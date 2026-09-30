import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export function testDirectory(label: string) {
  const root = realpathSync(tmpdir());
  const path = mkdtempSync(join(root, `meshrooms-${label}-`));
  return { path, cleanup() {
    const target = realpathSync(path);
    if (dirname(target) !== root || !basename(target).startsWith(`meshrooms-${label}-`)) throw new Error('Refusing cleanup outside this test directory.');
    rmSync(target, { recursive: true, force: true });
  } };
}
