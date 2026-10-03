/**
 * Live attachment: an agent's own interactive session waits for the room with `listen --until-addressed`, run as a
 * background command. It blocks at no turn cost and returns only when there is work; a harness that re-invokes the
 * session when a background command exits (Claude Code does) then wakes the operator's own session, in the operator's
 * own window, with no second process resuming the transcript beside it.
 *
 * One mailbox has one consumer at a time. The room folder's `live.json` says who it is:
 * - `attached`: a live listener is waiting. It refreshes `heartbeat` every few seconds and names its process by pid and
 *   start time (processInfo), so it is told apart from a process that later gets its pid (sameRun).
 * - `pickup`: the listener returned work at `returnedAt`. The live session is expected to handle it and listen again
 *   before `pickupUntil` (the grace window).
 * - `headless`: the watcher is running a headless wake (its own pid, and the run's once it starts).
 * The watcher never wakes a headless run while a lease is attached or in its pickup window; a listener never attaches
 * while a headless wake runs. Both decide under `live.lock`, so the check and the write are one step. Only a stale lease
 * (no heartbeat, or a process that is gone) or an expired pickup window lets the headless fallback run again.
 *
 * `live.json` sits in the room folder itself, not in the folders a wake may write: a wake can't forge a lease to keep the
 * watcher quiet.
 */
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { replaceFile } from './browser-agent';

export const LIVE_LEASE = 'live.json', LIVE_LOCK = 'live.lock';
/**
 * When the agent's last listen outside a wake reported headless runs (see wokenRuns). In the room folder itself, like
 * the lease: a wake that could move it forward would hide its own replies from the live session.
 */
export const WOKEN_SEEN = 'woken-seen.json';
/** Every file of live attachment: all in the room folder's root, none in a folder a wake may write. */
export const LIVE_FILES = [LIVE_LEASE, LIVE_LOCK, WOKEN_SEEN] as const;
/**
 * heartbeatMs: how often a live listener refreshes its lease. staleMs: a lease whose heartbeat is older is stale (a
 * process verified to still be the listener gets one more staleMs, for a machine waking from sleep). sliceSeconds: one
 * internal listen; the process doesn't return between them. runnerTroubleMs: how long a runner that stopped may take
 * to be repaired before the listener gives up (exit 5). attachPollMs: how often a listener waiting for a headless wake
 * to end looks again.
 */
export const LIVE_TIMING = { heartbeatMs: 5_000, staleMs: 30_000, sliceSeconds: 60, runnerTroubleMs: 10 * 60_000, attachPollMs: 2_000 };
/**
 * A pickup window stays open past its end while the live session shows life in the room (it acted there within
 * PICKUP_LIFE_MS), up to PICKUP_CAP_MS after the listen returned: a session busy on a long task never gets a headless
 * run of the same session started beside it.
 */
export const PICKUP_LIFE_MS = 10 * 60_000, PICKUP_CAP_MS = 60 * 60_000;
export const DEFAULT_PICKUP_MINUTES = 10, DEFAULT_MAX_WAIT_HOURS = 24;
/** Exit codes of `listen --until-addressed`: 0 work (or the upper bound passed), 3 room closed, 4 agent removed, 5 runner not repaired. */
export const LIVE_EXIT = { work: 0, closed: 3, removed: 4, runner: 5 } as const;
/** How many headless runs a listen reports at most. */
export const MAX_WOKEN_RUNS = 5;

/** A live listener's process: its pid, its start time as the system reports it, and the mark its command line carries (the room id). */
export type LeaseIdentity = { pid: number; started?: string; fingerprint: string };
/** What a returned listen consumed: the cursor before and after it, and the agent's own actions in the room then. */
export type Reoffer = { before: string; after: string; actions: number };
export type LiveLease = {
  state: 'attached' | 'pickup' | 'headless'; pid: number; started?: string; fingerprint?: string; session?: string;
  attachedAt?: number; heartbeat?: number; returnedAt?: number; pickupUntil?: number; reoffer?: Reoffer; reoffered?: boolean;
  /** headless: the run the watcher started, and how long the wake may hold the mailbox. */
  run?: number; since?: number; until?: number;
};
/** What a lease means now. `stale`: an attached listener stopped. `expired`: the pickup window passed. */
export type LiveHold = 'attached' | 'pickup' | 'headless' | 'stale' | 'expired' | 'none';
/** What lease decisions need: a clock, a cheap check that a pid runs, an identity check, and the lease lock. */
export type LiveDeps = {
  now(): number;
  alive(pid: number): boolean;
  /** Whether the lease's process still is that listener (sameRun on its pid and start time), is verifiably gone, or can't be told. */
  verify(lease: LiveLease): 'same' | 'gone' | 'unknown';
  lock<T>(work: () => T): T | 'busy';
  /** When the agent last acted in the room (sent, changed a task, voted, reacted), if ever: life during a pickup window. */
  lastActed?(): number | undefined;
};

export function readLease(dir: string): LiveLease | undefined {
  try {
    const lease = JSON.parse(readFileSync(join(dir, LIVE_LEASE), 'utf8')) as LiveLease;
    return ['attached', 'pickup', 'headless'].includes(lease?.state) && Number.isSafeInteger(lease.pid) && lease.pid > 0 ? lease : undefined;
  } catch { return undefined; }
}
const writeLease = (dir: string, lease: LiveLease) => replaceFile(join(dir, LIVE_LEASE), JSON.stringify(lease));
const dropLease = (dir: string) => { try { unlinkSync(join(dir, LIVE_LEASE)); } catch { /* Already gone. */ } };
const ours = (lease: LiveLease | undefined, me: LeaseIdentity) => !!lease && lease.state !== 'headless' && lease.pid === me.pid && lease.started === me.started;

/**
 * What a lease means now. An attached lease holds while its heartbeat is fresh and its pid runs; past staleMs it holds
 * one staleMs more only while its process is verified to be that listener (a machine back from sleep runs the watcher's
 * check before the listener's next heartbeat). A pickup lease holds until its window ends. A headless claim holds while
 * the watcher or its run lives, until its time is up. The identity check (processInfo, slow on Windows) runs only for a
 * stale heartbeat, never on every poll.
 */
export function liveHold(lease: LiveLease | undefined, deps: Pick<LiveDeps, 'now' | 'alive' | 'verify' | 'lastActed'>, staleMs = LIVE_TIMING.staleMs): LiveHold {
  if (!lease) return 'none';
  const now = deps.now();
  if (lease.state === 'headless') return now < (lease.until ?? 0) && (deps.alive(lease.pid) || (!!lease.run && deps.alive(lease.run))) ? 'headless' : 'none';
  if (lease.state === 'pickup') {
    if (now < (lease.pickupUntil ?? 0)) return 'pickup';
    // Past its end, still open while the session acts in the room, up to the cap.
    const acted = deps.lastActed?.();
    return acted !== undefined && now - acted < PICKUP_LIFE_MS && now < (lease.returnedAt ?? 0) + PICKUP_CAP_MS ? 'pickup' : 'expired';
  }
  const age = now - (lease.heartbeat ?? 0);
  if (!deps.alive(lease.pid)) return 'stale';
  if (age < staleMs) return 'attached';
  return age < 2 * staleMs && deps.verify(lease) === 'same' ? 'attached' : 'stale';
}

export type AttachResult = { attached: LiveLease } | { refused: string } | { wait: 'headless' } | 'busy';
/**
 * Takes the lease for a live listener. Refused while another listener is attached, unless that one is verifiably gone
 * (its pid runs something else now, by sameRun on its start time; never judged by a bare pid). A pickup lease is the
 * previous listener's, handed back: taken over. While a headless wake holds the mailbox, the caller waits.
 */
export function attachLive(dir: string, me: LeaseIdentity, deps: LiveDeps, session?: string, staleMs = LIVE_TIMING.staleMs): AttachResult {
  return deps.lock((): AttachResult => {
    const lease = readLease(dir), hold = liveHold(lease, deps, staleMs);
    if (lease?.state === 'attached' && hold === 'attached' && lease.pid !== me.pid && deps.verify(lease) !== 'gone')
      return { refused: `Another live listener is attached for this agent in this room (pid ${lease.pid}${lease.session ? `, session ${lease.session}` : ''}, `
        + `since ${new Date(lease.attachedAt ?? 0).toISOString()}). Only one may wait at a time: stop that one first, or let it hand you the work.` };
    if (hold === 'headless') return { wait: 'headless' };
    // Work a previous listener returned and nobody handled yet stays offerable: the new lease carries it.
    const carried = lease && lease.state !== 'headless' && lease.reoffer && !lease.reoffered ? { reoffer: lease.reoffer } : {};
    const now = deps.now(), attached: LiveLease = { state: 'attached', ...me, ...(session ? { session } : {}), attachedAt: now, heartbeat: now, ...carried };
    writeLease(dir, attached);
    return { attached };
  });
}
/** Refreshes this listener's heartbeat; false once the lease is no longer its own (another listener took it over). */
export function beatLive(dir: string, me: LeaseIdentity, deps: LiveDeps) {
  const done = deps.lock(() => {
    const lease = readLease(dir);
    if (!ours(lease, me) || lease!.state !== 'attached') return false;
    writeLease(dir, { ...lease!, heartbeat: deps.now() });
    return true;
  });
  return done === 'busy' ? true : done;
}
/** The listener returned work: its lease waits for the live session to handle it, for `graceMs`. */
export function pickupLive(dir: string, me: LeaseIdentity, deps: LiveDeps, graceMs: number, reoffer: Reoffer) {
  deps.lock(() => {
    const lease = readLease(dir);
    if (!ours(lease, me)) return;
    const now = deps.now(), carried = lease!.reoffer;
    // Carried work still unhandled (nothing acted, and this listen read on from where it ended): offered together.
    const merged = carried && carried.after === reoffer.before && carried.actions === reoffer.actions ? { ...reoffer, before: carried.before } : reoffer;
    writeLease(dir, { ...lease!, state: 'pickup', returnedAt: now, pickupUntil: now + graceMs, reoffer: merged });
  });
}
/**
 * The listener ends without work (a timeout, a closed room, an error): its lease goes. One that carries work a previous
 * listener returned becomes an ended pickup instead, so the watcher can still offer that work.
 */
export function releaseLive(dir: string, me: LeaseIdentity, deps: Pick<LiveDeps, 'lock' | 'now'>) {
  deps.lock(() => {
    const lease = readLease(dir);
    if (!ours(lease, me) || lease!.state !== 'attached') return;
    if (lease!.reoffer && !lease!.reoffered) { const now = deps.now(); writeLease(dir, { ...lease!, state: 'pickup', returnedAt: now, pickupUntil: now }); }
    else dropLease(dir);
  });
}

export type LiveGate = { hold: LiveHold; lease?: LiveLease; reoffer?: string };
/**
 * The watcher's look before a wake. A pickup window that passed while the agent did nothing in the room and no listen
 * read further gives the consumed work back once (`reoffer`: the cursor to restore), so the headless fallback handles
 * it rather than lose it.
 */
export function liveGate(dir: string, deps: LiveDeps, current: { cursor(): string; actions(): number }, staleMs = LIVE_TIMING.staleMs): LiveGate {
  const lease = readLease(dir), hold = liveHold(lease, deps, staleMs);
  // An expired pickup, or a listener that stopped while carrying an earlier listener's unhandled work.
  const due = (l: LiveLease | undefined) => !!l && l.state !== 'headless' && !!l.reoffer && !l.reoffered && current.cursor() === l.reoffer.after && current.actions() === l.reoffer.actions;
  const ended = (h: LiveHold) => h === 'expired' || h === 'stale';
  if (!ended(hold) || !due(lease)) return { hold, lease };
  const reoffer = deps.lock(() => {
    const now = readLease(dir);
    if (!due(now) || !ended(liveHold(now, deps, staleMs))) return undefined;
    writeLease(dir, { ...now!, reoffered: true });
    return now!.reoffer!.before;
  });
  return { hold, lease, ...(typeof reoffer === 'string' ? { reoffer } : {}) };
}
/** Claims the mailbox for a headless wake, unless a live listener holds it (attached, or in its pickup window). */
export function beginHeadless(dir: string, watcher: number, untilMs: number, deps: LiveDeps, staleMs = LIVE_TIMING.staleMs) {
  const done = deps.lock(() => {
    const hold = liveHold(readLease(dir), deps, staleMs);
    if (hold === 'attached' || hold === 'pickup') return false;
    const now = deps.now();
    writeLease(dir, { state: 'headless', pid: watcher, since: now, until: now + untilMs });
    return true;
  });
  return done === true;
}
/** Records the headless run's own pid, so a listener keeps waiting for a run that outlives its watcher. */
export function headlessStarted(dir: string, watcher: number, run: number, deps: Pick<LiveDeps, 'lock'>) {
  deps.lock(() => { const lease = readLease(dir); if (lease?.state === 'headless' && lease.pid === watcher) writeLease(dir, { ...lease, run }); });
}
export function endHeadless(dir: string, watcher: number, deps: Pick<LiveDeps, 'lock'>) {
  deps.lock(() => { const lease = readLease(dir); if (lease?.state === 'headless' && lease.pid === watcher) dropLease(dir); });
}

/** What watch-status and the watcher show about a live session. */
export function liveReport(lease: LiveLease | undefined, hold: LiveHold, now: number) {
  if (!lease || hold === 'none' || lease.state === 'headless') return null;
  const iso = (at: number | undefined) => at ? new Date(at).toISOString() : null;
  return { state: hold, pid: lease.pid, session: lease.session ?? null, attachedAt: iso(lease.attachedAt),
    ...(lease.heartbeat ? { heartbeatAgoSeconds: Math.max(0, Math.round((now - lease.heartbeat) / 1000)) } : {}),
    ...(lease.state === 'pickup' ? { returnedAt: iso(lease.returnedAt), pickupUntil: iso(lease.pickupUntil) } : {}),
    wakes: hold === 'attached' || hold === 'pickup' ? 'deferred to the live session' : 'on' };
}

/** How a headless run ended, as the watcher judged it. */
export const RUN_OUTCOMES = ['replied', 'failed', 'paused', 'busy', 'no-action', 'did-not-read'] as const;
/**
 * A headless run as the watcher records it for the live session: when it ended, how, the ids of the messages it sent
 * (their request ids) and of the messages they reply to. Ids and an enum only: no harness text ever reaches an agent.
 */
export type RecentRun = { at: number; outcome: typeof RUN_OUTCOMES[number]; sent: string[]; repliedTo: string[] };
const ID = /^[A-Za-z0-9-]{1,64}$/;
/**
 * Headless runs since the agent's last listen outside a wake, newest last, at most MAX_WOKEN_RUNS. Rebuilt field by field
 * from what the file holds, so nothing but a time, a known outcome and ids comes out, whatever was written there.
 */
export function wokenRuns(runs: unknown[] | undefined, seenAt: number | undefined) {
  const ids = (list: unknown) => Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string' && ID.test(id)).slice(0, 10) : [];
  return (runs ?? []).flatMap(value => {
    const run = value as Partial<RecentRun> | undefined;
    if (typeof run?.at !== 'number' || run.at <= (seenAt ?? 0)) return [];
    return [{ at: new Date(run.at).toISOString(), outcome: RUN_OUTCOMES.includes(run.outcome as never) ? run.outcome! : 'unknown' as const, sent: ids(run.sent), repliedTo: ids(run.repliedTo) }];
  }).slice(-MAX_WOKEN_RUNS);
}
export const readWokenSeen = (roomDir: string): number | undefined => {
  try { const at = JSON.parse(readFileSync(join(roomDir, WOKEN_SEEN), 'utf8'))?.at; return typeof at === 'number' ? at : undefined; } catch { return undefined; }
};
export const writeWokenSeen = (roomDir: string, at: number) => { try { replaceFile(join(roomDir, WOKEN_SEEN), JSON.stringify({ at })); } catch { /* Reported again next time. */ } };

/** One internal listen, as listenRemembering returns it. */
export type SliceResult = { state: string; addressed?: unknown[]; tasks?: unknown[]; decisions?: unknown; error?: string; [key: string]: unknown };
/** What a listen return holds for the agent: messages that address it, assignments, or decisions (peekWork's rule). */
export const sliceHasWork = (result: SliceResult) => !['timeout', 'closed', 'runner-stopped', 'waiting'].includes(result.state)
  && (!!result.addressed?.length || !!result.tasks?.length || !!result.decisions);

export type LiveListenDeps = {
  now(): number;
  sleep(ms: number): Promise<unknown>;
  attach(): AttachResult;
  /** Refreshes the lease; false once it is someone else's. */
  beat(): boolean;
  pickup(reoffer: Reoffer): void;
  release(): void;
  /** One internal listen of at most `seconds`: listenRemembering, which consumes only what it returns as work. */
  listen(seconds: number): Promise<SliceResult>;
  /** Whether the room service said this agent is no longer in the room (the runner's proof, removedSince). */
  removed(): boolean;
  /** Repairs a runner that stopped, when this command owns it (repairRunner); otherwise leaves it to its owner. */
  repair(): Promise<unknown>;
  cursor(): string;
  actions(): number;
  /** Runs `work` every `ms` until the returned function is called. */
  every(ms: number, work: () => void): () => void;
  log(line: string): void;
};
export type LiveListenOptions = { maxWaitMs: number; graceMs: number; timing?: typeof LIVE_TIMING };
/**
 * `listen --until-addressed`: waits, in internal slices, until there is work for this agent, holding the live lease the
 * whole time. Never returns on a runner gap: a slice that reports the runner stopped is followed by a repair (or, while
 * the watcher owns the runner, by waiting for it), and only trouble that lasts runnerTroubleMs ends the wait (exit 5).
 * A first listen's history without anything for the agent is caught up silently. Past `maxWaitMs` it exits 0 with
 * `state: timeout`, so a forgotten listener doesn't live forever.
 */
export async function liveListen(deps: LiveListenDeps, options: LiveListenOptions): Promise<{ exitCode: number; result: SliceResult }> {
  const timing = options.timing ?? LIVE_TIMING, start = deps.now(), left = () => options.maxWaitMs - (deps.now() - start);
  const timeout = (last?: SliceResult): { exitCode: number; result: SliceResult } => ({ exitCode: LIVE_EXIT.work, result: { ...(last ?? {}), state: 'timeout' } });
  let waitLogged = false;
  for (;;) {
    const attached = deps.attach();
    if (attached !== 'busy' && 'refused' in attached) throw new Error(attached.refused);
    if (attached !== 'busy' && 'attached' in attached) break;
    if (attached !== 'busy' && !waitLogged) { deps.log('a headless wake is handling this agent\'s work; waiting for it to finish'); waitLogged = true; }
    if (left() <= 0) return timeout();
    await deps.sleep(timing.attachPollMs);
  }
  let lost = false, handedOff = false, last: SliceResult | undefined, troubleSince: number | undefined;
  const stop = deps.every(timing.heartbeatMs, () => { if (!deps.beat()) lost = true; });
  try {
    for (;;) {
      if (lost) throw new Error('Another live listener took this agent\'s lease over; this one stops without reading. Run it again only if that one is gone.');
      if (deps.removed()) return { exitCode: LIVE_EXIT.removed, result: { ...(last ?? {}), state: 'removed', error: 'This agent was removed from the room. Stop listening to it; connect again with a new link to rejoin.' } };
      if (left() <= 0) return timeout(last);
      const before = deps.cursor();
      const result = await deps.listen(Math.max(1, Math.min(timing.sliceSeconds, Math.ceil(left() / 1000))));
      if (result.state === 'closed') return { exitCode: LIVE_EXIT.closed, result };
      if (result.state === 'runner-stopped') {
        troubleSince ??= deps.now();
        if (deps.now() - troubleSince >= timing.runnerTroubleMs) return { exitCode: LIVE_EXIT.runner, result: { ...result,
          error: `The room's background process stopped and was not running again within ${Math.round(timing.runnerTroubleMs / 60_000)} minutes. Check status, then run this listen again.` } };
        await deps.repair();
        await deps.sleep(timing.attachPollMs);
        continue;
      }
      troubleSince = undefined;
      if (!sliceHasWork(result)) { if (result.state === 'timeout') last = result; continue; }
      deps.pickup({ before, after: deps.cursor(), actions: deps.actions() });
      handedOff = true;
      return { exitCode: LIVE_EXIT.work, result };
    }
  } finally { stop(); if (!handedOff) deps.release(); }
}

/** How `connect --session` and `watch` read a harness's session id. */
export type SessionHarness = 'claude' | 'codex' | 'hermes' | 'other';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** The harness a `connect --harness` text names (it is free text, like 'Claude Code'). */
export const sessionHarness = (text: string | undefined): SessionHarness =>
  /claude/i.test(text ?? '') ? 'claude' : /codex/i.test(text ?? '') ? 'codex' : /hermes/i.test(text ?? '') ? 'hermes' : 'other';
/**
 * The session `connect --session` recorded, as the default for `watch --harness codex|hermes` when neither --session nor
 * --last is given: only one recorded for that same harness, in its own format.
 */
export function recordedSessionFor(harness: 'codex' | 'hermes', recorded: { id: string; harness: SessionHarness } | undefined) {
  return recorded && recorded.harness === harness && sessionProblem(harness, recorded.id) === undefined ? recorded.id : undefined;
}
/** Whether `id` has the shape of that harness's session ids; undefined when it does, else what to give instead. */
export function sessionProblem(harness: SessionHarness, id: string): string | undefined {
  if (harness === 'claude') return UUID.test(id) ? undefined : 'A Claude Code session id is a UUID (claude --resume lists them; /status shows the current one).';
  if (harness === 'hermes') return /^\d{8}_\d{6}_[0-9a-f]{4,}$/i.test(id) ? undefined : 'A Hermes session id looks like 20260101_000000_abcdef.';
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) ? undefined : 'Use --session with the session id your harness printed.';
}
/** Claude Code's own folder ($CLAUDE_CONFIG_DIR, else ~/.claude). */
export const claudeConfigDir = (env: Record<string, string | undefined> = process.env, home = homedir()) => env.CLAUDE_CONFIG_DIR || join(home, '.claude');
/** Where Claude Code keeps the transcripts of sessions started in `cwd`: projects/<cwd with every other character than a letter or digit as ->. */
export const claudeProjectDir = (cwd: string, configDir = claudeConfigDir()) => join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
/** How recent a Claude Code session must be to count as one `--continue` could pick. */
export const RECENT_SESSION_MS = 24 * 3_600_000;
/**
 * Claude Code sessions in `cwd` written to within `withinMs`, newest first. A folder that can't be read lists none (a
 * newer Claude Code may name it differently): the watcher then works as before rather than refuse.
 */
export function recentClaudeSessions(cwd: string, options: { configDir?: string; now?: number; withinMs?: number } = {}) {
  const dir = claudeProjectDir(cwd, options.configDir), since = (options.now ?? Date.now()) - (options.withinMs ?? RECENT_SESSION_MS);
  let names: string[]; try { names = readdirSync(dir); } catch { return []; }
  return names.flatMap(name => {
    const id = /^(.+)\.jsonl$/.exec(name)?.[1];
    if (!id || !UUID.test(id)) return [];
    try { const at = statSync(join(dir, name)).mtimeMs; return at >= since ? [{ id, at }] : []; } catch { return []; }
  }).sort((a, b) => b.at - a.at).map(s => s.id);
}
/**
 * The session a Claude Code watcher resumes when `watch` names none: the one `connect --session` recorded, else the most
 * recent in the folder (a bare --continue), but only when the folder has at most one recent session. With several,
 * --continue could resume the wrong one, so `watch` refuses and says how to name it. `--last` keeps the old behaviour.
 */
export function pinClaudeSession(o: { session?: string; last: boolean; recorded?: { id: string; harness: SessionHarness }; recent: () => string[]; cwd: string }):
  { pinned?: string; from?: 'connect' } {
  if (o.session !== undefined || o.last) return o.session !== undefined ? { pinned: o.session } : {};
  if (o.recorded && (o.recorded.harness === 'claude' || o.recorded.harness === 'other') && UUID.test(o.recorded.id)) return { pinned: o.recorded.id, from: 'connect' };
  const recent = o.recent();
  if (recent.length > 1) throw new Error(`${o.cwd} has ${recent.length} Claude Code sessions active in the last day, so --continue could resume the wrong one. `
    + 'Name the session to wake: watch ... --session <session id> (or record it once with connect ... --session <session id>), or pass --last to resume the most recent anyway.');
  return {};
}
