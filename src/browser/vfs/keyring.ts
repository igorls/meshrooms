/**
 * Room VFS Key-Epoch Ring (`RK_e`), Host-Only Epoch-1 Bootstrap, Forward-Only Rotation,
 * and Offline-Host Delegated Key Grants (`docs/flows/room-vfs.md` §4.3).
 *
 * Security invariants:
 * - Only the verified room host may mint Epoch 1 (`bootstrapEpoch1`) or rotate forward
 *   (`rotateEpoch` -> `epoch + 1`). Non-hosts never mint Epoch 1 (preventing dual-genesis forks)
 *   and fail closed with `VFS_EPOCH_UNINITIALIZED` until Epoch 1 arrives.
 * - Every `VfsKeyEpochHeader` commits to `keyCommit = SHA-256("vfs-rk-commit-v1|" ||
 *   roomId || "|" || epoch || "|" || RK_e)`, preventing host wrap-equivocation and enabling any
 *   online admitted human device to grant `RK_1..RK_e` to newcomers while the host is offline
 *   (`VfsKeyGrantPacket`) — the recipient verifies every `keyCommit` against the host-signed header!
 * - Recipient key wraps reuse Meshrooms' audited P-256 ECDH + HKDF-SHA256 + AES-256-GCM pattern
 *   (`src/browser/relay-crypto.ts`), chunked at `<= 64` recipients per `VfsKeyWrapChunk`.
 */

import { verify } from '../protocol';
import {
  base64ToBytes,
  bytesToBase64,
  canonicalJson,
  canonicalize,
  exportRawPublicKey,
  generateEncKeyPair,
  importEncPublicKey,
  verifyDelegatedRosterEntry,
  type RosterEntry,
  type SignFn,
  type SignedRoster,
} from '../relay-crypto';
import {
  VFS_EPOCH_HEADER_SIG_DOMAIN,
  VFS_EPOCH_WRAP_DOMAIN,
  VFS_GRANT_WRAP_DOMAIN,
  VFS_KEY_BYTES,
  VFS_KEY_COMMIT_DOMAIN,
  VFS_KEY_GRANT_SIG_DOMAIN,
  VFS_KEY_WRAP_MAX_RECIPIENTS_PER_CHUNK,
  VFS_KEY_WRAP_SIG_DOMAIN,
  VFS_PROTOCOL_VERSION,
  VfsError,
  VfsObjKind,
  vfsEpochKey,
} from './constants';
import {
  bytesToHex,
  concatBytes,
  constantTimeEqual,
  generateVfsKey,
  openVfsEnvelope,
  sealVfsEnvelope,
  sha256Bytes,
  sha256Hex,
  toArrayBufferView,
  utf8Bytes,
} from './envelope';

const HEX_64 = /^[a-f0-9]{64}$/;
const HEX_PIN = /^[0-9a-f]{16,64}$/;
const WRAP_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const EXPECTED_WRAPPED_KEY_BYTES = WRAP_IV_BYTES + VFS_KEY_BYTES + GCM_TAG_BYTES;
const MAX_U32 = 0xffff_ffff;
const MAX_TIME = 8_640_000_000_000_000;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

// ---------------------------------------------------------------------------
// Wire & persistence types
// ---------------------------------------------------------------------------

export type VfsKeyEpochHeaderBody = {
  kind: 'vfs-key-epoch';
  v: typeof VFS_PROTOCOL_VERSION;
  roomId: string;
  epoch: number;
  prevEpochHash: string;
  rosterVersion: number;
  hostDeviceId: string;
  at: number;
  epk: string;
  keyCommit: string;
};

export type VfsKeyEpochHeader = {
  body: VfsKeyEpochHeaderBody;
  signature: string;
};

export type VfsKeyWrapChunkBody = {
  kind: 'vfs-key-wrap';
  v: typeof VFS_PROTOCOL_VERSION;
  roomId: string;
  epoch: number;
  headerHash: string;
  chunkIndex: number;
  chunkCount: number;
  senderDeviceId: string;
  wraps: Record<string, string>;
};

export type VfsKeyWrapChunk = {
  body: VfsKeyWrapChunkBody;
  signature: string;
};

export type VfsKeyGrantEntry = {
  header: VfsKeyEpochHeader;
  wrappedKey: string;
};

export type VfsKeyGrantBody = {
  kind: 'vfs-key-grant';
  v: typeof VFS_PROTOCOL_VERSION;
  roomId: string;
  rosterVersion: number;
  granterDeviceId: string;
  recipientDeviceId: string;
  recipientEncVersion: number;
  epk: string;
  at: number;
  entries: VfsKeyGrantEntry[];
};

export type VfsKeyGrantPacket = {
  body: VfsKeyGrantBody;
  signature: string;
};

export type VfsEpochRecord = {
  epoch: number;
  rosterVersion: number;
  header: VfsKeyEpochHeader;
  headerHash: string;
  key: Uint8Array<ArrayBuffer>;
  createdAt: number;
  revokedAt?: number;
};

export type VfsKeyringOptions = {
  roomId: string;
  selfDeviceId: string;
  selfEncPrivateKey: CryptoKey;
  selfEncVersion: number;
  sign: SignFn;
  /** Optional host pin (16..64 lowercase hex prefix of host deviceId from `#h=`, or TOFU once learned). */
  pinnedHost?: string;
  now?: () => number;
};

// ---------------------------------------------------------------------------
// Key commitment & canonical hashing
// ---------------------------------------------------------------------------

/**
 * Computes `SHA-256("vfs-rk-commit-v1|" || roomId || "|" || epoch || "|" || RK_e)`.
 * Verified by every recipient after unwrapping `RK_e` to defeat wrap-equivocation and forgeable grants.
 */
export async function computeVfsKeyCommit(
  roomId: string,
  epoch: number,
  roomKey: Uint8Array,
): Promise<string> {
  if (!roomId || roomId.includes('\0')) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid roomId for keyCommit.');
  }
  if (!Number.isInteger(epoch) || epoch < 1 || epoch > MAX_U32) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid epoch for keyCommit.');
  }
  if (!(roomKey instanceof Uint8Array) || roomKey.byteLength !== VFS_KEY_BYTES) {
    throw new VfsError('VFS_INVALID_ENVELOPE', `Room key must be ${VFS_KEY_BYTES} bytes.`);
  }
  const prefix = utf8Bytes(`${VFS_KEY_COMMIT_DOMAIN}${roomId}|${epoch}|`);
  return bytesToHex(await sha256Bytes(concatBytes(prefix, roomKey)));
}

export async function hashEpochHeaderBody(body: VfsKeyEpochHeaderBody): Promise<string> {
  return sha256Hex(utf8Bytes(canonicalJson(body)));
}

function epochHeaderSigPayload(body: VfsKeyEpochHeaderBody) {
  return canonicalize({ d: VFS_EPOCH_HEADER_SIG_DOMAIN, body });
}

function keyWrapSigPayload(body: VfsKeyWrapChunkBody) {
  return canonicalize({ d: VFS_KEY_WRAP_SIG_DOMAIN, body });
}

function keyGrantSigPayload(body: VfsKeyGrantBody) {
  return canonicalize({ d: VFS_KEY_GRANT_SIG_DOMAIN, body });
}

// ---------------------------------------------------------------------------
// Shape & signature validation
// ---------------------------------------------------------------------------

function isPlainObj(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isValidKeyEpochHeaderShape(value: unknown): value is VfsKeyEpochHeader {
  if (!isPlainObj(value) || !isPlainObj(value.body) || typeof value.signature !== 'string' || value.signature.length !== 88) {
    return false;
  }
  const b = value.body;
  if (b.kind !== 'vfs-key-epoch' || b.v !== VFS_PROTOCOL_VERSION) return false;
  if (typeof b.roomId !== 'string' || b.roomId.length === 0 || b.roomId.length > 128) return false;
  if (typeof b.epoch !== 'number' || !Number.isInteger(b.epoch) || b.epoch < 1 || b.epoch > MAX_U32) return false;
  if (typeof b.prevEpochHash !== 'string') return false;
  if (b.epoch === 1 && b.prevEpochHash !== '') return false;
  if (b.epoch > 1 && !HEX_64.test(b.prevEpochHash)) return false;
  if (typeof b.rosterVersion !== 'number' || !Number.isInteger(b.rosterVersion) || b.rosterVersion < 1) return false;
  if (typeof b.hostDeviceId !== 'string' || !HEX_64.test(b.hostDeviceId)) return false;
  if (typeof b.at !== 'number' || !Number.isSafeInteger(b.at) || b.at <= 0 || b.at > MAX_TIME) return false;
  if (typeof b.epk !== 'string' || b.epk.length !== 88) return false;
  if (typeof b.keyCommit !== 'string' || !HEX_64.test(b.keyCommit)) return false;
  return true;
}

export function isValidKeyWrapChunkShape(value: unknown): value is VfsKeyWrapChunk {
  if (!isPlainObj(value) || !isPlainObj(value.body) || typeof value.signature !== 'string' || value.signature.length !== 88) {
    return false;
  }
  const b = value.body;
  if (b.kind !== 'vfs-key-wrap' || b.v !== VFS_PROTOCOL_VERSION) return false;
  if (typeof b.roomId !== 'string' || b.roomId.length === 0 || b.roomId.length > 128) return false;
  if (typeof b.epoch !== 'number' || !Number.isInteger(b.epoch) || b.epoch < 1 || b.epoch > MAX_U32) return false;
  if (typeof b.headerHash !== 'string' || !HEX_64.test(b.headerHash)) return false;
  if (typeof b.chunkIndex !== 'number' || !Number.isInteger(b.chunkIndex) || b.chunkIndex < 0) return false;
  if (typeof b.chunkCount !== 'number' || !Number.isInteger(b.chunkCount) || b.chunkCount < 1 || b.chunkIndex >= b.chunkCount) return false;
  if (typeof b.senderDeviceId !== 'string' || !HEX_64.test(b.senderDeviceId)) return false;
  if (!isPlainObj(b.wraps)) return false;
  const entries = Object.entries(b.wraps);
  if (entries.length === 0 || entries.length > VFS_KEY_WRAP_MAX_RECIPIENTS_PER_CHUNK) return false;
  for (const [devId, wrapped] of entries) {
    if (!HEX_64.test(devId) || typeof wrapped !== 'string' || wrapped.length === 0 || wrapped.length > 256) return false;
  }
  return true;
}

export function isValidKeyGrantPacketShape(value: unknown): value is VfsKeyGrantPacket {
  if (!isPlainObj(value) || !isPlainObj(value.body) || typeof value.signature !== 'string' || value.signature.length !== 88) {
    return false;
  }
  const b = value.body;
  if (b.kind !== 'vfs-key-grant' || b.v !== VFS_PROTOCOL_VERSION) return false;
  if (typeof b.roomId !== 'string' || b.roomId.length === 0 || b.roomId.length > 128) return false;
  if (typeof b.rosterVersion !== 'number' || !Number.isInteger(b.rosterVersion) || b.rosterVersion < 1) return false;
  if (typeof b.granterDeviceId !== 'string' || !HEX_64.test(b.granterDeviceId)) return false;
  if (typeof b.recipientDeviceId !== 'string' || !HEX_64.test(b.recipientDeviceId)) return false;
  if (typeof b.recipientEncVersion !== 'number' || !Number.isInteger(b.recipientEncVersion) || b.recipientEncVersion < 1) return false;
  if (typeof b.epk !== 'string' || b.epk.length !== 88) return false;
  if (typeof b.at !== 'number' || !Number.isSafeInteger(b.at) || b.at <= 0 || b.at > MAX_TIME) return false;
  if (!Array.isArray(b.entries) || b.entries.length === 0 || b.entries.length > 1024) return false;
  for (const entry of b.entries) {
    if (!isPlainObj(entry) || !isValidKeyEpochHeaderShape(entry.header)) return false;
    if (typeof entry.wrappedKey !== 'string' || entry.wrappedKey.length === 0 || entry.wrappedKey.length > 256) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// ECDH P-256 + HKDF-SHA256 + AES-256-GCM key wrapping helpers
// ---------------------------------------------------------------------------

async function deriveWrapAesKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  salt: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> {
  const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

async function wrapRoomKeyForRecipient(
  epkPrivate: CryptoKey,
  recipientEncPubB64: string,
  roomKey: Uint8Array,
  salt: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const recipientPub = await importEncPublicKey(recipientEncPubB64);
  const wrapKey = await deriveWrapAesKey(epkPrivate, recipientPub, salt, info, 'encrypt');
  const iv = new Uint8Array(new ArrayBuffer(WRAP_IV_BYTES));
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: info }, wrapKey, toArrayBufferView(roomKey)),
  );
  return bytesToBase64(concatBytes(iv, ct));
}

async function unwrapRoomKeyFromSender(
  selfEncPrivateKey: CryptoKey,
  epkPubB64: string,
  wrappedB64: string,
  salt: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = base64ToBytes(wrappedB64);
  } catch (cause) {
    throw new VfsError('VFS_DECRYPT_FAILED', 'Invalid base64 in wrapped room key.', { cause });
  }
  if (raw.byteLength !== EXPECTED_WRAPPED_KEY_BYTES) {
    throw new VfsError('VFS_DECRYPT_FAILED', 'Invalid wrapped room key byte length.');
  }
  const iv = new Uint8Array(new ArrayBuffer(WRAP_IV_BYTES));
  iv.set(raw.subarray(0, WRAP_IV_BYTES));
  const ct = new Uint8Array(new ArrayBuffer(raw.byteLength - WRAP_IV_BYTES));
  ct.set(raw.subarray(WRAP_IV_BYTES));

  const epkPub = await importEncPublicKey(epkPubB64);
  const wrapKey = await deriveWrapAesKey(selfEncPrivateKey, epkPub, salt, info, 'decrypt');
  let keyBuf: ArrayBuffer;
  try {
    keyBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: info }, wrapKey, ct);
  } catch (cause) {
    throw new VfsError('VFS_DECRYPT_FAILED', 'Failed to unwrap VFS room epoch key.', { cause });
  }
  if (keyBuf.byteLength !== VFS_KEY_BYTES) {
    throw new VfsError('VFS_DECRYPT_FAILED', 'Unwrapped VFS room epoch key has invalid length.');
  }
  return new Uint8Array(keyBuf);
}

function epochWrapSalt(roomId: string, epoch: number, headerHash: string): Uint8Array<ArrayBuffer> {
  return utf8Bytes(`${roomId}|${epoch}|${headerHash}`);
}

function epochWrapInfo(
  roomId: string,
  epoch: number,
  senderDeviceId: string,
  recipientDeviceId: string,
  recipientEncVersion: number,
): Uint8Array<ArrayBuffer> {
  return utf8Bytes(`${VFS_EPOCH_WRAP_DOMAIN}${roomId}|${epoch}|${senderDeviceId}|${recipientDeviceId}|${recipientEncVersion}`);
}

function grantWrapSalt(roomId: string, epoch: number, headerHash: string): Uint8Array<ArrayBuffer> {
  return utf8Bytes(`grant|${roomId}|${epoch}|${headerHash}`);
}

function grantWrapInfo(
  roomId: string,
  epoch: number,
  granterDeviceId: string,
  recipientDeviceId: string,
  recipientEncVersion: number,
): Uint8Array<ArrayBuffer> {
  return utf8Bytes(`${VFS_GRANT_WRAP_DOMAIN}${roomId}|${epoch}|${granterDeviceId}|${recipientDeviceId}|${recipientEncVersion}`);
}

// ---------------------------------------------------------------------------
// Header verification against verified SignedRoster & host pin
// ---------------------------------------------------------------------------

/**
 * Verifies a host-signed `VfsKeyEpochHeader` against the verified `SignedRoster`, optional
 * `pinnedHost` (hex prefix or full 64-hex deviceId), and optional `trustedPriorHosts` map
 * (`priorHostDeviceId -> signPubKey`) for historical epochs signed before a `transfer-host`.
 */
export async function verifyKeyEpochHeader(
  header: unknown,
  options: {
    roomId: string;
    roster: SignedRoster;
    pinnedHost?: string;
    trustedPriorHosts?: Readonly<Record<string, string>>;
    allowPriorHost?: boolean;
  },
): Promise<{ headerHash: string; signerPublicKey: string }> {
  if (!isValidKeyEpochHeaderShape(header)) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Malformed VfsKeyEpochHeader.');
  }
  const b = header.body;
  if (b.roomId !== options.roomId) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'VfsKeyEpochHeader roomId mismatch.');
  }
  if (options.roster.body.room !== options.roomId) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'SignedRoster room mismatch.');
  }

  let signerPublicKey: string | undefined;
  const isCurrentHost = b.hostDeviceId === options.roster.body.host;
  if (isCurrentHost) {
    const hostEntry = options.roster.body.devices.find(d => d.id === options.roster.body.host);
    if (!hostEntry) {
      throw new VfsError('VFS_EPOCH_UNAUTHORIZED', 'Current roster host is missing from roster devices.');
    }
    signerPublicKey = hostEntry.sign;
    if (options.pinnedHost !== undefined) {
      const pin = options.pinnedHost.trim().toLowerCase();
      if (!HEX_PIN.test(pin)) {
        throw new VfsError('VFS_EPOCH_UNAUTHORIZED', 'Invalid pinned room host format.');
      }
      if (!b.hostDeviceId.startsWith(pin)) {
        // After a verified `transfer-host` (hostA -> hostB), allow the new roster host when
        // `trustedPriorHosts` explicitly vouches for the previously pinned host.
        const pinInPriorHosts = !!options.trustedPriorHosts
          && Object.keys(options.trustedPriorHosts).some(priorId => priorId.toLowerCase().startsWith(pin));
        if (!pinInPriorHosts) {
          throw new VfsError('VFS_EPOCH_UNAUTHORIZED', 'Epoch header host does not match pinned room host.');
        }
      }
    }
  } else if (options.allowPriorHost && options.trustedPriorHosts && options.trustedPriorHosts[b.hostDeviceId]) {
    signerPublicKey = options.trustedPriorHosts[b.hostDeviceId];
  } else {
    throw new VfsError('VFS_EPOCH_UNAUTHORIZED', 'Only the verified room host may sign VFS key epoch headers.');
  }

  // Validate ephemeral key is a valid P-256 point.
  try {
    await importEncPublicKey(b.epk);
  } catch (cause) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid ephemeral P-256 public key in epoch header.', { cause });
  }

  const sigOk = await verify(signerPublicKey, epochHeaderSigPayload(b), header.signature);
  if (!sigOk) {
    throw new VfsError('VFS_INVALID_SIGNATURE', 'Invalid host signature on VfsKeyEpochHeader.');
  }

  return { headerHash: await hashEpochHeaderBody(b), signerPublicKey };
}

// ---------------------------------------------------------------------------
// Device-at-rest sealing for persisted EpochKeyRecord (VfsEnvelopeV1 objKind=0x10)
// ---------------------------------------------------------------------------

type PersistedEpochRecordJson = {
  v: typeof VFS_PROTOCOL_VERSION;
  epoch: number;
  rosterVersion: number;
  header: VfsKeyEpochHeader;
  headerHash: string;
  keyB64: string;
  createdAt: number;
  revokedAt?: number;
};

/** Seals a `VfsEpochRecord` under `K_device_seal` for Tier 1 KV persistence (`vfs:v1:<roomId>:epoch:<epoch8>`). */
export async function sealEpochRecordForStorage(
  roomId: string,
  record: VfsEpochRecord,
  deviceSealKey: Uint8Array,
): Promise<{ kvKey: string; bytes: Uint8Array<ArrayBuffer>; cid: string }> {
  const kvKey = vfsEpochKey(roomId, record.epoch);
  const payload: PersistedEpochRecordJson = {
    v: VFS_PROTOCOL_VERSION,
    epoch: record.epoch,
    rosterVersion: record.rosterVersion,
    header: record.header,
    headerHash: record.headerHash,
    keyB64: bytesToBase64(record.key),
    createdAt: record.createdAt,
    ...(record.revokedAt !== undefined ? { revokedAt: record.revokedAt } : {}),
  };
  const sealed = await sealVfsEnvelope({
    roomId,
    epoch: 0,
    objKind: VfsObjKind.DeviceLocal,
    key: deviceSealKey,
    plaintext: utf8Bytes(canonicalJson(payload)),
    bindingKey: kvKey,
  });
  return { kvKey, bytes: sealed.bytes, cid: sealed.cid };
}

/** Unseals a persisted `VfsEpochRecord` from Tier 1 KV and re-verifies its `keyCommit`. */
export async function openEpochRecordFromStorage(
  roomId: string,
  epoch: number,
  bytes: Uint8Array,
  deviceSealKey: Uint8Array,
): Promise<VfsEpochRecord> {
  const kvKey = vfsEpochKey(roomId, epoch);
  const opened = await openVfsEnvelope({
    bytes,
    roomId,
    key: deviceSealKey,
    bindingKey: kvKey,
    expectedObjKind: VfsObjKind.DeviceLocal,
    expectedEpoch: 0,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(opened.plaintext));
  } catch (cause) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Corrupted persisted EpochKeyRecord JSON.', { cause });
  }
  if (!isPlainObj(parsed) || parsed.v !== VFS_PROTOCOL_VERSION || parsed.epoch !== epoch) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Persisted EpochKeyRecord version or epoch mismatch.');
  }
  if (!isValidKeyEpochHeaderShape(parsed.header) || parsed.header.body.roomId !== roomId || parsed.header.body.epoch !== epoch) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Persisted EpochKeyRecord header invalid.');
  }
  if (typeof parsed.keyB64 !== 'string' || typeof parsed.rosterVersion !== 'number' || typeof parsed.createdAt !== 'number') {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Persisted EpochKeyRecord missing required fields.');
  }
  const key = base64ToBytes(parsed.keyB64);
  if (key.byteLength !== VFS_KEY_BYTES) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Persisted room epoch key has invalid length.');
  }
  const computedCommit = await computeVfsKeyCommit(roomId, epoch, key);
  if (!constantTimeEqual(utf8Bytes(computedCommit), utf8Bytes(parsed.header.body.keyCommit))) {
    throw new VfsError('VFS_KEY_COMMIT_MISMATCH', 'Persisted room epoch key does not match header keyCommit.');
  }
  const headerHash = await hashEpochHeaderBody(parsed.header.body);
  if (parsed.headerHash !== headerHash) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Persisted EpochKeyRecord headerHash mismatch.');
  }
  return {
    epoch,
    rosterVersion: parsed.rosterVersion,
    header: parsed.header,
    headerHash,
    key,
    createdAt: parsed.createdAt,
    ...(typeof parsed.revokedAt === 'number' ? { revokedAt: parsed.revokedAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// VfsKeyring — Room Epoch Key State Machine
// ---------------------------------------------------------------------------

export class VfsKeyring {
  readonly roomId: string;
  readonly selfDeviceId: string;
  private readonly selfEncPrivateKey: CryptoKey;
  private readonly selfEncVersion: number;
  private readonly signFn: SignFn;
  private readonly now: () => number;
  private pinnedHost?: string;
  private epochs = new Map<number, VfsEpochRecord>();
  private currentEpoch = 0;
  private highestRosterVersion = 0;

  constructor(options: VfsKeyringOptions) {
    if (!options.roomId || !HEX_64.test(options.selfDeviceId)) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid VfsKeyring roomId or selfDeviceId.');
    }
    if (!Number.isInteger(options.selfEncVersion) || options.selfEncVersion < 1) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid selfEncVersion for VfsKeyring.');
    }
    if (options.pinnedHost !== undefined) {
      const pin = options.pinnedHost.trim().toLowerCase();
      if (!HEX_PIN.test(pin)) {
        throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid pinnedHost hex prefix.');
      }
      this.pinnedHost = pin;
    }
    this.roomId = options.roomId;
    this.selfDeviceId = options.selfDeviceId;
    this.selfEncPrivateKey = options.selfEncPrivateKey;
    this.selfEncVersion = options.selfEncVersion;
    this.signFn = options.sign;
    this.now = options.now ?? (() => Date.now());
  }

  get hostPin(): string | undefined {
    return this.pinnedHost;
  }

  get activeEpoch(): number {
    return this.currentEpoch;
  }

  isInitialized(): boolean {
    return this.currentEpoch >= 1 && this.epochs.has(this.currentEpoch);
  }

  listEpochs(): number[] {
    return [...this.epochs.keys()].sort((a, b) => a - b);
  }

  getRecord(epoch: number): VfsEpochRecord | undefined {
    return this.epochs.get(epoch);
  }

  getKey(epoch: number): Uint8Array<ArrayBuffer> | undefined {
    return this.epochs.get(epoch)?.key;
  }

  /**
   * Returns the active room key record, or fails closed with `VFS_EPOCH_UNINITIALIZED` (503)
   * when Epoch 1 has not yet been initialized by the room host.
   */
  requireActiveEpoch(): VfsEpochRecord {
    const rec = this.epochs.get(this.currentEpoch);
    if (!rec || this.currentEpoch < 1) {
      throw new VfsError(
        'VFS_EPOCH_UNINITIALIZED',
        'Waiting for the room host to initialize encrypted shared documents.',
        { status: 503 },
      );
    }
    return rec;
  }

  /** Loads verified persisted `VfsEpochRecord`s (e.g. opened from WormDB/IDB via `openEpochRecordFromStorage`). */
  async hydrate(records: readonly VfsEpochRecord[]): Promise<void> {
    const sorted = [...records].sort((a, b) => a.epoch - b.epoch);
    for (const rec of sorted) {
      if (rec.header.body.roomId !== this.roomId || rec.header.body.epoch !== rec.epoch) {
        throw new VfsError('VFS_INVALID_ENVELOPE', 'Hydrated epoch record does not match keyring room.');
      }
      const commit = await computeVfsKeyCommit(this.roomId, rec.epoch, rec.key);
      if (!constantTimeEqual(utf8Bytes(commit), utf8Bytes(rec.header.body.keyCommit))) {
        throw new VfsError('VFS_KEY_COMMIT_MISMATCH', `Hydrated epoch ${rec.epoch} keyCommit mismatch.`);
      }
      const prev = this.epochs.get(rec.epoch - 1);
      if (rec.epoch > 1 && prev && rec.header.body.prevEpochHash !== prev.headerHash) {
        throw new VfsError('VFS_EPOCH_ROLLBACK', `Hydrated epoch ${rec.epoch} prevEpochHash chain broken.`);
      }
      const next = this.epochs.get(rec.epoch + 1);
      if (next && next.header.body.prevEpochHash !== rec.headerHash) {
        throw new VfsError('VFS_EPOCH_ROLLBACK', `Hydrated epoch ${rec.epoch} does not match held epoch ${rec.epoch + 1} prevEpochHash.`);
      }
      this.epochs.set(rec.epoch, rec);
      if (rec.epoch > this.currentEpoch) this.currentEpoch = rec.epoch;
      if (rec.rosterVersion > this.highestRosterVersion) this.highestRosterVersion = rec.rosterVersion;
    }
  }

  /**
   * Host-only Epoch-1 bootstrap (`docs/flows/room-vfs.md` §4.3).
   * Non-hosts are strictly rejected with `VFS_EPOCH_UNAUTHORIZED` to prevent dual-genesis forks.
   */
  async bootstrapEpoch1(
    roster: SignedRoster,
  ): Promise<{ header: VfsKeyEpochHeader; wrapChunks: VfsKeyWrapChunk[]; record: VfsEpochRecord }> {
    if (roster.body.room !== this.roomId) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'SignedRoster room mismatch.');
    }
    if (roster.body.host !== this.selfDeviceId) {
      throw new VfsError(
        'VFS_EPOCH_UNAUTHORIZED',
        'Only the room host may initialize VFS epoch 1.',
        { status: 403 },
      );
    }
    if (this.currentEpoch >= 1 || this.epochs.has(1)) {
      throw new VfsError('VFS_EPOCH_ROLLBACK', 'VFS epoch 1 is already initialized.');
    }
    if (this.pinnedHost && !this.selfDeviceId.startsWith(this.pinnedHost)) {
      throw new VfsError('VFS_EPOCH_UNAUTHORIZED', 'Host device does not match pinnedHost.');
    }
    if (!Number.isInteger(roster.body.version) || roster.body.version < Math.max(1, this.highestRosterVersion)) {
      throw new VfsError('VFS_EPOCH_ROLLBACK', 'Cannot bootstrap VFS epoch 1 under a stale or invalid roster version.');
    }
    const minted = await this.mintEpoch(1, '', roster);
    this.pinnedHost = this.selfDeviceId;
    return minted;
  }

  /**
   * Host-only forward epoch rotation (`epoch -> epoch + 1`) on member/device revocation.
   * Wraps the fresh independent `RK_{e+1}` strictly to active devices in `roster.body.devices`.
   */
  async rotateEpoch(
    roster: SignedRoster,
  ): Promise<{ header: VfsKeyEpochHeader; wrapChunks: VfsKeyWrapChunk[]; record: VfsEpochRecord }> {
    if (roster.body.room !== this.roomId) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'SignedRoster room mismatch.');
    }
    const prev = this.requireActiveEpoch();
    if (roster.body.host !== this.selfDeviceId) {
      throw new VfsError(
        'VFS_EPOCH_UNAUTHORIZED',
        'Only the room host may rotate VFS room key epochs.',
        { status: 403 },
      );
    }
    const minRosterVersion = Math.max(prev.rosterVersion, this.highestRosterVersion);
    if (!Number.isInteger(roster.body.version) || roster.body.version < minRosterVersion) {
      throw new VfsError(
        'VFS_EPOCH_ROLLBACK',
        `Cannot rotate VFS key epoch under stale rosterVersion ${roster.body.version} < ${minRosterVersion}.`,
      );
    }
    const removedIds = new Set(roster.body.removed.map(r => r.id));
    if (removedIds.has(this.selfDeviceId)) {
      throw new VfsError('VFS_EPOCH_UNAUTHORIZED', 'Removed host device cannot rotate VFS key epochs.', { status: 403 });
    }
    const at = this.now();
    const minted = await this.mintEpoch(prev.epoch + 1, prev.headerHash, roster, at);
    prev.revokedAt = at;
    this.pinnedHost = this.selfDeviceId;
    return minted;
  }

  private async mintEpoch(
    epoch: number,
    prevEpochHash: string,
    roster: SignedRoster,
    at = this.now(),
  ): Promise<{ header: VfsKeyEpochHeader; wrapChunks: VfsKeyWrapChunk[]; record: VfsEpochRecord }> {
    const roomKey = generateVfsKey();
    const keyCommit = await computeVfsKeyCommit(this.roomId, epoch, roomKey);
    const epkPair = await generateEncKeyPair(false);
    const epk = await exportRawPublicKey(epkPair.publicKey);

    const headerBody: VfsKeyEpochHeaderBody = canonicalize({
      kind: 'vfs-key-epoch',
      v: VFS_PROTOCOL_VERSION,
      roomId: this.roomId,
      epoch,
      prevEpochHash,
      rosterVersion: roster.body.version,
      hostDeviceId: this.selfDeviceId,
      at,
      epk,
      keyCommit,
    });
    const headerSig = await this.signFn(epochHeaderSigPayload(headerBody));
    const header: VfsKeyEpochHeader = { body: headerBody, signature: headerSig };
    const headerHash = await hashEpochHeaderBody(headerBody);

    const removed = new Set(roster.body.removed.map(r => r.id));
    const recipients = roster.body.devices
      .filter(d => d.id !== this.selfDeviceId && !removed.has(d.id))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const wrapChunks: VfsKeyWrapChunk[] = [];
    if (recipients.length > 0) {
      const salt = epochWrapSalt(this.roomId, epoch, headerHash);
      const chunkCount = Math.ceil(recipients.length / VFS_KEY_WRAP_MAX_RECIPIENTS_PER_CHUNK);
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
        const slice = recipients.slice(
          chunkIndex * VFS_KEY_WRAP_MAX_RECIPIENTS_PER_CHUNK,
          (chunkIndex + 1) * VFS_KEY_WRAP_MAX_RECIPIENTS_PER_CHUNK,
        );
        const wraps: Record<string, string> = {};
        for (const r of slice) {
          const info = epochWrapInfo(this.roomId, epoch, this.selfDeviceId, r.id, r.encVersion);
          wraps[r.id] = await wrapRoomKeyForRecipient(epkPair.privateKey, r.enc, roomKey, salt, info);
        }
        const chunkBody: VfsKeyWrapChunkBody = canonicalize({
          kind: 'vfs-key-wrap',
          v: VFS_PROTOCOL_VERSION,
          roomId: this.roomId,
          epoch,
          headerHash,
          chunkIndex,
          chunkCount,
          senderDeviceId: this.selfDeviceId,
          wraps,
        });
        const sig = await this.signFn(keyWrapSigPayload(chunkBody));
        wrapChunks.push({ body: chunkBody, signature: sig });
      }
    }

    const record: VfsEpochRecord = {
      epoch,
      rosterVersion: roster.body.version,
      header,
      headerHash,
      key: roomKey,
      createdAt: at,
    };
    this.epochs.set(epoch, record);
    this.currentEpoch = epoch;
    this.highestRosterVersion = Math.max(this.highestRosterVersion, roster.body.version);
    return { header, wrapChunks, record };
  }

  /**
   * Verifies and installs a host-broadcast epoch (`VfsKeyEpochHeader` + `VfsKeyWrapChunk[]`),
   * enforcing host authority, monotonicity, `prevEpochHash` chaining, and `keyCommit` equality.
   */
  async acceptEpochBroadcast(options: {
    header: unknown;
    wrapChunks: readonly unknown[];
    roster: SignedRoster;
    trustedPriorHosts?: Readonly<Record<string, string>>;
  }): Promise<VfsEpochRecord> {
    const { header, wrapChunks, roster, trustedPriorHosts } = options;
    const { headerHash, signerPublicKey } = await verifyKeyEpochHeader(header, {
      roomId: this.roomId,
      roster,
      pinnedHost: this.pinnedHost,
      trustedPriorHosts,
    });
    const typedHeader = header as VfsKeyEpochHeader;
    const b = typedHeader.body;

    // Anti-rollback & anti-equivocation checks.
    const existing = this.epochs.get(b.epoch);
    if (existing) {
      if (existing.headerHash === headerHash && existing.header.body.keyCommit === b.keyCommit) {
        return existing;
      }
      throw new VfsError('VFS_EPOCH_ROLLBACK', `Conflicting header received for already-held epoch ${b.epoch}.`);
    }
    if (b.epoch < this.currentEpoch) {
      throw new VfsError(
        'VFS_EPOCH_ROLLBACK',
        `Rejected epoch downgrade ${b.epoch} < current epoch ${this.currentEpoch}.`,
      );
    }
    if (b.rosterVersion < this.highestRosterVersion) {
      throw new VfsError(
        'VFS_EPOCH_ROLLBACK',
        `Rejected epoch bound to stale rosterVersion ${b.rosterVersion} < ${this.highestRosterVersion}.`,
      );
    }
    const prev = this.epochs.get(b.epoch - 1);
    if (b.epoch > 1 && prev && b.prevEpochHash !== prev.headerHash) {
      throw new VfsError('VFS_EPOCH_ROLLBACK', `Epoch ${b.epoch} prevEpochHash does not chain to epoch ${b.epoch - 1}.`);
    }

    // Locate and verify our recipient wrap chunk.
    let wrappedForSelf: string | undefined;
    for (const rawChunk of wrapChunks) {
      if (!isValidKeyWrapChunkShape(rawChunk)) continue;
      const cb = rawChunk.body;
      if (
        cb.roomId !== this.roomId
        || cb.epoch !== b.epoch
        || cb.headerHash !== headerHash
        || cb.senderDeviceId !== b.hostDeviceId
      ) {
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(cb.wraps, this.selfDeviceId)) continue;
      const chunkSigOk = await verify(signerPublicKey, keyWrapSigPayload(cb), rawChunk.signature);
      if (!chunkSigOk) {
        throw new VfsError('VFS_INVALID_SIGNATURE', 'Invalid host signature on VfsKeyWrapChunk.');
      }
      wrappedForSelf = cb.wraps[this.selfDeviceId];
      break;
    }

    if (!wrappedForSelf) {
      throw new VfsError('VFS_DECRYPT_FAILED', `No verified key wrap addressed to this device for epoch ${b.epoch}.`);
    }

    const salt = epochWrapSalt(this.roomId, b.epoch, headerHash);
    const info = epochWrapInfo(this.roomId, b.epoch, b.hostDeviceId, this.selfDeviceId, this.selfEncVersion);
    const roomKey = await unwrapRoomKeyFromSender(this.selfEncPrivateKey, b.epk, wrappedForSelf, salt, info);

    // Crucial: defeat host wrap-equivocation by asserting unwrapped RK_e matches host-signed keyCommit!
    const computedCommit = await computeVfsKeyCommit(this.roomId, b.epoch, roomKey);
    if (!constantTimeEqual(utf8Bytes(computedCommit), utf8Bytes(b.keyCommit))) {
      throw new VfsError('VFS_KEY_COMMIT_MISMATCH', 'Unwrapped room key does not match host-signed keyCommit.');
    }

    const now = this.now();
    if (prev && prev.revokedAt === undefined) prev.revokedAt = now;
    const record: VfsEpochRecord = {
      epoch: b.epoch,
      rosterVersion: b.rosterVersion,
      header: typedHeader,
      headerHash,
      key: roomKey,
      createdAt: b.at,
    };
    this.epochs.set(b.epoch, record);
    this.currentEpoch = b.epoch;
    this.highestRosterVersion = Math.max(this.highestRosterVersion, b.rosterVersion);
    this.pinnedHost = b.hostDeviceId;
    return record;
  }

  /**
   * Creates a delegated `VfsKeyGrantPacket` from any online admitted **human** device holding
   * `RK_1..RK_e` to a newly admitted member, companion device, or agent while the host is offline.
   * Each entry carries the original host-signed `VfsKeyEpochHeader` so the recipient verifies
   * every unwrapped key against the pinned host's `keyCommit`.
   */
  async createKeyGrant(options: {
    recipient: RosterEntry;
    roster: SignedRoster;
    epochs?: readonly number[];
  }): Promise<VfsKeyGrantPacket> {
    const { recipient, roster } = options;
    if (roster.body.room !== this.roomId) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'SignedRoster room mismatch.');
    }
    const active = this.requireActiveEpoch();
    const minRosterVersion = Math.max(active.rosterVersion, this.highestRosterVersion);
    if (!Number.isInteger(roster.body.version) || roster.body.version < minRosterVersion) {
      throw new VfsError(
        'VFS_EPOCH_ROLLBACK',
        `Cannot issue VFS key grant under stale rosterVersion ${roster.body.version} < ${minRosterVersion}.`,
      );
    }

    const removed = new Set(roster.body.removed.map(r => r.id));
    if (removed.has(this.selfDeviceId)) {
      throw new VfsError('VFS_EPOCH_UNAUTHORIZED', 'Removed device may not issue a VFS key grant.', { status: 403 });
    }
    if (removed.has(recipient.id)) {
      throw new VfsError('VFS_EPOCH_UNAUTHORIZED', 'Cannot issue a VFS key grant to a removed device.', { status: 403 });
    }

    // Only an active admitted human device may grant room keys.
    const selfEntry = roster.body.devices.find(d => d.id === this.selfDeviceId);
    if (!selfEntry || selfEntry.role !== 'human') {
      throw new VfsError(
        'VFS_EPOCH_UNAUTHORIZED',
        'Only an admitted human device may issue a VFS key grant.',
        { status: 403 },
      );
    }
    if (recipient.id === this.selfDeviceId) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'Cannot issue a VFS key grant to self.');
    }

    // Recipient must be in the verified roster OR carry a valid delegated entry cert.
    const inRoster = roster.body.devices.find(d => d.id === recipient.id);
    if (inRoster) {
      if (inRoster.enc !== recipient.enc || inRoster.encVersion !== recipient.encVersion) {
        throw new VfsError('VFS_EPOCH_UNAUTHORIZED', 'Recipient encryption key does not match verified roster.');
      }
    } else {
      const delegated = await verifyDelegatedRosterEntry(recipient, roster, this.roomId);
      if (!delegated.ok) {
        throw new VfsError('VFS_EPOCH_UNAUTHORIZED', `Recipient is not authorized for key grant: ${delegated.reason}`);
      }
    }

    const requestedEpochs = options.epochs ? [...new Set(options.epochs)].sort((a, b) => a - b) : this.listEpochs();
    if (requestedEpochs.length === 0) {
      throw new VfsError('VFS_EPOCH_UNINITIALIZED', 'No room key epochs available to grant.');
    }

    const epkPair = await generateEncKeyPair(false);
    const epk = await exportRawPublicKey(epkPair.publicKey);
    const entries: VfsKeyGrantEntry[] = [];

    for (const epoch of requestedEpochs) {
      const rec = this.epochs.get(epoch);
      if (!rec) {
        throw new VfsError('VFS_EPOCH_UNKNOWN', `Keyring does not hold epoch ${epoch}.`);
      }
      const salt = grantWrapSalt(this.roomId, epoch, rec.headerHash);
      const info = grantWrapInfo(this.roomId, epoch, this.selfDeviceId, recipient.id, recipient.encVersion);
      const wrappedKey = await wrapRoomKeyForRecipient(epkPair.privateKey, recipient.enc, rec.key, salt, info);
      entries.push({ header: rec.header, wrappedKey });
    }

    const body: VfsKeyGrantBody = canonicalize({
      kind: 'vfs-key-grant',
      v: VFS_PROTOCOL_VERSION,
      roomId: this.roomId,
      rosterVersion: roster.body.version,
      granterDeviceId: this.selfDeviceId,
      recipientDeviceId: recipient.id,
      recipientEncVersion: recipient.encVersion,
      epk,
      at: this.now(),
      entries,
    });
    const signature = await this.signFn(keyGrantSigPayload(body));
    this.highestRosterVersion = Math.max(this.highestRosterVersion, roster.body.version);
    return { body, signature };
  }

  /**
   * Verifies and installs a `VfsKeyGrantPacket` from an online admitted human peer while the host
   * is offline. Every epoch key is cryptographically verified against its original host-signed
   * `VfsKeyEpochHeader` and `keyCommit` — a malicious granter cannot forge or substitute `RK_e`.
   */
  async acceptKeyGrant(options: {
    grant: unknown;
    roster: SignedRoster;
    trustedPriorHosts?: Readonly<Record<string, string>>;
  }): Promise<VfsEpochRecord[]> {
    const { grant, roster, trustedPriorHosts } = options;
    if (!isValidKeyGrantPacketShape(grant)) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'Malformed VfsKeyGrantPacket.');
    }
    const b = grant.body;
    if (b.roomId !== this.roomId || roster.body.room !== this.roomId) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'VfsKeyGrantPacket room mismatch.');
    }
    if (b.recipientDeviceId !== this.selfDeviceId || b.recipientEncVersion !== this.selfEncVersion) {
      throw new VfsError('VFS_DECRYPT_FAILED', 'VfsKeyGrantPacket is not addressed to this device/encVersion.');
    }
    if (b.rosterVersion < this.highestRosterVersion || roster.body.version < this.highestRosterVersion) {
      throw new VfsError(
        'VFS_EPOCH_ROLLBACK',
        `Rejected key grant bound to stale rosterVersion ${Math.min(b.rosterVersion, roster.body.version)} < ${this.highestRosterVersion}.`,
      );
    }

    // Verify granter is an active non-removed human device in the verified roster.
    const removed = new Set(roster.body.removed.map(r => r.id));
    if (removed.has(b.granterDeviceId)) {
      throw new VfsError('VFS_EPOCH_UNAUTHORIZED', 'Key granter has been removed from the room.');
    }
    const granter = roster.body.devices.find(d => d.id === b.granterDeviceId);
    if (!granter || granter.role !== 'human') {
      throw new VfsError('VFS_EPOCH_UNAUTHORIZED', 'Key grant must be signed by an admitted human device.');
    }
    const grantSigOk = await verify(granter.sign, keyGrantSigPayload(b), grant.signature);
    if (!grantSigOk) {
      throw new VfsError('VFS_INVALID_SIGNATURE', 'Invalid granter signature on VfsKeyGrantPacket.');
    }

    // Validate epk point up front.
    try {
      await importEncPublicKey(b.epk);
    } catch (cause) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid ephemeral P-256 key in VfsKeyGrantPacket.', { cause });
    }

    // Stage and verify EVERY entry atomically before mutating keyring state.
    const staged: VfsEpochRecord[] = [];
    const stagedByEpoch = new Map<number, VfsEpochRecord>();
    let lastEpoch = 0;

    for (const entry of b.entries) {
      const epoch = entry.header.body.epoch;
      if (epoch <= lastEpoch) {
        throw new VfsError('VFS_INVALID_ENVELOPE', 'VfsKeyGrantPacket entries must be strictly ascending by epoch.');
      }
      lastEpoch = epoch;

      const { headerHash } = await verifyKeyEpochHeader(entry.header, {
        roomId: this.roomId,
        roster,
        pinnedHost: this.pinnedHost,
        trustedPriorHosts,
        allowPriorHost: !!trustedPriorHosts,
      });

      const existing = this.epochs.get(epoch);
      if (existing && (existing.headerHash !== headerHash || existing.header.body.keyCommit !== entry.header.body.keyCommit)) {
        throw new VfsError('VFS_EPOCH_ROLLBACK', `Conflicting header in key grant for held epoch ${epoch}.`);
      }

      // Check prevEpochHash and rosterVersion monotonicity against staged or already-held epoch - 1.
      const prev = stagedByEpoch.get(epoch - 1) ?? this.epochs.get(epoch - 1);
      if (epoch > 1 && prev) {
        if (entry.header.body.prevEpochHash !== prev.headerHash) {
          throw new VfsError('VFS_EPOCH_ROLLBACK', `Key grant epoch ${epoch} prevEpochHash does not chain to epoch ${epoch - 1}.`);
        }
        if (entry.header.body.rosterVersion < prev.rosterVersion) {
          throw new VfsError('VFS_EPOCH_ROLLBACK', `Key grant epoch ${epoch} regressed rosterVersion.`);
        }
      }
      // Forward-chain check on historical backfill: if epoch + 1 is already held, its prevEpochHash MUST match this epoch!
      const next = this.epochs.get(epoch + 1);
      if (next) {
        if (next.header.body.prevEpochHash !== headerHash) {
          throw new VfsError('VFS_EPOCH_ROLLBACK', `Backfilled epoch ${epoch} does not match held epoch ${epoch + 1} prevEpochHash.`);
        }
        if (entry.header.body.rosterVersion > next.rosterVersion) {
          throw new VfsError('VFS_EPOCH_ROLLBACK', `Backfilled epoch ${epoch} rosterVersion exceeds held epoch ${epoch + 1}.`);
        }
      }

      const salt = grantWrapSalt(this.roomId, epoch, headerHash);
      const info = grantWrapInfo(this.roomId, epoch, b.granterDeviceId, this.selfDeviceId, this.selfEncVersion);
      const roomKey = await unwrapRoomKeyFromSender(this.selfEncPrivateKey, b.epk, entry.wrappedKey, salt, info);

      // Verify unwrapped key matches the original HOST-signed keyCommit!
      const computedCommit = await computeVfsKeyCommit(this.roomId, epoch, roomKey);
      if (!constantTimeEqual(utf8Bytes(computedCommit), utf8Bytes(entry.header.body.keyCommit))) {
        throw new VfsError('VFS_KEY_COMMIT_MISMATCH', `Granted key for epoch ${epoch} failed host keyCommit verification.`);
      }

      const record: VfsEpochRecord = existing ?? {
        epoch,
        rosterVersion: entry.header.body.rosterVersion,
        header: entry.header,
        headerHash,
        key: roomKey,
        createdAt: entry.header.body.at,
      };
      staged.push(record);
      stagedByEpoch.set(epoch, record);
    }

    // Commit atomically once every entry verified.
    for (const rec of staged) {
      this.epochs.set(rec.epoch, rec);
      if (rec.epoch > this.currentEpoch) this.currentEpoch = rec.epoch;
      if (rec.rosterVersion > this.highestRosterVersion) this.highestRosterVersion = rec.rosterVersion;
      if (rec.header.body.hostDeviceId === roster.body.host) {
        this.pinnedHost = rec.header.body.hostDeviceId;
      }
    }
    return staged;
  }
}
