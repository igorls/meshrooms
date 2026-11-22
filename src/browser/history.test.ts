import { describe, expect, test } from 'bun:test';
import { MAX_STORED_MESSAGES, awaitingDelivery, windowHistory, windowMessages } from './history';

const self = 'a'.repeat(64), peer = 'b'.repeat(64), gone = 'c'.repeat(64);
const message = (i: number, deviceId = peer, targets: string[] = [], receipts: string[] = []) =>
  ({ packet: { body: { id: `m${i}`, deviceId } }, targets, receipts });

describe('rolling message window', () => {
  test('keeps everything up to the window', () => {
    const list = Array.from({ length: 10 }, (_, i) => message(i));
    expect(windowMessages(list, () => false, 10)).toEqual({ kept: list, evicted: [] });
  });

  test('evicts the oldest stored messages past the window', () => {
    const list = Array.from({ length: MAX_STORED_MESSAGES + 3 }, (_, i) => message(i));
    const { kept, evicted } = windowMessages(list, () => false);
    expect(kept).toHaveLength(MAX_STORED_MESSAGES);
    expect(evicted.map(m => m.packet.body.id)).toEqual(['m0', 'm1', 'm2']);
    expect(kept[0].packet.body.id).toBe('m3');
    expect(kept.at(-1)!.packet.body.id).toBe(`m${MAX_STORED_MESSAGES + 2}`);
  });

  test("never evicts this device's messages still waiting for a receipt from a device in the room", () => {
    const devices = new Set([self, peer]);
    const list = [message(0, self, [peer]), message(1, self, [peer], [peer]), message(2, self, [gone]), message(3), message(4)];
    const isProtected = (m: ReturnType<typeof message>) => awaitingDelivery(m, self, devices);
    const { kept, evicted } = windowMessages(list, isProtected, 3);
    // m0 waits for peer; m1 was confirmed and m2's only target left the room, so both can go.
    expect(evicted.map(m => m.packet.body.id)).toEqual(['m1', 'm2']);
    expect(kept.map(m => m.packet.body.id)).toEqual(['m0', 'm3', 'm4']);
  });

  test('only the newest outbox-full of unconfirmed messages are protected, so a device that never returns cannot pin the window', () => {
    // A device still listed in the room that never confirms anything: every own message waits for it.
    const devices = new Set([self, peer]), awaiting = (m: ReturnType<typeof message>) => awaitingDelivery(m, self, devices);
    const list = [...Array.from({ length: 12 }, (_, i) => message(i, self, [peer])), message(12), message(13)];
    const { kept, evicted } = windowHistory(list, awaiting, 10, 4);
    // Own m0..m7 lost protection (still ordinary history) and go first; the newest four waiting stay.
    expect(evicted.map(m => m.packet.body.id)).toEqual(['m0', 'm1', 'm2', 'm3']);
    expect(kept.map(m => m.packet.body.id)).toEqual(['m4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11', 'm12', 'm13']);
    // Full of unconfirmed own messages, the window still makes room for new ones.
    const own = Array.from({ length: MAX_STORED_MESSAGES + 1 }, (_, i) => message(i, self, [peer]));
    expect(windowHistory(own, awaiting).kept).toHaveLength(MAX_STORED_MESSAGES);
  });

  test("one member's flood evicts their own oldest messages, not everyone else's history", () => {
    const from = (i: number, memberId: string) => ({ packet: { body: { id: `m${i}`, deviceId: peer, memberId } }, targets: [], receipts: [] });
    // Four from Alex and Sam, then twelve from Mallory, in a window of ten: the six to evict are all Mallory's.
    const list = [from(0, 'alex'), from(1, 'sam'), from(2, 'alex'), from(3, 'sam'), ...Array.from({ length: 12 }, (_, i) => from(4 + i, 'mallory'))];
    const { kept, evicted } = windowMessages(list, () => false, 10);
    expect(evicted.map(m => m.packet.body.id)).toEqual(['m4', 'm5', 'm6', 'm7', 'm8', 'm9']);
    expect(kept.map(m => m.packet.body.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm10', 'm11', 'm12', 'm13', 'm14', 'm15']);
    // Once nobody holds more than half, the oldest go, whoever wrote them.
    const quiet = [from(0, 'alex'), from(1, 'mallory'), from(2, 'sam'), from(3, 'mallory'), from(4, 'alex'), from(5, 'sam')];
    expect(windowMessages(quiet, () => false, 4).evicted.map(m => m.packet.body.id)).toEqual(['m0', 'm1']);
    // Bringing the heaviest member down to half isn't always enough: the rest is oldest-first.
    const mostly = [from(0, 'alex'), ...Array.from({ length: 5 }, (_, i) => from(1 + i, 'mallory')), from(6, 'sam'), from(7, 'alex')];
    expect(windowMessages(mostly, () => false, 4).evicted.map(m => m.packet.body.id)).toEqual(['m0', 'm1', 'm2', 'm3']);
    // A protected message of the heavy member stays; their next oldest goes.
    const pinned = windowMessages(list, m => m.packet.body.id === 'm4', 10);
    expect(pinned.evicted.map(m => m.packet.body.id)).toEqual(['m5', 'm6', 'm7', 'm8', 'm9', 'm10']);
  });

  test('awaiting delivery: own messages with an unconfirmed target; without a device list every target counts', () => {
    expect(awaitingDelivery(message(0, self, [peer]), self)).toBe(true);
    expect(awaitingDelivery(message(0, self, [gone]), self)).toBe(true);
    expect(awaitingDelivery(message(0, self, [gone]), self, new Set([self, peer]))).toBe(false);
    expect(awaitingDelivery(message(0, self, [peer], [peer]), self)).toBe(false);
    expect(awaitingDelivery(message(0, peer, [self]), self)).toBe(false);
  });
});
