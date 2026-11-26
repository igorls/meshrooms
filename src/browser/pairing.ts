/**
 * Pairing the hosted browser with the desktop app (internal/docs/design/desktop-first.md, "Identity and pairing").
 * One convention for the browser, the room service and the app (desktop/src-tauri/src/pair.rs reads pair-words.json):
 *
 * - The browser makes a secret N of 32 random bytes, and hands it to the app in the link
 *   `meshrooms://pair?v=2&origin=<origin>&name=<name>&device=<browser device id>&rooms=<uuid,uuid>&secret=<N>`:
 *   the browser's device id is its one identity key's id (64 lowercase hex), N is base64url without padding (43 chars).
 * - The app's companion request in a room carries `pairing: hex(HMAC-SHA256(key = N, "meshrooms-pair-v2:" + roomId +
 *   ":" + appPublicKey + ":" + browserDeviceId))` (pairingProof), never N: appPublicKey is the requesting device's key as
 *   the room service stores it (base64 of the raw P-256 point). The browser then links each of its rooms with
 *   `link {pairing: N}`, and the room service recomputes the proof for each companion request waiting there with that
 *   request's own key, the room, and the LINKING device's id. A copied proof is worth nothing to another device or in
 *   another room, nobody makes a valid one without N, and only the browser device the link named can link it. The room
 *   service never shows a proof to anyone, the requester included.
 * - Both show the phrase: four words of pair-words.json (256 words), word i being byte i of sha256("phrase:" ++ N),
 *   where "phrase:" is ASCII bytes followed by N's raw bytes. The person types it in the app's own window. The phrase
 *   proves the person at the app sees the same pairing as some browser showing it; it does not prove who that browser
 *   is (the name and origin in the link are its claims).
 */
import WORDS from './pair-words.json';

export const PAIR_WORDS: readonly string[] = WORDS;
export const PAIRING_VERSION = '2';
/** How long the browser keeps the pairing open (the requests themselves expire after 10 minutes). */
export const PAIRING_TTL_MS = 15 * 60_000;
/** Rooms one pairing link names at most. */
export const PAIRING_MAX_ROOMS = 64;
/** The display name in a pairing link, in code points. */
export const PAIRING_NAME_MAX = 64;
/** The secret as it travels: base64url without padding. */
export const PAIRING_SECRET = /^[A-Za-z0-9_-]{43}$/;
/** The proof the app's requests carry, and a device id: 64 lowercase hex. */
export const PAIRING_PROOF = /^[a-f0-9]{64}$/;
export const DEVICE_ID = /^[a-f0-9]{64}$/;
/** What a request's proof is a MAC of: the room, the requesting device's key and the browser device that may link it. */
export const pairingMessage = (roomId: string, publicKey: string, browserDeviceId: string) => `meshrooms-pair-v2:${roomId}:${publicKey}:${browserDeviceId}`;

const hex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));

export function encodeSecret(secret: Uint8Array) {
  return btoa(String.fromCharCode(...secret)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** The 32 bytes of a secret, or undefined when it isn't one (only the canonical spelling of 32 bytes is accepted). */
export function decodeSecret(text: unknown): Uint8Array | undefined {
  if (typeof text !== 'string' || !PAIRING_SECRET.test(text)) return undefined;
  const bytes = Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='), c => c.charCodeAt(0));
  return bytes.length === 32 && encodeSecret(bytes) === text ? bytes : undefined;
}
export function newSecret() { return crypto.getRandomValues(new Uint8Array(32)); }
/** The proof a device with `publicKey` sends with its companion request in `roomId` (see the top of this file). */
export async function pairingProof(secret: Uint8Array, roomId: string, publicKey: string, browserDeviceId: string) {
  const key = await crypto.subtle.importKey('raw', secret as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(pairingMessage(roomId, publicKey, browserDeviceId))));
}
export async function pairingPhrase(secret: Uint8Array) {
  const digest = await sha256(new Uint8Array([...new TextEncoder().encode('phrase:'), ...secret]));
  return [0, 1, 2, 3].map(i => PAIR_WORDS[digest[i]]).join(' ');
}
/** A typed phrase as compared: lower case, words separated by single spaces. */
export const normalPhrase = (typed: string) => typed.toLowerCase().split(/[\s,.-]+/).filter(Boolean).join(' ');

/** Controls, bidi overrides and invisible formatting, which a name must never carry into the app's window. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
export function pairingName(name: string) {
  return [...name.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()].slice(0, PAIRING_NAME_MAX).join('').trim();
}

export function pairLink(input: { origin: string; name: string; device: string; rooms: string[]; secret: Uint8Array }) {
  const rooms = [...new Set(input.rooms)].slice(0, PAIRING_MAX_ROOMS);
  const query = new URLSearchParams({ v: PAIRING_VERSION, origin: input.origin, name: pairingName(input.name) || 'Meshrooms', device: input.device, rooms: rooms.join(','),
    secret: encodeSecret(input.secret) });
  return `meshrooms://pair?${query}`;
}

/**
 * Key-bound words (the words the person compares when linking a phone, replacing `pairingPhrase` for it): four words of
 * pair-words.json, word i being byte i of sha256("meshrooms-sas-v1:" ++ N ++ the requesting device's raw public key). The
 * phone computes them from its own key, the trusted device from the key `link {pairing, preview: true}` returns for the
 * request that answers N. Someone who photographed the code and asks from another key gets other words than the phone shows.
 */
export async function pairingSas(secret: Uint8Array, publicKey: string) {
  const key = Uint8Array.from(atob(publicKey), c => c.charCodeAt(0));
  const digest = await sha256(new Uint8Array([...new TextEncoder().encode('meshrooms-sas-v1:'), ...secret, ...key]));
  return [0, 1, 2, 3].map(i => PAIR_WORDS[digest[i]]).join(' ');
}

/**
 * A typed pairing code (`pair-offer` in the room service): 10 characters of Crockford base32 (50 bits), shown as XXXXX-XXXXX.
 * Neither the code nor the secret it makes ever reaches the room service: the trusted device sends `offerLookup(code)` to
 * file the offer, the phone sends the same lookup to redeem it, and both derive the pairing secret N from the code
 * itself, so the `request {pairing}` / `link {pairing}` convention above is unchanged.
 */
export const OFFER_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const OFFER_CODE_LENGTH = 10;
/** How long the room service keeps an offer, and the most rooms one names (the phone asks in each). */
export const OFFER_TTL_MS = 5 * 60_000;
export const OFFER_MAX_ROOMS = 8;
/** The lookup the room service files an offer under: 64 lowercase hex. */
export const OFFER_LOOKUP = /^[a-f0-9]{64}$/;
export function newOfferCode() {
  // 32 symbols, so one random byte masked to five bits is uniform.
  return [...crypto.getRandomValues(new Uint8Array(OFFER_CODE_LENGTH))].map(b => OFFER_ALPHABET[b & 31]).join('');
}
export const showOfferCode = (code: string) => `${code.slice(0, 5)}-${code.slice(5)}`;
/** A typed code as compared: case and separators ignored, I and L read as 1, O as 0 (Crockford); undefined when it can't be one. */
export function normalOfferCode(typed: string) {
  const code = typed.toUpperCase().replace(/[\s.-]+/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return code.length === OFFER_CODE_LENGTH && [...code].every(c => OFFER_ALPHABET.includes(c)) ? code : undefined;
}
async function offerKey(code: string, purpose: 'secret' | 'lookup') {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('meshrooms-offer-v1'), info: new TextEncoder().encode(purpose) }, base, 256));
}
/** N for a typed code: the same 32 bytes on both devices, never sent anywhere. */
export const offerSecret = (code: string) => offerKey(code, 'secret');
export const offerLookup = async (code: string) => hex(await offerKey(code, 'lookup'));
