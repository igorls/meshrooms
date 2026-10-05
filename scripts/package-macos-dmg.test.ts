import { expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { packageMacosDmg, runDmgCommand } from './package-macos-dmg';

type Run = NonNullable<Parameters<typeof packageMacosDmg>[1]>;
const macTest = test.skipIf(process.platform !== 'darwin');
function fixture(check: (f: { root: string; app: string; script: string; output: string }) => void) {
  const root = mkdtempSync(join(tmpdir(), 'mr-image-input-'));
  const app = join(root, 'Example.app'), script = join(root, 'bundle_dmg.sh');
  mkdirSync(join(app, 'Contents'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'Info.plist'), '<plist/>');
  writeFileSync(script, 'exit 99\n');
  try { check({ root, app, script, output: join(root, 'result.dmg') }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
const success = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const noMounts: Run = (command) => success(command.endsWith('plutil') ? '{"images":[]}' : '<plist/>');
function noWork(root: string) { expect(readdirSync(root).filter(name => name.startsWith('.meshrooms-dmg-'))).toEqual([]); }
function failsCleanly(action: () => unknown, message: string) {
  let error: unknown;
  try { action(); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain(message);
  expect(String(error)).not.toContain('cleanup failed');
  expect(String(error)).not.toContain('Cannot remove owned work directory');
}

macTest('refuses unsafe, existing and dangling-symlink output before running the image tool', () => fixture(f => {
  const run: Run = () => { throw new Error('must not invoke the tool'); };
  expect(() => packageMacosDmg({ ...f, output: join(f.app, 'nested.dmg') }, run)).toThrow('cannot be inside');
  writeFileSync(f.output, 'original');
  expect(() => packageMacosDmg(f, run)).toThrow('left untouched');
  expect(readFileSync(f.output, 'utf8')).toBe('original');
  rmSync(f.output); symlinkSync('missing-target', f.output);
  expect(() => packageMacosDmg(f, run)).toThrow('left untouched');
  expect(readlinkSync(f.output)).toBe('missing-target');
  expect(() => packageMacosDmg({ ...f, output: join(f.root, 'bad.txt') }, run)).toThrow('end in .dmg');
  noWork(f.root);
}));

macTest('rejects a symlinked physical output parent, including a nonexistent suffix, before mutating the app', () => fixture(f => {
  const alias = join(f.root, 'alias'); symlinkSync(f.app, alias);
  const before = readdirSync(f.app);
  for (const suffix of ['nested.dmg', 'missing/deeper/nested.dmg']) {
    expect(() => packageMacosDmg({ ...f, output: join(alias, suffix) })).toThrow('cannot be inside');
  }
  expect(readdirSync(f.app)).toEqual(before);
  expect(existsSync(join(f.app, 'missing'))).toBe(false);
  noWork(f.root);
}));

macTest('component seam: stages relative framework symlinks that survive removal of the original source', () => fixture(f => {
  const framework = join(f.app, 'Contents', 'Frameworks', 'Example.framework');
  mkdirSync(join(framework, 'Versions', 'A', 'Resources'), { recursive: true });
  writeFileSync(join(framework, 'Versions', 'A', 'Example'), 'framework fixture');
  writeFileSync(join(framework, 'Versions', 'A', 'Resources', 'Info.plist'), 'resource fixture');
  symlinkSync('A', join(framework, 'Versions', 'Current'));
  symlinkSync('Versions/Current/Example', join(framework, 'Example'));
  symlinkSync('Versions/Current/Resources', join(framework, 'Resources'));
  let temporary = '';
  const run: Run = (command, args) => {
    if (command === '/bin/bash') {
      temporary = args.at(-2)!;
      const stage = args.at(-1)!;
      expect(temporary.startsWith(stage + '/')).toBe(false);
      expect(existsSync(f.output)).toBe(false);
      const copied = join(stage, 'Example.app', 'Contents', 'Frameworks', 'Example.framework');
      for (const link of ['Versions/Current', 'Example', 'Resources']) {
        expect(readlinkSync(join(copied, link))).toBe(readlinkSync(join(framework, link)));
        expect(isAbsolute(readlinkSync(join(copied, link)))).toBe(false);
      }
      rmSync(f.app, { recursive: true });
      expect(readFileSync(join(copied, 'Example'), 'utf8')).toBe('framework fixture');
      expect(readFileSync(join(copied, 'Resources', 'Info.plist'), 'utf8')).toBe('resource fixture');
      writeFileSync(temporary, 'component-only image bytes');
    } else {
      expect(args).toEqual(['verify', temporary]);
      expect(existsSync(f.output)).toBe(false);
    }
    return success();
  };
  const result = packageMacosDmg(f, run);
  expect(result.bytes).toBe(Buffer.byteLength('component-only image bytes'));
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(readFileSync(f.output, 'utf8')).toBe('component-only image bytes');
  noWork(f.root);
}));

macTest('native default path builds a verified fixture image without a vendor script (not app startup)', () => fixture(f => {
  const result = packageMacosDmg({ app: f.app, output: f.output });
  expect(result.file).toBe(f.output);
  expect(result.bytes).toBeGreaterThan(0);
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(existsSync(f.output)).toBe(true);
  noWork(f.root);
}), 180_000);

macTest('native shell creation failure removes its owned partial and rw image, never publishing a final', () => fixture(f => {
  writeFileSync(f.script, 'image="${@: -2:1}"\nprintf partial > "$image"\nprintf writable > "$(dirname "$image")/rw.$$.verified.dmg"\nexit 7\n');
  failsCleanly(() => packageMacosDmg(f), 'Disk-image creation failed');
  expect(existsSync(f.output)).toBe(false);
  noWork(f.root);
}));

macTest('native hdiutil verification rejects an invalid fixture image and removes the owned image', () => fixture(f => {
  writeFileSync(f.script, 'printf invalid > "${@: -2:1}"\n');
  failsCleanly(() => packageMacosDmg(f), 'Disk-image verification failed');
  expect(existsSync(f.output)).toBe(false);
  noWork(f.root);
}));

macTest('component seam: success without an image does not publish', () => fixture(f => {
  const run: Run = (command, args, options) => command === '/bin/bash' ? success() : noMounts(command, args, options);
  expect(() => packageMacosDmg(f, run)).toThrow('without creating an image');
  expect(existsSync(f.output)).toBe(false);
  noWork(f.root);
}));

macTest('component seam: publication does not overwrite an output created during verification', () => fixture(f => {
  const run: Run = (command, args, options) => {
    if (command === '/bin/bash') { writeFileSync(args.at(-2)!, 'component image'); return success(); }
    if (args[0] === 'verify') { writeFileSync(f.output, 'racing original'); return success(); }
    return noMounts(command, args, options);
  };
  expect(() => packageMacosDmg(f, run)).toThrow('EEXIST');
  expect(readFileSync(f.output, 'utf8')).toBe('racing original');
  noWork(f.root);
}));

macTest('component seam: failure detaches only uniquely-owned image devices', () => fixture(f => {
  let work = '';
  const detached: string[] = [];
  const run: Run = (command, args) => {
    if (command === '/bin/bash') {
      const image = args.at(-2)!; work = dirname(dirname(image));
      writeFileSync(image, 'partial');
      return { status: 9, stdout: '', stderr: 'creation failure' };
    }
    if (command.endsWith('plutil')) return success(JSON.stringify({ images: [
      { 'image-path': join(work, 'images', 'rw.123.verified.dmg'), 'system-entities': [{ 'dev-entry': '/dev/disk999' }] },
      { 'image-path': join(f.root, 'unrelated.dmg'), 'system-entities': [{ 'dev-entry': '/dev/disk998' }] },
    ] }));
    if (args[0] === 'detach') detached.push(args[1]!);
    return success('<plist/>');
  };
  expect(() => packageMacosDmg(f, run)).toThrow('creation failure');
  expect(detached).toEqual(['/dev/disk999']);
  expect(existsSync(f.output)).toBe(false);
  noWork(f.root);
}));

macTest('component seam: failed mount cleanup is surfaced without claiming resource cleanup', () => fixture(f => {
  const run: Run = (command) => ({ status: 1, stdout: '', stderr: command === '/bin/bash' ? 'creation failure' : 'inspection failed' });
  expect(() => packageMacosDmg(f, run)).toThrow('an owned mount may need manual cleanup');
  expect(existsSync(f.output)).toBe(false);
  noWork(f.root);
}));

macTest('native timeout stops only its isolated shell group and cleans partial images', () => fixture(f => {
  const childPid = join(f.root, 'child.pid');
  writeFileSync(f.script, 'image="${@: -2:1}"\nprintf partial > "$image"\nsleep 30 &\nprintf "%s" "$!" > "$CHILD_PID_FILE"\nwait\n');
  // Pass the fixture path as an extra shell positional argument, not environment/settings.
  const run: Run = (command, args, options) => {
    if (command !== '/bin/bash') return runDmgCommand(command, args, options);
    return runDmgCommand(command, ['-c', 'export CHILD_PID_FILE="$1"; shift; exec /bin/bash "$@"', 'fixture', childPid, ...args], { ...options, timeout: 500 });
  };
  failsCleanly(() => packageMacosDmg(f, run), 'Disk-image creation failed');
  expect(existsSync(f.output)).toBe(false);
  expect(lstatSync(childPid).isFile()).toBe(true);
  const pid = Number(readFileSync(childPid, 'utf8'));
  // Killed children can briefly be zombies; ps must not report a running sleeper.
  const status = runDmgCommand('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { timeout: 5000 });
  expect(status.stdout.trim() === '' || status.stdout.trim().startsWith('Z')).toBe(true);
  noWork(f.root);
}));
