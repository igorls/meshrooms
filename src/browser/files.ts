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
export const HIGH_WATER = 262_144;
/** Threshold at which the channel wakes paused senders via `bufferedamountlow`. */
export const LOW_WATER = 65_536;
/** Global RAM cap across all concurrent in-flight and partial downloads (SEC-11). */
export const MAX_INFLIGHT_BYTES = 32 * 1024 * 1024;
/** Per-sender auto-fetch budget for inline raster images; non-images and older images fetch on demand (SEC-11). */
export const MAX_AUTO_FETCH_BYTES_PER_SENDER = 24 * 1024 * 1024;
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
 *
 * `owners` names who sent each list (the message's member). When more than one member's files are in the room, each
 * member's files take at most half of the bytes and half of the count: otherwise a couple of dozen large files from
 * one member would evict everyone else's from every device. A member past their half loses their own older files;
 * the walk goes on to older messages of others. Without `owners`, or with files from one member only, the caps are
 * the room's alone.
 */
export function retainedFiles(lists: (AttachmentRef[] | undefined)[], maxBytes = MAX_ROOM_FILE_BYTES, maxFiles = MAX_ROOM_FILES, owners?: (string | undefined)[]) {
  const kept = new Map<string, AttachmentRef>(); let bytes = 0;
  const shared = !!owners && new Set(lists.flatMap((list, i) => list?.length && owners[i] !== undefined ? [owners[i]] : [])).size > 1;
  const used = new Map<string, { bytes: number; files: number }>();
  for (let i = lists.length - 1; i >= 0; i--) for (const ref of lists[i] || []) {
    if (kept.has(ref.sha256)) continue;
    if (bytes + ref.size > maxBytes || kept.size >= maxFiles) return kept;
    const owner = shared ? owners![i] : undefined;
    if (owner !== undefined) {
      const share = used.get(owner) ?? { bytes: 0, files: 0 };
      if (share.bytes + ref.size > maxBytes / 2 || share.files >= maxFiles / 2) continue;
      used.set(owner, { bytes: share.bytes + ref.size, files: share.files + 1 });
    }
    kept.set(ref.sha256, ref); bytes += ref.size;
  }
  return kept;
}

/**
 * Attachments a browser or local page fetches automatically (SEC-11): verified raster images only, newest first,
 * within each sender's auto-fetch budget and never outside `retained` (if supplied). Non-images (PDFs, text, binary
 * archives) and older images past a sender's budget stay un-fetched until the person clicks to download them.
 */
export function autoFetchFiles(
  lists: (AttachmentRef[] | undefined)[],
  owners?: (string | undefined)[],
  retained?: Map<string, AttachmentRef>,
  maxPerSender = MAX_AUTO_FETCH_BYTES_PER_SENDER,
) {
  const auto = new Map<string, AttachmentRef>();
  const used = new Map<string, number>();
  for (let i = lists.length - 1; i >= 0; i--) for (const ref of lists[i] || []) {
    if (auto.has(ref.sha256) || !IMAGE_TYPES.includes(ref.type)) continue;
    if (retained && !retained.has(ref.sha256)) continue;
    const owner = owners?.[i];
    if (owner !== undefined) {
      const bytes = used.get(owner) ?? 0;
      if (bytes + ref.size > maxPerSender) continue;
      used.set(owner, bytes + ref.size);
    }
    auto.set(ref.sha256, ref);
  }
  return auto;
}

export const isFilePacket = (p: unknown): p is FilePacket => {
  const kind = (p as { kind?: unknown })?.kind;
  return typeof kind === 'string' && (kind === 'files' || kind.startsWith('file-'));
};

export interface FileChannel {
  readonly readyState: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold?: number;
  send(data: string): void;
  addEventListener?(type: string, listener: () => void, options?: { once?: boolean }): void;
  removeEventListener?(type: string, listener: () => void): void;
}
export interface FileStore {
  has(sha256: string): boolean;
  /** Verified bytes, or undefined when the file is not here (or no longer matches its hash). */
  get(sha256: string): Promise<Uint8Array | undefined>;
  /** Called only with bytes that match sha256; `type` is sniffed from them. */
  put(sha256: string, bytes: Uint8Array, type: string): Promise<void>;
}
export type TransferState = { state: 'fetching'; received: number; size: number } | { state: 'waiting' } | { state: 'damaged' };
type Incoming = {
  ref: AttachmentRef; bytes?: Uint8Array; chunks: Uint8Array[]; chunksBytes: number; received: number;
  source?: string; since: number; disconnectedAt?: number;
  tried: Set<string>; contributors: Set<string>; damaged: boolean; retryAt: number; reported: number; verifying?: boolean;
};
type Options = {
  roomId: string; store: FileStore;
  /** Metadata of a file named by a verified message in this room that `peer` (when given) is authorized to see; nothing else is served. */
  referenced: (sha256: string, peer?: string) => AttachmentRef | undefined;
  channel: (peer: string) => FileChannel | undefined;
  /** Connected, admitted devices. */
  peers: () => string[];
  changed?: () => void; now?: () => number;
  /** Global in-flight RAM cap across all partial and verifying downloads (defaults to MAX_INFLIGHT_BYTES). */
  maxInflightBytes?: number;
};

/** Pulls wanted files from peers that announced file support and serves referenced files to them. */
export class FileTransfers {
  private incoming = new Map<string, Incoming>();
  private capable = new Set<string>();
  private announced = new Set<string>();
  private verifyingBytes = 0;
  /** `loading` while the file is read from the store: a repeated request for it waits instead of reading it again. */
  private uploads = new Map<string, { cancelled: boolean; loading: boolean; wake?: () => void }>();
  /** `peer:sha256` of peers whose bytes failed verification, until a time; kept when a fetch is abandoned and asked again. */
  private distrusted = new Map<string, number>();
  constructor(private o: Options) {}
  private now() { return this.o.now?.() ?? Date.now(); }
  private get maxInflightBytes() { return this.o.maxInflightBytes ?? MAX_INFLIGHT_BYTES; }
  private itemBytes(item: Incoming) { return item.bytes ? item.bytes.byteLength : item.chunksBytes; }
  /** Total RAM currently held by partial chunk buffers and buffers under SHA-256 verification. */
  get inflightBytes() {
    let total = this.verifyingBytes;
    for (const item of this.incoming.values()) total += this.itemBytes(item);
    return total;
  }
  private releaseBuffer(item: Incoming) {
    item.bytes = undefined;
    item.chunks = [];
    item.chunksBytes = 0;
    item.received = 0;
    item.reported = 0;
    item.contributors.clear();
    item.disconnectedAt = undefined;
  }
  /** Free oldest idle partial buffers until `needed` additional bytes fit under `maxInflightBytes`. */
  private releaseIdleBuffers(needed: number, keepItem?: Incoming) {
    if (this.inflightBytes + needed <= this.maxInflightBytes) return;
    const idle = [...this.incoming.values()]
      .filter(i => !i.source && !i.verifying && i !== keepItem && this.itemBytes(i) > 0)
      .sort((a, b) => (a.disconnectedAt ?? 0) - (b.disconnectedAt ?? 0));
    for (const item of idle) {
      this.releaseBuffer(item);
      if (this.inflightBytes + needed <= this.maxInflightBytes) break;
    }
  }
  private send(peer: string, packet: FilePacket) {
    const channel = this.o.channel(peer);
    if (channel?.readyState !== 'open') return false;
    try { channel.send(JSON.stringify(packet)); return true; } catch { return false; }
  }
  /** Announce support on a new channel; only announced peers are asked for files. */
  opened(peer: string) { if (this.send(peer, { kind: 'files', roomId: this.o.roomId, version: 1 })) this.announced.add(peer); }
  closed(peer: string) {
    this.capable.delete(peer); this.announced.delete(peer);
    for (const [key, upload] of this.uploads) if (key.startsWith(`${peer}:`)) { upload.cancelled = true; upload.wake?.(); }
    // Keep lazy partial chunks briefly so another connected holder can resume at the same offset,
    // releasing them after STALL_MS idle or immediately whenever RAM cap headroom is needed.
    const at = this.now();
    for (const item of this.incoming.values()) if (item.source === peer) { item.source = undefined; item.disconnectedAt = at; }
    this.releaseIdleBuffers(0);
    this.pump();
  }
  want(ref: AttachmentRef) {
    if (this.o.store.has(ref.sha256) || this.incoming.has(ref.sha256)) return;
    this.incoming.set(ref.sha256, { ref, chunks: [], chunksBytes: 0, received: 0, since: 0, tried: new Set(), contributors: new Set(), damaged: false, retryAt: 0, reported: 0 });
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
      if (!item.source && !item.verifying && this.itemBytes(item) > 0 && item.disconnectedAt !== undefined && now - item.disconnectedAt > STALL_MS) {
        this.releaseBuffer(item);
      }
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
  private reservedBytes() {
    let reserved = this.verifyingBytes;
    for (const item of this.incoming.values()) reserved += item.source ? item.ref.size : this.itemBytes(item);
    return reserved;
  }
  private pump() {
    let active = [...this.incoming.values()].filter(i => i.source || i.verifying).length;
    const open = this.o.peers().filter(peer => this.capable.has(peer) && this.o.channel(peer)?.readyState === 'open');
    for (const [sha, item] of this.incoming) {
      if (active >= PARALLEL) break;
      if (item.source || item.verifying) continue;
      const need = Math.max(0, item.ref.size - this.itemBytes(item));
      if (this.reservedBytes() + need > this.maxInflightBytes) {
        // Release other idle partial buffers to make room under the global RAM cap.
        const idle = [...this.incoming.values()]
          .filter(i => !i.source && !i.verifying && i !== item && this.itemBytes(i) > 0)
          .sort((a, b) => (a.disconnectedAt ?? 0) - (b.disconnectedAt ?? 0));
        for (const other of idle) {
          this.releaseBuffer(other);
          if (this.reservedBytes() + need <= this.maxInflightBytes) break;
        }
        if (this.reservedBytes() + need > this.maxInflightBytes) {
          if (active > 0 || item.ref.size > this.maxInflightBytes) continue;
        }
      }
      const peer = open.find(p => !item.tried.has(p) && !this.distrusted.has(`${p}:${sha}`));
      if (!peer) continue;
      if (!this.send(peer, { kind: 'file-want', roomId: this.o.roomId, sha256: sha, offset: item.received })) { item.tried.add(peer); continue; }
      item.source = peer; item.since = this.now(); item.disconnectedAt = undefined; active++;
    }
    this.o.changed?.();
  }
  private drop(peer: string, sha: string) {
    const item = this.incoming.get(sha);
    if (item?.source !== peer) return;
    this.skip(item, peer); this.pump();
  }
  /** Stop asking this peer for a while and free any partial buffer held for the failed/stalled attempt. */
  private skip(item: Incoming, peer: string) {
    item.tried.add(peer); item.source = undefined; item.retryAt = Math.max(item.retryAt, this.now() + RETRY_MS);
    this.releaseBuffer(item);
  }
  private chunk(peer: string, p: Extract<FilePacket, { kind: 'file-chunk' }>) {
    const item = this.incoming.get(p.sha256);
    if (item?.source !== peer) return;
    const data = typeof p.data === 'string' && p.data.length <= Math.ceil(CHUNK_BYTES / 3) * 4 ? fromBase64(p.data) : undefined;
    if (p.offset !== item.received || !data?.length || data.length > CHUNK_BYTES || item.received + data.length > item.ref.size) { this.drop(peer, p.sha256); return; }
    if (this.inflightBytes + data.length > this.maxInflightBytes) this.releaseIdleBuffers(data.length, item);
    if (this.inflightBytes + data.length > this.maxInflightBytes) { this.drop(peer, p.sha256); return; }
    item.chunks.push(data);
    item.chunksBytes += data.length;
    item.received += data.length; item.since = this.now(); item.disconnectedAt = undefined; item.contributors.add(peer);
    if (item.received - item.reported >= CHUNK_BYTES * 64) { item.reported = item.received; this.o.changed?.(); }
  }
  private async done(peer: string, sha: string) {
    const item = this.incoming.get(sha);
    if (item?.source !== peer) return;
    item.source = undefined;
    if (item.received < item.ref.size) { this.skip(item, peer); this.pump(); return; }
    let bytes: Uint8Array;
    if (item.bytes) {
      bytes = item.bytes;
    } else {
      bytes = new Uint8Array(item.ref.size);
      let offset = 0;
      for (const chunk of item.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    }
    // Release chunk references immediately before hashing so peak RAM never doubles.
    item.chunks = []; item.chunksBytes = 0; item.bytes = undefined;
    item.verifying = true; // Not handed to another peer while hashing and storing.
    this.verifyingBytes += bytes.byteLength;
    try {
      const matches = await sha256Hex(bytes) === sha;
      if (this.incoming.get(sha) !== item) return; // Let go while hashing, as when its message was deleted.
      if (matches) {
        try { await this.o.store.put(sha, bytes, sniff(bytes).type); this.incoming.delete(sha); }
        catch { this.releaseBuffer(item); item.retryAt = this.now() + RETRY_MS; item.tried.add(peer); }
      } else {
        // Bytes may have come from several peers after a resume; none of them is trusted for this file for a while.
        for (const contributor of item.contributors) this.distrusted.set(`${contributor}:${sha}`, this.now() + BAD_MS);
        this.releaseBuffer(item); item.damaged = true;
      }
      item.verifying = false;
    } finally {
      this.verifyingBytes -= bytes.byteLength;
    }
    this.pump();
  }
  private waitForDrain(channel: FileChannel, upload: { cancelled: boolean; wake?: () => void }): Promise<void> {
    return new Promise<void>(resolve => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (upload.wake === finish) upload.wake = undefined;
        channel.removeEventListener?.('bufferedamountlow', finish);
        channel.removeEventListener?.('close', finish);
        resolve();
      };
      upload.wake = finish;
      const hasEvents = typeof channel.addEventListener === 'function';
      const timer = setTimeout(finish, hasEvents ? 50 : 10);
      if (hasEvents) {
        if (typeof channel.bufferedAmountLowThreshold === 'number' && channel.bufferedAmountLowThreshold === 0) {
          try { channel.bufferedAmountLowThreshold = LOW_WATER; } catch { /* Read-only in some mocks. */ }
        }
        channel.addEventListener!('bufferedamountlow', finish, { once: true });
        channel.addEventListener!('close', finish, { once: true });
      }
    });
  }
  private async serve(peer: string, sha: string, offset: unknown) {
    const key = `${peer}:${sha}`, missing = () => { this.send(peer, { kind: 'file-missing', roomId: this.o.roomId, sha256: sha }); };
    const previous = this.uploads.get(key);
    if (previous?.loading) return; // Already reading this file for this peer; a flood of requests must not read it again.
    // The upload slot is taken before the file is read, so requests beyond the limits never load files into memory.
    const busy = [...this.uploads.keys()].filter(k => k.startsWith(`${peer}:`) && k !== key).length >= UPLOADS_PER_PEER
      || (!previous && this.uploads.size >= UPLOADS_TOTAL);
    const ref = this.o.referenced(sha, peer);
    if (busy || !ref || !Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > ref.size || !this.o.store.has(sha)) { missing(); return; }
    if (previous) { previous.cancelled = true; previous.wake?.(); }
    const upload: { cancelled: boolean; loading: boolean; wake?: () => void } = { cancelled: false, loading: true }; this.uploads.set(key, upload);
    try {
      const bytes = await this.o.store.get(sha).catch(() => undefined); upload.loading = false;
      if (upload.cancelled) return;
      if (!bytes || bytes.length !== ref.size) { missing(); return; }
      for (let at = offset as number; at < bytes.length; at += CHUNK_BYTES) {
        while (!upload.cancelled) {
          const channel = this.o.channel(peer);
          if (channel?.readyState !== 'open' || channel.bufferedAmount <= HIGH_WATER) break;
          await this.waitForDrain(channel, upload);
        }
        if (upload.cancelled || !this.send(peer, this.packet(sha, at, bytes.subarray(at, at + CHUNK_BYTES)))) return;
      }
      this.send(peer, { kind: 'file-done', roomId: this.o.roomId, sha256: sha, size: bytes.length });
    } finally { if (this.uploads.get(key) === upload) this.uploads.delete(key); }
  }
  private packet(sha256: string, offset: number, bytes: Uint8Array): FilePacket {
    return { kind: 'file-chunk', roomId: this.o.roomId, sha256, offset, data: toBase64(bytes) };
  }
}
