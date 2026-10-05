// Pairing in the room service (src/browser/pairing.ts): the browser holds a secret N; the app's companion request in a
// room carries a proof, HMAC(N, the room, the app's own key and the browser device that may link it); the browser links each of its rooms with N.
import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { PAIRING_NOT_FOUND, deviceId, type JoinRequest } from '../../src/browser/protocol';
import { pairingMessage } from '../../src/browser/pairing';
import { BrowserLobby, LINK_FAILURES, LINK_FAILURE_WINDOW, WAITING_PER_ADDRESS, WAITING_PER_KIND } from './lobby';
import { admitPerson, client, type TestClient } from './test-client';

const origin = 'http://127.0.0.1:4320';
const secret = () => crypto.getRandomValues(new Uint8Array(32));
const n64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const keyOf = async (device: TestClient) => (await device.signed('status', crypto.randomUUID())).publicKey;
/** The proof `device` sends in `room` for the secret `n`, as the app makes it. */
const proof = async (n: Uint8Array, room: string, device: TestClient, linker: TestClient) =>
  createHmac('sha256', n).update(pairingMessage(room, await keyOf(device), await deviceId(await keyOf(linker)))).digest('hex');
const ask = async (device: TestClient, room: string, pairing: string, extra: Record<string, unknown> = {}) =>
  device.send('request', room, { name: 'Companion device', label: 'Meshrooms app', kind: 'companion', pairing, ...extra });
/** The error's machine-readable code, or its message, or 'ok'. */
const outcome = async (work: Promise<unknown>) => { try { await work; return 'ok'; } catch (error) { return (error as { code?: string }).code ?? (error as Error).message; } };
async function roomWithSam(now?: () => number) {
  const lobby = new BrowserLobby(':memory:', { origin, ...(now ? { now } : {}) });
  const host = await client(lobby, now), room = crypto.randomUUID();
  await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });
  const sam = await admitPerson(lobby, host, room, 'Sam', now);
  return { lobby, host, room, sam, samId: (await sam.status(room)).memberId! };
}

test('the right secret links the app at once, and the proof is shown to nobody, the app included', async () => {
  const { lobby, host, room, sam, samId } = await roomWithSam();
  try {
    const app = await client(lobby), n = secret(), value = await proof(n, room, app, sam);
    await ask(app, room, value);
    // Not to the host, not to a member, not to the device that sent it.
    for (const viewer of [host, sam, app]) {
      const seen = JSON.stringify(await viewer.status(room));
      expect(seen).not.toContain(value);
      expect(seen).not.toContain('"pairing"');
    }
    expect((await app.status(room)).request!.code).toBeUndefined();
    // The person (not the host) links it with N: admitted at once, as their own device.
    expect(await sam.send('link', room, { pairing: n64(n) })).toEqual({ roomId: room, admitted: true });
    expect((await app.status(room)).memberId).toBe(samId);
    // Single use: N links nothing again.
    expect(await outcome(sam.send('link', room, { pairing: n64(n) }))).toBe(PAIRING_NOT_FOUND);
  } finally { lobby.close(); }
});

test('a proof copied by another device, or into another room, links nothing; two that match link neither', async () => {
  const { lobby, room, sam, samId } = await roomWithSam();
  try {
    const app = await client(lobby), attacker = await client(lobby), n = secret(), value = await proof(n, room, app, sam);
    // The attacker files the app's proof first, with its own key; the browser's link still finds only the app.
    await ask(attacker, room, value);
    await ask(app, room, value);
    expect(await sam.send('link', room, { pairing: n64(n) })).toEqual({ roomId: room, admitted: true });
    expect((await app.status(room)).memberId).toBe(samId);
    expect((await attacker.status(room)).memberId).toBeUndefined();
    // With only the copy left, N links nothing.
    expect(await outcome(sam.send('link', room, { pairing: n64(n) }))).toBe(PAIRING_NOT_FOUND);
    expect((await attacker.status(room)).memberId).toBeUndefined();

    // The app's proof for this room, filed by the app in another room of Sam's, matches nothing there.
    const other = crypto.randomUUID(), app2 = await client(lobby), m = secret();
    await sam.send('create', other, { title: 'Other', name: 'Sam', label: 'Laptop' });
    await ask(app2, other, await proof(m, room, app2, sam));
    expect(await outcome(sam.send('link', other, { pairing: n64(m) }))).toBe(PAIRING_NOT_FOUND);
    expect((await app2.status(other)).memberId).toBeUndefined();

    // Two waiting requests that both answer one secret (only a bug, or a key copied with its proof, could make them):
    // ambiguity links neither.
    const twin = await client(lobby), k = secret();
    await ask(twin, room, await proof(k, room, twin, sam));
    const db = (lobby as unknown as { db: Database }).db;
    const stored = JSON.parse((db.query('SELECT body FROM rooms WHERE id=?').get(room) as { body: string }).body) as { requests: JoinRequest[] };
    const twinKey = await keyOf(twin), original = stored.requests.find(r => r.device.publicKey === twinKey)!;
    stored.requests.push({ ...original, id: crypto.randomUUID(), device: { ...original.device, id: 'f'.repeat(64) } });
    db.query('UPDATE rooms SET body=? WHERE id=?').run(JSON.stringify(stored), room);
    expect(await outcome(sam.send('link', room, { pairing: n64(k) }))).toBe('More than one device answers this pairing, so none was linked. Pair again.');
    expect((await twin.status(room)).memberId).toBeUndefined();
  } finally { lobby.close(); }
});

test('every link that matches nothing counts, per linking device and room, and the budget comes back after the window', async () => {
  let now = Date.now();
  const { lobby, host, room, sam, samId } = await roomWithSam(() => now);
  try {
    // Nothing waiting at all: still counted, so the browser never polls by linking.
    for (let i = 0; i < LINK_FAILURES; i++) expect(await outcome(sam.send('link', room, { pairing: n64(secret()) }))).toBe(PAIRING_NOT_FOUND);
    const app = await client(lobby, () => now), n = secret();
    await ask(app, room, await proof(n, room, app, sam));
    await expect(sam.send('link', room, { pairing: n64(n) })).rejects.toThrow('Too many wrong device codes');
    // Another person's budget is their own.
    expect(await outcome(host.send('link', room, { pairing: n64(secret()) }))).toBe(PAIRING_NOT_FOUND);
    now += LINK_FAILURE_WINDOW + 1;
    await ask(app, room, await proof(n, room, app, sam));
    expect(await sam.send('link', room, { pairing: n64(n) })).toEqual({ roomId: room, admitted: true });
    expect((await app.status(room)).memberId).toBe(samId);
  } finally { lobby.close(); }
});

test('a flood fills the companions\' share at most 8 per address; the app is told the room is full, and the host clears it', async () => {
  const { lobby, host, room, sam, samId } = await roomWithSam();
  try {
    const from = async (address: string, device: TestClient, payload: Record<string, unknown>) => lobby.execute(await device.signed('request', room, payload), address);
    const app = await client(lobby), n = secret(), value = await proof(n, room, app, sam);
    const fake = (i: number) => ({ name: 'Companion device', label: 'Meshrooms app', kind: 'companion', pairing: i % 2 ? value : Buffer.from(secret()).toString('hex') });
    // One address fills at most WAITING_PER_ADDRESS places, whatever keys it makes.
    for (let i = 0; i < WAITING_PER_ADDRESS; i++) await from('192.0.2.1', await client(lobby), fake(i));
    await expect(from('192.0.2.1', await client(lobby), fake(0))).rejects.toThrow('Too many requests from your network');
    // A second address fills the rest of the companions' 16 (some copy the app's proof); people still have their share.
    for (let i = 0; i < WAITING_PER_KIND - WAITING_PER_ADDRESS; i++) await from('192.0.2.2', await client(lobby), fake(i));
    await from('192.0.2.3', await client(lobby), { name: 'Pat', label: 'Laptop', kind: 'person' });
    // The honest app is told, plainly, that the waiting room is full.
    await expect(from('198.51.100.7', app, { name: 'Companion device', label: 'Meshrooms app', kind: 'companion', pairing: value })).rejects.toThrow('waiting room is full');
    // The host clears the waiting room; the app then asks, and the flood cost the person nothing: they may still miss
    // all but one of their tries, and the right secret then links the app (never a copy of its proof).
    for (const request of (await host.status(room)).requests!.filter(r => r.kind === 'companion')) await host.send('decide', room, { requestId: request.id, admit: false });
    await from('198.51.100.7', app, { name: 'Companion device', label: 'Meshrooms app', kind: 'companion', pairing: value });
    for (let i = 0; i < LINK_FAILURES - 1; i++) expect(await outcome(sam.send('link', room, { pairing: n64(secret()) }))).toBe(PAIRING_NOT_FOUND);
    expect(await sam.send('link', room, { pairing: n64(n) })).toEqual({ roomId: room, admitted: true });
    expect((await app.status(room)).memberId).toBe(samId);
  } finally { lobby.close(); }
});

test('only the browser device the pairing named can link it, even another person holding the secret', async () => {
  const { lobby, host, room, sam, samId } = await roomWithSam();
  try {
    const app = await client(lobby), n = secret();
    await ask(app, room, await proof(n, room, app, sam));
    // The host, and another of Sam's own devices, hold N but are not the browser the link named.
    const m = secret(), other = await client(lobby);
    await ask(other, room, await proof(m, room, other, sam));
    await sam.send('link', room, { pairing: n64(m) });
    expect((await other.status(room)).memberId).toBe(samId);
    expect(await outcome(host.send('link', room, { pairing: n64(n) }))).toBe(PAIRING_NOT_FOUND);
    expect(await outcome(other.send('link', room, { pairing: n64(n) }))).toBe(PAIRING_NOT_FOUND);
    expect((await app.status(room)).memberId).toBeUndefined();
    expect(await sam.send('link', room, { pairing: n64(n) })).toEqual({ roomId: room, admitted: true });
    expect((await app.status(room)).memberId).toBe(samId);
  } finally { lobby.close(); }
});

test('one secret covers each room whose request carries a proof of it, host or not', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  try {
    const host = await client(lobby), sam = await client(lobby), app = await client(lobby), n = secret();
    const [first, second] = [crypto.randomUUID(), crypto.randomUUID()];
    await host.send('create', first, { title: 'Hosted by Alex', name: 'Alex', label: 'Desktop' });
    await sam.send('request', first, { name: 'Sam', label: 'Laptop', kind: 'person' });
    await host.send('decide', first, { requestId: (await host.status(first)).requests![0].id, admit: true });
    await sam.send('create', second, { title: 'Hosted by Sam', name: 'Sam', label: 'Laptop' });
    for (const room of [first, second]) await ask(app, room, await proof(n, room, app, sam));
    // Sam isn't the host of the first room: N alone admits there, as in the room Sam hosts.
    for (const room of [first, second]) expect(await sam.send('link', room, { pairing: n64(n) })).toEqual({ roomId: room, admitted: true });
    expect((await app.status(first)).memberId).toBe((await sam.status(first)).memberId!);
    expect((await app.status(second)).memberId).toBe((await sam.status(second)).memberId!);
  } finally { lobby.close(); }
});

test('agents, waiting devices and outsiders can\'t link by a secret, and the host keeps its say', async () => {
  const { lobby, host, room, sam } = await roomWithSam();
  try {
    await host.send('settings', room, { guestAgentApproval: false });
    const { token } = await sam.send('agent-invite', room, { name: 'Codex' }) as { token: string };
    const agent = await client(lobby), stranger = await client(lobby);
    await agent.send('agent-redeem', room, { token, label: 'Agent node' });
    const app = await client(lobby), n = secret();
    await ask(app, room, await proof(n, room, app, sam));
    await expect(agent.send('link', room, { pairing: n64(n) })).rejects.toThrow('Only people');
    await expect(stranger.send('link', room, { pairing: n64(n) })).rejects.toThrow('existing device');
    await expect(app.send('link', room, { pairing: n64(n) })).rejects.toThrow('existing device');
    expect((await app.status(room)).memberId).toBeUndefined();
    // With hostApprovesDevices, the person's link only confirms the device: it waits for the host, and N is spent.
    await host.send('settings', room, { hostApprovesDevices: true });
    expect(await sam.send('link', room, { pairing: n64(n) })).toEqual({ roomId: room, admitted: false });
    expect(await outcome(host.send('link', room, { pairing: n64(n) }))).toBe(PAIRING_NOT_FOUND);
    await host.send('decide', room, { requestId: (await app.status(room)).request!.id, admit: true });
    expect((await app.status(room)).memberId).toBe((await sam.status(room)).memberId!);
    // A device the host removed waits for the host again, even when paired.
    await host.send('settings', room, { hostApprovesDevices: false });
    await host.send('remove', room, { deviceId: (await app.status(room)).deviceId });
    const again = secret();
    await ask(app, room, await proof(again, room, app, sam));
    expect(await sam.send('link', room, { pairing: n64(again) })).toEqual({ roomId: room, admitted: false });
    expect((await app.status(room)).memberId).toBeUndefined();
  } finally { lobby.close(); }
});

test('a request carries a code or a proof, never both, and neither check stands in for the other', async () => {
  const { lobby, room, sam } = await roomWithSam();
  try {
    const n = secret(), app = await client(lobby), phone = await client(lobby), value = await proof(n, room, app, sam);
    // Only a companion request carries a proof, and only a well-formed one.
    for (const payload of [{ kind: 'person' }, { pairing: 'not a proof' }, { pairing: value.toUpperCase() }, { pairing: 42 }])
      await expect(ask(app, room, value, payload)).rejects.toThrow('pairing');
    // A code request and a pairing request (whose own `code` field is ignored): each gets only its own secret.
    await phone.send('request', room, { name: 'Companion device', label: 'Phone', kind: 'companion' });
    const code = (await phone.status(room)).request!.code!;
    await ask(app, room, value, { code: 'ffffffffffffffff' });
    expect((await app.status(room)).request!.code).toBeUndefined();
    await expect(sam.send('link', room, { code: 'ffffffffffffffff' })).rejects.toThrow('not found');
    // A proof is not a secret, and both at once is refused outright, whatever each would match.
    await expect(sam.send('link', room, { pairing: value })).rejects.toThrow('not valid');
    await expect(sam.send('link', room, { code, pairing: n64(n) })).rejects.toThrow('not both');
    // Malformed secrets are refused before any lookup: not 32 bytes, not the canonical spelling, not text.
    for (const bad of [n64(n).slice(1), n64(new Uint8Array(31)), `${n64(n)}A`, 42, null]) await expect(sam.send('link', room, { pairing: bad })).rejects.toThrow('not valid');
    expect((await app.status(room)).memberId).toBeUndefined();
    expect((await phone.status(room)).memberId).toBeUndefined();
    // Each with its own secret, both link.
    await sam.send('link', room, { pairing: n64(n) });
    await sam.send('link', room, { code });
    expect((await app.status(room)).memberId).toBeDefined();
    expect((await phone.status(room)).memberId).toBeDefined();
  } finally { lobby.close(); }
});

test('a device asking again with a new proof replaces its waiting request; the same proof changes nothing', async () => {
  const { lobby, host, room, sam } = await roomWithSam();
  try {
    const app = await client(lobby), old = secret(), n = secret();
    await app.send('request', room, { name: 'Companion device', label: 'Meshrooms app', kind: 'companion' });
    expect((await app.status(room)).request!.code).toBeDefined();
    await ask(app, room, await proof(old, room, app, sam));
    expect((await app.status(room)).request!.code).toBeUndefined();
    await ask(app, room, await proof(n, room, app, sam));
    const id = (await app.status(room)).request!.id;
    await ask(app, room, await proof(n, room, app, sam));
    expect((await app.status(room)).request!.id).toBe(id);
    expect((await host.status(room)).requests!.filter(r => r.device.label === 'Meshrooms app')).toHaveLength(1);
    expect(await outcome(sam.send('link', room, { pairing: n64(old) }))).toBe(PAIRING_NOT_FOUND);
    await sam.send('link', room, { pairing: n64(n) });
    expect((await app.status(room)).memberId).toBe((await sam.status(room)).memberId!);
  } finally { lobby.close(); }
});
