import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CURRENT_AGENT_VERSION, MIN_AGENT_VERSION } from './agent-version';
import { MIN_PROTOCOL_VERSION, PROTOCOL_HEADER, PROTOCOL_VERSION, UPGRADE_REQUIRED } from '../../src/browser/protocol';
import { BrowserLobby } from './lobby';
import { addressKey, browserHandler, RATE_KEYS, wideKey } from './http';
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

test('SEC-3: the /48 around an IPv6 address has a quota of its own, which cycling /64s does not escape or evict', async () => {
  expect(wideKey(addressKey('2001:db8:1:2::9'))).toBe('2001:db8:1::/48');
  expect(wideKey(addressKey('192.0.2.7'))).toBeUndefined();
  expect(wideKey('unknown')).toBeUndefined();
  let now = 0;
  const lobby = new BrowserLobby(':memory:', { origin });
  const handler = browserHandler(lobby, origin, '.', { apiLimit: 1000, rateKeys: 2048, now: () => now, log: () => {} });
  try {
    // 5,000 requests a minute for the /48 (5 times 1,000), each from a different /64 that never reaches its own 1,000.
    // More /64 keys than the table holds (2,048) pass through, and the /48's counter is still there at the end.
    for (let i = 0; i < 5000; i++) expect((await lookup(handler, `2001:db8:1:${i.toString(16)}::1`)).status).toBe(404);
    expect((await lookup(handler, '2001:db8:1:ffff::1')).status).toBe(429);
    expect((await lookup(handler, '2001:db8:2:1::1')).status).toBe(404); // the next /48 is someone else
    now += 60_000;
    expect((await lookup(handler, '2001:db8:1:ffff::1')).status).toBe(404);
  } finally { lobby.close(); }
});

test('default RATE_KEYS is large enough that one IPv6 /48 budget cannot evict other clients', async () => {
  expect(RATE_KEYS).toBe(32_768);
  let now = 0;
  const lobby = new BrowserLobby(':memory:', { origin });
  // Behind Nginx, apiLimit is 1200/min -> one /48 gets 6,000/min across distinct /64s.
  const handler = browserHandler(lobby, origin, '.', { apiLimit: 1200, now: () => now, log: () => {} });
  try {
    // Exhaust an IPv4 client's own quota first.
    for (let i = 0; i < 1200; i++) expect((await lookup(handler, '198.51.100.77')).status).toBe(404);
    expect((await lookup(handler, '198.51.100.77')).status).toBe(429);
    // One /48 burns its entire 6,000-request/min budget across 6,000 distinct /64 subnets.
    for (let i = 0; i < 6000; i++) expect((await lookup(handler, `2001:db8:42:${i.toString(16)}::1`)).status).toBe(404);
    expect((await lookup(handler, '2001:db8:42:ffff::1')).status).toBe(429);
    // The IPv4 client's counter is still tracked (not evicted by the /48 flood).
    expect((await lookup(handler, '198.51.100.77')).status).toBe(429);
  } finally { lobby.close(); }
});

test('SEC-3: a single noisy IPv6 /64 flooding past its own quota cannot exhaust the shared /48 for its neighbours', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  const handler = browserHandler(lobby, origin, '.', { apiLimit: 2, log: () => {} });
  try {
    // One /64 spends its 2 requests, then sends 50 more rejected requests (far past 5 * 2 = 10 for the /48).
    expect((await lookup(handler, '2001:db8:1:a::1')).status).toBe(404);
    expect((await lookup(handler, '2001:db8:1:a::2')).status).toBe(404);
    for (let i = 0; i < 50; i++) expect((await lookup(handler, `2001:db8:1:a::${(i + 10).toString(16)}`)).status).toBe(429);
    // Neighbouring /64s in the same /48 still get their remaining 4 * 2 = 8 requests before the /48 cap is reached.
    for (let subnet = 1; subnet <= 4; subnet++) {
      expect((await lookup(handler, `2001:db8:1:${subnet}::1`)).status).toBe(404);
      expect((await lookup(handler, `2001:db8:1:${subnet}::2`)).status).toBe(404);
    }
    expect((await lookup(handler, '2001:db8:1:99::1')).status).toBe(429);
  } finally { lobby.close(); }
});

test('SEC-3: room creation is bounded per IPv6 /48 across multiple /64s', async () => {
  const lobby = new BrowserLobby(':memory:', { origin, invites: 'off' });
  const handler = browserHandler(lobby, origin, '.', { createLimit: 1, log: () => {} });
  try {
    const post = async (body: unknown, ip: string) => handler(new Request(`${origin}/api/lobby`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }), ip);
    // 4 creations across 4 different /64s reach the /48 limit (4 * 1 = 4).
    for (let i = 1; i <= 4; i++) {
      const host = await client(lobby);
      const body = await host.signed('create', crypto.randomUUID(), { title: `Room ${i}`, name: 'Alex', label: 'Desktop' });
      expect((await post(body, `2001:db8:9:${i}::1`)).status).toBe(200);
    }
    const fifth = await client(lobby);
    expect((await post(await fifth.signed('create', crypto.randomUUID(), { title: 'Blocked', name: 'Alex', label: 'Desktop' }), '2001:db8:9:5::1')).status).toBe(429);
    // A different /48 is unaffected.
    expect((await post(await fifth.signed('create', crypto.randomUUID(), { title: 'Other /48', name: 'Alex', label: 'Desktop' }), '2001:db8:a:1::1')).status).toBe(200);
  } finally { lobby.close(); }
});

test('SEC-3: the agent page counts against the request quota', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  const handler = browserHandler(lobby, origin, '.', { apiLimit: 2, log: () => {} });
  try {
    const page = () => handler(new Request(`${origin}/agent/${crypto.randomUUID()}.md`), '198.51.100.40');
    expect((await page()).status).toBe(404); expect((await page()).status).toBe(404);
    expect((await page()).status).toBe(429);
  } finally { lobby.close(); }
});

test('SEC-3: a full rate table makes room for new addresses instead of refusing them', async () => {
  let now = 0;
  const lobby = new BrowserLobby(':memory:', { origin });
  const handler = browserHandler(lobby, origin, '.', { apiLimit: 1, rateKeys: 256, now: () => now, log: () => {} });
  try {
    expect((await lookup(handler, '198.51.100.1')).status).toBe(404);
    expect((await lookup(handler, '198.51.100.1')).status).toBe(429);
    // 256 other addresses within the same minute fill the table.
    for (let i = 0; i < 256; i++) { now++; expect((await lookup(handler, `198.18.${(i >> 8) & 255}.${i & 255}`)).status).toBe(404); }
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

test('SEC-3: creates that fail authentication do not use up the address\'s hourly creates; authenticated ones do', async () => {
  const lobby = new BrowserLobby(':memory:', { origin, invites: 'required' });
  const handler = browserHandler(lobby, origin, '.', { createLimit: 2, log: () => {} });
  try {
    const host = await client(lobby);
    const post = async (body: unknown) => handler(new Request(`${origin}/api/lobby`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }), '198.51.100.24');
    const create = async (invite: string) => host.signed('create', crypto.randomUUID(), { title: 'Work', name: 'Alex', label: 'Desktop', invite });
    // Anyone at this address can send these; none is counted.
    for (let i = 0; i < 5; i++) {
      expect((await post({ command: { action: 'create' } })).status).toBe(400);
      expect((await post({ ...(await create('x')), signature: 'A'.repeat(88) })).status).toBe(401);
    }
    // A signed create with a wrong invite is refused and counted: two of them use the address's two creates.
    const refused = (await post(await create('AAAA-AAAA-AAAA-AAAA'))).status;
    expect(refused).toBeGreaterThanOrEqual(400); expect([400, 401, 429]).not.toContain(refused);
    expect((await post(await create('BBBB-BBBB-BBBB-BBBB'))).status).toBe(refused);
    const { code } = mintInvite((lobby as unknown as { db: Database }).db, { uses: 1, days: 1 });
    expect((await post(await create(code))).status).toBe(429);
  } finally { lobby.close(); }
});

test('OPS-3: health reads the database, answers 503 when it cannot, and is never rate limited', async () => {
  const lines: string[] = [];
  const lobby = new BrowserLobby(':memory:', { origin });
  const handler = browserHandler(lobby, origin, '.', { apiLimit: 1, revision: 'abc123', log: line => lines.push(line) });
  const health = () => handler(new Request(`${origin}/api/lobby/health`), '198.51.100.1');
  for (let i = 0; i < 3; i++) expect(await (await health()).json()).toEqual({ ok: true, revision: 'abc123', inviteRequired: false, minAgentVersion: MIN_AGENT_VERSION, currentAgentVersion: CURRENT_AGENT_VERSION, protocolVersion: PROTOCOL_VERSION, minProtocolVersion: MIN_PROTOCOL_VERSION });
  lobby.close();
  const down = await health();
  expect(down.status).toBe(503);
  expect(await down.json()).toEqual({ ok: false, revision: 'abc123', inviteRequired: false, minAgentVersion: MIN_AGENT_VERSION, currentAgentVersion: CURRENT_AGENT_VERSION, protocolVersion: PROTOCOL_VERSION, minProtocolVersion: MIN_PROTOCOL_VERSION });
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

test('SEC-3: creates sent at the same time each take a slot, so no more than the hourly limit get through', async () => {
  const lobby = new BrowserLobby(':memory:', { origin, invites: 'off' });
  const handler = browserHandler(lobby, origin, '.', { createLimit: 2, log: () => {} });
  try {
    const post = (body: unknown) => handler(new Request(`${origin}/api/lobby`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }), '198.51.100.31');
    const hosts = await Promise.all(Array.from({ length: 10 }, () => client(lobby)));
    const bodies = await Promise.all(hosts.map(host => host.signed('create', crypto.randomUUID(), { title: 'Work', name: 'Alex', label: 'Desktop' })));
    const statuses = await Promise.all(bodies.map(async body => (await post(body)).status));
    expect(statuses.filter(status => status === 200)).toHaveLength(2);
    expect(statuses.filter(status => status === 429)).toHaveLength(8);
  } finally { lobby.close(); }
});

test('SEC-3: invite codes sent at the same time are bounded by the hourly creates; unsigned creates sent at once never hold one', async () => {
  const lobby = new BrowserLobby(':memory:', { origin, invites: 'required' });
  const handler = browserHandler(lobby, origin, '.', { createLimit: 2, log: () => {} });
  try {
    const post = (body: unknown) => handler(new Request(`${origin}/api/lobby`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }), '198.51.100.32');
    const host = await client(lobby);
    const create = (invite: string) => host.signed('create', crypto.randomUUID(), { title: 'Work', name: 'Alex', label: 'Desktop', invite });
    // Unsigned creates, all at once: none keeps a slot.
    const unsigned = await Promise.all(Array.from({ length: 10 }, async () => (await post({ ...(await create('x')), signature: 'A'.repeat(88) })).status));
    expect(unsigned.every(status => status === 401)).toBe(true);
    // Ten guesses at once: two are checked and refused, the other eight never reach the invite check.
    const guesses = await Promise.all(Array.from({ length: 10 }, async (_, i) => (await post(await create(`AAAA-AAAA-AAAA-${String(i).padStart(4, 'A')}`))).status));
    expect(guesses.filter(status => status === 429)).toHaveLength(8);
    expect(guesses.filter(status => status !== 429).every(status => ![200, 400, 401].includes(status))).toBe(true);
    // Both slots are spent: even a valid invite has to wait for the hour.
    const { code } = mintInvite((lobby as unknown as { db: Database }).db, { uses: 1, days: 1 });
    expect((await post(await create(code))).status).toBe(429);
  } finally { lobby.close(); }
});

test('OPS-11: Coturn example config widens relay capacity to 500 ports and stays aligned with deployment docs and peer deny rules', () => {
  const root = resolve(import.meta.dir, '../..');
  const conf = readFileSync(resolve(root, 'deploy/turnserver.conf.example'), 'utf8');
  const docs = readFileSync(resolve(root, 'docs/browser-deployment.md'), 'utf8');
  const value = (key: string) => {
    const match = new RegExp(`^${key}=(.+)$`, 'm').exec(conf);
    return match?.[1].trim();
  };
  const minPort = Number(value('min-port'));
  const maxPort = Number(value('max-port'));
  const totalQuota = Number(value('total-quota'));
  const userQuota = Number(value('user-quota'));
  const maxBps = Number(value('max-bps'));
  expect(minPort).toBe(49160);
  expect(maxPort).toBe(49659);
  expect(maxPort - minPort + 1).toBe(500);
  expect(totalQuota).toBe(500);
  expect(totalQuota).toBeLessThanOrEqual(maxPort - minPort + 1);
  expect(userQuota).toBe(16);
  expect(maxBps).toBe(1_000_000);
  expect(conf).toMatch(/^no-loopback-peers$/m);
  expect(conf).toMatch(/^denied-peer-ip=SERVER_PUBLIC_IPV4$/m);
  const denied = [...conf.matchAll(/^denied-peer-ip=(.+)$/gm)].map(m => m[1].trim());
  expect(denied).toContain('SERVER_PUBLIC_IPV4');
  expect(denied).toContain('127.0.0.0-127.255.255.255');
  expect(denied).toContain('169.254.0.0-169.254.255.255');
  // Verify RFC1918, CGNAT, and IPv6 ULA/link-local deny rules remain configured.
  const deniedPrefixes = new Set(denied.map(entry => entry.split(/[.:]/)[0]));
  for (const prefix of ['0', '10', '100', '127', '169', '172', '192', '198', '224', 'fc00', 'fe80']) {
    expect(deniedPrefixes.has(prefix)).toBe(true);
  }
  expect(docs).toContain('49160–49659 UDP');
  expect(docs).not.toContain('49160–49259');
});

test('OPS-6: health reports protocol versions and POST /api/lobby answers HTTP 426 when declared protocol is outdated', async () => {
  const lines: string[] = [];
  const lobby = new BrowserLobby(':memory:', { origin, minProtocolVersion: 2 });
  const handler = browserHandler(lobby, origin, '.', { revision: 'rev-ops6', log: line => lines.push(line) });
  try {
    const health = await handler(new Request(`${origin}/api/lobby/health`));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, protocolVersion: PROTOCOL_VERSION, minProtocolVersion: 2, revision: 'rev-ops6' });

    const host = await client(lobby), sam = await client(lobby), room = crypto.randomUUID();
    const post = (body: unknown, proto?: string) => handler(new Request(`${origin}/api/lobby`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...(proto !== undefined ? { [PROTOCOL_HEADER]: proto } : {}) },
      body: JSON.stringify(body),
    }), '198.51.100.55');

    // Clients omitting the header stay accepted for backward compatibility.
    const createBody = await host.signed('create', room, { title: 'Compat', name: 'Alex', label: 'Desktop' });
    expect((await post(createBody)).status).toBe(200);

    // Outdated or invalid protocol headers receive HTTP 426 with UPGRADE_REQUIRED code and version metadata.
    for (const bad of ['1', '0', '-1', '1.5', 'abc', '']) {
      const res = await post(await host.signed('status', room, { session: host.session }), bad);
      expect(res.status).toBe(426);
      expect(await res.json()).toEqual({
        error: 'This page or bridge is outdated. Reload the page or update the agent bridge to continue.',
        code: UPGRADE_REQUIRED,
        minProtocolVersion: 2,
        protocolVersion: PROTOCOL_VERSION,
        revision: 'rev-ops6',
      });
    }

    // Current or newer declared protocol version succeeds, and transfer-host logs its real action name.
    expect((await post(await host.signed('status', room, { session: host.session }), '2')).status).toBe(200);
    expect((await post(await sam.signed('request', room, { name: 'Sam', label: 'Laptop', kind: 'person' }), '2')).status).toBe(200);
    const req = (await host.status(room)).requests![0];
    expect((await post(await host.signed('decide', room, { requestId: req.id, admit: true }), '2')).status).toBe(200);
    const samId = (await sam.status(room)).memberId!;
    lines.length = 0;
    expect((await post(await host.signed('transfer-host', room, { memberId: samId }), '2')).status).toBe(200);
    expect(lines.map(l => JSON.parse(l)).map(e => [e.action, e.status])).toEqual([['transfer-host', 200]]);
  } finally { lobby.close(); }
});
