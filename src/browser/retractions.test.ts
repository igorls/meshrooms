import { describe, expect, test } from 'bun:test';
import {
  MAX_RETRACTIONS, MAX_UNRESOLVED_PER_MEMBER, RETRACTION_CHUNK_CHARS, addRetractions, applyRetractions, isRetracted, mayRetract,
  retractedStub, retractionSyncChunks, validRetractBody, type RetractBody, type RetractPacket,
} from './retractions';
import { MAX_STORED_MESSAGES } from './history';

const room = 'a'.repeat(36), alice = 'b'.repeat(36), bob = 'c'.repeat(36), device = 'd'.repeat(64), laptop = 'e'.repeat(64);
const uuid = (n: number) => n.toString(16).padStart(36, '0');
const message = (id: string, memberId = alice, attachments?: { sha256: string }[]) => ({
  packet: { body: { kind: 'message' as const, roomId: room, id, deviceId: device, memberId, text: 'secret', at: 1, ...(attachments ? { attachments } : {}) }, signature: 'sig' },
  targets: ['peer'], receipts: [] as string[],
});
const op = (id: string, target: string, memberId = alice): RetractBody => ({ kind: 'retract', roomId: room, id, deviceId: laptop, memberId, at: 2, target });
const packet = (body: RetractBody): RetractPacket => ({ body, signature: 'sig' });

describe('validRetractBody', () => {
  test('accepts the signed shape and refuses others', () => {
    expect(validRetractBody(op(uuid(1), uuid(2)), room)).toBe(true);
    expect(validRetractBody(op(uuid(1), uuid(2)), 'f'.repeat(36))).toBe(false);
    expect(validRetractBody({ ...op(uuid(1), uuid(2)), target: 'nope' }, room)).toBe(false);
    expect(validRetractBody({ ...op(uuid(1), uuid(2)), at: 0 }, room)).toBe(false);
    expect(validRetractBody({ ...op(uuid(1), uuid(2)), kind: 'message' }, room)).toBe(false);
    expect(validRetractBody(null, room)).toBe(false);
  });
});

describe('mayRetract', () => {
  test('the author may, from another device; nobody else may', () => {
    const body = message(uuid(2)).packet.body;
    expect(mayRetract(op(uuid(1), uuid(2)), body)).toBe(true);
    expect(mayRetract(op(uuid(1), uuid(2), bob), body)).toBe(false);
    expect(mayRetract(op(uuid(1), uuid(3)), body)).toBe(false);
  });
});

describe('retractedStub', () => {
  test('keeps the position and drops every piece of content', () => {
    const stub = retractedStub(message(uuid(2), alice, [{ sha256: 'f'.repeat(64) }]));
    expect(isRetracted(stub)).toBe(true);
    expect(stub.packet.body.id).toBe(uuid(2));
    expect(stub.packet.body.at).toBe(1);
    expect(JSON.stringify(stub)).not.toContain('secret');
    expect(JSON.stringify(stub)).not.toContain('f'.repeat(64));
    expect(stub.packet.signature).toBe('');
    expect(stub.targets).toEqual([]);
  });
});

describe('applyRetractions', () => {
  test('replaces the target in place and leaves the others', () => {
    const { messages, changed } = applyRetractions([message(uuid(1)), message(uuid(2))], [op(uuid(9), uuid(2))]);
    expect(changed).toEqual([uuid(2)]);
    expect(messages.map(m => m.packet.body.id)).toEqual([uuid(1), uuid(2)]);
    expect(messages[0]!.packet.body.text).toBe('secret');
    expect(messages[1]!.packet.body.text).toBe('');
  });
  test('ignores a retraction by another member', () => {
    const { messages, changed } = applyRetractions([message(uuid(2))], [op(uuid(9), uuid(2), bob)]);
    expect(changed).toEqual([]);
    expect(messages[0]!.packet.body.text).toBe('secret');
  });
  test('a forged retraction does not shield the real one', () => {
    const { changed } = applyRetractions([message(uuid(2))], [op(uuid(8), uuid(2), bob), op(uuid(9), uuid(2))]);
    expect(changed).toEqual([uuid(2)]);
  });
  test('running it again changes nothing', () => {
    const first = applyRetractions([message(uuid(2))], [op(uuid(9), uuid(2))]);
    const second = applyRetractions(first.messages, [op(uuid(9), uuid(2))]);
    expect(second.changed).toEqual([]);
    expect(second.messages).toBe(first.messages);
  });
  test('a message that arrives after its retraction is scrubbed too', () => {
    expect(applyRetractions([], [op(uuid(9), uuid(2))]).changed).toEqual([]);
    expect(applyRetractions([message(uuid(2))], [op(uuid(9), uuid(2))]).messages[0]!.packet.body.text).toBe('');
  });
  test('releases only the files nothing else refers to', () => {
    const only = 'a'.repeat(64), shared = 'b'.repeat(64);
    const { released } = applyRetractions([message(uuid(1), alice, [{ sha256: only }, { sha256: shared }]), message(uuid(2), bob, [{ sha256: shared }])], [op(uuid(9), uuid(1))]);
    expect(released).toEqual([only]);
  });
});

describe('addRetractions', () => {
  test('skips duplicates by id and by target', () => {
    const one = packet(op(uuid(1), uuid(2)));
    const { log, added } = addRetractions([one], [one, packet(op(uuid(3), uuid(2)))], [message(uuid(2))]);
    expect(log).toEqual([one]);
    expect(added).toEqual([]);
  });
  test('drops one aimed at a held message by another member', () => {
    expect(addRetractions([], [packet(op(uuid(1), uuid(2), bob))], [message(uuid(2))]).added).toEqual([]);
  });
  test('parks one for an unknown message, up to the cap per member', () => {
    const incoming = Array.from({ length: MAX_UNRESOLVED_PER_MEMBER + 5 }, (_, i) => packet(op(uuid(1000 + i), uuid(5000 + i))));
    const { log } = addRetractions([], incoming, []);
    expect(log.length).toBe(MAX_UNRESOLVED_PER_MEMBER);
    expect(addRetractions(log, [packet(op(uuid(9000), uuid(9001), bob))], []).added.length).toBe(1);
    expect(addRetractions(log, [packet(op(uuid(9002), uuid(9003)))], []).added.length).toBe(0);
  });
  test('held targets are not charged to the cap', () => {
    const held = Array.from({ length: MAX_UNRESOLVED_PER_MEMBER + 5 }, (_, i) => message(uuid(5000 + i)));
    const incoming = held.map((m, i) => packet(op(uuid(1000 + i), m.packet.body.id)));
    expect(addRetractions([], incoming, held).added.length).toBe(held.length);
  });
  test('past the cap the oldest make room', () => {
    const { log } = addRetractions([packet(op(uuid(1), uuid(2)))], [packet(op(uuid(3), uuid(4)))], [], 1);
    expect(log.map(p => p.body.id)).toEqual([uuid(3)]);
  });
  test('past the cap a retraction of a held message stays, however old', () => {
    const { log } = addRetractions([packet(op(uuid(1), uuid(2))), packet(op(uuid(5), uuid(6)))], [packet(op(uuid(3), uuid(4)))], [message(uuid(2))], 2);
    expect(log.map(p => p.body.id)).toEqual([uuid(1), uuid(3)]);
  });
  test('the log can hold a retraction for every message in the window', () => {
    expect(MAX_RETRACTIONS).toBeGreaterThan(MAX_STORED_MESSAGES);
  });
});

describe('retractionSyncChunks', () => {
  test('stays under the chunk size', () => {
    const ops = Array.from({ length: 200 }, (_, i) => packet(op(uuid(i + 1), uuid(i + 1000))));
    const chunks = retractionSyncChunks(room, ops);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flatMap(c => c.ops).length).toBe(200);
    for (const chunk of chunks) expect(JSON.stringify(chunk).length).toBeLessThan(RETRACTION_CHUNK_CHARS + 1000);
  });
  test('nothing to send gives no chunks', () => { expect(retractionSyncChunks(room, [])).toEqual([]); });
});
