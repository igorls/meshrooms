/**
 * Room VFS P2P Wire Protocol Types, Runtime Validators, Chunking, Frontier Hashing,
 * and Relay Safety Guards (`docs/flows/room-vfs.md` §6).
 *
 * Pure TypeScript + WebCrypto with zero runtime dependencies (identical in Browser and Bun).
 */

import { base64ToBytes, type RelayLane } from '../relay-crypto';
import {
  VFS_BINARY_MAX_BYTES,
  VFS_ENVELOPE_OVERHEAD_BYTES,
  VFS_MAX_FRONTIER_MAP,
  VFS_MAX_OPS_PER_RESPONSE,
  VFS_MAX_SEQ,
  VFS_PROTOCOL_VERSION,
  VFS_WIRE_CHUNK_CHARS,
  VFS_WIRE_SLICE_BYTES,
  VfsError,
  VfsObjKind,
  isDeterministicVfsObjKind,
} from './constants';
import { parseVfsEnvelopeHeader, sha256Hex, utf8Bytes } from './envelope';
import {
  isValidKeyEpochHeaderShape,
  isValidKeyGrantPacketShape,
  isValidKeyWrapChunkShape,
  type VfsKeyEpochHeader,
  type VfsKeyGrantPacket as KeyringVfsKeyGrantPacket,
  type VfsKeyWrapChunk,
} from './keyring';

// ---------------------------------------------------------------------------
// Wire Bounds & Constants
// ---------------------------------------------------------------------------

/** Hard UTF-8 JSON byte cap per `vfs-ops` / `vfs-have` packet (`<= 14 KB`, safe under WebRTC 20 KB & Relay 21 KiB). */
export const VFS_OPS_MAX_BYTES = VFS_WIRE_CHUNK_CHARS;
/** Hard record count cap per `vfs-ops` page (`<= 64`). */
export const VFS_OPS_MAX_RECORDS = VFS_MAX_OPS_PER_RESPONSE;
/** Hard max entries in `VfsHavePacket.heads`. */
export const VFS_HAVE_MAX_HEADS = VFS_MAX_FRONTIER_MAP;
/** Hard max equivocation digests in `VfsHavePacket.conflictIds`. */
export const VFS_HAVE_MAX_CONFLICT_IDS = 128;
/** Hard max CIDs advertised/requested in `VfsBlockWantPacket` / `VfsBlockHavePacket`. */
export const VFS_BLOCK_MAX_CIDS = 128;
/** Hard max base64 length for a single `VfsRecordPacket.env` (`<= 18,000` chars ≈ `13,500` B raw envelope). */
export const VFS_RECORD_MAX_ENV_B64_CHARS = 18_000;
/** Hard max raw byte length for a single `VfsBlockChunkPacket` slice (`12,000 B`). */
export const VFS_BLOCK_CHUNK_MAX_BYTES = VFS_WIRE_SLICE_BYTES;
/** Hard max total encrypted block size accepted in `VfsBlockChunkPacket` (`10 MiB + 56 B`). */
export const VFS_BLOCK_MAX_TOTAL_BYTES = VFS_BINARY_MAX_BYTES + VFS_ENVELOPE_OVERHEAD_BYTES;
/** Hard max serialized UTF-8 byte size for key-distribution wire packets. */
export const VFS_KEY_PACKET_MAX_BYTES = 18_000;
/** Hard max length for opaque pagination cursors. */
export const VFS_CURSOR_MAX_CHARS = 256;
/** Hard max `retryAfterMs` hint accepted on `vfs-ops` (10 minutes). */
export const VFS_MAX_RETRY_AFTER_MS = 600_000;
/** Domain separator for O(1) frontier SHA-256 digests. */
export const VFS_FRONTIER_HASH_DOMAIN = 'meshrooms-vfs-frontier-v1|';

const LOWER_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const HEX_16 = /^[a-f0-9]{16}$/;
const HEAD_KEY_RE = /^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:[a-f0-9]{64})$/;
const STRICT_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_U32 = 0xffff_ffff;

// ---------------------------------------------------------------------------
// Wire Frame Types
// ---------------------------------------------------------------------------

export type VfsRecordObjKind =
  | typeof VfsObjKind.DocOp
  | typeof VfsObjKind.Commit
  | typeof VfsObjKind.TreeOp;

/** Outer replicated record carrying a deterministic binary `VfsEnvelopeV1` (base64 on JSON channels). */
export type VfsRecordPacket = {
  kind: 'vfs-record';
  v: typeof VFS_PROTOCOL_VERSION;
  roomId: string;
  epoch: number;
  objKind: VfsRecordObjKind;
  nodeId: string;
  deviceId: string;
  seq: number;
  opId: string;
  cid: string;
  /** Standard base64 encoding of canonical binary `VfsEnvelopeV1` bytes. */
  env: string;
};

/** Anti-entropy state advertisement (`frontierHash` O(1) fast-path + sparse `heads` + pagination `cursor`). */
export type VfsHavePacket = {
  kind: 'vfs-have';
  v: typeof VFS_PROTOCOL_VERSION;
  roomId: string;
  deviceId: string;
  frontierHash: string;
  latestEpoch: number;
  /** Maps `deviceId` or `nodeId:deviceId` -> highest known `seq` for sparse anti-entropy. */
  heads: Record<string, number>;
  cursor?: string;
  nodeId?: string;
  conflictIds?: string[];
};

/** Bounded page of replicated VFS records (`<= 14,000 B` UTF-8 JSON, `<= 64` records/page). */
export type VfsOpsPacket = {
  kind: 'vfs-ops';
  v: typeof VFS_PROTOCOL_VERSION;
  roomId: string;
  deviceId: string;
  records: VfsRecordPacket[];
  more: boolean;
  nextCursor?: string;
  retryAfterMs?: number;
};

/** Wire wrapper for a host-signed `VfsKeyEpochHeader` (`keyring.ts`). */
export type VfsKeyEpochPacket = {
  kind: 'vfs-key-epoch';
  v: typeof VFS_PROTOCOL_VERSION;
  roomId: string;
  header: VfsKeyEpochHeader;
};

/** Wire wrapper for a host-signed `VfsKeyWrapChunk` (`keyring.ts`). */
export type VfsKeyWrapPacket = {
  kind: 'vfs-key-wrap';
  v: typeof VFS_PROTOCOL_VERSION;
  roomId: string;
  chunk: VfsKeyWrapChunk;
};

/** Wire wrapper for an admitted-human signed `VfsKeyGrantPacket` (`keyring.ts`). */
export type VfsKeyGrantPacket = {
  kind: 'vfs-key-grant';
  v: typeof VFS_PROTOCOL_VERSION;
  roomId: string;
  grant: KeyringVfsKeyGrantPacket;
};

export type { KeyringVfsKeyGrantPacket };

/** Cold CAS block pull request (bounded CIDs). */
export type VfsBlockWantPacket = {
  kind: 'vfs-block-want';
  v: typeof VFS_PROTOCOL_VERSION;
  roomId: string;
  deviceId?: string;
  cids: string[];
};

/** Cold CAS encrypted block slice (`<= 12,000 B` raw payload). */
export type VfsBlockChunkPacket = {
  kind: 'vfs-block-chunk';
  v: typeof VFS_PROTOCOL_VERSION;
  roomId: string;
  deviceId?: string;
  cid: string;
  offset: number;
  totalBytes: number;
  /** Standard base64 encoding of slice bytes (`<= 12,000 B` decoded). */
  data: string;
};

/** Cold CAS block availability advertisement (bounded CIDs). */
export type VfsBlockHavePacket = {
  kind: 'vfs-block-have';
  v: typeof VFS_PROTOCOL_VERSION;
  roomId: string;
  deviceId?: string;
  cids: string[];
};

export const VFS_PACKET_KINDS = [
  'vfs-record',
  'vfs-have',
  'vfs-ops',
  'vfs-key-epoch',
  'vfs-key-wrap',
  'vfs-key-grant',
  'vfs-block-want',
  'vfs-block-chunk',
  'vfs-block-have',
] as const;

export type VfsPacketKind = (typeof VFS_PACKET_KINDS)[number];

export type VfsPacket =
  | VfsRecordPacket
  | VfsHavePacket
  | VfsOpsPacket
  | VfsKeyEpochPacket
  | VfsKeyWrapPacket
  | VfsKeyGrantPacket
  | VfsBlockWantPacket
  | VfsBlockChunkPacket
  | VfsBlockHavePacket;

const VFS_PACKET_KIND_SET = new Set<string>(VFS_PACKET_KINDS);

// ---------------------------------------------------------------------------
// Hard Decision 1 & Loop-Safety Relay Send Guard
// ---------------------------------------------------------------------------

/** Canonical safe relay options for EVERY VFS packet (zero server-side hold, zero agent wake). */
export const VFS_RELAY_SEND_OPTS: Readonly<{ hold: false; wake: undefined }> = Object.freeze({
  hold: false,
  wake: undefined,
});

export type VfsRelaySafeOptionsLike = {
  hold?: unknown;
  wake?: unknown;
};

/**
 * Hard Decision 1 & loop-safety guard: explicitly forbids `hold: true` (zero persistent relay
 * storage) or non-empty `wake` (agents never wake on VFS mutations) on ANY VFS relay send.
 */
export function assertVfsRelaySafeOptions(opts?: VfsRelaySafeOptionsLike | null): void {
  if (opts == null) return;
  if (typeof opts !== 'object') {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid VFS relay options object.');
  }
  if (opts.hold !== undefined && opts.hold !== false) {
    throw new VfsError(
      'VFS_INVALID_ENVELOPE',
      'VFS relay packets must never set hold: true (zero server-side storage invariant).',
    );
  }
  if (opts.wake !== undefined) {
    if (!Array.isArray(opts.wake) || opts.wake.length > 0) {
      throw new VfsError(
        'VFS_INVALID_ENVELOPE',
        'VFS relay packets must never set non-empty wake targets (loop-safety invariant).',
      );
    }
  }
}

/** Returns the Meshrooms relay lane for a VFS packet (`'file'` for cold CAS blocks, `'primary'` otherwise). */
export function vfsPacketRelayLane(packet: Pick<VfsPacket, 'kind'>): RelayLane {
  return packet.kind === 'vfs-block-want'
    || packet.kind === 'vfs-block-chunk'
    || packet.kind === 'vfs-block-have'
    ? 'file'
    : 'primary';
}

// ---------------------------------------------------------------------------
// Low-level Helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isValidRoomId(value: unknown, expectedRoomId?: string): value is string {
  if (typeof value !== 'string' || !LOWER_UUID.test(value)) return false;
  if (expectedRoomId !== undefined && value !== expectedRoomId) return false;
  return true;
}

function isValidOpId(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && !value.includes('\0')
    && !value.includes(':')
  );
}

function isValidCursor(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= VFS_CURSOR_MAX_CHARS
    && !value.includes('\0')
  );
}

function decodeStrictBase64(value: string, maxChars: number): Uint8Array<ArrayBuffer> | undefined {
  if (value.length === 0) return new Uint8Array(new ArrayBuffer(0));
  if (value.length > maxChars || (value.length % 4) !== 0) return undefined;
  if (!STRICT_BASE64_RE.test(value)) return undefined;
  try {
    return base64ToBytes(value);
  } catch {
    return undefined;
  }
}

function jsonUtf8Bytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value)).byteLength;
}

// ---------------------------------------------------------------------------
// Runtime Packet Validators
// ---------------------------------------------------------------------------

export function isVfsPacketKind(kind: unknown): kind is VfsPacketKind {
  return typeof kind === 'string' && VFS_PACKET_KIND_SET.has(kind);
}

/** Decodes `packet.env` from a validated `VfsRecordPacket` into raw `VfsEnvelopeV1` bytes. */
export function decodeVfsRecordEnvelope(packet: Pick<VfsRecordPacket, 'env'>): Uint8Array<ArrayBuffer> {
  const bytes = decodeStrictBase64(packet.env, VFS_RECORD_MAX_ENV_B64_CHARS);
  if (!bytes || bytes.byteLength < VFS_ENVELOPE_OVERHEAD_BYTES) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid or truncated base64 VfsEnvelopeV1 in vfs-record.');
  }
  return bytes;
}

export function isVfsRecordPacket(value: unknown, roomId?: string): value is VfsRecordPacket {
  if (!isPlainObject(value)) return false;
  if (value.kind !== 'vfs-record' || value.v !== VFS_PROTOCOL_VERSION) return false;
  if (!isValidRoomId(value.roomId, roomId)) return false;
  if (typeof value.epoch !== 'number' || !Number.isInteger(value.epoch) || value.epoch < 1 || value.epoch > MAX_U32) {
    return false;
  }
  if (
    typeof value.objKind !== 'number'
    || !Number.isInteger(value.objKind)
    || !isDeterministicVfsObjKind(value.objKind as VfsRecordObjKind)
  ) {
    return false;
  }
  if (typeof value.nodeId !== 'string' || !LOWER_UUID.test(value.nodeId)) return false;
  if (typeof value.deviceId !== 'string' || !HEX_64.test(value.deviceId)) return false;
  if (typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq) || value.seq < 1 || value.seq > VFS_MAX_SEQ) {
    return false;
  }
  if (!isValidOpId(value.opId)) return false;
  if (typeof value.cid !== 'string' || !HEX_64.test(value.cid)) return false;
  if (typeof value.env !== 'string' || value.env.length === 0) return false;

  const envBytes = decodeStrictBase64(value.env, VFS_RECORD_MAX_ENV_B64_CHARS);
  if (!envBytes || envBytes.byteLength < VFS_ENVELOPE_OVERHEAD_BYTES) return false;

  try {
    const header = parseVfsEnvelopeHeader(envBytes);
    if (header.objKind !== value.objKind || header.epoch !== value.epoch) return false;
  } catch {
    return false;
  }

  return true;
}

export function isVfsHavePacket(value: unknown, roomId?: string): value is VfsHavePacket {
  if (!isPlainObject(value)) return false;
  if (value.kind !== 'vfs-have' || value.v !== VFS_PROTOCOL_VERSION) return false;
  if (!isValidRoomId(value.roomId, roomId)) return false;
  if (typeof value.deviceId !== 'string' || !HEX_64.test(value.deviceId)) return false;
  if (typeof value.frontierHash !== 'string' || !HEX_64.test(value.frontierHash)) return false;
  if (
    typeof value.latestEpoch !== 'number'
    || !Number.isInteger(value.latestEpoch)
    || value.latestEpoch < 0
    || value.latestEpoch > MAX_U32
  ) {
    return false;
  }
  if (!isPlainObject(value.heads)) return false;
  const headEntries = Object.entries(value.heads);
  if (headEntries.length > VFS_HAVE_MAX_HEADS) return false;
  for (const [k, seq] of headEntries) {
    if (!HEAD_KEY_RE.test(k)) return false;
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || seq > VFS_MAX_SEQ) return false;
  }
  if (value.cursor !== undefined && !isValidCursor(value.cursor)) return false;
  if (value.nodeId !== undefined && (typeof value.nodeId !== 'string' || !LOWER_UUID.test(value.nodeId))) {
    return false;
  }
  if (value.conflictIds !== undefined) {
    if (!Array.isArray(value.conflictIds) || value.conflictIds.length > VFS_HAVE_MAX_CONFLICT_IDS) return false;
    for (const digest of value.conflictIds) {
      if (typeof digest !== 'string' || !HEX_16.test(digest)) return false;
    }
  }
  if (jsonUtf8Bytes(value) > VFS_OPS_MAX_BYTES) return false;
  return true;
}

export function isVfsOpsPacket(value: unknown, roomId?: string): value is VfsOpsPacket {
  if (!isPlainObject(value)) return false;
  if (value.kind !== 'vfs-ops' || value.v !== VFS_PROTOCOL_VERSION) return false;
  if (!isValidRoomId(value.roomId, roomId)) return false;
  if (typeof value.deviceId !== 'string' || !HEX_64.test(value.deviceId)) return false;
  if (typeof value.more !== 'boolean') return false;
  if (value.nextCursor !== undefined && !isValidCursor(value.nextCursor)) return false;
  if (
    value.retryAfterMs !== undefined
    && (
      typeof value.retryAfterMs !== 'number'
      || !Number.isSafeInteger(value.retryAfterMs)
      || value.retryAfterMs < 0
      || value.retryAfterMs > VFS_MAX_RETRY_AFTER_MS
    )
  ) {
    return false;
  }
  if (!Array.isArray(value.records) || value.records.length > VFS_OPS_MAX_RECORDS) return false;
  if (jsonUtf8Bytes(value) > VFS_OPS_MAX_BYTES) return false;
  for (const rec of value.records) {
    if (!isVfsRecordPacket(rec, value.roomId)) return false;
  }
  return true;
}

export function isVfsKeyEpochPacket(value: unknown, roomId?: string): value is VfsKeyEpochPacket {
  if (!isPlainObject(value)) return false;
  if (value.kind !== 'vfs-key-epoch' || value.v !== VFS_PROTOCOL_VERSION) return false;
  if (!isValidRoomId(value.roomId, roomId)) return false;
  if (!isValidKeyEpochHeaderShape(value.header)) return false;
  if (value.header.body.roomId !== value.roomId) return false;
  if (jsonUtf8Bytes(value) > VFS_KEY_PACKET_MAX_BYTES) return false;
  return true;
}

export function isVfsKeyWrapPacket(value: unknown, roomId?: string): value is VfsKeyWrapPacket {
  if (!isPlainObject(value)) return false;
  if (value.kind !== 'vfs-key-wrap' || value.v !== VFS_PROTOCOL_VERSION) return false;
  if (!isValidRoomId(value.roomId, roomId)) return false;
  if (!isValidKeyWrapChunkShape(value.chunk)) return false;
  if (value.chunk.body.roomId !== value.roomId) return false;
  if (jsonUtf8Bytes(value) > VFS_KEY_PACKET_MAX_BYTES) return false;
  return true;
}

export function isVfsKeyGrantPacket(value: unknown, roomId?: string): value is VfsKeyGrantPacket {
  if (!isPlainObject(value)) return false;
  if (value.kind !== 'vfs-key-grant' || value.v !== VFS_PROTOCOL_VERSION) return false;
  if (!isValidRoomId(value.roomId, roomId)) return false;
  if (!isValidKeyGrantPacketShape(value.grant)) return false;
  if (value.grant.body.roomId !== value.roomId) return false;
  for (const entry of value.grant.body.entries) {
    if (entry.header.body.roomId !== value.roomId) return false;
  }
  if (jsonUtf8Bytes(value) > VFS_KEY_PACKET_MAX_BYTES) return false;
  return true;
}

function isValidCidList(value: unknown, minLen: number, maxLen: number): value is string[] {
  if (!Array.isArray(value) || value.length < minLen || value.length > maxLen) return false;
  for (const cid of value) {
    if (typeof cid !== 'string' || !HEX_64.test(cid)) return false;
  }
  return true;
}

export function isVfsBlockWantPacket(value: unknown, roomId?: string): value is VfsBlockWantPacket {
  if (!isPlainObject(value)) return false;
  if (value.kind !== 'vfs-block-want' || value.v !== VFS_PROTOCOL_VERSION) return false;
  if (!isValidRoomId(value.roomId, roomId)) return false;
  if (value.deviceId !== undefined && (typeof value.deviceId !== 'string' || !HEX_64.test(value.deviceId))) {
    return false;
  }
  if (!isValidCidList(value.cids, 1, VFS_BLOCK_MAX_CIDS)) return false;
  if (jsonUtf8Bytes(value) > VFS_OPS_MAX_BYTES) return false;
  return true;
}

export function isVfsBlockHavePacket(value: unknown, roomId?: string): value is VfsBlockHavePacket {
  if (!isPlainObject(value)) return false;
  if (value.kind !== 'vfs-block-have' || value.v !== VFS_PROTOCOL_VERSION) return false;
  if (!isValidRoomId(value.roomId, roomId)) return false;
  if (value.deviceId !== undefined && (typeof value.deviceId !== 'string' || !HEX_64.test(value.deviceId))) {
    return false;
  }
  if (!isValidCidList(value.cids, 0, VFS_BLOCK_MAX_CIDS)) return false;
  if (jsonUtf8Bytes(value) > VFS_OPS_MAX_BYTES) return false;
  return true;
}

export function isVfsBlockChunkPacket(value: unknown, roomId?: string): value is VfsBlockChunkPacket {
  if (!isPlainObject(value)) return false;
  if (value.kind !== 'vfs-block-chunk' || value.v !== VFS_PROTOCOL_VERSION) return false;
  if (!isValidRoomId(value.roomId, roomId)) return false;
  if (value.deviceId !== undefined && (typeof value.deviceId !== 'string' || !HEX_64.test(value.deviceId))) {
    return false;
  }
  if (typeof value.cid !== 'string' || !HEX_64.test(value.cid)) return false;
  if (
    typeof value.totalBytes !== 'number'
    || !Number.isSafeInteger(value.totalBytes)
    || value.totalBytes < 0
    || value.totalBytes > VFS_BLOCK_MAX_TOTAL_BYTES
  ) {
    return false;
  }
  if (typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset < 0) return false;
  if (typeof value.data !== 'string') return false;

  const maxB64Chars = Math.ceil(VFS_BLOCK_CHUNK_MAX_BYTES / 3) * 4;
  const decoded = decodeStrictBase64(value.data, maxB64Chars);
  if (!decoded || decoded.byteLength > VFS_BLOCK_CHUNK_MAX_BYTES) return false;

  if (value.totalBytes === 0) {
    if (value.offset !== 0 || decoded.byteLength !== 0) return false;
  } else {
    if (decoded.byteLength === 0 || value.offset + decoded.byteLength > value.totalBytes) return false;
  }
  return true;
}

export function isVfsPacket(value: unknown, roomId?: string): value is VfsPacket {
  if (!isPlainObject(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'vfs-record':
      return isVfsRecordPacket(value, roomId);
    case 'vfs-have':
      return isVfsHavePacket(value, roomId);
    case 'vfs-ops':
      return isVfsOpsPacket(value, roomId);
    case 'vfs-key-epoch':
      return isVfsKeyEpochPacket(value, roomId);
    case 'vfs-key-wrap':
      return isVfsKeyWrapPacket(value, roomId);
    case 'vfs-key-grant':
      return isVfsKeyGrantPacket(value, roomId);
    case 'vfs-block-want':
      return isVfsBlockWantPacket(value, roomId);
    case 'vfs-block-chunk':
      return isVfsBlockChunkPacket(value, roomId);
    case 'vfs-block-have':
      return isVfsBlockHavePacket(value, roomId);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Wire Packet Builders, Chunking & Deterministic Frontier Hash
// ---------------------------------------------------------------------------

export function wrapKeyEpochPacket(header: VfsKeyEpochHeader): VfsKeyEpochPacket {
  if (!isValidKeyEpochHeaderShape(header)) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid VfsKeyEpochHeader for wire wrapping.');
  }
  return {
    kind: 'vfs-key-epoch',
    v: VFS_PROTOCOL_VERSION,
    roomId: header.body.roomId,
    header,
  };
}

export function wrapKeyWrapPacket(chunk: VfsKeyWrapChunk): VfsKeyWrapPacket {
  if (!isValidKeyWrapChunkShape(chunk)) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid VfsKeyWrapChunk for wire wrapping.');
  }
  return {
    kind: 'vfs-key-wrap',
    v: VFS_PROTOCOL_VERSION,
    roomId: chunk.body.roomId,
    chunk,
  };
}

export function wrapKeyGrantPacket(grant: KeyringVfsKeyGrantPacket): VfsKeyGrantPacket {
  if (!isValidKeyGrantPacketShape(grant)) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid VfsKeyGrantPacket for wire wrapping.');
  }
  return {
    kind: 'vfs-key-grant',
    v: VFS_PROTOCOL_VERSION,
    roomId: grant.body.roomId,
    grant,
  };
}

export type ChunkVfsOpsOptions = {
  /** Max UTF-8 JSON byte budget per `vfs-ops` page (default & max: `VFS_OPS_MAX_BYTES` = 14,000). */
  maxBytes?: number;
  /** Max records per `vfs-ops` page (default & max: `VFS_OPS_MAX_RECORDS` = 64). */
  maxRecords?: number;
  /** Set `true` when additional unsent records remain beyond `records`. */
  hasMore?: boolean;
  /** Explicit cursor attached to the final page when `hasMore` is `true`. */
  nextCursor?: string;
  /** Optional cursor derivation for each page's last record when `more` is `true`. */
  cursorOf?: (record: VfsRecordPacket) => string;
};

/**
 * Splits `records` into bounded `VfsOpsPacket` pages strictly honoring BOTH `<= maxBytes`
 * (default/max `14,000` UTF-8 JSON bytes) and `<= maxRecords` (default/max `64` records/page).
 */
export function chunkVfsOpsPages(
  roomId: string,
  deviceId: string,
  records: readonly VfsRecordPacket[],
  opts?: ChunkVfsOpsOptions,
): VfsOpsPacket[] {
  if (!isValidRoomId(roomId)) {
    throw new VfsError('VFS_INVALID_KEY', 'Invalid roomId for chunkVfsOpsPages.');
  }
  if (typeof deviceId !== 'string' || !HEX_64.test(deviceId)) {
    throw new VfsError('VFS_INVALID_KEY', 'Invalid deviceId for chunkVfsOpsPages.');
  }
  const maxBytes = opts?.maxBytes ?? VFS_OPS_MAX_BYTES;
  const maxRecords = opts?.maxRecords ?? VFS_OPS_MAX_RECORDS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > VFS_OPS_MAX_BYTES) {
    throw new VfsError('VFS_LIMIT_EXCEEDED', `maxBytes must be in 1..${VFS_OPS_MAX_BYTES}.`);
  }
  if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0 || maxRecords > VFS_OPS_MAX_RECORDS) {
    throw new VfsError('VFS_LIMIT_EXCEEDED', `maxRecords must be in 1..${VFS_OPS_MAX_RECORDS}.`);
  }
  if (opts?.nextCursor !== undefined && !isValidCursor(opts.nextCursor)) {
    throw new VfsError('VFS_INVALID_KEY', 'Invalid nextCursor for chunkVfsOpsPages.');
  }

  if (records.length === 0) return [];

  for (const rec of records) {
    if (!isVfsRecordPacket(rec, roomId)) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid VfsRecordPacket passed to chunkVfsOpsPages.');
    }
  }

  const buildCandidate = (batch: VfsRecordPacket[], more: boolean, cursor?: string): VfsOpsPacket => ({
    kind: 'vfs-ops',
    v: VFS_PROTOCOL_VERSION,
    roomId,
    deviceId,
    records: batch,
    more,
    ...(cursor !== undefined ? { nextCursor: cursor } : {}),
  });

  // Account for cursor overhead while packing so finalizing `more`/`nextCursor` never exceeds `maxBytes`.
  const reservedCursorFor = (lastRec: VfsRecordPacket, isFinalCandidate: boolean): string | undefined => {
    if (isFinalCandidate) {
      if (opts?.nextCursor !== undefined) return opts.nextCursor;
      if (opts?.hasMore && opts.cursorOf) return opts.cursorOf(lastRec);
      return undefined;
    }
    return opts?.cursorOf ? opts.cursorOf(lastRec) : undefined;
  };

  const rawBatches: VfsRecordPacket[][] = [];
  let current: VfsRecordPacket[] = [];

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const isLastInput = i === records.length - 1;
    const tentative = [...current, rec];
    const tentativeMore = !isLastInput || Boolean(opts?.hasMore);
    const tentativeCursor = reservedCursorFor(rec, isLastInput);
    const tentativeSize = jsonUtf8Bytes(buildCandidate(tentative, tentativeMore, tentativeCursor));

    if (tentative.length <= maxRecords && tentativeSize <= maxBytes) {
      current = tentative;
      continue;
    }

    if (current.length > 0) {
      rawBatches.push(current);
      current = [];
    }

    // Verify the single record fits inside an empty page under `maxBytes`.
    const singleMore = !isLastInput || Boolean(opts?.hasMore);
    const singleCursor = reservedCursorFor(rec, isLastInput);
    const singleSize = jsonUtf8Bytes(buildCandidate([rec], singleMore, singleCursor));
    if (singleSize > maxBytes) {
      throw new VfsError(
        'VFS_LIMIT_EXCEEDED',
        `Single VfsRecordPacket (${singleSize} bytes) exceeds vfs-ops page budget (${maxBytes} bytes).`,
      );
    }
    current = [rec];
  }

  if (current.length > 0) {
    rawBatches.push(current);
  }

  return rawBatches.map((batch, idx) => {
    const isFinal = idx === rawBatches.length - 1;
    const more = !isFinal || Boolean(opts?.hasMore);
    const lastRec = batch[batch.length - 1];
    const nextCursor = isFinal
      ? (opts?.nextCursor ?? (opts?.hasMore && opts.cursorOf ? opts.cursorOf(lastRec) : undefined))
      : (opts?.cursorOf ? opts.cursorOf(lastRec) : undefined);
    if (nextCursor !== undefined && !isValidCursor(nextCursor)) {
      throw new VfsError('VFS_INVALID_KEY', 'cursorOf returned an invalid VFS pagination cursor.');
    }
    const page = buildCandidate(batch, more, nextCursor);
    if (jsonUtf8Bytes(page) > maxBytes) {
      throw new VfsError('VFS_LIMIT_EXCEEDED', 'Finalized vfs-ops page exceeds maxBytes budget.');
    }
    return page;
  });
}

/**
 * Computes an O(1) order- and duplicate-invariant SHA-256 hex digest over a room's set of
 * replicated record CIDs (`SHA-256("meshrooms-vfs-frontier-v1|" || sortedUniqueCids.join("\n"))`).
 */
export async function computeVfsFrontierHash(cids: Iterable<string>): Promise<string> {
  const unique = new Set<string>();
  for (const cid of cids) {
    if (typeof cid !== 'string' || !HEX_64.test(cid)) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'computeVfsFrontierHash requires 64-char lowercase hex CIDs.');
    }
    unique.add(cid);
  }
  const sorted = [...unique].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256Hex(utf8Bytes(`${VFS_FRONTIER_HASH_DOMAIN}${sorted.join('\n')}`));
}
