import { expect, test } from 'bun:test';
import { RelayClient } from './relay-client';
import type { RosterEntry } from './relay-crypto';

const client = (maxQueuedPrimary: number) => new RelayClient({
  origin: 'http://127.0.0.1:1', roomId: crypto.randomUUID(), deviceId: crypto.randomUUID(), publicKey: 'pk',
  sign: async () => 'sig', maxQueuedPrimary,
});
const recipients = [] as unknown as RosterEntry[];
const opts = (wake?: string[]) => ({ rosterVersion: 1, lane: 'primary' as const, recipients, ...(wake ? { wake } : {}) });

test('a full queue drops the oldest unaddressed frame instead of refusing the next one', () => {
  const relay = client(4);
  const ids = [0, 1, 2, 3].map(i => relay.enqueuePacket({ n: i }, opts()));
  expect(relay.queueStats()).toMatchObject({ primaryQueued: 4, droppedUnaddressed: 0 });
  // Sending never throws "queue is full" for chatter, and the queue never grows past its limit.
  for (let i = 4; i < 40; i++) relay.enqueuePacket({ n: i }, opts());
  expect(relay.queueStats()).toEqual({ primaryQueued: 4, fileQueued: 0, droppedUnaddressed: 36 });
  expect(ids).toHaveLength(4);
});

test('frames that address someone are kept while the room chatters, and only an addressed frame meets a queue full of addressed ones', () => {
  const relay = client(3);
  relay.enqueuePacket({ n: 'a' }, opts(['agent-1']));
  relay.enqueuePacket({ n: 'b' }, opts());
  relay.enqueuePacket({ n: 'c' }, opts(['agent-1']));
  // Chatter replaces chatter, never the addressed frames.
  relay.enqueuePacket({ n: 'd' }, opts());
  relay.enqueuePacket({ n: 'e' }, opts());
  expect(relay.queueStats()).toMatchObject({ primaryQueued: 3, droppedUnaddressed: 2 });
  // An addressed frame displaces the last chatter; once only addressed frames are queued, more chatter is dropped quietly...
  relay.enqueuePacket({ n: 'f' }, opts(['agent-1']));
  expect(relay.queueStats()).toMatchObject({ primaryQueued: 3, droppedUnaddressed: 3 });
  expect(() => relay.enqueuePacket({ n: 'g' }, opts())).not.toThrow();
  expect(relay.queueStats()).toMatchObject({ primaryQueued: 3, droppedUnaddressed: 4 });
  // ...and only an addressed frame with no room left is refused, as before.
  expect(() => relay.enqueuePacket({ n: 'h' }, opts(['agent-1']))).toThrow('queue is full');
});

test('one inbox frame that is never committed cannot pin the acknowledged cursor forever', () => {
  let at = 1_000;
  const relay = new RelayClient({
    origin: 'http://127.0.0.1:1', roomId: crypto.randomUUID(), deviceId: crypto.randomUUID(), publicKey: 'pk',
    sign: async () => 'sig', now: () => at, pendingAckMaxAgeMs: 60_000,
  });
  const internals = relay as unknown as { trackDeliveredCursor(cursor: number): void; ackedCursor: number };
  for (const cursor of [1, 2, 3, 4]) internals.trackDeliveredCursor(cursor);
  // Cursor 1's handler never finished; 2 and 3 were committed. Held behind 1, nothing is acknowledged yet.
  relay.ackCursor(2); relay.ackCursor(3);
  expect(internals.ackedCursor).toBe(0);
  // Past the limit, the next commit gives up on 1 and the acknowledgement moves over it.
  at += 61_000;
  relay.ackCursor(4);
  expect(internals.ackedCursor).toBe(4);
  expect(relay.abandonedCursors).toBe(1);
});
