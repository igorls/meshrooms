import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REPAIR_BACKOFF_MS, RUNNER_LOCK, RUNNER_REPAIR, agentCli, listenNotes, probeRoomService, repairRunner, roomServiceReport, runRunner, runnerHealth, runnerReport, runnerStarted, sameRunner, stopRunner,
  watcherRunnerCheck, withRunnerLock, type FoundRunner, type RepairDeps,
} from '../agent-cli';
import {
  BrowserAgent, PENDING_PROFILE, RUNNER_ALIVE, RUNNER_STUCK_MS, RunnerWedged, runBridge, runnerStopped, runnerStuck, runnerTrouble, serviceSilence, settleWithin, stuckFor, within,
} from '../browser-agent';
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
function room(options: { answer?: (action: string) => Promise<unknown>; status?: () => Promise<unknown> | undefined } = {}) {
  const home = tempDir();
  const agent = new BrowserAgent(home, 'http://127.0.0.1:1', roomId);
  writeFileSync(join(agent.dir, 'room.json'), JSON.stringify({ origin: 'http://127.0.0.1:1', roomId }));
  writeFileSync(join(agent.dir, 'members.json'), JSON.stringify({ memberId: wren, ownerId: alex, members, devices: [] }));
  const state = { polls: 0, closed: false };
  (agent as unknown as { command: (action: string) => Promise<unknown> }).command = async action => {
    if (action !== 'status') return (options.answer ?? (async () => ({})))(action);
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
