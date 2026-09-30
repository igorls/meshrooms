import { expect, test } from 'bun:test';
import { CURRENT_AGENT_VERSION, MIN_AGENT_VERSION } from './agent-version';
import { BrowserLobby } from './lobby';
import { addressKey, browserHandler } from './http';
import { browserConfig } from './config';
import { mintInvite } from './invites';
import { client, testOrigin as origin } from './test-client';
import type { Database } from 'bun:sqlite';

const lookup = (handler: ReturnType<typeof browserHandler>, address: string) => handler(new Request(`${origin}/api/lobby/rooms/${crypto.randomUUID()}`), address);

test('SEC-3: IPv6 clients are keyed by their /64; IPv4 and IPv4-mapped addresses stay per address', () => {
  expect(addressKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
  expect(addressKey('2001:0db8:0001:0002::1')).toBe('2001:db8:1:2::/64');
  expect(addressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
  expect(addressKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  expect(addressKey('::1')).toBe('0:0:0:0::/64');
  expect(addressKey('::ffff:192.0.2.7')).toBe('192.0.2.7');
  expect(addressKey('192.0.2.7')).toBe('192.0.2.7');
  expect(addressKey('unknown')).toBe('unknown');
});

test('SEC-3: one /64 shares a quota, over the proxy header too', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  const handler = browserHandler(lobby, origin, '.', { apiLimit: 2, trustLoopbackProxy: true, log: () => {} });
  try {
    const viaProxy = (ip: string) => handler(new Request(`${origin}/api/lobby/rooms/${crypto.randomUUID()}`, { headers: { 'x-real-ip': ip } }), '127.0.0.1');
    expect((await viaProxy('2001:db8:1:2::1')).status).toBe(404);
    expect((await viaProxy('2001:db8:1:2::ffff')).status).toBe(404);
    expect((await viaProxy('2001:db8:1:2:1:2:3:4')).status).toBe(429);
    expect((await viaProxy('2001:db8:1:3::1')).status).toBe(404); // the next /64 is someone else
  } finally { lobby.close(); }
});

test('SEC-3: a full rate table makes room for new addresses instead of refusing them', async () => {
  let now = 0;
  const lobby = new BrowserLobby(':memory:', { origin });
  const handler = browserHandler(lobby, origin, '.', { apiLimit: 1, now: () => now, log: () => {} });
  try {
    expect((await lookup(handler, '198.51.100.1')).status).toBe(404);
    expect((await lookup(handler, '198.51.100.1')).status).toBe(429);
    // 4096 other addresses within the same minute fill the table.
    for (let i = 0; i < 4096; i++) { now++; expect((await lookup(handler, `198.18.${(i >> 8) & 255}.${i & 255}`)).status).toBe(404); }
    // A new address is still served; the oldest entry made room for it.
    expect((await lookup(handler, '203.0.113.9')).status).toBe(404);
    expect((await lookup(handler, '203.0.113.9')).status).toBe(429);
    // Expired entries are dropped as time passes.
    now += 60_000;
    expect((await lookup(handler, '198.18.0.0')).status).toBe(404);
  } finally { lobby.close(); }
});

test('OPS-1: one JSON line per command and per 5xx, never with payloads, keys, codes, SDP or addresses', async () => {
  const lines: string[] = [];
  const lobby = new BrowserLobby(':memory:', { origin, invites: 'required' });
  const handler = browserHandler(lobby, origin, '.', { log: line => lines.push(line) });
  try {
    const { code } = mintInvite((lobby as unknown as { db: Database }).db, { uses: 1, days: 1 });
    const host = await client(lobby), room = crypto.randomUUID();
    const post = async (body: unknown) => handler(new Request(`${origin}/api/lobby`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }), '198.51.100.23');
    const create = await host.signed('create', room, { title: 'Secret plans', name: 'Alex Private', label: 'Desktop', invite: code });
    expect((await post(create)).status).toBe(200);
    const status = await host.signed('status', room, { session: host.session });
    expect((await post(status)).status).toBe(200);
    const sdp = 'v=0 o=- 4611731400430051336 2 IN IP4 198.51.100.23';
    const signal = await host.signed('signal', room, { to: 'x', session: host.session, targetSession: host.session, description: { type: 'offer', sdp } });
    expect((await post(signal)).status).toBe(403);
    expect((await post({ command: { action: 'drop tables' } })).status).toBe(400);

    const events = lines.map(line => JSON.parse(line));
    // Successful status polls are not logged; everything else is, once.
    expect(events.map(e => [e.event, e.action, e.status])).toEqual([['lobby', 'create', 200], ['lobby', 'signal', 403], ['lobby', 'unknown', 400]]);
    for (const e of events) { expect(e.request).toMatch(/^[a-f0-9-]{8}$/); expect(typeof e.ms).toBe('number'); expect(Date.parse(e.time)).not.toBeNaN(); }
    const all = lines.join('\n');
    for (const secret of [code, code.replaceAll('-', ''), 'Secret plans', 'Alex Private', create.publicKey, create.signature, sdp, '198.51.100.23', room, 'drop tables']) expect(all).not.toContain(secret);

    // An unexpected failure: logged with its message and stack, answered with a request id and nothing more.
    lines.length = 0;
    const broken = browserHandler({ ...lobby, inviteRequired: false, execute: async () => { throw new Error('disk I/O error'); } } as unknown as BrowserLobby, origin, '.', { log: line => lines.push(line) });
    const response = await broken(new Request(`${origin}/api/lobby`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(status) }), '198.51.100.23');
    expect(response.status).toBe(500);
    const answer = await response.json();
    expect(answer.error).not.toContain('disk'); expect(answer.requestId).toMatch(/^[a-f0-9-]{8}$/);
    const logged = lines.map(line => JSON.parse(line));
    expect(logged.find(e => e.event === 'error')).toMatchObject({ status: 500, request: answer.requestId, route: '/api/lobby', message: 'disk I/O error' });
    expect(logged.find(e => e.event === 'error').stack).toContain('disk I/O error');
    expect(logged.find(e => e.event === 'lobby')).toMatchObject({ action: 'status', status: 500, request: answer.requestId });
    expect(lines.join('\n')).not.toContain(status.signature);
  } finally { lobby.close(); }
});

test('OPS-1: tabs still polling a closed room do not write a log line per poll', async () => {
  const lines: string[] = [];
  const lobby = new BrowserLobby(':memory:', { origin });
  const handler = browserHandler(lobby, origin, '.', { log: line => lines.push(line) });
  try {
    const host = await client(lobby), room = crypto.randomUUID();
    const post = async (body: unknown) => handler(new Request(`${origin}/api/lobby`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }), '198.51.100.23');
    expect((await post(await host.signed('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' }))).status).toBe(200);
    expect((await post(await host.signed('close', room))).status).toBe(200);
    lines.length = 0;
    for (let i = 0; i < 5; i++) expect((await post(await host.signed('status', room, { session: host.session }))).status).toBe(410);
    expect(lines).toEqual([]);
    // Other commands on a closed room are still logged.
    expect((await post(await host.signed('request', room, { name: 'Sam', label: 'Laptop', kind: 'person' }))).status).toBe(410);
    expect(lines.map(line => JSON.parse(line)).map(e => [e.action, e.status])).toEqual([['request', 410]]);
  } finally { lobby.close(); }
});

test('SEC-3: retrying a create that already succeeded is not charged against the hourly create limit', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  const handler = browserHandler(lobby, origin, '.', { createLimit: 1, log: () => {} });
  try {
    const host = await client(lobby);
    const post = async (body: unknown) => handler(new Request(`${origin}/api/lobby`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }), '198.51.100.23');
    const create = await host.signed('create', crypto.randomUUID(), { title: 'Work', name: 'Alex', label: 'Desktop' });
    for (let i = 0; i < 3; i++) expect((await post(create)).status).toBe(200);
    // A new create is charged, as is a forged "retry" from another key under the same id.
    expect((await post(await host.signed('create', crypto.randomUUID(), { title: 'Two', name: 'Alex', label: 'Desktop' }))).status).toBe(429);
    const other = await client(lobby);
    const forged = { ...(await other.signed('create', crypto.randomUUID(), {})), command: create.command };
    expect((await post(forged)).status).toBe(429);
  } finally { lobby.close(); }
});

test('OPS-3: health reads the database, answers 503 when it cannot, and is never rate limited', async () => {
  const lines: string[] = [];
  const lobby = new BrowserLobby(':memory:', { origin });
  const handler = browserHandler(lobby, origin, '.', { apiLimit: 1, revision: 'abc123', log: line => lines.push(line) });
  const health = () => handler(new Request(`${origin}/api/lobby/health`), '198.51.100.1');
  for (let i = 0; i < 3; i++) expect(await (await health()).json()).toEqual({ ok: true, revision: 'abc123', inviteRequired: false, minAgentVersion: MIN_AGENT_VERSION, currentAgentVersion: CURRENT_AGENT_VERSION });
  lobby.close();
  const down = await health();
  expect(down.status).toBe(503);
  expect(await down.json()).toEqual({ ok: false, revision: 'abc123', inviteRequired: false, minAgentVersion: MIN_AGENT_VERSION, currentAgentVersion: CURRENT_AGENT_VERSION });
  expect(JSON.parse(lines[0])).toMatchObject({ event: 'error', status: 503, route: '/api/lobby/health' });
});

test('OPS-12 and configuration: HTTPS needs the trusted proxy; invites default on for HTTPS only; caps are validated', () => {
  expect(() => browserConfig({ MESHROOMS_BROWSER_ORIGIN: 'https://meshrooms.example' })).toThrow('MESHROOMS_TRUST_LOOPBACK_PROXY=1');
  const hosted = browserConfig({ MESHROOMS_BROWSER_ORIGIN: 'https://meshrooms.example', MESHROOMS_TRUST_LOOPBACK_PROXY: '1' });
  expect(hosted).toMatchObject({ invites: 'required', maxRooms: 256, idleDays: 30, trustLoopbackProxy: true });
  expect(browserConfig({ MESHROOMS_BROWSER_ORIGIN: 'https://meshrooms.example', MESHROOMS_TRUST_LOOPBACK_PROXY: '1', MESHROOMS_INVITES: 'off' }).invites).toBe('off');
  const local = browserConfig({});
  expect(local).toMatchObject({ origin: 'http://127.0.0.1:4320', invites: 'off', maxRooms: 256, idleDays: 30 });
  expect(browserConfig({ MESHROOMS_INVITES: 'required', MESHROOMS_MAX_ROOMS: '12', MESHROOMS_ROOM_IDLE_DAYS: '0.5' })).toMatchObject({ invites: 'required', maxRooms: 12, idleDays: 0.5 });
  expect(() => browserConfig({ MESHROOMS_INVITES: 'yes' })).toThrow('"required" or "off"');
  expect(() => browserConfig({ MESHROOMS_MAX_ROOMS: '0' })).toThrow('MESHROOMS_MAX_ROOMS');
  expect(() => browserConfig({ MESHROOMS_MAX_ROOMS: '2.5' })).toThrow('whole number');
  expect(() => browserConfig({ MESHROOMS_ROOM_IDLE_DAYS: '-1' })).toThrow('MESHROOMS_ROOM_IDLE_DAYS');
  expect(() => browserConfig({ MESHROOMS_BROWSER_ORIGIN: 'http://meshrooms.example' })).toThrow('HTTPS origin');
});
