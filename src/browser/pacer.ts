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
