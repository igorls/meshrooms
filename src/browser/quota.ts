/**
 * Per-member receive quotas (DEC-6): each member may send this device 60 of each kind per minute, in bursts of up to 20.
 * They apply to live packets, the single signed operations a member's own device sends as they happen. Over-quota
 * packets are dropped: not stored, not relayed, and no receipt. A dropped message stays in its sender's outbox and is
 * sent again. Task, decision and reaction operations have no retry of their own, so the receiver notes the peer
 * (QuotaDrops) and, once the burst is over, asks it for its state again (a sync request, answered with envelopes).
 *
 * Sync envelopes (a peer's whole board, decisions or reactions, exchanged when a channel opens) are not charged: a
 * newcomer legitimately receives hundreds of operations per author at once. A modified client can therefore wrap a
 * flood in an envelope; what that can do is bounded by the per-member caps (live reaction keys, decision shares, task
 * revision jumps) and the room-wide log caps, not by this quota.
 */
export type QuotaKind = 'message' | 'history' | 'task' | 'decision' | 'reaction' | 'retract' | 'vfs' | 'vfs-sync';
export const QUOTA_PER_MINUTE = 60, QUOTA_BURST = 20;
/**
 * History replication receive quota per author member: a higher burst (512) and refill (600/min) lets a newcomer
 * or newly paired device catch up a busy single-author room without stalling while still capping sustained pushes,
 * with `QuotaDrops` resuming cleanly if a single author exceeds the burst.
 */
export const HISTORY_QUOTA_PER_MINUTE = 600, HISTORY_QUOTA_BURST = 512;
/**
 * Room VFS receive quotas (`docs/flows/room-vfs.md` §6.2):
 * - `'vfs'`: live signed `vfs-record` / `vfs-key-*` packets per author/peer (60/min, burst 30)
 * - `'vfs-sync'`: batched `vfs-ops` catch-up entries per peer (1,024 entries/min, burst 512)
 * Isolated in separate buckets so an abusive VFS flood never drops or starves chat/history/tasks/decisions.
 */
export const VFS_QUOTA_PER_MINUTE = 60, VFS_QUOTA_BURST = 30;
export const VFS_SYNC_QUOTA_PER_MINUTE = 1024, VFS_SYNC_QUOTA_BURST = 512;
/** A peer whose state was dropped over quota is asked for it again once no drop has happened for this long. */
export const QUOTA_QUIET_MS = 5000;

/**
 * Peers whose live task, decision or reaction operations were dropped over quota. `due` (called from a tick) names each
 * once its burst is over, to be sent a sync request; the answer comes in sync envelopes, which are not charged, and the
 * peer answers at most once per RESYNC_INTERVAL_MS, so a steady over-quota sender converges without a reconnect.
 */
export class QuotaDrops {
  private dropped = new Map<string, number>();
  constructor(private now: () => number = () => Date.now(), private quiet = QUOTA_QUIET_MS) {}
  drop(peer: string) { this.dropped.set(peer, this.now()); }
  due(): string[] {
    const at = this.now(), peers: string[] = [];
    for (const [peer, last] of this.dropped) if (at - last >= this.quiet) { peers.push(peer); this.dropped.delete(peer); }
    return peers;
  }
}

/** `tokens` in 1/60,000ths of a packet, so refills of whole milliseconds stay exact integers. */
type Bucket = { tokens: number; at: number; reported: number };
const UNIT = 60_000;

export class ReceiveQuota {
  private buckets = new Map<string, Bucket>();
  constructor(
    private now: () => number = () => Date.now(),
    private perMinute = QUOTA_PER_MINUTE,
    private burst = QUOTA_BURST,
    private maxBuckets = 512,
    private historyPerMinute = HISTORY_QUOTA_PER_MINUTE,
    private historyBurst = HISTORY_QUOTA_BURST,
    private vfsPerMinute = VFS_QUOTA_PER_MINUTE,
    private vfsBurst = VFS_QUOTA_BURST,
    private vfsSyncPerMinute = VFS_SYNC_QUOTA_PER_MINUTE,
    private vfsSyncBurst = VFS_SYNC_QUOTA_BURST,
  ) {}
  private limits(kind: QuotaKind) {
    if (kind === 'history') return { perMinute: this.historyPerMinute, burst: this.historyBurst };
    if (kind === 'vfs') return { perMinute: this.vfsPerMinute, burst: this.vfsBurst };
    if (kind === 'vfs-sync') return { perMinute: this.vfsSyncPerMinute, burst: this.vfsSyncBurst };
    return { perMinute: this.perMinute, burst: this.burst };
  }
  private bucket(memberId: string, kind: QuotaKind) {
    const key = `${kind}:${memberId}`, at = this.now(), { perMinute, burst } = this.limits(kind);
    let bucket = this.buckets.get(key);
    if (bucket) {
      this.buckets.delete(key); // Re-inserted below, so the map stays in least-recently-used order.
      bucket.tokens = Math.min(burst * UNIT, bucket.tokens + Math.max(0, at - bucket.at) * perMinute); bucket.at = at;
    } else bucket = { tokens: burst * UNIT, at, reported: -Infinity };
    this.buckets.set(key, bucket);
    if (this.buckets.size > this.maxBuckets) this.buckets.delete(this.buckets.keys().next().value!);
    return bucket;
  }
  /** Spend `cost` packet units of `kind` from `memberId`; false when over quota (drop the packet). */
  take(memberId: string, kind: QuotaKind, cost = 1) {
    const bucket = this.bucket(memberId, kind);
    const need = Math.max(1, Math.floor(cost)) * UNIT;
    if (bucket.tokens < need) return false;
    bucket.tokens -= need; return true;
  }
  /** Whether a drop is worth a log line: the first per member and kind each minute, so a flood doesn't flood the log. */
  report(memberId: string, kind: QuotaKind) {
    const bucket = this.bucket(memberId, kind), at = this.now();
    if (at - bucket.reported < 60_000) return false;
    bucket.reported = at; return true;
  }
}
