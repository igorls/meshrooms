/**
 * The machine's person device: the person who uses this OS account, as one more device of theirs in each of their rooms.
 * One P-256 key per OS user (identity.json, 0600), and a list of rooms (rooms.json) that is the source of truth: the room
 * service never learns "a person's rooms". Each room runs the same peer, store and runner as an agent's room
 * (BrowserAgent with `person`), in <person home>/browser-agents/<room>, so the machine's daemon looks after it like an
 * agent's room. Only admission differs: a person joins with `request {kind: 'person' | 'companion'}`, never a connect link.
 *
 * This file holds the person's files and what the commands and the local API read and write; agent-cli.ts wires the
 * runners and the daemon in.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ADMISSION_FILE, BrowserAgent, PERSON_STATUS_FILE, RUNNER_ALIVE, parseRoomUrl, pickDecision, replaceFile, roomClosed, type PersonStatus } from './browser-agent';
import { agentHomesFile } from './agent-watch';
import { MAX_MESSAGE_ATTACHMENTS, attachmentRef, isSha256, shownText, type AttachmentRef } from '../src/browser/files';
import { MAX_PENDING_ATTACHMENTS } from '../src/attachments';
import { foldBoard, taskBody, validTaskBody, type TaskChange } from '../src/browser/board';
import type { TaskStatus } from '../src/collab';
import { castVote, openDecision, reviseDecision, type DecisionMode } from '../src/browser/decisions';
import { MAX_REACTION_KEYS_PER_MEMBER, isReactionEmoji, liveKeysForMember, memberReacted } from '../src/browser/reactions';
import { countUnread } from '../src/browser/unread';
import { DEVICE_ID, PAIRING_MAX_ROOMS, decodeSecret, pairingMessage, pairingName } from '../src/browser/pairing';
import { PUBLIC_ROOM_SERVICE } from '../src/browser/protocol';

/** Files in the person's folder. */
export const PERSON_IDENTITY = 'identity.json', PERSON_ROOMS = 'rooms.json';
/** Files in a person room's folder: room.json as for agents, and where the person last read up to. */
export const PERSON_ROOM = 'room.json', READ_CURSOR = 'read.json';

/**
 * The person's folder: ~/.meshrooms/person, beside the agent registry like the daemon's folder, so a test that moves the
 * registry (MESHROOMS_AGENT_REGISTRY) never sees or writes the real person. MESHROOMS_PERSON_HOME overrides it.
 */
export function personHome(env: Record<string, string | undefined> = process.env, home = homedir()) {
  return env.MESHROOMS_PERSON_HOME ? resolve(env.MESHROOMS_PERSON_HOME) : join(dirname(agentHomesFile(home, env)), 'person');
}
export const personIdentityFile = (home = personHome()) => join(home, PERSON_IDENTITY);

const b64 = (bytes: ArrayBuffer) => Buffer.from(new Uint8Array(bytes)).toString('base64');
/** The person's device id and public key, once `person init` made them; never the private key. */
export function personIdentity(home = personHome()): { id: string; publicKey: string } | undefined {
  try {
    const { id, publicKey } = JSON.parse(readFileSync(personIdentityFile(home), 'utf8'));
    return typeof id === 'string' && typeof publicKey === 'string' ? { id, publicKey } : undefined;
  } catch { return undefined; }
}
/**
 * `person init`: makes the person's key, once. An existing key is kept (a second init changes nothing), since every room
 * the person is in knows this device by it. Written with `wx`, so two inits at once can't both write one.
 */
export async function initPerson(home = personHome()) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const existing = personIdentity(home);
  if (existing) return { created: false, deviceId: existing.id, home };
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const publicKey = b64(await crypto.subtle.exportKey('raw', keys.publicKey));
  const id = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex');
  try { writeFileSync(personIdentityFile(home), JSON.stringify({ id, publicKey, privateJwk: await crypto.subtle.exportKey('jwk', keys.privateKey) }), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if ((error as { code?: string }).code !== 'EEXIST') throw error; return { created: false, deviceId: personIdentity(home)!.id, home }; }
  return { created: true, deviceId: id, home };
}
function requireIdentity(home: string) {
  const identity = personIdentity(home);
  if (!identity) throw new Error('This machine has no person yet. Run person init first.');
  return identity;
}

/** One room in the person's list. `kind`: how this device asked to join (as a new person, or as a companion of one). */
export type PersonRoom = { roomId: string; origin: string; kind: 'person' | 'companion'; name?: string; joinedAt: number; created?: boolean };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** The most messages one read returns. */
export const MAX_PAGE = 200;
const validRoom = (r: unknown): r is PersonRoom => {
  const room = r as Partial<PersonRoom> | null;
  return !!room && typeof room.roomId === 'string' && UUID.test(room.roomId) && typeof room.origin === 'string' && /^https?:\/\/[^/]+$/.test(room.origin)
    && (room.kind === 'person' || room.kind === 'companion') && typeof room.joinedAt === 'number';
};
/** The person's rooms, in the order they were added; entries that don't parse are left out, never guessed at. */
export function personRooms(home = personHome()): PersonRoom[] {
  try { const rooms = JSON.parse(readFileSync(join(home, PERSON_ROOMS), 'utf8')); return Array.isArray(rooms) ? rooms.filter(validRoom) : []; } catch { return []; }
}
/** Adds or updates a room in the list, and writes the room's own room.json, which the daemon looks for. */
export function recordPersonRoom(room: PersonRoom, home = personHome()) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const rooms = personRooms(home), at = rooms.findIndex(r => r.roomId === room.roomId);
  const next = at < 0 ? [...rooms, room] : rooms.map((r, i) => i === at ? { ...r, ...room, joinedAt: r.joinedAt } : r);
  const agent = personAgent(room.roomId, home, room.origin);
  replaceFile(join(agent.dir, PERSON_ROOM), JSON.stringify({ origin: room.origin, roomId: room.roomId, person: true }));
  replaceFile(join(home, PERSON_ROOMS), JSON.stringify(next, null, 2));
  return agent;
}
/** The person device's peer in one room. `origin` is read from the room's room.json when not given. */
export function personAgent(roomId: string, home = personHome(), origin?: string, options: { mkdir?: boolean } = {}) {
  if (!UUID.test(roomId)) throw new Error('Use a room id like the one person rooms prints.');
  const from = origin ?? personRooms(home).find(r => r.roomId === roomId)?.origin;
  if (!from) throw new Error('The person on this machine has not joined that room. Join it from its link, in the Meshrooms app.');
  return new BrowserAgent(home, from, roomId, { ...options, person: { identityFile: personIdentityFile(home) } });
}

const readJson = <T>(path: string): T | undefined => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; } };
/** Where the room's request stands as the runner last heard it, while this device isn't admitted. */
export type Admission = { state: 'pending' | 'admitted' | 'declined' | 'expired' | 'none'; kind?: string; code?: string; expiresAt?: number; at: number };
export const admission = (agent: BrowserAgent) => readJson<Admission>(join(agent.dir, ADMISSION_FILE));
/**
 * The room as the person device holds it: `joined` once admitted; `waiting` for the host (or, for a companion, for one of
 * the person's devices to link it, with the code to give it); `declined` or `expired` (join again); `closed` by its host;
 * `removed` from the room after it was in it; `starting` before the runner first heard from the room service.
 */
export type RoomState = 'joined' | 'waiting' | 'declined' | 'expired' | 'closed' | 'removed' | 'starting';
export function roomState(agent: BrowserAgent): { state: RoomState; code?: string; reason?: string } {
  const closed = roomClosed(agent);
  if (closed) return { state: 'closed', reason: closed.reason };
  const proof = readJson<{ removedSince?: unknown }>(join(agent.dir, RUNNER_ALIVE));
  if (typeof proof?.removedSince === 'number') return { state: 'removed' };
  if (agent.members().memberId) return { state: 'joined' };
  const request = admission(agent);
  if (!request) return { state: 'starting' };
  if (request.state === 'pending') return { state: 'waiting', ...(request.code ? { code: request.code } : {}) };
  return { state: request.state === 'declined' || request.state === 'expired' ? request.state : 'starting' };
}

/**
 * `person join` and `person companion`: asks to join the room as this machine's person, and adds it to the list. A
 * device already admitted (or still waiting) asks nothing again; one whose request was declined or expired asks anew.
 * `ensureRunner` makes sure the room's runner runs (the daemon's, when it runs); it polls until the host (or, for a
 * companion, one of the person's own devices) admits this device.
 *
 * One person per app: once the app is paired (pairing.json), it joins rooms at that room service only, and as a person
 * under the paired name unless another is given. A room at another service is refused, as another browser's pairing is.
 */
export async function joinRoom(input: { url: string; kind: 'person' | 'companion'; name?: string; label: string },
  ensureRunner: (agent: BrowserAgent) => Promise<{ pid?: number; outcome: string }>, home = personHome()) {
  const identity = requireIdentity(home);
  const { origin, roomId } = parseRoomUrl(input.url);
  const paired = pairedWith(home);
  if (paired && paired.origin !== origin) throw new Error(otherService(paired, origin));
  const name = input.kind === 'person' ? (input.name ?? paired?.name)?.trim() : 'Companion device';
  if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) throw new Error('Give your name with --name (up to 80 characters).');
  const known = personRooms(home).find(r => r.roomId === roomId);
  if (known && known.origin !== origin) throw new Error(`This person is already in that room through ${known.origin}.`);
  const agent = personAgent(roomId, home, origin);
  // Admitted already: the runner's own record says so, and no status poll from here disturbs its presence.
  let status: any = agent.members().memberId ? { memberId: agent.members().memberId, title: agent.members().title } : undefined;
  if (!status) {
    status = await agent.command('status', { session: randomUUID() });
    if (status?.roomId !== roomId || status?.deviceId !== identity.id) throw new Error('The room service gave an unexpected answer, so nothing was asked.');
    if (!status.memberId && status.request?.state !== 'pending') {
      await agent.command('request', { kind: input.kind, name, label: input.label });
      status = await agent.command('status', { session: randomUUID() });
    }
  }
  recordPersonRoom({ roomId, origin, kind: known?.kind ?? input.kind, ...(input.kind === 'person' ? { name } : known?.name ? { name: known.name } : {}), joinedAt: Date.now() }, home);
  const runner = await ensureRunner(agent);
  const request = status.request;
  return { roomId, title: status.title ?? null, deviceId: identity.id, state: status.memberId ? 'joined' : request?.state === 'pending' ? 'waiting' : request?.state ?? 'waiting',
    ...(request?.code && !status.memberId ? { code: request.code } : {}), runner: runner.outcome, runnerPid: runner.pid ?? null };
}

/** A room service's origin as a pairing or a new room names it: HTTPS, or plain HTTP on this machine only, and no path. */
export function roomService(text: unknown) {
  let url: URL | undefined;
  try { url = typeof text === 'string' ? new URL(text) : undefined; } catch { url = undefined; }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url?.hostname ?? '');
  if (!url || url.origin !== text || !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) throw new Error('Give the room service as its origin, like https://rooms.example.');
  return url.origin;
}
export { PUBLIC_ROOM_SERVICE };
/**
 * Where a new room is made when nothing names a room service: MESHROOMS_ROOM_SERVICE, else the service of the room this
 * person last CREATED here, else the public one. A paired or companion room never sets it: a pairing link names its
 * origin itself, and a phished one must not quietly become where the person's next room lives.
 */
export function defaultRoomService(home = personHome(), env: Record<string, string | undefined> = process.env) {
  if (env.MESHROOMS_ROOM_SERVICE) return roomService(env.MESHROOMS_ROOM_SERVICE);
  const made = personRooms(home).filter(r => r.kind === 'person' && r.created === true);
  return made.length ? made.reduce((a, b) => b.joinedAt >= a.joinedAt ? b : a).origin : PUBLIC_ROOM_SERVICE;
}

/** Why a room at `origin` can't be joined by an app paired with someone at another room service. */
export const otherService = (paired: { name: string; origin: string }, origin: string) =>
  `This app is paired with ${paired.name} at ${paired.origin}, so it can't join a room at ${origin}: one person per app. Open that room in your browser, or unpair this app first.`;
/**
 * Whether the person's claim on the app still holds: some room has this device in it, or still has its request waiting
 * (unexpired), as the rooms' runners last heard. A pairing that was never confirmed lapses with its requests.
 */
export function claimHolds(home = personHome(), now = Date.now()) {
  return listedAgents(home).some(({ agent }) => {
    if (agent.members().memberId) return true;
    const request = admission(agent);
    return request?.state === 'pending' && typeof request.expiresAt === 'number' && request.expiresAt > now;
  });
}
/** The one person this app is paired with (pairing.json): the browser device that paired it, at its room service. */
export type PairedWith = { origin: string; device: string; name: string; at: number };
export const PAIRED_FILE = 'pairing.json';
export function pairedWith(home = personHome()): PairedWith | undefined {
  const value = readJson<Partial<PairedWith>>(join(home, PAIRED_FILE));
  return value && typeof value.origin === 'string' && typeof value.device === 'string' && DEVICE_ID.test(value.device) && typeof value.name === 'string' && typeof value.at === 'number'
    ? value as PairedWith : undefined;
}
type Ensure = (agent: BrowserAgent) => Promise<{ pid?: number; outcome: string }>;
/** One room of a pairing, as `person pair` reports it. `failed` rooms say why, and stay off the person's list. */
export type PairedRoom = { roomId: string; state: 'joined' | 'waiting' | 'failed'; title?: string | null; error?: string };
/**
 * `person pair`: the app's half of pairing with the person's browser (src/browser/pairing.ts). In every room the browser
 * named, this device asks to join as a companion with a proof made from the browser's secret, bound to this device's key
 * and that room (pairingProof; the secret itself never leaves this machine), adds the room to the list, and starts its
 * runner: the browser then links each request with the secret, and the runners see themselves admitted. A room this
 * device is already in is only listed again. Makes the person first when needed. `secret`: base64url, 32 bytes.
 * `device`: the browser's device id; only that browser device can link these requests (the proof names it).
 *
 * One person per app: the first pairing records who paired it (pairing.json). Later pairings from the same browser
 * device at the same room service add rooms; any other is refused until the app is unpaired (`person unpair`).
 */
export async function pairRooms(input: { origin: unknown; rooms: unknown; name: unknown; device: unknown; secret: unknown }, ensureRunner: Ensure, home = personHome()) {
  const origin = roomService(input.origin);
  if (typeof input.device !== 'string' || !DEVICE_ID.test(input.device)) throw new Error('Give the browser\'s device id as 64 lowercase hex characters.');
  const device = input.device;
  let paired = pairedWith(home);
  // A claim no room ever confirmed (the browser never linked, and every request expired or was declined) has lapsed:
  // it holds the app for nobody.
  if (paired && !claimHolds(home)) { rmSync(join(home, PAIRED_FILE), { force: true }); paired = undefined; }
  if (paired && (paired.origin !== origin || paired.device !== device))
    throw new Error(`This app is paired with ${paired.name} at ${paired.origin}. Unpair it first in the app.`);
  const rooms = typeof input.rooms === 'string' ? [...new Set(input.rooms.split(','))] : [];
  if (!rooms.length || rooms.length > PAIRING_MAX_ROOMS || !rooms.every(r => UUID.test(r))) throw new Error(`Give the rooms as 1 to ${PAIRING_MAX_ROOMS} room ids, separated by commas.`);
  const secret = decodeSecret(input.secret);
  if (!secret) throw new Error('Give the pairing secret from the browser (32 bytes, base64url).');
  const name = typeof input.name === 'string' ? pairingName(input.name) : '';
  if (!name) throw new Error('Give the name of the person pairing.');
  const made = await initPerson(home), identity = requireIdentity(home);
  const results: PairedRoom[] = [];
  for (const roomId of rooms) {
    try {
      const known = personRooms(home).find(r => r.roomId === roomId);
      if (known && known.origin !== origin) throw new Error(`This person is already in that room through ${known.origin}.`);
      const agent = personAgent(roomId, home, origin);
      let status: any = agent.members().memberId ? { memberId: agent.members().memberId, title: agent.members().title } : undefined;
      if (!status) {
        status = await agent.command('status', { session: randomUUID() });
        if (status?.roomId !== roomId || status?.deviceId !== identity.id) throw new Error('The room service gave an unexpected answer, so nothing was asked.');
        // A request already linked, and waiting for the host, is left as it is; one waiting under the same proof is kept
        // by the room service, and one under another proof (an earlier pairing) is replaced.
        if (!status.memberId && !(status.request?.state === 'pending' && status.request.linkedMemberId)) {
          const pairing = createHmac('sha256', secret).update(pairingMessage(roomId, identity.publicKey, device)).digest('hex');
          await agent.command('request', { kind: 'companion', name: 'Companion device', label: 'Meshrooms app', pairing });
        }
      }
      recordPersonRoom({ roomId, origin, kind: known?.kind ?? 'companion', name: known?.name ?? name, joinedAt: Date.now() }, home);
      results.push({ roomId, state: status.memberId ? 'joined' : 'waiting', title: status.title ?? null });
    } catch (error) {
      // A room that never made it onto the list leaves no folder behind.
      if (!personRooms(home).some(r => r.roomId === roomId)) rmSync(join(home, 'browser-agents', roomId), { recursive: true, force: true });
      results.push({ roomId, state: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }
  secret.fill(0);
  // The app is claimed by this browser only once a room took its request (or already had this device): a pairing whose
  // every room failed claims nothing.
  if (!paired && results.some(r => r.state !== 'failed')) replaceFile(join(home, PAIRED_FILE), JSON.stringify({ origin, device, name, at: Date.now() } satisfies PairedWith));
  // The runners once every request is in, together: the browser links the rooms as soon as the app has asked in them.
  await Promise.all(results.filter(r => r.state !== 'failed').map(r => ensureRunner(personAgent(r.roomId, home, origin)).catch(() => undefined)));
  return { deviceId: identity.id, created: made.created, origin, rooms: results };
}

/**
 * `person titles`: the rooms a pairing link names, as their room service shows them to anyone (GET /api/lobby/rooms/:id),
 * for the app's window to list before the final Pair. Plain, short text; a room that doesn't answer is null.
 */
export async function roomTitles(input: { origin: unknown; rooms: unknown }) {
  const origin = roomService(input.origin);
  const rooms = typeof input.rooms === 'string' ? [...new Set(input.rooms.split(','))] : [];
  if (!rooms.length || rooms.length > PAIRING_MAX_ROOMS || !rooms.every(r => UUID.test(r))) throw new Error(`Give the rooms as 1 to ${PAIRING_MAX_ROOMS} room ids, separated by commas.`);
  const titles = await Promise.all(rooms.map(async roomId => {
    try {
      const response = await fetch(`${origin}/api/lobby/rooms/${roomId}`, { redirect: 'error', signal: AbortSignal.timeout(8_000) });
      const text = response.ok ? await cappedText(response, 4_096) : undefined;
      const title = text ? (JSON.parse(text) as { title?: unknown }).title : undefined;
      return { roomId, title: typeof title === 'string' ? pairingName(title) || null : null };
    } catch { return { roomId, title: null }; }
  }));
  return { origin, rooms: titles };
}
/** A response body of at most `limit` bytes as text, or undefined past it: never read further than the limit. */
export async function cappedText(response: Response, limit: number) {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (!Number.isFinite(declared) || declared > limit) { await response.body?.cancel().catch(() => {}); return undefined; }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel().catch(() => {}); return undefined; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

/** How unpairing would go in one room, as the room service has it now. */
type UnpairRoom = { roomId: string; title: string | null; soleHost: boolean };
/** Answers that mean the room is gone for this device: closed (410), or unknown to the service (404). */
const roomGone = (error: unknown) => [404, 410].includes((error as { status?: number }).status ?? 0);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/**
 * The rooms whose only host device is this one: unpairing takes the key, so those rooms would lose their host. Read from
 * the room service (status), never from what a runner last wrote. A room that can't be read is `unreachable`.
 */
async function unpairRooms(home: string) {
  const identity = personIdentity(home);
  const rooms: UnpairRoom[] = [], unreachable: { roomId: string; error: string }[] = [];
  for (const { room, agent } of identity ? listedAgents(home) : []) {
    try {
      const status = await agent.command('status', { session: randomUUID() });
      const hostDevices = (status?.devices ?? []).filter((d: { memberId?: string }) => d.memberId === status.ownerId).length;
      rooms.push({ roomId: room.roomId, title: typeof status?.title === 'string' ? pairingName(status.title) || null : null,
        soleHost: !!status?.memberId && status.memberId === status.ownerId && hostDevices <= 1 });
    } catch (error) {
      if (roomGone(error)) rooms.push({ roomId: room.roomId, title: null, soleHost: false });
      else unreachable.push({ roomId: room.roomId, error: message(error) });
    }
  }
  return { rooms, unreachable };
}
/**
 * `person unpair --check`: what unpairing would do, for the app's window to say before anything changes: whom the app is
 * paired with, and the rooms this device is the only host device of (they would keep this device and lose their host).
 * Reads only.
 */
export async function unpairCheck(home = personHome()) {
  const paired = pairedWith(home), { rooms, unreachable } = await unpairRooms(home);
  return { pairedWith: paired ? { name: paired.name, origin: paired.origin } : null, rooms: rooms.length + unreachable.length,
    soleHost: rooms.filter(r => r.soleHost).map(({ roomId, title }) => ({ roomId, title })), unreachable };
}

/** How a runner stop went: stopped, there was none, or one still runs (busy, or it couldn't be stopped). */
export type StopOutcome = 'stopped' | 'none' | 'alive';
/**
 * `person unpair`: the app forgets its person. Nothing is deleted until every room is settled:
 * 1. In each room this device leaves (is removed, or cancels its request). A room whose only host device is this one
 *    can't be left: with `anyway` (the person was told, and chose to), it keeps this device and loses its host
 *    (`kept`); without, unpairing stops there. A room that couldn't be reached (the network, the service) stops it too:
 *    the person tries again later, and nothing was deleted.
 * 2. Each room's runner is stopped (and marked stopped, so the daemon leaves it). One that still runs stops it too.
 * 3. Then the person folder goes: the key, the rooms and pairing.json.
 * `unpaired` is true only when the folder went; `kept` names rooms left hostless by choice. Only the app runs it, from
 * its own window; the localhost page has no way to.
 */
export async function unpairPerson(stop: (agent: BrowserAgent) => Promise<StopOutcome>, home = personHome(),
  options: { anyway?: boolean; beforeDelete?: () => Promise<{ roomId: string; title: string | null }[]> } = {}) {
  const identity = personIdentity(home), paired = pairedWith(home), was = paired ? { name: paired.name, origin: paired.origin } : null;
  const listed = identity ? listedAgents(home) : [];
  const rooms: { roomId: string; title: string | null; state: 'left' | 'kept' | 'failed'; error?: string }[] = [];
  for (const { room, agent } of listed) {
    let title: string | null = null;
    try {
      const status = await agent.command('status', { session: randomUUID() });
      title = typeof status?.title === 'string' ? pairingName(status.title) || null : null;
      const hostDevices = (status?.devices ?? []).filter((d: { memberId?: string }) => d.memberId === status.ownerId).length;
      if (status?.memberId && status.memberId === status.ownerId && hostDevices <= 1) {
        rooms.push(options.anyway ? { roomId: room.roomId, title, state: 'kept' }
          : { roomId: room.roomId, title, state: 'failed', error: 'This computer is the room\'s only host device. Unpair anyway to leave it without a host.' });
        continue;
      }
      if (status?.memberId) await agent.command('remove', { deviceId: identity!.id });
      else if (status?.request?.state === 'pending') await agent.command('cancel', { requestId: status.request.id });
      rooms.push({ roomId: room.roomId, title, state: 'left' });
    } catch (error) {
      rooms.push(roomGone(error) ? { roomId: room.roomId, title, state: 'left' } : { roomId: room.roomId, title, state: 'failed', error: message(error) });
    }
  }
  const kept = rooms.filter(r => r.state === 'kept').map(({ roomId, title }) => ({ roomId, title }));
  const failed = rooms.filter(r => r.state === 'failed');
  if (failed.length) return { unpaired: false, was, rooms, kept, failed, next: 'Nothing was deleted. Try again when these rooms can be reached.' };
  const running: { roomId: string; title: string | null }[] = [];
  for (const { room, agent } of listed) {
    const outcome = await stop(agent).catch(() => 'alive' as const);
    if (outcome === 'alive') running.push({ roomId: room.roomId, title: rooms.find(r => r.roomId === room.roomId)?.title ?? null });
  }
  // What else lives in the person's folder and runs (the agent identities' rooms) is let go first: `beforeDelete` names
  // the rooms where something still runs.
  if (options.beforeDelete) running.push(...await options.beforeDelete().catch(() => [{ roomId: '', title: null }]));
  if (running.length) return { unpaired: false, was, rooms, kept, failed: running.map(r => ({ ...r, state: 'failed' as const, error: 'Its background process is still running.' })),
    next: 'Nothing was deleted. Try again in a moment.' };
  // A runner that is still closing may hold a file for a moment (Windows): the folder goes once it lets go.
  for (let i = 0; existsSync(home); i++) {
    try { rmSync(home, { recursive: true, force: true }); }
    catch (error) { if (i >= 40) throw error; await Bun.sleep(250); }
  }
  return { unpaired: true, was, rooms, kept, failed: [] };
}

/**
 * `person create`: a new room, created by the person device (the new user's path: no browser to pair with). `invite`
 * is the room service's invite code when it asks for one. The room is the person's from the start, hosted by this device.
 */
export async function createRoom(input: { origin: unknown; title: unknown; name: unknown; invite?: unknown; roomId?: unknown }, ensureRunner: Ensure, home = personHome()) {
  const origin = roomService(input.origin);
  const text = (value: unknown, what: string) => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f]/.test(value)) throw new Error(`Give ${what} of up to 80 characters.`);
    return value.trim();
  };
  const title = text(input.title, 'the room a name'), name = text(input.name, 'your name');
  const invite = input.invite === undefined || input.invite === '' ? undefined : input.invite;
  if (invite !== undefined && (typeof invite !== 'string' || invite.length > 64)) throw new Error('Give the invite code as it was given to you.');
  const roomId = input.roomId === undefined ? randomUUID() : input.roomId;
  if (typeof roomId !== 'string' || !UUID.test(roomId)) throw new Error('Use a UUID for the room id.');
  await initPerson(home);
  // A retry of a create that was made (its answer lost) finds the room on the list already.
  const listed = personRooms(home).find(r => r.roomId === roomId);
  if (listed) return { roomId, origin: listed.origin, title, url: `${listed.origin}/r/${roomId}`, state: 'joined' as const, runner: 'unchanged', runnerPid: null };
  const agent = personAgent(roomId, home, origin);
  try { await agent.command('create', { title, name, label: 'Meshrooms app', ...(invite ? { invite: invite.trim() } : {}) }, roomId); }
  catch (error) {
    // Nothing of a room that was never made stays behind: its folder has no room.json, so nothing looks after it anyway.
    rmSync(agent.dir, { recursive: true, force: true });
    throw error;
  }
  recordPersonRoom({ roomId, origin, kind: 'person', name, created: true, joinedAt: Date.now() }, home);
  const runner = await ensureRunner(agent).catch(() => ({ outcome: 'not started', pid: undefined }));
  return { roomId, origin, title, url: `${origin}/r/${roomId}`, state: 'joined' as const, runner: runner.outcome, runnerPid: runner.pid ?? null };
}

/** The person device's peer in each listed room whose folder exists. */
export function listedAgents(home = personHome()) {
  return personRooms(home).flatMap(room => {
    if (!existsSync(join(home, 'browser-agents', room.roomId, PERSON_ROOM))) return [];
    return [{ room, agent: personAgent(room.roomId, home, room.origin, { mkdir: false }) }];
  });
}

/**
 * Where the person last read up to in a room: the newest message read (`id`, once the page says which) and its time;
 * messages after it from others are unread.
 */
function readUpTo(agent: BrowserAgent, joinedAt: number): { id?: string; at: number } {
  const cursor = readJson<{ at?: unknown; id?: unknown }>(join(agent.dir, READ_CURSOR));
  return { ...(typeof cursor?.id === 'string' && UUID.test(cursor.id) ? { id: cursor.id } : {}), at: typeof cursor?.at === 'number' ? cursor.at : joinedAt };
}
function markRead(agent: BrowserAgent, at: number, id?: string) {
  const current = readJson<{ at?: unknown }>(join(agent.dir, READ_CURSOR))?.at;
  if (typeof current !== 'number' || at > current || (id && at === current)) replaceFile(join(agent.dir, READ_CURSOR), JSON.stringify({ at, ...(id ? { id } : {}) }));
}
/** The page read the room up to `messageId` (a message it holds): the read cursor moves there, never back. */
export function markReadUpTo(agent: BrowserAgent, messageId: unknown) {
  const body = typeof messageId === 'string' ? agent.messages().find(m => m.packet.body.id === messageId)?.packet.body : undefined;
  if (!body) throw Object.assign(new Error('That message is not in this room.'), { status: 404 });
  markRead(agent, body.at, body.id);
  return { read: body.id };
}

/** A message as the local API hands it out: plain text and metadata, never a signature or a key. */
export type LocalMessage = { id: string; authorId: string; author: string; role: 'human' | 'agent'; own: boolean; text: string; at: string; replyTo?: string;
  attachments?: { id: string; name: string; type: string; size: number }[] };
export function localMessages(agent: BrowserAgent, stored = agent.messages()): LocalMessage[] {
  const { memberId, members } = agent.members(), names = new Map(members.map(m => [m.id, m]));
  return stored.map(({ packet: { body } }) => {
    const author = names.get(body.memberId);
    return { id: body.id, authorId: body.memberId, author: author?.name ?? 'Former member', role: author?.role ?? 'human', own: body.memberId === memberId,
      text: shownText(body), at: new Date(body.at).toISOString(), ...(body.replyTo ? { replyTo: body.replyTo } : {}),
      ...(body.attachments?.length ? { attachments: body.attachments.map(({ id, name, type, size }) => ({ id, name, type, size })) } : {}) };
  });
}
/** Who is in the room, and who has a device online now (as the person device's runner last heard). */
export function roomMembers(agent: BrowserAgent) {
  const { memberId, members, devices } = agent.members();
  return members.map(m => ({ id: m.id, name: m.name, role: m.role ?? 'human', ...(m.operatorId ? { operatorId: m.operatorId } : {}), self: m.id === memberId,
    online: devices.some(d => d.memberId === m.id && d.online === true) }));
}
/** The room as the person device's runner last heard it from the room service (see PERSON_STATUS_FILE). */
export const personRoomStatus = (agent: BrowserAgent) => readJson<PersonStatus>(join(agent.dir, PERSON_STATUS_FILE));
/**
 * The room for the local API's room list. `connected`: the room's runner proved it is alive within the last 15 s.
 * `mentions`: unread messages for the person (an @mention or a reply to them). `waiting`: in a room they host, who is
 * waiting to join, as the room's badge shows it.
 */
export function roomSummary(room: PersonRoom, agent: BrowserAgent, now = Date.now()) {
  const state = roomState(agent), { memberId, title, members } = agent.members();
  const since = readUpTo(agent, room.joinedAt), messages = agent.messages();
  const proof = readJson<{ at?: unknown }>(join(agent.dir, RUNNER_ALIVE));
  const bodies = messages.map(m => m.packet.body), held = since.id !== undefined && bodies.some(b => b.id === since.id);
  // Without a message id, or one the window evicted, the time decides: everything after it counts.
  const position = held ? { id: since.id, at: since.at } : { id: [...bodies].reverse().find(b => b.at <= since.at)?.id, at: since.at };
  const counted = memberId ? countUnread(bodies, position, memberId, members) : { unread: 0, mentions: 0 };
  const status = memberId ? personRoomStatus(agent) : undefined;
  const waiting = status?.ownerId === memberId ? (status?.requests ?? []).filter(r => r.state === 'pending').map(r => ({ id: r.id, name: r.name, kind: r.kind })) : [];
  return { roomId: room.roomId, origin: room.origin, kind: room.kind, title: title ?? null, ...state,
    connected: typeof proof?.at === 'number' && now - proof.at < 15_000,
    unread: counted.unread, mentions: counted.mentions, ...(waiting.length ? { waiting } : {}),
    lastMessageAt: messages.length ? new Date(Math.max(...messages.map(m => m.packet.body.at))).toISOString() : null,
    members: roomMembers(agent) };
}
/**
 * Messages after `after` (a message id), oldest first, at most `limit`; without `after`, the latest `limit`. Reading
 * them is reading: the read cursor moves to the newest message returned, which is how unread counts go down in M0.
 */
export function messagePage(agent: BrowserAgent, after: string | undefined, limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw Object.assign(new Error(`Use limit between 1 and ${MAX_PAGE}.`), { status: 400 });
  if (after !== undefined && !UUID.test(after)) throw Object.assign(new Error('Use after with a message id from this room.'), { status: 400 });
  // One pass over the stored window (at most MAX_STORED_MESSAGES) to find the cursor; only the page is shaped.
  const stored = agent.messages(), at = after === undefined ? stored.length : stored.findIndex(m => m.packet.body.id === after);
  if (at < 0) throw Object.assign(new Error('That message is not in this room (it may have left the history window). Read without after to start again.'), { status: 404 });
  const start = after === undefined ? Math.max(0, stored.length - limit) : at + 1, end = Math.min(stored.length, start + limit);
  const slice = stored.slice(start, end);
  let newest = 0; for (const m of slice) newest = Math.max(newest, m.packet.body.at);
  if (newest) markRead(agent, newest);
  return { roomId: agent.roomId, messages: localMessages(agent, slice), more: after === undefined ? start > 0 : end < stored.length };
}
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });
/** The person's member id in the room, once admitted, and the room still open: what every change from the page needs. */
function admittedIn(agent: BrowserAgent) {
  const memberId = agent.members().memberId;
  if (!memberId) throw httpError(409, 'This device is not admitted to the room yet.');
  if (roomClosed(agent)) throw httpError(410, 'This room is closed.');
  return memberId;
}
const requestIdOf = (value: unknown) => {
  if (value === undefined) return randomUUID();
  if (typeof value !== 'string' || !UUID.test(value)) throw httpError(400, 'Use a UUID for requestId.');
  return value;
};
const queued = (agent: BrowserAgent, id: string) => readdirSync(join(agent.dir, 'outbox')).some(f => f.endsWith(`-${id}.json`));
const enqueue = (agent: BrowserAgent, id: string, item: unknown) => { if (!queued(agent, id)) replaceFile(join(agent.dir, 'outbox', `${Date.now()}-${id}.json`), JSON.stringify(item)); };
/**
 * Waits up to `ms` for the runner to sign a queued change (`done`), so the page usually sees it made when the call
 * returns. `dropped`: the runner took it out of the outbox without making it (it no longer applied when signed).
 */
async function signed(agent: BrowserAgent, id: string, done: () => boolean, ms = 5_000) {
  for (const by = Date.now() + ms; Date.now() < by; await Bun.sleep(100)) {
    if (done()) return 'shared' as const;
    if (!queued(agent, id)) return done() ? 'shared' as const : 'dropped' as const;
  }
  return 'queued' as const;
}

/**
 * Queues a message for the room's runner to sign and deliver, as `send` does for an agent, without its floor rules: a
 * person speaks when they like. Returns at once; the events feed says when it is stored. A retry with the same
 * `requestId` never queues it twice. `attachments`: files the page uploaded first (storeUpload), by hash and name; their
 * references are made here again from the stored bytes, never taken from the page.
 */
export async function queueMessage(agent: BrowserAgent, input: { text: unknown; replyTo?: unknown; requestId?: unknown; attachments?: unknown }) {
  admittedIn(agent);
  const files = input.attachments === undefined ? [] : input.attachments;
  if (!Array.isArray(files) || files.length > MAX_MESSAGE_ATTACHMENTS || !files.every(f => isSha256(f?.sha256) && typeof f.name === 'string' && f.name.length <= 255))
    throw httpError(400, `Attach up to ${MAX_MESSAGE_ATTACHMENTS} files the page uploaded first.`);
  if (typeof input.text !== 'string' || input.text.length > 4000 || (!input.text.trim() && !files.length)) throw httpError(400, 'Write a message of up to 4,000 characters.');
  const replyTo = input.replyTo === undefined || input.replyTo === null ? undefined : input.replyTo;
  if (replyTo !== undefined && (typeof replyTo !== 'string' || !UUID.test(replyTo) || !agent.messages().some(m => m.packet.body.id === replyTo)))
    throw httpError(400, 'The reply target is not in this room.');
  const id = requestIdOf(input.requestId);
  markRead(agent, Date.now());
  if (agent.messages().some(m => m.packet.body.id === id)) return { messageId: id, status: 'stored' as const };
  const attachments: AttachmentRef[] = [];
  for (const file of files as { sha256: string; name: string }[]) {
    const bytes = await agent.files.get(file.sha256);
    if (!bytes) throw httpError(409, 'An attached file is no longer here. Attach it again.');
    attachments.push(await attachmentRef(bytes, file.name));
  }
  enqueue(agent, id, { id, text: input.text.trim(), ...(replyTo ? { replyTo } : {}), ...(attachments.length ? { attachments } : {}) });
  return { messageId: id, status: 'queued' as const };
}
/** Files uploaded for a message not sent yet, per room: as many as the hosted node allows, and this many bytes in all. */
export const MAX_PENDING_UPLOAD_BYTES = 50 * 1024 * 1024;
/** The room's stored files no message names: uploads waiting for their message (the runner prunes them after a while). */
function pendingUploads(agent: BrowserAgent) {
  const named = new Set(agent.messages().flatMap(m => (m.packet.body.attachments ?? []).map(ref => ref.sha256)));
  return readdirSync(join(agent.dir, 'files')).filter(name => isSha256(name) && !named.has(name))
    .map(name => { try { return lstatSync(join(agent.dir, 'files', name)).size; } catch { return 0; } });
}
/**
 * Whether the page may upload `size` more bytes (0 when it didn't say): admitted to the room, and within the pending
 * uploads' share, checked before the body is read and again once it is (when a file already stored, `sha`, is no new one).
 */
export function uploadAllowed(agent: BrowserAgent, size: number, sha?: string) {
  admittedIn(agent);
  if (sha && agent.files.has(sha)) return;
  const pending = pendingUploads(agent);
  if (pending.length >= MAX_PENDING_ATTACHMENTS || pending.reduce((sum, n) => sum + n, 0) + size > MAX_PENDING_UPLOAD_BYTES)
    throw httpError(429, 'Too many files are waiting to be sent in this room. Send or remove some first.');
}
/** A file the page attaches to its next message: kept in the room's file store (by hash) until the message names it. */
export async function storeUpload(agent: BrowserAgent, bytes: Uint8Array, name: string) {
  const ref = await attachmentRef(bytes, name).catch(error => { throw httpError(400, error instanceof Error ? error.message : String(error)); });
  uploadAllowed(agent, bytes.length, ref.sha256);
  agent.files.add(bytes);
  return ref;
}

const TASK_STATUSES: TaskStatus[] = ['todo', 'doing', 'done'];
/**
 * A task change from the page: checked as the runner will build it (a new task, or a change to one on the board),
 * then queued for the runner to sign against the board as it stands then. A new task takes the request id as its id.
 */
export async function queueTask(agent: BrowserAgent, input: { requestId?: unknown; taskId?: unknown; change?: unknown; removed?: unknown }) {
  const memberId = admittedIn(agent), id = requestIdOf(input.requestId);
  const raw = (input.change ?? {}) as Record<string, unknown>;
  if (typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !['title', 'notes', 'status', 'assigneeId', 'issue'].includes(k))) throw httpError(400, 'Send a task change.');
  const text = (v: unknown) => v === undefined || typeof v === 'string';
  if (!text(raw.title) || !text(raw.notes) || (raw.status !== undefined && !TASK_STATUSES.includes(raw.status as TaskStatus))
    || (raw.assigneeId !== undefined && raw.assigneeId !== null && (typeof raw.assigneeId !== 'string' || !agent.members().members.some(m => m.id === raw.assigneeId)))
    || (raw.issue !== undefined && raw.issue !== null && typeof raw.issue !== 'string')) throw httpError(400, 'This task change is not one the board takes.');
  if (input.taskId !== undefined && (typeof input.taskId !== 'string' || !UUID.test(input.taskId))) throw httpError(400, 'Use a task id from the board.');
  const change = raw as TaskChange, removed = input.removed === true;
  const taskId = (input.taskId as string | undefined) ?? id, current = foldBoard(agent.taskOps().map(p => p.body)).find(t => t.id === taskId);
  const done = () => agent.taskOps().some(p => p.body.id === id);
  if (!done()) {
    if (input.taskId !== undefined && !current) throw httpError(404, 'That task is not on the board any more.');
    try {
      const body = taskBody({ roomId: agent.roomId, deviceId: 'a'.repeat(64), memberId, current, taskId, change, removed, repositories: agent.settings().repositories });
      if (!validTaskBody(body, agent.roomId)) throw new Error('This task change is not within the room\'s limits.');
    } catch (error) { throw httpError(400, error instanceof Error ? error.message : String(error)); }
    enqueue(agent, id, { type: 'task', id, taskId, change, ...(removed ? { removed: true } : {}) });
  }
  return { taskId, status: await signed(agent, id, done) };
}
/** A reaction toggle from the page, queued for the runner to sign against the reactions as they stand then. */
export async function queueReaction(agent: BrowserAgent, input: { requestId?: unknown; messageId?: unknown; emoji?: unknown }) {
  const memberId = admittedIn(agent), id = requestIdOf(input.requestId);
  if (!isReactionEmoji(input.emoji)) throw httpError(400, 'Choose one of the room’s reaction emoji.');
  if (typeof input.messageId !== 'string' || !agent.messages().some(m => m.packet.body.id === input.messageId)) throw httpError(404, 'That message is not in this room.');
  const done = () => agent.reactionOps().some(p => p.body.id === id);
  if (!done()) {
    const already = memberReacted(agent.reactionChips(), input.messageId, input.emoji, memberId);
    if (!already && liveKeysForMember(agent.reactionOps().map(p => p.body), memberId) >= MAX_REACTION_KEYS_PER_MEMBER)
      throw httpError(409, 'You have too many reactions in this room. Remove some before adding more.');
    enqueue(agent, id, { type: 'reaction', id, messageId: input.messageId, emoji: input.emoji });
  }
  return { messageId: input.messageId, status: await signed(agent, id, done) };
}
/**
 * A decision change from the page: open one, vote (or take a vote back with `optionId: null`), add an option, close or
 * withdraw. Built once here to check it; the runner builds it again against the decision as it stands when signing.
 */
export async function queueDecision(agent: BrowserAgent, input: Record<string, unknown>) {
  const memberId = admittedIn(agent), id = requestIdOf(input.requestId), action = input.action;
  const author = { roomId: agent.roomId, deviceId: 'a'.repeat(64), memberId };
  let intent: Record<string, unknown>;
  try {
    if (action === 'open') {
      const mode: DecisionMode = input.mode === 'plan-review' ? 'plan-review' : 'choice';
      const options = Array.isArray(input.options) && input.options.every(o => typeof o === 'string') ? input.options as string[] : [];
      const askAgents = typeof input.askAgents === 'boolean' ? input.askAgents : false;
      const closesAt = typeof input.closesAt === 'number' && Number.isSafeInteger(input.closesAt) ? input.closesAt : null;
      if (typeof input.question !== 'string' || (input.context !== undefined && typeof input.context !== 'string')) throw new Error('Ask a question.');
      const decisionId = randomUUID(), context = (input.context as string | undefined) ?? '';
      openDecision({ ...author, decisionId, question: input.question, context, mode, options, askAgents, closesAt });
      intent = { type: 'decision', id, decisionId, action, question: input.question, context, mode, options, askAgents, closesAt };
    } else {
      if (typeof input.decisionId !== 'string' || !UUID.test(input.decisionId)) throw new Error('Use a decision from this room.');
      const current = pickDecision(agent.decisions(), input.decisionId, memberId);
      if (!current) throw Object.assign(new Error('That decision is not in this room.'), { status: 404 });
      if (action === 'vote') {
        const optionId = input.optionId === null ? null : typeof input.optionId === 'string' ? input.optionId : undefined;
        const comment = typeof input.comment === 'string' ? input.comment : '';
        if (optionId === undefined) throw new Error('Choose an option.');
        castVote(author, current, optionId, comment);
        intent = { type: 'decision', id, decisionId: current.id, action, optionId, comment };
      } else if (action === 'option' && typeof input.label === 'string') {
        reviseDecision(author, current, { addOption: input.label });
        intent = { type: 'decision', id, decisionId: current.id, action, label: input.label };
      } else if (action === 'close' || action === 'withdraw') {
        if (current.state !== 'open') throw new Error(`This decision is already ${current.state}.`);
        intent = { type: 'decision', id, decisionId: current.id, action };
      } else throw new Error('Open, vote on, add an option to, close or withdraw a decision.');
    }
  } catch (error) { throw httpError((error as { status?: number }).status ?? 400, error instanceof Error ? error.message : String(error)); }
  const done = () => agent.madeDecisionOp(id);
  if (!done()) enqueue(agent, id, intent);
  return { decisionId: intent.decisionId as string, status: await signed(agent, id, done) };
}

/** A file of the room the page asked for: the runner fetches it from a device that has it, verified by its hash. */
export function wantFile(agent: BrowserAgent, sha: unknown) {
  if (!isSha256(sha) || !agent.attachment(sha)) throw httpError(404, 'No message in this room has that file.');
  if (!agent.files.has(sha)) replaceFile(join(agent.dir, 'wants', sha), '');
  return { sha256: sha, held: agent.files.has(sha) };
}

/** Messages the room view hands out at most at once; older ones come a page at a time with `before`. */
export const VIEW_LIMIT = 500;
/**
 * The open room for the person's page, in the shapes the hosted page keeps them: the room's status as the runner last
 * heard it, a page of history (the newest `limit`, or those before `before`), the board's and decisions' operations,
 * reaction chips, which of the page's files this device holds or is fetching, and the read position. Signatures and
 * keys never leave the daemon.
 */
export function roomView(room: PersonRoom, agent: BrowserAgent, options: { limit?: number; before?: string } = {}) {
  const limit = options.limit ?? VIEW_LIMIT, all = agent.messages();
  let end = all.length;
  if (options.before !== undefined) {
    end = all.findIndex(m => m.packet.body.id === options.before);
    if (end < 0) throw httpError(404, 'That message is not in this room (it may have left the history window).');
  }
  const page = all.slice(Math.max(0, end - limit), end);
  const transfers = agent.transfers(), files: Record<string, { held: boolean; transfer?: unknown }> = {};
  for (const { packet: { body } } of page) for (const ref of body.attachments ?? []) {
    const held = agent.files.has(ref.sha256);
    // Fetched: whatever asked for it is done.
    if (held) rmSync(join(agent.dir, 'wants', ref.sha256), { force: true });
    files[ref.sha256] = { held, ...(!held && transfers[ref.sha256] ? { transfer: transfers[ref.sha256] } : {}) };
  }
  const { memberId, title } = agent.members();
  return { roomId: room.roomId, origin: room.origin, title: title ?? null, ...roomState(agent), memberId: memberId ?? null,
    status: personRoomStatus(agent) ?? null,
    messages: page.map(({ packet: { body }, targets, receipts }) => ({ packet: { body }, targets, receipts })), more: end - page.length > 0,
    taskOps: agent.taskOps().map(p => p.body), decisionOps: agent.decisionOps().map(p => p.body), reactions: agent.reactionChips(),
    files, read: readUpTo(agent, room.joinedAt) };
}

/** `person status`: the person's device, folder and rooms at a glance. */
export function personStatus(home = personHome()) {
  const identity = personIdentity(home);
  const rooms = identity ? listedAgents(home).map(({ room, agent }) => ({ roomId: room.roomId, ...roomState(agent) })) : [];
  const paired = pairedWith(home);
  return { initialized: !!identity, deviceId: identity?.id ?? null, home, rooms: rooms.length,
    pairedWith: paired ? { name: paired.name, origin: paired.origin } : null,
    joined: rooms.filter(r => r.state === 'joined').length, waiting: rooms.filter(r => r.state === 'waiting').length,
    ...(identity ? {} : { next: 'Run person init to make this machine\'s person.' }) };
}
/** Whether a path is a regular file (the person's files are never read through a link). */
export const regularFile = (path: string) => { try { return lstatSync(path).isFile(); } catch { return false; } };
