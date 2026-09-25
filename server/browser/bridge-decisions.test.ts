import { expect, test } from 'bun:test';
import { foldDecisions, openDecision } from '../../src/browser/decisions';
import { pickDecision } from '../browser-agent';

test('a quoted decision id prefers the agent’s own decision and never guesses between other people’s copies', () => {
  const roomId = crypto.randomUUID(), deviceId = 'a'.repeat(64), [me, igor, dom] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const room = { ownerId: igor, members: [{ id: me, role: 'agent' as const, operatorId: igor }, { id: igor }, { id: dom }] };
  const mine = openDecision({ roomId, deviceId, memberId: me, question: 'Mine', options: ['A', 'B'] });
  const copy = openDecision({ roomId, deviceId, memberId: dom, question: 'Copy', options: ['A', 'B'], decisionId: mine.decisionId });
  const other = openDecision({ roomId, deviceId, memberId: igor, question: 'Igor’s', options: ['A', 'B'], decisionId: mine.decisionId });
  expect(pickDecision(foldDecisions([mine, copy], room), mine.decisionId, me)?.question).toBe('Mine');
  expect(pickDecision(foldDecisions([mine], room), mine.decisionId, igor)?.question).toBe('Mine');
  expect(() => pickDecision(foldDecisions([copy, other], room), mine.decisionId, me)).toThrow('Several decisions');
  expect(pickDecision(foldDecisions([mine], room), crypto.randomUUID(), me)).toBeUndefined();
});

test('a forged decision cannot carry a genuine vote in with it', async () => {
  const { admitDecisionPackets } = await import('../browser-agent');
  const { castVote } = await import('../../src/browser/decisions');
  const roomId = crypto.randomUUID(), deviceId = 'b'.repeat(64), [alex, sam] = [crypto.randomUUID(), crypto.randomUUID()];
  const room = { ownerId: alex, members: [{ id: alex }, { id: sam }] };
  const real = openDecision({ roomId, deviceId, memberId: alex, question: 'Real', options: ['A', 'B'] });
  const forged = { ...real, id: crypto.randomUUID() }; // same key, bad signature
  const vote = castVote({ roomId, deviceId, memberId: sam }, foldDecisions([real], room)[0], 'o1');
  const genuine = async (_: unknown, signature: string) => signature === 'ok';
  expect(await admitDecisionPackets([], [{ body: forged, signature: 'bad' }, { body: vote, signature: 'ok' }], roomId, genuine)).toEqual([]);
  // Once the real decision is held (or arrives verified in the batch), the same vote is kept.
  expect((await admitDecisionPackets([real], [{ body: vote, signature: 'ok' }], roomId, genuine)).map(p => p.body.id)).toEqual([vote.id]);
  expect((await admitDecisionPackets([], [{ body: real, signature: 'ok' }, { body: vote, signature: 'ok' }], roomId, genuine)).map(p => p.body.kind)).toEqual(['decision', 'vote']);
  // Forged votes and duplicates are dropped.
  expect(await admitDecisionPackets([real], [{ body: vote, signature: 'bad' }], roomId, genuine)).toEqual([]);
  expect((await admitDecisionPackets([real], [{ body: vote, signature: 'ok' }, { body: vote, signature: 'ok' }], roomId, genuine)).length).toBe(1);
});

test('retrying a request whose vote compaction dropped reports it superseded and never overwrites the current vote', async () => {
  const { mkdtempSync, writeFileSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { BrowserAgent, compactDecisionLog, decisionBrowser } = await import('../browser-agent');
  const { castVote } = await import('../../src/browser/decisions');
  const roomId = crypto.randomUUID(), me = crypto.randomUUID(), igor = crypto.randomUUID(), deviceId = 'c'.repeat(64);
  const agent = new BrowserAgent(mkdtempSync(join(tmpdir(), 'mr-compacted-')), 'http://127.0.0.1:1', roomId);
  writeFileSync(join(agent.dir, 'members.json'), JSON.stringify({ memberId: me, ownerId: igor, members: [{ id: me, name: 'Vesper', role: 'agent', operatorId: igor }, { id: igor, name: 'Igor' }], devices: [] }));
  const open = openDecision({ roomId, deviceId, memberId: igor, question: 'Q', options: ['A', 'B'], askAgents: true });
  const d = foldDecisions([open], { ownerId: igor, members: [{ id: me, role: 'agent' }, { id: igor }] })[0];
  const first = castVote({ roomId, deviceId, memberId: me }, d, 'o1', '', 1), second = castVote({ roomId, deviceId, memberId: me }, d, 'o2', '', 2);
  const log = [open, first, second].map((body, i) => ({ body, signature: 's', seq: i + 1 }));
  writeFileSync(join(agent.dir, 'decisions.json'), JSON.stringify(compactDecisionLog(agent, log, me)));
  expect(agent.decisionOps().map(p => p.body.id)).toEqual([open.id, second.id]);
  const retry = await decisionBrowser(agent, { id: first.id, decisionId: open.decisionId, action: 'vote', optionId: 'o1', comment: '' }, 1);
  expect(retry.status).toBe('superseded');
  expect(readdirSync(join(agent.dir, 'outbox'))).toEqual([]); // nothing queued to be signed again
  expect(agent.decisions()[0].votes.find(v => v.memberId === me)?.optionId).toBe('o2');
});

test('a full log from before compaction is compacted when read, keeps its cursor, and accepts changes again', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { BrowserAgent, compactStoredDecisions } = await import('../browser-agent');
  const { castVote, admissible, MAX_DECISION_OPS } = await import('../../src/browser/decisions');
  const roomId = crypto.randomUUID(), me = crypto.randomUUID(), igor = crypto.randomUUID(), deviceId = 'd'.repeat(64);
  const agent = new BrowserAgent(mkdtempSync(join(tmpdir(), 'mr-full-')), 'http://127.0.0.1:1', roomId);
  const open = openDecision({ roomId, deviceId, memberId: igor, question: 'Q', options: ['A', 'B'] });
  const d = foldDecisions([open], { ownerId: igor, members: [{ id: igor }, { id: me, role: 'agent' }] })[0];
  // A full log: one decision and a long history of the same people changing their votes.
  const votes = Array.from({ length: MAX_DECISION_OPS - 1 }, (_, i) => castVote({ roomId, deviceId, memberId: i % 2 ? igor : me }, d, i % 3 ? 'o1' : 'o2', '', i + 1));
  writeFileSync(join(agent.dir, 'decisions.json'), JSON.stringify([open, ...votes].map((body, i) => ({ body, signature: 's', seq: i + 1 }))));
  expect(agent.decisionOps().length).toBe(MAX_DECISION_OPS);
  const compacted = compactStoredDecisions(agent, me);
  expect(compacted.length).toBe(3); // the decision and each member's latest vote
  expect(agent.decisionCursor()).toBe(MAX_DECISION_OPS); // the cursor never moves back
  expect(agent.compactedDecisionIds().size).toBe(votes.filter(v => v.memberId === me).length - 1); // every dropped own id stays spent
  const next = castVote({ roomId, deviceId, memberId: me }, d, 'o1', '', MAX_DECISION_OPS + 1);
  expect(admissible(compacted.map(p => p.body), [next]).length).toBe(1);
});
