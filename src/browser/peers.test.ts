import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { fakeStorage, installFakeIndexedDB } from './test-indexeddb';
import { BrowserPeers, PENDING_REACTION_TTL_MS } from './peers';
import { MAX_STORED_MESSAGES } from './history';
import { FILE_CHANNEL_LABEL, MAX_PENDING_INCOMING, PACE_HIGH_WATER, PRIMARY_CHANNEL_LABEL, Resync, SYNC_REQUEST, UNHEALTHY_GRACE_MS } from './pacer';
import { MAX_LIVE_TASKS_PER_MEMBER, syncChunks, taskBody } from './board';
import { FenceError, claimFence, identity } from './storage';
import { QUOTA_BURST, QuotaDrops } from './quota';
import { MAX_PENDING_PER_MEMBER, MAX_REACTION_KEYS_PER_MEMBER, REACTION_EMOJI, reactionSyncChunks, type ReactionPacket } from './reactions';

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

describe('browser history window', () => {
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

  test('a message that could not be saved is not confirmed, and the failure is left to the storage banner', async () => {
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

  test('receipts are written together rather than rewriting the history for each one', async () => {
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

describe('browser receive quotas', () => {
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

describe('browser sync pacing', () => {
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

describe('message retractions (HIST-3)', () => {
  const retraction = async (target: string, signer = remote, memberId = them) => {
    const body = { kind: 'retract', roomId, id: crypto.randomUUID(), deviceId: signer.id, memberId, at: Date.now(), target };
    return { body, signature: await signer.sign(body) };
  };
  const stored = () => JSON.stringify([...records.values()]);
  const held = (engine: any, id: string) => engine.messages.find((m: any) => m.packet.body.id === id);

  test('deleting your own message leaves a stub, stores no text and tells connected peers', async () => {
    const { engine, channel } = await room();
    await engine.send('take this back');
    const id = engine.messages[0].packet.body.id;
    await engine.retract(id);
    expect(held(engine, id)).toMatchObject({ retracted: true, targets: [], packet: { signature: '', body: { id, text: '' } } });
    expect(stored()).not.toContain('take this back');
    const sent = channel.sent.map(t => JSON.parse(t)).find(p => p.body?.kind === 'retract');
    expect(sent.body.target).toBe(id);
    await engine.retract(id);
    expect(channel.sent.map(t => JSON.parse(t)).filter(p => p.body?.kind === 'retract').length).toBe(1);
  });
  test('someone else’s message cannot be deleted from this browser', async () => {
    const { engine, deliver, settle } = await room();
    const message = await messageFrom('theirs');
    deliver(message); await settle();
    await expect(engine.retract(message.body.id)).rejects.toThrow('You can only delete your own messages.');
    expect(held(engine, message.body.id).packet.body.text).toBe('theirs');
  });
  test('the author’s retraction removes the message here, and survives a reload', async () => {
    const { engine, deliver, settle } = await room();
    const message = await messageFrom('gone soon');
    deliver(message); await settle();
    deliver(await retraction(message.body.id)); await settle();
    expect(held(engine, message.body.id).retracted).toBe(true);
    expect(stored()).not.toContain('gone soon');
    const again = await room();
    expect(held(again.engine, message.body.id).retracted).toBe(true);
    again.deliver(message); await again.settle();
    expect(held(again.engine, message.body.id).packet.body.text).toBe('');
  });
  test('another member cannot retract a message, even with a valid signature of their own', async () => {
    const { engine, deliver, settle } = await room();
    await engine.send('mine stays');
    const id = engine.messages[0].packet.body.id;
    deliver(await retraction(id)); await settle();
    expect(held(engine, id).packet.body.text).toBe('mine stays');
    expect(engine.retractOps).toEqual([]);
  });
  test('a retraction with a bad signature or a false member is refused', async () => {
    const { engine, deliver, settle } = await room();
    const message = await messageFrom('still here');
    deliver(message); await settle();
    const forged = await retraction(message.body.id);
    deliver({ ...forged, signature: (await retraction(message.body.id)).signature }); await settle();
    deliver({ kind: 'retractions', roomId, ops: [{ ...forged, signature: 'AAAA' }] }); await settle();
    deliver(await retraction(message.body.id, remote, me)); await settle();
    expect(held(engine, message.body.id).packet.body.text).toBe('still here');
  });
  test('a retraction that arrives first means the message is never stored, and is still confirmed', async () => {
    const { engine, channel, deliver, settle } = await room();
    const message = await messageFrom('never kept');
    deliver(await retraction(message.body.id)); await settle();
    deliver(message); await settle();
    expect(held(engine, message.body.id).retracted).toBe(true);
    expect(stored()).not.toContain('never kept');
    expect(receipts(channel)).toContain(message.body.id);
  });
  test('a sender still retrying the original gets a receipt, so it stops', async () => {
    const { channel, deliver, settle } = await room();
    const message = await messageFrom('retrying');
    deliver(message); await settle();
    deliver(await retraction(message.body.id)); await settle();
    channel.sent.length = 0;
    deliver(message); await settle();
    expect(receipts(channel)).toEqual([message.body.id]);
    expect(stored()).not.toContain('retrying');
  });
  test('a retraction exchanged on connect verifies against a former device of the author', async () => {
    const { engine, deliver, settle } = await room();
    const message = await messageFrom('from the old laptop');
    deliver(message); await settle();
    const former = await keyPair();
    engine.status = { ...status, formerDevices: [{ id: former.id, publicKey: former.publicKey, label: 'old', memberId: them, admittedAt: 1 }] };
    deliver({ kind: 'retractions', roomId, ops: [await retraction(message.body.id, former)] }); await settle();
    expect(held(engine, message.body.id).retracted).toBe(true);
    engine.status = status;
  });
  test('a retraction relayed for a device someone else removed is refused, whatever time it claims', async () => {
    const { engine, deliver, settle } = await room();
    const message = await messageFrom('kept after the laptop was lost');
    deliver(message); await settle();
    const lost = await keyPair();
    engine.status = { ...status, formerDevices: [{ id: lost.id, publicKey: lost.publicKey, memberId: them, retiredAt: Date.now() + 60_000, revoked: true }] };
    deliver({ kind: 'retractions', roomId, ops: [await retraction(message.body.id, lost)] }); await settle();
    expect(held(engine, message.body.id).retracted).toBeFalsy();
    engine.status = status;
  });
  test('the log is sent to peers with the rest of the state, and a stub never is', async () => {
    const { engine, channel } = await room();
    await engine.send('old news');
    const id = engine.messages[0].packet.body.id;
    await engine.retract(id);
    channel.sent.length = 0;
    engine.flush(); engine.sendState(engine.peers.get(remote.id));
    engine.peers.get(remote.id).queue.pump();
    const sent = channel.sent.map(t => JSON.parse(t));
    expect(sent.find(p => p.kind === 'retractions').ops[0].body.target).toBe(id);
    expect(sent.some(p => p.body?.kind === 'message')).toBe(false);
  });
  test('a deleted message takes no new reactions', async () => {
    const { engine } = await room();
    await engine.send('quiet');
    const id = engine.messages[0].packet.body.id;
    await engine.retract(id);
    await expect(engine.react(id, '👍')).rejects.toThrow('That message is not in this browser.');
  });
  test('a member past the reaction cap keeps their newest, and a deleted message takes its reactions with it', async () => {
    const { engine } = await room();
    const ids: string[] = [];
    for (let i = 0; i < MAX_REACTION_KEYS_PER_MEMBER / REACTION_EMOJI.length; i++) {
      await engine.send(`message ${i}`);
      const id = engine.messages.at(-1).packet.body.id; ids.push(id);
      for (const emoji of REACTION_EMOJI) await engine.react(id, emoji);
    }
    await engine.send('still here');
    const kept = engine.messages.at(-1).packet.body.id;
    // One more never fails: the member's oldest reaction lets go.
    await engine.react(kept, '👍');
    const shown = () => engine.chips().map((chip: { messageId: string; emoji: string }) => `${chip.messageId} ${chip.emoji}`);
    expect(shown()).toContain(`${kept} 👍`);
    expect(shown()).not.toContain(`${ids[0]} ${REACTION_EMOJI[0]}`);
    expect(shown()).toHaveLength(MAX_REACTION_KEYS_PER_MEMBER);
    await engine.retract(ids[1]);
    expect(engine.reactionOps.some((op: ReactionPacket) => op.body.messageId === ids[1])).toBe(false);
  });
  test('a file write under way when its message is deleted is removed behind it', async () => {
    const { engine } = await room();
    const sha = 'a'.repeat(64);
    const writing = engine.storeFile(sha, new Uint8Array([1, 2, 3]), 'application/octet-stream');
    engine.syncFiles();
    await writing; await engine.fileSerial;
    expect(engine.index[sha]).toBeUndefined();
    expect(records.has(`file:${local.id}:${roomId}:${sha}`)).toBe(false);
  });
  test('a stale owner cannot write a retraction', async () => {
    const stale = await room();
    await stale.engine.send('held');
    const id = stale.engine.messages[0].packet.body.id;
    await room();
    await expect(stale.engine.retract(id)).rejects.toThrow(FenceError);
  });

  test('incoming reactions targeting a retracted stub are ignored and never parked pending', async () => {
    const { engine, deliver, settle } = await room();
    const message = await messageFrom('will be retracted');
    deliver(message); await settle();
    deliver(await retraction(message.body.id)); await settle();
    const reactionForStub = async (emoji: (typeof REACTION_EMOJI)[number]) => {
      const body = { kind: 'reaction' as const, roomId, id: crypto.randomUUID(), deviceId: remote.id, memberId: them, messageId: message.body.id, emoji, revision: 1, at: Date.now() };
      return { body, signature: await remote.sign(body) };
    };
    deliver(await reactionForStub('👍'));
    deliver({ kind: 'reactions', roomId, ops: [await reactionForStub('❤️')] });
    await settle();
    expect(engine.reactionOps).toHaveLength(0);
    expect(engine.pendingReactions).toHaveLength(0);
  });

  test('messages leaving the history window change no reaction, so devices agree whatever they still hold', async () => {
    const { engine } = await room();
    await engine.send('old');
    const old = engine.messages.at(-1).packet.body.id;
    await engine.react(old, '👍');
    await engine.send('new');
    const latest = engine.messages.at(-1).packet.body.id;
    engine.messages = engine.messages.filter((m: any) => m.packet.body.id !== old);
    await engine.react(latest, '👍');
    expect(engine.reactionOps.map((op: ReactionPacket) => op.body.messageId)).toEqual([old, latest]);
  });
});

describe('P0-2 board sync limits & P0-7 already-open channel', () => {
  test('a single member cannot fill the board via board sync envelopes or bypass MAX_REVISION_JUMP in one batch', async () => {
    const { engine, deliver, settle } = await room();
    const flood = await Promise.all(Array.from({ length: MAX_LIVE_TASKS_PER_MEMBER + 40 }, (_, i) => taskFrom(`Flood ${i}`)));
    for (const chunk of syncChunks(roomId, flood)) deliver(chunk);
    await settle();
    expect(engine.ops).toHaveLength(MAX_LIVE_TASKS_PER_MEMBER);
    // Another member (local) can still create tasks cleanly.
    await engine.changeTask({ title: 'Mine still fits' });
    expect(engine.ops).toHaveLength(MAX_LIVE_TASKS_PER_MEMBER + 1);
    // Stepping +1000 repeatedly in one board sync envelope cannot advance past MAX_REVISION_JUMP.
    const target = flood[0].body;
    const step1000 = { ...target, id: crypto.randomUUID(), revision: 1000 };
    const step2000 = { ...target, id: crypto.randomUUID(), revision: 2000 };
    deliver({
      kind: 'board',
      roomId,
      ops: [
        { body: step1000, signature: await remote.sign(step1000) },
        { body: step2000, signature: await remote.sign(step2000) },
      ],
    });
    await settle();
    const revs = engine.ops.filter((op: any) => op.body.taskId === target.taskId).map((op: any) => op.body.revision);
    expect(revs).toContain(1000);
    expect(revs).not.toContain(2000);
  });

  test('an already-open channel triggers sendState once and a replaced peer’s late onopen is a no-op', async () => {
    const engine = new BrowserPeers({} as never, roomId, local.id, 'session', () => {}, () => {}) as any;
    engine.fenced(await claimFence(`owner:${local.id}:${roomId}`));
    await engine.load();
    engine.status = status;
    await engine.changeTask({ title: 'Existing task' });

    const openChannel = fakeChannel();
    const peerA = { pc: { close() {} }, session: 's1', started: Date.now(), sent: new Map(), resync: new Resync() };
    engine.peers.set(remote.id, peerA);
    engine.connectChannel(peerA, remote.id, openChannel);
    const boardsAfterConnect = () => openChannel.sent.map(t => JSON.parse(t)).filter(p => p.kind === 'board');
    expect(boardsAfterConnect()).toHaveLength(1);
    // A subsequent onopen firing on the same channel must be idempotent.
    openChannel.onopen?.();
    expect(boardsAfterConnect()).toHaveLength(1);

    // A channel connected in 'connecting' state whose peer gets replaced before onopen fires does nothing.
    const staleChannel = { ...fakeChannel(), readyState: 'connecting' };
    const peerStale = { pc: { close() {} }, session: 's2', started: Date.now(), sent: new Map(), resync: new Resync() };
    engine.peers.set(remote.id, peerStale);
    engine.connectChannel(peerStale, remote.id, staleChannel);
    expect(staleChannel.sent).toHaveLength(0);
    const peerReplacement = { pc: { close() {} }, session: 's3', started: Date.now(), sent: new Map(), resync: new Resync() };
    engine.peers.set(remote.id, peerReplacement);
    staleChannel.readyState = 'open';
    staleChannel.onopen?.();
    expect(staleChannel.sent).toHaveLength(0);
  });
});

describe('WebRTC WAN stability and dedicated file channel (OPS-9, SYNC-5, OPS-11, SEC-11)', () => {
  const OriginalPC = globalThis.RTCPeerConnection;
  let ufragSeq = 0;
  let createdPcs: FakePC[] = [];
  let failSetConfig = false;
  let omitSetConfig = false;

  type MockChannel = Fake & { label: string; removeEventListener(type: string, fn: () => void): void };
  function mockChannel(label: string, initialState = 'connecting'): MockChannel {
    return {
      label,
      readyState: initialState,
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      sent: [],
      send(text: string) { this.sent.push(text); },
      addEventListener() {},
      removeEventListener() {},
    };
  }

  class FakePC {
    iceServers: RTCIceServer[];
    connectionState: RTCPeerConnectionState = 'new';
    iceConnectionState: RTCIceConnectionState = 'new';
    signalingState: RTCSignalingState = 'stable';
    iceGatheringState: RTCIceGatheringState = 'complete';
    localDescription: { type: RTCSdpType; sdp: string; toJSON(): { type: RTCSdpType; sdp: string } } | null = null;
    remoteDescription: { type: RTCSdpType; sdp: string } | null = null;
    remoteDescriptions: RTCSessionDescriptionInit[] = [];
    channels: MockChannel[] = [];
    closed = false;
    configUpdates: RTCIceServer[][] = [];
    ondatachannel?: (ev: { channel: MockChannel }) => void;
    onconnectionstatechange?: () => void;
    oniceconnectionstatechange?: () => void;
    setConfiguration?: (config: RTCConfiguration) => void;
    constructor(config: RTCConfiguration = {}) {
      this.iceServers = config.iceServers ? [...config.iceServers] : [];
      if (!omitSetConfig) {
        this.setConfiguration = (next: RTCConfiguration) => {
          if (failSetConfig) throw new Error('setConfiguration unsupported');
          this.iceServers = next.iceServers ? [...next.iceServers] : [];
          this.configUpdates.push(this.iceServers);
        };
      }
      createdPcs.push(this);
    }
    createDataChannel(label: string) {
      const ch = mockChannel(label, 'connecting');
      this.channels.push(ch);
      return ch;
    }
    async createOffer() {
      const ufrag = `off${++ufragSeq}`;
      return { type: 'offer' as const, sdp: `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=ice-ufrag:${ufrag}\r\na=mid:0\r\n` };
    }
    async createAnswer() {
      const ufrag = `ans${++ufragSeq}`;
      return { type: 'answer' as const, sdp: `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=ice-ufrag:${ufrag}\r\na=mid:0\r\n` };
    }
    async setLocalDescription(desc: { type: RTCSdpType; sdp: string }) {
      if (this.closed) throw new Error('closed');
      this.localDescription = { ...desc, toJSON: () => ({ type: desc.type, sdp: desc.sdp }) };
      this.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable';
    }
    async setRemoteDescription(desc: RTCSessionDescriptionInit) {
      if (this.closed) throw new Error('closed');
      this.remoteDescriptions.push(desc);
      this.remoteDescription = { type: desc.type, sdp: desc.sdp ?? '' };
      this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
    }
    addEventListener() {}
    removeEventListener() {}
    close() {
      this.closed = true;
      this.connectionState = 'closed';
      this.iceConnectionState = 'closed';
      this.signalingState = 'closed';
    }
  }

  const peerLow = '0'.repeat(64); // sorts < local.id (remote offers, we answer)
  const peerHigh = 'f'.repeat(64); // sorts > local.id (we offer, remote answers)

  beforeEach(() => {
    createdPcs = [];
    failSetConfig = false;
    omitSetConfig = false;
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = FakePC;
  });
  afterEach(() => {
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = OriginalPC;
  });

  async function wanRoom(options: { onSignal?: (payload: Record<string, unknown>) => Promise<void> | void; now?: () => number } = {}) {
    const signalsSent: Record<string, unknown>[] = [];
    const errors: string[] = [];
    const api = {
      command: async (action: string, _roomId: string, payload: Record<string, unknown>) => {
        if (action === 'signal') {
          await options.onSignal?.(payload);
          signalsSent.push(payload);
        }
        return {};
      },
    };
    const engine = new BrowserPeers(api as never, roomId, local.id, 'local-session', () => {}, msg => errors.push(msg),
      () => {}, () => {}, () => {}, () => {}, () => {}, options.now ?? (() => Date.now())) as any;
    engine.fenced(await claimFence(`owner:${local.id}:${roomId}`));
    await engine.load();
    return { engine, signalsSent, errors };
  }

  const makeStatus = (overrides: Record<string, unknown> = {}) => ({
    roomId, title: 'Room', epoch: 'e1', hostOnline: true, deviceId: local.id, memberId: me, ownerId: me,
    members: [{ id: me, name: 'Me' }, { id: them, name: 'Them' }],
    devices: [
      { id: local.id, publicKey: local.publicKey, label: 'me', memberId: me, admittedAt: 1, session: 'local-session' },
      { id: peerHigh, publicKey: remote.publicKey, label: 'high', memberId: them, admittedAt: 1, session: 'sess-high' },
    ],
    signals: [],
    iceServers: [{ urls: 'turn:turn.example:3478', username: '1000:room', credential: 'cred-1' }],
    ...overrides,
  });

  test('OPS-9: coordinator epoch change keeps open healthy peers alive while tearing down connecting peers', async () => {
    let clock = 1_000_000;
    const { engine } = await wanRoom({ now: () => clock });
    const devA = { id: peerHigh, publicKey: remote.publicKey, label: 'open', memberId: them, admittedAt: 1, session: 's-open' };
    const devB = { id: `${'f'.repeat(63)}e`, publicKey: remote.publicKey, label: 'connecting', memberId: them, admittedAt: 1, session: 's-conn' };
    await engine.update(makeStatus({ devices: [
      { id: local.id, publicKey: local.publicKey, label: 'me', memberId: me, admittedAt: 1, session: 'local-session' },
      devA, devB,
    ] }));
    expect(createdPcs).toHaveLength(2);
    const peerOpen = engine.peers.get(devA.id);
    const peerConn = engine.peers.get(devB.id);
    const pcOpen = peerOpen.pc as FakePC;
    const pcConn = peerConn.pc as FakePC;
    // Mark devA healthy & open, leave devB half-open ('connecting').
    pcOpen.connectionState = 'connected';
    pcOpen.iceConnectionState = 'connected';
    peerOpen.channel.readyState = 'open';
    peerOpen.channel.onopen?.();
    pcConn.connectionState = 'connecting';

    // Coordinator restarts -> new epoch, and devA hasn't polled the new coordinator yet (session temporarily undefined!).
    clock += 2_000;
    await engine.update(makeStatus({
      epoch: 'e2',
      devices: [
        { id: local.id, publicKey: local.publicKey, label: 'me', memberId: me, admittedAt: 1, session: 'local-session' },
        { ...devA, session: undefined },
        devB,
      ],
    }));
    // Open peer survives untouched! Half-open connecting peer was torn down and immediately renegotiated.
    expect(pcOpen.closed).toBe(false);
    expect(engine.peers.get(devA.id)).toBe(peerOpen);
    expect(pcConn.closed).toBe(true);
    expect(engine.peers.get(devB.id)).not.toBe(peerConn);
    expect(engine.peers.get(devB.id)).toBeDefined();

    // Actually removing devA from the room still disconnects it immediately.
    await engine.update(makeStatus({
      epoch: 'e2',
      devices: [{ id: local.id, publicKey: local.publicKey, label: 'me', memberId: me, admittedAt: 1, session: 'local-session' }, devB],
    }));
    expect(pcOpen.closed).toBe(true);
    expect(engine.peers.has(devA.id)).toBe(false);
  });

  test('SYNC-5: long-lived peer gets unhealthySince grace on disconnected, zombie connected+closed channel drops immediately', async () => {
    let clock = 1_000_000;
    const { engine } = await wanRoom({ now: () => clock });
    await engine.update(makeStatus());
    const peer = engine.peers.get(peerHigh);
    const pc = peer.pc as FakePC;
    pc.connectionState = 'connected';
    pc.iceConnectionState = 'connected';
    peer.channel.readyState = 'open';
    peer.channel.onopen?.();
    await engine.update(makeStatus());

    // Advance clock > 1 hour (long-lived healthy session), then briefly drop to 'disconnected'.
    clock += 2 * 3_600_000;
    pc.connectionState = 'disconnected';
    pc.iceConnectionState = 'disconnected';
    await engine.update(makeStatus());
    expect(pc.closed).toBe(false);
    expect(engine.peers.get(peerHigh)).toBe(peer);
    expect(peer.unhealthySince).toBe(clock);

    // Recovers within grace period: unhealthySince clears and PC stays alive!
    clock += 5_000;
    pc.connectionState = 'connected';
    pc.iceConnectionState = 'connected';
    await engine.update(makeStatus());
    expect(pc.closed).toBe(false);
    expect(peer.unhealthySince).toBeUndefined();

    // Drops again and stays disconnected past UNHEALTHY_GRACE_MS -> torn down and recreated!
    clock += 10_000;
    pc.connectionState = 'disconnected';
    pc.iceConnectionState = 'disconnected';
    await engine.update(makeStatus());
    expect(pc.closed).toBe(false);
    clock += UNHEALTHY_GRACE_MS + 1;
    await engine.update(makeStatus());
    expect(pc.closed).toBe(true);
    const peer2 = engine.peers.get(peerHigh);
    expect(peer2).not.toBe(peer);

    // Zombie PC: connectionState === 'connected' while DataChannel is 'closed' -> dropped immediately!
    const pc2 = peer2.pc as FakePC;
    pc2.connectionState = 'connected';
    pc2.iceConnectionState = 'connected';
    peer2.channel.readyState = 'closed';
    await engine.update(makeStatus());
    expect(pc2.closed).toBe(true);
    expect(engine.peers.get(peerHigh)).not.toBe(peer2);

    // Zombie PC #2: connectionState === 'connected' while DataChannel never opens ('connecting') -> dropped after grace!
    const peer3 = engine.peers.get(peerHigh);
    const pc3 = peer3.pc as FakePC;
    pc3.connectionState = 'connected';
    pc3.iceConnectionState = 'connected';
    peer3.channel.readyState = 'connecting';
    await engine.update(makeStatus());
    expect(pc3.closed).toBe(false);
    clock += UNHEALTHY_GRACE_MS + 1;
    await engine.update(makeStatus());
    expect(pc3.closed).toBe(true);
    expect(engine.peers.get(peerHigh)).not.toBe(peer3);
  });

  test('SYNC-5: failed signal cleans up half-open peer immediately; duplicate offers and stale answers are rejected', async () => {
    let clock = 1_000_000;
    let shouldFailSignal = true;
    const { engine, signalsSent } = await wanRoom({
      now: () => clock,
      onSignal: () => { if (shouldFailSignal) throw new Error('signal 409'); },
    });

    // 1. Failed signal cleans up peer immediately (doesn't stall 20 s).
    await engine.update(makeStatus());
    expect(engine.peers.has(peerHigh)).toBe(false);
    expect(createdPcs[0].closed).toBe(true);

    // Next poll retries immediately (only +1 s later).
    clock += 1_000;
    shouldFailSignal = false;
    await engine.update(makeStatus());
    expect(engine.peers.has(peerHigh)).toBe(true);
    expect(signalsSent).toHaveLength(1);
    const pc1 = engine.peers.get(peerHigh).pc as FakePC;

    // 2. Valid answer with ufrag 'ans-valid-1' is accepted; mismatched mid or missing ufrag is rejected.
    await engine.update(makeStatus({
      signals: [{ seq: 1, from: peerHigh, session: 'sess-high', targetSession: 'local-session',
        description: { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:badmid\r\na=mid:99\r\n' } }],
    }));
    expect(pc1.remoteDescriptions).toHaveLength(0);

    await engine.update(makeStatus({
      signals: [{ seq: 2, from: peerHigh, session: 'sess-high', targetSession: 'local-session',
        description: { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:ans-valid-1\r\na=mid:0\r\n' } }],
    }));
    expect(pc1.remoteDescriptions).toHaveLength(1);

    // Force pc1 to fail -> recreates pc2, and retires 'ans-valid-1'. A stale replayed answer carrying 'ans-valid-1' is ignored!
    pc1.connectionState = 'failed';
    await engine.update(makeStatus());
    const pc2 = engine.peers.get(peerHigh).pc as FakePC;
    expect(pc2).not.toBe(pc1);
    await engine.update(makeStatus({
      signals: [{ seq: 3, from: peerHigh, session: 'sess-high', targetSession: 'local-session',
        description: { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:ans-valid-1\r\na=mid:0\r\n' } }],
    }));
    expect(pc2.remoteDescriptions).toHaveLength(0);

    // 3. Multiple offers from peerLow in one poll batch deduplicate to the newest seq (only 1 PC created, 1 answer sent).
    const beforePcs = createdPcs.length, beforeSignals = signalsSent.length;
    await engine.update(makeStatus({
      devices: [
        { id: local.id, publicKey: local.publicKey, label: 'me', memberId: me, admittedAt: 1, session: 'local-session' },
        { id: peerLow, publicKey: remote.publicKey, label: 'low', memberId: them, admittedAt: 1, session: 'sess-low' },
      ],
      signals: [
        { seq: 10, from: peerLow, session: 'sess-low', targetSession: 'local-session', description: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:old-off\r\na=mid:0\r\n' } },
        { seq: 11, from: peerLow, session: 'sess-low', targetSession: 'local-session', description: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:new-off\r\na=mid:0\r\n' } },
      ],
    }));
    expect(createdPcs.length - beforePcs).toBe(1);
    expect(signalsSent.length - beforeSignals).toBe(1);
    expect(createdPcs.at(-1)!.remoteDescription?.sdp).toContain('a=ice-ufrag:new-off');
  });

  test('OPS-11: refreshed TURN iceServers update existing PCs via setConfiguration and recreate disconnected PCs when unavailable', async () => {
    let clock = 1_000_000;
    const { engine } = await wanRoom({ now: () => clock });
    const ice1 = [{ urls: 'turn:turn.example:3478', username: '1000:room', credential: 'cred-1' }];
    const ice2 = [{ urls: 'turn:turn.example:3478', username: '4600:room', credential: 'cred-2' }];
    await engine.update(makeStatus({ iceServers: ice1 }));
    const peer = engine.peers.get(peerHigh);
    const pc = peer.pc as FakePC;
    pc.connectionState = 'connected';
    pc.iceConnectionState = 'connected';
    peer.channel.readyState = 'open';
    peer.channel.onopen?.();
    expect(pc.iceServers).toEqual(ice1);

    // Refreshed TURN credentials arrive -> pushed via setConfiguration immediately!
    await engine.update(makeStatus({ iceServers: ice2 }));
    expect(pc.configUpdates).toEqual([ice2]);
    expect(pc.iceServers).toEqual(ice2);

    // When setConfiguration throws/is absent and a peer is disconnected, it recreates cleanly with the fresh credentials.
    const ice3 = [{ urls: 'turn:turn.example:3478', username: '8200:room', credential: 'cred-3' }];
    failSetConfig = true;
    pc.connectionState = 'disconnected';
    pc.iceConnectionState = 'disconnected';
    await engine.update(makeStatus({ iceServers: ice3 }));
    expect(pc.closed).toBe(true);
    const replacement = engine.peers.get(peerHigh).pc as FakePC;
    expect(replacement).not.toBe(pc);
    expect(replacement.iceServers).toEqual(ice3);
  });

  test('SEC-11: dedicated files data channel isolates bulk transfers and falls back to primary channel for older peers', async () => {
    const { engine } = await wanRoom();
    await engine.update(makeStatus());
    const peer = engine.peers.get(peerHigh);
    const pc = peer.pc as FakePC;
    // Offerer creates both primary and dedicated 'files' channels.
    expect(pc.channels.map(c => c.label)).toEqual([PRIMARY_CHANNEL_LABEL, FILE_CHANNEL_LABEL]);
    const [primary, filesCh] = pc.channels;
    pc.connectionState = 'connected';
    pc.iceConnectionState = 'connected';
    primary.readyState = 'open';
    primary.onopen?.();
    filesCh.readyState = 'open';
    filesCh.onopen?.();
    // File capability announcement went out on 'files', and subsequent file-want goes over 'files' (not primary).
    expect(filesCh.sent.map(s => JSON.parse(s).kind)).toContain('files');
    primary.sent.length = 0;
    filesCh.sent.length = 0;
    filesCh.onmessage?.({ data: JSON.stringify({ kind: 'files', roomId, version: 1 }) });
    const imgRef = { id: crypto.randomUUID(), name: 'pic.png', type: 'image/png', size: 128, sha256: 'a'.repeat(64) };
    const pdfRef = { id: crypto.randomUUID(), name: 'doc.pdf', type: 'application/pdf', size: 512, sha256: 'b'.repeat(64) };
    // Deliver a message with one image and one PDF: only the image is auto-fetched!
    const msgBody = { kind: 'message', roomId, id: crypto.randomUUID(), deviceId: peerHigh, memberId: them, text: 'attachments', at: Date.now(), attachments: [imgRef, pdfRef] };
    primary.onmessage?.({ data: JSON.stringify({ body: msgBody, signature: await remote.sign(msgBody) }) });
    while (engine.incoming.size) await Bun.sleep(1);
    await engine.serial;
    // Image file-want went over the dedicated 'files' channel, NOT primary, and PDF was NOT auto-fetched!
    const wantedShas = () => filesCh.sent.map(s => JSON.parse(s)).filter(p => p.kind === 'file-want').map(p => p.sha256);
    expect(wantedShas()).toEqual([imgRef.sha256]);
    expect(primary.sent.map(s => JSON.parse(s)).some(p => p.kind === 'file-want')).toBe(false);
    // Explicit on-demand requestFile() fetches the PDF over the dedicated 'files' channel.
    engine.requestFile(pdfRef.sha256);
    expect(wantedShas()).toEqual([imgRef.sha256, pdfRef.sha256]);

    // Older single-channel peer (answerer receiving only primary channel): files seamlessly fall back to primary channel!
    await engine.update(makeStatus({
      devices: [
        { id: local.id, publicKey: local.publicKey, label: 'me', memberId: me, admittedAt: 1, session: 'local-session' },
        { id: peerLow, publicKey: remote.publicKey, label: 'low', memberId: them, admittedAt: 1, session: 'sess-low' },
      ],
      signals: [{ seq: 20, from: peerLow, session: 'sess-low', targetSession: 'local-session',
        description: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:legacy1\r\na=mid:0\r\n' } }],
    }));
    const legacyPeer = engine.peers.get(peerLow);
    const legacyPc = legacyPeer.pc as FakePC;
    const legacyChan = mockChannel(PRIMARY_CHANNEL_LABEL, 'open');
    legacyPc.ondatachannel?.({ channel: legacyChan });
    expect(legacyPeer.fileChannel).toBeUndefined();
    expect(legacyChan.sent.map(s => JSON.parse(s).kind)).toContain('files');
  });
});

describe('client sync polish (receipt TOCTOU and pendingReactions stale eviction)', () => {
  test('a channel closing mid-receipt sign or throwing on send does not raise a peer error banner', async () => {
    const { engine, channel, settle, deliver, errors } = await room();
    // Simulate a channel whose send() throws InvalidStateError after readyState was checked open before signing.
    channel.send = () => { throw new DOMException('RTCDataChannel is not open', 'InvalidStateError'); };
    const packet = await messageFrom('arrived right before disconnect');
    deliver(packet);
    await settle();
    expect(engine.messages.some((m: any) => m.packet.body.id === packet.body.id)).toBe(true);
    expect(errors).toEqual([]);
  });

  test('stale pendingReactions expire past TTL and evict oldest entries when member pending cap is reached', async () => {
    let clock = 1_000_000;
    const engine = new BrowserPeers({} as never, roomId, local.id, 'session', () => {}, () => {},
      () => {}, () => {}, () => {}, () => {}, () => {}, () => clock) as any;
    engine.fenced(await claimFence(`owner:${local.id}:${roomId}`));
    await engine.load();
    engine.status = status;
    const channel = fakeChannel(), peer = { pc: { close() {} }, session: 's', started: clock, sent: new Map(), resync: new Resync() };
    engine.peers.set(remote.id, peer); engine.connectChannel(peer, remote.id, channel);
    const settle = async () => { while (engine.incoming.size) await Bun.sleep(1); await engine.serial; };
    const deliver = (packet: unknown) => channel.onmessage!({ data: JSON.stringify(packet) });
    const makeReaction = async (messageId: string, i: number) => {
      const body = { kind: 'reaction' as const, roomId, id: crypto.randomUUID(), deviceId: remote.id, memberId: them, messageId, emoji: '👍' as const, revision: 1, at: clock + i };
      return { body, signature: await remote.sign(body) };
    };

    // Park MAX_PENDING_PER_MEMBER + 5 reactions for never-arriving (evicted) messages: oldest 5 evict FIFO so newest stay!
    const ops = await Promise.all(Array.from({ length: MAX_PENDING_PER_MEMBER + 5 }, (_, i) => makeReaction(crypto.randomUUID(), i)));
    for (const chunk of reactionSyncChunks(roomId, ops)) deliver(chunk);
    await settle();
    expect(engine.pendingReactions).toHaveLength(MAX_PENDING_PER_MEMBER);
    expect(engine.pendingReactions[0].body.id).toBe(ops[5].body.id);
    expect(engine.pendingReactions.at(-1).body.id).toBe(ops.at(-1)!.body.id);

    // Advance past PENDING_REACTION_TTL_MS: tick() evicts all stale pending reactions cleanly.
    clock += PENDING_REACTION_TTL_MS + 1;
    engine.tick();
    expect(engine.pendingReactions).toHaveLength(0);
    expect(engine.pendingReactionAt.size).toBe(0);
  });
});
