/**
 * Paced sending of bulk state (sync envelopes) on one data channel, for browsers and the agent bridge. Sends only
 * while the channel's own send buffer is below a high-water mark; the caller pumps again when the buffer drains
 * (bufferedamountlow) and on its regular tick. A receiver that still drops packets under load asks for the state
 * again with a sync request (see SYNC_REQUEST), and the sender answers at most once per RESYNC_INTERVAL_MS.
 */
export type PacedChannel = { readonly readyState: string; readonly bufferedAmount: number; send(data: string): void };
export const PACE_HIGH_WATER = 64 * 1024;
export const PACE_LOW_WATER = 16 * 1024;
/** Upper bound on queued envelopes per channel; a full exchange of the largest board, decisions and reactions fits. */
export const MAX_QUEUED_ENVELOPES = 1024;

/**
 * Asks a peer to send its board, decisions and reactions again, after this device dropped packets under load. Peers from
 * before it ignore unknown kinds (a packet with no signed body is discarded), so it is safe to send to anyone.
 */
export const SYNC_REQUEST = 'sync-request';
export type SyncRequest = { kind: typeof SYNC_REQUEST; roomId: string };
export const isSyncRequest = (packet: unknown, roomId: string): packet is SyncRequest =>
  !!packet && typeof packet === 'object' && (packet as SyncRequest).kind === SYNC_REQUEST && (packet as SyncRequest).roomId === roomId;
/** A peer gets a full resend at most this often, however often it asks. */
export const RESYNC_INTERVAL_MS = 10_000;

export class SendQueue {
  private queue: string[] = [];
  constructor(private channel: PacedChannel, private high = PACE_HIGH_WATER) {}
  get pending() { return this.queue.length; }
  /** Queue envelopes (already serialized) and send what the buffer allows now. False when the queue is full. */
  push(texts: string[]) {
    if (this.queue.length + texts.length > MAX_QUEUED_ENVELOPES) return false;
    this.queue.push(...texts); this.pump(); return true;
  }
  pump() {
    if (this.channel.readyState === 'closing' || this.channel.readyState === 'closed') { this.queue = []; return; }
    while (this.queue.length && this.channel.readyState === 'open' && this.channel.bufferedAmount < this.high) {
      try { this.channel.send(this.queue[0]); } catch { return; } // Kept for the next pump.
      this.queue.shift();
    }
  }
}

/** Resends of full state to one peer: requested by it, spaced RESYNC_INTERVAL_MS apart, and never while one is queued. */
export class Resync {
  private requested = false;
  private last = -Infinity;
  constructor(private now: () => number = () => Date.now()) {}
  request() { this.requested = true; }
  /** Full state was just queued for this peer (its channel opened, or a resend). */
  sent() { this.last = this.now(); }
  /** Call from a tick: true when a requested resend is due now (and marks it done). */
  due(queue: SendQueue) {
    if (!this.requested || queue.pending || this.now() - this.last < RESYNC_INTERVAL_MS) return false;
    this.requested = false; this.last = this.now(); return true;
  }
}

/** Packets waiting for the serialized handler, at most this many; past it they are dropped. */
export const MAX_PENDING_INCOMING = 64;
/**
 * Bounds the incoming packets waiting for the (serialized, signature-checking) handler, so a peer can't grow memory or
 * CPU without limit. Remembers which peers lost packets to it; once the backlog has drained, those peers are asked for
 * their state again (a lost message or receipt is retried by its sender anyway).
 */
export class IncomingGate {
  private pending = 0;
  private dropped = new Set<string>();
  constructor(private limit = MAX_PENDING_INCOMING) {}
  get size() { return this.pending; }
  /** Whether `admit` would accept one more now: a source that can wait (the relay inbox keeps its copy) checks this first instead of being dropped. */
  hasRoom() { return this.pending < this.limit; }
  /** Room for one more packet from `from`; false means drop it. */
  admit(from: string) {
    if (this.pending >= this.limit) { this.dropped.add(from); return false; }
    this.pending++; return true;
  }
  /** An admitted packet was handled. Returns the peers to ask for a resync, once nothing is waiting. */
  done(): string[] {
    this.pending = Math.max(0, this.pending - 1);
    if (this.pending || !this.dropped.size) return [];
    const peers = [...this.dropped]; this.dropped.clear(); return peers;
  }
}

/** Primary chat/sync channel label; older peers open only this channel and reuse it for files. */
export const PRIMARY_CHANNEL_LABEL = 'meshrooms-browser-v1';
/** Dedicated bulk file-transfer channel label; upgraded peers isolate file chunks here. */
export const FILE_CHANNEL_LABEL = 'files';
/** Initial handshake deadline before a peer that never reached healthy state is torn down. */
export const CONNECT_TIMEOUT_MS = 20_000;
/** Recovery grace once an established peer drops to disconnected, or ICE connects without an open channel (SYNC-5). */
export const UNHEALTHY_GRACE_MS = 12_000;

export type PeerHealthState = {
  connectionState?: string;
  iceConnectionState?: string;
  channelState?: string;
  started: number;
  openedOnce?: boolean;
  unhealthySince?: number;
};

/**
 * Evaluates whether a WebRTC peer is healthy, within its recovery grace period, or ready to tear down (SYNC-5).
 * Tracks `unhealthySince` separately from `started` so a peer connected for >1 h still gets a short recovery grace
 * on `disconnected`, while terminal `failed`/`closed` states and zombie PCs with a closed DataChannel drop at once.
 */
export function evaluatePeerHealth(peer: PeerHealthState, now: number): 'healthy' | 'grace' | 'drop' {
  const pc = peer.connectionState, ice = peer.iceConnectionState, ch = peer.channelState;
  if (pc === 'failed' || pc === 'closed' || ice === 'failed' || ice === 'closed' || ch === 'closed') {
    peer.unhealthySince ??= now;
    return 'drop';
  }
  const pcConnected = pc === 'connected' || (pc === undefined && ch === 'open');
  const iceOk = !ice || ice === 'connected' || ice === 'completed';
  if (pcConnected && iceOk && ch === 'open') {
    peer.openedOnce = true;
    peer.unhealthySince = undefined;
    return 'healthy';
  }
  if (peer.openedOnce || pc === 'connected' || pc === 'disconnected' || ice === 'disconnected' || ch === 'closing') {
    peer.unhealthySince ??= now;
    if (now - peer.unhealthySince > UNHEALTHY_GRACE_MS) return 'drop';
    if (!peer.openedOnce && now - peer.started > CONNECT_TIMEOUT_MS) return 'drop';
    return 'grace';
  }
  return now - peer.started > CONNECT_TIMEOUT_MS ? 'drop' : 'grace';
}

/** True when a peer holds a live open primary channel on a non-failed connection (safe to keep across epoch changes). */
export function isLiveOpenPeer(pcState: string | undefined, iceState: string | undefined, channelState: string | undefined): boolean {
  return channelState === 'open' && pcState !== 'failed' && pcState !== 'closed' && iceState !== 'failed' && iceState !== 'closed';
}

/** First `a=ice-ufrag:` token in an SDP body, if present. */
export function sdpIceUfrag(sdp: string | undefined): string | undefined {
  if (typeof sdp !== 'string') return undefined;
  return /(?:^|\r?\n)a=ice-ufrag:([^\r\n\s]+)/.exec(sdp)?.[1];
}

/** Ordered `a=mid:` identifiers in an SDP body. */
export function sdpMids(sdp: string | undefined): string[] {
  if (typeof sdp !== 'string') return [];
  const mids: string[] = [];
  for (const match of sdp.matchAll(/(?:^|\r?\n)a=mid:([^\r\n\s]+)/g)) mids.push(match[1]);
  return mids;
}

/**
 * Checks whether an incoming SDP answer is compatible with the current local offer and not a replayed remote `ice-ufrag`
 * from an earlier/retired connection for the same session. (Note: per RFC 8839, an answer carries the answerer's own
 * `ice-ufrag`, distinct from the offerer's `ice-ufrag`; both sides share `a=mid` sections.)
 */
export function answerMatchesOffer(localSdp: string | undefined, answerSdp: string | undefined, retiredRemoteUfrags?: Set<string>, currentRemoteSdp?: string): boolean {
  if (typeof answerSdp !== 'string' || !answerSdp) return false;
  const localUfrag = sdpIceUfrag(localSdp);
  const answerUfrag = sdpIceUfrag(answerSdp);
  if (localUfrag && !answerUfrag) return false;
  if (answerUfrag && retiredRemoteUfrags?.has(answerUfrag)) return false;
  const previousRemoteUfrag = sdpIceUfrag(currentRemoteSdp);
  if (answerUfrag && previousRemoteUfrag && answerUfrag === previousRemoteUfrag) return false;
  const localMids = sdpMids(localSdp), answerMids = sdpMids(answerSdp);
  if (localMids.length && answerMids.length && (localMids.length !== answerMids.length || localMids.some((m, i) => m !== answerMids[i]))) return false;
  return true;
}

/** Deduplicates a poll batch's signals to the newest `seq` per `(from, session, type)` among currently online devices. */
export function dedupeSignals<T extends { seq: number; from: string; session: string; description?: { type?: string; sdp?: string } }>(
  signals: T[],
  available: { id: string; session?: string }[],
): T[] {
  const latest = new Map<string, T>();
  for (const signal of signals) {
    const type = signal?.description?.type;
    if ((type !== 'offer' && type !== 'answer') || typeof signal.description?.sdp !== 'string') continue;
    if (!available.some(d => d.id === signal.from && d.session === signal.session)) continue;
    const key = `${signal.from}:${signal.session}:${type}`;
    const prev = latest.get(key);
    if (!prev || signal.seq >= prev.seq) latest.set(key, signal);
  }
  return [...latest.values()].sort((a, b) => a.seq - b.seq);
}

/** Parses an HTTP `Retry-After` header (delta-seconds or HTTP-date) into milliseconds from `now`. */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const dateMs = Date.parse(trimmed);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - now) : undefined;
}

/** Exponential backoff for HTTP 429 polling, honoring `Retry-After` when larger, bounded by `maxMs`. */
export function nextPollBackoff(currentMs: number, retryAfterMs?: number, baseMs = 2_000, maxMs = 30_000): number {
  const exp = currentMs > 0 ? currentMs * 2 : baseMs;
  const desired = retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? Math.max(exp, retryAfterMs) : exp;
  return Math.min(maxMs, Math.max(baseMs, desired));
}
