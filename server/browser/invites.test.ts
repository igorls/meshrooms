import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserLobby, LobbyError } from './lobby';
import { browserHandler } from './http';
import { BETA_DEVICES_PER_PERSON, betaPerson, consumeInvite, invitesCli, listBetaPeople, listInvites, mintInvite, normalizeInvite, revokeBetaPerson, revokeInvite } from './invites';
import { client, testOrigin as origin, type TestClient } from './test-client';

const DAY = 86_400_000;
const db = (lobby: BrowserLobby) => (lobby as unknown as { db: Database }).db;
async function rejected(work: Promise<unknown>): Promise<LobbyError> {
  try { await work; } catch (error) { return error as LobbyError; }
  throw new Error('expected a rejection');
}
const create = async (lobby: BrowserLobby, invite?: string, clock = () => Date.now()) =>
  (await client(lobby, clock)).send('create', crypto.randomUUID(), { title: 'Beta', name: 'Alex', label: 'Desktop', ...(invite === undefined ? {} : { invite }) });

test('SEC-2: codes are shown once, stored only as a hash, and typed in any case with or without dashes', () => {
  const lobby = new BrowserLobby(':memory:', { origin, invites: 'required' });
  try {
    const invite = mintInvite(db(lobby), { uses: 5, days: 14, note: 'Beta cohort A' });
    expect(invite.code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    const stored = JSON.stringify(db(lobby).query('SELECT * FROM creation_invites').all());
    expect(stored).not.toContain(invite.code); expect(stored).not.toContain(invite.code.replaceAll('-', ''));
    expect(normalizeInvite(` ${invite.code.toLowerCase()} `)).toBe(invite.code.replaceAll('-', ''));
    expect(normalizeInvite('short')).toBeUndefined();
    expect(listInvites(db(lobby))).toEqual([{ id: invite.id, uses: 5, remaining: 5, expiresAt: invite.expiresAt, note: 'Beta cohort A', createdAt: expect.any(Number), revokedAt: null }]);
    expect(() => mintInvite(db(lobby), { uses: 0, days: 14 })).toThrow('--uses');
    expect(() => mintInvite(db(lobby), { uses: 1, days: 0 })).toThrow('--days');
  } finally { lobby.close(); }
});

test('SEC-2: creation needs a valid code with uses left; joining by link never does', async () => {
  let now = Date.now();
  const lobby = new BrowserLobby(':memory:', { origin, invites: 'required', now: () => now });
  try {
    const { code, id } = mintInvite(db(lobby), { uses: 2, days: 1, now });
    const missing = await rejected(create(lobby, undefined, () => now));
    expect([missing.status, missing.code]).toEqual([403, 'invite-required']);
    const invalid = await rejected(create(lobby, 'AAAA-BBBB-CCCC-DDDD', () => now));
    expect([invalid.status, invalid.code]).toEqual([403, 'invite-invalid']);

    const host = await client(lobby, () => now), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Beta', name: 'Alex', label: 'Desktop', invite: code.toLowerCase() });
    // Joining the room needs no code.
    await (await client(lobby, () => now)).send('request', room, { name: 'Sam', label: 'Laptop', kind: 'person' });
    await create(lobby, code.replaceAll('-', ' '), () => now);
    const used = await rejected(create(lobby, code, () => now));
    expect([used.status, used.code]).toEqual([410, 'invite-used']);
    expect(listInvites(db(lobby))[0].remaining).toBe(0);

    const later = mintInvite(db(lobby), { uses: 5, days: 1, now });
    now += DAY;
    const expired = await rejected(create(lobby, later.code, () => now));
    expect([expired.status, expired.code]).toEqual([410, 'invite-expired']);
    const revoked = mintInvite(db(lobby), { uses: 5, days: 7, now });
    expect(revokeInvite(db(lobby), revoked.id, now)).toBe(true);
    expect(revokeInvite(db(lobby), revoked.id, now)).toBe(false);
    expect((await rejected(create(lobby, revoked.code, () => now))).code).toBe('invite-invalid');
    expect(id).toMatch(/^[a-f0-9]{8}$/);
  } finally { lobby.close(); }
});

test('SEC-2: a retried create uses one code once, and a create that fails uses none', async () => {
  const lobby = new BrowserLobby(':memory:', { origin, invites: 'required', maxRooms: 2 });
  try {
    const { code } = mintInvite(db(lobby), { uses: 3, days: 1 });
    const remaining = () => listInvites(db(lobby))[0].remaining;
    const host = await client(lobby), room = crypto.randomUUID();
    const signed = await host.signed('create', room, { title: 'Beta', name: 'Alex', label: 'Desktop', invite: code });
    expect(await lobby.execute(signed)).toEqual({ roomId: room });
    expect(await lobby.execute(signed)).toEqual({ roomId: room }); // the same request again: answered from its receipt
    expect(remaining()).toBe(2);
    // A create refused for another reason leaves the code unused, and a use taken in a transaction that fails is rolled back.
    await expect(host.send('create', crypto.randomUUID(), { title: 'Beta', name: '', label: 'Desktop', invite: code })).rejects.toThrow('valid name');
    expect(remaining()).toBe(2);
    expect(() => db(lobby).transaction(() => { expect(consumeInvite(db(lobby), code, Date.now())).toBeUndefined(); throw new Error('later failure'); })()).toThrow('later failure');
    expect(remaining()).toBe(2);
    await create(lobby, code);
    // The service is full: refused before the code is touched.
    expect((await rejected(create(lobby, code))).status).toBe(429);
    expect(remaining()).toBe(1);
  } finally { lobby.close(); }
});

test('SEC-2: without the gate (local development) rooms are created as before; health says which applies', async () => {
  const open = new BrowserLobby(':memory:', { origin });
  const gated = new BrowserLobby(':memory:', { origin, invites: 'required' });
  try {
    await create(open);
    const health = async (lobby: BrowserLobby) => (await browserHandler(lobby, origin, '.')(new Request(`${origin}/api/lobby/health`))).json();
    expect(await health(open)).toMatchObject({ ok: true, inviteRequired: false });
    expect(await health(gated)).toMatchObject({ ok: true, inviteRequired: true });
    // Over HTTP the create form gets the code it can act on.
    const host = await client(gated);
    const response = await browserHandler(gated, origin, '.')(new Request(`${origin}/api/lobby`, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(await host.signed('create', crypto.randomUUID(), { title: 'Beta', name: 'Alex', label: 'Desktop' })) }), '192.0.2.1');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'invite-required' });
  } finally { open.close(); gated.close(); }
});

test('SEC-2: the operator CLI mints, lists without codes, and revokes', () => {
  const store = new BrowserLobby(':memory:', { origin });
  try {
    const out: string[] = [];
    invitesCli(['mint', '--uses', '5', '--days', '14', '--note', 'Beta cohort A'], db(store), line => out.push(line));
    const code = /Code \(shown only now\): (\S+)/.exec(out.join('\n'))![1];
    const id = /^Invite ([a-f0-9]{8}):/.exec(out[0])![1];
    expect(out[0]).toContain('5 users'); expect(out[0]).toContain('Beta cohort A');
    out.length = 0;
    invitesCli(['list'], db(store), line => out.push(line));
    expect(out[0]).toStartWith(`${id}\tactive\t0/5 used`); expect(out.join('\n')).not.toContain(code);
    invitesCli(['revoke', id], db(store), line => out.push(line));
    expect(() => invitesCli(['revoke', id], db(store))).toThrow('No active invite');
    out.length = 0;
    invitesCli(['list'], db(store), line => out.push(line));
    expect(out[0]).toContain('revoked');
    expect(() => invitesCli(['bogus'], db(store))).toThrow('Usage');
  } finally { store.close(); }
});

test('a beta invite admits a person once, across rooms, expiry and a service restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshrooms-beta-')), path = join(dir, 'admission.sqlite');
  let now = Date.now(), lobby = new BrowserLobby(path, { origin, invites: 'required', now: () => now });
  try {
    const invite = mintInvite(db(lobby), { uses: 1, days: 1, now });
    const host = await client(lobby, () => now), first = crypto.randomUUID();
    expect(await host.send('creation-status', first)).toMatchObject({ admitted: false });
    await host.send('create', first, { title: 'First', name: 'Alex', label: 'Browser', invite: invite.code });
    await host.send('create', crypto.randomUUID(), { title: 'Second', name: 'Alex', label: 'Browser' });
    expect(listInvites(db(lobby))[0].remaining).toBe(0);
    await host.send('close', first);
    now += 2 * DAY;
    lobby.close(); lobby = new BrowserLobby(path, { origin, invites: 'required', now: () => now });
    expect(await lobby.execute(await host.signed('creation-status', crypto.randomUUID()))).toMatchObject({ admitted: true });
    await lobby.execute(await host.signed('create', crypto.randomUUID(), { title: 'Third', name: 'Alex', label: 'Browser' }));
    // A name, guest admission or knowledge of a used code cannot impersonate an admitted person.
    expect((await rejected(create(lobby, undefined, () => now))).code).toBe('invite-required');
    expect((await rejected(create(lobby, invite.code, () => now))).code).toBe('invite-expired');
  } finally { lobby.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a revoked person stays revoked across a service restart, until they redeem a new invite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshrooms-beta-revoke-')), path = join(dir, 'admission.sqlite');
  let lobby = new BrowserLobby(path, { origin, invites: 'required' });
  const on = async (device: TestClient, action: Parameters<TestClient['signed']>[0], payload = {}) => lobby.execute(await device.signed(action, crypto.randomUUID(), payload));
  try {
    const { code } = mintInvite(db(lobby), { uses: 1, days: 1 });
    const host = await client(lobby), comp = await client(lobby), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Beta', name: 'Alex', label: 'Browser', invite: code });
    await comp.send('request', room, { kind: 'companion', name: 'Alex', label: 'Desktop' });
    await host.send('link', room, { code: (await comp.status(room)).request!.code });
    expect(revokeBetaPerson(db(lobby), betaPerson(db(lobby), (await host.status(room)).deviceId)!)).toBe(2);
    // The restart re-admits hosts of existing rooms from before invites, but not a host the operator revoked.
    lobby.close(); lobby = new BrowserLobby(path, { origin, invites: 'required' });
    expect(await on(host, 'creation-status')).toMatchObject({ admitted: false });
    expect(await on(comp, 'creation-status')).toMatchObject({ admitted: false });
    expect(listBetaPeople(db(lobby))).toHaveLength(0);
    // A new invite gives the person back room creation, and that survives the next restart.
    const again = mintInvite(db(lobby), { uses: 1, days: 1 });
    await on(host, 'create', { title: 'Back', name: 'Alex', label: 'Browser', invite: again.code });
    lobby.close(); lobby = new BrowserLobby(path, { origin, invites: 'required' });
    expect(await on(host, 'creation-status')).toMatchObject({ admitted: true });
    expect(await on(comp, 'creation-status')).toMatchObject({ admitted: true });
  } finally { lobby.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('only a linked human companion inherits beta admission, never a guest or an agent', async () => {
  const lobby = new BrowserLobby(':memory:', { origin, invites: 'required' });
  try {
    const { code } = mintInvite(db(lobby), { uses: 1, days: 1 });
    const host = await client(lobby), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Beta', name: 'Alex', label: 'Browser', invite: code });
    const companion = await client(lobby), guest = await client(lobby), agent = await client(lobby);
    await companion.send('request', room, { kind: 'companion', name: 'Alex', label: 'Desktop' });
    const waiting = (await companion.status(room)).request!;
    await host.send('link', room, { code: waiting.code });
    expect(await companion.send('creation-status', crypto.randomUUID())).toMatchObject({ admitted: true });
    await companion.send('create', crypto.randomUUID(), { title: 'From desktop', name: 'Alex', label: 'Desktop' });
    await guest.send('request', room, { kind: 'person', name: 'Alex guest', label: 'Browser' });
    const request = (await host.status(room)).requests!.find(r => r.name === 'Alex guest')!;
    await host.send('decide', room, { requestId: request.id, admit: true });
    expect(await guest.send('creation-status', crypto.randomUUID())).toMatchObject({ admitted: false });
    const link = await host.send('agent-invite', room, { name: 'Helper' }) as { token: string };
    await agent.send('agent-redeem', room, { token: link.token, label: 'Agent' });
    expect(await agent.send('creation-status', crypto.randomUUID())).toMatchObject({ admitted: false });
    expect(listInvites(db(lobby))[0].remaining).toBe(0);
  } finally { lobby.close(); }
});

test('existing room hosts keep admission on upgrade, without admitting guests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshrooms-beta-upgrade-')), path = join(dir, 'admission.sqlite');
  let lobby = new BrowserLobby(path, { origin });
  try {
    const host = await client(lobby), guest = await client(lobby), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Before upgrade', name: 'Alex', label: 'Browser' });
    await guest.send('request', room, { kind: 'person', name: 'Guest', label: 'Browser' });
    await host.send('decide', room, { requestId: (await host.status(room)).requests![0].id, admit: true });
    lobby.close(); lobby = new BrowserLobby(path, { origin, invites: 'required' });
    expect(await lobby.execute(await host.signed('creation-status', room))).toMatchObject({ admitted: true });
    expect(await lobby.execute(await guest.signed('creation-status', room))).toMatchObject({ admitted: false });
    await lobby.execute(await host.signed('create', crypto.randomUUID(), { title: 'After upgrade', name: 'Alex', label: 'Browser' }));
  } finally { lobby.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('devices linked before their person redeems an invite inherit admission without another code', async () => {
  const lobby = new BrowserLobby(':memory:', { origin, invites: 'required' });
  try {
    const hostInvite = mintInvite(db(lobby), { uses: 1, days: 1 });
    const host = await client(lobby), guest = await client(lobby), companion = await client(lobby), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Existing room', name: 'Host', label: 'Browser', invite: hostInvite.code });
    await guest.send('request', room, { kind: 'person', name: 'Guest', label: 'Browser' });
    await host.send('decide', room, { requestId: (await host.status(room)).requests![0].id, admit: true });
    await companion.send('request', room, { kind: 'companion', name: 'Guest', label: 'Desktop' });
    await guest.send('link', room, { code: (await companion.status(room)).request!.code });
    expect(await companion.send('creation-status', room)).toMatchObject({ admitted: false });
    const invite = mintInvite(db(lobby), { uses: 1, days: 1 });
    await guest.send('create', crypto.randomUUID(), { title: 'Guest becomes creator', name: 'Guest', label: 'Browser', invite: invite.code });
    expect(await companion.send('creation-status', room)).toMatchObject({ admitted: true });
    await companion.send('create', crypto.randomUUID(), { title: 'Linked desktop', name: 'Guest', label: 'Desktop' });
    expect(listInvites(db(lobby)).every(i => i.remaining === 0)).toBe(true);
  } finally { lobby.close(); }
});

test('the 8-room hosting cap applies per admitted person across linked and removed companions', async () => {
  const lobby = new BrowserLobby(':memory:', { origin, invites: 'required' });
  try {
    const invite = mintInvite(db(lobby), { uses: 2, days: 1 });
    const d1 = await client(lobby), d2 = await client(lobby), d3 = await client(lobby), other = await client(lobby);
    const first = crypto.randomUUID();
    await d1.send('create', first, { title: 'Room 1', name: 'Alex', label: 'Browser', invite: invite.code });
    // Link d2 and d3 as Alex's companions in Room 1, then remove d1 from Room 1 so d1 is no longer active there.
    for (const [comp, label] of [[d2, 'Desktop'], [d3, 'Laptop']] as const) {
      await comp.send('request', first, { kind: 'companion', name: 'Alex', label });
      await d1.send('link', first, { code: (await comp.status(first)).request!.code });
    }
    await d2.send('remove', first, { deviceId: (await d1.status(first)).deviceId });
    // d1 creates 3 more rooms (total 4 across Alex) and d2 creates 4 more (total 8 across Alex).
    for (let i = 2; i <= 4; i++) await d1.send('create', crypto.randomUUID(), { title: `Room ${i}`, name: 'Alex', label: 'Browser' });
    for (let i = 5; i <= 8; i++) await d2.send('create', crypto.randomUUID(), { title: `Room ${i}`, name: 'Alex', label: 'Desktop' });
    // Neither d1, d2 nor d3 (which hosts 0 rooms directly!) can create a 9th room for Alex.
    for (const dev of [d1, d2, d3]) {
      const err = await rejected(dev.send('create', crypto.randomUUID(), { title: 'Too many', name: 'Alex', label: 'Device' }));
      expect(err.status).toBe(429); expect(err.message).toContain('eight rooms');
    }
    // Closing one of Alex's rooms frees a slot for any of Alex's devices; another admitted person has their own cap.
    await d2.send('close', first);
    await d3.send('create', crypto.randomUUID(), { title: 'Replacement 8th', name: 'Alex', label: 'Laptop' });
    expect((await rejected(d1.send('create', crypto.randomUUID(), { title: 'Still 9th', name: 'Alex', label: 'Browser' }))).status).toBe(429);
    await other.send('create', crypto.randomUUID(), { title: 'Other person', name: 'Sam', label: 'Browser', invite: invite.code });
  } finally { lobby.close(); }
});

test('beta_admissions caps distinct devices per person and never mints unlimited creator keys', async () => {
  const lobby = new BrowserLobby(':memory:', { origin, invites: 'required' });
  try {
    const { code } = mintInvite(db(lobby), { uses: 1, days: 1 });
    const host = await client(lobby), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Primary', invite: code });
    const hostId = (await host.status(room)).deviceId;
    const person = betaPerson(db(lobby), hostId)!;
    const admitted: Awaited<ReturnType<typeof client>>[] = [host];
    // Link companions until BETA_DEVICES_PER_PERSON distinct devices are admitted (removing earlier ones from the room
    // to stay within DEVICES_PER_MEMBER = 4 in this room).
    for (let i = 1; i < BETA_DEVICES_PER_PERSON; i++) {
      const comp = await client(lobby);
      await comp.send('request', room, { kind: 'companion', name: 'Alex', label: `Comp ${i}` });
      await host.send('link', room, { code: (await comp.status(room)).request!.code });
      const compId = (await comp.status(room)).deviceId;
      expect(betaPerson(db(lobby), compId)).toBe(person);
      expect(await comp.send('creation-status', room)).toMatchObject({ admitted: true });
      admitted.push(comp);
      await host.send('remove', room, { deviceId: compId });
    }
    expect(listBetaPeople(db(lobby))).toEqual([{ id: person, devices: BETA_DEVICES_PER_PERSON, admittedAt: expect.any(Number) }]);

    // The 9th distinct device can still join the room as a companion, but gets NO beta admission row.
    const ninth = await client(lobby);
    await ninth.send('request', room, { kind: 'companion', name: 'Alex', label: 'Ninth' });
    await host.send('link', room, { code: (await ninth.status(room)).request!.code });
    const ninthId = (await ninth.status(room)).deviceId;
    expect(betaPerson(db(lobby), ninthId)).toBeUndefined();
    expect(await ninth.send('creation-status', room)).toMatchObject({ admitted: false });
    expect((await rejected(ninth.send('create', crypto.randomUUID(), { title: 'Blocked', name: 'Alex', label: 'Ninth' }))).code).toBe('invite-required');
    expect(listBetaPeople(db(lobby))[0].devices).toBe(BETA_DEVICES_PER_PERSON);

    // Even if host removes itself leaving only un-admitted ninth as host of `room`, `room` still counts toward Alex's 8-room cap.
    await ninth.send('remove', room, { deviceId: hostId });
    for (let i = 2; i <= 8; i++) await admitted[1].send('create', crypto.randomUUID(), { title: `Room ${i}`, name: 'Alex', label: 'Comp 1' });
    expect((await rejected(host.send('create', crypto.randomUUID(), { title: 'Room 9', name: 'Alex', label: 'Primary' }))).status).toBe(429);
  } finally { lobby.close(); }
});

test('operators can list admitted people and revoke a person across all linked devices via API and CLI', async () => {
  const lobby = new BrowserLobby(':memory:', { origin, invites: 'required' });
  try {
    const out: string[] = [];
    invitesCli(['people'], db(lobby), line => out.push(line));
    expect(out).toEqual(['No admitted people.']);

    const { code } = mintInvite(db(lobby), { uses: 2, days: 1 });
    const host = await client(lobby), comp = await client(lobby), other = await client(lobby), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Beta', name: 'Alex', label: 'Browser', invite: code });
    await comp.send('request', room, { kind: 'companion', name: 'Alex', label: 'Desktop' });
    await host.send('link', room, { code: (await comp.status(room)).request!.code });
    await other.send('create', crypto.randomUUID(), { title: 'Other', name: 'Sam', label: 'Browser', invite: code });

    const alexPerson = betaPerson(db(lobby), (await host.status(room)).deviceId)!;
    const people = listBetaPeople(db(lobby));
    expect(people).toHaveLength(2);
    expect(people.find(p => p.id === alexPerson)).toMatchObject({ id: alexPerson, devices: 2 });

    out.length = 0;
    invitesCli(['people'], db(lobby), line => out.push(line));
    expect(out.join('\n')).toContain(`${alexPerson}\t2 devices\tadmitted `);
    expect(out.join('\n')).not.toContain(code);

    out.length = 0;
    invitesCli(['revoke-person', alexPerson], db(lobby), line => out.push(line));
    expect(out).toEqual([`Revoked ${alexPerson} (2 devices).`]);
    expect(revokeBetaPerson(db(lobby), alexPerson)).toBe(0);
    expect(() => invitesCli(['revoke-person', alexPerson], db(lobby))).toThrow('No admitted person');

    // Both of Alex's devices lost creation admission; Sam keeps theirs.
    expect(await host.send('creation-status', room)).toMatchObject({ admitted: false });
    expect(await comp.send('creation-status', room)).toMatchObject({ admitted: false });
    expect((await rejected(host.send('create', crypto.randomUUID(), { title: 'After revoke', name: 'Alex', label: 'Browser' }))).code).toBe('invite-required');
    expect((await rejected(comp.send('create', crypto.randomUUID(), { title: 'After revoke', name: 'Alex', label: 'Desktop' }))).code).toBe('invite-required');
    expect(await other.send('creation-status', crypto.randomUUID())).toMatchObject({ admitted: true });
    expect(listBetaPeople(db(lobby))).toHaveLength(1);
  } finally { lobby.close(); }
});

test('LIFE-4: transferring host updates rooms.owner_person atomically to the new host\'s beta identity (or clears it)', async () => {
  const lobby = new BrowserLobby(':memory:', { origin, invites: 'required' });
  try {
    const { code } = mintInvite(db(lobby), { uses: 2, days: 1 });
    const alex = await client(lobby), sam = await client(lobby), guest = await client(lobby);
    const room = crypto.randomUUID();
    await alex.send('create', room, { title: 'Owned', name: 'Alex', label: 'Browser', invite: code });
    await sam.send('create', crypto.randomUUID(), { title: 'Sam room', name: 'Sam', label: 'Browser', invite: code });
    await sam.send('request', room, { name: 'Sam', label: 'Browser', kind: 'person' });
    await guest.send('request', room, { name: 'Guest', label: 'Browser', kind: 'person' });
    for (const r of (await alex.status(room)).requests!) await alex.send('decide', room, { requestId: r.id, admit: true });

    const alexPerson = betaPerson(db(lobby), (await alex.status(room)).deviceId)!;
    const samPerson = betaPerson(db(lobby), (await sam.status(room)).deviceId)!;
    expect(db(lobby).query('SELECT owner_person FROM rooms WHERE id=?').get(room)).toEqual({ owner_person: alexPerson });

    // Transfer to beta-admitted Sam -> owner_person becomes Sam's beta person.
    await alex.send('transfer-host', room, { memberId: (await sam.status(room)).memberId! });
    expect(db(lobby).query('SELECT owner_person FROM rooms WHERE id=?').get(room)).toEqual({ owner_person: samPerson });

    // Transfer to non-beta Guest -> owner_person clears to null.
    await sam.send('transfer-host', room, { memberId: (await guest.status(room)).memberId! });
    expect(db(lobby).query('SELECT owner_person FROM rooms WHERE id=?').get(room)).toEqual({ owner_person: null });
  } finally { lobby.close(); }
});
