import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, rotate, STATUS_FILE, verify } from '../deploy/backup/backup-admission';
import { BACKUP_STATUS_FILE, backupFreshness } from '../server/browser/backup-status';
import { BrowserLobby } from '../server/browser/lobby';
import { CURRENT_SCHEMA_VERSION } from '../server/browser/store';

test('backs up a live WAL admission database into a verified standalone copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshrooms-backup-'));
  const db = join(dir, 'data', 'admission.sqlite');
  const out = join(dir, 'backups');
  mkdirSync(join(dir, 'data'));
  const lobby = new BrowserLobby(db, { origin: 'http://127.0.0.1:4320' });
  // A second writer keeps the committed rows in the WAL, as with a running coordinator.
  const writer = new Database(db);
  try {
    writer.exec('PRAGMA wal_autocheckpoint = 0');
    writer.query('INSERT INTO rooms (id, body) VALUES (?, ?)').run('room-1', '{}');
    const file = backup({ db, out, keepDays: 14, keepMin: 3, now: new Date('2026-09-29T03:15:00Z') });
    expect(file.endsWith('admission-20260929T031500Z.sqlite')).toBe(true);
    const checked = verify(file);
    expect(checked.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(checked.counts).toEqual({
      rooms: 1, receipts: 0, avatars: 0, room_activity: 0, closed_rooms: 0, service_state: 1, creation_invites: 0, beta_admissions: 0,
      room_devices: 0, retired_devices: 0, beta_revocations: 0, room_rosters: 0,
    });
    expect(readdirSync(out).filter(name => name.endsWith('.partial'))).toEqual([]);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    // The copy is standalone: no WAL of its own.
    expect(existsSync(`${file}-wal`)).toBe(false);
    // The coordinator reads the success time from the data directory.
    expect(STATUS_FILE).toBe(BACKUP_STATUS_FILE);
    const status = JSON.parse(readFileSync(join(dir, 'data', STATUS_FILE), 'utf8'));
    expect(status).toMatchObject({ at: Date.parse('2026-09-29T03:15:00Z'), file: 'admission-20260929T031500Z.sqlite' });
    if (process.platform !== 'win32') expect(statSync(join(dir, 'data', STATUS_FILE)).mode & 0o777).toBe(0o600);
    expect(backupFreshness(join(dir, 'data'), 26, () => Date.parse('2026-09-30T03:00:00Z'))()).toBe(true);
    expect(backupFreshness(join(dir, 'data'), 26, () => Date.parse('2026-09-30T06:00:00Z'))()).toBe(false);
    expect(() => backup({ db, out, keepDays: 14, keepMin: 3, now: new Date('2026-09-29T03:15:00Z') })).toThrow(/already exists/);
  } finally { writer.close(); lobby.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('refuses a file that is not a healthy admission database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshrooms-backup-'));
  try {
    const other = join(dir, 'other.sqlite');
    const db = new Database(other); db.exec('CREATE TABLE unrelated (a)'); db.close();
    expect(() => verify(other)).toThrow(/no rooms table/);
    const incomplete = join(dir, 'incomplete.sqlite');
    const partial = new Database(incomplete);
    partial.exec('CREATE TABLE rooms (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE receipts (id TEXT); CREATE TABLE avatars (id TEXT);');
    partial.close();
    expect(() => verify(incomplete)).toThrow(/no room_activity table/);
    const junk = join(dir, 'junk.sqlite');
    writeFileSync(junk, 'SQLite format 3\0' + 'x'.repeat(200));
    expect(() => verify(junk)).toThrow();
    // A schema v2 backup missing migrated tables (`room_devices` or `retired_devices`) is refused.
    const missingRetired = join(dir, 'missing-retired.sqlite');
    const lobby = new BrowserLobby(missingRetired, { origin: 'http://127.0.0.1:4320' });
    lobby.close();
    const edit = new Database(missingRetired);
    edit.exec('DROP TABLE retired_devices');
    edit.close();
    expect(() => verify(missingRetired)).toThrow(/no retired_devices table/);
    const missingRoomDevices = join(dir, 'missing-room-devices.sqlite');
    const lobby2 = new BrowserLobby(missingRoomDevices, { origin: 'http://127.0.0.1:4320' });
    lobby2.close();
    const edit2 = new Database(missingRoomDevices);
    edit2.exec('DROP TABLE room_devices');
    edit2.close();
    expect(() => verify(missingRoomDevices)).toThrow(/no room_devices table/);
    // Pre-migration v0 backups (all base tables, user_version=0) still pass pre-deploy backup verification.
    const legacyV0 = join(dir, 'legacy-v0.sqlite');
    const v0 = new Database(legacyV0);
    v0.exec('CREATE TABLE rooms (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE receipts (id TEXT); CREATE TABLE avatars (id TEXT); CREATE TABLE room_activity (id TEXT); CREATE TABLE closed_rooms (id TEXT); CREATE TABLE service_state (key TEXT); CREATE TABLE creation_invites (id TEXT); CREATE TABLE beta_admissions (device TEXT);');
    v0.close();
    expect(verify(legacyV0).schemaVersion).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rotation keeps 14 days and never fewer than the newest three', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshrooms-backup-'));
  try {
    const names = ['20260901T031500Z', '20260902T031500Z', '20260903T031500Z', '20260904T031500Z', '20260920T031500Z'].map(at => `admission-${at}.sqlite`);
    for (const name of [...names, 'unrelated.txt']) writeFileSync(join(dir, name), '');
    // Only one backup is inside the window; the two newest old ones are kept as the minimum.
    expect(rotate(dir, { keepDays: 14, keepMin: 3, now: new Date('2026-09-29T04:00:00Z') }).sort()).toEqual([names[0], names[1]]);
    expect(readdirSync(dir).sort()).toEqual([names[2], names[3], names[4], 'unrelated.txt'].sort());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failed backup leaves no partial copy and no success record, and stale partials are swept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshrooms-backup-'));
  try {
    const out = join(dir, 'backups');
    mkdirSync(out);
    const stale = join(out, 'admission-20260101T000000Z.sqlite.partial');
    writeFileSync(stale, 'left by a crash');
    utimesSync(stale, new Date('2026-09-29T00:00:00Z'), new Date('2026-09-29T00:00:00Z'));
    const junk = join(dir, 'admission.sqlite');
    writeFileSync(junk, 'SQLite format 3\0' + 'x'.repeat(200));
    expect(() => backup({ db: junk, out, keepDays: 14, keepMin: 3, now: new Date('2026-09-29T03:15:00Z') })).toThrow();
    expect(readdirSync(out)).toEqual([]);
    expect(existsSync(join(dir, STATUS_FILE))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
