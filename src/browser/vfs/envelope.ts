/**
 * Binary `VfsEnvelopeV1` encryption, decryption, canonical CID hashing, and P-256 ECDSA
 * signing/verification (`docs/flows/room-vfs.md` §4).
 *
 * Uses strictly native WebCrypto (`crypto.subtle`) with zero external dependencies so it runs
 * identically in browsers (under strict CSP `script-src 'self'`) and Bun.
 */

import { verify } from '../protocol';
import {
  base64ToBytes,
  bytesToBase64,
  canonicalJson,
  canonicalize,
  importEncPrivateJwk,
  importEncPublicKey,
  type SignFn,
  type StateSecretInput,
} from '../relay-crypto';
import {
  VFS_DEVICE_SEAL_INFO_DOMAIN,
  VFS_DEVICE_SEAL_SALT_DOMAIN,
  VFS_ENVELOPE_HEADER_BYTES,
  VFS_ENVELOPE_IV_BYTES,
  VFS_ENVELOPE_MAGIC,
  VFS_ENVELOPE_OVERHEAD_BYTES,
  VFS_ENVELOPE_SALT_BYTES,
  VFS_ENVELOPE_TAG_BYTES,
  VFS_ENVELOPE_VERSION,
  VFS_FLAG_DEFLATE_RAW,
  VFS_KEY_BYTES,
  VFS_MAX_SNAP_DECOMPRESSED_BYTES,
  VFS_MAX_SNAP_DEFLATE_RATIO,
  VFS_OBJ_HKDF_DOMAIN,
  VFS_OP_HKDF_DOMAIN,
  VFS_OP_MAX_PLAINTEXT_BYTES,
  VFS_SALT_DOMAIN,
  VFS_SIG_DOMAIN,
  VfsError,
  VfsObjKind,
  isDeterministicVfsObjKind,
  isValidVfsObjKind,
  type VfsObjKindValue,
} from './constants';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const HEX_64 = /^[a-f0-9]{64}$/;
const MAX_U32 = 0xffff_ffff;

/** NIST P-256 (secp256r1) curve group order `n` and low-S threshold `floor(n / 2)`. */
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF_N = P256_N >> 1n;

/**
 * Nothing-up-my-sleeve P-256 curve point H (identical to `src/browser/relay-crypto.ts`),
 * used to derive a device's 256-bit at-rest sealing key `K_device_seal` from its non-extractable
 * P-256 ECDH private CryptoKey via `ECDH(d, H) -> HKDF`.
 */
const DEVICE_SEAL_H_RAW_B64 = 'BMVUY4MGpKocsOUXFPY+wR3TRhcyCY3fZXjuiwwGMC4Po0wV+BLfeoe37hLy1CtMRSrReoiPvmi5jBdGr4jWoKY=';

let deviceSealPointPromise: Promise<CryptoKey> | undefined;
function getDeviceSealPoint(): Promise<CryptoKey> {
  return (deviceSealPointPromise ||= importEncPublicKey(DEVICE_SEAL_H_RAW_B64));
}

export type VfsEnvelopeHeader = {
  version: typeof VFS_ENVELOPE_VERSION;
  objKind: VfsObjKindValue;
  flags: number;
  epoch: number;
  salt: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
};

export type SealVfsEnvelopeOptions = {
  roomId: string;
  epoch: number;
  objKind: VfsObjKindValue;
  /** 32-byte `RK_e` (0x01/0x03/0x04/0x05/room-snap), 32-byte `BK` (0x06 chunk), or 32-byte `K_device_seal` (0x10/local-snap). */
  key: Uint8Array;
  plaintext: Uint8Array;
  /**
   * Binding key authenticated in unified AAD:
   * - `0x01 / 0x03 / 0x04`: `opBindingKey(deviceId, seq, opId)` (`deviceId:seq:opId`)
   * - `0x05 / 0x06`: `nodeId`
   * - `0x10 / 0x02`: `kvKey`
   */
  bindingKey: string;
  /** Optional header flags byte (only `VFS_FLAG_DEFLATE_RAW` on `VfsObjKind.Snap`). */
  flags?: number;
};

export type SealedVfsEnvelope = {
  bytes: Uint8Array<ArrayBuffer>;
  cid: string;
  /** 64-hex `SHA-256(plaintext)` (populated for deterministic signed ops/commits `0x01/0x03/0x04`). */
  opHash?: string;
  header: VfsEnvelopeHeader;
};

export type OpenVfsEnvelopeOptions = {
  bytes: Uint8Array;
  roomId: string;
  key: Uint8Array;
  bindingKey: string;
  expectedObjKind?: VfsObjKindValue;
  expectedEpoch?: number;
  expectedCid?: string;
};

export type OpenedVfsEnvelope = {
  plaintext: Uint8Array<ArrayBuffer>;
  cid: string;
  /** 64-hex `SHA-256(plaintext)` (populated for deterministic signed ops/commits `0x01/0x03/0x04`). */
  opHash?: string;
  header: VfsEnvelopeHeader;
};

export type VfsSignedPayload<T = Record<string, unknown>> = {
  body: T;
  signature: string;
};

export type VfsSignedOpKind = 'vfs-doc-op' | 'vfs-commit' | 'vfs-tree-op';

export type VfsSignedOpHeaderFields = {
  kind: VfsSignedOpKind;
  roomId: string;
  epoch: number;
  deviceId: string;
  seq: number;
  opId: string;
  nodeId?: string;
};

/** Maps a deterministic binary `VfsObjKind` to its required inner `body.kind`. */
export function expectedBodyKindForObjKind(
  objKind: typeof VfsObjKind.DocOp | typeof VfsObjKind.Commit | typeof VfsObjKind.TreeOp,
): VfsSignedOpKind {
  switch (objKind) {
    case VfsObjKind.DocOp:
      return 'vfs-doc-op';
    case VfsObjKind.Commit:
      return 'vfs-commit';
    case VfsObjKind.TreeOp:
      return 'vfs-tree-op';
  }
}

// ---------------------------------------------------------------------------
// Low-level byte & hash helpers
// ---------------------------------------------------------------------------

export function utf8Bytes(text: string): Uint8Array<ArrayBuffer> {
  return textEncoder.encode(text) as Uint8Array<ArrayBuffer>;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function toArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export async function sha256Bytes(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBufferView(bytes));
  return new Uint8Array(digest);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(await sha256Bytes(bytes));
}

/** Canonical content identifier: `hex(SHA-256(envelopeBytes))`. */
export async function computeCid(envelopeBytes: Uint8Array): Promise<string> {
  return sha256Hex(envelopeBytes);
}

/** Canonical op hash over inner signed payload bytes: `SHA-256(innerBytes)`. */
export async function computeOpHash(innerBytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return sha256Bytes(innerBytes);
}

export async function computeOpHashHex(innerBytes: Uint8Array): Promise<string> {
  return bytesToHex(await computeOpHash(innerBytes));
}

/** Generates a fresh random 256-bit key (e.g. per-block `BK` for CAS chunks or new epoch `RK_e`). */
export function generateVfsKey(): Uint8Array<ArrayBuffer> {
  const key = new Uint8Array(new ArrayBuffer(VFS_KEY_BYTES));
  crypto.getRandomValues(key);
  return key;
}

/** Formats the canonical AAD `bindingKey` for signed ops/commits (`deviceId:seq:opId`). */
export function opBindingKey(deviceId: string, seq: number, opId: string): string {
  if (typeof deviceId !== 'string' || !HEX_64.test(deviceId)) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid op deviceId for bindingKey.');
  }
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid op seq for bindingKey.');
  }
  if (typeof opId !== 'string' || opId.length === 0 || opId.length > 128 || opId.includes('\0') || opId.includes(':')) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid opId for bindingKey.');
  }
  return `${deviceId}:${seq}:${opId}`;
}

/**
 * Derives a room-and-device-scoped 32-byte at-rest sealing key `K_device_seal` from the device's
 * non-extractable ECDH private key (or JWK / raw secret), matching `deriveStateKey` in `relay-crypto.ts`.
 */
export async function deriveVfsDeviceSealKey(
  encPrivateKeyOrSecret: StateSecretInput,
  context: { roomId: string; deviceId: string },
): Promise<Uint8Array<ArrayBuffer>> {
  if (!context.roomId || !context.deviceId) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Device seal key derivation requires roomId and deviceId.');
  }
  let ikm: ArrayBuffer;
  if (encPrivateKeyOrSecret instanceof Uint8Array) {
    if (encPrivateKeyOrSecret.byteLength < 16) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'Device seal secret must be at least 16 bytes.');
    }
    ikm = toArrayBufferView(encPrivateKeyOrSecret).buffer;
  } else if (typeof CryptoKey !== 'undefined' && encPrivateKeyOrSecret instanceof CryptoKey) {
    const pointH = await getDeviceSealPoint();
    ikm = await crypto.subtle.deriveBits({ name: 'ECDH', public: pointH }, encPrivateKeyOrSecret, 256);
  } else if (encPrivateKeyOrSecret && typeof encPrivateKeyOrSecret === 'object' && !Array.isArray(encPrivateKeyOrSecret)) {
    const privKey = await importEncPrivateJwk(encPrivateKeyOrSecret as JsonWebKey, false);
    const pointH = await getDeviceSealPoint();
    ikm = await crypto.subtle.deriveBits({ name: 'ECDH', public: pointH }, privKey, 256);
  } else {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Unsupported device seal key material.');
  }

  const hkdfKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const salt = utf8Bytes(`${VFS_DEVICE_SEAL_SALT_DOMAIN}${context.roomId}`);
  const info = utf8Bytes(`${VFS_DEVICE_SEAL_INFO_DOMAIN}${context.roomId}|${context.deviceId}`);
  const derived = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, hkdfKey, VFS_KEY_BYTES * 8);
  return new Uint8Array(derived);
}

// ---------------------------------------------------------------------------
// Header validation & AAD construction
// ---------------------------------------------------------------------------

function validateKeyBytes(key: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(key instanceof Uint8Array) || key.byteLength !== VFS_KEY_BYTES) {
    throw new VfsError('VFS_INVALID_ENVELOPE', `VFS encryption key must be exactly ${VFS_KEY_BYTES} bytes.`);
  }
  return toArrayBufferView(key);
}

function validateRoomAndBinding(roomId: string, bindingKey: string): void {
  if (typeof roomId !== 'string' || roomId.length === 0 || roomId.includes('\0')) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid roomId for VFS envelope.');
  }
  if (typeof bindingKey !== 'string' || bindingKey.includes('\0')) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid bindingKey for VFS envelope.');
  }
}

function validateEpochAndFlags(objKind: VfsObjKindValue, epoch: number, flags: number): void {
  if (!Number.isInteger(epoch) || epoch < 0 || epoch > MAX_U32) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid VFS envelope epoch.');
  }
  if (objKind === VfsObjKind.DeviceLocal) {
    if (epoch !== 0) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'Local VFS envelopes must use epoch 0.');
    }
  } else if (objKind !== VfsObjKind.Snap) {
    if (epoch < 1) {
      throw new VfsError('VFS_INVALID_ENVELOPE', `Room VFS object kind 0x${objKind.toString(16)} requires epoch >= 1.`);
    }
  }
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xff) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid VFS envelope flags.');
  }
  if (flags !== 0) {
    if (objKind !== VfsObjKind.Snap || flags !== VFS_FLAG_DEFLATE_RAW) {
      throw new VfsError('VFS_INVALID_ENVELOPE', `Unsupported flags 0x${flags.toString(16)} for objKind 0x${objKind.toString(16)}.`);
    }
  }
}

function encodeEnvelopeHeader(
  objKind: VfsObjKindValue,
  flags: number,
  epoch: number,
  salt16: Uint8Array,
  iv12: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(new ArrayBuffer(VFS_ENVELOPE_HEADER_BYTES));
  header.set(VFS_ENVELOPE_MAGIC, 0);
  header[4] = VFS_ENVELOPE_VERSION;
  header[5] = objKind;
  header[6] = flags;
  header[7] = 0x00; // reserved
  new DataView(header.buffer).setUint32(8, epoch, false);
  header.set(salt16, 12);
  header.set(iv12, 28);
  return header;
}

/** Parses and validates the 40-byte `VfsEnvelopeV1` header without decrypting. */
export function parseVfsEnvelopeHeader(bytes: Uint8Array): VfsEnvelopeHeader {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < VFS_ENVELOPE_OVERHEAD_BYTES) {
    throw new VfsError('VFS_INVALID_ENVELOPE', `Truncated VFS envelope (minimum ${VFS_ENVELOPE_OVERHEAD_BYTES} bytes).`);
  }
  for (let i = 0; i < VFS_ENVELOPE_MAGIC.length; i++) {
    if (bytes[i] !== VFS_ENVELOPE_MAGIC[i]) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid VFS envelope magic.');
    }
  }
  if (bytes[4] !== VFS_ENVELOPE_VERSION) {
    throw new VfsError('VFS_INVALID_ENVELOPE', `Unsupported VFS envelope version ${bytes[4]}.`);
  }
  const objKind = bytes[5];
  if (!isValidVfsObjKind(objKind)) {
    throw new VfsError('VFS_INVALID_ENVELOPE', `Unknown VFS envelope objKind 0x${objKind.toString(16)}.`);
  }
  const flags = bytes[6];
  if (bytes[7] !== 0x00) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Non-zero reserved byte in VFS envelope header.');
  }
  const epoch = new DataView(bytes.buffer, bytes.byteOffset, VFS_ENVELOPE_HEADER_BYTES).getUint32(8, false);
  validateEpochAndFlags(objKind, epoch, flags);

  const salt = new Uint8Array(new ArrayBuffer(VFS_ENVELOPE_SALT_BYTES));
  salt.set(bytes.subarray(12, 28));
  const iv = new Uint8Array(new ArrayBuffer(VFS_ENVELOPE_IV_BYTES));
  iv.set(bytes.subarray(28, 40));

  return { version: VFS_ENVELOPE_VERSION, objKind, flags, epoch, salt, iv };
}

/**
 * Unified AAD for `VfsEnvelopeV1`: `header[0..40] || utf8(roomId) || utf8(bindingKey)`.
 * Binds version, objKind, flags, reserved, epoch, salt16, iv, roomId, and object binding key.
 */
export function buildVfsEnvelopeAad(header40: Uint8Array, roomId: string, bindingKey: string): Uint8Array<ArrayBuffer> {
  if (header40.byteLength !== VFS_ENVELOPE_HEADER_BYTES) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'VFS AAD requires exact 40-byte header.');
  }
  validateRoomAndBinding(roomId, bindingKey);
  return concatBytes(header40, utf8Bytes(roomId), utf8Bytes(bindingKey));
}

// ---------------------------------------------------------------------------
// Two-step keyed deterministic derivation (0x01, 0x03, 0x04) & random-IV HKDF
// ---------------------------------------------------------------------------

/**
 * Step 1 for signed ops/commits (`0x01`, `0x03`, `0x04`):
 * `salt16 = HMAC-SHA256(RK_e, "meshrooms-vfs-salt-v1|" || opHash)[0..16]`.
 */
export async function deriveDeterministicOpSalt(
  roomKey: Uint8Array,
  opHash: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const keyBuf = validateKeyBytes(roomKey);
  if (opHash.byteLength !== 32) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'opHash must be 32 bytes.');
  }
  const hmacKey = await crypto.subtle.importKey('raw', keyBuf, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', hmacKey, concatBytes(utf8Bytes(VFS_SALT_DOMAIN), opHash));
  const out = new Uint8Array(new ArrayBuffer(VFS_ENVELOPE_SALT_BYTES));
  out.set(new Uint8Array(mac).subarray(0, VFS_ENVELOPE_SALT_BYTES));
  return out;
}

/**
 * Step 2 for signed ops/commits (`0x01`, `0x03`, `0x04`):
 * `(K_op[32], iv[12]) = HKDF-SHA256(RK_e, salt = salt16, info = "meshrooms-vfs-op-v1|" || roomId || "|" || epoch || "|" || objKind)`.
 */
async function deriveDeterministicOpKeyAndIv(
  roomKey: Uint8Array<ArrayBuffer>,
  salt16: Uint8Array<ArrayBuffer>,
  roomId: string,
  epoch: number,
  objKind: VfsObjKindValue,
  usage: 'encrypt' | 'decrypt',
): Promise<{ aesKey: CryptoKey; iv: Uint8Array<ArrayBuffer> }> {
  const hkdfKey = await crypto.subtle.importKey('raw', roomKey, 'HKDF', false, ['deriveBits']);
  const info = utf8Bytes(`${VFS_OP_HKDF_DOMAIN}${roomId}|${epoch}|${objKind}`);
  const okm = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: salt16, info },
      hkdfKey,
      (VFS_KEY_BYTES + VFS_ENVELOPE_IV_BYTES) * 8,
    ),
  );
  const keyBytes = new Uint8Array(new ArrayBuffer(VFS_KEY_BYTES));
  keyBytes.set(okm.subarray(0, VFS_KEY_BYTES));
  const iv = new Uint8Array(new ArrayBuffer(VFS_ENVELOPE_IV_BYTES));
  iv.set(okm.subarray(VFS_KEY_BYTES, VFS_KEY_BYTES + VFS_ENVELOPE_IV_BYTES));
  const aesKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [usage]);
  return { aesKey, iv };
}

/**
 * Per-object HKDF key for random-IV envelopes (`0x02`, `0x05`, `0x06`, `0x10`):
 * `K_obj[32] = HKDF-SHA256(baseKey, salt = salt16, info = "meshrooms-vfs-obj-v1|" || roomId || "|" || epoch || "|" || objKind)`.
 */
async function deriveRandomObjKey(
  baseKey: Uint8Array<ArrayBuffer>,
  salt16: Uint8Array<ArrayBuffer>,
  roomId: string,
  epoch: number,
  objKind: VfsObjKindValue,
  usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey('raw', baseKey, 'HKDF', false, ['deriveKey']);
  const info = utf8Bytes(`${VFS_OBJ_HKDF_DOMAIN}${roomId}|${epoch}|${objKind}`);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: salt16, info },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

// ---------------------------------------------------------------------------
// Seal & Open VfsEnvelopeV1
// ---------------------------------------------------------------------------

/** Encrypts `plaintext` into a canonical binary `VfsEnvelopeV1` (56-byte overhead). */
export async function sealVfsEnvelope(options: SealVfsEnvelopeOptions): Promise<SealedVfsEnvelope> {
  const { roomId, epoch, objKind, bindingKey } = options;
  if (!isValidVfsObjKind(objKind)) {
    throw new VfsError('VFS_INVALID_ENVELOPE', `Unknown VFS object kind: ${String(objKind)}.`);
  }
  const flags = options.flags ?? 0;
  validateEpochAndFlags(objKind, epoch, flags);
  validateRoomAndBinding(roomId, bindingKey);
  const keyBuf = validateKeyBytes(options.key);
  const plainBuf = toArrayBufferView(options.plaintext);
  if (isDeterministicVfsObjKind(objKind) && plainBuf.byteLength > VFS_OP_MAX_PLAINTEXT_BYTES) {
    throw new VfsError(
      'VFS_LIMIT_EXCEEDED',
      `Signed VFS op plaintext (${plainBuf.byteLength} bytes) exceeds ${VFS_OP_MAX_PLAINTEXT_BYTES}-byte limit.`,
    );
  }
  if (objKind === VfsObjKind.Snap && plainBuf.byteLength > VFS_MAX_SNAP_DECOMPRESSED_BYTES) {
    throw new VfsError(
      'VFS_LIMIT_EXCEEDED',
      `VFS snapshot payload (${plainBuf.byteLength} bytes) exceeds ${VFS_MAX_SNAP_DECOMPRESSED_BYTES}-byte limit.`,
    );
  }

  let salt: Uint8Array<ArrayBuffer>;
  let iv: Uint8Array<ArrayBuffer>;
  let aesKey: CryptoKey;
  let opHashHex: string | undefined;

  if (isDeterministicVfsObjKind(objKind)) {
    const opHashBytes = await computeOpHash(plainBuf);
    opHashHex = bytesToHex(opHashBytes);
    salt = await deriveDeterministicOpSalt(keyBuf, opHashBytes);
    const derived = await deriveDeterministicOpKeyAndIv(keyBuf, salt, roomId, epoch, objKind, 'encrypt');
    aesKey = derived.aesKey;
    iv = derived.iv;
  } else {
    salt = new Uint8Array(new ArrayBuffer(VFS_ENVELOPE_SALT_BYTES));
    crypto.getRandomValues(salt);
    iv = new Uint8Array(new ArrayBuffer(VFS_ENVELOPE_IV_BYTES));
    crypto.getRandomValues(iv);
    aesKey = await deriveRandomObjKey(keyBuf, salt, roomId, epoch, objKind, 'encrypt');
  }

  const headerBytes = encodeEnvelopeHeader(objKind, flags, epoch, salt, iv);
  const aad = buildVfsEnvelopeAad(headerBytes, roomId, bindingKey);
  const ctAndTag = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, aesKey, plainBuf),
  );
  const bytes = concatBytes(headerBytes, ctAndTag);
  const cid = await computeCid(bytes);

  return {
    bytes,
    cid,
    ...(opHashHex !== undefined ? { opHash: opHashHex } : {}),
    header: { version: VFS_ENVELOPE_VERSION, objKind, flags, epoch, salt, iv },
  };
}

/**
 * Verifies header, optional CID, unified AAD, deterministic `(salt16, iv)` anti-malleability
 * invariants (for `0x01/0x03/0x04`), and decrypts `VfsEnvelopeV1`.
 */
export async function openVfsEnvelope(options: OpenVfsEnvelopeOptions): Promise<OpenedVfsEnvelope> {
  const { bytes, roomId, bindingKey, expectedObjKind, expectedEpoch, expectedCid } = options;
  validateRoomAndBinding(roomId, bindingKey);
  const keyBuf = validateKeyBytes(options.key);
  const envBuf = toArrayBufferView(bytes);

  const cid = await computeCid(envBuf);
  if (expectedCid !== undefined && cid !== expectedCid.toLowerCase()) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'VFS envelope CID mismatch.');
  }

  const header = parseVfsEnvelopeHeader(envBuf);
  if (expectedObjKind !== undefined && header.objKind !== expectedObjKind) {
    throw new VfsError(
      'VFS_INVALID_ENVELOPE',
      `Unexpected VFS objKind 0x${header.objKind.toString(16)} (expected 0x${expectedObjKind.toString(16)}).`,
    );
  }
  if (expectedEpoch !== undefined && header.epoch !== expectedEpoch) {
    throw new VfsError(
      'VFS_INVALID_ENVELOPE',
      `Unexpected VFS epoch ${header.epoch} (expected ${expectedEpoch}).`,
    );
  }

  const headerBytes = envBuf.subarray(0, VFS_ENVELOPE_HEADER_BYTES);
  const ctAndTag = envBuf.subarray(VFS_ENVELOPE_HEADER_BYTES);
  const expectedPlainBytes = ctAndTag.byteLength - VFS_ENVELOPE_TAG_BYTES;
  if (isDeterministicVfsObjKind(header.objKind) && expectedPlainBytes > VFS_OP_MAX_PLAINTEXT_BYTES) {
    throw new VfsError(
      'VFS_LIMIT_EXCEEDED',
      `Signed VFS op plaintext (${expectedPlainBytes} bytes) exceeds ${VFS_OP_MAX_PLAINTEXT_BYTES}-byte limit.`,
    );
  }
  if (header.objKind === VfsObjKind.Snap && expectedPlainBytes > VFS_MAX_SNAP_DECOMPRESSED_BYTES) {
    throw new VfsError(
      'VFS_LIMIT_EXCEEDED',
      `VFS snapshot payload (${expectedPlainBytes} bytes) exceeds ${VFS_MAX_SNAP_DECOMPRESSED_BYTES}-byte limit.`,
    );
  }
  const aad = buildVfsEnvelopeAad(headerBytes, roomId, bindingKey);

  if (isDeterministicVfsObjKind(header.objKind)) {
    const { aesKey, iv: expectedIv } = await deriveDeterministicOpKeyAndIv(
      keyBuf,
      header.salt,
      roomId,
      header.epoch,
      header.objKind,
      'decrypt',
    );
    // Reject substituted IVs before invoking AES-GCM.
    if (!constantTimeEqual(header.iv, expectedIv)) {
      throw new VfsError('VFS_MALLEABLE_ENVELOPE', 'VFS deterministic op IV does not match derived HKDF IV.');
    }

    let plainBuf: ArrayBuffer;
    try {
      plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: header.iv, additionalData: aad }, aesKey, ctAndTag);
    } catch (cause) {
      throw new VfsError('VFS_DECRYPT_FAILED', 'VFS deterministic op authentication or decryption failed.', { cause });
    }

    const plaintext = new Uint8Array(plainBuf);
    const opHashBytes = await computeOpHash(plaintext);
    const expectedSalt = await deriveDeterministicOpSalt(keyBuf, opHashBytes);
    // Defeat insider salt substitution (another member holding RK_e cannot re-encrypt with a different salt16).
    if (!constantTimeEqual(header.salt, expectedSalt)) {
      throw new VfsError('VFS_MALLEABLE_ENVELOPE', 'VFS deterministic op salt16 does not match HMAC commitment.');
    }

    return { plaintext, cid, opHash: bytesToHex(opHashBytes), header };
  }

  const aesKey = await deriveRandomObjKey(keyBuf, header.salt, roomId, header.epoch, header.objKind, 'decrypt');
  let plainBuf: ArrayBuffer;
  try {
    plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: header.iv, additionalData: aad }, aesKey, ctAndTag);
  } catch (cause) {
    throw new VfsError('VFS_DECRYPT_FAILED', 'VFS envelope authentication or decryption failed.', { cause });
  }

  return { plaintext: new Uint8Array(plainBuf), cid, header };
}

// ---------------------------------------------------------------------------
// Bounded `deflate-raw` snapshot compression helpers (zip-bomb safe)
// ---------------------------------------------------------------------------

/** Compresses a snapshot payload using `deflate-raw`, enforcing `VFS_MAX_SNAP_DECOMPRESSED_BYTES`. */
export async function deflateSnapPayload(raw: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const input = toArrayBufferView(raw);
  if (input.byteLength > VFS_MAX_SNAP_DECOMPRESSED_BYTES) {
    throw new VfsError(
      'VFS_LIMIT_EXCEEDED',
      `Snapshot raw payload (${input.byteLength} bytes) exceeds ${VFS_MAX_SNAP_DECOMPRESSED_BYTES}-byte ceiling.`,
    );
  }
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const writePromise = writer.write(input).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    await writePromise;
  } catch (cause) {
    await reader.cancel().catch(() => {});
    await writePromise.catch(() => {});
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Failed to deflate snapshot payload.', { cause });
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Inflates a `deflate-raw` snapshot payload with streaming byte-budget enforcement
 * (`VFS_MAX_SNAP_DEFLATE_RATIO` and `VFS_MAX_SNAP_DECOMPRESSED_BYTES`) to prevent zip-bombs.
 */
export async function inflateSnapPayload(
  compressed: Uint8Array,
  options?: { maxRatio?: number; maxBytes?: number },
): Promise<Uint8Array<ArrayBuffer>> {
  const input = toArrayBufferView(compressed);
  const maxRatio = options?.maxRatio ?? VFS_MAX_SNAP_DEFLATE_RATIO;
  const maxBytes = options?.maxBytes ?? VFS_MAX_SNAP_DECOMPRESSED_BYTES;
  if (input.byteLength === 0) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Empty deflate-raw snapshot payload.');
  }
  if (input.byteLength > maxBytes) {
    throw new VfsError(
      'VFS_LIMIT_EXCEEDED',
      `Compressed snapshot (${input.byteLength} bytes) exceeds ${maxBytes}-byte ceiling.`,
    );
  }
  const limit = Math.min(maxBytes, input.byteLength * maxRatio);
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const writePromise = writer.write(input).then(() => writer.close()).catch(() => {});
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        await writer.abort().catch(() => {});
        throw new VfsError(
          'VFS_LIMIT_EXCEEDED',
          `Inflated snapshot exceeded bound (${limit} bytes; max ${maxRatio}x ratio / ${maxBytes} B ceiling).`,
        );
      }
      chunks.push(value);
    }
    await writePromise;
  } catch (err) {
    if (err instanceof VfsError) throw err;
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Failed to inflate deflate-raw snapshot payload.', { cause: err });
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// P-256 ECDSA low-S canonicalization (anti-malleability for deterministic CIDs)
// ---------------------------------------------------------------------------

function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let acc = 0n;
  for (let i = 0; i < bytes.byteLength; i++) {
    acc = (acc << 8n) | BigInt(bytes[i]!);
  }
  return acc;
}

function bigIntToBytes32BE(value: bigint): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(32));
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * Normalizes a raw 64-byte IEEE P1363 `(r || s)` P-256 ECDSA base64 signature to canonical
 * low-S form (`1 <= s <= floor(n / 2)`) and canonical base64 encoding.
 */
export function canonicalizeP256LowSSignature(signature: string): string {
  if (typeof signature !== 'string' || signature.length !== 88) {
    throw new VfsError('VFS_INVALID_SIGNATURE', 'Signer returned malformed P-256 signature.');
  }
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = base64ToBytes(signature);
  } catch (cause) {
    throw new VfsError('VFS_INVALID_SIGNATURE', 'Signer returned non-base64 P-256 signature.', { cause });
  }
  if (raw.byteLength !== 64) {
    throw new VfsError('VFS_INVALID_SIGNATURE', 'P-256 signature must be exactly 64 raw (r || s) bytes.');
  }
  const r = bytesToBigIntBE(raw.subarray(0, 32));
  const s = bytesToBigIntBE(raw.subarray(32, 64));
  if (r === 0n || r >= P256_N || s === 0n || s >= P256_N) {
    throw new VfsError('VFS_INVALID_SIGNATURE', 'P-256 signature scalar (r, s) is out of group range.');
  }
  if (s > P256_HALF_N) {
    const out = new Uint8Array(new ArrayBuffer(64));
    out.set(raw.subarray(0, 32), 0);
    out.set(bigIntToBytes32BE(P256_N - s), 32);
    return bytesToBase64(out);
  }
  return bytesToBase64(raw);
}

/**
 * Classifies a base64-encoded 64-byte P-256 `(r || s)` signature BEFORE calling WebCrypto verify:
 * - `'invalid'`: wrong type/length or undecodable base64
 * - `'malleable'`: non-canonical base64 padding bits, out-of-range `r`/`s`, or high-S (`s > n/2`)
 * - `'ok'`: canonical low-S signature ready for cryptographic verification
 */
export function checkP256LowSSignature(signature: unknown): 'ok' | 'malleable' | 'invalid' {
  if (typeof signature !== 'string' || signature.length !== 88) return 'invalid';
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = base64ToBytes(signature);
  } catch {
    return 'invalid';
  }
  if (raw.byteLength !== 64) return 'invalid';
  if (bytesToBase64(raw) !== signature) return 'malleable';
  const r = bytesToBigIntBE(raw.subarray(0, 32));
  const s = bytesToBigIntBE(raw.subarray(32, 64));
  if (r === 0n || r >= P256_N || s === 0n || s > P256_HALF_N) {
    return 'malleable';
  }
  return 'ok';
}

/** Returns true iff `signature` is a canonical base64 low-S P-256 `(r || s)` signature. */
export function isCanonicalP256LowSSignature(signature: unknown): signature is string {
  return checkP256LowSSignature(signature) === 'ok';
}

// ---------------------------------------------------------------------------
// Domain-separated P-256 ECDSA sign & verify helpers for canonical VFS payloads
// ---------------------------------------------------------------------------

/** Canonical domain-separated signing preimage (`meshrooms-vfs-sig-v1`). */
export function vfsSignaturePayload(body: unknown): { d: typeof VFS_SIG_DOMAIN; body: unknown } {
  return canonicalize({ d: VFS_SIG_DOMAIN, body });
}

/** Signs a canonical VFS op/commit body with P-256 ECDSA and canonicalizes `s` to low-S. */
export async function signVfsPayload<T>(body: T, signFn: SignFn): Promise<VfsSignedPayload<T>> {
  const canonicalBody = canonicalize(body);
  const rawSignature = await signFn(vfsSignaturePayload(canonicalBody));
  const signature = canonicalizeP256LowSSignature(rawSignature);
  return { body: canonicalBody, signature };
}

/** Verifies a domain-separated canonical low-S P-256 ECDSA signature over a VFS payload. */
export async function verifyVfsPayload(signed: unknown, publicKey: string): Promise<boolean> {
  if (!signed || typeof signed !== 'object' || Array.isArray(signed)) return false;
  const s = signed as Record<string, unknown>;
  if (!isCanonicalP256LowSSignature(s.signature)) return false;
  if (!s.body || typeof s.body !== 'object' || Array.isArray(s.body)) return false;
  return verify(publicKey, vfsSignaturePayload(s.body), s.signature);
}

/** Encodes `{ body, signature }` to canonical UTF-8 JSON bytes for `VfsEnvelopeV1` encryption. */
export function encodeSignedVfsPayload<T>(signed: VfsSignedPayload<T>): Uint8Array<ArrayBuffer> {
  return utf8Bytes(canonicalJson({ body: signed.body, signature: signed.signature }));
}

/**
 * Strictly decodes canonical UTF-8 JSON bytes into a `VfsSignedPayload`.
 * Enforces exact top-level key count (`{ body, signature }` only), byte-for-byte canonical
 * serialization, and canonical low-S ECDSA signature encoding so an insider holding `RK_e`
 * cannot re-encrypt another author's signed payload with whitespace, reordered keys, extra
 * fields, non-canonical base64, or high-S `(r, n - s)` to forge a second `cid`/`opHash`.
 */
export function decodeSignedVfsPayload<T = Record<string, unknown>>(bytes: Uint8Array): VfsSignedPayload<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(bytes));
  } catch (cause) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Decrypted VFS signed payload is not valid UTF-8 JSON.', { cause });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Decrypted VFS signed payload must be an object.');
  }
  const obj = parsed as Record<string, unknown>;
  if (!obj.body || typeof obj.body !== 'object' || Array.isArray(obj.body)) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Decrypted VFS signed payload missing body object.');
  }
  if (typeof obj.signature !== 'string' || obj.signature.length !== 88) {
    throw new VfsError('VFS_INVALID_SIGNATURE', 'Decrypted VFS signed payload has malformed signature.');
  }
  if (Object.keys(obj).length !== 2) {
    throw new VfsError('VFS_MALLEABLE_ENVELOPE', 'Decrypted VFS signed payload contains unexpected top-level keys.');
  }
  const signed: VfsSignedPayload<T> = { body: obj.body as T, signature: obj.signature };
  const expectedBytes = encodeSignedVfsPayload(signed);
  if (!constantTimeEqual(toArrayBufferView(bytes), expectedBytes)) {
    throw new VfsError('VFS_MALLEABLE_ENVELOPE', 'Decrypted VFS signed payload bytes are not canonical JSON.');
  }
  const sigState = checkP256LowSSignature(signed.signature);
  if (sigState === 'invalid') {
    throw new VfsError('VFS_INVALID_SIGNATURE', 'Decrypted VFS signed payload has malformed P-256 signature.');
  }
  if (sigState === 'malleable') {
    throw new VfsError(
      'VFS_MALLEABLE_ENVELOPE',
      'Decrypted VFS signed payload has malleable high-S or non-canonical P-256 signature.',
    );
  }
  return signed;
}

function validateSignedOpBodyForObjKind(
  body: VfsSignedOpHeaderFields,
  objKind: typeof VfsObjKind.DocOp | typeof VfsObjKind.Commit | typeof VfsObjKind.TreeOp,
): void {
  const expectedKind = expectedBodyKindForObjKind(objKind);
  if (body.kind !== expectedKind) {
    throw new VfsError(
      'VFS_INVALID_ENVELOPE',
      `VFS op body.kind "${String(body.kind)}" does not match objKind 0x${objKind.toString(16)} (expected "${expectedKind}").`,
    );
  }
  if (objKind === VfsObjKind.DocOp || objKind === VfsObjKind.TreeOp) {
    if (typeof body.nodeId !== 'string' || body.nodeId.length === 0 || body.nodeId.includes('\0')) {
      throw new VfsError('VFS_INVALID_ENVELOPE', `VFS ${expectedKind} requires a non-empty nodeId.`);
    }
  } else {
    const scope = (body as Record<string, unknown>).scope;
    if (body.nodeId !== undefined && (typeof body.nodeId !== 'string' || body.nodeId.length === 0 || body.nodeId.includes('\0'))) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'VFS commit nodeId must be a non-empty string when present.');
    }
    if (scope === 'doc' && typeof body.nodeId !== 'string') {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'Doc-scoped VFS commit requires a non-empty nodeId.');
    }
  }
}

/**
 * Signs a canonical op/commit `body` with low-S P-256 ECDSA and seals it into a deterministic
 * `VfsEnvelopeV1` (`0x01 doc-op`, `0x03 commit`, or `0x04 tree-op`).
 */
export async function sealSignedVfsOp<T extends VfsSignedOpHeaderFields>(options: {
  body: T;
  objKind: typeof VfsObjKind.DocOp | typeof VfsObjKind.Commit | typeof VfsObjKind.TreeOp;
  roomKey: Uint8Array;
  sign: SignFn;
}): Promise<{
  envelope: SealedVfsEnvelope;
  signed: VfsSignedPayload<T>;
  cid: string;
  opHash: string;
}> {
  const { body, objKind, roomKey, sign } = options;
  if (!isDeterministicVfsObjKind(objKind)) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'sealSignedVfsOp requires a deterministic op/commit objKind.');
  }
  validateSignedOpBodyForObjKind(body, objKind);
  const signed = await signVfsPayload(body, sign);
  const innerBytes = encodeSignedVfsPayload(signed);
  if (innerBytes.byteLength > VFS_OP_MAX_PLAINTEXT_BYTES) {
    throw new VfsError(
      'VFS_LIMIT_EXCEEDED',
      `Signed VFS op plaintext (${innerBytes.byteLength} bytes) exceeds ${VFS_OP_MAX_PLAINTEXT_BYTES}-byte limit.`,
    );
  }
  const bindingKey = opBindingKey(body.deviceId, body.seq, body.opId);
  const envelope = await sealVfsEnvelope({
    roomId: body.roomId,
    epoch: body.epoch,
    objKind,
    key: roomKey,
    plaintext: innerBytes,
    bindingKey,
  });
  return { envelope, signed, cid: envelope.cid, opHash: envelope.opHash! };
}

/**
 * Opens a deterministic `VfsEnvelopeV1`, enforces `VFS_OP_MAX_PLAINTEXT_BYTES`, verifies
 * anti-malleability (`iv`, `salt16` HMAC, canonical JSON, low-S ECDSA) and unified AAD,
 * asserts decrypted inner metadata (`kind`, `roomId`, `nodeId`, `epoch`, `deviceId`, `seq`,
 * `opId`) matches outer wire metadata, and verifies the author's P-256 ECDSA signature.
 */
export async function openSignedVfsOp<T extends VfsSignedOpHeaderFields>(options: {
  bytes: Uint8Array;
  roomId: string;
  epoch: number;
  objKind: typeof VfsObjKind.DocOp | typeof VfsObjKind.Commit | typeof VfsObjKind.TreeOp;
  /** Expected target nodeId (required for `DocOp`/`TreeOp` and doc-scoped `Commit`). */
  nodeId?: string;
  deviceId: string;
  seq: number;
  opId: string;
  roomKey: Uint8Array;
  expectedCid?: string;
  resolvePublicKey: (body: T) => string | undefined | Promise<string | undefined>;
}): Promise<{
  body: T;
  signature: string;
  cid: string;
  opHash: string;
  header: VfsEnvelopeHeader;
}> {
  const { bytes, roomId, epoch, objKind, nodeId, deviceId, seq, opId, roomKey, expectedCid, resolvePublicKey } = options;
  if (!isDeterministicVfsObjKind(objKind)) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'openSignedVfsOp requires a deterministic op/commit objKind.');
  }
  if (objKind === VfsObjKind.DocOp || objKind === VfsObjKind.TreeOp) {
    if (typeof nodeId !== 'string' || nodeId.length === 0 || nodeId.includes('\0')) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'openSignedVfsOp requires a non-empty nodeId for DocOp and TreeOp.');
    }
  } else if (nodeId !== undefined && (typeof nodeId !== 'string' || nodeId.length === 0 || nodeId.includes('\0'))) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid outer nodeId for VFS Commit.');
  }
  if (bytes.byteLength > VFS_ENVELOPE_OVERHEAD_BYTES + VFS_OP_MAX_PLAINTEXT_BYTES) {
    throw new VfsError(
      'VFS_LIMIT_EXCEEDED',
      `Signed VFS op envelope (${bytes.byteLength} bytes) exceeds ${VFS_ENVELOPE_OVERHEAD_BYTES + VFS_OP_MAX_PLAINTEXT_BYTES}-byte limit.`,
    );
  }
  const bindingKey = opBindingKey(deviceId, seq, opId);
  const opened = await openVfsEnvelope({
    bytes,
    roomId,
    key: roomKey,
    bindingKey,
    expectedObjKind: objKind,
    expectedEpoch: epoch,
    expectedCid,
  });
  const signed = decodeSignedVfsPayload<T>(opened.plaintext);
  const b = signed.body;
  validateSignedOpBodyForObjKind(b, objKind);
  if (
    b.roomId !== roomId
    || b.epoch !== epoch
    || b.deviceId !== deviceId
    || b.seq !== seq
    || b.opId !== opId
  ) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Decrypted VFS op metadata does not match outer envelope.');
  }
  if (objKind === VfsObjKind.DocOp || objKind === VfsObjKind.TreeOp) {
    if (b.nodeId !== nodeId) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'Decrypted VFS op nodeId does not match outer nodeId.');
    }
  } else if (nodeId !== undefined) {
    if (b.nodeId !== nodeId) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'Decrypted VFS commit nodeId does not match outer nodeId.');
    }
  } else if (b.nodeId !== undefined) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Decrypted VFS commit specifies a nodeId that was not bound by caller.');
  }
  const publicKey = await resolvePublicKey(b);
  if (!publicKey || !(await verifyVfsPayload(signed, publicKey))) {
    throw new VfsError('VFS_INVALID_SIGNATURE', 'VFS op P-256 author signature verification failed.');
  }
  return {
    body: b,
    signature: signed.signature,
    cid: opened.cid,
    opHash: opened.opHash!,
    header: opened.header,
  };
}
