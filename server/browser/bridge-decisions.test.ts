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
