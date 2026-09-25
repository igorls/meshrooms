import { expect, test } from 'bun:test';
import { base64, browserProtocol, encode, type Command, type RoomStatus } from '../../src/browser/protocol';
import { BrowserLobby } from './lobby';
import { browserHandler } from './http';
import { testDirectory } from '../test-directory';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const origin = 'http://127.0.0.1:4320';

test('proxy quotas isolate real clients and ignore forged forwarding from direct clients', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  let now = Date.now();
  const handler = browserHandler(lobby, origin, '.', { trustLoopbackProxy: true, apiLimit: 2, revision: 'test-revision', now: () => now });
  const health = (ip: string, remote = '127.0.0.1') => handler(new Request(`${origin}/api/lobby/health`, { headers: { 'x-real-ip': ip } }), remote);
  try {
    expect(await (await health('192.0.2.1')).json()).toEqual({ ok: true, revision: 'test-revision' });
    expect((await health('192.0.2.1')).status).toBe(200);
    expect((await health('192.0.2.1')).status).toBe(429);
    expect((await health('192.0.2.2')).status).toBe(200);
    expect((await health('192.0.2.3', '192.0.2.20')).status).toBe(200);
    expect((await health('192.0.2.4', '192.0.2.20')).status).toBe(200);
    expect((await health('192.0.2.5', '192.0.2.20')).status).toBe(429);
    now += 60_000;
    expect((await health('192.0.2.1')).status).toBe(200);
  } finally { lobby.close(); }
});

test('creation quotas leave existing-room access available and bound rooms per host device', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  const handler = browserHandler(lobby, origin, '.', { createLimit: 1 });
  try {
    const host = await client(lobby), room = crypto.randomUUID();
    const send = async (id: string) => handler(new Request(`${origin}/api/lobby`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(await host.signed('create', id, { title: 'QA', name: 'Host', label: 'Browser' })) }), '192.0.2.1');
    expect((await send(room)).status).toBe(200);
    expect((await send(crypto.randomUUID())).status).toBe(429);
    expect((await handler(new Request(`${origin}/api/lobby/rooms/${room}`), '192.0.2.1')).status).toBe(200);
    for (let i = 1; i < 8; i++) await host.send('create', crypto.randomUUID(), { title: 'QA', name: 'Host', label: 'Browser' });
    await expect(host.send('create', crypto.randomUUID(), { title: 'QA', name: 'Host', label: 'Browser' })).rejects.toThrow('eight rooms');
  } finally { lobby.close(); }
});
async function client(lobby: BrowserLobby, clock = () => Date.now()) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = base64(await crypto.subtle.exportKey('raw', keys.publicKey));
  const session = crypto.randomUUID();
  const signed = async (action: Command['action'], roomId: string, payload: Record<string, unknown> = {}) => {
    const command: Command = { protocol: browserProtocol, origin, action, roomId, payload, id: crypto.randomUUID(), at: clock() };
    return { command, publicKey, signature: base64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, encode(command))) };
  };
  const send = async (action: Command['action'], roomId: string, payload = {}) => lobby.execute(await signed(action, roomId, payload));
  return { signed, send, status: async (roomId: string) => await send('status', roomId, { session }) as RoomStatus, session };
}

test('link is only a lobby; only host admission exposes members and allows signaling', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  try {
    const host = await client(lobby), guest = await client(lobby), stranger = await client(lobby);
    const room = crypto.randomUUID();
    await host.send('create', room, { title: 'Review', name: 'Alex', label: 'Desktop' });
    expect(lobby.publicRoom(room)).toEqual({ roomId: room, title: 'Review' });
    expect((await guest.status(room)).members).toBeUndefined();
    await guest.send('request', room, { name: 'Sam', label: 'Laptop', kind: 'person' });
    const request = (await host.status(room)).requests![0];
    await expect(stranger.send('decide', room, { requestId: request.id, admit: true })).rejects.toThrow('Only the host');
    await expect(guest.send('signal', room, {})).rejects.toThrow('admission');
    await host.send('decide', room, { requestId: request.id, admit: true });
    const joined = await guest.status(room);
    expect(joined.members).toHaveLength(2);
    expect(joined.requests).toBeUndefined();
    await expect(host.send('decide', room, { requestId: request.id, admit: true })).rejects.toThrow('no longer waiting');
    expect((await host.status(room)).members).toHaveLength(2);
  } finally { lobby.close(); }
});

test('companion enrollment binds to the approving identity; same display name creates no link', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  try {
    const host = await client(lobby), second = await client(lobby), impostor = await client(lobby);
    const room = crypto.randomUUID();
    await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });
    await impostor.send('request', room, { name: 'Alex', label: 'Other', kind: 'person' });
    await second.send('request', room, { name: 'My device', label: 'Laptop', kind: 'companion' });
    const pending = (await second.status(room)).request!;
    const hostBefore = await host.status(room);
    expect(hostBefore.requests!.find(r => r.id === pending.id)!.code).toBeUndefined();
    await expect(host.send('decide', room, { requestId: pending.id, admit: true })).rejects.toThrow('Confirm this device');
    await expect(impostor.send('link', room, { code: pending.code })).rejects.toThrow('existing device');
    await host.send('link', room, { code: pending.code });
    const h = await host.status(room), s = await second.status(room);
    expect(s.memberId).toBe(h.memberId);
    expect(s.members).toHaveLength(1);
    expect(s.devices).toHaveLength(2);
    expect((await impostor.status(room)).memberId).toBeUndefined();
    await host.send('remove', room, { deviceId: s.deviceId });
    expect((await second.status(room)).memberId).toBeUndefined();
    expect((await host.status(room)).devices).toHaveLength(1);
  } finally { lobby.close(); }
});

test('signed commands resist forgery, replay changes, expiry, and cross-room approvals', async () => {
  let now = Date.now(); const lobby = new BrowserLobby(':memory:', { origin, now: () => now });
  try {
    const host = await client(lobby, () => now), guest = await client(lobby, () => now);
    const a = crypto.randomUUID(), b = crypto.randomUUID();
    const create = await host.signed('create', a, { title: 'A', name: 'Alex', label: 'Desktop' });
    await lobby.execute(create); expect(await lobby.execute(create)).toEqual({ roomId: a });
    await expect(lobby.execute({ ...create, command: { ...create.command, roomId: b } })).rejects.toThrow('authenticated');
    await guest.send('create', b, { title: 'B', name: 'Sam', label: 'Laptop' });
    await guest.send('request', a, { name: 'Sam', label: 'Laptop', kind: 'person' });
    const pending = (await host.status(a)).requests![0];
    await expect(guest.send('decide', a, { requestId: pending.id, admit: true })).rejects.toThrow('Only the host');
    await expect(guest.send('decide', b, { requestId: pending.id, admit: true })).rejects.toThrow('no longer waiting');
    now += 61_000;
    await expect(lobby.execute(create)).rejects.toThrow('expired');
    now += 600_000;
    expect((await guest.status(a)).request?.state).toBe('expired');
  } finally { lobby.close(); }
});

test('admission and request decisions survive coordinator restart', async () => {
  const dir = testDirectory('browser-admission'); const path = join(dir.path, 'state.sqlite');
  let lobby = new BrowserLobby(path, { origin });
  try {
    const host = await client(lobby), guest = await client(lobby), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Persistent', name: 'Alex', label: 'Desktop' });
    await guest.send('request', room, { name: 'Sam', label: 'Laptop', kind: 'person' });
    await host.send('decide', room, { requestId: (await host.status(room)).requests![0].id, admit: true });
    const command = await guest.signed('status', room, { session: guest.session });
    const before = await lobby.execute(command) as RoomStatus;
    lobby.close(); lobby = new BrowserLobby(path, { origin });
    const after = await lobby.execute(command) as RoomStatus;
    expect(after.memberId).toBe(before.memberId); expect(after.devices).toHaveLength(2);
  } finally { lobby.close(); dir.cleanup(); }
});

test('HTTP protects origin, host, body limit, and private files', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  try {
    const handle = browserHandler(lobby, origin, 'dist');
    expect((await handle(new Request(`${origin}/api/lobby`, { method: 'POST', headers: { Origin: 'https://other.example' } }))).status).toBe(403);
    expect((await handle(new Request(`${origin}/rooms`, { headers: { Host: 'other.example' } }))).status).toBe(403);
    expect((await handle(new Request(`${origin}/.local/browser-rooms/admission.sqlite`))).status).toBe(404);
    expect((await handle(new Request(`${origin}/api/lobby`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: ' '.repeat(25_000) }))).status).toBe(413);
  } finally { lobby.close(); }
});

test('companion confirmation by a guest still requires host admission; canceled requests cannot be admitted', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  try {
    const host = await client(lobby), guest = await client(lobby), second = await client(lobby), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });
    await guest.send('request', room, { name: 'Sam', label: 'Laptop', kind: 'person' });
    await host.send('decide', room, { requestId: (await host.status(room)).requests![0].id, admit: true });
    await second.send('request', room, { name: 'Companion', label: 'Tablet', kind: 'companion' });
    const request = (await second.status(room)).request!;
    await guest.send('link', room, { code: request.code });
    expect((await second.status(room)).memberId).toBeUndefined();
    await host.send('decide', room, { requestId: request.id, admit: true });
    expect((await second.status(room)).memberId).toBe((await guest.status(room)).memberId);
    await expect(second.send('remove', room, { deviceId: (await host.status(room)).deviceId })).rejects.toThrow('cannot remove');
    await host.send('remove', room, { deviceId: (await second.status(room)).deviceId });
    await second.send('request', room, { name: 'New request', label: 'Tablet', kind: 'person' });
    const fresh = (await second.status(room)).request!;
    await expect(guest.send('cancel', room, { requestId: fresh.id })).rejects.toThrow('only cancel your own');
    await second.send('cancel', room, { requestId: fresh.id });
    await expect(host.send('decide', room, { requestId: fresh.id, admit: true })).rejects.toThrow('no longer waiting');
  } finally { lobby.close(); }
});

test('signaling is scoped to admitted devices, current sessions and the coordinator epoch', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  try {
    const host = await client(lobby), guest = await client(lobby), room = crypto.randomUUID(), other = crypto.randomUUID();
    await host.send('create', room, { title: 'A', name: 'Alex', label: 'Desktop' });
    await guest.send('create', other, { title: 'B', name: 'Sam', label: 'Laptop' });
    const target = await guest.status(other);
    const h = await host.status(room);
    const payload = { to: target.deviceId, session: host.session, targetSession: guest.session, description: { type: 'offer', sdp: 'test offer' } };
    await expect(host.send('signal', room, payload)).rejects.toThrow('not admitted');
    await guest.send('request', room, { name: 'Sam', label: 'Laptop', kind: 'person' });
    await host.send('decide', room, { requestId: (await host.status(room)).requests![0].id, admit: true });
    await guest.status(room);
    await host.send('signal', room, payload);
    const received = await guest.status(room);
    expect(received.signals).toHaveLength(1);
    expect(received.signals![0].from).toBe(h.deviceId);
    const drained = await guest.send('status', room, { session: guest.session, cursor: received.signals![0].seq, epoch: received.epoch }) as RoomStatus;
    expect(drained.signals).toHaveLength(0);
    const restarted = await guest.send('status', room, { session: guest.session, cursor: 999, epoch: 'previous-process' }) as RoomStatus;
    expect(restarted.signals).toHaveLength(1);
    await host.send('remove', room, { deviceId: target.deviceId });
    await expect(guest.send('signal', room, { ...payload, to: h.deviceId, session: guest.session, targetSession: host.session })).rejects.toThrow('admission');
  } finally { lobby.close(); }
});

async function admitPerson(lobby: BrowserLobby, host: Awaited<ReturnType<typeof client>>, room: string, name: string, clock = () => Date.now()) {
  const person = await client(lobby, clock);
  await person.send('request', room, { name, label: 'Laptop', kind: 'person' });
  await host.send('decide', room, { requestId: (await host.status(room)).requests!.find(r => r.name === name)!.id, admit: true });
  return person;
}

test('a person connects an agent with a one-time link; it joins as its own member they operate', async () => {
  let now = Date.now(); const lobby = new BrowserLobby(':memory:', { origin, now: () => now });
  try {
    const host = await client(lobby, () => now), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });
    const sam = await admitPerson(lobby, host, room, 'Sam', () => now), pat = await admitPerson(lobby, host, room, 'Pat', () => now);
    const stranger = await client(lobby, () => now), agent = await client(lobby, () => now), late = await client(lobby, () => now);
    await expect(stranger.send('agent-invite', room, { name: 'Codex' })).rejects.toThrow('Only people');
    await expect(sam.send('agent-invite', room, { name: 'pat' })).rejects.toThrow('already uses that name');
    // Copilot's review of #5: "agents" is reserved for @agents, for people and agents alike.
    await expect(sam.send('agent-invite', room, { name: 'Agents' })).rejects.toThrow('reserved');
    await expect((await client(lobby)).send('request', room, { name: ' AGENTS ', label: 'Laptop', kind: 'person' })).rejects.toThrow('reserved');
    await expect((await client(lobby)).send('create', crypto.randomUUID(), { title: 'Other', name: 'agents', label: 'Desktop' })).rejects.toThrow('reserved');
    const { token } = await sam.send('agent-invite', room, { name: 'Codex' }) as { token: string };
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(pat.send('agent-invite', room, { name: 'codex' })).rejects.toThrow('already uses that name');
    expect((await sam.status(room)).agentInvites).toEqual([{ name: 'Codex', expiresAt: now + 900_000 }]);
    expect((await pat.status(room)).agentInvites).toBeUndefined();
    await expect(agent.send('agent-redeem', room, { token: token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'), label: 'Windows node' })).rejects.toThrow('already used or has expired');

    const redeem = await agent.signed('agent-redeem', room, { token, label: 'Windows node' });
    expect(await lobby.execute(redeem)).toEqual({ roomId: room });
    expect(await lobby.execute(redeem)).toEqual({ roomId: room }); // an uncertain retry of the same command is safe
    const joined = await agent.status(room), samId = (await sam.status(room)).memberId!;
    expect(joined.members!.find(m => m.id === joined.memberId)).toMatchObject({ name: 'Codex', role: 'agent', operatorId: samId });
    expect(joined.members!.find(m => m.id === samId)!.role).toBe('human');
    expect(joined.members!.find(m => m.id === joined.ownerId)!.role).toBeUndefined(); // members from before agents read as people
    expect((await sam.status(room)).agentInvites).toBeUndefined();
    await expect(late.send('agent-redeem', room, { token, label: 'Other node' })).rejects.toThrow('already used or has expired');

    const { token: stale } = await sam.send('agent-invite', room, { name: 'Grok' }) as { token: string };
    now += 900_001;
    await expect(late.send('agent-redeem', room, { token: stale, label: 'Linux node' })).rejects.toThrow('already used or has expired');

    // Agents cannot invite agents, vouch for devices, admit anyone, or be removed by an unrelated member.
    const tablet = await client(lobby, () => now);
    await tablet.send('request', room, { name: 'Tablet', label: 'Tablet', kind: 'companion' });
    await expect(agent.send('agent-invite', room, { name: 'Helper' })).rejects.toThrow('Only people');
    await expect(agent.send('link', room, { code: (await tablet.status(room)).request!.code })).rejects.toThrow('Only people');
    await expect(agent.send('decide', room, { requestId: (await tablet.status(room)).request!.id, admit: true })).rejects.toThrow('Only the host');
    await expect(pat.send('remove', room, { deviceId: joined.deviceId })).rejects.toThrow('cannot remove');
    await sam.send('remove', room, { deviceId: joined.deviceId });
    expect((await host.status(room)).members!.map(m => m.name)).toEqual(['Alex', 'Sam', 'Pat']);
    expect((await agent.status(room)).memberId).toBeUndefined();
  } finally { lobby.close(); }
});

test('agent links are capped per person, and agents leave with their operator', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  try {
    const host = await client(lobby), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });
    const sam = await admitPerson(lobby, host, room, 'Sam');
    const hostAgent = await client(lobby), samAgent = await client(lobby);
    const { token: vesper } = await host.send('agent-invite', room, { name: 'Vesper' }) as { token: string };
    await hostAgent.send('agent-redeem', room, { token: vesper, label: 'Mac node' });
    const { token: codex } = await sam.send('agent-invite', room, { name: 'Codex' }) as { token: string };
    await samAgent.send('agent-redeem', room, { token: codex, label: 'Windows node' });
    const links: string[] = [];
    for (const name of ['A1', 'A2', 'A3', 'A4']) links.push((await sam.send('agent-invite', room, { name }) as { token: string }).token);
    await expect(sam.send('agent-invite', room, { name: 'A5' })).rejects.toThrow('four unused agent links');
    // Vesper's review: links made while Sam had fewer agents cannot take Sam past four once they are used.
    for (const token of links.slice(0, 3)) await (await client(lobby)).send('agent-redeem', room, { token, label: 'Extra' });
    await expect((await client(lobby)).send('agent-redeem', room, { token: links[3], label: 'Extra' })).rejects.toThrow('already has four agents');
    expect((await host.status(room)).members!.map(m => [m.name, m.role ?? 'human'])).toEqual([['Alex', 'human'], ['Sam', 'human'], ['Vesper', 'agent'], ['Codex', 'agent'],
      ['A1', 'agent'], ['A2', 'agent'], ['A3', 'agent']]);

    // The host removes Sam's only device: Sam's agent and unused links go too; the host's agent stays.
    await host.send('remove', room, { deviceId: (await sam.status(room)).deviceId });
    const after = await host.status(room);
    expect(after.members!.map(m => m.name)).toEqual(['Alex', 'Vesper']);
    expect(after.devices).toHaveLength(2);
    expect((await samAgent.status(room)).memberId).toBeUndefined();
    // Departed devices keep their member's role, so a removed agent's signed votes never pass as a person's.
    const roles = Object.fromEntries(after.formerDevices!.map(d => [d.role, (after.formerDevices!.filter(x => x.role === d.role)).length]));
    expect(roles).toEqual({ human: 1, agent: 4 });
    const again = await client(lobby);
    await expect(again.send('agent-redeem', room, { token: codex, label: 'Windows node' })).rejects.toThrow('already used or has expired');
  } finally { lobby.close(); }
});

test('the agent explainer and bridge are served per room, with a plain room title and the bundle hash', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  const dir = testDirectory('agent-explainer');
  try {
    const host = await client(lobby), room = crypto.randomUUID();
    const bare = browserHandler(lobby, origin, dir.path);
    expect((await bare(new Request(`${origin}/agent/${room}`))).status).toBe(404);
    expect((await bare(new Request(`${origin}/agent/meshrooms-agent.js`))).status).toBe(404);
    await host.send('create', room, { title: 'Work <b>**`', name: 'Alex', label: 'Desktop' });
    expect(await (await bare(new Request(`${origin}/agent/${room}.md`))).text()).toContain('unavailable: the agent bridge is not built');

    mkdirSync(join(dir.path, 'agent'));
    writeFileSync(join(dir.path, 'agent', 'meshrooms-agent.js'), 'console.log(1)');
    writeFileSync(join(dir.path, 'agent', 'meshrooms-agent.js.sha256'), `${'a'.repeat(64)}  meshrooms-agent.js\n`);
    const handle = browserHandler(lobby, origin, dir.path);
    const markdown = await handle(new Request(`${origin}/agent/${room}.md`));
    expect(markdown.headers.get('content-type')).toContain('text/markdown');
    const text = await markdown.text();
    expect(text).toContain(`${origin}/agent/${room}`); expect(text).toContain('a'.repeat(64)); expect(text).toContain('**Work b**'); expect(text).not.toContain('{{');
    const page = await handle(new Request(`${origin}/agent/${room}`));
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    const html = await page.text();
    expect(html).toContain('<pre># Join a Meshrooms room as an agent'); expect(html).not.toContain('<script'); expect(html).toContain('&lt;the link, including #token&gt;');
    const script = await handle(new Request(`${origin}/agent/meshrooms-agent.js`));
    expect(script.headers.get('content-type')).toContain('text/javascript'); expect(await script.text()).toBe('console.log(1)');
    expect(await (await handle(new Request(`${origin}/agent/meshrooms-agent.js.sha256`))).text()).toStartWith('a'.repeat(64));
    expect((await handle(new Request(`${origin}/agent/${room}/../../lobby.ts`))).status).toBe(404);
  } finally { lobby.close(); dir.cleanup(); }
});

test('a member leaves by removing their own device, and their agents leave with them', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  try {
    const host = await client(lobby), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });
    const sam = await admitPerson(lobby, host, room, 'Sam'), agent = await client(lobby);
    const { token } = await sam.send('agent-invite', room, { name: 'Codex' }) as { token: string };
    await agent.send('agent-redeem', room, { token, label: 'Node' });
    await sam.send('remove', room, { deviceId: (await sam.status(room)).deviceId });
    expect((await host.status(room)).members!.map(m => m.name)).toEqual(['Alex']);
    expect((await sam.status(room)).memberId).toBeUndefined();
    expect((await agent.status(room)).memberId).toBeUndefined();
    await expect(host.send('remove', room, { deviceId: (await host.status(room)).deviceId })).rejects.toThrow('at least one host device');
  } finally { lobby.close(); }
});

test('keys of devices that left stay available to members, so their task changes still verify', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  try {
    const host = await client(lobby), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });
    const sam = await admitPerson(lobby, host, room, 'Sam');
    const samStatus = await sam.status(room);
    expect((await host.status(room)).formerDevices).toBeUndefined();
    await sam.send('remove', room, { deviceId: samStatus.deviceId });
    const after = await host.status(room);
    expect(after.formerDevices).toEqual([{ id: samStatus.deviceId, publicKey: samStatus.devices!.find(d => d.id === samStatus.deviceId)!.publicKey, memberId: samStatus.memberId!, role: 'human' }]);
    expect((await sam.status(room)).formerDevices).toBeUndefined(); // not shown outside the room
  } finally { lobby.close(); }
});

test('the host controls room settings, and can require approval for guests’ agents', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  try {
    const host = await client(lobby), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });
    const sam = await admitPerson(lobby, host, room, 'Sam');
    expect((await sam.status(room)).settings).toEqual({ floor: 'humans-first', agentAssignmentsWake: false, guestAgentApproval: false });
    await expect(sam.send('settings', room, { floor: 'open' })).rejects.toThrow('Only the host');
    await expect(host.send('settings', room, { floor: 'loud' })).rejects.toThrow('when agents reply');
    await expect(host.send('settings', room, { guestAgentApproval: 'yes' })).rejects.toThrow('on or off');
    await host.send('settings', room, { guestAgentApproval: true, agentAssignmentsWake: true });
    expect((await sam.status(room)).settings).toEqual({ floor: 'humans-first', agentAssignmentsWake: true, guestAgentApproval: true });

    // A guest's agent waits for the host; the host's own agent joins right away.
    const samAgent = await client(lobby), hostAgent = await client(lobby), orphan = await client(lobby);
    const { token } = await sam.send('agent-invite', room, { name: 'Codex' }) as { token: string };
    await samAgent.send('agent-redeem', room, { token, label: 'Windows node' });
    const waiting = await samAgent.status(room);
    expect(waiting.memberId).toBeUndefined();
    expect(waiting.request).toMatchObject({ kind: 'agent', state: 'pending', name: 'Codex' });
    const request = (await host.status(room)).requests!.find(r => r.kind === 'agent')!;
    expect(request.operatorId).toBe((await sam.status(room)).memberId);
    await host.send('decide', room, { requestId: request.id, admit: true });
    const admitted = await samAgent.status(room);
    expect(admitted.members!.find(m => m.id === admitted.memberId)).toMatchObject({ name: 'Codex', role: 'agent', operatorId: request.operatorId });
    const { token: own } = await host.send('agent-invite', room, { name: 'Vesper' }) as { token: string };
    await hostAgent.send('agent-redeem', room, { token: own, label: 'Mac node' });
    expect((await hostAgent.status(room)).memberId).toBeDefined();

    // A guest's agent still waiting leaves with its operator.
    const { token: late } = await sam.send('agent-invite', room, { name: 'Grok' }) as { token: string };
    await orphan.send('agent-redeem', room, { token: late, label: 'Linux node' });
    expect((await host.status(room)).requests!.some(r => r.name === 'Grok')).toBe(true);
    await host.send('remove', room, { deviceId: (await sam.status(room)).deviceId });
    const after = await host.status(room);
    expect(after.requests!.some(r => r.name === 'Grok')).toBe(false);
    expect(after.members!.map(m => m.name)).toEqual(['Alex', 'Vesper']);
  } finally { lobby.close(); }
});

/** Just enough of a PNG for type and size detection. */
function png(width: number, height: number, extra = 16) {
  const bytes = new Uint8Array(24 + extra);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width); new DataView(bytes.buffer).setUint32(20, height);
  return Buffer.from(bytes).toString('base64');
}

test('members set small pictures for themselves and their agents; the host can only clear them', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  try {
    const handle = browserHandler(lobby, origin, 'dist');
    const host = await client(lobby), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });
    const sam = await admitPerson(lobby, host, room, 'Sam'), agent = await client(lobby);
    const { token } = await sam.send('agent-invite', room, { name: 'Codex' }) as { token: string };
    await agent.send('agent-redeem', room, { token, label: 'Node' });
    const samId = (await sam.status(room)).memberId!, alexId = (await host.status(room)).memberId!, codexId = (await agent.status(room)).memberId!;

    await sam.send('profile', room, { avatar: png(64, 64) });
    const hash = (await host.status(room)).members!.find(m => m.id === samId)!.avatar!;
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
    const picture = await handle(new Request(`${origin}/api/lobby/rooms/${room}/avatars/${samId}?h=${hash}`));
    expect(picture.status).toBe(200);
    expect(picture.headers.get('content-type')).toBe('image/png');
    expect(picture.headers.get('cache-control')).toContain('immutable');
    expect(picture.headers.get('content-security-policy')).toContain('sandbox');
    expect((await handle(new Request(`${origin}/api/lobby/rooms/${room}/avatars/${samId}?h=${'0'.repeat(16)}`))).status).toBe(404);

    const gif = Buffer.from('GIF89a\x10\x00\x10\x00' + '\x00'.repeat(20), 'binary').toString('base64');
    await expect(sam.send('profile', room, { avatar: gif })).rejects.toThrow('PNG, JPEG or WebP');
    await expect(sam.send('profile', room, { avatar: png(300, 300) })).rejects.toThrow('256 by 256');
    await expect(sam.send('profile', room, { avatar: png(64, 64, 17 * 1024) })).rejects.toThrow('16 KB');
    await expect(sam.send('profile', room, { avatar: 'not base64!' })).rejects.toThrow('16 KB');

    await expect(sam.send('profile', room, { avatar: png(32, 32), memberId: alexId })).rejects.toThrow('your own picture');
    await sam.send('profile', room, { avatar: png(32, 32), memberId: codexId });
    expect((await host.status(room)).members!.find(m => m.id === codexId)!.avatar).toMatch(/^[a-f0-9]{16}$/);
    await expect(host.send('profile', room, { avatar: png(32, 32), memberId: samId })).rejects.toThrow('your own picture');
    await host.send('profile', room, { avatar: null, memberId: samId });
    expect((await host.status(room)).members!.find(m => m.id === samId)!.avatar).toBeUndefined();

    // A member's picture leaves with them.
    await sam.send('profile', room, { avatar: png(48, 48) });
    const again = (await host.status(room)).members!.find(m => m.id === samId)!.avatar!;
    await host.send('remove', room, { deviceId: (await sam.status(room)).deviceId });
    expect((await handle(new Request(`${origin}/api/lobby/rooms/${room}/avatars/${samId}?h=${again}`))).status).toBe(404);
  } finally { lobby.close(); }
});

test('agents report their harness and model; only the agent or its operator sets them, and the host can clear them', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  try {
    const host = await client(lobby), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });
    const sam = await admitPerson(lobby, host, room, 'Sam'), agent = await client(lobby);
    const { token } = await sam.send('agent-invite', room, { name: 'Codex' }) as { token: string };
    await agent.send('agent-redeem', room, { token, label: 'Node' });
    const codexId = (await agent.status(room)).memberId!, samId = (await sam.status(room)).memberId!;
    const codex = async () => (await host.status(room)).members!.find(m => m.id === codexId)!;

    await agent.send('profile', room, { harness: ' Codex CLI ', model: 'gpt-5.1-codex' });
    expect(await codex()).toMatchObject({ harness: 'Codex CLI', model: 'gpt-5.1-codex' });
    await sam.send('profile', room, { model: 'o4-mini', memberId: codexId });
    expect(await codex()).toMatchObject({ harness: 'Codex CLI', model: 'o4-mini' });
    // Plain text only: nothing that could render as markup or pose as another line.
    for (const bad of ['<b>x</b>', 'a\nb', '', ' ', 'x'.repeat(49), '**bold**', '`code`']) await expect(agent.send('profile', room, { model: bad })).rejects.toThrow('up to 48');
    await expect(sam.send('profile', room, { harness: 'Claude Code' })).rejects.toThrow('Only agents');
    await expect(host.send('profile', room, { model: 'other', memberId: codexId })).rejects.toThrow('agent or its operator');
    await host.send('profile', room, { harness: null, model: null, memberId: codexId });
    expect(await codex()).not.toHaveProperty('model');
    expect(await codex()).not.toHaveProperty('harness');
    // A picture and the runtime can change together; an empty change is refused.
    await agent.send('profile', room, { avatar: png(32, 32), harness: 'Claude Code' });
    expect(await codex()).toMatchObject({ harness: 'Claude Code', avatar: expect.stringMatching(/^[a-f0-9]{16}$/) });
    await expect(agent.send('profile', room, {})).rejects.toThrow('what to change');
    expect((await host.status(room)).members!.find(m => m.id === samId)).not.toHaveProperty('harness');
  } finally { lobby.close(); }
});
