import { MAX_ATTACHMENT_BYTES, MAX_MESSAGE_ATTACHMENTS, cleanName, defaultName, sniff } from '../attachments';

/**
 * Browser-room attachments. The room service never sees files: a signed message names each file by its SHA-256, and
 * devices pull the bytes from any connected device that holds them over the data channel. Because the hash is inside
 * the signed message, a receiver checks reassembled bytes against it and never stores or shows anything else.
 * Transfer packets are unsigned envelopes without a `body`, so browsers and bridges from before files ignore them.
 */
export type AttachmentRef = { id: string; name: string; type: string; size: number; sha256: string; width?: number; height?: number };
export type FilePacket =
  | { kind: 'files'; roomId: string; version: 1 }
  | { kind: 'file-want'; roomId: string; sha256: string; offset: number }
  | { kind: 'file-chunk'; roomId: string; sha256: string; offset: number; data: string }
  | { kind: 'file-done'; roomId: string; sha256: string; size: number }
  | { kind: 'file-missing'; roomId: string; sha256: string };

export { MAX_ATTACHMENT_BYTES, MAX_MESSAGE_ATTACHMENTS };
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** Every type `sniff` can return; a declared type outside this list is not a valid attachment. */
export const FILE_TYPES = [...IMAGE_TYPES, 'application/pdf', 'text/plain', 'application/octet-stream'];
export const MAX_ROOM_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_ROOM_FILES = 512;
/** 12,000 bytes are 16,000 base64 characters: with the envelope, well under the 20,000-character channel limit. */
export const CHUNK_BYTES = 12_000;
/** A sender waits while this much is queued on a channel, so a 10 MB file never floods the SCTP buffer. */
export const HIGH_WATER = 1_000_000;
const STALL_MS = 15_000, RETRY_MS = 20_000, BAD_MS = 10 * 60_000, PARALLEL = 3, UPLOADS_PER_PEER = 2, UPLOADS_TOTAL = 6;

const uuid = (v: unknown) => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);
export const isSha256 = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const dimension = (v: unknown) => v === undefined || (Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= 65535);

export async function sha256Hex(bytes: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), n => n.toString(16).padStart(2, '0')).join('');
}
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
function fromBase64(value: string) { try { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); } catch { return undefined; } }

export function validAttachments(list: unknown): list is AttachmentRef[] {
  if (!Array.isArray(list) || !list.length || list.length > MAX_MESSAGE_ATTACHMENTS) return false;
  const ids = new Set<string>();
  for (const a of list) {
    if (!a || typeof a !== 'object' || !uuid(a.id) || ids.has(a.id) || !isSha256(a.sha256) || !FILE_TYPES.includes(a.type)) return false;
    if (typeof a.name !== 'string' || !a.name || cleanName(a.name, '') !== a.name) return false;
    if (!Number.isSafeInteger(a.size) || a.size < 1 || a.size > MAX_ATTACHMENT_BYTES || !dimension(a.width) || !dimension(a.height)) return false;
    if (Object.keys(a).some(key => !['id', 'name', 'type', 'size', 'sha256', 'width', 'height'].includes(key))) return false;
    ids.add(a.id);
  }
  return true;
}

/** Metadata for a file this device attaches. The type and size come from the bytes, never from the file's claim. */
export async function attachmentRef(bytes: Uint8Array, name: string, id: string = crypto.randomUUID()): Promise<AttachmentRef> {
  if (!bytes.length) throw new Error('That file is empty.');
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error('Attach files of 10 MB or less.');
  const { type, width, height } = sniff(bytes);
  return { id, name: cleanName(name, defaultName(type)), type, size: bytes.length, sha256: await sha256Hex(bytes), ...(width ? { width } : {}), ...(height ? { height } : {}) };
}

/**
 * Browsers and bridges from before attachments drop messages without text, so a message of only files carries
 * this text. They show it; current devices recognize it and show the files instead.
 */
export const attachmentText = (refs: AttachmentRef[]) => `Attached ${refs.map(a => a.name).join(', ')}`;
export const shownText = (body: { text: string; attachments?: AttachmentRef[] }) => body.attachments && body.text === attachmentText(body.attachments) ? '' : body.text;
/** Inline only when the stored bytes sniff as the declared raster type; everything else, including SVG, is a download. */
export const displayKind = (ref: AttachmentRef, storedType?: string): 'image' | 'file' => IMAGE_TYPES.includes(ref.type) && storedType === ref.type ? 'image' : 'file';

/**
 * Files a device keeps for a room: those of the newest messages, until the room's byte or file cap. Everything
 * older is evicted and not fetched again, so eviction and eager fetching never chase each other.
 */
export function retainedFiles(lists: (AttachmentRef[] | undefined)[], maxBytes = MAX_ROOM_FILE_BYTES, maxFiles = MAX_ROOM_FILES) {
  const kept = new Map<string, AttachmentRef>(); let bytes = 0;
  for (let i = lists.length - 1; i >= 0; i--) for (const ref of lists[i] || []) {
    if (kept.has(ref.sha256)) continue;
    if (bytes + ref.size > maxBytes || kept.size >= maxFiles) return kept;
    kept.set(ref.sha256, ref); bytes += ref.size;
  }
  return kept;
}

export const isFilePacket = (p: unknown): p is FilePacket => {
  const kind = (p as { kind?: unknown })?.kind;
  return typeof kind === 'string' && (kind === 'files' || kind.startsWith('file-'));
};

export interface FileChannel { readonly readyState: string; readonly bufferedAmount: number; send(data: string): void }
export interface FileStore {
  has(sha256: string): boolean;
  /** Verified bytes, or undefined when the file is not here (or no longer matches its hash). */
  get(sha256: string): Promise<Uint8Array | undefined>;
  /** Called only with bytes that match sha256; `type` is sniffed from them. */
  put(sha256: string, bytes: Uint8Array, type: string): Promise<void>;
}
export type TransferState = { state: 'fetching'; received: number; size: number } | { state: 'waiting' } | { state: 'damaged' };
type Incoming = {
  ref: AttachmentRef; bytes?: Uint8Array; received: number; source?: string; since: number;
  tried: Set<string>; contributors: Set<string>; damaged: boolean; retryAt: number; reported: number; verifying?: boolean;
};
type Options = {
  roomId: string; store: FileStore;
  /** Metadata of a file named by a verified message in this room; nothing else is served. */
  referenced: (sha256: string) => AttachmentRef | undefined;
  channel: (peer: string) => FileChannel | undefined;
  /** Connected, admitted devices. */
  peers: () => string[];
  changed?: () => void; now?: () => number;
};

/** Pulls wanted files from peers that announced file support and serves referenced files to them. */
export class FileTransfers {
  private incoming = new Map<string, Incoming>();
  private capable = new Set<string>();
  private announced = new Set<string>();
  /** `loading` while the file is read from the store: a repeated request for it waits instead of reading it again. */
  private uploads = new Map<string, { cancelled: boolean; loading: boolean }>();
  /** `peer:sha256` of peers whose bytes failed verification, until a time; kept when a fetch is abandoned and asked again. */
  private distrusted = new Map<string, number>();
  constructor(private o: Options) {}
  private now() { return this.o.now?.() ?? Date.now(); }
  private send(peer: string, packet: FilePacket) {
    const channel = this.o.channel(peer);
    if (channel?.readyState !== 'open') return false;
    try { channel.send(JSON.stringify(packet)); return true; } catch { return false; }
  }
  /** Announce support on a new channel; only announced peers are asked for files. */
  opened(peer: string) { if (this.send(peer, { kind: 'files', roomId: this.o.roomId, version: 1 })) this.announced.add(peer); }
  closed(peer: string) {
    this.capable.delete(peer); this.announced.delete(peer);
    for (const [key, upload] of this.uploads) if (key.startsWith(`${peer}:`)) upload.cancelled = true;
    // Keep what arrived: the next source resumes at the same offset.
    for (const item of this.incoming.values()) if (item.source === peer) item.source = undefined;
    this.pump();
  }
  want(ref: AttachmentRef) {
    if (this.o.store.has(ref.sha256) || this.incoming.has(ref.sha256)) return;
    this.incoming.set(ref.sha256, { ref, received: 0, since: 0, tried: new Set(), contributors: new Set(), damaged: false, retryAt: 0, reported: 0 });
    this.pump();
  }
  /** Stop fetching files no longer wanted (evicted, or their message is gone). */
  keep(wanted: (sha256: string) => boolean) { for (const sha of this.incoming.keys()) if (!wanted(sha)) this.incoming.delete(sha); }
  state(sha256: string): TransferState | undefined {
    const item = this.incoming.get(sha256); if (!item) return undefined;
    if (item.source || item.verifying) return { state: 'fetching', received: item.received, size: item.ref.size };
    return item.damaged ? { state: 'damaged' } : { state: 'waiting' };
  }
  /** Timeouts and retries; call about once a second. */
  tick() {
    const now = this.now();
    for (const item of this.incoming.values()) {
      if (item.source && now - item.since > STALL_MS) this.skip(item, item.source);
      if (!item.source && now >= item.retryAt) { item.tried.clear(); item.retryAt = now + RETRY_MS; }
    }
    for (const [key, until] of this.distrusted) if (now >= until) this.distrusted.delete(key);
    this.pump();
  }
  /** True when the packet was a file packet (handled or ignored); the caller then does nothing else with it. */
  handle(peer: string, packet: unknown): boolean {
    if (!isFilePacket(packet)) return false;
    const p = packet;
    if (p.roomId !== this.o.roomId) return true;
    if (p.kind === 'files') {
      // Answer if this side never announced (its open event can precede the handler on a channel the peer created).
      this.capable.add(peer); if (!this.announced.has(peer)) this.opened(peer);
      for (const item of this.incoming.values()) item.tried.delete(peer);
      this.pump(); return true;
    }
    if (!isSha256(p.sha256)) return true;
    if (p.kind === 'file-want') void this.serve(peer, p.sha256, p.offset);
    else if (p.kind === 'file-chunk') this.chunk(peer, p);
    else if (p.kind === 'file-done') void this.done(peer, p.sha256);
    else if (p.kind === 'file-missing') this.drop(peer, p.sha256);
    return true;
  }
  private pump() {
    let active = [...this.incoming.values()].filter(i => i.source).length;
    const open = this.o.peers().filter(peer => this.capable.has(peer) && this.o.channel(peer)?.readyState === 'open');
    for (const [sha, item] of this.incoming) {
      if (active >= PARALLEL) break;
      if (item.source || item.verifying) continue;
      const peer = open.find(p => !item.tried.has(p) && !this.distrusted.has(`${p}:${sha}`));
      if (!peer) continue;
      if (!this.send(peer, { kind: 'file-want', roomId: this.o.roomId, sha256: sha, offset: item.received })) { item.tried.add(peer); continue; }
      item.source = peer; item.since = this.now(); active++;
    }
    this.o.changed?.();
  }
  private drop(peer: string, sha: string) {
    const item = this.incoming.get(sha);
    if (item?.source !== peer) return;
    this.skip(item, peer); this.pump();
  }
  /** Stop asking this peer for a while: other holders are tried first, and every peer again after RETRY_MS. */
  private skip(item: Incoming, peer: string) {
    item.tried.add(peer); item.source = undefined; item.retryAt = Math.max(item.retryAt, this.now() + RETRY_MS);
  }
  private chunk(peer: string, p: Extract<FilePacket, { kind: 'file-chunk' }>) {
    const item = this.incoming.get(p.sha256);
    if (item?.source !== peer) return;
    const data = typeof p.data === 'string' && p.data.length <= Math.ceil(CHUNK_BYTES / 3) * 4 ? fromBase64(p.data) : undefined;
    if (p.offset !== item.received || !data?.length || data.length > CHUNK_BYTES || item.received + data.length > item.ref.size) { this.drop(peer, p.sha256); return; }
    (item.bytes ||= new Uint8Array(item.ref.size)).set(data, item.received);
    item.received += data.length; item.since = this.now(); item.contributors.add(peer);
    if (item.received - item.reported >= CHUNK_BYTES * 64) { item.reported = item.received; this.o.changed?.(); }
  }
  private async done(peer: string, sha: string) {
    const item = this.incoming.get(sha);
    if (item?.source !== peer) return;
    item.source = undefined;
    if (item.received < item.ref.size) { this.skip(item, peer); this.pump(); return; }
    const bytes = item.bytes!;
    item.verifying = true; // Not handed to another peer while hashing and storing.
    if (await sha256Hex(bytes) === sha) {
      try { await this.o.store.put(sha, bytes, sniff(bytes).type); this.incoming.delete(sha); }
      catch { item.retryAt = this.now() + RETRY_MS; item.tried.add(peer); }
    } else {
      // Bytes may have come from several peers after a resume; none of them is trusted for this file for a while.
      for (const contributor of item.contributors) this.distrusted.set(`${contributor}:${sha}`, this.now() + BAD_MS);
      Object.assign(item, { bytes: undefined, received: 0, reported: 0, contributors: new Set(), damaged: true });
    }
    item.verifying = false; this.pump();
  }
  private async serve(peer: string, sha: string, offset: unknown) {
    const key = `${peer}:${sha}`, missing = () => { this.send(peer, { kind: 'file-missing', roomId: this.o.roomId, sha256: sha }); };
    const previous = this.uploads.get(key);
    if (previous?.loading) return; // Already reading this file for this peer; a flood of requests must not read it again.
    // The upload slot is taken before the file is read, so requests beyond the limits never load files into memory.
    const busy = [...this.uploads.keys()].filter(k => k.startsWith(`${peer}:`) && k !== key).length >= UPLOADS_PER_PEER
      || (!previous && this.uploads.size >= UPLOADS_TOTAL);
    const ref = this.o.referenced(sha);
    if (busy || !ref || !Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > ref.size || !this.o.store.has(sha)) { missing(); return; }
    if (previous) previous.cancelled = true;
    const upload = { cancelled: false, loading: true }; this.uploads.set(key, upload);
    try {
      const bytes = await this.o.store.get(sha).catch(() => undefined); upload.loading = false;
      if (upload.cancelled) return;
      if (!bytes || bytes.length !== ref.size) { missing(); return; }
      for (let at = offset as number; at < bytes.length; at += CHUNK_BYTES) {
        while ((this.o.channel(peer)?.bufferedAmount ?? 0) > HIGH_WATER && !upload.cancelled && this.o.channel(peer)?.readyState === 'open') await new Promise(r => setTimeout(r, 10));
        if (upload.cancelled || !this.send(peer, this.packet(sha, at, bytes.subarray(at, at + CHUNK_BYTES)))) return;
      }
      this.send(peer, { kind: 'file-done', roomId: this.o.roomId, sha256: sha, size: bytes.length });
    } finally { if (this.uploads.get(key) === upload) this.uploads.delete(key); }
  }
  private packet(sha256: string, offset: number, bytes: Uint8Array): FilePacket {
    return { kind: 'file-chunk', roomId: this.o.roomId, sha256, offset, data: toBase64(bytes) };
  }
}
