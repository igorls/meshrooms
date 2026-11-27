/**
 * Room VFS Relay Pacing, Edit Coalescing, and Per-Peer Anti-Entropy Sync Tracking
 * (`docs/flows/room-vfs.md` §6.2).
 *
 * Pure TypeScript with zero runtime dependencies (identical in Browser and Bun).
 */

import {
  VFS_COALESCE_RELAY_MS,
  VFS_COALESCE_WEBRTC_MS,
  VFS_RELAY_MAX_BLOCK_FRAMES_PER_MIN,
  VFS_RELAY_MAX_BYTES_PER_MIN,
  VFS_RELAY_MAX_FRAMES_PER_MIN,
  VFS_RELAY_MAX_OPS_FRAMES_PER_MIN,
  VfsError,
} from './constants';

// ---------------------------------------------------------------------------
// VfsRelayBudget — Sliding-Window Relay Frame & Byte Pacer with Chat Yield
// ---------------------------------------------------------------------------

export type VfsRelayBudgetLane = 'ops' | 'block';

export type VfsRelayBudgetOptions = {
  /** Max combined VFS frames per rolling window (default `48` / min, reserving >= 50% of relay 120/min for chat). */
  maxFramesPerMin?: number;
  /** Optional ops-lane sub-cap when `lane === 'ops'` is passed (default `30` / min). */
  maxOpsFramesPerMin?: number;
  /** Optional block-lane sub-cap when `lane === 'block'` is passed (default `18` / min). */
  maxBlockFramesPerMin?: number;
  /** Max combined VFS bytes per rolling window (default `900 * 1024` B / min, reserving >= 50% of 2 MiB/min). */
  maxBytesPerMin?: number;
  /** Sliding window length in ms (default `60_000`). */
  windowMs?: number;
  /** Suggested wait hint returned by `nextAvailableMs` when yielding to queued chat frames (default `250`). */
  chatPriorityYieldMs?: number;
  /** Optional hook returning `true` when primary chat frames are waiting to send, pausing VFS immediately. */
  chatPriorityPending?: () => boolean;
  /** Clock function (injectable for deterministic tests). */
  now?: () => number;
  /** Random source in `[0, 1)` for jittered relay rate-limit backoff. */
  random?: () => number;
};

export type VfsRelayBudgetStats = {
  framesUsed: number;
  opsFramesUsed: number;
  blockFramesUsed: number;
  bytesUsed: number;
  maxFramesPerMin: number;
  maxBytesPerMin: number;
  backoffRemainingMs: number;
  chatYielding: boolean;
};

type BudgetEntry = {
  at: number;
  bytes: number;
  lane?: VfsRelayBudgetLane;
};

const RATE_LIMIT_BACKOFF_STEPS_MS = [2_000, 5_000, 15_000] as const;

export class VfsRelayBudget {
  readonly maxFramesPerMin: number;
  readonly maxOpsFramesPerMin: number;
  readonly maxBlockFramesPerMin: number;
  readonly maxBytesPerMin: number;
  readonly windowMs: number;
  readonly chatPriorityYieldMs: number;

  private chatPriorityPending?: () => boolean;
  private readonly nowFn: () => number;
  private readonly randomFn: () => number;
  private entries: BudgetEntry[] = [];
  private rateLimitStreak = 0;
  private backoffUntil = 0;

  constructor(opts: VfsRelayBudgetOptions = {}) {
    this.maxFramesPerMin = opts.maxFramesPerMin ?? VFS_RELAY_MAX_FRAMES_PER_MIN;
    this.maxOpsFramesPerMin = opts.maxOpsFramesPerMin ?? VFS_RELAY_MAX_OPS_FRAMES_PER_MIN;
    this.maxBlockFramesPerMin = opts.maxBlockFramesPerMin ?? VFS_RELAY_MAX_BLOCK_FRAMES_PER_MIN;
    this.maxBytesPerMin = opts.maxBytesPerMin ?? VFS_RELAY_MAX_BYTES_PER_MIN;
    this.windowMs = opts.windowMs ?? 60_000;
    this.chatPriorityYieldMs = opts.chatPriorityYieldMs ?? 250;
    this.chatPriorityPending = opts.chatPriorityPending;
    this.nowFn = opts.now ?? (() => Date.now());
    this.randomFn = opts.random ?? (() => Math.random());

    if (!Number.isSafeInteger(this.maxFramesPerMin) || this.maxFramesPerMin < 1) {
      throw new VfsError('VFS_LIMIT_EXCEEDED', 'VfsRelayBudget maxFramesPerMin must be a positive integer.');
    }
    if (!Number.isSafeInteger(this.maxBytesPerMin) || this.maxBytesPerMin < 1) {
      throw new VfsError('VFS_LIMIT_EXCEEDED', 'VfsRelayBudget maxBytesPerMin must be a positive integer.');
    }
    if (!Number.isSafeInteger(this.windowMs) || this.windowMs < 1) {
      throw new VfsError('VFS_LIMIT_EXCEEDED', 'VfsRelayBudget windowMs must be a positive integer.');
    }
  }

  setChatPriorityPending(hook: (() => boolean) | undefined): void {
    this.chatPriorityPending = hook;
  }

  private prune(t: number): void {
    const cutoff = t - this.windowMs;
    let keepFrom = 0;
    while (keepFrom < this.entries.length && this.entries[keepFrom].at <= cutoff) {
      keepFrom++;
    }
    if (keepFrom > 0) {
      this.entries.splice(0, keepFrom);
    }
  }

  private laneLimit(lane?: VfsRelayBudgetLane): number | undefined {
    if (lane === 'ops') return this.maxOpsFramesPerMin;
    if (lane === 'block') return this.maxBlockFramesPerMin;
    return undefined;
  }

  private countLane(lane: VfsRelayBudgetLane): number {
    let n = 0;
    for (const e of this.entries) {
      if (e.lane === lane) n++;
    }
    return n;
  }

  private sumBytes(): number {
    let total = 0;
    for (const e of this.entries) total += e.bytes;
    return total;
  }

  /**
   * Returns `true` when sending a VFS relay frame of `bytes` fits within the sliding frame/byte
   * budget, no rate-limit backoff is active, and chat has no higher-priority outbound frames queued.
   */
  canSend(bytes: number, now?: number, lane?: VfsRelayBudgetLane): boolean {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0 || bytes > this.maxBytesPerMin) {
      return false;
    }
    const t = now ?? this.nowFn();
    if (this.chatPriorityPending?.()) return false;
    if (t < this.backoffUntil) return false;

    this.prune(t);
    if (this.entries.length + 1 > this.maxFramesPerMin) return false;
    if (this.sumBytes() + bytes > this.maxBytesPerMin) return false;
    if (lane !== undefined) {
      const cap = this.laneLimit(lane)!;
      if (this.countLane(lane) + 1 > cap) return false;
    }
    return true;
  }

  /**
   * Consumes budget for one VFS relay frame if allowed; returns `true` if admitted, `false` otherwise.
   */
  consume(bytes: number, now?: number, lane?: VfsRelayBudgetLane): boolean {
    const t = now ?? this.nowFn();
    if (!this.canSend(bytes, t, lane)) return false;
    this.entries.push(lane !== undefined ? { at: t, bytes, lane } : { at: t, bytes });
    this.rateLimitStreak = 0;
    return true;
  }

  /**
   * Computes milliseconds until a VFS relay frame of `bytes` may be sent (`0` if sendable now,
   * `Infinity` if `bytes` exceeds the total per-window byte ceiling).
   */
  nextAvailableMs(bytes: number, now?: number, lane?: VfsRelayBudgetLane): number {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0 || bytes > this.maxBytesPerMin) {
      return Infinity;
    }
    const t = now ?? this.nowFn();
    this.prune(t);

    let waitMs = 0;
    if (this.chatPriorityPending?.()) {
      waitMs = Math.max(waitMs, this.chatPriorityYieldMs);
    }
    if (t < this.backoffUntil) {
      waitMs = Math.max(waitMs, this.backoffUntil - t);
    }

    let frames = this.entries.length;
    let usedBytes = this.sumBytes();
    let laneFrames = lane !== undefined ? this.countLane(lane) : 0;
    const laneCap = this.laneLimit(lane);

    const fits = () =>
      frames + 1 <= this.maxFramesPerMin
      && usedBytes + bytes <= this.maxBytesPerMin
      && (laneCap === undefined || laneFrames + 1 <= laneCap);

    if (!fits()) {
      for (const e of this.entries) {
        frames--;
        usedBytes -= e.bytes;
        if (lane !== undefined && e.lane === lane) laneFrames--;
        if (fits()) {
          const expireWait = Math.max(0, e.at + this.windowMs - t);
          waitMs = Math.max(waitMs, expireWait);
          break;
        }
      }
    }

    return waitMs;
  }

  /**
   * Records a relay `rate-limit` rejection, pausing VFS sends with jittered backoff
   * (`2 s -> 5 s -> 15 s`, +/- 15% jitter) while preserving sync cursors.
   */
  noteRateLimited(now?: number): number {
    const t = now ?? this.nowFn();
    const step = RATE_LIMIT_BACKOFF_STEPS_MS[Math.min(this.rateLimitStreak, RATE_LIMIT_BACKOFF_STEPS_MS.length - 1)];
    this.rateLimitStreak = Math.min(this.rateLimitStreak + 1, RATE_LIMIT_BACKOFF_STEPS_MS.length - 1);
    const jitterFactor = 0.85 + Math.max(0, Math.min(1, this.randomFn())) * 0.3;
    const delay = Math.round(step * jitterFactor);
    this.backoffUntil = Math.max(this.backoffUntil, t + delay);
    return this.backoffUntil - t;
  }

  resetBackoff(): void {
    this.rateLimitStreak = 0;
    this.backoffUntil = 0;
  }

  stats(now?: number): VfsRelayBudgetStats {
    const t = now ?? this.nowFn();
    this.prune(t);
    return {
      framesUsed: this.entries.length,
      opsFramesUsed: this.countLane('ops'),
      blockFramesUsed: this.countLane('block'),
      bytesUsed: this.sumBytes(),
      maxFramesPerMin: this.maxFramesPerMin,
      maxBytesPerMin: this.maxBytesPerMin,
      backoffRemainingMs: Math.max(0, this.backoffUntil - t),
      chatYielding: Boolean(this.chatPriorityPending?.()),
    };
  }
}

// ---------------------------------------------------------------------------
// VfsEditCoalescer — Per-Node Debounce + Max Batch Window Coalescer
// ---------------------------------------------------------------------------

export const VFS_COALESCE_MAX_BATCH_WINDOW_MS = 2_000;

export type VfsTransportMode = 'webrtc' | 'relay';
export type VfsFlushReason = 'debounce' | 'max-window' | 'commit' | 'revert' | 'close' | 'manual';

export type VfsEditCoalescerOptions<T> = {
  /** Active transport mode (`'webrtc'` -> 300 ms, `'relay'` -> 1,000 ms). Default `'webrtc'`. */
  transport?: VfsTransportMode;
  webrtcIntervalMs?: number;
  relayIntervalMs?: number;
  maxBatchWindowMs?: number;
  onFlush: (nodeId: string, edits: T[], reason: VfsFlushReason) => void | Promise<void>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

type CoalesceBucket<T> = {
  edits: T[];
  firstAt: number;
  timer?: unknown;
};

export class VfsEditCoalescer<T = unknown> {
  readonly webrtcIntervalMs: number;
  readonly relayIntervalMs: number;
  readonly maxBatchWindowMs: number;

  private mode: VfsTransportMode;
  private closed = false;
  private buckets = new Map<string, CoalesceBucket<T>>();
  private readonly onFlush: (nodeId: string, edits: T[], reason: VfsFlushReason) => void | Promise<void>;
  private readonly nowFn: () => number;
  private readonly setTimerFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimerFn: (handle: unknown) => void;

  constructor(opts: VfsEditCoalescerOptions<T>) {
    this.mode = opts.transport ?? 'webrtc';
    this.webrtcIntervalMs = opts.webrtcIntervalMs ?? VFS_COALESCE_WEBRTC_MS;
    this.relayIntervalMs = opts.relayIntervalMs ?? VFS_COALESCE_RELAY_MS;
    this.maxBatchWindowMs = opts.maxBatchWindowMs ?? VFS_COALESCE_MAX_BATCH_WINDOW_MS;
    this.onFlush = opts.onFlush;
    this.nowFn = opts.now ?? (() => Date.now());
    this.setTimerFn = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimerFn = opts.clearTimer ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get transport(): VfsTransportMode {
    return this.mode;
  }

  get intervalMs(): number {
    return this.mode === 'relay' ? this.relayIntervalMs : this.webrtcIntervalMs;
  }

  setTransport(mode: VfsTransportMode): void {
    this.mode = mode;
  }

  hasPending(nodeId?: string): boolean {
    if (nodeId !== undefined) return (this.buckets.get(nodeId)?.edits.length ?? 0) > 0;
    return this.buckets.size > 0;
  }

  pendingCount(nodeId?: string): number {
    if (nodeId !== undefined) return this.buckets.get(nodeId)?.edits.length ?? 0;
    let total = 0;
    for (const bucket of this.buckets.values()) total += bucket.edits.length;
    return total;
  }

  /**
   * Queues a local edit for `nodeId`. Rapid edits coalesce within `intervalMs` (`300 ms` WebRTC /
   * `1,000 ms` Relay) and always flush once `maxBatchWindowMs` (`2,000 ms`) elapses since the
   * first queued edit in the batch.
   */
  enqueue(nodeId: string, edit: T): void {
    if (this.closed) {
      throw new VfsError('VFS_STORAGE_CLOSED', 'VfsEditCoalescer is closed.');
    }
    const t = this.nowFn();
    let bucket = this.buckets.get(nodeId);
    if (!bucket) {
      bucket = { edits: [], firstAt: t };
      this.buckets.set(nodeId, bucket);
    }
    bucket.edits.push(edit);

    if (bucket.timer !== undefined) {
      this.clearTimerFn(bucket.timer);
      bucket.timer = undefined;
    }

    const remainingMax = this.maxBatchWindowMs - (t - bucket.firstAt);
    if (remainingMax <= 0) {
      void this.flush(nodeId, 'max-window');
      return;
    }

    const delay = Math.min(this.intervalMs, remainingMax);
    const hitMaxWindow = remainingMax <= this.intervalMs;
    bucket.timer = this.setTimerFn(() => {
      void this.flush(nodeId, hitMaxWindow ? 'max-window' : 'debounce');
    }, delay);
  }

  /** Immediately flushes any queued edits for `nodeId` (e.g. on `commit`, `revert`, or `manual`). */
  async flush(nodeId: string, reason: VfsFlushReason = 'manual'): Promise<void> {
    const bucket = this.buckets.get(nodeId);
    if (!bucket) return;
    if (bucket.timer !== undefined) {
      this.clearTimerFn(bucket.timer);
      bucket.timer = undefined;
    }
    this.buckets.delete(nodeId);
    if (bucket.edits.length === 0) return;
    await this.onFlush(nodeId, bucket.edits, reason);
  }

  async flushCommit(nodeId: string): Promise<void> {
    await this.flush(nodeId, 'commit');
  }

  async flushRevert(nodeId: string): Promise<void> {
    await this.flush(nodeId, 'revert');
  }

  async flushAll(reason: VfsFlushReason = 'manual'): Promise<void> {
    const nodeIds = [...this.buckets.keys()];
    for (const nodeId of nodeIds) {
      await this.flush(nodeId, reason);
    }
  }

  /** Flushes all pending edits immediately with reason `'close'` and rejects future enqueues. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.flushAll('close');
  }
}

// ---------------------------------------------------------------------------
// VfsSyncTracker — Per-Peer Anti-Entropy Round & Retry Backoff State Machine
// ---------------------------------------------------------------------------

export const VFS_SYNC_DEFAULT_MAX_ROUNDS = 64;
export const VFS_SYNC_DEFAULT_ROUND_TIMEOUT_MS = 5_000;
export const VFS_SYNC_DEFAULT_BASE_RETRY_MS = 1_000;
export const VFS_SYNC_DEFAULT_MAX_BACKOFF_MS = 30_000;
export const VFS_SYNC_DEFAULT_MAX_TIMEOUTS = 6;

export type VfsSyncTrackerOptions = {
  /** Max `vfs-have` / `vfs-ops` rounds per peer per frontier sync cycle (default `64`). */
  maxRounds?: number;
  /** Timeout before an unanswered in-flight `vfs-have` round fails and backs off (default `5,000` ms). */
  roundTimeoutMs?: number;
  /** Initial exponential retry backoff on round timeout (default `1,000` ms). */
  baseRetryMs?: number;
  /** Maximum exponential retry backoff (default `30,000` ms). */
  maxBackoffMs?: number;
  /** Max consecutive round timeouts before pausing sync for that peer until reconnect (default `6`). */
  maxTimeouts?: number;
  now?: () => number;
};

export type VfsPeerSyncState = {
  readonly inFlight: boolean;
  readonly inFlightSince?: number;
  readonly roundsUsed: number;
  readonly consecutiveTimeouts: number;
  readonly paused: boolean;
  readonly nextRetryAt: number;
  readonly cursor?: string;
  readonly remoteFrontierHash?: string;
  readonly syncedFrontierHash?: string;
};

type MutablePeerSyncState = {
  inFlight: boolean;
  inFlightSince?: number;
  roundsUsed: number;
  consecutiveTimeouts: number;
  paused: boolean;
  nextRetryAt: number;
  cursor?: string;
  remoteFrontierHash?: string;
  syncedFrontierHash?: string;
};

export type VfsSyncOpsDecision =
  | { action: 'done' }
  | { action: 'continue'; cursor?: string }
  | { action: 'wait'; retryAfterMs: number; cursor?: string }
  | { action: 'paused' };

export type VfsSyncTimeoutEvent = {
  peerId: string;
  consecutiveTimeouts: number;
  paused: boolean;
  retryAfterMs: number;
};

export class VfsSyncTracker {
  readonly maxRounds: number;
  readonly roundTimeoutMs: number;
  readonly baseRetryMs: number;
  readonly maxBackoffMs: number;
  readonly maxTimeouts: number;

  private readonly nowFn: () => number;
  private peers = new Map<string, MutablePeerSyncState>();

  constructor(opts: VfsSyncTrackerOptions = {}) {
    this.maxRounds = opts.maxRounds ?? VFS_SYNC_DEFAULT_MAX_ROUNDS;
    this.roundTimeoutMs = opts.roundTimeoutMs ?? VFS_SYNC_DEFAULT_ROUND_TIMEOUT_MS;
    this.baseRetryMs = opts.baseRetryMs ?? VFS_SYNC_DEFAULT_BASE_RETRY_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? VFS_SYNC_DEFAULT_MAX_BACKOFF_MS;
    this.maxTimeouts = opts.maxTimeouts ?? VFS_SYNC_DEFAULT_MAX_TIMEOUTS;
    this.nowFn = opts.now ?? (() => Date.now());
  }

  private ensurePeer(peerId: string): MutablePeerSyncState {
    let state = this.peers.get(peerId);
    if (!state) {
      state = {
        inFlight: false,
        roundsUsed: 0,
        consecutiveTimeouts: 0,
        paused: false,
        nextRetryAt: 0,
      };
      this.peers.set(peerId, state);
    }
    return state;
  }

  getPeerState(peerId: string): VfsPeerSyncState | undefined {
    const state = this.peers.get(peerId);
    return state ? { ...state } : undefined;
  }

  /**
   * Returns `true` if a `vfs-have` should be sent to `peerId` right now.
   * Prevents sync loops when `frontierHash` already matches the peer's confirmed frontier,
   * while an in-flight round is active, during retry backoff, or once `maxRounds` is exhausted.
   */
  shouldSendHave(peerId: string, currentFrontierHash: string, now?: number): boolean {
    const t = now ?? this.nowFn();
    const state = this.peers.get(peerId);
    if (!state) return true;
    if (state.paused) return false;
    if (state.inFlight) return false;
    if (t < state.nextRetryAt) return false;
    if (state.roundsUsed >= this.maxRounds) return false;
    if (state.remoteFrontierHash !== undefined && state.remoteFrontierHash === currentFrontierHash) {
      return false;
    }
    if (
      state.syncedFrontierHash !== undefined
      && state.syncedFrontierHash === currentFrontierHash
      && state.cursor === undefined
    ) {
      return false;
    }
    return true;
  }

  /** Records that a `vfs-have` round was dispatched to `peerId`. */
  markHaveSent(peerId: string, currentFrontierHash: string, now?: number): void {
    const t = now ?? this.nowFn();
    const state = this.ensurePeer(peerId);
    if (state.syncedFrontierHash !== undefined && state.syncedFrontierHash !== currentFrontierHash) {
      state.syncedFrontierHash = undefined;
    }
    state.inFlight = true;
    state.inFlightSince = t;
    state.roundsUsed++;
  }

  /**
   * Records a `vfs-have` received from `peerId`. When `remoteFrontierHash === currentFrontierHash`,
   * marks the peer synced with zero further ops rounds required (eliminating sync ping-pong loops).
   */
  recordRemoteHave(
    peerId: string,
    remoteFrontierHash: string,
    currentFrontierHash: string,
  ): { matched: boolean } {
    const state = this.ensurePeer(peerId);
    const prevRemote = state.remoteFrontierHash;
    state.remoteFrontierHash = remoteFrontierHash;
    if (remoteFrontierHash === currentFrontierHash) {
      state.inFlight = false;
      state.inFlightSince = undefined;
      state.consecutiveTimeouts = 0;
      state.nextRetryAt = 0;
      state.cursor = undefined;
      state.syncedFrontierHash = currentFrontierHash;
      return { matched: true };
    }
    // Peer advertises a NEW differing frontier: allow a fresh sync cycle if not paused by timeouts.
    if (state.syncedFrontierHash === currentFrontierHash && prevRemote !== remoteFrontierHash) {
      state.syncedFrontierHash = undefined;
      if (!state.paused) state.roundsUsed = 0;
    }
    return { matched: false };
  }

  /**
   * Records a `vfs-ops` response received from `peerId` and advises whether the sync cycle is
   * `'done'`, should `'continue'` with `cursor`, should `'wait'` (`retryAfterMs`), or is `'paused'`.
   */
  recordOpsReceived(
    peerId: string,
    info: {
      more: boolean;
      nextCursor?: string;
      retryAfterMs?: number;
      currentFrontierHash: string;
    },
    now?: number,
  ): VfsSyncOpsDecision {
    const t = now ?? this.nowFn();
    const state = this.ensurePeer(peerId);
    state.inFlight = false;
    state.inFlightSince = undefined;
    state.consecutiveTimeouts = 0;

    if (info.retryAfterMs !== undefined && info.retryAfterMs > 0) {
      const wait = Math.min(info.retryAfterMs, this.maxBackoffMs);
      state.nextRetryAt = t + wait;
      if (info.nextCursor !== undefined) state.cursor = info.nextCursor;
      return { action: 'wait', retryAfterMs: wait, ...(state.cursor ? { cursor: state.cursor } : {}) };
    }

    if (info.more) {
      state.cursor = info.nextCursor;
      if (state.roundsUsed >= this.maxRounds) {
        state.paused = true;
        return { action: 'paused' };
      }
      return { action: 'continue', ...(state.cursor ? { cursor: state.cursor } : {}) };
    }

    state.cursor = undefined;
    state.nextRetryAt = 0;
    state.syncedFrontierHash = info.currentFrontierHash;
    return { action: 'done' };
  }

  /**
   * Checks all peers with in-flight `vfs-have` rounds against `roundTimeoutMs`.
   * Timed-out peers transition out of `inFlight` with exponential retry backoff
   * (`baseRetryMs * 2^(consecutiveTimeouts - 1)`, capped at `maxBackoffMs`) and pause after `maxTimeouts`.
   */
  collectTimeouts(now?: number): VfsSyncTimeoutEvent[] {
    const t = now ?? this.nowFn();
    const events: VfsSyncTimeoutEvent[] = [];
    for (const [peerId, state] of this.peers.entries()) {
      if (!state.inFlight || state.inFlightSince === undefined) continue;
      if (t - state.inFlightSince < this.roundTimeoutMs) continue;

      state.inFlight = false;
      state.inFlightSince = undefined;
      state.consecutiveTimeouts++;

      const backoff = Math.min(
        this.baseRetryMs * (2 ** (state.consecutiveTimeouts - 1)),
        this.maxBackoffMs,
      );
      if (state.consecutiveTimeouts >= this.maxTimeouts) {
        state.paused = true;
        state.nextRetryAt = Infinity;
      } else {
        state.nextRetryAt = t + backoff;
      }

      events.push({
        peerId,
        consecutiveTimeouts: state.consecutiveTimeouts,
        paused: state.paused,
        retryAfterMs: state.paused ? Infinity : backoff,
      });
    }
    return events;
  }

  /**
   * Notifies the tracker that our room's frontier changed (e.g. local edit or new ops applied),
   * reopening sync eligibility for non-paused peers whose synced frontier is now stale.
   */
  notifyFrontierChanged(newFrontierHash: string): void {
    for (const state of this.peers.values()) {
      if (state.syncedFrontierHash !== newFrontierHash) {
        state.syncedFrontierHash = undefined;
        if (!state.paused) {
          state.roundsUsed = 0;
        }
      }
      if (state.remoteFrontierHash === newFrontierHash) {
        state.syncedFrontierHash = newFrontierHash;
      }
    }
  }

  /** Resets per-peer sync state (e.g. on peer reconnect). */
  resetPeer(peerId: string): void {
    this.peers.delete(peerId);
  }

  /** Removes a disconnected peer's state. */
  removePeer(peerId: string): void {
    this.peers.delete(peerId);
  }
}
