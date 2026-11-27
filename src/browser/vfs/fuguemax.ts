/**
 * Pure TypeScript Signed Run-Length FugueMax Text CRDT.
 *
 * Implements the FugueMax tree CRDT (Weidner, Gentle, Kleppmann 2023) over
 * Unicode scalar values (code points) with:
 * - Lazy O(1) run-length splitting on interior inserts/deletes
 * - Backward non-interleaving via descending `rightOrigin` tree order
 * - Idempotent tombstone range union retaining compact structural stubs
 * - Causal DAG frontier tracking, canonical `f:<16-hex>` frontier digests,
 *   bounded local `frontierMap` (256 entries), and `materializeAt(frontier)`
 * - Deterministic equivocation resolution (lower `opHash` wins on overlapping
 *   `(deviceId, counter)` allocations)
 * - Checkpoint serialization/deserialization and configurable soft/hard doc
 *   UTF-8 byte limits
 *
 * Zero dependencies; runs identically in Browser and Bun.
 */

import {
  isValidVfsCommitId,
  VFS_DOC_HARD_LIMIT_BYTES,
  VFS_DOC_SOFT_LIMIT_BYTES,
  VFS_MAX_COUNTER_JUMP,
  VFS_MAX_DEL_RUN_LEN,
  VFS_MAX_FRONTIER_MAP,
  VFS_MAX_LAMPORT_JUMP,
  VFS_MAX_PENDING_OPS_GLOBAL,
  VFS_MAX_PENDING_OPS_PER_MEMBER,
  VFS_MAX_SEQ,
  VFS_MAX_SEQ_JUMP,
  VFS_OP_COMPACTION_CEILING,
  VFS_OP_MAX_PARENTS,
  VFS_OP_MAX_PLAINTEXT_BYTES,
  VFS_OP_MAX_SUBOPS,
  VFS_PENDING_OP_TTL_MS,
} from './constants';
import { hasLoneSurrogate, utf8ByteLength } from './path';

export const FUGUEMAX_SOFT_LIMIT_BYTES = VFS_DOC_SOFT_LIMIT_BYTES;
export const FUGUEMAX_HARD_LIMIT_BYTES = VFS_DOC_HARD_LIMIT_BYTES;
export const FUGUEMAX_MAX_FRONTIER_MAP_ENTRIES = VFS_MAX_FRONTIER_MAP;
export const FUGUEMAX_MAX_PENDING_OPS = VFS_MAX_PENDING_OPS_GLOBAL;
export const FUGUEMAX_MAX_PENDING_OPS_PER_MEMBER = VFS_MAX_PENDING_OPS_PER_MEMBER;
export const FUGUEMAX_PENDING_OP_TTL_MS = VFS_PENDING_OP_TTL_MS;
export const FUGUEMAX_MAX_PARENTS = VFS_OP_MAX_PARENTS;
export const FUGUEMAX_MAX_SUBOPS = VFS_OP_MAX_SUBOPS;
export const FUGUEMAX_MAX_OP_PLAINTEXT_BYTES = VFS_OP_MAX_PLAINTEXT_BYTES;
export const FUGUEMAX_MAX_COUNTER_JUMP = VFS_MAX_COUNTER_JUMP;
export const FUGUEMAX_MAX_SEQ_JUMP = VFS_MAX_SEQ_JUMP;
export const FUGUEMAX_MAX_LAMPORT_JUMP = VFS_MAX_LAMPORT_JUMP;
export const FUGUEMAX_MAX_DEL_RUN_LEN = VFS_MAX_DEL_RUN_LEN;
export const FUGUEMAX_MAX_APPLIED_OPS = VFS_OP_COMPACTION_CEILING;
export const FUGUEMAX_MAX_EQUIVOCATIONS_PER_DEVICE = 8;

export type FugueId = readonly [deviceId: string, counter: number];
export type FugueDelRun = readonly [deviceId: string, startCounter: number, len: number];

export type FugueSubOp =
  | {
      t: 'ins';
      parent: FugueId | null;
      side: 'L' | 'R';
      rightOrigin?: FugueId | null;
      text: string;
    }
  | {
      t: 'del';
      runs: FugueDelRun[];
    };

export interface VfsAuthorStamp {
  v: 1;
  roomId: string;
  opId: string;
  deviceId: string;
  memberId: string;
  epoch: number;
  seq: number;
  lamport: number;
  at: number;
  visibility: 'room' | 'members';
  audienceUntil?: number;
}

export interface VfsDocOpBody extends VfsAuthorStamp {
  kind: 'vfs-doc-op';
  nodeId: string;
  parents: string[];
  counterStart: number;
  ops: FugueSubOp[];
  revertsCommit?: string;
}

export interface FugueVisibleElement {
  readonly id: FugueId;
  readonly deviceId: string;
  readonly counter: number;
  readonly seq: number;
  readonly offset: number;
  readonly char: string;
}

export interface FugueTreeElement {
  readonly id: FugueId;
  readonly deleted: boolean;
  readonly char: string | null;
}

export interface FugueLocalOpMeta {
  roomId: string;
  nodeId: string;
  opId: string;
  deviceId: string;
  memberId: string;
  epoch: number;
  seq: number;
  lamport: number;
  at: number;
  visibility?: 'room' | 'members';
  audienceUntil?: number;
  revertsCommit?: string;
}

export interface FugueDocOptions {
  /** Bound room ID; rejects any applied op with a different `roomId`. */
  roomId?: string;
  /** Bound document node ID; rejects any applied op with a different `nodeId`. */
  nodeId?: string;
  softLimitBytes?: number;
  hardLimitBytes?: number;
  maxFrontierMapEntries?: number;
  maxPendingOps?: number;
  maxPendingOpsPerMember?: number;
  pendingOpTtlMs?: number;
  maxParents?: number;
  maxSubOps?: number;
  maxOpPlaintextBytes?: number;
  maxCounterJump?: number;
  maxSeqJump?: number;
  maxLamportJump?: number;
  maxDelRunLen?: number;
  maxAppliedOps?: number;
  maxEquivocationsPerDevice?: number;
  now?: () => number;
}

export interface FugueAppliedOpRecord {
  readonly op: VfsDocOpBody;
  readonly opHash: string;
  readonly order: number;
}

export interface FugueRejectedPendingOp {
  readonly opHash: string;
  readonly error: Error;
}

export interface FugueApplyResult {
  readonly applied: boolean;
  readonly duplicate: boolean;
  readonly buffered: boolean;
  readonly opHash: string;
  readonly drained: string[];
  readonly rejectedPending: FugueRejectedPendingOp[];
  readonly equivocationDetected: boolean;
}

export interface FugueMaterializedState {
  readonly text: string;
  readonly visible: FugueVisibleElement[];
  readonly frontier: string[];
  readonly rev: string;
  readonly doc: FugueMaxDoc;
}

export type FugueCheckpointRunTuple = readonly [
  deviceId: string,
  counterStart: number,
  len: number,
  seq: number,
  opHash: string,
  parent: FugueId | null,
  side: 'L' | 'R',
  rightOrigin: FugueId | null,
  textOrNull: string | null,
];

export interface FugueCheckpoint {
  readonly v: 1;
  readonly roomId?: string;
  readonly nodeId?: string;
  readonly frontier: string[];
  readonly frontierRev: string;
  readonly nextCounters: Record<string, number>;
  readonly maxSeqByDevice?: Record<string, number>;
  readonly maxLamport?: number;
  readonly tombstonedBytes?: number;
  readonly knownOpHashes: string[];
  readonly frontierMap: Array<readonly [rev: string, frontier: string[]]>;
  readonly runs: FugueCheckpointRunTuple[];
  readonly opLog?: Array<{ op: VfsDocOpBody; opHash: string }>;
}

export class VfsInvalidOpError extends Error {
  readonly code = 'VFS_INVALID_OP' as const;
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'VFS_INVALID_OP';
    this.reason = reason;
  }
}

export class VfsSizeLimitError extends Error {
  readonly code = 'VFS_SIZE_LIMIT' as const;
  readonly byteLength: number;
  readonly limitBytes: number;

  constructor(byteLength: number, limitBytes: number) {
    super(`Document size ${byteLength} bytes exceeds hard limit of ${limitBytes} bytes.`);
    this.name = 'VFS_SIZE_LIMIT';
    this.byteLength = byteLength;
    this.limitBytes = limitBytes;
  }
}

// ---------------------------------------------------------------------------
// Pure-TS synchronous SHA-256 (FIPS 180-4) & Canonical JSON
// ---------------------------------------------------------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const textEncoder = new TextEncoder();

export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? textEncoder.encode(input) : input;
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;

  const view = new DataView(buf.buffer);
  const highBits = Math.floor(bitLen / 0x100000000);
  const lowBits = bitLen >>> 0;
  view.setUint32(paddedLen - 8, highBits, false);
  view.setUint32(paddedLen - 4, lowBits, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map((v) => v.toString(16).padStart(8, '0')).join('');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/**
 * Computes the canonical FugueMax DAG body hash `SHA-256(canonicalJson(op))`.
 *
 * IMPORTANT: FugueMax causal DAG links (`VfsDocOpBody.parents[]`, `frontier()`,
 * and `frontierRev()`) ALWAYS use this deterministic canonical-body hash
 * (`docOpHash`) — NOT `VfsEnvelopeV1`'s outer signed-payload `opHash`
 * (`SHA-256(encodeSignedVfsPayload({ body, signature }))`). Keeping DAG links
 * bound to `docOpHash` guarantees sender and receiver frontiers stay 100%
 * identical even before/after ECDSA signing.
 */
export function computeDocOpHash(op: VfsDocOpBody): string {
  return sha256Hex(canonicalJson(op));
}

export function computeFrontierRev(frontierOpHashes: readonly string[]): string {
  const sorted = [...frontierOpHashes].sort();
  return `f:${sha256Hex(sorted.join(',')).slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// Helpers for FugueId and Unicode scalar values
// ---------------------------------------------------------------------------

export function fugueIdKey(id: FugueId): string {
  return `${id[0]}:${id[1]}`;
}

export function fugueIdEquals(a: FugueId | null, b: FugueId | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a[0] === b[0] && a[1] === b[1];
}

export function isValidFugueId(value: unknown): value is FugueId {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    value[0].length > 0 &&
    typeof value[1] === 'number' &&
    Number.isSafeInteger(value[1]) &&
    value[1] >= 0
  );
}

export function compareFugueId(a: FugueId, b: FugueId): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  return a[1] - b[1];
}

export function validateTextScalars(text: string): string[] {
  if (typeof text !== 'string') {
    throw new VfsInvalidOpError('invalid-text', 'Text payload must be a string.');
  }
  if (hasLoneSurrogate(text)) {
    throw new VfsInvalidOpError('lone-surrogate', 'Text payload contains an unpaired UTF-16 surrogate.');
  }
  if (text.includes('\0')) {
    throw new VfsInvalidOpError('nul-byte', 'Text payload must not contain NUL bytes.');
  }
  return Array.from(text);
}

// ---------------------------------------------------------------------------
// Internal Run Node
// ---------------------------------------------------------------------------

interface FugueRun {
  readonly deviceId: string;
  readonly counterStart: number;
  len: number;
  readonly seq: number;
  readonly opHash: string;
  deleted: boolean;
  codePoints: string[] | null;
  parent: FugueRun | null; // null = ROOT
  readonly side: 'L' | 'R';
  readonly rightOrigin: FugueId | null; // null = END
  leftChildren: FugueRun[];
  rightChildren: FugueRun[];
}

function cloneOp(op: VfsDocOpBody): VfsDocOpBody {
  return {
    ...op,
    parents: [...op.parents],
    ops: op.ops.map((sub) =>
      sub.t === 'ins'
        ? {
            t: 'ins',
            parent: sub.parent ? ([sub.parent[0], sub.parent[1]] as const) : null,
            side: sub.side,
            ...(sub.rightOrigin !== undefined
              ? { rightOrigin: sub.rightOrigin ? ([sub.rightOrigin[0], sub.rightOrigin[1]] as const) : null }
              : {}),
            text: sub.text,
          }
        : {
            t: 'del',
            runs: sub.runs.map((r) => [r[0], r[1], r[2]] as const),
          },
    ),
  };
}

// ---------------------------------------------------------------------------
// Min-Heap for O(n log n) deterministic topological ordering
// ---------------------------------------------------------------------------

class StringMinHeap {
  private items: string[] = [];

  get size(): number {
    return this.items.length;
  }

  push(value: string): void {
    const arr = this.items;
    arr.push(value);
    let idx = arr.length - 1;
    while (idx > 0) {
      const parent = (idx - 1) >>> 1;
      if (arr[parent]! <= arr[idx]!) break;
      const tmp = arr[parent]!;
      arr[parent] = arr[idx]!;
      arr[idx] = tmp;
      idx = parent;
    }
  }

  pop(): string | undefined {
    const arr = this.items;
    if (arr.length === 0) return undefined;
    const min = arr[0]!;
    const last = arr.pop()!;
    if (arr.length > 0) {
      arr[0] = last;
      let idx = 0;
      const len = arr.length;
      while (true) {
        const left = (idx << 1) + 1;
        const right = left + 1;
        let smallest = idx;
        if (left < len && arr[left]! < arr[smallest]!) smallest = left;
        if (right < len && arr[right]! < arr[smallest]!) smallest = right;
        if (smallest === idx) break;
        const tmp = arr[idx]!;
        arr[idx] = arr[smallest]!;
        arr[smallest] = tmp;
        idx = smallest;
      }
    }
    return min;
  }
}

interface PendingOpEntry {
  readonly op: VfsDocOpBody;
  readonly opHash: string;
  readonly memberId: string;
  readonly insertedAt: number;
}

// ---------------------------------------------------------------------------
// FugueMaxDoc
// ---------------------------------------------------------------------------

export class FugueMaxDoc {
  readonly softLimitBytes: number;
  readonly hardLimitBytes: number;
  readonly maxFrontierMapEntries: number;
  readonly maxPendingOps: number;
  readonly maxPendingOpsPerMember: number;
  readonly pendingOpTtlMs: number;
  readonly maxParents: number;
  readonly maxSubOps: number;
  readonly maxOpPlaintextBytes: number;
  readonly maxCounterJump: number;
  readonly maxSeqJump: number;
  readonly maxLamportJump: number;
  readonly maxDelRunLen: number;
  readonly maxAppliedOps: number;
  readonly maxEquivocationsPerDevice: number;

  private readonly now: () => number;
  private _roomId?: string;
  private _nodeId?: string;

  private rootRightChildren: FugueRun[] = [];
  private runsByDevice = new Map<string, FugueRun[]>();
  private nextCounters = new Map<string, number>();
  private maxSeqByDevice = new Map<string, number>();
  private maxLamport = 0;

  private appliedOps = new Map<string, FugueAppliedOpRecord>();
  private knownOpHashes = new Set<string>();
  private frontierSet = new Set<string>();
  private frontierMap = new Map<string, string[]>();
  private pendingOps = new Map<string, PendingOpEntry>();
  private pendingCountByMember = new Map<string, number>();

  // Bounded anti-amplification equivocation tracking:
  // Keeps at most 1 equivocation proof per winning opHash and caps total equivocations per device.
  private equivocationProofsByWinner = new Map<string, string>();
  private equivocationCountByDevice = new Map<string, number>();

  // Base checkpoint state if loaded from a checkpoint without full op history
  private checkpointBase: FugueCheckpoint | null = null;
  private checkpointBaseKnownSet = new Set<string>();
  private checkpointMaxLamport = 0;
  private applyCounter = 0;
  private visibleBytes = 0;
  private tombstonedBytes = 0;

  constructor(options: FugueDocOptions = {}) {
    if (options.roomId !== undefined) {
      if (typeof options.roomId !== 'string' || options.roomId.length === 0 || options.roomId.includes('\0')) {
        throw new VfsInvalidOpError('invalid-room-id', 'Document roomId must be a non-empty string without NUL.');
      }
      this._roomId = options.roomId;
    }
    if (options.nodeId !== undefined) {
      if (typeof options.nodeId !== 'string' || options.nodeId.length === 0 || options.nodeId.includes('\0')) {
        throw new VfsInvalidOpError('invalid-node-id', 'Document nodeId must be a non-empty string without NUL.');
      }
      this._nodeId = options.nodeId;
    }
    this.softLimitBytes = options.softLimitBytes ?? FUGUEMAX_SOFT_LIMIT_BYTES;
    this.hardLimitBytes = options.hardLimitBytes ?? FUGUEMAX_HARD_LIMIT_BYTES;
    this.maxFrontierMapEntries = options.maxFrontierMapEntries ?? FUGUEMAX_MAX_FRONTIER_MAP_ENTRIES;
    this.maxPendingOps = options.maxPendingOps ?? FUGUEMAX_MAX_PENDING_OPS;
    this.maxPendingOpsPerMember = options.maxPendingOpsPerMember ?? FUGUEMAX_MAX_PENDING_OPS_PER_MEMBER;
    this.pendingOpTtlMs = options.pendingOpTtlMs ?? FUGUEMAX_PENDING_OP_TTL_MS;
    this.maxParents = options.maxParents ?? FUGUEMAX_MAX_PARENTS;
    this.maxSubOps = options.maxSubOps ?? FUGUEMAX_MAX_SUBOPS;
    this.maxOpPlaintextBytes = options.maxOpPlaintextBytes ?? FUGUEMAX_MAX_OP_PLAINTEXT_BYTES;
    this.maxCounterJump = options.maxCounterJump ?? FUGUEMAX_MAX_COUNTER_JUMP;
    this.maxSeqJump = options.maxSeqJump ?? FUGUEMAX_MAX_SEQ_JUMP;
    this.maxLamportJump = options.maxLamportJump ?? FUGUEMAX_MAX_LAMPORT_JUMP;
    this.maxDelRunLen = options.maxDelRunLen ?? FUGUEMAX_MAX_DEL_RUN_LEN;
    this.maxAppliedOps = options.maxAppliedOps ?? FUGUEMAX_MAX_APPLIED_OPS;
    this.maxEquivocationsPerDevice = options.maxEquivocationsPerDevice ?? FUGUEMAX_MAX_EQUIVOCATIONS_PER_DEVICE;
    this.now = options.now ?? (() => Date.now());
    this.recordFrontier([]);
  }

  /** Room ID bound to this document (explicitly configured or bound on first op). */
  get roomId(): string | undefined {
    return this._roomId;
  }

  /** Node ID bound to this document (explicitly configured or bound on first op). */
  get nodeId(): string | undefined {
    return this._nodeId;
  }

  private docOptions(): FugueDocOptions {
    return {
      ...(this._roomId !== undefined ? { roomId: this._roomId } : {}),
      ...(this._nodeId !== undefined ? { nodeId: this._nodeId } : {}),
      softLimitBytes: this.softLimitBytes,
      hardLimitBytes: this.hardLimitBytes,
      maxFrontierMapEntries: this.maxFrontierMapEntries,
      maxPendingOps: this.maxPendingOps,
      maxPendingOpsPerMember: this.maxPendingOpsPerMember,
      pendingOpTtlMs: this.pendingOpTtlMs,
      maxParents: this.maxParents,
      maxSubOps: this.maxSubOps,
      maxOpPlaintextBytes: this.maxOpPlaintextBytes,
      maxCounterJump: this.maxCounterJump,
      maxSeqJump: this.maxSeqJump,
      maxLamportJump: this.maxLamportJump,
      maxDelRunLen: this.maxDelRunLen,
      maxAppliedOps: this.maxAppliedOps,
      maxEquivocationsPerDevice: this.maxEquivocationsPerDevice,
      now: this.now,
    };
  }

  // -------------------------------------------------------------------------
  // Public inspection API
  // -------------------------------------------------------------------------

  /** Current visible document text rendered via in-order DFS. */
  getText(): string {
    const parts: string[] = [];
    this.traverseRuns((run) => {
      if (!run.deleted && run.codePoints) {
        for (let i = 0; i < run.codePoints.length; i++) {
          parts.push(run.codePoints[i]!);
        }
      }
    });
    return parts.join('');
  }

  /** Current visible UTF-8 byte size. */
  utf8ByteLength(): number {
    return this.visibleBytes;
  }

  /** True if current visible UTF-8 byte length exceeds `softLimitBytes`. */
  isOverSoftLimit(): boolean {
    return this.visibleBytes > this.softLimitBytes;
  }

  /** Ordered list of visible Unicode scalar value elements in DFS order. */
  visibleElements(): FugueVisibleElement[] {
    const out: FugueVisibleElement[] = [];
    this.traverseRuns((run) => {
      if (!run.deleted && run.codePoints) {
        for (let i = 0; i < run.codePoints.length; i++) {
          const counter = run.counterStart + i;
          out.push({
            id: [run.deviceId, counter] as const,
            deviceId: run.deviceId,
            counter,
            seq: run.seq,
            offset: i,
            char: run.codePoints[i]!,
          });
        }
      }
    });
    return out;
  }

  /** Ordered list of ALL tree elements (visible + tombstones) in DFS order. */
  fullTreeElements(): FugueTreeElement[] {
    const out: FugueTreeElement[] = [];
    this.traverseRuns((run) => {
      for (let i = 0; i < run.len; i++) {
        out.push({
          id: [run.deviceId, run.counterStart + i] as const,
          deleted: run.deleted,
          char: run.deleted ? null : run.codePoints![i]!,
        });
      }
    });
    return out;
  }

  /** Sorted DAG frontier (`opHash[]`). */
  frontier(): string[] {
    return [...this.frontierSet].sort();
  }

  /** Canonical frontier digest `f:<sha256(sortedOpHashes.join(','))[0..16]>`. */
  frontierRev(): string {
    return computeFrontierRev(this.frontier());
  }

  /** Resolves a `f:<16-hex>` frontier digest from the bounded local frontierMap. */
  resolveFrontier(rev: string): string[] | null {
    const entry = this.frontierMap.get(rev);
    return entry ? [...entry] : null;
  }

  /** Returns a copy of all currently tracked `frontierMap` entries. */
  getFrontierMap(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const [k, v] of this.frontierMap) {
      out.set(k, [...v]);
    }
    return out;
  }

  /** Next unused counter for a given `deviceId`. */
  nextCounterFor(deviceId: string): number {
    return this.nextCounters.get(deviceId) ?? 0;
  }

  /** Returns an applied op record by `opHash`, if retained in the op log. */
  getAppliedOp(opHash: string): FugueAppliedOpRecord | undefined {
    return this.appliedOps.get(opHash);
  }

  /** Returns all applied op records in application order. */
  getAppliedOps(): FugueAppliedOpRecord[] {
    return [...this.appliedOps.values()].sort((a, b) => a.order - b.order);
  }

  /** Number of buffered ops waiting on causal parents. */
  pendingCount(): number {
    return this.pendingOps.size;
  }

  /** Number of buffered pending ops currently attributed to `memberId`. */
  pendingCountForMember(memberId: string): number {
    return this.pendingCountByMember.get(memberId) ?? 0;
  }

  /** Number of uncompacted ops retained in the in-memory op log. */
  appliedOpCount(): number {
    return this.appliedOps.size;
  }

  /** Evicts any pending causal ops whose buffered age reached `pendingOpTtlMs`. */
  pruneExpiredPendingOps(nowMs: number = this.now()): number {
    if (this.pendingOps.size === 0) return 0;
    let evicted = 0;
    for (const [hash, entry] of this.pendingOps) {
      if (nowMs - entry.insertedAt >= this.pendingOpTtlMs) {
        this.deletePendingEntry(hash, entry.memberId);
        evicted++;
      }
    }
    return evicted;
  }

  /**
   * Compacts the retained in-memory `appliedOps` log into a compact checkpoint base,
   * reclaiming op-log memory before hitting `VFS_OP_COMPACTION_CEILING` (20,000 ops).
   */
  compact(): FugueCheckpoint {
    const cp = this.exportCheckpoint({ includeOpLog: false });
    this.appliedOps.clear();
    this.equivocationProofsByWinner.clear();
    this.checkpointBase = cp;
    this.checkpointBaseKnownSet = new Set(cp.knownOpHashes);
    this.checkpointMaxLamport = Math.max(this.checkpointMaxLamport, this.maxLamport);
    return cp;
  }

  /** Deep clones this document state (useful for atomic speculative application). */
  clone(): FugueMaxDoc {
    const cp = this.exportCheckpoint({ includeOpLog: false });
    const cloned = FugueMaxDoc.fromCheckpoint(cp, this.docOptions());
    cloned.checkpointBase = this.checkpointBase;
    cloned.checkpointBaseKnownSet = new Set(this.checkpointBaseKnownSet);
    cloned.checkpointMaxLamport = this.checkpointMaxLamport;
    for (const rec of this.getAppliedOps()) {
      cloned.appliedOps.set(rec.opHash, {
        op: cloneOp(rec.op),
        opHash: rec.opHash,
        order: cloned.applyCounter++,
      });
      cloned.knownOpHashes.add(rec.opHash);
    }
    for (const [winner, proof] of this.equivocationProofsByWinner) {
      cloned.equivocationProofsByWinner.set(winner, proof);
    }
    for (const [dev, cnt] of this.equivocationCountByDevice) {
      cloned.equivocationCountByDevice.set(dev, cnt);
    }
    return cloned;
  }

  // -------------------------------------------------------------------------
  // Local Editing Helpers (code-point indexed)
  // -------------------------------------------------------------------------

  /**
   * Computes a FugueMax `ins` sub-op inserting `text` at visible code-point
   * index `index` (`0 <= index <= visibleLength`) WITHOUT mutating the doc.
   */
  planInsertAt(index: number, text: string): FugueSubOp {
    const cps = validateTextScalars(text);
    if (cps.length === 0) {
      throw new VfsInvalidOpError('empty-insert', 'Insert text must be non-empty.');
    }
    const visible = this.visibleElements();
    if (!Number.isInteger(index) || index < 0 || index > visible.length) {
      throw new VfsInvalidOpError(
        'index-out-of-bounds',
        `Insert index ${index} out of bounds [0..${visible.length}].`,
      );
    }

    if (index === 0) {
      if (this.rootRightChildren.length === 0) {
        return { t: 'ins', parent: null, side: 'R', rightOrigin: null, text };
      }
      const rightTarget = this.leftmostDescendant(this.rootRightChildren[0]!);
      const targetId: FugueId = [rightTarget.deviceId, rightTarget.counterStart];
      return { t: 'ins', parent: targetId, side: 'L', rightOrigin: targetId, text };
    }

    const leftElem = visible[index - 1]!;
    const leftRun = this.findRun(leftElem.deviceId, leftElem.counter);
    if (!leftRun) {
      throw new VfsInvalidOpError('missing-left-origin', 'Internal error: left origin missing.');
    }

    const isEndOfRun = leftElem.counter === leftRun.counterStart + leftRun.len - 1;
    if (!isEndOfRun) {
      // Next element in tree is the very next character inside the same run ->
      // leftOrigin already has an implicit right child, so attach as 'L' child of (deviceId, counter + 1).
      const nextInRun: FugueId = [leftRun.deviceId, leftElem.counter + 1];
      return { t: 'ins', parent: nextInRun, side: 'L', rightOrigin: nextInRun, text };
    }

    if (leftRun.rightChildren.length === 0) {
      const rightOrigin = this.nextIdInTreeAfterRun(leftRun);
      return {
        t: 'ins',
        parent: leftElem.id,
        side: 'R',
        rightOrigin,
        text,
      };
    }

    const rightTarget = this.leftmostDescendant(leftRun.rightChildren[0]!);
    const targetId: FugueId = [rightTarget.deviceId, rightTarget.counterStart];
    return { t: 'ins', parent: targetId, side: 'L', rightOrigin: targetId, text };
  }

  /**
   * Computes a compact `del` sub-op deleting `length` visible code points
   * starting at visible code-point `index` WITHOUT mutating the doc.
   */
  planDeleteAt(index: number, length: number): FugueSubOp {
    if (!Number.isInteger(index) || !Number.isInteger(length) || index < 0 || length <= 0) {
      throw new VfsInvalidOpError('invalid-delete-range', 'Delete index must be >= 0 and length > 0.');
    }
    const visible = this.visibleElements();
    if (index + length > visible.length) {
      throw new VfsInvalidOpError(
        'index-out-of-bounds',
        `Delete range [${index}..${index + length}) exceeds document length ${visible.length}.`,
      );
    }

    const runs: [string, number, number][] = [];
    for (let i = index; i < index + length; i++) {
      const elem = visible[i]!;
      const prev = runs[runs.length - 1];
      if (prev && prev[0] === elem.deviceId && prev[1] + prev[2] === elem.counter) {
        prev[2] += 1;
      } else {
        runs.push([elem.deviceId, elem.counter, 1]);
      }
    }
    return { t: 'del', runs };
  }

  /**
   * Creates AND applies a local insert op at visible code-point index `index`.
   */
  localInsert(index: number, text: string, meta: FugueLocalOpMeta): { op: VfsDocOpBody; opHash: string } {
    const sub = this.planInsertAt(index, text);
    return this.commitLocalSubOps([sub], meta);
  }

  /**
   * Creates AND applies a local delete op removing `length` visible code points
   * starting at visible code-point index `index`.
   */
  localDelete(index: number, length: number, meta: FugueLocalOpMeta): { op: VfsDocOpBody; opHash: string } {
    const sub = this.planDeleteAt(index, length);
    return this.commitLocalSubOps([sub], meta);
  }

  /**
   * Creates AND applies a local replace (delete + optional insert) as a single op.
   */
  localReplace(
    index: number,
    deleteLen: number,
    insertText: string,
    meta: FugueLocalOpMeta,
  ): { op: VfsDocOpBody; opHash: string } {
    const subs: FugueSubOp[] = [];
    if (deleteLen > 0) {
      subs.push(this.planDeleteAt(index, deleteLen));
    }
    if (insertText.length > 0) {
      // Plan insert on a clone if we also deleted so leftOrigin is post-delete.
      if (subs.length > 0) {
        const scratch = this.clone();
        const delOp = this.buildLocalOp(subs, meta);
        scratch.applyOp(delOp);
        subs.push(scratch.planInsertAt(index, insertText));
      } else {
        subs.push(this.planInsertAt(index, insertText));
      }
    }
    return this.commitLocalSubOps(subs, meta);
  }

  /** Builds a `VfsDocOpBody` from sub-ops using current frontier and device counter. */
  buildLocalOp(subOps: FugueSubOp[], meta: FugueLocalOpMeta): VfsDocOpBody {
    return {
      v: 1,
      kind: 'vfs-doc-op',
      roomId: meta.roomId,
      nodeId: meta.nodeId,
      opId: meta.opId,
      deviceId: meta.deviceId,
      memberId: meta.memberId,
      epoch: meta.epoch,
      seq: meta.seq,
      lamport: meta.lamport,
      at: meta.at,
      visibility: meta.visibility ?? 'room',
      ...(meta.audienceUntil !== undefined ? { audienceUntil: meta.audienceUntil } : {}),
      parents: this.frontier(),
      counterStart: this.nextCounterFor(meta.deviceId),
      ops: subOps,
      ...(meta.revertsCommit !== undefined ? { revertsCommit: meta.revertsCommit } : {}),
    };
  }

  private commitLocalSubOps(subOps: FugueSubOp[], meta: FugueLocalOpMeta): { op: VfsDocOpBody; opHash: string } {
    const op = this.buildLocalOp(subOps, meta);
    const opHash = computeDocOpHash(op);
    this.applyOp(op, opHash);
    return { op, opHash };
  }

  // -------------------------------------------------------------------------
  // Remote / General Op Application
  // -------------------------------------------------------------------------

  /**
   * Applies a `VfsDocOpBody` (idempotent on duplicate `docOpHash`, causally
   * buffered with per-member cap & TTL if `parents` have not arrived yet,
   * deterministic and anti-amplification bounded on counter equivocation).
   *
   * ALWAYS computes `computeDocOpHash(op)` and rejects with `VFS_INVALID_OP` if
   * `explicitOpHash` is provided and differs from the canonical body hash.
   */
  applyOp(op: VfsDocOpBody, explicitOpHash?: string, nowMs?: number): FugueApplyResult {
    this.validateOpShape(op);
    const opJson = canonicalJson(op);
    const opJsonBytes = utf8ByteLength(opJson);
    if (opJsonBytes > this.maxOpPlaintextBytes) {
      throw new VfsInvalidOpError(
        'op-too-large',
        `Op canonical JSON (${opJsonBytes} bytes) exceeds limit (${this.maxOpPlaintextBytes} bytes).`,
      );
    }
    const opHash = sha256Hex(opJson);
    if (explicitOpHash !== undefined && explicitOpHash !== opHash) {
      throw new VfsInvalidOpError(
        'op-hash-mismatch',
        `Explicit opHash "${explicitOpHash}" does not match computed docOpHash "${opHash}".`,
      );
    }

    if (this.knownOpHashes.has(opHash)) {
      return {
        applied: false,
        duplicate: true,
        buffered: false,
        opHash,
        drained: [],
        rejectedPending: [],
        equivocationDetected: false,
      };
    }

    const now = nowMs ?? this.now();
    this.pruneExpiredPendingOps(now);

    if (!this.areParentsReady(op)) {
      if (!this.pendingOps.has(opHash)) {
        const memberPending = this.pendingCountByMember.get(op.memberId) ?? 0;
        if (memberPending >= this.maxPendingOpsPerMember) {
          throw new VfsInvalidOpError(
            'pending-member-overflow',
            `Member "${op.memberId}" pending causal op buffer reached limit (${this.maxPendingOpsPerMember}).`,
          );
        }
        if (this.pendingOps.size >= this.maxPendingOps) {
          throw new VfsInvalidOpError(
            'pending-overflow',
            `Pending causal op buffer reached limit (${this.maxPendingOps}).`,
          );
        }
        this.pendingOps.set(opHash, {
          op: cloneOp(op),
          opHash,
          memberId: op.memberId,
          insertedAt: now,
        });
        this.pendingCountByMember.set(op.memberId, memberPending + 1);
      }
      return {
        applied: false,
        duplicate: false,
        buffered: true,
        opHash,
        drained: [],
        rejectedPending: [],
        equivocationDetected: false,
      };
    }

    const eq = this.applyReadyOp(cloneOp(op), opHash);
    const drained: string[] = [];
    const rejectedPending: FugueRejectedPendingOp[] = [];
    let anyEq = eq;

    // Drain any buffered ops whose parents are now satisfied. Isolate each
    // drained op so one invalid buffered op is safely discarded without
    // aborting the valid parent's applyOp() or stranding other ready ops.
    let progressed = true;
    while (progressed && this.pendingOps.size > 0) {
      progressed = false;
      const ready = [...this.pendingOps.values()]
        .filter((entry) => this.areParentsReady(entry.op))
        .sort((a, b) => (a.opHash < b.opHash ? -1 : a.opHash > b.opHash ? 1 : 0));

      for (const entry of ready) {
        this.deletePendingEntry(entry.opHash, entry.memberId);
        if (this.knownOpHashes.has(entry.opHash)) continue;
        try {
          // Re-verify roomId/nodeId binding in case doc bound on the parent op
          this.assertDocBinding(entry.op);
          const drEq = this.applyReadyOp(entry.op, entry.opHash);
          anyEq = anyEq || drEq;
          drained.push(entry.opHash);
          progressed = true;
        } catch (err) {
          rejectedPending.push({
            opHash: entry.opHash,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }
    }

    return {
      applied: true,
      duplicate: false,
      buffered: false,
      opHash,
      drained,
      rejectedPending,
      equivocationDetected: anyEq,
    };
  }

  private deletePendingEntry(opHash: string, memberId: string): void {
    if (!this.pendingOps.delete(opHash)) return;
    const prev = this.pendingCountByMember.get(memberId) ?? 0;
    if (prev <= 1) {
      this.pendingCountByMember.delete(memberId);
    } else {
      this.pendingCountByMember.set(memberId, prev - 1);
    }
  }

  private assertDocBinding(op: VfsDocOpBody): void {
    if (this._roomId !== undefined && op.roomId !== this._roomId) {
      throw new VfsInvalidOpError(
        'room-mismatch',
        `Op roomId "${op.roomId}" does not match document roomId "${this._roomId}".`,
      );
    }
    if (this._nodeId !== undefined && op.nodeId !== this._nodeId) {
      throw new VfsInvalidOpError(
        'node-mismatch',
        `Op nodeId "${op.nodeId}" does not match document nodeId "${this._nodeId}".`,
      );
    }
  }

  private validateOpShape(op: VfsDocOpBody): void {
    if (!op || op.kind !== 'vfs-doc-op' || op.v !== 1) {
      throw new VfsInvalidOpError('invalid-kind', 'Op must be a v1 vfs-doc-op.');
    }
    if (typeof op.roomId !== 'string' || op.roomId.length === 0 || op.roomId.includes('\0')) {
      throw new VfsInvalidOpError('invalid-room-id', 'Op roomId must be a non-empty string without NUL.');
    }
    if (typeof op.nodeId !== 'string' || op.nodeId.length === 0 || op.nodeId.includes('\0')) {
      throw new VfsInvalidOpError('invalid-node-id', 'Op nodeId must be a non-empty string without NUL.');
    }
    this.assertDocBinding(op);

    if (typeof op.opId !== 'string' || op.opId.length === 0 || op.opId.length > 128 || op.opId.includes('\0')) {
      throw new VfsInvalidOpError('invalid-op-id', 'Op opId must be a non-empty string (<= 128 chars).');
    }
    if (typeof op.deviceId !== 'string' || op.deviceId.length === 0 || op.deviceId.length > 128 || op.deviceId.includes('\0')) {
      throw new VfsInvalidOpError('invalid-device-id', 'Op deviceId must be non-empty.');
    }
    if (typeof op.memberId !== 'string' || op.memberId.length === 0 || op.memberId.length > 128 || op.memberId.includes('\0')) {
      throw new VfsInvalidOpError('invalid-member-id', 'Op memberId must be non-empty.');
    }
    if (!Number.isInteger(op.epoch) || op.epoch < 1 || op.epoch > 0xffff_ffff) {
      throw new VfsInvalidOpError('invalid-epoch', 'Op epoch must be a positive uint32.');
    }
    if (!Number.isSafeInteger(op.seq) || op.seq < 1 || op.seq > VFS_MAX_SEQ) {
      throw new VfsInvalidOpError('invalid-seq', `Op seq must be an integer in 1..${VFS_MAX_SEQ}.`);
    }
    if (!Number.isSafeInteger(op.lamport) || op.lamport < 1) {
      throw new VfsInvalidOpError('invalid-lamport', 'Op lamport must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(op.at) || op.at <= 0) {
      throw new VfsInvalidOpError('invalid-timestamp', 'Op timestamp must be a positive safe integer.');
    }
    if (op.revertsCommit !== undefined && !isValidVfsCommitId(op.revertsCommit)) {
      throw new VfsInvalidOpError(
        'invalid-reverts-commit',
        'Op revertsCommit must be a lowercase UUID or 64-char lowercase hex hash.',
      );
    }
    if (!Number.isSafeInteger(op.counterStart) || op.counterStart < 0) {
      throw new VfsInvalidOpError('invalid-counter', 'Op counterStart must be a non-negative safe integer.');
    }
    if (!Array.isArray(op.parents) || !Array.isArray(op.ops)) {
      throw new VfsInvalidOpError('invalid-arrays', 'Op parents and ops must be arrays.');
    }
    if (op.parents.length > this.maxParents) {
      throw new VfsInvalidOpError(
        'too-many-parents',
        `Op parents count ${op.parents.length} exceeds limit (${this.maxParents}).`,
      );
    }
    if (op.ops.length > this.maxSubOps) {
      throw new VfsInvalidOpError(
        'too-many-sub-ops',
        `Op sub-op count ${op.ops.length} exceeds limit (${this.maxSubOps}).`,
      );
    }
    const seenParents = new Set<string>();
    for (const p of op.parents) {
      if (typeof p !== 'string' || p.length === 0) {
        throw new VfsInvalidOpError('invalid-parent-hash', 'Op parents entries must be non-empty strings.');
      }
      if (seenParents.has(p)) {
        throw new VfsInvalidOpError('duplicate-parent-hash', `Duplicate parent hash "${p}" in op.parents.`);
      }
      seenParents.add(p);
    }

    let totalIns = 0;
    let totalInsBytes = 0;
    let totalDelRuns = 0;
    for (const sub of op.ops) {
      if (sub.t === 'ins') {
        const cps = validateTextScalars(sub.text);
        if (cps.length === 0) {
          throw new VfsInvalidOpError('empty-insert', 'Insert sub-op must have non-empty text.');
        }
        totalInsBytes += utf8ByteLength(sub.text);
        if (totalInsBytes > this.maxOpPlaintextBytes) {
          throw new VfsInvalidOpError(
            'op-too-large',
            `Op inserted bytes (${totalInsBytes}) exceed limit (${this.maxOpPlaintextBytes} bytes).`,
          );
        }
        totalIns += cps.length;
        if (op.counterStart > Number.MAX_SAFE_INTEGER - totalIns) {
          throw new VfsInvalidOpError('counter-overflow', 'Op counter range exceeds MAX_SAFE_INTEGER.');
        }
        if (sub.side !== 'L' && sub.side !== 'R') {
          throw new VfsInvalidOpError('invalid-side', 'Insert sub-op side must be "L" or "R".');
        }
        if (sub.parent !== null && !isValidFugueId(sub.parent)) {
          throw new VfsInvalidOpError('invalid-parent-tuple', 'Insert sub-op parent must be null or [deviceId, safeInt].');
        }
        if (sub.side === 'L' && sub.parent === null) {
          throw new VfsInvalidOpError('left-of-root', 'Cannot insert with side "L" under ROOT.');
        }
        if (sub.rightOrigin !== undefined && sub.rightOrigin !== null && !isValidFugueId(sub.rightOrigin)) {
          throw new VfsInvalidOpError(
            'invalid-right-origin-tuple',
            'Insert sub-op rightOrigin must be null/undefined or [deviceId, safeInt].',
          );
        }
      } else if (sub.t === 'del') {
        if (!Array.isArray(sub.runs)) {
          throw new VfsInvalidOpError('invalid-del-runs', 'Delete sub-op runs must be an array.');
        }
        totalDelRuns += sub.runs.length;
        if (totalDelRuns > this.maxOpPlaintextBytes) {
          throw new VfsInvalidOpError('op-too-large', 'Op delete runs exceed plaintext size ceiling.');
        }
        for (const r of sub.runs) {
          if (
            !Array.isArray(r) ||
            r.length !== 3 ||
            typeof r[0] !== 'string' ||
            r[0].length === 0 ||
            !Number.isSafeInteger(r[1]) ||
            r[1] < 0 ||
            !Number.isSafeInteger(r[2]) ||
            r[2] <= 0
          ) {
            throw new VfsInvalidOpError('invalid-del-run', 'Invalid delete run tuple.');
          }
          if (r[2] > this.maxDelRunLen) {
            throw new VfsInvalidOpError(
              'del-run-too-long',
              `Delete run length ${r[2]} exceeds limit (${this.maxDelRunLen}).`,
            );
          }
          if (r[1] > Number.MAX_SAFE_INTEGER - r[2]) {
            throw new VfsInvalidOpError('del-run-overflow', 'Delete run range exceeds MAX_SAFE_INTEGER.');
          }
        }
      } else {
        throw new VfsInvalidOpError('unknown-sub-op', 'Unknown FugueMax sub-op type.');
      }
    }
  }

  private areParentsReady(op: VfsDocOpBody): boolean {
    for (const p of op.parents) {
      if (!this.knownOpHashes.has(p)) return false;
    }
    return true;
  }

  private isCurrentFrontier(parents: readonly string[]): boolean {
    if (parents.length !== this.frontierSet.size) return false;
    for (let i = 0; i < parents.length; i++) {
      if (!this.frontierSet.has(parents[i]!)) return false;
    }
    return true;
  }

  /**
   * Returns all already-inserted runs by `op.deviceId` whose counter range overlaps `op`'s
   * insert range in O(log n + k) via binary search on the sorted device index.
   */
  private findOverlappingRuns(op: VfsDocOpBody): FugueRun[] {
    const devRuns = this.runsByDevice.get(op.deviceId);
    if (!devRuns || devRuns.length === 0) return [];
    let totalIns = 0;
    for (const sub of op.ops) {
      if (sub.t === 'ins') {
        totalIns += Array.from(sub.text).length;
      }
    }
    if (totalIns === 0) return [];
    const start = op.counterStart;
    const end = start + totalIns;

    // Binary search for first run whose `counterStart + len > start`
    let lo = 0;
    let hi = devRuns.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const run = devRuns[mid]!;
      if (run.counterStart + run.len <= start) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    const overlaps: FugueRun[] = [];
    for (let i = lo; i < devRuns.length; i++) {
      const run = devRuns[i]!;
      if (run.counterStart >= end) break;
      overlaps.push(run);
    }
    return overlaps;
  }

  /**
   * Pre-validates ALL sub-op references (`ins` `parent`/`rightOrigin` AND `del` target runs)
   * against `parentCone` BEFORE mutating any state so acceptance is 100% atomic AND
   * order-independent across peers.
   */
  private validateSubOpReferences(
    op: VfsDocOpBody,
    parentCone?: ReadonlySet<string>,
    hasCompactedAncestor = false,
  ): void {
    let cursorCounter = op.counterStart;
    const intraStart = op.counterStart;

    const isRunInCausalCone = (run: FugueRun): boolean => {
      if (!parentCone) return true;
      if (parentCone.has(run.opHash)) return true;
      if (hasCompactedAncestor && this.checkpointBaseKnownSet.has(run.opHash)) return true;
      return false;
    };

    const idAccessible = (id: FugueId): boolean => {
      if (id[0] === op.deviceId && id[1] >= intraStart && id[1] < cursorCounter) {
        return true;
      }
      const run = this.findRun(id[0], id[1]);
      if (!run) return false;
      return isRunInCausalCone(run);
    };

    for (const sub of op.ops) {
      if (sub.t === 'ins') {
        const cps = validateTextScalars(sub.text);
        if (sub.parent !== null && !idAccessible(sub.parent)) {
          throw new VfsInvalidOpError(
            'missing-parent',
            `Referenced parent ${fugueIdKey(sub.parent)} not found in op.parents causal cone.`,
          );
        }
        if (sub.side === 'L') {
          if (sub.rightOrigin !== undefined && sub.rightOrigin !== null && !fugueIdEquals(sub.rightOrigin, sub.parent)) {
            throw new VfsInvalidOpError(
              'invalid-left-right-origin',
              'Insert sub-op with side "L" must have rightOrigin equal to parent.',
            );
          }
        } else if (sub.rightOrigin !== undefined && sub.rightOrigin !== null && !idAccessible(sub.rightOrigin)) {
          throw new VfsInvalidOpError(
            'missing-right-origin',
            `Referenced rightOrigin ${fugueIdKey(sub.rightOrigin)} not found in op.parents causal cone.`,
          );
        }
        cursorCounter += cps.length;
      } else {
        // Strictly verify EVERY deleted code point belongs to an op in `op.parents` causal cone
        // (or an earlier intra-op insert) so delete acceptance is 100% order-independent.
        for (const [targetDevice, startCounter, delLen] of sub.runs) {
          let cursor = startCounter;
          const end = startCounter + delLen;
          while (cursor < end) {
            if (targetDevice === op.deviceId && cursor >= intraStart && cursor < cursorCounter) {
              cursor = Math.min(end, cursorCounter);
              continue;
            }
            const run = this.findRun(targetDevice, cursor);
            if (!run) {
              throw new VfsInvalidOpError(
                'delete-outside-causal-cone',
                `Delete target ${targetDevice}:${cursor} does not exist in op.parents causal cone.`,
              );
            }
            if (!isRunInCausalCone(run)) {
              throw new VfsInvalidOpError(
                'delete-outside-causal-cone',
                `Delete target ${targetDevice}:${cursor} (op ${run.opHash}) is outside op.parents causal cone.`,
              );
            }
            cursor = Math.min(end, run.counterStart + run.len);
          }
        }
      }
    }
  }

  private applyReadyOp(op: VfsDocOpBody, opHash: string): boolean {
    if (this.appliedOps.size >= this.maxAppliedOps) {
      throw new VfsInvalidOpError(
        'compaction-ceiling-exceeded',
        `Applied op log reached compaction ceiling (${this.maxAppliedOps}); compact before applying more ops.`,
      );
    }

    // Enforce anti-DoS counter, seq, and order-independent lamport jump bounds
    // AFTER causal parents are ready (so valid out-of-order ops buffer cleanly).
    const expectedNext = this.nextCounters.get(op.deviceId) ?? 0;
    if (op.counterStart > expectedNext + this.maxCounterJump) {
      throw new VfsInvalidOpError(
        'counter-jump-exceeded',
        `Op counterStart ${op.counterStart} exceeds allowed jump (${this.maxCounterJump}) above ${expectedNext}.`,
      );
    }
    const prevSeq = this.maxSeqByDevice.get(op.deviceId) ?? 0;
    if (op.seq > prevSeq + this.maxSeqJump) {
      throw new VfsInvalidOpError(
        'seq-jump-exceeded',
        `Op seq ${op.seq} exceeds allowed jump (${this.maxSeqJump}) above ${prevSeq}.`,
      );
    }
    let parentMaxLamport = 0;
    for (const p of op.parents) {
      const parentRec = this.appliedOps.get(p);
      const pLamport = parentRec ? parentRec.op.lamport : this.checkpointMaxLamport;
      if (pLamport > parentMaxLamport) parentMaxLamport = pLamport;
    }
    if (op.lamport > parentMaxLamport + this.maxLamportJump) {
      throw new VfsInvalidOpError(
        'lamport-jump-exceeded',
        `Op lamport ${op.lamport} exceeds allowed jump (${this.maxLamportJump}) above parent max ${parentMaxLamport}.`,
      );
    }

    const projectedDelta = this.estimateByteDelta(op);
    if (projectedDelta > this.hardLimitBytes) {
      throw new VfsSizeLimitError(projectedDelta, this.hardLimitBytes);
    }

    // Order-independent causal cone validation for BOTH inserts and deletes.
    const parentCone = this.causalCone(op.parents);
    let hasCompactedAncestor = false;
    if (this.checkpointBase !== null && this.checkpointBase.opLog === undefined) {
      for (const h of parentCone) {
        if (!this.appliedOps.has(h) && this.checkpointBaseKnownSet.has(h)) {
          hasCompactedAncestor = true;
          break;
        }
      }
    }

    const overlappingRuns = this.findOverlappingRuns(op);
    const isEquivocation = overlappingRuns.length > 0;

    // Validate references strictly within `op.parents` causal cone BEFORE any mutation.
    this.validateSubOpReferences(op, parentCone, hasCompactedAncestor);

    // Order-independent hard size ceiling check: evaluates post-apply size strictly
    // against `materializeAt(op.parents)` so concurrent edits never cause order-dependent
    // acceptance/rejection divergence across peers!
    if (projectedDelta > 0) {
      if (this.isCurrentFrontier(op.parents) && !isEquivocation) {
        if (this.visibleBytes + projectedDelta > this.hardLimitBytes) {
          const exactBytes = this.measurePostApplyBytes(op, opHash);
          if (exactBytes > this.hardLimitBytes) {
            throw new VfsSizeLimitError(exactBytes, this.hardLimitBytes);
          }
        }
      } else if (this.visibleBytes + this.tombstonedBytes + projectedDelta > this.hardLimitBytes) {
        const coneBytes = this.measureCausalConePostApplyBytes(op, opHash);
        if (coneBytes > this.hardLimitBytes) {
          throw new VfsSizeLimitError(coneBytes, this.hardLimitBytes);
        }
      }
    }

    if (isEquivocation) {
      let minWinnerHash = overlappingRuns[0]!.opHash;
      for (let i = 1; i < overlappingRuns.length; i++) {
        const h = overlappingRuns[i]!.opHash;
        if (h < minWinnerHash) minWinnerHash = h;
      }

      const existingProof = this.equivocationProofsByWinner.get(minWinnerHash);
      const devEqCount = this.equivocationCountByDevice.get(op.deviceId) ?? 0;

      if (opHash > minWinnerHash) {
        // Incoming equivocating op LOSES to already-applied lower-hash winner.
        // Keep at most 1 equivocation proof per winning range; reject spam in O(1)
        // with ZERO clone, ZERO rebuild, and ZERO memory amplification!
        if (existingProof !== undefined) {
          throw new VfsInvalidOpError(
            'equivocation-limit-exceeded',
            `Device "${op.deviceId}" exceeded equivocation proof cap for counterStart ${op.counterStart}.`,
          );
        }
        if (devEqCount >= this.maxEquivocationsPerDevice) {
          throw new VfsInvalidOpError(
            'equivocation-limit-exceeded',
            `Device "${op.deviceId}" exceeded per-device equivocation cap (${this.maxEquivocationsPerDevice}).`,
          );
        }
        this.equivocationProofsByWinner.set(minWinnerHash, opHash);
        this.equivocationCountByDevice.set(op.deviceId, devEqCount + 1);
        this.recordAppliedMeta(op, opHash);
        return true;
      }

      // Incoming equivocating op has strictly LOWER opHash -> NEW winner.
      if (devEqCount >= this.maxEquivocationsPerDevice) {
        throw new VfsInvalidOpError(
          'equivocation-limit-exceeded',
          `Device "${op.deviceId}" exceeded per-device equivocation cap (${this.maxEquivocationsPerDevice}).`,
        );
      }

      // Single atomic rebuild on scratch clone, then O(1) state swap (avoids double rebuild!).
      const scratch = this.clone();
      scratch.recordAppliedMeta(op, opHash);
      scratch.rebuildTreeDeterministic();
      this.commitRebuiltStateFrom(scratch);
      this.equivocationProofsByWinner.delete(minWinnerHash);
      this.equivocationProofsByWinner.set(opHash, minWinnerHash);
      this.equivocationCountByDevice.set(op.deviceId, devEqCount + 1);
      return true;
    }

    this.applySubOpsUnchecked(op, opHash);
    this.recordAppliedMeta(op, opHash);
    return false;
  }

  private commitRebuiltStateFrom(scratch: FugueMaxDoc): void {
    this.rootRightChildren = scratch.rootRightChildren;
    this.runsByDevice = scratch.runsByDevice;
    this.nextCounters = scratch.nextCounters;
    this.maxSeqByDevice = scratch.maxSeqByDevice;
    this.maxLamport = scratch.maxLamport;
    this.appliedOps = scratch.appliedOps;
    this.knownOpHashes = scratch.knownOpHashes;
    this.frontierSet = scratch.frontierSet;
    this.frontierMap = scratch.frontierMap;
    this.applyCounter = scratch.applyCounter;
    this.visibleBytes = scratch.visibleBytes;
    this.tombstonedBytes = scratch.tombstonedBytes;
    this._roomId = scratch._roomId;
    this._nodeId = scratch._nodeId;
  }

  private estimateByteDelta(op: VfsDocOpBody): number {
    let added = 0;
    for (const sub of op.ops) {
      if (sub.t === 'ins') {
        added += utf8ByteLength(sub.text);
      }
    }
    return added;
  }

  private measurePostApplyBytes(op: VfsDocOpBody, opHash: string): number {
    const scratch = this.clone();
    scratch.applySubOpsUnchecked(op, opHash);
    return scratch.visibleBytes;
  }

  private measureCausalConePostApplyBytes(op: VfsDocOpBody, opHash: string): number {
    try {
      const coneState = this.materializeAt(op.parents);
      const coneDoc = coneState.doc;
      if (coneDoc.findOverlappingRuns(op).length > 0) {
        coneDoc.recordAppliedMeta(op, opHash);
        coneDoc.rebuildTreeDeterministic();
      } else {
        coneDoc.applySubOpsUnchecked(op, opHash);
      }
      return coneDoc.visibleBytes;
    } catch (err) {
      if (err instanceof VfsInvalidOpError && err.reason === 'history-compacted') {
        return this.measurePostApplyBytes(op, opHash);
      }
      throw err;
    }
  }

  private recordAppliedMeta(op: VfsDocOpBody, opHash: string): void {
    if (this._roomId === undefined) this._roomId = op.roomId;
    if (this._nodeId === undefined) this._nodeId = op.nodeId;
    this.knownOpHashes.add(opHash);
    this.appliedOps.set(opHash, { op, opHash, order: this.applyCounter++ });
    const prevSeq = this.maxSeqByDevice.get(op.deviceId) ?? 0;
    if (op.seq > prevSeq) this.maxSeqByDevice.set(op.deviceId, op.seq);
    if (op.lamport > this.maxLamport) this.maxLamport = op.lamport;
    for (const p of op.parents) {
      this.frontierSet.delete(p);
    }
    this.frontierSet.add(opHash);
    this.recordFrontier(this.frontier());
  }

  private recordFrontier(frontier: string[]): void {
    const rev = computeFrontierRev(frontier);
    if (this.frontierMap.has(rev)) {
      // Refresh recency
      this.frontierMap.delete(rev);
    }
    this.frontierMap.set(rev, [...frontier]);
    while (this.frontierMap.size > this.maxFrontierMapEntries) {
      const oldestKey = this.frontierMap.keys().next().value;
      if (oldestKey !== undefined) {
        this.frontierMap.delete(oldestKey);
      } else {
        break;
      }
    }
  }

  private applySubOpsUnchecked(op: VfsDocOpBody, opHash: string): void {
    let cursorCounter = op.counterStart;

    for (const sub of op.ops) {
      if (sub.t === 'ins') {
        const cps = validateTextScalars(sub.text);
        const len = cps.length;

        let parentRun: FugueRun | null = null;
        if (sub.parent !== null) {
          parentRun = this.prepareParentForAttachment(sub.parent, sub.side);
          if (!parentRun) {
            throw new VfsInvalidOpError(
              'missing-parent',
              `Referenced parent ${fugueIdKey(sub.parent)} not found in document.`,
            );
          }
        }

        // For side 'L', rightOrigin is canonically the parent's first ID.
        let rightOrigin: FugueId | null;
        if (sub.side === 'L') {
          rightOrigin = [parentRun!.deviceId, parentRun!.counterStart];
        } else {
          rightOrigin = sub.rightOrigin ?? null;
          if (rightOrigin !== null && !this.findRun(rightOrigin[0], rightOrigin[1])) {
            throw new VfsInvalidOpError(
              'missing-right-origin',
              `Referenced rightOrigin ${fugueIdKey(rightOrigin)} not found in document.`,
            );
          }
        }

        const run: FugueRun = {
          deviceId: op.deviceId,
          counterStart: cursorCounter,
          len,
          seq: op.seq,
          opHash,
          deleted: false,
          codePoints: cps,
          parent: parentRun,
          side: sub.side,
          rightOrigin,
          leftChildren: [],
          rightChildren: [],
        };

        this.insertRunIntoDeviceIndex(run);
        this.attachChildRun(parentRun, run);
        this.visibleBytes += utf8ByteLength(sub.text);
        cursorCounter += len;
      } else {
        for (const [targetDevice, startCounter, delLen] of sub.runs) {
          this.tombstoneRange(targetDevice, startCounter, delLen);
        }
      }
    }

    const prevNext = this.nextCounters.get(op.deviceId) ?? 0;
    if (cursorCounter > prevNext) {
      this.nextCounters.set(op.deviceId, cursorCounter);
    }
  }

  /**
   * Rebuilds the CRDT tree deterministically across all applied ops in O(n log n),
   * resolving any `(deviceId, counter)` equivocation in favor of the lowest `opHash`.
   */
  private rebuildTreeDeterministic(): void {
    const allOps = [...this.appliedOps.values()];
    // Order topologically with deterministic opHash tie-breaking.
    const ordered = this.topologicalSortOps(allOps);

    // Reset tree state (re-hydrating from checkpointBase if present).
    this.rootRightChildren = [];
    this.runsByDevice.clear();
    this.nextCounters.clear();
    this.visibleBytes = 0;
    this.tombstonedBytes = 0;

    if (this.checkpointBase) {
      this.hydrateTreeFromCheckpointRuns(this.checkpointBase);
    }

    // Track claimed counter intervals per device (sorted by start for O(log n) overlap checks);
    // iterate in ascending opHash order so lowest opHash always wins.
    const sortedByHash = [...ordered].sort((a, b) => (a.opHash < b.opHash ? -1 : a.opHash > b.opHash ? 1 : 0));
    const claimed = new Map<string, Array<[number, number]>>();
    const suppressedInsertOps = new Set<string>();

    for (const rec of sortedByHash) {
      let insLen = 0;
      for (const sub of rec.op.ops) {
        if (sub.t === 'ins') insLen += Array.from(sub.text).length;
      }
      if (insLen === 0) continue;
      const start = rec.op.counterStart;
      const end = start + insLen;
      let intervals = claimed.get(rec.op.deviceId);
      if (!intervals) {
        intervals = [];
        claimed.set(rec.op.deviceId, intervals);
      }
      // Binary search for insertion point by interval start
      let lo = 0;
      let hi = intervals.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (intervals[mid]![0] < start) lo = mid + 1;
        else hi = mid;
      }
      const overlapsPrev = lo > 0 && intervals[lo - 1]![1] > start;
      const overlapsNext = lo < intervals.length && intervals[lo]![0] < end;
      if (overlapsPrev || overlapsNext) {
        suppressedInsertOps.add(rec.opHash);
      } else {
        intervals.splice(lo, 0, [start, end]);
      }
    }

    for (const rec of ordered) {
      if (suppressedInsertOps.has(rec.opHash)) continue;
      try {
        this.validateSubOpReferences(rec.op);
      } catch {
        // Dangling reference to a suppressed equivocating loser: skip deterministically.
        continue;
      }
      this.applySubOpsUnchecked(rec.op, rec.opHash);
    }
  }

  // -------------------------------------------------------------------------
  // FugueMax Tree Primitives
  // -------------------------------------------------------------------------

  private findRun(deviceId: string, counter: number): FugueRun | null {
    const runs = this.runsByDevice.get(deviceId);
    if (!runs || runs.length === 0) return null;
    let lo = 0;
    let hi = runs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const run = runs[mid]!;
      if (counter < run.counterStart) {
        hi = mid - 1;
      } else if (counter >= run.counterStart + run.len) {
        lo = mid + 1;
      } else {
        return run;
      }
    }
    return null;
  }

  private insertRunIntoDeviceIndex(run: FugueRun): void {
    let runs = this.runsByDevice.get(run.deviceId);
    if (!runs) {
      runs = [];
      this.runsByDevice.set(run.deviceId, runs);
    }
    // Fast path: monotonic append
    if (runs.length === 0 || runs[runs.length - 1]!.counterStart < run.counterStart) {
      runs.push(run);
      return;
    }
    let lo = 0;
    let hi = runs.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (runs[mid]!.counterStart < run.counterStart) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    runs.splice(lo, 0, run);
  }

  /**
   * Splits `run` at relative code-point offset `offset` (`0 < offset < run.len`),
   * mutating `run` in-place to become `[0..offset)` and returning the new right
   * half `[offset..len)`.
   */
  private splitRun(run: FugueRun, offset: number): FugueRun {
    const rightLen = run.len - offset;
    const rightRun: FugueRun = {
      deviceId: run.deviceId,
      counterStart: run.counterStart + offset,
      len: rightLen,
      seq: run.seq,
      opHash: run.opHash,
      deleted: run.deleted,
      codePoints: run.deleted ? null : run.codePoints!.slice(offset),
      parent: run,
      side: 'R',
      rightOrigin: run.rightOrigin,
      leftChildren: [],
      rightChildren: run.rightChildren,
    };

    for (const ch of rightRun.rightChildren) {
      ch.parent = rightRun;
    }

    run.len = offset;
    run.codePoints = run.deleted ? null : run.codePoints!.slice(0, offset);
    run.rightChildren = [rightRun];

    this.insertRunIntoDeviceIndex(rightRun);
    return rightRun;
  }

  /**
   * Ensures the character `parentId` sits at the exact attachment boundary of its
   * run (start of run for side `'L'`, end of run for side `'R'`), lazily splitting
   * if needed.
   */
  private prepareParentForAttachment(parentId: FugueId, side: 'L' | 'R'): FugueRun | null {
    const run = this.findRun(parentId[0], parentId[1]);
    if (!run) return null;
    const offset = parentId[1] - run.counterStart;
    if (side === 'L') {
      if (offset === 0) return run;
      return this.splitRun(run, offset);
    } else {
      if (offset === run.len - 1) return run;
      this.splitRun(run, offset + 1);
      return run;
    }
  }

  private tombstoneRange(deviceId: string, startCounter: number, len: number): void {
    let cursor = startCounter;
    const end = startCounter + len;

    while (cursor < end) {
      const run = this.findRun(deviceId, cursor);
      if (!run) {
        // Skip unknown range safely (idempotent / partial range)
        const runs = this.runsByDevice.get(deviceId);
        if (!runs) break;
        const nextRun = runs.find((r) => r.counterStart > cursor && r.counterStart < end);
        if (!nextRun) break;
        cursor = nextRun.counterStart;
        continue;
      }

      const runStart = run.counterStart;
      const runEnd = runStart + run.len;
      const delStart = Math.max(cursor, runStart);
      const delEnd = Math.min(end, runEnd);

      if (run.deleted) {
        cursor = delEnd;
        continue;
      }

      let target = run;
      if (delStart > runStart) {
        target = this.splitRun(run, delStart - runStart);
      }
      if (delEnd < target.counterStart + target.len) {
        this.splitRun(target, delEnd - target.counterStart);
      }

      if (!target.deleted && target.codePoints) {
        let removedBytes = 0;
        for (let i = 0; i < target.codePoints.length; i++) {
          removedBytes += utf8ByteLength(target.codePoints[i]!);
        }
        this.visibleBytes -= removedBytes;
        this.tombstonedBytes += removedBytes;
        target.deleted = true;
        target.codePoints = null;
      }

      cursor = delEnd;
    }
  }

  private attachChildRun(parent: FugueRun | null, child: FugueRun): void {
    if (parent === null) {
      this.insertSortedRightChild(this.rootRightChildren, child);
      return;
    }
    if (child.side === 'L') {
      this.insertSortedLeftChild(parent.leftChildren, child);
    } else {
      this.insertSortedRightChild(parent.rightChildren, child);
    }
  }

  private insertSortedLeftChild(list: FugueRun[], child: FugueRun): void {
    const childId: FugueId = [child.deviceId, child.counterStart];
    let idx = list.length;
    for (let i = 0; i < list.length; i++) {
      const existing = list[i]!;
      if (compareFugueId(childId, [existing.deviceId, existing.counterStart]) < 0) {
        idx = i;
        break;
      }
    }
    list.splice(idx, 0, child);
  }

  private insertSortedRightChild(list: FugueRun[], child: FugueRun): void {
    let idx = list.length;
    for (let i = 0; i < list.length; i++) {
      if (this.compareRightSiblings(child, list[i]!, 0) < 0) {
        idx = i;
        break;
      }
    }
    list.splice(idx, 0, child);
  }

  /**
   * FugueMax right-sibling comparator:
   * 1. `rightOrigin` tree position DESCENDING (guarantees backward non-interleaving)
   * 2. `(deviceId, counterStart)` ASCENDING
   */
  private compareRightSiblings(a: FugueRun, b: FugueRun, depth: number): number {
    if (a === b) return 0;
    const roCmp = this.compareRightOrigins(a.rightOrigin, b.rightOrigin, depth + 1);
    if (roCmp !== 0) return -roCmp; // DESCENDING rightOrigin order!
    return compareFugueId([a.deviceId, a.counterStart], [b.deviceId, b.counterStart]);
  }

  /** Compares two `rightOrigin` references in in-order tree traversal (`null` = END = +infinity). */
  private compareRightOrigins(a: FugueId | null, b: FugueId | null, depth: number): number {
    if (fugueIdEquals(a, b)) return 0;
    if (a === null) return 1; // END > any real node
    if (b === null) return -1;
    if (depth > 256) {
      // Defensive cycle guard against malformed Byzantine inputs
      return compareFugueId(a, b);
    }
    const runA = this.findRun(a[0], a[1]);
    const runB = this.findRun(b[0], b[1]);
    if (!runA || !runB) {
      return compareFugueId(a, b);
    }
    if (runA === runB) {
      return a[1] - b[1];
    }
    return this.compareRunsInTreeOrder(runA, runB, depth);
  }

  /** Compares two distinct runs in full in-order tree traversal via their LCA. */
  private compareRunsInTreeOrder(a: FugueRun, b: FugueRun, depth: number): number {
    if (a === b) return 0;

    // Build root-to-node ancestor paths (root is implicit null at index -1).
    const pathA: FugueRun[] = [];
    for (let cur: FugueRun | null = a; cur !== null; cur = cur.parent) {
      pathA.push(cur);
    }
    pathA.reverse();

    const pathB: FugueRun[] = [];
    for (let cur: FugueRun | null = b; cur !== null; cur = cur.parent) {
      pathB.push(cur);
    }
    pathB.reverse();

    let common = 0;
    const minLen = Math.min(pathA.length, pathB.length);
    while (common < minLen && pathA[common] === pathB[common]) {
      common++;
    }

    // One is an ancestor of the other
    if (common === pathA.length) {
      // `a` is an ancestor of `b`; check which side of `a` leads to `b`.
      const childOfA = pathB[common]!;
      return childOfA.side === 'L' ? 1 : -1;
    }
    if (common === pathB.length) {
      // `b` is an ancestor of `a`; check which side of `b` leads to `a`.
      const childOfB = pathA[common]!;
      return childOfB.side === 'L' ? -1 : 1;
    }

    // Diverged at distinct children `childA` and `childB` of the same LCA (or ROOT when common === 0).
    const childA = pathA[common]!;
    const childB = pathB[common]!;
    if (childA.side !== childB.side) {
      return childA.side === 'L' ? -1 : 1;
    }
    if (childA.side === 'L') {
      return compareFugueId([childA.deviceId, childA.counterStart], [childB.deviceId, childB.counterStart]);
    }
    return this.compareRightSiblings(childA, childB, depth + 1);
  }

  private leftmostDescendant(run: FugueRun): FugueRun {
    let cur = run;
    while (cur.leftChildren.length > 0) {
      cur = cur.leftChildren[0]!;
    }
    return cur;
  }

  /**
   * Immediate successor of `run` in full in-order tree traversal, assuming
   * `run.rightChildren.length === 0`.
   */
  private nextIdInTreeAfterRun(run: FugueRun): FugueId | null {
    let cur: FugueRun = run;
    while (true) {
      const parent = cur.parent;
      if (parent === null) {
        // `cur` is a rootRightChild; check if there is a next sibling in rootRightChildren.
        const idx = this.rootRightChildren.indexOf(cur);
        if (idx >= 0 && idx + 1 < this.rootRightChildren.length) {
          const nextSib = this.leftmostDescendant(this.rootRightChildren[idx + 1]!);
          return [nextSib.deviceId, nextSib.counterStart];
        }
        return null; // END
      }
      if (cur.side === 'L') {
        const idx = parent.leftChildren.indexOf(cur);
        if (idx >= 0 && idx + 1 < parent.leftChildren.length) {
          const nextSib = this.leftmostDescendant(parent.leftChildren[idx + 1]!);
          return [nextSib.deviceId, nextSib.counterStart];
        }
        // Finished all left children of `parent`; next in-order node is `parent` itself!
        return [parent.deviceId, parent.counterStart];
      } else {
        const idx = parent.rightChildren.indexOf(cur);
        if (idx >= 0 && idx + 1 < parent.rightChildren.length) {
          const nextSib = this.leftmostDescendant(parent.rightChildren[idx + 1]!);
          return [nextSib.deviceId, nextSib.counterStart];
        }
        cur = parent;
      }
    }
  }

  /** Iterative in-order DFS across all runs (avoids call-stack overflow on deep chains). */
  private traverseRuns(visit: (run: FugueRun) => void): void {
    // Frame state: 0 = descend leftChildren, 1 = visit self & push rightChildren
    const stack: Array<{ run: FugueRun; stage: 0 | 1 }> = [];
    for (let i = this.rootRightChildren.length - 1; i >= 0; i--) {
      stack.push({ run: this.rootRightChildren[i]!, stage: 0 });
    }
    while (stack.length > 0) {
      const frame = stack.pop()!;
      const { run, stage } = frame;
      if (stage === 0) {
        stack.push({ run, stage: 1 });
        for (let i = run.leftChildren.length - 1; i >= 0; i--) {
          stack.push({ run: run.leftChildren[i]!, stage: 0 });
        }
      } else {
        visit(run);
        for (let i = run.rightChildren.length - 1; i >= 0; i--) {
          stack.push({ run: run.rightChildren[i]!, stage: 0 });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Causal Cone & Historical Materialization
  // -------------------------------------------------------------------------

  /**
   * Returns the complete causal cone (set of all ancestor `opHash`es, inclusive)
   * for `targetFrontier`. Throws `VfsInvalidOpError` if any frontier hash is unknown.
   */
  causalCone(targetFrontier: readonly string[]): Set<string> {
    const cone = new Set<string>();
    const stack: string[] = [];
    for (const h of targetFrontier) {
      if (!this.knownOpHashes.has(h)) {
        throw new VfsInvalidOpError('unknown-frontier-op', `Unknown op hash "${h}" in frontier.`);
      }
      if (!cone.has(h)) {
        cone.add(h);
        stack.push(h);
      }
    }
    while (stack.length > 0) {
      const cur = stack.pop()!;
      const rec = this.appliedOps.get(cur);
      if (!rec) continue;
      for (const p of rec.op.parents) {
        if (!cone.has(p)) {
          cone.add(p);
          stack.push(p);
        }
      }
    }
    return cone;
  }

  /**
   * Materializes the exact historical document text and visible element list at
   * any past frontier (either `opHash[]` or a `f:<16-hex>` digest from `frontierMap`).
   */
  materializeAt(frontierOrRev: readonly string[] | string): FugueMaterializedState {
    let targetFrontier: string[];
    if (typeof frontierOrRev === 'string') {
      const resolved = this.resolveFrontier(frontierOrRev);
      if (!resolved) {
        throw new VfsInvalidOpError('unknown-frontier-rev', `Unknown frontier revision "${frontierOrRev}".`);
      }
      targetFrontier = resolved;
    } else {
      targetFrontier = [...frontierOrRev].sort();
    }

    const targetRev = computeFrontierRev(targetFrontier);

    // Fast path: requesting current HEAD frontier
    if (targetRev === this.frontierRev()) {
      const snapDoc = this.clone();
      return {
        text: snapDoc.getText(),
        visible: snapDoc.visibleElements(),
        frontier: snapDoc.frontier(),
        rev: targetRev,
        doc: snapDoc,
      };
    }

    // Empty frontier -> empty doc
    if (targetFrontier.length === 0) {
      const emptyDoc = new FugueMaxDoc(this.docOptions());
      return {
        text: '',
        visible: [],
        frontier: [],
        rev: emptyDoc.frontierRev(),
        doc: emptyDoc,
      };
    }

    const cone = this.causalCone(targetFrontier);

    // If this doc was loaded from a compact checkpoint without ancient op logs,
    // start from the checkpoint if the target cone contains the checkpoint frontier.
    let replayDoc: FugueMaxDoc;
    const baseOps = new Set<string>();
    if (this.checkpointBase && this.checkpointBase.opLog === undefined) {
      const cpKnown = new Set(this.checkpointBase.knownOpHashes);
      const cpFrontierCovered = this.checkpointBase.frontier.every((h) => cone.has(h));
      if (!cpFrontierCovered) {
        throw new VfsInvalidOpError(
          'history-compacted',
          `Cannot materialize frontier "${targetRev}": ops before checkpoint were compacted.`,
        );
      }
      replayDoc = FugueMaxDoc.fromCheckpoint(this.checkpointBase, this.docOptions());
      for (const h of cpKnown) baseOps.add(h);
    } else {
      replayDoc = new FugueMaxDoc(this.docOptions());
    }

    const opsToReplay: FugueAppliedOpRecord[] = [];
    for (const h of cone) {
      if (baseOps.has(h)) continue;
      const rec = this.appliedOps.get(h);
      if (!rec) {
        throw new VfsInvalidOpError('missing-op-in-cone', `Op "${h}" missing from op log.`);
      }
      opsToReplay.push(rec);
    }

    const ordered = this.topologicalSortOps(opsToReplay);
    for (const rec of ordered) {
      replayDoc.applyOp(rec.op, rec.opHash);
    }

    return {
      text: replayDoc.getText(),
      visible: replayDoc.visibleElements(),
      frontier: replayDoc.frontier(),
      rev: replayDoc.frontierRev(),
      doc: replayDoc,
    };
  }

  private topologicalSortOps(records: FugueAppliedOpRecord[]): FugueAppliedOpRecord[] {
    const byHash = new Map<string, FugueAppliedOpRecord>();
    for (const r of records) byHash.set(r.opHash, r);

    const indegree = new Map<string, number>();
    const children = new Map<string, string[]>();
    for (const r of records) {
      let deg = 0;
      for (const p of r.op.parents) {
        if (byHash.has(p)) {
          deg++;
          let list = children.get(p);
          if (!list) {
            list = [];
            children.set(p, list);
          }
          list.push(r.opHash);
        }
      }
      indegree.set(r.opHash, deg);
    }

    const ready = new StringMinHeap();
    for (const [h, deg] of indegree) {
      if (deg === 0) ready.push(h);
    }

    const out: FugueAppliedOpRecord[] = [];
    while (ready.size > 0) {
      const h = ready.pop()!;
      out.push(byHash.get(h)!);
      const kids = children.get(h);
      if (kids) {
        for (const k of kids) {
          const nextDeg = (indegree.get(k) ?? 1) - 1;
          indegree.set(k, nextDeg);
          if (nextDeg === 0) {
            ready.push(k);
          }
        }
      }
    }

    return out;
  }

  // -------------------------------------------------------------------------
  // Checkpoint Export / Import
  // -------------------------------------------------------------------------

  /**
   * Exports a serializable JSON-safe checkpoint capturing the full FugueMax tree
   * (visible runs + compact tombstone stubs), frontiers, and optional opLog.
   */
  exportCheckpoint(options: { includeOpLog?: boolean } = {}): FugueCheckpoint {
    // Emit runs in BFS/pre-order (parents strictly before children) AND ensure
    // rightOrigin dependencies appear before any run referencing them.
    const allRuns: FugueRun[] = [];
    const queue: FugueRun[] = [...this.rootRightChildren];
    while (queue.length > 0) {
      const run = queue.shift()!;
      allRuns.push(run);
      for (const ch of run.leftChildren) queue.push(ch);
      for (const ch of run.rightChildren) queue.push(ch);
    }

    // Topological sort over both `parent` and `rightOrigin` dependencies so
    // `fromCheckpoint` can attach every run in a single clean pass.
    const orderedRuns = this.topologicalSortRuns(allRuns);

    const runTuples: FugueCheckpointRunTuple[] = orderedRuns.map((r) => [
      r.deviceId,
      r.counterStart,
      r.len,
      r.seq,
      r.opHash,
      r.parent ? ([r.parent.deviceId, r.parent.counterStart] as const) : null,
      r.side,
      r.rightOrigin ? ([r.rightOrigin[0], r.rightOrigin[1]] as const) : null,
      r.deleted ? null : r.codePoints!.join(''),
    ]);

    const nextCounters: Record<string, number> = {};
    for (const [dev, next] of [...this.nextCounters.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      nextCounters[dev] = next;
    }

    const maxSeqByDevice: Record<string, number> = {};
    for (const [dev, seq] of [...this.maxSeqByDevice.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      maxSeqByDevice[dev] = seq;
    }

    const frontier = this.frontier();
    const frontierMapEntries: Array<readonly [string, string[]]> = [];
    for (const [rev, f] of this.frontierMap) {
      frontierMapEntries.push([rev, [...f]] as const);
    }

    const checkpoint: FugueCheckpoint = {
      v: 1,
      ...(this._roomId !== undefined ? { roomId: this._roomId } : {}),
      ...(this._nodeId !== undefined ? { nodeId: this._nodeId } : {}),
      frontier,
      frontierRev: computeFrontierRev(frontier),
      nextCounters,
      maxSeqByDevice,
      maxLamport: this.maxLamport,
      tombstonedBytes: this.tombstonedBytes,
      knownOpHashes: [...this.knownOpHashes].sort(),
      frontierMap: frontierMapEntries,
      runs: runTuples,
      ...(options.includeOpLog
        ? {
            opLog: this.getAppliedOps().map((rec) => ({
              op: cloneOp(rec.op),
              opHash: rec.opHash,
            })),
          }
        : {}),
    };

    return checkpoint;
  }

  private topologicalSortRuns(runs: FugueRun[]): FugueRun[] {
    const keyOf = (r: FugueRun) => `${r.deviceId}:${r.counterStart}`;
    const byKey = new Map<string, FugueRun>();
    for (const r of runs) byKey.set(keyOf(r), r);

    const deps = new Map<string, Set<string>>();
    const dependents = new Map<string, string[]>();

    for (const r of runs) {
      const k = keyOf(r);
      const d = new Set<string>();
      if (r.parent) {
        d.add(keyOf(r.parent));
      }
      if (r.rightOrigin) {
        const roRun = this.findRun(r.rightOrigin[0], r.rightOrigin[1]);
        if (roRun && roRun !== r) {
          d.add(keyOf(roRun));
        }
      }
      deps.set(k, d);
      for (const depKey of d) {
        let list = dependents.get(depKey);
        if (!list) {
          list = [];
          dependents.set(depKey, list);
        }
        list.push(k);
      }
    }

    const ready: string[] = [];
    for (const [k, d] of deps) {
      if (d.size === 0) ready.push(k);
    }
    ready.sort();

    const result: FugueRun[] = [];
    while (ready.length > 0) {
      const k = ready.shift()!;
      result.push(byKey.get(k)!);
      const kids = dependents.get(k);
      if (kids) {
        for (const kid of kids) {
          const d = deps.get(kid)!;
          d.delete(k);
          if (d.size === 0) {
            ready.push(kid);
          }
        }
      }
    }

    // Fallback: include any remaining runs if a malformed cycle ever existed
    if (result.length < runs.length) {
      const seen = new Set(result.map(keyOf));
      for (const r of runs) {
        if (!seen.has(keyOf(r))) result.push(r);
      }
    }
    return result;
  }

  /** Reconstructs a `FugueMaxDoc` from a serialized `FugueCheckpoint`. */
  static fromCheckpoint(checkpoint: FugueCheckpoint, options: FugueDocOptions = {}): FugueMaxDoc {
    if (!checkpoint || checkpoint.v !== 1 || !Array.isArray(checkpoint.runs)) {
      throw new VfsInvalidOpError('invalid-checkpoint', 'Invalid FugueMax checkpoint format.');
    }
    if (
      options.roomId !== undefined &&
      checkpoint.roomId !== undefined &&
      options.roomId !== checkpoint.roomId
    ) {
      throw new VfsInvalidOpError(
        'checkpoint-room-mismatch',
        `Checkpoint roomId "${checkpoint.roomId}" does not match expected "${options.roomId}".`,
      );
    }
    if (
      options.nodeId !== undefined &&
      checkpoint.nodeId !== undefined &&
      options.nodeId !== checkpoint.nodeId
    ) {
      throw new VfsInvalidOpError(
        'checkpoint-node-mismatch',
        `Checkpoint nodeId "${checkpoint.nodeId}" does not match expected "${options.nodeId}".`,
      );
    }

    const mergedOptions: FugueDocOptions = {
      ...options,
      ...(options.roomId ?? checkpoint.roomId !== undefined ? { roomId: options.roomId ?? checkpoint.roomId } : {}),
      ...(options.nodeId ?? checkpoint.nodeId !== undefined ? { nodeId: options.nodeId ?? checkpoint.nodeId } : {}),
    };
    const doc = new FugueMaxDoc(mergedOptions);
    doc.frontierMap.clear();
    doc.hydrateTreeFromCheckpointRuns(checkpoint);

    if (doc.visibleBytes > doc.hardLimitBytes) {
      throw new VfsSizeLimitError(doc.visibleBytes, doc.hardLimitBytes);
    }

    if (checkpoint.maxSeqByDevice) {
      for (const [dev, seq] of Object.entries(checkpoint.maxSeqByDevice)) {
        if (Number.isSafeInteger(seq) && seq >= 0) {
          doc.maxSeqByDevice.set(dev, seq);
        }
      }
    }
    if (typeof checkpoint.maxLamport === 'number' && Number.isSafeInteger(checkpoint.maxLamport) && checkpoint.maxLamport >= 0) {
      doc.maxLamport = checkpoint.maxLamport;
      doc.checkpointMaxLamport = checkpoint.maxLamport;
    }

    for (const h of checkpoint.knownOpHashes) {
      doc.knownOpHashes.add(h);
    }
    for (const h of checkpoint.frontier) {
      doc.frontierSet.add(h);
      doc.knownOpHashes.add(h);
    }
    for (const [rev, f] of checkpoint.frontierMap) {
      doc.frontierMap.set(rev, [...f]);
    }
    doc.recordFrontier(doc.frontier());

    if (checkpoint.opLog) {
      for (const entry of checkpoint.opLog) {
        doc.assertDocBinding(entry.op);
        const computed = computeDocOpHash(entry.op);
        if (entry.opHash !== computed) {
          throw new VfsInvalidOpError('checkpoint-op-hash-mismatch', 'Checkpoint opLog entry hash mismatch.');
        }
        if (doc._roomId === undefined) doc._roomId = entry.op.roomId;
        if (doc._nodeId === undefined) doc._nodeId = entry.op.nodeId;
        doc.appliedOps.set(entry.opHash, {
          op: cloneOp(entry.op),
          opHash: entry.opHash,
          order: doc.applyCounter++,
        });
        doc.knownOpHashes.add(entry.opHash);
        const prevSeq = doc.maxSeqByDevice.get(entry.op.deviceId) ?? 0;
        if (entry.op.seq > prevSeq) doc.maxSeqByDevice.set(entry.op.deviceId, entry.op.seq);
        if (entry.op.lamport > doc.maxLamport) doc.maxLamport = entry.op.lamport;
      }
    } else {
      doc.checkpointBase = checkpoint;
      doc.checkpointBaseKnownSet = new Set(checkpoint.knownOpHashes);
    }

    return doc;
  }

  private hydrateTreeFromCheckpointRuns(checkpoint: FugueCheckpoint): void {
    const runByKey = new Map<string, FugueRun>();
    let estimatedTombstoneBytes = 0;

    for (const tuple of checkpoint.runs) {
      const [deviceId, counterStart, len, seq, opHash, parentId, side, rightOrigin, textOrNull] = tuple;
      const deleted = textOrNull === null;
      let cps: string[] | null = null;
      if (!deleted) {
        cps = validateTextScalars(textOrNull);
        if (cps.length !== len) {
          throw new VfsInvalidOpError(
            'checkpoint-len-mismatch',
            `Checkpoint run length mismatch: expected ${len}, got ${cps.length}.`,
          );
        }
      } else {
        estimatedTombstoneBytes += len * 4;
      }

      let parentRun: FugueRun | null = null;
      if (parentId !== null) {
        parentRun = runByKey.get(fugueIdKey(parentId)) ?? this.findRun(parentId[0], parentId[1]);
        if (!parentRun) {
          throw new VfsInvalidOpError(
            'checkpoint-missing-parent',
            `Checkpoint parent ${fugueIdKey(parentId)} missing.`,
          );
        }
      }

      const run: FugueRun = {
        deviceId,
        counterStart,
        len,
        seq,
        opHash,
        deleted,
        codePoints: cps,
        parent: parentRun,
        side,
        rightOrigin: rightOrigin ? ([rightOrigin[0], rightOrigin[1]] as const) : null,
        leftChildren: [],
        rightChildren: [],
      };

      runByKey.set(fugueIdKey([deviceId, counterStart]), run);
      this.insertRunIntoDeviceIndex(run);
      this.attachChildRun(parentRun, run);
      if (!deleted && textOrNull !== null) {
        this.visibleBytes += utf8ByteLength(textOrNull);
      }

      const prevNext = this.nextCounters.get(deviceId) ?? 0;
      if (counterStart + len > prevNext) {
        this.nextCounters.set(deviceId, counterStart + len);
      }
      const prevSeq = this.maxSeqByDevice.get(deviceId) ?? 0;
      if (seq > prevSeq) {
        this.maxSeqByDevice.set(deviceId, seq);
      }
    }

    this.tombstonedBytes =
      typeof checkpoint.tombstonedBytes === 'number' && checkpoint.tombstonedBytes >= 0
        ? checkpoint.tombstonedBytes
        : estimatedTombstoneBytes;

    for (const [dev, next] of Object.entries(checkpoint.nextCounters)) {
      const cur = this.nextCounters.get(dev) ?? 0;
      if (next > cur) this.nextCounters.set(dev, next);
    }
  }
}
