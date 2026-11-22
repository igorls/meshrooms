import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { BrowserLobby, LobbyError } from './lobby';
import { browserHandler } from './http';
import { roomsCli } from './rooms';
import { CURRENT_SCHEMA_VERSION, getRoomSummary, listRetiredDevices, listRooms, openAdmission } from './store';
import { admitPerson, client, testOrigin as origin } from './test-client';
import { BrowserAgent, runBridge } from '../browser-agent';
import { signerOf, type RoomStatus } from '../../src/browser/protocol';

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
}, 30_000);

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

test('read-only paths (status, creation-status, publicRoom, avatar, health, room summaries) never acquire BEGIN IMMEDIATE', async () => {
  const dir = tempDir(), path = join(dir.path, 'admission.sqlite');
  let now = Date.now();
  let lobby = new BrowserLobby(path, { origin, now: () => now, idleDays: 30 });
  const blocker = new Database(path);
  const reader = new Database(path, { readonly: true });
  try {
    const host = await client(lobby, () => now), stranger = await client(lobby, () => now), room = crypto.randomUUID();
    await create(host, room, 'Read-only check');
    const sam = await admitPerson(lobby, host, room, 'Sam', () => now);
    await sam.send('profile', room, { avatar: png(32, 32) });
    const samStatus = await sam.status(room);
    const samAvatar = samStatus.members!.find(m => m.id === samStatus.memberId)!.avatar!;

    // Keep busy_timeout short on the lobby so any accidental BEGIN IMMEDIATE fails fast with SQLITE_BUSY.
    (lobby as unknown as { db: Database }).db.exec('PRAGMA busy_timeout = 50');
    blocker.exec('BEGIN IMMEDIATE');
    try {
      // Every read path must succeed while another connection holds the SQLite write lock.
      now += 5_000;
      expect((await host.status(room)).memberId).toBeDefined();
      expect((await sam.status(room)).memberId).toBeDefined();
      expect((await stranger.status(room)).memberId).toBeUndefined();
      expect(await host.send('creation-status', room)).toEqual({ roomId: room, admitted: true });
      expect(lobby.publicRoom(room)).toEqual({ roomId: room, title: 'Read-only check' });
      expect(lobby.avatar(room, samStatus.memberId!, samAvatar)?.type).toBe('image/png');
      expect(lobby.healthy()).toBe(true);
      expect(listRooms(reader)).toHaveLength(1);
      expect(getRoomSummary(reader, room)?.title).toBe('Read-only check');
    } finally {
      blocker.exec('ROLLBACK');
    }

    // After restarting with a cold in-memory cache while activity is still fresh (< 1 h), the first status poll reads
    // `room_activity`, caches it, and still takes no write lock.
    lobby.close();
    now += 60_000;
    lobby = new BrowserLobby(path, { origin, now: () => now, idleDays: 30 });
    (lobby as unknown as { db: Database }).db.exec('PRAGMA busy_timeout = 50');
    blocker.exec('BEGIN IMMEDIATE');
    try {
      const resumed = await lobby.execute(await host.signed('status', room, { session: host.session })) as RoomStatus;
      expect(resumed.memberId).toBeDefined();
    } finally {
      blocker.exec('ROLLBACK');
    }

    // Once past the hourly activity interval, status updates `room_activity` on disk, then returns to read-only polls.
    now += 61 * 60_000;
    const refreshed = await lobby.execute(await host.signed('status', room, { session: host.session })) as RoomStatus;
    expect(refreshed.expiresAt).toBe(now + 30 * DAY);
    expect(getRoomSummary(reader, room)?.lastActiveAt).toBe(now);
    blocker.exec('BEGIN IMMEDIATE');
    try {
      now += 5_000;
      const cachedAgain = await lobby.execute(await host.signed('status', room, { session: host.session })) as RoomStatus;
      expect(cachedAgain.expiresAt).toBe(refreshed.expiresAt);
    } finally {
      blocker.exec('ROLLBACK');
    }
  } finally { reader.close(); blocker.close(); lobby.close(); dir.cleanup(); }
});

test('legacy DBs backfill room metadata once; create, status, link and warm restarts never scan full rooms.body', async () => {
  const dir = tempDir(), path = join(dir.path, 'admission.sqlite');
  let now = Date.now();
  try {
    // Build a legacy database with only the original 3 tables and no metadata columns or room_devices table.
    const seed = new BrowserLobby(':memory:', { origin, now: () => now });
    const host = await client(seed, () => now), companion = await client(seed, () => now), guest = await client(seed, () => now);
    const room1 = crypto.randomUUID(), room2 = crypto.randomUUID();
    await create(host, room1, 'Legacy 1');
    await companion.send('request', room1, { kind: 'companion', name: 'Alex', label: 'Laptop' });
    await host.send('link', room1, { code: (await companion.status(room1)).request!.code });
    await guest.send('request', room1, { kind: 'person', name: 'Sam', label: 'Browser' });
    await host.send('decide', room1, { requestId: (await host.status(room1)).requests![0].id, admit: true });
    // Remove host from room1 so host becomes a retired host key while companion stays active.
    const hostId = (await host.status(room1)).deviceId;
    await companion.send('remove', room1, { deviceId: hostId });
    await create(host, room2, 'Legacy 2');

    const legacy = new Database(path);
    legacy.exec('CREATE TABLE rooms (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE receipts (device TEXT, id TEXT, body TEXT, result TEXT, at INTEGER, PRIMARY KEY(device,id)); CREATE TABLE avatars (room TEXT, member TEXT, hash TEXT, type TEXT, bytes BLOB, PRIMARY KEY(room,member));');
    const seedDb = (seed as unknown as { db: Database }).db;
    for (const row of seedDb.query('SELECT id, body FROM rooms').all() as { id: string; body: string }[]) {
      // Legacy v0 DBs kept retired keys inline inside `rooms.body`.
      const retired = listRetiredDevices(seedDb, row.id);
      const parsed = JSON.parse(row.body) as Record<string, unknown>;
      if (retired.length) parsed.retired = retired;
      legacy.query('INSERT INTO rooms VALUES (?,?)').run(row.id, JSON.stringify(parsed));
    }
    legacy.close(); seed.close();

    // First start migrates v0 -> v1 -> v2 (metadata + room_devices + retired_devices) and grandfathers host + companion (never guest).
    let lobby = new BrowserLobby(path, { origin, invites: 'required', now: () => now });
    expect(((lobby as unknown as { db: Database }).db.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(listRetiredDevices((lobby as unknown as { db: Database }).db, room1).map(d => d.id)).toEqual([hostId]);
    expect(JSON.parse(((lobby as unknown as { db: Database }).db.query('SELECT body FROM rooms WHERE id=?').get(room1) as { body: string }).body)).not.toHaveProperty('retired');
    expect(await lobby.execute(await host.signed('creation-status', room1))).toMatchObject({ admitted: true });
    expect(await lobby.execute(await companion.signed('creation-status', room1))).toMatchObject({ admitted: true });
    expect(await lobby.execute(await guest.signed('creation-status', room1))).toMatchObject({ admitted: false });
    // Legacy rooms (including room1 where host is now a retired host key) count toward the 8-room hosting cap.
    for (let i = 3; i <= 8; i++) await lobby.execute(await host.signed('create', crypto.randomUUID(), { title: `Room ${i}`, name: 'Alex', label: 'Desktop' }));
    expect((await rejected(lobby.execute(await host.signed('create', crypto.randomUUID(), { title: 'Room 9', name: 'Alex', label: 'Desktop' })))).status).toBe(429);
    lobby.close();

    // Second start on the already-migrated DB: wrap db.query to assert ZERO full-table `SELECT body FROM rooms` scans.
    lobby = new BrowserLobby(path, { origin, invites: 'required', now: () => now });
    const db = (lobby as unknown as { db: Database }).db;
    const queries: string[] = [];
    const originalQuery = db.query.bind(db);
    (db as unknown as { query: typeof db.query }).query = ((sql: string) => {
      queries.push(sql);
      return originalQuery(sql);
    }) as typeof db.query;

    try {
      const extraRoom = crypto.randomUUID();
      // Link a new companion in room2 and exercise link + status + create + publicRoom + listRooms + getRoomSummary.
      const comp2 = await client(lobby, () => now);
      await comp2.send('request', room2, { kind: 'companion', name: 'Alex', label: 'Tablet' });
      const code = (await comp2.status(room2)).request!.code;
      await lobby.execute(await host.signed('link', room2, { code }));
      await lobby.execute(await host.signed('status', room2, { session: host.session }));
      expect(lobby.publicRoom(room2)).toEqual({ roomId: room2, title: 'Legacy 2' });
      expect(listRooms(db)).toHaveLength(8);
      expect(getRoomSummary(db, room2)?.title).toBe('Legacy 2');
      // Creating a 9th room (rejected by cap) or replacing a closed room still never scans rooms.body.
      await expect(lobby.execute(await host.signed('create', extraRoom, { title: 'Capped', name: 'Alex', label: 'Desktop' }))).rejects.toThrow('eight rooms');
      await lobby.execute(await host.signed('close', room2));
      await lobby.execute(await host.signed('create', extraRoom, { title: 'Fresh', name: 'Alex', label: 'Desktop' }));
      const fullScans = queries.filter(sql => /SELECT\s+body\s+FROM\s+rooms\b(?!\s+WHERE\s+id\s*=)/i.test(sql));
      expect(fullScans).toEqual([]);
    } finally { lobby.close(); }
  } finally { dir.cleanup(); }
});

test('create retires idle-expired rooms when at maxRooms capacity instead of falsely returning 429', async () => {
  let now = Date.now();
  const lobby = new BrowserLobby(':memory:', { origin, maxRooms: 2, idleDays: 30, now: () => now });
  try {
    const a = await client(lobby, () => now), b = await client(lobby, () => now), c = await client(lobby, () => now);
    const roomA = crypto.randomUUID(), roomB = crypto.randomUUID(), roomC = crypto.randomUUID();
    await create(a, roomA, 'Room A');
    await create(b, roomB, 'Room B');
    await expect(create(c, roomC, 'Blocked')).rejects.toMatchObject({ status: 429 });
    // Advance past 30 idle days while keeping only roomA active; create for roomC reclaims expired roomB.
    now += 29 * DAY;
    await a.status(roomA);
    now += 2 * DAY;
    await create(c, roomC, 'Reclaimed');
    expect((await rejected(b.status(roomB))).status).toBe(410);
    expect((await c.status(roomC)).memberId).toBeDefined();
  } finally { lobby.close(); }
});

test('OPS-7: PRAGMA user_version runs ordered migrations (v1 -> v2) atomically and refuses downgrade from newer schema versions', () => {
  const dir = tempDir(), path = join(dir.path, 'admission.sqlite');
  try {
    // Build an explicit v1 database (has rooms metadata & room_devices, no retired_devices table yet).
    const v1 = new Database(path);
    v1.exec(`CREATE TABLE rooms (id TEXT PRIMARY KEY, body TEXT NOT NULL, owner_id TEXT, owner_person TEXT, title TEXT, member_count INTEGER, device_count INTEGER, meta_version INTEGER);
      CREATE TABLE room_devices (room_id TEXT NOT NULL, device_id TEXT NOT NULL, member_id TEXT NOT NULL, is_human INTEGER NOT NULL, is_host INTEGER NOT NULL, retired INTEGER NOT NULL, PRIMARY KEY (room_id, device_id, retired));
      CREATE TABLE receipts (device TEXT, id TEXT, body TEXT, result TEXT, at INTEGER, PRIMARY KEY(device,id));
      CREATE TABLE avatars (room TEXT, member TEXT, hash TEXT, type TEXT, bytes BLOB, PRIMARY KEY(room,member));
      CREATE TABLE room_activity (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE closed_rooms (id TEXT PRIMARY KEY, reason TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE service_state (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE creation_invites (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, uses INTEGER NOT NULL, remaining INTEGER NOT NULL, expires_at INTEGER NOT NULL, note TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE TABLE beta_admissions (device TEXT PRIMARY KEY, person TEXT NOT NULL, admitted_at INTEGER NOT NULL);
      PRAGMA user_version = 1;`);
    const roomId = crypto.randomUUID(), ownerId = crypto.randomUUID(), guestId = crypto.randomUUID();
    const roomBody = {
      id: roomId, title: 'V1 Room', ownerId,
      members: [{ id: ownerId, name: 'Alex' }],
      devices: [{ id: 'dev-active', publicKey: 'k-active', label: 'Desktop', memberId: ownerId, admittedAt: 100 }],
      requests: [],
      retired: [
        { id: 'dev-left', publicKey: 'k-left', memberId: guestId, role: 'human', retiredAt: 500 },
        { id: 'dev-revoked', publicKey: 'k-revoked', memberId: guestId, role: 'agent', retiredAt: 600, revoked: true },
        // Stale retired entry matching an already-active device must not be migrated into retired_devices.
        { id: 'dev-active', publicKey: 'k-active', memberId: ownerId, role: 'human', retiredAt: 400, revoked: true },
      ],
    };
    v1.query('INSERT INTO rooms VALUES (?,?,?,?,?,?,?,?)').run(roomId, JSON.stringify(roomBody), ownerId, null, 'V1 Room', 1, 1, 1);
    v1.query('INSERT INTO room_activity VALUES (?,?)').run(roomId, 1000);
    v1.close();

    // Opening runs v1 -> v2 only, moves retired entries into retired_devices, strips rooms.body.retired, and sets user_version = 2.
    const migrated = openAdmission(path, 2000);
    try {
      expect((migrated.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(CURRENT_SCHEMA_VERSION);
      expect(listRetiredDevices(migrated, roomId)).toEqual([
        { id: 'dev-left', publicKey: 'k-left', memberId: guestId, role: 'human', retiredAt: 500 },
        { id: 'dev-revoked', publicKey: 'k-revoked', memberId: guestId, role: 'agent', retiredAt: 600, revoked: true },
      ]);
      const storedBody = JSON.parse((migrated.query('SELECT body FROM rooms WHERE id=?').get(roomId) as { body: string }).body);
      expect(storedBody).not.toHaveProperty('retired');
      expect(migrated.query('SELECT device_id, retired FROM room_devices WHERE room_id=? ORDER BY device_id').all(roomId)).toEqual([
        { device_id: 'dev-active', retired: 0 },
        { device_id: 'dev-left', retired: 1 },
        { device_id: 'dev-revoked', retired: 1 },
      ]);
      // Simulate a future server schema version and verify openAdmission refuses downgrade.
      migrated.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
    } finally { migrated.close(); }

    expect(() => openAdmission(path)).toThrow(/newer than this server supports.*downgrade/i);
  } finally { dir.cleanup(); }
});

test('SYNC-8 & COL-4: retired_devices is unbounded past 256 churned entries, clears on room close, and clears stale rows on re-join', async () => {
  let now = Date.now();
  const lobby = new BrowserLobby(':memory:', { origin, now: () => now });
  const db = (lobby as unknown as { db: Database }).db;
  try {
    const host = await client(lobby, () => now), room = crypto.randomUUID();
    await create(host, room, 'Trust');
    await host.send('settings', room, { guestAgentApproval: false });

    // Early revoked & self-left devices must never be evicted by >256 later retired devices.
    const earlyRevoked = await admitPerson(lobby, host, room, 'EarlyRevoked', () => now);
    const earlyLeft = await admitPerson(lobby, host, room, 'EarlyLeft', () => now);
    const earlyRevokedId = (await earlyRevoked.status(room)).deviceId;
    const earlyLeftId = (await earlyLeft.status(room)).deviceId;
    now += 1000;
    await host.send('remove', room, { deviceId: earlyRevokedId });
    now += 1000;
    await earlyLeft.send('remove', room, { deviceId: earlyLeftId });

    // Seed 270 additional churned retired entries directly into retired_devices (past the old 256 JSON slice).
    const insert = db.query('INSERT INTO retired_devices (room_id, device_id, public_key, member_id, role, retired_at, revoked) VALUES (?,?,?,?,?,?,?)');
    for (let i = 0; i < 270; i++) {
      insert.run(room, `churn-${String(i).padStart(4, '0')}`, `pk-${i}`, `member-${i}`, 'human', now + i + 1, 0);
    }
    const status = await host.status(room);
    expect(status.formerDevices).toHaveLength(272);
    expect(status.formerDevices!.find(d => d.id === earlyRevokedId)).toMatchObject({ id: earlyRevokedId, revoked: true });
    expect(status.formerDevices!.find(d => d.id === earlyLeftId)).toMatchObject({ id: earlyLeftId });
    expect(JSON.parse((db.query('SELECT body FROM rooms WHERE id=?').get(room) as { body: string }).body)).not.toHaveProperty('retired');

    // COL-4 (1): Re-admitting a previously retired person via host `decide` clears its stale retired_devices row.
    await earlyRevoked.send('request', room, { name: 'EarlyRevoked', label: 'Browser', kind: 'person' });
    const rejoinReq = (await host.status(room)).requests!.find(r => r.name === 'EarlyRevoked')!;
    await host.send('decide', room, { requestId: rejoinReq.id, admit: true });
    const afterRejoin = await host.status(room);
    expect(afterRejoin.devices!.some(d => d.id === earlyRevokedId)).toBe(true);
    expect(afterRejoin.formerDevices!.some(d => d.id === earlyRevokedId)).toBe(false);
    expect(signerOf(afterRejoin, earlyRevokedId, now + 999_999)).toBeDefined();

    // COL-4 (2): Re-admitting a previously removed host companion via `link` clears its stale retired_devices row.
    const comp = await client(lobby, () => now);
    await comp.send('request', room, { name: 'Alex', label: 'Laptop', kind: 'companion' });
    await host.send('link', room, { code: (await comp.status(room)).request!.code });
    const compId = (await comp.status(room)).deviceId;
    await host.send('remove', room, { deviceId: compId });
    expect((await host.status(room)).formerDevices!.some(d => d.id === compId)).toBe(true);
    await comp.send('request', room, { name: 'Alex', label: 'Laptop', kind: 'companion' });
    await host.send('link', room, { code: (await comp.status(room)).request!.code });
    const afterCompRejoin = await host.status(room);
    expect(afterCompRejoin.devices!.some(d => d.id === compId)).toBe(true);
    expect(afterCompRejoin.formerDevices!.some(d => d.id === compId)).toBe(false);

    // COL-4 (3): Re-admitting a previously removed agent via `agent-redeem` clears its stale retired_devices row.
    const agent = await client(lobby, () => now);
    const { token: t1 } = await host.send('agent-invite', room, { name: 'Wren' }) as { token: string };
    await agent.send('agent-redeem', room, { token: t1, label: 'Bridge' });
    const agentDevId = (await agent.status(room)).deviceId;
    await host.send('remove', room, { deviceId: agentDevId });
    expect((await host.status(room)).formerDevices!.some(d => d.id === agentDevId)).toBe(true);
    const { token: t2 } = await host.send('agent-invite', room, { name: 'Wren' }) as { token: string };
    await agent.send('agent-redeem', room, { token: t2, label: 'Bridge' });
    const afterAgentRejoin = await host.status(room);
    expect(afterAgentRejoin.devices!.some(d => d.id === agentDevId)).toBe(true);
    expect(afterAgentRejoin.formerDevices!.some(d => d.id === agentDevId)).toBe(false);

    // Closing the room cleans up all retired_devices rows for the room.
    await host.send('close', room);
    expect(db.query('SELECT COUNT(*) AS n FROM retired_devices WHERE room_id=?').get(room)).toEqual({ n: 0 });
  } finally { lobby.close(); }
});

test('LIFE-4: host can transfer hosting atomically to another human member (never an agent), then leave the room', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  const db = (lobby as unknown as { db: Database }).db;
  try {
    const host = await client(lobby), room = crypto.randomUUID();
    await create(host, room, 'Handoff');
    await host.send('settings', room, { guestAgentApproval: false });
    const sam = await admitPerson(lobby, host, room, 'Sam');
    const pat = await admitPerson(lobby, host, room, 'Pat');
    const { token } = await host.send('agent-invite', room, { name: 'Wren' }) as { token: string };
    const agent = await client(lobby);
    await agent.send('agent-redeem', room, { token, label: 'Bridge' });

    const hostStatus = await host.status(room), samStatus = await sam.status(room), agentStatus = await agent.status(room);
    const hostId = hostStatus.memberId!, samId = samStatus.memberId!, agentId = agentStatus.memberId!;

    // Guard rails: non-host, invalid memberId, self, unknown member, and agent targets are rejected.
    await expect(sam.send('transfer-host', room, { memberId: samId })).rejects.toMatchObject({ status: 403 });
    await expect(host.send('transfer-host', room, { memberId: 'not-a-uuid' })).rejects.toMatchObject({ status: 400 });
    await expect(host.send('transfer-host', room, { memberId: hostId })).rejects.toMatchObject({ status: 409 });
    await expect(host.send('transfer-host', room, { memberId: crypto.randomUUID() })).rejects.toMatchObject({ status: 404 });
    await expect(host.send('transfer-host', room, { memberId: agentId })).rejects.toMatchObject({ status: 400 });

    // Before transfer, host cannot leave via remove { memberId }.
    await expect(host.send('remove', room, { memberId: hostId })).rejects.toMatchObject({ status: 409 });

    // Transfer host to Sam.
    await host.send('transfer-host', room, { memberId: samId });
    expect((await sam.status(room)).ownerId).toBe(samId);
    expect((await host.status(room)).ownerId).toBe(samId);
    expect(db.query('SELECT owner_id FROM rooms WHERE id=?').get(room)).toEqual({ owner_id: samId });
    expect(db.query('SELECT device_id, is_host FROM room_devices WHERE room_id=? AND retired=0 ORDER BY is_host DESC').all(room))
      .toContainEqual({ device_id: samStatus.deviceId, is_host: 1 });
    expect(db.query('SELECT is_host FROM room_devices WHERE room_id=? AND device_id=? AND retired=0').get(room, hostStatus.deviceId))
      .toEqual({ is_host: 0 });

    // Former host loses host powers; new host gains them.
    await expect(host.send('settings', room, { floor: 'open' })).rejects.toMatchObject({ status: 403 });
    await expect(host.send('close', room)).rejects.toMatchObject({ status: 403 });
    await sam.send('settings', room, { floor: 'open' });
    expect((await pat.status(room)).settings?.floor).toBe('open');

    // Former host can now cleanly leave the room (taking their operated agent Wren with them).
    await host.send('remove', room, { memberId: hostId });
    expect((await host.status(room)).memberId).toBeUndefined();
    expect((await agent.status(room)).memberId).toBeUndefined();
    expect((await sam.status(room)).members!.map(m => m.name)).toEqual(['Sam', 'Pat']);

    // New host can close the room.
    await sam.send('close', room);
    expect((await rejected(pat.status(room))).status).toBe(410);
  } finally { lobby.close(); }
});
