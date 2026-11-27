/**
 * Peer-to-peer message history replication (`docs/flows/history-replication.md`).
 *
 * Pure protocol logic shared by browsers (`peers.ts`), agent bridges (`server/browser-agent.ts`),
 * and future WormDB-backed native nodes:
 * - Each new message carries a signed `visibility` (`'members' | 'room'`), a per-author-device `seq`,
 *   and (for `'members'` messages) a signed `audienceUntil` (the newest `member.joinedAt` known at send time).
 * - Peers exchange `history-have` version vectors + coalesced sparse sequence ranges on connect and serve
 *   only entries the requester is authorized to see, newest first in bounded chunks.
 * - Equivocation (two distinct message IDs for one `(deviceId, seq)`) and cross-device ID collisions are
 *   preserved and surfaced as evidence rather than hidden; missing sequence numbers are exposed as O(N) ranges.
 */
import type { AttachmentRef } from './files';
import { MAX_STORED_MESSAGES } from './history';
import type { MessageVisibility, RoomStatus } from './protocol';
import type { SignedRoster } from './relay-crypto';
import { isRetracted, type RetractBody } from './retractions';

/** Data channel messages over 20,000 chars are dropped; keep history packets comfortably below both that and the 32 KB relay cap. */
export const HISTORY_CHUNK_CHARS = 15_000;
/** Maximum history entries returned for a single `history-have` request (newest first). */
export const MAX_HISTORY_PER_RESPONSE = 64;
/** Maximum convergence rounds per peer per connection (> MAX_STORED_MESSAGES / MAX_HISTORY_PER_RESPONSE, leaving headroom for retries). */
export const MAX_HISTORY_ROUNDS = 120;
/** Maximum accepted per-device sequence number so huge forged values (e.g. 1e9) are rejected at the boundary. */
export const MAX_MESSAGE_SEQ = 10_000_000;
/** Maximum forward sequence jump allowed above the highest seq already held for a device. */
export const MAX_SEQ_JUMP = 50_000;
/** Maximum author-device entries accepted in a peer's `history-have` vector. */
export const MAX_VECTOR_ENTRIES = 256;
/** Maximum coalesced `[start, end]` sparse sequence ranges listed per author device in `history-have`. */
export const MAX_SPARSE_RANGES_PER_DEVICE = 64;
/** Maximum 16-hex conflict evidence digests advertised in `history-have`. */
export const MAX_CONFLICT_IDS = 128;
/** Maximum 16-hex legacy (seq-less) message digests advertised in `history-have`. */
export const MAX_LEGACY_IDS = 512;
/** Per-peer token bucket on `serveHistory` (`history-have` requests), ignoring the request digest; throttled requests receive a bounded `retryAfterMs` hint. */
export const HISTORY_SERVE_PER_MINUTE = 60;
export const HISTORY_SERVE_BURST = 24;
/**
 * Per-peer entry-counted token bucket on incoming `history` packets before signature verification.
 * Counting entries (rather than 15 KB wire chunks) ensures a 64-entry round of long 3–4 KB agent messages
 * costs the same 64 tokens as a single-chunk round, while still strictly bounding signature-verification CPU.
 */
export const HISTORY_ACCEPT_ENTRIES_PER_MINUTE = 3840;
export const HISTORY_ACCEPT_ENTRIES_BURST = 2048;
export const HISTORY_ACCEPT_PER_MINUTE = HISTORY_ACCEPT_ENTRIES_PER_MINUTE;
export const HISTORY_ACCEPT_BURST = HISTORY_ACCEPT_ENTRIES_BURST;
/** How long before an unanswered relay `history-have` may be retried for the same peer in a session. */
export const RELAY_HISTORY_RETRY_MS = 60_000;
/** Requester-side timeout before retrying an unanswered in-flight history round (covers silent rate-limit drops, lost packets, and full send queues). */
export const HISTORY_ROUND_TIMEOUT_MS = 5_000;
/** Maximum consecutive silent round timeouts per peer before pausing until reconnect. */
export const MAX_HISTORY_ROUND_TIMEOUTS = 6;

const MAX_TIME = 8_640_000_000_000_000;
const MAX_RETRY_AFTER_MS = 600_000;

/** Inclusive sequence range `[start, end]` with `1 <= start <= end <= MAX_MESSAGE_SEQ`. */
export type SeqRange = [number, number];

/**
 * Stateless server-side pagination cursor ordered strictly by the serving peer's own receipt clock
 * plus immutable identity (`receivedAt`, `deviceId`, `seq`, `id`), never by author-chosen `at`.
 */
export type HistoryCursor = {
  /** Serving peer's `receivedAt ?? 0`. */
  r: number;
  /** Author `deviceId`. */
  d: string;
  /** Author `seq ?? 0`. */
  s: number;
  /** Message `id`. */
  i: string;
};

export type HistoryMessageBody = {
  kind: 'message';
  roomId: string;
  id: string;
  deviceId: string;
  memberId: string;
  text: string;
  at: number;
  replyTo?: string;
  attachments?: AttachmentRef[];
  visibility?: MessageVisibility;
  seq?: number;
  /** For `'members'` messages: newest `member.joinedAt` known to the author at send time (same clock as `member.joinedAt`). */
  audienceUntil?: number;
};

export type HistoryEntryPacket = {
  body: HistoryMessageBody;
  signature: string;
};

/**
 * Stored message shape shared across browser IndexedDB and agent JSON stores.
 * `receivedAt` and `replicated` sit outside `packet` (never signed): `receivedAt` records this peer's
 * own receipt clock when the message arrived live; `replicated` marks an entry learned through history
 * replication so `'members'` entries are never re-served across members using a later clock.
 */
export type HistoryStoredMessage = {
  packet: HistoryEntryPacket;
  targets: string[];
  receipts: string[];
  retracted?: true;
  receivedAt?: number;
  replicated?: true;
};

export type HistoryHavePacket = {
  kind: 'history-have';
  roomId: string;
  /** Highest contiguous `seq` held per author device (stops before any gap or equivocation). */
  vector: Record<string, number>;
  /** Coalesced `[start, end]` sequence ranges strictly above `vector[dev]` (excluding equivocating seqs). */
  haveSeqs?: Record<string, SeqRange[]>;
  /** 16-hex `(deviceId, id)` digests of already-held equivocating messages so peers still forward unknown conflicting evidence without infinite resends. */
  conflictIds?: string[];
  /** 16-hex `(deviceId, id)` digests of held legacy (seq-less) messages, used only between devices qualifying for `'members'`. */
  legacyIds?: string[];
  /** Server-side pagination cursor echoed from the previous round's `nextCursor` so progress never depends on summary caps or author clocks. */
  cursor?: HistoryCursor;
  /** Optimization hint set only when the requester's 5,000-message window is full (no half-cap skew): entries with `at < windowFullAt` would be immediately evicted. */
  windowFullAt?: number;
};

export type HistoryPacket = {
  kind: 'history';
  roomId: string;
  entries: HistoryEntryPacket[];
  /** True on the final chunk of a round when the serving peer still has more allowed entries after this batch. */
  more?: boolean;
  /** Pagination cursor of the last entry in this round (sent alongside `more: true`). */
  nextCursor?: HistoryCursor;
  /** True on the final chunk of the final round when no further entries remain. */
  done?: true;
  /** Sent with empty `entries` when the serving peer's rate limiter is full, telling the requester when to retry instead of stalling silently. */
  retryAfterMs?: number;
};

export type HistoryAnalysis = {
  vector: Record<string, number>;
  haveSeqs: Record<string, SeqRange[]>;
  /** Author devices for which two distinct message IDs share one `(deviceId, seq)`. */
  equivocatingDevices: Set<string>;
  /** Specific `(deviceId, id)` keys participating in a `(deviceId, seq)` collision. */
  equivocatingMessageKeys: Set<string>;
  /** Message IDs participating in a `(deviceId, seq)` collision. */
  equivocatingMessageIds: Set<string>;
  /** Message IDs signed by more than one distinct device (ID squatting / collision evidence). */
  collidingMessageIds: Set<string>;
  /** Lowest conflicting `seq` per equivocating device. */
  firstConflictSeq: Map<string, number>;
  /** All missing sequence ranges (`[start, end]`) per author device starting from seq 1 (protocol/sync view). */
  gapsByDevice: Map<string, SeqRange[]>;
  /** Interior missing sequence ranges strictly between the lowest and highest held seq per device (excludes leading late-joiner/evicted prefixes). */
  interiorGapsByDevice: Map<string, SeqRange[]>;
  /** Interior missing sequence ranges not accounted for by known retractions (UI warning view). */
  unexplainedGapsByDevice: Map<string, SeqRange[]>;
  hasGaps: boolean;
  hasVisibleGaps: boolean;
};

const DEVICE_HEX = /^[a-f0-9]{64}$/;
const UUID_HEX = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIGEST_HEX = /^[a-f0-9]{16}$/;
const MASK64 = 0xffffffffffffffffn;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

/** Composite storage & deduplication key `(deviceId, id)` so one member can never squat on another member's message ID. */
export const messageKey = (deviceId: string, id: string): string => `${deviceId}:${id}`;

/**
 * Deterministic 64-bit (16-hex) digest keyed by BOTH `deviceId` and `id` (FNV-1a 64-bit + SplitMix64 finalizer).
 * Because `deviceId` is bound to the signer's public key, an attacker cannot choose a message `id` to shadow another
 * device's legacy message or conflict evidence.
 */
export function entryDigest(deviceId: string, id: string): string {
  const input = `${deviceId}\0${id}`;
  let h = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    h = ((h ^ BigInt(input.charCodeAt(i))) * FNV_PRIME) & MASK64;
  }
  h = ((h ^ (h >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  h = ((h ^ (h >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  h = (h ^ (h >> 31n)) & MASK64;
  return h.toString(16).padStart(16, '0');
}

export const validMessageVisibility = (value: unknown): value is MessageVisibility | undefined =>
  value === undefined || value === 'members' || value === 'room';

export const validMessageSeq = (value: unknown): value is number | undefined =>
  value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_MESSAGE_SEQ);

export const validAudienceUntil = (value: unknown): value is number | undefined =>
  value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME);

/** Rejects forged `seq` jumps far above the highest seq already held for that device. */
export function withinSeqJump(seq: number | undefined, maxHeld: number): boolean {
  if (seq === undefined) return true;
  if (!validMessageSeq(seq)) return false;
  return maxHeld <= 0 || seq <= maxHeld + MAX_SEQ_JUMP;
}

/** Highest held `seq` per author device across `messages`. */
export function maxSeqByDevice(messages: readonly Pick<HistoryStoredMessage, 'packet'>[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of messages) {
    const b = m.packet.body;
    if (typeof b.seq === 'number' && Number.isSafeInteger(b.seq) && b.seq >= 1) {
      const prev = out.get(b.deviceId) ?? 0;
      if (b.seq > prev) out.set(b.deviceId, b.seq);
    }
  }
  return out;
}

/** Highest held `seq` for a single author device across `messages` (0 when none held). */
export function maxSeqForDevice(messages: readonly Pick<HistoryStoredMessage, 'packet'>[], deviceId: string): number {
  let max = 0;
  for (const m of messages) {
    const b = m.packet.body;
    if (b.deviceId === deviceId && typeof b.seq === 'number' && Number.isSafeInteger(b.seq) && b.seq > max) max = b.seq;
  }
  return max;
}

/** Per-peer exact-millisecond token bucket (used for `serveHistory` and `acceptHistory` rate limiting, independent of request digests). */
export class PeerRateLimiter {
  private readonly unit = 60_000;
  private buckets = new Map<string, { tokens: number; at: number; reported: number; retryHintAt: number }>();
  constructor(
    private now: () => number = () => Date.now(),
    private perMinute = HISTORY_SERVE_PER_MINUTE,
    private burst = HISTORY_SERVE_BURST,
    private maxBuckets = 512,
  ) {}
  private bucket(peer: string) {
    const at = this.now();
    let b = this.buckets.get(peer);
    if (b) {
      this.buckets.delete(peer);
      b.tokens = Math.min(this.burst * this.unit, b.tokens + Math.max(0, at - b.at) * this.perMinute);
      b.at = at;
    } else {
      b = { tokens: this.burst * this.unit, at, reported: -Infinity, retryHintAt: -Infinity };
    }
    this.buckets.set(peer, b);
    if (this.buckets.size > this.maxBuckets) this.buckets.delete(this.buckets.keys().next().value!);
    return b;
  }
  take(peer: string, cost = 1): boolean {
    const needed = Math.max(1, cost) * this.unit;
    const b = this.bucket(peer);
    if (b.tokens < needed) return false;
    b.tokens -= needed;
    return true;
  }
  /** Milliseconds until `cost` tokens will be available for `peer`. */
  retryAfterMs(peer: string, cost = 1): number {
    const needed = Math.max(1, cost) * this.unit;
    const b = this.bucket(peer);
    if (b.tokens >= needed) return 0;
    return Math.max(250, Math.min(MAX_RETRY_AFTER_MS, Math.ceil((needed - b.tokens) / Math.max(1, this.perMinute))));
  }
  /** Bounds `retryAfterMs` hints to at most one per `minIntervalMs` per peer so floods cannot amplify traffic. */
  maySendRetryHint(peer: string, minIntervalMs = 1000): boolean {
    const b = this.bucket(peer);
    const at = this.now();
    if (at - b.retryHintAt < minIntervalMs) return false;
    b.retryHintAt = at;
    return true;
  }
  report(peer: string): boolean {
    const b = this.bucket(peer);
    const at = this.now();
    if (at - b.reported < 60_000) return false;
    b.reported = at;
    return true;
  }
}

export function isHistoryCursor(value: unknown): value is HistoryCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  return typeof c.r === 'number' && Number.isSafeInteger(c.r) && c.r >= 0 && c.r <= MAX_TIME
    && typeof c.d === 'string' && DEVICE_HEX.test(c.d)
    && typeof c.s === 'number' && Number.isSafeInteger(c.s) && c.s >= 0 && c.s <= MAX_MESSAGE_SEQ
    && typeof c.i === 'string' && UUID_HEX.test(c.i);
}

export function isHistoryHavePacket(value: unknown, roomId: string): value is HistoryHavePacket {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (p.kind !== 'history-have' || p.roomId !== roomId) return false;
  if (!p.vector || typeof p.vector !== 'object' || Array.isArray(p.vector)) return false;
  const vecEntries = Object.entries(p.vector as Record<string, unknown>);
  if (vecEntries.length > MAX_VECTOR_ENTRIES) return false;
  for (const [dev, seq] of vecEntries) {
    if (!DEVICE_HEX.test(dev) || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || seq > MAX_MESSAGE_SEQ) return false;
  }
  if (p.haveSeqs !== undefined) {
    if (!p.haveSeqs || typeof p.haveSeqs !== 'object' || Array.isArray(p.haveSeqs)) return false;
    const sparseEntries = Object.entries(p.haveSeqs as Record<string, unknown>);
    if (sparseEntries.length > MAX_VECTOR_ENTRIES) return false;
    for (const [dev, list] of sparseEntries) {
      if (!DEVICE_HEX.test(dev) || !Array.isArray(list) || list.length > MAX_SPARSE_RANGES_PER_DEVICE) return false;
      for (const range of list) {
        if (!Array.isArray(range) || range.length !== 2) return false;
        const [lo, hi] = range;
        if (typeof lo !== 'number' || typeof hi !== 'number' || !Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) return false;
        if (lo < 1 || hi < lo || hi > MAX_MESSAGE_SEQ) return false;
      }
    }
  }
  if (p.conflictIds !== undefined) {
    if (!Array.isArray(p.conflictIds) || p.conflictIds.length > MAX_CONFLICT_IDS) return false;
    for (const id of p.conflictIds) if (typeof id !== 'string' || !DIGEST_HEX.test(id)) return false;
  }
  if (p.legacyIds !== undefined) {
    if (!Array.isArray(p.legacyIds) || p.legacyIds.length > MAX_LEGACY_IDS) return false;
    for (const id of p.legacyIds) if (typeof id !== 'string' || !DIGEST_HEX.test(id)) return false;
  }
  if (p.cursor !== undefined && !isHistoryCursor(p.cursor)) return false;
  if (p.windowFullAt !== undefined && (typeof p.windowFullAt !== 'number' || !Number.isSafeInteger(p.windowFullAt) || p.windowFullAt < 0 || p.windowFullAt > MAX_TIME)) return false;
  return true;
}

export function isHistoryPacket(value: unknown, roomId: string): value is HistoryPacket {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (p.kind !== 'history' || p.roomId !== roomId) return false;
  if (!Array.isArray(p.entries) || p.entries.length > MAX_HISTORY_PER_RESPONSE) return false;
  if (p.more !== undefined && typeof p.more !== 'boolean') return false;
  if (p.nextCursor !== undefined && !isHistoryCursor(p.nextCursor)) return false;
  if (p.done !== undefined && p.done !== true) return false;
  if (p.retryAfterMs !== undefined && (typeof p.retryAfterMs !== 'number' || !Number.isSafeInteger(p.retryAfterMs) || p.retryAfterMs < 0 || p.retryAfterMs > MAX_RETRY_AFTER_MS)) return false;
  return true;
}

/** Next strictly increasing sequence number for `deviceId`, accounting for held messages (including stubs) and any persisted floor. */
export function nextAuthorSeq(
  messages: readonly Pick<HistoryStoredMessage, 'packet'>[],
  deviceId: string,
  persistedLastSeq = 0,
): number {
  let max = Number.isSafeInteger(persistedLastSeq) && persistedLastSeq > 0 ? persistedLastSeq : 0;
  for (const m of messages) {
    const b = m.packet.body;
    if (b.deviceId === deviceId && typeof b.seq === 'number' && Number.isSafeInteger(b.seq) && b.seq > max) {
      max = b.seq;
    }
  }
  return max + 1;
}

/** Checks whether `seq` falls inside any `[start, end]` range in `ranges`. */
export function inSeqRanges(ranges: readonly SeqRange[] | undefined, seq: number): boolean {
  if (!ranges?.length) return false;
  for (const [lo, hi] of ranges) {
    if (seq >= lo && seq <= hi) return true;
  }
  return false;
}

/**
 * Maps each bare message `id` to its canonical (first-seen) composite `messageKey(deviceId, id)`.
 * Prefers earliest local `receivedAt` (missing = 0, pre-existing local record), then non-replicated over
 * replicated, then live over retracted, then earliest array index so later cross-device ID collisions never
 * hijack `replyTo`, reactions, or agent cursors.
 */
export function canonicalMessageKeys(
  messages: readonly Pick<HistoryStoredMessage, 'packet' | 'receivedAt' | 'replicated' | 'retracted'>[],
): Map<string, string> {
  type Best = { key: string; receivedAt: number; replicated: number; retracted: number; index: number };
  const bestById = new Map<string, Best>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const b = m.packet.body;
    const cand: Best = {
      key: messageKey(b.deviceId, b.id),
      receivedAt: m.receivedAt ?? 0,
      replicated: m.replicated ? 1 : 0,
      retracted: isRetracted(m) ? 1 : 0,
      index: i,
    };
    const prev = bestById.get(b.id);
    if (!prev
      || cand.receivedAt < prev.receivedAt
      || (cand.receivedAt === prev.receivedAt && cand.replicated < prev.replicated)
      || (cand.receivedAt === prev.receivedAt && cand.replicated === prev.replicated && cand.retracted < prev.retracted)) {
      bestById.set(b.id, cand);
    }
  }
  const out = new Map<string, string>();
  for (const [id, best] of bestById) out.set(id, best.key);
  return out;
}

/** Resolves a listen cursor (`<id>` or `<deviceId>:<id>`) against stored messages using first-seen canonical semantics. */
export function storedCursorIndex(
  messages: readonly Pick<HistoryStoredMessage, 'packet' | 'receivedAt' | 'replicated' | 'retracted'>[],
  cursor: string,
): number {
  const sep = cursor.indexOf(':');
  if (sep > 0) {
    const dev = cursor.slice(0, sep), id = cursor.slice(sep + 1);
    const exact = messages.findIndex(m => m.packet.body.deviceId === dev && m.packet.body.id === id);
    if (exact >= 0) return exact;
  }
  const canonical = canonicalMessageKeys(messages).get(cursor);
  if (canonical) {
    const idx = messages.findIndex(m => messageKey(m.packet.body.deviceId, m.packet.body.id) === canonical);
    if (idx >= 0) return idx;
  }
  return messages.findIndex(m => m.packet.body.id === cursor);
}

/** Subtracts a set of known-explained individual sequence numbers from a list of inclusive `[lo, hi]` ranges. */
function subtractSeqs(ranges: readonly SeqRange[], explained: ReadonlySet<number>, unresolvedCredit: { count: number }): SeqRange[] {
  const out: SeqRange[] = [];
  for (const [lo, hi] of ranges) {
    // Only expand small spans for exact retraction subtraction; huge spans still keep O(1) range form.
    if (hi - lo > 256) {
      out.push([lo, hi]);
      continue;
    }
    let start: number | undefined;
    for (let s = lo; s <= hi; s++) {
      let skip = explained.has(s);
      if (!skip && unresolvedCredit.count > 0) {
        unresolvedCredit.count--;
        skip = true;
      }
      if (skip) {
        if (start !== undefined) { out.push([start, s - 1]); start = undefined; }
      } else if (start === undefined) {
        start = s;
      }
    }
    if (start !== undefined) out.push([start, hi]);
  }
  return out;
}

/**
 * Summarises a room's held messages into a per-author-device version vector + coalesced sparse ranges in O(N log N)
 * time and O(N) space (never iterating `1..maxSeq`), detects `(deviceId, seq)` equivocation and cross-device ID
 * collisions, and distinguishes protocol sync gaps (`gapsByDevice`) from unexplained interior gaps (`unexplainedGapsByDevice`).
 */
export function analyzeHistory(
  messages: readonly Pick<HistoryStoredMessage, 'packet'>[],
  retractions?: readonly RetractBody[],
): HistoryAnalysis {
  const byDevice = new Map<string, Map<number, Set<string>>>();
  const memberByDevice = new Map<string, string>();
  const heldTargets = new Set<string>();
  const devicesById = new Map<string, Set<string>>();
  for (const m of messages) {
    const b = m.packet.body;
    heldTargets.add(`${b.memberId}\0${b.id}`);
    memberByDevice.set(b.deviceId, b.memberId);
    let idDevs = devicesById.get(b.id);
    if (!idDevs) { idDevs = new Set(); devicesById.set(b.id, idDevs); }
    idDevs.add(b.deviceId);
    if (typeof b.seq !== 'number' || !Number.isSafeInteger(b.seq) || b.seq < 1) continue;
    let seqMap = byDevice.get(b.deviceId);
    if (!seqMap) { seqMap = new Map(); byDevice.set(b.deviceId, seqMap); }
    let ids = seqMap.get(b.seq);
    if (!ids) { ids = new Set(); seqMap.set(b.seq, ids); }
    ids.add(b.id);
  }

  const collidingMessageIds = new Set<string>();
  for (const [id, devs] of devicesById) {
    if (devs.size > 1) collidingMessageIds.add(id);
  }

  // Known retracted sequence numbers & unresolved retraction counts per member (to avoid false gap warnings for deleted messages).
  const retractedSeqsByDevice = new Map<string, Set<number>>();
  const retractedSeqsByMember = new Map<string, Set<number>>();
  const unresolvedByMember = new Map<string, { count: number }>();
  for (const op of retractions ?? []) {
    if (heldTargets.has(`${op.memberId}\0${op.target}`)) continue;
    if (typeof op.seq === 'number' && Number.isSafeInteger(op.seq) && op.seq >= 1) {
      if (op.targetDeviceId) {
        let set = retractedSeqsByDevice.get(op.targetDeviceId);
        if (!set) { set = new Set(); retractedSeqsByDevice.set(op.targetDeviceId, set); }
        set.add(op.seq);
      } else {
        let set = retractedSeqsByMember.get(op.memberId);
        if (!set) { set = new Set(); retractedSeqsByMember.set(op.memberId, set); }
        set.add(op.seq);
      }
    } else {
      let credit = unresolvedByMember.get(op.memberId);
      if (!credit) { credit = { count: 0 }; unresolvedByMember.set(op.memberId, credit); }
      credit.count++;
    }
  }

  const vector: Record<string, number> = {};
  const haveSeqs: Record<string, SeqRange[]> = {};
  const equivocatingDevices = new Set<string>();
  const equivocatingMessageKeys = new Set<string>();
  const equivocatingMessageIds = new Set<string>();
  const firstConflictSeq = new Map<string, number>();
  const gapsByDevice = new Map<string, SeqRange[]>();
  const interiorGapsByDevice = new Map<string, SeqRange[]>();
  const unexplainedGapsByDevice = new Map<string, SeqRange[]>();

  for (const [dev, seqMap] of byDevice) {
    const sorted = [...seqMap.keys()].sort((a, b) => a - b);
    let firstConflict: number | undefined;
    for (const seq of sorted) {
      const ids = seqMap.get(seq)!;
      if (ids.size > 1) {
        equivocatingDevices.add(dev);
        for (const id of ids) {
          equivocatingMessageIds.add(id);
          equivocatingMessageKeys.add(messageKey(dev, id));
        }
        if (firstConflict === undefined) firstConflict = seq;
      }
    }
    if (firstConflict !== undefined) firstConflictSeq.set(dev, firstConflict);

    // Advance contiguous vector strictly below any gap AND strictly below any equivocation.
    let contiguous = 0;
    for (const seq of sorted) {
      if (seq !== contiguous + 1) break;
      if (firstConflict !== undefined && seq >= firstConflict) break;
      contiguous = seq;
    }
    if (contiguous > 0) vector[dev] = contiguous;

    // Build gap ranges and coalesced sparse held ranges strictly in O(sorted.length).
    const gaps: SeqRange[] = [];
    const interiorGaps: SeqRange[] = [];
    const sparse: SeqRange[] = [];
    let expected = 1;
    for (let idx = 0; idx < sorted.length; idx++) {
      const seq = sorted[idx];
      if (seq > expected) {
        gaps.push([expected, seq - 1]);
        // Leading prefixes before `sorted[0]` are normal for late joiners (`members`-only history) and rolling-window eviction.
        if (idx > 0) interiorGaps.push([expected, seq - 1]);
      }
      expected = seq + 1;
      const ids = seqMap.get(seq)!;
      // Keep equivocating seqs out of `haveSeqs` so peers still forward unknown conflicting evidence.
      if (seq > contiguous && ids.size === 1) {
        const last = sparse.at(-1);
        if (last && last[1] + 1 === seq) last[1] = seq;
        else sparse.push([seq, seq]);
      }
    }
    if (sparse.length) haveSeqs[dev] = sparse.slice(-MAX_SPARSE_RANGES_PER_DEVICE);
    if (gaps.length) gapsByDevice.set(dev, gaps);
    if (interiorGaps.length) {
      interiorGapsByDevice.set(dev, interiorGaps);
      const memberId = memberByDevice.get(dev);
      const explained = new Set<number>([
        ...(retractedSeqsByDevice.get(dev) ?? []),
        ...(memberId ? (retractedSeqsByMember.get(memberId) ?? []) : []),
      ]);
      const credit = (memberId ? unresolvedByMember.get(memberId) : undefined) ?? { count: 0 };
      const remaining = subtractSeqs(interiorGaps, explained, credit);
      if (remaining.length) unexplainedGapsByDevice.set(dev, remaining);
    }
  }

  return {
    vector,
    haveSeqs,
    equivocatingDevices,
    equivocatingMessageKeys,
    equivocatingMessageIds,
    collidingMessageIds,
    firstConflictSeq,
    gapsByDevice,
    interiorGapsByDevice,
    unexplainedGapsByDevice,
    hasGaps: gapsByDevice.size > 0,
    hasVisibleGaps: unexplainedGapsByDevice.size > 0,
  };
}

/** Builds a bounded `history-have` summary packet guaranteed to fit under `HISTORY_CHUNK_CHARS`. */
export function buildHistoryHave(
  roomId: string,
  messages: readonly Pick<HistoryStoredMessage, 'packet'>[],
  options: { cursor?: HistoryCursor; maxStored?: number } = {},
): HistoryHavePacket {
  const analysis = analyzeHistory(messages);
  const vector: Record<string, number> = Object.fromEntries(
    Object.entries(analysis.vector).filter(([, s]) => s <= MAX_MESSAGE_SEQ).slice(0, MAX_VECTOR_ENTRIES),
  );
  const sparseEntries = Object.entries(analysis.haveSeqs)
    .map(([dev, ranges]) => [dev, ranges.filter(([lo, hi]) => hi <= MAX_MESSAGE_SEQ)] as const)
    .filter(([, ranges]) => ranges.length > 0)
    .slice(0, MAX_VECTOR_ENTRIES);
  const haveSeqs: Record<string, SeqRange[]> | undefined = sparseEntries.length
    ? Object.fromEntries(sparseEntries.map(([dev, ranges]) => [dev, ranges.map(([lo, hi]): SeqRange => [lo, hi])]))
    : undefined;

  const legacySeen = new Set<string>();
  const legacyIds: string[] = [];
  for (let i = messages.length - 1; i >= 0 && legacyIds.length < MAX_LEGACY_IDS; i--) {
    const b = messages[i].packet.body;
    if (b.seq !== undefined) continue;
    const digest = entryDigest(b.deviceId, b.id);
    if (legacySeen.has(digest)) continue;
    legacySeen.add(digest);
    legacyIds.push(digest);
  }

  const conflictSeen = new Set<string>();
  const conflictIds: string[] = [];
  for (let i = messages.length - 1; i >= 0 && conflictIds.length < MAX_CONFLICT_IDS; i--) {
    const b = messages[i].packet.body;
    if (!analysis.equivocatingMessageKeys.has(messageKey(b.deviceId, b.id))) continue;
    const digest = entryDigest(b.deviceId, b.id);
    if (conflictSeen.has(digest)) continue;
    conflictSeen.add(digest);
    conflictIds.push(digest);
  }

  // When our rolling window is full and no single member holds >= half (where windowMessages would evict by half-cap
  // instead of oldest-first), advertise our oldest `at` so peers don't waste rounds resending immediately-evicted history.
  const maxStored = options.maxStored ?? MAX_STORED_MESSAGES;
  let windowFullAt: number | undefined;
  if (messages.length >= maxStored && maxStored > 0) {
    const perMember = new Map<string, number>();
    let minAt = Infinity;
    let skewed = false;
    for (const m of messages) {
      const b = m.packet.body;
      const count = (perMember.get(b.memberId) ?? 0) + 1;
      perMember.set(b.memberId, count);
      if (count >= maxStored / 2) skewed = true;
      if (b.at < minAt) minAt = b.at;
    }
    if (!skewed && Number.isSafeInteger(minAt) && minAt >= 0 && minAt <= MAX_TIME) windowFullAt = minAt;
  }

  const packet: HistoryHavePacket = {
    kind: 'history-have',
    roomId,
    vector,
    ...(haveSeqs ? { haveSeqs } : {}),
    ...(conflictIds.length ? { conflictIds } : {}),
    ...(legacyIds.length ? { legacyIds } : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(windowFullAt !== undefined ? { windowFullAt } : {}),
  };

  // Enforce `HISTORY_CHUNK_CHARS` across summary fields (`legacyIds -> conflictIds -> haveSeqs -> vector`),
  // always keeping `cursor` intact so server-side pagination still converges past any summary cap.
  while (packet.legacyIds?.length && JSON.stringify(packet).length > HISTORY_CHUNK_CHARS) {
    packet.legacyIds = packet.legacyIds.slice(0, Math.floor(packet.legacyIds.length / 2));
    if (!packet.legacyIds.length) delete packet.legacyIds;
  }
  while (packet.conflictIds?.length && JSON.stringify(packet).length > HISTORY_CHUNK_CHARS) {
    packet.conflictIds = packet.conflictIds.slice(0, Math.floor(packet.conflictIds.length / 2));
    if (!packet.conflictIds.length) delete packet.conflictIds;
  }
  while (packet.haveSeqs && JSON.stringify(packet).length > HISTORY_CHUNK_CHARS) {
    const entries = Object.entries(packet.haveSeqs);
    if (!entries.length) { delete packet.haveSeqs; break; }
    entries.sort((a, b) => b[1].length - a[1].length);
    const [dev, ranges] = entries[0];
    if (ranges.length > 1) {
      packet.haveSeqs[dev] = ranges.slice(-Math.floor(ranges.length / 2));
    } else {
      delete packet.haveSeqs[dev];
      if (!Object.keys(packet.haveSeqs).length) delete packet.haveSeqs;
    }
  }
  while (Object.keys(packet.vector).length > 0 && JSON.stringify(packet).length > HISTORY_CHUNK_CHARS) {
    const keys = Object.keys(packet.vector);
    const keep = Math.floor(keys.length / 2);
    packet.vector = Object.fromEntries(keys.slice(0, keep).map(k => [k, packet.vector[k]]));
  }
  return packet;
}

/** Earliest admission time recorded for `memberId` in the room service's `status`. */
export function memberJoinedAt(
  status: Pick<RoomStatus, 'devices' | 'members'> | undefined,
  memberId: string,
): number | undefined {
  const member = status?.members?.find(m => m.id === memberId);
  if (member?.joinedAt !== undefined) return member.joinedAt;
  let earliest: number | undefined;
  for (const d of status?.devices ?? []) {
    if (d.memberId === memberId && typeof d.admittedAt === 'number' && d.admittedAt > 0) {
      if (earliest === undefined || d.admittedAt < earliest) earliest = d.admittedAt;
    }
  }
  return earliest;
}

/**
 * Newest `member.joinedAt` across all current room members in `status`.
 * Authors sign this as `audienceUntil` on `'members'` messages so authorization compares
 * two timestamps from the room service's own clock, immune to delayed delivery and client clock skew.
 */
export function currentAudienceUntil(
  status: Pick<RoomStatus, 'devices' | 'members'> | undefined,
): number | undefined {
  let newest: number | undefined;
  for (const m of status?.members ?? []) {
    const j = memberJoinedAt(status, m.id);
    if (j !== undefined && (newest === undefined || j > newest)) newest = j;
  }
  return newest;
}

/**
 * Decides whether this peer may serve `entry` (or an attachment referenced by `entry`) to `requesterDeviceId`,
 * never trusting anything the requester claims.
 *
 * Rules:
 * - Retracted stubs are never served.
 * - When a host-signed `verifiedRoster` is available, `requesterDeviceId -> memberId` is verified against it.
 * - `visibility: 'room'` entries are servable to any admitted device.
 * - `'members'` (and legacy entries without `visibility`) are servable to:
 *   1. The author member's own devices (companion devices always see their own member's messages).
 *   2. Same-member companion devices of this peer (`member.id === selfMemberId`) even when `entry.replicated`.
 *   3. Any admitted member whose `joinedAt` qualifies:
 *      - When the author signed `audienceUntil`: `joinedAt <= body.audienceUntil` (same clock, immune to delayed delivery).
 *      - For older messages without `audienceUntil`: `joinedAt <= Math.min(entry.receivedAt ?? body.at, body.at)`
 *        (bounded by BOTH our receipt clock and the author's signed `at` so delayed delivery never leaks to later joiners).
 */
export function mayServeMessage(
  entry: Pick<HistoryStoredMessage, 'packet' | 'retracted' | 'receivedAt' | 'replicated'>,
  requesterDeviceId: string,
  status: Pick<RoomStatus, 'devices' | 'members'> | undefined,
  selfMemberId?: string,
  verifiedRoster?: SignedRoster,
): boolean {
  if (isRetracted(entry)) return false;
  let requesterMemberId: string | undefined;
  if (verifiedRoster) {
    const rosterEntry = verifiedRoster.body.devices.find(d => d.id === requesterDeviceId);
    if (!rosterEntry) return false;
    requesterMemberId = rosterEntry.memberId;
  } else {
    const requesterDevice = status?.devices?.find(d => d.id === requesterDeviceId);
    if (!requesterDevice) return false;
    requesterMemberId = requesterDevice.memberId;
  }
  const requesterMember = status?.members?.find(m => m.id === requesterMemberId);
  if (!requesterMember) return false;

  const body = entry.packet.body;
  if (body.visibility === 'room') return true;

  // A member's own messages are always visible to their companion devices.
  if (body.memberId === requesterMember.id) return true;

  // A `'members'` entry learned via history replication is only re-served to this peer's own companion devices,
  // never to a different member (preventing multi-hop leaks to late joiners).
  if (entry.replicated) return selfMemberId !== undefined && requesterMember.id === selfMemberId;

  const joined = memberJoinedAt(status, requesterMember.id);
  if (joined === undefined) return false;
  if (body.audienceUntil !== undefined) {
    return joined <= body.audienceUntil;
  }
  const receiptTime = entry.receivedAt ?? body.at;
  return joined <= Math.min(receiptTime, body.at);
}

function serveCursorOf(m: Pick<HistoryStoredMessage, 'packet' | 'receivedAt'>): HistoryCursor {
  const b = m.packet.body;
  const r = typeof m.receivedAt === 'number' && Number.isSafeInteger(m.receivedAt) && m.receivedAt >= 0 && m.receivedAt <= MAX_TIME ? m.receivedAt : 0;
  const s = typeof b.seq === 'number' && Number.isSafeInteger(b.seq) && b.seq >= 1 && b.seq <= MAX_MESSAGE_SEQ ? b.seq : 0;
  return { r, d: b.deviceId, s, i: b.id };
}

/**
 * Strict total order for serving history pages, newest-received first:
 * `(receivedAt desc, deviceId desc, seq desc, id desc)`.
 * Never depends on author-chosen `at`, so a malicious member signing far-future `at` values can never
 * jump to the front of every batch or stall pagination for other members.
 */
function compareServeCursor(a: HistoryCursor, b: HistoryCursor): number {
  if (a.r !== b.r) return b.r - a.r;
  if (a.d !== b.d) return b.d < a.d ? -1 : 1;
  if (a.s !== b.s) return b.s - a.s;
  if (a.i !== b.i) return b.i < a.i ? -1 : 1;
  return 0;
}

/**
 * Selects the next authorized page of messages that `requesterDeviceId` is missing according to `have`,
 * using the serving peer's deterministic `(receivedAt, deviceId, seq, id)` order and optional `have.cursor`
 * so progress is guaranteed even past sparse-range, conflict-digest, or legacy-digest summary caps.
 */
export function selectHistoryEntries(
  messages: readonly HistoryStoredMessage[],
  have: HistoryHavePacket,
  requesterDeviceId: string,
  status: Pick<RoomStatus, 'devices' | 'members'> | undefined,
  selfMemberId?: string,
  limit = MAX_HISTORY_PER_RESPONSE,
  verifiedRoster?: SignedRoster,
): { entries: HistoryEntryPacket[]; more: boolean; nextCursor?: HistoryCursor } {
  const analysis = analyzeHistory(messages);
  const conflictHave = new Set(have.conflictIds ?? []);
  const legacyHave = new Set(have.legacyIds ?? []);
  const candidates: { msg: HistoryStoredMessage; cursor: HistoryCursor }[] = [];

  for (const m of messages) {
    if (!mayServeMessage(m, requesterDeviceId, status, selfMemberId, verifiedRoster)) continue;
    const b = m.packet.body;
    if (have.windowFullAt !== undefined && b.at < have.windowFullAt) continue;
    const cursor = serveCursorOf(m);
    if (have.cursor && compareServeCursor(cursor, have.cursor) <= 0) continue;
    if (typeof b.seq === 'number' && Number.isSafeInteger(b.seq) && b.seq >= 1) {
      const isConflict = analysis.equivocatingMessageKeys.has(messageKey(b.deviceId, b.id));
      if (isConflict) {
        if (conflictHave.has(entryDigest(b.deviceId, b.id))) continue;
        candidates.push({ msg: m, cursor });
        continue;
      }
      const theirContiguous = have.vector[b.deviceId] ?? 0;
      if (b.seq <= theirContiguous) continue;
      if (inSeqRanges(have.haveSeqs?.[b.deviceId], b.seq)) continue;
      candidates.push({ msg: m, cursor });
    } else {
      if (legacyHave.has(entryDigest(b.deviceId, b.id))) continue;
      candidates.push({ msg: m, cursor });
    }
  }

  candidates.sort((a, b) => compareServeCursor(a.cursor, b.cursor));

  const more = candidates.length > limit;
  const page = candidates.slice(0, limit);
  const entries = page.map(c => c.msg.packet);
  const nextCursor = more && page.length ? page.at(-1)!.cursor : undefined;
  return { entries, more, ...(nextCursor ? { nextCursor } : {}) };
}

/** Splits history entries into wire chunks under `HISTORY_CHUNK_CHARS`, tagging the final chunk with `more`+`nextCursor` or `done: true`. */
export function historyChunks(
  roomId: string,
  entries: readonly HistoryEntryPacket[],
  more = false,
  nextCursor?: HistoryCursor,
): HistoryPacket[] {
  const chunks: HistoryPacket[] = [];
  let current: HistoryEntryPacket[] = [];
  let size = 0;
  for (const entry of entries) {
    const length = JSON.stringify(entry).length + 1;
    if (current.length && size + length > HISTORY_CHUNK_CHARS) {
      chunks.push({ kind: 'history', roomId, entries: current });
      current = [];
      size = 0;
    }
    current.push(entry);
    size += length;
  }
  if (current.length) {
    chunks.push({
      kind: 'history',
      roomId,
      entries: current,
      ...(more ? { more: true, ...(nextCursor ? { nextCursor } : {}) } : { done: true as const }),
    });
  }
  return chunks;
}

function compareHistoryOrder(a: Pick<HistoryStoredMessage, 'packet'>, b: Pick<HistoryStoredMessage, 'packet'>): number {
  const dt = a.packet.body.at - b.packet.body.at;
  if (dt !== 0) return dt;
  if (a.packet.body.deviceId === b.packet.body.deviceId) {
    const ds = (a.packet.body.seq ?? 0) - (b.packet.body.seq ?? 0);
    if (ds !== 0) return ds;
  }
  if (a.packet.body.id !== b.packet.body.id) return a.packet.body.id < b.packet.body.id ? -1 : 1;
  return a.packet.body.deviceId < b.packet.body.deviceId ? -1 : a.packet.body.deviceId > b.packet.body.deviceId ? 1 : 0;
}

/**
 * Merges newly accepted replicated history messages into `existing` WITHOUT reordering any two elements of `existing`.
 *
 * - Deduplicates by composite `(deviceId, id)` so an attacker cannot squat on another member's message ID.
 * - Preserves live arrival order (protecting positional agent cursors in `evaluateWake` and `windowMessages` eviction),
 *   inserting each sorted incoming entry right after the last existing entry that precedes it chronologically.
 * - Never inserts a cross-device ID collision copy ahead of an already-held message with the same bare `id`,
 *   preventing backdated colliding copies from rewinding cursors or hijacking bare-ID references.
 */
export function mergeHistoryMessages<T extends Pick<HistoryStoredMessage, 'packet'>>(
  existing: readonly T[],
  incoming: readonly T[],
): { messages: T[]; added: T[] } {
  const held = new Set(existing.map(m => messageKey(m.packet.body.deviceId, m.packet.body.id)));
  const lastExistingIndexById = new Map<string, number>();
  for (let i = 0; i < existing.length; i++) {
    lastExistingIndexById.set(existing[i].packet.body.id, i);
  }
  const added: T[] = [];
  for (const m of incoming) {
    const k = messageKey(m.packet.body.deviceId, m.packet.body.id);
    if (held.has(k)) continue;
    held.add(k);
    added.push(m);
  }
  if (!added.length) return { messages: [...existing], added: [] };
  added.sort(compareHistoryOrder);

  const buckets: T[][] = Array.from({ length: existing.length + 1 }, () => []);
  for (const item of added) {
    const minSlot = lastExistingIndexById.has(item.packet.body.id) ? lastExistingIndexById.get(item.packet.body.id)! + 1 : 0;
    let slot = minSlot;
    for (let i = existing.length - 1; i >= minSlot; i--) {
      if (compareHistoryOrder(existing[i], item) <= 0) {
        slot = i + 1;
        break;
      }
    }
    buckets[slot].push(item);
  }
  const merged: T[] = [...buckets[0]];
  for (let i = 0; i < existing.length; i++) {
    merged.push(existing[i], ...buckets[i + 1]);
  }
  return { messages: merged, added };
}
