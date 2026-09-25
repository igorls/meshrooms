import { describe, expect, test } from 'bun:test';
import {
  compactReactions,
  currentRevision,
  foldReactions,
  isReactionEmoji,
  liveKeysForMember,
  memberReacted,
  validReactionBody,
  type ReactionBody,
  type ReactionPacket,
} from './reactions';

const room = '45424fde-7562-4a96-9472-a4eea17545c5';
const message = '11111111-1111-4111-8111-111111111111';
const alice = '22222222-2222-4222-8222-222222222222';
const bob = '33333333-3333-4333-8333-333333333333';
const device = 'a'.repeat(64);

function op(partial: Partial<ReactionBody> & Pick<ReactionBody, 'id' | 'memberId' | 'emoji' | 'revision' | 'at'>): ReactionBody {
  return {
    kind: 'reaction',
    roomId: room,
    deviceId: device,
    messageId: message,
    ...partial,
  };
}

describe('browser reactions', () => {
  test('accepts the fixed emoji set only', () => {
    expect(isReactionEmoji('👍')).toBe(true);
    expect(isReactionEmoji('🚀')).toBe(false);
    expect(validReactionBody(op({ id: '44444444-4444-4444-8444-444444444444', memberId: alice, emoji: '👍', revision: 1, at: 1 }), room)).toBe(true);
    expect(validReactionBody(op({ id: '44444444-4444-4444-8444-444444444444', memberId: alice, emoji: '👍', revision: 0, at: 1 }), room)).toBe(false);
  });

  test('folds by revision, not wall clock, so a corrected clock cannot resurrect a removal', () => {
    const add = op({ id: '55555555-5555-4555-8555-555555555555', memberId: alice, emoji: '👍', revision: 1, at: 9_000 });
    const remove = op({ id: '66666666-6666-4666-8666-666666666666', memberId: alice, emoji: '👍', revision: 2, at: 1, removed: true });
    const bobAdd = op({ id: '77777777-7777-4777-8777-777777777777', memberId: bob, emoji: '👍', revision: 1, at: 5 });
    const chips = foldReactions([add, remove, bobAdd]);
    expect(chips).toEqual([{ messageId: message, emoji: '👍', memberIds: [bob] }]);
    expect(memberReacted(chips, message, '👍', alice)).toBe(false);
    expect(currentRevision([add, remove], message, alice, '👍')).toBe(2);
  });

  test('compaction keeps only the latest revision per member emoji', () => {
    const packets: ReactionPacket[] = [
      { body: op({ id: '55555555-5555-4555-8555-555555555555', memberId: alice, emoji: '👍', revision: 1, at: 1 }), signature: 'a' },
      { body: op({ id: '66666666-6666-4666-8666-666666666666', memberId: alice, emoji: '👍', revision: 2, at: 2, removed: true }), signature: 'b' },
      { body: op({ id: '77777777-7777-4777-8777-777777777777', memberId: bob, emoji: '😂', revision: 1, at: 3 }), signature: 'c' },
    ];
    const compacted = compactReactions(packets);
    expect(compacted.map(p => p.body.id)).toEqual([
      '77777777-7777-4777-8777-777777777777',
      '66666666-6666-4666-8666-666666666666',
    ]);
    expect(foldReactions(compacted.map(p => p.body))).toEqual([
      { messageId: message, emoji: '😂', memberIds: [bob] },
    ]);
    expect(liveKeysForMember(compacted.map(p => p.body), bob)).toBe(1);
    expect(liveKeysForMember(compacted.map(p => p.body), alice)).toBe(0);
  });
});
