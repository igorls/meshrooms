import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const BUSY = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']);
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Removes a test's folder, trying again for a moment when Windows still holds a file in it. A file closes (a database
 * handle, a child process that was just killed) a little before Windows lets go of it, and an antivirus or indexer scan
 * can hold one for longer. A folder still held after the last try is an error, not a silent leak.
 */
export function removeWithRetry(path: string, { tries = 20, delayMs = 100 }: { tries?: number; delayMs?: number } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { rmSync(path, { recursive: true, force: true }); return; } catch (error) {
      if (attempt >= tries || !BUSY.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      sleep(delayMs);
    }
  }
}

export function testDirectory(label: string) {
  const root = realpathSync(tmpdir());
  const path = mkdtempSync(join(root, `meshrooms-${label}-`));
  return { path, cleanup() {
    const target = realpathSync(path);
    if (dirname(target) !== root || !basename(target).startsWith(`meshrooms-${label}-`)) throw new Error('Refusing cleanup outside this test directory.');
    removeWithRetry(target);
  } };
}
