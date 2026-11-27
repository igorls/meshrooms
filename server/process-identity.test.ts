import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { inspectProcess, linuxStart, parseProcStart, runIdentity, sameRun, sameStart } from './agent-watch';
import { sameRunner } from './agent-cli';

const room = '00000000-0000-4000-8000-000000000001';
const command = `/usr/bin/bun --no-env-file /home/someone/.meshrooms/bin/meshrooms.js run --room ${room}`;

test('parseProcStart reads the start tick after the last ")" of /proc/<pid>/stat, whatever the command is called', () => {
  const tail = 'S 1 893183 893183 0 -1 4194560 100 0 0 0 5 6 0 0 20 0 9 0 123456789 7045152 18000 18446744073709551615';
  expect(parseProcStart(`893183 (bun.exe) ${tail}`, 'boot-1')).toBe('linux:boot-1:123456789');
  expect(parseProcStart(`893183 (my (odd) name) ${tail}`, 'boot-1')).toBe('linux:boot-1:123456789');
  expect(parseProcStart(`893183 (bun.exe) S 1`, 'boot-1')).toBeUndefined();
  expect(parseProcStart('garbage', 'boot-1')).toBeUndefined();
  expect(parseProcStart(`893183 (bun.exe) ${tail}`, '')).toBeUndefined();
});

test('a run is the same by its kernel start identity even when the wall-clock start ps prints has moved', () => {
  // The record was written when ps said 19:21:15; after the machine's clock stepped (a suspended sandbox resumed),
  // ps says 19:33:37 for the very same process. The identity is unchanged, so it still is the run.
  const run = { fingerprint: room, started: 'linux:boot-1:123456789' };
  const info = { command, started: 'linux:boot-1:123456789', startedWall: 'Thu Nov 26 19:33:37 2026' };
  expect(sameRun(run, info)).toBe(true);
  expect(runIdentity(run, info)).toBe(true);
  expect(sameRunner(room, 893183, { pid: 893183, started: run.started }, info)).toBe(true);
  // Another process that got the pid later, or after a reboot, differs in its tick or boot id.
  expect(sameRun(run, { ...info, started: 'linux:boot-1:123999999' })).toBe(false);
  expect(sameRun(run, { ...info, started: 'linux:boot-2:123456789' })).toBe(false);
  expect(runIdentity(run, { ...info, started: 'linux:boot-2:123456789' })).toBe(false);
});

test('a record from before the identity (ps wall-clock text) still matches while the clock has not moved, and not after', () => {
  const legacy = { fingerprint: room, started: 'Thu Nov 26 19:21:15 2026' };
  expect(sameRun(legacy, { command, started: 'linux:boot-1:5', startedWall: 'Thu Nov 26 19:21:15 2026' })).toBe(true);
  expect(sameRun(legacy, { command, started: 'linux:boot-1:5', startedWall: 'Thu Nov 26 19:33:37 2026' })).toBe(false);
  // Off Linux, `started` is the text itself, as before.
  expect(sameRun(legacy, { command, started: 'Thu Nov 26 19:21:15 2026' })).toBe(true);
  expect(sameStart('x', { started: 'y' })).toBe(false);
});

test.skipIf(process.platform !== 'linux')('on Linux a live process reports a stable identity that is not the wall-clock text', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
  try {
    await Bun.sleep(200);
    const first = inspectProcess(child.pid!), second = inspectProcess(child.pid!);
    expect(first?.started).toMatch(/^linux:[0-9a-f-]+:\d+$/);
    expect(first?.started).toBe(linuxStart(child.pid!));
    expect(second?.started).toBe(first?.started);
    expect(first?.startedWall).toBeTruthy();
    expect(first?.startedWall).not.toBe(first?.started);
  } finally { child.kill(); }
});
