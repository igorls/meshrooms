/**
 * The machine's agent daemon (`meshrooms daemon`): one process per OS user that keeps every agent on the machine
 * connected. For every agent folder in the registry (agent-homes.json) and every room in it, it keeps the room's runner
 * alive, and for every room whose binding (watch.json) is on, it keeps the room's watcher (`watch-run`) alive. Both stay
 * the separate, detached processes they always were: the daemon only starts, watches and replaces them, so a daemon that
 * restarts adopts what runs rather than cutting presence or a wake short.
 *
 * While it runs it is their single owner: commands and watchers that would start or replace a runner or a watcher defer
 * to it (runnerOwner). Every start and stop still goes through the room's runner lock or watch lock and the same checks
 * as before (repairRunner, sameRun, killTree), so it never adds a second runner or watcher beside a live one.
 *
 * This file holds what doesn't touch processes: the supervisor's decisions (with injected deps), the daemon's files,
 * bounded logs and bindings. agent-cli.ts wires the real processes in.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, truncateSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { agentHomesFile, knownAgentHomes, WATCH_CONFIG, type WatchConfig } from './agent-watch';
import { replaceFile } from './browser-agent';
import { terminalSafe } from './terminal-text';

/** Files in the daemon's folder (daemonDir). */
export const DAEMON_RECORD = 'daemon.json', DAEMON_LOCK = 'daemon.lock', DAEMON_LOG = 'daemon.log', DAEMON_OUT = 'daemon.out.log';
/** Files in a room's folder: the runner's and the watcher's stderr, and the marker `stop` leaves. */
export const RUNNER_LOG = 'runner.log', WATCHER_LOG = 'watcher.log', ROOM_STOPPED = 'stopped.json',
  /** Written when the daemon lets a room go (closed, or the agent removed): kept until a new connect rewrites room.json. */
  ROOM_RETIRED = 'retired.json';
/** Each log is kept under this size, plus one older copy (`<log>.1`). */
export const LOG_LIMIT = 1_000_000;

/**
 * The daemon's folder: ~/.meshrooms/daemon, beside the registry it reads, so a test that moves the registry
 * (MESHROOMS_AGENT_REGISTRY) never sees or writes the real daemon's files. MESHROOMS_DAEMON_DIR overrides it.
 */
export function daemonDir(env: Record<string, string | undefined> = process.env, home = homedir()) {
  return env.MESHROOMS_DAEMON_DIR ? resolve(env.MESHROOMS_DAEMON_DIR) : join(dirname(agentHomesFile(home, env)), 'daemon');
}

/** The folder of the session ledgers (sessionLedger): beside the daemon's, in ~/.meshrooms, which no wake can write. */
export const locksDir = (env: Record<string, string | undefined> = process.env, home = homedir()) => join(dirname(daemonDir(env, home)), 'locks');
/**
 * Keeps a log under `limit`: once past it, its contents move to `<path>.1` (replacing the older copy) and it starts
 * empty. Copied and then emptied rather than renamed, so a process that holds it open as its stderr, in append mode,
 * keeps writing to it, at its new end, on Windows too. A link at either path is removed, never followed.
 */
export function rotateLog(path: string, limit = LOG_LIMIT) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) { unlinkSync(path); return false; }
    if (stat.size <= limit) return false;
    try { if (!lstatSync(`${path}.1`).isFile()) unlinkSync(`${path}.1`); } catch { /* Not there yet. */ }
    copyFileSync(path, `${path}.1`);
    truncateSync(path, 0);
    return true;
  } catch { return false; }
}
/** Opens a log to append to, as the stdout and stderr of a process about to start; the caller closes it after the spawn. */
export function openProcessLog(path: string, limit = LOG_LIMIT) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rotateLog(path, limit);
  return openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
}
/** Runs `spawn` with a fresh descriptor for `path` and closes this process's copy afterwards: the child keeps its own. */
export function withProcessLog<T>(path: string, spawn: (fd: number | 'ignore') => T): T {
  let fd: number | undefined;
  try { fd = openProcessLog(path); } catch { /* A log that can't be opened must never keep the process from starting. */ }
  try { return spawn(fd ?? 'ignore'); } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* Already closed. */ } }
}

/**
 * Bun loads `.env` files from the folder it starts in into process.env. A command run in a project folder whose `.env`
 * someone else wrote must not hand those values to the long-lived processes it starts (a MESHROOMS_BIN_DIR there would
 * make them run another launcher). Every bridge process is started with --no-env-file and from a folder of its own, and
 * with this environment: the caller's, without any MESHROOMS_* override and without the values a `.env` file in `cwd`
 * put there (a variable the shell already had keeps its value, as Bun keeps it), plus `extra`, which the caller sets
 * explicitly (the daemon sets MESHROOMS_AGENT_HOME for each room).
 */
export const BUN_NO_ENV_FILE = '--no-env-file';
export function bridgeEnv(extra: Record<string, string> = {}, env: Record<string, string | undefined> = process.env, cwd = process.cwd()): Record<string, string> {
  const loaded = dotenvValues(cwd), out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || /^MESHROOMS_/i.test(key) || (loaded.has(key) && loaded.get(key) === value)) continue;
    out[key] = value;
  }
  return { ...out, ...extra };
}
/** The variables the `.env` files Bun autoloads from `cwd` set (.env, .env.local and .env.<NODE_ENV>, with .local). */
export function dotenvValues(cwd: string, mode = process.env.NODE_ENV ?? 'development') {
  const values = new Map<string, string>();
  for (const name of ['.env', `.env.${mode}`, '.env.local', `.env.${mode}.local`]) {
    let text: string; try { text = readFileSync(join(cwd, name), 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      const raw = match[2], quoted = /^(['"`])(.*)\1$/.exec(raw);
      values.set(match[1], quoted ? quoted[2] : raw.replace(/\s+#.*$/, ''));
    }
  }
  return values;
}

/** Why a binding is off when no one turned it off: written by the daemon's one-time migration of an older watch.json. */
export const LEGACY_OFF = 'from an earlier watch; run watch again to turn on';
/** Why a binding is off although watch.json says on: it changed after `watch` authorised it. */
export const UNTRUSTED_OFF = 'changed outside watch; run watch again';
/**
 * Where `watch` records each binding it authorises: in the daemon's own folder, never in the room folder,
 * one file per room folder holding a digest of the whole binding. No wake can read or write there (it is in
 * ~/.meshrooms, which wakes may not read, and it isn't one of the folders a Codex wake may write).
 */
export const BINDING_RECORDS = 'bindings';
const foldDir = (dir: string) => process.platform === 'win32' ? resolve(dir).toLowerCase() : resolve(dir);
const bindingRecordPath = (roomDir: string, trustDir: string) =>
  join(trustDir, BINDING_RECORDS, `${createHash('sha256').update(foldDir(roomDir)).digest('hex').slice(0, 32)}.json`);
/** A digest of everything in a binding but whether it is on: the harness, its program, its command, session, folder, tools, caps. */
export function bindingDigest(config: Record<string, unknown>) {
  const { enabled: _, offReason: __, ...rest } = config;
  const canonical = JSON.stringify(Object.keys(rest).sort().map(key => [key, rest[key]]));
  return createHash('sha256').update(canonical).digest('hex');
}
/** Records that the operator authorised this binding (only `watch` does). */
export function authorizeBinding(roomDir: string, config: Record<string, unknown>, trustDir = daemonDir()) {
  mkdirSync(join(trustDir, BINDING_RECORDS), { recursive: true, mode: 0o700 });
  replaceFile(bindingRecordPath(roomDir, trustDir), JSON.stringify({ roomDir: resolve(roomDir), digest: bindingDigest(config), at: Date.now() }));
}
/**
 * A room's binding, as the daemon and the watcher both read it (one parser, so they never disagree): its watch.json,
 * whether wakes are on, and a stamp of everything else in it (a change restarts the watcher). Wakes are on only when
 * the file says `enabled: true` and it is exactly what `watch` authorised (authorizeBinding): fail closed.
 * A file changed outside it, a command or program planted in it say, stays off as `untrusted`. A file from before
 * `enabled` (`legacy`) is off until the daemon migrates it (see migrateLegacyBinding). `config`: the file as read, which
 * is what a watcher runs.
 */
export type Binding = { enabled: boolean; stamp: string; legacy?: boolean; untrusted?: boolean; offReason?: string; harness?: string; session?: string;
  config: WatchConfig };
export function readBinding(roomDir: string, trustDir = daemonDir()): Binding | undefined {
  let config: Record<string, unknown>;
  try { config = JSON.parse(readFileSync(join(roomDir, WATCH_CONFIG), 'utf8')); } catch { return undefined; }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return undefined;
  const digest = bindingDigest(config), { enabled, offReason } = config;
  let record: { roomDir?: unknown; digest?: unknown } | undefined;
  try { record = JSON.parse(readFileSync(bindingRecordPath(roomDir, trustDir), 'utf8')); } catch { /* Never authorised. */ }
  const trusted = record?.digest === digest && typeof record.roomDir === 'string' && foldDir(record.roomDir) === foldDir(roomDir);
  return { enabled: enabled === true && trusted, stamp: digest.slice(0, 16), config: config as WatchConfig,
    ...(enabled === undefined ? { legacy: true } : {}),
    ...(enabled === true && !trusted ? { untrusted: true, offReason: UNTRUSTED_OFF } : enabled !== true && typeof offReason === 'string' ? { offReason } : {}),
    ...(typeof config.harness === 'string' ? { harness: config.harness } : {}), ...(typeof config.session === 'string' ? { session: config.session } : {}) };
}
/**
 * Why a watcher running the binding stamped `stamp` must stop, if it must: its binding is off (turned off, untrusted)
 * or no longer the one it runs. The watcher asks before every wake, by the same reading as the daemon (readBinding).
 */
export function bindingFence(roomDir: string, stamp: string, trustDir = daemonDir()) {
  return (): string | undefined => {
    const now = readBinding(roomDir, trustDir);
    return !now?.enabled ? `wakes are off${now?.offReason ? ` (${now.offReason})` : ''}` : now.stamp !== stamp ? 'the binding changed' : undefined;
  };
}
/**
 * Turns wakes off in watch.json, keeping the rest, and revokes what `watch` authorised (authorizeBinding), so someone
 * who can edit watch.json but not the daemon's folder can't turn wakes back on by flipping `enabled`. False when there
 * is no binding to change. Only `watch` turns wakes on.
 */
export function disableBinding(roomDir: string, offReason?: string, trustDir = daemonDir()) {
  const path = join(roomDir, WATCH_CONFIG);
  let config: Record<string, unknown> | undefined;
  try { config = JSON.parse(readFileSync(path, 'utf8')); } catch { /* No binding; a record of one is still revoked. */ }
  if (!config || typeof config !== 'object' || Array.isArray(config)) config = undefined;
  else if (config.enabled !== false || config.offReason !== offReason) {
    const { offReason: _, ...rest } = config;
    replaceFile(path, JSON.stringify({ ...rest, enabled: false, ...(offReason ? { offReason } : {}) }, null, 2));
  }
  rmSync(bindingRecordPath(roomDir, trustDir), { force: true });
  return !!config;
}
/**
 * The one-time migration of a watch.json from before `enabled`: turned off with LEGACY_OFF, whether or not its watcher
 * still runs. No earlier bridge recorded what its operator authorised, so its file can't be told apart from one someone
 * else wrote. The daemon then stops a watcher that runs it, and the operator runs `watch` again to turn wakes back on.
 */
export function migrateLegacyBinding(roomDir: string, trustDir = daemonDir()): 'off' | undefined {
  let config: Record<string, unknown>;
  try { config = JSON.parse(readFileSync(join(roomDir, WATCH_CONFIG), 'utf8')); } catch { return undefined; }
  if (!config || typeof config !== 'object' || config.enabled !== undefined) return undefined;
  return disableBinding(roomDir, LEGACY_OFF, trustDir) ? 'off' : undefined;
}


export const DAEMON_TIMING = {
  /** How often every room is looked at: only its files, which is cheap. */
  tickMs: 2_000,
  /** How often a room's runner and watcher are looked up as processes (slow on Windows: one PowerShell each). */
  fullCheckMs: 60_000,
  /** At most this many of those unhurried lookups per tick, so many rooms don't stall one tick. */
  lookupsPerTick: 2,
  /** A runner whose proof says it stopped or is stuck is looked into at once, then at most this often until that is fixed. */
  troubleRecheckMs: 20_000,
  /** A process that ran this long before it exited counts as having worked: its restart backoff starts over. */
  stableMs: 120_000,
  /** The first restart after a failure waits this long, doubling with each failure in a row up to restartMaxMs. */
  restartBaseMs: 2_000, restartMaxMs: 5 * 60_000,
  /** The room service must say this long that the agent is no longer in the room before the daemon lets the room go. */
  removedGraceMs: 60_000,
};
export type DaemonTiming = typeof DAEMON_TIMING;
/** How long to wait before starting a process again after `failures` failures in a row. */
export const restartDelay = (failures: number, timing: Pick<DaemonTiming, 'restartBaseMs' | 'restartMaxMs'> = DAEMON_TIMING) =>
  Math.min(timing.restartMaxMs, timing.restartBaseMs * 2 ** Math.max(0, failures - 1));

export type RoomRef = { home: string; roomId: string; dir: string };
/** A process the daemon started and still holds: `exit` is filled in when it ends, so no process lookup is needed. */
export type Handle = { pid: number; exit?: { at: number; code: number | null; signal?: string | null } };
/** What a room's files say, read every tick (no process lookups). */
export type RoomLook = {
  /** Changes when room.json is written again: a new connect brings a room the daemon let go back. */
  stamp: string;
  closed?: { at: number; reason: string };
  /** The runner has heard since then that the agent is no longer in the room (only from a runner started since `since`). */
  removedSince?: number;
  /** `stop` stopped the room: the daemon leaves it alone until a command uses it again. */
  stopped: boolean;
  /** The daemon let the room go before (retired.json for this same room.json), so a restarted daemon never brings it back. */
  retired?: { state: 'closed' | 'removed'; reason: string };
  /** The runner's proof of life says it stopped or is stuck (runnerTrouble), counted from `since`. */
  trouble?: 'stopped' | 'stuck';
  binding?: Omit<Binding, 'config'>;
};
export type RepairOutcome = { outcome: string; pid?: number };
/** Thrown by a start that found, under its lock, that the room no longer wants the process (stopped or closed meanwhile). */
export class StartSkipped extends Error {}
/** What the supervisor needs from the world; agent-cli.ts wires the real files and processes, tests wire fakes. */
export type SupervisorDeps = {
  now(): number;
  homes(): string[];
  rooms(home: string): RoomRef[];
  look(room: RoomRef, since: number): RoomLook;
  /** repairRunner for the room, with the daemon as the owner; `onStart` receives a runner it starts. */
  repairRunner(room: RoomRef, broken: boolean, onStart: (handle: Handle) => void): Promise<RepairOutcome>;
  /** Stops the room's runner (only one its command line proves), under the runner lock. */
  stopRunner(room: RoomRef): Promise<boolean>;
  /** Records that the room was let go (retired.json), tied to the room.json it was let go with. */
  retire(room: RoomRef, record: { state: 'closed' | 'removed'; reason: string; stamp: string }): void;
  /** Migrates a watch.json from before `enabled` once (migrateLegacyBinding, under the watch lock). */
  migrateBinding(room: RoomRef): 'off' | undefined;
  /**
   * The live watcher's pid, by a process lookup; 'unknown' when the process its pid file names lives but the lookup
   * couldn't say what it is (it timed out, say), so the daemon starts no second watcher on a guess.
   */
  findWatcher(room: RoomRef): number | 'unknown' | undefined;
  /**
   * Under the watch lock: adopts a watcher that runs, or starts one if the binding is still on. Undefined when the binding
   * went off meanwhile or another process holds the lock.
   */
  startWatcher(room: RoomRef): Promise<{ pid: number; handle?: Handle; stamp?: string } | undefined>;
  stopWatcher(room: RoomRef, pid: number, handle?: Handle): Promise<void>;
  rotateLogs(room: RoomRef): void;
  log(line: string): void;
  /** The daemon's heartbeat, with what it supervises; written after every room, so a slow tick never looks like a dead daemon. */
  heartbeat(rooms: DaemonRoom[]): void;
};

export type RoomState = 'starting' | 'supervised' | 'stopped' | 'closed' | 'removed';
type Proc = {
  pid?: number; handle?: Handle; startedAt?: number; seen?: boolean;
  /** Failures in a row (exits before stableMs, failed starts), and the restarts this daemon made. */
  failures: number; restarts: number; lastRestartAt?: number; backoffUntil?: number;
  lastExit?: { at: number; code: number | null; signal?: string | null; ranMs?: number };
  /** The binding the watcher was started with; a watcher that runs another one is restarted. */
  stamp?: string; lookedAt?: number;
  /** The last lookup couldn't tell whether a watcher runs: none is started until one can. */
  unsure?: boolean;
  /** It ended (or must be replaced): start it again as soon as its backoff allows, without waiting for the next look. */
  restartDue?: boolean;
};
type Supervised = { ref: RoomRef; state: RoomState; reason?: string; dropStamp?: string; since: number; lastFull: number; runner: Proc; watcher: Proc;
  wakes: DaemonRoom['watcher']['wakes'] };
export type ProcStatus = { pid: number | null; restarts: number; lastRestartAt: string | null; lastExit: { at: string; code: number | null; signal?: string | null; ranSeconds?: number } | null;
  nextStartAt: string | null; log: string };
/** One room as `daemon status` reports it. */
export type DaemonRoom = { roomId: string; home: string; state: RoomState; reason?: string; runner: ProcStatus; watcher: ProcStatus & { wakes: 'on' | 'off' | 'unbound' } };

const iso = (at: number | undefined) => at === undefined ? null : new Date(at).toISOString();
const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;
const foldKey = (dir: string) => process.platform === 'win32' ? resolve(dir).toLowerCase() : resolve(dir);

/**
 * The supervisor. Each tick looks at every room's files; a room's runner gets a full check (repairRunner, with its
 * process lookups) when its proof of life says it stopped or is stuck, when a runner the daemon holds exited, when the
 * room is new, and otherwise once every fullCheckMs. A process that keeps exiting is started again with a backoff that
 * doubles up to restartMaxMs, and every restart is recorded in the status. A closed room, or one whose agent was removed,
 * is let go and reported, never restarted; a room `stop` stopped is left alone until a command uses it again.
 */
export function createSupervisor(deps: SupervisorDeps, timing: DaemonTiming = DAEMON_TIMING) {
  const rooms = new Map<string, Supervised>();
  const proc = (): Proc => ({ failures: 0, restarts: 0 });
  // Reasons the room service gave (a closed room's) and error messages go into the log as they came: one line each, and
  // nothing in them can steer the terminal it is read in.
  const log = (line: string) => deps.log(terminalSafe(line).replace(/[\n\u2028\u2029]+/g, ' '));
  const say = (room: Supervised, line: string) => log(`room ${room.ref.roomId}: ${line}`);
  /** A process it held ended: recorded, and its next start put off by the backoff. */
  const ended = (room: Supervised, what: 'runner' | 'watcher', p: Proc) => {
    const exit = p.handle!.exit!, ranMs = p.startedAt === undefined ? undefined : Math.max(0, exit.at - p.startedAt);
    p.failures = ranMs !== undefined && ranMs >= timing.stableMs ? 1 : p.failures + 1;
    p.backoffUntil = exit.at + restartDelay(p.failures, timing);
    p.lastExit = { ...exit, ...(ranMs !== undefined ? { ranMs } : {}) };
    say(room, `the ${what} (pid ${p.handle!.pid}) exited (${exit.code ?? exit.signal ?? 'unknown'}) after ${seconds(ranMs ?? 0)}; `
      + `the next start waits until ${new Date(p.backoffUntil).toISOString()}`);
    p.handle = undefined; p.pid = undefined; p.restartDue = true;
  };
  const failed = (room: Supervised, what: string, p: Proc, error: unknown, now: number) => {
    p.failures++; p.backoffUntil = now + restartDelay(p.failures, timing); p.restartDue = true;
    say(room, `couldn't start the ${what}: ${error instanceof Error ? error.message : String(error)}; trying again after ${seconds(p.backoffUntil - now)}`);
  };
  /** Forgets the processes of a room it lets go or that `stop` stopped, without counting their end as a failure. */
  const forget = (p: Proc) => { p.handle = undefined; p.pid = undefined; p.stamp = undefined; p.lookedAt = undefined; p.unsure = undefined; p.failures = 0; p.backoffUntil = undefined; p.restartDue = false; };
  async function stopWatcherOf(room: Supervised, look: RoomLook) {
    const p = room.watcher, found = p.handle?.pid ?? p.pid ?? (look.binding ? deps.findWatcher(room.ref) : undefined), pid = found === 'unknown' ? undefined : found;
    if (pid !== undefined) { await deps.stopWatcher(room.ref, pid, p.handle); say(room, `stopped the watcher (pid ${pid})`); }
    forget(p);
  }
  async function letGo(room: Supervised, state: 'closed' | 'removed', reason: string, look: RoomLook) {
    if (room.state === state) return;
    room.state = state; room.reason = reason; room.dropStamp = look.stamp;
    say(room, `${reason}: no longer kept running`);
    try { deps.retire(room.ref, { state, reason, stamp: look.stamp }); } catch (error) { say(room, `couldn't record that: ${error instanceof Error ? error.message : String(error)}`); }
    await stopWatcherOf(room, look);
    // A closed room's runner has stopped by itself; a removed agent's runner would poll a room that won't have it forever.
    if (state === 'removed' && !await deps.stopRunner(room.ref)) say(room, "the runner couldn't be confirmed and stopped; it is left as it is");
    forget(room.runner);
  }

  async function runner(room: Supervised, look: RoomLook, now: number, lookup: () => boolean) {
    const p = room.runner;
    if (p.handle?.exit) ended(room, 'runner', p);
    // A proof that says stopped or stuck is looked into at once, but not again before troubleRecheckMs: a repair that
    // couldn't be done (repairRunner's own backoff, a runner it can't confirm) mustn't be retried every tick.
    const urgent = room.lastFull === 0 || !!p.restartDue || (look.trouble !== undefined && now - room.lastFull >= timing.troubleRecheckMs);
    if (p.backoffUntil !== undefined && now < p.backoffUntil) return;
    if (!urgent && !(now - room.lastFull >= timing.fullCheckMs && lookup())) return;
    room.lastFull = now; p.restartDue = false; p.backoffUntil = undefined;
    try {
      const repair = await deps.repairRunner(room.ref, look.trouble !== undefined, handle => {
        p.handle = handle; p.pid = handle.pid; p.startedAt = deps.now(); room.since = p.startedAt;
      });
      if (['started', 'restarted', 'replaced'].includes(repair.outcome)) {
        if (p.seen) { p.restarts++; p.lastRestartAt = now; }
        say(room, `${repair.outcome === 'started' ? 'started' : 'replaced'} the runner (pid ${repair.pid ?? 'unknown'})`);
      } else if (repair.outcome === 'kept' && repair.pid !== undefined && p.handle?.pid !== repair.pid) {
        // A runner something else started (before the daemon, or a bridge from before it): adopted, never replaced for that.
        p.handle = undefined; p.pid = repair.pid;
      } else if (!['kept', 'started', 'restarted', 'replaced'].includes(repair.outcome)) {
        // Needed a repair it couldn't make now (repairRunner logged why): looked at again at the unhurried pace.
        p.backoffUntil = now + (repair.outcome === 'busy' ? restartDelay(1, timing) : timing.fullCheckMs);
      }
      p.seen = true;
    } catch (error) {
      if (error instanceof StartSkipped) return;
      failed(room, 'runner', p, error, now);
    }
  }

  async function watcher(room: Supervised, look: RoomLook, now: number, lookup: () => boolean) {
    const p = room.watcher, binding = look.binding, want = !!binding?.enabled;
    if (p.handle?.exit) ended(room, 'watcher', p);
    // A watcher it didn't start (adopted) is known only by a lookup: looked at once, then at the unhurried pace (sooner
    // after a lookup that couldn't tell).
    if (!p.handle && binding && (p.lookedAt === undefined || (now - p.lookedAt >= (p.unsure ? timing.troubleRecheckMs : timing.fullCheckMs) && lookup()))) {
      const before = p.pid, found = deps.findWatcher(room.ref);
      p.lookedAt = now;
      if (found === 'unknown') {
        if (!p.unsure && want) say(room, "couldn't tell whether the watcher runs (the process lookup failed): no watcher is started until it can");
        p.unsure = true;
      } else {
        p.unsure = false; p.pid = found;
        if (p.pid !== undefined && p.pid !== before) { p.stamp = binding.stamp; p.seen = true; }
      }
    }
    const alive = !!p.handle || p.pid !== undefined;
    if (!want) {
      if (alive) { const pid = (p.handle?.pid ?? p.pid)!; await deps.stopWatcher(room.ref, pid, p.handle); say(room, `wakes are off: the watcher (pid ${pid}) is stopped`); }
      forget(p);
      return;
    }
    if (alive) {
      if (p.stamp === binding!.stamp) return;
      say(room, 'the binding changed: restarting the watcher');
      await deps.stopWatcher(room.ref, (p.handle?.pid ?? p.pid)!, p.handle);
      p.handle = undefined; p.pid = undefined; p.backoffUntil = undefined;
    }
    if (p.unsure || (p.backoffUntil !== undefined && now < p.backoffUntil)) return;
    try {
      const started = await deps.startWatcher(room.ref);
      if (!started) return;
      p.pid = started.pid; p.stamp = started.stamp ?? binding!.stamp; p.lookedAt = now;
      if (!started.handle) { p.handle = undefined; p.seen = true; return; }
      p.handle = started.handle; p.startedAt = deps.now();
      if (p.seen) { p.restarts++; p.lastRestartAt = now; }
      p.seen = true;
      say(room, `started the watcher (pid ${started.pid})`);
    } catch (error) {
      if (error instanceof StartSkipped) return;
      failed(room, 'watcher', p, error, now);
    }
  }

  async function supervise(room: Supervised, lookup: () => boolean) {
    const now = deps.now();
    let look = deps.look(room.ref, room.since);
    if (look.binding?.legacy) {
      // A binding from before `enabled`: decided once, failing closed (see migrateLegacyBinding).
      const migrated = deps.migrateBinding(room.ref);
      if (migrated) say(room, `a binding from an earlier watch: wakes off (${LEGACY_OFF})`);
      look = deps.look(room.ref, room.since);
    }
    room.wakes = !look.binding ? 'unbound' : look.binding.enabled ? 'on' : 'off';
    const dropped = room.state === 'closed' || room.state === 'removed';
    if (dropped && look.stamp !== room.dropStamp && !look.closed) {
      say(room, 'connected again: supervising it again');
      room.state = 'starting'; room.reason = undefined; room.since = now; room.lastFull = 0;
    }
    if (look.closed) return letGo(room, 'closed', `the room is closed (${look.closed.reason})`, look);
    if (look.removedSince !== undefined && now - look.removedSince >= timing.removedGraceMs) return letGo(room, 'removed', 'the agent was removed from the room', look);
    if (look.retired && room.state !== look.retired.state) {
      // Let go by an earlier daemon: stays let go, with nothing started, until a new connect.
      room.state = look.retired.state; room.reason = look.retired.reason; room.dropStamp = look.stamp;
      say(room, `${look.retired.reason} (recorded earlier): not started`);
      forget(room.runner); forget(room.watcher);
    }
    if (room.state === 'closed' || room.state === 'removed') return;
    if (look.stopped) {
      if (room.state !== 'stopped') { say(room, 'stopped by its operator (stop): left alone until a command uses the room again'); forget(room.runner); forget(room.watcher); }
      room.state = 'stopped'; return;
    }
    if (room.state === 'stopped') { say(room, 'in use again: supervising it again'); room.since = now; room.lastFull = 0; }
    room.state = 'supervised';
    await runner(room, look, now, lookup);
    await watcher(room, look, now, lookup);
  }

  const procStatus = (p: Proc, log: string): ProcStatus => ({ pid: p.handle?.pid ?? p.pid ?? null, restarts: p.restarts, lastRestartAt: iso(p.lastRestartAt),
    lastExit: p.lastExit ? { at: iso(p.lastExit.at)!, code: p.lastExit.code, ...(p.lastExit.signal ? { signal: p.lastExit.signal } : {}),
      ...(p.lastExit.ranMs !== undefined ? { ranSeconds: Math.round(p.lastExit.ranMs / 1000) } : {}) } : null,
    nextStartAt: p.backoffUntil !== undefined && p.backoffUntil > deps.now() ? iso(p.backoffUntil) : null, log });
  const status = (): DaemonRoom[] => [...rooms.values()].map(room => ({ roomId: room.ref.roomId, home: room.ref.home, state: room.state, ...(room.reason ? { reason: room.reason } : {}),
    runner: procStatus(room.runner, join(room.ref.dir, RUNNER_LOG)),
    watcher: { ...procStatus(room.watcher, join(room.ref.dir, WATCHER_LOG)), wakes: room.wakes } }));

  return {
    status,
    async tick() {
      const seen = new Set<string>();
      for (const home of deps.homes()) for (const ref of deps.rooms(home)) {
        const key = foldKey(ref.dir);
        if (seen.has(key)) continue;
        seen.add(key);
        if (!rooms.has(key)) { rooms.set(key, { ref, state: 'starting', since: deps.now(), lastFull: 0, runner: proc(), watcher: proc(), wakes: 'unbound' }); log(`room ${ref.roomId}: supervising it (agent folder ${ref.home})`); }
      }
      for (const [key, room] of rooms) if (!seen.has(key)) { rooms.delete(key); say(room, 'its folder or agent folder is gone: no longer supervised'); }
      let lookups = timing.lookupsPerTick;
      const lookup = () => lookups-- > 0;
      // The room checked longest ago goes first, so a slow tick still comes round to every room.
      for (const room of [...rooms.values()].sort((a, b) => a.lastFull - b.lastFull)) {
        try { await supervise(room, lookup); } catch (error) { say(room, error instanceof Error ? error.message : String(error)); }
        try { deps.rotateLogs(room.ref); } catch { /* Logs never stop supervision. */ }
        deps.heartbeat(status());
      }
      deps.heartbeat(status());
    },
  };
}

/** What the daemon writes to daemon.json: who it is, its heartbeat (`at`), the registry it reads, and what it supervises. */
export type DaemonRecord = { pid: number; startedAt: number; at: number; version: string; registry: string; homes?: string[]; script?: string; stoppedAt?: number; rooms: DaemonRoom[] };
export function readDaemonRecord(dir = daemonDir()): DaemonRecord | undefined {
  try { const record = JSON.parse(readFileSync(join(dir, DAEMON_RECORD), 'utf8')); return record && typeof record === 'object' ? record : undefined; } catch { return undefined; }
}
export function writeDaemonRecord(dir: string, record: DaemonRecord) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  replaceFile(join(dir, DAEMON_RECORD), JSON.stringify(record));
}
/**
 * The daemon counts as running while its process lives and its heartbeat is this recent. Generous on purpose: a tick
 * that inspects or starts processes can take tens of seconds on Windows, and a daemon taken for gone would let a command
 * start a runner beside it (the runner lock still keeps that to one at a time).
 */
export const DAEMON_ALIVE_MS = 60_000;
/** The running daemon's record, or undefined: no process lookup, only its pid and its heartbeat, so every command can afford it. */
export function runningDaemon(alive: (pid: number) => boolean, dir = daemonDir(), now = Date.now()): DaemonRecord | undefined {
  const record = readDaemonRecord(dir);
  if (!record || record.stoppedAt !== undefined || !Number.isSafeInteger(record.pid) || typeof record.at !== 'number' || now - record.at >= DAEMON_ALIVE_MS) return undefined;
  return alive(record.pid) ? record : undefined;
}
/**
 * Whether a running daemon looks after this agent folder: one it named as looked after, or one in the registry it reads,
 * where `connect` and `watch` record their folder before they rely on this, so a room connected a moment ago is the
 * daemon's too.
 */
export function daemonSupervises(agentHome: string, alive: (pid: number) => boolean, dir = daemonDir(), now = Date.now()) {
  const record = runningDaemon(alive, dir, now);
  if (!record || typeof record.registry !== 'string') return false;
  const home = foldKey(agentHome);
  return [...(Array.isArray(record.homes) ? record.homes : []), ...knownAgentHomes(record.registry)].some(known => typeof known === 'string' && foldKey(known) === home);
}
