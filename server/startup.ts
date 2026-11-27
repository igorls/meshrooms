import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dlopen, ptr } from 'bun:ffi';
import { startupHostStatus } from './windows-path';

export type StartupState = { installed: boolean; supported: boolean; message?: string };
export interface StartupManager { status(): StartupState; apply(enabled: boolean): StartupState }
export type StartupOptions = { dataDir: string; libraryPath: string; port: number; cliPath: string; executable?: string; launchAgentsDir?: string };
const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
/** A PowerShell single-quoted string: PowerShell ends one at any single quote, ASCII or typographic (U+2018-U+201B), so each is doubled. */
export const quotePS = (text: string) => `'${text.replace(/['\u2018-\u201b]/g, quote => quote + quote)}'`;
const xml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const nodeHash = (dataDir: string) => createHash('sha256').update(dataDir).digest('hex').slice(0, 16);
/**
 * A login entry without the environment it sets: the environment is the installing shell's (its PATH), so a check from
 * another shell compares everything else and doesn't report a working entry as needing repair.
 */
const withoutEnv = (text: string) => text.replace(/ {2}<key>EnvironmentVariables<\/key>\n {2}<dict>\n[\s\S]*?\n {2}<\/dict>\n/, '')
  .split('\n').filter(line => !line.startsWith('Environment=') && !line.startsWith('$env:')).join('\n');

/** HKCU registration is per-user and is applied only for an explicit settings command. */
export function startupManager(options: StartupOptions): StartupManager {
  if (process.platform === 'darwin') return launchAgentManager(options);
  if (process.platform !== 'win32') return { status: () => ({ installed: false, supported: false, message: 'Start at login is currently available on Windows and macOS.' }),
    apply(enabled) { if (enabled) throw new Error('Start at login is not supported on this platform yet.'); return this.status(); } };
  const dataDir = resolve(options.dataDir);
  const scriptPath = join(dataDir, 'start-at-login.ps1');
  const script = `$ErrorActionPreference = 'Stop'\n& ${quotePS(options.executable || process.execPath)} run ${quotePS(options.cliPath)} ensure --data-dir ${quotePS(dataDir)} --library ${quotePS(options.libraryPath)} --port ${options.port}\nexit $LASTEXITCODE\n`;
  return runKeyManager({ valueName: `Meshrooms-${nodeHash(dataDir.toLowerCase())}`, scriptPath, script });
}

/** What an external command answered; injected so tests never change the real login configuration. */
export type Exec = (file: string, args: string[]) => { status: number | null; stdout: string };
const exec: Exec = (file, args) => { const result = spawnSync(file, args, { windowsHide: true, encoding: 'utf8', timeout: 5000 }); return { status: result.status, stdout: result.stdout ?? '' }; };

/** A Run key value's text, or null when it is missing or not a string. */
export type ReadRunValue = (valueName: string) => string | null;

let advapi32: { RegGetValueW: (...args: unknown[]) => number } | undefined;
/**
 * Reads a value of the per-user Run key through the registry API, in UTF-16. `reg query` output is never parsed for
 * this: reg.exe prints in the console's OEM code page (850 on a default Portuguese or Western European Windows), so a
 * home folder with an accent (one named João, say) came back garbled, the entry never matched, and start at login could not be verified.
 */
export const readRunValue: ReadRunValue = valueName => {
  advapi32 ??= dlopen('advapi32.dll', {
    RegGetValueW: { args: ['u64', 'ptr', 'ptr', 'u32', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
  }).symbols as unknown as { RegGetValueW: (...args: unknown[]) => number };
  // HKEY_CURRENT_USER is (HKEY)(LONG)0x80000001: sign-extended to the 64-bit handle.
  const HKCU = 0xffffffff80000001n, RRF_RT_STRING = 0x2 | 0x4, RRF_NOEXPAND = 0x10000000, ERROR_MORE_DATA = 234;
  const subKey = Buffer.from('Software\\Microsoft\\Windows\\CurrentVersion\\Run\0', 'utf16le'), value = Buffer.from(`${valueName}\0`, 'utf16le');
  const size = Buffer.alloc(4);
  for (let bytes = 2048, attempt = 0; attempt < 3; attempt++) {
    const data = Buffer.alloc(bytes);
    size.writeUInt32LE(bytes);
    const status = advapi32.RegGetValueW(HKCU, ptr(subKey), ptr(value), RRF_RT_STRING | RRF_NOEXPAND, null, ptr(data), ptr(size));
    if (status === 0) return data.subarray(0, size.readUInt32LE()).toString('utf16le').replace(/\0[\s\S]*$/, '');
    // Missing (2), not a string (1630) or unreadable: not this entry.
    if (status !== ERROR_MORE_DATA) return null;
    bytes = Math.max(size.readUInt32LE(), bytes * 2);
  }
  return null;
};

/** The data `reg query <key> /v <name>` printed for a string value, for an injected reg.exe in tests. */
const queriedValue = (run: Exec, valueName: string): string | null => {
  const result = run('reg.exe', ['query', key, '/v', valueName]);
  if (result.status !== 0) return null;
  const match = result.stdout.match(/\sREG_(?:EXPAND_)?SZ(?:\s+(.*))?$/m);
  return match ? (match[1] ?? '').trimEnd() : null;
};

/**
 * A per-user Run key value that starts a PowerShell script, hidden, at login. The script is kept beside the program's
 * state, and the entry counts as installed only while both the value and the script are exactly what this writes.
 */
export function runKeyManager(entry: { valueName: string; scriptPath: string; script: string }, options: { run?: Exec; read?: ReadRunValue; host?: { supported: boolean; message?: string } } = {}): StartupManager {
  const host = options.host ?? startupHostStatus();
  if (!host.supported) return { status: () => ({ installed: false, ...host }),
    apply(enabled) { if (enabled) throw new Error(host.message); return this.status(); } };
  const { valueName, scriptPath, script } = entry, run = options.run ?? exec;
  // reg.exe takes its arguments in UTF-16, so writing and deleting through it is exact; reading goes through the API.
  // An injected reg.exe (tests) is read back through its own `query`.
  const read = options.read ?? (options.run ? (name: string) => queriedValue(run, name) : readRunValue);
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = `"${powershell}" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${scriptPath}"`;
  const reg = (args: string[]) => run('reg.exe', args);
  const status = (): StartupState => {
    const data = read(valueName);
    const installed = data === command && existsSync(scriptPath) && withoutEnv(readFileSync(scriptPath, 'utf8')) === withoutEnv(script);
    return { installed, supported: true, ...(data !== null && !installed ? { message: 'The startup entry needs repair before it can be marked active.' } : {}) };
  };
  return { status, apply(enabled) {
    if (enabled) {
      mkdirSync(dirname(scriptPath), { recursive: true }); writeFileSync(scriptPath, script, { mode: 0o600 });
      const result = reg(['add', key, '/v', valueName, '/t', 'REG_SZ', '/d', command, '/f']);
      if (result.status !== 0) throw new Error('Windows could not register start at login. Your preference was not saved.');
    } else if (read(valueName) !== null && reg(['delete', key, '/v', valueName, '/f']).status !== 0) {
      throw new Error('Windows could not remove the Meshrooms startup entry.');
    }
    const result = status(); if (result.installed !== enabled) throw new Error('The startup preference could not be verified.'); return result;
  } };
}

/**
 * A per-user LaunchAgent runs the daemon in the foreground so launchd restarts it after a crash.
 * Changes take effect at the next login: loading the job now would collide with this running daemon,
 * and unloading it could stop the process that is answering the settings request.
 */
export function launchAgentManager(options: StartupOptions): StartupManager {
  const dataDir = resolve(options.dataDir);
  const label = `dev.wormdb.meshrooms.${nodeHash(dataDir)}`;
  const plistPath = join(options.launchAgentsDir || join(homedir(), 'Library', 'LaunchAgents'), `${label}.plist`);
  const args = [options.executable || process.execPath, 'run', join(dirname(options.cliPath), 'daemon.ts'), '--supervised',
    '--data-dir', dataDir, '--library', resolve(options.libraryPath), '--port', String(options.port)];
  return plistManager(label, plistPath, launchAgentPlist(label, args, join(dataDir, 'daemon.log')));
}

/**
 * A LaunchAgent that starts `args` at login and again after it fails (KeepAlive SuccessfulExit=false: a clean exit,
 * such as a second copy finding the first one running, isn't restarted). `env` sets its environment: launchd gives a
 * job only a minimal PATH.
 */
export function launchAgentPlist(label: string, args: string[], log: string, env: Record<string, string> = {}) {
  const variables = Object.entries(env);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(arg => `    <string>${xml(arg)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
${variables.length ? `  <key>EnvironmentVariables</key>
  <dict>
${variables.map(([name, value]) => `    <key>${xml(name)}</key><string>${xml(value)}</string>`).join('\n')}
  </dict>
` : ''}  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}
/** Installs or removes a LaunchAgent file, and reports it installed only while the file is exactly `plist` and macOS hasn't turned it off. */
function plistManager(label: string, plistPath: string, plist: string, run?: Exec): StartupManager {
  // A user can switch the item off in System Settings; the file alone would then overstate the registration.
  const disabled = () => {
    const result = (run ?? exec)('/bin/launchctl', ['print-disabled', `gui/${process.getuid?.() ?? 0}`]);
    return result.status === 0 && new RegExp(`"${label.replaceAll('.', '\\.')}" => (disabled|true)`).test(result.stdout);
  };
  const status = (): StartupState => {
    if (!existsSync(plistPath)) return { installed: false, supported: true };
    if (withoutEnv(readFileSync(plistPath, 'utf8')) !== withoutEnv(plist)) return { installed: false, supported: true, message: 'The startup entry needs repair before it can be marked active.' };
    if (disabled()) return { installed: false, supported: true, message: 'macOS has turned this login item off. Allow Meshrooms in System Settings > General > Login Items.' };
    return { installed: true, supported: true };
  };
  return { status, apply(enabled) {
    if (enabled) { mkdirSync(dirname(plistPath), { recursive: true }); writeFileSync(plistPath, plist, { mode: 0o644 }); }
    else rmSync(plistPath, { force: true });
    const result = status(); if (result.installed !== enabled) throw new Error(result.message || 'The startup preference could not be verified.'); return result;
  } };
}

/** A word in a systemd unit line: quoted, with its escapes, and `%` and `$` doubled so systemd expands neither. */
const systemdWord = (text: string) => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$$$')}"`;
/**
 * A systemd user unit that runs `args` and restarts it after a failure (Restart=on-failure, like the LaunchAgent).
 * KillMode=process: stopping or restarting the unit stops only its main process. What it started detached (an agent's
 * runner, its watcher, a wake in progress) carries on and is adopted by the next one, as on the other systems; systemd
 * would otherwise kill the unit's whole control group.
 */
export function systemdUnit(description: string, args: string[], env: Record<string, string> = {}) {
  return ['[Unit]', `Description=${description}`, 'After=network-online.target', '', '[Service]', 'Type=simple', `ExecStart=${args.map(systemdWord).join(' ')}`,
    ...Object.entries(env).map(([name, value]) => `Environment=${systemdWord(`${name}=${value}`)}`),
    'Restart=on-failure', 'RestartSec=10', 'KillMode=process', '', '[Install]', 'WantedBy=default.target', ''].join('\n');
}
function systemdManager(name: string, unitPath: string, unit: string, run: Exec): StartupManager {
  const service = `${name}.service`, systemctl = (...args: string[]) => run('systemctl', ['--user', ...args]);
  const status = (): StartupState => {
    if (!existsSync(unitPath)) return { installed: false, supported: true };
    if (withoutEnv(readFileSync(unitPath, 'utf8')) !== withoutEnv(unit)) return { installed: false, supported: true, message: 'The startup entry needs repair before it can be marked active.' };
    const enabled = systemctl('is-enabled', service);
    if (enabled.status !== 0 || enabled.stdout.trim() !== 'enabled') return { installed: false, supported: true, message: `systemd doesn't have ${service} enabled. Run install again.` };
    return { installed: true, supported: true };
  };
  return { status, apply(enabled) {
    if (enabled) {
      mkdirSync(dirname(unitPath), { recursive: true }); writeFileSync(unitPath, unit, { mode: 0o644 });
      if (systemctl('daemon-reload').status !== 0 || systemctl('enable', '--now', service).status !== 0)
        throw new Error(`systemctl --user could not enable ${service}. Is a systemd user session running (systemctl --user status)?`);
    } else if (existsSync(unitPath)) {
      systemctl('disable', '--now', service);
      rmSync(unitPath, { force: true });
      systemctl('daemon-reload');
    }
    const result = status(); if (result.installed !== enabled) throw new Error(result.message || 'The startup preference could not be verified.'); return result;
  } };
}

/**
 * A long-running per-user program started at login: on macOS a LaunchAgent and on Linux a systemd user unit, both
 * running `args` in the foreground and restarting it after a failure; on Windows a Run key that runs `windowsArgs`
 * (which should start the program in the background and return) through a hidden PowerShell script kept in `dir`.
 */
export type LoginItem = { name: string; label: string; description: string; args: string[]; windowsArgs: string[]; dir: string; log: string; env?: Record<string, string> };
export function loginItemManager(item: LoginItem, options: { platform?: NodeJS.Platform; home?: string; env?: Record<string, string | undefined>; run?: Exec;
  read?: ReadRunValue; host?: { supported: boolean; message?: string } } = {}): StartupManager & { where: string } {
  const platform = options.platform ?? process.platform, home = options.home ?? homedir(), env = options.env ?? process.env, run = options.run ?? exec;
  if (platform === 'darwin') {
    const where = join(home, 'Library', 'LaunchAgents', `${item.label}.plist`);
    return { where, ...plistManager(item.label, where, launchAgentPlist(item.label, item.args, item.log, item.env), run) };
  }
  if (platform === 'win32') {
    const where = join(item.dir, 'start-at-login.ps1');
    const variables = Object.entries(item.env ?? {}).map(([name, value]) => `$env:${name} = ${quotePS(value)}\n`).join('');
    const script = `$ErrorActionPreference = 'Stop'\n${variables}& ${item.windowsArgs.map(quotePS).join(' ')}\nexit $LASTEXITCODE\n`;
    // Only an injected reg.exe (tests) is passed on: without one, runKeyManager reads the value through the registry API.
    return { where, ...runKeyManager({ valueName: item.name, scriptPath: where, script },
      { ...(options.run ? { run: options.run } : {}), ...(options.read ? { read: options.read } : {}), ...(options.host ? { host: options.host } : {}) }) };
  }
  const where = join(env.XDG_CONFIG_HOME ? resolve(env.XDG_CONFIG_HOME) : join(home, '.config'), 'systemd', 'user', `${item.name}.service`);
  return { where, ...systemdManager(item.name, where, systemdUnit(item.description, item.args, item.env), run) };
}

/** Tests exercise setup without mutating the user's OS startup configuration. */
export function testStartupManager(): StartupManager {
  let installed = false;
  return { status: () => ({ installed, supported: true }), apply(enabled) { installed = enabled; return this.status(); } };
}
