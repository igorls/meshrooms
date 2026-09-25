import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taskBody } from '../../src/browser/board';
import { foldDecisions, openDecision, reviseDecision, type DecisionBody } from '../../src/browser/decisions';
import { BrowserAgent, listenRemembering } from '../browser-agent';

const roomId = crypto.randomUUID(), alex = crypto.randomUUID(), vesper = crypto.randomUUID(), deviceId = 'a'.repeat(64);
const members = { memberId: vesper, ownerId: alex, members: [{ id: alex, name: 'Alex', role: 'human' as const }, { id: vesper, name: 'Vesper', role: 'agent' as const, operatorId: alex }], devices: [] };
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
    assign(title: string) { const body = taskBody({ roomId, deviceId, memberId: alex, change: { title, assigneeId: vesper } }); append('tasks.json', { body, signature: '' }); return body.taskId; },
    decide(body: DecisionBody) { append('decisions.json', { body, signature: '' }); return body.decisionId; },
    cursor: () => JSON.parse(readFileSync(join(agent.dir, 'listen-cursor.json'), 'utf8')),
  };
}
const ask = (question: string, memberId = alex) => openDecision({ roomId, deviceId, memberId, question, options: ['A', 'B'], askAgents: true });
type Listened = { state: string; addressed: string[]; tasks: { id: string }[]; decisions?: { asked: { id: string }[]; resolved: unknown[]; withdrawn?: { id: string }[] }; cursor?: string; resumed?: boolean; observed?: number };
const listen = (agent: BrowserAgent, flags = {}) => listenRemembering(agent, 1, flags) as Promise<Listened>;

test('a first plain listen returns history and wakes once on open assignments and open asks, then resumes from the saved cursors', async () => {
  const r = room();
  // This agent's own decision, withdrawn before it ever listened: old news, not a wake.
  const mine = ask('Mine?', vesper); r.decide(mine);
  r.decide(reviseDecision({ roomId, deviceId, memberId: vesper }, foldDecisions([mine], members)[0], { withdraw: true }));
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

  const mention = r.say('@Vesper can you look?');
  expect(await listen(r.agent)).toMatchObject({ state: 'addressed', addressed: [mention], cursor: mention, resumed: true });
  const later = r.assign('Write the tests');
  expect((await listen(r.agent)).tasks.map(t => t.id)).toEqual([later]);
  const advice = r.decide(ask('Ship Friday?'));
  const woke = await listen(r.agent);
  expect(woke).toMatchObject({ state: 'addressed', resumed: true });
  expect(woke.decisions?.asked.map(d => d.id)).toEqual([advice]);
  expect(r.cursor()).toEqual({ after: mention, boardAfter: 2, decisionsAfter: 4 });
  // Outcomes of its own decisions wake it once it has a cursor.
  const next = ask('Tabs or spaces?', vesper); r.decide(next);
  r.decide(reviseDecision({ roomId, deviceId, memberId: vesper }, foldDecisions([next], members)[0], { withdraw: true }));
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
  const mention = r.say('@Vesper can you check the header?');
  const woke = await listen(r.agent) as Listened & { messages: { id: string }[] };
  expect(woke.messages.map(m => m.id)).toEqual([chatter, mention]);
  expect(woke.addressed).toEqual([mention]);
});

test('a fresh listen that times out saves where it stood, so later outcomes and work still wake it', async () => {
  const r = room();
  const mine = ask('Which storage?', vesper); r.decide(mine);
  expect(await listen(r.agent)).toMatchObject({ state: 'timeout' });
  expect(r.cursor()).toEqual({ boardAfter: 0, decisionsAfter: 1 });
  r.decide(reviseDecision({ roomId, deviceId, memberId: vesper }, foldDecisions([mine], members)[0], { withdraw: true }));
  const withdrawn = await listen(r.agent);
  expect(withdrawn).toMatchObject({ state: 'addressed', resumed: true });
  expect(withdrawn.decisions?.withdrawn?.map(d => d.id)).toEqual([mine.decisionId]);
  const task = r.assign('Fix the header'), hello = r.say('Morning');
  const first = await listen(r.agent);
  expect(first).toMatchObject({ state: 'history', cursor: hello, resumed: true });
  expect(first.tasks.map(t => t.id)).toEqual([task]);
});

test('a saved message cursor this folder no longer holds starts over instead of failing every listen', async () => {
  const r = room();
  writeFileSync(join(r.agent.dir, 'listen-cursor.json'), JSON.stringify({ after: crypto.randomUUID(), boardAfter: 0, decisionsAfter: 0 }));
  const hello = r.say('Morning');
  expect(await listen(r.agent)).toMatchObject({ state: 'history', cursor: hello, resumed: true });
  writeFileSync(join(r.agent.dir, 'listen-cursor.json'), '{"boardAfter":"x"}');
  expect((await listen(r.agent)).resumed).toBeUndefined();
});
