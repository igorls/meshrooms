import { deviceId, verify } from './protocol';

export const RELAY_PROTOCOL_VERSION = 1 as const;
export const RELAY_MAX_FRAME_BYTES = 32 * 1024;
/**
 * Size-padding buckets (in bytes). The largest bucket is capped internally to
 * `RELAY_MAX_PADDED_PLAINTEXT_BYTES` so base64 ciphertext + envelope metadata +
 * recipient DEK wraps stay strictly within `RELAY_MAX_FRAME_BYTES` (32 KB).
 */
export const RELAY_PADDING_BUCKETS = [1024, 4096, 16384, 32768] as const;
/** Maximum padded plaintext size (21 KB -> ~28.7 KB base64) leaving >4 KB for metadata & wraps inside 32 KB. */
export const RELAY_MAX_PADDED_PLAINTEXT_BYTES = 21 * 1024;
export const SEALED_STATE_MAX_BYTES = 256 * 1024;
export const HOST_PIN_LENGTH = 16;

export type SignFn = (value: unknown) => Promise<string>;

export type RosterEntry = {
  id: string;
  sign: string;
  enc: string;
  encVersion: number;
  encSig: string;
  memberId: string;
  role: 'human' | 'agent';
  operatorId?: string;
  wakeable?: true;
  cert?: { by: string; sig: string };
};

export type RemovedRosterEntry = {
  id: string;
  at: number;
  revoked: boolean;
};

export type RosterBody = {
  v: 1;
  room: string;
  version: number;
  prev: string;
  at: number;
  host: string;
  devices: RosterEntry[];
  removed: RemovedRosterEntry[];
};

export type SignedRoster = {
  body: RosterBody;
  signature: string;
};

export type RelayLane = 'primary' | 'file';

export type RelayEnvelope = {
  v: 1;
  room: string;
  from: string;
  id: string;
  seq: number;
  roster: number;
  lane: RelayLane;
  epk: string;
  to: Record<string, string>;
  wake?: string[];
  hold?: true;
  iv: string;
  ct: string;
  /**
   * Sender's ECDSA signature over every other envelope field (see `relayEnvelopeSigPayload`). Receivers verify it
   * against the sender's key in the host-signed roster, so neither the relay nor another member can forge `from`.
   */
  sig: string;
};

export type AgentKeySecret = {
  origin: string;
  roomId: string;
  signJwk: JsonWebKey;
  encJwk: JsonWebKey;
  encVersion: number;
  hostPin?: string;
};

export type EncBindingInput = {
  room: string;
  deviceId: string;
  enc: string;
  encVersion: number;
};

export type VerifyRosterOptions = {
  roomId: string;
  /** Hex prefix (e.g. 16 hex chars from `#h=...`) pinning the signing host deviceId (SHA-256 of host signing pubkey). */
  expectedHostPin?: string;
  previous?: SignedRoster;
  minVersion?: number;
};

export type VerifyRosterResult =
  | { ok: true; hostDeviceId: string; hostPublicKey: string; hash: string }
  | { ok: false; reason: string };

export type EncryptEnvelopeOptions = {
  room: string;
  from: string;
  id: string;
  seq: number;
  rosterVersion: number;
  lane: RelayLane;
  recipients: readonly RosterEntry[];
  wake?: string[];
  hold?: true;
  /** Signs the envelope with the sender's room signing key (required: the wire format carries `sig`). */
  sign: SignFn;
};

export type DecryptEnvelopeOptions = {
  room: string;
  selfDeviceId: string;
  selfEncPrivateKey: CryptoKey;
  selfEncVersion: number;
  /**
   * The sender's signing public key from the verified host-signed roster. The envelope is rejected unless
   * `envelope.sig` verifies under it, which authenticates `from`, `id`, `seq`, `roster`, `lane`, recipients and ciphertext.
   */
  senderSignKey: string;
  minRosterVersion?: number;
  expectedFrom?: string;
};

export type DecryptedRelayEnvelope<T = unknown> = {
  packet: T;
  rosterVersion: number;
};

export type SealedStateContext = {
  room: string;
  deviceId: string;
};

export type StateSecretInput = CryptoKey | JsonWebKey | Uint8Array;

const HEX_64 = /^[a-f0-9]{64}$/;
const HEX_PIN = /^[0-9a-fA-F]{8,64}$/;
const BASE64_STD = /^[A-Za-z0-9+/]*={0,2}$/;
const SEALED_STATE_VERSION = 1;
const SEALED_STATE_IV_BYTES = 12;
const WRAP_IV_BYTES = 12;
const DEK_BYTES = 32;
const GCM_TAG_BYTES = 16;
const EXPECTED_WRAPPED_DEK_BYTES = WRAP_IV_BYTES + DEK_BYTES + GCM_TAG_BYTES;
const ENVELOPE_IV_BYTES = 12;

/**
 * Nothing-up-my-sleeve P-256 curve point H derived by try-and-increment
 * SHA-256("meshrooms-sealed-state-h-v1:4") -> valid uncompressed point on P-256.
 * Used for ECDH(d, H) -> HKDF when deriving a device's symmetric state-sealing key
 * from a non-extractable ECDH private CryptoKey (unknown discrete log wrt G).
 */
const SEALED_STATE_H_RAW_B64 = 'BMVUY4MGpKocsOUXFPY+wR3TRhcyCY3fZXjuiwwGMC4Po0wV+BLfeoe37hLy1CtMRSrReoiPvmi5jBdGr4jWoKY=';

let sealedStatePointPromise: Promise<CryptoKey> | undefined;
function getSealedStatePoint(): Promise<CryptoKey> {
  return sealedStatePointPromise ||= importEncPublicKey(SEALED_STATE_H_RAW_B64);
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return textEncoder.encode(text) as Uint8Array<ArrayBuffer>;
}

function isPlainObj(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Chunked base64 encoding safe for buffers up to 256 KB+ without overflowing JS call stacks. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Strict base64 decoding. */
export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 || !BASE64_STD.test(value)) {
    throw new Error('Invalid base64 encoding');
  }
  const binary = atob(value);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Returns a deeply canonicalized value with object keys sorted lexicographically and undefined properties omitted. */
export function canonicalize<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => canonicalize(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out as T;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalEncode(value: unknown): Uint8Array<ArrayBuffer> {
  return utf8(canonicalJson(value));
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// 5.1 ECDH P-256 encryption keys & ECDSA binding
// ---------------------------------------------------------------------------

export async function generateEncKeyPair(extractable = false): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    extractable,
    ['deriveBits', 'deriveKey'],
  );
}

export async function exportRawPublicKey(pub: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', pub);
  return bytesToBase64(new Uint8Array(raw));
}

export async function importEncPublicKey(rawB64: string): Promise<CryptoKey> {
  if (typeof rawB64 !== 'string' || rawB64.length !== 88) {
    throw new Error('Invalid P-256 public key length');
  }
  const bytes = base64ToBytes(rawB64);
  if (bytes.byteLength !== 65 || bytes[0] !== 0x04) {
    throw new Error('Invalid uncompressed P-256 public key');
  }
  return crypto.subtle.importKey('raw', bytes, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

export async function importEncPrivateJwk(jwk: JsonWebKey, extractable = false): Promise<CryptoKey> {
  if (
    !isPlainObj(jwk)
    || jwk.kty !== 'EC'
    || jwk.crv !== 'P-256'
    || typeof jwk.x !== 'string'
    || typeof jwk.y !== 'string'
    || typeof jwk.d !== 'string'
  ) {
    throw new Error('Invalid P-256 ECDH private JWK');
  }
  const cleanJwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d };
  return crypto.subtle.importKey(
    'jwk',
    cleanJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    extractable,
    ['deriveBits', 'deriveKey'],
  );
}

function encBindingPayload(input: EncBindingInput) {
  return canonicalize({
    room: input.room,
    deviceId: input.deviceId,
    enc: input.enc,
    encVersion: input.encVersion,
  });
}

export async function signEncBinding(signFn: SignFn, input: EncBindingInput): Promise<string> {
  if (!input.room || !input.deviceId || input.enc.length !== 88 || !Number.isInteger(input.encVersion) || input.encVersion < 1) {
    throw new Error('Invalid encryption key binding input');
  }
  return signFn(encBindingPayload(input));
}

export async function verifyEncBinding(
  signPubKey: string,
  input: EncBindingInput,
  encSig: string,
): Promise<boolean> {
  try {
    if (
      typeof signPubKey !== 'string' || signPubKey.length !== 88
      || typeof encSig !== 'string' || encSig.length !== 88
      || typeof input.room !== 'string' || input.room.length === 0
      || typeof input.deviceId !== 'string' || input.deviceId.length === 0
      || typeof input.enc !== 'string' || input.enc.length !== 88
      || !Number.isInteger(input.encVersion) || input.encVersion < 1
      || input.enc === signPubKey
    ) {
      return false;
    }
    const derivedId = await deviceId(signPubKey);
    if (derivedId !== input.deviceId) return false;
    return await verify(signPubKey, encBindingPayload(input), encSig);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 5.2 Host-signed roster & delegated certification
// ---------------------------------------------------------------------------

function delegatedCertPayload(room: string, entry: Omit<RosterEntry, 'cert'>) {
  return canonicalize({
    kind: 'roster-cert',
    room,
    id: entry.id,
    sign: entry.sign,
    enc: entry.enc,
    encVersion: entry.encVersion,
    encSig: entry.encSig,
    memberId: entry.memberId,
    role: entry.role,
    ...(entry.operatorId !== undefined ? { operatorId: entry.operatorId } : {}),
    ...(entry.wakeable ? { wakeable: true as const } : {}),
  });
}

export async function signDelegatedEntry(
  signFn: SignFn,
  room: string,
  entry: Omit<RosterEntry, 'cert'>,
  certifierDeviceId: string,
): Promise<{ by: string; sig: string }> {
  if (!room || !HEX_64.test(certifierDeviceId)) {
    throw new Error('Invalid delegated roster entry signing arguments');
  }
  const sig = await signFn(delegatedCertPayload(room, entry));
  return { by: certifierDeviceId, sig };
}

export async function verifyDelegatedEntry(
  certifierSignPubKey: string,
  room: string,
  entry: RosterEntry,
): Promise<boolean> {
  if (!entry.cert || typeof entry.cert.sig !== 'string' || entry.cert.sig.length !== 88) {
    return false;
  }
  const { cert: _cert, ...withoutCert } = entry;
  return verify(certifierSignPubKey, delegatedCertPayload(room, withoutCert), entry.cert.sig);
}

export async function hashRosterBody(body: RosterBody): Promise<string> {
  return sha256Hex(canonicalEncode(body));
}

export async function signRoster(body: RosterBody, signFn: SignFn): Promise<SignedRoster> {
  const canonicalBody = canonicalize(body);
  const signature = await signFn(canonicalBody);
  return { body: canonicalBody, signature };
}

function isValidRosterEntryShape(entry: unknown): entry is RosterEntry {
  if (!isPlainObj(entry)) return false;
  if (typeof entry.id !== 'string' || !HEX_64.test(entry.id)) return false;
  if (typeof entry.sign !== 'string' || entry.sign.length !== 88) return false;
  if (typeof entry.enc !== 'string' || entry.enc.length !== 88) return false;
  if (entry.enc === entry.sign) return false;
  if (typeof entry.encVersion !== 'number' || !Number.isInteger(entry.encVersion) || entry.encVersion < 1) return false;
  if (typeof entry.encSig !== 'string' || entry.encSig.length !== 88) return false;
  if (typeof entry.memberId !== 'string' || entry.memberId.length === 0 || entry.memberId.length > 128) return false;
  if (entry.role !== 'human' && entry.role !== 'agent') return false;
  if (entry.operatorId !== undefined && (typeof entry.operatorId !== 'string' || entry.operatorId.length === 0)) return false;
  if (entry.wakeable !== undefined && entry.wakeable !== true) return false;
  if (entry.cert !== undefined) {
    if (!isPlainObj(entry.cert)) return false;
    if (typeof entry.cert.by !== 'string' || !HEX_64.test(entry.cert.by)) return false;
    if (typeof entry.cert.sig !== 'string' || entry.cert.sig.length !== 88) return false;
  }
  return true;
}

function isValidRemovedEntryShape(entry: unknown): entry is RemovedRosterEntry {
  if (!isPlainObj(entry)) return false;
  if (typeof entry.id !== 'string' || !HEX_64.test(entry.id)) return false;
  if (typeof entry.at !== 'number' || !Number.isFinite(entry.at) || entry.at < 0) return false;
  if (typeof entry.revoked !== 'boolean') return false;
  return true;
}

async function verifyEntryCrypto(entry: RosterEntry, room: string): Promise<string | undefined> {
  const derivedId = await deviceId(entry.sign);
  if (derivedId !== entry.id) return `Device ${entry.id} id does not match signing key`;
  try {
    await importEncPublicKey(entry.enc);
  } catch {
    return `Device ${entry.id} has invalid P-256 encryption key`;
  }
  const roomBound = await verifyEncBinding(
    entry.sign,
    { room, deviceId: entry.id, enc: entry.enc, encVersion: entry.encVersion },
    entry.encSig,
  );
  if (!roomBound) {
    // Allow browser-profile wildcard binding only if explicitly signed over room "*".
    const profileBound = await verifyEncBinding(
      entry.sign,
      { room: '*', deviceId: entry.id, enc: entry.enc, encVersion: entry.encVersion },
      entry.encSig,
    );
    if (!profileBound) return `Device ${entry.id} has invalid encSig`;
  }
  return undefined;
}

function checkCertAuthority(entry: RosterEntry, certifier: RosterEntry): string | undefined {
  if (certifier.id === entry.id) return `Device ${entry.id} cannot self-certify`;
  if (certifier.cert) return `Certifier ${certifier.id} is itself delegated (delegation chains forbidden)`;
  if (certifier.role !== 'human') return `Certifier ${certifier.id} must be a human device`;
  if (entry.role === 'human') {
    if (certifier.memberId !== entry.memberId) {
      return `Certifier ${certifier.id} cannot certify companion for another member`;
    }
  } else {
    if (!entry.operatorId || entry.operatorId !== certifier.memberId) {
      return `Certifier ${certifier.id} is not the operator of agent ${entry.id}`;
    }
  }
  return undefined;
}

/**
 * Validates a delegated roster entry against a previously verified host-signed roster
 * (used when a companion or agent joins while the host is temporarily offline).
 */
export async function verifyDelegatedRosterEntry(
  entry: unknown,
  roster: SignedRoster,
  roomId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (roster.body.room !== roomId) return { ok: false, reason: 'Roster room mismatch' };
  if (!isValidRosterEntryShape(entry)) return { ok: false, reason: 'Invalid delegated roster entry shape' };
  if (!entry.cert) return { ok: false, reason: 'Missing delegation certificate' };
  const removedIds = new Set(roster.body.removed.map(r => r.id));
  if (removedIds.has(entry.id)) return { ok: false, reason: 'Delegated device is removed' };
  if (removedIds.has(entry.cert.by)) return { ok: false, reason: 'Certifier has been removed' };
  const certifier = roster.body.devices.find(d => d.id === entry.cert!.by);
  if (!certifier) return { ok: false, reason: 'Certifier is not in the verified roster' };
  const authErr = checkCertAuthority(entry, certifier);
  if (authErr) return { ok: false, reason: authErr };
  const cryptoErr = await verifyEntryCrypto(entry, roomId);
  if (cryptoErr) return { ok: false, reason: cryptoErr };
  const sigOk = await verifyDelegatedEntry(certifier.sign, roomId, entry);
  if (!sigOk) return { ok: false, reason: 'Invalid delegation signature' };
  return { ok: true };
}

export async function verifyRoster(
  signed: unknown,
  options: VerifyRosterOptions,
): Promise<VerifyRosterResult> {
  if (!isPlainObj(signed) || !isPlainObj(signed.body) || typeof signed.signature !== 'string' || signed.signature.length !== 88) {
    return { ok: false, reason: 'Malformed SignedRoster envelope' };
  }
  const body = signed.body as Record<string, unknown>;
  if (body.v !== RELAY_PROTOCOL_VERSION) return { ok: false, reason: 'Unsupported roster version' };
  if (typeof body.room !== 'string' || !body.room || body.room !== options.roomId) {
    return { ok: false, reason: 'Roster room mismatch' };
  }
  if (typeof body.version !== 'number' || !Number.isInteger(body.version) || body.version < 1) {
    return { ok: false, reason: 'Invalid roster version number' };
  }
  if (typeof body.prev !== 'string') return { ok: false, reason: 'Invalid roster prev hash' };
  if (body.version > 1 && !HEX_64.test(body.prev)) {
    return { ok: false, reason: 'Roster version > 1 must carry a 64-hex prev hash' };
  }
  if (body.version === 1 && body.prev !== '' && !HEX_64.test(body.prev)) {
    return { ok: false, reason: 'Invalid genesis roster prev field' };
  }
  if (typeof body.at !== 'number' || !Number.isFinite(body.at) || body.at <= 0) {
    return { ok: false, reason: 'Invalid roster timestamp' };
  }
  if (typeof body.host !== 'string' || !HEX_64.test(body.host)) {
    return { ok: false, reason: 'Invalid roster host id' };
  }
  if (!Array.isArray(body.devices) || !Array.isArray(body.removed)) {
    return { ok: false, reason: 'Roster devices and removed must be arrays' };
  }

  const typedBody = body as unknown as RosterBody;

  if (options.minVersion !== undefined && typedBody.version < options.minVersion) {
    return { ok: false, reason: `Roster rollback rejected: version ${typedBody.version} < minVersion ${options.minVersion}` };
  }

  const removedIds = new Set<string>();
  for (const r of typedBody.removed) {
    if (!isValidRemovedEntryShape(r)) return { ok: false, reason: 'Malformed removed roster entry' };
    if (removedIds.has(r.id)) return { ok: false, reason: `Duplicate removed entry ${r.id}` };
    removedIds.add(r.id);
  }

  const deviceMap = new Map<string, RosterEntry>();
  for (const d of typedBody.devices) {
    if (!isValidRosterEntryShape(d)) return { ok: false, reason: 'Malformed device roster entry' };
    if (deviceMap.has(d.id)) return { ok: false, reason: `Duplicate device entry ${d.id}` };
    if (removedIds.has(d.id)) return { ok: false, reason: `Device ${d.id} appears in both devices and removed` };
    deviceMap.set(d.id, d);
  }

  const newHostEntry = deviceMap.get(typedBody.host);
  if (!newHostEntry) {
    return { ok: false, reason: 'Roster host is not present in devices' };
  }
  if (newHostEntry.cert) {
    return { ok: false, reason: 'Roster host cannot be a delegated entry' };
  }

  let signerDeviceId = typedBody.host;
  let signerPublicKey = newHostEntry.sign;

  if (options.previous) {
    const prevBody = options.previous.body;
    if (prevBody.room !== options.roomId) {
      return { ok: false, reason: 'Previous roster room mismatch' };
    }
    if (typedBody.version <= prevBody.version) {
      return { ok: false, reason: `Roster rollback rejected: version ${typedBody.version} <= previous ${prevBody.version}` };
    }
    const expectedPrevHash = await hashRosterBody(prevBody);
    if (typedBody.prev !== expectedPrevHash) {
      return { ok: false, reason: 'Roster prev hash does not match previous roster' };
    }

    const prevHostEntry = prevBody.devices.find(d => d.id === prevBody.host);
    if (!prevHostEntry) {
      return { ok: false, reason: 'Previous roster has no matching host device' };
    }

    if (typedBody.host !== prevBody.host) {
      // Host transfer step (N -> N+1): previous host signs version N+1 naming the new host; new host signs N+2+.
      signerDeviceId = prevBody.host;
      signerPublicKey = prevHostEntry.sign;
      const oldHostInNew = deviceMap.get(prevBody.host);
      if (oldHostInNew && oldHostInNew.sign !== prevHostEntry.sign) {
        return { ok: false, reason: 'Previous host signing key changed during transfer' };
      }
    } else {
      if (newHostEntry.sign !== prevHostEntry.sign) {
        return { ok: false, reason: 'Host signing key mismatch with previous roster' };
      }
    }
  }

  if (options.expectedHostPin !== undefined) {
    const pin = options.expectedHostPin.trim().toLowerCase();
    if (!HEX_PIN.test(pin)) {
      return { ok: false, reason: 'Invalid expectedHostPin format' };
    }
    if (!signerDeviceId.toLowerCase().startsWith(pin)) {
      return { ok: false, reason: `Host pin mismatch: expected ${pin}, got ${signerDeviceId.slice(0, pin.length)}` };
    }
  }

  // Verify host signature over canonical RosterBody before inspecting entries.
  const hostSigOk = await verify(signerPublicKey, canonicalize(typedBody), signed.signature);
  if (!hostSigOk) {
    return { ok: false, reason: 'Invalid host signature on roster' };
  }

  // Verify every device's id/sign/enc/encSig binding and any delegated cert.
  for (const entry of typedBody.devices) {
    const cryptoErr = await verifyEntryCrypto(entry, options.roomId);
    if (cryptoErr) return { ok: false, reason: cryptoErr };

    if (entry.cert) {
      if (removedIds.has(entry.cert.by)) {
        return { ok: false, reason: `Certifier ${entry.cert.by} is removed` };
      }
      const certifier = deviceMap.get(entry.cert.by);
      if (!certifier) {
        return { ok: false, reason: `Certifier ${entry.cert.by} is not an admitted device in roster` };
      }
      const authErr = checkCertAuthority(entry, certifier);
      if (authErr) return { ok: false, reason: authErr };
      const certOk = await verifyDelegatedEntry(certifier.sign, options.roomId, entry);
      if (!certOk) {
        return { ok: false, reason: `Invalid delegation signature for device ${entry.id}` };
      }
    }
  }

  return {
    ok: true,
    hostDeviceId: typedBody.host,
    hostPublicKey: newHostEntry.sign,
    hash: await hashRosterBody(typedBody),
  };
}

// ---------------------------------------------------------------------------
// Host-key URL fragment pin helpers (#h=<16-hex>)
// ---------------------------------------------------------------------------

export function parseHostPin(urlOrFragment: string): string | undefined {
  if (typeof urlOrFragment !== 'string' || !urlOrFragment) return undefined;
  const hashIndex = urlOrFragment.indexOf('#');
  const fragment = hashIndex >= 0 ? urlOrFragment.slice(hashIndex + 1) : urlOrFragment;
  if (!fragment) return undefined;
  for (const part of fragment.split('&')) {
    const match = /^h=([0-9a-fA-F]{8,64})$/.exec(part);
    if (match) return match[1].toLowerCase();
  }
  return undefined;
}

/** Strips any `h=<pin>` parameter from a URL fragment (with or without leading `#`), preserving existing token segments. */
export function stripHostPinFromFragment(fragment: string): string {
  const raw = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  return raw
    .split('&')
    .filter(part => part.length > 0 && !/^h=/.test(part))
    .join('&');
}

export function appendHostPin(url: string, hostDeviceId: string, pinLength = HOST_PIN_LENGTH): string {
  if (!Number.isInteger(pinLength) || pinLength < 8 || pinLength > 64) {
    throw new Error('Invalid host pin length');
  }
  const cleanId = hostDeviceId.trim().toLowerCase();
  if (!/^[0-9a-f]{8,64}$/.test(cleanId) || cleanId.length < pinLength) {
    throw new Error('Invalid hostDeviceId for host pin');
  }
  const pin = cleanId.slice(0, pinLength);
  const hashIndex = url.indexOf('#');
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const existingFragment = hashIndex >= 0 ? url.slice(hashIndex + 1) : '';
  const kept = stripHostPinFromFragment(existingFragment);
  return kept ? `${base}#${kept}&h=${pin}` : `${base}#h=${pin}`;
}

// ---------------------------------------------------------------------------
// 5.3 Relay envelope AAD, padding, encryption & decryption
// ---------------------------------------------------------------------------

/** Printable ASCII envelope id (1..128 chars), matching `RelayReplayGuard` so no accepted envelope can bypass replay tracking. */
export const RELAY_ENVELOPE_ID_PATTERN = /^[\x21-\x7e]{1,128}$/;

export function isValidRelayEnvelopeShape(value: unknown): value is RelayEnvelope {
  if (!isPlainObj(value)) return false;
  if (value.v !== RELAY_PROTOCOL_VERSION) return false;
  if (typeof value.room !== 'string' || value.room.length === 0 || value.room.length > 128) return false;
  if (typeof value.from !== 'string' || value.from.length === 0 || value.from.length > 128) return false;
  if (typeof value.id !== 'string' || !RELAY_ENVELOPE_ID_PATTERN.test(value.id)) return false;
  if (typeof value.seq !== 'number' || !Number.isInteger(value.seq) || value.seq < 1) return false;
  if (typeof value.roster !== 'number' || !Number.isInteger(value.roster) || value.roster < 1) return false;
  if (value.lane !== 'primary' && value.lane !== 'file') return false;
  if (typeof value.epk !== 'string' || value.epk.length !== 88) return false;
  if (!isPlainObj(value.to)) return false;
  const toKeys = Object.keys(value.to);
  if (toKeys.length === 0) return false;
  for (const key of toKeys) {
    if (!key || key.length > 128) return false;
    const wrapped = value.to[key];
    if (typeof wrapped !== 'string' || wrapped.length === 0 || wrapped.length > 256) return false;
  }
  if (value.wake !== undefined) {
    if (!Array.isArray(value.wake) || !value.wake.every(w => typeof w === 'string' && w.length > 0 && w.length <= 128)) {
      return false;
    }
  }
  if (value.hold !== undefined && value.hold !== true) return false;
  if (typeof value.iv !== 'string' || value.iv.length !== 16) return false;
  if (typeof value.ct !== 'string' || value.ct.length === 0) return false;
  if (typeof value.sig !== 'string' || value.sig.length !== 88) return false;
  return true;
}

/** The exact value a sender signs: every envelope field except `sig`, so no routing or ciphertext byte can change unnoticed. */
export function relayEnvelopeSigPayload(env: Omit<RelayEnvelope, 'sig'>): Record<string, unknown> {
  return {
    t: 'relay-envelope',
    v: env.v,
    room: env.room,
    from: env.from,
    id: env.id,
    seq: env.seq,
    roster: env.roster,
    lane: env.lane,
    epk: env.epk,
    // Sorted so the signed bytes never depend on JSON key order after a hop through a server.
    to: Object.fromEntries(Object.entries(env.to).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    ...(env.wake !== undefined ? { wake: env.wake } : {}),
    ...(env.hold !== undefined ? { hold: env.hold } : {}),
    iv: env.iv,
    ct: env.ct,
  };
}

/** Verifies the sender signature of an envelope against the sender's roster signing key. */
export function verifyRelayEnvelopeSig(env: RelayEnvelope, senderSignKey: string): Promise<boolean> {
  const { sig, ...unsigned } = env;
  return verify(senderSignKey, relayEnvelopeSigPayload(unsigned), sig);
}

export function envelopeAad(
  env: Pick<RelayEnvelope, 'v' | 'room' | 'from' | 'id' | 'seq' | 'roster' | 'lane' | 'to' | 'wake' | 'hold'>,
): Uint8Array<ArrayBuffer> {
  const payload: Record<string, unknown> = {
    v: env.v,
    room: env.room,
    from: env.from,
    id: env.id,
    seq: env.seq,
    roster: env.roster,
    lane: env.lane,
    recipients: Object.keys(env.to).sort(),
  };
  if (env.wake !== undefined) payload.wake = env.wake;
  if (env.hold !== undefined) payload.hold = env.hold;
  return canonicalEncode(payload);
}

function wrapInfoBytes(room: string, from: string, recipientId: string, recipientEncVersion: number): Uint8Array<ArrayBuffer> {
  return utf8(`meshrooms-relay-v1|${room}|${from}|${recipientId}|${recipientEncVersion}`);
}

async function deriveWrapKey(
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

function padPlaintext(plainJsonBytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const needed = 4 + plainJsonBytes.byteLength;
  let bucketSize = 0;
  for (const rawBucket of RELAY_PADDING_BUCKETS) {
    const effective = Math.min(rawBucket, RELAY_MAX_PADDED_PLAINTEXT_BYTES);
    if (needed <= effective) {
      bucketSize = effective;
      break;
    }
  }
  if (bucketSize === 0) {
    throw new Error(`Relay plaintext size ${plainJsonBytes.byteLength} exceeds padded bucket limit (${RELAY_MAX_PADDED_PLAINTEXT_BYTES - 4} bytes)`);
  }
  const padded = new Uint8Array(new ArrayBuffer(bucketSize));
  new DataView(padded.buffer).setUint32(0, plainJsonBytes.byteLength, false);
  padded.set(plainJsonBytes, 4);
  return padded;
}

function unpadPlaintext(padded: Uint8Array): Uint8Array {
  if (padded.byteLength < 4) throw new Error('Truncated relay plaintext');
  const len = new DataView(padded.buffer, padded.byteOffset, 4).getUint32(0, false);
  if (4 + len > padded.byteLength) throw new Error('Invalid relay plaintext length prefix');
  let padOr = 0;
  for (let i = 4 + len; i < padded.byteLength; i++) padOr |= padded[i];
  if (padOr !== 0) throw new Error('Non-zero relay plaintext padding');
  return padded.subarray(4, 4 + len);
}

export async function encryptRelayEnvelope(
  plaintextPacket: unknown,
  options: EncryptEnvelopeOptions,
): Promise<RelayEnvelope> {
  const { room, from, id, seq, rosterVersion, lane, recipients, wake, hold, sign } = options;
  if (typeof sign !== 'function') throw new Error('Relay envelopes must be signed by the sender');
  if (!room || !from || !id) throw new Error('Missing required relay envelope routing fields');
  if (!RELAY_ENVELOPE_ID_PATTERN.test(id)) throw new Error('Relay envelope id must be 1..128 printable ASCII characters');
  if (!Number.isInteger(seq) || seq < 1) throw new Error('Relay envelope seq must be a positive integer');
  if (!Number.isInteger(rosterVersion) || rosterVersion < 1) throw new Error('Relay envelope rosterVersion must be a positive integer');
  if (lane !== 'primary' && lane !== 'file') throw new Error('Invalid relay lane');
  if (!recipients.length) throw new Error('Relay envelope requires at least one recipient');

  const seenRecipients = new Set<string>();
  for (const r of recipients) {
    if (r.id === from) throw new Error('Relay envelope cannot be addressed to sender');
    if (seenRecipients.has(r.id)) throw new Error(`Duplicate recipient ${r.id}`);
    seenRecipients.add(r.id);
  }

  const dekBytes = new Uint8Array(new ArrayBuffer(DEK_BYTES));
  crypto.getRandomValues(dekBytes);
  const dekKey = await crypto.subtle.importKey('raw', dekBytes, { name: 'AES-GCM' }, false, ['encrypt']);

  const epkPair = await generateEncKeyPair(false);
  const epk = await exportRawPublicKey(epkPair.publicKey);
  const salt = utf8(id);

  const to: Record<string, string> = {};
  for (const recipient of recipients) {
    const recipientPub = await importEncPublicKey(recipient.enc);
    const info = wrapInfoBytes(room, from, recipient.id, recipient.encVersion);
    const wrapKey = await deriveWrapKey(epkPair.privateKey, recipientPub, salt, info, 'encrypt');
    const wrapIv = new Uint8Array(new ArrayBuffer(WRAP_IV_BYTES));
    crypto.getRandomValues(wrapIv);
    const wrappedCt = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv, additionalData: info }, wrapKey, dekBytes),
    );
    const combined = new Uint8Array(WRAP_IV_BYTES + wrappedCt.byteLength);
    combined.set(wrapIv, 0);
    combined.set(wrappedCt, WRAP_IV_BYTES);
    to[recipient.id] = bytesToBase64(combined);
  }

  const jsonStr = JSON.stringify(plaintextPacket);
  if (jsonStr === undefined) throw new Error('Plaintext packet is not JSON-serializable');
  const padded = padPlaintext(utf8(jsonStr));

  const cleanWake = wake && wake.length > 0 ? [...wake] : undefined;
  const header = {
    v: RELAY_PROTOCOL_VERSION,
    room,
    from,
    id,
    seq,
    roster: rosterVersion,
    lane,
    to,
    ...(cleanWake ? { wake: cleanWake } : {}),
    ...(hold ? { hold: true as const } : {}),
  };
  const aad = envelopeAad(header);
  const iv = new Uint8Array(new ArrayBuffer(ENVELOPE_IV_BYTES));
  crypto.getRandomValues(iv);
  const ctBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    dekKey,
    padded,
  );

  const unsigned: Omit<RelayEnvelope, 'sig'> = {
    ...header,
    epk,
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ctBuf)),
  };
  const envelope: RelayEnvelope = { ...unsigned, sig: await sign(relayEnvelopeSigPayload(unsigned)) };

  const wireBytes = utf8(JSON.stringify(envelope)).byteLength;
  if (wireBytes > RELAY_MAX_FRAME_BYTES) {
    throw new Error(`Relay envelope size ${wireBytes} exceeds maximum ${RELAY_MAX_FRAME_BYTES} bytes`);
  }
  return envelope;
}

export async function decryptRelayEnvelope<T = unknown>(
  envelope: unknown,
  options: DecryptEnvelopeOptions,
): Promise<DecryptedRelayEnvelope<T>> {
  checkEnvelopeFor(envelope, options);
  // Authenticate the sender BEFORE any key agreement: `from` is only a claim until this signature verifies.
  if (typeof options.senderSignKey !== 'string' || !await verifyRelayEnvelopeSig(envelope, options.senderSignKey)) {
    throw new Error('Relay envelope sender signature invalid');
  }
  return openEnvelope<T>(envelope, options);
}

/**
 * Opens an envelope from a sender whose signing key only the packet carries: remote control's enrolment
 * (docs/flows/remote-control.md), where the browser learns the machine's keys from the machine's first message. It
 * decrypts first, then requires the key `keyOf(packet)` names to hash to `from` and `sig` to verify under it. Anyone can
 * seal a packet to a device's encryption key, so the caller must also authenticate the packet by other means (the
 * enrolment's HMAC under the link's secret) before trusting it.
 */
export async function decryptSelfCertifiedEnvelope<T = unknown>(
  envelope: unknown,
  options: Omit<DecryptEnvelopeOptions, 'senderSignKey'> & { keyOf: (packet: T) => unknown },
): Promise<DecryptedRelayEnvelope<T> & { senderSignKey: string }> {
  checkEnvelopeFor(envelope, options);
  const opened = await openEnvelope<T>(envelope, options);
  const key = options.keyOf(opened.packet);
  if (typeof key !== 'string' || !BASE64_STD.test(key) || key.length !== 88) throw new Error('Relay envelope sender signature invalid');
  const id = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', base64ToBytes(key))), b => b.toString(16).padStart(2, '0')).join('');
  if (id !== envelope.from || !await verifyRelayEnvelopeSig(envelope, key)) throw new Error('Relay envelope sender signature invalid');
  return { ...opened, senderSignKey: key };
}

/** What every envelope must be before anything is derived from it: well formed, in size, for this room and this device. */
function checkEnvelopeFor(envelope: unknown, options: Pick<DecryptEnvelopeOptions, 'room' | 'selfDeviceId' | 'minRosterVersion' | 'expectedFrom'>): asserts envelope is RelayEnvelope {
  if (!isValidRelayEnvelopeShape(envelope)) {
    throw new Error('Invalid relay envelope shape');
  }
  const wireBytes = utf8(JSON.stringify(envelope)).byteLength;
  if (wireBytes > RELAY_MAX_FRAME_BYTES) {
    throw new Error(`Relay envelope size ${wireBytes} exceeds maximum ${RELAY_MAX_FRAME_BYTES} bytes`);
  }
  if (envelope.from === options.selfDeviceId) {
    throw new Error('Refusing reflected relay envelope from self');
  }
  if (envelope.room !== options.room) {
    throw new Error('Relay envelope room mismatch');
  }
  if (options.expectedFrom !== undefined && envelope.from !== options.expectedFrom) {
    throw new Error('Relay envelope sender mismatch');
  }
  if (options.minRosterVersion !== undefined && envelope.roster < options.minRosterVersion) {
    throw new Error('Relay envelope roster version below minimum');
  }
  if (!Object.prototype.hasOwnProperty.call(envelope.to, options.selfDeviceId)) {
    throw new Error('Relay envelope is not addressed to this device');
  }
}

/** Unwraps the envelope's key with this device's and decrypts it. The caller has checked it (checkEnvelopeFor). */
async function openEnvelope<T>(envelope: RelayEnvelope, options: Pick<DecryptEnvelopeOptions, 'selfDeviceId' | 'selfEncPrivateKey' | 'selfEncVersion'>): Promise<DecryptedRelayEnvelope<T>> {

  const wrappedBytes = base64ToBytes(envelope.to[options.selfDeviceId]);
  if (wrappedBytes.byteLength !== EXPECTED_WRAPPED_DEK_BYTES) {
    throw new Error('Invalid wrapped DEK length');
  }
  const wrapIv = wrappedBytes.slice(0, WRAP_IV_BYTES);
  const wrapCt = wrappedBytes.slice(WRAP_IV_BYTES);

  const epkKey = await importEncPublicKey(envelope.epk);
  const salt = utf8(envelope.id);
  const info = wrapInfoBytes(envelope.room, envelope.from, options.selfDeviceId, options.selfEncVersion);
  const wrapKey = await deriveWrapKey(options.selfEncPrivateKey, epkKey, salt, info, 'decrypt');

  let dekBuf: ArrayBuffer;
  try {
    dekBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: wrapIv, additionalData: info },
      wrapKey,
      wrapCt,
    );
  } catch {
    throw new Error('Failed to unwrap relay envelope DEK');
  }
  if (dekBuf.byteLength !== DEK_BYTES) {
    throw new Error('Unwrapped DEK has invalid length');
  }
  const dekKey = await crypto.subtle.importKey('raw', dekBuf, { name: 'AES-GCM' }, false, ['decrypt']);

  const iv = base64ToBytes(envelope.iv);
  if (iv.byteLength !== ENVELOPE_IV_BYTES) {
    throw new Error('Invalid relay envelope IV length');
  }
  const ct = base64ToBytes(envelope.ct);
  const aad = envelopeAad(envelope);

  let paddedBuf: ArrayBuffer;
  try {
    paddedBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad },
      dekKey,
      ct,
    );
  } catch {
    throw new Error('Relay envelope authentication or decryption failed');
  }

  const plainBytes = unpadPlaintext(new Uint8Array(paddedBuf));
  const packet = JSON.parse(textDecoder.decode(plainBytes)) as T;
  return { packet, rosterVersion: envelope.roster };
}

// ---------------------------------------------------------------------------
// 6.4 Sealed agent state (AES-256-GCM, HKDF-derived state key, <= 256 KB)
// ---------------------------------------------------------------------------

async function deriveStateKey(
  encPrivateKeyOrSecret: StateSecretInput,
  context: SealedStateContext,
  usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> {
  if (!context.room || !context.deviceId) {
    throw new Error('Sealed state requires room and deviceId');
  }
  let ikm: ArrayBuffer;
  if (encPrivateKeyOrSecret instanceof Uint8Array) {
    if (encPrivateKeyOrSecret.byteLength < 16) {
      throw new Error('State secret must be at least 16 bytes');
    }
    const copy = new Uint8Array(new ArrayBuffer(encPrivateKeyOrSecret.byteLength));
    copy.set(encPrivateKeyOrSecret);
    ikm = copy.buffer;
  } else if (typeof CryptoKey !== 'undefined' && encPrivateKeyOrSecret instanceof CryptoKey) {
    const pointH = await getSealedStatePoint();
    ikm = await crypto.subtle.deriveBits({ name: 'ECDH', public: pointH }, encPrivateKeyOrSecret, 256);
  } else if (isPlainObj(encPrivateKeyOrSecret)) {
    const privKey = await importEncPrivateJwk(encPrivateKeyOrSecret as JsonWebKey, false);
    const pointH = await getSealedStatePoint();
    ikm = await crypto.subtle.deriveBits({ name: 'ECDH', public: pointH }, privKey, 256);
  } else {
    throw new Error('Unsupported state key material');
  }

  const hkdfKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  const salt = utf8(`meshrooms-sealed-state-salt-v1|${context.room}`);
  const info = utf8(`meshrooms-sealed-state-v1|${context.room}|${context.deviceId}`);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

export async function sealAgentState(
  stateObj: unknown,
  encPrivateKeyOrSecret: StateSecretInput,
  context: SealedStateContext,
): Promise<string> {
  const jsonStr = JSON.stringify(stateObj);
  if (jsonStr === undefined) throw new Error('State object is not JSON-serializable');
  const plainBytes = utf8(jsonStr);
  const key = await deriveStateKey(encPrivateKeyOrSecret, context, 'encrypt');
  const iv = new Uint8Array(new ArrayBuffer(SEALED_STATE_IV_BYTES));
  crypto.getRandomValues(iv);
  const aad = utf8(`meshrooms-sealed-state-v1|${context.room}|${context.deviceId}`);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plainBytes));

  const out = new Uint8Array(1 + SEALED_STATE_IV_BYTES + ct.byteLength);
  out[0] = SEALED_STATE_VERSION;
  out.set(iv, 1);
  out.set(ct, 1 + SEALED_STATE_IV_BYTES);
  const blob = bytesToBase64(out);
  if (blob.length > SEALED_STATE_MAX_BYTES) {
    throw new Error(`Sealed state size ${blob.length} exceeds maximum ${SEALED_STATE_MAX_BYTES} bytes`);
  }
  return blob;
}

export async function unsealAgentState<T = unknown>(
  blob: string,
  encPrivateKeyOrSecret: StateSecretInput,
  context: SealedStateContext,
): Promise<T> {
  if (typeof blob !== 'string' || blob.length === 0) {
    throw new Error('Sealed state blob is empty');
  }
  if (blob.length > SEALED_STATE_MAX_BYTES) {
    throw new Error(`Sealed state size ${blob.length} exceeds maximum ${SEALED_STATE_MAX_BYTES} bytes`);
  }
  const raw = base64ToBytes(blob);
  if (raw.byteLength < 1 + SEALED_STATE_IV_BYTES + GCM_TAG_BYTES) {
    throw new Error('Truncated sealed state blob');
  }
  if (raw[0] !== SEALED_STATE_VERSION) {
    throw new Error('Unsupported sealed state version');
  }
  const iv = raw.slice(1, 1 + SEALED_STATE_IV_BYTES);
  const ct = raw.slice(1 + SEALED_STATE_IV_BYTES);
  const key = await deriveStateKey(encPrivateKeyOrSecret, context, 'decrypt');
  const aad = utf8(`meshrooms-sealed-state-v1|${context.room}|${context.deviceId}`);

  let plainBuf: ArrayBuffer;
  try {
    plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ct);
  } catch {
    throw new Error('Failed to unseal agent state');
  }
  return JSON.parse(textDecoder.decode(new Uint8Array(plainBuf))) as T;
}

// ---------------------------------------------------------------------------
// 6.3 MESHROOMS_AGENT_KEY encoding & strict validation
// ---------------------------------------------------------------------------

function isValidP256PrivateJwk(value: unknown): value is JsonWebKey {
  return (
    isPlainObj(value)
    && value.kty === 'EC'
    && value.crv === 'P-256'
    && typeof value.x === 'string' && value.x.length > 0
    && typeof value.y === 'string' && value.y.length > 0
    && typeof value.d === 'string' && value.d.length > 0
  );
}

function validateAgentKeySecret(value: unknown): AgentKeySecret {
  if (!isPlainObj(value)) throw new Error('Invalid MESHROOMS_AGENT_KEY payload');
  if (typeof value.origin !== 'string' || !value.origin) {
    throw new Error('Invalid MESHROOMS_AGENT_KEY origin');
  }
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(value.origin);
  } catch {
    throw new Error('Invalid MESHROOMS_AGENT_KEY origin URL');
  }
  if ((parsedOrigin.protocol !== 'https:' && parsedOrigin.protocol !== 'http:') || parsedOrigin.origin !== value.origin) {
    throw new Error('MESHROOMS_AGENT_KEY origin must be a canonical http(s) origin');
  }
  if (typeof value.roomId !== 'string' || value.roomId.trim().length === 0 || value.roomId.length > 128) {
    throw new Error('Invalid MESHROOMS_AGENT_KEY roomId');
  }
  if (!isValidP256PrivateJwk(value.signJwk)) {
    throw new Error('Invalid MESHROOMS_AGENT_KEY signJwk');
  }
  if (!isValidP256PrivateJwk(value.encJwk)) {
    throw new Error('Invalid MESHROOMS_AGENT_KEY encJwk');
  }
  if (value.encJwk.d === value.signJwk.d) {
    throw new Error('MESHROOMS_AGENT_KEY encJwk must be distinct from signJwk');
  }
  if (typeof value.encVersion !== 'number' || !Number.isInteger(value.encVersion) || value.encVersion < 1) {
    throw new Error('Invalid MESHROOMS_AGENT_KEY encVersion');
  }
  let hostPin: string | undefined;
  if (value.hostPin !== undefined) {
    if (typeof value.hostPin !== 'string' || !HEX_PIN.test(value.hostPin)) {
      throw new Error('Invalid MESHROOMS_AGENT_KEY hostPin');
    }
    hostPin = value.hostPin.toLowerCase();
  }
  return {
    origin: value.origin,
    roomId: value.roomId,
    signJwk: {
      kty: 'EC',
      crv: 'P-256',
      x: value.signJwk.x,
      y: value.signJwk.y,
      d: value.signJwk.d,
    },
    encJwk: {
      kty: 'EC',
      crv: 'P-256',
      x: value.encJwk.x,
      y: value.encJwk.y,
      d: value.encJwk.d,
    },
    encVersion: value.encVersion,
    ...(hostPin !== undefined ? { hostPin } : {}),
  };
}

export function encodeAgentKeySecret(secret: AgentKeySecret): string {
  const clean = validateAgentKeySecret(secret);
  return bytesToBase64(utf8(JSON.stringify(clean)));
}

export function decodeAgentKeySecret(b64: string): AgentKeySecret {
  if (typeof b64 !== 'string') throw new Error('Invalid MESHROOMS_AGENT_KEY format');
  const trimmed = b64.trim();
  if (!trimmed) throw new Error('MESHROOMS_AGENT_KEY is empty');
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(base64ToBytes(trimmed)));
  } catch {
    throw new Error('Invalid MESHROOMS_AGENT_KEY encoding');
  }
  return validateAgentKeySecret(parsed);
}
