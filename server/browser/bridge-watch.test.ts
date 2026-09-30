import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { taskBody } from '../../src/browser/board';
import { openDecision } from '../../src/browser/decisions';
import { BrowserAgent, listenRemembering, noteDropped, outboxProblem, peekWork, queuedMaySpeak, takeDropped } from '../browser-agent';
import { claimIssueTask, releaseIssueTask } from '../github-issues';
import { agentCli, cwdExposes, envProject, insideDir, newerThreadWarning, ourProcess, runnerOwner, startFromNow, wakeGuard, ALIVE_WITHIN_MS, START_SETTLE_MS } from '../agent-cli';
import {
  CLAUDE_DENIED, CODEX_DISABLED, CODEX_PROFILE, PAUSED_NOTE, WATCH_TIMING, appendNoFollow, claudeReadRules, claudeRulePath, clearDir, codexBase, codexConfig, codexThread, killTree, reapGroup,
  runFingerprint, sameRun, wakeReadDenies, agentHomesFile, codexEnvDenies, envProjectProblem, knownAgentHomes, recordAgentHome, stopOwnChild, type KillDeps, emptyState, harnessInvocation, heredocMarker, launcherRules, newestCodexThread,
  openFresh, readHarnessOutput, resolveProgram, runProgram, sessionClaim, sessionKey, splitTemplate, wakeLedger, watchLoop, watchPrompt, writeFresh,
  type WatchConfig, type WatchDeps, type WatchState,
} from '../agent-watch';

const alex = crypto.randomUUID(), wren = crypto.randomUUID(), other = crypto.randomUUID(), deviceId = 'a'.repeat(64);
const roster = (memberId: string) => ({ memberId, ownerId: alex, members: [{ id: alex, name: 'Alex', role: 'human' as const },
  { id: wren, name: 'Wren', role: 'agent' as const, operatorId: alex }, { id: other, name: 'Otto', role: 'agent' as const, operatorId: alex }], devices: [] });
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempHome = () => { const home = mkdtempSync(join(tmpdir(), 'mr-bridge-watch-')); dirs.push(home); return home; };

/** A room folder as the runner leaves it, for the agent Wren. */
function room(home = tempHome(), roomId: string = crypto.randomUUID(), floor: 'humans-first' | 'open' = 'humans-first') {
  const agent = new BrowserAgent(home, 'http://127.0.0.1:1', roomId);
  writeFileSync(join(agent.dir, 'members.json'), JSON.stringify(roster(wren)));
  writeFileSync(join(agent.dir, 'settings.json'), JSON.stringify({ floor }));
  writeFileSync(join(agent.dir, 'room.json'), JSON.stringify({ origin: 'http://127.0.0.1:1', roomId }));
  const append = (file: string, packet: object) => {
    const ops = JSON.parse((() => { try { return readFileSync(join(agent.dir, file), 'utf8'); } catch { return '[]'; } })());
    writeFileSync(join(agent.dir, file), JSON.stringify([...ops, { ...packet, seq: ops.length + 1 }]));
  };
  return {
    agent, roomId, home,
    say(text: string, memberId = alex, replyTo?: string) {
      const body = { kind: 'message', roomId, id: crypto.randomUUID(), deviceId, memberId, text, at: Date.now(), ...(replyTo ? { replyTo } : {}) };
      writeFileSync(join(agent.dir, 'messages.json'), JSON.stringify([...agent.messages(), { packet: { body, signature: '' }, targets: [], receipts: [] }]));
      return body.id;
    },
    assign(title: string) { append('tasks.json', { body: taskBody({ roomId, deviceId, memberId: alex, change: { title, assigneeId: wren } }), signature: '' }); },
    ask(question: string, memberId = alex) { append('decisions.json', { body: openDecision({ roomId, deviceId, memberId, question, options: ['A', 'B'], askAgents: true }), signature: '' }); },
    cursor: () => { try { return readFileSync(join(agent.dir, 'live', 'listen-cursor.json'), 'utf8'); } catch { return ''; } },
  };
}
type Room = ReturnType<typeof room>;
type Listened = { state: string; addressed: string[]; tasks: { id: string }[]; decisions?: { asked: unknown[]; resolved: unknown[]; withdrawn?: unknown[] } };
const listenWork = (l: Listened) => l.state !== 'timeout' && (l.addressed.length > 0 || l.tasks.length > 0 || !!l.decisions?.asked.length || !!l.decisions?.resolved.length || !!l.decisions?.withdrawn?.length);

test('peek finds exactly the work listen would return, and consumes nothing', async () => {
  const scenarios: [string, (r: Room) => void, boolean, ('humans-first' | 'open')?][] = [
    ['a person chatting', r => { r.say('Lunch at noon?'); }, false],
    ['a mention', r => { r.say('@Wren can you look?'); }, true],
    ['@agents', r => { r.say('@agents status please'); }, true],
    ['a reply to its own message', r => { const mine = r.say('Done with the header', wren); r.agent.saveListenCursor({ after: mine, boardAfter: 0, decisionsAfter: 0 }); r.say('Thanks, one more thing', alex, mine); }, true],
    ['a mention of another agent only', r => { r.say('@Otto can you look?'); }, false],
    ['its own message mentioning itself', r => { r.say('@Wren note to self', wren); }, false],
    ['another agent mentioning it, humans first', r => { r.say('@Wren over to you', other); }, false],
    ['another agent mentioning it, open floor', r => { r.say('@Wren over to you', other); }, true, 'open'],
    ['a person mentioning nobody, open floor', r => { r.say('Anyone around?'); }, true, 'open'],
    ['an assignment by a person', r => { r.assign('Fix the header'); }, true],
    ['a decision asking agents', r => { r.ask('Ship Friday?'); }, true],
    // Asks follow the same author rules as messages: another agent's ask doesn't wake it in a humans-first room.
    ['a decision another agent opened, humans first', r => { r.ask('Tabs or spaces?', other); }, false],
    ['a decision another agent opened, open floor', r => { r.ask('Tabs or spaces?', other); }, true, 'open'],
  ];
  for (const [name, happen, expected, floor] of scenarios) {
    const r = room(undefined, undefined, floor);
    r.say('Morning, everyone');
    await listenRemembering(r.agent, 1); // Establishes the saved cursors, like an agent that listened before.
    happen(r);
    const cursor = r.cursor(), activity = JSON.stringify(r.agent.activity());
    const peek = peekWork(r.agent);
    expect({ name, work: peek.work }).toEqual({ name, work: expected });
    // Peeking twice changes nothing: no cursor saved, no activity recorded.
    expect(peekWork(r.agent)).toEqual(peek);
    expect(r.cursor()).toBe(cursor);
    expect(JSON.stringify(r.agent.activity())).toBe(activity);
    const listened = await listenRemembering(r.agent, 1) as Listened;
    expect({ name, work: listenWork(listened) }).toEqual({ name, work: expected });
    if (expected) expect(peek.addressed).toEqual(listened.addressed);
    // Once listen has consumed it, it is no longer work.
    expect({ name, after: peekWork(r.agent).work }).toEqual({ name, after: false });
  }
}, 60_000);

test('before its first listen, the history counts as work only when something in it is for the agent', async () => {
  const quiet = room();
  quiet.say('Morning, everyone');
  expect(peekWork(quiet.agent)).toMatchObject({ admitted: true, work: false });
  const asked = room();
  const mention = asked.say('@Wren welcome, can you check the header?');
  expect(peekWork(asked.agent)).toMatchObject({ work: true, state: 'history', addressed: [mention] });
  expect(asked.cursor()).toBe('');
  const listened = await listenRemembering(asked.agent, 1) as Listened;
  expect(listened).toMatchObject({ state: 'history', addressed: [mention] });
  expect(peekWork(asked.agent).work).toBe(false);
});

test('the runner signs a queued message only when the room lets the agent speak, whoever wrote the outbox', () => {
  const r = room();
  const mention = r.say('@Wren can you look?'), chatter = r.say('Lunch at noon?');
  expect(queuedMaySpeak(r.agent, wren, undefined)).toBe(false);
  expect(queuedMaySpeak(r.agent, wren, chatter)).toBe(false);
  expect(queuedMaySpeak(r.agent, wren, mention)).toBe(true);
  expect(queuedMaySpeak(room(undefined, undefined, 'open').agent, wren, undefined)).toBe(true);
});

test('an agent not admitted yet has no work and does not fail', () => {
  const r = room();
  writeFileSync(join(r.agent.dir, 'members.json'), JSON.stringify({ members: [], devices: [] }));
  expect(peekWork(r.agent)).toEqual({ admitted: false, work: false, state: 'waiting', addressed: [], tasks: [], decisions: [] });
});

/** A fake clock and a harness that does what the prompt asks: listen, then reply to what addressed it. */
function harness(r: Room, behave: { reads?: boolean | (() => boolean); replies?: boolean; exitCode?: () => number; during?: () => void } = {}) {
  const runs: { at: number; addressed: string[] }[] = [];
  let busy = 0, overlapped = false;
  const run = async (onStart: (pid: number) => void) => {
    onStart(4242);
    busy++; if (busy > 1) overlapped = true;
    await Promise.resolve();
    let addressed: string[] = [];
    const reads = typeof behave.reads === 'function' ? behave.reads() : behave.reads !== false;
    const exitCode = behave.exitCode?.() ?? 0;
    if (reads) {
      const listened = await listenRemembering(r.agent, 1) as Listened;
      addressed = listened.addressed;
      if (behave.replies !== false && exitCode === 0) for (const id of addressed) r.say('On it.', wren, id);
    }
    behave.during?.();
    runs.push({ at: clock.now, addressed });
    busy--;
    return { exitCode };
  };
  const clock = { now: 1_000_000 };
  return { runs, run, clock, overlapped: () => overlapped };
}
/** One agent's wakes across its rooms, shared by the loops of a test. */
const ledger = () => { const at: number[] = []; return { recent: (now: number) => at.filter(t => t > now - 3_600_000).length, add: (t: number) => { at.push(t); } }; };
function deps(r: Room, h: ReturnType<typeof harness>, options: { until: () => boolean; state?: { value: WatchState }; runAlive?: (pid: number) => boolean; logs?: string[];
  killed?: number[]; agentWakes?: ReturnType<typeof ledger>; claim?: () => boolean }): WatchDeps {
  const state = options.state ?? { value: emptyState() };
  return {
    now: () => h.clock.now,
    sleep: async ms => { h.clock.now += ms; await Promise.resolve(); },
    peek: () => peekWork(r.agent),
    cursor: r.cursor,
    restoreCursor: saved => r.agent.saveListenCursor(JSON.parse(saved)),
    ownActions: () => r.agent.messages().filter(m => m.packet.body.memberId === wren).length,
    activity: { idle: () => r.agent.recordActivity('idle', undefined, h.clock.now), working: on => r.agent.recordActivity('working', on, h.clock.now),
      touch: () => r.agent.touchActivity(h.clock.now), setNote: text => r.agent.noteActivity(text, h.clock.now), currentNote: () => r.agent.activity()?.note },
    run: h.run,
    ensureRunner: async () => {},
    runAlive: run => options.runAlive?.(run.pid) ?? false,
    killRun: run => { options.killed?.push(run.pid); },
    agentWakes: options.agentWakes ?? ledger(),
    claimSession: () => options.claim && !options.claim() ? undefined : { started: () => {}, release: () => {} },
    log: line => options.logs?.push(line),
    readState: () => structuredClone(state.value),
    writeState: next => { state.value = structuredClone(next); },
    stopped: options.until,
  };
}
const config = (max = 20, all = 30): Pick<WatchConfig, 'maxWakesPerHour' | 'maxAgentWakesPerHour' | 'harness'> => ({ maxWakesPerHour: max, maxAgentWakesPerHour: all, harness: 'exec' });
/** Stops a loop once `seconds` of fake time passed. */
const after = (h: ReturnType<typeof harness>, seconds: number) => { const end = h.clock.now + seconds * 1000; return () => h.clock.now >= end; };
async function listened(r: Room) { r.say('Morning, everyone'); await listenRemembering(r.agent, 1); }
const replies = (r: Room, to: string) => r.agent.messages().filter(m => m.packet.body.memberId === wren && m.packet.body.replyTo === to).length;

test('a mention wakes the harness once, which reads and replies; its own reply does not wake it again', async () => {
  const r = room(); await listened(r);
  const mention = r.say('@Wren can you look?');
  const h = harness(r), state = { value: emptyState() };
  expect(await watchLoop(config(), deps(r, h, { until: after(h, 600), state }))).toBe('stopped');
  expect(h.runs.map(run => run.addressed)).toEqual([[mention]]);
  expect(state.value.lastResult).toMatchObject({ progress: true, replied: true, exitCode: 0 });
  expect(state.value.noProgress).toBe(0);
  expect(r.agent.activity()).toMatchObject({ state: 'idle' });
});

test('work that arrives during a run waits for it to end, then wakes the harness again', async () => {
  const r = room(); await listened(r);
  const first = r.say('@Wren first question');
  let second = '';
  const h = harness(r, { during: () => { if (!second) second = r.say('@Wren and a second one, while you are busy'); } });
  await watchLoop(config(), deps(r, h, { until: after(h, 600) }));
  expect(h.overlapped()).toBe(false);
  expect(h.runs.map(run => run.addressed)).toEqual([[first], [second]]);
});

test('runs that do not read the room back off; the third pauses the watcher, which stays up, shows a note, retries every 15 minutes and resumes', async () => {
  const r = room(); await listened(r);
  const mention = r.say('@Wren are you there?');
  const started = 1_000_000; // Where harness() starts its clock.
  // The harness is fixed after 20 minutes: the retry at 16.5 minutes still fails, the one at 31.5 reads the room.
  const h = harness(r, { reads: () => h.clock.now >= started + 1_200_000 }), state = { value: emptyState() }, logs: string[] = [];
  expect(await watchLoop(config(), deps(r, h, { until: after(h, 2400), state, logs }))).toBe('stopped');
  const gaps = h.runs.map(run => Math.round((run.at - started) / 1000));
  expect(gaps).toEqual([0, 30, 90, 990, 1890]);
  expect(gaps[3] - gaps[2]).toBe(WATCH_TIMING.pausedRetryMs / 1000);
  expect(logs.some(line => line.startsWith('paused:'))).toBe(true);
  expect(logs.some(line => line.includes('resuming'))).toBe(true);
  expect(replies(r, mention)).toBe(1);
  expect(state.value.paused).toBeUndefined();
  expect(r.agent.activity()?.note).toBeUndefined();
});

test('while paused the watcher keeps its heartbeat and the note people see', async () => {
  const r = room(); await listened(r);
  r.say('@Wren are you there?');
  const h = harness(r, { reads: false }), state = { value: emptyState() };
  await watchLoop(config(), deps(r, h, { until: after(h, 600), state }));
  expect(state.value.paused?.reason).toContain("without handling the room's work");
  const activity = r.agent.activity()!;
  expect(activity).toMatchObject({ state: 'idle', note: PAUSED_NOTE });
  expect(h.clock.now - activity.heartbeat).toBeLessThanOrEqual(WATCH_TIMING.heartbeatMs + WATCH_TIMING.pollMs);
  // Nothing was consumed: the work is still there for when the harness answers again.
  expect(peekWork(r.agent).work).toBe(true);
});

test('a run that fails after reading the room, without acting on it, gets that work offered once more', async () => {
  const r = room(); await listened(r);
  const mention = r.say('@Wren can you check the build?');
  let attempts = 0;
  const h = harness(r, { exitCode: () => attempts++ === 0 ? 1 : 0 }), logs: string[] = [];
  await watchLoop(config(), deps(r, h, { until: after(h, 600), logs }));
  expect(h.runs.map(run => run.addressed)).toEqual([[mention], [mention]]);
  expect(replies(r, mention)).toBe(1);
  expect(logs.some(line => line.includes('offered again'))).toBe(true);
  // Failing on the same work again, it is not offered a third time.
  const again = room(); await listened(again);
  const stuck = again.say('@Wren and this one?');
  const g = harness(again, { exitCode: () => 1 }), glogs: string[] = [], gstate = { value: emptyState() };
  await watchLoop(config(), deps(again, g, { until: after(g, 900), logs: glogs, state: gstate }));
  expect(g.runs.filter(run => run.addressed.includes(stuck))).toHaveLength(2);
  expect(glogs.some(line => line.includes('not offered a third time'))).toBe(true);
  // Failing like that is never taken for success: both failures count toward the pause.
  expect(gstate.value.noProgress).toBe(2);
  expect(gstate.value.lastResult).toMatchObject({ progress: true, replied: false, exitCode: 1 });
});

test('the per-hour cap stops agent-to-agent ping-pong, and wakes resume once the hour has passed', async () => {
  const r = room(undefined, undefined, 'open'); await listened(r);
  r.say('@Wren ping', other);
  // Another agent answers every reply: without the cap this never ends.
  const h = harness(r, { during: () => { r.say('@Wren ping again', other); } }), state = { value: emptyState() };
  await watchLoop(config(3), deps(r, h, { until: after(h, 1800), state }));
  expect(h.runs).toHaveLength(3);
  expect(state.value.capped).toBe(true);
  expect(r.agent.activity()?.note).toContain('limit reached');
  await watchLoop(config(3), deps(r, h, { until: after(h, 3600), state }));
  expect(h.runs.length).toBeGreaterThan(3);
  expect(h.runs.length).toBeLessThanOrEqual(6);
});

test('one agent\'s wakes are capped across all its rooms too', async () => {
  const home = tempHome(), shared = ledger();
  const rooms = [room(home, undefined, 'open'), room(home, undefined, 'open')];
  const ran: number[] = [];
  for (const [i, r] of rooms.entries()) {
    await listened(r);
    r.say('@Wren ping', other);
    const h = harness(r, { during: () => { r.say('@Wren ping again', other); } });
    await watchLoop(config(20, 5), deps(r, h, { until: after(h, 900), agentWakes: shared }));
    ran[i] = h.runs.length;
  }
  expect(ran[0] + ran[1]).toBe(5);
  expect(rooms[1].agent.activity()?.note).toContain('in all rooms');
});

test('after a restart, pending work is handled exactly once and handled work is never replayed', async () => {
  const r = room(); await listened(r);
  const mention = r.say('@Wren can you check the build?');
  const state = { value: emptyState() };
  // The first watcher goes down the moment its run ends, before it records anything: the state on disk is what it was then.
  const first = harness(r);
  let ended = false, onDisk = state.value;
  const crashing = { ...deps(r, first, { until: () => ended, state }),
    run: async (onStart: (pid: number) => void) => { const out = await first.run(onStart); onDisk = structuredClone(state.value); ended = true; return out; } };
  await watchLoop(config(), crashing);
  state.value = onDisk;
  expect(first.runs.map(run => run.addressed)).toEqual([[mention]]);
  expect(state.value.activeRun).toEqual({ pid: 4242, startedAt: expect.any(Number) });
  expect(state.value.lastResult).toBeUndefined();
  // The next watcher finds the mention behind the cursor: it does not wake the harness for it again.
  const second = harness(r);
  second.clock.now = first.clock.now;
  await watchLoop(config(), deps(r, second, { until: after(second, 600), state }));
  expect(second.runs).toHaveLength(0);
  expect(state.value.activeRun).toBeUndefined();
  // Work that arrived while it was down is handled once.
  const pending = r.say('@Wren and the tests?');
  const third = harness(r);
  third.clock.now = second.clock.now;
  await watchLoop(config(), deps(r, third, { until: after(third, 600), state }));
  expect(third.runs.map(run => run.addressed)).toEqual([[pending]]);
  expect(replies(r, mention)).toBe(1);
});

test('a restarted watcher waits for the run its predecessor started, so two runs never overlap', async () => {
  const r = room(); await listened(r);
  r.say('@Wren can you check the build?');
  const h = harness(r), state = { value: { ...emptyState(), activeRun: { pid: 777, startedAt: h.clock.now } } }, killed: number[] = [];
  const endsAt = h.clock.now + 90_000;
  await watchLoop(config(), deps(r, h, { until: after(h, 600), state, runAlive: pid => pid === 777 && h.clock.now < endsAt, killed }));
  expect(h.runs).toHaveLength(1);
  expect(h.runs[0].at).toBeGreaterThanOrEqual(endsAt);
  expect(killed).toEqual([]);
});

test('an orphaned run is waited for only as long as a run may take, then stopped with everything it started', async () => {
  const r = room(); await listened(r);
  r.say('@Wren can you check the build?');
  const h = harness(r), state = { value: { ...emptyState(), activeRun: { pid: 777, startedAt: h.clock.now } } }, killed: number[] = [];
  const timing = { ...WATCH_TIMING, runTimeoutMs: 120_000, orphanGraceMs: 30_000 };
  const bound = h.clock.now + timing.runTimeoutMs + timing.orphanGraceMs;
  let dead = false;
  const d = deps(r, h, { until: after(h, 600), state, runAlive: pid => pid === 777 && !dead, killed });
  d.killRun = run => { killed.push(run.pid); dead = true; };
  await watchLoop(config(), d, timing);
  expect(killed).toEqual([777]);
  expect(h.runs).toHaveLength(1);
  expect(h.runs[0].at).toBeGreaterThanOrEqual(bound);
  // A pid that is no longer that run (reused by another program) is neither waited for nor killed.
  const s = room(); await listened(s); s.say('@Wren again?');
  const g = harness(s), gkilled: number[] = [];
  await watchLoop(config(), deps(s, g, { until: after(g, 60), state: { value: { ...emptyState(), activeRun: { pid: 778, startedAt: g.clock.now } } }, runAlive: () => false, killed: gkilled }));
  expect(gkilled).toEqual([]);
  expect(g.runs[0].at).toBeLessThan(g.clock.now);
});

test('one wake at a time per harness session: a session another room is resuming waits', async () => {
  const r = room(); await listened(r);
  const mention = r.say('@Wren can you look?');
  const h = harness(r), logs: string[] = [], start = h.clock.now;
  // Another room's wake holds the session for the first 45 seconds.
  await watchLoop(config(), deps(r, h, { until: after(h, 120), logs, claim: () => h.clock.now >= start + 45_000 }));
  expect(h.runs.map(run => run.addressed)).toEqual([[mention]]);
  expect(h.runs[0].at).toBeGreaterThanOrEqual(start + 45_000);
  expect(logs.filter(line => line.includes('another room'))).toHaveLength(1);
});

test('a session held elsewhere (a thread open in the Codex app) waits and retries, and each try counts as a wake', async () => {
  const r = room(); await listened(r);
  const mention = r.say('@Wren can you look?');
  const h = harness(r), state = { value: emptyState() }, logs: string[] = [];
  let held = 2; // The app holds the thread for the first two attempts.
  const d = deps(r, h, { until: after(h, 900), state, logs });
  d.run = async onStart => held-- > 0 ? { exitCode: 1, busy: true, error: 'thread already has an active writer' } : h.run(onStart);
  expect(await watchLoop(config(20), d)).toBe('stopped');
  expect(h.runs.map(run => run.addressed)).toEqual([[mention]]);
  expect(state.value.paused).toBeUndefined();
  expect(state.value.wakes).toHaveLength(3);
  expect(logs.filter(line => line.includes('open elsewhere'))).toHaveLength(2);
  expect(r.agent.activity()?.note).toBeUndefined();
});

test('a Codex thread is found by id with the folder, client and version it recorded, and --last by its folder', () => {
  const home = tempHome(), id = '0190a000-0000-7000-8000-00000000000a', older = '0190a000-0000-7000-8000-000000000009', day = join(home, 'sessions', '2026', '09', '30');
  mkdirSync(day, { recursive: true });
  const meta = (thread: string, cwd: string) => `${JSON.stringify({ type: 'session_meta', payload: { id: thread, cwd, originator: 'Codex Desktop', cli_version: '0.159.2', source: 'vscode' } })}\n{"type":"event"}\n`;
  writeFileSync(join(day, `rollout-2026-01-01T00-00-00-${older}.jsonl`), meta(older, join(home, 'project')));
  writeFileSync(join(day, `rollout-2026-01-01T00-00-01-${id}.jsonl`), meta(id, join(home, 'project')));
  writeFileSync(join(day, `rollout-2026-01-01T00-00-02-0190a000-0000-7000-8000-00000000000d.jsonl`), meta('0190a000-0000-7000-8000-00000000000d', join(home, 'elsewhere')));
  utimesSync(join(day, `rollout-2026-01-01T00-00-00-${older}.jsonl`), new Date(1_000_000), new Date(1_000_000));
  expect(codexThread(id, home)).toMatchObject({ cwd: join(home, 'project'), originator: 'Codex Desktop', cliVersion: '0.159.2' });
  expect(codexThread('0190a000-0000-7000-8000-00000000000c', home)).toBeUndefined();
  expect(newestCodexThread(join(home, 'project'), home)).toBe(id);
  expect(newestCodexThread(join(home, 'nowhere'), home)).toBeUndefined();
  // A thread the Codex app started with a newer Codex than the CLI that will resume it.
  expect(newerThreadWarning({ cliVersion: '0.159.2', originator: 'Codex Desktop' }, '0.157.1')).toContain('started by Codex 0.159.2 (Codex Desktop), newer than this codex (0.157.1)');
  for (const cli of ['0.159.2', '0.160.0', undefined, 'unknown']) expect(newerThreadWarning({ cliVersion: '0.159.2' }, cli)).toBeUndefined();
  expect(newerThreadWarning({ cliVersion: '0.158.0-alpha.2.1' }, '0.158.0')).toBeUndefined();
});

test('only Codex itself can say the thread is busy: its error on stderr with a failed exit, never the model\'s output', () => {
  const held = 'Error: thread/resume: thread/resume failed: thread 0190a000-0000-7000-8000-00000000000a already has an active writer (code -32600)\n';
  expect(readHarnessOutput('codex', '', held, 1)).toMatchObject({ busy: true });
  expect(readHarnessOutput('codex', '', held, 0).busy).toBeUndefined();
  expect(readHarnessOutput('codex', 'thread x already has an active writer', '', 1).busy).toBeUndefined();
});

test('the operator\'s Codex configuration is read as Codex 0.159 reads it, so a read-only one is never widened and their own profile is built on', () => {
  const home = tempHome(), write = (text: string) => writeFileSync(join(home, 'config.toml'), text);
  expect(codexConfig(home)).toEqual({ mcpServers: [] });
  write('model = "x"\nsandbox_mode = "read-only"\n');
  expect(codexBase(codexConfig(home))).toHaveProperty('refuse');
  write('default_permissions = ":read-only"\n');
  expect(codexBase(codexConfig(home))).toHaveProperty('refuse');
  // A full-access sandbox is what a wake's own profile replaces (verified live: the profile applied over it).
  write('sandbox_mode = "danger-full-access"\napproval_policy = "never"\n');
  expect(codexBase(codexConfig(home))).toEqual({ extends: ':read-only' });
  // A permission profile of the operator's own is built on, not replaced.
  write('default_permissions = "mine"\n[permissions.mine]\nextends = ":workspace"\n');
  expect(codexBase(codexConfig(home))).toEqual({ extends: 'mine' });
  // A legacy profile line makes Codex 0.159 refuse to start: reported, not guessed at.
  write('profile = "fast"\n[profiles.fast]\nsandbox_mode = "danger-full-access"\n');
  expect((codexBase(codexConfig(home)) as { refuse: string }).refuse).toContain('no longer accepts');
  // Keys inside other tables don't count, and every configured MCP server is found (a wake turns them off).
  write('model = "x"\n[windows]\nsandbox_mode = "read-only"\n[mcp_servers.docs]\ncommand = "x"\n[mcp_servers.docs.env]\nA = "1"\n[mcp_servers.web-tools]\nurl = "y"\n');
  expect(codexConfig(home)).toMatchObject({ sandboxMode: undefined, mcpServers: ['docs', 'web-tools'] });
});

test('a mention in another room never wakes this room\'s watcher', async () => {
  const home = tempHome();
  const here = room(home), elsewhere = room(home);
  await listened(here); await listened(elsewhere);
  elsewhere.say('@Wren can you look at this one?');
  const h = harness(here);
  await watchLoop(config(), deps(here, h, { until: after(h, 600) }));
  expect(h.runs).toHaveLength(0);
  expect(peekWork(elsewhere.agent).work).toBe(true);
});

test('while it waits the watcher keeps the agent reachable, and shows it working during a run', async () => {
  const r = room(); await listened(r);
  const h = harness(r);
  let working = false;
  const d = deps(r, h, { until: after(h, 120) });
  const run = h.run;
  d.run = async onStart => { working = r.agent.activity()?.state === 'working'; return run(onStart); };
  r.say('@Wren quick one');
  await watchLoop(config(), d);
  expect(working).toBe(true);
  const activity = r.agent.activity()!;
  expect(activity.state).toBe('idle');
  // Heartbeats kept coming while it waited, well inside the roster's idle staleness.
  expect(h.clock.now - activity.heartbeat).toBeLessThanOrEqual(WATCH_TIMING.heartbeatMs + WATCH_TIMING.pollMs);
});

const watchConfig = (over: Partial<WatchConfig> = {}): WatchConfig => ({ roomId: '00000000-0000-4000-8000-000000000000', harness: 'claude', cwd: '/work/project',
  maxWakesPerHour: 20, maxAgentWakesPerHour: 30, runTimeoutMinutes: 20, allowTools: [], launcher: '/home/me/.meshrooms/bin/meshrooms.js', agentHome: '/home/me/.meshrooms/agents',
  binDir: '/home/me/.meshrooms/bin', roomDir: '/home/me/.meshrooms/agents/browser-agents/ROOM', ...over });
const found = (name: string) => ({ file: `/usr/bin/${name}`, prefix: [] });
const dangerous = ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-skip-permissions', 'bypassPermissions', 'danger-full-access'];
const L = '/home/me/.meshrooms/bin/meshrooms.js';

test('Claude Code gets the prompt on stdin, may run only the wake subcommands, never writes files or fetches, and never asks', () => {
  const run = harnessInvocation(watchConfig(), 'the prompt', '/tmp/prompt.txt', found);
  expect(run.stdin).toBe('the prompt');
  const args = run.args, list = (flag: string) => { const rest = args.slice(args.indexOf(flag) + 1); const end = rest.findIndex(a => a.startsWith('--')); return end < 0 ? rest : rest.slice(0, end); };
  expect(args.slice(0, 9)).toEqual(['-p', '--continue', '--output-format', 'json', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--add-dir', join(watchConfig().roomDir, 'wake')]);
  expect(list('--disallowedTools')).toEqual([...CLAUDE_DENIED, 'Read(**/.env*)']);
  const allowed = list('--allowedTools');
  expect(allowed).toEqual(launcherRules(L));
  expect(allowed).toContain(`Bash(bun "${L}" listen *)`);
  expect(allowed).toContain(`Bash(bun "${L}" send *)`);
  expect(allowed).toContain(`Bash(bun "${L}" help)`);
  // No rule lets through the bridge's other commands, or the launcher with anything after it.
  for (const rule of allowed) expect(rule).not.toMatch(/" \*\)$|watch|connect|profile|avatar|stop|task-issue|issue-task/);
  // An operator's --allow-tools can lift a denied tool, and allowing an MCP tool keeps MCP servers.
  const widened = harnessInvocation(watchConfig({ session: '11111111-1111-4111-8111-111111111111', model: 'sonnet', allowTools: ['Edit', 'mcp__docs__search'] }), 'p', '/tmp/p', found);
  expect(widened.args.slice(0, 3)).toEqual(['-p', '--resume', '11111111-1111-4111-8111-111111111111']);
  expect(widened.args).not.toContain('--strict-mcp-config');
  expect(widened.args.slice(widened.args.indexOf('--disallowedTools') + 1, widened.args.indexOf('--allowedTools'))).not.toContain('Edit');
  expect(widened.args.slice(-2)).toEqual(['Edit', 'mcp__docs__search']);
  for (const flag of dangerous) expect(widened.args.join(' ')).not.toContain(flag);
  // Paths a wake must not read become Read denies, which cover Grep and Glob too, spelled as Claude Code 2.1.285 honours them.
  // The rules are spelled for the platform running the watcher, so the paths here are that platform's too.
  const windows = process.platform === 'win32', home = windows ? 'C:\\Users\\me' : '/home/me', rule = windows ? '//c/Users/me' : '//home/me';
  const denied = harnessInvocation(watchConfig(), 'p', '/tmp/p', found, { denyRead: [{ path: join(home, '.ssh'), dir: true }, { path: join(home, 'agents', 'browser-agents', 'ROOM', 'identity.json'), dir: false }] });
  expect(denied.args).toContain(`Read(${rule}/.ssh/**)`);
  expect(denied.args).toContain(`Read(${rule}/agents/browser-agents/ROOM/identity.json)`);
});

test('Claude Code rule paths: lower-case drive without its colon on Windows, a leading // elsewhere', () => {
  expect(claudeRulePath('C:\\Users\\me\\.ssh', 'win32')).toBe('//c/Users/me/.ssh');
  expect(claudeRulePath('/home/me/.ssh', 'linux')).toBe('//home/me/.ssh');
  expect(claudeReadRules([{ path: '/home/me/.aws', dir: true }], 'linux')).toEqual(['Read(//home/me/.aws/**)', 'Read(**/.env*)']);
});

test('a Codex wake runs under a permission profile of its own: the room\'s wake folders writable, secrets unreadable, no network, search, MCP servers or computer use', () => {
  const room = watchConfig().roomDir;
  const run = harnessInvocation(watchConfig({ harness: 'codex', session: '0190a000-0000-7000-8000-00000000000b' }), 'the prompt', '/tmp/p', found,
    { denyRead: [{ path: join(room, 'identity.json'), dir: false }, { path: '/home/me/.ssh', dir: true }], codexExtends: ':read-only', codexMcpServers: ['docs', 'web-tools'] });
  expect(run.stdin).toBe('the prompt');
  const at = (key: string) => run.args[run.args.findIndex(a => a.startsWith(`${key}=`))];
  expect(run.args.slice(0, 4)).toEqual(['exec', 'resume', '0190a000-0000-7000-8000-00000000000b', '--skip-git-repo-check']);
  expect(at('default_permissions')).toBe(`default_permissions="${CODEX_PROFILE}"`);
  expect(at(`permissions.${CODEX_PROFILE}.extends`)).toBe(`permissions.${CODEX_PROFILE}.extends=":read-only"`);
  const filesystem = at(`permissions.${CODEX_PROFILE}.filesystem`);
  expect(filesystem).toContain(`${JSON.stringify(join(room, 'identity.json'))} = "deny"`);
  expect(filesystem).toContain('"/home/me/.ssh" = "deny"');
  for (const sub of ['live', 'outbox', 'files', 'wants', 'wake']) expect(filesystem).toContain(`${JSON.stringify(join(room, sub))} = "write"`);
  expect(run.args).toContain(`permissions.${CODEX_PROFILE}.network.enabled=false`);
  expect(run.args).toContain('approval_policy="never"');
  expect(run.args).toContain('web_search="disabled"');
  expect(run.args).toContain('mcp_servers.docs.enabled=false');
  expect(run.args).toContain('mcp_servers.web-tools.enabled=false');
  for (const feature of CODEX_DISABLED) expect(run.args.join(' ')).toContain(`--disable ${feature}`);
  // Never the legacy sandbox switch (it can't be combined with a permission profile), and never a bypass.
  expect(run.args.join(' ')).not.toContain('sandbox_mode');
  for (const flag of dangerous) expect(run.args.join(' ')).not.toContain(flag);
  expect(run.args.at(-1)).toBe('-');
  const model = harnessInvocation(watchConfig({ harness: 'codex', session: '0190a000-0000-7000-8000-00000000000b', model: 'gpt-6-luna' }), 'p', '/tmp/p', found);
  expect(model.args.slice(-3)).toEqual(['-m', 'gpt-6-luna', '-']);
});

test('what a wake may not read: the signing key, other rooms and every other agent, downloads, credentials and transcripts, but not its own room or the bridge', () => {
  const home = tempHome(), meshrooms = join(home, '.meshrooms'), agentHome = join(meshrooms, 'agents'), rooms = join(agentHome, 'browser-agents');
  const roomDir = join(rooms, 'room-a'), binDirPath = join(meshrooms, 'bin'), codexHome = join(home, '.codex'), appData = join(home, 'AppData', 'Roaming');
  // A neighbour whose folder doesn't follow the agents-* naming, and one elsewhere that connect recorded.
  const custom = join(meshrooms, 'work-bot'), elsewhere = join(home, 'bots', 'helper');
  for (const dir of [roomDir, join(rooms, 'room-b'), join(agentHome, 'downloads'), join(meshrooms, 'agents-other'), custom, elsewhere, binDirPath, join(home, '.ssh'),
    join(home, '.claude'), join(home, '.config', 'gcloud'), codexHome, join(home, 'project'), join(appData, 'GitHub CLI'), join(appData, 'gnupg')]) mkdirSync(dir, { recursive: true });
  for (const file of [join(roomDir, 'identity.json'), join(roomDir, 'room.json'), join(agentHome, 'watch-wakes.json'), join(meshrooms, 'agent-homes.json'), join(home, '.npmrc'), join(home, '.pypirc')])
    writeFileSync(file, '{}');
  const denied = wakeReadDenies({ agentHome, roomDir, binDir: binDirPath }, home, codexHome, { platform: 'win32', appData, knownHomes: [agentHome, elsewhere] });
  const paths = denied.map(d => d.path).sort();
  expect(paths).toEqual([join(roomDir, 'identity.json'), join(rooms, 'room-b'), join(agentHome, 'downloads'), join(agentHome, 'watch-wakes.json'), join(meshrooms, 'agents-other'),
    custom, join(meshrooms, 'agent-homes.json'), elsewhere, join(home, '.ssh'), join(home, '.npmrc'), join(home, '.pypirc'), join(home, '.config', 'gcloud'), join(home, '.claude'),
    codexHome, join(appData, 'GitHub CLI'), join(appData, 'gnupg')].map(p => resolve(p)).sort());
  expect(denied.find(d => d.path.endsWith('identity.json'))?.dir).toBe(false);
  // The way down to this room, the room's own files, and the bridge's code stay readable.
  for (const kept of [meshrooms, agentHome, rooms, roomDir, join(roomDir, 'room.json'), binDirPath]) expect(paths).not.toContain(resolve(kept));
  // Not on Windows: no %APPDATA%.
  expect(wakeReadDenies({ agentHome, roomDir, binDir: binDirPath }, home, codexHome, { platform: 'linux', appData, knownHomes: [] }).some(d => d.path.includes('GitHub CLI'))).toBe(false);
});

test('connect and watch record every agent folder, once, where MESHROOMS_AGENT_REGISTRY says when it is set', () => {
  expect(agentHomesFile('/home/me', { MESHROOMS_AGENT_REGISTRY: '/tmp/registry.json' })).toBe(resolve('/tmp/registry.json'));
  expect(agentHomesFile('/home/me', {})).toBe(join('/home/me', '.meshrooms', 'agent-homes.json'));
  const file = join(tempHome(), '.meshrooms', 'agent-homes.json');
  recordAgentHome('/a/agents', file); recordAgentHome('/a/agents', file); recordAgentHome('/b/bot', file);
  expect(knownAgentHomes(file)).toEqual([resolve('/a/agents'), resolve('/b/bot')]);
});

test('Codex .env denies are bounded to the home folder\'s own files and the thread\'s project, in the system\'s own separators', () => {
  expect(codexEnvDenies('/home/me', '/work/app')).toEqual([join('/home/me', '.env*'), join('/work/app', '**', '.env*')]);
  expect(codexEnvDenies('/home/me')).toEqual([join('/home/me', '.env*')]);
  const run = harnessInvocation(watchConfig({ harness: 'codex', session: '0190a000-0000-7000-8000-00000000000b' }), 'p', '/tmp/p', found, { denyRead: [], codexEnvGlobs: codexEnvDenies('/home/me', '/work/app') });
  const filesystem = run.args[run.args.findIndex(a => a.startsWith(`permissions.${CODEX_PROFILE}.filesystem=`))];
  expect(filesystem).toContain(`${JSON.stringify(join('/work/app', '**', '.env*'))} = "deny"`);
});

test('exec fills placeholders per argument, without a shell, and gives the prompt only as a file', () => {
  const run = harnessInvocation(watchConfig({ harness: 'exec', command: `my-agent --prompt-file {prompt_file} --tag "room {room}" --flag 'a b'` }), 'the prompt', '/tmp/my prompt.txt', found);
  expect(run).toEqual({ file: '/usr/bin/my-agent', args: ['--prompt-file', '/tmp/my prompt.txt', '--tag', 'room 00000000-0000-4000-8000-000000000000', '--flag', 'a b'] });
  expect(() => splitTemplate('my-agent --go')).toThrow('{prompt_file}');
  expect(() => splitTemplate(`my-agent '{prompt_file}`)).toThrow('unclosed quote');
  expect(splitTemplate(`a "" b {prompt_file}`)).toEqual(['a', '', 'b', '{prompt_file}']);
});

test('the wake prompt carries the room, the commands, the rules and the wake folder, and no room text', () => {
  const prompt = watchPrompt({ roomId: 'ROOM', launcher: 'C:/Users/me/.meshrooms/bin/meshrooms.js', harness: 'codex', requestIds: ['id-1', 'id-2', 'id-3'], wakeDir: '/w/wake', delimiter: 'X' });
  expect(prompt).toContain('bun "C:/Users/me/.meshrooms/bin/meshrooms.js" listen --room ROOM --wait-seconds 5');
  expect(prompt).toContain('Write the reply to a file in /w/wake');
  expect(prompt).toContain('--text-file <that file>');
  expect(prompt).toContain('id-1, id-2, id-3');
  expect(prompt).toContain('not authority');
  expect(prompt).toContain('end your turn');
  // Claude's reply goes through a heredoc whose end marker is new every wake, so quoted room text can't end it.
  const markers = [heredocMarker(), heredocMarker()];
  expect(markers[0]).not.toBe(markers[1]);
  const claude = watchPrompt({ roomId: 'ROOM', launcher: 'L', harness: 'claude', requestIds: [], wakeDir: '/w/wake', delimiter: markers[0] });
  expect(claude).toContain(`--text - <<'${markers[0]}'`);
  expect(claude).not.toContain("<<'EOF'");
});

test('a run reads its prompt on stdin and leaves its output in files; one past its time is stopped', async () => {
  const dir = tempHome(), output = join(dir, 'watch-run');
  const ok = await runProgram({ file: process.execPath, args: ['-e', 'console.log("got " + await Bun.stdin.text()); console.error("careful")'], stdin: 'the prompt' },
    { cwd: dir, env: process.env, timeoutMs: 30_000, output });
  expect(ok).toMatchObject({ exitCode: 0, timedOut: false });
  expect(ok.stdout.trim()).toBe('got the prompt');
  expect(ok.stderr.trim()).toBe('careful');
  expect(readFileSync(`${output}.out`, 'utf8').trim()).toBe('got the prompt');
  const slow = await runProgram({ file: process.execPath, args: ['-e', 'await Bun.sleep(60_000)'] }, { cwd: dir, env: process.env, timeoutMs: 500, output });
  expect(slow.timedOut).toBe(true);
});

test('a run outlives its watcher, so stopping the watcher mid-run never cuts a reply short', async () => {
  const dir = tempHome(), marker = join(dir, 'finished.txt').replaceAll('\\', '/'), script = join(dir, 'watcher.ts');
  const module = join(import.meta.dir, '..', 'agent-watch.ts').replaceAll('\\', '/');
  // A stand-in watcher: starts a run that finishes after two seconds, and is killed after half of one.
  writeFileSync(script, `import { runProgram } from '${module}';
await runProgram({ file: process.execPath, args: ['-e', 'await Bun.sleep(2000); require("node:fs").writeFileSync(${JSON.stringify(marker)}, "done")'] },
  { cwd: ${JSON.stringify(dir)}, env: process.env, timeoutMs: 60_000, output: ${JSON.stringify(join(dir, 'watch-run'))}, onStart: pid => console.log(pid) });`);
  // Started detached, as `watch` starts the real one.
  const watcher = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const pid = await new Promise<number>(started => watcher.stdout!.once('data', chunk => started(Number(String(chunk).trim()))));
  expect(pid).toBeGreaterThan(0);
  await Bun.sleep(500);
  const exited = new Promise(gone => watcher.once('exit', gone));
  process.kill(watcher.pid!); await exited;
  for (let i = 0; i < 60 && !existsSync(marker); i++) await Bun.sleep(100);
  expect(existsSync(marker)).toBe(true);
}, 30_000);

test('npm shims on Windows run through node, other batch files are refused, and a missing program says so', () => {
  const dir = tempHome();
  mkdirSync(join(dir, 'node_modules', 'tool', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'tool.cmd'), '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\tool\\bin\\tool.js" %*\r\n');
  writeFileSync(join(dir, 'other.bat'), '@echo off\r\necho hi\r\n');
  writeFileSync(join(dir, 'real.exe'), '');
  const env = { PATH: dir };
  const shim = resolveProgram('tool', env, 'win32');
  expect(shim.file).toBe('node');
  expect(shim.prefix[0]).toContain('tool.js');
  expect(resolveProgram('real', env, 'win32')).toEqual({ file: join(dir, 'real.exe'), prefix: [] });
  expect(() => resolveProgram('other', env, 'win32')).toThrow('only a shell can run');
  expect(() => resolveProgram('absent', env, 'win32')).toThrow("Couldn't find absent");
  expect(resolveProgram('claude', env, 'linux')).toEqual({ file: 'claude', prefix: [] });
});

test('what a run printed: Claude\'s session, refusals and errors, Codex\'s session', () => {
  const claude = JSON.stringify({ session_id: 's-1', is_error: false, result: 'Replied.', permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }] });
  expect(readHarnessOutput('claude', claude, '')).toEqual({ sessionId: 's-1', denied: ['rm -rf x'], summary: 'Replied.' });
  expect(readHarnessOutput('claude', '', 'Not logged in\n')).toEqual({ error: 'Not logged in' });
  expect(readHarnessOutput('codex', 'Replied in the room.\n', 'session id: 0190a000-0000-7000-8000-00000000000b\nERROR: model not supported\n', 1))
    .toEqual({ sessionId: '0190a000-0000-7000-8000-00000000000b', error: 'model not supported', summary: 'Replied in the room.' });
});

test('a process is ours by its command line, or, when a sandbox hides that, by a fresh proof of life, which never licenses a kill', () => {
  const now = 1_000_000, alive = () => true;
  const matches = (command: string) => command.includes('run --room');
  expect(ourProcess(50, matches, { alive, commandLine: () => 'bun meshrooms.js run --room R', now })).toBe('command');
  expect(ourProcess(50, matches, { alive, commandLine: () => 'notepad.exe', proof: () => ({ pid: 50, at: now }), now })).toBe(false);
  expect(ourProcess(50, matches, { alive: () => false, commandLine: () => 'bun meshrooms.js run --room R', now })).toBe(false);
  // Codex's Windows sandbox: the process list comes back empty or the lookup fails. The answer says it came from the proof.
  for (const commandLine of [() => '', () => { throw new Error('Access denied'); }]) {
    expect(ourProcess(50, matches, { alive, commandLine, proof: () => ({ pid: 50, at: now - 2_000 }), now })).toBe('proof');
    expect(ourProcess(50, matches, { alive, commandLine, proof: () => ({ pid: 50, at: now - ALIVE_WITHIN_MS - 1 }), now })).toBe(false);
    expect(ourProcess(50, matches, { alive, commandLine, proof: () => ({ pid: 51, at: now }), now })).toBe(false);
    expect(ourProcess(50, matches, { alive, commandLine, now })).toBe(false);
  }
});

/** Runs `work` with wake variables set, as the watcher sets them for a harness. */
async function inWake<T>(room: string, dir: string | undefined, work: () => Promise<T> | T) {
  const saved = { room: process.env.MESHROOMS_WAKE_ROOM, dir: process.env.MESHROOMS_WAKE_DIR };
  process.env.MESHROOMS_WAKE_ROOM = room;
  if (dir === undefined) delete process.env.MESHROOMS_WAKE_DIR; else process.env.MESHROOMS_WAKE_DIR = dir;
  try { return await work(); } finally {
    if (saved.room === undefined) delete process.env.MESHROOMS_WAKE_ROOM; else process.env.MESHROOMS_WAKE_ROOM = saved.room;
    if (saved.dir === undefined) delete process.env.MESHROOMS_WAKE_DIR; else process.env.MESHROOMS_WAKE_DIR = saved.dir;
  }
}

test('in a wake the bridge refuses whatever would configure it, other rooms, and files outside the wake folder', async () => {
  const home = tempHome(), wake = join(home, 'wake'), room = crypto.randomUUID(), elsewhere = crypto.randomUUID();
  mkdirSync(wake);
  writeFileSync(join(wake, 'reply.md'), 'hi');
  writeFileSync(join(home, 'secret.txt'), 'private');
  const guard = (argv: Record<string, string>, attach: string[] = [], command = 'send', dir: string | null = wake) => () => wakeGuard(command, argv, attach, { MESHROOMS_WAKE_ROOM: room, MESHROOMS_WAKE_DIR: dir ?? undefined });
  // Outside a wake nothing changes.
  expect(wakeGuard('watch', {}, [], {})).toBeUndefined();
  for (const command of ['watch', 'watch-stop', 'watch-run', 'stop', 'connect', 'profile', 'avatar', 'run', 'rooms', 'task-issue', 'issue-task'])
    expect(guard({ '--room': room }, [], command)).toThrow("isn't available to an agent the room watcher woke");
  expect(guard({ '--room': elsewhere })).toThrow(`This wake is for room ${room}`);
  expect(guard({ '--room': room, '--text-file': join(wake, 'reply.md') })()).toBe(wake);
  expect(guard({ '--room': room, '--text-file': join(home, 'secret.txt') })).toThrow('files must be in the wake folder');
  expect(guard({ '--room': room, '--text-file': join(wake, '..', 'secret.txt') })).toThrow('files must be in the wake folder');
  expect(guard({ '--room': room }, [join(home, 'secret.txt')])).toThrow('files must be in the wake folder');
  expect(guard({ '--room': room }, [join(wake, 'reply.md')])()).toBe(wake);
  expect(guard({ '--room': room, '--plan-file': join(home, 'secret.txt') }, [], 'ask')).toThrow('files must be in the wake folder');
  expect(guard({ '--room': room, '--context-file': join(home, 'secret.txt') }, [], 'ask')).toThrow('files must be in the wake folder');
  expect(guard({ '--room': room, '--out': join(home, 'x') }, [], 'attachment')).toThrow('leave out --out');
  // A roster note is seen by everyone: during a wake it would be speaking unaddressed. Clearing one is fine.
  expect(guard({ '--room': room, '--note': 'hello everyone' }, [], 'status')).toThrow('reply in the room');
  expect(guard({ '--room': room, '--note': '' }, [], 'status')()).toBe(wake);
  expect(guard({ '--room': room }, [], 'attachment', null)).toThrow('no wake folder');
  expect(guard({ '--room': room, '--text-file': join(wake, 'reply.md') }, [], 'send', null)).toThrow('files must be in the wake folder');
  // A link inside the wake folder that leads out of it is refused too.
  let linked = false;
  try { symlinkSync(join(home, 'secret.txt'), join(wake, 'innocent.md')); linked = true; } catch { /* Windows without the privilege to make file links. */ }
  if (linked) expect(guard({ '--room': room, '--text-file': join(wake, 'innocent.md') })).toThrow('files must be in the wake folder');
  mkdirSync(join(home, 'outside'));
  writeFileSync(join(home, 'outside', 'secret.md'), 'private');
  symlinkSync(join(home, 'outside'), join(wake, 'dir'), 'junction');
  expect(insideDir(join(wake, 'dir', 'secret.md'), wake)).toBe(false);
  expect(insideDir(join(wake, 'reply.md'), wake)).toBe(true);
});

test('in a wake the CLI itself enforces the room and the command, whatever the harness runs', async () => {
  const home = tempHome(), saved = process.env.MESHROOMS_AGENT_HOME;
  process.env.MESHROOMS_AGENT_HOME = home;
  try {
    const r = room(home), other = room(home); await listened(r);
    const wake = join(r.agent.dir, 'wake'); mkdirSync(wake, { recursive: true });
    await inWake(r.roomId, wake, async () => {
      await expect(agentCli(['watch', '--room', r.roomId, '--harness', 'exec', '--command', 'x {prompt_file}'])).rejects.toThrow("isn't available");
      await expect(agentCli(['rooms'])).rejects.toThrow("isn't available");
      await expect(agentCli(['listen', '--room', other.roomId, '--peek'])).rejects.toThrow(`This wake is for room ${r.roomId}`);
      expect(await agentCli(['listen', '--room', r.roomId, '--peek'])).toMatchObject({ roomId: r.roomId });
      // The watcher owns the runner during a wake: listen neither starts nor restarts one.
      expect(await agentCli(['listen', '--room', r.roomId, '--wait-seconds', '1'])).toMatchObject({ state: 'timeout' });
      expect(existsSync(join(r.agent.dir, 'runner.pid'))).toBe(false);
    });
    expect(existsSync(join(r.agent.dir, 'watch.json'))).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.MESHROOMS_AGENT_HOME; else process.env.MESHROOMS_AGENT_HOME = saved;
  }
});

test('the watcher\'s own files never follow a planted link, and clearing the wake folder never follows one out', () => {
  const home = tempHome(), target = join(home, 'profile.sh'), run = join(home, 'watch-run.out');
  writeFileSync(target, 'original');
  let linked = false;
  try { symlinkSync(target, run); linked = true; } catch { /* Windows without the privilege to make file links. */ }
  if (linked) {
    const fd = openFresh(run); closeSync(fd);
    writeFresh(join(home, 'watch-prompt.txt'), 'prompt');
    expect(readFileSync(target, 'utf8')).toBe('original');
    expect(lstatSync(run).isSymbolicLink()).toBe(false);
    symlinkSync(target, join(home, 'watch.log'));
    appendNoFollow(join(home, 'watch.log'), 'line\n');
    expect(readFileSync(target, 'utf8')).toBe('original');
  }
  // The wake folder holds a junction (or link) to a folder outside: emptying it removes the junction, never what it points to.
  const wake = join(home, 'wake'), outside = join(home, 'outside');
  mkdirSync(join(wake, 'sub'), { recursive: true }); mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'keep'); writeFileSync(join(wake, 'sub', 'x.txt'), 'x'); writeFileSync(join(wake, 'y.txt'), 'y');
  symlinkSync(outside, join(wake, 'escape'), 'junction');
  clearDir(wake);
  expect(readdirSync(wake)).toEqual([]);
  expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
});

test('a session claim is held by one watcher at a time, and taken over once its holders are gone or its time is up', () => {
  const dir = tempHome(), live = new Set([process.pid]);
  let now = 1_000_000;
  const claim = sessionClaim(dir, 'claude:/work/project', pid => live.has(pid), () => now);
  const first = claim(60_000)!;
  expect(first).toBeDefined();
  expect(claim(60_000)).toBeUndefined();
  first.started(4321); live.add(4321);
  first.release();
  const second = claim(60_000)!;
  expect(second).toBeDefined();
  // Its time is up: taken over although the pid is alive (pids get reused).
  now += 120_000;
  expect(claim(60_000)).toBeDefined();
  expect(sessionKey({ harness: 'codex', session: 'T', cwd: '/w', command: undefined })).toBe(sessionKey({ harness: 'codex', session: 'T', cwd: '/elsewhere', command: undefined }));
  expect(sessionKey({ harness: 'claude', cwd: '/w/a' })).not.toBe(sessionKey({ harness: 'claude', cwd: '/w/b' }));
});

test('the agent-wide wake count is kept in one file and forgets wakes older than an hour', () => {
  const path = join(tempHome(), 'watch-wakes.json'), ledgerFile = wakeLedger(path);
  ledgerFile.add(1_000_000); ledgerFile.add(2_000_000);
  expect(ledgerFile.recent(2_000_000)).toBe(2);
  expect(ledgerFile.recent(1_000_000 + 3_600_001)).toBe(1);
});

test('a run is known by its room\'s mark and its start time, so a process that later gets its pid is never taken for it', () => {
  const fingerprint = runFingerprint({ roomDir: 'C:\\Users\\me\\.meshrooms\\agents\\browser-agents\\ROOM' });
  const run = { fingerprint, started: '2026-01-01T10:00:00.0000000Z' };
  const claude = '"claude.exe" -p --add-dir C:\\Users\\me\\.meshrooms\\agents\\browser-agents\\ROOM\\wake';
  // Claude names the room's wake folder; Codex names it inside a JSON string (backslashes doubled); both are the run.
  expect(sameRun(run, { command: claude, started: run.started })).toBe(true);
  expect(sameRun(run, { command: 'node codex.js exec resume T -c permissions.x.filesystem={ "C:\\\\Users\\\\me\\\\.meshrooms\\\\agents\\\\browser-agents\\\\ROOM\\\\live" = "write" }', started: run.started })).toBe(true);
  // The operator's own Claude or Codex, or any node, that got the pid later: not the run.
  expect(sameRun(run, { command: '"claude.exe"', started: run.started })).toBe(false);
  expect(sameRun(run, { command: 'node codex.js', started: run.started })).toBe(false);
  // An editor or terminal showing the room's folder: its path alone is not enough.
  expect(sameRun(run, { command: 'code C:\\Users\\me\\.meshrooms\\agents\\browser-agents\\ROOM', started: '2026-01-01T09:00:00.0000000Z' })).toBe(false);
  // The same command started at another time: another process.
  expect(sameRun(run, { command: claude, started: '2026-01-01T11:00:00.0000000Z' })).toBe(false);
  // Fails closed: a start time that couldn't be read, then or now, means not the run (no wait, no kill).
  expect(sameRun({ fingerprint }, { command: claude, started: run.started })).toBe(false);
  expect(sameRun(run, { command: claude })).toBe(false);
  expect(sameRun(run, undefined)).toBe(false);
  expect(sameRun({}, { command: 'anything', started: run.started })).toBe(false);
});

test('killing an orphaned run signals its own group, and SIGKILL follows only while it is still that run; without ps nothing is signalled', () => {
  const signals: [number, string][] = [], taskkills: number[] = [];
  let pending: (() => void) | undefined;
  const fake = (leader: boolean, platform: NodeJS.Platform = 'linux'): KillDeps => ({ platform, signal: (target, signal) => { signals.push([target, signal]); }, leader: () => leader,
    later: work => { pending = work; }, taskkill: pid => { taskkills.push(pid); } });
  expect(killTree(4321, 5_000, fake(true), () => true)).toBe(true);
  expect(signals).toEqual([[-4321, 'SIGTERM']]);
  pending!();
  expect(signals).toEqual([[-4321, 'SIGTERM'], [-4321, 'SIGKILL']]);
  // By the time SIGKILL is due, the pid is no longer that run: nothing more is sent.
  signals.length = 0; pending = undefined;
  killTree(4321, 5_000, fake(true), () => false); pending!();
  expect(signals).toEqual([[-4321, 'SIGTERM']]);
  // Not a group leader, or no `ps` to tell (a slim container): not taken for a run of ours, so nothing is signalled.
  signals.length = 0; pending = undefined;
  expect(killTree(999, 5_000, { ...fake(false), leader: () => { throw new Error('ps: not found'); } } as KillDeps)).toBe(false);
  expect(killTree(999, 5_000, fake(false))).toBe(false);
  expect(signals).toEqual([]);
  expect(pending).toBeUndefined();
  // Windows: the whole tree through taskkill /T /F.
  expect(killTree(777, 5_000, fake(true, 'win32'))).toBe(true);
  expect(taskkills).toEqual([777]);
  // After every run, what it left in its group gets SIGTERM only: no SIGKILL that nothing could re-verify.
  signals.length = 0; pending = undefined;
  reapGroup(4321, fake(true));
  expect(signals).toEqual([[-4321, 'SIGTERM']]);
  expect(pending).toBeUndefined();
  reapGroup(4321, fake(true, 'win32'));
  expect(signals).toEqual([[-4321, 'SIGTERM']]);
});

test('a run past its timeout is stopped by the handle the watcher holds, with no ps needed', () => {
  const signals: [number, string][] = [];
  let pending: (() => void) | undefined;
  const deps: KillDeps = { platform: 'linux', signal: (target, signal) => { signals.push([target, signal]); }, leader: () => { throw new Error('ps: not found'); },
    later: work => { pending = work; }, taskkill: () => {} };
  const child = { pid: 5555, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, kill: () => true };
  stopOwnChild(child, 5_000, deps);
  expect(signals).toEqual([[-5555, 'SIGTERM']]);
  pending!();
  expect(signals).toEqual([[-5555, 'SIGTERM'], [-5555, 'SIGKILL']]);
  // It ended in time: no SIGKILL.
  signals.length = 0;
  stopOwnChild(child, 5_000, deps); child.exitCode = 0; pending!();
  expect(signals).toEqual([[-5555, 'SIGTERM']]);
  // The group is gone but the child isn't: the child itself is signalled.
  const own: string[] = [];
  stopOwnChild({ pid: 6666, exitCode: null, signalCode: null, kill: signal => { own.push(String(signal)); return true; } }, 5_000, { ...deps, signal: () => { throw new Error('ESRCH'); } });
  expect(own).toEqual(['SIGTERM']);
});

test('the runner checks a queued item again, whoever wrote the outbox: ids, the floor, who is asked, who may close, and text limits', () => {
  const r = room();
  const mention = r.say('@Wren can you look?');
  const good = { id: crypto.randomUUID(), text: 'On it', replyTo: mention };
  expect(outboxProblem(r.agent, wren, good)).toBeUndefined();
  expect(outboxProblem(r.agent, wren, { ...good, id: '../../elsewhere/x' })).toContain('not a UUID');
  expect(outboxProblem(r.agent, wren, { ...good, replyTo: 'x/y' })).toContain('reply target');
  expect(outboxProblem(r.agent, wren, { id: crypto.randomUUID(), text: 'Unprompted' })).toContain('addressed');
  expect(outboxProblem(r.agent, wren, { ...good, text: 'x'.repeat(4001) })).toContain('4,000');
  expect(outboxProblem(r.agent, wren, { ...good, text: '  ' })).toContain('empty');
  // Decisions: opening one is speaking; advice only when asked or addressed; only a steward closes.
  const decisionId = crypto.randomUUID();
  expect(outboxProblem(r.agent, wren, { type: 'decision', action: 'open', id: crypto.randomUUID(), decisionId })).toContain('humans-first');
  expect(outboxProblem(r.agent, wren, { type: 'decision', action: 'open', id: crypto.randomUUID(), decisionId, replyTo: mention })).toBeUndefined();
  const notAsking = openDecision({ roomId: r.roomId, deviceId, memberId: alex, question: 'Lunch?', options: ['A', 'B'], askAgents: false });
  writeFileSync(join(r.agent.dir, 'decisions.json'), JSON.stringify([{ body: notAsking, signature: '', seq: 1 }]));
  const vote = { type: 'decision', action: 'vote', id: crypto.randomUUID(), decisionId: notAsking.decisionId, optionId: null, comment: '' };
  expect(outboxProblem(r.agent, wren, vote)).toContain('did not ask');
  expect(outboxProblem(r.agent, wren, { ...vote, replyTo: mention })).toBeUndefined();
  expect(outboxProblem(r.agent, wren, { type: 'decision', action: 'close', id: crypto.randomUUID(), decisionId: notAsking.decisionId })).toContain('only who opened');
  r.ask('Ship Friday?');
  const asking = r.agent.decisions().find(d => d.question === 'Ship Friday?')!;
  expect(outboxProblem(r.agent, wren, { ...vote, decisionId: asking.id })).toBeUndefined();
  expect(outboxProblem(r.agent, wren, { type: 'task', id: crypto.randomUUID(), taskId: 'x' })).toContain('task id');
  expect(outboxProblem(r.agent, wren, { type: 'reaction', id: crypto.randomUUID(), messageId: 'x' })).toContain('message id');
});

test('what the runner writes into wake-writable folders never follows a planted link, and a bad id writes nothing', async () => {
  const r = room(), outbox = join(r.agent.dir, 'outbox'), target = join(r.home, 'profile.sh');
  writeFileSync(target, 'original');
  const id = crypto.randomUUID();
  let linked = false;
  try { symlinkSync(target, join(outbox, `${id}.dropped`)); symlinkSync(target, join(r.agent.dir, 'files', 'a'.repeat(64))); linked = true; } catch { /* No privilege to make file links. */ }
  noteDropped(outbox, id, 'reason');
  noteDropped(outbox, '../escape', 'reason');
  expect(existsSync(join(r.agent.dir, 'escape.dropped'))).toBe(false);
  if (linked) {
    expect(readFileSync(target, 'utf8')).toBe('original');
    expect(lstatSync(join(outbox, `${id}.dropped`)).isSymbolicLink()).toBe(false);
    // A link in files/ is not a file the bridge holds.
    expect(r.agent.files.has('a'.repeat(64))).toBe(false);
  }
});

test('a first watcher starts from now only once admitted and synced: history that arrives later never wakes the agent', () => {
  const r = room(), now = 1_000_000;
  writeFileSync(join(r.agent.dir, 'members.json'), JSON.stringify({ members: [], devices: [] }));
  // Not admitted yet, then admitted but not yet in touch with another device, then in touch but still receiving.
  expect(startFromNow(r.agent, { syncedAt: now - 60_000 }, now)).toBe('waiting');
  writeFileSync(join(r.agent.dir, 'members.json'), JSON.stringify(roster(wren)));
  expect(startFromNow(r.agent, undefined, now)).toBe('waiting');
  expect(startFromNow(r.agent, { syncedAt: now - 1_000 }, now)).toBe('waiting');
  expect(r.cursor()).toBe('');
  // The history arrives meanwhile; once it had its moment, the cursor starts after it.
  r.say('@Wren an old question'); r.assign('Old task'); r.ask('Old ask?');
  expect(startFromNow(r.agent, { syncedAt: now - START_SETTLE_MS }, now)).toBe('started');
  expect(peekWork(r.agent).work).toBe(false);
  // A cursor that exists is left alone.
  expect(startFromNow(r.agent, { syncedAt: now - 60_000 }, now)).toBe('listening');
  const mention = r.say('@Wren a new one');
  expect(peekWork(r.agent)).toMatchObject({ work: true, addressed: [mention] });
});

test('a watcher that isn\'t ready yet keeps the heartbeat and never wakes the harness', async () => {
  const r = room(); await listened(r);
  r.say('@Wren can you look?');
  let ready = false;
  const h = harness(r), d = deps(r, h, { until: after(h, 120) });
  d.ready = () => ready || (ready = h.clock.now >= 1_000_000 + 60_000);
  await watchLoop(config(), d);
  expect(h.runs).toHaveLength(1);
  expect(h.runs[0].at).toBeGreaterThanOrEqual(1_000_000 + 60_000);
});

test('a Claude Code wake refuses a working folder that holds the agent, the bridge, or the operator\'s credentials', () => {
  const home = tempHome(), project = join(home, 'project'), secrets = [join(home, '.ssh'), join(home, '.meshrooms', 'agents')];
  for (const dir of [project, ...secrets]) mkdirSync(dir, { recursive: true });
  expect(cwdExposes(project, secrets)).toEqual([]);
  expect(cwdExposes(home, secrets)).toEqual(secrets);
  expect(cwdExposes(join(home, '.meshrooms'), secrets)).toEqual([secrets[1]]);
});

test('the CLI peeks without consuming, and checks watch options before starting anything', async () => {
  const home = tempHome(), saved = process.env.MESHROOMS_AGENT_HOME;
  process.env.MESHROOMS_AGENT_HOME = home;
  try {
    const r = room(home); await listened(r);
    const cursor = r.cursor();
    expect(await agentCli(['listen', '--room', r.roomId, '--peek'])).toMatchObject({ roomId: r.roomId, work: false });
    const mention = r.say('@Wren ping');
    expect(await agentCli(['listen', '--room', r.roomId, '--peek'])).toMatchObject({ work: true, addressed: [mention] });
    expect(r.cursor()).toBe(cursor);
    expect(await agentCli(['watch-status', '--room', r.roomId])).toMatchObject({ state: 'never-started', pid: null, paused: null, lastResult: null });
    await expect(agentCli(['watch', '--room', r.roomId, '--harness', 'nope'])).rejects.toThrow('--harness claude, codex, or exec');
    await expect(agentCli(['watch', '--room', r.roomId, '--harness', 'exec'])).rejects.toThrow('Give --command');
    await expect(agentCli(['watch', '--room', r.roomId, '--harness', 'exec', '--command', 'my-agent --go'])).rejects.toThrow('{prompt_file}');
    await expect(agentCli(['watch', '--room', r.roomId, '--harness', 'codex', '--last', '--allow-tools', 'Read'])).rejects.toThrow('--allow-tools is for --harness claude');
    await expect(agentCli(['watch', '--room', r.roomId, '--harness', 'codex'])).rejects.toThrow('For Codex, name the thread to wake');
    await expect(agentCli(['watch', '--room', r.roomId, '--harness', 'codex', '--session', 'T1', '--cwd', home])).rejects.toThrow('only finds the thread for --last');
    await expect(agentCli(['watch', '--room', r.roomId, '--harness', 'codex', '--last', '--harness-bin', join(home, 'no-codex.exe')])).rejects.toThrow("doesn't exist");
    await expect(agentCli(['watch', '--room', r.roomId, '--harness', 'claude', '--session', 'x', '--last'])).rejects.toThrow('not both');
    await expect(agentCli(['watch', '--room', r.roomId, '--harness', 'claude', '--session', 'not-a-uuid'])).rejects.toThrow('--session');
    await expect(agentCli(['watch', '--room', r.roomId, '--harness', 'claude', '--max-wakes-per-hour', '0'])).rejects.toThrow('--max-wakes-per-hour between 1 and 120');
    await expect(agentCli(['watch', '--room', r.roomId, '--harness', 'claude', '--max-agent-wakes-per-hour', '999'])).rejects.toThrow('--max-agent-wakes-per-hour between 1 and 240');
    await expect(agentCli(['watch', '--room', r.roomId, '--harness', 'claude', '--cwd', join(home, 'missing')])).rejects.toThrow('is not a folder');
    // A read-only Codex sandbox is never loosened.
    const codexHome = join(home, 'codex'); mkdirSync(codexHome);
    writeFileSync(join(codexHome, 'config.toml'), 'sandbox_mode = "read-only"\n');
    const savedCodex = process.env.CODEX_HOME; process.env.CODEX_HOME = codexHome;
    try { await expect(agentCli(['watch', '--room', r.roomId, '--harness', 'codex', '--session', '0190a000-0000-7000-8000-00000000000b'])).rejects.toThrow('never loosens it'); }
    finally { if (savedCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedCodex; }
    expect(existsSync(join(r.agent.dir, 'watch.json'))).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.MESHROOMS_AGENT_HOME; else process.env.MESHROOMS_AGENT_HOME = saved;
  }
});

test('a dropped note is read only when it is a small regular file, and a claim file stays in its folder whatever the link', () => {
  const r = room(), outbox = join(r.agent.dir, 'outbox'), target = join(r.home, 'secret.txt');
  writeFileSync(target, 'private');
  const id = crypto.randomUUID();
  writeFileSync(join(outbox, `${id}.dropped`), 'the reason');
  expect(takeDropped(outbox, id)).toBe('the reason');
  expect(takeDropped(outbox, id)).toBeUndefined();
  writeFileSync(join(outbox, `${id}.dropped`), 'x'.repeat(5000));
  expect(takeDropped(outbox, id)).toBeUndefined();
  let linked = false;
  try { symlinkSync(target, join(outbox, `${id}.dropped`)); linked = true; } catch { /* No privilege to make file links. */ }
  if (linked) { expect(takeDropped(outbox, id)).toBeUndefined(); expect(readFileSync(target, 'utf8')).toBe('private'); }
  // Issue claims: a link that isn't a strict GitHub issue link names no file, and a valid one stays inside the folder.
  const claims = join(r.home, 'claims');
  expect(() => claimIssueTask(claims, 'https://github.com/a\\..\\..\\b/c/issues/1', crypto.randomUUID())).toThrow('GitHub issue');
  releaseIssueTask(claims, 'https://evil.example/..%2f..%2fx/issues/1');
  expect(claimIssueTask(claims, 'https://github.com/owner/name/issues/42', crypto.randomUUID())).toBeUndefined();
  expect(readdirSync(claims)).toEqual(['owner_name_42.txt']);
  releaseIssueTask(claims, 'https://github.com/owner/name/issues/42');
  expect(readdirSync(claims)).toEqual([]);
});

test('one owner starts the runner: the watcher whenever one runs, a command only when none does', () => {
  expect(runnerOwner(true, () => false)).toBe('watcher');
  expect(runnerOwner(false, () => true)).toBe('watcher');
  expect(runnerOwner(false, () => false)).toBe('command');
});

test('right after a run the watcher checks the runner again, rather than a minute later', async () => {
  const r = room(); await listened(r);
  r.say('@Wren can you look?');
  const h = harness(r), checks: number[] = [];
  const d = deps(r, h, { until: after(h, 10) });
  d.ensureRunner = async () => { checks.push(h.clock.now); };
  await watchLoop(config(), d);
  expect(h.runs).toHaveLength(1);
  // Once at the start, and again as soon as the run ended, well inside the minute.
  expect(checks.length).toBe(2);
  expect(checks[1] - checks[0]).toBeLessThan(WATCH_TIMING.runnerCheckMs);
});

test('a Codex thread\'s project roots a .env glob only when it is narrower than the home folder: never home, a folder holding it, or a root', () => {
  const home = resolve(tempHome()), project = join(home, 'work', 'app'), root = resolve('/');
  expect(envProjectProblem(home, project)).toBeUndefined();
  expect(envProjectProblem(home, home)).toContain('home folder');
  expect(envProjectProblem(home, dirname(home))).toContain('holds the home folder');
  expect(envProjectProblem(home, root)).toContain('root');
  expect(envProjectProblem(home, 'relative/app')).toContain('absolute');
  // Too wide: only the home folder's own .env files are denied, never a scan of all of it.
  expect(codexEnvDenies(home, home)).toEqual([join(home, '.env*')]);
  expect(codexEnvDenies(home, dirname(home))).toEqual([join(home, '.env*')]);
  expect(codexEnvDenies(home, root)).toEqual([join(home, '.env*')]);
  expect(codexEnvDenies(home, project)).toEqual([join(home, '.env*'), join(project, '**', '.env*')]);
  // Why the project glob was dropped is said, so the watcher can log it once and watch can warn.
  const codex = { harness: 'codex' as const };
  expect(envProject({ ...codex, session: 'a-thread-name' }, home, () => undefined).dropped).toContain('not a thread id');
  expect(envProject({ ...codex, session: '0190a000-0000-7000-8000-00000000000b' }, home, () => undefined).dropped).toContain("rollout file wasn't found");
  expect(envProject({ ...codex, session: '0190a000-0000-7000-8000-00000000000b' }, home, () => ({ file: 'x', cwd: home })).dropped).toContain('home folder');
  expect(envProject({ ...codex, session: '0190a000-0000-7000-8000-00000000000b' }, home, () => ({ file: 'x', cwd: project }))).toEqual({ project });
  expect(envProject({ harness: 'claude', session: undefined }, home)).toEqual({});
});

test('an agent-registry override can only add agent folders to deny, never hide the recorded ones; older unrecorded agents-* folders are denied too', () => {
  const home = tempHome(), meshrooms = join(home, '.meshrooms'), custom = join(home, 'bots'), agentHome = join(custom, 'agent-a'), roomDir = join(agentHome, 'browser-agents', 'room');
  const recorded = join(home, 'elsewhere', 'agent-b'), added = join(home, 'more', 'agent-c'), oldSibling = join(custom, 'agents-old');
  for (const dir of [roomDir, recorded, added, oldSibling, join(meshrooms, 'bin')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(meshrooms, 'agent-homes.json'), JSON.stringify([recorded]));
  const override = join(home, 'override.json');
  writeFileSync(override, JSON.stringify([added]));
  const saved = process.env.MESHROOMS_AGENT_REGISTRY;
  process.env.MESHROOMS_AGENT_REGISTRY = override;
  try {
    const paths = wakeReadDenies({ agentHome, roomDir, binDir: join(meshrooms, 'bin') }, home, join(home, '.codex')).map(d => d.path);
    for (const denied of [recorded, added, oldSibling]) expect(paths).toContain(resolve(denied));
    expect(paths).not.toContain(resolve(roomDir));
  } finally { if (saved === undefined) delete process.env.MESHROOMS_AGENT_REGISTRY; else process.env.MESHROOMS_AGENT_REGISTRY = saved; }
});

test('during a run each heartbeat also checks the runner, so one that stops mid-wake is repaired then', async () => {
  const r = room(); await listened(r);
  r.say('@Wren a long one');
  const h = harness(r), checks: string[] = [];
  const d = deps(r, h, { until: after(h, 5) });
  let running = false;
  d.ensureRunner = async () => { checks.push(running ? 'during' : 'between'); };
  const run = h.run;
  d.run = async onStart => { running = true; await Bun.sleep(120); running = false; return run(onStart); };
  await watchLoop(config(), d, { ...WATCH_TIMING, heartbeatMs: 20 });
  expect(checks.filter(c => c === 'during').length).toBeGreaterThanOrEqual(2);
});
