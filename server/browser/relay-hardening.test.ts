import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserConfig, RELAY_SECRET_MIN_LENGTH } from './config';
import { CURRENT_SCHEMA_VERSION, openAdmission } from './store';
import { WakeConnector } from './wake-connector';

const dirs: string[] = [];
const processes: { kill: () => void }[] = [];
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'mr-relay-hardening-')); dirs.push(dir); return dir; };
afterEach(() => {
  for (const p of processes.splice(0)) { try { p.kill(); } catch { /* already gone */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('MESHROOMS_RELAY_ENABLED (relay ships dark)', () => {
  const secret = 's'.repeat(RELAY_SECRET_MIN_LENGTH);

  test('is off unless explicitly set to 1, and rejects other values', () => {
    expect(browserConfig({}).relayEnabled).toBe(false);
    expect(browserConfig({ MESHROOMS_RELAY_ENABLED: '' }).relayEnabled).toBe(false);
    expect(browserConfig({ MESHROOMS_RELAY_ENABLED: '0' }).relayEnabled).toBe(false);
    expect(browserConfig({ MESHROOMS_RELAY_ENABLED: '1', MESHROOMS_RELAY_SECRET: secret }).relayEnabled).toBe(true);
    for (const bad of ['true', 'yes', 'on', '2']) expect(() => browserConfig({ MESHROOMS_RELAY_ENABLED: bad })).toThrow('MESHROOMS_RELAY_ENABLED must be');
  });

  test('turning it on requires an explicit, long-enough MESHROOMS_RELAY_SECRET', () => {
    expect(() => browserConfig({ MESHROOMS_RELAY_ENABLED: '1' })).toThrow('MESHROOMS_RELAY_SECRET');
    expect(() => browserConfig({ MESHROOMS_RELAY_ENABLED: '1', MESHROOMS_RELAY_SECRET: 'short' })).toThrow('MESHROOMS_RELAY_SECRET');
    // A leftover secret with the relay off is harmless and not validated.
    expect(browserConfig({ MESHROOMS_RELAY_SECRET: 'short' }).relayEnabled).toBe(false);
  });

  async function boot(env: Record<string, string>, port: number) {
    const dataDir = tempDir();
    const proc = Bun.spawn(['bun', 'server/browser/main.ts'], {
      env: { ...process.env, MESHROOMS_BROWSER_PORT: String(port), MESHROOMS_BROWSER_DATA: dataDir, MESHROOMS_BROWSER_ORIGIN: `http://127.0.0.1:${port}`, ...env },
      stdout: 'pipe', stderr: 'pipe',
    });
    processes.push(proc);
    return { dataDir, proc, origin: `http://127.0.0.1:${port}` };
  }
  async function ready(proc: ReturnType<typeof Bun.spawn>, origin: string) {
    for (let i = 0; i < 150; i++) {
      if (proc.exitCode !== null) throw new Error(`server exited early (${proc.exitCode})`);
      try { if ((await fetch(`${origin}/api/lobby/health`)).ok) return; } catch { /* not listening yet */ }
      await Bun.sleep(100);
    }
    throw new Error('server did not start');
  }
  const freePort = () => { const s = Bun.serve({ port: 0, fetch: () => new Response('') }); const port = s.port!; s.stop(true); return port; };

  test('off: the coordinator behaves as before the relay: relay routes 404, health does not advertise it, no relay database is created', async () => {
    const { dataDir, proc, origin } = await boot({}, freePort());
    await ready(proc, origin);
    const health = await (await fetch(`${origin}/api/lobby/health`)).json() as Record<string, unknown>;
    expect(health.ok).toBe(true);
    expect(health).not.toHaveProperty('relayEnabled');
    for (const path of ['/api/relay/v1', '/api/relay/v1/open', '/api/relay/v1/send', '/api/relay/v1/poll', '/api/relay/v1/state', '/api/relay/v1/wake-register']) {
      const res = await fetch(`${origin}${path}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
      expect(res.status).toBe(404);
    }
    expect(readdirSync(dataDir).filter(name => name.startsWith('relay.sqlite'))).toEqual([]);
    // The pre-relay request body cap is back: a 40 KB body is refused before it is parsed.
    const big = await fetch(`${origin}/api/lobby/commands`, { method: 'POST', body: 'x'.repeat(40_000) }).catch(() => undefined);
    expect(big === undefined || big.status >= 400).toBe(true);
  }, 30_000);

  test('on: health advertises the relay and its database exists', async () => {
    const { dataDir, proc, origin } = await boot({ MESHROOMS_RELAY_ENABLED: '1', MESHROOMS_RELAY_SECRET: secret }, freePort());
    await ready(proc, origin);
    const health = await (await fetch(`${origin}/api/lobby/health`)).json() as Record<string, unknown>;
    expect(health.relayEnabled).toBe(true);
    expect(existsSync(join(dataDir, 'relay.sqlite'))).toBe(true);
  }, 30_000);

  test('on without a secret: the process refuses to start', async () => {
    const { proc } = await boot({ MESHROOMS_RELAY_ENABLED: '1' }, freePort());
    expect(await proc.exited).not.toBe(0);
    expect(await new Response(proc.stderr as ReadableStream).text()).toContain('MESHROOMS_RELAY_SECRET');
  }, 30_000);
});

describe('WakeConnector secret handling (no random fallback)', () => {
  test('refuses to store registrations on disk without an explicit secret', () => {
    const dbPath = join(tempDir(), 'relay.sqlite');
    expect(() => new WakeConnector({ dbPath })).toThrow(/explicit secret/);
    expect(() => new WakeConnector({ dbPath, secret: '' })).toThrow(/explicit secret/);
  });

  test('registrations survive a restart with the same secret and cannot be read with another', async () => {
    const dbPath = join(tempDir(), 'relay.sqlite');
    const room = crypto.randomUUID(), device = 'a'.repeat(64), sender = 'b'.repeat(64);
    const hooks: string[] = [];
    const webhook = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: req => { hooks.push(req.headers.get('authorization') ?? ''); return new Response('ok'); } });
    try {
      const options = { dbPath, allowLoopbackHttp: true, retryDelayMs: 1 };
      const first = new WakeConnector({ ...options, secret: 'first-secret-first-secret-first-secret' });
      first.register(room, device, `http://127.0.0.1:${webhook.port}/hook`, 'bearer-1');
      first.close();

      const sameSecret = new WakeConnector({ ...options, secret: 'first-secret-first-secret-first-secret' });
      expect(await sameSecret.notify(room, device, sender, 1)).toBe('dispatched');
      expect(hooks).toEqual(['Bearer bearer-1']);
      sameSecret.close();

      // A different secret (what a random per-process key amounts to after a restart) cannot decrypt: the wake silently fails.
      const otherSecret = new WakeConnector({ ...options, secret: 'another-secret-another-secret-another' });
      expect(await otherSecret.notify(room, device, sender, 1)).toBe('failed');
      expect(hooks).toHaveLength(1);
      otherSecret.close();
    } finally { webhook.stop(true); }
  });

  test('an in-memory connector (nothing persisted) may run without a secret', () => {
    expect(() => new WakeConnector({ allowLoopbackHttp: true }).close()).not.toThrow();
    expect(() => new WakeConnector({ dbPath: ':memory:' }).close()).not.toThrow();
  });
});

describe('admission database backup before the one-way v3 migration', () => {
  /** An admission database that has the current tables but reports schema v2, as a pre-relay deployment would. */
  function legacyV2(path: string) {
    const db = openAdmission(path, 1000);
    db.query('INSERT INTO rooms (id, body, owner_id, title, member_count, device_count, meta_version) VALUES (?,?,?,?,?,?,?)').run('room-1', '{"id":"room-1"}', 'o', 'Old room', 1, 0, 1);
    db.exec('PRAGMA user_version = 2');
    db.close();
  }

  test('keeps an owner-only copy that still opens as schema v2, once, and never overwrites it', () => {
    const dir = tempDir(), path = join(dir, 'admission.sqlite');
    legacyV2(path);
    const migrated = openAdmission(path, 2000);
    expect(migrated.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(CURRENT_SCHEMA_VERSION);
    migrated.query("UPDATE rooms SET title = 'changed after migration' WHERE id = 'room-1'").run();
    migrated.close();

    const backup = `${path}.pre-v${CURRENT_SCHEMA_VERSION}-from-v2.bak`;
    expect(existsSync(backup)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(backup).mode & 0o777).toBe(0o600);
    const copy = new Database(backup, { readonly: true });
    expect(copy.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(2);
    expect(copy.query<{ title: string }, []>("SELECT title FROM rooms WHERE id = 'room-1'").get()?.title).toBe('Old room');
    copy.close();

    // A later start (already v3) neither migrates nor rewrites the backup.
    const before = statSync(backup).mtimeMs;
    openAdmission(path, 3000).close();
    expect(statSync(backup).mtimeMs).toBe(before);
  });

  test('a fresh database and an in-memory one take no backup, and backup can be disabled explicitly', () => {
    const dir = tempDir();
    openAdmission(join(dir, 'fresh.sqlite'), 1000).close();
    expect(readdirSync(dir).filter(name => name.endsWith('.bak'))).toEqual([]);
    openAdmission(':memory:', 1000).close();
    const optOut = join(dir, 'optout.sqlite');
    legacyV2(optOut);
    openAdmission(optOut, 2000, { backup: false }).close();
    expect(readdirSync(dir).filter(name => name.endsWith('.bak'))).toEqual([]);
  });

  test('a backup that cannot be written stops the migration and leaves the database untouched at v2', () => {
    const dir = tempDir(), path = join(dir, 'admission.sqlite');
    legacyV2(path);
    // The backup target is a directory, so the copy fails.
    mkdirSync(`${path}.pre-v${CURRENT_SCHEMA_VERSION}-from-v2.bak`);
    expect(() => openAdmission(path, 2000)).toThrow(/back up the admission database/);
    const db = new Database(path, { readonly: true });
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(2);
    db.close();
  });
});
