import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REPAIR_BACKOFF_MS, RUNNER_LOCK, RUNNER_REPAIR, agentCli, listenNotes, probeRoomService, repairRunner, roomServiceReport, runRunner, runnerHealth, runnerReport, runnerStarted, sameRunner, stopRunner,
  watcherRunnerCheck, withRunnerLock, type FoundRunner, type RepairDeps,
} from '../agent-cli';
import {
  BrowserAgent, PENDING_PROFILE, RUNNER_ALIVE, RUNNER_STUCK_MS, RunnerWedged, UPGRADE_BACKOFF_MS, runBridge, withGatheredCandidates, runnerStopped, runnerStuck, runnerTrouble, serviceSilence, settleWithin, stuckFor, within,
} from '../browser-agent';
import { CONNECT_TIMEOUT_MS, FILE_CHANNEL_LABEL, PRIMARY_CHANNEL_LABEL, UNHEALTHY_GRACE_MS } from '../../src/browser/pacer';
import { fakeRunner } from './fake-runner';

const roomId = crypto.randomUUID(), alex = crypto.randomUUID(), wren = crypto.randomUUID();
const members = [{ id: alex, name: 'Alex', role: 'human' as const }, { id: wren, name: 'Wren', role: 'agent' as const, operatorId: alex }];
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'mr-bridge-runner-')); dirs.push(dir); return dir; };

/**
 * An admitted agent whose room service is a fake: every status answers at once (or as `status` says), other commands as
 * `answer` says. Passes pause 20 ms instead of a second, so the loop comes round quickly; nothing below depends on how
 * quickly, only on it coming round, and each wait allows 20 s for what takes well under one.
 */
function room(options: { answer?: (action: string, payload?: any) => Promise<unknown>; status?: () => Promise<unknown> | undefined } = {}) {
  const home = tempDir();
  const agent = new BrowserAgent(home, 'http://127.0.0.1:1', roomId);
  writeFileSync(join(agent.dir, 'room.json'), JSON.stringify({ origin: 'http://127.0.0.1:1', roomId }));
  writeFileSync(join(agent.dir, 'members.json'), JSON.stringify({ memberId: wren, ownerId: alex, members, devices: [] }));
  const state = { polls: 0, closed: false };
  (agent as unknown as { command: (action: string, payload?: unknown) => Promise<unknown> }).command = async (action, payload) => {
    if (action !== 'status') return (options.answer ?? (async () => ({})))(action, payload);
    if (state.closed) throw Object.assign(new Error('This room was closed by its host.'), { status: 410 });
    state.polls++;
    const custom = options.status?.();
    if (custom) return custom;
    return { roomId, memberId: wren, ownerId: alex, epoch: 'one', members, devices: [], settings: { floor: 'open', agentAssignmentsWake: false, guestAgentApproval: true } };
  };
  const until = async (done: () => boolean) => { for (const by = Date.now() + 20_000; !done();) { if (Date.now() > by) throw new Error('timed out waiting'); await Bun.sleep(20); } };
  const queue = (text: string) => {
    const id = crypto.randomUUID();
    writeFileSync(join(agent.dir, 'outbox', `${Date.now()}-${id}.json`), JSON.stringify({ id, text }));
    return id;
  };
  const proof = () => JSON.parse(readFileSync(join(agent.dir, RUNNER_ALIVE), 'utf8'));
  return { agent, home, state, until, queue, proof, pause: () => Bun.sleep(20),
    stored: (id: string) => agent.messages().filter(m => m.packet.body.id === id).length,
    outbox: () => readdirSync(join(agent.dir, 'outbox')).filter(f => f.endsWith('.json')) };
}

test('a bounded wait says whether work settled in time, without cancelling it or leaving a late rejection unhandled', async () => {
  expect(await within(Promise.resolve(), 1_000)).toBe(true);
  expect(await within(Promise.reject(new Error('no')), 1_000)).toBe(true);
  expect(await within(new Promise(() => {}), 30)).toBe(false);
  let fail!: (error: Error) => void;
  const late = new Promise<number>((_, reject) => { fail = reject; });
  const results = await settleWithin([Promise.resolve(1), late, new Promise<number>(() => {})], 30);
  expect(results).toEqual([{ status: 'fulfilled', value: 1 }, undefined, undefined]);
  // Rejected after its wait was given up: handled, so the runner never dies of an unhandled rejection.
  fail(new Error('too late'));
  await Bun.sleep(10);
});

// The steps below never finish, so the deadlines race nothing: each only decides when the pass stops waiting.
test('a pass step that never finishes is cut off by its deadline, reported once, not started again, and the loop keeps coming round', async () => {
  let profiles = 0;
  const r = room({ answer: async action => { if (action === 'profile') { profiles++; return new Promise(() => {}); } return {}; } });
  writeFileSync(join(r.agent.dir, PENDING_PROFILE), JSON.stringify({ model: 'test-model' }));
  const logs: string[] = [];
  const bridge = runBridge(r.agent, line => logs.push(line), { deadlines: { profile: 300 }, pause: r.pause }).catch(error => error);
  try {
    await r.until(() => profiles === 1);
    const hung = Date.now(), before = r.state.polls;
    // Without the deadline the pass would wait on the profile report forever, and the device would drop out of the room.
    await r.until(() => r.state.polls >= before + 5);
    expect(logs.filter(line => line.includes('profile did not finish within 0.3 s'))).toHaveLength(1);
    expect(profiles).toBe(1);
    // Its proof says the loop still comes round and the room service answers.
    await r.until(() => r.proof().loopAt > hung && r.proof().polledAt > hung);
    const proof = r.proof();
    expect(proof.pid).toBe(process.pid);
    expect(proof.failingSince).toBeUndefined();
    expect(runnerTrouble(r.agent, 0)).toBeUndefined();
  } finally { r.state.closed = true; }
  expect(String(await bridge)).toContain('closed by its host');
}, 40_000);

test('an outbox delivery the pass stops waiting for is never run twice: each message is signed and stored once, and none is lost', async () => {
  const r = room(), logs: string[] = [];
  let release!: () => void, signed = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sign = r.agent.sign.bind(r.agent);
  (r.agent as unknown as { sign: (value: unknown) => Promise<string> }).sign = async value => {
    if ((value as { kind?: string })?.kind === 'message') { signed++; await gate; }
    return sign(value);
  };
  const first = r.queue('First, held up while signing');
  const bridge = runBridge(r.agent, line => logs.push(line), { deadlines: { outbox: 300, decisions: 300 }, pause: r.pause }).catch(error => error);
  try {
    await r.until(() => signed === 1);
    const before = r.state.polls;
    const second = r.queue('Second, queued while the first is stuck');
    await r.until(() => r.state.polls >= before + 5);
    // The pass moved on and kept polling; the stuck delivery was not started again, so nothing was signed twice.
    expect(logs.filter(line => line.includes('outbox did not finish within 0.3 s'))).toHaveLength(1);
    expect(signed).toBe(1);
    // Both are still in the outbox, the durable queue: nothing is lost while the delivery hangs.
    expect(r.outbox()).toHaveLength(2);
    expect(r.stored(first)).toBe(0);
    release();
    await r.until(() => r.outbox().length === 0);
    const settled = r.state.polls;
    await r.until(() => r.state.polls >= settled + 5);
    expect(r.stored(first)).toBe(1);
    expect(r.stored(second)).toBe(1);
    expect(signed).toBe(2);
  } finally { release(); r.state.closed = true; }
  expect(String(await bridge)).toContain('closed by its host');
}, 40_000);

test('a step that never finishes stops the runner, so a fresh one takes over, and its message stays queued', async () => {
  const r = room(), logs: string[] = [];
  const sign = r.agent.sign.bind(r.agent);
  (r.agent as unknown as { sign: (value: unknown) => Promise<string> }).sign = value => (value as { kind?: string })?.kind === 'message' ? new Promise(() => {}) : sign(value);
  const id = r.queue('Never signed');
  const error = await runBridge(r.agent, line => logs.push(line), { deadlines: { outbox: 100, wedged: 1_000 }, pause: r.pause }).catch(caught => caught);
  expect(error).toBeInstanceOf(RunnerWedged);
  expect(logs.some(line => line.includes('outbox has not finished') && line.includes('fresh runner'))).toBe(true);
  expect(r.outbox()).toHaveLength(1);
  expect(r.stored(id)).toBe(0);
  // Its ticker is stopped: the proof no longer moves (the ticker runs every second; 1.5 s would have rewritten it).
  const at = r.proof().at;
  await Bun.sleep(1_500);
  expect(r.proof().at).toBe(at);
}, 30_000);

test('a room service that fails or never answers is recorded as such, and the runner carries on rather than being taken for stuck', async () => {
  let failing: 'rejected' | 'error' | 'hang' | undefined = 'rejected';
  const r = room({ status: () => failing === 'rejected' ? Promise.reject(Object.assign(new Error('Too many requests.'), { status: 429 }))
    : failing === 'error' ? Promise.reject(new Error('fetch failed')) : failing === 'hang' ? new Promise(() => {}) : undefined });
  const bridge = runBridge(r.agent, () => {}, { deadlines: { poll: 300 }, pause: r.pause }).catch(error => error);
  try {
    // The service answered, with a rejection: its HTTP status is recorded, so this is never taken for a cut-off runner.
    await r.until(() => r.state.polls >= 3 && serviceSilence(r.proof())?.status === 429);
    const since = r.proof().failingSince;
    // The request itself fails: no status, a transport failure.
    failing = 'error';
    await r.until(() => serviceSilence(r.proof())?.failure === 'fetch failed');
    expect(serviceSilence(r.proof())?.status).toBeUndefined();
    expect(r.proof().failingSince).toBe(since);
    // A poll that never answers is cut off too, so the loop still comes round; the outage keeps its first moment.
    failing = 'hang';
    await r.until(() => (serviceSilence(r.proof())?.failure ?? '').includes('did not answer within 0.3 s'));
    expect(r.proof().failingSince).toBe(since);
    expect(r.proof().polledAt).toBeUndefined();
    expect(runnerTrouble(r.agent, 0)).toBeUndefined();
    // The service answers again: the outage is over.
    failing = undefined;
    await r.until(() => typeof r.proof().polledAt === 'number' && r.proof().failingSince === undefined);
  } finally { r.state.closed = true; failing = undefined; }
  expect(String(await bridge)).toContain('closed by its host');
}, 40_000);

test('only a loop that stopped coming round counts against a runner: an outage of the room service never does', () => {
  const r = room(), now = Date.now(), prove = (proof: object) => writeFileSync(join(r.agent.dir, RUNNER_ALIVE), JSON.stringify({ pid: process.pid, at: now, ...proof }));
  // Its process ticks along, but its loop hasn't come round for twenty minutes.
  prove({ startedAt: now - 30 * 60_000, loopAt: now - 20 * 60_000, polledAt: now - 20 * 60_000 });
  expect(runnerTrouble(r.agent, 0, now)).toBe('stuck');
  expect(runnerStopped(r.agent, 0, now)).toBe(true);
  expect(runnerStuck({ loopAt: now - RUNNER_STUCK_MS - 1 }, now)).toBe(true);
  expect(runnerStuck({ loopAt: now - RUNNER_STUCK_MS + 1_000 }, now)).toBe(false);
  // Its loop comes round, but the room service hasn't answered for twenty minutes: an outage, not a stuck runner.
  prove({ startedAt: now - 30 * 60_000, loopAt: now - 1_000, polledAt: now - 20 * 60_000, failingSince: now - 20 * 60_000, failure: 'fetch failed' });
  expect(runnerTrouble(r.agent, 0, now)).toBeUndefined();
  expect(serviceSilence(JSON.parse(readFileSync(join(r.agent.dir, RUNNER_ALIVE), 'utf8')))).toEqual({ since: now - 20 * 60_000, failure: 'fetch failed' });
  // A runner just started or replaced gets its full minute from then, whatever its predecessor's proof said.
  prove({ loopAt: now - 20 * 60_000 });
  expect(runnerTrouble(r.agent, now - 10_000, now)).toBeUndefined();
  expect(stuckFor({ loopAt: now - 20 * 60_000 }, now, now - 10_000)).toBe(10_000);
  // A runner from before loopAt was recorded is never taken for a stuck one.
  prove({ startedAt: now - 30 * 60_000 });
  expect(runnerTrouble(r.agent, 0, now)).toBeUndefined();
  expect(stuckFor({ pid: 1, at: now }, now)).toBeUndefined();
});

test('health is read only from the runner\'s own proof; status reports a stuck runner as none, and an outage as its own state', () => {
  const now = 10_000_000;
  expect(runnerHealth(50, { pid: 50, at: now, loopAt: now, polledAt: now - 2_000 }, now)).toEqual({ stuck: false, polledAt: now - 2_000 });
  expect(runnerHealth(50, { pid: 50, at: now, loopAt: now - 90_000 }, now)).toEqual({ stuck: true });
  expect(runnerHealth(50, { pid: 50, at: now, loopAt: now, failingSince: now - 90_000, failure: 'x' }, now)).toEqual({ stuck: false, silence: { since: now - 90_000, failure: 'x' } });
  // Another pid's proof (the runner just started hasn't written its own) says nothing about this one.
  expect(runnerHealth(50, { pid: 49, at: now, loopAt: now - 90_000 }, now)).toEqual({ stuck: false });
  expect(runnerHealth(50, undefined, now)).toEqual({ stuck: false });
  expect(runnerReport(undefined, now)).toEqual({ runner: null });
  expect(runnerReport({ pid: 50, verified: true, stuck: false, polledAt: now - 2_400 }, now)).toEqual({ runner: { pid: 50, syncedAgoSeconds: 2 } });
  expect(runnerReport({ pid: 50, verified: false, stuck: false }, now)).toEqual({ runner: { pid: 50, syncedAgoSeconds: null } });
  expect(runnerReport({ pid: 50, verified: true, stuck: true, polledAt: now - 1_200_000 }, now))
    .toEqual({ runner: null, runnerProblem: { pid: 50, syncedAgoSeconds: 1200, reason: expect.stringContaining('people see this agent offline') } });
  const outage = runnerReport({ pid: 50, verified: true, stuck: false, polledAt: now - 600_000, silence: { since: now - 600_000, failure: 'fetch failed' } }, now) as Record<string, unknown>;
  expect(outage.runner).toEqual({ pid: 50, syncedAgoSeconds: 600 });
  expect(outage.roomService).toMatchObject({ answering: false, since: new Date(now - 600_000).toISOString(), failure: 'fetch failed' });
  expect(roomServiceReport(undefined)).toBeUndefined();
  // listen adds nothing when all is well, and says what is wrong when it isn't.
  const fresh = { pid: 50, at: now, loopAt: now };
  expect(listenNotes(fresh, { outcome: 'kept', pid: 50 }, now)).toEqual({});
  expect(listenNotes({ ...fresh, failingSince: now - 60_000 }, { outcome: 'kept', pid: 50 }, now)).toMatchObject({ roomService: { answering: false } });
  // A proof nothing rewrites any more says nothing about the service now.
  expect(listenNotes({ ...fresh, at: now - 60_000, failingSince: now - 60_000 }, { outcome: 'kept', pid: 50 }, now)).toEqual({});
  for (const outcome of ['unverified', 'not-stopped', 'backoff', 'busy'] as const)
    expect(listenNotes(fresh, { outcome, pid: 50 }, now)).toMatchObject({ runnerProblem: { outcome, hint: expect.any(String) } });
});

/** RepairDeps over a fake runner table, with an in-memory lock; `calls` records what happened, in order. */
function fakeRepairs(options: { inWake?: boolean; watcher?: boolean; runner?: FoundRunner; stops?: boolean; broken?: boolean; lastRepair?: number; busy?: boolean; serviceAnswers?: boolean }) {
  const calls: string[] = [], logs: string[] = [];
  let runner = options.runner, next = 900, lastRepair = options.lastRepair;
  const deps: RepairDeps = {
    inWake: !!options.inWake, broken: options.broken, watcherRuns: () => { calls.push('watcher?'); return !!options.watcher; },
    probe: async () => { calls.push('probe'); return !!options.serviceAnswers; },
    lock: async work => options.busy ? 'busy' : work(),
    runner: () => { calls.push('look'); return runner; },
    stop: async pid => { calls.push(`stop ${pid}`); if (options.stops === false) return false; runner = undefined; return true; },
    start: async () => { calls.push('start'); runner = { pid: ++next, verified: true, stuck: false }; return next; },
    lastRepair: () => lastRepair, recordRepair: at => { lastRepair = at; }, now: () => 1_000_000, log: line => logs.push(line),
  };
  return { deps, calls, logs, repaired: () => lastRepair };
}

test('commands replace a stuck runner only when they own it: never while a watcher runs, never in a wake, never on a proof alone', async () => {
  const stuck: FoundRunner = { pid: 70, verified: true, stuck: true };
  const attempt = async (options: Parameters<typeof fakeRepairs>[0]) => { const f = fakeRepairs(options); return { ...await repairRunner(f.deps), calls: f.calls, logs: f.logs }; };
  // No watcher: looked at again under the lock, stopped first, and started only once it's gone and no other appeared.
  expect(await attempt({ runner: stuck })).toMatchObject({ outcome: 'restarted', pid: 901, calls: ['look', 'watcher?', 'look', 'stop 70', 'look', 'start'] });
  // A watcher runs: it owns the runner, and repairs it itself.
  expect(await attempt({ runner: stuck, watcher: true })).toMatchObject({ outcome: 'watcher', calls: ['look', 'watcher?'] });
  // In a wake the command doesn't even look.
  expect(await attempt({ runner: stuck, inWake: true })).toMatchObject({ outcome: 'wake', calls: [] });
  // Known only by its proof of life (a sandbox hides processes): never killed on that word, no second one, and said so.
  const unverified = await attempt({ runner: { ...stuck, verified: false } });
  expect(unverified).toMatchObject({ outcome: 'unverified', calls: ['look', 'watcher?', 'look'] });
  expect(unverified.logs.join()).toContain("can't be inspected");
  // One that couldn't be confirmed and stopped keeps the device: no second runner, and said so.
  const kept = await attempt({ runner: stuck, stops: false });
  expect(kept).toMatchObject({ outcome: 'not-stopped', calls: ['look', 'watcher?', 'look', 'stop 70'] });
  expect(kept.logs.join()).toContain('not starting a second one');
  // Another process holds the lock (it is repairing it): left to that one.
  expect(await attempt({ runner: stuck, busy: true })).toMatchObject({ outcome: 'busy' });
  // A healthy runner is kept; a missing one is started unless a watcher runs.
  expect(await attempt({ runner: { ...stuck, stuck: false } })).toMatchObject({ outcome: 'kept', pid: 70, calls: ['look'] });
  expect(await attempt({})).toMatchObject({ outcome: 'started', pid: 901, calls: ['look', 'watcher?', 'look', 'start'] });
  expect(await attempt({ watcher: true })).toMatchObject({ outcome: 'watcher' });
  // One listen (or the watcher) found broken is replaced like a stuck one.
  expect(await attempt({ runner: { ...stuck, stuck: false }, broken: true })).toMatchObject({ outcome: 'restarted' });
  // Another version is replaced, and says which; that is no repair, so the backoff neither applies nor starts.
  const outdated = fakeRepairs({ runner: { ...stuck, stuck: false, outdated: '0.1.0' }, lastRepair: 999_000 });
  expect(await repairRunner(outdated.deps)).toMatchObject({ outcome: 'replaced', replaced: '0.1.0' });
  expect(outdated.repaired()).toBe(999_000);
});

test('a stuck runner is replaced at most once in the backoff, and a runner that appeared meanwhile is kept', async () => {
  const stuck: FoundRunner = { pid: 70, verified: true, stuck: true };
  const first = fakeRepairs({ runner: stuck });
  expect(await repairRunner(first.deps)).toMatchObject({ outcome: 'restarted' });
  expect(first.repaired()).toBe(1_000_000);
  // Replaced again within the backoff: left alone, and said so.
  const soon = fakeRepairs({ runner: stuck, lastRepair: 1_000_000 - REPAIR_BACKOFF_MS + 1 });
  expect(await repairRunner(soon.deps)).toMatchObject({ outcome: 'backoff', pid: 70 });
  expect(soon.calls).not.toContain('stop 70');
  expect(soon.logs.join()).toContain('already replaced');
  expect(await repairRunner(fakeRepairs({ runner: stuck, lastRepair: 1_000_000 - REPAIR_BACKOFF_MS }).deps)).toMatchObject({ outcome: 'restarted' });
  // A stop that failed replaced nothing: it is not recorded, so the next try isn't held back by a replacement that never was.
  const failedStop = fakeRepairs({ runner: stuck, stops: false });
  expect(await repairRunner(failedStop.deps)).toMatchObject({ outcome: 'not-stopped' });
  expect(failedStop.repaired()).toBeUndefined();
  // A runner found broken, but another took its place before the lock was taken: that one gets its own time.
  const f = fakeRepairs({ runner: { ...stuck, stuck: false }, broken: true });
  const look = f.deps.runner;
  let looks = 0;
  f.deps.runner = () => ++looks === 1 ? look() : { pid: 71, verified: true, stuck: false };
  expect(await repairRunner(f.deps)).toMatchObject({ outcome: 'kept', pid: 71 });
  // A live runner that appeared while the stuck one was stopped (a bridge that doesn't take the lock): no second one.
  const g = fakeRepairs({ runner: stuck });
  const stop = g.deps.stop;
  let appeared = false;
  g.deps.stop = async pid => { const done = await stop(pid); appeared = true; return done; };
  const gLook = g.deps.runner;
  g.deps.runner = () => appeared ? { pid: 72, verified: true, stuck: false } : gLook();
  expect(await repairRunner(g.deps)).toMatchObject({ outcome: 'kept', pid: 72 });
  expect(g.calls).not.toContain('start');
  // But the runner just stopped can still seem there for a moment (its proof stays fresh; on Linux it may not be reaped
  // yet): that is not another runner, and the new one starts.
  const h = fakeRepairs({ runner: stuck });
  const hStop = h.deps.stop;
  let stopped = false;
  h.deps.stop = async pid => { stopped = await hStop(pid); return stopped; };
  const hLook = h.deps.runner;
  h.deps.runner = () => stopped && !h.calls.includes('start') ? { ...stuck, stuck: false } : hLook();
  expect(await repairRunner(h.deps)).toMatchObject({ outcome: 'restarted', pid: 901 });
  expect(h.calls.at(-1)).toBe('start');
});

test('a runner whose polls keep failing is replaced when the room service answers this process, and kept through an outage', async () => {
  // The fakes' clock stands at 1,000,000: polls failing for two minutes, or for thirty seconds.
  const failing = (ms: number): FoundRunner => ({ pid: 70, verified: true, stuck: false, polledAt: 1_000_000 - ms, silence: { since: 1_000_000 - ms, failure: 'fetch failed' } });
  // The service answers this process: the runner's own networking is broken, and a fresh one fixes it. Asked once.
  const isolated = fakeRepairs({ runner: failing(120_000), serviceAnswers: true });
  expect(await repairRunner(isolated.deps)).toMatchObject({ outcome: 'restarted', pid: 901 });
  expect(isolated.calls).toEqual(['look', 'watcher?', 'probe', 'watcher?', 'look', 'watcher?', 'stop 70', 'look', 'start']);
  expect(isolated.logs.join()).toContain(`room service answers but the runner's polls fail since ${new Date(1_000_000 - 120_000).toISOString()}: replacing`);
  expect(isolated.repaired()).toBe(1_000_000);
  // Within the backoff: left alone, and said so.
  const soon = fakeRepairs({ runner: failing(120_000), serviceAnswers: true, lastRepair: 1_000_000 - 60_000 });
  expect(await repairRunner(soon.deps)).toMatchObject({ outcome: 'backoff', pid: 70 });
  expect(soon.calls).not.toContain('stop 70');
  // The service doesn't answer this process either: an outage. Reported, never a kill.
  const outage = fakeRepairs({ runner: failing(120_000), serviceAnswers: false });
  expect(await repairRunner(outage.deps)).toMatchObject({ outcome: 'kept', pid: 70 });
  expect(outage.calls).toEqual(['look', 'watcher?', 'probe']);
  expect(outage.repaired()).toBeUndefined();
  // The service answered the runner's polls, with a rate limit or a server error: it was reached, so a healthy probe
  // proves nothing about the runner's networking. Kept, and no request is made.
  for (const status of [429, 500]) {
    const rejected = fakeRepairs({ runner: { ...failing(120_000), silence: { since: 1_000_000 - 120_000, failure: 'Rejected', status } }, serviceAnswers: true });
    expect(await repairRunner(rejected.deps)).toMatchObject({ outcome: 'kept', pid: 70 });
    expect(rejected.calls).not.toContain('probe');
    expect(rejected.repaired()).toBeUndefined();
  }
  // Failing for under a minute: nothing to check yet, so no request is made.
  const brief = fakeRepairs({ runner: failing(30_000), serviceAnswers: true });
  expect(await repairRunner(brief.deps)).toMatchObject({ outcome: 'kept' });
  expect(brief.calls).not.toContain('probe');
  // Only the runner's owner asks: never while a watcher runs, never in a wake.
  const watched = fakeRepairs({ runner: failing(120_000), serviceAnswers: true, watcher: true });
  expect(await repairRunner(watched.deps)).toMatchObject({ outcome: 'kept' });
  expect(watched.calls).not.toContain('probe');
  const woken = fakeRepairs({ runner: failing(120_000), serviceAnswers: true, inWake: true });
  expect(await repairRunner(woken.deps)).toMatchObject({ outcome: 'wake' });
  expect(woken.calls).toEqual([]);
});

test('the probe asks the room service\'s health endpoint at the runner\'s origin, and anything but ok: true is an outage', async () => {
  const asked: string[] = [];
  const answer = (response: () => Response | Promise<Response>) => (async (url: string | URL | Request) => { asked.push(String(url)); return response(); }) as unknown as typeof fetch;
  expect(await probeRoomService('https://rooms.example', answer(() => Response.json({ ok: true })))).toBe(true);
  expect(asked).toEqual(['https://rooms.example/api/lobby/health']);
  expect(await probeRoomService('https://rooms.example', answer(() => Response.json({ ok: false })))).toBe(false);
  expect(await probeRoomService('https://rooms.example', answer(() => new Response('down', { status: 503 })))).toBe(false);
  expect(await probeRoomService('https://rooms.example', answer(() => new Response('<html>', { status: 200 })))).toBe(false);
  expect(await probeRoomService('https://rooms.example', answer(() => { throw new Error('fetch failed'); }))).toBe(false);
  // One that never answers gives up after its timeout.
  const hang = ((_: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('timed out'))))) as unknown as typeof fetch;
  expect(await probeRoomService('https://rooms.example', hang, 100)).toBe(false);
});

test('two commands repairing one stuck runner at once start exactly one runner between them, thanks to the runner lock', async () => {
  const dir = tempDir();
  const race = async (lock: RepairDeps['lock']) => {
    // One shared runner table, as runner.pid is on disk; stopping and starting each take a moment, as they do for real.
    const table = { pid: 70 as number | undefined, stuck: true }, starts: number[] = [];
    const deps = (): RepairDeps => ({ inWake: false, watcherRuns: () => false, lock, probe: async () => false,
      runner: () => table.pid === undefined ? undefined : { pid: table.pid, verified: true, stuck: table.stuck },
      stop: async () => { await Bun.sleep(100); table.pid = undefined; return true; },
      start: async () => { await Bun.sleep(100); const pid = 100 + starts.length; starts.push(pid); table.pid = pid; table.stuck = false; return pid; },
      lastRepair: () => undefined, recordRepair: () => {}, now: Date.now, log: () => {} });
    const outcomes = await Promise.all([repairRunner(deps()), repairRunner(deps())]);
    return { starts, outcomes: outcomes.map(o => o.outcome).sort() };
  };
  // With the lock: the second looks again once the first is done, and keeps the runner the first started.
  expect(await race(work => withRunnerLock(dir, work))).toEqual({ starts: [100], outcomes: ['kept', 'restarted'] });
  expect(existsSync(join(dir, RUNNER_LOCK))).toBe(false);
  // Without it, both stop and both start: the second runner this test exists to rule out.
  expect((await race(async work => work())).starts).toHaveLength(2);
});

test('the runner lock waits for its holder, gives up after its wait, and takes over one whose holder is gone', async () => {
  const dir = tempDir(), lock = join(dir, RUNNER_LOCK);
  // Held by a live process (this one): a second taker waits, then gives up without running its work.
  writeFileSync(lock, String(process.pid));
  let ran = false;
  expect(await withRunnerLock(dir, async () => { ran = true; }, 300)).toBe('busy');
  expect(ran).toBe(false);
  // Its holder crashed: the lock names a process that is gone, so it is taken over.
  writeFileSync(lock, '2147483000');
  expect(await withRunnerLock(dir, async () => 'done', 300)).toBe('done');
  expect(existsSync(lock)).toBe(false);
  // A file that names no process is never taken over.
  writeFileSync(lock, 'junk');
  await expect(withRunnerLock(dir, async () => 'done', 300)).rejects.toThrow("doesn't name the runner start that made it");
});

test('recording a runner start asks until the system reports when the process started', () => {
  let looks = 0;
  const started = runnerStarted(70, () => ++looks < 3 ? undefined : { started: '2026-01-01T00:00:00.0000000Z' }, () => {}, 1_000);
  expect(started).toBe('2026-01-01T00:00:00.0000000Z');
  expect(looks).toBe(3);
});

test('recording a runner start stops asking once its budget has passed', () => {
  let now = 0, slept = 0;
  const started = runnerStarted(70, () => undefined, ms => { slept += ms; now += ms; }, 250, () => now);
  expect(started).toBeUndefined();
  expect(slept).toBe(250);
});

test('H-6: runnerStarted bails immediately when process inspection is unavailable in a sandbox or container', () => {
  let looks = 0, slept = 0;
  const started = runnerStarted(70, () => { looks++; return { unavailable: true }; }, ms => { slept += ms; }, 15_000);
  expect(started).toBeUndefined();
  expect(looks).toBe(1);
  expect(slept).toBe(0);
});

test('H-8: locks only fall back from hardlink on no-hardlink errnos, retry brief empty locks, and reclaim expired short-held locks', async () => {
  const { takeLock, tryLock } = await import('../locks');
  const { utimesSync } = await import('node:fs');
  const dir = tempDir();
  // takeLock rethrows unexpected errors like ENOSPC instead of falling back to wx.
  const enospcPath = join(dir, 'enospc.lock');
  expect(() => takeLock(enospcPath, () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); })).toThrow('no space');
  expect(existsSync(enospcPath)).toBe(false);
  // takeLock DOES fall back to wx on ENOTSUP/EXDEV/EPERM/ENOSYS/EOPNOTSUPP.
  const fallbackPath = join(dir, 'notsup.lock');
  takeLock(fallbackPath, () => { throw Object.assign(new Error('not supported'), { code: 'ENOTSUP' }); });
  expect(existsSync(fallbackPath)).toBe(true);

  // An expired short-held runner.lock (even with junk/crashed content) ages out past maxAgeMs instead of deadlocking forever.
  const runnerLock = join(dir, RUNNER_LOCK);
  writeFileSync(runnerLock, '');
  const old = new Date(Date.now() - 180_000);
  utimesSync(runnerLock, old, old);
  expect(await withRunnerLock(dir, async () => 'recovered', 300)).toBe('recovered');
  expect(existsSync(runnerLock)).toBe(false);

  // Stale reclaim marker with maxAgeMs is cleared instead of throwing permanently.
  const aged = join(dir, 'aged.lock');
  writeFileSync(aged, String(process.pid));
  writeFileSync(`${aged}.reclaim`, '2147483000');
  utimesSync(aged, old, old);
  utimesSync(`${aged}.reclaim`, old, old);
  expect(tryLock(aged, 'aged', undefined, { maxAgeMs: 30_000 })).toBe(false);
  expect(existsSync(`${aged}.reclaim`)).toBe(false);
  expect(tryLock(aged, 'aged', undefined, { maxAgeMs: 30_000 })).toBe(true);
});

test('a runner is stopped only while it still is this room\'s runner, and nothing new starts until it is gone', async () => {
  const room = '0190a000-0000-7000-8000-00000000000a', command = `bun /opt/meshrooms/bin/meshrooms.js run --room ${room}`, started = '2026-01-01T10:00:00.0000000Z';
  const record = { pid: 70, started };
  expect(sameRunner(room, 70, record, { command, started })).toBe(true);
  expect(sameRunner(room, 70, record, { command, started: '2026-01-01T11:00:00.0000000Z' })).toBe(false); // Its pid, reused.
  expect(sameRunner(room, 70, record, { command })).toBe(false); // A start time it can't read: fails closed.
  expect(sameRunner(room, 70, record, { command: 'bun test', started })).toBe(false);
  expect(sameRunner(room, 70, record, { command: command.replace(room, crypto.randomUUID()), started })).toBe(false);
  expect(sameRunner(room, 70, record, undefined)).toBe(false);
  // A runner started before start times were recorded is known by its exact command line, as before.
  expect(sameRunner(room, 70, { pid: 70 }, { command })).toBe(true);
  expect(sameRunner(room, 70, { pid: 71, started }, { command })).toBe(true);

  const stop = async (info: { command: string; started?: string } | undefined, kills: boolean, goneAfter: number) => {
    let looks = 0, killed = 0;
    const done = await stopRunner(room, 70, { info: () => info, record: () => record, kill: (_pid, stillSame) => { killed++; expect(stillSame()).toBe(!!info); return kills; },
      gone: () => ++looks > goneAfter, sleep: async () => {} });
    return { done, killed };
  };
  expect(await stop({ command, started }, true, 3)).toEqual({ done: true, killed: 1 });
  expect(await stop({ command, started: 'later' }, true, 0)).toEqual({ done: false, killed: 0 });
  expect(await stop(undefined, true, 0)).toEqual({ done: false, killed: 0 });
  // Not its own process group (or no ps to tell): not signalled, so not stopped.
  expect(await stop({ command, started }, false, 0)).toEqual({ done: false, killed: 1 });
  // It never went: the caller must not start another.
  expect(await stop({ command, started }, true, Infinity)).toEqual({ done: false, killed: 1 });
});

test('run exits when the runner wedges, so nothing of it lingers beside the next one; other failures still surface', async () => {
  const r = room(), exits: number[] = [], logs: string[] = [];
  const deps = (bridge: () => Promise<unknown>) => ({ check: async () => {}, bridge, exit: (code: number) => { exits.push(code); }, log: (line: string) => logs.push(line) });
  await runRunner(r.agent, deps(async () => { throw new RunnerWedged("The runner's outbox step never finished; start the runner again."); }));
  expect(exits).toEqual([1]);
  expect(logs).toEqual(["The runner's outbox step never finished; start the runner again."]);
  await expect(runRunner(r.agent, deps(async () => { throw Object.assign(new Error('This room was closed by its host.'), { status: 410 }); }))).rejects.toThrow('closed by its host');
  expect(exits).toEqual([1]);
});

/** Runs `work` with MESHROOMS_AGENT_HOME set to `home`. */
async function inHome<T>(home: string, work: () => Promise<T>) {
  const saved = process.env.MESHROOMS_AGENT_HOME;
  process.env.MESHROOMS_AGENT_HOME = home;
  try { return await work(); } finally { if (saved === undefined) delete process.env.MESHROOMS_AGENT_HOME; else process.env.MESHROOMS_AGENT_HOME = saved; }
}

test('the watcher replaces a stuck runner it can see, through the real lookup, lock and kill, then waits out the backoff', async () => {
  const r = room(), logs: string[] = [], fakes: { kill: () => void }[] = [];
  const plant = async () => {
    const fake = await fakeRunner(join(r.home, 'fake'), roomId, { kind: 'stuck', proofFile: join(r.agent.dir, RUNNER_ALIVE) });
    fakes.push(fake);
    writeFileSync(join(r.agent.dir, 'runner.pid'), String(fake.pid));
    writeFileSync(join(r.agent.dir, 'runner.json'), JSON.stringify({ pid: fake.pid, version: null, started: fake.started }));
    return fake;
  };
  try {
    await inHome(r.home, async () => {
      const starts: number[] = [];
      // Everything is real but the start: no runner is spawned from inside a test.
      const check = watcherRunnerCheck(r.agent, line => logs.push(line), { start: async () => { starts.push(Date.now()); return 4242; } });
      const stuck = await plant();
      expect(await check()).toMatchObject({ outcome: 'restarted', pid: 4242 });
      expect(stuck.alive()).toBe(false);
      expect(starts).toHaveLength(1);
      expect(existsSync(join(r.agent.dir, RUNNER_REPAIR))).toBe(true);
      expect(existsSync(join(r.agent.dir, RUNNER_LOCK))).toBe(false);
      expect(logs.some(line => line.includes('is stuck') && line.includes('replaced it'))).toBe(true);
      // Stuck again within the backoff: left running, said so, nothing started.
      const again = await plant();
      expect(await check()).toMatchObject({ outcome: 'backoff', pid: again.pid });
      expect(again.alive()).toBe(true);
      expect(starts).toHaveLength(1);
      expect(logs.some(line => line.includes('already replaced'))).toBe(true);
    });
  } finally { for (const fake of fakes) fake.kill(); }
}, 90_000);

test('a runner.pid naming a process that is gone, or one that isn\'t this room\'s runner, counts as no runner', async () => {
  const r = room();
  await inHome(r.home, async () => {
    for (const pid of [2_147_483_000, process.pid]) {
      writeFileSync(join(r.agent.dir, 'runner.pid'), String(pid));
      // Even with a fresh proof naming it: a command line that is visible and isn't the runner's decides.
      writeFileSync(join(r.agent.dir, RUNNER_ALIVE), JSON.stringify({ pid, at: Date.now(), startedAt: Date.now(), loopAt: Date.now(), polledAt: Date.now() }));
      const status = await agentCli(['status', '--room', roomId]) as Record<string, unknown>;
      expect(status).toMatchObject({ runner: null, floorLive: false });
      expect(status.runnerProblem).toBeUndefined();
      // And stop never signals it.
      expect(await agentCli(['stop', '--room', roomId])).toEqual({ stopped: false });
    }
    // Another process holds the runner lock: stop waits for it (up to 20 s), then says why it stopped nothing.
    writeFileSync(join(r.agent.dir, RUNNER_LOCK), String(process.pid));
    expect(await agentCli(['stop', '--room', roomId])).toEqual({ stopped: false, reason: 'busy' });
  });
}, 90_000);

test('a runner alone in its room counts as synced, so a watcher can start; with another device online it waits for that channel', async () => {
  // Another device present and online: history may come from it, so the runner is not synced until a channel opens. Its
  // id sorts first, so this runner only answers its offers and never makes one, and no real connection is attempted.
  let others: { id: string; memberId: string; session: string }[] = [{ id: '0'.repeat(64), memberId: alex, session: crypto.randomUUID() }];
  const r = room({ status: () => Promise.resolve({ roomId, memberId: wren, ownerId: alex, epoch: 'one', members, devices: others,
    settings: { floor: 'open', agentAssignmentsWake: false, guestAgentApproval: true } }) });
  const bridge = runBridge(r.agent, () => {}, { pause: r.pause }).catch(error => error);
  try {
    await r.until(() => r.state.polls >= 5 && typeof r.proof().polledAt === 'number');
    expect(r.proof().syncedAt).toBeUndefined();
    // Everyone else leaves (or the operator closes the browser): nobody can send history, so there is nothing to wait for.
    others = [];
    await r.until(() => typeof r.proof().syncedAt === 'number');
  } finally { r.state.closed = true; }
  expect(String(await bridge)).toContain('closed by its host');
}, 40_000);

test('OPS-11: runBridge applies exponential backoff on HTTP 429 honoring Retry-After and resets on success', async () => {
  const pauses: number[] = [];
  let seq = 0;
  const r = room({
    status: () => {
      seq++;
      if (seq === 1) return Promise.reject(Object.assign(new Error('Too many requests.'), { status: 429 }));
      if (seq === 2) return Promise.reject(Object.assign(new Error('Too many requests.'), { status: 429 }));
      if (seq === 3) return Promise.reject(Object.assign(new Error('Too many requests.'), { status: 429, retryAfterMs: 12_000 }));
      if (seq === 4) return Promise.reject(Object.assign(new Error('Too many requests.'), { status: 429 }));
      if (seq === 5) return Promise.reject(Object.assign(new Error('Too many requests.'), { status: 429 }));
      return undefined; // 6+: succeeds and resets backoff to 1000 ms
    },
  });
  const bridge = runBridge(r.agent, () => {}, {
    pause: async ms => { pauses.push(ms); await Bun.sleep(10); },
  }).catch(error => error);
  try {
    await r.until(() => pauses.length >= 6);
    expect(pauses.slice(0, 6)).toEqual([2_000, 4_000, 12_000, 24_000, 30_000, 1_000]);
  } finally { r.state.closed = true; }
  expect(String(await bridge)).toContain('closed by its host');
}, 20_000);

test('OPS-9, SYNC-5, OPS-11, SEC-11: runBridge keeps open peers across epoch changes, opens files channel, refreshes ICE, and recovers zombies/failed signals', async () => {
  const peerOpenId = 'f'.repeat(64);
  const peerConnId = 'e'.repeat(64);
  let clock = 1_000_000;
  let epoch = 'e1';
  let iceServers: RTCIceServer[] = [{ urls: 'turn:turn.example:3478', username: '1000:room', credential: 'cred-1' }];
  let devices: { id: string; memberId: string; publicKey: string; label: string; admittedAt: number; session?: string }[] = [
    { id: peerOpenId, memberId: alex, publicKey: 'A'.repeat(88), label: 'open', admittedAt: 1, session: 's-open' },
    { id: peerConnId, memberId: alex, publicKey: 'B'.repeat(88), label: 'conn', admittedAt: 1, session: 's-conn' },
  ];
  let failSignalsFor: string | undefined;
  type Sub<T> = { handlers: ((v: T) => void)[]; subscribe(fn: (v: T) => void): void; fire(v: T): void };
  const sub = <T,>(): Sub<T> => ({ handlers: [], subscribe(fn) { this.handlers.push(fn); }, fire(v) { for (const fn of this.handlers) fn(v); } });
  type MockBridgeChannel = {
    label: string; readyState: string; bufferedAmount: number; bufferedAmountLowThreshold: number;
    sent: string[]; send(data: string): void;
    stateChanged: Sub<string>; onMessage: Sub<string>; bufferedAmountLow: Sub<void>;
  };
  type MockBridgePC = {
    iceServers: { urls: string; username?: string; credential?: string }[];
    configUpdates: { urls: string; username?: string; credential?: string }[][];
    connectionState: string; iceConnectionState: string; signalingState: string;
    localDescription: { type: string; sdp: string } | null;
    remoteDescription: { type: string; sdp: string } | null;
    channels: MockBridgeChannel[]; closed: boolean;
    onDataChannel: Sub<MockBridgeChannel>; connectionStateChange: Sub<string>; iceConnectionStateChange: Sub<string>;
    createDataChannel(label: string): MockBridgeChannel;
    createOffer(): Promise<{ type: 'offer'; sdp: string }>;
    createAnswer(): Promise<{ type: 'answer'; sdp: string }>;
    setLocalDescription(d: { type: string; sdp: string }): Promise<void>;
    setRemoteDescription(d: { type: string; sdp: string }): Promise<void>;
    setConfiguration(cfg: { iceServers?: { urls: string; username?: string; credential?: string }[] }): void;
    close(): Promise<void>;
  };
  const pcs: MockBridgePC[] = [];
  let ufrag = 0;
  const createPeerConnection = (cfg: { iceServers: { urls: string; username?: string; credential?: string }[] }) => {
    const pc: MockBridgePC = {
      iceServers: [...cfg.iceServers],
      configUpdates: [],
      connectionState: 'new', iceConnectionState: 'new', signalingState: 'stable',
      localDescription: null, remoteDescription: null, channels: [], closed: false,
      onDataChannel: sub(), connectionStateChange: sub(), iceConnectionStateChange: sub(),
      createDataChannel(label) {
        const ch: MockBridgeChannel = {
          label, readyState: 'connecting', bufferedAmount: 0, bufferedAmountLowThreshold: 0, sent: [],
          send(data) { this.sent.push(data); },
          stateChanged: sub(), onMessage: sub(), bufferedAmountLow: sub(),
        };
        this.channels.push(ch);
        return ch;
      },
      async createOffer() { return { type: 'offer', sdp: `v=0\r\na=ice-ufrag:bo${++ufrag}\r\na=mid:0\r\n` }; },
      async createAnswer() { return { type: 'answer', sdp: `v=0\r\na=ice-ufrag:ba${++ufrag}\r\na=mid:0\r\n` }; },
      async setLocalDescription(d) { this.localDescription = d; this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'; },
      async setRemoteDescription(d) { this.remoteDescription = d; this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable'; },
      setConfiguration(next) { if (next.iceServers) { this.iceServers = [...next.iceServers]; this.configUpdates.push(this.iceServers); } },
      async close() { this.closed = true; this.connectionState = 'closed'; this.iceConnectionState = 'closed'; this.signalingState = 'closed'; },
    };
    pcs.push(pc);
    return pc as unknown as any;
  };

  let signalCount = 0;
  const r = room({
    status: () => Promise.resolve({
      roomId, memberId: wren, ownerId: alex, epoch, members, devices, iceServers, signals: [],
      settings: { floor: 'open', agentAssignmentsWake: false, guestAgentApproval: true },
    }),
    answer: async action => {
      if (action === 'signal') {
        signalCount++;
        if (failSignalsFor) throw new Error('signal failed');
      }
      return {};
    },
  });
  const bridge = runBridge(r.agent, () => {}, {
    pause: () => Bun.sleep(15),
    now: () => clock,
    gatherMs: 0,
    createPeerConnection,
  }).catch(error => error);
  try {
    // Wait until both peers are created with both primary + dedicated 'files' channels.
    await r.until(() => pcs.length >= 2);
    const [pcOpen, pcConn] = pcs;
    expect(pcOpen.channels.map(c => c.label)).toEqual([PRIMARY_CHANNEL_LABEL, FILE_CHANNEL_LABEL]);
    // Open pcOpen's primary and files channels; leave pcConn still connecting.
    pcOpen.connectionState = 'connected';
    pcOpen.iceConnectionState = 'connected';
    pcOpen.channels[0].readyState = 'open';
    pcOpen.channels[0].stateChanged.fire('open');
    pcOpen.channels[1].readyState = 'open';
    pcOpen.channels[1].stateChanged.fire('open');
    // File announcement went over the dedicated 'files' channel!
    expect(pcOpen.channels[1].sent.map(s => JSON.parse(s).kind)).toContain('files');

    // OPS-9: coordinator restarts (epoch e1 -> e2) and peerOpen's session is momentarily absent;
    // pcOpen MUST stay open while half-open pcConn IS retired and renegotiated!
    const pollsBeforeEpoch = r.state.polls;
    epoch = 'e2';
    devices = [
      { id: peerOpenId, memberId: alex, publicKey: 'A'.repeat(88), label: 'open', admittedAt: 1, session: undefined },
      { id: peerConnId, memberId: alex, publicKey: 'B'.repeat(88), label: 'conn', admittedAt: 1, session: 's-conn' },
    ];
    await r.until(() => r.state.polls >= pollsBeforeEpoch + 2 && pcConn.closed);
    expect(pcOpen.closed).toBe(false);
    expect(pcConn.closed).toBe(true);
    expect(pcs.length).toBeGreaterThanOrEqual(3);

    // OPS-11: refreshed TURN iceServers push into live pcOpen via setConfiguration.
    devices = [{ id: peerOpenId, memberId: alex, publicKey: 'A'.repeat(88), label: 'open', admittedAt: 1, session: 's-open' }];
    iceServers = [{ urls: 'turn:turn.example:3478', username: '4600:room', credential: 'cred-2' }];
    await r.until(() => pcOpen.configUpdates.length >= 1);
    expect(pcOpen.configUpdates.at(-1)![0].credential).toBe('cred-2');

    // SYNC-5: long-lived (>1h) peer drops to disconnected -> gets UNHEALTHY_GRACE_MS grace, then retires past grace!
    clock += 2 * 3_600_000;
    pcOpen.connectionState = 'disconnected';
    pcOpen.iceConnectionState = 'disconnected';
    const pollsAtDrop = r.state.polls;
    await r.until(() => r.state.polls >= pollsAtDrop + 2);
    expect(pcOpen.closed).toBe(false); // Still inside 12 s grace!
    clock += UNHEALTHY_GRACE_MS + 1;
    await r.until(() => pcOpen.closed);
    const pcReplacement = pcs.at(-1)!;
    expect(pcReplacement).not.toBe(pcOpen);
    expect(pcReplacement.iceServers[0].credential).toBe('cred-2');

    // Zombie connected PC with closed DataChannel retires immediately!
    pcReplacement.connectionState = 'connected';
    pcReplacement.iceConnectionState = 'connected';
    pcReplacement.channels[0].readyState = 'closed';
    await r.until(() => pcReplacement.closed);

    // Failed signal retires half-open peer immediately instead of stalling 20 s!
    const pcsBeforeFail = pcs.length;
    failSignalsFor = peerOpenId;
    const prevLatest = pcs.at(-1)!;
    prevLatest.connectionState = 'failed';
    await r.until(() => pcs.length >= pcsBeforeFail + 2 && pcs[pcsBeforeFail].closed);
    expect(signalCount).toBeGreaterThan(2);
  } finally { failSignalsFor = undefined; r.state.closed = true; }
  expect(String(await bridge)).toContain('closed by its host');
}, 30_000);

test('OPS-6: BrowserAgent.command sends X-Meshrooms-Protocol: 1 and runBridge handles HTTP 426 cleanly', async () => {
  const originalFetch = globalThis.fetch;
  const seenHeaders: Record<string, string>[] = [];
  const home = tempDir();
  const realAgent = new BrowserAgent(home, 'https://meshrooms.example', roomId);
  globalThis.fetch = Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
    seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
    return Response.json({ error: 'Bridge version unsupported.', code: 'upgrade-required' }, { status: 426 });
  }, { preconnect: originalFetch.preconnect });
  try {
    await expect(realAgent.command('status', { session: 's' })).rejects.toMatchObject({
      status: 426,
      code: 'upgrade-required',
      message: 'Bridge version unsupported.',
    });
    expect(seenHeaders[0]['X-Meshrooms-Protocol']).toBe('1');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // runBridge logs a clear upgrade hint, records upgradeRequired in runner-alive.json, backs off 60s, and clears on recovery.
  const pauses: number[] = [];
  const logs: string[] = [];
  let seq = 0;
  const r = room({
    status: () => {
      seq++;
      if (seq <= 2) return Promise.reject(Object.assign(new Error('Coordinator requires a newer protocol.'), { status: 426, code: 'upgrade-required' }));
      return undefined; // 3+: recovered
    },
  });
  const bridge = runBridge(r.agent, line => logs.push(line), {
    pause: async ms => { pauses.push(ms); await Bun.sleep(10); },
  }).catch(error => error);
  try {
    await r.until(() => pauses.length >= 1 && r.proof().upgradeRequired === true);
    expect(pauses[0]).toBe(UPGRADE_BACKOFF_MS);
    expect(r.proof()).toMatchObject({ upgradeRequired: true, failureStatus: 426, failure: 'Coordinator requires a newer protocol.' });
    expect(serviceSilence(r.proof())).toMatchObject({ status: 426, upgradeRequired: true, failure: 'Coordinator requires a newer protocol.' });
    expect(logs.some(line => line.includes('426') && line.includes('bunx @wormdb/meshrooms@') && line.includes('Coordinator requires a newer protocol.'))).toBe(true);
    await r.until(() => pauses.length >= 3 && r.proof().upgradeRequired === undefined && typeof r.proof().polledAt === 'number');
    expect(pauses.slice(0, 3)).toEqual([UPGRADE_BACKOFF_MS, UPGRADE_BACKOFF_MS, 1_000]);
  } finally { r.state.closed = true; }
  expect(String(await bridge)).toContain('closed by its host');
}, 20_000);

test('a gathered candidate is added to the end of its media section once, and a malformed one is left out', () => {
  const sdp = 'v=0\r\na=group:BUNDLE 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\na=candidate:1 1 udp 1 192.0.2.1 5000 typ host\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:1\r\n';
  const relay = 'candidate:2 1 udp 2 203.0.113.9 49200 typ relay raddr 0.0.0.0 rport 0';
  const out = withGatheredCandidates(sdp, [
    { candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', sdpMLineIndex: 0 }, // already there
    { candidate: relay, sdpMLineIndex: 0 }, { candidate: relay, sdpMLineIndex: 0 },
    { candidate: 'candidate:3 1 udp 3 192.0.2.3 5000 typ host', sdpMLineIndex: 1 },
    { candidate: 'candidate:4 1 udp 4 192.0.2.4 5000 typ host\r\na=injected', sdpMLineIndex: 0 },
    { candidate: 'not a candidate', sdpMLineIndex: 0 },
  ]);
  expect(out.split('\r\n')).toEqual(['v=0', 'a=group:BUNDLE 0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=mid:0',
    'a=candidate:1 1 udp 1 192.0.2.1 5000 typ host', `a=${relay}`, 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=mid:1',
    'a=candidate:3 1 udp 3 192.0.2.3 5000 typ host', '']);
  expect(withGatheredCandidates('v=0\r\n', [{ candidate: relay }])).toBe('v=0\r\n');
});

// werift's setLocalDescription resolves only when every STUN/TURN server answered; with UDP dropped a udp TURN URL held it
// past the pass's signal deadline, and every connection the agent started was dropped before its offer went out.
test('an offer whose gathering outlasts the gather deadline goes out with the candidates so far, and its answer is kept while werift still gathers', async () => {
  const peerId = 'f'.repeat(64), relay = 'candidate:2 1 udp 2 203.0.113.9 49200 typ relay raddr 0.0.0.0 rport 0';
  const sub = <T,>() => ({ handlers: [] as ((v: T) => void)[], subscribe(fn: (v: T) => void) { this.handlers.push(fn); return { unSubscribe: () => { this.handlers = this.handlers.filter(h => h !== fn); } }; }, fire(v: T) { for (const fn of this.handlers) fn(v); } });
  const pcs: any[] = [];
  const createPeerConnection = () => {
    const pc: any = {
      connectionState: 'new', iceConnectionState: 'new', signalingState: 'stable', localDescription: null, remoteDescription: null, closed: false,
      onDataChannel: sub(), connectionStateChange: sub(), iceConnectionStateChange: sub(), onIceCandidate: sub<{ candidate: string; sdpMLineIndex: number } | undefined>(),
      createDataChannel: (label: string) => ({ label, readyState: 'connecting', bufferedAmount: 0, bufferedAmountLowThreshold: 0, send() {}, stateChanged: sub(), onMessage: sub(), bufferedAmountLow: sub() }),
      async createOffer() { return { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:slow1\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\n' }; },
      // As werift does: the description is in place and the host candidate comes at once, but the promise waits for every server.
      setLocalDescription(d: { type: string; sdp: string }) {
        pc.localDescription = d; pc.signalingState = 'have-local-offer';
        pc.onIceCandidate.fire({ candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', sdpMLineIndex: 0 });
        setTimeout(() => pc.onIceCandidate.fire({ candidate: relay, sdpMLineIndex: 0 }), 5);
        return new Promise<void>(() => {});
      },
      // Queued behind the gathering, as in werift.
      setRemoteDescription(d: { type: string; sdp: string }) { pc.answered = d; return new Promise<void>(() => {}); },
      setConfiguration() {},
      async close() { pc.closed = true; pc.connectionState = 'closed'; },
    };
    pcs.push(pc);
    return pc;
  };
  const signals: { to: string; description: { type: string; sdp: string } }[] = [];
  let answer: unknown[] = [];
  const logs: string[] = [];
  let clock = 1_000_000;
  const r = room({
    status: () => { const out = answer; answer = []; return Promise.resolve({
      roomId, memberId: wren, ownerId: alex, epoch: 'one', members, iceServers: [], signals: out,
      devices: [{ id: peerId, memberId: alex, publicKey: 'A'.repeat(88), label: 'browser', admittedAt: 1, session: 's-1' }],
      settings: { floor: 'open', agentAssignmentsWake: false, guestAgentApproval: true },
    }); },
    answer: async (action, payload) => { if (action === 'signal') signals.push(payload); return {}; },
  });
  const bridge = runBridge(r.agent, line => logs.push(line), {
    pause: () => Bun.sleep(15), now: () => clock, gatherMs: 0, gatherDeadlineMs: 50, deadlines: { signals: 200 }, createPeerConnection: createPeerConnection as any,
  }).catch(error => error);
  try {
    await r.until(() => signals.length >= 1);
    expect(signals).toHaveLength(1);
    expect(signals[0].to).toBe(peerId);
    expect(signals[0].description.type).toBe('offer');
    expect(signals[0].description.sdp).toContain('a=candidate:1 1 udp 1 192.0.2.1 5000 typ host\r\n');
    expect(signals[0].description.sdp).toContain(`a=${relay}\r\n`);
    expect(logs.some(line => line.includes('sending 2 candidate(s) gathered so far'))).toBe(true);
    expect(logs.some(line => line.includes('did not finish within'))).toBe(false);
    expect(pcs[0].closed).toBe(false);

    // The browser answers; werift holds that answer until its gathering ends. The connection is kept, not dropped.
    answer = [{ seq: 1, from: peerId, session: 's-1', description: { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:brw1\r\na=mid:0\r\n' } }];
    await r.until(() => logs.some(line => line.includes('still waiting on gathering')));
    const polls = r.state.polls;
    await r.until(() => r.state.polls >= polls + 3);
    expect(pcs[0].answered?.type).toBe('answer');
    expect(pcs[0].closed).toBe(false);
    expect(pcs).toHaveLength(1);
    expect(signals).toHaveLength(1);

    // Kept only until the connect timeout: one that never opens is dropped and tried afresh.
    clock += CONNECT_TIMEOUT_MS + 1;
    await r.until(() => pcs[0].closed && pcs.length >= 2);
  } finally { r.state.closed = true; }
  expect(String(await bridge)).toContain('closed by its host');
}, 20_000);

// A sandbox that denies getifaddrs made os.networkInterfaces throw EPERM, and the runner crashed in multicast-dns as
// soon as a browser's `.local` candidate arrived. With no interfaces it now connects through the room's relay only.
test('where network interfaces cannot be listed, the runner says relay-only, asks werift for relay candidates only, and drops .local candidates', async () => {
  const peerId = 'f'.repeat(64);
  const sub = <T,>() => ({ handlers: [] as ((v: T) => void)[], subscribe(fn: (v: T) => void) { this.handlers.push(fn); return { unSubscribe: () => { this.handlers = this.handlers.filter(h => h !== fn); } }; }, fire(v: T) { for (const fn of this.handlers) fn(v); } });
  const configs: any[] = [], pcs: any[] = [];
  const createPeerConnection = (config: unknown) => {
    configs.push(config);
    const pc: any = {
      connectionState: 'new', iceConnectionState: 'new', signalingState: 'stable', localDescription: null, remoteDescription: null,
      onDataChannel: sub(), connectionStateChange: sub(), iceConnectionStateChange: sub(), onIceCandidate: sub(),
      createDataChannel: (label: string) => ({ label, readyState: 'connecting', bufferedAmount: 0, bufferedAmountLowThreshold: 0, send() {}, stateChanged: sub(), onMessage: sub(), bufferedAmountLow: sub() }),
      async createOffer() { return { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:relay1\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\na=candidate:2 1 udp 2 203.0.113.9 49200 typ relay raddr 0.0.0.0 rport 0\r\n' }; },
      async setLocalDescription(d: unknown) { pc.localDescription = d; pc.signalingState = 'have-local-offer'; },
      async setRemoteDescription(d: { type: string; sdp: string }) { pc.remoteDescription = d; pc.signalingState = 'stable'; },
      setConfiguration() {},
      async close() { pc.connectionState = 'closed'; },
    };
    pcs.push(pc);
    return pc;
  };
  const signals: { to: string; description: { type: string; sdp: string } }[] = [];
  let answer: unknown[] = [];
  const logs: string[] = [];
  const r = room({
    status: () => { const out = answer; answer = []; return Promise.resolve({
      roomId, memberId: wren, ownerId: alex, epoch: 'one', members, iceServers: [{ urls: 'turns:turn.example.test:443?transport=tcp', username: 'u', credential: 'c' }], signals: out,
      devices: [{ id: peerId, memberId: alex, publicKey: 'A'.repeat(88), label: 'browser', admittedAt: 1, session: 's-1' }],
      settings: { floor: 'open', agentAssignmentsWake: false, guestAgentApproval: true },
    }); },
    answer: async (action, payload) => { if (action === 'signal') signals.push(payload); return {}; },
  });
  const interfaces = { networkInterfaces: (() => { throw Object.assign(new Error('uv_interface_addresses returned EPERM'), { code: 'EPERM' }); }) as any };
  const bridge = runBridge(r.agent, line => logs.push(line), {
    pause: () => Bun.sleep(15), gatherMs: 0, createPeerConnection: createPeerConnection as any, interfaces,
  }).catch(error => error);
  try {
    await r.until(() => signals.length >= 1);
    expect(logs.filter(line => line.startsWith('interfaces unavailable; relay-only'))).toHaveLength(1);
    expect(configs[0].iceTransportPolicy).toBe('relay');
    expect(configs[0].iceServers).toEqual([{ urls: 'turns:turn.example.test:443?transport=tcp', username: 'u', credential: 'c' }]);
    answer = [{ seq: 1, from: peerId, session: 's-1', description: { type: 'answer', sdp: [
      'v=0', 'a=ice-ufrag:brw1', 'a=mid:0',
      'a=candidate:1 1 udp 2122260223 0b1c2d3e-0000-4000-8000-1234567890ab.local 50000 typ host generation 0',
      'a=candidate:3 1 udp 2 198.51.100.20 51000 typ relay raddr 0.0.0.0 rport 0', ''].join('\r\n') } }];
    await r.until(() => !!pcs[0].remoteDescription);
    expect(pcs[0].remoteDescription.sdp).not.toContain('.local');
    expect(pcs[0].remoteDescription.sdp).toContain('typ relay');
    expect(logs.some(line => line === `relay-only: skipped 1 mDNS candidate(s) from ${peerId.slice(0, 8)}`)).toBe(true);
  } finally { r.state.closed = true; }
  expect(String(await bridge)).toContain('closed by its host');
}, 20_000);
