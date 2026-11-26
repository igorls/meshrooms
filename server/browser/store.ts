import { Database } from 'bun:sqlite';
import { chmodSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FormerDevice } from '../../src/browser/protocol';

/** Where the coordinator and the operator commands find admission data. */
export const dataDirectory = (env: Record<string, string | undefined> = process.env) => resolve(env.MESHROOMS_BROWSER_DATA || '.local/browser-rooms');
export const admissionPath = (dir: string) => resolve(dir, 'admission.sqlite');
/** Dedicated SQLite store for encrypted relay ciphertext inbox, sealed agent state, and encrypted wake registrations (zero OAuth/account linkage). */
export const relayPath = (dir: string) => resolve(dir, 'relay.sqlite');

/**
 * Why a room is gone. The record is kept for good: its link keeps answering "closed", and because clients choose room
 * ids, nobody can create a new room under an old link that former members still have.
 */
export type ClosedReason = 'closed' | 'expired' | 'retired';

/** Schema version of the indexed metadata projection stored alongside `rooms.body`. */
export const ROOM_META_VERSION = 1;
/** Current SQLite `PRAGMA user_version` managed by `openAdmission()`. */
export const CURRENT_SCHEMA_VERSION = 3;
/** Maximum retired devices returned in `RoomStatus.formerDevices` per room (prioritizing revoked entries). */
export const MAX_FORMER_DEVICES = 2000;

/** Minimal room shape needed to keep indexed metadata columns and `room_devices` in sync with `rooms.body`. */
export type StoredRoomProjection = {
  id: string;
  title: string;
  ownerId: string;
  ownerPerson?: string;
  members: { id: string; role?: 'human' | 'agent' }[];
  devices: { id: string; memberId: string; enc?: string; encVersion?: number; encSig?: string; wakeable?: true }[];
  retired?: FormerDevice[];
};

type RetiredDeviceRow = {
  device_id: string;
  public_key: string;
  member_id: string;
  role: string | null;
  retired_at: number | null;
  revoked: number;
};

function toFormerDevice(row: RetiredDeviceRow): FormerDevice {
  return {
    id: row.device_id,
    publicKey: row.public_key,
    memberId: row.member_id,
    ...(row.role === 'human' || row.role === 'agent' ? { role: row.role } : {}),
    ...(row.retired_at !== null ? { retiredAt: row.retired_at } : {}),
    ...(row.revoked ? { revoked: true as const } : {}),
  };
}

/** Lists retired devices for a room from `retired_devices`, keeping revoked devices ahead of any churn past `limit`. */
export function listRetiredDevices(db: Database, roomId: string, limit = MAX_FORMER_DEVICES): FormerDevice[] {
  const rows = db.query(
    `SELECT device_id, public_key, member_id, role, retired_at, revoked
     FROM (
       SELECT device_id, public_key, member_id, role, retired_at, revoked, rowid
       FROM retired_devices
       WHERE room_id = ?
       ORDER BY revoked DESC, COALESCE(retired_at, 0) DESC, rowid DESC
       LIMIT ?
     )
     ORDER BY COALESCE(retired_at, 0) ASC, rowid ASC`
  ).all(roomId, limit) as RetiredDeviceRow[];
  return rows.map(toFormerDevice);
}

/** Looks up one retired device in `retired_devices` by primary key `(room_id, device_id)`. */
export function getRetiredDevice(db: Database, roomId: string, deviceId: string): FormerDevice | undefined {
  const row = db.query(
    'SELECT device_id, public_key, member_id, role, retired_at, revoked FROM retired_devices WHERE room_id = ? AND device_id = ?'
  ).get(roomId, deviceId) as RetiredDeviceRow | null;
  return row ? toFormerDevice(row) : undefined;
}

/** Inserts or updates a retired device in `retired_devices`. */
export function upsertRetiredDevice(db: Database, roomId: string, device: FormerDevice) {
  db.query(
    'INSERT OR REPLACE INTO retired_devices (room_id, device_id, public_key, member_id, role, retired_at, revoked) VALUES (?,?,?,?,?,?,?)'
  ).run(roomId, device.id, device.publicKey, device.memberId, device.role ?? null, device.retiredAt ?? null, device.revoked ? 1 : 0);
}

/** Marks an existing retired device row as revoked. */
export function revokeRetiredDevice(db: Database, roomId: string, deviceId: string) {
  db.query('UPDATE retired_devices SET revoked = 1 WHERE room_id = ? AND device_id = ?').run(roomId, deviceId);
}

/** Removes a retired device row when that device is re-admitted into the same room, avoiding active/former conflicts. */
export function deleteRetiredDevice(db: Database, roomId: string, deviceId: string) {
  db.query('DELETE FROM retired_devices WHERE room_id = ? AND device_id = ?').run(roomId, deviceId);
}

/** Reads the latest persisted host-signed roster for a room, if any. */
export function getRoomRoster<T = unknown>(db: Database, roomId: string): T | null {
  const row = db.query('SELECT body FROM room_rosters WHERE room_id = ?').get(roomId) as { body: string } | null;
  return row ? JSON.parse(row.body) as T : null;
}

/** Persists the latest verified host-signed roster for a room. */
export function saveRoomRoster(db: Database, roomId: string, version: number, roster: unknown, updatedAt: number) {
  db.query('INSERT OR REPLACE INTO room_rosters (room_id, version, body, updated_at) VALUES (?,?,?,?)')
    .run(roomId, version, JSON.stringify(roster), updatedAt);
}

function syncRoomDevices(
  db: Database,
  roomId: string,
  ownerId: string | null,
  members: { id: string; role?: 'human' | 'agent' }[],
  devices: { id: string; memberId: string; enc?: string; encVersion?: number; encSig?: string; wakeable?: true }[],
  retiredOverride?: { id: string; memberId: string; role?: 'human' | 'agent' }[],
  withRelayColumns = true,
) {
  db.query('DELETE FROM room_devices WHERE room_id=?').run(roomId);
  const humanMembers = new Set(members.filter(m => (m.role ?? 'human') === 'human').map(m => m.id));
  if (withRelayColumns) {
    const insert = db.query(
      'INSERT OR REPLACE INTO room_devices (room_id, device_id, member_id, is_human, is_host, retired, enc, enc_version, enc_sig, wakeable) VALUES (?,?,?,?,?,?,?,?,?,?)',
    );
    for (const d of devices) {
      if (!d || typeof d.id !== 'string' || typeof d.memberId !== 'string') continue;
      insert.run(
        roomId, d.id, d.memberId, humanMembers.has(d.memberId) ? 1 : 0, ownerId !== null && d.memberId === ownerId ? 1 : 0, 0,
        d.enc ?? null, d.encVersion ?? null, d.encSig ?? null, d.wakeable ? 1 : 0,
      );
    }
    const retired = retiredOverride ?? (db.query(
      'SELECT device_id AS id, member_id AS memberId, role FROM retired_devices WHERE room_id = ?',
    ).all(roomId) as { id: string; memberId: string; role: string | null }[]).map(r => ({
      id: r.id,
      memberId: r.memberId,
      ...(r.role === 'human' || r.role === 'agent' ? { role: r.role as 'human' | 'agent' } : {}),
    }));
    for (const d of retired) {
      if (!d || typeof d.id !== 'string' || typeof d.memberId !== 'string') continue;
      insert.run(roomId, d.id, d.memberId, (d.role ?? 'human') === 'human' ? 1 : 0, ownerId !== null && d.memberId === ownerId ? 1 : 0, 1, null, null, null, 0);
    }
    return;
  }
  const insert = db.query('INSERT OR REPLACE INTO room_devices (room_id, device_id, member_id, is_human, is_host, retired) VALUES (?,?,?,?,?,?)');
  for (const d of devices) {
    if (!d || typeof d.id !== 'string' || typeof d.memberId !== 'string') continue;
    insert.run(roomId, d.id, d.memberId, humanMembers.has(d.memberId) ? 1 : 0, ownerId !== null && d.memberId === ownerId ? 1 : 0, 0);
  }
  const retired = retiredOverride ?? (db.query(
    'SELECT device_id AS id, member_id AS memberId, role FROM retired_devices WHERE room_id = ?'
  ).all(roomId) as { id: string; memberId: string; role: string | null }[]).map(r => ({
    id: r.id,
    memberId: r.memberId,
    ...(r.role === 'human' || r.role === 'agent' ? { role: r.role as 'human' | 'agent' } : {}),
  }));
  for (const d of retired) {
    if (!d || typeof d.id !== 'string' || typeof d.memberId !== 'string') continue;
    insert.run(roomId, d.id, d.memberId, (d.role ?? 'human') === 'human' ? 1 : 0, ownerId !== null && d.memberId === ownerId ? 1 : 0, 1);
  }
}

/** Backfills indexed metadata columns and `room_devices` for one legacy room row without altering its stored JSON body. */
function indexRoomBody(db: Database, id: string, body: string) {
  const parsed = JSON.parse(body) as Partial<StoredRoomProjection>;
  const ownerId = typeof parsed.ownerId === 'string' ? parsed.ownerId : null;
  const ownerPerson = typeof parsed.ownerPerson === 'string' ? parsed.ownerPerson : null;
  const title = typeof parsed.title === 'string' ? parsed.title : '';
  const members = Array.isArray(parsed.members) ? parsed.members : [];
  const devices = Array.isArray(parsed.devices) ? parsed.devices : [];
  const retired = Array.isArray(parsed.retired) ? parsed.retired : [];
  db.query('UPDATE rooms SET owner_id=?, owner_person=?, title=?, member_count=?, device_count=?, meta_version=? WHERE id=?')
    .run(ownerId, ownerPerson, title, members.length, devices.length, ROOM_META_VERSION, id);
  syncRoomDevices(db, id, ownerId, members, devices, retired, false);
}

/** Persists a room and keeps its indexed metadata columns and (when membership/devices changed) `room_devices` in sync. */
export function saveRoom<T extends StoredRoomProjection>(db: Database, room: T, syncDevices = true) {
  const stored = room.retired !== undefined ? (({ retired: _retired, ...rest }) => rest)(room) : room;
  db.query(
    'INSERT OR REPLACE INTO rooms (id, body, owner_id, owner_person, title, member_count, device_count, meta_version) VALUES (?,?,?,?,?,?,?,?)'
  ).run(room.id, JSON.stringify(stored), room.ownerId, room.ownerPerson ?? null, room.title, room.members.length, room.devices.length, ROOM_META_VERSION);
  if (syncDevices) syncRoomDevices(db, room.id, room.ownerId, room.members, room.devices);
}

/** Version 0 -> 1: create base tables, add indexed `rooms` metadata columns, indexes, and backfill legacy rows. */
function migrateToV1(db: Database, now: number) {
  db.exec(`CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY, body TEXT NOT NULL,
      owner_id TEXT, owner_person TEXT, title TEXT, member_count INTEGER, device_count INTEGER, meta_version INTEGER
    );
    CREATE TABLE IF NOT EXISTS room_devices (
      room_id TEXT NOT NULL, device_id TEXT NOT NULL, member_id TEXT NOT NULL,
      is_human INTEGER NOT NULL, is_host INTEGER NOT NULL, retired INTEGER NOT NULL,
      PRIMARY KEY (room_id, device_id, retired)
    );
    CREATE TABLE IF NOT EXISTS receipts (device TEXT, id TEXT, body TEXT, result TEXT, at INTEGER, PRIMARY KEY(device,id));
    CREATE TABLE IF NOT EXISTS avatars (room TEXT, member TEXT, hash TEXT, type TEXT, bytes BLOB, PRIMARY KEY(room,member));
    CREATE TABLE IF NOT EXISTS room_activity (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS closed_rooms (id TEXT PRIMARY KEY, reason TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS service_state (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS creation_invites (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, uses INTEGER NOT NULL,
      remaining INTEGER NOT NULL, expires_at INTEGER NOT NULL, note TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
    CREATE TABLE IF NOT EXISTS beta_admissions (device TEXT PRIMARY KEY, person TEXT NOT NULL, admitted_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS beta_revocations (device TEXT PRIMARY KEY, person TEXT NOT NULL, revoked_at INTEGER NOT NULL);`);
  const columns = new Set((db.query('PRAGMA table_info(rooms)').all() as { name: string }[]).map(c => c.name));
  for (const [name, type] of [
    ['owner_id', 'TEXT'], ['owner_person', 'TEXT'], ['title', 'TEXT'],
    ['member_count', 'INTEGER'], ['device_count', 'INTEGER'], ['meta_version', 'INTEGER'],
  ] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE rooms ADD COLUMN ${name} ${type}`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS beta_admissions_person ON beta_admissions(person);
    CREATE INDEX IF NOT EXISTS rooms_owner_person ON rooms(owner_person);
    CREATE INDEX IF NOT EXISTS rooms_unindexed ON rooms(id) WHERE meta_version IS NULL OR meta_version < 1;
    CREATE INDEX IF NOT EXISTS room_devices_device ON room_devices(device_id, retired, is_host);
    CREATE INDEX IF NOT EXISTS room_devices_member ON room_devices(room_id, member_id, retired);
    CREATE INDEX IF NOT EXISTS room_devices_active_host ON room_devices(is_host, is_human, retired);
    CREATE INDEX IF NOT EXISTS room_activity_at ON room_activity(at);
    CREATE INDEX IF NOT EXISTS receipts_at ON receipts(at);`);
  // Rooms from before idle expiry get a full idle window, and legacy rows are indexed once.
  const needsActivity = !!db.query('SELECT 1 FROM rooms r LEFT JOIN room_activity a ON a.id = r.id WHERE a.id IS NULL LIMIT 1').get();
  if (needsActivity) db.query('INSERT OR IGNORE INTO room_activity (id, at) SELECT id, ? FROM rooms').run(now);
  const rows = db.query('SELECT id, body FROM rooms WHERE meta_version IS NULL OR meta_version < ?').all(ROOM_META_VERSION) as { id: string; body: string }[];
  for (const row of rows) indexRoomBody(db, row.id, row.body);
  db.exec('PRAGMA user_version = 1');
}

/** Version 1 -> 2: create `retired_devices` (and ensure `beta_revocations`) and move legacy `room.retired` JSON entries out of `rooms.body`. */
function migrateToV2(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS beta_revocations (device TEXT PRIMARY KEY, person TEXT NOT NULL, revoked_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS retired_devices (
      room_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      member_id TEXT NOT NULL,
      role TEXT,
      retired_at INTEGER,
      revoked INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (room_id, device_id)
    );
    CREATE INDEX IF NOT EXISTS retired_devices_room ON retired_devices(room_id, retired_at);`);
  const insert = db.query(
    'INSERT OR IGNORE INTO retired_devices (room_id, device_id, public_key, member_id, role, retired_at, revoked) VALUES (?,?,?,?,?,?,?)'
  );
  const rows = db.query('SELECT id, body FROM rooms').all() as { id: string; body: string }[];
  for (const row of rows) {
    const parsed = JSON.parse(row.body) as Partial<StoredRoomProjection> & Record<string, unknown>;
    if (!Array.isArray(parsed.retired)) continue;
    const devices = Array.isArray(parsed.devices) ? parsed.devices : [];
    const members = Array.isArray(parsed.members) ? parsed.members : [];
    const ownerId = typeof parsed.ownerId === 'string' ? parsed.ownerId : null;
    const activeIds = new Set(devices.map(d => d?.id).filter((x): x is string => typeof x === 'string'));
    for (const d of parsed.retired) {
      if (!d || typeof d.id !== 'string' || typeof d.publicKey !== 'string' || typeof d.memberId !== 'string') continue;
      if (activeIds.has(d.id)) continue;
      const role = d.role === 'human' || d.role === 'agent' ? d.role : null;
      const retiredAt = typeof d.retiredAt === 'number' && Number.isSafeInteger(d.retiredAt) ? d.retiredAt : null;
      insert.run(row.id, d.id, d.publicKey, d.memberId, role, retiredAt, d.revoked ? 1 : 0);
    }
    delete parsed.retired;
    db.query('UPDATE rooms SET body = ? WHERE id = ?').run(JSON.stringify(parsed), row.id);
    syncRoomDevices(db, row.id, ownerId, members, devices, undefined, false);
  }
  db.exec('PRAGMA user_version = 2');
}

/** Version 2 -> 3: persist device encryption/wake columns on `room_devices` and add `room_rosters` for host-signed rosters. */
function migrateToV3(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS room_rosters (
    room_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    body TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );`);
  const columns = new Set((db.query('PRAGMA table_info(room_devices)').all() as { name: string }[]).map(c => c.name));
  for (const [name, type] of [
    ['enc', 'TEXT'],
    ['enc_version', 'INTEGER'],
    ['enc_sig', 'TEXT'],
    ['wakeable', 'INTEGER NOT NULL DEFAULT 0'],
  ] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE room_devices ADD COLUMN ${name} ${type}`);
  }
  db.exec('PRAGMA user_version = 3');
}

/**
 * Copies the admission database to `<path>.pre-v<target>-from-v<current>.bak` (owner-only) before a schema migration. An
 * existing backup is never overwritten, so the copy taken from the original schema survives repeated starts. A failed backup stops
 * the migration: starting without a way back is the worse outcome.
 */
function backupBeforeMigration(db: Database, path: string, from: number) {
  const target = `${resolve(path)}.pre-v${CURRENT_SCHEMA_VERSION}-from-v${from}.bak`;
  try { if (statSync(target).isFile()) return; } catch { /* no backup yet */ }
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    chmodSync(target, 0o600);
  } catch (error) {
    db.close();
    throw new Error(`Could not back up the admission database before migrating it from schema ${from}: ${(error as Error).message}. Free space or fix permissions, or restore from your own backup and start again.`);
  }
}

/**
 * Opens the admission store and runs any pending `PRAGMA user_version` schema migrations atomically inside
 * `BEGIN IMMEDIATE`. Refuses to open a database whose schema version is newer than this server supports.
 * Already-migrated databases perform zero writes and zero room-body scans on open.
 */
export function openAdmission(path: string, now = Date.now(), options: { backup?: boolean } = {}): Database {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  const version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version > CURRENT_SCHEMA_VERSION) {
    db.close();
    throw new Error(`Admission database schema version ${version} is newer than this server supports (max ${CURRENT_SCHEMA_VERSION}); refusing to open to avoid downgrade.`);
  }
  if (version < CURRENT_SCHEMA_VERSION) {
    // The v3 migration is one-way: a server that only knows v2 refuses a v3 database. Before upgrading a database that
    // already holds rooms, keep a consistent copy (taken through this connection, so it includes the WAL) next to it.
    if (version >= 1 && options.backup !== false && path !== ':memory:') backupBeforeMigration(db, path, version);
    db.transaction(() => {
      if (version < 1) migrateToV1(db, now);
      if (version < 2) migrateToV2(db);
      if (version < 3) migrateToV3(db);
    }).immediate();
  }
  return db;
}

/** Deletes a room and everything the service keeps for it, leaving only the record that it closed. */
export function retireRoom(db: Database, id: string, reason: ClosedReason, now = Date.now()): boolean {
  return db.transaction(() => {
    if (!db.query('SELECT 1 FROM rooms WHERE id=?').get(id)) return false;
    db.query('DELETE FROM rooms WHERE id=?').run(id);
    db.query('DELETE FROM room_devices WHERE room_id=?').run(id);
    db.query('DELETE FROM retired_devices WHERE room_id=?').run(id);
    db.query('DELETE FROM room_rosters WHERE room_id=?').run(id);
    db.query('DELETE FROM avatars WHERE room=?').run(id);
    db.query('DELETE FROM room_activity WHERE id=?').run(id);
    db.query('INSERT OR REPLACE INTO closed_rooms (id, reason, at) VALUES (?,?,?)').run(id, reason, now);
    return true;
  }).immediate();
}

export type RoomSummary = { id: string; title: string; members: number; devices: number; lastActiveAt: number | null };
type RoomSummaryRow = { id: string; title: string | null; member_count: number | null; device_count: number | null; body: string | null; at: number | null };
function toRoomSummary(row: RoomSummaryRow): RoomSummary {
  if (row.body !== null) {
    const room = JSON.parse(row.body) as { title?: string; members?: unknown[]; devices?: unknown[] };
    return { id: row.id, title: room.title ?? '', members: room.members?.length ?? 0, devices: room.devices?.length ?? 0, lastActiveAt: row.at };
  }
  return { id: row.id, title: row.title ?? '', members: row.member_count ?? 0, devices: row.device_count ?? 0, lastActiveAt: row.at };
}
/** Rooms for the operator: no member names, keys or requests. Reads indexed columns without parsing room JSON. */
export function listRooms(db: Database): RoomSummary[] {
  const rows = db.query(
    'SELECT r.id, r.title, r.member_count, r.device_count, CASE WHEN r.meta_version >= ? THEN NULL ELSE r.body END AS body, a.at FROM rooms r LEFT JOIN room_activity a ON a.id = r.id ORDER BY a.at'
  ).all(ROOM_META_VERSION) as RoomSummaryRow[];
  return rows.map(toRoomSummary);
}
/** Single-room summary lookup for operator commands without scanning every room. */
export function getRoomSummary(db: Database, id: string): RoomSummary | null {
  const row = db.query(
    'SELECT r.id, r.title, r.member_count, r.device_count, CASE WHEN r.meta_version >= ? THEN NULL ELSE r.body END AS body, a.at FROM rooms r LEFT JOIN room_activity a ON a.id = r.id WHERE r.id = ?'
  ).get(ROOM_META_VERSION, id) as RoomSummaryRow | null;
  return row ? toRoomSummary(row) : null;
}
