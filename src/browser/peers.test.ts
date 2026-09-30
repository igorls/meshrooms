import { beforeEach, describe, expect, test } from 'bun:test';
import { fakeStorage, installFakeIndexedDB } from './test-indexeddb';
import { BrowserPeers } from './peers';
import { MAX_STORED_MESSAGES } from './history';
import { MAX_PENDING_INCOMING, PACE_HIGH_WATER, Resync, SYNC_REQUEST } from './pacer';
import { syncChunks, taskBody } from './board';
import { FenceError, claimFence, identity } from './storage';
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
/** An engine that has claimed the room, as the app's engines do before writing; a later room() takes it over. */
async function room() {
  const errors: string[] = [];
  const engine = new BrowserPeers({} as never, roomId, local.id, 'session', () => {}, message => errors.push(message)) as any;
  engine.fenced(await claimFence(`owner:${local.id}:${roomId}`));
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
    // 1,001 signed sends plus a full history window: about 4 s on a desktop, past the default 5 s on a busy CI runner.
  }, 20_000);

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

describe('a stale owner after a takeover (fencing)', () => {
  const ownerKey = `owner:${local.id}:${roomId}`;
  const storedTexts = () => (records.get(`messages:${local.id}:${roomId}`) as { packet: { body: { text: string } } }[]).map(m => m.packet.body.text);
  /** The room held by one owner, then claimed by a second (a tab taking it over) while the first is frozen, not stopped. */
  async function takeover() {
    const stale = await room();
    const fresh = await room();
    return { stale, fresh };
  }

  test('a stale owner waking up writes nothing, loses nothing and confirms nothing', async () => {
    const stale = await room();
    const first = await messageFrom('before the takeover');
    stale.deliver(first); await stale.settle();
    expect(storedTexts()).toEqual(['before the takeover']);
    // The new owner claims the room and loads what the old one had written.
    const fresh = await room();
    const second = await messageFrom('stored by the new owner');
    fresh.deliver(second); await fresh.settle();
    expect(storedTexts()).toEqual(['before the takeover', 'stored by the new owner']);
    // The frozen owner wakes with its older copy and receives a message: its write of [first, third] must not land.
    const writes = fakeStorage.writes;
    const third = await messageFrom('sent while the old owner was frozen');
    stale.deliver(third); await stale.settle();
    expect(fakeStorage.writes).toBe(writes);
    expect(storedTexts()).toEqual(['before the takeover', 'stored by the new owner']);
    // No receipt, so the sender keeps it for the new owner; no banner; the stale engine stops.
    expect(receipts(stale.channel)).toEqual([first.body.id]);
    expect(stale.errors).toEqual([]);
    expect(stale.engine.isStopped()).toBe(true);
    // Its pending receipt writes and board changes are fenced too.
    await stale.engine.close();
    expect(storedTexts()).toEqual(['before the takeover', 'stored by the new owner']);
    // The new owner goes on as before, and gets the message when the sender retries.
    fresh.deliver(third); await fresh.settle();
    expect(storedTexts()).toEqual(['before the takeover', 'stored by the new owner', 'sent while the old owner was frozen']);
  });

  test('a message the new owner evicted is not brought back by the stale owner', async () => {
    const stored = Array.from({ length: MAX_STORED_MESSAGES }, (_, i) => ({
      packet: { body: { kind: 'message', roomId, id: crypto.randomUUID(), deviceId: remote.id, memberId: them, text: `old ${i}`, at: i + 1 }, signature: 'x' }, targets: [], receipts: [] }));
    records.set(`messages:${local.id}:${roomId}`, stored);
    const { stale, fresh } = await takeover();
    fresh.deliver(await messageFrom('newer')); await fresh.settle();
    fresh.deliver(await messageFrom('newest')); await fresh.settle();
    expect(storedTexts()[0]).toBe('old 2'); // 'old 0' and 'old 1' made room.
    // The stale owner still holds 'old 1'; its window with one more message would write it back.
    stale.deliver(await messageFrom('late')); await stale.settle();
    const after = storedTexts();
    expect(after).toHaveLength(MAX_STORED_MESSAGES);
    expect(after[0]).toBe('old 2');
    expect(after).not.toContain('old 1');
    expect(after.slice(-2)).toEqual(['newer', 'newest']);
    expect(after).not.toContain('late');
  });

  test('every kind of write by a stale owner is fenced, and the first one stops it', async () => {
    const own = { packet: { body: { kind: 'message', roomId, id: crypto.randomUUID(), deviceId: remote.id, memberId: them, text: 'held', at: 1 }, signature: 'x' }, targets: [], receipts: [] };
    const attempts: [string, (engine: any) => Promise<unknown>, string[]][] = [
      ['send', engine => engine.send('a draft that must come back'), [`messages:${local.id}:${roomId}`]],
      ['board', engine => engine.changeTask({ title: 'A task' }), [`board:${local.id}:${roomId}`]],
      ['decision', engine => engine.openDecision({ question: 'Which one?', options: ['A', 'B'] }), [`decisions:${local.id}:${roomId}`]],
      ['reaction', engine => engine.react(own.packet.body.id, '👍'), [`reactions:${local.id}:${roomId}`]],
      ['file', engine => engine.storeFile('a'.repeat(64), new Uint8Array([1, 2, 3]), 'image/png'), [`files:${local.id}:${roomId}`, `file:${local.id}:${roomId}:${'a'.repeat(64)}`]],
    ];
    for (const [kind, attempt, keys] of attempts) {
      records.clear();
      records.set(`messages:${local.id}:${roomId}`, [own]);
      const { stale } = await takeover();
      const before = keys.map(key => records.get(key));
      await expect(attempt(stale.engine), kind).rejects.toBeInstanceOf(FenceError);
      expect(keys.map(key => records.get(key)), kind).toEqual(before);
      expect(stale.engine.isStopped(), kind).toBe(true);
      expect(stale.engine.lostRoom(), kind).toBe(true);
      expect(stale.errors, kind).toEqual([]);
    }
  });

  test('a stale owner evicting files deletes nothing', async () => {
    const sha = 'b'.repeat(64), fileKey = `file:${local.id}:${roomId}:${sha}`, indexKey = `files:${local.id}:${roomId}`;
    const { stale } = await takeover();
    // The new owner holds a file that the stale owner, going by its older history, would evict.
    records.set(indexKey, { [sha]: { size: 3, type: 'image/png' } });
    records.set(fileKey, new Blob([new Uint8Array([1, 2, 3])]));
    stale.engine.index = { [sha]: { size: 3, type: 'image/png' } };
    stale.engine.syncFiles(); await stale.engine.fileSerial;
    expect(records.has(fileKey)).toBe(true);
    expect(records.get(indexKey)).toEqual({ [sha]: { size: 3, type: 'image/png' } });
    expect(stale.engine.isStopped()).toBe(true);
  });

  test('each claim moves the epoch on, even when two are made at once', async () => {
    const one = await claimFence(ownerKey), two = await claimFence(ownerKey);
    expect(two.epoch).toBe(one.epoch + 1);
    // Concurrent claims each read and write the epoch in one transaction: neither can take the other's number.
    const [three, four] = await Promise.all([claimFence(ownerKey), claimFence(ownerKey)]);
    expect([three.epoch, four.epoch]).toEqual([two.epoch + 1, two.epoch + 2]);
  });

  test('an engine without a claim writes nothing', async () => {
    const engine = new BrowserPeers({} as never, roomId, local.id, 'session', () => {}, () => {}) as any;
    await engine.load();
    engine.status = status;
    await expect(engine.send('never stored')).rejects.toThrow('Claim the room');
    expect(records.has(`messages:${local.id}:${roomId}`)).toBe(false);
  });
});
