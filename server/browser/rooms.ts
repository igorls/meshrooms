import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { idleDays } from './config';
import { admissionPath, dataDirectory, listRooms, openAdmission, retireRoom } from './store';

/**
 * Operator room tools. Safe while the service runs: it reads rooms from SQLite for every request and keeps no room cache,
 * so a retired room answers "removed" on its next request, and SQLite serialises this write with the service's own.
 */
const usage = `Usage (run as the service account, with MESHROOMS_BROWSER_DATA set to the service's data directory):
  bun run server/browser/rooms.ts list
  bun run server/browser/rooms.ts retire <room uuid>`;

export function roomsCli(args: string[], db: Database, options: { idleDays: number; print?: (line: string) => void; now?: number }) {
  const print = options.print ?? console.log, [command, id] = args;
  if (command === 'list') {
    const rooms = listRooms(db);
    if (!rooms.length) { print('No rooms.'); return; }
    print(['id', 'title', 'members', 'devices', 'last active', 'expires'].join('\t'));
    for (const r of rooms) {
      const active = r.lastActiveAt === null ? 'unknown' : new Date(r.lastActiveAt).toISOString();
      const expires = r.lastActiveAt === null ? 'unknown' : new Date(r.lastActiveAt + options.idleDays * 86_400_000).toISOString();
      print([r.id, JSON.stringify(r.title), r.members, r.devices, active, expires].join('\t'));
    }
    return;
  }
  if (command === 'retire' && id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Give the exact room UUID from `rooms list`.');
    const room = listRooms(db).find(r => r.id === id);
    if (!room || !retireRoom(db, id, 'retired', options.now)) throw new Error(`No room ${id}.`);
    print(`Retired ${id} (${JSON.stringify(room.title)}, ${room.members} member${room.members === 1 ? '' : 's'}). Its link now says it was removed.`);
    return;
  }
  throw new Error(usage);
}

if (import.meta.main) {
  try {
    const path = admissionPath(dataDirectory());
    if (!existsSync(path)) throw new Error(`No admission database at ${path}. Set MESHROOMS_BROWSER_DATA to the service's data directory.`);
    const db = openAdmission(path);
    try { roomsCli(process.argv.slice(2), db, { idleDays: idleDays(process.env) }); } finally { db.close(); }
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
