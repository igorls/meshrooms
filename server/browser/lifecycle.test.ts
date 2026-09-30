import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { BrowserLobby, LobbyError } from './lobby';
import { browserHandler } from './http';
import { roomsCli } from './rooms';
import { listRooms, openAdmission } from './store';
import { admitPerson, client, testOrigin as origin } from './test-client';
import { BrowserAgent, runBridge } from '../browser-agent';
import type { RoomStatus } from '../../src/browser/protocol';

const DAY = 86_400_000;
const create = (host: Awaited<ReturnType<typeof client>>, room: string, title = 'Work') => host.send('create', room, { title, name: 'Alex', label: 'Desktop' });
async function rejected(work: Promise<unknown>): Promise<LobbyError> {
  try { await work; } catch (error) { return error as LobbyError; }
  throw new Error('expected a rejection');
}
/** Just enough of a PNG for type and size detection. */
function png(width: number, height: number) {
  const bytes = new Uint8Array(40);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width); new DataView(bytes.buffer).setUint32(20, height);
  return Buffer.from(bytes).toString('base64');
}
function tempDir() {
  const path = mkdtempSync(join(tmpdir(), 'mr-lifecycle-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

test('LIFE-3: the service-wide room cap comes from options, 256 by default', async () => {
  const small = new BrowserLobby(':memory:', { origin, maxRooms: 2 });
  try {
    for (let i = 0; i < 2; i++) await create(await client(small), crypto.randomUUID());
    const full = await rejected(create(await client(small), crypto.randomUUID()));
    expect(full.status).toBe(429); expect(full.message).toContain('full');
  } finally { small.close(); }
  const lobby = new BrowserLobby(':memory:', { origin });
  try {
    // The old hard-coded 64 no longer applies (eight rooms per host device still does).
    for (let i = 0; i < 70; i++) await create(await client(lobby), crypto.randomUUID());
  } finally { lobby.close(); }
});

test('LIFE-1: only the host closes a room; afterwards every command and the public lookup answer 410 room-closed', async () => {
  const dir = tempDir(), path = join(dir.path, 'admission.sqlite');
  let lobby = new BrowserLobby(path, { origin });
  try {
    const host = await client(lobby), room = crypto.randomUUID();
    await create(host, room);
    const sam = await admitPerson(lobby, host, room, 'Sam'), stranger = await client(lobby);
    await sam.send('profile', room, { avatar: png(32, 32) });
    expect((await host.status(room)).members!.find(m => m.name === 'Sam')!.avatar).toBeDefined();
    expect((await rejected(sam.send('close', room))).message).toContain('Only the host');
    expect((await rejected(stranger.send('close', room))).status).toBe(403);

    const close = await host.signed('close', room);
    expect(await lobby.execute(close)).toEqual({ roomId: room });
    expect(await lobby.execute(close)).toEqual({ roomId: room }); // an uncertain retry is answered from its receipt

    for (const attempt of [() => sam.status(room), () => host.status(room), () => stranger.send('request', room, { name: 'Pat', label: 'Laptop', kind: 'person' }), () => host.send('close', room)]) {
      const error = await rejected(attempt());
      expect(error.status).toBe(410); expect(error.code).toBe('room-closed'); expect(error.message).toBe('This room was closed by its host.');
    }
    expect(() => lobby.publicRoom(room)).toThrow('closed by its host');
    // The same id cannot be created again.
    expect((await rejected(create(await client(lobby), room))).status).toBe(409);

    // Over HTTP the reason code is returned, and it survives a restart.
    lobby.close();
    lobby = new BrowserLobby(path, { origin });
    const response = await browserHandler(lobby, origin, '.')(new Request(`${origin}/api/lobby/rooms/${room}`));
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: 'This room was closed by its host.', code: 'room-closed' });
    const db = new Database(path);
    try {
      expect(db.query('SELECT COUNT(*) AS n FROM rooms').get()).toEqual({ n: 0 });
      expect(db.query('SELECT COUNT(*) AS n FROM avatars').get()).toEqual({ n: 0 });
      expect(db.query('SELECT reason FROM closed_rooms WHERE id=?').get(room)).toEqual({ reason: 'closed' });
    } finally { db.close(); }
  } finally { lobby.close(); dir.cleanup(); }
});

test('LIFE-2: activity is written at most hourly, status shows the expiry, and the sweep removes only idle rooms', async () => {
  const dir = tempDir(), path = join(dir.path, 'admission.sqlite');
  let now = Date.now();
  const lobby = new BrowserLobby(path, { origin, now: () => now, idleDays: 30 });
  const peek = new Database(path);
  const activity = (room: string) => (peek.query('SELECT at FROM room_activity WHERE id=?').get(room) as { at: number } | null)?.at;
  try {
    const host = await client(lobby, () => now), quiet = await client(lobby, () => now), busy = crypto.randomUUID(), idle = crypto.randomUUID();
    await create(host, busy); await create(quiet, idle);
    const created = now;
    expect((await host.status(busy)).expiresAt).toBe(created + 30 * DAY);
    now += 30 * 60_000;
    await host.status(busy);
    expect(activity(busy)).toBe(created); // not rewritten within the hour
    now += 31 * 60_000;
    expect((await host.status(busy)).expiresAt).toBe(now + 30 * DAY);
    expect(activity(busy)).toBe(now);

    // A waiting request is not activity: only admitted devices keep a room.
    now = created + 29 * DAY;
    await (await client(lobby, () => now)).send('request', idle, { name: 'Pat', label: 'Laptop', kind: 'person' });
    await host.status(busy);
    expect(lobby.sweep()).toBe(0);
    now = created + 30 * DAY + 1;
    expect(lobby.sweep()).toBe(1);
    const gone = await rejected(quiet.status(idle));
    expect(gone.status).toBe(410); expect(gone.message).toContain('nobody opened it');
    expect((await host.status(busy)).memberId).toBeDefined();
  } finally { peek.close(); lobby.close(); dir.cleanup(); }
});

test('existing rooms gain an activity record at first start and keep guest agents unapproved, as they were', async () => {
  const dir = tempDir(), path = join(dir.path, 'admission.sqlite');
  try {
    // A production database from before this change: only the three original tables.
    const legacy = new Database(path);
    legacy.exec('CREATE TABLE rooms (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE receipts (device TEXT, id TEXT, body TEXT, result TEXT, at INTEGER, PRIMARY KEY(device,id)); CREATE TABLE avatars (room TEXT, member TEXT, hash TEXT, type TEXT, bytes BLOB, PRIMARY KEY(room,member));');
    const seed = new BrowserLobby(':memory:', { origin });
    const host = await client(seed), room = crypto.randomUUID();
    await create(host, room);
    // The room as it was stored before SEC-12: the same host device, but no stored settings.
    const { settings: _, ...body } = JSON.parse(((seed as unknown as { db: Database }).db.query('SELECT body FROM rooms').get() as { body: string }).body);
    legacy.query('INSERT INTO rooms VALUES (?,?)').run(room, JSON.stringify(body));
    legacy.close(); seed.close();

    const at = Date.now();
    const db = openAdmission(path, at);
    expect(db.query('SELECT at FROM room_activity WHERE id=?').get(room)).toEqual({ at });
    db.close();
    const again = openAdmission(path, at + 5000); // idempotent: a second start changes nothing
    expect(again.query('SELECT at FROM room_activity WHERE id=?').get(room)).toEqual({ at });
    again.close();

    const lobby = new BrowserLobby(path, { origin });
    try {
      // A legacy room keeps letting guests' agents in without approval; a new room asks the host.
      const status = await lobby.execute(await host.signed('status', room, { session: host.session })) as { settings?: { guestAgentApproval: boolean } };
      expect(status.settings?.guestAgentApproval).toBe(false);
      const owner = await client(lobby), fresh = crypto.randomUUID();
      await create(owner, fresh);
      expect((await owner.status(fresh)).settings?.guestAgentApproval).toBe(true);
    } finally { lobby.close(); }
  } finally { dir.cleanup(); }
});

test('operator rooms list and retire work beside the running service', async () => {
  const dir = tempDir(), path = join(dir.path, 'admission.sqlite');
  const lobby = new BrowserLobby(path, { origin });
  const operator = openAdmission(path);
  try {
    const host = await client(lobby), room = crypto.randomUUID(), other = crypto.randomUUID();
    await create(host, room, 'Ops review'); await create(host, other, 'Keep');
    await admitPerson(lobby, host, room, 'Sam');
    const lines: string[] = [];
    roomsCli(['list'], operator, { idleDays: 30, print: line => lines.push(line) });
    expect(lines[0]).toBe('id\ttitle\tmembers\tdevices\tlast active\texpires');
    expect(lines.find(l => l.startsWith(room))).toContain('"Ops review"\t2\t2\t');
    expect(lines.join('\n')).not.toContain('Sam'); // no member names

    expect(() => roomsCli(['retire', 'Ops review'], operator, { idleDays: 30 })).toThrow('exact room UUID');
    expect(() => roomsCli(['retire', crypto.randomUUID()], operator, { idleDays: 30 })).toThrow('No room');
    roomsCli(['retire', room], operator, { idleDays: 30, print: line => lines.push(line) });
    expect(lines.at(-1)).toContain('Retired');
    // The running service sees it on the next request, without a restart.
    const error = await rejected(host.status(room));
    expect(error.status).toBe(410); expect(error.message).toContain('service operator');
    expect((await host.status(other)).memberId).toBeDefined();
    expect(listRooms(operator).map(r => r.id)).toEqual([other]);
  } finally { operator.close(); lobby.close(); dir.cleanup(); }
});

test('SEC-4: TURN credentials name the room, stay stable for a while, last at least an hour, and need two devices', async () => {
  const now = Date.UTC(2026, 8, 29, 12, 0, 7);
  const lobby = new BrowserLobby(':memory:', { origin, now: () => now, stunUrls: ['stun:turn.example:3478'], turnUrls: ['turn:turn.example:3478'], turnSecret: 'secret' });
  try {
    const host = await client(lobby, () => now), room = crypto.randomUUID();
    await create(host, room);
    // Alone in the room: STUN only, nobody to relay to.
    expect((await host.status(room)).iceServers).toEqual([{ urls: ['stun:turn.example:3478'] }]);
    const sam = await admitPerson(lobby, host, room, 'Sam', () => now);
    const [hostTurn, samTurn] = [(await host.status(room)).iceServers![1], (await sam.status(room)).iceServers![1]];
    expect(hostTurn).toEqual(samTurn); // one username per room, not per device
    const [expiry, scope] = String(hostTurn.username).split(':');
    expect(scope).toBe(room);
    expect(Number(expiry) * 1000 - now).toBeGreaterThanOrEqual(3600_000);
    expect(Number(expiry) * 1000 - now).toBeLessThan(3600_000 + 600_000);
    expect(hostTurn.credential).toBe(createHmac('sha1', 'secret').update(String(hostTurn.username)).digest('base64'));
  } finally { lobby.close(); }
});

test('the agent bridge stops when its room is closed, instead of retrying', async () => {
  const dir = tempDir();
  try {
    const agent = new BrowserAgent(dir.path, 'http://127.0.0.1:1', crypto.randomUUID());
    let calls = 0; const lines: string[] = [];
    agent.command = async () => {
      calls++;
      // A passing outage is retried; a closed room is final.
      throw Object.assign(new Error(calls === 1 ? 'Cannot reach the room service.' : 'This room was closed by its host.'), { status: calls === 1 ? 503 : 410 });
    };
    await expect(runBridge(agent, line => lines.push(line))).rejects.toThrow('closed by its host');
    expect(calls).toBe(2);
    expect(lines.some(l => l.includes('Cannot reach'))).toBe(true);
  } finally { dir.cleanup(); }
});

test('LIFE-2: time the service was down is not idle time: a 40-day outage removes nothing', async () => {
  const dir = tempDir(), path = join(dir.path, 'admission.sqlite');
  const t0 = Date.UTC(2026, 0, 1);
  let now = t0;
  try {
    // A clean stop records when the service went down.
    let lobby = new BrowserLobby(path, { origin, now: () => now });
    const host = await client(lobby, () => now), room = crypto.randomUUID();
    await create(host, room);
    now = t0 + 29 * DAY + 12 * 3_600_000;
    lobby.close();
    now += 40 * DAY;
    lobby = new BrowserLobby(path, { origin, now: () => now });
    expect(lobby.sweep()).toBe(0);
    const back = await lobby.execute(await host.signed('status', room, { session: host.session })) as RoomStatus;
    expect(back.memberId).toBeDefined();
    const other = crypto.randomUUID();
    await lobby.execute(await host.signed('create', other, { title: 'Quiet', name: 'Alex', label: 'Desktop' }));
    now += 2 * 3_600_000;
    lobby.sweep(); // the hourly heartbeat
    // A crash leaves no clean stop: the last heartbeat is the reference.
    (lobby as unknown as { db: Database }).db.close();
    now += 40 * DAY;
    lobby = new BrowserLobby(path, { origin, now: () => now });
    expect(lobby.sweep()).toBe(0);
    // Idle time while running still counts.
    now += 30 * DAY;
    expect(lobby.sweep()).toBe(2);
    lobby.close();
  } finally { dir.cleanup(); }
});

test('LIFE-1: closed room ids are kept for good, so an old link can never lead to someone else’s room', async () => {
  let now = Date.now();
  const lobby = new BrowserLobby(':memory:', { origin, now: () => now });
  try {
    const host = await client(lobby, () => now), room = crypto.randomUUID();
    await create(host, room);
    await host.send('close', room);
    now += 3 * 365 * DAY;
    lobby.sweep();
    expect((await rejected(host.status(room))).status).toBe(410);
    expect((await rejected(create(await client(lobby, () => now), room))).message).toContain('already exists');
  } finally { lobby.close(); }
});

test('LIFE-2: activity from a command that fails is not remembered, and short idle periods write more often', async () => {
  const dir = tempDir(), path = join(dir.path, 'admission.sqlite');
  let now = Date.now();
  const lobby = new BrowserLobby(path, { origin, now: () => now });
  const peek = new Database(path);
  const activity = (room: string) => (peek.query('SELECT at FROM room_activity WHERE id=?').get(room) as { at: number }).at;
  try {
    const host = await client(lobby, () => now), room = crypto.randomUUID();
    await create(host, room);
    const created = now;
    now += 2 * 3_600_000;
    await expect(host.send('settings', room, { floor: 'loud' })).rejects.toThrow('when agents reply');
    expect(activity(room)).toBe(created); // rolled back with the command
    await host.status(room);
    expect(activity(room)).toBe(now); // and not suppressed by a cached value
  } finally { peek.close(); lobby.close(); dir.cleanup(); }

  let clock = Date.now();
  const short = new BrowserLobby(':memory:', { origin, now: () => clock, idleDays: 0.1 }); // 2.4 hours
  try {
    const host = await client(short, () => clock), room = crypto.randomUUID();
    await create(host, room);
    clock += 40 * 60_000;
    expect((await host.status(room)).expiresAt).toBe(clock + 0.1 * DAY); // written after a quarter of the idle period
  } finally { short.close(); }
});
