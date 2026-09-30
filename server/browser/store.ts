import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';

/** Where the coordinator and the operator commands find admission data. */
export const dataDirectory = (env: Record<string, string | undefined> = process.env) => resolve(env.MESHROOMS_BROWSER_DATA || '.local/browser-rooms');
export const admissionPath = (dir: string) => resolve(dir, 'admission.sqlite');

/**
 * Why a room is gone. The record is kept for good: its link keeps answering "closed", and because clients choose room
 * ids, nobody can create a new room under an old link that former members still have.
 */
export type ClosedReason = 'closed' | 'expired' | 'retired';

/**
 * Opens the admission store and creates missing tables. Every statement is idempotent, so an existing production
 * database only gains the new tables; rooms, receipts and avatars are left as they are. The operator commands open the
 * same file next to the running service: SQLite serialises writers, and busy_timeout lets either side wait briefly.
 */
export function openAdmission(path: string, now = Date.now()): Database {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS receipts (device TEXT, id TEXT, body TEXT, result TEXT, at INTEGER, PRIMARY KEY(device,id));
    CREATE TABLE IF NOT EXISTS avatars (room TEXT, member TEXT, hash TEXT, type TEXT, bytes BLOB, PRIMARY KEY(room,member));
    CREATE TABLE IF NOT EXISTS room_activity (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS closed_rooms (id TEXT PRIMARY KEY, reason TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS service_state (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS creation_invites (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, uses INTEGER NOT NULL,
      remaining INTEGER NOT NULL, expires_at INTEGER NOT NULL, note TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);`);
  // Rooms from before idle expiry get a full idle window from the first start that tracks activity.
  db.query('INSERT OR IGNORE INTO room_activity (id, at) SELECT id, ? FROM rooms').run(now);
  return db;
}

/** Deletes a room and everything the service keeps for it, leaving only the record that it closed. */
export function retireRoom(db: Database, id: string, reason: ClosedReason, now = Date.now()): boolean {
  return db.transaction(() => {
    if (!db.query('SELECT 1 FROM rooms WHERE id=?').get(id)) return false;
    db.query('DELETE FROM rooms WHERE id=?').run(id);
    db.query('DELETE FROM avatars WHERE room=?').run(id);
    db.query('DELETE FROM room_activity WHERE id=?').run(id);
    db.query('INSERT OR REPLACE INTO closed_rooms (id, reason, at) VALUES (?,?,?)').run(id, reason, now);
    return true;
  }).immediate();
}

export type RoomSummary = { id: string; title: string; members: number; devices: number; lastActiveAt: number | null };
/** Rooms for the operator: no member names, keys or requests. */
export function listRooms(db: Database): RoomSummary[] {
  const rows = db.query('SELECT r.id, r.body, a.at FROM rooms r LEFT JOIN room_activity a ON a.id = r.id ORDER BY a.at').all() as { id: string; body: string; at: number | null }[];
  return rows.map(row => {
    const room = JSON.parse(row.body) as { title: string; members: unknown[]; devices: unknown[] };
    return { id: row.id, title: room.title, members: room.members.length, devices: room.devices.length, lastActiveAt: row.at };
  });
}
