/**
 * One runner per agent folder and room, and one per device: what keeps a second `run` (a test session, a copied folder,
 * a hand-started process the daemon never heard of) from sharing the relay inbox with the real runner and driving it
 * into session-replaced churn. The guard is two lock files that name their process (see locks.ts):
 *
 *   <room folder>/runner.run.lock            this folder's runner
 *   <locks dir>/runners/<device>.lock        the runner of this room device, wherever its folder is (the registry)
 *
 * with a `<device>.json` beside the second that says who holds it, for `doctor`. A runner that finds either lock held by
 * a live process leaves instead of starting; one that finds a lock left by a process that is gone takes it over.
 * Nothing here touches processes except by pid: killing is `doctor --reap`'s business, not the guard's.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { running, tryLock } from './locks';

export const RUNNER_RUN_LOCK = 'runner.run.lock';
/** Exit codes of a runner that stopped on purpose; the same as `listen --until-addressed`'s. */
export const RUNNER_EXIT = { removed: 4, parentGone: 6, duplicate: 7, superseded: 8 } as const;

export type RunnerClaim =
  | { ok: true; release: () => void; held: () => boolean }
  | { ok: false; holder: number | undefined; scope: 'folder' | 'device' };

export type RunnerRegistryEntry = { pid: number; ppid: number; roomId: string; deviceId: string; folder: string; startedAt: number };

const readPid = (path: string) => { try { const n = Number(readFileSync(path, 'utf8')); return Number.isSafeInteger(n) && n > 0 ? n : undefined; } catch { return undefined; } };
const unlinkQuiet = (path: string) => { try { unlinkSync(path); } catch { /* Already gone. */ } };
export const deviceKey = (roomId: string, deviceId: string) => createHash('sha256').update(`${roomId.toLowerCase()}|${deviceId}`).digest('hex').slice(0, 32);

/**
 * Takes this process's place as the runner of the room folder and device, or says who already is. `gone` judges a lock's
 * owner when "its process has exited" isn't enough (a pid reused by another program: see the callers).
 */
export function claimRunner(input: { roomDir: string; registryDir: string; roomId: string; deviceId: string; ppid?: number; now?: number; gone?: (pid: number) => boolean }): RunnerClaim {
  const { roomDir, registryDir, roomId, deviceId, gone } = input;
  mkdirSync(registryDir, { recursive: true, mode: 0o700 });
  const folderLock = join(roomDir, RUNNER_RUN_LOCK), key = deviceKey(roomId, deviceId);
  const deviceLock = join(registryDir, `${key}.lock`), entryFile = join(registryDir, `${key}.json`);
  if (!tryLock(folderLock, 'runner', gone)) return { ok: false, holder: readPid(folderLock), scope: 'folder' };
  if (!tryLock(deviceLock, 'runner', gone)) { unlinkQuiet(folderLock); return { ok: false, holder: readPid(deviceLock), scope: 'device' }; }
  const entry: RunnerRegistryEntry = { pid: process.pid, ppid: input.ppid ?? process.ppid, roomId, deviceId, folder: roomDir, startedAt: input.now ?? Date.now() };
  try { writeFileSync(entryFile, JSON.stringify(entry), { mode: 0o600 }); } catch { /* The lock is what counts; the entry is for `doctor`. */ }
  const mine = (path: string) => readPid(path) === process.pid;
  /** Whose a lock is: a read that fails for any reason but "no such file" proves nothing, so it never ends a runner. */
  const owner = (path: string): 'me' | 'other' | 'unknown' => {
    try { return Number(readFileSync(path, 'utf8')) === process.pid ? 'me' : 'other'; }
    catch (error) { return (error as { code?: string }).code === 'ENOENT' ? 'other' : 'unknown'; }
  };
  return {
    ok: true,
    // Still ours: a runner whose lock was reclaimed or removed (its folder wiped, a replacement started) must not carry on.
    held: () => owner(folderLock) !== 'other' && owner(deviceLock) !== 'other',
    release: () => { if (mine(folderLock)) unlinkQuiet(folderLock); if (mine(deviceLock)) { unlinkQuiet(deviceLock); unlinkQuiet(entryFile); } },
  };
}

/** The registry's entries: one per device whose runner took the device lock, held or left behind. */
export function readRegistry(registryDir: string, listDir: (dir: string) => string[]): { entry: RunnerRegistryEntry; live: boolean }[] {
  let names: string[] = [];
  try { names = listDir(registryDir).filter(n => n.endsWith('.json')); } catch { return []; }
  const out: { entry: RunnerRegistryEntry; live: boolean }[] = [];
  for (const name of names) {
    try {
      const entry = JSON.parse(readFileSync(join(registryDir, name), 'utf8')) as RunnerRegistryEntry;
      if (typeof entry.pid === 'number' && typeof entry.roomId === 'string') out.push({ entry, live: readPid(join(registryDir, name.replace(/\.json$/, '.lock'))) === entry.pid && running(entry.pid) });
    } catch { /* Not an entry. */ }
  }
  return out;
}

/**
 * Whether the runner should stop, as `runBridge` asks every pass: its lock is no longer its own (a replacement took the
 * place, or the folder was deleted), or the process that was told to keep it (`--parent`) is gone.
 */
export function runnerShouldStop(claim: Extract<RunnerClaim, { ok: true }>, parent?: number, alive: (pid: number) => boolean = running): { reason: string; code: 6 | 8 } | undefined {
  if (parent !== undefined && !alive(parent)) return { reason: `its parent process (pid ${parent}) is gone`, code: RUNNER_EXIT.parentGone };
  if (!claim.held()) return { reason: 'another runner took over this room folder or device, or its folder was removed', code: RUNNER_EXIT.superseded };
  return undefined;
}

export type ProcessRow = { pid: number; ppid: number; command: string };
/** Parses `ps -ww -eo pid=,ppid=,command=`. */
export function parsePsTable(out: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return rows;
}

export type RunnerFinding = { pid: number; ppid: number; roomId: string; verb: 'run' | 'person-run'; home?: string; status: 'managed' | 'orphan'; why?: string };
/**
 * Every runner process in a process table and whether it is managed: some agent folder the machine knows names its pid
 * (runner.pid, or the runner lock). Anything else is an orphan: a test session's, a copied folder's, one whose folder
 * is gone or no longer lists it. `matches` is the runner command line test (isRunnerCommand); `managedPids` the pids the
 * known folders name; `homeOf` reads a process's agent folder where the system allows.
 */
export function findRunners(table: ProcessRow[], matches: (command: string, roomId: string, verb: 'run' | 'person-run') => boolean,
  managedPids: Set<number>, homeOf: (pid: number) => string | undefined = () => undefined): RunnerFinding[] {
  const found: RunnerFinding[] = [];
  for (const row of table) {
    const m = /\s(run|person-run)\s+--room\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\s+--parent\s+\d+)?\s*$/i.exec(row.command);
    if (!m) continue;
    const verb = m[1] as 'run' | 'person-run', roomId = m[2];
    if (!matches(row.command, roomId, verb)) continue;
    const home = homeOf(row.pid), managed = managedPids.has(row.pid);
    found.push({ pid: row.pid, ppid: row.ppid, roomId, verb, ...(home ? { home } : {}), status: managed ? 'managed' : 'orphan',
      ...(managed ? {} : { why: 'no known agent folder names this process as its runner' }) });
  }
  return found;
}
