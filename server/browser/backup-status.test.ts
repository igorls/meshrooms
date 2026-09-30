import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserLobby } from './lobby';
import { browserHandler } from './http';
import { browserConfig } from './config';
import { BACKUP_STATUS_FILE, backupFreshness, readBackupStatus } from './backup-status';

const HOUR = 3_600_000;
const origin = 'http://127.0.0.1:4320';

test('backup freshness follows the recorded time, re-reading the file at most once a minute', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshrooms-backup-status-'));
  try {
    let now = 100 * HOUR;
    const fresh = backupFreshness(dir, 26, () => now);
    expect(fresh()).toBe(false); // no backup recorded yet
    writeFileSync(join(dir, BACKUP_STATUS_FILE), JSON.stringify({ at: now - 2 * HOUR }));
    expect(fresh()).toBe(false); // cached for a minute
    now += 60_000;
    expect(fresh()).toBe(true);
    now += 25 * HOUR;
    expect(fresh()).toBe(false); // 27 hours old
    writeFileSync(join(dir, BACKUP_STATUS_FILE), 'not json');
    expect(readBackupStatus(dir)).toBeUndefined();
    writeFileSync(join(dir, BACKUP_STATUS_FILE), JSON.stringify({ at: now + 2 * HOUR }));
    now += 60_000;
    expect(fresh()).toBe(false); // a future time is not trusted
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('health reports backupFresh only when a maximum age is configured', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshrooms-backup-status-'));
  const lobby = new BrowserLobby(join(dir, 'admission.sqlite'), { origin });
  try {
    const health = async (backupFresh?: () => boolean) => (await browserHandler(lobby, origin, '.', { backupFresh })(new Request(`${origin}/api/lobby/health`))).json();
    expect(await health()).not.toHaveProperty('backupFresh');
    expect(await health(() => true)).toMatchObject({ ok: true, backupFresh: true });
    // A stale backup is reported, never turned into a failing health check.
    const stale = await browserHandler(lobby, origin, '.', { backupFresh: () => false })(new Request(`${origin}/api/lobby/health`));
    expect(stale.status).toBe(200);
    expect(await stale.json()).toMatchObject({ ok: true, backupFresh: false });
  } finally { lobby.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('MESHROOMS_BACKUP_MAX_AGE_HOURS is optional and must be positive', () => {
  expect(browserConfig({}).backupMaxAgeHours).toBeUndefined();
  expect(browserConfig({ MESHROOMS_BACKUP_MAX_AGE_HOURS: '26' }).backupMaxAgeHours).toBe(26);
  expect(() => browserConfig({ MESHROOMS_BACKUP_MAX_AGE_HOURS: '-1' })).toThrow(/MESHROOMS_BACKUP_MAX_AGE_HOURS/);
});
