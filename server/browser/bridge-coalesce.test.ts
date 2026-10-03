/**
 * Wakes across rooms and sessions, end to end through the real wake path: watchLoop with the real session ledger,
 * prompt, runProgram, harnessInvocation and readHarnessOutput, and a fake harness that is a Bun script (run by
 * process.execPath, so it runs the same on Windows). The fake reads the prompt, "listens" by moving the agent's cursor,
 * replies with the request ids the prompt gives, and logs every delivery. The clock is fake: only the harness runs take
 * real time.
 */
import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { answeredItems, wakePrompt } from '../agent-cli';
import {
  BUSY_NOTE, HALTED_NOTE, LEDGER_LOCK_MAX_AGE_MS, WATCH_TIMING, canonicalPath, emptyState, harnessInvocation, processInfo, readHarnessOutput, replyKey, replyRequestId, runFingerprint, runIdentity,
  runProgram, sessionKey, sessionLedger, wakeReadDenies, watchLoop, writeFresh, type RunOutcome, type WatchConfig, type WatchDeps, type WatchState,
} from '../agent-watch';
import { BrowserAgent, peekWork } from '../browser-agent';
import { processRuns } from './fake-runner';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'mr-coalesce-')); dirs.push(dir); return dir; };
const alex = crypto.randomUUID(), wren = crypto.randomUUID(), deviceId = 'a'.repeat(64);

/** The fake harness: what a woken agent does, driven by its room's control file. */
const FAKE = `const fs = require('fs'), path = require('path');
const [promptFile] = process.argv.slice(2);
const control = JSON.parse(fs.readFileSync(process.env.FAKE_CONTROL, 'utf8'));
const log = entry => fs.appendFileSync(path.join(control.shared, 'deliveries.jsonl'), JSON.stringify({ room: process.env.MESHROOMS_WAKE_ROOM, ...entry }) + '\\n');
if (control.lease && fs.existsSync(control.lease)) { log({ refused: true }); process.stderr.write('SESSION_NOT_OWNED\\n'); process.exit(1); }
if (control.registry && fs.existsSync(control.registry)) { log({ broken: true }); process.stderr.write('ActiveSessionRegistryError: the active session registry is unreadable\\n'); process.exit(1); }
const busy = path.join(control.shared, 'busy');
let overlap = false;
try { fs.writeFileSync(busy, process.env.MESHROOMS_WAKE_ROOM, { flag: 'wx' }); } catch { overlap = true; }
const prompt = fs.readFileSync(promptFile, 'utf8');
const replies = [...prompt.matchAll(/([0-9a-f-]{36}) -> ([0-9a-f-]{36})/g)].map(m => ({ message: m[1], id: m[2] }));
const skip = /Already answered.*?skip unless someone asked again: (.*)\\./.exec(prompt)?.[1]?.split(', ') ?? [];
const file = path.join(control.roomDir, 'messages.json');
const messages = () => JSON.parse(fs.readFileSync(file, 'utf8'));
// listen: everything so far is read (unless this harness never gets that far).
const all = messages();
if (!control.noListen) fs.writeFileSync(path.join(control.roomDir, 'live', 'listen-cursor.json'), JSON.stringify({ after: all.at(-1).packet.body.id, boardAfter: 0, decisionsAfter: 0 }));
const add = (id, text, memberId, replyTo) => {
  const now = messages();
  if (now.some(m => m.packet.body.id === id)) return false;
  now.push({ packet: { body: { kind: 'message', roomId: control.roomId, id, deviceId: '${deviceId}', memberId, text, at: Date.now(), ...(replyTo ? { replyTo } : {}) }, signature: '' }, targets: [], receipts: [] });
  fs.writeFileSync(file, JSON.stringify(now));
  return true;
};
const replied = [];
for (const [i, r] of replies.filter(r => !skip.includes(r.message)).entries()) {
  if (control.noReply || control.noListen || (control.partial && i > 0)) break;
  if (add(r.id, 'On it.', control.agent, r.message)) replied.push(r.message);
}
// A retry that re-sends an answered reply with its fixed id changes nothing (the id is the message's id in the room).
const resent = [];
for (const id of control.resend ?? []) { const again = replies.find(r => r.message === id); if (again) { resent.push(id); add(again.id, 'On it.', control.agent, id); } }
// More mentions arrive while it runs: "during" in its first wake only, "flood" in every one.
const once = path.join(control.shared, 'during-' + control.roomId);
const arriving = (control.flood ?? 0) + (control.during && !fs.existsSync(once) ? control.during : 0);
if (control.during) fs.writeFileSync(once, '1');
for (let i = 0; i < arriving; i++) add(crypto.randomUUID(), '@Wren and another thing', control.human);
const until = Date.now() + (control.sleepMs ?? 0); while (Date.now() < until) {}
log({ replied, skip, overlap, resent, offered: replies.map(r => r.message) });
if (!overlap) fs.unlinkSync(busy);
process.exit(control.exitCode ?? 0);
`;

/** A room folder as the runner leaves it, for the agent Wren, with one old message already read. */
function room(home: string, shared: string, roomId = crypto.randomUUID()) {
  const agent = new BrowserAgent(home, 'http://127.0.0.1:1', roomId);
  writeFileSync(join(agent.dir, 'members.json'), JSON.stringify({ memberId: wren, ownerId: alex, members: [{ id: alex, name: 'Alex', role: 'human' }, { id: wren, name: 'Wren', role: 'agent', operatorId: alex }], devices: [] }));
  writeFileSync(join(agent.dir, 'settings.json'), JSON.stringify({ floor: 'humans-first' }));
  writeFileSync(join(agent.dir, 'room.json'), JSON.stringify({ origin: 'http://127.0.0.1:1', roomId }));
  const say = (text: string) => {
    const body = { kind: 'message', roomId, id: crypto.randomUUID(), deviceId, memberId: alex, text, at: Date.now() };
    writeFileSync(join(agent.dir, 'messages.json'), JSON.stringify([...agent.messages(), { packet: { body, signature: '' }, targets: [], receipts: [] }]));
    return body.id;
  };
  agent.saveListenCursor({ after: say('Morning, everyone'), boardAfter: 0, decisionsAfter: 0 });
  const controlFile = join(agent.dir, 'fake-control.json');
  const control = (extra: Record<string, unknown> = {}) => writeFileSync(controlFile, JSON.stringify({ shared, roomDir: agent.dir, roomId, agent: wren, human: alex, ...extra }));
  control();
  const replies = (to: string) => agent.messages().filter(m => m.packet.body.memberId === wren && m.packet.body.replyTo === to).length;
  return { agent, roomId, say, control, controlFile, replies };
}
type Room = ReturnType<typeof room>;
type Delivery = { room: string; refused?: boolean; broken?: boolean; replied?: string[]; skip?: string[]; overlap?: boolean; offered?: string[]; resent?: string[] };
const deliveries = (shared: string): Delivery[] => { try { return readFileSync(join(shared, 'deliveries.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

/** A machine for these tests: a fake clock every loop shares, the fake harness, and one session for every room. */
function machine() {
  const base = tempDir(), shared = join(base, 'shared'), script = join(base, 'fake-harness.js'), locks = join(base, 'locks'), home = join(base, 'agents');
  mkdirSync(shared); mkdirSync(home);
  writeFileSync(script, FAKE);
  const clock = { now: 1_000_000 }, hooks: (() => void)[] = [];
  const key = replyKey(home);
  /** The deps of one room's watcher, as runWatch wires them, with the clock, state and stop condition of the test. */
  const watcher = (r: Room, options: { until: () => boolean; state?: { value: WatchState }; generation?: string; fenced?: () => string | undefined;
    outcome?: (result: RunOutcome) => RunOutcome; logs?: string[]; session?: string }) => {
    const state = options.state ?? { value: emptyState() };
    const config: WatchConfig = { roomId: r.roomId, harness: 'exec', cwd: base, command: `"${process.execPath}" "${script}" {prompt_file}`, maxWakesPerHour: 100, maxAgentWakesPerHour: 100,
      runTimeoutMinutes: 1, allowTools: [], launcher: 'x', agentHome: home, binDir: join(base, 'bin'), roomDir: r.agent.dir, ...(options.generation ? { generation: options.generation } : {}) };
    const ledger = sessionLedger(locks, sessionKey({ harness: 'claude', session: options.session ?? 'S', cwd: base }), r.roomId, {
      alive: pid => pid === process.pid || processRuns(pid), holdMs: 24 * 3_600_000, ownedMs: WATCH_TIMING.busyRetryMs, freshMs: 30_000, now: () => clock.now, ...(options.generation ? { generation: options.generation } : {}) });
    const promptFile = join(r.agent.dir, 'watch-prompt.txt');
    const deps: WatchDeps = {
      now: () => clock.now,
      sleep: async ms => { clock.now += ms; for (const hook of hooks) hook(); await new Promise(done => setTimeout(done, 1)); },
      peek: () => peekWork(r.agent),
      cursor: () => JSON.stringify(r.agent.listenCursor() ?? null),
      restoreCursor: saved => { const cursor = JSON.parse(saved); if (cursor) r.agent.saveListenCursor(cursor); },
      ownActions: () => r.agent.messages().filter(m => m.packet.body.memberId === wren).length,
      answered: (items, since) => answeredItems(r.agent, items, since),
      activity: { idle: () => r.agent.recordActivity('idle', undefined, clock.now), working: on => r.agent.recordActivity('working', on, clock.now),
        touch: () => r.agent.touchActivity(clock.now), setNote: text => r.agent.noteActivity(text, clock.now), currentNote: () => r.agent.activity()?.note },
      run: async (onStart, offer) => {
        const prompt = wakePrompt(config, wren, key, offer);
        writeFresh(promptFile, prompt);
        const result = await runProgram(harnessInvocation(config, prompt, promptFile), { cwd: base, timeoutMs: 60_000, output: join(r.agent.dir, 'watch-run'), onStart: pid => onStart(pid),
          env: { ...process.env, MESHROOMS_WAKE_ROOM: r.roomId, MESHROOMS_WAKE_DIR: join(r.agent.dir, 'wake'), FAKE_CONTROL: r.controlFile } });
        const read: RunOutcome = { exitCode: result.exitCode, ...readHarnessOutput('exec', result.stdout, result.stderr, result.exitCode) };
        return options.outcome ? options.outcome(read) : read;
      },
      ensureRunner: async () => {}, runAlive: () => false, killRun: () => {},
      agentWakes: { recent: () => 0, add: () => {} },
      claimSession: () => ledger.claim(), withdrawSession: () => ledger.withdraw(),
      ...(options.fenced ? { fenced: options.fenced } : {}),
      log: line => options.logs?.push(line),
      readState: () => structuredClone(state.value), writeState: next => { state.value = structuredClone(next); },
      stopped: options.until,
    };
    return { deps, state, config, ledger };
  };
  return { base, shared, clock, hooks, home, key, locks, watcher, room: () => room(home, shared), at: (seconds: number) => () => clock.now >= 1_000_000 + seconds * 1000 };
}
const exec = { maxWakesPerHour: 100, maxAgentWakesPerHour: 100, harness: 'exec' as const };

test('a burst of events while the session is held elsewhere: one pending offer, nothing pushed into it, no work lost', async () => {
  const m = machine(), r = m.room(), lease = join(m.base, 'lease');
  writeFileSync(lease, 'held by a desktop chat');
  r.control({ lease });
  const first = Array.from({ length: 5 }, (_, i) => r.say(`@Wren question ${i}`));
  // More arrive while it is held; the owner lets go at 2 minutes (the harness itself is the only signal).
  let more: string[] = [];
  m.hooks.push(() => { if (!more.length && m.clock.now >= 1_000_000 + 30_000) more = Array.from({ length: 5 }, (_, i) => r.say(`@Wren and ${i}`)); });
  m.hooks.push(() => { if (m.clock.now >= 1_000_000 + 120_000 && existsSync(lease)) unlinkSync(lease); });
  const w = m.watcher(r, { until: m.at(400) });
  // While it is held (at 200 s): one offer refused, nothing delivered or consumed, no obligation lost.
  let during: { sent: Delivery[]; owned: boolean; note?: string; state: WatchState; pending: string[] } | undefined;
  m.hooks.push(() => { if (!during && m.clock.now >= 1_000_000 + 200_000) during = { sent: deliveries(m.shared), owned: !!w.ledger.read().owned, note: r.agent.activity()?.note,
    state: structuredClone(w.state.value), pending: peekWork(r.agent).addressed }; });
  await watchLoop(exec, w.deps);
  expect(during!.sent).toEqual([expect.objectContaining({ refused: true })]);
  expect(during!.owned).toBe(true);
  expect(during!.note).toBe(BUSY_NOTE);
  expect(during!.state).toMatchObject({ noProgress: 0, busy: true });
  expect(during!.state.offer).toBeUndefined();
  expect(Object.keys(during!.state.obligations ?? {})).toEqual([]);
  expect(during!.pending.sort()).toEqual([...first, ...more].sort());
  // Released: exactly one more offer, which takes in everything that waited, each answered once.
  const sent = deliveries(m.shared);
  expect(sent).toHaveLength(2);
  expect(sent[1].replied!.sort()).toEqual([...first, ...more].sort());
  for (const id of [...first, ...more]) expect(r.replies(id)).toBe(1);
}, 60_000);

test('an owner that is idle but holds its lease still refuses: the offer is eligible again only after it lets go', async () => {
  const m = machine(), r = m.room(), lease = join(m.base, 'lease');
  writeFileSync(lease, 'an idle chat window');
  r.control({ lease });
  const mention = r.say('@Wren are you there?');
  const w = m.watcher(r, { until: m.at(620) });
  // The lease is held for 7 minutes: the offers at 0 and 5 minutes are refused by the harness itself.
  m.hooks.push(() => { if (m.clock.now >= 1_000_000 + 420_000 && existsSync(lease)) unlinkSync(lease); });
  await watchLoop(exec, w.deps);
  const sent = deliveries(m.shared);
  expect(sent.filter(d => d.refused)).toHaveLength(2);
  expect(sent.filter(d => d.replied)).toEqual([expect.objectContaining({ replied: [mention] })]);
  expect(r.replies(mention)).toBe(1);
  expect(w.state.value.noProgress).toBe(0);
}, 60_000);

test('two rooms bound to one session: one wake at a time, each confined to its own room, and both served, a flooding room no faster than in turn', async () => {
  const m = machine(), a = m.room(), b = m.room();
  // Room A floods: every wake of A sees more mentions arrive in A while it runs.
  a.control({ flood: 2, sleepMs: 50 }); b.control({ sleepMs: 50 });
  const aMentions = [a.say('@Wren in A')], bMention = b.say('@Wren in B');
  let stop = false;
  const wa = m.watcher(a, { until: () => stop || m.clock.now > 1_000_000 + 3_600_000 }), wb = m.watcher(b, { until: () => stop || m.clock.now > 1_000_000 + 3_600_000 });
  m.hooks.push(() => { if (deliveries(m.shared).filter(d => d.room === a.roomId).length >= 4) stop = true; });
  await Promise.all([watchLoop(exec, wa.deps), watchLoop(exec, wb.deps)]);
  const sent = deliveries(m.shared);
  // Never two at once, across rooms.
  expect(sent.some(d => d.overlap)).toBe(false);
  // Each wake ran for its own room only: the room it was woken for is the room it read and answered.
  for (const d of sent) for (const id of d.replied ?? []) expect((d.room === a.roomId ? a : b).agent.messages().some(msg => msg.packet.body.id === id)).toBe(true);
  // B was served after at most one of A's wakes, however much A keeps getting.
  const order = sent.map(d => d.room);
  expect(order.indexOf(b.roomId)).toBeGreaterThanOrEqual(0);
  expect(order.indexOf(b.roomId)).toBeLessThanOrEqual(1);
  expect(b.replies(bMention)).toBe(1);
  expect(a.replies(aMentions[0])).toBe(1);
}, 60_000);

test('events that arrive during a wake are covered by exactly one follow-up wake', async () => {
  const m = machine(), r = m.room();
  // The wake reads the room, then five more mentions arrive before it ends; after that, none.
  r.control({ during: 5 });
  const mention = r.say('@Wren first');
  const w = m.watcher(r, { until: m.at(600) });
  await watchLoop(exec, w.deps);
  const sent = deliveries(m.shared);
  expect(sent).toHaveLength(2);
  expect(sent[0].replied).toEqual([mention]);
  expect(sent[1].replied).toHaveLength(5);
  expect(peekWork(r.agent).work).toBe(false);
}, 60_000);

test('a watcher restarted while its run still goes (a crash mid-run) waits for it and dispatches nothing twice', async () => {
  const m = machine(), r = m.room();
  const mention = r.say('@Wren can you check the build?');
  // The previous watcher wrote down its offer and started a run, then died; the run goes on, detached.
  const w = m.watcher(r, { until: m.at(600) });
  const offer = { at: m.clock.now, before: JSON.stringify(r.agent.listenCursor()), items: [{ id: mention, kind: 'message' as const }] };
  const prompt = wakePrompt(w.config, wren, m.key, { items: offer.items, answered: [] });
  const promptFile = join(r.agent.dir, 'watch-prompt.txt');
  writeFresh(promptFile, prompt);
  r.control({ sleepMs: 4_000 });
  const child = spawn(process.execPath, [join(m.base, 'fake-harness.js'), promptFile, runFingerprint(w.config)], { detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, MESHROOMS_WAKE_ROOM: r.roomId, FAKE_CONTROL: r.controlFile } });
  // This test spans two clocks: the child takes real time, while watcher sleeps advance fake time.
  // Synchronize the first simulated poll with the child's actual exit. Otherwise the fake orphan
  // deadline can pass in under two real seconds, before the child's four-second run has finished.
  // Keep the real detached child and identity check: a mocked process would miss that boundary.
  const exited = new Promise<void>((done, fail) => {
    child.once('error', fail);
    child.once('exit', code => code === 0 ? done() : fail(new Error(`orphan harness exited ${code}`)));
  });
  const sleep = w.deps.sleep;
  w.deps.sleep = async ms => { await exited; await sleep(ms); };
  try {
    let started: string | undefined;
    for (const by = Date.now() + 20_000; !(started = processInfo(child.pid!)?.started);) { if (Date.now() > by) throw new Error('no start time'); await Bun.sleep(50); }
    const run = { pid: child.pid!, startedAt: m.clock.now, fingerprint: runFingerprint(w.config), started };
    w.state.value = { ...emptyState(), activeRun: run, offer };
    // The real identity check: the run is known by its room's mark (on its command line) and its start time.
    w.deps.runAlive = orphan => processRuns(orphan.pid) ? runIdentity(orphan, processInfo(orphan.pid)) : false;
    const logs: string[] = [];
    w.deps.log = line => logs.push(line);
    await watchLoop(exec, w.deps);
    expect(logs.some(line => line.includes('waiting for the harness run the previous watcher started'))).toBe(true);
    // Its reply counts: the offer it settled is not offered again, and nothing ran a second time.
    expect(deliveries(m.shared)).toHaveLength(1);
    expect(r.replies(mention)).toBe(1);
    expect(w.state.value.offer).toBeUndefined();
    expect(w.state.value.obligations ?? {}).toEqual({});
  } finally { try { process.kill(child.pid!, 'SIGKILL'); } catch { /* Gone. */ } }
}, 60_000);

test('unbinding or binding again while a wake runs: the old binding\'s outcome never touches the new binding\'s state', async () => {
  const m = machine(), r = m.room();
  const mention = r.say('@Wren can you look?');
  // The binding is replaced while the run is in progress, and the run then fails.
  let rebound = false;
  r.control({ exitCode: 1, noReply: true });
  const before = { ...emptyState(), noProgress: 1, wakes: [] as number[] };
  const old = m.watcher(r, { until: m.at(600), generation: 'g1', state: { value: before }, fenced: () => rebound ? 'the room was bound again' : undefined });
  const run = old.deps.run;
  old.deps.run = async (onStart, offer) => { const out = await run(onStart, offer); rebound = true; return out; };
  await watchLoop({ ...exec, generation: 'g1' }, old.deps);
  // Its counters and last result are untouched; its offer and run stay written down.
  expect(old.state.value.noProgress).toBe(0);
  expect(old.state.value.lastResult).toBeUndefined();
  expect(old.state.value.offer).toMatchObject({ generation: 'g1', items: [{ id: mention, kind: 'message' }] });
  expect(old.state.value.activeRun).toBeDefined();
  // The new binding's watcher settles that offer (read, failed, unanswered: offered again) and answers it once.
  r.control({});
  const next = m.watcher(r, { until: m.at(1200), generation: 'g2', state: { value: structuredClone(old.state.value) } });
  await watchLoop({ ...exec, generation: 'g2' }, next.deps);
  expect(r.replies(mention)).toBe(1);
  expect(next.state.value).toMatchObject({ noProgress: 0 });
  expect(next.state.value.lastResult).toMatchObject({ exitCode: 0, progress: true });
}, 60_000);

test('a wake that fails after listening, or after answering part of its work, gets the rest offered again and never repeats an answer', async () => {
  const m = machine(), r = m.room();
  const first = r.say('@Wren first question'), second = r.say('@Wren second question');
  // First wake: reads both, answers the first, then fails. Its retry would send the first again, by the same id.
  r.control({ partial: true, exitCode: 1 });
  let wakes = 0;
  m.hooks.push(() => { const n = deliveries(m.shared).length; if (n !== wakes) { wakes = n; r.control({ resend: [first] }); } });
  const logs: string[] = [];
  const w = m.watcher(r, { until: m.at(600), logs });
  await watchLoop(exec, w.deps);
  const sent = deliveries(m.shared);
  expect(sent).toHaveLength(2);
  expect(sent[0].replied).toEqual([first]);
  // The second wake is told the first is answered, with the fixed id of each reply. Its retry sends the first reply
  // again anyway, under that id: the same message, not a second one.
  expect(sent[1].skip).toEqual([first]);
  expect(sent[1].offered!.sort()).toEqual([first, second].sort());
  expect(sent[1].replied).toEqual([second]);
  expect(sent[1].resent).toEqual([first]);
  expect(r.replies(first)).toBe(1);
  expect(r.replies(second)).toBe(1);
  expect(logs.some(line => line.includes('offered again'))).toBe(true);
  expect(w.state.value.obligations ?? {}).toEqual({});
  // Past its tries, unanswered work stays pending and flagged, never dropped.
  const g = m.room(), stuck = g.say('@Wren will you ever answer?');
  g.control({ exitCode: 1, noReply: true });
  const gw = m.watcher(g, { until: m.at(1800) });
  await watchLoop(exec, gw.deps);
  expect(gw.state.value.obligations?.[stuck]).toMatchObject({ kind: 'message', offers: 2, flaggedAt: expect.any(Number) });
}, 60_000);

test('a broken ownership registry is a visible coordination failure: no fail-open, no retry loop, for every room on the session, until bound again', async () => {
  const m = machine(), a = m.room(), b = m.room(), registry = join(m.base, 'registry-broken');
  writeFileSync(registry, '1');
  a.control({ registry }); b.control({ registry });
  a.say('@Wren in A');
  const wa = m.watcher(a, { until: m.at(3600) });
  await watchLoop(exec, wa.deps);
  // One try, then nothing for an hour.
  expect(deliveries(m.shared)).toEqual([expect.objectContaining({ broken: true })]);
  expect(wa.state.value.halted?.reason).toContain('ActiveSessionRegistryError');
  expect(a.agent.activity()?.note).toBe(HALTED_NOTE);
  expect(wa.ledger.read().halted).toBeDefined();
  // Room B on the same session doesn't offer either.
  b.say('@Wren in B');
  const wb = m.watcher(b, { until: m.at(7200) });
  await watchLoop(exec, wb.deps);
  expect(deliveries(m.shared)).toHaveLength(1);
  expect(b.agent.activity()?.note).toBe(HALTED_NOTE);
  // Fixed and bound again (a new generation, the ledger's halt cleared by bind): served.
  unlinkSync(registry);
  wb.ledger.clearHalt();
  const again = m.watcher(b, { until: m.at(7800), generation: 'g2' });
  await watchLoop({ ...exec, generation: 'g2' }, again.deps);
  expect(deliveries(m.shared).filter(d => d.replied?.length)).toHaveLength(1);
}, 60_000);

test('one room can\'t hold up another on the same session: one that keeps failing, or is paused on a breach, leaves the session to the other', async () => {
  const m = machine(), a = m.room(), b = m.room();
  // A's harness never reads the room; then A is held by a hard pause. B must still be served each time it has work.
  a.control({ exitCode: 1, noListen: true, sleepMs: 20 }); b.control({});
  a.say('@Wren in A');
  let bServed = 0, bMentions = 0;
  const end = 1_000_000 + 2 * 3_600_000;
  m.hooks.push(() => {
    // B gets a new mention every ten minutes.
    if (m.clock.now >= 1_000_000 + bMentions * 600_000 && bMentions < 6) { b.say(`@Wren in B ${bMentions}`); bMentions++; }
  });
  const wa = m.watcher(a, { until: () => m.clock.now >= end }), wb = m.watcher(b, { until: () => m.clock.now >= end });
  await Promise.all([watchLoop(exec, wa.deps), watchLoop(exec, wb.deps)]);
  bServed = deliveries(m.shared).filter(d => d.room === b.roomId).reduce((n, d) => n + (d.replied?.length ?? 0), 0);
  expect(bServed).toBe(bMentions);
  expect(wa.state.value.paused).toBeDefined();
  // A breach in A pauses A's binding only.
  const c = m.room(), d = m.room();
  c.say('@Wren in C');
  const dMention = d.say('@Wren in D');
  const wc = m.watcher(c, { until: m.at(3 * 3600), outcome: out => ({ ...out, confinementBroken: true }) }), wd = m.watcher(d, { until: m.at(3 * 3600) });
  await Promise.all([watchLoop(exec, wc.deps), watchLoop(exec, wd.deps)]);
  expect(wc.state.value.paused).toMatchObject({ hard: true });
  expect(d.replies(dMention)).toBe(1);
  expect(peekWork(d.agent).work).toBe(false);
  expect(deliveries(m.shared).filter(x => x.room === d.roomId && x.replied?.length)).toHaveLength(1);
}, 120_000);

test('a session claim whose wake crashed expires: a gone watcher and run release it, and an overdue one is over', () => {
  const dir = tempDir(), live = new Set([301, 302]);
  let now = 1_000_000;
  const options = (pid: number) => ({ alive: (p: number) => live.has(p), holdMs: 60_000, ownedMs: 300_000, freshMs: 30_000, now: () => now, pid });
  const a = sessionLedger(dir, 'k', 'A', options(301)), b = sessionLedger(dir, 'k', 'B', options(302));
  const claim = a.claim();
  expect('wait' in claim).toBe(false);
  if (!('wait' in claim)) claim.started(4040);
  live.add(4040);
  expect(b.claim()).toMatchObject({ wait: 'running' });
  // A's watcher and its run both die (a crash): the claim is released at once.
  live.delete(301); live.delete(4040);
  expect('wait' in b.claim()).toBe(false);
  // A claim held past its lease is over even with its holders alive.
  const c = sessionLedger(dir, 'k2', 'C', options(302)), d = sessionLedger(dir, 'k2', 'D', { ...options(303) });
  live.add(303);
  expect('wait' in c.claim()).toBe(false);
  expect(d.claim()).toMatchObject({ wait: 'running' });
  now += 61_000;
  expect('wait' in d.claim()).toBe(false);
});

test('every room bound to one session computes one key, however the session is spelled; different sessions never share one', () => {
  const dir = tempDir(), store = join(dir, 'claude-config');
  mkdirSync(store);
  const key = (config: { harness: 'claude' | 'codex' | 'hermes'; session?: string; cwd: string }, env: Record<string, string>) => sessionKey(config, env, dir);
  const base = key({ harness: 'claude', session: 'S1', cwd: dir }, { CLAUDE_CONFIG_DIR: store });
  expect(key({ harness: 'claude', session: ' S1 ', cwd: join(dir, 'x', '..') }, { CLAUDE_CONFIG_DIR: `${store}${process.platform === 'win32' ? '\\' : '/'}` })).toBe(base);
  if (process.platform === 'win32') expect(key({ harness: 'claude', session: 'S1', cwd: dir }, { CLAUDE_CONFIG_DIR: store.toUpperCase().replaceAll('\\', '/') })).toBe(base);
  expect(canonicalPath(store)).toBe(canonicalPath(`${store}/.`));
  expect(key({ harness: 'claude', session: 'S2', cwd: dir }, { CLAUDE_CONFIG_DIR: store })).not.toBe(base);
  expect(key({ harness: 'codex', session: 'S1', cwd: dir }, { CODEX_HOME: store })).not.toBe(base);
  expect(key({ harness: 'claude', session: 'S1', cwd: dir }, { CLAUDE_CONFIG_DIR: join(dir, 'another') })).not.toBe(base);
  // Without an id, the folder decides; with one, it doesn't.
  expect(key({ harness: 'claude', cwd: join(dir, 'a') }, {})).not.toBe(key({ harness: 'claude', cwd: join(dir, 'b') }, {}));
  expect(key({ harness: 'hermes', session: 'S1', cwd: join(dir, 'a') }, {})).toBe(key({ harness: 'hermes', session: 'S1', cwd: join(dir, 'b') }, {}));
  // A uuid is one id in either case; other ids keep theirs.
  const id = '0190A000-ABCD-7000-8000-00000000000F';
  expect(key({ harness: 'claude', session: id, cwd: dir }, { CLAUDE_CONFIG_DIR: store })).toBe(key({ harness: 'claude', session: ` ${id.toLowerCase()}`, cwd: dir }, { CLAUDE_CONFIG_DIR: store }));
  expect(key({ harness: 'codex', session: id, cwd: dir }, {})).toBe(key({ harness: 'codex', session: id.toLowerCase(), cwd: dir }, {}));
  expect(key({ harness: 'hermes', session: '20260101_000000_ABCDEF', cwd: dir }, {})).not.toBe(key({ harness: 'hermes', session: '20260101_000000_abcdef', cwd: dir }, {}));
  // What a hand-edited watch.json holds is not trusted to be text.
  expect(() => sessionKey({ harness: 'exec', cwd: dir, command: 42 as unknown as string })).not.toThrow();
  expect(() => sessionKey({ harness: 'claude', cwd: dir, session: 7 as unknown as string })).not.toThrow();
});

test('a reply\'s request id is fixed per message for this agent, distinct per message, and can\'t be worked out from what the room can see', () => {
  const home = join(tempDir(), '.meshrooms', 'agents'), room = crypto.randomUUID(), m1 = crypto.randomUUID(), m2 = crypto.randomUUID();
  const key = replyKey(home), again = replyKey(home), other = replyKey(join(tempDir(), 'agents'));
  expect(Buffer.from(again).equals(Buffer.from(key))).toBe(true);
  const id = replyRequestId(key, room, wren, m1);
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(replyRequestId(key, room, wren, m1)).toBe(id);
  expect(replyRequestId(key, room, wren, m2)).not.toBe(id);
  expect(replyRequestId(key, room, alex, m1)).not.toBe(id);
  expect(replyRequestId(other, room, wren, m1)).not.toBe(id);
  // Not any plain hash of the room-visible values.
  const hex = id.replaceAll('-', '');
  for (const text of [`${room}${wren}${m1}`, `${room}:${wren}:${m1}`, `meshrooms-reply\0${room}\0${wren}\0${m1}`, m1])
    expect(createHash('sha256').update(text).digest('hex').slice(0, 32)).not.toBe(hex);
  // The key lives where no wake can read it.
  const roomDir = join(home, 'browser-agents', room), bin = join(home, '..', 'bin');
  mkdirSync(roomDir, { recursive: true }); mkdirSync(bin, { recursive: true });
  const denies = wakeReadDenies({ agentHome: home, roomDir, binDir: bin }, resolve(home, '..', '..'), join(tempDir(), '.codex'), { knownHomes: [] });
  expect(denies.some(d => resolve(d.path) === resolve(home, 'reply-key'))).toBe(true);
  // Made whole, never left half-written beside a draft; a damaged key is refused, not used or replaced.
  expect(readdirSync(home).filter(name => name.startsWith('reply-key'))).toEqual(['reply-key']);
  const short = join(tempDir(), 'agents');
  mkdirSync(short, { recursive: true });
  writeFileSync(join(short, 'reply-key'), 'too short');
  expect(() => replyKey(short)).toThrow(/damaged/);
  expect(readFileSync(join(short, 'reply-key'), 'utf8')).toBe('too short');
});

test('a session ledger whose lock is damaged says so at once, never "queued" forever; a lock left by a crash ages out, and a watcher\'s own unreleased turn is over', () => {
  const dir = tempDir(), live = new Set([401, 402]);
  // A clock that moves on every read, so who joined the line first never comes down to two calls in one millisecond.
  let tick = Date.now();
  const options = (pid: number) => ({ alive: (p: number) => live.has(p), holdMs: 60_000, ownedMs: 300_000, freshMs: 30_000, pid, now: () => ++tick });
  const a = sessionLedger(dir, 'k', 'A', options(401)), b = sessionLedger(dir, 'k', 'B', options(402));
  const lock = `${a.file}.lock`;
  mkdirSync(dir, { recursive: true });
  // A lock file that names no process: no waiting it out, the reason is given.
  writeFileSync(lock, 'not a pid');
  const started = Date.now();
  expect(a.claim()).toMatchObject({ wait: 'broken', reason: expect.stringContaining("doesn't name") });
  expect(Date.now() - started).toBeLessThan(1_500);
  // Leaving the line doesn't throw meanwhile.
  expect(() => a.withdraw()).not.toThrow();
  // Old enough, it was left by a crash, whatever it holds: taken over.
  const old = new Date(Date.now() - LEDGER_LOCK_MAX_AGE_MS - 5_000);
  utimesSync(lock, old, old);
  expect('wait' in a.claim()).toBe(false);
  expect(existsSync(lock)).toBe(false);
  // A lock that names a live process (its pid since reused, say) ages out the same way; so does a crashed reclaim marker.
  writeFileSync(lock, String(process.pid)); writeFileSync(`${lock}.reclaim`, String(process.pid));
  utimesSync(lock, old, old); utimesSync(`${lock}.reclaim`, old, old);
  expect(b.claim()).toMatchObject({ wait: 'running', room: 'A' });
  expect(existsSync(`${lock}.reclaim`)).toBe(false);
  // A's turn was never released (its release couldn't change the ledger): A asking again ends it, and B is first in line.
  expect(a.claim()).toMatchObject({ wait: 'queued', room: 'B' });
  expect('wait' in b.claim()).toBe(false);
});

test('a run is known by its room\'s mark and start time: the same run, another program, or a process that can\'t be told', () => {
  const run = { fingerprint: runFingerprint({ roomDir: join('work', 'room') }), started: 'Mon Oct  5 10:00:00 2026' };
  const command = `harness --add-dir ${join('work', 'room', 'wake')}`;
  expect(runIdentity(run, { command, started: run.started })).toBe(true);
  // Another program now has the pid, or the same mark with another start time: not the run.
  expect(runIdentity(run, { command: 'explorer.exe', started: run.started })).toBe(false);
  expect(runIdentity(run, { command, started: 'Mon Oct  5 11:00:00 2026' })).toBe(false);
  // Running but not visible (a protected process: no command line), or no start time to compare: unknown.
  expect(runIdentity(run, undefined)).toBe('unknown');
  expect(runIdentity({ fingerprint: run.fingerprint }, { command, started: run.started })).toBe('unknown');
  expect(runIdentity(run, { command })).toBe('unknown');
  expect(runIdentity({ started: run.started }, { command, started: run.started })).toBe(false);
});

test('a run from before a restart that can\'t be identified halts the watcher, and binding again is the operator\'s answer: it isn\'t halted on twice', async () => {
  const m = machine(), r = m.room();
  const mention = r.say('@Wren still there?');
  // The pid now belongs to a process that can't be inspected: alive, no command line.
  const orphan = { pid: 424242, startedAt: m.clock.now - 2 * 3_600_000 };
  const logs: string[] = [];
  const first = m.watcher(r, { until: m.at(60), generation: 'g1', logs, state: { value: { ...emptyState(), activeRun: orphan } } });
  first.deps.runAlive = () => 'unknown';
  await watchLoop({ ...exec, generation: 'g1' }, first.deps);
  expect(first.state.value.halted).toMatchObject({ pid: orphan.pid, generation: 'g1' });
  expect(first.state.value.activeRun).toMatchObject({ pid: orphan.pid });
  expect(r.agent.activity()?.note).toBe(HALTED_NOTE);
  expect(deliveries(m.shared)).toEqual([]);
  // Restarted on the same binding (the daemon restarts a watcher): still halted, nothing started.
  const again = m.watcher(r, { until: m.at(120), generation: 'g1', state: { value: structuredClone(first.state.value) } });
  again.deps.runAlive = () => 'unknown';
  await watchLoop({ ...exec, generation: 'g1' }, again.deps);
  expect(again.state.value.halted).toBeDefined();
  expect(deliveries(m.shared)).toEqual([]);
  // Bound again with that pid still unidentified: taken as checked, not waited for or halted on, and the work is done.
  const rebound = m.watcher(r, { until: m.at(600), generation: 'g2', logs, state: { value: structuredClone(again.state.value) } });
  rebound.deps.runAlive = () => 'unknown';
  await watchLoop({ ...exec, generation: 'g2' }, rebound.deps);
  expect(logs.some(line => line.includes('taken as checked'))).toBe(true);
  expect(rebound.state.value.halted).toBeUndefined();
  expect(rebound.state.value.activeRun).toBeUndefined();
  expect(r.replies(mention)).toBe(1);
  // Another pid that can't be identified halts again: binding again answered for the halted run only. The earlier halt is
  // kept here, so only the pid comparison tells this run from the one the operator answered.
  const next = m.watcher(r, { until: m.at(660), generation: 'g2', state: { value: { ...structuredClone(rebound.state.value), halted: structuredClone(first.state.value.halted), activeRun: { pid: 434343, startedAt: orphan.startedAt } } } });
  next.deps.runAlive = () => 'unknown';
  await watchLoop({ ...exec, generation: 'g2' }, next.deps);
  expect(next.state.value.halted).toMatchObject({ pid: 434343 });
}, 60_000);

test('work offered again names what the failed wake did answer, a task or decision too, by counting answers from its first offer', async () => {
  const m = machine(), r = m.room(), message = crypto.randomUUID(), task = crypto.randomUUID();
  const w = m.watcher(r, { until: m.at(600) });
  let cursor = 'before', taskAnsweredAt: number | undefined;
  const offers: { items: string[]; answered: string[] }[] = [];
  w.deps.cursor = () => cursor;
  w.deps.restoreCursor = saved => { cursor = saved; };
  w.deps.peek = () => cursor === 'before' ? { admitted: true, work: true, state: 'addressed', addressed: [message], tasks: [task], decisions: [] }
    : { admitted: true, work: false, state: 'waiting', addressed: [], tasks: [], decisions: [] };
  w.deps.answered = (items, since) => items.filter(item => item.kind === 'task' && taskAnsweredAt !== undefined && taskAnsweredAt >= since).map(item => item.id);
  w.deps.run = async (_onStart, offer) => {
    offers.push({ items: offer!.items.map(item => item.id), answered: offer!.answered });
    cursor = 'after';
    // The first wake updates the task, then fails before replying to the message.
    if (offers.length === 1) { taskAnsweredAt = m.clock.now; return { exitCode: 1 }; }
    return { exitCode: 0 };
  };
  await watchLoop(exec, w.deps);
  expect(offers).toHaveLength(2);
  expect(offers[1].items.sort()).toEqual([message, task].sort());
  expect(offers[1].answered).toEqual([task]);
  expect(w.state.value.obligations ?? {}).toEqual({});
}, 60_000);

test('only the harness\'s own error line is a broken ownership registry, never a line that merely mentions it', () => {
  const read = (stderr: string) => readHarnessOutput('hermes', '', stderr, 1).coordination;
  expect(read('Traceback (most recent call last):\n  ...\nhermes_cli.sessions.ActiveSessionRegistryError: unreadable\n')).toContain('ActiveSessionRegistryError');
  expect(read('ActiveSessionRegistryError: unreadable')).toBeDefined();
  expect(read('hermes-refusal-reason: ActiveSessionRegistryError')).toBeDefined();
  expect(read('warning: a room message said ActiveSessionRegistryError\n')).toBeUndefined();
  expect(read('  quoted: "ActiveSessionRegistryError: unreadable"')).toBeUndefined();
  expect(readHarnessOutput('hermes', '', 'ActiveSessionRegistryError: unreadable', 0).coordination).toBeUndefined();
});
