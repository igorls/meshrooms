/**
 * "Connect your phone" (docs/browser-rooms.md): a device already in the person's rooms shows a QR code; the phone opens
 * it, asks to join each of those rooms as a companion, and the trusted device links it with the one-time secret. It is
 * the desktop-app pairing (pairing.ts) with a browser in the app's place, so the room service sees the same two
 * commands: `request {kind: 'companion', pairing: <proof>}` from the phone and `link {pairing: <secret>}` from the
 * trusted device, in every room named.
 *
 * What the code holds, all in the URL fragment (never sent to a server, never in a Referer):
 *   `#pair=p1.<secret>.<device>.<name>.<rooms>`
 * the secret N (base64url, 43), the trusted device's id (32 bytes, base64url, 43), the person's name (UTF-8, base64url,
 * may be empty), and the rooms (16 bytes each, base64url, 22 each, at most PHONE_MAX_ROOMS). The page it opens is the
 * same origin that showed it, so the origin travels as the page itself.
 */
import { DEVICE_ID, OFFER_MAX_ROOMS, PAIRING_PROOF, decodeSecret, encodeSecret, normalOfferCode, offerLookup, offerSecret, pairingName, pairingProof, pairingSas } from './pairing';
import { PAIRING_NOT_FOUND, PAIR_OFFER_NOT_FOUND, type PairingOffer, type PairingPreview } from './protocol';

/** How long a code lives. The requests the phone makes expire at the room service after 10 minutes in any case. */
export const PHONE_TTL_MS = 5 * 60_000;
/** Rooms one code names: more would make the code too dense to scan from a screen. */
export const PHONE_MAX_ROOMS = 8;
const ROOM_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const B64URL = /^[A-Za-z0-9_-]*$/;

/** `expiresAt` is set when the room service said how long the link lives (a typed code); a scanned code lives PHONE_TTL_MS from when it was opened. */
export type PhoneLink = { secret: Uint8Array; device: string; name: string; rooms: string[]; expiresAt?: number };

const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], pair => parseInt(pair, 16));
const bytesToHex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
/** Base64url without padding (encodeSecret is that for 32 bytes; this takes any length). */
function b64url(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64url(text: string): Uint8Array | undefined {
  if (!B64URL.test(text) || text.length % 4 === 1) return undefined;
  try {
    const bytes = Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4)), c => c.charCodeAt(0));
    return b64url(bytes) === text ? bytes : undefined;
  } catch { return undefined; }
}

/** The fragment (without the leading `#`) for a pairing. */
export function phoneFragment(link: PhoneLink) {
  const rooms = [...new Set(link.rooms)].filter(id => ROOM_ID.test(id)).slice(0, PHONE_MAX_ROOMS);
  if (!DEVICE_ID.test(link.device)) throw new Error('A pairing names the trusted device by its id.');
  const name = new TextEncoder().encode(pairingName(link.name));
  return `pair=p1.${encodeSecret(link.secret)}.${encodeSecret(hexToBytes(link.device))}.${b64url(name)}.${rooms.map(id => b64url(hexToBytes(id.replace(/-/g, '')))).join('')}`;
}
export const phoneUrl = (origin: string, link: PhoneLink) => `${origin}/rooms#${phoneFragment(link)}`;

/** What a fragment says, or undefined when it is not a well-formed pairing (anything off is refused, nothing is guessed). */
export function parsePhoneFragment(hash: string): PhoneLink | undefined {
  const match = /^#?pair=p1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]*)\.([A-Za-z0-9_-]+)$/.exec(hash);
  if (!match) return undefined;
  const secret = decodeSecret(match[1]), deviceBytes = unb64url(match[2]), nameBytes = unb64url(match[3]), roomText = match[4];
  if (!secret || deviceBytes?.length !== 32 || !nameBytes || nameBytes.length > 256 || roomText.length % 22 !== 0 || roomText.length / 22 > PHONE_MAX_ROOMS) return undefined;
  const rooms: string[] = [];
  for (let i = 0; i < roomText.length; i += 22) {
    const bytes = unb64url(roomText.slice(i, i + 22));
    if (bytes?.length !== 16) return undefined;
    const hex = bytesToHex(bytes), id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    if (!ROOM_ID.test(id) || rooms.includes(id)) return undefined;
    rooms.push(id);
  }
  const name = pairingName(new TextDecoder().decode(nameBytes));
  return { secret, device: bytesToHex(deviceBytes), name, rooms };
}

/** A device label people can tell apart in a list: "iPhone (Safari)", never a bare "Mac browser" for an iPhone. */
export function deviceLabel(userAgent: string, touchPoints = 0) {
  const ua = userAgent || '';
  // iPadOS asks for the desktop site by default and says Macintosh; only a touch screen gives it away.
  const device = /iPhone|iPod/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1) ? 'iPad'
    : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet') : /CrOS/.test(ua) ? 'Chromebook'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux|X11/.test(ua) ? 'Linux' : '';
  const browser = /EdgA?\/|Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : '';
  return device && browser ? `${device} (${browser})` : device ? `${device} browser` : browser ? `${browser} browser` : 'Browser';
}

export type LinkState = 'waiting' | 'joined' | 'host' | 'missing' | 'failed';
export type LinkProblem = { status?: number; code?: string; message: string };
/** Links per room for one confirmation, a few seconds apart (the phone may still be asking in later rooms). */
export const LINK_TRIES = 3, LINK_BETWEEN_MS = 3_000;

/**
 * The trusted device confirms: it links each room still waiting with the secret, a few times while the phone may still be
 * asking. Every link that matches nothing counts against this device's own wrong-code budget in that room (8 per 10
 * minutes), so it runs on the person's word, never on a timer. `report` is called with each room's new state.
 */
export async function linkPhoneRooms(input: {
  rooms: string[]; secret: string; stopped(): boolean;
  link(roomId: string, secret: string): Promise<Record<string, unknown>>;
  report(roomId: string, state: LinkState, problem?: string): void;
  sleep?(ms: number): Promise<void>;
}): Promise<{ states: Record<string, LinkState>; rateLimited: boolean }> {
  const sleep = input.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const states: Record<string, LinkState> = Object.fromEntries(input.rooms.map(id => [id, 'waiting' as LinkState]));
  let rateLimited = false;
  for (let attempt = 0; attempt < LINK_TRIES && !input.stopped() && !rateLimited; attempt++) {
    if (attempt) await sleep(LINK_BETWEEN_MS);
    for (const id of input.rooms.filter(room => states[room] === 'waiting')) {
      if (input.stopped()) return { states, rateLimited };
      try {
        const answer = await input.link(id, input.secret);
        states[id] = answer.admitted === false ? 'host' : 'joined'; input.report(id, states[id]);
      } catch (error) {
        const e = error as LinkProblem;
        if (e.code === PAIRING_NOT_FOUND) continue;
        if (e.status === 429) { rateLimited = true; break; }
        states[id] = 'failed'; input.report(id, 'failed', e.message);
      }
    }
    if (!input.rooms.some(id => states[id] === 'waiting')) break;
  }
  for (const id of input.rooms) if (states[id] === 'waiting') { states[id] = 'missing'; input.report(id, 'missing'); }
  return { states, rateLimited };
}

/** What the phone knows of one room. */
export type PhoneRoomState = 'asking' | 'asked' | 'joined' | 'host' | 'failed';
/** The phone asks to join every room in the code, one after the other, with the proof for each (pairing.ts). */
export async function askPhoneRooms(input: {
  rooms: string[]; secret: Uint8Array; trustedDevice: string; publicKey: string; label: string;
  request(roomId: string, payload: Record<string, unknown>): Promise<unknown>;
  report(roomId: string, state: PhoneRoomState, problem?: string): void;
}) {
  for (const id of input.rooms) {
    try {
      const pairing = await pairingProof(input.secret, id, input.publicKey, input.trustedDevice);
      if (!PAIRING_PROOF.test(pairing)) throw new Error('Could not make the proof.');
      await input.request(id, { name: 'Companion device', label: input.label, kind: 'companion', pairing });
      input.report(id, 'asked');
    } catch (error) { input.report(id, 'failed', (error as Error).message); }
  }
}

/** The phone reads a room's status while it waits: in the room (the trusted device linked it), waiting for the host, or still waiting. */
export function phoneRoomFrom(status: { memberId?: string; request?: { state: string; linkedMemberId?: string } }, current: PhoneRoomState): { state: PhoneRoomState; problem?: string } {
  if (status.memberId) return { state: 'joined' };
  const request = status.request;
  // Asked, and now there is no request: the computer withdrew it ("Not my phone" or a new code).
  if (!request) return current === 'asked' || current === 'host' ? { state: 'failed', problem: 'Your computer withdrew this request.' } : { state: current };
  if (request.state === 'admitted') return { state: 'joined' };
  if (request.state === 'declined') return { state: 'failed', problem: 'The host declined this device.' };
  if (request.state === 'expired') return { state: 'failed', problem: 'The request expired.' };
  if (request.linkedMemberId) return { state: 'host' };
  return { state: current === 'host' ? 'host' : 'asked' };
}

/** The phone is done once nothing is still waiting for the trusted device; or, once something got in, a short while after the last change. */
export function phoneFinished(states: PhoneRoomState[], idleMs: number) {
  if (!states.length || states.some(s => s === 'asking')) return false;
  if (states.every(s => s !== 'asked')) return true;
  return states.some(s => s === 'joined' || s === 'host') && idleMs >= 8_000;
}

/** How the screens reach the room service: `link` for a room (with `preview` or `revoke`), `command` for the pairing-code actions. */
export type PairLinker = (roomId: string, secret: string, options?: { preview?: true; revoke?: true }) => Promise<Record<string, unknown>>;
export type PairCommander = (action: 'pair-offer' | 'pair-redeem' | 'pair-cancel', roomId: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** What the trusted device learns of the phone that answered the code: who it says it is, and the words only that phone's key gives. */
export type PhoneSeen = { label: string; deviceId: string; publicKey: string; words: string };
/**
 * The trusted device asks the room service which request answers the code (`link {pairing, preview}`), without linking it,
 * and works out the key-bound words from the key the service holds for it (pairingSas). Someone who photographed the code
 * and asks from another key gets other words than the phone shows. `undefined`: no room has the phone's request yet. A miss
 * costs the wrong-code budget, so at most `tries` rooms are asked, in the order the phone asks them.
 */
export async function previewPhone(input: { rooms: string[]; secret: Uint8Array; link: PairLinker; tries?: number }): Promise<PhoneSeen | undefined> {
  const text = encodeSecret(input.secret);
  for (const id of input.rooms.slice(0, input.tries ?? 2)) {
    try {
      const answer = (await input.link(id, text, { preview: true })).preview as Partial<PairingPreview> | undefined;
      if (!answer || typeof answer.publicKey !== 'string' || typeof answer.deviceId !== 'string') continue;
      return { label: typeof answer.label === 'string' ? answer.label : 'Device', deviceId: answer.deviceId, publicKey: answer.publicKey, words: await pairingSas(input.secret, answer.publicKey) };
    } catch (error) { if ((error as LinkProblem).code !== PAIRING_NOT_FOUND) throw error; }
  }
  return undefined;
}

/** Closing a pairing early: withdraws, in each room, the unused requests that answer the code. Best effort; the requests expire by themselves otherwise. */
export async function revokePhoneRooms(input: { rooms: string[]; secret: string; link: PairLinker }) {
  for (const id of input.rooms) { try { await input.link(id, input.secret, { revoke: true }); } catch { /* It expires in ten minutes anyway. */ } }
}

/** Files a typed code with the room service: only the lookup derived from it goes there, never the code or the secret. */
export async function fileOffer(input: { code: string; rooms: string[]; command: PairCommander }) {
  const rooms = [...new Set(input.rooms)].slice(0, OFFER_MAX_ROOMS);
  if (!rooms.length) throw new Error('Choose a room.');
  await input.command('pair-offer', rooms[0], { lookup: await offerLookup(input.code), rooms });
}
/** Withdraws a code the person no longer wants (best effort: it expires in five minutes anyway). */
export async function cancelOffer(input: { code: string; roomId: string; command: PairCommander }) {
  try { await input.command('pair-cancel', input.roomId, { lookup: await offerLookup(input.code) }); } catch { /* Expires by itself. */ }
}

/** The words for a typed code that cannot be one, said plainly. */
export const OFFER_TYPO = 'That is not a code. It has ten letters and numbers, like K7M2P-9XQ4D.';
export const OFFER_GONE = 'That code was not found. It may have been mistyped, already used or expired. Make a new one on your computer.';
/**
 * The phone types the code shown on the trusted device. It never leaves the phone: the lookup finds the offer, and N comes
 * from the code itself. The answer names the person, the trusted device and the rooms, and is checked like a scanned one.
 */
export async function redeemOffer(typed: string, command: PairCommander): Promise<PhoneLink> {
  const code = normalOfferCode(typed);
  if (!code) throw Object.assign(new Error(OFFER_TYPO), { code: 'offer-typo' });
  let offer: Partial<PairingOffer> | undefined;
  try { offer = (await command('pair-redeem', crypto.randomUUID(), { lookup: await offerLookup(code) })).offer as Partial<PairingOffer> | undefined; }
  catch (error) { if ((error as LinkProblem).code === PAIR_OFFER_NOT_FOUND) throw Object.assign(new Error(OFFER_GONE), { code: PAIR_OFFER_NOT_FOUND }); throw error; }
  const rooms = Array.isArray(offer?.rooms) ? offer.rooms : [];
  if (!offer || typeof offer.device !== 'string' || !DEVICE_ID.test(offer.device) || typeof offer.name !== 'string' || !rooms.length || rooms.length > PHONE_MAX_ROOMS
    || !rooms.every(id => typeof id === 'string' && ROOM_ID.test(id)) || new Set(rooms).size !== rooms.length) throw new Error('The room service sent something this phone can’t use. Make a new code.');
  return { secret: await offerSecret(code), device: offer.device, name: pairingName(offer.name), rooms, ...(typeof offer.expiresAt === 'number' ? { expiresAt: offer.expiresAt } : {}) };
}
