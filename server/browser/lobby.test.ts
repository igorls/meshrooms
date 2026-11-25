import { expect, test } from 'bun:test';
import { base64, MIN_PROTOCOL_VERSION, PROTOCOL_VERSION, type RoomStatus } from '../../src/browser/protocol';
import { BrowserLobby, DECLINE_COOLDOWN_MS, DEVICES_PER_MEMBER, LINK_FAILURES, LINK_FAILURE_WINDOW, MAX_BLOCKED_DEVICES, MAX_SIGNALS_PER_DEVICE, MAX_SIGNALS_PER_SENDER, PRESENCE_MS, SIGNAL_TTL_MS } from './lobby';
import { browserHandler } from './http';
import { CURRENT_AGENT_VERSION, MIN_AGENT_VERSION } from './agent-version';
import { testDirectory } from '../test-directory';
import { admitPerson, client } from './test-client';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const origin = 'http://127.0.0.1:4320';

test('proxy quotas isolate real clients and ignore forged forwarding from direct clients', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  let now = Date.now();
  const handler = browserHandler(lobby, origin, '.', { trustLoopbackProxy: true, apiLimit: 2, revision: 'test-revision', now: () => now });
  // Any lobby request counts; an unknown room answers 404 until the quota answers 429.
  const health = (ip: string, remote = '127.0.0.1') => handler(new Request(`${origin}/api/lobby/rooms/${crypto.randomUUID()}`, { headers: { 'x-real-ip': ip } }), remote);
  try {
    expect(await (await handler(new Request(`${origin}/api/lobby/health`), '127.0.0.1')).json()).toMatchObject({ ok: true, revision: 'test-revision', minAgentVersion: MIN_AGENT_VERSION });
    expect((await health('192.0.2.1')).status).toBe(404);
    expect((await health('192.0.2.1')).status).toBe(404);
    expect((await health('192.0.2.1')).status).toBe(429);
    expect((await health('192.0.2.2')).status).toBe(404);
    expect((await health('192.0.2.3', '192.0.2.20')).status).toBe(404);
    expect((await health('192.0.2.4', '192.0.2.20')).status).toBe(404);
    expect((await health('192.0.2.5', '192.0.2.20')).status).toBe(429);
    now += 60_000;
    expect((await health('192.0.2.1')).status).toBe(404);
    // The health check is answered before quotas, so a probe never sees 429.
    for (let i = 0; i < 4; i++) expect(await (await handler(new Request(`${origin}/api/lobby/health`, { headers: { 'x-real-ip': '192.0.2.1' } }), '127.0.0.1')).json())
      .toEqual({ ok: true, revision: 'test-revision', inviteRequired: false, minAgentVersion: MIN_AGENT_VERSION, currentAgentVersion: CURRENT_AGENT_VERSION, protocolVersion: PROTOCOL_VERSION, minProtocolVersion: MIN_PROTOCOL_VERSION });
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
    // Linking a companion into one of the eight rooms and removing the host device from it still keeps the host at eight.
    const companion = await client(lobby);
    await companion.send('request', room, { kind: 'companion', name: 'Host', label: 'Desktop' });
    await host.send('link', room, { code: (await companion.status(room)).request!.code });
    await companion.send('remove', room, { deviceId: (await host.status(room)).deviceId });
    await expect(host.send('create', crypto.randomUUID(), { title: 'QA', name: 'Host', label: 'Browser' })).rejects.toThrow('eight rooms');
  } finally { lobby.close(); }
});

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
    // SEC-8: a distinct person cannot join with an existing member's name; a companion request using the same name still creates no link.
    await expect(impostor.send('request', room, { name: 'Alex', label: 'Other', kind: 'person' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('already uses that name') });
    await impostor.send('request', room, { name: 'Alex', label: 'Other', kind: 'companion' });
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

test('a guest confirming their own companion admits it at once; canceled requests cannot be admitted', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  try {
    const host = await client(lobby), guest = await client(lobby), second = await client(lobby), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });
    await guest.send('request', room, { name: 'Sam', label: 'Laptop', kind: 'person' });
    await host.send('decide', room, { requestId: (await host.status(room)).requests![0].id, admit: true });
    await second.send('request', room, { name: 'Companion', label: 'Tablet', kind: 'companion' });
    const request = (await second.status(room)).request!;
    // The host admitted Sam; adding Sam's own devices is Sam's call, so no host decision is needed.
    await guest.send('link', room, { code: request.code });
    expect((await second.status(room)).memberId).toBe((await guest.status(room)).memberId);
    await expect(host.send('decide', room, { requestId: request.id, admit: true })).rejects.toThrow('no longer waiting');
    // Admitted: the code is spent, so nobody can link it again.
    await expect(host.send('link', room, { code: request.code })).rejects.toThrow('not found');
    await expect(second.send('remove', room, { deviceId: (await host.status(room)).deviceId })).rejects.toThrow('cannot remove');
    await host.send('remove', room, { deviceId: (await second.status(room)).deviceId });
    await second.send('request', room, { name: 'New request', label: 'Tablet', kind: 'person' });
    const fresh = (await second.status(room)).request!;
    await expect(guest.send('cancel', room, { requestId: fresh.id })).rejects.toThrow('only cancel your own');
    await second.send('cancel', room, { requestId: fresh.id });
    await expect(host.send('decide', room, { requestId: fresh.id, admit: true })).rejects.toThrow('no longer waiting');
  } finally { lobby.close(); }
});

test('self-link: a companion only ever becomes the linker\'s device; agents, strangers and removed members link nothing', async () => {
  let now = Date.now(); const lobby = new BrowserLobby(':memory:', { origin, now: () => now });
  try {
    const host = await client(lobby, () => now), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });
    const sam = await admitPerson(lobby, host, room, 'Sam', () => now), pat = await admitPerson(lobby, host, room, 'Pat', () => now);
    const samId = (await sam.status(room)).memberId!, patId = (await pat.status(room)).memberId!;
    const companion = async (label: string, extra: Record<string, unknown> = {}) => {
      const device = await client(lobby, () => now);
      await device.send('request', room, { name: 'Companion device', label, kind: 'companion', ...extra });
      return { device, code: (await device.status(room)).request!.code! };
    };
    // A request can't choose whose device it becomes: a member id in its payload is ignored.
    const tablet = await companion('Tablet', { linkedMemberId: samId, memberId: samId });
    expect((await host.status(room)).requests!.find(r => r.device.label === 'Tablet')).not.toHaveProperty('linkedMemberId');
    // Codes are shown only to the device that asked: not to the host, not to other members.
    expect((await host.status(room)).requests!.every(r => r.code === undefined)).toBe(true);
    expect((await sam.status(room)).requests).toBeUndefined();
    // Pat holds Sam's code: linking it makes the device Pat's, never Sam's. The code is the secret.
    await pat.send('link', room, { code: tablet.code });
    expect((await tablet.device.status(room)).memberId).toBe(patId);
    expect((await host.status(room)).members).toHaveLength(3);
    // Spent: the code admits nothing again.
    await expect(sam.send('link', room, { code: tablet.code })).rejects.toThrow('not found or expired');

    // Agents can't link, not even to their own member; nor can a device that is still waiting itself.
    await host.send('settings', room, { guestAgentApproval: false });
    const { token } = await sam.send('agent-invite', room, { name: 'Codex' }) as { token: string };
    const agent = await client(lobby, () => now);
    await agent.send('agent-redeem', room, { token, label: 'Agent node' });
    const phone = await companion('Phone');
    await expect(agent.send('link', room, { code: phone.code })).rejects.toThrow('Only people');
    await expect(phone.device.send('link', room, { code: phone.code })).rejects.toThrow('existing device');
    expect((await phone.device.status(room)).memberId).toBeUndefined();

    // A member the host removed holds no device here, so their old devices can't link anything.
    const kim = await admitPerson(lobby, host, room, 'Kim', () => now);
    await host.send('remove', room, { deviceId: (await kim.status(room)).deviceId });
    await expect(kim.send('link', room, { code: phone.code })).rejects.toThrow('existing device');

    // An expired code admits nothing.
    now += 600_001;
    await expect(sam.send('link', room, { code: phone.code })).rejects.toThrow('not found or expired');
  } finally { lobby.close(); }
});

test('self-link keeps the host in control: per-person and room device caps, removed devices, and an approval setting', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  try {
    const host = await client(lobby), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });
    const sam = await admitPerson(lobby, host, room, 'Sam'), samId = (await sam.status(room)).memberId!;
    const companion = async (label: string) => {
      const device = await client(lobby);
      await device.send('request', room, { name: 'Companion device', label, kind: 'companion' });
      return { device, code: (await device.status(room)).request!.code! };
    };
    // One person holds at most DEVICES_PER_MEMBER devices, so nobody fills the room's 16 alone.
    const own = [];
    for (let i = 1; i < DEVICES_PER_MEMBER; i++) { const c = await companion(`Device ${i}`); await sam.send('link', room, { code: c.code }); own.push(c); }
    expect((await host.status(room)).devices!.filter(d => d.memberId === samId)).toHaveLength(DEVICES_PER_MEMBER);
    const extra = await companion('One too many');
    await expect(sam.send('link', room, { code: extra.code })).rejects.toThrow(`up to ${DEVICES_PER_MEMBER} devices`);
    expect((await extra.device.status(room)).memberId).toBeUndefined();

    // The host removes one of Sam's devices. It can't come back with its old code, and Sam linking its new request
    // only confirms it: a device the host removed waits for the host again.
    const removed = own[0];
    await host.send('remove', room, { deviceId: (await removed.device.status(room)).deviceId });
    await expect(sam.send('link', room, { code: removed.code })).rejects.toThrow('not found or expired');
    await removed.device.send('request', room, { name: 'Companion device', label: 'Back again', kind: 'companion' });
    const again = (await removed.device.status(room)).request!;
    await sam.send('link', room, { code: again.code });
    expect((await removed.device.status(room)).memberId).toBeUndefined();
    await host.send('decide', room, { requestId: again.id, admit: true });
    expect((await removed.device.status(room)).memberId).toBe(samId);

    // With hostApprovesDevices, a person's link only confirms the device; the host admits it.
    await host.send('remove', room, { deviceId: (await own[1].device.status(room)).deviceId });
    await host.send('settings', room, { hostApprovesDevices: true });
    const watch = await companion('Watch');
    await sam.send('link', room, { code: watch.code });
    expect((await watch.device.status(room)).memberId).toBeUndefined();
    await host.send('decide', room, { requestId: (await watch.device.status(room)).request!.id, admit: true });
    expect((await watch.device.status(room)).memberId).toBe(samId);
    await host.send('settings', room, { hostApprovesDevices: false });

    // The room's 16 still holds for self-links: the link fails and admits nothing.
    const people = [sam];
    while ((await host.status(room)).devices!.length < 16) people.push(await admitPerson(lobby, host, room, `Person ${people.length}`));
    const late = await companion('Late');
    await expect(people.at(-1)!.send('link', room, { code: late.code })).rejects.toThrow('device limit');
    expect((await late.device.status(room)).memberId).toBeUndefined();
  } finally { lobby.close(); }
});

test('a linked device whose person left before the host decided is not admitted', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  try {
    const host = await client(lobby), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });
    await host.send('settings', room, { hostApprovesDevices: true });
    const sam = await admitPerson(lobby, host, room, 'Sam');
    const tablet = await client(lobby);
    await tablet.send('request', room, { name: 'Companion device', label: 'Tablet', kind: 'companion' });
    const request = (await tablet.status(room)).request!;
    await sam.send('link', room, { code: request.code });
    // Sam's only device leaves while the linked request waits for the host.
    await host.send('remove', room, { deviceId: (await sam.status(room)).deviceId });
    await expect(host.send('decide', room, { requestId: request.id, admit: true })).rejects.toThrow('no longer in the room');
    expect((await tablet.status(room)).memberId).toBeUndefined();
    expect((await host.status(room)).members!.map(m => m.name)).toEqual(['Alex']);
    // Codes are 64 random bits, as hex.
    expect(request.code).toMatch(/^[a-f0-9]{16}$/);
  } finally { lobby.close(); }
});

test('wrong device codes are limited per device and room, so codes can\'t be guessed', async () => {
  let now = Date.now(); const lobby = new BrowserLobby(':memory:', { origin, now: () => now });
  try {
    const host = await client(lobby, () => now), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });
    const sam = await admitPerson(lobby, host, room, 'Sam', () => now);
    const tablet = await client(lobby, () => now);
    await tablet.send('request', room, { name: 'Companion device', label: 'Tablet', kind: 'companion' });
    const code = (await tablet.status(room)).request!.code!;
    for (let i = 0; i < LINK_FAILURES; i++) await expect(sam.send('link', room, { code: i.toString(16).padStart(16, '0') })).rejects.toThrow('not found');
    // Over the limit, even the right code waits; another person's guesses are their own.
    await expect(sam.send('link', room, { code })).rejects.toThrow('Too many wrong device codes');
    await expect(host.send('link', room, { code: 'not a code' })).rejects.toThrow('not found');
    now += LINK_FAILURE_WINDOW + 1;
    // Past the window it works again (the request itself was refreshed by a new request, as it would have expired).
    await tablet.send('request', room, { name: 'Companion device', label: 'Tablet', kind: 'companion' });
    await sam.send('link', room, { code: (await tablet.status(room)).request!.code });
    expect((await tablet.status(room)).memberId).toBe((await sam.status(room)).memberId);
  } finally { lobby.close(); }
});

test('queued connection offers are bounded across all rooms, and the bound frees on expiry or room close without waiting for a poll', async () => {
  let now = Date.now();
  const lobby = new BrowserLobby(':memory:', { origin, now: () => now, maxSignalChars: 2500 });
  try {
    const host = await client(lobby, () => now), room = crypto.randomUUID(), other = crypto.randomUUID();
    await host.send('create', room, { title: 'A', name: 'Alex', label: 'Desktop' });
    const guest = await admitPerson(lobby, host, room, 'Sam', () => now);
    const second = await admitPerson(lobby, host, room, 'Pat', () => now);
    const h = await host.status(room), g = await guest.status(room);
    await second.status(room);
    const send = (from: typeof host, type: 'offer' | 'answer', sdp: string) =>
      from.send('signal', room, { to: g.deviceId, session: from.session, targetSession: guest.session, description: { type, sdp, extra: 'x'.repeat(5000) } });
    await send(host, 'offer', 'a'.repeat(1000));
    await send(second, 'offer', 'b'.repeat(1000));
    // The third would pass 2,500 characters held; fields other than type and sdp are never kept or counted.
    await expect(send(host, 'answer', 'c'.repeat(1000))).rejects.toMatchObject({ status: 429, message: expect.stringContaining('busy') });
    await send(host, 'answer', 'd'.repeat(400));
    expect((await guest.status(room)).signals!.map(s => Object.keys(s.description).sort())).toEqual([['sdp', 'type'], ['sdp', 'type'], ['sdp', 'type']]);
    // Refresh presence at +15s while offers from t=0 are still active, then cross the 30s offer TTL while presence is
    // still live: the next signal recounts and accepts without needing another status poll first.
    now += 15_000;
    await host.status(room); await guest.status(room);
    now += 16_000;
    await send(host, 'offer', 'e'.repeat(2000));
    // Closing the room that holds the queued offers also frees the global budget immediately for another room's signal.
    await host.send('create', other, { title: 'B', name: 'Alex', label: 'Desktop' });
    const peer = await admitPerson(lobby, host, other, 'Pat', () => now);
    await host.status(other); const p = await peer.status(other);
    const otherOffer = (sdp: string) => host.send('signal', other, { to: p.deviceId, session: host.session, targetSession: peer.session, description: { type: 'offer', sdp } });
    await expect(otherOffer('f'.repeat(1000))).rejects.toMatchObject({ status: 429, message: expect.stringContaining('busy') });
    await host.send('close', room);
    await otherOffer('f'.repeat(1000));
    expect(h.deviceId).not.toBe(g.deviceId);
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
    // A stale coordinator epoch ignores any old high cursor so signals from the current process are still delivered.
    const restarted = await guest.send('status', room, { session: guest.session, cursor: 999, epoch: 'previous-process' }) as RoomStatus;
    expect(restarted.signals).toHaveLength(1);
    // Once acknowledged with the current epoch and cursor, the signal is drained from the queue.
    const drained = await guest.send('status', room, { session: guest.session, cursor: received.signals![0].seq, epoch: received.epoch }) as RoomStatus;
    expect(drained.signals).toHaveLength(0);
    expect((await guest.status(room)).signals).toHaveLength(0);
    await host.send('remove', room, { deviceId: target.deviceId });
    await expect(guest.send('signal', room, { ...payload, to: h.deviceId, session: guest.session, targetSession: host.session })).rejects.toThrow('admission');
  } finally { lobby.close(); }
});

test('signal queue deduplicates superseded offers/answers, enforces per-sender fairness, and keeps signalChars strictly invariant', async () => {
  let now = Date.now();
  const lobby = new BrowserLobby(':memory:', { origin, now: () => now, maxSignalChars: 1500 });
  const chars = () => (lobby as unknown as { signalChars: number }).signalChars;
  try {
    const host = await client(lobby, () => now), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Signaling', name: 'Alex', label: 'Desktop' });
    const sam = await admitPerson(lobby, host, room, 'Sam', () => now);
    const pat = await admitPerson(lobby, host, room, 'Pat', () => now);
    const h = await host.status(room), s = await sam.status(room), p = await pat.status(room);
    const send = (from: typeof host, to: string, targetSession: string, type: 'offer' | 'answer', sdp: string) =>
      from.send('signal', room, { to, session: from.session, targetSession, description: { type, sdp } });

    expect(chars()).toBe(0);
    // 1. Newer offer from the same sender replaces the older unpolled offer and adjusts signalChars accurately.
    await send(host, s.deviceId, sam.session, 'offer', 'o1'.repeat(500)); // 1000 chars
    expect(chars()).toBe(1000);
    // Replacement that exceeds maxSignalChars is refused without mutating the queued offer or signalChars.
    await expect(send(host, s.deviceId, sam.session, 'offer', 'x'.repeat(1600))).rejects.toMatchObject({ status: 429 });
    expect(chars()).toBe(1000);
    // Replacement that fits once the superseded offer is freed succeeds and updates signalChars to the new length.
    await send(host, s.deviceId, sam.session, 'offer', 'o2'.repeat(750)); // 1500 chars
    expect(chars()).toBe(1500);
    // Shrink back via replacement, then queue a separate answer from the same sender (offer + answer coexist).
    await send(host, s.deviceId, sam.session, 'offer', 'o3'.repeat(200)); // 400 chars
    await send(host, s.deviceId, sam.session, 'answer', 'a1'.repeat(150)); // +300 = 700
    await send(host, s.deviceId, sam.session, 'answer', 'a2'.repeat(100)); // replaces a1 -> 400 + 200 = 600
    expect(chars()).toBe(600);
    const polled = await sam.status(room);
    expect(polled.signals!.map(sig => [sig.description.type, sig.description.sdp])).toEqual([
      ['offer', 'o3'.repeat(200)],
      ['answer', 'a2'.repeat(100)],
    ]);
    // 2. Draining via matching epoch + cursor frees queued signals and returns signalChars to 0.
    const maxSeq = Math.max(...polled.signals!.map(sig => sig.seq));
    const drained = await sam.send('status', room, { session: sam.session, cursor: maxSeq, epoch: polled.epoch }) as RoomStatus;
    expect(drained.signals).toHaveLength(0);
    expect(chars()).toBe(0);

    // 3. Expiry (30 s TTL) returns signalChars to 0 without blocking valid reconnects.
    await send(host, s.deviceId, sam.session, 'offer', 'e'.repeat(1400));
    expect(chars()).toBe(1400);
    now += 15_000;
    await host.status(room); await sam.status(room); await pat.status(room);
    now += SIGNAL_TTL_MS - 14_000; // +31 s total since offer, while presence is still fresh (+16 s)
    await send(pat, s.deviceId, sam.session, 'offer', 'p'.repeat(500));
    expect(chars()).toBe(500);
    // Reconnecting with a brand-new session drops signals addressed to the old session and zeros signalChars.
    const freshSession = crypto.randomUUID();
    const reconnected = await sam.send('status', room, { session: freshSession }) as RoomStatus;
    expect(reconnected.signals).toHaveLength(0);
    expect(chars()).toBe(0);
    sam.session = freshSession;

    // 4. Removing a device clears both signals addressed to it and signals sent by it, returning signalChars to 0.
    await send(host, p.deviceId, pat.session, 'offer', 'h'.repeat(300));
    await send(pat, h.deviceId, host.session, 'offer', 'q'.repeat(250));
    expect(chars()).toBe(550);
    await host.send('remove', room, { deviceId: p.deviceId });
    expect(chars()).toBe(0);

    // 5. Closing the room clears all remaining signals and returns signalChars to 0.
    await send(host, s.deviceId, sam.session, 'offer', 'z'.repeat(600));
    expect(chars()).toBe(600);
    await host.send('close', room);
    expect(chars()).toBe(0);
  } finally { lobby.close(); }
});

test('signal queue enforces fair per-sender cap and 32-slot per-device cap while allowing offer replacement', async () => {
  let now = Date.now();
  const lobby = new BrowserLobby(':memory:', { origin, now: () => now });
  const internalSignals = (lobby as unknown as { signals: Map<string, { seq: number; from: string; session: string; targetSession: string; description: RTCSessionDescriptionInit; at: number }[]> }).signals;
  const setChars = (delta: number) => { (lobby as unknown as { signalChars: number }).signalChars += delta; };
  try {
    const host = await client(lobby, () => now), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Fairness', name: 'Alex', label: 'Desktop' });
    const target = await admitPerson(lobby, host, room, 'Sam', () => now);
    const peer = await admitPerson(lobby, host, room, 'Pat', () => now);
    const h = await host.status(room), t = await target.status(room), p = await peer.status(room);
    const key = `${room}:${t.deviceId}`;

    // One noisy peer flooding offers/answers cannot starve other room members because offers/answers supersede in place.
    for (let i = 0; i < 40; i++) {
      await host.send('signal', room, { to: t.deviceId, session: host.session, targetSession: target.session, description: { type: 'offer', sdp: `offer-${i}` } });
    }
    expect(internalSignals.get(key)).toHaveLength(1);
    await peer.send('signal', room, { to: t.deviceId, session: peer.session, targetSession: target.session, description: { type: 'offer', sdp: 'peer-offer' } });
    expect(internalSignals.get(key)).toHaveLength(2);

    // Explicit per-sender cap (MAX_SIGNALS_PER_SENDER = 8): a sender already holding 8 non-offer slots cannot add a 9th,
    // while another sender can still enqueue into the same recipient's queue.
    const seeded = internalSignals.get(key)!;
    seeded.length = 0;
    (lobby as unknown as { signalChars: number }).signalChars = 0;
    for (let i = 0; i < MAX_SIGNALS_PER_SENDER; i++) {
      seeded.push({ seq: i + 1, from: h.deviceId, session: host.session, targetSession: target.session, description: { type: 'pranswer', sdp: 'x' }, at: now });
      setChars(1);
    }
    await expect(host.send('signal', room, { to: t.deviceId, session: host.session, targetSession: target.session, description: { type: 'offer', sdp: 'blocked' } }))
      .rejects.toMatchObject({ status: 429 });
    // Another peer is unaffected by the noisy sender's cap.
    await peer.send('signal', room, { to: t.deviceId, session: peer.session, targetSession: target.session, description: { type: 'offer', sdp: 'peer-ok' } });
    expect(internalSignals.get(key)!.some(s => s.from === p.deviceId)).toBe(true);

    // At the 32-slot per-device cap, a brand-new signal is rejected with 429, while replacing an existing offer succeeds.
    const live = internalSignals.get(key)!;
    while (live.length < MAX_SIGNALS_PER_DEVICE) {
      live.push({ seq: live.length + 100, from: `other-${live.length}`, session: 's', targetSession: target.session, description: { type: 'pranswer', sdp: 'y' }, at: now });
      setChars(1);
    }
    expect(live).toHaveLength(MAX_SIGNALS_PER_DEVICE);
    await expect(peer.send('signal', room, { to: t.deviceId, session: peer.session, targetSession: target.session, description: { type: 'answer', sdp: 'full' } }))
      .rejects.toMatchObject({ status: 429 });
    await peer.send('signal', room, { to: t.deviceId, session: peer.session, targetSession: target.session, description: { type: 'offer', sdp: 'peer-replaced' } });
    const afterReplace = internalSignals.get(key)!;
    expect(afterReplace).toHaveLength(MAX_SIGNALS_PER_DEVICE);
    expect(afterReplace.find(s => s.from === p.deviceId && s.description.type === 'offer')?.description.sdp).toBe('peer-replaced');
  } finally { lobby.close(); }
});

test('a device stays reachable for the presence window after its last poll, so a slow bridge pass does not drop it', async () => {
  let now = Date.now(); const lobby = new BrowserLobby(':memory:', { origin, now: () => now });
  try {
    const host = await client(lobby, () => now), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });
    const sam = await admitPerson(lobby, host, room, 'Sam', () => now);
    const s = await sam.status(room);
    const offer = { to: s.deviceId, session: host.session, targetSession: sam.session, description: { type: 'offer', sdp: 'test offer' } };
    // A bridge that polled 12 s ago, in the middle of a long pass, is still there: it is listed and can be offered to.
    now += 12_000;
    expect((await host.status(room)).devices!.find(d => d.id === s.deviceId)?.session).toBe(sam.session);
    await host.send('signal', room, offer);
    // Past the window it is gone: not listed, and an offer to it asks the sender to reconnect.
    now += PRESENCE_MS;
    expect((await host.status(room)).devices!.find(d => d.id === s.deviceId)?.session).toBeUndefined();
    await expect(host.send('signal', room, offer)).rejects.toThrow('connection changed');
  } finally { lobby.close(); }
});

test('a person connects an agent with a one-time link; it joins as its own member they operate', async () => {
  let now = Date.now(); const lobby = new BrowserLobby(':memory:', { origin, now: () => now });
  try {
    const host = await client(lobby, () => now), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });
    await host.send('settings', room, { guestAgentApproval: false });
    const sam = await admitPerson(lobby, host, room, 'Sam', () => now), pat = await admitPerson(lobby, host, room, 'Pat', () => now);
    const stranger = await client(lobby, () => now), agent = await client(lobby, () => now), late = await client(lobby, () => now);
    await expect(stranger.send('agent-invite', room, { name: 'Codex' })).rejects.toThrow('Only people');
    await expect(sam.send('agent-invite', room, { name: 'pat' })).rejects.toThrow('already uses that name');
    // "agents" is reserved for @agents, for people and agents alike.
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
    await host.send('settings', room, { guestAgentApproval: false });
    const sam = await admitPerson(lobby, host, room, 'Sam');
    const hostAgent = await client(lobby), samAgent = await client(lobby);
    const { token: wren } = await host.send('agent-invite', room, { name: 'Wren' }) as { token: string };
    await hostAgent.send('agent-redeem', room, { token: wren, label: 'Mac node' });
    const { token: codex } = await sam.send('agent-invite', room, { name: 'Codex' }) as { token: string };
    await samAgent.send('agent-redeem', room, { token: codex, label: 'Windows node' });
    const links: string[] = [];
    for (const name of ['A1', 'A2', 'A3', 'A4']) links.push((await sam.send('agent-invite', room, { name }) as { token: string }).token);
    await expect(sam.send('agent-invite', room, { name: 'A5' })).rejects.toThrow('four unused agent links');
    // From review: links made while Sam had fewer agents cannot take Sam past four once they are used.
    for (const token of links.slice(0, 3)) await (await client(lobby)).send('agent-redeem', room, { token, label: 'Extra' });
    await expect((await client(lobby)).send('agent-redeem', room, { token: links[3], label: 'Extra' })).rejects.toThrow('already has four agents');
    expect((await host.status(room)).members!.map(m => [m.name, m.role ?? 'human'])).toEqual([['Alex', 'human'], ['Sam', 'human'], ['Wren', 'agent'], ['Codex', 'agent'],
      ['A1', 'agent'], ['A2', 'agent'], ['A3', 'agent']]);

    // The host removes Sam's only device: Sam's agent and unused links go too; the host's agent stays.
    await host.send('remove', room, { deviceId: (await sam.status(room)).deviceId });
    const after = await host.status(room);
    expect(after.members!.map(m => m.name)).toEqual(['Alex', 'Wren']);
    expect(after.devices).toHaveLength(2);
    expect((await samAgent.status(room)).memberId).toBeUndefined();
    // Departed devices keep their member's role, so a removed agent's signed votes never pass as a person's.
    const roles = Object.fromEntries(after.formerDevices!.map(d => [d.role, (after.formerDevices!.filter(x => x.role === d.role)).length]));
    expect(roles).toEqual({ human: 1, agent: 4 });
    const again = await client(lobby);
    await expect(again.send('agent-redeem', room, { token: codex, label: 'Windows node' })).rejects.toThrow('already used or has expired');
  } finally { lobby.close(); }
});

test('the agent explainer and bridge are served per room, naming the room by id (never its title), without a same-origin bundle hash', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  const dir = testDirectory('agent-explainer');
  try {
    const host = await client(lobby), room = crypto.randomUUID();
    const bare = browserHandler(lobby, origin, dir.path);
    expect((await bare(new Request(`${origin}/agent/${room}`))).status).toBe(404);
    expect((await bare(new Request(`${origin}/agent/meshrooms-agent.js`))).status).toBe(404);
    await host.send('create', room, { title: 'Work <b>**`', name: 'Alex', label: 'Desktop' });
    // An exact version, never a bare package name bunx could answer from an older cached copy.
    const guide = await (await bare(new Request(`${origin}/agent/${room}.md`))).text();
    expect(guide).toContain(`bunx @wormdb/meshrooms@${CURRENT_AGENT_VERSION} connect '<the link, including #token>'`);
    expect([...guide.matchAll(/bunx @wormdb\/meshrooms(\S*)/g)].map(m => m[1]).every(v => v === `@${CURRENT_AGENT_VERSION}`)).toBe(true);
    // A Grok Bot is pointed at its guide at the same bridge's tag, so the guide's commands are that bridge's.
    expect(guide).toContain(`https://raw.githubusercontent.com/igorls/meshrooms/bridge-v${CURRENT_AGENT_VERSION}/skills/meshrooms-grok-bot/SKILL.md`);
    expect(guide).toContain("grok wake --room {room} --prompt-file {prompt_file}");
    expect(await (await bare(new Request(`${origin}/api/lobby/health`))).json()).toMatchObject({ minAgentVersion: MIN_AGENT_VERSION, currentAgentVersion: CURRENT_AGENT_VERSION });

    mkdirSync(join(dir.path, 'agent'));
    writeFileSync(join(dir.path, 'agent', 'meshrooms-agent.js'), 'console.log(1)');
    writeFileSync(join(dir.path, 'agent', 'meshrooms-agent.js.sha256'), `${'a'.repeat(64)}  meshrooms-agent.js\n`);
    const handle = browserHandler(lobby, origin, dir.path);
    const markdown = await handle(new Request(`${origin}/agent/${room}.md`));
    expect(markdown.headers.get('content-type')).toContain('text/markdown');
    const text = await markdown.text();
    expect(text).toContain(`${origin}/agent/${room}`); expect(text).not.toContain('a'.repeat(64)); expect(text).not.toContain('{{');
    // SEC-10: the host-written title never reaches text an agent follows; the room is named by its id.
    expect(text).not.toContain('Work'); expect(text).toContain(`**\`${room}\`**`);
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
    await host.send('settings', room, { guestAgentApproval: false });
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

test('keys of devices that left stay available to members, stamped with when they left and whether they were revoked', async () => {
  let now = Date.now(); const lobby = new BrowserLobby(':memory:', { origin, now: () => now });
  try {
    const host = await client(lobby), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });
    const sam = await admitPerson(lobby, host, room, 'Sam'), kim = await admitPerson(lobby, host, room, 'Kim');
    const samStatus = await sam.status(room), kimStatus = await kim.status(room);
    const key = (id: string) => samStatus.devices!.find(d => d.id === id)!.publicKey;
    expect((await host.status(room)).formerDevices).toBeUndefined();
    // Sam leaves from Sam's own device: trusted up to when it left.
    now += 1000; await sam.send('remove', room, { deviceId: samStatus.deviceId });
    // The host removes Kim's device: revoked, nothing more it signs is accepted.
    now += 1000; await host.send('remove', room, { deviceId: kimStatus.deviceId });
    const after = await host.status(room);
    expect(after.formerDevices).toEqual([
      { id: samStatus.deviceId, publicKey: key(samStatus.deviceId), memberId: samStatus.memberId!, role: 'human', retiredAt: now - 1000 },
      { id: kimStatus.deviceId, publicKey: key(kimStatus.deviceId), memberId: kimStatus.memberId!, role: 'human', retiredAt: now, revoked: true },
    ]);
    expect((await sam.status(room)).formerDevices).toBeUndefined(); // not shown outside the room
  } finally { lobby.close(); }
});

test('a device that left from itself can be revoked afterwards, by the host or its own member only', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  try {
    const host = await client(lobby), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });
    const sam = await admitPerson(lobby, host, room, 'Sam'), kim = await admitPerson(lobby, host, room, 'Kim');
    const samId = (await sam.status(room)).deviceId, kimId = (await kim.status(room)).deviceId;
    // Sam's laptop leaves on its own (say, it was stolen), so it is not revoked yet.
    await sam.send('remove', room, { deviceId: samId });
    const former = async () => (await host.status(room)).formerDevices!.find(d => d.id === samId)!;
    expect((await former()).revoked).toBeUndefined();
    await expect(kim.send('remove', room, { deviceId: samId })).rejects.toThrow('cannot remove this device');
    await expect(sam.send('remove', room, { deviceId: samId })).rejects.toThrow();
    await host.send('remove', room, { deviceId: samId });
    expect((await former()).revoked).toBe(true);
    // Kim's own device can revoke Kim's departed device.
    const kimPhone = await client(lobby);
    await kimPhone.send('request', room, { name: 'Companion', label: 'Phone', kind: 'companion' });
    await kim.send('link', room, { code: (await kimPhone.status(room)).request!.code });
    await kim.send('remove', room, { deviceId: kimId });
    await kimPhone.send('remove', room, { deviceId: kimId });
    expect((await host.status(room)).formerDevices!.find(d => d.id === kimId)!.revoked).toBe(true);
    await expect(host.send('remove', room, { deviceId: crypto.randomUUID() })).rejects.toThrow('Device not found');
  } finally { lobby.close(); }
});

test('the host controls room settings, and can require approval for guests’ agents', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  try {
    const host = await client(lobby), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });
    const sam = await admitPerson(lobby, host, room, 'Sam');
    // SEC-12: new rooms approve guests' agents by default.
    expect((await sam.status(room)).settings).toEqual({ floor: 'humans-first', agentAssignmentsWake: false, guestAgentApproval: true, hostApprovesDevices: false });
    await expect(sam.send('settings', room, { floor: 'open' })).rejects.toThrow('Only the host');
    await expect(host.send('settings', room, { floor: 'loud' })).rejects.toThrow('when agents reply');
    await expect(host.send('settings', room, { guestAgentApproval: 'yes' })).rejects.toThrow('on or off');
    await host.send('settings', room, { guestAgentApproval: false, agentAssignmentsWake: true });
    expect((await sam.status(room)).settings).toEqual({ floor: 'humans-first', agentAssignmentsWake: true, guestAgentApproval: false, hostApprovesDevices: false });
    await host.send('settings', room, { guestAgentApproval: true });
    expect((await sam.status(room)).settings).toEqual({ floor: 'humans-first', agentAssignmentsWake: true, guestAgentApproval: true, hostApprovesDevices: false });

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
    const { token: own } = await host.send('agent-invite', room, { name: 'Wren' }) as { token: string };
    await hostAgent.send('agent-redeem', room, { token: own, label: 'Mac node' });
    expect((await hostAgent.status(room)).memberId).toBeDefined();

    // A guest's agent still waiting leaves with its operator.
    const { token: late } = await sam.send('agent-invite', room, { name: 'Grok' }) as { token: string };
    await orphan.send('agent-redeem', room, { token: late, label: 'Linux node' });
    expect((await host.status(room)).requests!.some(r => r.name === 'Grok')).toBe(true);
    await host.send('remove', room, { deviceId: (await sam.status(room)).deviceId });
    const after = await host.status(room);
    expect(after.requests!.some(r => r.name === 'Grok')).toBe(false);
    expect(after.members!.map(m => m.name)).toEqual(['Alex', 'Wren']);
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
    await host.send('settings', room, { guestAgentApproval: false });
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
    await host.send('settings', room, { guestAgentApproval: false });
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

test('people pin repositories one at a time; agents and strangers cannot', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  try {
    const host = await client(lobby), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });
    const sam = await admitPerson(lobby, host, room, 'Sam'), stranger = await client(lobby), agent = await client(lobby);
    expect((await host.status(room)).repositories).toBeUndefined();
    // Any person pins, not only the host; two pins at once both stay.
    await sam.send('repositories', room, { pin: 'igorls/meshrooms' });
    await host.send('repositories', room, { pin: 'igorls/wormdb' });
    await host.send('repositories', room, { pin: 'IGORLS/Meshrooms' }); // already pinned, in any case
    expect((await sam.status(room)).repositories).toEqual(['igorls/meshrooms', 'igorls/wormdb']);
    for (const bad of ['igorls', 'igorls/..', 'a/b/c', 'https://github.com/igorls/meshrooms', 'x'.repeat(40) + '/r'])
      await expect(host.send('repositories', room, { pin: bad })).rejects.toThrow('owner/name');
    await expect(host.send('repositories', room, { pin: 'a/b', unpin: 'c/d' })).rejects.toThrow('owner/name');
    await expect(stranger.send('repositories', room, { pin: 'a/b' })).rejects.toThrow('Only people');
    const { token } = await sam.send('agent-invite', room, { name: 'Codex' }) as { token: string };
    await agent.send('agent-redeem', room, { token, label: 'Laptop' });
    await expect(agent.send('repositories', room, { pin: 'a/b' })).rejects.toThrow('Only people');
    for (let i = 0; i < 6; i++) await host.send('repositories', room, { pin: `org/repo-${i}` });
    await expect(host.send('repositories', room, { pin: 'org/one-too-many' })).rejects.toThrow('Unpin one first');
    await sam.send('repositories', room, { unpin: 'IGORLS/WORMDB' });
    expect((await host.status(room)).repositories).toHaveLength(7);
    for (const r of (await host.status(room)).repositories!) await host.send('repositories', room, { unpin: r });
    expect((await host.status(room)).repositories).toBeUndefined();
    expect(lobby.publicRoom(room)).toEqual({ roomId: room, title: 'Work' }); // never shown outside the room
  } finally { lobby.close(); }
});

test('SEC-8: display names and titles normalize NFKC/control chars and enforce case-folded uniqueness across people and agents', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  try {
    const host = await client(lobby), room = crypto.randomUUID();
    // Control-only / zero-width-only names and room titles are refused.
    await expect(host.send('create', room, { title: '\u200b\u202e\t  ', name: 'Alex', label: 'Desktop' })).rejects.toMatchObject({ status: 400 });
    await expect(host.send('create', room, { title: 'Work', name: '\u200b\u202e\u0000 ', label: 'Desktop' })).rejects.toMatchObject({ status: 400 });
    await expect(host.send('create', room, { title: 'Work', name: 'Ａｇｅｎｔｓ', label: 'Desktop' })).rejects.toThrow('reserved');
    // Normalized titles and display names strip invisible/bidi chars and collapse whitespace.
    await host.send('create', room, { title: '  \u202eProject   Room\u200b ', name: '  Ａｌｅｘ   M.\u200b ', label: 'Desktop' });
    expect(lobby.publicRoom(room)).toEqual({ roomId: room, title: 'Project Room' });
    expect((await host.status(room)).members![0].name).toBe('Alex M.');

    // Lookalike person requests collide via NFKC + case-folding.
    for (const spoof of ['alex m.', 'ALEX  M.', 'Ａｌｅｘ M.', 'A\u200blex M.', '\u202eAlex M.\u202c']) {
      await expect((await client(lobby)).send('request', room, { name: spoof, label: 'Browser', kind: 'person' }))
        .rejects.toMatchObject({ status: 409, message: 'Someone in this room already uses that name. Choose a different name.' });
    }
    // Companion requests may carry the existing member's name without colliding.
    const companion = await client(lobby);
    await companion.send('request', room, { name: 'Alex M.', label: 'Tablet', kind: 'companion' });
    await host.send('link', room, { code: (await companion.status(room)).request!.code });
    expect((await companion.status(room)).memberId).toBe((await host.status(room)).memberId);

    // Two pending person requests with the same folded name: admitting the first blocks admitting the second.
    const first = await client(lobby), second = await client(lobby);
    await first.send('request', room, { name: 'Jordan', label: 'Laptop', kind: 'person' });
    await second.send('request', room, { name: 'Ｊｏｒｄａｎ\u200b', label: 'Phone', kind: 'person' });
    const reqs = (await host.status(room)).requests!;
    expect(reqs).toHaveLength(2);
    const firstReq = reqs.find(r => r.device.label === 'Laptop')!, secondReq = reqs.find(r => r.device.label === 'Phone')!;
    await host.send('decide', room, { requestId: firstReq.id, admit: true });
    await expect(host.send('decide', room, { requestId: secondReq.id, admit: true }))
      .rejects.toMatchObject({ status: 409, message: 'Someone in this room already uses that name. Choose a different name.' });

    // Agent invites and redemptions enforce NFKC+case-folded uniqueness against both people and open invites.
    await expect(host.send('agent-invite', room, { name: 'ｊｏｒｄａｎ' })).rejects.toMatchObject({ status: 409 });
    await expect(host.send('agent-invite', room, { name: 'A\u200bgents' })).rejects.toThrow('reserved');
    const { token } = await host.send('agent-invite', room, { name: 'Wren' }) as { token: string };
    // An active unused agent invite also blocks a person requesting that name.
    await expect((await client(lobby)).send('request', room, { name: 'ＷＲＥＮ', label: 'Browser', kind: 'person' })).rejects.toMatchObject({ status: 409 });
    const agent = await client(lobby);
    await agent.send('agent-redeem', room, { token, label: 'Bridge' });
    expect((await agent.status(room)).memberId).toBeDefined();

    // If a person was waiting with a name before an agent invite wasn't there yet, and joins first, a racing agent-redeem fails with 409.
    const { token: racingToken } = await host.send('agent-invite', room, { name: 'Scout' }) as { token: string };
    // Create a racing person request by waiting before invite? Invite already exists so test opposite order:
    const pendingPerson = await client(lobby);
    await pendingPerson.send('request', room, { name: 'Casey', label: 'Desktop', kind: 'person' });
    const { token: caseyToken } = await host.send('agent-invite', room, { name: 'Ｃａｓｅｙ' }) as { token: string };
    const caseyReq = (await host.status(room)).requests!.find(r => r.name === 'Casey')!;
    // Active invite for 'Casey' blocks admitting the earlier pending person request.
    await expect(host.send('decide', room, { requestId: caseyReq.id, admit: true })).rejects.toMatchObject({ status: 409 });
    const scoutAgent = await client(lobby);
    await scoutAgent.send('agent-redeem', room, { token: racingToken, label: 'Node' });
    expect((await scoutAgent.status(room)).memberId).toBeDefined();
    // Redeeming the Casey invite succeeds cleanly once it's the invite holder.
    const caseyAgent = await client(lobby);
    await caseyAgent.send('agent-redeem', room, { token: caseyToken, label: 'Node' });
    expect((await caseyAgent.status(room)).memberId).toBeDefined();
  } finally { lobby.close(); }
});

test('SEC-13: atomic remove { memberId } removes all member devices and operated agents with SEC-7 revocation semantics', async () => {
  let now = Date.now();
  const lobby = new BrowserLobby(':memory:', { origin, now: () => now });
  try {
    const host = await client(lobby, () => now), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });
    await host.send('settings', room, { guestAgentApproval: false });
    const sam = await admitPerson(lobby, host, room, 'Sam', () => now);
    const pat = await admitPerson(lobby, host, room, 'Pat', () => now);
    const samPhone = await client(lobby, () => now), patPhone = await client(lobby, () => now);
    await samPhone.send('request', room, { name: 'Sam', label: 'Phone', kind: 'companion' });
    await sam.send('link', room, { code: (await samPhone.status(room)).request!.code });
    await patPhone.send('request', room, { name: 'Pat', label: 'Phone', kind: 'companion' });
    await pat.send('link', room, { code: (await patPhone.status(room)).request!.code });

    const { token: t1 } = await sam.send('agent-invite', room, { name: 'SamBot' }) as { token: string };
    const samAgent = await client(lobby, () => now);
    await samAgent.send('agent-redeem', room, { token: t1, label: 'Bridge' });
    const { token: unusedSam } = await sam.send('agent-invite', room, { name: 'SamBot2' }) as { token: string };
    const { token: t2 } = await pat.send('agent-invite', room, { name: 'PatBot' }) as { token: string };
    const patAgent = await client(lobby, () => now);
    await patAgent.send('agent-redeem', room, { token: t2, label: 'Bridge' });

    const hostStatus = await host.status(room);
    const samId = (await sam.status(room)).memberId!, patId = (await pat.status(room)).memberId!;
    const samDeviceId = (await sam.status(room)).deviceId, samPhoneId = (await samPhone.status(room)).deviceId, samAgentDevId = (await samAgent.status(room)).deviceId;
    const patDeviceId = (await pat.status(room)).deviceId, patPhoneId = (await patPhone.status(room)).deviceId, patAgentDevId = (await patAgent.status(room)).deviceId;

    // Validation & permission checks.
    await expect(host.send('remove', room, {})).rejects.toMatchObject({ status: 400 });
    await expect(host.send('remove', room, { deviceId: samDeviceId, memberId: samId })).rejects.toMatchObject({ status: 400 });
    await expect(host.send('remove', room, { memberId: hostStatus.memberId })).rejects.toMatchObject({ status: 409 });
    await expect(pat.send('remove', room, { memberId: samId })).rejects.toMatchObject({ status: 403 });

    // Host atomically removes Sam (2 devices + 1 agent + 1 unused invite): every removed device is revoked.
    now += 1000;
    await host.send('remove', room, { memberId: samId });
    expect((await sam.status(room)).memberId).toBeUndefined();
    expect((await samPhone.status(room)).memberId).toBeUndefined();
    expect((await samAgent.status(room)).memberId).toBeUndefined();
    await expect((await client(lobby, () => now)).send('agent-redeem', room, { token: unusedSam, label: 'Late' })).rejects.toMatchObject({ status: 410 });
    const afterHostRemove = await host.status(room);
    for (const devId of [samDeviceId, samPhoneId, samAgentDevId]) {
      expect(afterHostRemove.formerDevices!.find(d => d.id === devId)).toMatchObject({ id: devId, retiredAt: now, revoked: true });
    }

    // Pat self-leaves via atomic remove { memberId: patId } from Pat's primary device:
    // primary device (actor.id) is self-left (not revoked), while Pat's other companion & agent are revoked.
    now += 1000;
    await pat.send('remove', room, { memberId: patId });
    expect((await pat.status(room)).memberId).toBeUndefined();
    expect((await patPhone.status(room)).memberId).toBeUndefined();
    expect((await patAgent.status(room)).memberId).toBeUndefined();
    const afterSelfLeave = await host.status(room);
    expect(afterSelfLeave.members!.map(m => m.name)).toEqual(['Alex']);
    expect(afterSelfLeave.formerDevices!.find(d => d.id === patDeviceId)?.revoked).toBeUndefined();
    expect(afterSelfLeave.formerDevices!.find(d => d.id === patPhoneId)?.revoked).toBe(true);
    expect(afterSelfLeave.formerDevices!.find(d => d.id === patAgentDevId)?.revoked).toBe(true);
  } finally { lobby.close(); }
});

test('SEC-13: declining a request enforces a 5-minute cooldown; decline & block permanently blocks the device', async () => {
  let now = Date.now();
  const lobby = new BrowserLobby(':memory:', { origin, now: () => now });
  try {
    const host = await client(lobby, () => now), visitor = await client(lobby, () => now), banned = await client(lobby, () => now), other = await client(lobby, () => now);
    const room = crypto.randomUUID();
    await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });

    // Temporary decline cooldown via { admit: false }.
    await visitor.send('request', room, { name: 'Visitor', label: 'Browser', kind: 'person' });
    const req1 = (await host.status(room)).requests![0];
    await host.send('decide', room, { requestId: req1.id, admit: false });
    expect((await visitor.status(room)).request?.state).toBe('declined');
    await expect(visitor.send('request', room, { name: 'Visitor', label: 'Browser', kind: 'person' }))
      .rejects.toMatchObject({ status: 429, message: 'Your join request was declined. Wait a few minutes before asking again.' });
    // Unrelated device is unaffected.
    await other.send('request', room, { name: 'Other', label: 'Laptop', kind: 'person' });
    // Still blocked 1 ms before cooldown expires; allowed once cooldown elapses.
    now += DECLINE_COOLDOWN_MS - 1;
    await expect(visitor.send('request', room, { name: 'Visitor', label: 'Browser', kind: 'person' })).rejects.toMatchObject({ status: 429 });
    now += 2;
    await visitor.send('request', room, { name: 'Visitor', label: 'Browser', kind: 'person' });
    expect((await visitor.status(room)).request?.state).toBe('pending');

    // Permanent block via { decision: 'decline', block: true }.
    await banned.send('request', room, { name: 'Spammer', label: 'Browser', kind: 'person' });
    const bannedReq = (await host.status(room)).requests!.find(r => r.name === 'Spammer')!;
    await host.send('decide', room, { requestId: bannedReq.id, decision: 'decline', block: true });
    await expect(banned.send('request', room, { name: 'Spammer', label: 'Browser', kind: 'person' })).rejects.toMatchObject({ status: 403 });
    // Even days later and even with an agent invite token, a permanently blocked device cannot join.
    now += 7 * 86_400_000;
    await expect(banned.send('request', room, { name: 'New Name', label: 'Browser', kind: 'person' })).rejects.toMatchObject({ status: 403 });
    const { token } = await host.send('agent-invite', room, { name: 'Bot' }) as { token: string };
    await expect(banned.send('agent-redeem', room, { token, label: 'Bridge' })).rejects.toMatchObject({ status: 403 });
    // Permanent block survives > MAX_BLOCKED_DEVICES temporary cooldowns.
    expect(MAX_BLOCKED_DEVICES).toBe(256);
    for (let i = 0; i < MAX_BLOCKED_DEVICES + 5; i++) {
      const churn = await client(lobby, () => now);
      await churn.send('request', room, { name: `Guest ${i}`, label: 'Browser', kind: 'person' });
      const pending = (await host.status(room)).requests!.find(r => r.name === `Guest ${i}`)!;
      await host.send('decide', room, { requestId: pending.id, admit: false });
    }
    await expect(banned.send('request', room, { name: 'Still Blocked', label: 'Browser', kind: 'person' })).rejects.toMatchObject({ status: 403 });
  } finally { lobby.close(); }
});
