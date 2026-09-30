import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createHandler } from './http';
import { LocalNode } from './node';
import { NodeAccess } from './access';
import { testStartupManager } from './startup';
import type { PeerBridge } from './peer-bridge';
import { tokenHash } from './model';

function app(options: { bridge?: PeerBridge; localPeerKey?: string } = {}) {
  const values = new Map<string, string>();
  const node = new LocalNode({ read: key => values.get(key) ?? null, write: (key, value) => { values.set(key, value); }, close() {} });
  const token = 'test-control-token-32-bytes-minimum-length';
  const handle = createHandler({ node, origins: ['http://127.0.0.1:4318'], distDir: 'dist', dataDir: 'test-store', access: new NodeAccess(token, node),
    startup: testStartupManager(), runtime: { apiVersion: 2, instanceId: 'test-instance', pid: process.pid }, proof: () => 'test-proof', ...options });
  const headers = { Authorization: ['Bearer', token].join(' ') };
  const get = (path: string, extra: Record<string, string> = {}) => handle(new Request(`http://127.0.0.1:4318/api/node/${path}`, { headers: { ...headers, ...extra } }));
  const send = (path: string, body: unknown, extra: Record<string, string> = {}) => handle(new Request(`http://127.0.0.1:4318/api/node/${path}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) }));
  return { node, handle, get, send, headers };
}

test('HTTP rooms and history are explicit and cross-site commands cannot create rooms', async () => {
  const { handle, send, headers } = app();
  expect((await send('rooms', { title: 'No', requestId: randomUUID() }, { Origin: 'https://other.example' })).status).toBe(403);
  expect((await handle(new Request('http://127.0.0.1:4318/api/node/snapshot', { headers: { Host: 'rebinding.example:4318' } }))).status).toBe(403);
  const a = await (await send('rooms', { title: 'A', requestId: randomUUID() })).json();
  const b = await (await send('rooms', { title: 'B', requestId: randomUUID() })).json();
  const command = { roomId: a.roomId, text: 'Only A', requestId: randomUUID() };
  const sent = await (await send('messages', command)).json();
  expect(await (await send('messages', command)).json()).toEqual(sent);
  expect((await send('messages', { roomId: b.roomId, text: 'Invalid reply', requestId: randomUUID(), replyTo: sent.messageId })).status).toBe(400);
  const snapshot = await (await handle(new Request('http://127.0.0.1:4318/api/node/snapshot', { headers }))).json();
  expect(snapshot.rooms.map((room: any) => room.messages.map((message: any) => message.text))).toEqual([['Only A'], []]);
});

test('SSE subscribes to the node; aborting a view preserves room state', async () => {
  const { node, handle, send, headers } = app();
  const abort = new AbortController();
  const response = await handle(new Request('http://127.0.0.1:4318/api/node/events?view=test', { signal: abort.signal, headers }));
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('"rooms":[]');
  await send('rooms', { title: 'Persistent ownership', requestId: randomUUID() });
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('Persistent ownership');
  abort.abort(); await reader.cancel();
  expect(node.snapshot().rooms).toHaveLength(1);
});

test('transport endpoints require owner auth and explicit attachment', async () => {
  const { node, handle, get, send } = app();
  const roomId = node.createRoom({ title: 'Pairable', requestId: randomUUID() }).roomId;
  expect((await handle(new Request('http://127.0.0.1:4318/api/node/transport'))).status).toBe(401);
  expect(await (await get('transport')).json()).toEqual({ enabled: false });
  expect((await get(`rooms/descriptor?roomId=${roomId}`)).status).toBe(409);
  expect((await send('rooms/pair', { version: 1, roomId, peerKey: 'b'.repeat(64), participants: [] })).status).toBe(409);
});

test('transport endpoints expose descriptors and pair rooms through the request handler', async () => {
  const bridge = { status: () => ({ connected: true, error: undefined, rooms: [] }) } as unknown as PeerBridge;
  const local = app({ bridge, localPeerKey: 'a'.repeat(64) });
  const remote = new LocalNode({ read: () => null, write() {}, close() {} });
  const roomId = randomUUID();
  try {
    local.node.completeSetup({ requestId: randomUUID(), humanName: 'Local owner', machineName: 'Local machine', startAtLogin: false });
    remote.completeSetup({ requestId: randomUUID(), humanName: 'Remote owner', machineName: 'Remote machine', startAtLogin: false });
    local.node.createRoom({ title: 'Pairable', requestId: roomId });
    remote.createRoom({ title: 'Pairable', requestId: roomId });
    expect(await (await local.get('transport')).json()).toMatchObject({ enabled: true, connected: true, rooms: [] });
    expect(await (await local.get(`rooms/descriptor?roomId=${roomId}`)).json()).toEqual(local.node.descriptor(roomId, 'a'.repeat(64)));
    expect((await local.send('rooms/pair', remote.descriptor(roomId, 'b'.repeat(64)))).status).toBe(200);
    expect(local.node.snapshot().rooms[0]?.paired).toBe(true);
    const blocked = app({ bridge, localPeerKey: 'c'.repeat(64) });
    try {
      blocked.node.createRoom({ title: 'Blocked', requestId: roomId });
      expect((await blocked.send('rooms/pair', remote.descriptor(roomId, 'b'.repeat(64)))).status).toBe(409);
    } finally { blocked.node.close(); }
  } finally { local.node.close(); remote.close(); }
});

function viewFixture() {
  const local = app(), responses: Response[] = [];
  const agent = () => {
    const token = randomUUID(), room = randomUUID();
    local.node.prepareRoom({ requestId: room, title: room, agentName: 'Agent', credentialHash: tokenHash(token) });
    local.node.completeSetup({ requestId: randomUUID(), intentId: room, humanName: 'Owner', machineName: 'Node', startAtLogin: false });
    return { token, room };
  };
  const open = async (view: string, token?: string, signal?: AbortSignal, cookie?: string) => {
    const headers = cookie ? { Cookie: cookie } : token ? { Authorization: `Bearer ${token}` } : local.headers;
    const response = await local.handle(new Request(`http://127.0.0.1:4318/api/node/events?view=${view}`, { headers, signal }));
    responses.push(response); return response;
  };
  const close = async () => { for (const response of responses) await response.body?.cancel(); local.node.close(); };
  return { ...local, agent, open, close };
}

test('SSE quotas isolate room agents and duplicate views without blocking owner or another room', async () => {
  const f = viewFixture(), a = f.agent(), b = f.agent();
  try {
    expect((await f.open('first', a.token)).status).toBe(200);
    expect((await f.open('first', a.token)).status).toBe(429);
    expect((await f.open('second', a.token)).status).toBe(200);
    for (let i = 0; i < 16; i++) expect((await f.open(`rotating-${i}`, a.token)).status).toBe(429);
    const other = await f.open('first', b.token), owner = await f.open('first');
    expect(other.status).toBe(200); expect(owner.status).toBe(200);
    const reader = other.body!.getReader();
    const snapshot = new TextDecoder().decode((await reader.read()).value);
    reader.releaseLock();
    expect(snapshot).toContain(b.room); expect(snapshot).not.toContain(a.room);
  } finally { await f.close(); }
});

test('SSE cleanup releases exactly once for abort, cancel and already-aborted requests', async () => {
  const f = viewFixture(), a = f.agent(), abort = new AbortController();
  try {
    const first = await f.open('first', a.token, abort.signal);
    const second = await f.open('second', a.token);
    expect((await f.open('third', a.token)).status).toBe(429);
    abort.abort(); await first.body!.cancel();
    expect((await f.open('first', a.token)).status).toBe(200);
    expect((await f.open('third', a.token)).status).toBe(429);
    await second.body!.cancel();
    const aborted = new AbortController(); aborted.abort();
    expect((await f.open('already-aborted', a.token, aborted.signal)).status).toBe(200);
    expect((await f.open('replacement', a.token)).status).toBe(200);
    expect((await f.open('excess', a.token)).status).toBe(429);
    expect(f.node.snapshot().rooms[0].participants.find(p => p.role === 'agent')?.connected).toBe(true);
  } finally { await f.close(); }
  expect(f.node.snapshot().rooms[0].participants.find(p => p.role === 'agent')?.connected).toBe(false);
});

test('SSE reserves four owner slots and retains the sixteen-view global backstop', async () => {
  const f = viewFixture();
  try {
    for (let i = 0; i < 6; i++) {
      const a = f.agent();
      expect((await f.open('a', a.token)).status).toBe(200);
      expect((await f.open('b', a.token)).status).toBe(200);
    }
    const seventh = f.agent(); expect((await f.open('waiting', seventh.token)).status).toBe(429);
    for (let i = 0; i < 4; i++) expect((await f.open(`owner-${i}`)).status).toBe(200);
    expect((await f.open('overflow')).status).toBe(429);
  } finally { await f.close(); }
});

test('owner cookies and bearer tokens share view accounting and ordinary multi-tab access', async () => {
  const f = viewFixture();
  try {
    const { ticket } = await (await f.send('control/browser', {})).json();
    const session = await f.send('session', { ticket });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    expect((await f.open('tab')).status).toBe(200);
    expect((await f.open('tab', undefined, undefined, cookie)).status).toBe(429);
    for (let i = 1; i < 16; i++) expect((await f.open(`tab-${i}`, undefined, undefined, cookie)).status).toBe(200);
    expect((await f.open('overflow')).status).toBe(429);
  } finally { await f.close(); }
});
