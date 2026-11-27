/**
 * Canonical Room VFS constants, object kinds, error codes, and opaque KV key builders
 * (`docs/flows/room-vfs.md`).
 *
 * Pure TypeScript with zero runtime dependencies (identical in Browser and Bun).
 * Filenames and paths NEVER appear in WormDB/IndexedDB KV keys; every key uses fixed-width
 * big-endian lowercase hex integers and opaque UUID/SHA-256 identifiers so lexicographic
 * scans match numeric order while leaking zero plaintext metadata on disk.
 */

export const VFS_PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Binary VfsEnvelopeV1 layout constants (56-byte overhead)
// ---------------------------------------------------------------------------

/** 4-byte ASCII magic `"MVFS"` (`0x4d 0x56 0x46 0x53`). */
export const VFS_ENVELOPE_MAGIC = new Uint8Array([0x4d, 0x56, 0x46, 0x53]);
export const VFS_ENVELOPE_VERSION = 1 as const;
export const VFS_ENVELOPE_HEADER_BYTES = 40;
export const VFS_ENVELOPE_SALT_BYTES = 16;
export const VFS_ENVELOPE_IV_BYTES = 12;
export const VFS_ENVELOPE_TAG_BYTES = 16;
export const VFS_ENVELOPE_OVERHEAD_BYTES = VFS_ENVELOPE_HEADER_BYTES + VFS_ENVELOPE_TAG_BYTES;
export const VFS_KEY_BYTES = 32;

/** Header flag bit 0: `deflate-raw` compression (allowed ONLY on `VfsObjKind.Snap` = `0x02`). */
export const VFS_FLAG_DEFLATE_RAW = 0x01;
export const VFS_MAX_SNAP_DEFLATE_RATIO = 10;
export const VFS_MAX_SNAP_DECOMPRESSED_BYTES = 16 * 1024 * 1024;

/** Binary envelope object kinds (`header[5]`). */
export const VfsObjKind = {
  DocOp: 0x01,
  Snap: 0x02,
  Commit: 0x03,
  TreeOp: 0x04,
  Manifest: 0x05,
  Chunk: 0x06,
  DeviceLocal: 0x10,
} as const;

export type VfsObjKindValue = (typeof VfsObjKind)[keyof typeof VfsObjKind];

const VALID_OBJ_KINDS = new Set<number>(Object.values(VfsObjKind));

export function isValidVfsObjKind(value: unknown): value is VfsObjKindValue {
  return typeof value === 'number' && Number.isInteger(value) && VALID_OBJ_KINDS.has(value);
}

/** Signed op/commit object kinds using two-step keyed deterministic `(salt16, K_op, iv)` derivation. */
export function isDeterministicVfsObjKind(kind: VfsObjKindValue): boolean {
  return kind === VfsObjKind.DocOp || kind === VfsObjKind.Commit || kind === VfsObjKind.TreeOp;
}

// ---------------------------------------------------------------------------
// Domain separation strings
// ---------------------------------------------------------------------------

export const VFS_SALT_DOMAIN = 'meshrooms-vfs-salt-v1|';
export const VFS_OP_HKDF_DOMAIN = 'meshrooms-vfs-op-v1|';
export const VFS_OBJ_HKDF_DOMAIN = 'meshrooms-vfs-obj-v1|';
export const VFS_EPOCH_WRAP_DOMAIN = 'meshrooms-vfs-epoch-v1|';
export const VFS_GRANT_WRAP_DOMAIN = 'meshrooms-vfs-grant-v1|';
export const VFS_KEY_COMMIT_DOMAIN = 'vfs-rk-commit-v1|';
export const VFS_DEVICE_SEAL_SALT_DOMAIN = 'meshrooms-vfs-device-seal-salt-v1|';
export const VFS_DEVICE_SEAL_INFO_DOMAIN = 'meshrooms-vfs-device-seal-v1|';
export const VFS_SIG_DOMAIN = 'meshrooms-vfs-sig-v1';
export const VFS_EPOCH_HEADER_SIG_DOMAIN = 'meshrooms-vfs-epoch-header-v1';
export const VFS_KEY_WRAP_SIG_DOMAIN = 'meshrooms-vfs-key-wrap-v1';
export const VFS_KEY_GRANT_SIG_DOMAIN = 'meshrooms-vfs-key-grant-v1';

// ---------------------------------------------------------------------------
// Canonical limits, quotas & pacing constants
// ---------------------------------------------------------------------------

/** Virtual root directory node ID (`parentId` for top-level docs in MVP). */
export const VFS_ROOT_DIR_ID = '00000000-0000-0000-0000-000000000000';

/** Soft MVP UI/agent text document cap (256 KiB; enforced by `FugueMaxDoc`). */
export const VFS_DOC_SOFT_LIMIT_BYTES = 256 * 1024;
/** Hard protocol text CRDT document ceiling (1 MiB; enforced by `FugueMaxDoc`). */
export const VFS_DOC_HARD_LIMIT_BYTES = 1024 * 1024;

/** Pre-parse anti-DoS bounds on signed op payloads (enforced by `envelope.ts` & `FugueMaxDoc`). */
export const VFS_OP_MAX_PLAINTEXT_BYTES = 12 * 1024;
export const VFS_OP_MAX_SUBOPS = 64;
export const VFS_OP_MAX_PARENTS = 16;

/** CRDT doc op-log compaction ceiling, frontier map, causal jump & pending buffer bounds (enforced by `FugueMaxDoc`). */
export const VFS_COMPACT_OPS_PER_DOC = 20_000;
export const VFS_OP_COMPACTION_CEILING = VFS_COMPACT_OPS_PER_DOC;
export const VFS_MAX_FRONTIER_MAP = 256;
export const VFS_MAX_SEQ = 10_000_000;
export const VFS_MAX_SEQ_JUMP = 50_000;
export const VFS_MAX_COUNTER_JUMP = 100_000;
export const VFS_MAX_LAMPORT_JUMP = 10_000;
export const VFS_MAX_DEL_RUN_LEN = 65_536;
export const VFS_MAX_PENDING_OPS_PER_MEMBER = 64;
export const VFS_MAX_PENDING_OPS_GLOBAL = 512;
export const VFS_PENDING_OP_TTL_MS = 5 * 60_000;

/** Key-epoch recipient chunking cap (enforced by `VfsKeyring`). */
export const VFS_KEY_WRAP_MAX_RECIPIENTS_PER_CHUNK = 64;

// ---------------------------------------------------------------------------
// Cross-layer protocol quotas & pacing (enforced by VFS store, tree, sync & Phase 2 CAS layers)
// ---------------------------------------------------------------------------

/** Phase 2 binary CAS file cap (10 MiB, matching `MAX_ATTACHMENT_BYTES`; enforced by VFS CAS store). */
export const VFS_BINARY_MAX_BYTES = 10 * 1024 * 1024;
/** Maximum plaintext size stored inline in Tier 1 Hot KV (`obj:<cid64>`; enforced by VFS store). */
export const VFS_INLINE_BLOCK_MAX_BYTES = 16 * 1024;
/** Fixed plaintext chunk size for Tier 2 Cold Encrypted CAS binary files (64 KiB; enforced by VFS CAS store). */
export const VFS_CAS_CHUNK_BYTES = 64 * 1024;
/** Raw wire slice size (`12,000 B` = `16,000` base64 chars; enforced by VFS replication). */
export const VFS_WIRE_SLICE_BYTES = 12_000;
/** Max JSON characters per `vfs-ops` wire chunk (enforced by VFS replication). */
export const VFS_WIRE_CHUNK_CHARS = 14_000;

/** Live document & directory node caps (enforced by VFS directory tree CRDT). */
export const VFS_MAX_DOCS_MVP = 256;
export const VFS_MAX_DOCS_PER_MEMBER = 64;
export const VFS_MAX_NODES_FULL = 1024;

/** Per-room Tier 1 Hot KV and Tier 2 Cold CAS storage budgets (enforced by VFS store & GC). */
export const VFS_HOT_KV_MAX_BYTES_BROWSER = 32 * 1024 * 1024;
export const VFS_HOT_KV_MAX_BYTES_NATIVE = 64 * 1024 * 1024;
export const VFS_COLD_CAS_MAX_BYTES_BROWSER = 256 * 1024 * 1024;
export const VFS_COLD_CAS_MAX_BYTES_NATIVE = 1024 * 1024 * 1024;

/** Snapshot cadence, history retention, GC grace & idempotency receipts (enforced by VFS store). */
export const VFS_SNAP_EVERY_OPS = 250;
export const VFS_SNAP_EVERY_BYTES = 256 * 1024;
export const VFS_HISTORY_RETAIN_COMMITS = 200;
export const VFS_HISTORY_RETAIN_DAYS = 30;
export const VFS_GC_GRACE_MS = 10 * 60_000;
export const VFS_MAX_RECEIPTS_PER_ACTOR = 256;

/** Replication batching & relay pacing limits (enforced by VFS sync engine). */
export const VFS_MAX_OPS_PER_RESPONSE = 64;
export const VFS_RELAY_MAX_FRAMES_PER_MIN = 48;
export const VFS_RELAY_MAX_OPS_FRAMES_PER_MIN = 30;
export const VFS_RELAY_MAX_BLOCK_FRAMES_PER_MIN = 18;
export const VFS_RELAY_MAX_BYTES_PER_MIN = 900 * 1024;
export const VFS_COALESCE_WEBRTC_MS = 300;
export const VFS_COALESCE_RELAY_MS = 1_000;

/** Path validation ceilings (shared with `path.ts`). */
export const VFS_PATH_MAX_UTF8_BYTES = 240;
export const VFS_PATH_MAX_SEGMENTS = 8;
export const VFS_PATH_MAX_SEGMENT_CHARS = 80;

/** Canonical KV key prefix & hard adapter key ceiling (below WormDB WAL `u16` = 65,535 B). */
export const VFS_KEY_PREFIX = 'vfs:v1:';
export const VFS_MAX_KV_KEY_BYTES = 512;

// ---------------------------------------------------------------------------
// Error Codes & VfsError
// ---------------------------------------------------------------------------

export type VfsErrorCode =
  | 'VFS_INVALID_PATH'
  | 'VFS_INVALID_CONTENT'
  | 'VFS_INVALID_ENVELOPE'
  | 'VFS_INVALID_SIGNATURE'
  | 'VFS_DECRYPT_FAILED'
  | 'VFS_MALLEABLE_ENVELOPE'
  | 'VFS_KEY_COMMIT_MISMATCH'
  | 'VFS_EPOCH_UNINITIALIZED'
  | 'VFS_EPOCH_UNAUTHORIZED'
  | 'VFS_EPOCH_ROLLBACK'
  | 'VFS_EPOCH_UNKNOWN'
  | 'VFS_NOT_FOUND'
  | 'VFS_ALREADY_EXISTS'
  | 'VFS_BASE_REV_REQUIRED'
  | 'VFS_ANCHOR_NOT_FOUND'
  | 'VFS_ANCHOR_AMBIGUOUS'
  | 'VFS_OVERLAPPING_HUNKS'
  | 'VFS_CONFLICT'
  | 'VFS_LIMIT_EXCEEDED'
  | 'VFS_NO_ONLINE_PEER'
  | 'VFS_STORAGE_FAILED'
  | 'VFS_STORAGE_FENCED'
  | 'VFS_STORAGE_QUOTA'
  | 'VFS_STORAGE_CLOSED'
  | 'VFS_INVALID_KEY';

export class VfsError extends Error {
  override readonly name = 'VfsError';
  readonly code: VfsErrorCode;
  readonly status?: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: VfsErrorCode,
    message: string,
    options?: { status?: number; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.code = code;
    this.status = options?.status;
    this.details = options?.details;
  }
}

// ---------------------------------------------------------------------------
// Opaque KV key builders (`docs/flows/room-vfs.md` §3.2)
// ---------------------------------------------------------------------------

const LOWER_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const HEX_ANY = /^[a-f0-9]+$/;
const MAX_U32 = 0xffff_ffff;
const MAX_U48 = 0xffff_ffff_ffff;

/** Validates a canonical commit identifier (lowercase UUID or 64-char lowercase SHA-256 hex). */
export function isValidVfsCommitId(value: unknown): value is string {
  return typeof value === 'string' && (LOWER_UUID.test(value) || HEX_64.test(value));
}

function assertLowerUuid(value: string, label: string): string {
  if (typeof value !== 'string' || !LOWER_UUID.test(value)) {
    throw new VfsError('VFS_INVALID_KEY', `Invalid ${label}: expected lowercase UUID.`);
  }
  return value;
}

function assertHex64(value: string, label: string): string {
  if (typeof value !== 'string' || !HEX_64.test(value)) {
    throw new VfsError('VFS_INVALID_KEY', `Invalid ${label}: expected 64 lowercase hex chars.`);
  }
  return value;
}

function assertHexPrefix(value: string, minLen: number, takeLen: number, label: string): string {
  if (typeof value !== 'string') {
    throw new VfsError('VFS_INVALID_KEY', `Invalid ${label}: expected hex string.`);
  }
  const normalized = value.replace(/-/g, '').toLowerCase();
  if (normalized.length < minLen || !HEX_ANY.test(normalized)) {
    throw new VfsError('VFS_INVALID_KEY', `Invalid ${label}: expected at least ${minLen} hex chars.`);
  }
  return normalized.slice(0, takeLen);
}

function hexU32(value: number, label: string): string {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_U32) {
    throw new VfsError('VFS_INVALID_KEY', `Invalid ${label}: expected uint32.`);
  }
  return value.toString(16).padStart(8, '0');
}

function hexU48(value: number, label: string): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_U48) {
    throw new VfsError('VFS_INVALID_KEY', `Invalid ${label}: expected uint48.`);
  }
  return value.toString(16).padStart(12, '0');
}

function checkedKey(key: string): string {
  if (key.length > VFS_MAX_KV_KEY_BYTES || key.includes('\0')) {
    throw new VfsError('VFS_INVALID_KEY', `VFS KV key exceeds ${VFS_MAX_KV_KEY_BYTES} bytes or contains NUL.`);
  }
  return key;
}

/** Room keyspace prefix: `vfs:v1:<roomId>:` */
export function vfsRoomPrefix(roomId: string): string {
  return checkedKey(`${VFS_KEY_PREFIX}${assertLowerUuid(roomId, 'roomId')}:`);
}

/** `${P}meta` — single-key atomic room VFS publish root. */
export function vfsMetaKey(roomId: string): string {
  return checkedKey(`${vfsRoomPrefix(roomId)}meta`);
}

/** `${P}epoch:<epoch8>` — device-sealed room key-epoch entry (`epoch >= 1`). */
export function vfsEpochKey(roomId: string, epoch: number): string {
  if (!Number.isInteger(epoch) || epoch < 1 || epoch > MAX_U32) {
    throw new VfsError('VFS_INVALID_KEY', 'Invalid epoch: expected positive uint32.');
  }
  return checkedKey(`${vfsRoomPrefix(roomId)}epoch:${hexU32(epoch, 'epoch')}`);
}

/** `${P}node:<nodeId>:head` — O(1) node tip, snapshot pointer, and `--base-rev` frontier map. */
export function vfsNodeHeadKey(roomId: string, nodeId: string): string {
  return checkedKey(`${vfsRoomPrefix(roomId)}node:${assertLowerUuid(nodeId, 'nodeId')}:head`);
}

/** Prefix for scanning a node's ops (optionally scoped to one `deviceId`). */
export function vfsOpPrefix(roomId: string, nodeId: string, deviceId?: string): string {
  const base = `${vfsRoomPrefix(roomId)}op:${assertLowerUuid(nodeId, 'nodeId')}:`;
  return checkedKey(deviceId !== undefined ? `${base}${assertHex64(deviceId, 'deviceId')}:` : base);
}

/** `${P}op:<nodeId>:<deviceId>:<seq12>:<opHash8>` — equivocation-preserving op-log key. */
export function vfsOpKey(
  roomId: string,
  nodeId: string,
  deviceId: string,
  seq: number,
  opHash: string,
): string {
  if (!Number.isSafeInteger(seq) || seq < 1 || seq > VFS_MAX_SEQ) {
    throw new VfsError('VFS_INVALID_KEY', `Invalid seq: expected 1..${VFS_MAX_SEQ}.`);
  }
  const h8 = assertHexPrefix(opHash, 8, 8, 'opHash');
  return checkedKey(`${vfsOpPrefix(roomId, nodeId, deviceId)}${hexU48(seq, 'seq')}:${h8}`);
}

/** Prefix for scanning cached local snapshots of a node. */
export function vfsSnapPrefix(roomId: string, nodeId: string): string {
  return checkedKey(`${vfsRoomPrefix(roomId)}snap:${assertLowerUuid(nodeId, 'nodeId')}:`);
}

/** `${P}snap:<nodeId>:<ts12>:<cid16>` — newest snapshot via `scanPrefix(..., 1)` (`ScanCut.last`). */
export function vfsSnapKey(roomId: string, nodeId: string, tsMs: number, cid: string): string {
  const c16 = assertHexPrefix(cid, 16, 16, 'cid');
  return checkedKey(`${vfsSnapPrefix(roomId, nodeId)}${hexU48(tsMs, 'tsMs')}:${c16}`);
}

/** `${P}obj:<cid64>` — content-addressed immutable CAS object in Tier 1 Hot KV. */
export function vfsObjKey(roomId: string, cid: string): string {
  return checkedKey(`${vfsRoomPrefix(roomId)}obj:${assertHex64(cid, 'cid')}`);
}

/** `${P}bmeta:<cid64>` — lightweight block metadata for GC and per-member fairness accounting. */
export function vfsBmetaKey(roomId: string, cid: string): string {
  return checkedKey(`${vfsRoomPrefix(roomId)}bmeta:${assertHex64(cid, 'cid')}`);
}

/** Prefix for scanning commit time index entries. */
export function vfsCommitPrefix(roomId: string): string {
  return checkedKey(`${vfsRoomPrefix(roomId)}commit:`);
}

/** `${P}commit:<ts12>:<commitId16>` — reverse-chronological commit index key. */
export function vfsCommitKey(roomId: string, tsMs: number, commitId: string): string {
  const id16 = assertHexPrefix(commitId, 16, 16, 'commitId');
  return checkedKey(`${vfsCommitPrefix(roomId)}${hexU48(tsMs, 'tsMs')}:${id16}`);
}

/** `${P}sync:<peerDeviceId>` — anti-entropy sync resumption cursor per peer. */
export function vfsSyncKey(roomId: string, peerDeviceId: string): string {
  return checkedKey(`${vfsRoomPrefix(roomId)}sync:${assertHex64(peerDeviceId, 'peerDeviceId')}`);
}

/** `${P}req:<actorId>:<requestId>` — `--request-id` idempotency receipt key. */
export function vfsReqKey(roomId: string, actorId: string, requestId: string): string {
  return checkedKey(
    `${vfsRoomPrefix(roomId)}req:${assertLowerUuid(actorId, 'actorId')}:${assertLowerUuid(requestId, 'requestId')}`,
  );
}
