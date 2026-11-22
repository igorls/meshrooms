import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchAgentManager, runKeyManager, type Exec } from './startup';
import { testDirectory } from './test-directory';

const plutil = (...args: string[]) => spawnSync('/usr/bin/plutil', args, { encoding: 'utf8' });

test('Windows Run-key registration passes -ExecutionPolicy Bypass before -File', () => {
  const directory = testDirectory('runkey');
  try {
    const values = new Map<string, string>();
    const run: Exec = (_file, args) => {
      const [verb, , , name, ...rest] = args;
      if (verb === 'add') { values.set(name, rest[rest.indexOf('/d') + 1]); return { status: 0, stdout: '' }; }
      if (verb === 'delete') { values.delete(name); return { status: 0, stdout: '' }; }
      return values.has(name) ? { status: 0, stdout: `${name} REG_SZ ${values.get(name)}` } : { status: 1, stdout: '' };
    };
    const scriptPath = join(directory.path, 'start-at-login.ps1');
    const manager = runKeyManager({ valueName: 'Meshrooms-test', scriptPath, script: 'exit 0\n' }, { run, host: { supported: true } });
    expect(manager.apply(true)).toEqual({ installed: true, supported: true });
    expect(values.get('Meshrooms-test')).toContain(`-WindowStyle Hidden -ExecutionPolicy Bypass -File "${scriptPath}"`);
    expect(manager.apply(false)).toEqual({ installed: false, supported: true });
  } finally { directory.cleanup(); }
});

// Uses a private LaunchAgents directory: the test never registers a real login item.
test.skipIf(process.platform !== 'darwin')('a macOS LaunchAgent supervises the foreground daemon and verifies before reporting', () => {
  const directory = testDirectory('launchd');
  try {
    const agents = join(directory.path, 'LaunchAgents');
    const dataDir = join(directory.path, 'data & <node>');
    const manager = launchAgentManager({ dataDir, libraryPath: '/opt/lib/libwormdb_ffi.dylib', port: 4318, cliPath: '/opt/meshrooms/server/cli.ts',
      executable: '/opt/meshrooms/bun', launchAgentsDir: agents });
    expect(manager.status()).toEqual({ installed: false, supported: true });
    expect(manager.apply(true)).toEqual({ installed: true, supported: true });
    const [file] = readdirSync(agents); const plist = join(agents, file!);
    expect(file).toMatch(/^dev\.wormdb\.meshrooms\.[0-9a-f]{16}\.plist$/);
    expect(plutil('-lint', plist).status).toBe(0);
    expect(JSON.parse(plutil('-extract', 'ProgramArguments', 'json', '-o', '-', plist).stdout)).toEqual(['/opt/meshrooms/bun', 'run',
      '/opt/meshrooms/server/daemon.ts', '--supervised', '--data-dir', dataDir, '--library', '/opt/lib/libwormdb_ffi.dylib', '--port', '4318']);
    expect(plutil('-extract', 'KeepAlive.SuccessfulExit', 'raw', '-o', '-', plist).stdout.trim()).toBe('false');
    expect(plutil('-extract', 'RunAtLoad', 'raw', '-o', '-', plist).stdout.trim()).toBe('true');
    // Another runtime path or port leaves a stale entry that must not be reported as active.
    writeFileSync(plist, readFileSync(plist, 'utf8').replace('4318', '4319'));
    expect(manager.status()).toMatchObject({ installed: false, message: expect.stringContaining('repair') });
    expect(manager.apply(true).installed).toBe(true);
    expect(manager.apply(false)).toEqual({ installed: false, supported: true });
    expect(existsSync(plist)).toBe(false);
    expect(manager.apply(false).installed).toBe(false);
  } finally { directory.cleanup(); }
});
