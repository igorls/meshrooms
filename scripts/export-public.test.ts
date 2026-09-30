import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Drives scripts/export-public.sh against a throwaway repository with its own internal/ lists, so
// it runs the same in the private and the public repo. "fake/main" stands in for origin/main.
const REPO = resolve(import.meta.dir, '..');
const root = mkdtempSync(join(tmpdir(), 'meshrooms-export-'));
const src = join(root, 'src');
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

function findBash(): string | undefined {
  if (process.platform !== 'win32') return 'bash';
  // On Windows, `bash` on PATH may be WSL's; use the one that ships with Git for Windows.
  const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
  const bash = resolve(execPath, '../../../bin/bash.exe');
  return existsSync(bash) ? bash : undefined;
}
const bash = findBash();
const gitleaks = spawnSync(process.env.GITLEAKS || 'gitleaks', ['version']).status === 0;

const git = (...args: string[]) => {
  const run = spawnSync('git', ['-C', src, ...args], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
};
const write = (path: string, text: string) => { mkdirSync(join(src, path, '..'), { recursive: true }); writeFileSync(join(src, path), text); };
const commit = (message: string, merged = true) => {
  git('add', '-A');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message);
  if (merged) git('update-ref', 'refs/remotes/fake/main', 'HEAD');
  return git('rev-parse', 'HEAD');
};
const utcDay = (sha: string) => spawnSync('git', ['-C', src, 'log', '-1', '--date=format-local:%Y-%m-%d', '--format=%cd', sha],
  { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }).stdout.trim();
const exportTo = (out: string, ...args: string[]) => spawnSync(bash!, ['scripts/export-public.sh', ...args, join(root, out)], {
  cwd: src, encoding: 'utf8', env: { ...process.env, MESHROOMS_EXPORT_REMOTE: 'fake' },
});

function setup() {
  if (existsSync(join(src, '.git'))) return git('rev-parse', 'HEAD');
  mkdirSync(src, { recursive: true });
  git('init', '-q');
  for (const file of ['scripts/check-public.ts', 'scripts/export-public.sh']) {
    mkdirSync(join(src, 'scripts'), { recursive: true });
    copyFileSync(join(REPO, file), join(src, file));
  }
  write('.gitattributes', '* text=auto eol=lf\n');
  // --require-terms wants a real list: one term the tests use, plus filler.
  write('internal/private-terms.txt', ['# test terms', 'hamlet', ...Array.from({ length: 20 }, (_, i) => `filler${i}term`)].join('\n') + '\n');
  write('internal/export-exclude.txt', 'internal/\nnotes/plan.md\n');
  write('notes/plan.md', 'the hamlet plan\n');
  write('README.md', 'hello\n');
  write('docs/old.md', 'old\n');
  write('.gitignore', '*.log\n');
  write('keep.log', 'a tracked file the tree ignores\n');
  git('add', '-f', 'keep.log');
  return commit('first');
}

test.skipIf(!bash || !gitleaks)('export makes a single-commit snapshot of exactly the gated files, then diffs against it', () => {
  const first = setup();
  const one = exportTo('one', first);
  expect(one.status, one.stderr).toBe(0);
  const tree = join(root, 'one/tree');
  const inTree = (...args: string[]) => spawnSync('git', ['-C', tree, ...args], { encoding: 'utf8' }).stdout.trim();
  expect(existsSync(join(tree, 'README.md'))).toBe(true);
  expect(existsSync(join(tree, 'internal'))).toBe(false);
  expect(existsSync(join(tree, 'notes/plan.md'))).toBe(false);
  expect(inTree('rev-list', '--count', 'HEAD')).toBe('1');
  // The public commit names a date, never the private revision.
  expect(inTree('log', '-1', '--format=%s|%an')).toBe(`Meshrooms public snapshot ${utcDay(first)}|Igor Lins e Silva`);
  expect(inTree('log', '-1', '--format=%B')).not.toContain(first.slice(0, 7));
  expect(inTree('remote')).toBe('');
  // Committed files are the gated list, including one the tree's .gitignore would skip.
  expect(inTree('ls-files').split('\n')).toContain('keep.log');
  const manifest1 = readFileSync(join(root, 'one/MANIFEST.md'), 'utf8');
  expect(manifest1).toContain(`Source: \`${first}\``);
  expect(manifest1).toMatch(/Excluded: 3 files by 2 rules, under `internal\/`, `notes\/`/);
  expect(manifest1).not.toContain('plan.md'); // excluded names stay out of the manifest

  write('README.md', 'hello again\n');
  write('docs/new.md', 'new\n');
  rmSync(join(src, 'docs/old.md'));
  const second = commit('second');
  const two = exportTo('two', '--previous', join(root, 'one'), '--label', 'beta 2', second);
  expect(two.status, two.stderr).toBe(0);
  expect(spawnSync('git', ['-C', join(root, 'two/tree'), 'log', '-1', '--format=%s'], { encoding: 'utf8' }).stdout.trim())
    .toBe(`Meshrooms public snapshot ${utcDay(second)}: beta 2`);
  const manifest = readFileSync(join(root, 'two/MANIFEST.md'), 'utf8');
  expect(manifest).toContain(`Compared with: Meshrooms public snapshot ${utcDay(first)}`);
  expect(manifest).toMatch(/## Added \(1\)\n\n- `docs\/new\.md`/);
  expect(manifest).toMatch(/## Removed \(1\)\n\n- `docs\/old\.md`/);
  expect(manifest).toMatch(/## Changed \(1\)\n\n- `README\.md`/);
}, 120_000);

test.skipIf(!bash)('export refuses a leak, a private label, a revision other than HEAD, an unmerged revision and a dirty tree', () => {
  const base = setup();
  write('README.md', 'ask hamlet\n');
  const leaky = commit('leak');
  const leak = exportTo('leak', '--dry-run', leaky);
  expect(leak.status).not.toBe(0);
  expect(leak.stderr).toContain('README.md:1: private-term: hamlet');
  expect(existsSync(join(root, 'leak/tree'))).toBe(false);

  write('README.md', 'clean\n');
  const clean = commit('clean');
  const label = exportTo('label', '--dry-run', '--label', 'for hamlet', clean);
  expect(label.status).not.toBe(0);
  expect(label.stderr).toContain('--label failed the privacy gate');

  // The lists and the gate come from the checkout, so an older revision is refused even in a dry run.
  const older = exportTo('older', '--dry-run', base);
  expect(older.status).not.toBe(0);
  expect(older.stderr).toContain('check out');

  write('README.md', 'unmerged\n');
  const unmerged = commit('unmerged', false);
  const refused = exportTo('unmerged', unmerged);
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toContain('is not on fake/main');
  const dry = exportTo('dry', '--dry-run', unmerged);
  expect(dry.status, dry.stderr).toBe(0);
  expect(existsSync(join(root, 'dry/tree/.git'))).toBe(false);
  expect(readFileSync(join(root, 'dry/MANIFEST.md'), 'utf8')).toContain('**Dry run:**');

  write('README.md', 'edited\n');
  const dirty = exportTo('dirty', '--dry-run', unmerged);
  expect(dirty.status).not.toBe(0);
  expect(dirty.stderr).toContain('modified tracked files');
  git('checkout', '--', 'README.md');
}, 120_000);

// Git for Windows checks symbolic links out as plain files, so this runs where links are real.
test.skipIf(!bash || process.platform === 'win32')('export refuses symbolic links', () => {
  setup();
  const blob = spawnSync('git', ['-C', src, 'hash-object', '-w', '--stdin'], { input: '../README.md', encoding: 'utf8' }).stdout.trim();
  git('update-index', '--add', '--cacheinfo', `120000,${blob},docs/link.md`);
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'link');
  git('checkout', '--', '.');
  const linked = exportTo('link', '--dry-run', 'HEAD');
  expect(linked.status).not.toBe(0);
  expect(linked.stderr).toContain('symbolic links');
  expect(existsSync(join(root, 'link/tree'))).toBe(false);
}, 120_000);
