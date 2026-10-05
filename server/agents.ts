/**
 * Agent identities on the person's machine (desktop-first M4): named agent profiles (name, harness, model) the person
 * puts into their rooms and binds to harness sessions, all driven by the daemon, which is the person's device.
 *
 * - Identities live in the person's folder (agents.json, 0600). Each has an agent folder of its own,
 *   <person home>/agents/<identity id>, holding one room folder (and one device key) per room it is in, like any agent
 *   folder; it is recorded in agent-homes.json when first put into a room, so the daemon looks after its runners.
 * - Putting an identity into a room: the person device signs `agent-invite {name}` and the daemon redeems the token
 *   itself through connect (connectAgent), so no link is ever copied. The room's rules still apply (four agents per
 *   operator per room, names unique in the room); the room service's refusals come back as they are.
 * - Binding it to a NEW session needs no approval (the session starts empty), but it is logged (agents.log). Binding it
 *   to an EXISTING session carries that session's context into the room, so it is only filed as a pending approval
 *   (approvals.json), which only the native app may approve. So is an identity an agent asks for (`agent request`).
 *
 * This file holds the files and the decisions; agent-cli.ts wires in connect, bind and the session bootstrap (deps).
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { BrowserAgent, RUNNER_ALIVE, replaceFile, roomClosed } from './browser-agent';
import { WATCH_STATE, WATCH_TIMING, agentHomesFile, knownAgentHomes, readSessionLedger, sessionKey, sessionLedgerFile, wakeDir } from './agent-watch';
import { locksDir, readBinding, rotateLog } from './agent-daemon';
import { tryLock } from './locks';
import { listedAgents, personHome } from './person';
import { HARNESS_IDS, HARNESS_LABELS, RENDERS_BLANK, plainText, type HarnessId } from './detectors/harnesses';

/** Files in the person's folder. */
export const AGENTS_FILE = 'agents.json', APPROVALS_FILE = 'approvals.json', AGENTS_LOG = 'agents.log', AGENTS_LOCK = 'agents.lock';
/** The room service's limit on member names, and its one reserved name. */
export const MAX_NAME = 64;
/** Approvals waiting at once, and how long one waits. */
export const MAX_APPROVALS = 32, APPROVAL_TTL_MS = 24 * 3_600_000;
/** A new session's start that hasn't finished after this long is reported as failed (the daemon stopped meanwhile). */
export const BOOTSTRAP_STALE_MS = 10 * 60_000;
/** The label the identity's device carries in the room's device list. */
export const AGENT_DEVICE_LABEL = 'Meshrooms app';

/** The most identities a person keeps. */
export const MAX_IDENTITIES = 32;
/** Identity requests one harness kind may have waiting at once, so no one source fills the approvals queue. */
export const MAX_REQUESTS_PER_HARNESS = 4;
/**
 * Written into every identity's agent folder when it is made: a folder that carries it belongs to the app, and no
 * command-line bind or watch runs in it (startWatch refuses it, however the folder was reached: env, a link, a short name).
 */
export const IDENTITY_MARKER = 'meshrooms-app-identity.json';
/** Rate limits on what the page may start: a link minted (put into a room), and a new session (a model run). */
export const PUT_LIMIT = { count: 6, windowMs: 10 * 60_000 }, BIND_NEW_LIMIT = { count: 3, windowMs: 10 * 60_000 };
/** After a connect fails, the room gets no new link for this long. */
export const CONNECT_COOLDOWN_MS = 60_000;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** A model id: starts with a letter or digit (never read as a flag), then at most 99 more of these. */
export const MODEL = /^[A-Za-z0-9][\w.:/@-]{0,99}$/;
/**
 * The folders whose names say where things are on this machine: the home folder, the person's folder (where the
 * environment puts it, and the default one), the bridge's state folder and the temporary folder.
 */
export const knownRoots = () => [homedir(), personHome(), personHome({}), dirname(agentHomesFile()), tmpdir()];
/**
 * A message as it may go out to the page: no local path in it. The known roots are replaced first, however they are
 * spelled (either separator, JSON-escaped, any case on Windows); then anything else that looks like a path (a drive or
 * UNC path, an absolute or home-relative POSIX path) is replaced up to a delimiter (a quote, comma, semicolon, bracket,
 * a sentence's end or the line's), spaces included, so `C:\Users\Jane Doe\...` never leaves half of itself behind.
 */
export function pathFree(message: string, roots: string[] = knownRoots()) {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const spellings = [...new Set(roots.filter(r => r && r.length > 3).flatMap(root => {
    const full = resolve(root);
    return [full, full.replace(/\\/g, '/'), full.replace(/\//g, '\\'), full.replace(/\\/g, '\\\\')];
  }))].sort((a, b) => b.length - a.length);
  let out = message;
  for (const spelling of spellings) out = out.replace(new RegExp(escape(spelling), process.platform === 'win32' ? 'gi' : 'g'), '<path>');
  const rest = String.raw`(?:(?!\.(?:\s|$))[^'"\x60<>|,;)\]\r\n])*`;
  return out
    .replace(new RegExp(String.raw`(?:\b[A-Za-z]:[\\/]|\\\\[^\\\s]+\\)` + rest, 'g'), '<path>')
    .replace(new RegExp(String.raw`(?<![\w.:/<>-])(?:~|\.{1,2})?\/[^\s'"\x60<>|,;)\]/]+` + rest, 'g'), '<path>');
}
export const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

/**
 * Why a binding failed, as a fixed code the page can show in its own words; `error` is the path-free message.
 * `bootstrap-failed`: the new session didn't start. `bind-refused`: bind refused the binding. `not-finished`: the daemon
 * stopped before the start finished.
 */
export type BindFailure = 'bootstrap-failed' | 'bind-refused' | 'not-finished';
const BIND_FAILURES: BindFailure[] = ['bootstrap-failed', 'bind-refused', 'not-finished'];
/**
 * How an identity's room is bound, as the daemon recorded it: `new` (a dedicated session) or `existing` (approved).
 * `paused`: when the person paused its wakes from the app's Review window; the binding is kept, to resume as it was.
 * `cwd`: the folder an approved existing session was bound to work in (Claude Code's own), which Resume binds again.
 * `held`: what its watcher held its wakes for when last seen (see Hold), kept so nothing done to the wakes hides it.
 */
export type BoundRecord = { kind: 'new' | 'existing'; state: 'starting' | 'bound' | 'failed'; session?: string; reason?: BindFailure; error?: string; at: number; paused?: number;
  cwd?: string; held?: Hold };
/**
 * An agent identity. `command`: an exec identity's command template ({prompt_file} where the prompt file goes), only ever
 * set at the person's terminal (`agent create --command`), never over the local API or by an agent's request.
 */
export type AgentIdentity = { id: string; name: string; harness: HarnessId; model?: string; command?: string; createdAt: number; bound?: Record<string, BoundRecord> };

/** A name the room service takes for a member: 1 to 64 characters, no control characters, not "agents". */
export function nameProblem(name: unknown): string | undefined {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > MAX_NAME || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}]/u.test(name) || RENDERS_BLANK.test(name)) return `Give the agent a name of 1 to ${MAX_NAME} characters, as plain text.`;
  if (name.trim().toLowerCase() === 'agents') return '"agents" is reserved: @agents addresses every agent. Choose another name.';
  return undefined;
}
const validBound = (b: unknown): b is BoundRecord => {
  const r = b as Partial<BoundRecord> | null;
  return !!r && (r.kind === 'new' || r.kind === 'existing') && (r.state === 'starting' || r.state === 'bound' || r.state === 'failed') && typeof r.at === 'number'
    && (r.session === undefined || typeof r.session === 'string') && (r.error === undefined || typeof r.error === 'string')
    && (r.reason === undefined || BIND_FAILURES.includes(r.reason)) && (r.paused === undefined || typeof r.paused === 'number')
    && (r.cwd === undefined || (typeof r.cwd === 'string' && r.cwd.length <= 4_096 && !/[\p{Cc}\p{Cf}]/u.test(r.cwd) && !RENDERS_BLANK.test(r.cwd))) && (r.held === undefined || validHold(r.held));
};
/** Whether an entry of agents.json is an identity, checked in full: the file is the user's, and anything may have written it. */
export function validIdentity(value: unknown): value is AgentIdentity {
  const i = value as Partial<AgentIdentity> | null;
  if (!i || typeof i.id !== 'string' || !UUID.test(i.id) || nameProblem(i.name) !== undefined || !HARNESS_IDS.includes(i.harness as HarnessId) || typeof i.createdAt !== 'number') return false;
  if (i.model !== undefined && (typeof i.model !== 'string' || !MODEL.test(i.model))) return false;
  if (i.command !== undefined && (i.harness !== 'exec' || typeof i.command !== 'string' || i.command.length > 2_000 || !i.command.includes('{prompt_file}'))) return false;
  if (i.bound !== undefined && (typeof i.bound !== 'object' || Array.isArray(i.bound) || !Object.entries(i.bound).every(([room, b]) => UUID.test(room) && validBound(b)))) return false;
  return true;
}
const readJson = <T>(path: string, fallback: T): T => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };
/** The person's identities, in the order they were made; entries that don't check out are left out, never guessed at. */
export function readIdentities(home = personHome()): AgentIdentity[] {
  const list = readJson<unknown>(join(home, AGENTS_FILE), []);
  return Array.isArray(list) ? list.filter(validIdentity) : [];
}
/** An identity's agent folder: one per identity, named by its id (never by its name). */
export const identityHome = (home: string, id: string) => join(home, 'agents', id);
/** Makes the identity's folder (0700) and marks it as the app's (IDENTITY_MARKER). */
export function markIdentityHome(home: string, id: string) {
  const dir = identityHome(home, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(join(dir, IDENTITY_MARKER))) replaceFile(join(dir, IDENTITY_MARKER), JSON.stringify({ identity: id, note: 'This agent belongs to the Meshrooms app: bind it from the app, not the command line.' }));
  return dir;
}

/** A sliding-window limit per key: `take` throws 429 once `count` were taken within `windowMs`. In memory, per daemon. */
export function rateLimit(limit: { count: number; windowMs: number }, now: () => number = Date.now) {
  const seen = new Map<string, number[]>();
  return {
    take(key: string, what: string) {
      const at = now(), recent = (seen.get(key) ?? []).filter(t => t > at - limit.windowMs);
      if (recent.length >= limit.count) throw httpError(429, `Too many ${what} in a short time. Wait a few minutes and try again.`);
      seen.set(key, [...recent, at]);
    },
  };
}
const putLimit = rateLimit(PUT_LIMIT), bindNewLimit = rateLimit(BIND_NEW_LIMIT);
/** Rooms whose last connect failed, until when no new link is made for them. */
const connectCooldown = new Map<string, number>();

/**
 * Runs `work` holding the person folder's agents lock: one change to agents.json or approvals.json at a time, across the
 * daemon and the CLI. Waits briefly for another holder.
 */
export async function withAgentsLock<T>(home: string, work: () => T | Promise<T>, waitMs = 5_000): Promise<T> {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = join(home, AGENTS_LOCK);
  for (const by = Date.now() + waitMs; !tryLock(lock, 'agents change');) {
    if (Date.now() >= by) throw httpError(409, 'Another change to the agents is being made. Try again in a moment.');
    await Bun.sleep(25);
  }
  try { return await work(); } finally { try { unlinkSync(lock); } catch { /* Already gone. */ } }
}
const writeIdentities = (home: string, list: AgentIdentity[]) => replaceFile(join(home, AGENTS_FILE), JSON.stringify(list, null, 2));
async function updateIdentity(home: string, id: string, change: (identity: AgentIdentity) => AgentIdentity) {
  return withAgentsLock(home, () => {
    const list = readIdentities(home), at = list.findIndex(i => i.id === id);
    if (at < 0) throw httpError(404, 'There is no agent with that id.');
    list[at] = change(list[at]);
    writeIdentities(home, list);
    return list[at];
  });
}

/** One line in agents.log: what was done, to which identity and room. Never a session title or a path. */
export function logAgents(home: string, event: Record<string, unknown>) {
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const path = join(home, AGENTS_LOG);
    rotateLog(path);
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
  } catch { /* A log that can't be written never stops the change. */ }
}

/**
 * The checks an identity's fields pass, whoever asks for one. `command`: a custom command (the exec harness) is code the
 * daemon runs as the person at every wake, so only the person makes one, in the app's own window (`allowed`: the
 * app-only route). The page, `agent create` and any request (an agent's) are refused it.
 */
const CUSTOM_COMMAND_HOW = 'A custom-command agent runs a program as you at every wake, so only you make one, in the Meshrooms app.';
function checkedInput(input: { name?: unknown; harness?: unknown; model?: unknown; command?: unknown }, options: { command: 'allowed' | 'refused' }) {
  const problem = nameProblem(input.name);
  if (problem) throw httpError(400, problem);
  if (!HARNESS_IDS.includes(input.harness as HarnessId)) throw httpError(400, `Use a harness of ${HARNESS_IDS.join(', ')}.`);
  const harness = input.harness as HarnessId;
  if (input.model !== undefined && input.model !== null && (typeof input.model !== 'string' || !MODEL.test(input.model))) throw httpError(400, 'Use a model id, e.g. sonnet.');
  if ((input.command !== undefined || harness === 'exec') && options.command === 'refused') throw httpError(400, CUSTOM_COMMAND_HOW);
  if (harness === 'exec' && (typeof input.command !== 'string' || !input.command.includes('{prompt_file}') || input.command.length > 2_000))
    throw httpError(400, "Give --command with the program to run and {prompt_file} where the prompt file goes, e.g. --command 'my-agent --prompt-file {prompt_file}'.");
  if (harness !== 'exec' && input.command !== undefined) throw httpError(400, '--command is for --harness exec.');
  return { name: (input.name as string).trim(), harness, ...(typeof input.model === 'string' ? { model: input.model } : {}), ...(harness === 'exec' ? { command: input.command as string } : {}) };
}
const nameTaken = (list: AgentIdentity[], name: string) => list.some(i => i.name.toLowerCase() === name.toLowerCase());

/**
 * A new identity. `command`: whether an exec command may be set, which only an approved request does (decideApproval);
 * the page and `agent create` may not (checkedInput). Names are unique among the person's identities, ignoring case.
 */
export async function createIdentity(input: { name?: unknown; harness?: unknown; model?: unknown; command?: unknown }, home = personHome(), options: { command: 'allowed' | 'refused'; check?: (command: string) => void } = { command: 'refused' }) {
  const fields = checkedInput(input, options);
  if (fields.command !== undefined) { try { options.check?.(fields.command); } catch (error) { throw httpError(400, error instanceof Error ? error.message : String(error)); } }
  const made = await withAgentsLock(home, () => {
    const list = readIdentities(home);
    if (nameTaken(list, fields.name)) throw httpError(409, `You already have an agent named ${fields.name}.`);
    if (list.length >= MAX_IDENTITIES) throw httpError(429, `You have ${MAX_IDENTITIES} agents already. Delete one first.`);
    const identity: AgentIdentity = { id: randomUUID(), ...fields, createdAt: Date.now() };
    // Marked as the app's before it is listed, so no command-line bind ever finds it unmarked.
    markIdentityHome(home, identity.id);
    writeIdentities(home, [...list, identity]);
    return identity;
  });
  logAgents(home, { event: 'identity-created', identity: made.id, harness: made.harness });
  return made;
}

/**
 * Why a watcher holds an agent's wakes until its person decides: a pause on a broken confinement or an approval wall
 * (`hard-pause`), or a halt (the harness's session ownership broke, or a run from before a restart may still be going:
 * `pid` is the process it is checking). Resuming clears it, so the app asks first, naming it.
 */
export type Hold = { kind: 'hard-pause' | 'halted'; reason: string; at: number; pid?: number };
const validHold = (h: unknown): h is Hold => {
  const v = h as Partial<Hold> | null;
  return !!v && (v.kind === 'hard-pause' || v.kind === 'halted') && typeof v.reason === 'string' && v.reason.length <= 2_000 && typeof v.at === 'number'
    && (v.pid === undefined || Number.isSafeInteger(v.pid));
};
/** A watcher whose proof of life is older than this is taken for gone: twice its heartbeat. */
export const WATCHER_FRESH_MS = 2 * WATCH_TIMING.heartbeatMs;
type WatchFile = {
  paused?: { reason?: unknown; at?: unknown; hard?: unknown; generation?: unknown }; halted?: { reason?: unknown; at?: unknown; generation?: unknown; pid?: unknown };
  aliveAt?: unknown; lastCheck?: unknown; startedAt?: unknown; stoppedAt?: unknown };
/** The hold the room's watcher state, or its session's ledger, has for the binding as it stands (`generation`), if any. */
function watchHold(watch: WatchFile | undefined, binding: ReturnType<typeof readBinding>): Hold | undefined {
  const current = (g: unknown) => g === undefined || g === binding?.config.generation;
  const text = (v: unknown) => typeof v === 'string' ? v : 'no reason given';
  const at = (v: unknown) => typeof v === 'number' ? v : 0;
  if (watch?.halted && current(watch.halted.generation))
    return { kind: 'halted', reason: text(watch.halted.reason), at: at(watch.halted.at), ...(Number.isSafeInteger(watch.halted.pid) ? { pid: watch.halted.pid as number } : {}) };
  if (watch?.paused?.hard === true && current(watch.paused.generation)) return { kind: 'hard-pause', reason: text(watch.paused.reason), at: at(watch.paused.at) };
  if (binding) {
    try {
      const ledger = readSessionLedger(sessionLedgerFile(locksDir(), sessionKey(binding.config)));
      if (ledger.halted) return { kind: 'halted', reason: `the session is halted: ${ledger.halted.reason}`, at: ledger.halted.at };
    } catch { /* No ledger yet. */ }
  }
  return undefined;
}
/** Whether the room's watcher proved it is alive within WATCHER_FRESH_MS (and didn't stop since). */
function watcherAlive(watch: WatchFile | undefined, now: number) {
  const last = Math.max(...[watch?.aliveAt, watch?.lastCheck, watch?.startedAt].map(v => typeof v === 'number' ? v : 0));
  return last > 0 && now - last < WATCHER_FRESH_MS && !(typeof watch?.stoppedAt === 'number' && watch.stoppedAt >= last);
}

/** One room an identity is in, as its folder says (files only: no process lookups, so the page can ask often). */
export type IdentityRoom = {
  roomId: string; title: string | null; memberId: string | null; state: 'connected' | 'waiting' | 'closed' | 'removed';
  runner: 'alive' | 'down';
  binding: { wakes: 'unbound' | 'on' | 'off' | 'paused' | 'halted'; kind?: 'new' | 'existing'; state?: BoundRecord['state']; reason?: BindFailure; session?: string | null; error?: string; offReason?: string;
    /** Why the watcher paused or halted its wakes (an approval wall, say), as capped plain text. */
    why?: string;
    /** The person paused it from the app (Review); it resumes as it was. */
    pausedInApp?: true;
    /** What holds its wakes until the person decides (see Hold), with the reason as capped plain text. */
    hold?: Hold;
    /** Its watcher proved it is alive within WATCHER_FRESH_MS. */
    watcher: 'alive' | 'down';
    /**
     * Wakes are on, the watcher is alive and has its listen cursor: from here on a message that addresses the agent
     * wakes it. Until then (the room's history is still arriving, or no watcher runs) one could pass unnoticed, so the
     * page says it is starting.
     */
    listening: boolean };
};
function identityRooms(home: string, identity: AgentIdentity, now = Date.now()): IdentityRoom[] {
  const base = join(identityHome(home, identity.id), 'browser-agents');
  let ids: string[]; try { ids = readdirSync(base).filter(id => UUID.test(id)); } catch { return []; }
  return ids.flatMap(roomId => {
    const dir = join(base, roomId), room = readJson<{ origin?: unknown } | undefined>(join(dir, 'room.json'), undefined);
    if (typeof room?.origin !== 'string') return [];
    const agent = new BrowserAgent(identityHome(home, identity.id), room.origin, roomId, { mkdir: false });
    const { memberId, title } = agent.members(), proof = readJson<{ at?: unknown; removedSince?: unknown } | undefined>(join(dir, RUNNER_ALIVE), undefined);
    const state: IdentityRoom['state'] = roomClosed(agent) ? 'closed' : typeof proof?.removedSince === 'number' ? 'removed' : memberId ? 'connected' : 'waiting';
    const binding = readBinding(dir), watch = readJson<WatchFile | undefined>(join(dir, WATCH_STATE), undefined);
    let record = identity.bound?.[roomId];
    if (record?.state === 'starting' && now - record.at > BOOTSTRAP_STALE_MS) record = { ...record, state: 'failed', reason: 'not-finished', error: 'The new session did not finish starting.' };
    // A pause or halt of an older binding (one bound again since) is the old watcher's, not this one's.
    const current = (g: unknown) => g === undefined || g === binding?.config.generation;
    const halted = !!watch?.halted && current(watch.halted.generation), paused = !!watch?.paused && current(watch.paused.generation);
    const wakes = !binding ? 'unbound' as const : !binding.enabled ? 'off' as const : halted ? 'halted' as const : paused ? 'paused' as const : 'on' as const;
    const why = wakes === 'halted' ? watch?.halted?.reason : wakes === 'paused' ? watch?.paused?.reason : undefined;
    // What the watcher holds the wakes for is shown however the wakes stand, and kept in the record once seen.
    const held = watchHold(watch, binding) ?? record?.held, watcher = watcherAlive(watch, now) ? 'alive' as const : 'down' as const;
    return [{ roomId, title: plainText(title, 120), memberId: memberId ?? null, state, runner: typeof proof?.at === 'number' && now - proof.at < 15_000 ? 'alive' as const : 'down' as const,
      binding: { wakes, ...(record ? { kind: record.kind, state: record.state, ...(record.reason ? { reason: record.reason } : {}),
          ...(record.error ? { error: plainText(pathFree(record.error), 300) ?? undefined } : {}) } : {}),
        ...(binding ? { session: binding.session ?? null } : record?.session ? { session: record.session } : {}),
        ...(binding?.offReason ? { offReason: plainText(pathFree(binding.offReason), 300) ?? undefined } : {}),
        ...(typeof why === 'string' && plainText(pathFree(why), 300) ? { why: plainText(pathFree(why), 300)! } : {}),
        ...(record?.paused !== undefined && wakes === 'off' && !held ? { pausedInApp: true as const } : {}),
        ...(held ? { hold: { ...held, reason: plainText(pathFree(held.reason), 300) ?? 'no reason given' } } : {}),
        watcher, listening: wakes === 'on' && watcher === 'alive' && !!agent.listenCursor() } }];
  });
}
/** The identities as the page lists them: each with its rooms and their binding state, and no command or path. */
export function listIdentities(home = personHome(), now = Date.now()) {
  return readIdentities(home).map(identity => ({ id: identity.id, name: identity.name, harness: identity.harness, label: HARNESS_LABELS[identity.harness],
    model: identity.model ?? null, custom: identity.harness === 'exec' && !!identity.command, createdAt: new Date(identity.createdAt).toISOString(),
    rooms: identityRooms(home, identity, now) }));
}

/** What agents.ts needs from the bridge: agent-cli.ts wires the real connect, bind and bootstrap; tests wire their own. */
export type AgentDeps = {
  connect(input: { agentHome: string; origin: string; roomId: string; token: string; harness: string; model?: string; label: string; wait: false }): Promise<{ state: string; runnerPid?: number | null; bridge?: { runner?: string } }>;
  /** bind (startWatch) with these options, for the room folder of `agent`. */
  bind(agent: BrowserAgent, values: Record<string, string>): Promise<{ pid?: number | null; warnings?: string[] }>;
  unbind(agent: BrowserAgent): Promise<{ stopped: boolean; wakes: string }>;
  /** Stops a room of an identity being deleted: wakes off, the room left alone, its runner stopped (as `stop`). */
  stopRoom?(agent: BrowserAgent): Promise<unknown>;
  /** What connect checks before it touches a link (the room service takes this bridge), run before a link is made. */
  preflight?(origin: string): Promise<unknown>;
  /**
   * A new session of `harness` for the identity in this room, with its name and the room in the first prompt: its id,
   * proven made by this run (never an id the run merely printed).
   */
  bootstrap(agent: BrowserAgent, input: { harness: 'claude' | 'codex' | 'hermes'; name: string; model?: string; title: string | null; identityId: string }): Promise<string>;
  /** Where an existing session of this harness works (Claude Code: its transcript's folder), when binding needs it. */
  sessionFolder(harness: HarnessId, session: string): string | undefined;
  /** Throws when a custom command's template doesn't parse (splitTemplate). */
  checkCommand?(command: string): void;
};

/** The person's admitted device in a room, or why not (404, 409). */
function personIn(home: string, roomId: string) {
  if (!UUID.test(roomId)) throw httpError(400, 'Use a room id.');
  const listed = listedAgents(home).find(r => r.room.roomId === roomId);
  if (!listed) throw httpError(404, 'This person is not in that room.');
  if (!listed.agent.members().memberId) throw httpError(409, 'This device is not admitted to the room yet.');
  if (roomClosed(listed.agent)) throw httpError(410, 'This room is closed.');
  return listed;
}
const identityOf = (home: string, id: unknown) => {
  const found = typeof id === 'string' ? readIdentities(home).find(i => i.id === id) : undefined;
  if (!found) throw httpError(404, 'There is no agent with that id.');
  return found;
};
/**
 * Changes in progress, one per identity at a time across all its rooms: putting it into a room, binding (a new
 * session's start included, until it is bound or failed), unbinding, approving a bind and deleting it. Whatever the
 * change checks (the identity still there, its rooms) it checks inside this, so none can race another.
 */
const inProgress = new Set<string>();
const busy = () => httpError(409, 'This agent is being changed already. Wait a moment and try again.');
async function withIdentity<T>(id: string, work: () => Promise<T>) {
  if (inProgress.has(id)) throw busy();
  inProgress.add(id);
  try { return await work(); } finally { inProgress.delete(id); }
}
/** The identity as it stands now, inside its lock: it may have been deleted since the request was read. */
const stillThere = (home: string, id: string) => {
  const found = readIdentities(home).find(i => i.id === id);
  if (!found) throw httpError(404, 'That agent was deleted meanwhile.');
  return found;
};
/** Marks an identity's room folder as the app's (IDENTITY_MARKER), besides its agent folder. */
export function markIdentityRoom(home: string, id: string, roomId: string) {
  markIdentityHome(home, id);
  const dir = join(identityHome(home, id), 'browser-agents', roomId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(join(dir, IDENTITY_MARKER))) replaceFile(join(dir, IDENTITY_MARKER), JSON.stringify({ identity: id, room: roomId }));
}
const roomFolderOf = (home: string, identity: AgentIdentity, roomId: string) => {
  const agentHome = identityHome(home, identity.id), room = readJson<{ origin?: unknown } | undefined>(join(agentHome, 'browser-agents', roomId, 'room.json'), undefined);
  return typeof room?.origin === 'string' ? new BrowserAgent(agentHome, room.origin, roomId) : undefined;
};

/**
 * Puts an identity into one of the person's rooms: the person device makes an agent link for its name, and the daemon
 * redeems it in the identity's folder at once (connectAgent). The agent then is a member the person operates, and the
 * daemon starts its runner. One already in the room (or waiting for the host) is not added again.
 */
export async function putIntoRoom(identityId: unknown, roomId: string, deps: Pick<AgentDeps, 'connect' | 'preflight'>, home = personHome(), now: () => number = Date.now) {
  const { id } = identityOf(home, identityId);
  return withIdentity(id, async () => {
    const identity = stillThere(home, id), { room, agent: person } = personIn(home, roomId);
    const cooling = connectCooldown.get(roomId);
    if (cooling !== undefined && cooling > now()) throw httpError(429, 'The last try to add an agent to this room failed a moment ago. Wait a minute and try again.');
    // Already in the room (its runner's own record says so, and no status poll from here disturbs its presence), or
    // waiting for the host (the room service says so for the identity's device), before a link is made that connect
    // would then refuse.
    const existing = roomFolderOf(home, identity, roomId);
    const removed = existing && (roomClosed(existing) || typeof readJson<{ removedSince?: unknown }>(join(existing.dir, RUNNER_ALIVE), {}).removedSince === 'number');
    if (existing && existing.members().memberId && !removed) throw httpError(409, `${identity.name} is already in this room.`);
    if (existing && !removed && existsSync(join(existing.dir, 'identity.json'))) {
      const status = await existing.command('status', { session: randomUUID() }).catch(() => undefined);
      if (status?.memberId) throw httpError(409, `${identity.name} is already in this room.`);
      if (status?.request?.state === 'pending') throw httpError(409, `${identity.name} is waiting for the host to let it into this room.`);
    }
    if (existing && existsSync(join(existing.dir, 'connect.lock'))) throw httpError(409, `${identity.name} is being connected to this room already.`);
    // What connect would refuse for, checked before a link is made, so a refusal never leaves an unused link behind:
    // a bridge the room service no longer takes.
    try { await deps.preflight?.(room.origin); }
    catch (error) { throw httpError(502, pathFree(error instanceof Error ? error.message : String(error))); }
    putLimit.take(roomId, 'agents added to this room');
    markIdentityRoom(home, identity.id, roomId);
    let token: string;
    try {
      const made = await person.command('agent-invite', { name: identity.name });
      if (typeof made?.token !== 'string') throw httpError(502, 'The room service did not give an agent link.');
      token = made.token;
    } catch (error) {
      const status = (error as { status?: number }).status;
      throw httpError(status && status < 500 ? status : 502, error instanceof Error ? error.message : String(error));
    }
    let joined: Awaited<ReturnType<AgentDeps['connect']>>;
    try {
      joined = await deps.connect({ agentHome: identityHome(home, identity.id), origin: room.origin, roomId, token, harness: HARNESS_LABELS[identity.harness],
        ...(identity.model ? { model: identity.model } : {}), label: AGENT_DEVICE_LABEL, wait: false });
    } catch (error) {
      // The link made above may be left unused: no new one for this room for a while.
      connectCooldown.set(roomId, now() + CONNECT_COOLDOWN_MS);
      logAgents(home, { event: 'put-failed', identity: identity.id, room: roomId });
      const status = (error as { status?: number }).status;
      throw httpError(status && status < 500 ? status : 502, pathFree(error instanceof Error ? error.message : String(error)));
    }
    logAgents(home, { event: 'put-in-room', identity: identity.id, room: roomId, state: joined.state });
    return { identityId: identity.id, roomId, state: joined.state === 'connected' ? 'connected' as const : 'waiting' as const, runner: joined.bridge?.runner ?? null };
  });
}

/**
 * An identity's room by the agent's member id there, or by the identity's id (before the host admitted it), and only
 * when this person may act on it: the room is on the person's list and the person is admitted there (personIn), the
 * identity is one of the person's own (agents.json), and, once the agent is a member, the room's roster as the person
 * device holds it shows that member as an agent operated by this person. Anything else is not the person's to bind.
 */
export function identityInRoom(home: string, roomId: string, key: string) {
  if (!UUID.test(roomId) || !UUID.test(key)) throw httpError(400, 'Use a room id and the agent\'s member id.');
  const { agent: person } = personIn(home, roomId);
  for (const identity of readIdentities(home)) {
    const agent = roomFolderOf(home, identity, roomId);
    if (!agent || (identity.id !== key && agent.members().memberId !== key)) continue;
    const memberId = agent.members().memberId;
    if (memberId) {
      const roster = person.members(), member = roster.members.find(m => m.id === memberId);
      // Not on the person's roster yet (just admitted; the person device's runner hears of it within seconds): try again.
      if (!member) throw httpError(409, `The room's roster doesn't show ${identity.name} yet. Try again in a moment.`);
      if (member.role !== 'agent' || member.operatorId !== roster.memberId) throw httpError(403, `${identity.name} is not an agent you operate in this room.`);
    }
    return { identity, agent };
  }
  throw httpError(404, 'No agent of yours with that id is in this room.');
}
const setBound = (home: string, identity: AgentIdentity, roomId: string, record: BoundRecord | undefined) =>
  updateIdentity(home, identity.id, current => {
    const { [roomId]: _, ...rest } = current.bound ?? {};
    return { ...current, bound: record ? { ...rest, [roomId]: record } : rest };
  });

/**
 * Binds an identity in a room to a NEW session, which needs no approval: it starts empty. Logged. exec binds its command
 * at once; Claude Code, Codex and Hermes first start a session for the identity (deps.bootstrap, with its name and the
 * room in the first prompt), which can take a while, so that runs on after this returns (`state: starting`) and the
 * agents list says how it went. A new session always works in the room's own wake folder: a working folder of the
 * person's choice is a terminal decision (meshrooms bind --cwd).
 */
export async function bindNewSession(roomId: string, key: string, deps: AgentDeps, home = personHome(), options: { background?: boolean } = {}) {
  const { identity, agent } = identityInRoom(home, roomId, key);
  if (roomClosed(agent)) throw httpError(410, 'This room is closed.');
  const wake = wakeDir({ roomDir: agent.dir });
  mkdirSync(wake, { recursive: true, mode: 0o700 });
  const model: Record<string, string> = identity.model ? { '--model': identity.model } : {};
  if (identity.harness === 'exec') {
    if (!identity.command) throw httpError(409, `${identity.name} has no command. Make a custom-command agent in the Meshrooms app.`);
    return withIdentity(identity.id, async () => {
      stillThere(home, identity.id);
      bindNewLimit.take(identity.id, 'new sessions for this agent');
      const bound = await bindChecked(deps, agent, { '--harness': 'exec', '--command': identity.command!, '--cwd': wake });
      await setBound(home, identity, roomId, { kind: 'new', state: 'bound', at: Date.now() });
      logAgents(home, { event: 'bind-new', identity: identity.id, room: roomId, harness: 'exec', warnings: bound.warnings?.length ?? 0 });
      return { identityId: identity.id, roomId, harness: identity.harness, kind: 'new' as const, state: 'bound' as const, session: null };
    });
  }
  const harness = identity.harness as 'claude' | 'codex' | 'hermes';
  const key2 = identity.id;
  if (inProgress.has(key2)) throw busy();
  // Each one is a model run: a few per agent per window, however often the page asks.
  bindNewLimit.take(identity.id, 'new sessions for this agent');
  inProgress.add(key2);
  await setBound(home, identity, roomId, { kind: 'new', state: 'starting', at: Date.now() }).catch(error => { inProgress.delete(key2); throw error; });
  logAgents(home, { event: 'bind-new', identity: identity.id, room: roomId, harness, state: 'starting' });
  const run = (async () => {
    let reason: BindFailure = 'bootstrap-failed';
    try {
      const session = await deps.bootstrap(agent, { harness, name: identity.name, ...(identity.model ? { model: identity.model } : {}), title: agent.members().title ?? null, identityId: identity.id });
      reason = 'bind-refused';
      // Deleted while its session started (delete waits for this lock, so only from outside the daemon): nothing is bound.
      stillThere(home, identity.id);
      const bound = await bindChecked(deps, agent, { '--harness': harness, '--session': session, ...(harness === 'codex' ? {} : { '--cwd': wake }), ...model });
      await setBound(home, identity, roomId, { kind: 'new', state: 'bound', session, at: Date.now() });
      logAgents(home, { event: 'bound', identity: identity.id, room: roomId, harness, session, warnings: bound.warnings?.length ?? 0 });
      return session;
    } catch (error) {
      const message = pathFree(error instanceof Error ? error.message : String(error));
      await setBound(home, identity, roomId, { kind: 'new', state: 'failed', reason, error: message.slice(0, 300), at: Date.now() }).catch(() => {});
      logAgents(home, { event: 'bind-failed', identity: identity.id, room: roomId, harness, reason });
      throw error;
    } finally { inProgress.delete(key2); }
  })();
  if (options.background === false) { const session = await run; return { identityId: identity.id, roomId, harness, kind: 'new' as const, state: 'bound' as const, session }; }
  run.catch(() => { /* Recorded in agents.json, shown by the agents list. */ });
  return { identityId: identity.id, roomId, harness, kind: 'new' as const, state: 'starting' as const, session: null };
}
async function bindChecked(deps: Pick<AgentDeps, 'bind'>, agent: BrowserAgent, values: Record<string, string>) {
  try { return await deps.bind(agent, values); }
  catch (error) { throw httpError((error as { status?: number }).status ?? 409, pathFree(error instanceof Error ? error.message : String(error))); }
}

/** Turns an identity's wakes off in a room; the agent stays in the room and connected. No approval: either side may. */
export async function unbindIdentity(roomId: string, key: string, deps: Pick<AgentDeps, 'unbind'>, home = personHome()) {
  const { identity, agent } = identityInRoom(home, roomId, key);
  return withIdentity(identity.id, async () => {
    stillThere(home, identity.id);
    const result = await deps.unbind(agent);
    await setBound(home, identity, roomId, undefined);
    logAgents(home, { event: 'unbind', identity: identity.id, room: roomId });
    return { identityId: identity.id, roomId, wakes: result.wakes, stopped: result.stopped };
  });
}

/**
 * Records a hold the watcher has on an identity's room (see Hold) in its bound record, so that nothing done to the
 * wakes afterwards (an app pause, a watcher restart) hides why it stopped. The daemon calls it when it first sees one.
 */
export async function recordHold(home: string, identityId: string, roomId: string, hold: Hold) {
  const identity = readIdentities(home).find(i => i.id === identityId), record = identity?.bound?.[roomId];
  if (!identity || !record || (record.held && record.held.at === hold.at && record.held.kind === hold.kind)) return;
  await setBound(home, identity, roomId, { ...record, held: { kind: hold.kind, reason: hold.reason.slice(0, 2_000), at: hold.at, ...(hold.pid !== undefined ? { pid: hold.pid } : {}) } });
}
/** The hold on an identity's room now: the watcher's, or the one its record kept. */
const holdOf = (home: string, identity: AgentIdentity, roomId: string) => identityRooms(home, identity).find(r => r.roomId === roomId)?.binding.hold;
/**
 * Pauses an identity's wakes in a room from the app's Review window: wakes off (as unbind does) and the watcher stopped,
 * but the binding is kept (`paused`), so Resume binds the same session again and nothing is dropped. App-only. Never on
 * a binding its watcher holds (a broken confinement, an approval wall, a halt): that would put "paused" over the reason.
 */
export async function pauseIdentity(roomId: string, key: string, deps: Pick<AgentDeps, 'unbind'>, home = personHome()) {
  const { identity, agent } = identityInRoom(home, roomId, key);
  return withIdentity(identity.id, async () => {
    const current = stillThere(home, identity.id), record = current.bound?.[roomId];
    if (!record || record.state !== 'bound') throw httpError(409, `${identity.name} has no binding in this room to pause.`);
    const hold = holdOf(home, current, roomId);
    if (hold) {
      await recordHold(home, identity.id, roomId, hold);
      throw Object.assign(httpError(409, `${identity.name}'s waking already stopped: ${hold.reason}`), { code: 'hold' });
    }
    await deps.unbind(agent);
    await setBound(home, identity, roomId, { ...record, paused: Date.now() });
    logAgents(home, { event: 'pause', identity: identity.id, room: roomId });
    return { identityId: identity.id, roomId, wakes: 'paused' as const };
  });
}
/**
 * The bind arguments that bind a recorded binding again, from the person's own records only (agents.json and the
 * identity), never from the room folder's watch.json, which only `watch` makes trusted: a new session in the room's wake
 * folder (Codex in its own), an approved existing Claude Code session in the folder that was approved (and only while
 * its transcript still says so), a custom command with its command. Undefined when there is nothing to bind again.
 */
function rebindValues(identity: AgentIdentity, record: BoundRecord, agent: BrowserAgent, deps: Pick<AgentDeps, 'sessionFolder'>): Record<string, string> | undefined {
  const wake = wakeDir({ roomDir: agent.dir }), model: Record<string, string> = identity.model ? { '--model': identity.model } : {};
  if (identity.harness === 'exec') return identity.command ? { '--harness': 'exec', '--command': identity.command, '--cwd': wake } : undefined;
  if (!record.session) return undefined;
  let cwd: string | undefined = identity.harness === 'codex' ? undefined : wake;
  if (record.kind === 'existing' && identity.harness === 'claude') {
    if (!record.cwd) return undefined;
    if (deps.sessionFolder('claude', record.session) !== record.cwd)
      throw httpError(409, 'That session\'s folder changed since you approved it, so it was not bound again. Bind it from the Meshrooms page.');
    cwd = record.cwd;
  }
  return { '--harness': identity.harness, '--session': record.session, ...(cwd !== undefined ? { '--cwd': cwd } : {}), ...model };
}
/**
 * Resumes an identity's wakes in a room from the app's Review window: binds the recorded session again (never a new one,
 * so no model runs), which also replaces a watcher that paused or halted itself. A binding the watcher holds (see Hold)
 * resumes only with `confirmHold`, the time of the hold the app showed and the person confirmed: one that changed since
 * (a newer hold) is answered 409 again, with its reason. App-only.
 */
export async function resumeIdentity(roomId: string, key: string, deps: Pick<AgentDeps, 'bind' | 'sessionFolder'>, home = personHome(), confirmHold?: unknown) {
  const { identity, agent } = identityInRoom(home, roomId, key);
  if (roomClosed(agent)) throw httpError(410, 'This room is closed.');
  return withIdentity(identity.id, async () => {
    const current = stillThere(home, identity.id), record = current.bound?.[roomId];
    const values = record && record.state === 'bound' ? rebindValues(current, record, agent, deps) : undefined;
    if (!record || !values) throw httpError(409, `${identity.name} has no binding here to resume. Bind it from the Meshrooms page.`);
    const hold = holdOf(home, current, roomId);
    if (hold && confirmHold !== hold.at) {
      await recordHold(home, identity.id, roomId, hold);
      throw Object.assign(httpError(409, `Waking stopped because ${hold.reason}. Resume anyway?`), { code: 'hold' });
    }
    mkdirSync(wakeDir({ roomDir: agent.dir }), { recursive: true, mode: 0o700 });
    await bindChecked(deps, agent, values);
    const { paused: _, held: __, ...kept } = stillThere(home, identity.id).bound?.[roomId] ?? record;
    await setBound(home, identity, roomId, { ...kept, at: Date.now() });
    logAgents(home, { event: 'resume', identity: identity.id, room: roomId, ...(hold ? { overrode: hold.kind } : {}) });
    return { identityId: identity.id, roomId, wakes: 'on' as const };
  });
}

/** How long after the daemon starts, or after a binding was made, an agent not yet listening counts as starting, not failed. */
export const REVIEW_GRACE_MS = 60_000;
/**
 * One bound agent as the app's Review window and its "agents live" notice show it: `live` (wakes on, in the room, its
 * runner and watcher up and listening), `starting` (a new session starting, or within REVIEW_GRACE_MS of the daemon's
 * start or the binding), `waiting` (for the host to let it in), `paused` (by the person, or by its watcher: an approval
 * wall, say, with the reason), or `failed` (its new session did not start, its runner or watcher is not running, it
 * halted, its wakes went off, or it is no longer in the room). A binding is never left out: one that did not come back
 * is listed as failed. `hold`: what the watcher holds its wakes for; Resume then needs the person's confirmation.
 */
export type ReviewRow = { identityId: string; name: string; harness: HarnessId; roomId: string; memberId: string | null; title: string | null;
  state: 'live' | 'starting' | 'waiting' | 'paused' | 'failed'; reason?: string; hold?: Hold; canPause: boolean; canResume: boolean };
export function agentReview(home = personHome(), now = Date.now(), daemonStartedAt?: number) {
  const rows: ReviewRow[] = [];
  for (const identity of readIdentities(home)) {
    for (const room of identityRooms(home, identity, now)) {
      const b = room.binding, record = identity.bound?.[room.roomId];
      // Only bound agents: one the person unbound (wakes off, no record) or never bound is not listening, by choice.
      if (!record && (b.wakes === 'unbound' || b.wakes === 'off')) continue;
      const settling = now - Math.max(daemonStartedAt ?? 0, record?.at ?? 0) < REVIEW_GRACE_MS;
      const resumable = !!record && record.state === 'bound' && room.state === 'connected' && !!room.memberId;
      const row = (state: ReviewRow['state'], reason?: string): ReviewRow => ({ identityId: identity.id, name: identity.name, harness: identity.harness, roomId: room.roomId,
        memberId: room.memberId, title: room.title, state, ...(reason ? { reason: plainText(pathFree(reason), 300) ?? undefined } : {}), ...(b.hold ? { hold: b.hold } : {}),
        canPause: resumable && !b.hold && (state === 'live' || state === 'starting' || (state === 'paused' && !b.pausedInApp)),
        canResume: resumable && (!!b.hold || state === 'paused' || (state === 'failed' && b.wakes !== 'on')) });
      if (room.state === 'closed') rows.push(row('failed', 'The room was closed.'));
      else if (room.state === 'removed') rows.push(row('failed', 'It was removed from the room.'));
      else if (b.state === 'failed') rows.push(row('failed', b.error ?? 'Its session did not start.'));
      else if (b.state === 'starting') rows.push(row('starting', 'Its new session is starting.'));
      else if (b.hold?.kind === 'halted') rows.push(row('failed', b.hold.pid !== undefined ? `${b.hold.reason} (It is checking process ${b.hold.pid}.)` : b.hold.reason));
      else if (b.hold) rows.push(row('paused', b.hold.reason));
      else if (b.pausedInApp) rows.push(row('paused', 'Paused from the app.'));
      else if (b.wakes === 'paused') rows.push(row('paused', b.why ?? 'Its watcher paused it.'));
      else if (b.wakes === 'halted') rows.push(row('failed', b.why ?? 'Its watcher halted it.'));
      else if (b.wakes === 'off') rows.push(row('failed', b.offReason ? `Wakes are off: ${b.offReason}` : 'Wakes are off.'));
      else if (b.wakes === 'unbound') rows.push(row('failed', 'Its binding is gone.'));
      else if (room.state === 'waiting') rows.push(row('waiting', 'Waiting for the host to let it in.'));
      // Live only once its runner is up and its watcher is alive and listening: before that a mention could pass unnoticed.
      else if (room.runner === 'alive' && b.listening) rows.push(row('live'));
      else if (settling) rows.push(row('starting', room.runner !== 'alive' ? 'Its runner is starting.' : b.watcher !== 'alive' ? 'Its watcher is starting.' : 'It is getting the room\'s history before it listens.'));
      else rows.push(row('failed', room.runner !== 'alive' ? 'Its runner is not running.' : b.watcher !== 'alive' ? 'Its watcher is not running.' : 'It has not started listening.'));
    }
  }
  const live = rows.filter(r => r.state === 'live'), count = (state: ReviewRow['state']) => rows.filter(r => r.state === state).length;
  return { summary: { live: live.length, rooms: new Set(live.map(r => r.roomId)).size, starting: count('starting'), waiting: count('waiting'), paused: count('paused'), failed: count('failed') },
    agents: rows };
}

/**
 * A pending approval. `identity`: an agent asked for an identity (`agent request`). `bind-existing`: the page asked to bind
 * an identity in a room to a session that already has context. Titles and folder labels are capped plain text, for
 * the app's window; nothing here is a path.
 */
export type Approval =
  | { id: string; kind: 'identity'; name: string; harness: HarnessId; model?: string; requestedAt: number; expiresAt: number }
  | { id: string; kind: 'bind-existing'; identityId: string; roomId: string; harness: HarnessId; session: string; title: string | null; folder: string | null;
      /** The full folder the session would be bound to work in (null for Codex, which works in the room's own): shown in the app, part of the digest. */
      cwd: string | null; requestedAt: number; expiresAt: number };
function validApproval(value: unknown, now: number): value is Approval {
  const a = value as Record<string, unknown> | null;
  if (!a || typeof a.id !== 'string' || !UUID.test(a.id) || typeof a.requestedAt !== 'number' || typeof a.expiresAt !== 'number' || a.expiresAt <= now) return false;
  if (!HARNESS_IDS.includes(a.harness as HarnessId)) return false;
  // Exactly the fields of its kind, each checked: anything else in the file (a command, rooms, a folder, tools) makes the
  // entry no request at all, so the app always shows everything an approval would apply.
  const keys = Object.keys(a).sort().join(',');
  const shownText = (v: unknown, limit: number) => v === null || (typeof v === 'string' && plainText(v, limit) === v);
  if (a.kind === 'identity') return (keys === 'expiresAt,harness,id,kind,name,requestedAt' || keys === 'expiresAt,harness,id,kind,model,name,requestedAt')
    && nameProblem(a.name) === undefined && a.harness !== 'exec' && (a.model === undefined || (typeof a.model === 'string' && MODEL.test(a.model)));
  return keys === 'cwd,expiresAt,folder,harness,id,identityId,kind,requestedAt,roomId,session,title' && a.harness !== 'exec' && shownText(a.title, 60) && shownText(a.folder, 40)
    && (a.harness === 'codex' ? a.cwd === null : typeof a.cwd === 'string' && a.cwd.length <= 4_096 && !/[\p{Cc}\p{Cf}]/u.test(a.cwd) && !RENDERS_BLANK.test(a.cwd))
    && a.kind === 'bind-existing' && typeof a.identityId === 'string' && UUID.test(a.identityId) && typeof a.roomId === 'string' && UUID.test(a.roomId)
    && typeof a.session === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(a.session) && (a.title === null || typeof a.title === 'string') && (a.folder === null || typeof a.folder === 'string');
}
/** The approvals still waiting (expired ones are left out). */
export function readApprovals(home = personHome(), now = Date.now()): Approval[] {
  const list = readJson<unknown>(join(home, APPROVALS_FILE), []);
  return Array.isArray(list) ? list.filter(a => validApproval(a, now)) : [];
}
const writeApprovals = (home: string, list: Approval[]) => replaceFile(join(home, APPROVALS_FILE), JSON.stringify(list, null, 2));
type NewApproval = Approval extends infer A ? A extends Approval ? Omit<A, 'id' | 'requestedAt' | 'expiresAt'> : never : never;
/** Files an approval, or returns the same one already waiting (same kind and target), so asking twice files one. */
export async function fileApproval(input: NewApproval, home = personHome(), now = Date.now()) {
  const made = await withAgentsLock(home, () => {
    const list = readApprovals(home, now);
    const same = list.find(a => a.kind === input.kind && (a.kind === 'identity' ? a.name.toLowerCase() === (input as { name: string }).name.toLowerCase()
      : a.identityId === (input as { identityId: string }).identityId && a.roomId === (input as { roomId: string }).roomId && a.session === (input as { session: string }).session));
    if (same) return same;
    if (input.kind === 'identity' && list.filter(a => a.kind === 'identity' && a.harness === input.harness).length >= MAX_REQUESTS_PER_HARNESS)
      throw httpError(429, `${MAX_REQUESTS_PER_HARNESS} requests for ${HARNESS_LABELS[input.harness]} agents are waiting already. The person approves or rejects them in the Meshrooms app first.`);
    if (list.length >= MAX_APPROVALS) throw httpError(429, 'Too many approvals are waiting. Approve or reject some in the Meshrooms app first.');
    const approval = { ...input, id: randomUUID(), requestedAt: now, expiresAt: now + APPROVAL_TTL_MS } as Approval;
    writeApprovals(home, [...list, approval]);
    return approval;
  });
  logAgents(home, { event: 'approval-filed', approval: made.id, kind: made.kind });
  return made;
}
/**
 * `agent request`: an identity an agent (or the person) asks for, which does nothing until the person approves it in the
 * app. It carries a name, a harness (Claude Code, Codex or Hermes: never a custom command) and a model, and nothing
 * else: no command, folder, tools, session or rooms. Approving it makes the identity only; putting it into a room and
 * binding it stay the person's own steps.
 */
export async function requestIdentity(input: { name?: unknown; harness?: unknown; model?: unknown; command?: unknown }, home = personHome()) {
  const fields = checkedInput(input, { command: 'refused' });
  if (nameTaken(readIdentities(home), fields.name)) throw httpError(409, `There is already an agent named ${fields.name}.`);
  return fileApproval({ kind: 'identity', name: fields.name, harness: fields.harness, ...(fields.model ? { model: fields.model } : {}) }, home);
}
/**
 * What the app showed for an approval, as a digest: approving sends it back, so a request changed after it was shown (the
 * file is the user's, and anything of theirs may write it) is never approved as it now stands.
 */
export const approvalDigest = (approval: Approval, labels: ApprovalLabels | Record<string, never> = {}) => {
  const fields: Record<string, unknown> = { ...approval, ...labels };
  return createHash('sha256').update(JSON.stringify(Object.keys(fields).sort().map(key => [key, fields[key]]))).digest('hex');
};
/**
 * What a bind-existing request is shown with besides its own fields, looked up as they are now: its identity's name and
 * the model the bind would run it with (the identity's), and the room's title. They are in its digest too, so a request
 * approved is one whose labels, and the model it applies, are still the ones shown.
 */
export type ApprovalLabels = { identityName: string | null; identityModel: string | null; roomTitle: string | null };
function approvalLabeller(home: string) {
  const identities = new Map(readIdentities(home).map(i => [i.id, i])), titles = new Map<string, string | null>();
  const titleOf = (roomId: string) => {
    if (!titles.has(roomId)) {
      const listed = listedAgents(home).find(r => r.room.roomId === roomId);
      titles.set(roomId, listed ? plainText(listed.agent.members().title, 60) : null);
    }
    return titles.get(roomId) ?? null;
  };
  return (a: Approval): ApprovalLabels | Record<string, never> => a.kind !== 'bind-existing' ? {}
    : { identityName: identities.get(a.identityId)?.name ?? null, identityModel: identities.get(a.identityId)?.model ?? null, roomTitle: titleOf(a.roomId) };
}
/**
 * The folder an existing session would be bound to work in: Claude Code's own (its transcript says, and it resumes only
 * there), Hermes the room's wake folder, Codex none (it always works in the room's). Undefined when it can't be told.
 */
function existingCwd(deps: Pick<AgentDeps, 'sessionFolder'>, harness: HarnessId, session: string, agent: BrowserAgent): string | null | undefined {
  if (harness === 'claude') return deps.sessionFolder('claude', session);
  if (harness === 'hermes') return wakeDir({ roomDir: agent.dir });
  return null;
}
/**
 * Asks to bind an identity in a room to an EXISTING session: never done here, only filed for the app (403 to the page).
 * The session must be one the harness lists now; its title and folder label, and the full folder it would work in, go
 * with the request for the app to show (the page never sees that folder).
 */
export async function requestExistingBinding(roomId: string, key: string, session: { id: string; title: string | null; folder: string | null }, deps: Pick<AgentDeps, 'sessionFolder'>, home = personHome()) {
  const { identity, agent } = identityInRoom(home, roomId, key);
  if (roomClosed(agent)) throw httpError(410, 'This room is closed.');
  if (identity.harness === 'exec') throw httpError(400, 'A custom-command agent has no sessions to bind.');
  const cwd = existingCwd(deps, identity.harness, session.id, agent);
  if (cwd === undefined) throw httpError(409, 'That session\'s folder could not be found, so it can\'t be bound.');
  return fileApproval({ kind: 'bind-existing', identityId: identity.id, roomId, harness: identity.harness, session: session.id, title: session.title, folder: session.folder, cwd }, home);
}
/**
 * The app's answer to an approval. Reject drops it. Approve does what it asked: makes the identity, or binds the existing
 * session (bind, with the session's own folder for Claude Code). An approval whose action fails stays waiting, with
 * the reason returned, so the person can fix the cause or reject it.
 */
export async function decideApproval(id: string, approve: boolean, deps: AgentDeps, home = personHome(), shown?: unknown, detected: (harness: HarnessId) => Promise<boolean> = async () => true) {
  if (!UUID.test(id)) throw httpError(400, 'Use an approval id.');
  const approval = readApprovals(home).find(a => a.id === id);
  if (!approval) throw httpError(404, 'That approval is not waiting any more.');
  const drop = () => withAgentsLock(home, () => writeApprovals(home, readApprovals(home).filter(a => a.id !== id)));
  if (!approve) { await drop(); logAgents(home, { event: 'approval-rejected', approval: id, kind: approval.kind }); return { id, rejected: true }; }
  // The digest covers the request and, for a bind, the labels it was shown with and the model it applies.
  const labels = approvalLabeller(home)(approval);
  if (typeof shown !== 'string' || shown !== approvalDigest(approval, labels)) throw httpError(409, 'This request changed since it was shown, or the approval named no digest. Look at it again before approving.');
  let result: Record<string, unknown>;
  if (approval.kind === 'identity') {
    // Only a harness this machine has: what the app showed is what is made, and nothing more (no room, no binding).
    if (!await detected(approval.harness)) throw httpError(409, `${HARNESS_LABELS[approval.harness]} is not installed on this machine, so this agent was not made.`);
    const identity = await createIdentity({ name: approval.name, harness: approval.harness, ...(approval.model ? { model: approval.model } : {}) }, home, { command: 'refused' });
    result = { identityId: identity.id };
  } else {
    // The same checks as when it was asked: the person still in the room, the agent still theirs.
    const { identity, agent } = identityInRoom(home, approval.roomId, approval.identityId);
    // The folder bound is the one the app showed, and only while the session still says so.
    if (existingCwd(deps, approval.harness, approval.session, agent) !== approval.cwd) throw httpError(409, 'That session\'s folder changed since it was shown, so it was not bound. Reject this and ask again.');
    mkdirSync(wakeDir({ roomDir: agent.dir }), { recursive: true, mode: 0o700 });
    await withIdentity(identity.id, async () => (stillThere(home, identity.id), bindChecked(deps, agent, { '--harness': approval.harness, '--session': approval.session,
      ...(approval.cwd !== null ? { '--cwd': approval.cwd } : {}), ...('identityModel' in labels && labels.identityModel ? { '--model': labels.identityModel } : {}) })));
    await setBound(home, identity, approval.roomId, { kind: 'existing', state: 'bound', session: approval.session, ...(approval.cwd !== null ? { cwd: approval.cwd } : {}), at: Date.now() });
    result = { identityId: identity.id, roomId: approval.roomId, session: approval.session };
  }
  await drop();
  logAgents(home, { event: 'approval-approved', approval: id, kind: approval.kind });
  return { id, approved: true, ...result };
}
/**
 * Approvals as the app's window shows them, each with the digest its approval must send back (approvalDigest). A
 * bind-existing request names its identity and room by id only, so its view also carries their labels as they are now
 * (ApprovalLabels: the identity's name and model, the room's title as capped plain text; null when unknown), which its
 * digest covers too: a request whose labels changed since it was shown is refused like one that changed itself.
 */
export const approvalsView = (home = personHome()) => {
  const label = approvalLabeller(home);
  return readApprovals(home).map(a => {
    const labels = label(a);
    return { ...a, requestedAt: new Date(a.requestedAt).toISOString(), expiresAt: new Date(a.expiresAt).toISOString(), ...labels, digest: approvalDigest(a, labels) };
  });
};

/** Takes agent folders out of the agent registry (agent-homes.json), so the daemon no longer looks after them. */
export function dropAgentHomes(dirs: string[], registry = agentHomesFile()) {
  const homes = knownAgentHomes(registry), gone = new Set(dirs.map(d => resolve(d)));
  if (homes.some(h => gone.has(resolve(h)))) replaceFile(registry, JSON.stringify(homes.filter(h => !gone.has(resolve(h)))));
}
/** Every room folder of every identity, as `{ identity, agent }` (files only). */
export function identityRoomFolders(home = personHome()) {
  return readIdentities(home).flatMap(identity => {
    let ids: string[]; try { ids = readdirSync(join(identityHome(home, identity.id), 'browser-agents')).filter(id => UUID.test(id)); } catch { return []; }
    return ids.flatMap(roomId => { const agent = roomFolderOf(home, identity, roomId); return agent ? [{ identity, agent }] : []; });
  });
}
/** The rooms an identity is still in (not closed, not removed from), by its folder. */
const activeRooms = (home: string, identity: AgentIdentity) => identityRooms(home, identity).filter(r => r.state === 'connected' || r.state === 'waiting');
/** What a stop reported that means a process may still run: then nothing is deleted. */
const notStopped = (outcome: unknown) => {
  const reason = (outcome as { reason?: unknown } | undefined)?.reason;
  return reason === 'busy' || reason === 'unverified' || reason === 'not-stopped' || reason === 'error';
};
/**
 * Deletes an identity. From the page only while it is in no room. From the app (`app`) also when it is. Under the
 * identity's lock (so no put, bind or new session's start runs meanwhile), and in this order, so a failure part way
 * changes as little as it can and can be tried again:
 * 1. every room of it is stopped (wakes off, left alone, its runner stopped); if any runner may still run, nothing else
 *    happens and the answer says so;
 * 2. it leaves the rooms it is in, through the person device (best effort: the room may be gone);
 * 3. its folder (with its keys) is removed, retried while a closing process holds a file;
 * 4. only once the folder is gone is it unlisted, dropped from the agent registry, and its approvals with it.
 */
export async function deleteIdentity(id: unknown, deps: Pick<AgentDeps, 'unbind' | 'stopRoom'>, home = personHome(), options: { app: boolean } = { app: false }) {
  const { id: key } = identityOf(home, id);
  return withIdentity(key, async () => {
    const identity = stillThere(home, key), rooms = activeRooms(home, identity);
    if (rooms.length && !options.app) throw httpError(403, `${identity.name} is in ${rooms.length} room${rooms.length > 1 ? 's' : ''}. Delete it in the Meshrooms app, which takes it out of them too.`);
    const folders = identityRoomFolders(home).filter(f => f.identity.id === identity.id);
    const running: string[] = [];
    for (const { agent } of folders) {
      const outcome = await (deps.stopRoom ? deps.stopRoom(agent) : deps.unbind(agent)).catch(() => ({ reason: 'error' }));
      if (notStopped(outcome)) running.push(agent.roomId);
    }
    if (running.length) throw httpError(409, `${identity.name}'s background process could not be confirmed stopped in ${running.length} room${running.length > 1 ? 's' : ''}, so nothing was deleted. Its wakes are off; try again in a moment.`);
    for (const { agent } of folders) {
      if (!rooms.some(r => r.roomId === agent.roomId)) continue;
      const device = readJson<{ id?: unknown }>(join(agent.dir, 'identity.json'), {}).id;
      const person = listedAgents(home).find(r => r.room.roomId === agent.roomId)?.agent;
      if (person && typeof device === 'string') await person.command('remove', { deviceId: device }).catch(() => {});
    }
    const dir = identityHome(home, identity.id);
    // A process that is still closing may hold a file for a moment (Windows): the folder goes once it lets go.
    for (let i = 0; existsSync(dir); i++) {
      try { rmSync(dir, { recursive: true, force: true }); }
      catch { if (i >= 40) throw httpError(409, `${identity.name}'s folder could not be removed yet, so it is still listed. Try again in a moment.`); await Bun.sleep(250); }
    }
    await withAgentsLock(home, () => {
      writeIdentities(home, readIdentities(home).filter(i => i.id !== identity.id));
      writeApprovals(home, readApprovals(home).filter(a => a.kind !== 'bind-existing' || a.identityId !== identity.id));
      dropAgentHomes([dir]);
    });
    logAgents(home, { event: 'identity-deleted', identity: identity.id, rooms: rooms.length });
    return { id: identity.id, deleted: true, leftRooms: rooms.length };
  });
}
/** Rooms where an identity's new session is starting now (as agents.json says, so the CLI sees it too): unpair waits for them. */
export function startingSessions(home = personHome(), now = Date.now()) {
  return readIdentities(home).flatMap(identity => Object.entries(identity.bound ?? {})
    .filter(([, record]) => record.state === 'starting' && now - record.at <= BOOTSTRAP_STALE_MS).map(([roomId]) => ({ identityId: identity.id, roomId })));
}
