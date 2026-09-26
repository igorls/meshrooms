import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  lstatSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';

export type PackageOptions = {
  sourceDir: string;
  outputDir: string;
  externalBun?: boolean;
  nativeLibraryPath?: string;
  /** macOS only: Developer ID identity for bun and the native library, applied before hashing. */
  codesignIdentity?: string;
};

export type PackageResult = {
  directory: string;
  manifestPath: string;
};

const TARGETS = {
  'win32-x64': { platform: 'win32', arch: 'x64', library: 'wormdb_ffi.dll', libraryLabel: 'WormDB native DLL', bun: 'bun.exe' },
  'darwin-arm64': { platform: 'darwin', arch: 'arm64', library: 'libwormdb_ffi.dylib', libraryLabel: 'WormDB native library', bun: 'bun' },
} as const;
type PackageTarget = (typeof TARGETS)[keyof typeof TARGETS];

export type PackageManifest = {
  schema: 1;
  platform: PackageTarget['platform'];
  arch: PackageTarget['arch'];
  version: string;
  bun: { version: string; bundled: boolean };
  git: {
    commit: string | null;
    dirty: boolean;
    releaseCommit: string | null;
  };
  entry: string;
  files: Record<string, string>;
};

const REQUIRED_SERVER_FILES = ['daemon.ts', 'cli.ts', 'runtime.ts'];
// The browser-room agent bridge ships separately as dist/agent/meshrooms-agent.js; the local runtime never loads it.
const EXCLUDED_SERVER_FILES = new Set(['test-directory.ts', 'mockRoom.ts', 'browser-agent.ts', 'agent-cli.ts', 'github-issues.ts']);

function computeSha256(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

function getGitInfo(dir: string): { commit: string | null; dirty: boolean; releaseCommit: string | null } {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const dirty = status.length > 0;
    // Must not claim release commit if working directory is dirty
    const releaseCommit = dirty ? null : commit;
    return { commit: commit || null, dirty, releaseCommit };
  } catch {
    return { commit: null, dirty: true, releaseCommit: null };
  }
}

function copyRecursive(src: string, dest: string, filesToHash: string[], rootDest: string) {
  const stat = lstatSync(src);
  if (stat.isSymbolicLink()) throw new Error(`Runtime inputs cannot contain links: ${src}`);
  if (stat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const item of readdirSync(src)) {
      copyRecursive(join(src, item), join(dest, item), filesToHash, rootDest);
    }
  } else {
    const relativeFile = relative(rootDest, dest).replaceAll('\\', '/');
    if (!stat.isFile() || (relativeFile !== 'dist/index.html' && !/^dist\/assets\/.+\.(js|css|woff2?|svg|png|jpe?g|webp|gif|ico|avif)$/.test(relativeFile))) throw new Error(`Unexpected built UI input: ${relativeFile}`);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    filesToHash.push(relative(rootDest, dest).replaceAll('\\', '/'));
  }
}

export async function packageRuntime(options: PackageOptions): Promise<PackageResult> {
  const target: PackageTarget | undefined = TARGETS[`${process.platform}-${process.arch}` as keyof typeof TARGETS];
  if (!target) {
    throw new Error(`packageRuntime currently targets Windows x64 and macOS arm64 only. Detected: ${process.platform}-${process.arch}`);
  }

  if (options.codesignIdentity && target.platform !== 'darwin') {
    throw new Error('Code signing during packaging is only supported for macOS bundles.');
  }

  const sourceDir = resolve(options.sourceDir);
  const outputDir = resolve(options.outputDir);
  for (const input of ['dist', 'server', 'src', '.local/native', 'skills']) {
    const rel = relative(join(sourceDir, input), outputDir);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Output cannot be inside a packaged input directory.');
  }

  if (!existsSync(sourceDir)) {
    throw new Error(`Source directory does not exist: ${sourceDir}`);
  }

  if (existsSync(outputDir)) {
    throw new Error(`Output directory already exists: ${outputDir}. Refusing to overwrite.`);
  }

  // 1. Validate required inputs
  const distDir = join(sourceDir, 'dist');
  if (!existsSync(distDir) || !existsSync(join(distDir, 'index.html'))) {
    throw new Error(`Built UI is missing in source directory (${distDir}). Build UI before packaging.`);
  }

  const dllPath = options.nativeLibraryPath ? resolve(options.nativeLibraryPath) : join(sourceDir, '.local', 'native', target.library);
  if (!existsSync(dllPath)) {
    throw new Error(`Required ${target.libraryLabel} is missing: ${dllPath}`);
  }

  const serverDir = join(sourceDir, 'server');
  if (!existsSync(serverDir)) {
    throw new Error(`Server directory missing: ${serverDir}`);
  }
  for (const req of REQUIRED_SERVER_FILES) {
    const file = join(serverDir, req);
    if (!existsSync(file)) {
      throw new Error(`Required server file missing: server/${req}`);
    }
  }

  const roomTs = join(sourceDir, 'src', 'room.ts');
  if (!existsSync(roomTs)) {
    throw new Error(`Required type file missing: src/room.ts`);
  }
  const setupTs = join(sourceDir, 'src', 'setup.ts');
  if (!existsSync(setupTs)) throw new Error('Required type file missing: src/setup.ts');
  // Shared room logic imported at runtime by server/node.ts and server/cli.ts.
  const collabTs = join(sourceDir, 'src', 'collab.ts');
  if (!existsSync(collabTs)) throw new Error('Required shared file missing: src/collab.ts');
  const attachmentsTs = join(sourceDir, 'src', 'attachments.ts');
  if (!existsSync(attachmentsTs)) throw new Error('Required shared file missing: src/attachments.ts');
  const skillPath = join(sourceDir, 'skills', 'meshrooms', 'SKILL.md');
  if (!existsSync(skillPath)) throw new Error('Required skill missing: skills/meshrooms/SKILL.md');
  const metadata = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8'));
  for (const required of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'skills/meshrooms/LICENSE']) {
    if (!existsSync(join(sourceDir, required))) throw new Error(`Required notice missing: ${required}`);
  }
  for (const input of [serverDir, join(serverDir, 'persistence'), join(sourceDir, 'src'), join(sourceDir, '.local'), join(sourceDir, '.local', 'native'), join(sourceDir, 'skills'), join(sourceDir, 'skills', 'meshrooms'), roomTs, setupTs, collabTs, attachmentsTs, dllPath, skillPath]) {
    if (existsSync(input) && lstatSync(input).isSymbolicLink()) throw new Error(`Runtime inputs cannot contain links: ${input}`);
  }

  // 2. Prepare destination directory
  mkdirSync(dirname(outputDir), { recursive: true });
  mkdirSync(outputDir);
  const relativeFiles: string[] = [];

  // 3. Copy dist/
  copyRecursive(distDir, join(outputDir, 'dist'), relativeFiles, outputDir);

  // 4. Copy server/*.ts (excluding tests, mockRoom, test-directory)
  const destServerDir = join(outputDir, 'server');
  mkdirSync(destServerDir, { recursive: true });
  for (const file of readdirSync(serverDir)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts') || EXCLUDED_SERVER_FILES.has(file)) {
      continue;
    }
    const srcPath = join(serverDir, file);
    if (lstatSync(srcPath).isSymbolicLink()) throw new Error(`Runtime inputs cannot contain links: ${srcPath}`);
    if (statSync(srcPath).isFile()) {
      const destPath = join(destServerDir, file);
      copyFileSync(srcPath, destPath);
      relativeFiles.push(relative(outputDir, destPath).replaceAll('\\', '/'));
    }
  }

  // Copy server/persistence/*.ts if present (excluding tests and fixtures)
  const srcPersistenceDir = join(serverDir, 'persistence');
  if (existsSync(srcPersistenceDir)) {
    const destPersistenceDir = join(destServerDir, 'persistence');
    mkdirSync(destPersistenceDir, { recursive: true });
    for (const file of readdirSync(srcPersistenceDir)) {
      if (file.endsWith('.ts') && !file.endsWith('.test.ts')) {
        const srcPath = join(srcPersistenceDir, file);
        if (lstatSync(srcPath).isSymbolicLink()) throw new Error(`Runtime inputs cannot contain links: ${srcPath}`);
        if (statSync(srcPath).isFile()) {
          const destPath = join(destPersistenceDir, file);
          copyFileSync(srcPath, destPath);
          relativeFiles.push(relative(outputDir, destPath).replaceAll('\\', '/'));
        }
      }
    }
  }

  // 5. Copy shared types and the portable agent skill.
  const destSrcDir = join(outputDir, 'src');
  mkdirSync(destSrcDir, { recursive: true });
  copyFileSync(roomTs, join(destSrcDir, 'room.ts'));
  relativeFiles.push('src/room.ts');
  copyFileSync(collabTs, join(destSrcDir, 'collab.ts'));
  relativeFiles.push('src/collab.ts');
  copyFileSync(attachmentsTs, join(destSrcDir, 'attachments.ts'));
  relativeFiles.push('src/attachments.ts');

  if (existsSync(setupTs)) {
    copyFileSync(setupTs, join(destSrcDir, 'setup.ts'));
    relativeFiles.push('src/setup.ts');
  }
  mkdirSync(join(outputDir, 'skills', 'meshrooms'), { recursive: true });
  copyFileSync(skillPath, join(outputDir, 'skills', 'meshrooms', 'SKILL.md'));
  relativeFiles.push('skills/meshrooms/SKILL.md');
  const extraFiles = ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'skills/meshrooms/LICENSE'];
  for (const folder of ['LICENSES', 'skills/meshrooms/scripts']) {
    const path = join(sourceDir, folder);
    if (!existsSync(path)) continue;
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Runtime inputs cannot contain links: ${path}`);
    for (const name of readdirSync(path)) {
      if (!/^[a-zA-Z0-9._-]+\.(txt|md|ps1)$/.test(name)) throw new Error(`Unexpected release resource: ${name}`);
      extraFiles.push(`${folder}/${name}`);
    }
  }
  for (const file of extraFiles) {
    const src = join(sourceDir, file);
    if (!lstatSync(src).isFile() || lstatSync(src).isSymbolicLink()) throw new Error(`Invalid release resource: ${file}`);
    mkdirSync(dirname(join(outputDir, file)), { recursive: true });
    copyFileSync(src, join(outputDir, file));
    relativeFiles.push(file);
  }

  // 6. Copy native library
  const destNativeDir = join(outputDir, '.local', 'native');
  mkdirSync(destNativeDir, { recursive: true });
  copyFileSync(dllPath, join(destNativeDir, target.library));
  relativeFiles.push(`.local/native/${target.library}`);

  // 7. Copy bun executable (bun.exe on Windows)
  if (!options.externalBun) {
    copyFileSync(process.execPath, join(outputDir, target.bun));
    if (target.platform !== 'win32') chmodSync(join(outputDir, target.bun), 0o755);
    relativeFiles.push(target.bun);
  }

  // 7b. Sign before hashing: re-signing rewrites the binaries, and notarization requires
  // Developer ID with hardened runtime for every Mach-O file in the app bundle.
  if (options.codesignIdentity) {
    const sign = (file: string, entitlements?: string) => {
      execFileSync('/usr/bin/codesign', ['--force', '--timestamp', '--options', 'runtime', '--sign', options.codesignIdentity!,
        ...(entitlements ? ['--entitlements', entitlements] : []), file], { stdio: 'pipe' });
      execFileSync('/usr/bin/codesign', ['--verify', '--strict', file], { stdio: 'pipe' });
    };
    sign(join(destNativeDir, target.library));
    if (!options.externalBun) sign(join(outputDir, target.bun), join(import.meta.dir, 'macos', 'bun.entitlements'));
  }

  // 8. Write minimal package.json
  const minimalPackageJson = {
    name: 'meshrooms-runtime',
    version: metadata.version,
    private: true,
    type: 'module',
  };
  writeFileSync(join(outputDir, 'package.json'), JSON.stringify(minimalPackageJson, null, 2) + '\n');
  relativeFiles.push('package.json');

  // 9. Build manifest with SHA256 hashes
  relativeFiles.sort();
  const fileHashes: Record<string, string> = {};
  for (const rel of relativeFiles) {
    const fullPath = join(outputDir, rel);
    fileHashes[rel] = computeSha256(fullPath);
  }

  const gitInfo = getGitInfo(sourceDir);
  const manifest: PackageManifest = {
    schema: 1,
    platform: target.platform,
    arch: target.arch,
    version: metadata.version,
    bun: { version: '1.4.2', bundled: !options.externalBun },
    git: gitInfo,
    entry: `${target.bun} run server/cli.ts`,
    files: fileHashes,
  };

  const manifestPath = join(outputDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  return {
    directory: outputDir,
    manifestPath,
  };
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  let sourceDir = root;
  let outputDir = resolve(root, '.local', 'packages', 'current');
  let externalBun = false;
  let nativeLibraryPath: string | undefined;
  let codesignIdentity: string | undefined;

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source') {
      sourceDir = resolve(args[++i]);
    } else if (args[i] === '--out') {
      outputDir = resolve(args[++i]);
    } else if (args[i] === '--external-bun') {
      externalBun = true;
    } else if (args[i] === '--library') {
      nativeLibraryPath = resolve(args[++i]);
    } else if (args[i] === '--codesign-identity') {
      codesignIdentity = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: bun run scripts/package-runtime.ts [--source PATH] [--out PATH] [--library DLL] [--external-bun] [--codesign-identity NAME]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${args[i]}`);
      process.exit(1);
    }
  }

  packageRuntime({ sourceDir, outputDir, externalBun, nativeLibraryPath, codesignIdentity })
    .then((result) => {
      console.log(JSON.stringify({ event: 'runtime.packaged', ...result }, null, 2));
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
