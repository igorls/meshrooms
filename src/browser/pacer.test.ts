import { describe, expect, test } from 'bun:test';
import { IncomingGate, MAX_PENDING_INCOMING, PACE_HIGH_WATER, RESYNC_INTERVAL_MS, Resync, SYNC_REQUEST, SendQueue, isSyncRequest } from './pacer';

/** A channel whose send buffer fills by what is sent and drains when told to. */
function channel() {
  return { readyState: 'open', bufferedAmount: 0, sent: [] as string[], send(text: string) { this.sent.push(text); this.bufferedAmount += text.length; } };
}

describe('paced sync (SYNC-3)', () => {
  test('sends only while the send buffer is under the high-water mark, and the rest when it drains', () => {
    const c = channel(), queue = new SendQueue(c);
    const chunks = Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(15_000, 'x'));
    expect(queue.push(chunks)).toBe(true);
    expect(c.sent.length).toBe(Math.ceil(PACE_HIGH_WATER / 15_000));
    expect(queue.pending).toBe(20 - c.sent.length);
    while (queue.pending) { c.bufferedAmount = 0; queue.pump(); }
    expect(c.sent).toEqual(chunks);
  });

  test('a failed send is kept for the next pump; a closed channel drops the queue', () => {
    const sent: string[] = []; let fail = true;
    const flaky = { readyState: 'open', bufferedAmount: 0, send(text: string) { if (fail) throw new Error('busy'); sent.push(text); } };
    const queue = new SendQueue(flaky);
    queue.push(['a', 'b']);
    expect(queue.pending).toBe(2);
    fail = false; queue.pump();
    expect(sent).toEqual(['a', 'b']);
    flaky.readyState = 'closing'; queue.push(['c']);
    expect(queue.pending).toBe(0);
    expect(sent).toEqual(['a', 'b']);
  });

  test('resends are answered at most once per interval and never while one is still queued', () => {
    let now = 1_000_000; const resync = new Resync(() => now), c = channel(), queue = new SendQueue(c);
    expect(resync.due(queue)).toBe(false); // Nothing asked.
    resync.sent(); resync.request();
    expect(resync.due(queue)).toBe(false); // Full state went out moments ago.
    now += RESYNC_INTERVAL_MS;
    c.bufferedAmount = PACE_HIGH_WATER; queue.push(['still queued']);
    expect(resync.due(queue)).toBe(false);
    c.bufferedAmount = 0; queue.pump();
    expect(resync.due(queue)).toBe(true);
    resync.request(); // Asked again at once: waits for the next interval.
    expect(resync.due(queue)).toBe(false);
    now += RESYNC_INTERVAL_MS;
    expect(resync.due(queue)).toBe(true);
  });

  test('the incoming gate drops past its bound and names the peers to ask again once drained', () => {
    const gate = new IncomingGate();
    for (let i = 0; i < MAX_PENDING_INCOMING; i++) expect(gate.admit('a')).toBe(true);
    expect(gate.admit('b')).toBe(false);
    expect(gate.admit('a')).toBe(false);
    for (let i = 0; i < MAX_PENDING_INCOMING - 1; i++) expect(gate.done()).toEqual([]);
    expect(gate.done()).toEqual(['b', 'a']);
    expect(gate.size).toBe(0);
    expect(gate.done()).toEqual([]); // Never negative.
  });

  test('sync requests are recognised only for this room', () => {
    const room = crypto.randomUUID();
    expect(isSyncRequest({ kind: SYNC_REQUEST, roomId: room }, room)).toBe(true);
    expect(isSyncRequest({ kind: SYNC_REQUEST, roomId: crypto.randomUUID() }, room)).toBe(false);
    expect(isSyncRequest({ body: { kind: SYNC_REQUEST } }, room)).toBe(false);
    expect(isSyncRequest(null, room)).toBe(false);
  });
});
