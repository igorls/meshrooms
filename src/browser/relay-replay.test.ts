import { describe, expect, test } from 'bun:test';
import { RELAY_REPLAY_MAX_PER_SENDER, RELAY_REPLAY_MAX_TOTAL, RelayReplayGuard } from './relay-replay';

describe('relay replay guard', () => {
  test('remembers each sender + envelope id once', () => {
    const guard = new RelayReplayGuard();
    expect(guard.seen('alice', 'env-1')).toBe(false);
    expect(guard.add('alice', 'env-1')).toBe(true);
    expect(guard.seen('alice', 'env-1')).toBe(true);
    expect(guard.add('alice', 'env-1')).toBe(false);
    // The same id from another sender is a different envelope: ids are only unique per sender.
    expect(guard.seen('bob', 'env-1')).toBe(false);
    expect(guard.add('bob', 'env-1')).toBe(true);
  });

  test('refuses ids it could not persist or compare safely', () => {
    const guard = new RelayReplayGuard();
    expect(guard.add('', 'env-1')).toBe(false);
    expect(guard.add('alice', '')).toBe(false);
    expect(guard.add('alice', 'has space')).toBe(false);
    expect(guard.add('alice', 'x'.repeat(129))).toBe(false);
    expect(guard.size).toBe(0);
  });

  test('keeps only the newest ids per sender', () => {
    const guard = new RelayReplayGuard(1000, 3);
    for (const id of ['a', 'b', 'c', 'd']) guard.add('alice', id);
    expect(guard.seen('alice', 'a')).toBe(false);
    for (const id of ['b', 'c', 'd']) expect(guard.seen('alice', id)).toBe(true);
    expect(guard.size).toBe(3);
  });

  test('one chatty sender cannot flush another sender\'s record when the total cap is reached', () => {
    const guard = new RelayReplayGuard(10, 100);
    guard.add('quiet', 'q-1'); guard.add('quiet', 'q-2');
    for (let i = 0; i < 40; i++) guard.add('loud', `l-${i}`);
    expect(guard.size).toBeLessThanOrEqual(10);
    expect(guard.seen('quiet', 'q-1')).toBe(true);
    expect(guard.seen('quiet', 'q-2')).toBe(true);
    expect(guard.seen('loud', 'l-39')).toBe(true);
    expect(guard.seen('loud', 'l-0')).toBe(false);
  });

  test('round-trips through its persisted form and ignores malformed or oversized records', () => {
    const guard = new RelayReplayGuard();
    guard.add('alice', 'env-1'); guard.add('alice', 'env-2'); guard.add('bob', 'env-3');
    const restored = RelayReplayGuard.from(JSON.parse(JSON.stringify(guard.export())));
    for (const [sender, id] of [['alice', 'env-1'], ['alice', 'env-2'], ['bob', 'env-3']]) expect(restored.seen(sender, id)).toBe(true);
    expect(restored.version).toBe(0);

    for (const junk of [undefined, null, 'x', 7, [], { v: 2, senders: {} }, { v: 1 }, { v: 1, senders: 'x' }, { v: 1, senders: { a: 'x', b: [1, null, {}] } }]) {
      expect(RelayReplayGuard.from(junk).size).toBe(0);
    }
    const flood = { v: 1, senders: { alice: Array.from({ length: RELAY_REPLAY_MAX_PER_SENDER * 3 }, (_, i) => `id-${i}`) } };
    const capped = RelayReplayGuard.from(flood);
    expect(capped.size).toBe(RELAY_REPLAY_MAX_PER_SENDER);
    expect(RELAY_REPLAY_MAX_PER_SENDER).toBeLessThanOrEqual(RELAY_REPLAY_MAX_TOTAL);
  });

  test('its persisted form is small enough to travel in sealed agent state', () => {
    const guard = new RelayReplayGuard();
    for (let s = 0; s < 8; s++) for (let i = 0; i < RELAY_REPLAY_MAX_PER_SENDER; i++) guard.add(`${'d'.repeat(63)}${s}`, crypto.randomUUID());
    expect(guard.size).toBeLessThanOrEqual(RELAY_REPLAY_MAX_TOTAL);
    expect(JSON.stringify(guard.export()).length).toBeLessThan(120_000);
  });
});
