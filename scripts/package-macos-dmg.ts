import { createHash } from 'node:crypto';
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { closeSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

interface CommandOptions { cwd?: string; timeout: number; input?: string; logDirectory?: string }
interface CommandResult { status: number | null; stdout: string; stderr: string; error?: Error }
type Run = (command: string, args: string[], options: CommandOptions) => CommandResult;

/** Isolate the vendor shell's children; file-backed logs cannot keep timeout pipes open. */
export const runDmgCommand: Run = (command, args, options) => {
  const logs = options.logDirectory
    ? [join(options.logDirectory, 'stdout.log'), join(options.logDirectory, 'stderr.log')]
    : [];
  const fds: number[] = [];
  try {
    for (const log of logs) fds.push(openSync(log, 'wx', 0o600));
    // Both Node and Bun honor detached for spawnSync, though Node's typings omit it.
    const spawnOptions: SpawnSyncOptionsWithStringEncoding & { detached: boolean } = {
      cwd: options.cwd, timeout: options.timeout, input: options.input, encoding: 'utf8',
      detached: true, killSignal: 'SIGKILL',
      stdio: fds.length ? ['ignore', fds[0]!, fds[1]!] : ['pipe', 'pipe', 'pipe'],
    };
    const result = spawnSync(command, args, spawnOptions);
    let error: Error | undefined = result.error;
    if ((error || result.status !== 0) && result.pid) {
      // Only this invocation's new process group, never a process-name search.
      try { process.kill(-result.pid, 'SIGKILL'); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
          error = new Error(`${error?.message ?? 'Command failed'}; cannot stop owned process group: ${String(e)}`);
        }
      }
    }
    return {
      status: result.status, error,
      stdout: logs.length ? readFileSync(logs[0]!, 'utf8') : (result.stdout ?? ''),
      stderr: logs.length ? readFileSync(logs[1]!, 'utf8') : (result.stderr ?? ''),
    };
  } finally {
    for (const fd of fds) closeSync(fd);
  }
};

function inside(parent: string, path: string) {
  const rel = relative(parent, path);
  return !rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function entryExists(path: string) {
  try { lstatSync(path); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}

/** Resolve the physical ancestor BEFORE creating even a missing suffix. */
function physicalParent(parent: string): string {
  try { return realpathSync(parent); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || entryExists(parent)) throw e;
    return join(physicalParent(dirname(parent)), basename(parent));
  }
}

function succeeded(result: CommandResult, action: string) {
  if (result.error || result.status !== 0) {
    throw new Error(`${action}: ${result.error?.message ?? (result.stderr || result.stdout || `exit ${result.status}`)}`);
  }
}

/** Detach only images whose backing paths belong to this unique work directory. */
function detachOwnedImages(work: string, run: Run) {
  const info = run('/usr/bin/hdiutil', ['info', '-plist'], { timeout: 15_000 });
  succeeded(info, 'Cannot inspect owned disk-image mounts');
  const decoded = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { timeout: 15_000, input: info.stdout });
  succeeded(decoded, 'Cannot decode disk-image mount information');
  const data = JSON.parse(decoded.stdout) as { images?: { 'image-path'?: string; 'system-entities'?: { 'dev-entry'?: string }[] }[] };
  for (const image of data.images ?? []) {
    if (!image['image-path'] || !inside(work, resolve(image['image-path']))) continue;
    const device = image['system-entities']?.map(entity => entity['dev-entry']).find(dev => dev && /^\/dev\/disk\d+$/.test(dev));
    if (!device) throw new Error('Cannot identify the device for an owned mounted image.');
    succeeded(run('/usr/bin/hdiutil', ['detach', device], { timeout: 30_000 }), 'Cannot detach owned disk image');
  }
}

/** Package an already built macOS app without putting a writable image into its own input folder. */
export function packageMacosDmg(options: { app: string; output: string; script?: string }, run: Run = runDmgCommand) {
  if (process.platform !== 'darwin') throw new Error('macOS disk-image packaging must run on macOS.');
  const app = realpathSync(resolve(options.app));
  if (!lstatSync(app).isDirectory() || !app.endsWith('.app')) throw new Error('Give a built .app directory.');
  if (!existsSync(join(app, 'Contents', 'Info.plist'))) throw new Error('The app has no Info.plist.');
  const requested = resolve(options.output), script = options.script ? realpathSync(resolve(options.script)) : undefined;
  if (!requested.endsWith('.dmg')) throw new Error('The output must end in .dmg.');
  const parent = physicalParent(dirname(requested));
  const output = join(parent, basename(requested));
  if (inside(app, output)) throw new Error('The output cannot be inside the app.');
  if (entryExists(output)) throw new Error('The disk-image output already exists; it was left untouched.');
  if (script && !lstatSync(script).isFile()) throw new Error('Give the generated Tauri bundle_dmg.sh.');
  mkdirSync(parent, { recursive: true });
  // Images (including the vendor's rw.PID image) and logs have one unique owner.
  // Stage ONLY the app; neither writable nor compressed images can be copied into themselves.
  const work = mkdtempSync(join(parent, '.meshrooms-dmg-'));
  let started = false;
  let failure: unknown;
  let artifact: { file: string; bytes: number; sha256: string; layout: string } | undefined;
  try {
    const stage = join(work, 'source'), images = join(work, 'images');
    mkdirSync(stage); mkdirSync(images);
    const image = join(images, 'verified.dmg');
    cpSync(app, join(stage, basename(app)), { recursive: true, dereference: false, verbatimSymlinks: true });
    // App-only Tauri builds do not generate a vendor DMG shell script. The
    // native path shares the same isolated staging, verification and publication.
    if (!script) symlinkSync('/Applications', join(stage, 'Applications'));
    started = true;
    const command = script ? '/bin/bash' : '/usr/bin/hdiutil';
    const args = script
      ? [script, '--skip-jenkins', '--volname', 'Meshrooms', '--app-drop-link', '400', '200', image, stage]
      : ['create', '-volname', 'Meshrooms', '-srcfolder', stage, '-format', 'UDZO', image];
    succeeded(run(command, args, {
      cwd: script ? dirname(script) : work, timeout: 180_000, logDirectory: work,
    }), 'Disk-image creation failed');
    if (!entryExists(image)) throw new Error('The disk-image tool reported success without creating an image.');
    if (!lstatSync(image).isFile()) throw new Error('The disk-image tool did not create a regular image file.');
    succeeded(run('/usr/bin/hdiutil', ['verify', image], { timeout: 60_000 }), 'Disk-image verification failed');
    artifact = { file: output, bytes: statSync(image).size, sha256: createHash('sha256').update(readFileSync(image)).digest('hex'),
      layout: 'app plus Applications link; noninteractive, no Finder automation' };
    // A hard link is atomic and fails if any entry (including a dangling symlink)
    // appeared at the final path. Never rename over an existing output.
    linkSync(image, output);
  } catch (e) {
    failure = e;
  }
  const cleanupErrors: string[] = [];
  if (started && failure) {
    try { detachOwnedImages(work, run); }
    catch (e) { cleanupErrors.push(`Mount cleanup failed; an owned mount may need manual cleanup: ${String(e)}`); }
  }
  try { rmSync(work, { recursive: true, force: true }); }
  catch (e) { cleanupErrors.push(`Cannot remove owned work directory ${work}: ${String(e)}`); }
  if (cleanupErrors.length) throw new Error(`${failure ? String(failure) : 'Image was verified and published'}; ${cleanupErrors.join('; ')}`);
  if (failure) throw failure;
  return artifact!;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (key: string) => { const at = args.indexOf(key); return at < 0 ? undefined : args[at + 1]; };
  const app = value('--app'), output = value('--out'), script = value('--script');
  if (!app || !output) throw new Error('Use --app APP --out IMAGE.dmg [--script GENERATED_BUNDLE_DMG_SH].');
  console.log(JSON.stringify(packageMacosDmg({ app, output, script })));
}
