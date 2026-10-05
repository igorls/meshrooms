import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EventFeed, LOCAL_API_FILE, LOCAL_PAGE_FLAG, LocalAccess, MAX_PENDING_TICKETS, MAX_SESSIONS, MAX_WAITERS, MAX_WAITERS_PER_TOKEN, PAGE_CSP, SESSION_IDLE_MS, SESSION_TTL_MS, TICKET_TTL_MS, helloProof, localApiHandler, localControlToken, readLocalApi,
  requestBrowserLink, startLocalApi,
} from './local-api';
import { MAX_PAGE, MAX_PENDING_UPLOAD_BYTES, initPerson, messagePage, personAgent, personIdentity, recordPersonRoom, uploadAllowed } from './person';
import { MAX_PENDING_ATTACHMENTS } from '../src/attachments';
import type { AttachmentRef } from '../src/browser/files';
import { PERSON_STATUS_FILE, personStatusOf } from './browser-agent';
import { testDirectory } from './test-directory';
import { BrowserLobby } from './browser/lobby';
import { browserHandler } from './browser/http';
import { mintInvite } from './browser/invites';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const roomId = crypto.randomUUID(), me = crypto.randomUUID(), alex = crypto.randomUUID(), wren = crypto.randomUUID();
const isUs = (pid: number) => pid === process.pid;

/** A person who joined one room, with its runner's files written as a runner would: members, presence, history. */
async function personWithRoom() {
  const dir = testDirectory('local-api');
  cleanups.push(dir.cleanup);
  const home = join(dir.path, 'person'), daemon = join(dir.path, 'daemon');
  await initPerson(home);
  const agent = recordPersonRoom({ roomId, origin: 'http://127.0.0.1:1', kind: 'person', name: 'Robin', joinedAt: 1_000 }, home);
  writeFileSync(join(agent.dir, 'members.json'), JSON.stringify({ memberId: me, ownerId: alex, title: 'Design review', members: [
    { id: alex, name: 'Alex', role: 'human' }, { id: me, name: 'Robin', role: 'human' }, { id: wren, name: 'Wren', role: 'agent', operatorId: alex }],
    devices: [{ id: 'a'.repeat(64), memberId: alex, online: true }, { id: 'b'.repeat(64), memberId: me, online: true }, { id: 'c'.repeat(64), memberId: wren, online: false }] }));
  const message = (memberId: string, text: string, at: number) => ({ packet: { body: { kind: 'message', roomId, id: crypto.randomUUID(), deviceId: 'a'.repeat(64), memberId, text, at }, signature: 'x' }, targets: [], receipts: [] });
  const history = [message(alex, 'Hello Robin', 2_000), message(wren, 'Status: green', 3_000), message(me, 'Thanks', 4_000), message(alex, 'One more', 5_000)];
  writeFileSync(join(agent.dir, 'messages.json'), JSON.stringify(history));
  return { home, daemon, agent, history, message };
}

/** The API on a real loopback port. `as(token)` is what the Meshrooms page sends: its exact Origin and its session token. */
async function served(existing?: Awaited<ReturnType<typeof personWithRoom>>) {
  const room = existing ?? await personWithRoom(), logs: string[] = [];
  const api = startLocalApi({ dir: room.daemon, home: room.home, port: 0, log: line => logs.push(line) });
  cleanups.push(() => api.stop());
  const base = `http://127.0.0.1:${api.port}`, origin = base;
  const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => fetch(`${base}${path}`, init);
  const control = () => ({ Authorization: `Bearer ${localControlToken(readLocalApi(room.daemon)!.secret)}` });
  const as = (token: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, Origin: origin, ...extra });
  const ticket = async () => (await (await call('/api/local/ticket', { method: 'POST', headers: control() })).json() as { ticket: string }).ticket;
  const signIn = async () => {
    const response = await call('/api/local/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: await ticket() }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    return (await response.json() as { token: string }).token;
  };
  return { ...room, api, base, origin, call, control, as, ticket, signIn, logs };
}

test('tickets live 120 s, are spent once and capped while pending; session tokens live 12 h from last use, are revocable and die with the daemon', () => {
  let now = 1_000_000;
  const access = new LocalAccess(undefined, () => now);
  const ticket = access.issueTicket();
  const { token, expiresInSeconds } = access.exchange(ticket);
  expect(token).toMatch(/^[\w-]{43}$/);
  expect(expiresInSeconds).toBe(SESSION_TTL_MS / 1000);
  expect(access.session(token)).toBe(true);
  // Spent: a replay buys nothing.
  expect(() => access.exchange(ticket)).toThrow('already used or has expired');
  // Another daemon start (another secret, other memory) knows nothing of it; a changed token is nothing.
  expect(new LocalAccess(undefined, () => now).session(token)).toBe(false);
  expect(access.session(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'))).toBe(false);
  // In use, it lives on; idle past the TTL, it ends.
  now += SESSION_TTL_MS - 1; expect(access.session(token)).toBe(true);
  now += SESSION_TTL_MS - 1; expect(access.session(token)).toBe(true);
  now += SESSION_TTL_MS + 1; expect(access.session(token)).toBe(false);
  // Revoked: ended at once.
  const other = access.exchange(access.issueTicket()).token;
  expect(access.revoke(other)).toBe(true);
  expect(access.session(other)).toBe(false);
  // A ticket expires after its TTL, even never used.
  const late = access.issueTicket();
  now += TICKET_TTL_MS + 1;
  expect(() => access.exchange(late)).toThrow('already used or has expired');
  expect(() => access.exchange('made-up')).toThrow('already used or has expired');
  // At most MAX_PENDING_TICKETS wait at once; expired ones make room again.
  for (let i = 0; i < MAX_PENDING_TICKETS; i++) access.issueTicket();
  expect(() => access.issueTicket()).toThrow('Too many browser links');
  now += TICKET_TTL_MS + 1;
  expect(access.issueTicket()).toMatch(/^[\w-]{43}$/);
  // The control token comes from the secret, so it changes with every start.
  expect(access.isControl(localControlToken(access.secret))).toBe(true);
  expect(access.isControl(localControlToken(new LocalAccess().secret))).toBe(false);
});

test('the API refuses other hosts, other origins (reads too), missing tokens, control tokens from browsers, and sets no cookie', async () => {
  const { call, origin, as, control, ticket, signIn, api } = await served();
  // DNS rebinding: a request that names another host is refused before anything else.
  expect((await call('/api/local/health', { headers: { Host: 'rebound.example' } })).status).toBe(403);
  expect((await call('/api/local/health', { headers: { Host: `127.0.0.1:${api.port + 1}` } })).status).toBe(403);
  // The page's requests without a token: 401, for every endpoint.
  for (const path of ['/api/local/health', '/api/local/rooms', `/api/local/rooms/${roomId}/messages`, '/api/local/events']) expect((await call(path, { headers: { Origin: origin } })).status).toBe(401);
  // Without an Origin and without a valid token, nothing.
  expect((await call('/api/local/rooms')).status).toBe(401);
  expect((await call('/api/local/rooms', { headers: { Authorization: 'Bearer wrong-but-well-formed-token' } })).status).toBe(401);
  expect((await call('/api/local/rooms', { headers: { Authorization: 'Basic abc' } })).status).toBe(401);
  expect((await call('/api/local/rooms', { headers: control() })).status).toBe(200);
  // The control token from a browser (it sends an Origin, or Fetch Metadata) is refused, and it can't buy tickets that way.
  expect((await call('/api/local/rooms', { headers: { ...control(), Origin: origin } })).status).toBe(403);
  expect((await call('/api/local/rooms', { headers: { ...control(), 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(403);
  expect((await call('/api/local/ticket', { method: 'POST', headers: { Origin: origin } })).status).toBe(401);
  // The ticket exchange: this exact origin, and a real ticket, once.
  const exchange = (headers: Record<string, string>, body: unknown) => call('/api/local/session', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  expect((await exchange({}, { ticket: await ticket() })).status).toBe(403);
  expect((await exchange({ Origin: 'http://evil.example' }, { ticket: await ticket() })).status).toBe(403);
  expect((await exchange({ Origin: `http://127.0.0.1:${api.port + 1}` }, { ticket: await ticket() })).status).toBe(403);
  expect((await exchange({ Origin: origin, 'Sec-Fetch-Site': 'cross-site' }, { ticket: await ticket() })).status).toBe(403);
  expect((await exchange({ Origin: origin }, { ticket: 'not-a-ticket' })).status).toBe(401);
  const good = await ticket();
  expect((await exchange({ Origin: origin }, { ticket: good })).status).toBe(200);
  expect((await exchange({ Origin: origin }, { ticket: good })).status).toBe(401);
  // The page's origin is 127.0.0.1, never localhost (which browsers try on ::1 first, where another program may listen).
  expect((await exchange({ Origin: `http://localhost:${api.port}`, Host: `localhost:${api.port}` }, { ticket: await ticket() })).status).toBe(403);
  expect((await exchange({ Origin: `http://[::1]:${api.port}` }, { ticket: await ticket() })).status).toBe(403);
  // The control token is refused from anything that looks like a browser.
  expect((await call('/api/local/rooms', { headers: { ...control(), 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(403);

  const token = await signIn();
  const ok = await call('/api/local/health', { headers: as(token) });
  expect(ok.status).toBe(200);
  // No CORS, ever; a CSP that loads nothing and can't be framed.
  expect(ok.headers.get('access-control-allow-origin')).toBeNull();
  expect(ok.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
  const corsAsk = await call('/api/local/rooms', { method: 'OPTIONS', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'GET' } });
  expect(corsAsk.status).toBe(403);
  expect(corsAsk.headers.get('access-control-allow-origin')).toBeNull();
  // Reads: browsers send no Origin on a same-origin GET, so none is fine from the same origin, and only from there.
  expect((await call('/api/local/rooms', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  expect((await call('/api/local/rooms', { headers: { Authorization: `Bearer ${token}`, 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(200);
  expect((await call('/api/local/rooms', { headers: { Authorization: `Bearer ${token}`, 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
  expect((await call('/api/local/rooms', { headers: { Authorization: `Bearer ${token}`, 'Sec-Fetch-Site': 'same-site' } })).status).toBe(403);
  expect((await call('/api/local/rooms', { headers: { Authorization: `Bearer ${token}`, 'Sec-Fetch-Site': 'none' } })).status).toBe(403);
  expect((await call('/api/local/rooms', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(401);
  // With an Origin, only this exact one.
  expect((await call('/api/local/rooms', { headers: as(token, { Origin: 'http://evil.example' }) })).status).toBe(403);
  expect((await call('/api/local/rooms', { headers: as(token, { Origin: 'null' }) })).status).toBe(403);
  expect((await call('/api/local/rooms', { headers: as(token, { 'Sec-Fetch-Site': 'cross-site' }) })).status).toBe(403);
  const send = (headers: Record<string, string>) => call(`/api/local/rooms/${roomId}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ text: 'hi' }) });
  // Writes need the exact Origin, even from the same origin.
  expect((await send({ Authorization: `Bearer ${token}` })).status).toBe(403);
  expect((await send({ Authorization: `Bearer ${token}`, 'Sec-Fetch-Site': 'same-origin' })).status).toBe(403);
  expect((await send(as(token, { Origin: 'http://evil.example' }))).status).toBe(403);
  expect((await send({ Origin: origin })).status).toBe(401);
  expect((await call(`/api/local/rooms/${roomId}/send`, { method: 'POST', headers: as(token, { 'Content-Type': 'text/plain' }), body: '{"text":"hi"}' })).status).toBe(415);
  // Signing out ends the token.
  expect(await (await call('/api/local/session', { method: 'DELETE', headers: as(token) })).json()).toEqual({ ended: true });
  expect((await call('/api/local/rooms', { headers: as(token) })).status).toBe(401);
});

test('a session token from one daemon start is refused after a restart, and a clean stop removes the endpoint file', async () => {
  const room = await personWithRoom();
  const first = await served(room);
  const token = await first.signIn();
  expect((await first.call('/api/local/rooms', { headers: first.as(token) })).status).toBe(200);
  const secret = readLocalApi(room.daemon)!.secret;
  first.api.stop();
  expect(existsSync(join(room.daemon, LOCAL_API_FILE))).toBe(false);
  const second = await served(room);
  expect(readLocalApi(room.daemon)!.secret).not.toBe(secret);
  expect((await second.call('/api/local/rooms', { headers: second.as(token) })).status).toBe(401);
  expect((await second.call('/api/local/rooms', { headers: { Authorization: `Bearer ${localControlToken(secret)}` } })).status).toBe(401);
});

test('rooms, messages and send: titles, members with presence, unread counts that reading clears, and a queued message', async () => {
  const { call, as, signIn, agent, history } = await served();
  const token = await signIn(), get = async (path: string) => (await call(path, { headers: as(token) })).json() as Promise<any>;
  const { rooms } = await get('/api/local/rooms');
  expect(rooms).toHaveLength(1);
  expect(rooms[0]).toMatchObject({ roomId, title: 'Design review', state: 'joined', kind: 'person', unread: 3, connected: false });
  expect(rooms[0].members).toEqual([
    { id: alex, name: 'Alex', role: 'human', self: false, online: true },
    { id: me, name: 'Robin', role: 'human', self: true, online: true },
    { id: wren, name: 'Wren', role: 'agent', operatorId: alex, self: false, online: false }]);
  // A page of two, oldest first, then the rest after it.
  const first = await get(`/api/local/rooms/${roomId}/messages?limit=2&after=${history[0].packet.body.id}`);
  expect(first.messages.map((m: any) => m.text)).toEqual(['Status: green', 'Thanks']);
  expect(first.messages[1]).toMatchObject({ own: true, author: 'Robin', role: 'human' });
  expect(first.more).toBe(true);
  expect((await get('/api/local/rooms')).rooms[0].unread).toBe(1);
  const latest = await get(`/api/local/rooms/${roomId}/messages?limit=50`);
  expect(latest.messages).toHaveLength(4);
  expect(latest.messages[0]).not.toHaveProperty('signature');
  expect((await get('/api/local/rooms')).rooms[0].unread).toBe(0);
  expect((await call(`/api/local/rooms/${roomId}/messages?limit=500`, { headers: as(token) })).status).toBe(400);
  expect((await call(`/api/local/rooms/${crypto.randomUUID()}/messages`, { headers: as(token) })).status).toBe(404);

  const send = (body: unknown) => call(`/api/local/rooms/${roomId}/send`, { method: 'POST', headers: as(token, { 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  const requestId = crypto.randomUUID();
  const queued = await send({ text: '  On it  ', replyTo: history[0].packet.body.id, requestId });
  expect(queued.status).toBe(202);
  expect(await queued.json()).toEqual({ messageId: requestId, status: 'queued' });
  // A retry queues nothing twice.
  expect((await send({ text: 'On it', replyTo: history[0].packet.body.id, requestId })).status).toBe(202);
  const outbox = readdirSync(join(agent.dir, 'outbox')).filter(f => f.endsWith('.json'));
  expect(outbox).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(agent.dir, 'outbox', outbox[0]), 'utf8'))).toEqual({ id: requestId, text: 'On it', replyTo: history[0].packet.body.id });
  expect((await send({ text: '' })).status).toBe(400);
  expect((await send({ text: 'x'.repeat(4001) })).status).toBe(400);
  expect((await send({ text: 'hi', replyTo: crypto.randomUUID() })).status).toBe(400);
  expect((await send({ text: 'hi', requestId: 'not-a-uuid' })).status).toBe(400);
});

test('the page\'s room: its view without secrets, the read position, changes the runner signs, uploads, and only the host actions a page may ask for', async () => {
  const { call, as, signIn, agent, history } = await served();
  const token = await signIn(), get = async (path: string) => (await call(path, { headers: as(token) })).json() as Promise<any>;
  const post = (path: string, body: unknown) => call(`/api/local/rooms/${roomId}/${path}`, { method: 'POST', headers: as(token, { 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  // The runner's status, as it keeps it: no signals, no ICE servers (TURN credentials), devices online instead of sessions.
  writeFileSync(join(agent.dir, PERSON_STATUS_FILE), JSON.stringify(personStatusOf({ roomId, title: 'Design review', epoch: 'e1', hostOnline: true, deviceId: 'b'.repeat(64), memberId: me, ownerId: alex,
    members: [{ id: alex, name: 'Alex' }, { id: me, name: 'Robin' }], devices: [{ id: 'a'.repeat(64), publicKey: 'k', label: 'Desktop', memberId: alex, admittedAt: 1, session: crypto.randomUUID() }],
    signals: [{ seq: 1, from: 'a'.repeat(64), session: 's', targetSession: 't', description: { type: 'offer', sdp: 'v=0' } }], iceServers: [{ urls: 'turn:turn.example', username: 'u', credential: 'turn-secret' }] },
    ['a'.repeat(64)], {})));
  const view = await get(`/api/local/rooms/${roomId}/view`);
  expect(view).toMatchObject({ roomId, title: 'Design review', state: 'joined', memberId: me, more: false, read: { at: 1_000 } });
  expect(JSON.stringify(view)).not.toContain('turn-secret');
  expect(view.status).not.toHaveProperty('signals');
  expect(view.status.devices).toEqual([{ id: 'a'.repeat(64), publicKey: 'k', label: 'Desktop', memberId: alex, admittedAt: 1, online: true }]);
  expect(view.status.connected).toEqual(['a'.repeat(64)]);
  expect(view.messages.map((m: any) => m.packet.body.text)).toEqual(['Hello Robin', 'Status: green', 'Thanks', 'One more']);
  expect(view.messages[0].packet).not.toHaveProperty('signature');
  // Older messages a page at a time.
  const older = await get(`/api/local/rooms/${roomId}/view?before=${history[2].packet.body.id}&limit=1`);
  expect(older.messages.map((m: any) => m.packet.body.text)).toEqual(['Status: green']);
  expect(older.more).toBe(true);
  expect((await call(`/api/local/rooms/${roomId}/view?limit=501`, { headers: as(token) })).status).toBe(400);

  // Reading moves the read position to a message the room holds, never back.
  expect((await post('read', { messageId: history[1].packet.body.id })).status).toBe(200);
  expect((await get('/api/local/rooms')).rooms[0]).toMatchObject({ unread: 1, mentions: 0 });
  expect((await get(`/api/local/rooms/${roomId}/view`)).read).toEqual({ id: history[1].packet.body.id, at: 3_000 });
  expect((await post('read', { messageId: crypto.randomUUID() })).status).toBe(404);

  // Changes go to the runner's outbox, checked first; a stand-in runner takes them out unsigned (so they read as dropped).
  const taken: any[] = [];
  const runner = setInterval(() => {
    for (const file of readdirSync(join(agent.dir, 'outbox')).filter(f => f.endsWith('.json'))) {
      taken.push(JSON.parse(readFileSync(join(agent.dir, 'outbox', file), 'utf8'))); rmSync(join(agent.dir, 'outbox', file));
    }
  }, 20);
  try {
    const task = await post('task', { requestId: crypto.randomUUID(), change: { title: 'Fix the header', assigneeId: alex } });
    expect(task.status).toBe(200);
    expect(await task.json()).toMatchObject({ status: 'dropped' });
    expect(taken.at(-1)).toMatchObject({ type: 'task', change: { title: 'Fix the header', assigneeId: alex } });
    expect((await post('task', { change: { title: '' } })).status).toBe(400);
    expect((await post('task', { change: { title: 'x', assigneeId: crypto.randomUUID() } })).status).toBe(400);
    expect((await post('task', { change: { title: 'x', owner: 'me' } })).status).toBe(400);
    expect((await post('task', { taskId: crypto.randomUUID(), change: { status: 'done' } })).status).toBe(404);
    expect((await post('react', { messageId: history[0].packet.body.id, emoji: '👍' })).status).toBe(200);
    expect(taken.at(-1)).toMatchObject({ type: 'reaction', messageId: history[0].packet.body.id, emoji: '👍' });
    expect((await post('react', { messageId: history[0].packet.body.id, emoji: 'nope' })).status).toBe(400);
    expect((await post('react', { messageId: crypto.randomUUID(), emoji: '👍' })).status).toBe(404);
    expect((await post('decision', { action: 'open', question: 'Ship it?', options: ['Yes', 'No'], askAgents: true })).status).toBe(200);
    expect(taken.at(-1)).toMatchObject({ type: 'decision', action: 'open', question: 'Ship it?', options: ['Yes', 'No'], mode: 'choice', askAgents: true });
    expect((await post('decision', { action: 'open', question: 'Ship it?', options: ['Only one'] })).status).toBe(400);
    expect((await post('decision', { action: 'vote', decisionId: crypto.randomUUID(), optionId: 'o1' })).status).toBe(404);

    // A file to attach: raw bytes, kept by hash; the message names it and its reference is made from the stored bytes.
    const upload = (body: BodyInit, type = 'application/octet-stream', name = 'notes.txt') =>
      call(`/api/local/rooms/${roomId}/files?name=${encodeURIComponent(name)}`, { method: 'POST', headers: as(token, { 'Content-Type': type }), body });
    const stored = await upload('hello file');
    expect(stored.status).toBe(200);
    const ref = await stored.json() as { sha256: string; name: string; size: number };
    expect(ref).toMatchObject({ name: 'notes.txt', size: 10 });
    expect(agent.files.has(ref.sha256)).toBe(true);
    expect((await upload('hello', 'text/plain')).status).toBe(415);
    expect((await upload(new Uint8Array(10 * 1024 * 1024 + 1))).status).toBe(413);
    expect((await post('send', { text: '', attachments: [{ sha256: ref.sha256, name: 'renamed.txt' }] })).status).toBe(202);
    for (let i = 0; i < 100 && !taken.at(-1)?.attachments; i++) await Bun.sleep(20);
    expect(taken.at(-1)).toMatchObject({ text: '', attachments: [{ name: 'renamed.txt', sha256: ref.sha256, size: 10, type: 'text/plain' }] });
    expect((await post('send', { text: 'x', attachments: [{ sha256: 'f'.repeat(64), name: 'gone.txt' }] })).status).toBe(409);
    // A file no message names is not served, nor fetched.
    expect((await call(`/api/local/rooms/${roomId}/files/${ref.sha256}`, { headers: as(token) })).status).toBe(404);
    expect((await post(`files/${ref.sha256}/want`, {})).status).toBe(404);
  } finally { clearInterval(runner); }

  // Only the room service actions a page may ask for; the room service decides the rest (unreachable here: 502).
  for (const action of ['create', 'status', 'signal', 'agent-redeem', 'nonsense']) expect((await post('command', { action, payload: {} })).status).toBe(400);
  expect((await post('command', { action: 'settings', payload: [] })).status).toBe(400);
  expect((await post('command', { action: 'settings', payload: { floor: 'open' } })).status).toBe(502);
  expect((await call(`/api/local/rooms/${roomId}/avatars/${alex}?h=../x`, { headers: as(token) })).status).toBe(400);
});

/** A stand-in room service on loopback for the person's rooms: avatars as `avatars` says, and every command it is sent. */
async function fakeService(avatars: Record<string, () => Response>) {
  const commands: any[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    const url = new URL(request.url);
    if (url.pathname === '/api/lobby' && request.method === 'POST') { commands.push(await request.json()); return Response.json({ roomId: 'ok' }); }
    const avatar = /\/avatars\/([a-f0-9-]{36})$/.exec(url.pathname);
    return avatar && avatars[avatar[1]] ? avatars[avatar[1]]() : new Response('no', { status: 404 });
  } });
  cleanups.push(() => server.stop(true));
  return { origin: `http://127.0.0.1:${server.port}`, commands };
}
/** A served person with one room on `origin` (see personWithRoom), admitted unless `admitted` is false. */
async function servedOn(origin: string, admitted = true) {
  const room = await personWithRoom();
  const agent = recordPersonRoom({ roomId, origin, kind: 'person', name: 'Robin', joinedAt: 1_000 }, room.home);
  if (!admitted) writeFileSync(join(agent.dir, 'members.json'), JSON.stringify({ members: [], devices: [] }));
  const api = await served({ ...room, agent });
  return { ...api, token: await api.signIn() };
}

test('avatars come from the room service only as small pictures: no redirect, no other type, no stream past 16 KB', async () => {
  const png = new Uint8Array(200); png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let cancelled = false;
  const [good, moved, huge, html, missing] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const service = await fakeService({
    [good]: () => new Response(png, { headers: { 'Content-Type': 'image/png' } }),
    [moved]: () => new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:1/api/lobby/rooms/${roomId}/avatars/${good}?h=abcdef12` } }),
    // Chunked (no length), and it would go on for a megabyte: the reader stops past 16 KB and cancels it.
    [huge]: () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(4096)); if (cancelled) controller.close(); },
      cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'image/png' } }),
    [html]: () => new Response('<script>alert(1)</script>', { headers: { 'Content-Type': 'text/html' } }),
  });
  const { call, as, token } = await servedOn(service.origin);
  const avatar = (member: string) => call(`/api/local/rooms/${roomId}/avatars/${member}?h=abcdef12`, { headers: as(token) });
  const ok = await avatar(good);
  expect(ok.status).toBe(200);
  expect(ok.headers.get('content-type')).toBe('image/png');
  expect(ok.headers.get('cache-control')).toBe('no-store');
  expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
  expect(new Uint8Array(await ok.arrayBuffer())).toEqual(png);
  expect((await avatar(moved)).status).toBe(502);
  expect((await avatar(huge)).status).toBe(502);
  // The service hears of the cancel once the connection closes, a moment after the answer.
  for (let i = 0; i < 100 && !cancelled; i++) await Bun.sleep(20);
  expect(cancelled).toBe(true);
  expect((await avatar(html)).status).toBe(404);
  expect((await avatar(missing)).status).toBe(404);
  expect((await call(`/api/local/rooms/${roomId}/avatars/${good}?h=nothex`, { headers: as(token) })).status).toBe(400);
});

test('files are served never to render: nosniff, a sandbox policy, and anything but a verified raster image as a download', async () => {
  const { call, as, signIn, agent } = await served(), token = await signIn();
  const upload = async (name: string, content: string | Uint8Array) => (await (await call(`/api/local/rooms/${roomId}/files?name=${name}`,
    { method: 'POST', headers: as(token, { 'Content-Type': 'application/octet-stream' }), body: content as BodyInit })).json()) as AttachmentRef;
  const png = new Uint8Array(64); png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);
  const refs = [await upload('page.html', '<!doctype html><script>alert(1)</script>'), await upload('drawing.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), await upload('dot.png', png)];
  // A message names them, as the runner stores one.
  const messages = JSON.parse(readFileSync(join(agent.dir, 'messages.json'), 'utf8'));
  messages.push({ packet: { body: { kind: 'message', roomId, id: crypto.randomUUID(), deviceId: 'a'.repeat(64), memberId: alex, text: 'files', at: 6_000, attachments: refs }, signature: 'x' }, targets: [], receipts: [] });
  writeFileSync(join(agent.dir, 'messages.json'), JSON.stringify(messages));
  for (const ref of refs.slice(0, 2)) {
    const response = await call(`/api/local/rooms/${roomId}/files/${ref.sha256}`, { headers: as(token) });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toBe('attachment');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  const image = await call(`/api/local/rooms/${roomId}/files/${refs[2].sha256}`, { headers: as(token) });
  expect(image.headers.get('content-type')).toBe('image/png');
  expect(image.headers.get('content-disposition')).toBeNull();
  expect(image.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
});

test('uploads: only once admitted and within the pending share, both checked before the body is read', async () => {
  const blocked = await servedOn('http://127.0.0.1:1', false);
  const post = (api: typeof blocked, body: BodyInit, headers: Record<string, string> = {}) => api.call(`/api/local/rooms/${roomId}/files?name=a.txt`,
    { method: 'POST', headers: api.as(api.token, { 'Content-Type': 'application/octet-stream', ...headers }), body });
  expect((await post(blocked, 'not admitted')).status).toBe(409);
  const { agent, ...api } = await servedOn('http://127.0.0.1:1');
  const room = { ...api, agent };
  for (let i = 0; i < MAX_PENDING_ATTACHMENTS; i++) expect((await post(room, `pending ${i}`)).status).toBe(200);
  // Full: refused before the body is read (so even a file already stored, whose hash isn't known yet).
  expect((await post(room, 'one too many')).status).toBe(429);
  expect((await post(room, 'pending 0')).status).toBe(429);
  // A message naming one frees its place; a declared size past the bytes' budget is refused unread.
  const named = readdirSync(join(agent.dir, 'files'))[0];
  const messages = JSON.parse(readFileSync(join(agent.dir, 'messages.json'), 'utf8'));
  messages.push({ packet: { body: { kind: 'message', roomId, id: crypto.randomUUID(), deviceId: 'a'.repeat(64), memberId: me, text: 'x', at: 6_000,
    attachments: [{ id: crypto.randomUUID(), name: 'a.txt', type: 'text/plain', size: 9, sha256: named }] }, signature: 'x' }, targets: [], receipts: [] });
  writeFileSync(join(agent.dir, 'messages.json'), JSON.stringify(messages));
  expect((await post(room, 'fits now')).status).toBe(200);
  for (const name of readdirSync(join(agent.dir, 'files')).filter(n => n !== named)) rmSync(join(agent.dir, 'files', name));
  expect(MAX_PENDING_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
  expect(() => uploadAllowed(agent, MAX_PENDING_UPLOAD_BYTES + 1)).toThrow('Too many files are waiting');
  expect(() => uploadAllowed(agent, MAX_PENDING_UPLOAD_BYTES - 64)).not.toThrow();
});

test('a command the page asks for is signed for the room in its path, by the person, and a request always says it comes from the app', async () => {
  const service = await fakeService({});
  const { call, as, token, home } = await servedOn(service.origin);
  const command = (action: string, payload: Record<string, unknown>) => call(`/api/local/rooms/${roomId}/command`,
    { method: 'POST', headers: as(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ action, payload }) });
  const elsewhere = crypto.randomUUID();
  expect((await command('settings', { floor: 'open', roomId: elsewhere })).status).toBe(200);
  expect((await command('request', { kind: 'person', name: 'Robin', label: 'Totally not the app' })).status).toBe(200);
  const [settings, request] = service.commands;
  const identity = personIdentity(home)!;
  for (const signed of [settings, request]) {
    expect(signed.command.roomId).toBe(roomId);
    expect(signed.command.origin).toBe(service.origin);
    expect(signed.publicKey).toBe(identity.publicKey);
  }
  expect(settings.command).toMatchObject({ action: 'settings', payload: { floor: 'open', roomId: elsewhere } });
  expect(request.command).toMatchObject({ action: 'request', payload: { kind: 'person', name: 'Robin', label: 'Meshrooms app' } });
});

test('the events long poll reports new messages and member changes in order, and a stale cursor resets', async () => {
  const { call, as, signIn, agent, history, message, api } = await served();
  const token = await signIn(), get = async (path: string) => (await call(path, { headers: as(token) })).json() as Promise<any>;
  const start = await get('/api/local/events');
  expect(start.events).toEqual([]);
  // Nothing new: the wait ends empty, with the same cursor.
  expect(await get(`/api/local/events?after=${start.cursor}&wait=0`)).toEqual({ cursor: start.cursor, events: [] });
  const waiting = get(`/api/local/events?after=${start.cursor}&wait=20`);
  await Bun.sleep(50);
  const added = message(alex, 'Are you there?', 6_000);
  writeFileSync(join(agent.dir, 'messages.json'), JSON.stringify([...history, added]));
  api.feed.poll();
  const answer = await waiting;
  expect(answer.events).toHaveLength(1);
  expect(answer.events[0]).toMatchObject({ type: 'message', roomId, message: { id: added.packet.body.id, text: 'Are you there?', author: 'Alex' } });
  // Wren comes online: a members event.
  const members = JSON.parse(readFileSync(join(agent.dir, 'members.json'), 'utf8'));
  members.devices[2].online = true;
  writeFileSync(join(agent.dir, 'members.json'), JSON.stringify(members));
  api.feed.poll();
  const next = await get(`/api/local/events?after=${answer.cursor}&wait=5`);
  expect(next.events).toHaveLength(1);
  expect(next.events[0]).toMatchObject({ type: 'members', roomId, state: 'joined' });
  expect(next.events[0].members.find((m: any) => m.id === wren).online).toBe(true);
  // A cursor from another daemon, or from the future, means read everything again.
  expect(await get(`/api/local/events?after=deadbeef.1&wait=0`)).toMatchObject({ reset: true });
  expect(await get(`/api/local/events?after=${api.feed.epoch}.99999&wait=0`)).toMatchObject({ reset: true });
  expect((await call('/api/local/events?after=nonsense', { headers: as(token) })).status).toBe(400);
  expect((await call(`/api/local/events?after=${answer.cursor}&wait=31`, { headers: as(token) })).status).toBe(400);
});

test('the feed takes a baseline first and keeps only the last thousand events', async () => {
  const { home, agent, history, message } = await personWithRoom();
  const feed = new EventFeed(home);
  feed.poll();
  const cursor = feed.cursor;
  feed.poll();
  expect(feed.cursor).toBe(cursor);
  const more = Array.from({ length: 1_005 }, (_, i) => message(alex, `burst ${i}`, 10_000 + i));
  writeFileSync(join(agent.dir, 'messages.json'), JSON.stringify([...history, ...more]));
  feed.poll();
  expect((await feed.since(cursor, 0)).reset).toBe(true);
});

test('person open proves the daemon before it sends anything: the hello challenge, its port, and its pid', async () => {
  const { daemon, api } = await served();
  const record = readLocalApi(daemon)!;
  expect(record).toMatchObject({ port: api.port, pid: process.pid, url: `http://127.0.0.1:${api.port}` });
  if (process.platform !== 'win32') expect((await Bun.file(join(daemon, LOCAL_API_FILE)).stat()).mode & 0o077).toBe(0);
  const link = await requestBrowserLink(daemon, isUs);
  expect(link.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${api.port}/#access=[\\w-]{43}$`));
  // The real server's proof is bound to its port and the nonce.
  const nonce = 'n'.repeat(24);
  const hello = await (await fetch(`http://127.0.0.1:${api.port}/api/local/hello?nonce=${nonce}`)).json() as { proof: string; pid: number };
  expect(hello).toEqual({ proof: helloProof(record.secret, api.port, nonce), pid: process.pid });
  expect(hello.proof).not.toBe(helloProof(record.secret, api.port + 1, nonce));
  // A pid that isn't the daemon: nothing is asked at all.
  await expect(requestBrowserLink(daemon, () => false)).rejects.toThrow('not running');

  // A squatter on the endpoint's port (the daemon died and something else took it, or the file is stale): it answers the
  // challenge wrongly, or not at all, and is never sent the control token or anything else.
  const seen: { path: string; authorization: string | null }[] = [];
  const squatter = (answer: (url: URL) => Response) => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => { const url = new URL(request.url); seen.push({ path: url.pathname, authorization: request.headers.get('authorization') }); return answer(url); } });
    cleanups.push(() => server.stop(true));
    return server.port!;
  };
  const pointAt = (port: number, pid = process.pid) => writeFileSync(join(daemon, LOCAL_API_FILE), JSON.stringify({ ...record, port, pid }));
  for (const answer of [
    () => Response.json({ proof: 'x'.repeat(43), pid: process.pid }), // a wrong HMAC
    (url: URL) => Response.json({ proof: helloProof('another daemon secret, 32 characters long', Number(url.port), url.searchParams.get('nonce')!), pid: process.pid }),
    () => new Response('not json'),
    () => new Response(null, { status: 404 }),
  ]) {
    pointAt(squatter(answer));
    await expect(requestBrowserLink(daemon, isUs)).rejects.toThrow('Something other than Meshrooms answers');
  }
  // A relay to the real daemon from another port: the proof is for the real daemon's port, so it doesn't pass.
  pointAt(squatter(url => Response.json(helloProofRelay(record.secret, api.port, url.searchParams.get('nonce')!))));
  await expect(requestBrowserLink(daemon, isUs)).rejects.toThrow('Something other than Meshrooms answers');
  // The right proof from another pid than the file names is refused too.
  pointAt(api.port, process.pid + 1);
  await expect(requestBrowserLink(daemon, () => true)).rejects.toThrow('Something other than Meshrooms answers');
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every(request => request.path === '/api/local/hello' && request.authorization === null)).toBe(true);
  // A port nobody answers on.
  pointAt(1);
  await expect(requestBrowserLink(daemon, isUs)).rejects.toThrow('Something other than Meshrooms answers');
});
const helloProofRelay = (secret: string, port: number, nonce: string) => ({ proof: helloProof(secret, port, nonce), pid: process.pid });

test('the preferred port falls back to a free one when another program holds it, and says so', async () => {
  const { home, daemon } = await personWithRoom();
  const taken = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('taken') });
  cleanups.push(() => taken.stop(true));
  const logs: string[] = [];
  const api = startLocalApi({ dir: daemon, home, port: taken.port, log: line => logs.push(line) });
  cleanups.push(() => api.stop());
  expect(api.port).not.toBe(taken.port);
  expect(logs.some(line => line.includes(`port ${taken.port} is taken`))).toBe(true);
  expect(readLocalApi(daemon)).toMatchObject({ port: api.port, preferred: taken.port });
  // Openers follow the endpoint file, so the program on the preferred port is never asked anything.
  expect((await requestBrowserLink(daemon, isUs)).url).toStartWith(`http://127.0.0.1:${api.port}/`);
});

test('pages come only from the built UI folder, under the page CSP; without one there is no page', async () => {
  const { home, daemon } = await personWithRoom();
  const access = new LocalAccess(), feed = new EventFeed(home), port = 4999;
  // The handler sees the path as given: %2f and %5c survive URL parsing, so its own decoding is what is tested.
  const page = (handler: ReturnType<typeof localApiHandler>, path: string) => handler(new Request(`http://127.0.0.1:${port}${path}`, { headers: { Host: `127.0.0.1:${port}` } }));
  expect((await page(localApiHandler({ access, port, feed, home }), '/')).status).toBe(404);
  const dist = join(daemon, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Meshrooms</title>');
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(daemon, 'secret.txt'), 'not for pages');
  const handler = localApiHandler({ access, port, feed, home, distDir: dist });
  const index = await page(handler, '/');
  expect(index.status).toBe(200);
  expect(index.headers.get('content-security-policy')).toBe(PAGE_CSP);
  expect(index.headers.get('set-cookie')).toBeNull();
  expect((await page(handler, '/assets/app.js')).status).toBe(200);
  expect(new URL(`http://127.0.0.1:${port}/assets/..%2f..%2fsecret.txt`).pathname).toBe('/assets/..%2f..%2fsecret.txt');
  // Only built assets by name: no escapes, no traversal, nothing else in the folder.
  for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/%2e%2e/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt', '/..%2fsecret.txt', '/..%5csecret.txt',
    '/assets/..%5c..%5csecret.txt', '/missing.js', '/%E0%A4%A', '/assets/%00app.js']) expect((await page(handler, path)).status).toBe(404);
  // The page's routes are index.html, marked as the local page.
  for (const path of ['/', '/rooms', `/r/${roomId}`]) {
    const html = await page(handler, path);
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toStartWith('text/html');
    expect(await html.text()).toContain(LOCAL_PAGE_FLAG);
  }
  mkdirSync(join(dist, 'agent'), { recursive: true });
  writeFileSync(join(dist, 'agent', 'meshrooms-agent.js'), 'bridge');
  writeFileSync(join(dist, 'notes.txt'), 'not an asset');
  for (const path of ['/agent/meshrooms-agent.js', '/notes.txt', '/index.html', '/r/not-a-room', '/rooms/x', '/assets/%zz', '/assets/']) expect((await page(handler, path)).status).toBe(404);
  expect((await handler(new Request(`http://127.0.0.1:${port}/assets/app.js`, { method: 'POST', headers: { Host: `127.0.0.1:${port}` } }))).status).toBe(405);
});

test('a release serves its verified UI from memory only: listed files, never the disk', async () => {
  const { home } = await personWithRoom();
  const access = new LocalAccess(), feed = new EventFeed(home), port = 4998;
  const uiFiles = new Map([['index.html', new TextEncoder().encode('<!doctype html><html><head><title>Meshrooms</title></head></html>')], ['assets/index-abc.js', new TextEncoder().encode('console.log(1)')]]);
  const handler = localApiHandler({ access, port, feed, home, uiFiles });
  const page = (path: string) => handler(new Request(`http://127.0.0.1:${port}${path}`, { headers: { Host: `127.0.0.1:${port}` } }));
  for (const path of ['/', '/rooms', `/r/${roomId}`]) {
    const html = await page(path);
    expect(html.status).toBe(200);
    expect(html.headers.get('content-security-policy')).toBe(PAGE_CSP);
    expect(await html.text()).toContain(LOCAL_PAGE_FLAG);
  }
  const script = await page('/assets/index-abc.js');
  expect(script.status).toBe(200);
  expect(script.headers.get('content-type')).toStartWith('text/javascript');
  expect(await script.text()).toBe('console.log(1)');
  for (const path of ['/assets/other.js', '/index.html', '/assets/..%2findex.html', '/notes.txt']) expect((await page(path)).status).toBe(404);
});

test('a person room the list doesn\'t name is not served', async () => {
  const { call, as, signIn, home } = await served();
  const token = await signIn();
  // A folder planted beside the listed ones is not a room of the person's.
  const stray = personAgent(crypto.randomUUID(), home, 'http://127.0.0.1:1');
  writeFileSync(join(stray.dir, 'room.json'), JSON.stringify({ origin: 'http://127.0.0.1:1', roomId: stray.roomId, person: true }));
  expect((await call(`/api/local/rooms/${stray.roomId}/messages`, { headers: as(token) })).status).toBe(404);
  expect(((await (await call('/api/local/rooms', { headers: as(token) })).json()) as any).rooms).toHaveLength(1);
});

test('a local API whose endpoint file can\'t be written closes again rather than listen where nobody finds it', async () => {
  const { home, daemon } = await personWithRoom();
  writeFileSync(daemon, 'a file where the daemon folder should be');
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') }), port = probe.port!;
  probe.stop(true);
  expect(() => startLocalApi({ dir: daemon, home, port, log: () => {} })).toThrow();
  // The port is free again: the server was stopped.
  const again = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('') });
  again.stop(true);
});

test('a full session table refuses new sign-ins rather than drop a page in use; only long-idle sessions make room', () => {
  let now = 1_000_000;
  const access = new LocalAccess(undefined, () => now);
  const tokens = Array.from({ length: MAX_SESSIONS }, () => access.exchange(access.issueTicket()).token);
  // A burst of redemptions (a control-token holder, a loop) can't push anyone out: the new one is refused, its ticket kept.
  const ticket = access.issueTicket();
  expect(() => access.exchange(ticket)).toThrow('Too many browsers');
  expect(tokens.every(token => access.session(token))).toBe(true);
  // One signs out: the kept ticket now works.
  access.revoke(tokens[0]);
  expect(access.exchange(ticket).token).toMatch(/^[\w-]{43}$/);
  // Long after, only the page still in use is fresh; the idle ones may make room, the page never does.
  now += SESSION_IDLE_MS - 1;
  const page = tokens[1];
  expect(access.session(page)).toBe(true);
  now += 2;
  for (let i = 0; i < MAX_SESSIONS - 1; i++) access.exchange(access.issueTicket());
  expect(access.session(page)).toBe(true);
  // Now every session is fresh: refused again.
  expect(() => access.exchange(access.issueTicket())).toThrow('Too many browsers');
  expect(access.session(page)).toBe(true);
});

test('long polls are capped per session token and in all, and over the cap are refused at once, never queued', async () => {
  const { home } = await personWithRoom();
  const feed = new EventFeed(home);
  feed.poll();
  const cursor = feed.cursor, aborts: AbortController[] = [], waits: Promise<unknown>[] = [];
  const wait = (holder: string) => { const abort = new AbortController(); aborts.push(abort); const w = feed.since(cursor, 60_000, abort.signal, holder); waits.push(w.catch(() => {})); return w; };
  try {
    for (let i = 0; i < MAX_WAITERS_PER_TOKEN; i++) void wait('tab-a');
    await expect(wait('tab-a')).rejects.toThrow('Too many open event requests');
    // Another token still gets in: one token can't starve the page.
    for (let holder = 1; feed.waiting < MAX_WAITERS; holder++) for (let i = 0; i < MAX_WAITERS_PER_TOKEN && feed.waiting < MAX_WAITERS; i++) void wait(`tab-${holder}`);
    expect(feed.waiting).toBe(MAX_WAITERS);
    await expect(wait('fresh-tab')).rejects.toThrow('Too many open event requests');
    // A closed request frees its slot at once.
    aborts[0].abort();
    await Bun.sleep(0);
    expect(feed.waiting).toBe(MAX_WAITERS - 1);
    void wait('fresh-tab');
    expect(feed.waiting).toBe(MAX_WAITERS);
  } finally { for (const abort of aborts) abort.abort(); await Promise.all(waits); }
  expect(feed.waiting).toBe(0);
});

test('nothing is read from a request before it passes the checks, and bodies are bounded before and while reading', async () => {
  const { call, origin, as, signIn, base } = await served();
  const big = 'x'.repeat(40_000);
  // Unauthenticated: refused without the body being looked at.
  expect((await call(`/api/local/rooms/${roomId}/send`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: big })).status).toBe(401);
  expect((await call(`/api/local/rooms/${roomId}/send`, { method: 'POST', headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' }, body: big })).status).toBe(403);
  // The ticket exchange reads a body before any token: its declared size is checked first.
  expect((await call('/api/local/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: big }) })).status).toBe(413);
  const token = await signIn();
  expect((await call(`/api/local/rooms/${roomId}/send`, { method: 'POST', headers: as(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ text: big }) })).status).toBe(413);
  // A body sent without a length stops at the limit too.
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < 10; i++) c.enqueue(new TextEncoder().encode('y'.repeat(8_000))); c.close(); } });
  expect((await fetch(`${base}/api/local/rooms/${roomId}/send`, { method: 'POST', headers: as(token, { 'Content-Type': 'application/json' }), body: stream, duplex: 'half' } as RequestInit)).status).toBe(413);
});

test('a read of messages is bounded: limit is capped, after must be a message id, and only the page is shaped', async () => {
  const { agent, message } = await personWithRoom();
  const stored = Array.from({ length: 5_000 }, (_, i) => message(i % 2 ? alex : me, `m${i}`, 10_000 + i));
  writeFileSync(join(agent.dir, 'messages.json'), JSON.stringify(stored));
  expect(() => messagePage(agent, undefined, MAX_PAGE + 1)).toThrow('Use limit');
  expect(() => messagePage(agent, undefined, 0)).toThrow('Use limit');
  expect(() => messagePage(agent, 'x'.repeat(10_000), 10)).toThrow('message id');
  expect(() => messagePage(agent, crypto.randomUUID(), 10)).toThrow('not in this room');
  const started = performance.now();
  const page = messagePage(agent, stored[10].packet.body.id, MAX_PAGE);
  const latest = messagePage(agent, undefined, 3);
  expect(performance.now() - started).toBeLessThan(2_000);
  expect(page.messages).toHaveLength(MAX_PAGE);
  expect(page.messages[0].text).toBe('m11');
  expect(page.more).toBe(true);
  expect(latest.messages.map(m => m.text)).toEqual(['m4997', 'm4998', 'm4999']);
  expect(latest.more).toBe(true);
  expect(messagePage(agent, stored[4_998].packet.body.id, 50)).toMatchObject({ more: false, messages: [expect.objectContaining({ text: 'm4999' })] });
});

test('the page creates a room on the person\'s room service, which says whether it needs an invite code', async () => {
  let handle: ReturnType<typeof browserHandler> | undefined;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request, s) => handle!(request, s.requestIP(request)?.address ?? 'unknown') });
  const service = `http://127.0.0.1:${server.port}`, lobby = new BrowserLobby(':memory:', { origin: service, invites: 'required' });
  handle = browserHandler(lobby, service, '.', { log: () => {} });
  cleanups.push(() => { server.stop(true); lobby.close(); });
  const room = await personWithRoom();
  // The person's room is on this service: new rooms go there too.
  recordPersonRoom({ roomId, origin: service, kind: 'person', name: 'Robin', created: true, joinedAt: 1_000 }, room.home);
  const { call, as, signIn, origin } = await served(room), token = await signIn();
  expect(await (await call('/api/local/service', { headers: as(token) })).json()).toEqual({ origin: service, inviteRequired: true });
  const create = (body: Record<string, unknown>) => call('/api/local/rooms', { method: 'POST', headers: as(token, { 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  // Without a code, the service's reason passes on, so the page asks for one.
  const refused = await create({ title: 'Launch', name: 'Robin' });
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ code: 'invite-required' });
  const { code } = mintInvite((lobby as unknown as { db: Parameters<typeof mintInvite>[0] }).db, { uses: 1, days: 1 });
  // The page can't choose the room service: an origin it names is ignored.
  const id = crypto.randomUUID(), made = await create({ title: 'Launch', name: 'Robin', invite: code, roomId: id, origin: 'https://rooms.example' });
  expect(made.status).toBe(200);
  expect(await made.json()).toMatchObject({ roomId: id, origin: service, state: 'joined' });
  const rooms = await (await call('/api/local/rooms', { headers: as(token) })).json() as { rooms: { roomId: string }[] };
  expect(rooms.rooms.map(r => r.roomId)).toContain(id);
  // The page has no way to pair or unpair: those are the app's (its window, and its control token on the CLI).
  for (const path of ['/api/local/unpair', '/api/local/pair', '/api/local/person/unpair'])
    expect((await call(path, { method: 'POST', headers: as(token, { 'Content-Type': 'application/json' }), body: '{}' })).status).toBe(404);
  // Only the page's own session may: no token, no room.
  expect((await call('/api/local/rooms', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
});
