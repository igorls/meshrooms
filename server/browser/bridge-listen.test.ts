import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taskBody } from '../../src/browser/board';
import { foldDecisions, openDecision, reviseDecision, type DecisionBody } from '../../src/browser/decisions';
import { agentCli } from '../agent-cli';
import { BrowserAgent, FIRST_LISTEN_GRACE_MS, PENDING_PROFILE, RUNNER_STALE_MS, listenRemembering, peekWork, runBridge } from '../browser-agent';

const roomId = crypto.randomUUID(), alex = crypto.randomUUID(), wren = crypto.randomUUID(), deviceId = 'a'.repeat(64);
const members = { memberId: wren, ownerId: alex, members: [{ id: alex, name: 'Alex', role: 'human' as const }, { id: wren, name: 'Wren', role: 'agent' as const, operatorId: alex }], devices: [] };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function room() {
  const home = mkdtempSync(join(tmpdir(), 'mr-bridge-listen-')); dirs.push(home);
  const agent = new BrowserAgent(home, 'http://127.0.0.1:1', roomId);
  writeFileSync(join(agent.dir, 'members.json'), JSON.stringify(members));
  const append = (file: string, packet: object) => {
    const ops = JSON.parse((() => { try { return readFileSync(join(agent.dir, file), 'utf8'); } catch { return '[]'; } })());
    writeFileSync(join(agent.dir, file), JSON.stringify([...ops, { ...packet, seq: ops.length + 1 }]));
  };
  return {
    agent,
    say(text: string) {
      const body = { kind: 'message', roomId, id: crypto.randomUUID(), deviceId, memberId: alex, text, at: Date.now() };
      writeFileSync(join(agent.dir, 'messages.json'), JSON.stringify([...agent.messages(), { packet: { body, signature: '' }, targets: [], receipts: [] }]));
      return body.id;
    },
    assign(title: string) { const body = taskBody({ roomId, deviceId, memberId: alex, change: { title, assigneeId: wren } }); append('tasks.json', { body, signature: '' }); return body.taskId; },
    decide(body: DecisionBody) { append('decisions.json', { body, signature: '' }); return body.decisionId; },
    cursor: () => JSON.parse(readFileSync(join(agent.dir, 'live', 'listen-cursor.json'), 'utf8')),
  };
}
const ask = (question: string, memberId = alex) => openDecision({ roomId, deviceId, memberId, question, options: ['A', 'B'], askAgents: true });
type Listened = { state: string; addressed: string[]; tasks: { id: string }[]; decisions?: { asked: { id: string }[]; resolved: unknown[]; withdrawn?: { id: string }[] }; cursor?: string; resumed?: boolean; observed?: number };
const listen = (agent: BrowserAgent, flags = {}) => listenRemembering(agent, 1, flags) as Promise<Listened>;

test('a first plain listen returns history and wakes once on open assignments and open asks, then resumes from the saved cursors', async () => {
  const r = room();
  // This agent's own decision, withdrawn before it ever listened: old news, not a wake.
  const mine = ask('Mine?', wren); r.decide(mine);
  r.decide(reviseDecision({ roomId, deviceId, memberId: wren }, foldDecisions([mine], members)[0], { withdraw: true }));
  const hello = r.say('Morning, everyone'), task = r.assign('Fix the header'), asked = r.decide(ask('Which storage?'));
  const first = await listen(r.agent);
  expect(first).toMatchObject({ state: 'history', cursor: hello, addressed: [] });
  expect(first.resumed).toBeUndefined();
  expect(first.tasks.map(t => t.id)).toEqual([task]);
  expect(first.decisions?.asked.map(d => d.id)).toEqual([asked]);
  expect(first.decisions?.withdrawn).toBeUndefined();
  expect(r.cursor()).toEqual({ after: hello, boardAfter: 1, decisionsAfter: 3 });
  expect(r.agent.activity()).toMatchObject({ state: 'working', on: { tasks: [task] } });

  // Not twice: the next plain listen continues past them.
  const quiet = await listen(r.agent);
  expect(quiet).toMatchObject({ state: 'timeout', cursor: hello, resumed: true, messages: [] });
  expect(quiet.decisions).toBeUndefined();

  const mention = r.say('@Wren can you look?');
  expect(await listen(r.agent)).toMatchObject({ state: 'addressed', addressed: [mention], cursor: mention, resumed: true });
  const later = r.assign('Write the tests');
  expect((await listen(r.agent)).tasks.map(t => t.id)).toEqual([later]);
  const advice = r.decide(ask('Ship Friday?'));
  const woke = await listen(r.agent);
  expect(woke).toMatchObject({ state: 'addressed', resumed: true });
  expect(woke.decisions?.asked.map(d => d.id)).toEqual([advice]);
  expect(r.cursor()).toEqual({ after: mention, boardAfter: 2, decisionsAfter: 4 });
  // Outcomes of its own decisions wake it once it has a cursor.
  const next = ask('Tabs or spaces?', wren); r.decide(next);
  r.decide(reviseDecision({ roomId, deviceId, memberId: wren }, foldDecisions([next], members)[0], { withdraw: true }));
  expect((await listen(r.agent)).decisions?.withdrawn?.map(d => d.id)).toEqual([next.decisionId]);
});

test('explicit flags override the saved cursors, and fromStart drops them', async () => {
  const r = room();
  const hello = r.say('Morning'), task = r.assign('Fix the header'), asked = r.decide(ask('Which storage?'));
  await listen(r.agent);
  // An older loop that passes only --board-after: its value wins, the other cursors are resumed.
  const board = await listen(r.agent, { boardAfter: 0 });
  expect(board).toMatchObject({ state: 'addressed', cursor: hello, resumed: true });
  expect(board.tasks.map(t => t.id)).toEqual([task]);
  expect(board.decisions?.asked ?? []).toEqual([]);
  // Every cursor given: nothing saved was used.
  const explicit = await listen(r.agent, { after: hello, boardAfter: 1, decisionsAfter: 0 });
  expect(explicit.decisions?.asked.map(d => d.id)).toEqual([asked]);
  expect(explicit.resumed).toBeUndefined();
  const again = await listen(r.agent, { fromStart: true });
  expect(again).toMatchObject({ state: 'history', cursor: hello });
  expect(again.resumed).toBeUndefined();
  expect(again.tasks.map(t => t.id)).toEqual([task]);
  expect(again.decisions?.asked.map(d => d.id)).toEqual([asked]);
});

test('a timeout keeps the cursors, so observed messages come back with the next wake', async () => {
  const r = room();
  const hello = r.say('Morning');
  await listen(r.agent);
  const saved = r.cursor();
  const chatter = r.say('Lunch at noon?');
  const quiet = await listen(r.agent);
  expect(quiet).toMatchObject({ state: 'timeout', cursor: hello, observed: 1 });
  expect(r.cursor()).toEqual(saved);
  const mention = r.say('@Wren can you check the header?');
  const woke = await listen(r.agent) as Listened & { messages: { id: string }[] };
  expect(woke.messages.map(m => m.id)).toEqual([chatter, mention]);
  expect(woke.addressed).toEqual([mention]);
});

test('a first listen in a room without messages returns empty history promptly and saves where it stood', async () => {
  const r = room();
  const mine = ask('Which storage?', wren); r.decide(mine);
  // Given a long wait, it still answers once the sync had its moment, not at the end of the wait.
  const started = Date.now();
  const first = await listenRemembering(r.agent, 60) as Listened & { messages: unknown[] };
  expect(Date.now() - started).toBeGreaterThanOrEqual(FIRST_LISTEN_GRACE_MS - 50);
  expect(Date.now() - started).toBeLessThan(FIRST_LISTEN_GRACE_MS + 2_000);
  expect(first).toMatchObject({ state: 'history', messages: [], addressed: [], tasks: [] });
  expect(first.cursor).toBeUndefined();
  expect(first.resumed).toBeUndefined();
  expect(first.decisions).toBeUndefined();
  expect(r.cursor()).toEqual({ boardAfter: 0, decisionsAfter: 1 });
  // Later calls are unchanged: nothing new is a timeout.
  expect(await listen(r.agent)).toMatchObject({ state: 'timeout', resumed: true, messages: [] });
  // --from-start is a first listen again.
  expect(await listen(r.agent, { fromStart: true })).toMatchObject({ state: 'history', messages: [] });
  r.decide(reviseDecision({ roomId, deviceId, memberId: wren }, foldDecisions([mine], members)[0], { withdraw: true }));
  const withdrawn = await listen(r.agent);
  expect(withdrawn).toMatchObject({ state: 'addressed', resumed: true });
  expect(withdrawn.decisions?.withdrawn?.map(d => d.id)).toEqual([mine.decisionId]);
  const task = r.assign('Fix the header'), hello = r.say('Morning');
  const caught = await listen(r.agent);
  expect(caught).toMatchObject({ state: 'history', cursor: hello, resumed: true });
  expect(caught.tasks.map(t => t.id)).toEqual([task]);
}, 15_000);

test('a first listen in a room without messages but with work for the agent returns it as history at once', async () => {
  const r = room();
  const task = r.assign('Fix the header'), asked = r.decide(ask('Which storage?'));
  const started = Date.now();
  const first = await listenRemembering(r.agent, 60) as Listened & { messages: unknown[] };
  expect(Date.now() - started).toBeLessThan(FIRST_LISTEN_GRACE_MS);
  expect(first).toMatchObject({ state: 'history', messages: [], addressed: [] });
  expect(first.tasks.map(t => t.id)).toEqual([task]);
  expect(first.decisions?.asked.map(d => d.id)).toEqual([asked]);
  // Once, as documented: the next listen continues past them.
  expect(await listen(r.agent)).toMatchObject({ state: 'timeout', resumed: true });
});

test('a saved message cursor this folder no longer holds starts over instead of failing every listen', async () => {
  const r = room();
  // A folder from before live/ existed: its cursor is still read.
  writeFileSync(join(r.agent.dir, 'listen-cursor.json'), JSON.stringify({ after: crypto.randomUUID(), boardAfter: 0, decisionsAfter: 0 }));
  const hello = r.say('Morning');
  expect(await listen(r.agent)).toMatchObject({ state: 'history', cursor: hello, resumed: true });
  writeFileSync(join(r.agent.dir, 'live', 'listen-cursor.json'), '{"boardAfter":"x"}');
  expect((await listen(r.agent)).resumed).toBeUndefined();
});

test('saved board and decision cursors ahead of the folder (a reset) are stale, so assignments and asks still wake', async () => {
  const r = room();
  writeFileSync(join(r.agent.dir, 'listen-cursor.json'), JSON.stringify({ boardAfter: 999, decisionsAfter: 999 }));
  const taskId = r.assign('After a reset'), askId = r.decide(ask('Still asked?'));
  const woke = await listen(r.agent);
  expect(woke.tasks.map(t => t.id)).toEqual([taskId]);
  expect(woke.decisions?.asked.map(d => d.id)).toEqual([askId]);
  expect(r.cursor()).toMatchObject({ boardAfter: 1, decisionsAfter: 1 });
});

test('on an open floor a message that mentions only another agent does not wake this one', async () => {
  const r = room();
  const echo = crypto.randomUUID();
  writeFileSync(join(r.agent.dir, 'members.json'), JSON.stringify({ ...members, members: [...members.members, { id: echo, name: 'Echo', role: 'agent', operatorId: alex }] }));
  writeFileSync(join(r.agent.dir, 'settings.json'), JSON.stringify({ floor: 'open' }));
  const hello = r.say('Morning');
  expect(await listen(r.agent)).toMatchObject({ state: 'history', cursor: hello });
  // Seen in production: a message mentioning only another agent woke every agent.
  r.say('@Echo all good on your side?');
  expect(await listen(r.agent)).toMatchObject({ state: 'timeout', observed: 1 });
  const everyone = r.say('@agents stand by'), chatter = r.say('Lunch in five'), mine = r.say('@Wren can you look?');
  expect((await listen(r.agent)).addressed).toEqual([everyone, chatter, mine]);
  // Humans-first: the same messages wake it only where it is addressed.
  writeFileSync(join(r.agent.dir, 'settings.json'), JSON.stringify({ floor: 'humans-first' }));
  expect((await listen(r.agent, { fromStart: true })).addressed).toEqual([everyone, mine]);
});

test('listen and status follow the floor the host sets while the runner is up, even when members.json cannot be written', async () => {
  const r = room(), home = join(r.agent.dir, '..', '..'), before = process.env.MESHROOMS_AGENT_HOME;
  writeFileSync(join(r.agent.dir, 'room.json'), JSON.stringify({ origin: 'http://127.0.0.1:1', roomId }));
  let floor: 'humans-first' | 'open' = 'humans-first', closed = false, omit = false;
  const profiles: unknown[] = [];
  (r.agent as unknown as { command: (action: string, payload: unknown) => Promise<unknown> }).command = async (action, payload) => {
    if (action === 'profile') profiles.push(payload);
    if (action !== 'status') return {};
    if (closed) throw Object.assign(new Error('This room was closed by its host.'), { status: 410 });
    return { roomId, memberId: wren, ownerId: alex, epoch: 'one', members: members.members, devices: [], ...(omit ? {} : { settings: { floor, agentAssignmentsWake: false, guestAgentApproval: true } }) };
  };
  const status = async () => {
    process.env.MESHROOMS_AGENT_HOME = home;
    try { return await agentCli(['status', '--room', roomId]) as { floor: string; floorCheckedAt: string | null; floorLive: boolean }; } finally { if (before === undefined) delete process.env.MESHROOMS_AGENT_HOME; else process.env.MESHROOMS_AGENT_HOME = before; }
  };
  const settled = async (want: string) => {
    for (const by = Date.now() + 8_000; r.agent.settings().floor !== want && Date.now() < by;) await Bun.sleep(100);
    return (await status()).floor;
  };
  const bridge = runBridge(r.agent, () => {}).catch(error => error);
  try {
    r.say('Morning');
    expect(await listen(r.agent)).toMatchObject({ state: 'history', floor: 'humans-first' });
    // The host opens the floor: the next status the runner receives carries it to listen and status.
    floor = 'open';
    expect(await settled('open')).toBe('open');
    const chatter = r.say('Lunch in five');
    expect(await listen(r.agent)).toMatchObject({ state: 'addressed', floor: 'open', addressed: [chatter] });
    // status says when the runner last had the floor from the room (no runner process here, so not live).
    const reported = await status();
    expect(Date.now() - Date.parse(reported.floorCheckedAt!)).toBeLessThan(5_000);
    expect(reported.floorLive).toBe(false);
    // A status without settings keeps the rules the runner last heard, and still writes them: a lost copy comes back
    // as the room's floor, not the humans-first default.
    omit = true;
    rmSync(join(r.agent.dir, 'settings.json'));
    for (const by = Date.now() + 8_000; !existsSync(join(r.agent.dir, 'settings.json')) && Date.now() < by;) await Bun.sleep(100);
    expect(r.agent.settings().floor).toBe('open');
    expect((await status()).floor).toBe('open');
    omit = false;
    // A members.json the runner can't replace (here a folder in its place) no longer holds the floor back.
    rmSync(join(r.agent.dir, 'members.json')); mkdirSync(join(r.agent.dir, 'members.json'));
    floor = 'humans-first';
    expect(await settled('humans-first')).toBe('humans-first');
    // Nor the rest of the pass: work after the roster (here a pending profile report) still happens.
    writeFileSync(join(r.agent.dir, PENDING_PROFILE), JSON.stringify({ model: 'test-model' }));
    for (const by = Date.now() + 8_000; !profiles.length && Date.now() < by;) await Bun.sleep(100);
    expect(profiles).toEqual([{ model: 'test-model' }]);
    rmSync(join(r.agent.dir, 'members.json'), { recursive: true }); writeFileSync(join(r.agent.dir, 'members.json'), JSON.stringify(members));
    r.say('Anyone around?');
    expect(await listen(r.agent)).toMatchObject({ state: 'timeout', floor: 'humans-first' });
    // The host closes the room during a long wait: listen says so within moments instead of waiting out half an hour.
    const waiting = listenRemembering(r.agent, 1800), at = Date.now();
    await Bun.sleep(600);
    closed = true;
    expect(await waiting).toMatchObject({ state: 'closed', error: expect.stringContaining('closed by its host') });
    expect(Date.now() - at).toBeLessThan(10_000);
  } finally {
    closed = true;
    expect(String(await bridge)).toContain('closed by its host');
  }
}, 40_000);

test('a long listen notices a runner that stopped: it restarts it once, then hands the question back', async () => {
  const r = room(), alive = join(r.agent.dir, 'runner-alive.json');
  const hello = r.say('Morning');
  await listen(r.agent);
  let now = Date.now(), restarts = 0;
  setSystemTime(new Date(now));
  const advance = async (ms: number) => { now += ms; setSystemTime(new Date(now)); await Bun.sleep(700); };
  try {
    // A hung runner: its process lives on, but its proof of life stops. The restart brings a fresh one.
    writeFileSync(alive, JSON.stringify({ pid: process.pid, at: now }));
    const waiting = listenRemembering(r.agent, 1800, { restartRunner: async () => { restarts++; writeFileSync(alive, JSON.stringify({ pid: process.pid, at: Date.now() })); } });
    let settled = false; void waiting.finally(() => { settled = true; });
    await advance(RUNNER_STALE_MS + 1_000);
    expect(restarts).toBe(1);
    expect(settled).toBe(false); // Still waiting, now on the new runner.
    // The replacement stops too: listen returns rather than wait on files nothing updates, and consumes nothing.
    await advance(RUNNER_STALE_MS + 1_000);
    expect(await waiting).toMatchObject({ state: 'runner-stopped', cursor: hello, error: expect.stringContaining('Run listen again') });
    expect(restarts).toBe(1);
    // A proof naming a process that is gone needs no half-minute of silence.
    writeFileSync(alive, JSON.stringify({ pid: 2_147_483_000, at: now }));
    const gone = listenRemembering(r.agent, 1800);
    await advance(6_000);
    expect(await gone).toMatchObject({ state: 'runner-stopped', cursor: hello });
    // But the proof the replaced runner left behind names a process gone by design: the new runner, still starting
    // up, gets the full half-minute to write its own before listen gives up on it.
    let slowStarts = 0;
    writeFileSync(alive, JSON.stringify({ pid: 2_147_483_000, at: now }));
    const starting = listenRemembering(r.agent, 1800, { restartRunner: async () => { slowStarts++; writeFileSync(alive, JSON.stringify({ pid: 2_147_483_000, at: Date.now() - 1_000 })); } });
    let startingSettled = false; void starting.finally(() => { startingSettled = true; });
    await advance(6_000); // The dead pid, 6 s in: listen asks for a restart once, as the proof is its own era's.
    expect(slowStarts).toBe(1);
    await advance(6_000); // 6 s after the restart, the old proof no longer counts: still waiting on the new runner.
    expect(startingSettled).toBe(false);
    await advance(RUNNER_STALE_MS);
    expect(await starting).toMatchObject({ state: 'runner-stopped', cursor: hello });
    expect(slowStarts).toBe(1);
  } finally { setSystemTime(); }
  // Nothing was consumed: a message sent meanwhile still wakes the next listen.
  const mention = r.say('@Wren still there?');
  expect(await listen(r.agent)).toMatchObject({ state: 'addressed', addressed: [mention] });
}, 30_000);

test('a reply to another agent is for that agent: listen and the watch peek both leave it alone, on either floor', async () => {
  const r = room();
  const echo = crypto.randomUUID();
  writeFileSync(join(r.agent.dir, 'members.json'), JSON.stringify({ ...members, members: [...members.members, { id: echo, name: 'Echo', role: 'agent', operatorId: alex }] }));
  const post = (memberId: string, text: string, replyTo?: string) => {
    const body = { kind: 'message', roomId, id: crypto.randomUUID(), deviceId, memberId, text, at: Date.now(), ...(replyTo ? { replyTo } : {}) };
    writeFileSync(join(r.agent.dir, 'messages.json'), JSON.stringify([...r.agent.messages(), { packet: { body, signature: '' }, targets: [], receipts: [] }]));
    return body.id;
  };
  for (const floor of ['open', 'humans-first'] as const) {
    writeFileSync(join(r.agent.dir, 'settings.json'), JSON.stringify({ floor }));
    const fromEcho = post(echo, 'Echo here, the build is green'), fromWren = post(wren, 'Wren here, reviewing now');
    await listen(r.agent, { fromStart: true });
    // Seen in production: on an open floor a person's reply to another agent, naming nobody, woke this agent too.
    post(alex, 'Thanks, ship it', fromEcho);
    expect(peekWork(r.agent)).toMatchObject({ work: false, addressed: [] });
    expect(await listen(r.agent)).toMatchObject({ state: 'timeout', floor, observed: 1 });
    const mine = post(alex, 'Good, go ahead', fromWren);
    expect(peekWork(r.agent)).toMatchObject({ work: true, addressed: [mine] });
    expect(await listen(r.agent)).toMatchObject({ state: 'addressed', floor, addressed: [mine] });
  }
});
