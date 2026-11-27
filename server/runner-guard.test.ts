import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { doctorCommand, isRunnerCommand } from './agent-cli';
import { RUNNER_RUN_LOCK, claimRunner, deviceKey, findRunners, parsePsTable, readRegistry, runnerShouldStop } from './runner-guard';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'mr-runner-guard-')); dirs.push(dir); return dir; };
const room = crypto.randomUUID(), device = 'device-a';
const setup = () => { const base = temp(); const roomDir = join(base, 'home', 'browser-agents', room); mkdirSync(roomDir, { recursive: true }); return { base, roomDir, registryDir: join(base, 'locks', 'runners') }; };

/** Runs claimRunner in another process; resolves with what it said. Optionally stays alive until killed. */
function otherProcess(input: { roomDir: string; registryDir: string; deviceId: string }, stay: boolean) {
  const script = `import { claimRunner } from ${JSON.stringify(join(import.meta.dir, 'runner-guard.ts'))};
    const c = claimRunner({ roomDir: ${JSON.stringify(input.roomDir)}, registryDir: ${JSON.stringify(input.registryDir)}, roomId: ${JSON.stringify(room)}, deviceId: ${JSON.stringify(input.deviceId)} });
    console.log(JSON.stringify({ ok: c.ok, holder: c.ok ? process.pid : c.holder, scope: c.ok ? undefined : c.scope }));
    ${stay ? 'setInterval(() => {}, 1000);' : 'process.exit(0);'}`;
  return spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
}
const firstLine = (child: ReturnType<typeof spawn>) => new Promise<{ ok: boolean; holder?: number; scope?: string }>(resolve => {
  let text = ''; child.stdout!.on('data', chunk => { text += chunk; if (text.includes('\n')) resolve(JSON.parse(text.split('\n')[0])); });
});

test('a second runner for the same folder refuses and names the first; the first keeps its lock until released', async () => {
  const s = setup();
  const first = claimRunner({ ...s, roomId: room, deviceId: device });
  expect(first.ok).toBe(true);
  expect(readFileSync(join(s.roomDir, RUNNER_RUN_LOCK), 'utf8')).toBe(String(process.pid));
  const rival = otherProcess({ ...s, deviceId: device }, false);
  expect(await firstLine(rival)).toEqual({ ok: false, holder: process.pid, scope: 'folder' });
  if (!first.ok) throw new Error('unreachable');
  expect(first.held()).toBe(true);
  first.release();
  expect(existsSync(join(s.roomDir, RUNNER_RUN_LOCK))).toBe(false);
  // Released: a runner can start again.
  const again = otherProcess({ ...s, deviceId: device }, false);
  expect((await firstLine(again)).ok).toBe(true);
});

test('the same device in another folder is refused too, and a runner whose process was killed leaves a lock that is taken over', async () => {
  const s = setup();
  const copy = join(s.base, 'copied-home', 'browser-agents', room); mkdirSync(copy, { recursive: true });
  const holder = otherProcess({ ...s, deviceId: device }, true);
  const held = await firstLine(holder);
  expect(held.ok).toBe(true);
  // A copied folder with the same device identity (what a duplicated agent home is): the registry stops it.
  const refused = claimRunner({ roomDir: copy, registryDir: s.registryDir, roomId: room, deviceId: device });
  expect(refused).toEqual({ ok: false, holder: held.holder, scope: 'device' });
  // Its folder lock was not left behind by the refusal.
  expect(existsSync(join(copy, RUNNER_RUN_LOCK))).toBe(false);
  // A different device in the same room is fine.
  const other = claimRunner({ roomDir: copy, registryDir: s.registryDir, roomId: room, deviceId: 'device-b' });
  expect(other.ok).toBe(true);
  if (other.ok) other.release();
  // SIGKILL leaves both locks; the next runner takes them over instead of refusing for good.
  holder.kill('SIGKILL');
  await new Promise(resolve => holder.once('exit', resolve));
  expect(existsSync(join(s.roomDir, RUNNER_RUN_LOCK))).toBe(true);
  const taken = claimRunner({ ...s, roomId: room, deviceId: device });
  expect(taken.ok).toBe(true);
  if (taken.ok) {
    expect(readRegistry(s.registryDir, dir => readdirSync(dir)).map(r => [r.entry.pid, r.live])).toEqual([[process.pid, true]]);
    taken.release();
  }
});

test('a runner stops when its lock is no longer its own, or the process it must not outlive is gone, and not before', () => {
  const s = setup();
  const claim = claimRunner({ ...s, roomId: room, deviceId: device });
  if (!claim.ok) throw new Error('unreachable');
  expect(runnerShouldStop(claim)).toBeUndefined();
  expect(runnerShouldStop(claim, 4242, () => true)).toBeUndefined();
  expect(runnerShouldStop(claim, 4242, () => false)).toMatchObject({ code: 6 });
  // Its folder wiped (a test's scratch folder removed), or its lock taken by another pid: superseded.
  writeFileSync(join(s.roomDir, RUNNER_RUN_LOCK), '1');
  expect(runnerShouldStop(claim)).toMatchObject({ code: 8 });
  rmSync(join(s.roomDir, RUNNER_RUN_LOCK));
  expect(runnerShouldStop(claim)).toMatchObject({ code: 8 });
  writeFileSync(join(s.roomDir, RUNNER_RUN_LOCK), String(process.pid));
  rmSync(join(s.registryDir, `${deviceKey(room, device)}.lock`));
  expect(runnerShouldStop(claim)).toMatchObject({ code: 8 });
});

const BUN = '/usr/local/bin/bun', SCRIPT = '/h/.meshrooms/bin/meshrooms.js';
const ps = [
  `  100     1 ${BUN} --no-env-file ${SCRIPT} run --room ${room}`,
  `  200    53 ${BUN} --no-env-file ${SCRIPT} run --room ${room}`,
  `  300    53 ${BUN} ${SCRIPT} run --room ${room} --parent 77`,
  `  400     1 ${BUN} --no-env-file ${SCRIPT} watch-run --room ${room}`,
  `  500     1 ${BUN} test ./server`,
].join('\n');

test('findRunners tells the runner a known folder names from strays, ignores watchers and other programs, and reads --parent runners', () => {
  const table = parsePsTable(ps);
  expect(table).toHaveLength(5);
  const found = findRunners(table, isRunnerCommand, new Set([100]), pid => pid === 200 ? '/scratch/agent-home-1' : undefined);
  expect(found.map(r => [r.pid, r.status, r.home])).toEqual([[100, 'managed', undefined], [200, 'orphan', '/scratch/agent-home-1'], [300, 'orphan', undefined]]);
});

test('doctor lists, and only with --reap stops the orphans: never a managed runner, itself, or one whose command line changed', async () => {
  const s = setup();
  writeFileSync(join(s.roomDir, 'runner.pid'), '100');
  const killed: number[] = [];
  const deps = (over: Record<string, unknown> = {}) => ({
    ps: () => ps, homes: () => [join(s.base, 'home')], registryDir: s.registryDir, env: () => undefined, self: [300],
    inspect: (pid: number) => ({ command: `${BUN} --no-env-file ${SCRIPT} run --room ${room}`, started: String(pid) }),
    kill: (pid: number, same: () => boolean) => { if (!same()) return false; killed.push(pid); return true; }, ...over });
  // pid 100 must be running for runner.pid to count: use this test process as the managed one.
  writeFileSync(join(s.roomDir, 'runner.pid'), String(process.pid));
  const table = ps.replace('  100 ', `  ${process.pid} `);
  const listed = await doctorCommand({}, deps({ ps: () => table }) as never) as { runners: { pid: number; status: string }[]; orphans: number; hint?: string };
  expect(listed.runners.map(r => [r.pid, r.status])).toEqual([[process.pid, 'managed'], [200, 'orphan'], [300, 'orphan']]);
  expect(listed.orphans).toBe(2);
  expect(killed).toEqual([]);
  expect(listed.hint).toContain('--reap');
  // --reap: 200 stopped; 300 is the doctor itself (self) and stays; the managed runner stays.
  const reaped = await doctorCommand({ '--reap': 'true' }, deps({ ps: () => table }) as never) as { reaped: number };
  expect(killed).toEqual([200]);
  expect(reaped.reaped).toBe(1);
  // A process whose command line no longer says it is that room's runner (its pid reused) is not killed.
  killed.length = 0;
  const changed = await doctorCommand({ '--reap': 'true' }, deps({ ps: () => table, inspect: () => ({ command: 'sleep 1000' }) }) as never) as { reaped: number };
  expect(killed).toEqual([]);
  expect(changed.reaped).toBe(0);
  // --room limits it to one room.
  const none = await doctorCommand({ '--room': crypto.randomUUID() }, deps({ ps: () => table }) as never) as { runners: unknown[] };
  expect(none.runners).toEqual([]);
});
