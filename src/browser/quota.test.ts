import { describe, expect, test } from 'bun:test';
import { MAX_REVISION_JUMP, taskBody, withinRevisionJump, type TaskPacket } from './board';
import { QUOTA_BURST, QUOTA_QUIET_MS, QuotaDrops, ReceiveQuota } from './quota';
import { MAX_REACTION_KEYS_PER_MEMBER, withinReactionKeyCap, type ReactionBody, type ReactionPacket } from './reactions';

const roomId = crypto.randomUUID(), alice = crypto.randomUUID(), bob = crypto.randomUUID();

describe('receive quotas (SEC-5, DEC-6)', () => {
  test('60 a minute in bursts of 20, per member and per kind', () => {
    let now = 0; const quota = new ReceiveQuota(() => now);
    for (let i = 0; i < QUOTA_BURST; i++) expect(quota.take(alice, 'message')).toBe(true);
    expect(quota.take(alice, 'message')).toBe(false);
    // Other kinds and other members have their own allowance.
    expect(quota.take(alice, 'reaction')).toBe(true);
    expect(quota.take(alice, 'task')).toBe(true);
    expect(quota.take(bob, 'message')).toBe(true);
    now += 1000; // One more per second.
    expect(quota.take(alice, 'message')).toBe(true);
    expect(quota.take(alice, 'message')).toBe(false);
    now += 60_000; // Refills to the burst, not beyond.
    let taken = 0; while (quota.take(alice, 'message')) taken++;
    expect(taken).toBe(QUOTA_BURST);
    // Sustained: about 60 a minute.
    let sustained = 0;
    for (let i = 0; i < 600; i++) { now += 100; if (quota.take(alice, 'message')) sustained++; }
    expect(sustained).toBe(60);
  });

  test('a drop is reported at most once a minute per member and kind', () => {
    let now = 0; const quota = new ReceiveQuota(() => now);
    expect(quota.report(alice, 'message')).toBe(true);
    expect(quota.report(alice, 'message')).toBe(false);
    expect(quota.report(alice, 'task')).toBe(true);
    now += 60_000;
    expect(quota.report(alice, 'message')).toBe(true);
  });
});

describe('recovering state dropped over quota', () => {
  test('a peer is named once its burst has been quiet for a while, and once per burst', () => {
    let now = 0; const drops = new QuotaDrops(() => now);
    drops.drop('a'); now += 1000; drops.drop('a'); drops.drop('b');
    expect(drops.due()).toEqual([]);
    now += QUOTA_QUIET_MS;
    expect(drops.due()).toEqual(['a', 'b']);
    expect(drops.due()).toEqual([]);
    drops.drop('a'); now += QUOTA_QUIET_MS;
    expect(drops.due()).toEqual(['a']);
  });
});

describe('task revision jumps (SEC-5)', () => {
  const create = { body: taskBody({ roomId, deviceId: 'a'.repeat(64), memberId: alice, change: { title: 'Fix header' } }), signature: '' };
  const at = (revision: number, from = create): TaskPacket => ({ body: { ...from.body, id: crypto.randomUUID(), revision }, signature: '' });

  test('refuses an operation that jumps far past the held revision, so nobody can freeze a task at the cap', () => {
    const held = [create.body];
    expect(withinRevisionJump(held, [at(1 + MAX_REVISION_JUMP)])).toHaveLength(1);
    expect(withinRevisionJump(held, [at(2 + MAX_REVISION_JUMP)])).toHaveLength(0);
    expect(withinRevisionJump(held, [at(1_000_000)])).toHaveLength(0);
    // A new task starts from 0.
    expect(withinRevisionJump([], [at(MAX_REVISION_JUMP)])).toHaveLength(1);
    expect(withinRevisionJump([], [at(MAX_REVISION_JUMP + 1)])).toHaveLength(0);
  });

  test('a batch may climb step by step (a compacted board from a peer), in arrival order', () => {
    const batch = [at(1500), at(900), create];
    expect(withinRevisionJump([], batch)).toEqual(batch);
    const other = { body: taskBody({ roomId, deviceId: 'a'.repeat(64), memberId: alice, change: { title: 'Other' } }), signature: '' };
    // Another task's revisions don't lift this one.
    expect(withinRevisionJump([other.body, { ...other.body, revision: 5000 }], [at(2000)])).toHaveLength(0);
  });
});

describe('incoming reaction cap (SEC-5)', () => {
  const reaction = (memberId: string, messageId: string, revision = 1, removed = false): ReactionPacket => ({
    body: { kind: 'reaction', roomId, id: crypto.randomUUID(), deviceId: 'a'.repeat(64), memberId, messageId, emoji: '👍', revision, at: 1, ...(removed ? { removed: true as const } : {}) } as ReactionBody,
    signature: '' });
  const full = Array.from({ length: MAX_REACTION_KEYS_PER_MEMBER }, () => reaction(alice, crypto.randomUUID()));

  test('a member at the cap cannot add another live reaction; others can', () => {
    const held = full.map(p => p.body);
    expect(withinReactionKeyCap(held, [reaction(alice, crypto.randomUUID())])).toHaveLength(0);
    expect(withinReactionKeyCap(held, [reaction(bob, crypto.randomUUID())])).toHaveLength(1);
    // Removing one, or re-adding an existing key at a higher revision, is always fine.
    const again = reaction(alice, full[0].body.messageId, 3), removal = reaction(alice, full[1].body.messageId, 2, true);
    expect(withinReactionKeyCap(held, [again, removal])).toEqual([again, removal]);
  });

  test('a removal and an addition arriving together are applied removal first', () => {
    const held = full.map(p => p.body);
    const add = reaction(alice, crypto.randomUUID()), removal = reaction(alice, full[5].body.messageId, 2, true);
    expect(withinReactionKeyCap(held, [add, removal])).toEqual([add, removal]);
  });

  test('a flood in one batch keeps only the first cap-full', () => {
    const flood = Array.from({ length: MAX_REACTION_KEYS_PER_MEMBER + 50 }, () => reaction(alice, crypto.randomUUID()));
    expect(withinReactionKeyCap([], flood)).toHaveLength(MAX_REACTION_KEYS_PER_MEMBER);
  });
});
