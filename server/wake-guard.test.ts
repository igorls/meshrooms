/**
 * The wake-mode refusals, driven through the REAL `agentCli` entry rather than through `wakeGuard`
 * directly.
 *
 * `wakeGuard` is a pure function with its own tests, but the server does not call it — the running
 * process calls `agentCli`, and the guard only bites if `agentCli` routes every wake command through
 * it. A test that calls `wakeGuard` directly would keep passing if that routing were dropped, which
 * is exactly the regression worth pinning. These call the same entry the MCP server calls.
 *
 * The wake environment is the whole boundary here: `MESHROOMS_WAKE_ROOM` present means "you are a
 * wake", and every refusal below is a consequence of it. Nothing outside this file is written.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentCli, insideDir } from './agent-cli';

const ROOM = '00000000-0000-4000-8000-000000000001';
const OTHER_ROOM = '00000000-0000-4000-8000-000000000002';

/** Runs `agentCli` with the wake environment set, and returns the message it threw (or undefined). */
const refuse = async (argv: string[], env: Record<string, string | undefined>) => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, env);
    await agentCli(argv);
    return undefined;
  } catch (error) { return error instanceof Error ? error.message : String(error); }
  finally { for (const key of Object.keys(env)) delete process.env[key]; Object.assign(process.env, saved); }
};

describe('wake mode — the refusals hold at the real CLI entry', () => {
  test('a room other than the wake\'s own is refused, naming the wake\'s room', async () => {
    const message = await refuse(['listen', '--room', OTHER_ROOM], { MESHROOMS_WAKE_ROOM: ROOM, MESHROOMS_WAKE_DIR: '/tmp' });
    expect(message).toContain(ROOM);
    expect(message).toContain('use --room');
  });

  test('a command the wake does not have is refused, and says only its operator can run it', async () => {
    // `watch-stop` would let room text or a confused wake stop its own watcher.
    const message = await refuse(['watch-stop', '--room', ROOM], { MESHROOMS_WAKE_ROOM: ROOM, MESHROOMS_WAKE_DIR: '/tmp' });
    expect(message).toContain("isn't available");
    expect(message).toContain('operator');
  });

  test('--out on an attachment is refused: a wake saves into its wake folder', async () => {
    const message = await refuse(['attachment', '--room', ROOM, '--id', 'x', '--out', '/tmp/anywhere'], { MESHROOMS_WAKE_ROOM: ROOM, MESHROOMS_WAKE_DIR: '/tmp' });
    expect(message).toContain('leave out --out');
  });

  test('a note is refused during a wake, because the roster is a way to speak unaddressed', async () => {
    const message = await refuse(['status', '--room', ROOM, '--note', 'quietly setting the record straight'], { MESHROOMS_WAKE_ROOM: ROOM, MESHROOMS_WAKE_DIR: '/tmp' });
    expect(message).toContain('reply in the room');
  });

  test('a file outside the wake folder is refused, and the folder is named', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wake-ok-')));
    const outDir = realpathSync(mkdtempSync(join(tmpdir(), 'wake-out-')));
    const outside = join(outDir, 'note.txt');
    writeFileSync(outside, 'x');
    try {
      const message = await refuse(['send', '--room', ROOM, '--attach', outside], { MESHROOMS_WAKE_ROOM: ROOM, MESHROOMS_WAKE_DIR: dir });
      expect(message).toContain('must be in the wake folder');
      expect(message).toContain(dir);
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outDir, { recursive: true, force: true }); }
  });

  test('a file INSIDE the wake folder is allowed past the guard (the negative control)', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wake-in-')));
    const inside = join(dir, 'note.txt');
    writeFileSync(inside, 'a note the wake may attach');
    try {
      // It must get PAST the guard. It will fail later for want of a room to talk to, which is fine:
      // what is asserted is that the failure is not the guard's refusal.
      const message = await refuse(['send', '--room', ROOM, '--attach', inside], { MESHROOMS_WAKE_ROOM: ROOM, MESHROOMS_WAKE_DIR: dir });
      expect(message ?? '').not.toContain('must be in the wake folder');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('outside a wake, none of this applies — the guard only exists when the room is set', async () => {
    // The control for the whole file: with no wake environment, `listen` is not refused for its room.
    const message = await refuse(['listen', '--room', OTHER_ROOM, '--wait-seconds', '0'], {});
    expect(message ?? '').not.toContain('use --room');
    expect(message ?? '').not.toContain("isn't available");
  });

  test('a path with .. is never inside the wake folder, however it is spelled', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wake-dot-')));
    try {
      expect(insideDir(join(dir, '..', 'escape.txt'), dir)).toBe(false);
      expect(insideDir(dir, dir)).toBe(false);           // a directory is not a file
      const file = join(dir, 'real.txt'); writeFileSync(file, 'x');
      expect(insideDir(file, dir)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
