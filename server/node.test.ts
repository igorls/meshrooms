import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { LocalNode } from './node';
import type { DurableStore } from './persistence/store';

function fixture() {
  const records = new Map<string, string>();
  let failWrite = false;
  const open = (): DurableStore => ({ read: key => records.get(key) ?? null,
    write(key, value) { if (failWrite) throw new Error('Disk failure'); records.set(key, value); }, close() {} });
  return { open, fail() { failWrite = true; } };
}
const create = (node: LocalNode, title: string) => node.createRoom({ title, project: 'Project', requestId: randomUUID() }).roomId;

describe('local room commands and recovery', () => {
  test('same node, room memberships, histories and idempotent retries recover together', () => {
    const store = fixture(); const first = new LocalNode(store.open());
    const createId = randomUUID();
    const a = first.createRoom({ title: 'Review', project: 'Alpha', requestId: createId }).roomId;
    const b = create(first, 'Review');
    const messageId = randomUUID();
    const sent = first.send({ roomId: a, requestId: messageId, text: 'Alpha only' });
    first.send({ roomId: b, requestId: randomUUID(), text: 'Beta only' });
    const before = first.snapshot(); first.close();
    const recovered = new LocalNode(store.open());
    expect(recovered.snapshot()).toEqual(before);
    expect(recovered.createRoom({ title: 'Review', project: 'Alpha', requestId: createId }).roomId).toBe(a);
    expect(recovered.send({ roomId: a, requestId: messageId, text: 'Alpha only' })).toEqual(sent);
    expect(recovered.snapshot().rooms.map(room => room.messages.map(message => message.text))).toEqual([['Alpha only'], ['Beta only']]);
  });
  test('cross-room reply and changed retries cannot alter history', () => {
    const node = new LocalNode(fixture().open());
    const a = create(node, 'A'); const b = create(node, 'B'); const id = randomUUID();
    const sent = node.send({ roomId: a, requestId: id, text: 'First' });
    expect(() => node.send({ roomId: b, requestId: randomUUID(), text: 'Reply', replyTo: sent.messageId })).toThrow('not in this room');
    expect(() => node.send({ roomId: a, requestId: id, text: 'Changed' })).toThrow('different content');
    expect(node.snapshot().rooms[0].messages).toHaveLength(1);
    expect(node.snapshot().rooms[1].messages).toHaveLength(0);
  });
  test('view lifetime does not own rooms; one bad view cannot reverse a successful write', () => {
    const node = new LocalNode(fixture().open()); const roomId = create(node, 'A');
    const stop = node.subscribe(() => { throw new Error('Gone view'); });
    expect(node.send({ roomId, requestId: randomUUID(), text: 'Kept' }).status).toBe('stored-locally'); stop();
    node.send({ roomId, requestId: randomUUID(), text: 'Without a browser' });
    expect(node.snapshot().rooms[0].messages.map(message => message.text)).toEqual(['Kept', 'Without a browser']);
  });
  test('a failed storage write is neither broadcast nor acknowledged; later commands fail closed', () => {
    const storage = fixture(); const node = new LocalNode(storage.open()); const roomId = create(node, 'A');
    let events = 0; node.subscribe(() => events++); storage.fail();
    expect(() => node.send({ roomId, requestId: randomUUID(), text: 'Unconfirmed' })).toThrow('could not be confirmed');
    expect(node.ready).toBe(false); expect(events).toBe(0); expect(node.snapshot().rooms[0].messages).toHaveLength(0);
    expect(() => create(node, 'B')).toThrow('storage is unavailable');
  });
  test('unknown persisted schema is refused without writing a replacement', () => {
    let writes = 0;
    expect(() => new LocalNode({ read: () => '{"version":99}', write() { writes++; }, close() {} })).toThrow('has not been reset');
    expect(writes).toBe(0);
  });
});
