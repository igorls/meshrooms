/**
 * Shared storage-engine-agnostic `VfsStore` / `VfsRoomStore` contract, validation helpers,
 * `VfsRoomFence`, `writeBeforePublish`, and `MemoryVfsStore` (`docs/flows/room-vfs.md` §3).
 *
 * Pure TypeScript + WebCrypto with zero runtime dependencies (identical in Browser and Bun).
 */

import {
  VFS_COLD_CAS_MAX_BYTES_BROWSER,
  VFS_COLD_CAS_MAX_BYTES_NATIVE,
  VFS_HOT_KV_MAX_BYTES_BROWSER,
  VFS_HOT_KV_MAX_BYTES_NATIVE,
  VFS_MAX_KV_KEY_BYTES,
  VfsError,
  vfsRoomPrefix,
} from './constants';
import { computeCid, utf8Bytes } from './envelope';

const LOWER_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX_64 = /^[a-f0-9]{64}$/;

// ---------------------------------------------------------------------------
// Core VfsStore & VfsRoomStore Contract
// ---------------------------------------------------------------------------

export type VfsKvEntry = {
  key: string;
  value: Uint8Array;
};

export type VfsStoreKind = 'memory' | 'indexeddb' | 'wormdb-ffi' | 'bun-file' | 'wormdb-wasm';

export type VfsStoreQuotas = {
  hotKvMaxBytes: number;
  coldCasMaxBytes: number;
  /** Max fraction of `coldCasMaxBytes` a single `authorMemberId` may occupy (default `0.5`). */
  perMemberCasFraction?: number;
};

export type ResolvedVfsStoreQuotas = Readonly<Required<VfsStoreQuotas>>;

export type VfsRoomStats = {
  hotKvBytes: number;
  hotKvKeys: number;
  coldCasBytes: number;
  coldCasBlocks: number;
  fenced: boolean;
  fencedReason?: string;
};

export type VfsScanDirection = 'first' | 'last';

export type VfsScanPrefixOptions = {
  /** If `> 0`, return at most `limit` matching keys (default unlimited). */
  limit?: number;
  /** Exclusive lower cursor key: only return keys strictly greater than `afterKey` (UTF-8 byte order). */
  afterKey?: string;
  /** Exclusive upper cursor key: only return keys strictly less than `beforeKey` (UTF-8 byte order). */
  beforeKey?: string;
  /**
   * Selection side when `limit > 0` (default `'first'`):
   * - `'first'`: returns the first `limit` matching keys in ascending UTF-8 lexicographic order.
   * - `'last'`: returns the last `limit` matching keys in ascending UTF-8 lexicographic order
   *   (e.g. `{ limit: 1, direction: 'last' }` returns the latest matching entry).
   */
  direction?: VfsScanDirection;
};

export type ResolvedVfsScanPrefixOptions = {
  limit?: number;
  afterKey?: string;
  beforeKey?: string;
  direction: VfsScanDirection;
};

export type VfsPutBlockOptions = {
  /** Member ID billed against the per-member CAS fairness cap (`perMemberCasFraction`). */
  authorMemberId?: string;
};

export interface VfsRoomStore {
  readonly roomId: string;
  readonly kind: VfsStoreKind;
  readonly quotas: ResolvedVfsStoreQuotas;
  readonly isFenced: boolean;
  kvGet(key: string): Promise<Uint8Array | undefined>;
  kvPut(key: string, value: Uint8Array): Promise<void>;
  /** Inserts `key -> value` only if absent; returns `true` if inserted, `false` if already present. */
  kvPutIfAbsent(key: string, value: Uint8Array): Promise<boolean>;
  /** Deletes `key`; returns `true` if the key existed and was deleted, `false` otherwise. */
  kvDelete(key: string): Promise<boolean>;
  /**
   * Scans keys matching `prefix` in STRICTLY ascending UTF-8 lexicographic order.
   * `afterKey` (exclusive lower bound) and `beforeKey` (exclusive upper bound) bound the range;
   * when `limit > 0`, `direction: 'first'` (default) returns the first `limit` matches and
   * `direction: 'last'` returns the last `limit` matches (still in ascending UTF-8 order).
   */
  kvScanPrefix(prefix: string, opts?: VfsScanPrefixOptions): Promise<VfsKvEntry[]>;
  /**
   * Stores an encrypted CAS block verified against `cid === SHA-256(bytes)`.
   * Returns `true` if newly stored (or replacing a corrupted block on disk), `false` if already
   * present and intact (idempotent). Rejects blocks exceeding `VFS_BLOCK_MAX_BYTES` with
   * `VFS_LIMIT_EXCEEDED`, CID mismatches with `VFS_INVALID_ENVELOPE`, and quota breaches with
   * `VFS_STORAGE_QUOTA`.
   */
  putBlock(cid: string, bytes: Uint8Array, opts?: VfsPutBlockOptions): Promise<boolean>;
  /** Retrieves a CAS block by 64-hex `cid`, verifying format and integrity (`SHA-256(bytes) === cid`). */
  getBlock(cid: string): Promise<Uint8Array | undefined>;
  hasBlock(cid: string): Promise<boolean>;
  deleteBlock(cid: string): Promise<boolean>;
  checkpoint(): Promise<void>;
  stats(): Promise<VfsRoomStats>;
  close(): Promise<void>;
}

export interface VfsStore {
  readonly kind: VfsStoreKind;
  openRoom(roomId: string, quotas?: Partial<VfsStoreQuotas>): Promise<VfsRoomStore>;
  destroyRoom(roomId: string): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Default Quotas & Shared Validation Helpers
// ---------------------------------------------------------------------------

export const DEFAULT_PER_MEMBER_CAS_FRACTION = 0.5;

/** Hard single-block size ceiling for Tier 2 Cold CAS blocks (256 KiB; chunks are 64 KiB + 56 B envelope). */
export const VFS_BLOCK_MAX_BYTES = 256 * 1024;

export const DEFAULT_BROWSER_VFS_QUOTAS: ResolvedVfsStoreQuotas = Object.freeze({
  hotKvMaxBytes: VFS_HOT_KV_MAX_BYTES_BROWSER,
  coldCasMaxBytes: VFS_COLD_CAS_MAX_BYTES_BROWSER,
  perMemberCasFraction: DEFAULT_PER_MEMBER_CAS_FRACTION,
});

export const DEFAULT_NATIVE_VFS_QUOTAS: ResolvedVfsStoreQuotas = Object.freeze({
  hotKvMaxBytes: VFS_HOT_KV_MAX_BYTES_NATIVE,
  coldCasMaxBytes: VFS_COLD_CAS_MAX_BYTES_NATIVE,
  perMemberCasFraction: DEFAULT_PER_MEMBER_CAS_FRACTION,
});

export function resolveVfsStoreQuotas(
  kind: VfsStoreKind,
  overrides?: Partial<VfsStoreQuotas>,
): ResolvedVfsStoreQuotas {
  const base = kind === 'wormdb-ffi' || kind === 'bun-file' ? DEFAULT_NATIVE_VFS_QUOTAS : DEFAULT_BROWSER_VFS_QUOTAS;
  const hotKvMaxBytes = overrides?.hotKvMaxBytes ?? base.hotKvMaxBytes;
  const coldCasMaxBytes = overrides?.coldCasMaxBytes ?? base.coldCasMaxBytes;
  const perMemberCasFraction = overrides?.perMemberCasFraction ?? base.perMemberCasFraction;

  if (!Number.isSafeInteger(hotKvMaxBytes) || hotKvMaxBytes < 0) {
    throw new VfsError('VFS_INVALID_KEY', 'hotKvMaxBytes must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(coldCasMaxBytes) || coldCasMaxBytes < 0) {
    throw new VfsError('VFS_INVALID_KEY', 'coldCasMaxBytes must be a non-negative safe integer.');
  }
  if (typeof perMemberCasFraction !== 'number' || !Number.isFinite(perMemberCasFraction) || perMemberCasFraction <= 0 || perMemberCasFraction > 1) {
    throw new VfsError('VFS_INVALID_KEY', 'perMemberCasFraction must be in (0, 1].');
  }
  return Object.freeze({ hotKvMaxBytes, coldCasMaxBytes, perMemberCasFraction });
}

/** Validates a canonical lowercase UUID room identifier. */
export function validateVfsRoomId(roomId: string): string {
  if (typeof roomId !== 'string' || !LOWER_UUID.test(roomId)) {
    throw new VfsError('VFS_INVALID_KEY', 'Invalid VFS roomId: expected lowercase UUID.');
  }
  return roomId;
}

/**
 * Validates that a KV key belongs strictly to `roomId`'s namespace (`vfs:v1:<roomId>:<non-empty>`),
 * contains no NUL bytes, and is at most `VFS_MAX_KV_KEY_BYTES` (512) UTF-8 bytes.
 */
export function validateVfsKvKey(roomId: string, key: string): string {
  const prefix = vfsRoomPrefix(validateVfsRoomId(roomId));
  if (typeof key !== 'string' || !key.startsWith(prefix) || key.length <= prefix.length) {
    throw new VfsError('VFS_INVALID_KEY', `VFS KV key must reside inside room namespace "${prefix}".`);
  }
  if (key.includes('\0')) {
    throw new VfsError('VFS_INVALID_KEY', 'VFS KV key must not contain NUL bytes.');
  }
  if (utf8Bytes(key).byteLength > VFS_MAX_KV_KEY_BYTES) {
    throw new VfsError('VFS_INVALID_KEY', `VFS KV key exceeds ${VFS_MAX_KV_KEY_BYTES} UTF-8 bytes.`);
  }
  return key;
}

/**
 * Validates a prefix for `kvScanPrefix`: must reside inside `vfs:v1:<roomId>:` (may equal the room
 * prefix itself to scan all keys in the room), contain no NUL bytes, and fit within 512 UTF-8 bytes.
 */
export function validateVfsKvPrefix(roomId: string, prefix: string): string {
  const roomPrefix = vfsRoomPrefix(validateVfsRoomId(roomId));
  if (typeof prefix !== 'string' || !prefix.startsWith(roomPrefix)) {
    throw new VfsError('VFS_INVALID_KEY', `VFS KV scan prefix must start with "${roomPrefix}".`);
  }
  if (prefix.includes('\0')) {
    throw new VfsError('VFS_INVALID_KEY', 'VFS KV scan prefix must not contain NUL bytes.');
  }
  if (utf8Bytes(prefix).byteLength > VFS_MAX_KV_KEY_BYTES) {
    throw new VfsError('VFS_INVALID_KEY', `VFS KV scan prefix exceeds ${VFS_MAX_KV_KEY_BYTES} UTF-8 bytes.`);
  }
  return prefix;
}

/** Validates `kvScanPrefix` cursor, limit, and direction options identically across adapters. */
export function validateScanPrefixOptions(opts?: VfsScanPrefixOptions): ResolvedVfsScanPrefixOptions {
  const afterKey = opts?.afterKey;
  if (afterKey !== undefined) {
    if (typeof afterKey !== 'string' || afterKey.includes('\0')) {
      throw new VfsError('VFS_INVALID_KEY', 'Invalid afterKey for kvScanPrefix.');
    }
  }
  const beforeKey = opts?.beforeKey;
  if (beforeKey !== undefined) {
    if (typeof beforeKey !== 'string' || beforeKey.includes('\0')) {
      throw new VfsError('VFS_INVALID_KEY', 'Invalid beforeKey for kvScanPrefix.');
    }
  }
  const limit = opts?.limit;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new VfsError('VFS_INVALID_KEY', 'kvScanPrefix limit must be a non-negative integer.');
  }
  const direction: VfsScanDirection = opts?.direction ?? 'first';
  if (direction !== 'first' && direction !== 'last') {
    throw new VfsError('VFS_INVALID_KEY', "kvScanPrefix direction must be 'first' or 'last'.");
  }
  return {
    ...(afterKey !== undefined ? { afterKey } : {}),
    ...(beforeKey !== undefined ? { beforeKey } : {}),
    ...(limit !== undefined ? { limit } : {}),
    direction,
  };
}

/** Enforces the per-block CAS byte ceiling (`VFS_BLOCK_MAX_BYTES`) before hashing or writing. */
export function assertBlockSizeWithinCap(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array)) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'CAS block payload must be a Uint8Array.');
  }
  if (bytes.byteLength > VFS_BLOCK_MAX_BYTES) {
    throw new VfsError(
      'VFS_LIMIT_EXCEEDED',
      `CAS block size ${bytes.byteLength} exceeds single-block cap of ${VFS_BLOCK_MAX_BYTES} bytes.`,
      { details: { size: bytes.byteLength, maxBytes: VFS_BLOCK_MAX_BYTES } },
    );
  }
}

/** Exact bytewise equality comparison for two `Uint8Array` views. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Validates a 64-char lowercase hex SHA-256 content identifier. */
export function validateBlockCid(cid: string): string {
  if (typeof cid !== 'string' || !HEX_64.test(cid)) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid CAS block CID: expected 64 lowercase hex chars.');
  }
  return cid;
}

/** Verifies 64-hex `cid` format AND cryptographic integrity `SHA-256(bytes) === cid`. */
export async function verifyBlockCid(cid: string, bytes: Uint8Array): Promise<string> {
  validateBlockCid(cid);
  if (!(bytes instanceof Uint8Array)) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'CAS block payload must be a Uint8Array.');
  }
  const actual = await computeCid(bytes);
  if (actual !== cid) {
    throw new VfsError('VFS_INVALID_ENVELOPE', `CAS block CID mismatch: expected ${cid}, got ${actual}.`);
  }
  return cid;
}

/** Exact UTF-8 byte-order comparison matching WormDB's bytewise key sort. */
export function compareUtf8Lex(a: string, b: string): number {
  if (a === b) return 0;
  const ab = utf8Bytes(a);
  const bb = utf8Bytes(b);
  const len = Math.min(ab.byteLength, bb.byteLength);
  for (let i = 0; i < len; i++) {
    if (ab[i] !== bb[i]) return ab[i] - bb[i];
  }
  return ab.byteLength - bb.byteLength;
}

/** Canonical Tier 1 Hot KV byte accounting for a key/value pair (`utf8(key) + value.byteLength`). */
export function kvEntryBytes(key: string, value: Uint8Array): number {
  return utf8Bytes(key).byteLength + value.byteLength;
}

/** Computes the per-member CAS byte ceiling from resolved room quotas. */
export function perMemberCasLimitBytes(quotas: ResolvedVfsStoreQuotas): number {
  return Math.floor(quotas.coldCasMaxBytes * quotas.perMemberCasFraction);
}

/** Returns an isolated defensive copy of `bytes` backed by a fresh `ArrayBuffer`. */
export function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  out.set(bytes);
  return out;
}

// ---------------------------------------------------------------------------
// VfsRoomFence — Room-Scoped Fail-Closed Error Latch
// ---------------------------------------------------------------------------

/**
 * Room-scoped fail-closed error latch. Once an underlying WAL, IndexedDB, or filesystem I/O
 * error trips the fence, every subsequent read/write on that room store fails with
 * `VFS_STORAGE_FENCED` until the handle is closed and reopened/recovered.
 */
export class VfsRoomFence {
  private tripped = false;
  private trippedReason?: string;

  constructor(readonly roomId: string) {
    validateVfsRoomId(roomId);
  }

  get fenced(): boolean {
    return this.tripped;
  }

  get reason(): string | undefined {
    return this.trippedReason;
  }

  trip(reason: string): void {
    if (!this.tripped) {
      this.tripped = true;
      this.trippedReason = reason || 'Storage I/O error';
    }
  }

  assertOpen(): void {
    if (this.tripped) {
      throw new VfsError(
        'VFS_STORAGE_FENCED',
        `VFS storage for room ${this.roomId} is fenced: ${this.trippedReason ?? 'storage error'}`,
        { details: { roomId: this.roomId, reason: this.trippedReason } },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Crash-Safe Write-Before-Publish Ordering Helper
// ---------------------------------------------------------------------------

export type WriteBeforePublishBlock = {
  cid: string;
  bytes: Uint8Array;
  authorMemberId?: string;
};

export type WriteBeforePublishKv = {
  key: string;
  value: Uint8Array;
  ifAbsent?: boolean;
};

export type WriteBeforePublishInput = {
  blocks?: readonly WriteBeforePublishBlock[];
  kvEntries?: readonly WriteBeforePublishKv[];
  publishKey: string;
  publishValue: Uint8Array;
};

export type WriteBeforePublishResult = {
  blocksInserted: number;
  kvWritten: number;
};

/**
 * Crash-safe multi-object write helper (compensating for single-key WAL stores without multi-key
 * transactions):
 * 1. Validates all keys and CIDs up front.
 * 2. Writes Tier 2 cold CAS `blocks` first.
 * 3. Writes non-head `kvEntries` next.
 * 4. Writes `publishKey -> publishValue` strictly LAST.
 *
 * Any failure in steps 1–3 aborts before `publishKey` is touched, leaving only harmless
 * unreferenced orphans swept by GC after the grace window.
 */
export async function writeBeforePublish(
  roomStore: VfsRoomStore,
  input: WriteBeforePublishInput,
): Promise<WriteBeforePublishResult> {
  validateVfsKvKey(roomStore.roomId, input.publishKey);
  if (!(input.publishValue instanceof Uint8Array)) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'publishValue must be a Uint8Array.');
  }
  for (const blk of input.blocks ?? []) {
    validateBlockCid(blk.cid);
    assertBlockSizeWithinCap(blk.bytes);
  }
  for (const entry of input.kvEntries ?? []) {
    validateVfsKvKey(roomStore.roomId, entry.key);
    if (!(entry.value instanceof Uint8Array)) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'KV entry value must be a Uint8Array.');
    }
  }

  let blocksInserted = 0;
  for (const blk of input.blocks ?? []) {
    const inserted = await roomStore.putBlock(
      blk.cid,
      blk.bytes,
      blk.authorMemberId !== undefined ? { authorMemberId: blk.authorMemberId } : undefined,
    );
    if (inserted) blocksInserted++;
  }

  let kvWritten = 0;
  for (const entry of input.kvEntries ?? []) {
    if (entry.ifAbsent) {
      if (await roomStore.kvPutIfAbsent(entry.key, entry.value)) kvWritten++;
    } else {
      await roomStore.kvPut(entry.key, entry.value);
      kvWritten++;
    }
  }

  await roomStore.kvPut(input.publishKey, input.publishValue);
  return { blocksInserted, kvWritten };
}

// ---------------------------------------------------------------------------
// MemoryVfsStore — In-Memory VfsStore (Stateless Agents, Private Fallback, Tests)
// ---------------------------------------------------------------------------

type StoredBlock = {
  bytes: Uint8Array<ArrayBuffer>;
  authorMemberId?: string;
};

type MemoryRoomState = {
  kv: Map<string, Uint8Array<ArrayBuffer>>;
  hotKvBytes: number;
  blocks: Map<string, StoredBlock>;
  coldCasBytes: number;
  memberCasBytes: Map<string, number>;
};

function createEmptyRoomState(): MemoryRoomState {
  return {
    kv: new Map(),
    hotKvBytes: 0,
    blocks: new Map(),
    coldCasBytes: 0,
    memberCasBytes: new Map(),
  };
}

export class MemoryVfsRoomStore implements VfsRoomStore {
  readonly kind: VfsStoreKind = 'memory';
  readonly quotas: ResolvedVfsStoreQuotas;
  readonly fence: VfsRoomFence;
  private closed = false;

  constructor(
    readonly roomId: string,
    private readonly state: MemoryRoomState,
    quotas: ResolvedVfsStoreQuotas,
    private readonly onClose: (handle: MemoryVfsRoomStore) => void,
  ) {
    this.quotas = quotas;
    this.fence = new VfsRoomFence(roomId);
  }

  get isFenced(): boolean {
    return this.fence.fenced;
  }

  private assertUsable(): void {
    if (this.closed) {
      throw new VfsError('VFS_STORAGE_CLOSED', `VFS room store for ${this.roomId} is closed.`);
    }
    this.fence.assertOpen();
  }

  /** Internal helper for `destroyRoom` / `store.close()`. */
  forceClose(): void {
    this.closed = true;
  }

  async kvGet(key: string): Promise<Uint8Array | undefined> {
    this.assertUsable();
    validateVfsKvKey(this.roomId, key);
    const val = this.state.kv.get(key);
    return val ? copyBytes(val) : undefined;
  }

  async kvPut(key: string, value: Uint8Array): Promise<void> {
    this.assertUsable();
    validateVfsKvKey(this.roomId, key);
    if (!(value instanceof Uint8Array)) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'KV value must be a Uint8Array.');
    }
    const existing = this.state.kv.get(key);
    const nextSize = kvEntryBytes(key, value);
    const prevSize = existing ? kvEntryBytes(key, existing) : 0;
    const delta = nextSize - prevSize;
    if (delta > 0 && this.state.hotKvBytes + delta > this.quotas.hotKvMaxBytes) {
      throw new VfsError(
        'VFS_STORAGE_QUOTA',
        `Hot KV quota exceeded for room ${this.roomId} (${this.state.hotKvBytes + delta} > ${this.quotas.hotKvMaxBytes}).`,
        { details: { hotKvBytes: this.state.hotKvBytes, delta, hotKvMaxBytes: this.quotas.hotKvMaxBytes } },
      );
    }
    this.state.kv.set(key, copyBytes(value));
    this.state.hotKvBytes += delta;
  }

  async kvPutIfAbsent(key: string, value: Uint8Array): Promise<boolean> {
    this.assertUsable();
    validateVfsKvKey(this.roomId, key);
    if (!(value instanceof Uint8Array)) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'KV value must be a Uint8Array.');
    }
    if (this.state.kv.has(key)) return false;
    const size = kvEntryBytes(key, value);
    if (this.state.hotKvBytes + size > this.quotas.hotKvMaxBytes) {
      throw new VfsError(
        'VFS_STORAGE_QUOTA',
        `Hot KV quota exceeded for room ${this.roomId} (${this.state.hotKvBytes + size} > ${this.quotas.hotKvMaxBytes}).`,
        { details: { hotKvBytes: this.state.hotKvBytes, delta: size, hotKvMaxBytes: this.quotas.hotKvMaxBytes } },
      );
    }
    this.state.kv.set(key, copyBytes(value));
    this.state.hotKvBytes += size;
    return true;
  }

  async kvDelete(key: string): Promise<boolean> {
    this.assertUsable();
    validateVfsKvKey(this.roomId, key);
    const existing = this.state.kv.get(key);
    if (!existing) return false;
    this.state.kv.delete(key);
    this.state.hotKvBytes = Math.max(0, this.state.hotKvBytes - kvEntryBytes(key, existing));
    return true;
  }

  async kvScanPrefix(prefix: string, opts?: VfsScanPrefixOptions): Promise<VfsKvEntry[]> {
    this.assertUsable();
    validateVfsKvPrefix(this.roomId, prefix);
    const { afterKey, beforeKey, limit, direction } = validateScanPrefixOptions(opts);
    if (afterKey !== undefined && beforeKey !== undefined && compareUtf8Lex(afterKey, beforeKey) >= 0) {
      return [];
    }

    const matchedKeys: string[] = [];
    for (const k of this.state.kv.keys()) {
      if (!k.startsWith(prefix)) continue;
      if (afterKey !== undefined && compareUtf8Lex(k, afterKey) <= 0) continue;
      if (beforeKey !== undefined && compareUtf8Lex(k, beforeKey) >= 0) continue;
      matchedKeys.push(k);
    }
    matchedKeys.sort(compareUtf8Lex);
    const slice = limit !== undefined && limit > 0
      ? (direction === 'last' ? matchedKeys.slice(-limit) : matchedKeys.slice(0, limit))
      : matchedKeys;
    return slice.map(k => ({ key: k, value: copyBytes(this.state.kv.get(k)!) }));
  }

  async putBlock(cid: string, bytes: Uint8Array, opts?: VfsPutBlockOptions): Promise<boolean> {
    this.assertUsable();
    assertBlockSizeWithinCap(bytes);
    await verifyBlockCid(cid, bytes);
    const existing = this.state.blocks.get(cid);
    if (existing && bytesEqual(existing.bytes, bytes)) return false;

    const size = bytes.byteLength;
    const prevSize = existing ? existing.bytes.byteLength : 0;
    const prevAuthor = existing?.authorMemberId;
    const nextTotal = Math.max(0, this.state.coldCasBytes - prevSize) + size;
    if (nextTotal > this.quotas.coldCasMaxBytes) {
      throw new VfsError(
        'VFS_STORAGE_QUOTA',
        `Cold CAS quota exceeded for room ${this.roomId} (${nextTotal} > ${this.quotas.coldCasMaxBytes}).`,
        { details: { coldCasBytes: this.state.coldCasBytes, size, coldCasMaxBytes: this.quotas.coldCasMaxBytes } },
      );
    }

    const author = opts?.authorMemberId;
    if (author !== undefined) {
      const memberCap = perMemberCasLimitBytes(this.quotas);
      const memberUsed = this.state.memberCasBytes.get(author) ?? 0;
      const adjustedMemberUsed = prevAuthor === author ? Math.max(0, memberUsed - prevSize) : memberUsed;
      if (adjustedMemberUsed + size > memberCap) {
        throw new VfsError(
          'VFS_STORAGE_QUOTA',
          `Per-member CAS fairness quota exceeded for ${author} (${adjustedMemberUsed + size} > ${memberCap}).`,
          { details: { authorMemberId: author, memberUsed: adjustedMemberUsed, size, memberCap } },
        );
      }
    }

    if (prevAuthor !== undefined) {
      const prevUsed = this.state.memberCasBytes.get(prevAuthor) ?? 0;
      const reduced = Math.max(0, prevUsed - prevSize);
      if (reduced === 0) this.state.memberCasBytes.delete(prevAuthor);
      else this.state.memberCasBytes.set(prevAuthor, reduced);
    }
    if (author !== undefined) {
      this.state.memberCasBytes.set(author, (this.state.memberCasBytes.get(author) ?? 0) + size);
    }

    this.state.blocks.set(cid, {
      bytes: copyBytes(bytes),
      ...(author !== undefined ? { authorMemberId: author } : {}),
    });
    this.state.coldCasBytes = nextTotal;
    return true;
  }

  async getBlock(cid: string): Promise<Uint8Array | undefined> {
    this.assertUsable();
    validateBlockCid(cid);
    const entry = this.state.blocks.get(cid);
    if (!entry) return undefined;
    const out = copyBytes(entry.bytes);
    await verifyBlockCid(cid, out);
    return out;
  }

  async hasBlock(cid: string): Promise<boolean> {
    this.assertUsable();
    validateBlockCid(cid);
    return this.state.blocks.has(cid);
  }

  async deleteBlock(cid: string): Promise<boolean> {
    this.assertUsable();
    validateBlockCid(cid);
    const entry = this.state.blocks.get(cid);
    if (!entry) return false;
    this.state.blocks.delete(cid);
    const size = entry.bytes.byteLength;
    this.state.coldCasBytes = Math.max(0, this.state.coldCasBytes - size);
    if (entry.authorMemberId !== undefined) {
      const prev = this.state.memberCasBytes.get(entry.authorMemberId) ?? 0;
      const next = Math.max(0, prev - size);
      if (next === 0) this.state.memberCasBytes.delete(entry.authorMemberId);
      else this.state.memberCasBytes.set(entry.authorMemberId, next);
    }
    return true;
  }

  async checkpoint(): Promise<void> {
    this.assertUsable();
  }

  async stats(): Promise<VfsRoomStats> {
    if (this.closed) {
      throw new VfsError('VFS_STORAGE_CLOSED', `VFS room store for ${this.roomId} is closed.`);
    }
    return {
      hotKvBytes: this.state.hotKvBytes,
      hotKvKeys: this.state.kv.size,
      coldCasBytes: this.state.coldCasBytes,
      coldCasBlocks: this.state.blocks.size,
      fenced: this.fence.fenced,
      ...(this.fence.reason !== undefined ? { fencedReason: this.fence.reason } : {}),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onClose(this);
  }
}

export class MemoryVfsStore implements VfsStore {
  readonly kind: VfsStoreKind = 'memory';
  private closed = false;
  private rooms = new Map<string, MemoryRoomState>();
  private openHandles = new Set<MemoryVfsRoomStore>();

  async openRoom(roomId: string, quotas?: Partial<VfsStoreQuotas>): Promise<MemoryVfsRoomStore> {
    if (this.closed) {
      throw new VfsError('VFS_STORAGE_CLOSED', 'MemoryVfsStore is closed.');
    }
    validateVfsRoomId(roomId);
    const resolved = resolveVfsStoreQuotas(this.kind, quotas);
    let state = this.rooms.get(roomId);
    if (!state) {
      state = createEmptyRoomState();
      this.rooms.set(roomId, state);
    }
    const handle = new MemoryVfsRoomStore(roomId, state, resolved, h => this.openHandles.delete(h));
    this.openHandles.add(handle);
    return handle;
  }

  async destroyRoom(roomId: string): Promise<void> {
    if (this.closed) {
      throw new VfsError('VFS_STORAGE_CLOSED', 'MemoryVfsStore is closed.');
    }
    validateVfsRoomId(roomId);
    for (const handle of [...this.openHandles]) {
      if (handle.roomId === roomId) {
        handle.forceClose();
        this.openHandles.delete(handle);
      }
    }
    this.rooms.delete(roomId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const handle of this.openHandles) handle.forceClose();
    this.openHandles.clear();
    this.rooms.clear();
  }
}
