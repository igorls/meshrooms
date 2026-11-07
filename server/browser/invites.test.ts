import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserLobby, LobbyError } from './lobby';
import { browserHandler } from './http';
import { consumeInvite, invitesCli, listInvites, mintInvite, normalizeInvite, revokeInvite } from './invites';
import { client, testOrigin as origin } from './test-client';

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
