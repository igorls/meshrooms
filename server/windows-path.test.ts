import { test, expect } from 'bun:test';
import { mkdtempSync, readdirSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { physicalWindowsDirectory, startupHostStatus } from './windows-path';

test.skipIf(process.platform !== 'win32')('shared profile paths are visible without redirection and startup probes leave no files', () => {
  const directory = mkdtempSync(join(homedir(), '.meshrooms-path-test-'));
  try {
    expect(physicalWindowsDirectory(directory).toLowerCase()).toBe(resolve(directory).toLowerCase());
    expect(startupHostStatus(directory).supported).toBe(true);
    expect(readdirSync(directory)).toEqual([]);
    expect(startupHostStatus(join(directory, 'absent')).supported).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  } finally { rmdirSync(directory); }
});
