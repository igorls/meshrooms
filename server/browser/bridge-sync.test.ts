import { describe, expect, test } from 'bun:test';
import { flushOutbox } from '../browser-agent';

const roomId = crypto.randomUUID(), me = crypto.randomUUID();
const self = 'a'.repeat(64), peer = 'b'.repeat(64), gone = 'c'.repeat(64);
const own = (i: number, targets = [peer], receipts: string[] = []) => ({
  packet: { body: { kind: 'message' as const, roomId, id: crypto.randomUUID(), deviceId: self, memberId: me, text: `mine ${i}`, at: i + 1 }, signature: 'x' }, targets, receipts });

describe('bridge outbox (SYNC-2, AGT-4)', () => {
  test('flush sends at most 16 per peer per tick, waits for a full send buffer, and survives a failing channel', () => {
    const messages = Array.from({ length: 40 }, (_, i) => own(i));
    const sent: string[] = [], logs: string[] = [];
    const channel = { readyState: 'open', bufferedAmount: 0, send: (text: string) => { sent.push(text); } };
    const broken = { readyState: 'open', bufferedAmount: 0, send: () => { throw new Error('channel closed'); } };
    const peers = new Map([[peer, { channel, sent: new Map<string, number>() }], [gone, { channel: broken, sent: new Map<string, number>() }]]);
    flushOutbox(messages.map(m => ({ ...m, targets: [peer, gone] })), self, peers, line => logs.push(line), 1_000_000);
    expect(sent).toHaveLength(16);
    expect(logs).toEqual([`send to ${gone.slice(0, 8)} failed: channel closed`]);
    // The next tick moves on to the next 16 instead of resending the first ones.
    flushOutbox(messages, self, peers, () => {}, 1_001_000);
    expect(new Set(sent).size).toBe(32);
    // A confirmed message is not sent again; after five seconds an unconfirmed one is.
    const confirmed = messages.map((m, i) => i < 8 ? { ...m, receipts: [peer] } : m);
    sent.length = 0;
    flushOutbox(confirmed, self, peers, () => {}, 1_006_000);
    expect(sent.map(t => JSON.parse(t).body.text)).toEqual(Array.from({ length: 16 }, (_, i) => `mine ${i + 8}`));
    // A full send buffer holds everything until it drains.
    sent.length = 0; channel.bufferedAmount = 300_000;
    flushOutbox(messages, self, peers, () => {}, 2_000_000);
    expect(sent).toHaveLength(0);
  });
});
