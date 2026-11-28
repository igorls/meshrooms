/**
 * Remote control, the machine's side (docs/flows/remote-control.md, build step 1): the controllers this machine acts
 * for, the person's policy, the audit log, and the remote turn runner. The local API serves it to the app only (its
 * control token, see local-api.ts), so it can be tried on one machine; the control socket will call runRemoteTurn
 * directly.
 *
 * It all lives in the person folder (personHome), each file 0600:
 * - controllers.json: the browser and phone keys the person enrolled on this machine. One is kept only when its device
 *   id is the sha256 of its signing key and its encryption key is bound to that key for every room ('*').
 * - remote-policy.json: off until the person turns it on here; which harnesses; which controllers skip the first-use
 *   question. A file that can't be read counts as off.
 * - control.log: a JSON line when a turn starts and one for every outcome: when, which controller, harness, session and
 *   request, the outcome and the byte sizes of prompt and reply. Never their text. Kept under LOG_LIMIT, one older copy.
 *
 * A remote turn is the person talking to their own session, so it runs as they would run it at this machine: the
 * harness's own resume, in the session's folder, with the session's own permissions and settings. None of a room wake's
 * confinement, and nothing added: no bypass flags, no allowed tools. A tool the harness would ask about is refused in
 * non-interactive mode, and the reply says so. One turn runs per session at a time: a second remote prompt is told
 * `busy`, and remote turns and room wakes take turns through the session ledger the watchers use (sessionLedger).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { replaceFile } from './browser-agent';
import {
  APPROVAL_WALL, HERMES_SESSION_BUSY, WATCH_TIMING, appendNoFollow, codexThread, reapGroup, sessionKey, sessionLedger, stopOwnChild, wakeEnv, writeFresh, type Invocation, type Program,
  type SessionClaim,
} from './agent-watch';
import { LOG_LIMIT, locksDir, rotateLog } from './agent-daemon';
import { HARNESS_IDS, HARNESS_LABELS, agySessionFolder, claudeSessionFolder, machineScanDeps, plainText, type HarnessId, type ScanDeps, type SessionListing } from './detectors/harnesses';
import { harnessPreferences, type CodexDelivery } from './harness-apps';
import { running } from './locks';
import { personHome } from './person';
import { deviceId, unbase64 } from '../src/browser/protocol';
import { importEncPublicKey, verifyEncBinding } from '../src/browser/relay-crypto';

export const CONTROLLERS_FILE = 'controllers.json', POLICY_FILE = 'remote-policy.json', CONTROL_LOG = 'control.log';
/** Harnesses a remote prompt can reach: those with sessions. A custom command (exec) has none. */
export const REMOTE_HARNESSES = ['claude', 'codex', 'hermes', 'agy'] as const;
export type RemoteHarness = typeof REMOTE_HARNESSES[number];
export const MAX_CONTROLLERS = 32;
/** A prompt is at most this many bytes; a reply is returned whole up to its own limit, then cut and marked `truncated`. */
export const MAX_PROMPT_BYTES = 32 * 1024, MAX_REPLY_BYTES = 256 * 1024;
/** How long a turn may run, and how long a prompt waits for a room wake in its session, by default. */
export const TURN_TIMEOUT_MS = 10 * 60_000, WAKE_WAIT_MS = 10 * 60_000;
/** Remote turns running or waiting at once on this machine; past it a prompt is told `busy`. */
export const MAX_LIVE_TURNS = 8;
/** The name remote turns go by in a session's ledger, where rooms go by their ids. */
export const REMOTE_PARTICIPANT = 'remote-control';
/** Windows gives a program at most 32,767 characters of command line, and Antigravity takes the prompt on it. */
export const WINDOWS_PROMPT_ARG_LIMIT = 30_000;
/** How much of a run's output is kept: its start and its end, this much of each. */
const OUTPUT_KEEP = 4 * 1024 * 1024, STDERR_KEEP = 16 * 1024;

const HEX64 = /^[a-f0-9]{64}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, BASE64_88 = /^[A-Za-z0-9+/]{86}[A-Za-z0-9+/=]{2}$/;
const NAME_POINTS = 60;
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });
const isRemoteHarness = (value: unknown): value is RemoteHarness => REMOTE_HARNESSES.includes(value as RemoteHarness);

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

/** A browser or phone the person enrolled on this machine: its keys, as the web app gave them, and what to call it. */
export type Controller = { device: string; sign: string; enc: string; encVersion: number; encSig: string; name: string; origin: string; addedAt: number };

/** A controller's web origin: https, or http on this machine (development), and nothing past the origin. */
function cleanOrigin(value: unknown) {
  if (typeof value !== 'string' || value.length > 256) return undefined;
  try {
    const url = new URL(value), local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    return url.origin === value && (url.protocol === 'https:' || (url.protocol === 'http:' && local)) ? value : undefined;
  } catch { return undefined; }
}
/** Whether `key` is a raw uncompressed P-256 public key that imports as an ECDSA key. */
async function signingKey(key: string) {
  try {
    const bytes = unbase64(key);
    if (bytes.length !== 65 || bytes[0] !== 4) return false;
    await crypto.subtle.importKey('raw', bytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return true;
  } catch { return false; }
}
async function encryptionKey(key: string) { try { await importEncPublicKey(key); return true; } catch { return false; } }

/**
 * A controller as it may be enrolled: its device id is the sha256 of its raw signing key (deviceId), and its encryption
 * key is bound to that key for every room ('*', signEncBinding). Anything else is refused (400), with the reason.
 */
export async function checkController(input: Record<string, unknown>, addedAt = Date.now()): Promise<Controller> {
  const { device, sign, enc, encVersion, encSig } = input;
  if (typeof sign !== 'string' || !BASE64_88.test(sign) || !await signingKey(sign)) throw httpError(400, "The controller's signing key is not a P-256 public key.");
  if (typeof device !== 'string' || !HEX64.test(device) || device !== await deviceId(sign)) throw httpError(400, "The controller's device id is not the hash of its signing key.");
  if (typeof enc !== 'string' || !BASE64_88.test(enc) || !await encryptionKey(enc)) throw httpError(400, "The controller's encryption key is not a P-256 public key.");
  if (typeof encVersion !== 'number' || !Number.isSafeInteger(encVersion) || encVersion < 1) throw httpError(400, "The controller's encryption key version must be a whole number from 1.");
  if (typeof encSig !== 'string' || !await verifyEncBinding(sign, { room: '*', deviceId: device, enc, encVersion }, encSig))
    throw httpError(400, "The controller's encryption key is not bound to its signing key for every room.");
  const name = plainText(input.name, NAME_POINTS);
  if (!name) throw httpError(400, 'Give the controller a name.');
  const origin = cleanOrigin(input.origin);
  if (!origin) throw httpError(400, "The controller's origin must be an https origin.");
  return { device, sign, enc, encVersion, encSig, name, origin, addedAt };
}
/** A stored controller read back: every field present and well formed (its keys were checked when it was added). */
function storedController(value: unknown): Controller | undefined {
  const c = value as Partial<Controller> | null;
  if (!c || typeof c !== 'object' || typeof c.device !== 'string' || !HEX64.test(c.device) || typeof c.sign !== 'string' || !BASE64_88.test(c.sign)
    || typeof c.enc !== 'string' || !BASE64_88.test(c.enc) || typeof c.encSig !== 'string' || !BASE64_88.test(c.encSig)
    || typeof c.encVersion !== 'number' || !Number.isSafeInteger(c.encVersion) || c.encVersion < 1 || typeof c.addedAt !== 'number' || !Number.isSafeInteger(c.addedAt)) return undefined;
  const name = plainText(c.name, NAME_POINTS), origin = cleanOrigin(c.origin);
  return name && name === c.name && origin ? { device: c.device, sign: c.sign, enc: c.enc, encVersion: c.encVersion, encSig: c.encSig, name, origin, addedAt: c.addedAt } : undefined;
}
/** The machine's controllers. A file that can't be read, or an entry that isn't well formed, controls nothing. */
export function readControllers(home = personHome()): Controller[] {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(join(home, CONTROLLERS_FILE), 'utf8')); } catch { return []; }
  const list = (parsed as { controllers?: unknown } | null)?.controllers;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  return list.map(storedController).filter((c): c is Controller => !!c && !seen.has(c.device) && !!seen.add(c.device)).slice(0, MAX_CONTROLLERS);
}
function writeControllers(home: string, controllers: Controller[]) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  replaceFile(join(home, CONTROLLERS_FILE), JSON.stringify({ version: 1, controllers }, null, 2));
}
/** Enrols a controller (checkController), replacing an earlier entry for the same device. At most MAX_CONTROLLERS. */
export async function addController(home: string, input: Record<string, unknown>, now = Date.now()) {
  const controller = await checkController(input, now);
  const others = readControllers(home).filter(c => c.device !== controller.device);
  if (others.length >= MAX_CONTROLLERS) throw httpError(409, `This machine has ${MAX_CONTROLLERS} controllers already. Remove one first.`);
  writeControllers(home, [...others, controller]);
  return controller;
}
/** Revokes a controller: it is no longer trusted, and its turns running now are cancelled. False when it wasn't one. */
export function removeController(home: string, device: string) {
  const list = readControllers(home), kept = list.filter(c => c.device !== device);
  if (kept.length === list.length) return false;
  writeControllers(home, kept);
  const policy = readPolicy(home);
  if (policy.trusted.includes(device)) writePolicy(home, { ...policy, trusted: policy.trusted.filter(d => d !== device) });
  for (const key of [...allowedOnce]) if (key.startsWith(`${home}\0${device}\0`)) allowedOnce.delete(key);
  stopTurns(turn => turn.home === home && turn.controller === device, "This browser's control of the machine was revoked.");
  return true;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** What the person allows on this machine: whether remote control is on, for which harnesses, and who isn't asked first. */
export type RemotePolicy = { enabled: boolean; harnesses: HarnessId[]; trusted: string[] };
export const defaultPolicy = (): RemotePolicy => ({ enabled: false, harnesses: [], trusted: [] });
/** The policy with these harnesses allowed: on with any, off with none (the kill switch). Trust is kept. */
export const policyAllowing = (policy: RemotePolicy, harnesses: unknown): RemotePolicy => {
  if (!Array.isArray(harnesses) || !harnesses.every(h => typeof h === 'string')) throw httpError(400, 'List the harnesses remote prompts may reach.');
  return { enabled: harnesses.length > 0, harnesses: harnesses as HarnessId[], trusted: policy.trusted };
};
/** The policy with one controller allowed to send prompts without the first-use question, or not. */
export const policyTrusting = (policy: RemotePolicy, device: string, trusted: boolean): RemotePolicy =>
  ({ ...policy, trusted: trusted ? [...new Set([...policy.trusted, device])] : policy.trusted.filter(d => d !== device) });
/**
 * The policy read strictly: the default when there is no file, a 409 when the file can't be read. Never the default for
 * a file that is there: a change made on top of that would wipe what the person set.
 */
export function readPolicyStrict(home = personHome()): RemotePolicy {
  let text: string;
  try { text = readFileSync(join(home, POLICY_FILE), 'utf8'); } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return defaultPolicy();
    throw httpError(409, "This machine's remote control policy can't be read.");
  }
  try { return checkPolicy(JSON.parse(text)); }
  catch { throw httpError(409, "This machine's remote control policy can't be read: fix or remove its file (remote-policy.json in the person folder) first."); }
}
/**
 * One change from the app's Remote control window, made to the policy as it is now and saved in one step (no await
 * between, so nothing else can change it meanwhile): `allow` (the harnesses; none turns remote control off) or `trust`
 * ({device, trusted}, for a controller of this machine). Trust for a browser no longer enrolled is dropped on the way, so
 * a stale entry never stops remote control being turned off.
 */
export function changePolicy(home: string, change: { allow?: unknown; trust?: unknown }) {
  let policy = readPolicyStrict(home);
  const controllers = readControllers(home);
  if (change.allow === undefined && change.trust === undefined) throw httpError(400, 'Send allow or trust.');
  if (change.allow !== undefined) policy = policyAllowing(policy, change.allow);
  if (change.trust !== undefined) {
    const trust = change.trust as { device?: unknown; trusted?: unknown } | null;
    if (!trust || typeof trust.device !== 'string' || !HEX64.test(trust.device) || typeof trust.trusted !== 'boolean') throw httpError(400, 'Send trust as {device, trusted}.');
    if (!controllers.some(c => c.device === trust.device)) throw httpError(404, 'That browser is not a controller of this machine.');
    policy = policyTrusting(policy, trust.device, trust.trusted);
  }
  return savePolicy(home, { ...policy, trusted: policy.trusted.filter(d => controllers.some(c => c.device === d)) });
}
/**
 * What the app's Remote control window shows: the policy (null, with why, when its file can't be read), each controller
 * with whether it may send prompts and whether it is online, and the control socket's connections. A controller is
 * online only through a connection that is ready; `machineKnown` is false when the daemon's control socket couldn't say.
 */
export function remoteOverview(home: string, machine?: { status(): unknown }) {
  let policy: RemotePolicy | null = null, policyProblem: string | undefined;
  try { policy = readPolicyStrict(home); } catch (error) { policyProblem = error instanceof Error ? error.message : String(error); }
  let status: { connections?: { origin: string; state: string; peers: { device: string; online: boolean; lastSeen?: number }[] }[]; problem?: string } | undefined;
  try { status = machine?.status() as typeof status; } catch { status = undefined; }
  const peers = new Map((status?.connections ?? []).filter(c => c.state === 'ready').flatMap(c => c.peers.map(p => [p.device, p] as const)));
  return {
    policy, ...(policyProblem ? { policyProblem } : {}),
    browsers: readControllers(home).map(c => {
      const peer = peers.get(c.device);
      return { device: c.device, name: c.name, origin: c.origin, addedAt: c.addedAt, trusted: !!policy?.trusted.includes(c.device), online: peer?.online === true,
        ...(peer && !peer.online && peer.lastSeen ? { lastSeen: peer.lastSeen } : {}) };
    }),
    connections: (status?.connections ?? []).map(({ origin, state }) => ({ origin, state })),
    machineKnown: !!status, ...(status?.problem ? { problem: status.problem } : {}),
  };
}

/** A policy as it may be saved: only these three fields, harnesses with sessions, and (given `controllers`) known devices. */
export function checkPolicy(input: unknown, controllers?: Controller[]): RemotePolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'Send the policy as { enabled, harnesses, trusted }.');
  const p = input as Record<string, unknown>;
  if (Object.keys(p).some(key => !['enabled', 'harnesses', 'trusted'].includes(key))) throw httpError(400, 'The policy has only enabled, harnesses and trusted.');
  if (typeof p.enabled !== 'boolean') throw httpError(400, 'Set enabled to true or false.');
  if (!Array.isArray(p.harnesses) || !p.harnesses.every(isRemoteHarness))
    throw httpError(400, `List harnesses among ${REMOTE_HARNESSES.join(', ')}. A custom command has no sessions to control.`);
  const trusted = p.trusted;
  if (!Array.isArray(trusted) || trusted.length > MAX_CONTROLLERS || !trusted.every(d => typeof d === 'string' && HEX64.test(d))) throw httpError(400, 'List trusted controllers by their device ids.');
  if (controllers && trusted.some(d => !controllers.some(c => c.device === d))) throw httpError(400, 'A trusted device is not a controller of this machine.');
  return { enabled: p.enabled, harnesses: REMOTE_HARNESSES.filter(h => (p.harnesses as unknown[]).includes(h)), trusted: [...new Set(trusted as string[])] };
}
/** The machine's policy; off (defaultPolicy) when there is none or it can't be read. */
export function readPolicy(home = personHome()): RemotePolicy {
  try { return checkPolicy(JSON.parse(readFileSync(join(home, POLICY_FILE), 'utf8'))); } catch { return defaultPolicy(); }
}
function writePolicy(home: string, policy: RemotePolicy) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  replaceFile(join(home, POLICY_FILE), JSON.stringify(policy, null, 2));
}
/** Saves the policy (checkPolicy). Turns it no longer allows stop at once: turning remote control off is the kill switch. */
export function savePolicy(home: string, input: unknown) {
  const policy = checkPolicy(input, readControllers(home));
  writePolicy(home, policy);
  stopTurns(turn => turn.home === home && (!policy.enabled || !policy.harnesses.includes(turn.harness)),
    policy.enabled ? 'Remote control of this harness was turned off on this machine.' : 'Remote control was turned off on this machine.');
  return policy;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/** Why a remote prompt didn't get a reply. */
export type TurnCode = 'invalid' | 'disabled' | 'unknown-controller' | 'not-allowed' | 'empty' | 'too-large' | 'duplicate' | 'busy' | 'unknown-session' | 'unsupported'
  | 'timeout' | 'cancelled' | 'failed';
/** One line of control.log: ids and sizes only, never the prompt or the reply. An id that wasn't well formed is null. */
export type AuditEntry = { at: string; controller: string | null; harness: string | null; sessionId: string | null; requestId: string | null; turnId: string;
  outcome: 'running' | 'done' | TurnCode; promptBytes: number; replyBytes: number; truncated?: true; durationMs?: number };
/** Appends a line to control.log, first moving a log past LOG_LIMIT to control.log.1 (the one older copy kept). */
export function writeAudit(home: string, entry: AuditEntry) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, CONTROL_LOG);
  rotateLog(file, LOG_LIMIT);
  appendNoFollow(file, `${JSON.stringify(entry)}\n`);
}

// ---------------------------------------------------------------------------
// Turns in progress
// ---------------------------------------------------------------------------

type LiveTurn = { turnId: string; requestId: string; home: string; controller: string; harness: RemoteHarness; sessionId: string; key: string; startedAt: number;
  state: 'waiting' | 'running'; stop: AbortController; why?: string };
/** This process's remote turns, waiting for their session or running. */
const live = new Map<string, LiveTurn>();
/** Controllers the person allowed once, in this process, for a harness (askFirstUse). */
const allowedOnce = new Set<string>();

/** The remote turns waiting or running now, for the app: ids and states, never the prompt. */
export function runningTurns(home?: string) {
  return [...live.values()].filter(turn => home === undefined || turn.home === home)
    .map(({ turnId, requestId, controller, harness, sessionId, state, startedAt }) => ({ turnId, requestId, controller, harness, sessionId, state, startedAt: new Date(startedAt).toISOString() }));
}
/** Cancels a turn: one waiting stops waiting, one running has its process tree killed. False when there is no such turn. */
export function cancelTurn(turnId: string, why = 'The turn was cancelled.') {
  const turn = live.get(turnId);
  if (!turn || turn.stop.signal.aborted) return false;
  turn.why = why;
  turn.stop.abort();
  return true;
}
function stopTurns(match: (turn: LiveTurn) => boolean, why: string) { for (const turn of [...live.values()]) if (match(turn)) cancelTurn(turn.turnId, why); }

// ---------------------------------------------------------------------------
// Running a turn
// ---------------------------------------------------------------------------

export type TurnInput = { requestId?: unknown; controller?: unknown; harness?: unknown; sessionId?: unknown; text?: unknown };
export type TurnResult =
  | { state: 'done'; turnId: string; sessionId: string; reply: string; truncated: boolean; denied?: string[] }
  | { state: 'failed'; turnId: string; code: TurnCode; message: string };
/** What runRemoteTurn needs from the machine; tests give fakes. */
export type RemoteDeps = {
  /** The person folder: controllers, policy, audit log. */
  home: string;
  /** The listings the local API serves (harnessScanner): only a session listed there can be prompted. */
  scanner: { sessions(harness: HarnessId): Promise<SessionListing> };
  /** How harness programs are found, and where each keeps its sessions (machineScanDeps). */
  machine: Pick<ScanDeps, 'resolve' | 'claudeDir' | 'codexHome' | 'agyCliDir'>;
  /** The session ledgers' folder (locksDir), shared with room wakes. */
  locks: string;
  /** The environment a turn runs with (default: this process's). */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** How long a prompt waits for a room wake in its session, and how often it asks meanwhile. */
  waitMs?: number; pollMs?: number;
  /** Codex's delivery mode as the person set it (default: their agent app settings, harness-apps.ts). */
  codexDelivery?: () => CodexDelivery;
  alive?: (pid: number) => boolean;
  now?: () => number;
  /** Told the turn's id once its process starts (the control socket answers `{ state: 'running', turnId }` then). */
  onRunning?: (turnId: string) => void;
  /**
   * Asks the person at the machine before a controller's first prompt to a harness, unless they trusted it (`trusted`).
   * Without it nothing is asked: the local API's turn route is the app's own.
   */
  askFirstUse?: (controller: Controller, harness: RemoteHarness) => Promise<boolean>;
};
/** The daemon's deps: the machine's programs and session stores, its ledgers, and the local API's scanner. */
export const machineRemoteDeps = (home: string, scanner: RemoteDeps['scanner']): RemoteDeps => ({ home, scanner, machine: machineScanDeps(), locks: locksDir() });

/** A refusal or failure with its code, thrown inside runRemoteTurn and answered as `{ state: 'failed' }`. */
class TurnError extends Error { constructor(readonly code: TurnCode, message: string) { super(message); } }

/**
 * Sends one prompt to a session and returns the agent's whole final reply (up to MAX_REPLY_BYTES). Refused, before
 * anything runs, when remote control is off here (`disabled`), the controller isn't enrolled (`unknown-controller`),
 * the harness isn't allowed (`not-allowed`), the text is empty or too large, the session is busy with another remote
 * prompt, isn't one its harness lists (`unknown-session`), or Codex delivers to its desktop app (`unsupported`, for now).
 * A room wake in the session is waited for, up to `waitMs`. Every outcome is written to the audit log.
 */
export async function runRemoteTurn(input: TurnInput, deps: RemoteDeps): Promise<TurnResult> {
  const now = deps.now ?? Date.now, startedAt = now(), turnId = randomUUID();
  const { requestId, controller, harness, sessionId, text } = input;
  const ids = {
    controller: typeof controller === 'string' && HEX64.test(controller) ? controller : null, harness: typeof harness === 'string' && HARNESS_IDS.includes(harness as HarnessId) ? harness : null,
    sessionId: typeof sessionId === 'string' && SESSION_ID.test(sessionId) ? sessionId : null, requestId: typeof requestId === 'string' && UUID.test(requestId) ? requestId : null,
  };
  const promptBytes = typeof text === 'string' ? Buffer.byteLength(text) : 0;
  const entry = (outcome: AuditEntry['outcome'], extra: Partial<AuditEntry> = {}): AuditEntry => ({ at: new Date(now()).toISOString(), ...ids, turnId, outcome, promptBytes, replyBytes: 0, ...extra });
  const answer = (result: TurnResult): TurnResult => {
    const done = result.state === 'done';
    try { writeAudit(deps.home, entry(done ? 'done' : result.code, { durationMs: now() - startedAt, ...(done ? { replyBytes: Buffer.byteLength(result.reply), ...(result.truncated ? { truncated: true as const } : {}) } : {}) })); }
    catch (error) { console.error('remote control: the audit log could not be written:', error instanceof Error ? error.message : String(error)); }
    return result;
  };
  const refuse = (code: TurnCode, message: string): TurnResult => answer({ state: 'failed', turnId, code, message });

  // Everything up to registering the turn is synchronous, so two prompts arriving together can't both pass the busy check.
  const policy = readPolicy(deps.home);
  if (!policy.enabled) return refuse('disabled', 'Remote control is off on this machine. Turn it on in the Meshrooms app there.');
  if (!ids.controller || !ids.harness || !ids.sessionId || !ids.requestId || typeof text !== 'string')
    return refuse('invalid', 'Send requestId (a uuid), controller (a device id), harness, sessionId and text.');
  const enrolled = readControllers(deps.home).find(c => c.device === ids.controller);
  if (!enrolled) return refuse('unknown-controller', 'This browser is not a controller of this machine.');
  if (!isRemoteHarness(harness) || !policy.harnesses.includes(harness)) return refuse('not-allowed', `Remote prompts to ${HARNESS_LABELS[harness as HarnessId]} are not allowed on this machine.`);
  if (!text.trim()) return refuse('empty', 'Write a prompt to send.');
  if (promptBytes > MAX_PROMPT_BYTES) return refuse('too-large', `A prompt is at most ${MAX_PROMPT_BYTES / 1024} KiB.`);
  const turns = [...live.values()];
  if (turns.some(turn => turn.requestId === requestId)) return refuse('duplicate', 'That request is already running.');
  const key = sessionKey({ harness, session: sessionId as string, cwd: '' }, deps.env ?? process.env);
  if (turns.some(turn => turn.key === key)) return refuse('busy', 'Another remote prompt is running in this session. Wait for its reply.');
  if (turns.length >= MAX_LIVE_TURNS) return refuse('busy', `${MAX_LIVE_TURNS} remote prompts are running on this machine already. Wait for one to finish.`);
  const turn: LiveTurn = { turnId, requestId: requestId as string, home: deps.home, controller: enrolled.device, harness, sessionId: sessionId as string, key, startedAt, state: 'waiting', stop: new AbortController() };
  live.set(turnId, turn);

  const label = HARNESS_LABELS[harness], timeoutMs = deps.timeoutMs ?? TURN_TIMEOUT_MS;
  let claim: SessionClaim | undefined, promptFile: string | undefined;
  const ledger = sessionLedger(deps.locks, key, REMOTE_PARTICIPANT, { alive: deps.alive ?? running, holdMs: timeoutMs + 60_000, ownedMs: WATCH_TIMING.busyRetryMs, freshMs: 30_000, now });
  // Read again after every wait (the person's answer, a room wake): the person may have changed either file meanwhile,
  // and a change made outside the app's routes stops nothing by itself.
  const stillAllowed = () => {
    const current = readPolicy(deps.home);
    if (!current.enabled) throw new TurnError('disabled', 'Remote control was turned off on this machine.');
    if (!current.harnesses.includes(turn.harness)) throw new TurnError('not-allowed', `Remote prompts to ${label} are no longer allowed on this machine.`);
    const still = readControllers(deps.home).find(c => c.device === enrolled.device);
    if (!still || still.sign !== enrolled.sign) throw new TurnError('unknown-controller', 'This browser is no longer a controller of this machine.');
  };
  try {
    // The stored keys are checked again before they are trusted: the file is the person's, but it is only a file.
    await checkController(enrolled, enrolled.addedAt).catch(() => { throw new TurnError('unknown-controller', "This browser's stored keys don't check out. Enrol it again."); });
    const askKey = `${deps.home}\0${enrolled.device}\0${harness}`;
    if (deps.askFirstUse && !policy.trusted.includes(enrolled.device) && !allowedOnce.has(askKey)) {
      if (!await deps.askFirstUse(enrolled, harness)) throw new TurnError('not-allowed', `The person at this machine did not allow prompts to ${label} from ${enrolled.name}.`);
      if (turn.stop.signal.aborted) throw new TurnError('cancelled', '');
      stillAllowed();
      allowedOnce.add(askKey);
    }
    const listing = await deps.scanner.sessions(harness);
    if (!listing.sessions.some(s => s.id === sessionId)) throw new TurnError('unknown-session', `That session is not one ${label} lists on this machine now.`);
    if (harness === 'codex' && (deps.codexDelivery ? deps.codexDelivery() : harnessPreferences(deps.home).codex.codexDelivery) === 'desktop')
      throw new TurnError('unsupported', 'Codex delivers to its desktop app on this machine, which remote prompts do not support yet.');
    const cwd = sessionFolder(harness, turn.sessionId, deps.machine);
    let program: Program;
    try { program = deps.machine.resolve(harness); } catch { throw new TurnError('failed', `${label} is not installed on this machine.`); }
    if (harness === 'agy' && process.platform === 'win32' && text.length + (text.match(/["\\]/g)?.length ?? 0) > WINDOWS_PROMPT_ARG_LIMIT)
      throw new TurnError('too-large', 'Antigravity takes the prompt on its command line, which Windows limits to about 30,000 characters.');

    claim = await takeSession(ledger, turn.stop.signal, deps.waitMs ?? WAKE_WAIT_MS, deps.pollMs ?? 1_000, now);
    if (turn.stop.signal.aborted) throw new TurnError('cancelled', '');
    stillAllowed();
    // Written only once the session is ours, so a prompt that waited and was refused never touched the disk.
    if (harness === 'hermes') promptFile = writePromptFile(deps.home, turnId, text);
    const invocation = remoteInvocation(harness, turn.sessionId, text, program, promptFile, timeoutMs);
    try { writeAudit(deps.home, entry('running')); } catch { throw new TurnError('failed', 'The audit log on this machine cannot be written, so nothing was sent.'); }
    turn.state = 'running';
    // The daemon's environment minus the credentials the harness doesn't sign in with, and minus the Hermes variables
    // that skip its confirmations (wakeEnv): a remote prompt gets no more than the session would at this machine.
    const run = await runTurnProgram(invocation, { cwd, env: { ...wakeEnv(deps.env ?? process.env, harness).env, NO_COLOR: '1' }, timeoutMs, signal: turn.stop.signal,
      onStart: pid => { claim?.started(pid); deps.onRunning?.(turnId); } });
    if (run.cancelled) throw new TurnError('cancelled', '');
    if (run.timedOut) throw new TurnError('timeout', `${label} did not finish within ${timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} minutes` : `${Math.ceil(timeoutMs / 1000)} seconds`}, so the turn was stopped.`);
    if (run.error) throw new TurnError('failed', `${label} could not be started: ${plainText(run.error, 200) ?? 'unknown error'}`);
    const read = readTurnReply(harness, replyOutput(harness, run), run.stderr, run.exitCode);
    if (!read.ok) {
      // The harness refused the session because something else holds it: room wakes back off too, as for theirs.
      if (read.code === 'busy') { claim.release({ busy: read.message }); claim = undefined; ledger.withdraw(); }
      throw new TurnError(read.code, read.message);
    }
    return answer({ state: 'done', turnId, sessionId: read.sessionId ?? turn.sessionId, reply: read.reply, truncated: read.truncated, ...(read.denied ? { denied: read.denied } : {}) });
  } catch (error) {
    if (!(error instanceof TurnError)) return refuse('failed', `The turn could not run: ${plainText(error instanceof Error ? error.message : String(error), 200) ?? 'unknown error'}`);
    return refuse(error.code, error.code === 'cancelled' ? turn.why ?? 'The turn was cancelled.' : error.message);
  } finally {
    live.delete(turnId);
    claim?.release();
    // A file that can't be removed now is removed at the next start (sweepPromptFiles).
    if (promptFile) try { rmSync(promptFile, { force: true }); } catch { /* Next start. */ }
  }
}

/**
 * Where a session works, as its harness recorded it: a turn runs there or not at all. Running it anywhere else (the
 * home folder, say) would point the session's tools and sandbox at a folder it never worked in. Hermes goes back to its
 * recorded folder by itself. Only a local absolute folder: Windows would reach out to another machine just to look at
 * a UNC path.
 */
function sessionFolder(harness: RemoteHarness, id: string, machine: RemoteDeps['machine']) {
  if (harness === 'hermes') return homedir();
  const folder = harness === 'claude' ? claudeSessionFolder(id, machine.claudeDir) : harness === 'codex' ? codexThread(id, machine.codexHome)?.cwd : agySessionFolder(id, machine.agyCliDir);
  if (!folder) throw new TurnError('unknown-session', `${HARNESS_LABELS[harness]} doesn't record where this session works, so it can't be resumed there.`);
  if (!isAbsolute(folder) || /^[\\/]{2}/.test(folder)) throw new TurnError('failed', "This session's folder is not a local folder on this machine.");
  const isFolder = (() => { try { return statSync(folder).isDirectory(); } catch { return false; } })();
  if (!isFolder) throw new TurnError('failed', "This session's folder is no longer on this machine.");
  return folder;
}
const PROMPT_DIR = 'remote-turns', PROMPT_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.txt$/;
/** Hermes reads the prompt from a file: one of its own (0600) in the person folder, removed when the turn ends. */
function writePromptFile(home: string, turnId: string, text: string) {
  const dir = join(home, PROMPT_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${turnId}.txt`);
  writeFresh(file, text);
  return file;
}
/**
 * Removes the prompt files a turn left when its process ended mid-turn (a crash, a kill), except a running turn's. The
 * local API calls it when it starts. Returns how many it removed.
 */
export function sweepPromptFiles(home: string) {
  const dir = join(home, PROMPT_DIR);
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  const kept = new Set([...live.values()].filter(turn => turn.home === home).map(turn => `${turn.turnId}.txt`));
  let removed = 0;
  for (const name of names) {
    if (!PROMPT_FILE.test(name) || kept.has(name)) continue;
    try { rmSync(join(dir, name), { force: true }); removed++; } catch { /* Next start. */ }
  }
  return removed;
}
/** Waits while a room wake runs in the session (or is ahead in its line), up to `waitMs`; anything else that holds it is `busy`. */
async function takeSession(ledger: ReturnType<typeof sessionLedger>, signal: AbortSignal, waitMs: number, pollMs: number, now: () => number): Promise<SessionClaim> {
  const until = now() + waitMs;
  try {
    for (;;) {
      if (signal.aborted) throw new TurnError('cancelled', '');
      const got = ledger.claim();
      if ('release' in got) return got;
      if (got.wait === 'broken') throw new TurnError('failed', `This session's ledger can't be used: ${plainText(got.reason, 200) ?? 'unknown error'}`);
      if (got.wait === 'halted') throw new TurnError('busy', 'Room wakes in this session are halted until its agent is bound again.');
      if (got.wait === 'owned') throw new TurnError('busy', 'Something else has this session open. Try again later.');
      if (got.wait === 'running' && got.room === REMOTE_PARTICIPANT) throw new TurnError('busy', 'Another remote prompt is running in this session.');
      if (now() >= until) throw new TurnError('busy', 'A room wake kept this session busy for too long. Try again later.');
      await pause(pollMs, signal);
    }
  } catch (error) { ledger.withdraw(); throw error; }
}
const pause = (ms: number, signal: AbortSignal) => new Promise<void>(done => {
  const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); done(); };
  const timer = setTimeout(finish, ms);
  signal.addEventListener('abort', finish, { once: true });
});

/**
 * How a remote prompt runs: the harness's own resume, as the person would type it. Nothing on the command line widens
 * what the session may do (no permission mode, allowed or disallowed tools, settings or bypass flags); what is added
 * only shapes the output and bounds the run. Claude Code and Codex read the prompt on stdin (Codex's `-` says so),
 * Hermes from a file, Antigravity as an argument.
 * - Hermes: its JSON event stream, and a run budget that ends the turn with a reply before `timeoutMs` stops it.
 * - Antigravity: its JSON event stream (so a stop for an approval is seen, not taken for a reply), no slash commands
 *   (the text is a prompt), and its print timeout set to ours. A prompt that starts with `-` gets a space in front,
 *   so it can't be read as an option.
 */
export function remoteInvocation(harness: RemoteHarness, sessionId: string, text: string, program: Program, promptFile?: string, timeoutMs = TURN_TIMEOUT_MS): Invocation {
  const { file, prefix } = program;
  if (harness === 'claude') return { file, args: [...prefix, '-p', '--resume', sessionId, '--output-format', 'json'], stdin: text };
  if (harness === 'codex') return { file, args: [...prefix, 'exec', 'resume', sessionId, '-'], stdin: text };
  if (harness === 'hermes') {
    if (!promptFile) throw new Error('Hermes reads the prompt from a file.');
    return { file, args: [...prefix, 'chat', '--resume', sessionId, '--oneshot', '--query-file', promptFile, '--format', 'stream-json',
      '--run-budget', String(Math.max(30, Math.floor(timeoutMs / 1000) - 30))] };
  }
  return { file, args: [...prefix, '-p', text.startsWith('-') ? ` ${text}` : text, '--conversation', sessionId, '--disable-slash-commands', '--output-format', 'stream-json',
    '--print-timeout', `${Math.max(1, Math.ceil(timeoutMs / 60_000))}m`] };
}

/** A finished run: its exit, why it stopped early if it did, the start and end of its stdout, and the end of its stderr. */
export type TurnRun = { exitCode: number | null; timedOut: boolean; cancelled: boolean; stdout: string; stdoutTail: string; overflowed: boolean; stderr: string; error?: string };
/**
 * Runs a turn's invocation without a shell, its output in memory: the first and the last OUTPUT_KEEP bytes of stdout, the
 * last STDERR_KEEP of stderr. Past `timeoutMs`, or when `signal` aborts, the whole process tree is killed (taskkill /T
 * on Windows, its process group elsewhere: stopOwnChild).
 */
export function runTurnProgram(invocation: Invocation, options: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number; signal?: AbortSignal; onStart?: (pid: number) => void }) {
  return new Promise<TurnRun>(done => {
    const head: Buffer[] = [], tail: Buffer[] = [], errors: Buffer[] = [];
    let headBytes = 0, tailBytes = 0, total = 0, errorBytes = 0, timedOut = false, cancelled = false, settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined, child: ChildProcess | undefined, startError: string | undefined;
    const finish = (value: { exitCode: number | null; error?: string }) => {
      if (settled) return; settled = true;
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      try { child?.stdout?.destroy(); child?.stderr?.destroy(); } catch { /* Closed. */ }
      const end = Buffer.concat(tail), overflowed = total > OUTPUT_KEEP;
      done({ ...value, ...(startError && !value.error ? { error: startError } : {}), timedOut, cancelled, overflowed, stdout: Buffer.concat(head).toString('utf8'), stdoutTail: (overflowed ? end.subarray(end.length - OUTPUT_KEEP) : end).toString('utf8'),
        stderr: Buffer.concat(errors).subarray(-STDERR_KEEP).toString('utf8') });
    };
    // Should a killed tree still not end, the turn is settled anyway rather than held forever.
    const stop = () => { if (child) stopOwnChild(child); setTimeout(() => finish({ exitCode: null }), 30_000).unref(); };
    const abort = () => { if (settled) return; cancelled = true; stop(); };
    try {
      child = spawn(invocation.file, invocation.args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true,
        stdio: [invocation.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (error) { finish({ exitCode: null, error: error instanceof Error ? error.message : String(error) }); return; }
    const started = child;
    timer = setTimeout(() => { if (settled) return; timedOut = true; stop(); }, options.timeoutMs);
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
    started.stdout!.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (headBytes < OUTPUT_KEEP) { const part = chunk.subarray(0, OUTPUT_KEEP - headBytes); head.push(part); headBytes += part.length; }
      tail.push(chunk); tailBytes += chunk.length;
      while (tail.length > 1 && tailBytes - tail[0].length >= OUTPUT_KEEP) tailBytes -= tail.shift()!.length;
    });
    started.stderr!.on('data', (chunk: Buffer) => {
      errors.push(chunk); errorBytes += chunk.length;
      while (errors.length > 1 && errorBytes - errors[0].length >= STDERR_KEEP) errorBytes -= errors.shift()!.length;
    });
    if (invocation.stdin !== undefined) { started.stdin!.on('error', () => { /* It ended before reading it all. */ }); started.stdin!.end(invocation.stdin); }
    started.on('error', error => finish({ exitCode: null, error: error.message }));
    // A start that can't be recorded (the session ledger, say) stops the run: nothing may run in a session unseen.
    if (started.pid) {
      try { options.onStart?.(started.pid); }
      catch (error) { startError = `it could not be recorded as running: ${error instanceof Error ? error.message : String(error)}`; stop(); }
    }
    // Whatever it left in its process group is told to go; output a leftover still holds open is not waited for long.
    started.on('exit', code => { if (started.pid) reapGroup(started.pid); setTimeout(() => finish({ exitCode: code }), 2_000).unref(); });
    started.on('close', code => finish({ exitCode: code }));
  });
}

/** The part of a run's stdout the reply is read from: its start for a plain reply, its end for JSON (whose result comes last). */
function replyOutput(harness: RemoteHarness, run: TurnRun) {
  if (!run.overflowed || harness === 'codex') return run.stdout;
  // The end begins mid-line: that line is dropped.
  const end = run.stdoutTail.slice(run.stdoutTail.indexOf('\n') + 1);
  return harness === 'claude' || jsonLines(end) ? end : run.stdout;
}

export type TurnReply = { ok: true; reply: string; truncated: boolean; sessionId?: string; denied?: string[] } | { ok: false; code: 'busy' | 'failed'; message: string };
/** A reply cut to `limit` bytes of UTF-8 at a character boundary, and whether it was cut. */
export function capReply(text: string, limit = MAX_REPLY_BYTES) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= limit) return { reply: text, truncated: false };
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { reply: bytes.subarray(0, end).toString('utf8'), truncated: true };
}
const lastLine = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1);
const jsonObject = (line: string): Record<string, any> | undefined => {
  try { const value = JSON.parse(line); return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined; } catch { return undefined; }
};
/** Every line of `text` as a JSON object, when every non-empty line is one (a harness's event stream); else undefined. */
function jsonLines(text: string) {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean), events = lines.map(jsonObject);
  return lines.length && events.every(Boolean) ? events as Record<string, any>[] : undefined;
}
const failure = (message: unknown, fallback: string): TurnReply => ({ ok: false, code: 'failed', message: plainText(typeof message === 'string' ? message : '', 300) ?? fallback });

/**
 * The agent's final reply as a harness printed it, in full (capReply), unlike readHarnessOutput's short summary:
 * - Claude Code (`--output-format json`): the result object's `result`, its `session_id`, and the tools it refused;
 * - Codex: stdout, which is the final message (the session header and errors go to stderr);
 * - Hermes and Antigravity: the `result` event when they print an event stream, else stdout as it is.
 * A session another program holds is `busy` (Codex's active writer, Hermes's SESSION_NOT_OWNED), as the watchers read it.
 */
export function readTurnReply(harness: RemoteHarness, stdout: string, stderr: string, exitCode: number | null): TurnReply {
  const ended = `${HARNESS_LABELS[harness]} ended with exit ${exitCode ?? 'unknown'}.`;
  if (harness === 'claude') {
    const result = jsonObject(stdout.trim()) ?? jsonObject(lastLine(stdout) ?? '');
    if (!result) return failure(lastLine(stderr), `${ended} It printed no result.`);
    if (result.is_error === true || exitCode !== 0) return failure(typeof result.result === 'string' ? result.result : result.subtype, ended);
    const denied = Array.isArray(result.permission_denials)
      ? [...new Set(result.permission_denials.map((d: { tool_name?: unknown }) => plainText(d?.tool_name, 80)).filter((name: string | null): name is string => !!name))] as string[] : [];
    return { ok: true, ...capReply(typeof result.result === 'string' ? result.result : ''), ...(typeof result.session_id === 'string' ? { sessionId: result.session_id } : {}), ...(denied.length ? { denied } : {}) };
  }
  if (harness === 'codex') {
    if (exitCode !== 0) {
      if (/already has an active writer/.test(stderr)) return { ok: false, code: 'busy', message: 'Codex has this thread open elsewhere (the Codex app). Try again later.' };
      return failure(/^(?:ERROR|Error): (.*)$/m.exec(stderr)?.[1] ?? lastLine(stderr), ended);
    }
    const sessionId = /session id:\s*([0-9a-f-]{36})/i.exec(stderr)?.[1];
    return { ok: true, ...capReply(stdout.trim()), ...(sessionId ? { sessionId } : {}) };
  }
  if (harness === 'hermes' && exitCode !== 0 && stderr.split('\n').some(line => line.trim() === `hermes-refusal-reason: ${HERMES_SESSION_BUSY}`))
    return { ok: false, code: 'busy', message: 'Hermes has this session open elsewhere. Try again later.' };
  const events = [...jsonLines(stdout) ?? []].reverse();
  const result = harness === 'hermes' ? events.find(e => e.type === 'result')
    : events.find(e => e.event === 'result' && e.result && typeof e.result === 'object')?.result as Record<string, any> | undefined;
  if (!result) return exitCode === 0 ? { ok: true, ...capReply(stdout.trim()) } : failure(lastLine(stderr), ended);
  if (harness === 'hermes') {
    if (exitCode !== 0 || (typeof result.exit_code === 'number' && result.exit_code !== 0))
      return APPROVAL_WALL.test(stderr) ? failure('Hermes stopped for an approval, which remote prompts cannot give yet.', ended) : failure(result.error ?? lastLine(stderr), ended);
    return { ok: true, ...capReply(typeof result.text === 'string' ? result.text : ''), ...(typeof result.session_id === 'string' ? { sessionId: result.session_id } : {}) };
  }
  if (result.status === 'WAITING') return failure('Antigravity stopped for an approval, which remote prompts cannot give yet.', ended);
  if (exitCode !== 0 || (typeof result.status === 'string' && result.status !== 'SUCCESS')) return failure(result.error ?? result.status ?? lastLine(stderr), ended);
  return { ok: true, ...capReply(typeof result.response === 'string' ? result.response : ''), ...(typeof result.conversation_id === 'string' ? { sessionId: result.conversation_id } : {}) };
}

// ---------------------------------------------------------------------------
// Local API routes (the app's only)
// ---------------------------------------------------------------------------

/** A turn's request body: the prompt as JSON, which may escape a character as six, and the ids around it. */
export const TURN_BODY_BYTES = 6 * MAX_PROMPT_BYTES + 4 * 1024;
export type RemoteRouteContext = {
  home: string;
  /** The request carries the control token (the app), not the page's session token. */
  control: boolean;
  body(limit?: number): Promise<Record<string, unknown>>;
  /** runRemoteTurn's deps; without them a turn answers 503. */
  deps?: RemoteDeps;
  /** Sets the request's idle timeout in seconds, 0 for none (Bun's server.timeout). */
  keepOpen?(seconds: number): void;
  /** The daemon's control socket (control-socket.ts): enrolment and its state. Without it those routes answer 503. */
  machine?: { enrol(input: Record<string, unknown>): Promise<unknown>; status(): unknown };
};
const ROUTES = '/api/local/app/remote/';
/**
 * The remote-control routes, for the app only (the control token; the page's session token is refused):
 *   GET    /api/local/app/remote/policy                    the policy (off by default)
 *   PUT    /api/local/app/remote/policy {enabled, harnesses, trusted}   saved; turns it no longer allows stop
 *   GET    /api/local/app/remote/controllers               {controllers}
 *   DELETE /api/local/app/remote/controllers/:device       {removed}; its running turns stop
 *   GET    /api/local/app/remote/turns                     {turns}: waiting and running, ids only
 *   POST   /api/local/app/remote/turn {requestId, controller, harness, sessionId, text}   the turn's result, when it ends
 *   POST   /api/local/app/remote/cancel {turnId} or {requestId}   {cancelled}
 *   POST   /api/local/app/remote/enrol {origin, name, device, sign, enc, encVersion, encSig, secret, words, trusted?, harnesses?}
 *          the link's fields and the words the person typed: {controller, machine} (control-socket.ts enrol)
 *   GET    /api/local/app/remote/status                    the control socket: {device, connections, enrolling}
 *   GET    /api/local/app/remote/overview                  the Remote control window's view (remoteOverview)
 *   POST   /api/local/app/remote/change {allow} or {trust: {device, trusted}}   one change, made atomically (changePolicy)
 * Undefined when the path is none of them.
 */
export async function remoteRoute(path: string, method: string, ctx: RemoteRouteContext): Promise<{ status: number; value: unknown } | undefined> {
  if (!path.startsWith(ROUTES)) return undefined;
  if (!ctx.control) throw httpError(403, 'This is for the Meshrooms app only.');
  const rest = path.slice(ROUTES.length), only = (wanted: string) => { if (method !== wanted) throw httpError(405, `Use ${wanted}.`); };
  if (rest === 'policy') {
    if (method === 'GET') return { status: 200, value: readPolicy(ctx.home) };
    if (method === 'PUT') return { status: 200, value: savePolicy(ctx.home, await ctx.body()) };
    throw httpError(405, 'Use GET or PUT.');
  }
  if (rest === 'controllers') { only('GET'); return { status: 200, value: { controllers: readControllers(ctx.home) } }; }
  const controller = /^controllers\/([a-f0-9]{64})$/.exec(rest);
  if (controller) { only('DELETE'); return { status: 200, value: { removed: removeController(ctx.home, controller[1]) } }; }
  if (rest === 'turns') { only('GET'); return { status: 200, value: { turns: runningTurns(ctx.home) } }; }
  if (rest === 'turn') {
    only('POST');
    if (!ctx.deps) throw httpError(503, 'Remote control is not available in this version of Meshrooms.');
    const input = await ctx.body(TURN_BODY_BYTES);
    if (Object.keys(input).some(key => !['requestId', 'controller', 'harness', 'sessionId', 'text'].includes(key))) throw httpError(400, 'Send requestId, controller, harness, sessionId and text, and nothing else.');
    // No idle timeout for this request: a turn may wait for a room wake and then run for minutes, more than the 255
    // seconds a Bun timeout can be, and it ends by itself (waitMs, then timeoutMs).
    ctx.keepOpen?.(0);
    return { status: 200, value: await runRemoteTurn(input, ctx.deps) };
  }
  if (rest === 'enrol') {
    only('POST');
    if (!ctx.machine) throw httpError(503, 'Remote control is not available in this version of Meshrooms.');
    return { status: 200, value: await ctx.machine.enrol(await ctx.body()) };
  }
  if (rest === 'overview') { only('GET'); return { status: 200, value: remoteOverview(ctx.home, ctx.machine) }; }
  if (rest === 'change') { only('POST'); return { status: 200, value: changePolicy(ctx.home, await ctx.body()) }; }
  if (rest === 'status') {
    only('GET');
    if (!ctx.machine) throw httpError(503, 'Remote control is not available in this version of Meshrooms.');
    return { status: 200, value: ctx.machine.status() };
  }
  if (rest === 'cancel') {
    only('POST');
    const { turnId, requestId } = await ctx.body();
    const id = typeof turnId === 'string' ? turnId : runningTurns(ctx.home).find(turn => turn.requestId === requestId)?.turnId;
    return { status: 200, value: { cancelled: !!id && live.get(id)?.home === ctx.home && cancelTurn(id) } };
  }
  throw httpError(404, 'Unknown local endpoint.');
}
