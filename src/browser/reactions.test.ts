import { describe, expect, test } from 'bun:test';
import {
  compactReactions,
  currentRevision,
  foldReactions,
  isReactionEmoji,
  liveKeysForMember,
  MAX_PENDING_PER_MEMBER,
  MAX_PENDING_REACTIONS,
  mayHoldPending,
  memberReacted,
  REACTION_CHUNK_CHARS,
  REACTION_EMOJI,
  reactionSyncChunks,
  validReactionBody,
  type ReactionBody,
  type ReactionPacket,
} from './reactions';

const room = '27299b62-e69e-4201-b127-099146317482';
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

  test('reactions waiting for their message are capped per member and in total', () => {
    const packet = (memberId: string, i: number): ReactionPacket => ({ body: op({ id: crypto.randomUUID(), memberId, emoji: '👍', revision: 1, at: i + 1, messageId: crypto.randomUUID() }), signature: 's' });
    const pending: ReactionPacket[] = [];
    for (let i = 0; i < MAX_PENDING_PER_MEMBER + 10; i++) { const p = packet(alice, i); if (mayHoldPending(pending, p)) pending.push(p); }
    expect(pending).toHaveLength(MAX_PENDING_PER_MEMBER); // one member can't fill the list
    expect(mayHoldPending(pending, packet(bob, 0))).toBe(true); // others still get their early reactions held
    const full = Array.from({ length: MAX_PENDING_REACTIONS }, (_, i) => packet(crypto.randomUUID(), i));
    expect(mayHoldPending(full, packet(bob, 1))).toBe(false);
  });

  test('reaction sync chunks of real signed packets always fit the data channel', async () => {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
    const sign = async (value: unknown) => Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey,
      new TextEncoder().encode(JSON.stringify(value)))).toString('base64');
    const packets: ReactionPacket[] = [];
    for (let i = 0; i < 600; i++) {
      const body: ReactionBody = { kind: 'reaction', roomId: room, id: crypto.randomUUID(), deviceId: 'f'.repeat(64), memberId: crypto.randomUUID(),
        messageId: crypto.randomUUID(), emoji: REACTION_EMOJI[i % REACTION_EMOJI.length], revision: 999_999, at: Date.now(), ...(i % 3 ? {} : { removed: true as const }) };
      expect(validReactionBody(body, room)).toBe(true);
      packets.push({ body, signature: await sign(body) });
    }
    // The old 200-op chunks were far past what receivers accept.
    expect(JSON.stringify({ kind: 'reactions', roomId: room, ops: packets.slice(0, 200) }).length).toBeGreaterThan(20_000);
    const chunks = reactionSyncChunks(room, packets);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(REACTION_CHUNK_CHARS + 200);
      expect(JSON.stringify(chunk).length).toBeLessThan(20_000);
      expect(chunk.ops.length).toBeLessThanOrEqual(500); // receivers' per-envelope cap
    }
    expect(chunks.flatMap(c => c.ops)).toEqual(packets);
    expect(reactionSyncChunks(room, [])).toEqual([]);
  });
});
