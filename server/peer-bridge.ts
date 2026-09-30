import { createHash } from 'node:crypto';
import { LocalNode } from './node';
import { isHash, isUuid, type StoredMessage } from './model';
import type { IncomingFile, IncomingPacket, PeerTransport } from './meshguard';
import { normalizeAttachment } from './attachments';

const CHUNK_BYTES = 512, MAX_CHUNKS = 128, MAX_ASSEMBLIES = 16;
const MAX_PEER_ASSEMBLIES = 4, MAX_ROOM_ASSEMBLIES = 2;
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
/** A file transfer the bridge started; the paired node's file-ack, not MeshGuard's DONE, retires it. */
type FileSend = { transfer: string; started: number; delivered?: number };
const FILE_ACK_GRACE_MS = 30000, FILE_RETRY_MS = 5000, FILE_SEND_TIMEOUT_MS = 10 * 60000;
type Assembly = { sender: string; room: string; id: string; hash: string; count: number; chunks: Map<number, Buffer>; expires: number };
function canonical(message: StoredMessage): StoredMessage {
  return { id: message.id, authorId: message.authorId, author: message.author, role: message.role, text: message.text,
    time: message.time, share: message.share, replyTo: message.replyTo, ...(message.attachments ? { attachments: message.attachments.map(normalizeAttachment) } : {}),
    requestId: message.requestId, fingerprint: message.fingerprint };
}
export function packets(room: string, message: StoredMessage): string[] {
  const data = Buffer.from(JSON.stringify(message)), hash = digest(data), n = Math.ceil(data.length / CHUNK_BYTES);
  if (n > MAX_CHUNKS) throw new Error('Room message exceeds the transport size limit.');
  return Array.from({ length: n }, (_, i) => JSON.stringify({ v: 1, k: 'chunk', room, id: message.id, hash, i, n,
    data: data.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES).toString('base64') }));
}

/** History is the durable outbox; only a persisted receiver acknowledgment retires an item. */
export class PeerBridge {
  private assemblies = new Map<string, Assembly>();
  private retryAt = new Map<string, number>();
  private fileSends = new Map<string, FileSend>();
  private fileRetryAt = new Map<string, number>();
  private chunkOffset = new Map<string, number>();
  private roomOffset = 0;
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private closed = false;
  private connected = false;
  private lastError?: string;
  constructor(private node: LocalNode, private transport: PeerTransport) {}
  start() { this.timer = setInterval(() => { void this.pump(); }, 250); this.timer.unref(); void this.pump(); }
  close() { this.closed = true; clearInterval(this.timer); this.assemblies.clear(); }
  status() { return { connected: this.connected, error: this.lastError, rooms: this.node.pendingDelivery().map(r => ({
    roomId: r.roomId, peerKey: r.peerKey, pending: r.messages.map(m => m.id), storedRemotely: r.acknowledged, filesStoredRemotely: r.files,
    sendingFiles: [...this.fileSends.keys()].filter(k => k.startsWith(`${r.roomId}:`)).map(k => k.slice(r.roomId.length + 1)),
  })) }; }
  async pump(now = Date.now()) {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      await this.transport.check(); if (this.closed) return;
      this.connected = true; this.lastError = undefined;
      this.expireAssemblies(now);
      for (let i = 0; i < 32 && !this.closed; i++) {
        const incoming = await this.transport.receive(); if (!incoming || this.closed) break;
        try { await this.ingest(incoming, now); }
        catch { /* An invalid/unadmitted packet receives no receipt. Sender retry repairs packet loss. */ }
      }
      for (let i = 0; i < 2 && this.transport.files && !this.closed; i++) {
        const file = await this.transport.files.nextFile(); if (!file) break;
        await this.ingestFile(file);
      }
      const rooms = this.node.pendingDelivery(); let budget = 16;
      const start = this.roomOffset;
      for (let i = 0; i < rooms.length && budget > 0; i++) {
        const room = rooms[(start + i) % rooms.length];
        if (this.closed) break;
        const message = room.messages[0]; if (!message) continue;
        // A message is sent only after the paired node stored every file it references.
        const missing = message.attachments?.filter(a => !room.files.includes(a.id)) ?? [];
        if (missing.length) {
          try { await this.sendFiles(room.roomId, room.peerKey, missing.map(a => a.id), Date.now()); }
          catch (error) { this.lastError = error instanceof Error ? error.message : 'File transfer failed.'; }
          continue;
        }
        const key = `${room.roomId}:${message.id}`;
        if ((this.retryAt.get(key) || 0) > now) continue;
        try {
          const frames = packets(room.roomId, message); let offset = this.chunkOffset.get(key) || 0;
          const end = Math.min(frames.length, offset + Math.min(16, budget));
          while (offset < end && !this.closed) { await this.transport.send(room.peerKey, frames[offset++]); budget--; }
          this.chunkOffset.set(key, offset === frames.length ? 0 : offset);
          if (offset === frames.length) this.retryAt.set(key, now + 3000);
        }
        catch (error) { this.lastError = error instanceof Error ? error.message : 'Peer send failed.'; }
      }
      this.roomOffset = rooms.length ? (start + 1) % rooms.length : 0;
    } catch (error) { this.connected = false; this.lastError = error instanceof Error ? error.message : 'MeshGuard attachment failed.'; }
    finally { this.busy = false; }
  }
  private async sendFiles(roomId: string, peerKey: string, ids: string[], now: number) {
    const files = this.transport.files;
    if (!files) { this.lastError = 'The attached MeshGuard cannot transfer files; messages with attachments are waiting.'; return; }
    for (const attachmentId of ids) {
      const key = `${roomId}:${attachmentId}`; const current = this.fileSends.get(key);
      if (current) {
        const state = await files.fileStatus(current.transfer);
        if (state?.state === 'delivered') {
          current.delivered ??= now;
          // MeshGuard verified the bytes; wait for our peer to confirm it stored them.
          if (now - current.delivered < FILE_ACK_GRACE_MS) continue;
        } else if (state?.state === 'sending' && now - current.started < FILE_SEND_TIMEOUT_MS) continue;
        else if (state?.state === 'failed') this.lastError = `File transfer failed: ${state.error || 'unknown reason'}`;
        await files.releaseFile(current.transfer); this.fileSends.delete(key); this.fileRetryAt.set(key, now + FILE_RETRY_MS);
        continue;
      }
      if ((this.fileRetryAt.get(key) || 0) > now) continue;
      const { attachment, hash, authorId, bytes } = this.node.peerAttachment(roomId, peerKey, attachmentId);
      const meta = new TextEncoder().encode(JSON.stringify({ v: 1, r: roomId, a: authorId, i: attachment.id, n: attachment.name }));
      try { this.fileSends.set(key, { transfer: await files.offerFile(peerKey, bytes, hash, meta), started: now }); }
      catch (error) { this.lastError = error instanceof Error ? error.message : 'File transfer could not start.'; this.fileRetryAt.set(key, now + FILE_RETRY_MS); }
    }
  }
  /** Store a verified incoming file, then confirm it to the sender. Unknown or unadmitted files are dropped. */
  async ingestFile(file: IncomingFile) {
    const files = this.transport.files!;
    let meta: any;
    try { meta = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.meta)); } catch { meta = null; }
    try {
      if (meta?.v !== 1 || !isUuid(meta.r) || !isUuid(meta.a) || !isUuid(meta.i) || typeof meta.n !== 'string' || !this.node.acceptsPeer(meta.r, file.sender)) return;
      this.node.receivePeerFile(meta.r, file.sender, { authorId: meta.a, id: meta.i, name: meta.n, hash: file.sha256 }, file.bytes);
    } catch { return; }
    finally { await files.releaseFile(file.id); }
    await this.transport.send(file.sender, JSON.stringify({ v: 1, k: 'file-ack', room: meta.r, id: meta.i, hash: file.sha256 }));
  }
  private expireAssemblies(now: number) {
    for (const [key, value] of this.assemblies) if (value.expires <= now) this.assemblies.delete(key);
  }
  async ingest(incoming: IncomingPacket, now = Date.now()) {
    if (this.closed || Buffer.byteLength(incoming.data) > 1024) return;
    const p = JSON.parse(incoming.data);
    if (!p || p.v !== 1 || !isUuid(p.room) || !isUuid(p.id) || !isHash(p.hash) || !this.node.acceptsPeer(p.room, incoming.sender)) return;
    if (p.k === 'file-ack') {
      this.node.acknowledgePeerFile(p.room, incoming.sender, p.id, p.hash);
      const key = `${p.room}:${p.id}`; const sent = this.fileSends.get(key);
      this.fileSends.delete(key); if (sent) await this.transport.files?.releaseFile(sent.transfer);
      return;
    }
    if (p.k === 'ack') { this.node.acknowledgePeer(p.room, incoming.sender, p.id, p.hash); this.retryAt.delete(`${p.room}:${p.id}`); this.chunkOffset.delete(`${p.room}:${p.id}`); return; }
    if (p.k !== 'chunk' || !Number.isInteger(p.n) || p.n < 1 || p.n > MAX_CHUNKS || !Number.isInteger(p.i) || p.i < 0 || p.i >= p.n
      || typeof p.data !== 'string' || p.data.length > 684 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.data)) return;
    const chunk = Buffer.from(p.data, 'base64');
    if (!chunk.length || chunk.length > CHUNK_BYTES || (p.i < p.n - 1 && chunk.length !== CHUNK_BYTES)) return;
    this.expireAssemblies(now);
    const key = `${incoming.sender}:${p.room}:${p.id}:${p.hash}`;
    let assembly = this.assemblies.get(key);
    if (!assembly) {
      if (this.assemblies.size >= MAX_ASSEMBLIES) return;
      // Count the bounded map itself so completion, expiry and close cannot
      // leave stale quota counters. A peer's allowance spans all paired rooms.
      const held = [...this.assemblies.values()];
      if (held.filter(a => a.sender === incoming.sender).length >= MAX_PEER_ASSEMBLIES
        || held.filter(a => a.room === p.room).length >= MAX_ROOM_ASSEMBLIES) return;
      assembly = { sender: incoming.sender, room: p.room, id: p.id, hash: p.hash, count: p.n, chunks: new Map(), expires: now + 30000 }; this.assemblies.set(key, assembly);
    }
    if (assembly.count !== p.n) return;
    assembly.chunks.set(p.i, chunk);
    if (assembly.chunks.size !== p.n) return;
    this.assemblies.delete(key);
    const data = Buffer.concat(Array.from({ length: p.n }, (_, i) => assembly!.chunks.get(i)!));
    if (digest(data) !== p.hash) return;
    const message = JSON.parse(data.toString('utf8'));
    if (message?.id !== p.id) return;
    if (digest(Buffer.from(JSON.stringify(canonical(message)))) !== p.hash) return;
    const storedHash = this.node.receivePeer(p.room, incoming.sender, message);
    // Receipt uses normalized persisted fields; unknown wire fields cannot manufacture a receipt.
    if (storedHash !== p.hash) return;
    await this.transport.send(incoming.sender, JSON.stringify({ v: 1, k: 'ack', room: p.room, id: p.id, hash: p.hash }));
  }
}
