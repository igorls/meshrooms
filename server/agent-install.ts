/**
 * Where the agent bridge lives on this machine, and whether the room service still accepts it.
 *
 * `bunx @wormdb/meshrooms@<version> connect` runs the bridge from bunx's cache, and the old flow ran it from a file downloaded into the
 * current folder (usually the user's repository). Background runners outlive both, so the bridge copies itself into
 * ~/.meshrooms/bin (%USERPROFILE%\.meshrooms\bin on Windows) as meshrooms-<version>.js plus a stable launcher,
 * meshrooms.js, and runners always start from the launcher. Nothing is written into the current folder.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { version as packageVersion } from '../packages/meshrooms/package.json';

/** The version of this bridge: the npm package's version, inlined when the bundle is built. */
export const BRIDGE_VERSION: string = packageVersion;
/** The oldest Bun the bridge is tested on (the repository's pinned Bun); packages/meshrooms declares the same in engines. */
export const MIN_BUN_VERSION = '1.4.2';
export const LAUNCHER = 'meshrooms.js';

/** ~/.meshrooms/bin, or MESHROOMS_BIN_DIR. It holds bridge code only; agents' keys and messages stay in MESHROOMS_AGENT_HOME. */
export function binDir(env: Record<string, string | undefined> = process.env, home = homedir()) {
  return resolve(env.MESHROOMS_BIN_DIR || join(home, '.meshrooms', 'bin'));
}

const SEMVER = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export const isVersion = (value: unknown): value is string => typeof value === 'string' && SEMVER.test(value);
/** Semantic version order, prereleases included: 0.2.0-beta.1 < 0.2.0-beta.2 < 0.2.0-rc.1 < 0.2.0 < 0.10.0. */
export function compareVersions(a: string, b: string): number {
  const left = SEMVER.exec(a), right = SEMVER.exec(b);
  if (!left || !right) throw new Error(`Not a version: ${left ? b : a}`);
  for (let i = 1; i <= 3; i++) if (Number(left[i]) !== Number(right[i])) return Math.sign(Number(left[i]) - Number(right[i]));
  if (!left[4] || !right[4]) return left[4] ? -1 : right[4] ? 1 : 0;
  const x = left[4].split('.'), y = right[4].split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined || y[i] === undefined) return x[i] === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x[i]), yn = /^\d+$/.test(y[i]);
    if (xn && yn && Number(x[i]) !== Number(y[i])) return Math.sign(Number(x[i]) - Number(y[i]));
    if (xn !== yn) return xn ? -1 : 1;
    if (!xn && x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/** Bun reports versions like 1.4.2 or 1.4.2-canary.1+abc; only the release part is compared. */
export function bunTooOld(version: string, minimum = MIN_BUN_VERSION) {
  const release = /^(\d+\.\d+\.\d+)/.exec(version)?.[1];
  return !!release && compareVersions(release, minimum) < 0;
}

/**
 * How to run the bridge through bunx: always with an exact version. For a bare `@wormdb/meshrooms`, bunx runs the copy
 * it cached (under the name `@latest`) for up to a day without asking the registry, so an agent that once ran an older
 * version keeps getting it. `@latest` is the fallback when no version is known (a service from before it reported one).
 */
export const bunxCommand = (version?: string) => `bunx @wormdb/meshrooms@${version && isVersion(version) ? version : 'latest'}`;

export class BridgeTooOld extends Error {
  constructor(readonly version: string, readonly minimum: string, command: string, readonly current?: string) {
    super(`This Meshrooms bridge is ${version}, and the room service needs ${minimum} or newer. `
      + (command === 'connect' ? 'The link was not used. ' : '')
      + `Run the same command with the ${current ? 'current' : 'latest'} bridge: ${bunxCommand(current)} ${command} ${command === 'connect' ? "'<the same link>'" : '...'}`);
  }
}

/** What the room service says about bridges: the oldest it accepts, and the one it tells agents to run. */
export type BridgeVersions = { minimum?: string; current?: string };
type HealthAnswer = ({ answered: true } & BridgeVersions) | { answered: false; reason: string };
async function askHealth(origin: string, version: string, fetcher: typeof fetch): Promise<HealthAnswer> {
  try {
    const response = await fetcher(`${origin}/api/lobby/health`, { redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'application/json', 'User-Agent': `meshrooms/${version}` } });
    if (!response.ok) return { answered: false, reason: `the service answered ${response.status}` };
    const body = await response.json().catch(() => undefined) as { ok?: unknown; minAgentVersion?: unknown; currentAgentVersion?: unknown } | undefined;
    // Only the room service's own health answer counts; a proxy or maintenance page can answer 200 with something else.
    if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean') return { answered: false, reason: 'the answer was not the room service\'s' };
    // Services from before 0.2.0-beta.2 don't name a current version; one that isn't a version is ignored, not trusted.
    const current = isVersion(body.currentAgentVersion) ? { current: body.currentAgentVersion } : {};
    if (body.minAgentVersion === undefined) return { answered: true, ...current }; // A service from before the handshake.
    if (!isVersion(body.minAgentVersion)) return { answered: false, reason: 'the service named no valid minimum version' };
    return { answered: true, minimum: body.minAgentVersion, ...current };
  } catch (error) { return { answered: false, reason: error instanceof Error ? error.message : String(error) }; }
}

export type VersionCheck = { version?: string; fetcher?: typeof fetch; attempts?: number; sleep?: (ms: number) => Promise<unknown> };
/**
 * Asks the room service which bridge versions it still accepts (`minAgentVersion` in /api/lobby/health) and throws
 * BridgeTooOld when this one is older. `connect` uses up a one-time link and can't be undone, so for it the check
 * fails closed: it retries a few times, then refuses without using the link. Other commands carry on when the service
 * can't be asked (the room commands that follow fail on their own); a service from before the handshake is accepted.
 * Returns what the service said (nothing when it couldn't be asked), so hints can name the version it wants.
 */
export async function checkBridgeVersion(origin: string, command: string, options: VersionCheck = {}): Promise<BridgeVersions | undefined> {
  const { version = BRIDGE_VERSION, fetcher = fetch, sleep = Bun.sleep } = options;
  const strict = command === 'connect', attempts = strict ? Math.max(1, options.attempts ?? 3) : 1;
  let answer: HealthAnswer = { answered: false, reason: 'not asked' };
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await sleep(500 * 2 ** (attempt - 1));
    answer = await askHealth(origin, version, fetcher);
    if (answer.answered) break;
  }
  if (!answer.answered) {
    if (!strict) return undefined;
    throw new Error(`Couldn't ask ${origin} which bridge versions it accepts (${answer.reason}), so this link was not used. `
      + 'Check the connection and run the same connect again.');
  }
  // Only a current version that the service itself accepts is worth suggesting.
  const current = answer.current && (!answer.minimum || compareVersions(answer.current, answer.minimum) >= 0) ? answer.current : undefined;
  if (answer.minimum && compareVersions(version, answer.minimum) < 0) throw new BridgeTooOld(version, answer.minimum, command, current);
  return { ...(answer.minimum ? { minimum: answer.minimum } : {}), ...(current ? { current } : {}) };
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/**
 * The launcher runs one installed version, after checking it still has the hash recorded when it was installed.
 * Background runners start from this file, never the bunx cache.
 */
export const launcherSource = (version: string, hash: string) => '#!/usr/bin/env bun\n'
  + '// Written by the Meshrooms bridge (npm package "@wormdb/meshrooms"). Runs the newest installed version below.\n'
  + "import { createHash } from 'node:crypto';\nimport { readFileSync } from 'node:fs';\n"
  + `const file = new URL('./meshrooms-${version}.js', import.meta.url);\n`
  + `if (createHash('sha256').update(readFileSync(file)).digest('hex') !== '${hash}') {\n`
  + `  console.error('The installed Meshrooms bridge ${version} changed since it was installed, so it was not run. Run ${bunxCommand(version)} connect with a new link to reinstall it.');\n`
  + '  process.exit(1);\n}\n'
  + 'const { main } = await import(file.href);\nawait main(process.argv.slice(2));\n';

export const MANIFEST = 'installed.json';
type Manifest = { versions: Record<string, { file: string; sha256: string }> };
function readManifest(dir: string): Manifest {
  try {
    const value = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'));
    if (value && typeof value.versions === 'object') return value;
  } catch { /* None yet, or unreadable: start over. */ }
  return { versions: {} };
}

/** Writes whole files only: a runner starting at the same moment never reads a half-written one. */
function writeAtomic(path: string, content: string | Uint8Array, mode = 0o644) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { mode });
  // Windows refuses to replace a file for a moment while a scanner or a starting runner has it open.
  try { whileBusy(() => renameSync(temporary, path)); } catch (error) { rmSync(temporary, { force: true }); throw error; }
}

/** On macOS and Linux, code in the folder runs as this user, so nobody else may be able to change it. */
export function assertPrivateDir(dir: string, uid = process.getuid?.()) {
  if (process.platform === 'win32' || uid === undefined) return;
  const found = statSync(dir);
  if (found.uid !== uid) throw new Error(`${dir} belongs to another user. Use a folder of your own (set MESHROOMS_BIN_DIR)`);
  if (found.mode & 0o022) throw new Error(`other users can write to ${dir}. Run chmod go-w '${dir}'`);
}

const code = (error: unknown) => (error as { code?: string }).code;
/**
 * On Windows a file that another process is deleting, or that a scanner holds open, refuses to be created, replaced or
 * removed for a moment: the call fails with EPERM, EACCES or EBUSY rather than EEXIST. There, those codes mean "busy,
 * try again"; elsewhere they are real permission errors.
 */
export const busyOnWindows = (error: unknown, platform = process.platform) =>
  platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(code(error) ?? '');
/** Retries `action` while Windows reports the file busy, for up to `ms`; then the last error stands. */
export function whileBusy<T>(action: () => T, ms = 2_000): T {
  const deadline = Date.now() + ms;
  while (true) {
    try { return action(); } catch (error) { if (!busyOnWindows(error) || Date.now() > deadline) throw error; }
    Bun.sleepSync(10);
  }
}

/**
 * One install at a time per folder, so two bridges of different versions can't leave the launcher on the older one.
 * On Windows the lock the last holder just removed can still be "delete pending": creating it then fails with EPERM
 * instead of EEXIST, which is contention like EEXIST, not a reason to give up.
 */
function withInstallLock<T>(dir: string, work: () => T): T {
  const lock = join(dir, 'install.lock'), deadline = Date.now() + 10_000;
  while (true) {
    try { writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); break; }
    catch (error) {
      if (code(error) !== 'EEXIST' && !busyOnWindows(error)) throw error;
      // An install takes milliseconds; a lock this old was left by a crash.
      let stale = false;
      try { stale = Date.now() - statSync(lock).mtimeMs > 30_000; } catch { /* Released meanwhile: try again. */ }
      if (stale) try { rmSync(lock, { force: true }); continue; } catch { /* Someone else is removing it. */ }
      if (Date.now() > deadline) throw code(error) === 'EEXIST' ? new Error(`another install holds ${lock}`) : error;
      Bun.sleepSync(25);
    }
  }
  try { return work(); } finally {
    // The work is done: failing to remove the lock mustn't fail the install. A lock left behind goes stale.
    try { whileBusy(() => rmSync(lock, { force: true })); } catch { /* Left behind. */ }
  }
}

/**
 * Copies the running bundle into `dir` as meshrooms-<version>.js, records its hash in installed.json, and points the
 * launcher at the newest recorded version whose file still has its recorded hash. Files that merely look like a
 * version are ignored, and an older bunx cache never moves runners back to an older version.
 */
export function installBridge(source: string, version = BRIDGE_VERSION, dir = binDir()) {
  if (!isVersion(version)) throw new Error(`Not a version: ${version}`);
  const intact = intactInstall(source, version, dir);
  if (intact) return intact;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    assertPrivateDir(dir);
    const code = readFileSync(source), hash = sha256(code), file = `meshrooms-${version}.js`;
    return withInstallLock(dir, () => {
      const versioned = join(dir, file);
      if (!existsSync(versioned) || sha256(readFileSync(versioned)) !== hash) writeAtomic(versioned, code);
      const manifest = readManifest(dir);
      manifest.versions[version] = { file, sha256: hash };
      const intact = Object.entries(manifest.versions).filter(([v, entry]) => {
        try { return isVersion(v) && entry.file === `meshrooms-${v}.js` && sha256(readFileSync(join(dir, entry.file))) === entry.sha256; }
        catch { return false; }
      });
      manifest.versions = Object.fromEntries(intact);
      writeAtomic(join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
      const [newest, entry] = intact.reduce((best, next) => compareVersions(next[0], best[0]) > 0 ? next : best);
      const launcher = join(dir, LAUNCHER), wanted = launcherSource(newest, entry.sha256);
      if (!existsSync(launcher) || readFileSync(launcher, 'utf8') !== wanted) writeAtomic(launcher, wanted, 0o755);
      return { dir, launcher, version: newest, installed: versioned };
    });
  } catch (error) {
    throw new Error(`Couldn't install the Meshrooms bridge into ${dir}: ${error instanceof Error ? error.message : String(error)}. `
      + 'Set MESHROOMS_BIN_DIR to a private folder you can write to (outside your project), then run the command again.');
  }
}

/**
 * The install as it stands, when it needs no change: this version is recorded with this bundle's hash, every recorded
 * version still has its hash, and the launcher is byte for byte the one the newest of them needs. Then nothing is
 * written (no lock, no manifest), so a command run from the installed launcher never needs the bin folder writable,
 * and the launcher is checked before a runner or watcher starts from it. Anything else takes the full install.
 */
function intactInstall(source: string, version: string, dir: string) {
  try {
    const hash = sha256(readFileSync(source)), file = `meshrooms-${version}.js`, manifest = readManifest(dir);
    if (manifest.versions[version]?.sha256 !== hash || manifest.versions[version]?.file !== file) return undefined;
    const entries = Object.entries(manifest.versions);
    if (!entries.every(([v, entry]) => isVersion(v) && entry.file === `meshrooms-${v}.js` && sha256(readFileSync(join(dir, entry.file))) === entry.sha256)) return undefined;
    const [newest, entry] = entries.reduce((best, next) => compareVersions(next[0], best[0]) > 0 ? next : best);
    const launcher = join(dir, LAUNCHER);
    if (readFileSync(launcher, 'utf8') !== launcherSource(newest, entry.sha256)) return undefined;
    assertPrivateDir(dir);
    return { dir, launcher, version: newest, installed: join(dir, file) };
  } catch { return undefined; }
}

/** The bundle this process runs from, or undefined when running from source (bun run server/agent-cli.ts). */
export function runningBundle(path = import.meta.path) { return /\.[cm]?js$/.test(path) ? path : undefined; }
