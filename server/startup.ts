import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startupHostStatus } from './windows-path';

export type StartupState = { installed: boolean; supported: boolean; message?: string };
export interface StartupManager { status(): StartupState; apply(enabled: boolean): StartupState }
export type StartupOptions = { dataDir: string; libraryPath: string; port: number; cliPath: string; executable?: string; launchAgentsDir?: string };
const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const quotePS = (text: string) => `'${text.replaceAll("'", "''")}'`;
const xml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const nodeHash = (dataDir: string) => createHash('sha256').update(dataDir).digest('hex').slice(0, 16);

/** HKCU registration is per-user and is applied only for an explicit settings command. */
export function startupManager(options: StartupOptions): StartupManager {
  if (process.platform === 'darwin') return launchAgentManager(options);
  if (process.platform !== 'win32') return { status: () => ({ installed: false, supported: false, message: 'Start at login is currently available on Windows and macOS.' }),
    apply(enabled) { if (enabled) throw new Error('Start at login is not supported on this platform yet.'); return this.status(); } };
  const host = startupHostStatus();
  if (!host.supported) return { status: () => ({ installed: false, ...host }),
    apply(enabled) { if (enabled) throw new Error(host.message); return this.status(); } };
  const dataDir = resolve(options.dataDir);
  const scriptPath = join(dataDir, 'start-at-login.ps1');
  const valueName = `Meshrooms-${nodeHash(dataDir.toLowerCase())}`;
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = `"${powershell}" -NoProfile -NonInteractive -WindowStyle Hidden -File "${scriptPath}"`;
  const script = `$ErrorActionPreference = 'Stop'\n& ${quotePS(options.executable || process.execPath)} run ${quotePS(options.cliPath)} ensure --data-dir ${quotePS(dataDir)} --library ${quotePS(options.libraryPath)} --port ${options.port}\nexit $LASTEXITCODE\n`;
  const reg = (args: string[]) => spawnSync('reg.exe', args, { windowsHide: true, encoding: 'utf8', timeout: 5000 });
  const status = (): StartupState => {
    const result = reg(['query', key, '/v', valueName]);
    const installed = result.status === 0 && result.stdout.includes(command) && existsSync(scriptPath) && readFileSync(scriptPath, 'utf8') === script;
    return { installed, supported: true, ...(result.status === 0 && !installed ? { message: 'The startup entry needs repair before it can be marked active.' } : {}) };
  };
  return { status, apply(enabled) {
    if (enabled) {
      mkdirSync(dataDir, { recursive: true }); writeFileSync(scriptPath, script, { mode: 0o600 });
      const result = reg(['add', key, '/v', valueName, '/t', 'REG_SZ', '/d', command, '/f']);
      if (result.status !== 0) throw new Error('Windows could not register start at login. Your preference was not saved.');
    } else {
      const present = reg(['query', key, '/v', valueName]);
      if (present.status === 0 && reg(['delete', key, '/v', valueName, '/f']).status !== 0) throw new Error('Windows could not remove the Meshrooms startup entry.');
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
  const log = join(dataDir, 'daemon.log');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
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
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
  // A user can switch the item off in System Settings; the file alone would then overstate the registration.
  const disabled = () => {
    const result = spawnSync('/bin/launchctl', ['print-disabled', `gui/${process.getuid!()}`], { encoding: 'utf8', timeout: 5000 });
    return result.status === 0 && new RegExp(`"${label.replaceAll('.', '\\.')}" => (disabled|true)`).test(result.stdout);
  };
  const status = (): StartupState => {
    if (!existsSync(plistPath)) return { installed: false, supported: true };
    if (readFileSync(plistPath, 'utf8') !== plist) return { installed: false, supported: true, message: 'The startup entry needs repair before it can be marked active.' };
    if (disabled()) return { installed: false, supported: true, message: 'macOS has turned this login item off. Allow Meshrooms in System Settings > General > Login Items.' };
    return { installed: true, supported: true };
  };
  return { status, apply(enabled) {
    if (enabled) { mkdirSync(dirname(plistPath), { recursive: true }); writeFileSync(plistPath, plist, { mode: 0o644 }); }
    else rmSync(plistPath, { force: true });
    const result = status(); if (result.installed !== enabled) throw new Error(result.message || 'The startup preference could not be verified.'); return result;
  } };
}

/** Tests exercise setup without mutating the user's OS startup configuration. */
export function testStartupManager(): StartupManager {
  let installed = false;
  return { status: () => ({ installed, supported: true }), apply(enabled) { installed = enabled; return this.status(); } };
}
