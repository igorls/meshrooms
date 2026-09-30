/**
 * Back up the browser coordinator's admission SQLite while it runs.
 *
 *   bun backup-admission.ts backup [--db <file>] [--out <dir>] [--keep-days 14] [--keep-min 3]
 *   bun backup-admission.ts verify <backup.sqlite>
 *
 * `VACUUM INTO` copies one consistent read snapshot (including committed pages still in the WAL)
 * into a new standalone database, without blocking the coordinator's writers in WAL mode. It uses
 * the same SQLite library as the coordinator (bun:sqlite), so the host needs no sqlite3 package.
 * The copy is written under a temporary name, checked with `PRAGMA integrity_check`, flushed and
 * only then renamed into place, so a listed backup is always a complete, verified file. The time of
 * the last verified backup goes to last-backup.json next to the database, where the coordinator's
 * health endpoint reads it (MESHROOMS_BACKUP_MAX_AGE_HOURS).
 */
import { Database } from 'bun:sqlite';
import { chmodSync, chownSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const PREFIX = 'admission-';
const NAME = /^admission-(\d{8}T\d{6}Z)\.sqlite$/;
const TABLES = ['rooms', 'receipts', 'avatars'];
const DAY = 86_400_000;
/** Must match BACKUP_STATUS_FILE in server/browser/backup-status.ts (a test checks both sides). */
export const STATUS_FILE = 'last-backup.json';

type Options = { db: string; out: string; keepDays: number; keepMin: number; now: Date };

const log = (message: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), message, ...fields }));
const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const parseStamp = (value: string) => new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`);

/** Flush a file (or, on POSIX, a directory entry) to disk. Windows cannot open directories for fsync. */
function fsyncPath(path: string, directory = false) {
  if (directory && process.platform === 'win32') return;
  const fd = openSync(path, directory ? 'r' : 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Integrity-check a database file and count its rows. Throws if it is not a healthy admission copy. */
export function verify(file: string) {
  const db = new Database(file, { readonly: true });
  try {
    const integrity = db.query('PRAGMA integrity_check').all().map(row => Object.values(row as object)[0]);
    if (integrity.length !== 1 || integrity[0] !== 'ok') throw new Error(`integrity_check failed for ${file}: ${integrity.slice(0, 5).join('; ')}`);
    const present = new Set(db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => (row as { name: string }).name));
    const counts: Record<string, number> = {};
    for (const table of TABLES) {
      if (!present.has(table)) throw new Error(`${file} has no ${table} table; it is not an admission database`);
      counts[table] = (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    }
    return { integrity: 'ok', counts, bytes: statSync(file).size };
  } finally { db.close(); }
}

/**
 * A root process opening a WAL database can create its -wal/-shm files. SQLite gives such files the
 * database owner when it runs as root, but the service must never find root-owned sidecars, so check
 * and repair explicitly rather than rely on it.
 */
function repairSidecarOwnership(db: string) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  const owner = statSync(db);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const file = db + suffix;
    if (!existsSync(file)) continue;
    const stat = statSync(file);
    if (stat.uid === owner.uid && stat.gid === owner.gid) continue;
    chownSync(file, owner.uid, owner.gid);
    log('repaired sidecar ownership', { file, uid: owner.uid, gid: owner.gid });
  }
}

/**
 * Record the last verified backup where the coordinator can read it (see server/browser/backup-status.ts): a small
 * JSON file in the admission data directory, owned like the database, mode 0600, replaced atomically.
 */
export function writeStatus(db: string, status: { at: number; file: string; bytes: number }) {
  const dir = dirname(db);
  const file = join(dir, STATUS_FILE);
  const temporary = join(dir, `.${STATUS_FILE}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(status)}
`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  if (typeof process.getuid === 'function' && process.getuid() === 0) { const owner = statSync(db); chownSync(temporary, owner.uid, owner.gid); }
  fsyncPath(temporary);
  renameSync(temporary, file);
  fsyncPath(dir, true);
}

/** A crash or a full disk can leave a .partial copy behind. It is never a valid backup; clear old ones first. */
export function sweepPartials(out: string, now: Date, olderThanMs = 3_600_000) {
  const removed: string[] = [];
  for (const name of readdirSync(out)) {
    if (!name.startsWith(PREFIX) || !name.endsWith('.sqlite.partial')) continue;
    if (now.getTime() - statSync(join(out, name)).mtimeMs >= olderThanMs) { rmSync(join(out, name), { force: true }); removed.push(name); }
  }
  if (removed.length) log('removed stale partial copies', { removed });
  return removed;
}

export function backup(options: Options) {
  const db = resolve(options.db);
  const out = resolve(options.out);
  if (!existsSync(db)) throw new Error(`No admission database at ${db}`);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  chmodSync(out, 0o700);
  sweepPartials(out, options.now);
  const final = join(out, `${PREFIX}${stamp(options.now)}.sqlite`);
  const partial = `${final}.partial`;
  if (existsSync(final)) throw new Error(`${final} already exists`);
  rmSync(partial, { force: true });
  const started = Date.now();
  try {
    const source = new Database(db, { readonly: true });
    try {
      source.exec('PRAGMA busy_timeout = 10000');
      source.query('VACUUM INTO ?').run(partial);
    } finally {
      source.close();
      repairSidecarOwnership(db);
    }
    chmodSync(partial, 0o600);
    const checked = verify(partial);
    fsyncPath(partial);
    renameSync(partial, final);
    fsyncPath(out, true);
    log('backup complete', { file: final, ms: Date.now() - started, ...checked });
    writeStatus(db, { at: options.now.getTime(), file: basename(final), bytes: checked.bytes });
  } catch (error) {
    // Includes a failed VACUUM INTO (for example ENOSPC): never leave the partial copy to fill the disk further.
    rmSync(partial, { force: true });
    throw error;
  }
  rotate(out, options);
  return final;
}

/** Delete verified backups older than keepDays, always keeping the newest keepMin. */
export function rotate(out: string, { keepDays, keepMin, now }: Pick<Options, 'keepDays' | 'keepMin' | 'now'>) {
  const backups = readdirSync(out).map(name => ({ name, match: NAME.exec(name) })).filter(entry => entry.match)
    .map(entry => ({ name: entry.name, at: parseStamp(entry.match![1]).getTime() })).sort((a, b) => b.at - a.at);
  const removed: string[] = [];
  for (const [index, entry] of backups.entries()) {
    if (index < keepMin || now.getTime() - entry.at <= keepDays * DAY) continue;
    rmSync(join(out, entry.name)); removed.push(entry.name);
  }
  log('rotation complete', { kept: backups.length - removed.filter(name => NAME.test(name)).length, removed });
  return removed;
}

function parse(argv: string[]) {
  const [command = 'backup', ...rest] = argv;
  const options: Options = { db: '/var/lib/meshrooms-browser/admission.sqlite', out: '/var/backups/meshrooms-browser', keepDays: 14, keepMin: 3, now: new Date() };
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = () => { const next = rest[++i]; if (next === undefined) throw new Error(`${flag} needs a value`); return next; };
    if (flag === '--db') options.db = value();
    else if (flag === '--out') options.out = value();
    else if (flag === '--keep-days') options.keepDays = Number(value());
    else if (flag === '--keep-min') options.keepMin = Number(value());
    else if (flag === '--now') options.now = new Date(value());
    else if (flag.startsWith('--')) throw new Error(`Unknown option ${flag}`);
    else positional.push(flag);
  }
  if (!(options.keepDays > 0) || !(options.keepMin >= 1) || Number.isNaN(options.now.getTime())) throw new Error('Invalid --keep-days, --keep-min or --now');
  return { command, options, positional };
}

if (import.meta.main) {
  try {
    const { command, options, positional } = parse(process.argv.slice(2));
    if (command === 'backup') backup(options);
    else if (command === 'verify' && positional.length === 1) log('verified', { file: resolve(positional[0]), ...verify(positional[0]) });
    else throw new Error('Usage: backup-admission.ts backup [--db file] [--out dir] [--keep-days 14] [--keep-min 3] | verify <file>');
  } catch (error) {
    console.error(JSON.stringify({ at: new Date().toISOString(), message: 'backup failed', error: (error as Error).message }));
    process.exit(1);
  }
}
