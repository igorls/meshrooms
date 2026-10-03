import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { agentCli, bindingsTable, daemonLoginItem, isDaemonCommand, isRunnerCommand, repairRunner, runnerOwner, trustedBinDir, tryLock, watcherLookup, watcherRunnerCheck, WATCHER_ALIVE_WITHIN_MS, type FoundRunner, type RepairDeps } from '../agent-cli';
import {
  BINDING_RECORDS, BUN_NO_ENV_FILE, DAEMON_LOCK, DAEMON_RECORD, DAEMON_TIMING, LEGACY_OFF, ROOM_STOPPED, UNTRUSTED_OFF, authorizeBinding, bindingFence, bridgeEnv, createSupervisor, daemonDir, daemonSupervises, disableBinding, migrateLegacyBinding, readBinding,
  restartDelay, rotateLog, runningDaemon,
  type Handle, type RoomLook, type RoomRef, type SupervisorDeps,
} from '../agent-daemon';
import { CODEX_PROFILE, WAKE_WRITABLE, WATCH_CONFIG, WATCH_STATE, emptyState, harnessInvocation, wakeReadDenies, watchLoop, type WatchDeps } from '../agent-watch';
import { BrowserAgent } from '../browser-agent';
import { loginItemManager, quotePS, systemdUnit, type Exec } from '../startup';
import { processRuns } from './fake-runner';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'mr-bridge-daemon-')); dirs.push(dir); return dir; };
// Nothing here may reach the real ~/.meshrooms: a call that falls back on the default agent folder, registry or daemon
// folder lands in a folder of this file's own (inFolders narrows it further per test).
const sandboxKeys = ['MESHROOMS_AGENT_HOME', 'MESHROOMS_AGENT_REGISTRY', 'MESHROOMS_DAEMON_DIR'] as const;
let sandbox: { dir: string; saved: (string | undefined)[] } | undefined;
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-bridge-daemon-home-'));
  sandbox = { dir, saved: sandboxKeys.map(key => process.env[key]) };
  process.env.MESHROOMS_AGENT_HOME = join(dir, 'agents'); process.env.MESHROOMS_AGENT_REGISTRY = join(dir, 'agent-homes.json'); delete process.env.MESHROOMS_DAEMON_DIR;
});
afterAll(() => {
  if (!sandbox) return;
  sandboxKeys.forEach((key, i) => { if (sandbox!.saved[i] === undefined) delete process.env[key]; else process.env[key] = sandbox!.saved[i]; });
  rmSync(sandbox.dir, { recursive: true, force: true });
});

/**
 * A machine as the supervisor sees it, all fake: rooms, what their files say, and runners and watchers as handles the
 * test ends itself. The clock moves only when the test ticks.
 */
function world(roomIds: string[], options: { repair?: (room: RoomRef, broken: boolean) => { outcome: string; pid?: number } | 'start' } = {}) {
  const clock = { now: 1_000_000 };
  const looks = new Map<string, Partial<RoomLook>>();
  const ids = [...roomIds];
  const calls = { repair: [] as { roomId: string; broken: boolean; at: number }[], stopRunner: [] as string[], startWatcher: [] as string[],
    stopWatcher: [] as { roomId: string; pid: number }[], retire: [] as { roomId: string; state: string }[], heartbeats: 0, starts: [] as number[], migrate: [] as string[] };
  const runners = new Map<string, Handle>(), watchers = new Map<string, Handle>(), found = new Map<string, number | 'unknown'>();
  const logs: string[] = [];
  let pid = 100;
  const ref = (roomId: string): RoomRef => ({ home: '/agents', roomId, dir: `/agents/browser-agents/${roomId}` });
  const deps: SupervisorDeps = {
    now: () => clock.now,
    homes: () => ['/agents'],
    rooms: () => ids.map(ref),
    look: room => ({ stamp: 'room-1', stopped: false, ...looks.get(room.roomId) }),
    repairRunner: async (room, broken, onStart) => {
      calls.repair.push({ roomId: room.roomId, broken, at: clock.now });
      const outcome = options.repair?.(room, broken) ?? (runners.get(room.roomId) && !runners.get(room.roomId)!.exit ? { outcome: 'kept', pid: runners.get(room.roomId)!.pid } : 'start');
      if (outcome !== 'start') return outcome;
      const handle: Handle = { pid: pid++ };
      runners.set(room.roomId, handle); onStart(handle); calls.starts.push(clock.now);
      return { outcome: 'started', pid: handle.pid };
    },
    stopRunner: async room => { calls.stopRunner.push(room.roomId); return true; },
    retire: (room, record) => { calls.retire.push({ roomId: room.roomId, state: record.state }); },
    migrateBinding: room => {
      calls.migrate.push(room.roomId);
      const binding = looks.get(room.roomId)?.binding;
      if (!binding?.legacy) return undefined;
      looks.set(room.roomId, { ...looks.get(room.roomId), binding: { enabled: false, stamp: binding.stamp, offReason: LEGACY_OFF } });
      return 'off';
    },
    findWatcher: room => found.get(room.roomId),
    startWatcher: async room => {
      calls.startWatcher.push(room.roomId);
      const binding = looks.get(room.roomId)?.binding;
      if (!binding?.enabled) return undefined;
      const handle: Handle = { pid: pid++ };
      watchers.set(room.roomId, handle);
      return { pid: handle.pid, handle, stamp: binding.stamp };
    },
    stopWatcher: async (room, stopped, handle) => {
      calls.stopWatcher.push({ roomId: room.roomId, pid: stopped });
      if (handle) handle.exit = { at: clock.now, code: 0 };
      found.delete(room.roomId);
    },
    rotateLogs: () => {},
    log: line => logs.push(line),
    heartbeat: () => { calls.heartbeats++; },
  };
  const supervisor = createSupervisor(deps);
  /** Ticks for `seconds` of fake time, one tick every tickMs. */
  const run = async (seconds: number) => { for (const end = clock.now + seconds * 1000; clock.now < end; clock.now += DAEMON_TIMING.tickMs) await supervisor.tick(); };
  const exit = (handle: Handle, code = 1) => { handle.exit = { at: clock.now, code }; };
  return { clock, looks, calls, runners, watchers, found, logs, supervisor, run, exit, ids, set: (roomId: string, look: Partial<RoomLook>) => looks.set(roomId, { ...looks.get(roomId), ...look }) };
}
const room1 = '0190a000-0000-7000-8000-000000000001', room2 = '0190a000-0000-7000-8000-000000000002';
const on = (stamp = 'b1') => ({ enabled: true, stamp });

test('a new room gets its runner started once; afterwards it is looked at once a minute, not every tick', async () => {
  const w = world([room1]);
  await w.run(10);
  expect(w.calls.repair).toEqual([{ roomId: room1, broken: false, at: 1_000_000 }]);
  await w.run(60);
  expect(w.calls.repair).toHaveLength(2);
  expect(w.supervisor.status()[0]).toMatchObject({ roomId: room1, state: 'supervised', runner: { pid: 100, restarts: 0 } });
  expect(w.calls.heartbeats).toBeGreaterThan(30);
});

test('a runner that exits is started again after the backoff, which doubles while it keeps failing and starts over after a good run', async () => {
  const w = world([room1]);
  await w.run(2);
  w.exit(w.runners.get(room1)!);
  // restartDelay(1) = 2 s: started on the tick after that, not when the proof of life would go stale 30 s later.
  await w.run(2); expect(w.calls.starts).toHaveLength(1);
  await w.run(2); expect(w.calls.starts).toHaveLength(2);
  // Each quick failure in a row doubles the wait: 4, 8, 16 s ... up to five minutes, and never less.
  for (let failures = 2; failures <= 10; failures++) {
    const exited = w.clock.now;
    w.exit(w.runners.get(room1)!);
    await w.run(restartDelay(failures) / 1000 + 4);
    expect(w.calls.starts).toHaveLength(failures + 1);
    const waited = w.calls.starts.at(-1)! - exited;
    expect(waited).toBeGreaterThanOrEqual(restartDelay(failures));
    expect(waited).toBeLessThanOrEqual(restartDelay(failures) + DAEMON_TIMING.tickMs);
  }
  expect(restartDelay(10)).toBe(DAEMON_TIMING.restartMaxMs);
  expect(w.supervisor.status()[0].runner.restarts).toBe(w.calls.starts.length - 1);
  // A runner that worked for a while and then exited is restarted quickly again.
  await w.run(DAEMON_TIMING.stableMs / 1000 + 2);
  const before = w.calls.starts.length;
  w.exit(w.runners.get(room1)!);
  await w.run(4);
  expect(w.calls.starts.length).toBe(before + 1);
  expect(w.supervisor.status()[0].runner.lastExit).toMatchObject({ code: 1 });
});

test('a repair that cannot be made now is not retried every tick', async () => {
  // The proof says stuck, and repairRunner keeps answering with its own backoff (or can't confirm the runner).
  for (const outcome of ['backoff', 'unverified', 'not-stopped']) {
    const w = world([room1], { repair: () => ({ outcome, pid: 7 }) });
    w.set(room1, { trouble: 'stuck' });
    await w.run(60);
    expect(w.calls.repair.length).toBeLessThanOrEqual(2);
    expect(w.calls.repair.every(call => call.broken)).toBe(true);
  }
  // A runner that keeps a stale proof but is alive is looked into again only every troubleRecheckMs.
  const w = world([room1], { repair: () => ({ outcome: 'kept', pid: 7 }) });
  w.set(room1, { trouble: 'stopped' });
  await w.run(60);
  expect(w.calls.repair.length).toBeLessThanOrEqual(60_000 / DAEMON_TIMING.troubleRecheckMs + 1);
  expect(w.supervisor.status()[0].runner.pid).toBe(7);
});

test('a runner or watcher that runs already is adopted, never started beside it', async () => {
  const w = world([room1], { repair: () => ({ outcome: 'kept', pid: 4242 }) });
  w.set(room1, { binding: on() });
  w.found.set(room1, 5151);
  await w.run(10);
  expect(w.calls.startWatcher).toEqual([]);
  expect(w.supervisor.status()[0]).toMatchObject({ runner: { pid: 4242 }, watcher: { pid: 5151, wakes: 'on' } });
  // The adopted watcher ends: found gone at the next unhurried look, then started.
  w.found.delete(room1);
  await w.run(64);
  expect(w.calls.startWatcher).toEqual([room1]);
});

test('a watcher the lookup cannot identify is never taken for gone: no second one starts until a lookup can tell', async () => {
  const w = world([room1]);
  w.set(room1, { binding: on() });
  w.found.set(room1, 'unknown');
  await w.run(120);
  expect(w.calls.startWatcher).toEqual([]);
  expect(w.calls.stopWatcher).toEqual([]);
  expect(w.logs.filter(line => line.includes("couldn't tell whether the watcher runs"))).toHaveLength(1);
  // A lookup that can tell again: none runs, so one is started.
  w.found.delete(room1);
  await w.run(30);
  expect(w.calls.startWatcher).toEqual([room1]);
  // The real lookup. Its command line decides when it can be read: a watcher for this room, or no watcher.
  const dir = tempDir(), room = { dir, roomId: room1 }, now = 5_000_000;
  writeFileSync(join(dir, 'watch.pid'), '4242');
  const alive = (pid: number) => pid === 4242, watcher = `bun /x/meshrooms.js watch-run --room ${room1}`, unread = () => { throw new Error('timed out'); };
  const base = { alive, commandLine: unread, state: () => undefined, pidWrittenAt: () => now - 1_000, now };
  expect(watcherLookup(room, { ...base, commandLine: () => watcher })).toEqual({ pid: 4242, how: 'command' });
  expect(watcherLookup(room, { ...base, commandLine: () => 'notepad.exe' })).toBeUndefined();
  expect(watcherLookup(room, { ...base, alive: () => false })).toBeUndefined();
  // Unreadable, with the watcher's own fresh proof of life naming that pid: ours, known by proof (never stopped on it).
  const beat = { pid: 4242, startedAt: now - 3_600_000, aliveAt: now - WATCHER_ALIVE_WITHIN_MS + 1_000 };
  expect(watcherLookup(room, { ...base, pidWrittenAt: () => now - 3_600_000, state: () => beat })).toEqual({ pid: 4242, how: 'proof' });
  for (const commandLine of [unread, () => '']) {
    // No proof yet, but watch.pid was just written: a watcher still starting, unknown, so no second one starts.
    expect(watcherLookup(room, { ...base, commandLine })).toEqual({ pid: 4242, how: 'unknown' });
    // An old watch.pid and no fresh proof (stale, another pid's, or the watcher recorded its stop): the pid is another
    // program's now, so the room has no watcher and the daemon starts one.
    const old = { ...base, commandLine, pidWrittenAt: () => now - 3_600_000 };
    expect(watcherLookup(room, old)).toBeUndefined();
    expect(watcherLookup(room, { ...old, state: () => ({ ...beat, aliveAt: now - WATCHER_ALIVE_WITHIN_MS - 1 }) })).toBeUndefined();
    expect(watcherLookup(room, { ...old, state: () => ({ ...beat, pid: 4243 }) })).toBeUndefined();
    expect(watcherLookup(room, { ...old, state: () => ({ ...beat, stoppedAt: now - 2_000 }) })).toBeUndefined();
    expect(watcherLookup(room, { ...old, pidWrittenAt: () => undefined })).toBeUndefined();
  }
});

test('the binding decides the watcher: on starts it, a change restarts it, off stops it and it stays stopped', async () => {
  const w = world([room1]);
  await w.run(4);
  expect(w.calls.startWatcher).toEqual([]);
  w.set(room1, { binding: on('b1') });
  await w.run(2);
  expect(w.calls.startWatcher).toEqual([room1]);
  const first = w.watchers.get(room1)!;
  // The same binding: nothing to do.
  await w.run(20);
  expect(w.calls.startWatcher).toHaveLength(1);
  // A new session (another stamp): the watcher is restarted once, with no backoff.
  w.set(room1, { binding: on('b2') });
  await w.run(2);
  expect(w.calls.stopWatcher).toEqual([{ roomId: room1, pid: first.pid }]);
  expect(w.calls.startWatcher).toHaveLength(2);
  // Off: stopped, and not started again however long it stays off.
  w.set(room1, { binding: { enabled: false, stamp: 'b2' } });
  await w.run(120);
  expect(w.calls.stopWatcher).toHaveLength(2);
  expect(w.calls.startWatcher).toHaveLength(2);
  expect(w.supervisor.status()[0].watcher).toMatchObject({ pid: null, wakes: 'off' });
  // Wakes off keeps the runner: unbinding never disconnects the agent.
  expect(w.calls.stopRunner).toEqual([]);
});

test('a watcher that crashes is started again with a backoff; one the binding refused under the lock is no failure', async () => {
  const w = world([room1]);
  w.set(room1, { binding: on() });
  await w.run(2);
  w.exit(w.watchers.get(room1)!);
  await w.run(2);
  expect(w.calls.startWatcher).toHaveLength(1);
  await w.run(2);
  expect(w.calls.startWatcher).toHaveLength(2);
  expect(w.supervisor.status()[0].watcher.restarts).toBe(1);
  expect(w.logs.some(line => line.includes('the watcher') && line.includes('exited (1)'))).toBe(true);
});

test('a closed room is let go: its watcher stopped, its runner not restarted, recorded once, and never brought back by a restarted daemon', async () => {
  const w = world([room1]);
  w.set(room1, { binding: on() });
  await w.run(2);
  w.set(room1, { closed: { at: 1, reason: 'This room was closed by its host.' } });
  w.exit(w.runners.get(room1)!);
  await w.run(120);
  expect(w.calls.repair).toHaveLength(1);
  expect(w.calls.stopWatcher).toHaveLength(1);
  expect(w.calls.stopRunner).toEqual([]);
  expect(w.calls.retire).toEqual([{ roomId: room1, state: 'closed' }]);
  expect(w.logs.filter(line => line.includes('no longer kept running'))).toHaveLength(1);
  expect(w.supervisor.status()[0]).toMatchObject({ state: 'closed', reason: expect.stringContaining('closed by its host') });
  // A new daemon: the room's retired.json says so, and nothing starts.
  const again = world([room1]);
  again.set(room1, { binding: on(), retired: { state: 'closed', reason: 'the room is closed' } });
  await again.run(120);
  expect(again.calls.repair).toEqual([]);
  expect(again.calls.startWatcher).toEqual([]);
  expect(again.supervisor.status()[0].state).toBe('closed');
});

test('a reason the room service gave reaches the daemon log as one inert line: no escapes, controls, bidi overrides or line breaks', async () => {
  const w = world([room1]);
  await w.run(2);
  w.set(room1, { closed: { at: 1, reason: 'closed\u001b[2J\u001b]8;;https://x.example\u0007link\u009b31m\u202eevil\nroom 0 forged line\u2028end' } });
  await w.run(2);
  const line = w.logs.find(entry => entry.includes('no longer kept running'))!;
  expect(line).toContain('closedlink31mevil room 0 forged line end');
  expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
});

test('an agent removed from the room is let go once the room has said so for a minute, and back after a new connect', async () => {
  const w = world([room1]);
  w.set(room1, { binding: on() });
  await w.run(2);
  w.set(room1, { removedSince: w.clock.now });
  await w.run(30);
  expect(w.calls.stopRunner).toEqual([]);
  await w.run(40);
  expect(w.calls.stopRunner).toEqual([room1]);
  expect(w.calls.stopWatcher).toHaveLength(1);
  expect(w.calls.retire).toEqual([{ roomId: room1, state: 'removed' }]);
  const repairs = w.calls.repair.length;
  await w.run(300);
  expect(w.calls.repair).toHaveLength(repairs);
  // connect again: room.json written anew, and the old proof no longer counts.
  w.set(room1, { stamp: 'room-2', removedSince: undefined });
  await w.run(4);
  expect(w.calls.repair.length).toBe(repairs + 1);
  expect(w.supervisor.status()[0].state).toBe('supervised');
});

test('a room its operator stopped is left alone, and supervised again once a command uses it', async () => {
  const w = world([room1]);
  w.set(room1, { binding: on() });
  await w.run(2);
  w.set(room1, { stopped: true });
  // `stop` stopped both itself; the daemon doesn't count that as a crash or start them again.
  w.exit(w.runners.get(room1)!); w.exit(w.watchers.get(room1)!);
  await w.run(300);
  expect(w.calls.repair).toHaveLength(1);
  expect(w.calls.startWatcher).toHaveLength(1);
  expect(w.supervisor.status()[0].state).toBe('stopped');
  w.set(room1, { stopped: false });
  await w.run(2);
  expect(w.calls.repair).toHaveLength(2);
  expect(w.calls.startWatcher).toHaveLength(2);
  expect(w.supervisor.status()[0].runner.restarts).toBe(1);
});

test('rooms connected later are picked up without a restart; a room whose folder is gone is no longer supervised', async () => {
  const w = world([room1]);
  await w.run(4);
  w.ids.push(room2);
  await w.run(2);
  expect(w.calls.repair.map(call => call.roomId)).toEqual([room1, room2]);
  w.ids.splice(0, 1);
  await w.run(2);
  expect(w.supervisor.status().map(r => r.roomId)).toEqual([room2]);
  expect(w.logs.some(line => line.includes(room1) && line.includes('no longer supervised'))).toBe(true);
});

test('many rooms due at once are looked up a few per tick, so one tick never runs every lookup', async () => {
  const ids = Array.from({ length: 6 }, (_, i) => `0190a000-0000-7000-8000-00000000001${i}`);
  const w = world(ids);
  await w.run(2);
  expect(w.calls.repair).toHaveLength(6);
  w.clock.now += DAEMON_TIMING.fullCheckMs;
  const before = w.calls.repair.length;
  await w.supervisor.tick();
  expect(w.calls.repair.length - before).toBe(DAEMON_TIMING.lookupsPerTick);
  await w.run(6);
  expect(w.calls.repair.length - before).toBe(6);
});

test('one owner starts the runner: the daemon whenever it runs, then a watcher, a command only when neither does, never a wake', async () => {
  expect(runnerOwner(true, () => true, () => true)).toBe('watcher');
  expect(runnerOwner(false, () => true, () => true)).toBe('daemon');
  expect(runnerOwner(false, () => true, () => false)).toBe('watcher');
  expect(runnerOwner(false, () => false, () => false)).toBe('command');
  // A command finds no runner while the daemon runs: it leaves the start to the daemon.
  const starts: number[] = [];
  const deps: RepairDeps = { inWake: false, watcherRuns: () => false, daemonRuns: () => true, probe: async () => true, lock: async work => work(),
    runner: () => undefined, stop: async () => true, start: async () => { starts.push(1); return 9; }, lastRepair: () => undefined, recordRepair: () => {},
    now: () => 0, log: () => {} };
  expect(await repairRunner(deps)).toEqual({ outcome: 'daemon' });
  const stuck: FoundRunner = { pid: 5, verified: true, stuck: true };
  expect(await repairRunner({ ...deps, runner: () => stuck })).toEqual({ outcome: 'daemon', pid: 5 });
  expect(starts).toEqual([]);
  expect((await repairRunner({ ...deps, daemonRuns: () => false })).outcome).toBe('started');
});

/** Runs `work` with the bridge's folders in `dir`: its agent folder, registry, and so the daemon's folder too. */
async function inFolders<T>(dir: string, work: () => Promise<T>) {
  const keys = ['MESHROOMS_AGENT_HOME', 'MESHROOMS_AGENT_REGISTRY', 'MESHROOMS_DAEMON_DIR'] as const;
  const saved = keys.map(key => process.env[key]);
  process.env.MESHROOMS_AGENT_HOME = join(dir, 'agents'); process.env.MESHROOMS_AGENT_REGISTRY = join(dir, 'agent-homes.json'); delete process.env.MESHROOMS_DAEMON_DIR;
  try { return await work(); } finally { keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; }); }
}
/** A daemon that looks alive to commands: this test process, with a fresh heartbeat, reading `registry`. */
function fakeDaemon(dir: string, registry: string, homes: string[] = []) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, DAEMON_RECORD), JSON.stringify({ pid: process.pid, startedAt: Date.now(), at: Date.now(), version: 'test', registry, homes, rooms: [] }));
}
function admittedRoom(home: string, roomId = crypto.randomUUID()) {
  const agent = new BrowserAgent(home, 'http://127.0.0.1:1', roomId);
  writeFileSync(join(agent.dir, 'room.json'), JSON.stringify({ origin: 'http://127.0.0.1:1', roomId }));
  const me = crypto.randomUUID();
  writeFileSync(join(agent.dir, 'members.json'), JSON.stringify({ memberId: me, ownerId: me, members: [{ id: me, name: 'Wren', role: 'agent' }], devices: [] }));
  return agent;
}

test('commands know the daemon by its pid and a fresh heartbeat, and defer only for the agent folders it looks after', () => {
  const dir = tempDir(), daemon = join(dir, 'daemon'), registry = join(dir, 'agent-homes.json'), home = join(dir, 'agents');
  expect(daemonDir({ MESHROOMS_AGENT_REGISTRY: registry })).toBe(resolve(daemon));
  expect(daemonDir({ MESHROOMS_DAEMON_DIR: join(dir, 'elsewhere') })).toBe(resolve(dir, 'elsewhere'));
  expect(runningDaemon(() => true, daemon)).toBeUndefined();
  writeFileSync(registry, JSON.stringify([home]));
  fakeDaemon(daemon, registry);
  expect(runningDaemon(() => true, daemon)?.pid).toBe(process.pid);
  expect(daemonSupervises(home, () => true, daemon)).toBe(true);
  expect(daemonSupervises(join(dir, 'other'), () => true, daemon)).toBe(false);
  // Its process gone, or its heartbeat stale, or stopped cleanly: not running.
  expect(daemonSupervises(home, () => false, daemon)).toBe(false);
  expect(daemonSupervises(home, () => true, daemon, Date.now() + 61_000)).toBe(false);
  const record = JSON.parse(readFileSync(join(daemon, DAEMON_RECORD), 'utf8'));
  writeFileSync(join(daemon, DAEMON_RECORD), JSON.stringify({ ...record, stoppedAt: Date.now() }));
  expect(runningDaemon(() => true, daemon)).toBeUndefined();
  // A folder it named itself (the default one, which an older bridge never recorded) counts too.
  writeFileSync(registry, '[]');
  fakeDaemon(daemon, registry, [home]);
  expect(daemonSupervises(home, () => true, daemon)).toBe(true);
});

test('while the daemon runs, the watcher and room commands leave the runner to it, and using the room undoes a stop', async () => {
  const dir = tempDir();
  await inFolders(dir, async () => {
    const agent = admittedRoom(join(dir, 'agents'));
    writeFileSync(join(dir, 'agent-homes.json'), JSON.stringify([join(dir, 'agents')]));
    fakeDaemon(join(dir, 'daemon'), join(dir, 'agent-homes.json'));
    const starts: number[] = [];
    const check = watcherRunnerCheck(agent, () => {}, { runner: () => undefined, start: async () => { starts.push(1); return 1; } });
    expect(await check()).toMatchObject({ outcome: 'daemon' });
    // stop: the room left alone (and wakes off) until a command uses it; that command then leaves the start to the daemon.
    writeFileSync(join(agent.dir, WATCH_CONFIG), JSON.stringify({ roomId: agent.roomId, harness: 'exec', enabled: true }));
    expect(await agentCli(['stop', '--room', agent.roomId])).toMatchObject({ stopped: false });
    expect(existsSync(join(agent.dir, ROOM_STOPPED))).toBe(true);
    expect(readBinding(agent.dir)?.enabled).toBe(false);
    await agentCli(['decisions', '--room', agent.roomId]);
    expect(existsSync(join(agent.dir, ROOM_STOPPED))).toBe(false);
    expect(existsSync(join(agent.dir, 'runner.pid'))).toBe(false);
    expect(starts).toEqual([]);
  });
});

test('watch with the daemon running records the binding and leaves the watcher to the daemon; watch-stop turns wakes off and keeps them off', async () => {
  const dir = tempDir();
  await inFolders(dir, async () => {
    const agent = admittedRoom(join(dir, 'agents'));
    writeFileSync(join(dir, 'agent-homes.json'), JSON.stringify([join(dir, 'agents')]));
    fakeDaemon(join(dir, 'daemon'), join(dir, 'agent-homes.json'));
    // The daemon would start the watcher; this one stands in for it by writing what a started watcher writes.
    writeFileSync(join(agent.dir, WATCH_STATE), JSON.stringify({ wakes: [], noProgress: 0, pid: process.pid, startedAt: Date.now() + 60_000 }));
    writeFileSync(join(agent.dir, ROOM_STOPPED), '{}');
    const result = await agentCli(['watch', '--room', agent.roomId, '--harness', 'exec', '--cwd', dir, '--command', `"${process.execPath}" agent.js {prompt_file}`]) as Record<string, unknown>;
    expect(result).toMatchObject({ watching: true, pid: process.pid, startedBy: 'daemon' });
    expect(readBinding(agent.dir)).toMatchObject({ enabled: true, harness: 'exec' });
    expect(existsSync(join(agent.dir, 'watch.pid'))).toBe(false);
    expect(existsSync(join(agent.dir, ROOM_STOPPED))).toBe(false);
    const stamp = readBinding(agent.dir)!.stamp;
    expect(await agentCli(['watch-stop', '--room', agent.roomId])).toMatchObject({ wakes: 'off' });
    expect(readBinding(agent.dir)).toMatchObject({ enabled: false, stamp });
    expect(await agentCli(['watch-status', '--room', agent.roomId])).toMatchObject({ wakes: 'off', supervisedBy: 'daemon' });
    // watch-stop revoked what watch authorised: turning `enabled` back on in the file doesn't turn wakes on.
    const stopped = JSON.parse(readFileSync(join(agent.dir, WATCH_CONFIG), 'utf8'));
    writeFileSync(join(agent.dir, WATCH_CONFIG), JSON.stringify({ ...stopped, enabled: true, offReason: undefined }));
    expect(readBinding(agent.dir)).toMatchObject({ enabled: false, untrusted: true, offReason: UNTRUSTED_OFF });
    expect(disableBinding(join(dir, 'nowhere'))).toBe(false);
  });
});

test('a log is kept bounded while a process holds it open in append mode: the old part moves to .1, new lines go on in the log', () => {
  const dir = tempDir(), log = join(dir, 'runner.log');
  const fd = openSync(log, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND);
  try {
    writeSync(fd, 'a'.repeat(2_000));
    expect(rotateLog(log, 1_000)).toBe(true);
    writeSync(fd, 'after');
    expect(readFileSync(`${log}.1`, 'utf8')).toBe('a'.repeat(2_000));
    expect(readFileSync(log, 'utf8')).toBe('after');
    expect(rotateLog(log, 1_000)).toBe(false);
  } finally { closeSync(fd); }
});

test('the daemon starts at login on every system, from files written only where the test says, and never from the installing shell\'s environment alone', () => {
  const dir = tempDir();
  const item = { name: 'meshrooms-daemon', label: 'dev.wormdb.meshrooms.agent-daemon', description: 'Meshrooms agent daemon', dir: join(dir, 'daemon'),
    args: ['/opt/bun dir/bun', '/srv/agent tools/bin/meshrooms.js', 'daemon', 'run'], windowsArgs: ['C:\\bun\\bun.exe', "C:\\Tools\\o'k\\meshrooms.js", 'daemon', 'start'],
    log: join(dir, 'daemon', 'daemon.out.log'), env: { PATH: '/usr/bin:/opt/100%$x' } };
  // Linux: a systemd user unit, enabled through systemctl --user; KillMode=process keeps the runners up across a restart.
  const calls: string[][] = [], enabled = { value: false };
  const systemctl: Exec = (file, args) => {
    calls.push([file, ...args]);
    if (args.includes('enable')) enabled.value = true;
    if (args.includes('disable')) enabled.value = false;
    return { status: 0, stdout: args.includes('is-enabled') ? (enabled.value ? 'enabled\n' : 'disabled\n') : '' };
  };
  const linux = loginItemManager(item, { platform: 'linux', home: dir, env: {}, run: systemctl });
  expect(linux.where).toBe(join(dir, '.config', 'systemd', 'user', 'meshrooms-daemon.service'));
  expect(linux.status().installed).toBe(false);
  expect(linux.apply(true).installed).toBe(true);
  const unit = readFileSync(linux.where, 'utf8');
  expect(unit).toContain('ExecStart="/opt/bun dir/bun" "/srv/agent tools/bin/meshrooms.js" "daemon" "run"');
  expect(unit).toContain('Environment="PATH=/usr/bin:/opt/100%%$$x"');
  expect(unit).toContain('KillMode=process');
  expect(unit).toContain('Restart=on-failure');
  expect(calls).toContainEqual(['systemctl', '--user', 'enable', '--now', 'meshrooms-daemon.service']);
  // Another shell's PATH doesn't make a working entry look broken; another program does.
  const other = loginItemManager({ ...item, env: { PATH: '/bin' } }, { platform: 'linux', home: dir, env: {}, run: systemctl });
  expect(other.status().installed).toBe(true);
  writeFileSync(linux.where, unit.replace('"run"', '"other"'));
  expect(linux.status()).toMatchObject({ installed: false, message: expect.stringContaining('repair') });
  expect(linux.apply(false).installed).toBe(false);
  expect(existsSync(linux.where)).toBe(false);
  const disable = calls.findIndex(call => call.includes('disable'));
  expect(disable).toBeGreaterThan(-1);
  expect(systemdUnit('x', ['a'])).not.toContain('Environment=');
  // macOS: a LaunchAgent with RunAtLoad and KeepAlive on failure, and the PATH launchd wouldn't give it.
  const mac = loginItemManager(item, { platform: 'darwin', home: dir, run: () => ({ status: 0, stdout: '' }) });
  expect(mac.apply(true).installed).toBe(true);
  const plist = readFileSync(mac.where, 'utf8');
  expect(mac.where).toBe(join(dir, 'Library', 'LaunchAgents', 'dev.wormdb.meshrooms.agent-daemon.plist'));
  expect(plist).toContain('<string>/opt/bun dir/bun</string>');
  expect(plist).toContain('<key>PATH</key><string>/usr/bin:/opt/100%$x</string>');
  expect(plist).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>');
  expect(loginItemManager({ ...item, env: {} }, { platform: 'darwin', home: dir, run: () => ({ status: 0, stdout: '' }) }).status().installed).toBe(true);
  expect(mac.apply(false).installed).toBe(false);
  // Windows: a Run key value starting a hidden PowerShell script that starts the daemon in the background.
  const values = new Map<string, string>();
  const reg: Exec = (_file, args) => {
    const [verb, , , name, ...rest] = args;
    if (verb === 'add') { values.set(name, rest[rest.indexOf('/d') + 1]); return { status: 0, stdout: '' }; }
    if (verb === 'delete') { values.delete(name); return { status: 0, stdout: '' }; }
    return values.has(name) ? { status: 0, stdout: `${name} REG_SZ ${values.get(name)}` } : { status: 1, stdout: '' };
  };
  const windows = loginItemManager(item, { platform: 'win32', home: dir, run: reg, host: { supported: true } });
  expect(windows.apply(true).installed).toBe(true);
  expect(values.get('meshrooms-daemon')).toContain(`-WindowStyle Hidden -File "${windows.where}"`);
  expect(readFileSync(windows.where, 'utf8')).toBe("$ErrorActionPreference = 'Stop'\n$env:PATH = '/usr/bin:/opt/100%$x'\n& 'C:\\bun\\bun.exe' 'C:\\Tools\\o''k\\meshrooms.js' 'daemon' 'start'\nexit $LASTEXITCODE\n");
  // PowerShell ends a single-quoted string at a typographic single quote too (U+2018 to U+201B): each is doubled.
  for (const quote of ['\u2018', '\u2019', '\u201a', '\u201b']) expect(quotePS(`a${quote}b`)).toBe(`'a${quote}${quote}b'`);
  expect(quotePS("it's")).toBe("'it''s'");
  expect(windows.apply(false).installed).toBe(false);
  expect(values.size).toBe(0);
});

test('the real daemon: one per user, seen by status, stopped by stop, and a crashed one\'s lock taken over by the next', async () => {
  const dir = tempDir(), registry = join(dir, 'agent-homes.json'), daemon = join(dir, 'daemon');
  writeFileSync(registry, '[]');
  const env: Record<string, string | undefined> = { ...process.env, MESHROOMS_AGENT_REGISTRY: registry, MESHROOMS_AGENT_HOME: join(dir, 'agents') };
  delete env.MESHROOMS_DAEMON_DIR;
  const cli = join(import.meta.dir, '..', 'agent-cli.ts');
  const pids: number[] = [];
  const spawnDaemon = () => {
    const child = spawn(process.execPath, [cli, 'daemon', 'run'], { env, stdio: 'ignore', detached: true, windowsHide: true });
    child.unref(); pids.push(child.pid!); return child.pid!;
  };
  const until = async <T>(look: () => T | undefined) => { for (const by = Date.now() + 30_000; Date.now() < by; await Bun.sleep(100)) { const seen = look(); if (seen) return seen; } throw new Error('timed out'); };
  try {
    const first = spawnDaemon();
    await until(() => runningDaemon(processRuns, daemon)?.pid === first);
    await inFolders(dir, async () => {
      expect(await agentCli(['daemon', 'status'])).toMatchObject({ running: true, pid: first, rooms: [] });
    });
    // A second one finds the lock held and leaves.
    const second = spawnDaemon();
    await until(() => !processRuns(second) || undefined);
    expect(processRuns(first)).toBe(true);
    // A crash leaves the lock behind; the next daemon takes it over.
    process.kill(first, 'SIGKILL');
    await until(() => !processRuns(first) || undefined);
    const third = spawnDaemon();
    await until(() => runningDaemon(processRuns, daemon)?.pid === third);
    await inFolders(dir, async () => {
      expect(await agentCli(['daemon', 'stop'])).toMatchObject({ stopped: true, pid: third });
      expect(await agentCli(['daemon', 'status'])).toMatchObject({ running: false, pid: null });
    });
    // A lock naming a live process that isn't the daemon (here this test's own process) is kept while the daemon's
    // heartbeat is fresh: whatever runs, a daemon that beats recently has it.
    writeFileSync(join(daemon, DAEMON_LOCK), String(process.pid));
    const record = { pid: process.pid, startedAt: Date.now(), at: Date.now(), version: 'test', registry, rooms: [] };
    writeFileSync(join(daemon, DAEMON_RECORD), JSON.stringify(record));
    const kept = spawnDaemon();
    await until(() => !processRuns(kept) || undefined);
    expect(readFileSync(join(daemon, DAEMON_LOCK), 'utf8')).toBe(String(process.pid));
    // After a reboot the lock's pid can be another program's: with no recent heartbeat, the next daemon takes the lock
    // over rather than leaving for good.
    writeFileSync(join(daemon, DAEMON_RECORD), JSON.stringify({ ...record, at: Date.now() - 120_000 }));
    const fourth = spawnDaemon();
    await until(() => runningDaemon(processRuns, daemon)?.pid === fourth);
  } finally { for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch { /* Gone. */ } }
}, 90_000);

test('a lock is taken over only from a holder that is gone, or that the caller proves is not one (a reused pid)', () => {
  const lock = join(tempDir(), 'some.lock');
  writeFileSync(lock, String(process.pid));
  expect(tryLock(lock, 'test')).toBe(false);
  expect(tryLock(lock, 'test', () => false)).toBe(false);
  expect(tryLock(lock, 'test', pid => pid === process.pid)).toBe(true);
  expect(readFileSync(lock, 'utf8')).toBe(String(process.pid));
});

test('a binding is on only when watch turned it on: upgrading turns an earlier watch.json off once, and its watcher is stopped', async () => {
  const dir = tempDir(), trust = join(tempDir(), 'daemon'), write = (config: object) => writeFileSync(join(dir, WATCH_CONFIG), JSON.stringify(config));
  // Fail closed: a file without `enabled`, or with anything but true, is off.
  write({ roomId: room1, harness: 'claude' });
  expect(readBinding(dir, trust)).toMatchObject({ enabled: false, legacy: true });
  write({ roomId: room1, harness: 'claude', enabled: 'yes' });
  expect(readBinding(dir, trust)?.enabled).toBe(false);
  // An earlier watch.json: off, with a reason that names the command that turns it on, and never migrated again. No
  // earlier bridge recorded what its operator authorised, so it reads as from an earlier watch, not as tampered with.
  write({ roomId: room1, harness: 'claude', command: 'original' });
  expect(migrateLegacyBinding(dir, trust)).toBe('off');
  expect(readBinding(dir, trust)).toMatchObject({ enabled: false, offReason: LEGACY_OFF });
  expect(LEGACY_OFF).toContain('run watch');
  expect(UNTRUSTED_OFF).toContain('run watch');
  expect(readBinding(dir, trust)?.legacy).toBeUndefined();
  expect(migrateLegacyBinding(dir, trust)).toBeUndefined();
  expect(readBinding(dir, trust)?.enabled).toBe(false);
  // A trust record that can't be read makes the binding off, and its watcher's fence says stop.
  const on = { roomId: room1, harness: 'claude', command: 'original', enabled: true };
  authorizeBinding(dir, on, trust);
  write(on);
  const stamp = readBinding(dir, trust)!.stamp, fence = bindingFence(dir, stamp, trust);
  expect(readBinding(dir, trust)?.enabled).toBe(true);
  expect(fence()).toBeUndefined();
  for (const name of readdirSync(join(trust, BINDING_RECORDS))) writeFileSync(join(trust, BINDING_RECORDS, name), '{not json');
  expect(readBinding(dir, trust)).toMatchObject({ enabled: false, untrusted: true });
  expect(fence()).toContain('wakes are off');
  rmSync(join(dir, WATCH_CONFIG));
  expect(fence()).toContain('wakes are off');
  // The supervisor migrates before it acts: no watcher is started for either legacy room, and one that still runs
  // (an earlier bridge's) is stopped.
  const w = world([room1, room2]);
  w.set(room1, { binding: { enabled: false, legacy: true, stamp: 'old' } });
  w.set(room2, { binding: { enabled: false, legacy: true, stamp: 'old' } });
  w.found.set(room2, 777);
  await w.run(20);
  expect(w.calls.migrate.filter(id => id === room1)).toHaveLength(1);
  expect(w.calls.startWatcher).toEqual([]);
  expect(w.calls.stopWatcher).toEqual([{ roomId: room2, pid: 777 }]);
  for (const id of [room1, room2]) expect(w.supervisor.status().find(r => r.roomId === id)?.watcher).toMatchObject({ wakes: 'off', pid: null });
  expect(w.logs.some(line => line.includes(LEGACY_OFF))).toBe(true);
});

test('watch is what turns wakes on: before it the daemon starts nothing, after it the binding says enabled: true', async () => {
  const dir = tempDir();
  await inFolders(dir, async () => {
    const agent = admittedRoom(join(dir, 'agents'));
    writeFileSync(join(dir, 'agent-homes.json'), JSON.stringify([join(dir, 'agents')]));
    fakeDaemon(join(dir, 'daemon'), join(dir, 'agent-homes.json'));
    writeFileSync(join(agent.dir, WATCH_CONFIG), JSON.stringify({ roomId: agent.roomId, harness: 'exec' }));
    expect(await agentCli(['watch-status', '--room', agent.roomId])).toMatchObject({ wakes: 'off', offReason: LEGACY_OFF });
    writeFileSync(join(agent.dir, WATCH_STATE), JSON.stringify({ wakes: [], noProgress: 0, pid: process.pid, startedAt: Date.now() + 60_000 }));
    await agentCli(['watch', '--room', agent.roomId, '--harness', 'exec', '--cwd', dir, '--command', `"${process.execPath}" agent.js {prompt_file}`]);
    expect(JSON.parse(readFileSync(join(agent.dir, WATCH_CONFIG), 'utf8')).enabled).toBe(true);
    expect(readBinding(agent.dir)?.offReason).toBeUndefined();
  });
});

test('the processes the bridge starts never take values from a .env where the command ran, nor inherited MESHROOMS_* overrides', async () => {
  const dir = tempDir(), project = join(dir, 'project');
  mkdirSync(project);
  writeFileSync(join(project, '.env'), 'MESHROOMS_BIN_DIR=/somewhere/else\nCODEX_HOME="/hostile/codex"\nSHARED=from-file\n');
  const inherited = { PATH: '/usr/bin', MESHROOMS_BIN_DIR: '/somewhere/else', MESHROOMS_AGENT_REGISTRY: '/other/registry', CODEX_HOME: '/hostile/codex', SHARED: 'from-shell', KEEP: 'yes' };
  const env = bridgeEnv({ MESHROOMS_AGENT_HOME: '/agents/a' }, inherited, project);
  expect(env).toEqual({ PATH: '/usr/bin', SHARED: 'from-shell', KEEP: 'yes', MESHROOMS_AGENT_HOME: '/agents/a' });
  // And Bun itself loads no .env for them: started with --no-env-file, from a folder that has one, the child sees none of it.
  const script = join(dir, 'probe.js');
  writeFileSync(script, 'process.stdout.write(JSON.stringify({ bin: process.env.MESHROOMS_BIN_DIR ?? null, codex: process.env.CODEX_HOME ?? null }))');
  const base = bridgeEnv({}, process.env, project);
  delete base.CODEX_HOME;
  const child = spawn(process.execPath, [BUN_NO_ENV_FILE, script], { cwd: project, env: base, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let out = '';
  child.stdout!.on('data', chunk => { out += chunk; });
  await new Promise(done => child.once('close', done));
  expect(JSON.parse(out)).toEqual({ bin: null, codex: null });
  // Runners, watchers and the daemon started that way are still recognized as ours.
  expect(isRunnerCommand(`"${process.execPath}" --no-env-file "C:\\Tools\\bin\\meshrooms.js" run --room ${room1}`, room1)).toBe(true);
  expect(isRunnerCommand(`/opt/bun/bun --no-env-file /srv/bin/meshrooms.js watch-run --room ${room1}`, room1, 'watch-run')).toBe(true);
  expect(isDaemonCommand('/opt/bun/bun --no-env-file /srv/bin/meshrooms.js daemon run')).toBe(true);
  expect(isDaemonCommand('/opt/bun/bun --no-env-file /srv/bin/meshrooms.js daemon run --bin-dir /srv/bin')).toBe(true);
  expect(isDaemonCommand('/opt/bun/bun /srv/bin/meshrooms.js listen --room x')).toBe(false);
});

test('the login item keeps no environment from the shell that installed it, and a bridge folder other than the default only from a checked --bin-dir', () => {
  const dir = tempDir(), cwd = process.cwd(), saved = process.env.MESHROOMS_BIN_DIR;
  const project = join(dir, 'project');
  mkdirSync(project);
  writeFileSync(join(project, '.env'), 'MESHROOMS_BIN_DIR=/somewhere/else\n');
  process.env.MESHROOMS_BIN_DIR = '/somewhere/else';
  process.chdir(project);
  try {
    const run: Exec = () => ({ status: 0, stdout: 'enabled\n' });
    const item = daemonLoginItem(join(dir, 'daemon'), undefined, { platform: 'linux', home: dir, env: {}, run });
    item.apply(true);
    const unit = readFileSync(item.where, 'utf8');
    expect(unit).not.toContain('Environment=');
    expect(unit).not.toContain('/somewhere/else');
    expect(unit).toContain(`ExecStart="${process.execPath.replaceAll('\\', '\\\\')}" "--no-env-file" `);
    const mac = daemonLoginItem(join(dir, 'daemon'), undefined, { platform: 'darwin', home: dir, run: () => ({ status: 0, stdout: '' }) });
    mac.apply(true);
    const plist = readFileSync(mac.where, 'utf8');
    expect(plist).not.toContain('EnvironmentVariables');
    expect(plist).not.toContain('/somewhere/else');
    expect(plist).toContain('<string>--no-env-file</string>');
  } finally {
    process.chdir(cwd);
    if (saved === undefined) delete process.env.MESHROOMS_BIN_DIR; else process.env.MESHROOMS_BIN_DIR = saved;
  }
  // --bin-dir: absolute, an existing folder inside the home folder, the user's own and not writable by others.
  const home = join(dir, 'home'), bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  const uid = 1000, ok = { isDirectory: () => true, uid, mode: 0o40700 };
  expect(trustedBinDir(bin, home, 'linux', () => ok, uid)).toBe(realpathSync(bin));
  expect(() => trustedBinDir('bin', home, 'linux', () => ok, uid)).toThrow('absolute');
  expect(() => trustedBinDir(join(dir, 'elsewhere'), home, 'linux', () => ok, uid)).toThrow('inside your home');
  expect(() => trustedBinDir(bin, home, 'linux', () => ({ ...ok, mode: 0o40775 }), uid)).toThrow('writable by group or others');
  expect(() => trustedBinDir(bin, home, 'linux', () => ({ ...ok, uid: uid + 1 }), uid)).toThrow('belong to you');
  expect(() => trustedBinDir(join(home, 'missing'), home, 'linux')).toThrow("doesn't exist");
  expect(trustedBinDir(bin, home, 'win32')).toBe(realpathSync(bin));
});

test('a binding changed outside watch is not run: the daemon and the watcher both read it as off until watch authorises it again', async () => {
  const dir = tempDir();
  await inFolders(dir, async () => {
    const agent = admittedRoom(join(dir, 'agents'));
    writeFileSync(join(dir, 'agent-homes.json'), JSON.stringify([join(dir, 'agents')]));
    fakeDaemon(join(dir, 'daemon'), join(dir, 'agent-homes.json'));
    writeFileSync(join(agent.dir, WATCH_STATE), JSON.stringify({ wakes: [], noProgress: 0, pid: process.pid, startedAt: Date.now() + 60_000 }));
    const watch = () => agentCli(['watch', '--room', agent.roomId, '--harness', 'exec', '--cwd', dir, '--command', `"${process.execPath}" agent.js {prompt_file}`]);
    await watch();
    expect(readBinding(agent.dir)).toMatchObject({ enabled: true });
    // The authorisation lives in the daemon's folder, not the room's.
    expect(readdirSync(join(dir, 'daemon', BINDING_RECORDS))).toHaveLength(1);
    // Someone plants another command in watch.json, still saying enabled: true.
    const config = JSON.parse(readFileSync(join(agent.dir, WATCH_CONFIG), 'utf8'));
    writeFileSync(join(agent.dir, WATCH_CONFIG), JSON.stringify({ ...config, command: 'planted {prompt_file}' }));
    expect(readBinding(agent.dir)).toMatchObject({ enabled: false, untrusted: true, offReason: UNTRUSTED_OFF });
    expect(await agentCli(['watch-status', '--room', agent.roomId])).toMatchObject({ wakes: 'off', offReason: UNTRUSTED_OFF });
    // The watcher refuses to start on it, before running anything.
    await expect(agentCli(['watch-run', '--room', agent.roomId])).rejects.toThrow(UNTRUSTED_OFF);
    // So does the daemon: its startWatcher reads the same binding (the supervisor never wants a watcher for it).
    const w = world([room1]);
    w.set(room1, { binding: { enabled: false, untrusted: true, offReason: UNTRUSTED_OFF, stamp: 'planted' } });
    await w.run(10);
    expect(w.calls.startWatcher).toEqual([]);
    // Each field that decides what runs counts, not just the command.
    for (const change of [{ program: '/elsewhere/claude' }, { harness: 'claude' }, { session: 'other' }, { cwd: dir + 'x' }, { allowTools: ['Bash(*)'] }]) {
      writeFileSync(join(agent.dir, WATCH_CONFIG), JSON.stringify({ ...config, ...change }));
      expect(readBinding(agent.dir)?.enabled).toBe(false);
    }
    // watch authorises it again.
    await watch();
    expect(readBinding(agent.dir)).toMatchObject({ enabled: true });
    expect(readBinding(agent.dir)?.untrusted).toBeUndefined();
  });
});

test('a watcher stops before its next wake once its binding is off or changed, and wakes nothing more', async () => {
  const dir = tempDir(), trust = join(dir, 'daemon'), roomDir = join(dir, 'room');
  mkdirSync(roomDir);
  const config = { roomId: room1, harness: 'exec', command: 'agent {prompt_file}', enabled: true };
  authorizeBinding(roomDir, config, trust);
  writeFileSync(join(roomDir, WATCH_CONFIG), JSON.stringify(config));
  const binding = readBinding(roomDir, trust)!, fence = bindingFence(roomDir, binding.stamp, trust);
  expect(binding.enabled).toBe(true);
  expect(fence()).toBeUndefined();
  // A loop with work always pending, whose first run turns wakes off midway (unbind while it runs).
  const clock = { now: 0 }, runs: number[] = [];
  let cursor = 0;
  const deps: WatchDeps = {
    now: () => clock.now, sleep: async ms => { clock.now += ms; await Promise.resolve(); },
    peek: () => ({ admitted: true, work: true, state: 'addressed', addressed: [crypto.randomUUID()], tasks: [], decisions: [] }),
    cursor: () => String(cursor), restoreCursor: () => {}, ownActions: () => runs.length,
    activity: { idle: () => {}, working: () => {}, touch: () => {}, setNote: () => {}, currentNote: () => undefined },
    run: async onStart => { onStart(1); runs.push(clock.now); cursor++; if (runs.length === 1) disableBinding(roomDir, undefined, trust); return { exitCode: 0 }; },
    ensureRunner: async () => {}, runAlive: () => false, killRun: () => {},
    agentWakes: { recent: () => 0, add: () => {} }, claimSession: () => ({ started: () => {}, release: () => {} }),
    log: () => {}, readState: () => emptyState(), writeState: () => {},
    stopped: () => !!fence() || clock.now > 600_000,
  };
  expect(await watchLoop({ maxWakesPerHour: 100, maxAgentWakesPerHour: 100, harness: 'exec' }, deps)).toBe('stopped');
  expect(runs).toHaveLength(1);
  expect(clock.now).toBeLessThan(600_000);
  expect(fence()).toContain('wakes are off');
  // A binding edited under a running watcher stops it too.
  authorizeBinding(roomDir, config, trust);
  writeFileSync(join(roomDir, WATCH_CONFIG), JSON.stringify(config));
  expect(fence()).toBeUndefined();
  writeFileSync(join(roomDir, WATCH_CONFIG), JSON.stringify({ ...config, command: 'planted {prompt_file}' }));
  expect(fence()).toContain(UNTRUSTED_OFF);
});

test('no wake can write a binding or read the daemon\'s records: watch.json is outside every wake-writable folder, and the daemon\'s folder is denied', () => {
  const home = tempDir(), agentHome = join(home, '.meshrooms', 'agents'), roomDir = join(agentHome, 'browser-agents', room1), bin = join(home, '.meshrooms', 'bin');
  const daemon = join(home, '.meshrooms', 'daemon');
  for (const path of [roomDir, bin, join(daemon, BINDING_RECORDS)]) mkdirSync(path, { recursive: true });
  const inside = (path: string, dir: string) => resolve(path).toLowerCase().startsWith(resolve(dir).toLowerCase() + (process.platform === 'win32' ? '\\' : '/'));
  for (const sub of WAKE_WRITABLE) {
    expect(resolve(roomDir, sub)).not.toBe(resolve(roomDir));
    expect(inside(join(roomDir, WATCH_CONFIG), join(roomDir, sub))).toBe(false);
  }
  // Codex's sandbox: exactly those folders writable, never the room folder itself or the daemon's.
  const config = { roomId: room1, harness: 'codex' as const, cwd: join(roomDir, 'wake'), maxWakesPerHour: 1, maxAgentWakesPerHour: 1, runTimeoutMinutes: 1, allowTools: [],
    launcher: join(bin, 'meshrooms.js'), agentHome, binDir: bin, roomDir };
  const denies = wakeReadDenies(config, home, join(home, '.codex'), { knownHomes: [] });
  const invocation = harnessInvocation(config, 'p', 'f', name => ({ file: name, prefix: [] }), { denyRead: denies });
  const filesystem = invocation.args.find(arg => arg.startsWith(`permissions.${CODEX_PROFILE}.filesystem=`))!;
  const writable = [...filesystem.matchAll(/"([^"]+)" = "write"/g)].map(m => JSON.parse(`"${m[1]}"`));
  expect(writable.map(path => resolve(path))).toEqual(WAKE_WRITABLE.map(sub => resolve(roomDir, sub)));
  // The daemon's folder in ~/.meshrooms is denied by the walk; one elsewhere is denied when named.
  expect(denies.some(d => resolve(d.path) === resolve(daemon) && d.dir)).toBe(true);
  const elsewhere = join(home, 'daemon-elsewhere');
  mkdirSync(elsewhere);
  expect(wakeReadDenies(config, home, join(home, '.codex'), { knownHomes: [], extra: [elsewhere] }).some(d => resolve(d.path) === resolve(elsewhere))).toBe(true);
});

test('bindings lists every agent the machine knows: its binding, wakes and why, runner, last wake and pending work, as JSON or a table', async () => {
  const dir = tempDir();
  await inFolders(dir, async () => {
    const bound = admittedRoom(join(dir, 'agents')), other = admittedRoom(join(dir, 'agents-two'));
    writeFileSync(join(dir, 'agent-homes.json'), JSON.stringify([join(dir, 'agents'), join(dir, 'agents-two')]));
    writeFileSync(join(bound.dir, WATCH_STATE), JSON.stringify({ wakes: [], noProgress: 0, pid: process.pid, startedAt: Date.now() + 60_000, lastWake: 1_700_000_000_000,
      obligations: { a: { kind: 'message', offers: 1 }, b: { kind: 'message', offers: 2, flaggedAt: 1 } } }));
    fakeDaemon(join(dir, 'daemon'), join(dir, 'agent-homes.json'));
    const first = await agentCli(['bind', '--room', bound.roomId, '--harness', 'exec', '--cwd', dir, '--command', `"${process.execPath}" agent.js {prompt_file}`]) as Record<string, unknown>;
    expect(first).toMatchObject({ bound: true, previously: 'unbound' });
    // Rebinding says what changed.
    const again = await agentCli(['bind', '--room', bound.roomId, '--harness', 'exec', '--cwd', join(dir, 'agents'), '--command', `"${process.execPath}" agent.js {prompt_file}`]) as Record<string, unknown>;
    expect(again).toMatchObject({ previously: 'on', changed: { folder: { from: dir, to: join(dir, 'agents') } } });
    const list = await agentCli(['bindings', '--json']) as { daemon: { pid: number } | null; bindings: Record<string, unknown>[] };
    expect(list.daemon?.pid).toBe(process.pid);
    const rows = new Map(list.bindings.map(row => [row.roomId, row]));
    expect(rows.get(bound.roomId)).toMatchObject({ agent: 'Wren', harness: 'exec', wakes: { state: 'on' }, supervisedBy: 'daemon', runner: null,
      lastWake: new Date(1_700_000_000_000).toISOString(), pending: { offeredAgain: 1, flagged: 1 } });
    expect(rows.get(other.roomId)).toMatchObject({ wakes: { state: 'unbound' }, harness: null });
    // unbind: wakes off with the reason, the agent kept.
    expect(await agentCli(['unbind', '--room', bound.roomId])).toMatchObject({ wakes: 'off' });
    const after = await agentCli(['bindings', '--json']) as { bindings: { roomId: string; wakes: { state: string; reason?: string } }[] };
    expect(after.bindings.find(row => row.roomId === bound.roomId)?.wakes).toMatchObject({ state: 'off', reason: 'turned off with unbind' });
    expect(existsSync(join(bound.dir, 'room.json'))).toBe(true);
  });
});

test('bindings never changes a room folder, lists past a damaged one, and prints names, titles and reasons inert; bind warns when the session is bound to another room too', async () => {
  const dir = tempDir();
  await inFolders(dir, async () => {
    const first = admittedRoom(join(dir, 'agents')), second = admittedRoom(join(dir, 'agents')), damaged = admittedRoom(join(dir, 'agents'));
    writeFileSync(join(dir, 'agent-homes.json'), JSON.stringify([join(dir, 'agents')]));
    for (const room of [first, second]) writeFileSync(join(room.dir, WATCH_STATE), JSON.stringify({ wakes: [], noProgress: 0, pid: process.pid, startedAt: Date.now() + 60_000 }));
    fakeDaemon(join(dir, 'daemon'), join(dir, 'agent-homes.json'));
    const bind = (room: BrowserAgent) => agentCli(['bind', '--room', room.roomId, '--harness', 'exec', '--cwd', dir, '--command', `"${process.execPath}" agent.js {prompt_file}`]) as Promise<{ warnings?: string[] }>;
    expect((await bind(first)).warnings ?? []).toEqual([]);
    // The same session: the rooms would share one conversation, and bind says so.
    expect((await bind(second)).warnings?.some(w => w.includes(first.roomId) && w.includes('share one conversation'))).toBe(true);
    // Text anyone in the room can set, with a bidi override, a CSI and a line separator in it.
    const members = JSON.parse(readFileSync(join(first.dir, 'members.json'), 'utf8'));
    writeFileSync(join(first.dir, 'members.json'), JSON.stringify({ ...members, title: 'Plans \u202egnp.exe\u202c', members: [{ ...members.members[0], name: 'Wren\u009b2J\u2028x' }] }));
    writeFileSync(join(first.dir, WATCH_STATE), JSON.stringify({ wakes: [], noProgress: 0, halted: { reason: 'harness said \u001b]0;title\u0007 \u202eevil', at: 1 } }));
    // A watch.json edited by hand into something no binding is: the listing goes on.
    writeFileSync(join(damaged.dir, WATCH_CONFIG), JSON.stringify({ harness: 'exec', command: 42, session: 7, cwd: dir, enabled: true }));
    rmSync(join(second.dir, 'outbox'), { recursive: true });
    const list = await agentCli(['bindings', '--json']) as { bindings: { roomId: string; title: string | null; agent: string | null; wakes: { state: string; reason?: string } }[] };
    expect(existsSync(join(second.dir, 'outbox'))).toBe(false);
    expect(list.bindings.map(row => row.roomId).sort()).toEqual([first.roomId, second.roomId, damaged.roomId].sort());
    const row = list.bindings.find(r => r.roomId === first.roomId)!;
    const unsafe = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
    expect(row).toMatchObject({ title: 'Plans gnp.exe', wakes: { state: 'halted' } });
    for (const text of [row.title, row.agent, row.wakes.reason]) expect(unsafe.test(text ?? '')).toBe(false);
    expect(/[\u2028\u2029]/.test(row.agent ?? '')).toBe(false);
    const table = bindingsTable(list as unknown as Parameters<typeof bindingsTable>[0]);
    expect(unsafe.test(table)).toBe(false);
    expect(/[\u2028\u2029]/.test(table)).toBe(false);
    expect(table).toContain('Plans gnp.exe');
    // Straight through the table too, for a list that didn't come from listBindings.
    const raw = { daemon: null, bindings: [{ roomId: first.roomId, title: 'a\u202eb\u009bc', agent: 'W\u001b[31mren', harness: 'exec', session: null, wakes: { state: 'halted', reason: 'x\u009d0;t\u0007\u202ey\nz' },
      runner: null, lastWake: null, pending: { now: false, offeredAgain: 0, flagged: 0 } }] };
    const printed = bindingsTable(raw);
    expect(unsafe.test(printed)).toBe(false);
    expect(printed).toContain('abc');
    expect(printed).toContain('Wren');
  });
});
