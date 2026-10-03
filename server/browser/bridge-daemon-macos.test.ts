import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HOME is private: this invokes the actual macOS CLI and plutil, but never writes the
// user's LaunchAgents folder or loads the product's label into the live launchd domain.
test.skipIf(process.platform !== 'darwin')('macOS daemon install works before the daemon directory exists', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mr-macos-cold-install-')));
  const env = { ...process.env, HOME: home };
  for (const key of Object.keys(env)) if (key.startsWith('MESHROOMS_')) delete env[key as keyof typeof env];
  const cli = join(import.meta.dir, '..', 'agent-cli.ts');
  const run = (...args: string[]) => spawnSync(process.execPath, ['--no-env-file', cli, ...args], {
    env, cwd: home, encoding: 'utf8', timeout: 30_000,
  });
  const command = (...args: string[]) => {
    const result = run(...args);
    expect(result.status, `${args.join(' ')}: ${result.stderr}`).toBe(0);
    return JSON.parse(result.stdout);
  };
  const dir = join(home, '.meshrooms', 'daemon');
  const plist = join(home, 'Library', 'LaunchAgents', 'dev.wormdb.meshrooms.agent-daemon.plist');
  try {
    expect(existsSync(dir)).toBe(false);
    const installed = command('daemon', 'install');
    expect(installed).toMatchObject({ installed: true, running: true, pid: expect.any(Number) });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(join(dir, 'login.json'), 'utf8'))).toEqual({});
    expect(spawnSync('/usr/bin/plutil', ['-lint', plist]).status).toBe(0);
    expect(command('daemon', 'status')).toMatchObject({ running: true, pid: installed.pid, startAtLogin: { installed: true } });
    expect(command('daemon', 'start')).toMatchObject({ started: false, pid: installed.pid });
    expect(command('daemon', 'stop')).toMatchObject({ stopped: true, pid: installed.pid });
    expect(command('daemon', 'status')).toMatchObject({ running: false, pid: null });
    expect(command('daemon', 'uninstall')).toMatchObject({ installed: false });
    expect(existsSync(plist)).toBe(false);
  } finally {
    run('daemon', 'stop');
    run('daemon', 'uninstall');
    rmSync(home, { recursive: true, force: true });
  }
}, 90_000);
