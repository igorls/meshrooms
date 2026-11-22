import { describe, expect, test } from 'bun:test';
import {
  castVote, decisionTaskTitle, foldDecisions, openDecision, reviseDecision, validDecisionBody,
  type DecisionBody, type RoomMembers, type VoteBody,
} from './decisions';

describe('decisionTaskTitle (UX-6)', () => {
  test('keeps short question and outcome intact, stripping trailing question mark', () => {
    expect(decisionTaskTitle('Ship today?', 'Yes')).toBe('Ship today → Yes');
    expect(decisionTaskTitle('Pick database', 'Postgres')).toBe('Pick database → Postgres');
  });

  test('budgets space for the chosen outcome first so it is never truncated', () => {
    const longQuestion = 'Should we migrate our authentication session tokens from localStorage to httpOnly cookies across all client platforms and desktop builds?';
    const chosen = 'Yes, next sprint';
    const result = decisionTaskTitle(longQuestion, chosen, 120);
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result.endsWith(`… → ${chosen}`)).toBe(true);
  });

  test('handles outcomes close to or at the 120-character limit without overflowing', () => {
    const maxChosen = 'x'.repeat(120);
    expect(decisionTaskTitle('Long question here?', maxChosen, 120)).toBe(maxChosen);
    const nearMax = 'y'.repeat(118);
    expect(decisionTaskTitle('Long question here?', nearMax, 120)).toBe(nearMax);
    const tight = 'z'.repeat(115);
    const tightResult = decisionTaskTitle('Long question here?', tight, 120);
    expect(tightResult.length).toBeLessThanOrEqual(120);
    expect(tightResult.endsWith(` → ${tight}`)).toBe(true);
  });
});

describe('decision revision and close integrity (COL-2, COL-3)', () => {
  const roomId = crypto.randomUUID(), deviceId = 'a'.repeat(64);
  const [alice, bob, sam, wren] = Array.from({ length: 4 }, () => crypto.randomUUID());
  const room: RoomMembers = {
    ownerId: alice,
    members: [
      { id: alice, role: 'human' },
      { id: bob, role: 'human' },
      { id: sam },
      { id: wren, role: 'agent', operatorId: alice },
    ],
  };
  const as = (memberId: string) => ({ roomId, deviceId, memberId });
  const fold = (ops: (DecisionBody | VoteBody)[]) => foldDecisions(ops, room);

  test('COL-2: reviseDecision refuses empty/blank addOption and no-op revisions instead of minting an empty revision op', () => {
    const open = openDecision({ ...as(alice), question: 'Deploy today?', options: ['Yes', 'No'] });
    const d = fold([open])[0];

    expect(() => reviseDecision(as(alice), d, { addOption: '' })).toThrow('label');
    expect(() => reviseDecision(as(alice), d, { addOption: '   ' })).toThrow('label');
    expect(() => reviseDecision(as(alice), d, {})).toThrow('Specify a change');
    expect(() => reviseDecision(as(alice), d, { close: false, withdraw: false })).toThrow('Specify a change');
    expect(() => reviseDecision(as(alice), d, { close: true, withdraw: true })).toThrow('not both');

    // Wire-level no-op revision (same options, terms, and open state) is also rejected by foldDecisions.
    const wireNoOp: DecisionBody = { ...open, id: crypto.randomUUID(), revision: 2 };
    expect(fold([open, wireNoOp])[0].revision).toBe(1);

    // Valid changes still work as expected.
    const added = reviseDecision(as(bob), d, { addOption: '  Tomorrow  ' });
    expect(added.options.at(-1)?.label).toBe('Tomorrow');
    expect(fold([open, added])[0].revision).toBe(2);
  });

  test('COL-3: close pins all held human votes and rejects forged counted: [] closes when human votes exist', () => {
    const open = openDecision({ ...as(wren), question: 'Pick a branch?', options: ['Main', 'Beta'] });
    const d0 = fold([open])[0];
    const aliceVote = castVote(as(alice), d0, 'o1', 'ready');
    const bobVote = castVote(as(bob), d0, 'o2', 'wait');
    const agentAdvice = castVote(as(wren), d0, 'o1', 'advice');
    const ops: (DecisionBody | VoteBody)[] = [open, aliceVote, bobVote, agentAdvice];
    const d = fold(ops)[0];

    // Closing pins every held human vote (never agents) and computes a consistent outcome even if tally was stale.
    const closed = reviseDecision(as(wren), { ...d, tally: { result: 'no-votes', optionIds: [], tally: { o1: 0, o2: 0 }, voters: 0, people: 3 } }, { close: true });
    expect(closed.counted).toEqual([
      { vote: aliceVote.id, memberId: alice, optionId: 'o1' },
      { vote: bobVote.id, memberId: bob, optionId: 'o2' },
    ]);
    expect(closed.outcome).toEqual({ result: 'draw', optionIds: ['o1', 'o2'], tally: { o1: 1, o2: 1 }, voters: 2, people: 3 });
    expect(validDecisionBody(closed, roomId)).toBe(true);
    expect(fold([...ops, closed])[0]).toMatchObject({ state: 'closed', verified: true, uncounted: 0, outcome: closed.outcome });

    // A forged close with counted: [] while human votes exist cannot silently drop held votes as uncounted or claim verified: true.
    const forgedEmptyClose: DecisionBody = {
      ...reviseDecision(as(wren), d0, { close: true }),
      at: 1, // Even with a backdated timestamp, clocks cannot bypass counted validation.
    };
    expect(forgedEmptyClose.counted).toEqual([]);
    const foldedForged = fold([...ops, forgedEmptyClose])[0];
    expect(foldedForged.state).toBe('open');
    expect(foldedForged.uncounted).toBe(0);
    expect(foldedForged.tally).toMatchObject({ result: 'draw', voters: 2 });

    // validDecisionBody rejects self-contradictory closed bodies (e.g. counted: [] claiming a decided outcome).
    expect(validDecisionBody({ ...forgedEmptyClose, outcome: { result: 'decided', optionIds: ['o1'], tally: { o1: 1, o2: 0 }, voters: 1, people: 3 } }, roomId)).toBe(false);

    // Genuine no-votes close (no human voted, or human took back their vote) still succeeds cleanly.
    expect(fold([open, agentAdvice, forgedEmptyClose])[0]).toMatchObject({ state: 'closed', verified: true, uncounted: 0, outcome: { result: 'no-votes' } });
    const retracted = castVote(as(alice), d0, null, '', 2);
    expect(fold([open, aliceVote, retracted, forgedEmptyClose])[0]).toMatchObject({ state: 'closed', verified: true, uncounted: 0, outcome: { result: 'no-votes' } });
  });
});
