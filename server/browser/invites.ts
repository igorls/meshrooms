import type { Database } from 'bun:sqlite';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { admissionPath, dataDirectory, openAdmission } from './store';

/**
 * Person-admission invite codes for the invite-only beta. Joining a room through its link never needs one. Only a hash of
 * each code is stored; the operator sees the code once, when it is minted.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DAY = 86_400_000;
export type InviteFailure = 'invite-required' | 'invite-invalid' | 'invite-used' | 'invite-expired';
export type InviteRow = { id: string; uses: number; remaining: number; expiresAt: number; note: string; createdAt: number; revokedAt: number | null };
export type BetaPersonRow = { id: string; devices: number; admittedAt: number };
/** Maximum beta-admitted devices one invite holder may link, so one code cannot mint unlimited creator keys. */
export const BETA_DEVICES_PER_PERSON = 8;

/** Codes are typed by people: case, spaces and dashes don't matter. */
export function normalizeInvite(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  const code = value.toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z0-9]{16}$/.test(code) ? code : undefined;
}
const hash = (code: string) => createHash('sha256').update(`meshrooms-invite:${code}`).digest('hex');

export function mintInvite(db: Database, options: { uses: number; days: number; note?: string; now?: number }) {
  const { uses, days } = options, now = options.now ?? Date.now();
  if (!Number.isSafeInteger(uses) || uses < 1 || uses > 1000) throw new Error('Give --uses as a whole number from 1 to 1000.');
  if (!Number.isFinite(days) || days <= 0 || days > 365) throw new Error('Give --days as a number of days from 1 to 365.');
  const note = (options.note ?? '').trim();
  if (note.length > 200 || /[\u0000-\u001f]/.test(note)) throw new Error('Keep --note to one line of at most 200 characters.');
  const raw = Array.from({ length: 16 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  const id = randomBytes(4).toString('hex'), expiresAt = now + Math.round(days * DAY);
  db.query('INSERT INTO creation_invites (id, hash, uses, remaining, expires_at, note, created_at, revoked_at) VALUES (?,?,?,?,?,?,?,NULL)')
    .run(id, hash(raw), uses, uses, expiresAt, note, now);
  return { id, code: raw.match(/.{4}/g)!.join('-'), uses, expiresAt, note };
}

export function listInvites(db: Database): InviteRow[] {
  return db.query('SELECT id, uses, remaining, expires_at AS expiresAt, note, created_at AS createdAt, revoked_at AS revokedAt FROM creation_invites ORDER BY created_at').all() as InviteRow[];
}

export function revokeInvite(db: Database, id: string, now = Date.now()): boolean {
  return db.query('UPDATE creation_invites SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(now, id).changes > 0;
}

/**
 * Uses one creation of a code. Call it inside the create transaction: a failed create rolls the use back, and a retried
 * create is answered from its request receipt before it reaches here, so it never uses a code twice.
 */
export function consumeInvite(db: Database, value: unknown, now: number): InviteFailure | undefined {
  if (value === undefined || value === null || value === '') return 'invite-required';
  const code = normalizeInvite(value);
  if (!code) return 'invite-invalid';
  const row = db.query('SELECT id, remaining, expires_at AS expiresAt, revoked_at AS revokedAt FROM creation_invites WHERE hash=?').get(hash(code)) as
    { id: string; remaining: number; expiresAt: number; revokedAt: number | null } | null;
  if (!row || row.revokedAt !== null) return 'invite-invalid';
  if (row.expiresAt <= now) return 'invite-expired';
  if (row.remaining < 1) return 'invite-used';
  db.query('UPDATE creation_invites SET remaining = remaining - 1 WHERE id=? AND remaining > 0').run(row.id);
  return undefined;
}

/** Admission survives room deletion and code expiry. Only authenticated device linking shares it. */
export function betaPerson(db: Database, device: string): string | undefined {
  return (db.query('SELECT person FROM beta_admissions WHERE device=?').get(device) as { person: string } | null)?.person;
}
/** Every device currently admitted under a beta person. */
export function betaDevices(db: Database, person: string): string[] {
  return (db.query('SELECT device FROM beta_admissions WHERE person=?').all(person) as { device: string }[]).map(row => row.device);
}
/**
 * Admits one device under `person`, up to `BETA_DEVICES_PER_PERSON` distinct rows per person so a single invite
 * holder cannot mint unlimited creator keys. Existing rows stay untouched.
 */
export function admitBetaDevice(db: Database, device: string, person = device, now = Date.now()): boolean {
  if (betaPerson(db, device)) return false;
  return db.query('INSERT OR IGNORE INTO beta_admissions (device, person, admitted_at) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM beta_admissions WHERE person=?) < ?')
    .run(device, person, now, person, BETA_DEVICES_PER_PERSON).changes > 0;
}
/** Admitted beta people for operators: person id, linked device count, earliest admission time (no secrets). */
export function listBetaPeople(db: Database): BetaPersonRow[] {
  return db.query('SELECT person AS id, COUNT(*) AS devices, MIN(admitted_at) AS admittedAt FROM beta_admissions GROUP BY person ORDER BY admittedAt DESC').all() as BetaPersonRow[];
}
/**
 * Removes all beta-admission rows for `person` and remembers the devices as revoked, so the service's start (which
 * re-admits the hosts of existing rooms from before invites) doesn't give them back. Redeeming a new invite clears it.
 * Returns the number of device rows deleted.
 */
export function revokeBetaPerson(db: Database, person: string, now = Date.now()): number {
  return db.transaction(() => {
    db.query('INSERT OR REPLACE INTO beta_revocations (device, person, revoked_at) SELECT device, person, ? FROM beta_admissions WHERE person=?').run(now, person);
    return db.query('DELETE FROM beta_admissions WHERE person=?').run(person).changes;
  }).immediate();
}
/** Whether the operator revoked this device's creation admission and no new invite has been redeemed since. */
export function betaRevoked(db: Database, device: string): boolean {
  return !!db.query('SELECT 1 FROM beta_revocations WHERE device=?').get(device);
}

export const inviteMessages: Record<InviteFailure, string> = {
  'invite-required': 'Enter your beta invite once to unlock room creation. After that, you can create more rooms without a code.',
  'invite-invalid': 'That invite code isn’t valid. Check it and try again.',
  'invite-used': 'That invite code has been used up. Ask for a new one.',
  'invite-expired': 'That invite code has expired. Ask for a new one.',
};

const usage = `Usage (run as the service account, with MESHROOMS_BROWSER_DATA set to the service's data directory):
  bun run server/browser/invites.ts mint --uses <n> --days <d> [--note "<who it is for>"]
  bun run server/browser/invites.ts list
  bun run server/browser/invites.ts revoke <id>
  bun run server/browser/invites.ts people
  bun run server/browser/invites.ts revoke-person <person>`;

export function invitesCli(args: string[], db: Database, print: (line: string) => void = console.log) {
  const [command, ...rest] = args;
  const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
  if (command === 'mint') {
    const invite = mintInvite(db, { uses: Number(flag('uses') ?? 1), days: Number(flag('days') ?? 14), note: flag('note') });
    print(`Invite ${invite.id}: ${invite.uses} user${invite.uses === 1 ? '' : 's'}, until ${new Date(invite.expiresAt).toISOString()}${invite.note ? ` (${invite.note})` : ''}`);
    print(`Code (shown only now): ${invite.code}`);
    return;
  }
  if (command === 'list') {
    const rows = listInvites(db), now = Date.now();
    if (!rows.length) { print('No invite codes.'); return; }
    for (const r of rows) {
      const state = r.revokedAt !== null ? 'revoked' : r.expiresAt <= now ? 'expired' : r.remaining < 1 ? 'used up' : 'active';
      print([r.id, state, `${r.uses - r.remaining}/${r.uses} used`, `expires ${new Date(r.expiresAt).toISOString()}`, r.note].filter(Boolean).join('\t'));
    }
    return;
  }
  if (command === 'revoke' && rest[0]) {
    if (!revokeInvite(db, rest[0])) throw new Error(`No active invite ${rest[0]}.`);
    print(`Revoked ${rest[0]}.`);
    return;
  }
  if (command === 'people') {
    const rows = listBetaPeople(db);
    if (!rows.length) { print('No admitted people.'); return; }
    for (const r of rows) {
      print([r.id, `${r.devices} device${r.devices === 1 ? '' : 's'}`, `admitted ${new Date(r.admittedAt).toISOString()}`].join('\t'));
    }
    return;
  }
  if (command === 'revoke-person' && rest[0]) {
    const removed = revokeBetaPerson(db, rest[0]);
    if (!removed) throw new Error(`No admitted person ${rest[0]}.`);
    print(`Revoked ${rest[0]} (${removed} device${removed === 1 ? '' : 's'}).`);
    return;
  }
  throw new Error(usage);
}

if (import.meta.main) {
  try {
    const path = admissionPath(dataDirectory());
    if (!existsSync(path)) throw new Error(`No admission database at ${path}. Set MESHROOMS_BROWSER_DATA to the service's data directory.`);
    const db = openAdmission(path);
    try { invitesCli(process.argv.slice(2), db); } finally { db.close(); }
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
