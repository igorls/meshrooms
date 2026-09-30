import { beforeEach, describe, expect, test } from 'bun:test';
import { fakeStorage, installFakeIndexedDB } from './test-indexeddb';
import { BrowserPeers } from './peers';
import { MAX_STORED_MESSAGES } from './history';
import { MAX_PENDING_INCOMING, PACE_HIGH_WATER, Resync, SYNC_REQUEST } from './pacer';
import { syncChunks, taskBody } from './board';
import { identity } from './storage';
import { QUOTA_BURST, QuotaDrops } from './quota';

/**
 * BrowserPeers over an in-memory IndexedDB and fake data channels, so the receive paths (window, receipts, quotas,
 * resync) run as in a browser. Packets are signed with real P-256 keys and verified as usual.
 */
installFakeIndexedDB();
const records = fakeStorage.records;
const keyPair = async () => {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('base64');
  const id = Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(publicKey, 'base64'))).toString('hex');
  const sign = async (value: unknown) => Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey,
    new TextEncoder().encode(JSON.stringify(value)))).toString('base64');
  return { id, publicKey, sign };
};
const local = await identity(), remote = await keyPair();

const roomId = crypto.randomUUID(), me = crypto.randomUUID(), them = crypto.randomUUID();
const status = {
  roomId, title: 'Room', epoch: 'e', hostOnline: true, deviceId: local.id, memberId: me, ownerId: me,
  members: [{ id: me, name: 'Me' }, { id: them, name: 'Them' }],
  devices: [{ id: local.id, publicKey: local.publicKey, label: 'b', memberId: me, admittedAt: 1 }, { id: remote.id, publicKey: remote.publicKey, label: 'b', memberId: them, admittedAt: 1 }],
};

type Fake = { readyState: string; bufferedAmount: number; sent: string[]; send(text: string): void; onmessage?: (event: { data: string }) => void;
  onopen?: () => void; onclose?: () => void; bufferedAmountLowThreshold: number; addEventListener(type: string, fn: () => void): void };
function fakeChannel(): Fake {
  return { readyState: 'open', bufferedAmount: 0, sent: [], send(text) { this.sent.push(text); }, bufferedAmountLowThreshold: 0, addEventListener() {} };
}
async function room() {
  const errors: string[] = [];
  const engine = new BrowserPeers({} as never, roomId, local.id, 'session', () => {}, message => errors.push(message)) as any;
  await engine.load();
  engine.status = status;
  const channel = fakeChannel(), peer = { pc: { close() {} }, session: 's', started: Date.now(), sent: new Map(), resync: new Resync() };
  engine.peers.set(remote.id, peer); engine.connectChannel(peer, remote.id, channel);
  const settle = async () => { while (engine.incoming.size) await Bun.sleep(1); await engine.serial; };
  const deliver = (packet: unknown) => channel.onmessage!({ data: JSON.stringify(packet) });
  return { engine, channel, settle, deliver, errors };
}
const messageFrom = async (text: string, at = Date.now()) => {
  const body = { kind: 'message', roomId, id: crypto.randomUUID(), deviceId: remote.id, memberId: them, text, at };
  return { body, signature: await remote.sign(body) };
};
const receipts = (channel: Fake) => channel.sent.map(t => JSON.parse(t)).filter(p => p.body?.kind === 'receipt').map(p => p.body.id);

beforeEach(() => { records.clear(); fakeStorage.writes = 0; fakeStorage.failWith = undefined; });

describe('browser history window (SYNC-2)', () => {
  test('a full history evicts its oldest message, stores the new one and always confirms it', async () => {
    const stored = Array.from({ length: MAX_STORED_MESSAGES }, (_, i) => ({
      packet: { body: { kind: 'message', roomId, id: crypto.randomUUID(), deviceId: remote.id, memberId: them, text: `old ${i}`, at: i + 1 }, signature: 'x' }, targets: [], receipts: [] }));
    records.set(`messages:${local.id}:${roomId}`, stored);
    const { engine, channel, settle, deliver } = await room();
    const packet = await messageFrom('new');
    deliver(packet); await settle();
    const kept = records.get(`messages:${local.id}:${roomId}`) as typeof stored;
    expect(kept).toHaveLength(MAX_STORED_MESSAGES);
    expect(kept[0].packet.body.text).toBe('old 1');
    expect(kept.at(-1)!.packet.body.id).toBe(packet.body.id);
    expect(receipts(channel)).toEqual([packet.body.id]);
    // The same message again (its sender missed the receipt) is confirmed again without storing a copy.
    deliver(packet); await settle();
    expect(receipts(channel)).toEqual([packet.body.id, packet.body.id]);
    expect(engine.messages).toHaveLength(MAX_STORED_MESSAGES);
  });

  test('a message that could not be saved is not confirmed, and the failure is left to the storage banner (SYNC-4)', async () => {
    const { channel, settle, deliver, errors } = await room();
    fakeStorage.failWith = 'QuotaExceededError';
    deliver(await messageFrom('lost for now')); await settle();
    expect(receipts(channel)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('a device that stays in the room but never returns cannot block sending or pin the history', async () => {
    // The remote device is listed in the room but never confirms anything.
    const { engine } = await room();
    for (let i = 0; i < 1001; i++) await engine.send(`mine ${i}`);
    expect(engine.messages).toHaveLength(1001);
    // A history full of such messages still makes room: the oldest unconfirmed lose protection first.
    const own = (i: number) => ({ packet: { body: { kind: 'message', roomId, id: crypto.randomUUID(), deviceId: local.id, memberId: me, text: `old ${i}`, at: i + 1 }, signature: 'x' },
      targets: [remote.id], receipts: [] as string[] });
    records.set(`messages:${local.id}:${roomId}`, Array.from({ length: MAX_STORED_MESSAGES }, (_, i) => own(i)));
    const full = await room();
    await full.engine.send('still works');
    expect(full.engine.messages).toHaveLength(MAX_STORED_MESSAGES);
    expect(full.engine.messages[0].packet.body.text).toBe('old 1');
    expect(full.engine.messages.at(-1).packet.body.text).toBe('still works');
    const incoming = await messageFrom('and receives');
    full.deliver(incoming); await full.settle();
    expect(receipts(full.channel)).toEqual([incoming.body.id]);
  });

  test('receipts are written together rather than rewriting the history for each one (SYNC-7)', async () => {
    const { engine, deliver, settle } = await room();
    for (let i = 0; i < 3; i++) await engine.send(`hello ${i}`);
    const before = fakeStorage.writes;
    for (const m of engine.messages) {
      const body = { kind: 'receipt', roomId, id: m.packet.body.id, deviceId: remote.id };
      deliver({ body, signature: await remote.sign(body) });
    }
    await settle();
    expect(engine.messages.every((m: any) => m.receipts.includes(remote.id))).toBe(true);
    expect(fakeStorage.writes).toBe(before);
    await Bun.sleep(1100); await engine.serial;
    expect(fakeStorage.writes).toBe(before + 1);
    expect((records.get(`messages:${local.id}:${roomId}`) as any[]).every(m => m.receipts.includes(remote.id))).toBe(true);
  });
});

const taskFrom = async (title: string, revision?: number) => {
  const body = { ...taskBody({ roomId, deviceId: remote.id, memberId: them, change: { title } }), ...(revision ? { revision } : {}) };
  return { body, signature: await remote.sign(body) };
};

describe('browser receive quotas (SEC-5)', () => {
  test('a member’s live messages past the burst are dropped without a receipt, and accepted again as the quota refills', async () => {
    const { engine, channel, settle, deliver } = await room();
    const debug = console.debug; const lines: string[] = []; console.debug = (line: string) => { lines.push(line); };
    try {
      const packets = await Promise.all(Array.from({ length: 25 }, (_, i) => messageFrom(`flood ${i}`)));
      for (const packet of packets) deliver(packet);
      await settle();
      expect(engine.messages).toHaveLength(20);
      expect(receipts(channel)).toEqual(packets.slice(0, 20).map(p => p.body.id));
      expect(lines).toHaveLength(1); // One debug line, not one per packet.
      // Its other kinds have their own allowance.
      deliver(await taskFrom('Still fine')); await settle();
      expect(engine.ops).toHaveLength(1);
      // A dropped message sent again once the quota refills is stored and confirmed.
      await Bun.sleep(1100);
      deliver(packets[20]); await settle();
      expect(receipts(channel).at(-1)).toBe(packets[20].body.id);
    } finally { console.debug = debug; }
  });

  test('a burst of task updates over the quota converges without a reconnect: the receiver asks for the board again', async () => {
    const { engine, channel, settle, deliver } = await room();
    const created = await taskFrom('Agent task');
    const ops = [created];
    for (let revision = 2; revision <= 30; revision++) {
      const body = { ...created.body, id: crypto.randomUUID(), revision, notes: `step ${revision}`, status: revision === 30 ? 'done' as const : 'doing' as const };
      ops.push({ body, signature: await remote.sign(body) });
    }
    for (const op of ops) deliver(op);
    await settle();
    expect(engine.ops).toHaveLength(QUOTA_BURST); // The rest went over the quota, final state included.
    const requests = () => channel.sent.map(t => JSON.parse(t)).filter(p => p.kind === SYNC_REQUEST);
    expect(requests()).toHaveLength(0); // Not while the burst may still be going on.
    engine.quotaDrops = Object.assign(new QuotaDrops(() => Date.now(), 0), { dropped: engine.quotaDrops.dropped });
    engine.tick();
    expect(requests()).toEqual([{ kind: SYNC_REQUEST, roomId }]);
    engine.tick();
    expect(requests()).toHaveLength(1); // Asked once per burst.
    // The peer answers with its board in sync envelopes, which the quota does not charge.
    for (const chunk of syncChunks(roomId, ops)) deliver(chunk);
    await settle();
    expect(engine.ops).toHaveLength(30);
    expect(engine.ops.map((op: any) => op.body.revision).sort((a: number, b: number) => a - b).at(-1)).toBe(30);
  });

  test('a live task operation far past the held revision is refused, so a task cannot be frozen', async () => {
    const { engine, settle, deliver } = await room();
    const created = await taskFrom('Fix header');
    deliver(created); await settle();
    const frozen = { ...created.body, id: crypto.randomUUID(), revision: 1_000_000 };
    deliver({ body: frozen, signature: await remote.sign(frozen) }); await settle();
    expect(engine.ops.map((op: any) => op.body.revision)).toEqual([1]);
    const next = { ...created.body, id: crypto.randomUUID(), revision: 2, title: 'Fix the header' };
    deliver({ body: next, signature: await remote.sign(next) }); await settle();
    expect(engine.ops.map((op: any) => op.body.revision)).toEqual([1, 2]);
  });
});

describe('browser sync pacing (SYNC-3)', () => {
  test('packets dropped under load make the receiver ask the peer for its state again', async () => {
    const { engine, channel, settle, deliver } = await room();
    const ops = await Promise.all(Array.from({ length: MAX_PENDING_INCOMING + 6 }, (_, i) => taskFrom(`Task ${i}`)));
    // One burst, as a channel delivers it: the first 64 wait for the handler, the rest are dropped.
    for (const op of ops) deliver({ kind: 'board', roomId, ops: [op] });
    await settle();
    expect(engine.ops).toHaveLength(MAX_PENDING_INCOMING);
    expect(channel.sent.map(t => JSON.parse(t)).filter(p => p.kind === SYNC_REQUEST)).toEqual([{ kind: SYNC_REQUEST, roomId }]);
    // The peer answers with its whole board; held operations are skipped, the missing ones stored.
    for (const chunk of syncChunks(roomId, ops)) deliver(chunk);
    await settle();
    expect(engine.ops).toHaveLength(ops.length);
  });

  test('a sync request is answered with this device’s state, paced by the send buffer, at most once per interval', async () => {
    const { engine, channel, settle, deliver } = await room();
    await engine.changeTask({ title: 'Ship the beta' });
    channel.sent.length = 0; channel.bufferedAmount = PACE_HIGH_WATER;
    deliver({ kind: SYNC_REQUEST, roomId }); await settle();
    expect(channel.sent).toHaveLength(0); // Queued behind a full send buffer.
    channel.bufferedAmount = 0; engine.peers.get(remote.id).queue.pump();
    expect(channel.sent.map(t => JSON.parse(t).kind)).toEqual(['board']);
    deliver({ kind: SYNC_REQUEST, roomId }); await settle();
    expect(channel.sent).toHaveLength(1); // Answered again only after the interval.
    // A request naming another room is ignored.
    deliver({ kind: SYNC_REQUEST, roomId: crypto.randomUUID() }); await settle();
    expect(channel.sent).toHaveLength(1);
  });
});
