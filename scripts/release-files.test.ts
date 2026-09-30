import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { releaseFiles } from './release-files';

test('the coordinator release carries its import closure and runtime assets only', () => {
  const files = releaseFiles(resolve(import.meta.dir, '..'));
  expect(files).toContain('server/browser/main.ts');
  expect(files).toContain('server/browser/lobby.ts');
  expect(files).toContain('server/browser/http.ts');
  expect(files).toContain('server/browser/agent-join.md');
  expect(files).toContain('src/browser/protocol.ts');
  expect(files).toContain('server/instance.ts');
  // Type-only imports are erased at runtime and must not widen the package.
  expect(files).not.toContain('src/room.ts');
  expect(files.some(file => file.endsWith('.test.ts'))).toBe(false);
});

test('a package import or a missing asset fails loudly', () => {
  const root = mkdtempSync(join(tmpdir(), 'meshrooms-release-files-'));
  try {
    mkdirSync(join(root, 'server/browser'), { recursive: true });
    writeFileSync(join(root, 'server/browser/main.ts'), "import { x } from 'left-pad';\nimport './helper';\nconsole.log(x);\n");
    writeFileSync(join(root, 'server/browser/helper.ts'), "export const page = new URL('./missing.md', import.meta.url);\n");
    expect(() => releaseFiles(root, 'server/browser/main.ts')).toThrow(/package "left-pad"[\s\S]*missing "\.\/missing\.md"|missing "\.\/missing\.md"[\s\S]*package "left-pad"/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('every operator command the coordinator ships is in the release', () => {
  const root = resolve(import.meta.dir, '..');
  const files = releaseFiles(root);
  const dir = join(root, 'server/browser');
  const commands = readdirSync(dir).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts')
    && readFileSync(join(dir, name), 'utf8').includes('import.meta.main')).map(name => `server/browser/${name}`);
  expect(commands).toContain('server/browser/rooms.ts');
  for (const command of commands) expect(files).toContain(command);
});
