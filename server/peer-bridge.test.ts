import { afterEach, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { LocalNode } from './node';
import { PeerBridge, packets } from './peer-bridge';
import { CATALOG, fingerprint, tokenHash } from './model';
import type { FileState, FileTransport, IncomingFile, IncomingPacket, PeerTransport } from './meshguard';

const nodes: LocalNode[] = [], bridges: PeerBridge[] = [];
afterEach(() => { for (const b of bridges.splice(0)) b.close(); for (const n of nodes.splice(0)) n.close(); });
function database() {
  const data = new Map<string, string>(); let fail = false;
  return { data, failWrites() { fail = true; }, recoverWrites() { fail = false; }, store: () => ({
    read: (key: string) => data.get(key) ?? null, write: (key: string, value: string) => { if (fail) throw new Error('disk failed'); data.set(key, value); }, close() {},
  }) };
}
function node(db = database()) { const n = new LocalNode(db.store()); nodes.push(n); return n; }
function fixture() {
  const dbA = database(), dbB = database(), a = node(dbA), b = node(dbB), room = randomUUID();
  const keyA = 'a'.repeat(64), keyB = 'b'.repeat(64);
  for (const [n, name] of [[a, 'Codex'], [b, 'Grok']] as const) {
    n.prepareRoom({ requestId: room, title: 'Transport test', agentName: name, credentialHash: tokenHash(name.repeat(16)) });
    n.completeSetup({ requestId: randomUUID(), intentId: room, humanName: `Test ${name} owner`, machineName: 'Test node', startAtLogin: false });
  }
  const descriptorA = a.descriptor(room, keyA), descriptorB = b.descriptor(room, keyB);
  a.pairRoom(descriptorB, keyA); b.pairRoom(descriptorA, keyB);
  const inboxA: IncomingPacket[] = [], inboxB: IncomingPacket[] = [];
  const state = { dropAcks: false, available: true, failFiles: false, files: true };
  const filesA: IncomingFile[] = [], filesB: IncomingFile[] = [], offered: string[] = [];
  // In-memory verified transfers: an offer lands whole in the peer's MeshGuard inbox.
  const makeFiles = (sender: string, own: IncomingFile[], remote: IncomingFile[]): FileTransport => {
    const statuses = new Map<string, FileState>();
    return {
      async offerFile(_peer, bytes, sha256, meta) {
        const id = randomUUID().replaceAll('-', ''); offered.push(sender);
        if (state.failFiles) statuses.set(id, { state: 'failed', error: 'receiver did not respond' });
        else { remote.push({ id, sender, sha256, meta, bytes }); statuses.set(id, { state: 'delivered' }); }
        return id;
      },
      async fileStatus(id) { return statuses.get(id) ?? null; },
      async nextFile() { return own.shift() ?? null; },
      async releaseFile(id) { statuses.delete(id); },
    };
  };
  const makeWire = (sender: string, own: IncomingPacket[], remote: IncomingPacket[], files: FileTransport): PeerTransport => ({
    async check() { if (!state.available) throw new Error('offline'); },
    async receive() { return own.shift() ?? null; },
    async send(_peer, data) { if (!state.dropAcks || JSON.parse(data).k !== 'ack') remote.push({ sender, data }); },
    get files() { return state.files ? files : undefined; },
  });
  const wireA = makeWire(keyA, inboxA, inboxB, makeFiles(keyA, filesA, filesB)), wireB = makeWire(keyB, inboxB, inboxA, makeFiles(keyB, filesB, filesA));
  const bridgeA = new PeerBridge(a, wireA), bridgeB = new PeerBridge(b, wireB); bridges.push(bridgeA, bridgeB);
  return { a, b, dbA, dbB, room, keyA, keyB, wireA, wireB, bridgeA, bridgeB, inboxA, inboxB, filesA, filesB, offered, state };
}

test('two admitted agents exchange fragmented unicode, while other rooms and author spoofing stay excluded', async () => {
  const f = fixture(), secretRoom = f.a.createRoom({ title: 'Private', requestId: randomUUID() }).roomId;
  // Agents open this exchange themselves, which requires an open floor on each node.
  for (const n of [f.a, f.b]) n.setFloor({ roomId: f.room, requestId: randomUUID(), floor: 'open' });
  f.a.send({ roomId: secretRoom, requestId: randomUUID(), text: 'Never shared' });
  const text = 'café 🚀'.repeat(300);
  const sent = f.a.send({ roomId: f.room, requestId: randomUUID(), text }, f.a.authenticateAgent('Codex'.repeat(16))!);
  await f.bridgeA.pump(1); expect(f.inboxB.length).toBeGreaterThan(1);
  f.inboxB.reverse();
  await f.bridgeB.pump(1); await f.bridgeA.pump(2);
  const roomB = f.b.snapshot().rooms[0]; expect(roomB.messages.map(m => [m.author, m.role, m.text])).toEqual([['Codex', 'agent', text]]);
  expect(f.b.snapshot().rooms).toHaveLength(1);
  expect(f.bridgeA.status().rooms[0].storedRemotely).toEqual([sent.messageId]);
  f.b.send({ roomId: f.room, requestId: randomUUID(), text: 'Received', replyTo: sent.messageId }, f.b.authenticateAgent('Grok'.repeat(16))!);
  await f.bridgeB.pump(2); await f.bridgeA.pump(3);
  expect(f.a.snapshot().rooms[0].messages.at(-1)?.author).toBe('Grok');
  const pending = f.b.pendingDelivery()[0].messages[0];
  expect(() => f.a.receivePeer(f.room, 'c'.repeat(64), pending)).toThrow('not admitted');
  expect(() => f.a.receivePeer(secretRoom, f.keyB, pending)).toThrow('not admitted');
  expect(() => f.a.receivePeer(f.room, f.keyB, { ...pending, authorId: f.a.owner.participantId })).toThrow('not admitted');
});

test('lost remote receipt plus sender and receiver restart retries without duplicate logical messages', async () => {
  const f = fixture(); f.state.dropAcks = true;
  const command = { roomId: f.room, requestId: randomUUID(), text: 'Durable retry' };
  const sent = f.a.send(command);
  await f.bridgeA.pump(1); await f.bridgeB.pump(1);
  expect(f.b.snapshot().rooms[0].messages).toHaveLength(1); expect(f.a.pendingDelivery()[0].messages).toHaveLength(1);
  f.bridgeA.close(); f.bridgeB.close(); f.a.close(); f.b.close();
  const a = node(f.dbA), b = node(f.dbB), ba = new PeerBridge(a, f.wireA), bb = new PeerBridge(b, f.wireB); bridges.push(ba, bb);
  f.state.dropAcks = false;
  expect(a.send(command).messageId).toBe(sent.messageId);
  await ba.pump(4000); await bb.pump(4000); await ba.pump(4001);
  expect(b.snapshot().rooms[0].messages).toHaveLength(1);
  expect(a.pendingDelivery()[0].messages).toHaveLength(0);
  expect(a.pendingDelivery()[0].acknowledged).toEqual([sent.messageId]);
  a.close(); const again = node(f.dbA); expect(again.pendingDelivery()[0].messages).toHaveLength(0);
});

test('a failed receiving store never produces a remote receipt; retry recovers after restart', async () => {
  const f = fixture(); f.a.send({ roomId: f.room, requestId: randomUUID(), text: 'Must persist first' }); f.dbB.failWrites();
  await f.bridgeA.pump(1); await f.bridgeB.pump(1);
  expect(f.inboxA).toHaveLength(0); expect(f.a.pendingDelivery()[0].messages).toHaveLength(1); expect(f.b.ready).toBe(false);
  f.bridgeB.close(); f.b.close(); f.dbB.recoverWrites();
  const b = node(f.dbB), bb = new PeerBridge(b, f.wireB); bridges.push(bb);
  await f.bridgeA.pump(4000); await bb.pump(4000); await f.bridgeA.pump(4001);
  expect(b.snapshot().rooms[0].messages).toHaveLength(1); expect(f.a.pendingDelivery()[0].messages).toHaveLength(0);
});

test('pairing does not publish old history and rejects conflicting grants and message retries', () => {
  const db = database(), a = node(db), b = node(), room = randomUUID();
  a.completeSetup({ requestId: randomUUID(), humanName: 'Local owner', machineName: 'Node A', startAtLogin: false });
  b.completeSetup({ requestId: randomUUID(), humanName: 'Remote owner', machineName: 'Node B', startAtLogin: false });
  a.createRoom({ title: 'Room', requestId: room }); b.createRoom({ title: 'Room', requestId: room });
  const beforePairing = a.send({ roomId: room, requestId: randomUUID(), text: 'Before pairing' });
  const descriptor = b.descriptor(room, 'b'.repeat(64));
  a.pairRoom(descriptor, 'a'.repeat(64)); a.pairRoom(descriptor, 'a'.repeat(64));
  expect(a.pendingDelivery()[0].messages).toHaveLength(0);
  expect(() => a.pairRoom({ ...descriptor, peerKey: 'c'.repeat(64) }, 'a'.repeat(64))).toThrow('already paired');
  b.pairRoom(a.descriptor(room, 'a'.repeat(64)), 'b'.repeat(64)); b.send({ roomId: room, requestId: randomUUID(), text: 'Original' });
  const incoming = b.pendingDelivery()[0].messages[0]; a.receivePeer(room, 'b'.repeat(64), incoming);
  const privateReply = { ...incoming, id: randomUUID(), requestId: randomUUID(), replyTo: beforePairing.messageId,
    fingerprint: fingerprint({ text: incoming.text, share: incoming.share, replyTo: beforePairing.messageId }) };
  expect(() => a.receivePeer(room, 'b'.repeat(64), privateReply)).toThrow('predates pairing');
  const changed = { ...incoming, text: 'Changed', fingerprint: fingerprint({ text: 'Changed' }) };
  expect(() => a.receivePeer(room, 'b'.repeat(64), changed)).toThrow('different content');
  a.close(); expect(node(db).snapshot().rooms[0].messages.map(m => m.text)).toEqual(['Before pairing', 'Original']);
});

test('paired fixed grants reject owner renames before settings can strand delivery', () => {
  const f = fixture();
  const original = { requestId: randomUUID(), humanName: f.a.settings.humanName, machineName: 'Updated node', startAtLogin: false };
  f.a.completeSetup(original);
  expect(f.a.completeSetup(original)).toEqual({});
  expect(() => f.a.completeSetup({ ...original, requestId: randomUUID(), humanName: 'Renamed owner' })).toThrow('fixed participant grant');
  expect(f.a.settings.humanName).toBe('Test Codex owner');
});

test('offline attachment keeps messages pending and malformed frames cannot create authors or receipts', async () => {
  const f = fixture(); f.a.send({ roomId: f.room, requestId: randomUUID(), text: 'Queued' }); f.state.available = false;
  await f.bridgeA.pump(1); expect(f.bridgeA.status().connected).toBe(false); expect(f.a.pendingDelivery()[0].messages).toHaveLength(1);
  f.state.available = true;
  const message = f.a.pendingDelivery()[0].messages[0], packet = JSON.parse(packets(f.room, message)[0]);
  await f.bridgeB.ingest({ sender: 'c'.repeat(64), data: JSON.stringify(packet) });
  await f.bridgeB.ingest({ sender: f.keyA, data: JSON.stringify({ ...packet, n: 999999 }) });
  await f.bridgeB.ingest({ sender: f.keyA, data: JSON.stringify({ ...packet, hash: 'f'.repeat(64) }) });
  expect(f.b.snapshot().rooms[0].messages).toHaveLength(0); expect(f.inboxA).toHaveLength(0);
  await f.bridgeA.pump(4000); await f.bridgeB.pump(4000); expect(f.b.snapshot().rooms[0].messages).toHaveLength(1);
});

test('canonical hash mismatches are rejected before persistence and receipt', async () => {
  const f = fixture();
  f.a.send({ roomId: f.room, requestId: randomUUID(), text: 'Canonical only' });
  const message = f.a.pendingDelivery()[0].messages[0];
  const forged = { ...message, wireOnly: 'ignored remotely' };
  const data = Buffer.from(JSON.stringify(forged));
  await f.bridgeB.ingest({ sender: f.keyA, data: JSON.stringify({ v: 1, k: 'chunk', room: f.room, id: message.id,
    hash: createHash('sha256').update(data).digest('hex'), i: 0, n: 1, data: data.toString('base64') }) });
  expect(f.b.snapshot().rooms[0].messages).toHaveLength(0);
  expect(f.inboxA).toHaveLength(0);
});

test('v2 catalog migration preserves node identity; invalid stored room grants fail closed', () => {
  const db = database(), before = node(db), identity = before.nodeId; before.close();
  const legacy = JSON.parse(db.data.get(CATALOG)!); legacy.version = 2; db.data.set(CATALOG, JSON.stringify(legacy));
  const migrated = node(db); expect(migrated.nodeId).toBe(identity); expect(JSON.parse(db.data.get(CATALOG)!).version).toBe(3); migrated.close();
  const bad = JSON.parse(db.data.get(CATALOG)!); bad.rooms.push({ id: randomUUID(), peer: { key: 'not a key' } }); db.data.set(CATALOG, JSON.stringify(bad));
  expect(() => node(db)).toThrow('not been reset'); expect(db.data.get(CATALOG)).toBe(JSON.stringify(bad));
});

test('maximum-size unicode text and excerpt are paced below the native queue bound', async () => {
  const f = fixture(), text = '漢'.repeat(4000), share = { title: 'Explicit excerpt', text: '漢'.repeat(8000) };
  f.a.send({ roomId: f.room, requestId: randomUUID(), text, share });
  expect(packets(f.room, f.a.pendingDelivery()[0].messages[0]).length).toBeGreaterThan(64);
  for (let now = 1; now < 6000 && f.a.pendingDelivery()[0].messages.length; now += 250) {
    await f.bridgeA.pump(now); expect(f.inboxB.length).toBeLessThanOrEqual(16); await f.bridgeB.pump(now);
  }
  expect(f.b.snapshot().rooms[0].messages[0].share).toEqual(share);
  expect(f.b.snapshot().rooms[0].messages[0].text).toBe(text);
  expect(f.a.pendingDelivery()[0].messages).toHaveLength(0);
});

function pairedRoom(a: LocalNode, b: LocalNode, keyA: string, keyB: string) {
  const room = randomUUID();
  for (const n of [a, b]) if (!n.settings.completed) n.completeSetup({ requestId: randomUUID(), humanName: 'Peer owner', machineName: 'Peer node', startAtLogin: false });
  a.createRoom({ title: 'Quota test', requestId: room }); b.createRoom({ title: 'Quota test', requestId: room });
  a.pairRoom(b.descriptor(room, keyB), keyA); b.pairRoom(a.descriptor(room, keyA), keyB);
  return room;
}
function fragmented(a: LocalNode, room: string) {
  const sent = a.send({ roomId: room, requestId: randomUUID(), text: 'Fragmented '.repeat(100) });
  return packets(room, a.pendingDelivery().find(r => r.roomId === room)!.messages.find(m => m.id === sent.messageId)!);
}
const chunk = (sender: string, data: string): IncomingPacket => ({ sender, data });

test('peer quota blocks rotating message IDs and hashes while another room receives and acknowledges', async () => {
  const f = fixture(), c = node(), keyC = 'c'.repeat(64), roomC = pairedRoom(c, f.b, keyC, f.keyB);
  const first = JSON.parse(fragmented(f.a, f.room)[0]);
  for (let i = 0; i < 16; i++) await f.bridgeB.ingest(chunk(f.keyA, JSON.stringify({ ...first, id: randomUUID(), hash: i.toString(16).padStart(64, '0') })), 1);
  const frames = fragmented(c, roomC);
  for (const data of [...frames].reverse()) await f.bridgeB.ingest(chunk(keyC, data), 2);
  expect(f.b.snapshot().rooms.find(r => r.id === roomC)!.messages).toHaveLength(1);
  expect(f.inboxA.map(p => JSON.parse(p.data))).toContainEqual(expect.objectContaining({ k: 'ack', room: roomC }));
});

test('peer aggregate quota spans rooms and existing assemblies complete at their room cap', async () => {
  const f = fixture(), room2 = pairedRoom(f.a, f.b, f.keyA, f.keyB), room3 = pairedRoom(f.a, f.b, f.keyA, f.keyB);
  const groups = [fragmented(f.a, f.room), fragmented(f.a, f.room), fragmented(f.a, room2), fragmented(f.a, room2)];
  for (const frames of groups) await f.bridgeB.ingest(chunk(f.keyA, frames[0]), 1);
  const excess = fragmented(f.a, room3);
  for (const data of excess) await f.bridgeB.ingest(chunk(f.keyA, data), 2);
  expect(f.b.snapshot().rooms.find(r => r.id === room3)!.messages).toHaveLength(0);
  await f.bridgeB.ingest(chunk(f.keyA, groups[0][0]), 3); // Duplicate does not allocate another slot.
  for (const data of groups[0].slice(1).reverse()) await f.bridgeB.ingest(chunk(f.keyA, data), 3);
  expect(f.b.snapshot().rooms.find(r => r.id === f.room)!.messages).toHaveLength(1);
  for (const data of excess) await f.bridgeB.ingest(chunk(f.keyA, data), 4);
  expect(f.b.snapshot().rooms.find(r => r.id === room3)!.messages).toHaveLength(1);
});

test('room assembly slots expire at their original deadline despite duplicate chunks, and retries recover', async () => {
  const f = fixture(), held = [fragmented(f.a, f.room), fragmented(f.a, f.room)], retry = fragmented(f.a, f.room);
  for (const frames of held) await f.bridgeB.ingest(chunk(f.keyA, frames[0]), 100);
  for (const data of retry) await f.bridgeB.ingest(chunk(f.keyA, data), 101);
  expect(f.b.snapshot().rooms[0].messages).toHaveLength(0);
  for (const frames of held) await f.bridgeB.ingest(chunk(f.keyA, frames[0]), 30099);
  for (const data of retry) await f.bridgeB.ingest(chunk(f.keyA, data), 30100);
  expect(f.b.snapshot().rooms[0].messages).toHaveLength(1);
  expect(f.inboxA).toHaveLength(1);
});

test('malformed or unpaired chunks allocate no slots; invalid completion releases its room slot', async () => {
  const f = fixture(), frames = fragmented(f.a, f.room), first = JSON.parse(frames[0]);
  for (let i = 0; i < 16; i++) {
    await f.bridgeB.ingest(chunk('c'.repeat(64), JSON.stringify({ ...first, id: randomUUID() })), 1);
    await f.bridgeB.ingest(chunk(f.keyA, JSON.stringify({ ...first, room: randomUUID(), id: randomUUID() })), 1);
    await f.bridgeB.ingest(chunk(f.keyA, JSON.stringify({ ...first, n: 129, id: randomUUID() })), 1);
  }
  const invalid = frames.map(data => JSON.stringify({ ...JSON.parse(data), hash: 'f'.repeat(64) }));
  await f.bridgeB.ingest(chunk(f.keyA, frames[0]), 2);
  await f.bridgeB.ingest(chunk(f.keyA, invalid[0]), 2);
  for (const data of invalid.slice(1)) await f.bridgeB.ingest(chunk(f.keyA, data), 3);
  const next = fragmented(f.a, f.room);
  for (const data of next) await f.bridgeB.ingest(chunk(f.keyA, data), 4);
  for (const data of frames.slice(1)) await f.bridgeB.ingest(chunk(f.keyA, data), 5);
  expect(f.b.snapshot().rooms[0].messages).toHaveLength(2); expect(f.inboxA).toHaveLength(2);
});

test('assembly global backstop remains bounded and acknowledgments bypass a full inbound room quota', async () => {
  const f = fixture(), sources = [{ source: f.a, key: f.keyA, room: f.room }];
  for (let i = 1; i < 9; i++) {
    const source = node(), key = (i + 2).toString(16).repeat(64);
    sources.push({ source, key, room: pairedRoom(source, f.b, key, f.keyB) });
  }
  for (const { source, key, room } of sources.slice(0, 8)) {
    for (let i = 0; i < 2; i++) await f.bridgeB.ingest(chunk(key, fragmented(source, room)[0]), 1);
  }
  const last = sources[8], frames = fragmented(last.source, last.room);
  for (const data of frames) await f.bridgeB.ingest(chunk(last.key, data), 2);
  expect(f.b.snapshot().rooms.find(r => r.id === last.room)!.messages).toHaveLength(0);
  const sent = f.b.send({ roomId: f.room, requestId: randomUUID(), text: 'Outbound delivery at inbound cap' });
  const message = f.b.pendingDelivery().find(r => r.roomId === f.room)!.messages[0];
  const hash = f.a.receivePeer(f.room, f.keyB, message);
  await f.bridgeB.ingest(chunk(f.keyA, JSON.stringify({ v: 1, k: 'ack', room: f.room, id: sent.messageId, hash })), 3);
  expect(f.b.pendingDelivery().find(r => r.roomId === f.room)!.acknowledged).toContain(sent.messageId);
  for (const data of frames) await f.bridgeB.ingest(chunk(last.key, data), 30001);
  expect(f.b.snapshot().rooms.find(r => r.id === last.room)!.messages).toHaveLength(1);
});

function png(width: number, height: number, seed = 0) {
  const bytes = new Uint8Array(64); bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width); new DataView(bytes.buffer).setUint32(20, height); bytes[63] = seed; return bytes;
}
async function exchange(f: ReturnType<typeof fixture>, rounds = 4) {
  for (let i = 0; i < rounds; i++) { await f.bridgeA.pump(10000 + i); await f.bridgeB.pump(10000 + i); }
}

test('a screenshot reaches the paired machine before the message that shows it', async () => {
  const f = fixture();
  const shot = f.a.upload({ roomId: f.room, requestId: randomUUID(), name: 'overlap.png', bytes: png(1440, 900) });
  const sent = f.a.send({ roomId: f.room, requestId: randomUUID(), text: '@Grok header overlaps at 390px', attachments: [shot.id] });
  await f.bridgeA.pump(1);
  // The message waits for the file; nothing but the transfer has left node A.
  expect(f.inboxB).toHaveLength(0); expect(f.filesB).toHaveLength(1);
  expect(f.bridgeA.status().rooms[0]).toMatchObject({ pending: [sent.messageId], sendingFiles: [shot.id], filesStoredRemotely: [] });
  await exchange(f);
  const remote = f.b.snapshot().rooms[0].messages;
  expect(remote.map(m => [m.text, m.attachments])).toEqual([['@Grok header overlaps at 390px', [shot]]]);
  expect(f.b.attachment(f.room, shot.id).bytes).toEqual(png(1440, 900));
  expect(f.a.pendingDelivery()[0]).toMatchObject({ messages: [], acknowledged: [sent.messageId], files: [shot.id] });
  expect(f.bridgeA.status().rooms[0].sendingFiles).toEqual([]);
  // The reply path works the same way in the other direction.
  const reply = f.b.upload({ roomId: f.room, requestId: randomUUID(), name: 'fixed.png', bytes: png(1440, 900, 1) }, f.b.authenticateAgent('Grok'.repeat(16))!);
  f.b.send({ roomId: f.room, requestId: randomUUID(), text: 'Fixed', replyTo: sent.messageId, attachments: [reply.id] }, f.b.authenticateAgent('Grok'.repeat(16))!);
  await exchange(f);
  expect(f.a.snapshot().rooms[0].messages.at(-1)?.attachments).toEqual([reply]);
  expect(f.a.attachment(f.room, reply.id).bytes).toEqual(png(1440, 900, 1));
});

test('failed transfers are retried and a delivered file is never sent twice', async () => {
  const f = fixture(); f.state.failFiles = true;
  const shot = f.a.upload({ roomId: f.room, requestId: randomUUID(), bytes: png(10, 10) });
  f.a.send({ roomId: f.room, requestId: randomUUID(), attachments: [shot.id] });
  await f.bridgeA.pump(1); await f.bridgeA.pump(2);
  expect(f.bridgeA.status().error).toContain('receiver did not respond');
  expect(f.b.snapshot().rooms[0].messages).toHaveLength(0);
  f.state.failFiles = false;
  // The retry waits out its backoff, then succeeds.
  await Bun.sleep(5100);
  await exchange(f);
  expect(f.b.snapshot().rooms[0].messages).toHaveLength(1);
  const offers = f.offered.length;
  await exchange(f); expect(f.offered).toHaveLength(offers);
}, 15000);

test('files from unadmitted senders or forged metadata are dropped without a receipt', async () => {
  const f = fixture();
  const bytes = png(8, 8), sha256 = createHash('sha256').update(bytes).digest('hex');
  const meta = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const agentB = f.b.snapshot(f.b.authenticateAgent('Grok'.repeat(16))!).localParticipantId;
  await f.bridgeA.ingestFile({ id: 'a'.repeat(32), sender: 'c'.repeat(64), sha256, bytes, meta: meta({ v: 1, r: f.room, a: agentB, i: randomUUID(), n: 'x.png' }) });
  await f.bridgeA.ingestFile({ id: 'b'.repeat(32), sender: f.keyB, sha256, bytes, meta: meta({ v: 1, r: f.room, a: f.a.owner.participantId, i: randomUUID(), n: 'x.png' }) });
  await f.bridgeA.ingestFile({ id: 'c'.repeat(32), sender: f.keyB, sha256: 'f'.repeat(64), bytes, meta: meta({ v: 1, r: f.room, a: agentB, i: randomUUID(), n: 'x.png' }) });
  expect(f.inboxB).toHaveLength(0);
  // A message naming an attachment that never arrived is refused, so no receipt is sent for it.
  const shot = f.b.upload({ roomId: f.room, requestId: randomUUID(), bytes }, f.b.authenticateAgent('Grok'.repeat(16))!);
  f.b.setFloor({ roomId: f.room, requestId: randomUUID(), floor: 'open' });
  f.b.send({ roomId: f.room, requestId: randomUUID(), attachments: [shot.id] }, f.b.authenticateAgent('Grok'.repeat(16))!);
  const message = f.b.pendingDelivery()[0].messages[0];
  expect(() => f.a.receivePeer(f.room, f.keyB, message)).toThrow('has not arrived');
  // A forged file claiming the same ID but different bytes is rejected once the real one is stored.
  await exchange(f);
  expect(f.a.snapshot().rooms[0].messages.at(-1)?.attachments?.[0].id).toBe(shot.id);
  const other = png(8, 8, 9);
  expect(() => f.a.receivePeerFile(f.room, f.keyB, { authorId: agentB, id: shot.id, name: 'x.png', hash: createHash('sha256').update(other).digest('hex') }, other)).toThrow('different file');
});

test('without MeshGuard transfers, messages with attachments wait and say why', async () => {
  const f = fixture(); f.state.files = false;
  const shot = f.a.upload({ roomId: f.room, requestId: randomUUID(), bytes: png(4, 4) });
  f.a.send({ roomId: f.room, requestId: randomUUID(), text: 'With file', attachments: [shot.id] });
  await f.bridgeA.pump(1);
  expect(f.bridgeA.status().error).toContain('cannot transfer files');
  expect(f.inboxB).toHaveLength(0);
});
