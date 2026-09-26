import { describe, it, expect, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageRuntime, type PackageManifest } from './package-runtime';
import { testDirectory } from '../server/test-directory';

const tempDirs: ReturnType<typeof testDirectory>[] = [];

function makeDir(label = 'pkg-test') {
  const dir = testDirectory(label);
  tempDirs.push(dir);
  return dir.path;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    dir.cleanup();
  }
});

function createMockSourceFixture(baseDir: string) {
  // 1. dist/index.html
  const distDir = join(baseDir, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><html><body>Mock UI</body></html>\n');

  // 2. server/
  const serverDir = join(baseDir, 'server');
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(join(serverDir, 'daemon.ts'), '// mock daemon\n');
  writeFileSync(join(serverDir, 'cli.ts'), '// mock cli\n');
  writeFileSync(join(serverDir, 'runtime.ts'), '// mock runtime\n');
  writeFileSync(join(serverDir, 'node.ts'), '// mock node\n');
  writeFileSync(join(serverDir, 'http.ts'), '// mock http\n');
  writeFileSync(join(serverDir, 'instance.ts'), '// mock instance\n');
  writeFileSync(join(serverDir, 'browser-agent.ts'), '// shipped as its own bundle\n');
  writeFileSync(join(serverDir, 'github-issues.ts'), '// part of the agent bundle\n');
  writeFileSync(join(serverDir, 'agent-cli.ts'), '// shipped as its own bundle\n');

  // Excluded test & helper files in server
  writeFileSync(join(serverDir, 'daemon.test.ts'), '// should be excluded\n');
  writeFileSync(join(serverDir, 'mockRoom.ts'), '// should be excluded\n');
  writeFileSync(join(serverDir, 'test-directory.ts'), '// should be excluded\n');

  // server/persistence/
  const persistenceDir = join(serverDir, 'persistence');
  mkdirSync(persistenceDir, { recursive: true });
  writeFileSync(join(persistenceDir, 'store.ts'), '// mock store\n');
  writeFileSync(join(persistenceDir, 'wormdb.ts'), '// mock wormdb\n');
  writeFileSync(join(persistenceDir, 'wormdb.test.ts'), '// should be excluded\n');

  // 3. src/room.ts + src/setup.ts
  const srcDir = join(baseDir, 'src');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, 'room.ts'), '// mock room types\n');
  writeFileSync(join(srcDir, 'setup.ts'), '// mock setup types\n');
  writeFileSync(join(srcDir, 'collab.ts'), '// mock shared room logic\n');
  writeFileSync(join(srcDir, 'attachments.ts'), '// mock shared attachment rules\n');
  mkdirSync(join(baseDir, 'skills', 'meshrooms'), { recursive: true });
  writeFileSync(join(baseDir, 'skills', 'meshrooms', 'SKILL.md'), '---\nname: meshrooms\ndescription: Start a local room.\n---\n');
  writeFileSync(join(baseDir, 'skills', 'meshrooms', 'LICENSE'), 'Test license');
  writeFileSync(join(baseDir, 'LICENSE'), 'Test license');
  writeFileSync(join(baseDir, 'THIRD_PARTY_NOTICES.md'), 'Test notices');
  writeFileSync(join(baseDir, 'package.json'), JSON.stringify({ version: '0.1.0-alpha.1' }));

  // 4. .local/native/wormdb_ffi.dll
  const nativeDir = join(baseDir, '.local', 'native');
  mkdirSync(nativeDir, { recursive: true });
  writeFileSync(join(nativeDir, 'wormdb_ffi.dll'), 'MOCK_DLL_BINARY_CONTENT');

  // 5. Sensitive / machine / temporary files that MUST NOT be packaged
  writeFileSync(join(baseDir, 'control.key'), 'SUPER_SECRET_CONTROL_TOKEN_NEVER_PACKAGE');
  writeFileSync(join(baseDir, 'runtime.json'), '{"pid": 1234, "url": "http://127.0.0.1:4318"}');
  writeFileSync(join(baseDir, '.env'), 'SECRET_KEY=12345');
  writeFileSync(join(baseDir, 'daemon.log'), 'sensitive logs');

  const nodeModulesDir = join(baseDir, 'node_modules', 'some-pkg');
  mkdirSync(nodeModulesDir, { recursive: true });
  writeFileSync(join(nodeModulesDir, 'index.js'), '// mock dep');
}

// The runtime packager supports Windows x64 only.
const describeWin = process.platform === 'win32' && process.arch === 'x64' ? describe : describe.skip;

describeWin('Runtime Packaging (packageRuntime)', () => {
  it("rejects a linked src/collab.ts like the other runtime inputs (Copilot's review of #5)", async () => {
    const root = makeDir('linked-collab'), source = join(root, 'source');
    createMockSourceFixture(source);
    writeFileSync(join(root, 'outside.ts'), '// outside the source tree');
    rmSync(join(source, 'src', 'collab.ts'));
    try { symlinkSync(join(root, 'outside.ts'), join(source, 'src', 'collab.ts'), 'file'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return; throw error; } // Needs symlink rights on Windows.
    await expect(packageRuntime({ sourceDir: source, outputDir: join(root, 'out') })).rejects.toThrow(/cannot contain links/);
  });

  it('fails honestly when required inputs are missing', async () => {
    const root = makeDir('missing-inputs');
    const outputDir = join(root, 'pkg-out');

    // Missing dist
    const src1 = join(root, 'src1');
    mkdirSync(src1, { recursive: true });
    await expect(packageRuntime({ sourceDir: src1, outputDir })).rejects.toThrow(/Built UI is missing/);

    // Missing dll
    const src2 = join(root, 'src2');
    mkdirSync(join(src2, 'dist'), { recursive: true });
    writeFileSync(join(src2, 'dist', 'index.html'), '<html></html>');
    await expect(packageRuntime({ sourceDir: src2, outputDir })).rejects.toThrow(/WormDB native DLL is missing/);

    // Missing server files
    const src3 = join(root, 'src3');
    mkdirSync(join(src3, 'dist'), { recursive: true });
    writeFileSync(join(src3, 'dist', 'index.html'), '<html></html>');
    mkdirSync(join(src3, '.local', 'native'), { recursive: true });
    writeFileSync(join(src3, '.local', 'native', 'wormdb_ffi.dll'), 'dll');
    await expect(packageRuntime({ sourceDir: src3, outputDir })).rejects.toThrow(/Server directory missing/);

    // Missing cli.ts specifically
    mkdirSync(join(src3, 'server'), { recursive: true });
    writeFileSync(join(src3, 'server', 'daemon.ts'), '//');
    writeFileSync(join(src3, 'server', 'runtime.ts'), '//');
    await expect(packageRuntime({ sourceDir: src3, outputDir })).rejects.toThrow(/server\/cli\.ts/);
  });

  it('fails without modification if output directory already exists', async () => {
    const root = makeDir('output-exists');
    const sourceDir = join(root, 'mock-src');
    createMockSourceFixture(sourceDir);

    const existingOutputDir = join(root, 'existing-pkg');
    mkdirSync(existingOutputDir, { recursive: true });
    const sentinelPath = join(existingOutputDir, 'important-file.txt');
    writeFileSync(sentinelPath, 'DO_NOT_DELETE');

    await expect(packageRuntime({ sourceDir, outputDir: existingOutputDir })).rejects.toThrow(
      /Output directory already exists.*Refusing to overwrite/,
    );

    // Verify existing directory was NOT modified or deleted
    expect(existsSync(sentinelPath)).toBe(true);
    expect(readFileSync(sentinelPath, 'utf8')).toBe('DO_NOT_DELETE');
  });

  it('packages clean runtime, excludes sensitive files, and verifies manifest hashes', async () => {
    const root = makeDir('clean-package');
    const sourceDir = join(root, 'mock-src');
    createMockSourceFixture(sourceDir);

    const outputDir = join(root, 'packaged-runtime');
    const result = await packageRuntime({ sourceDir, outputDir });

    expect(result.directory).toBe(outputDir);
    expect(result.manifestPath).toBe(join(outputDir, 'manifest.json'));
    expect(existsSync(result.manifestPath)).toBe(true);

    // 1. Verify sensitive files are strictly excluded
    expect(existsSync(join(outputDir, 'control.key'))).toBe(false);
    expect(existsSync(join(outputDir, 'runtime.json'))).toBe(false);
    expect(existsSync(join(outputDir, '.env'))).toBe(false);
    expect(existsSync(join(outputDir, 'daemon.log'))).toBe(false);
    expect(existsSync(join(outputDir, 'node_modules'))).toBe(false);

    // Verify test files in server are excluded
    expect(existsSync(join(outputDir, 'server', 'daemon.test.ts'))).toBe(false);
    expect(existsSync(join(outputDir, 'server', 'mockRoom.ts'))).toBe(false);
    expect(existsSync(join(outputDir, 'server', 'test-directory.ts'))).toBe(false);
    expect(existsSync(join(outputDir, 'server', 'persistence', 'wormdb.test.ts'))).toBe(false);

    // 2. Verify required files are present
    expect(existsSync(join(outputDir, 'bun.exe'))).toBe(true);
    expect(existsSync(join(outputDir, 'package.json'))).toBe(true);
    expect(existsSync(join(outputDir, 'dist', 'index.html'))).toBe(true);
    expect(existsSync(join(outputDir, 'server', 'daemon.ts'))).toBe(true);
    expect(existsSync(join(outputDir, 'server', 'cli.ts'))).toBe(true);
    expect(existsSync(join(outputDir, 'server', 'runtime.ts'))).toBe(true);
    expect(existsSync(join(outputDir, 'server', 'persistence', 'store.ts'))).toBe(true);
    expect(existsSync(join(outputDir, 'server', 'persistence', 'wormdb.ts'))).toBe(true);
    expect(existsSync(join(outputDir, 'src', 'room.ts'))).toBe(true);
    expect(existsSync(join(outputDir, 'src', 'setup.ts'))).toBe(true);
    expect(existsSync(join(outputDir, 'src', 'collab.ts'))).toBe(true);
    // Copilot's review of #10: server/attachments.ts imports it at runtime.
    expect(existsSync(join(outputDir, 'src', 'attachments.ts'))).toBe(true);
    // The browser bridge ships as its own bundle, never in the local runtime.
    expect(existsSync(join(outputDir, 'server', 'browser-agent.ts'))).toBe(false);
    expect(existsSync(join(outputDir, 'server', 'github-issues.ts'))).toBe(false);
    expect(existsSync(join(outputDir, 'server', 'agent-cli.ts'))).toBe(false);
    expect(existsSync(join(outputDir, 'skills', 'meshrooms', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(outputDir, '.local', 'native', 'wormdb_ffi.dll'))).toBe(true);

    // 3. Verify manifest contents and cryptographic file hashes
    const manifest: PackageManifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
    expect(manifest.schema).toBe(1);
    expect(manifest.platform).toBe('win32');
    expect(manifest.arch).toBe('x64');
    expect(manifest.entry).toBe('bun.exe run server/cli.ts');
    expect(typeof manifest.git).toBe('object');

    // For every file recorded in the manifest, verify SHA-256 against actual bytes on disk
    for (const [relPath, expectedHash] of Object.entries(manifest.files)) {
      const fullPath = join(outputDir, relPath);
      expect(existsSync(fullPath)).toBe(true);
      const actualBytes = readFileSync(fullPath);
      const computedHash = createHash('sha256').update(actualBytes).digest('hex');
      expect(computedHash).toBe(expectedHash);
    }

    // Verify bun.exe matches process.execPath
    const bunExpectedHash = createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
    expect(manifest.files['bun.exe']).toBe(bunExpectedHash);

    // Verify minimal package.json contents
    const pkg = JSON.parse(readFileSync(join(outputDir, 'package.json'), 'utf8'));
    expect(pkg.type).toBe('module');
    expect(pkg.name).toBe('meshrooms-runtime');
  });

  it('rejects a recursive output target and contaminated build output', async () => {
    const root = makeDir('bad-package-target'); const sourceDir = join(root, 'source'); createMockSourceFixture(sourceDir);
    await expect(packageRuntime({ sourceDir, outputDir: join(sourceDir, 'dist', 'package') })).rejects.toThrow('inside a packaged input');
    expect(existsSync(join(sourceDir, 'dist', 'package'))).toBe(false);
    writeFileSync(join(sourceDir, 'dist', 'control.key'), 'private');
    await expect(packageRuntime({ sourceDir, outputDir: join(root, 'package') })).rejects.toThrow('Unexpected built UI input');
    expect(existsSync(join(root, 'package', 'dist', 'control.key'))).toBe(false);
  });

  it('can prepare a public archive that installs Bun separately and retains notices', async () => {
    const root = makeDir('external-bun');
    const sourceDir = join(root, 'source'); createMockSourceFixture(sourceDir);
    const result = await packageRuntime({ sourceDir, outputDir: join(root, 'out'), externalBun: true });
    const manifest: PackageManifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
    expect(manifest.bun).toEqual({ version: '1.4.2', bundled: false });
    expect(manifest.version).toBe('0.1.0-alpha.1');
    expect(existsSync(join(result.directory, 'bun.exe'))).toBe(false);
    expect(manifest.files['LICENSE']).toBeDefined();
    // Every runtime source is covered by the release hashes (Copilot on #10).
    expect(manifest.files['src/attachments.ts']).toBeDefined();
    expect(manifest.files['src/collab.ts']).toBeDefined();
    expect(manifest.files['skills/meshrooms/LICENSE']).toBeDefined();
    expect(manifest.files['THIRD_PARTY_NOTICES.md']).toBeDefined();
  });
});

const describeMac = process.platform === 'darwin' && process.arch === 'arm64' ? describe : describe.skip;

describeMac('Runtime Packaging on macOS arm64 (packageRuntime)', () => {
  function createMacFixture(baseDir: string) {
    createMockSourceFixture(baseDir);
    writeFileSync(join(baseDir, '.local', 'native', 'libwormdb_ffi.dylib'), 'MOCK_DYLIB_BINARY_CONTENT');
  }

  it('fails closed when the native dylib is missing', async () => {
    const root = makeDir('mac-missing-dylib');
    const sourceDir = join(root, 'source'); createMockSourceFixture(sourceDir);
    await expect(packageRuntime({ sourceDir, outputDir: join(root, 'out') })).rejects.toThrow(/WormDB native library is missing: .*libwormdb_ffi\.dylib/);
    expect(existsSync(join(root, 'out'))).toBe(false);
  });

  it('packages a darwin-arm64 bundle with an executable bun and dylib', async () => {
    const root = makeDir('mac-package');
    const sourceDir = join(root, 'source'); createMacFixture(sourceDir);
    const result = await packageRuntime({ sourceDir, outputDir: join(root, 'out') });
    const out = result.directory;
    expect(existsSync(join(out, 'bun'))).toBe(true);
    expect(statSync(join(out, 'bun')).mode & 0o777).toBe(0o755);
    expect(existsSync(join(out, 'bun.exe'))).toBe(false);
    expect(readFileSync(join(out, '.local', 'native', 'libwormdb_ffi.dylib'), 'utf8')).toBe('MOCK_DYLIB_BINARY_CONTENT');
    expect(existsSync(join(out, '.local', 'native', 'wormdb_ffi.dll'))).toBe(false);
    for (const excluded of ['control.key', 'runtime.json', '.env', 'daemon.log', 'node_modules', 'server/daemon.test.ts', 'server/mockRoom.ts']) {
      expect(existsSync(join(out, excluded))).toBe(false);
    }
    const manifest: PackageManifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
    expect(manifest.platform).toBe('darwin');
    expect(manifest.arch).toBe('arm64');
    expect(manifest.entry).toBe('bun run server/cli.ts');
    expect(manifest.bun.bundled).toBe(true);
    expect(manifest.files['bun']).toBe(createHash('sha256').update(readFileSync(process.execPath)).digest('hex'));
    expect(manifest.files['.local/native/libwormdb_ffi.dylib']).toBeDefined();
    expect(manifest.files['.local/native/wormdb_ffi.dll']).toBeUndefined();
    for (const [relPath, expectedHash] of Object.entries(manifest.files)) {
      expect(createHash('sha256').update(readFileSync(join(out, relPath))).digest('hex')).toBe(expectedHash);
    }
  });

  it('honors an explicit library path and external Bun', async () => {
    const root = makeDir('mac-external');
    const sourceDir = join(root, 'source'); createMockSourceFixture(sourceDir);
    const library = join(root, 'custom.dylib'); writeFileSync(library, 'CUSTOM_DYLIB');
    const result = await packageRuntime({ sourceDir, outputDir: join(root, 'out'), externalBun: true, nativeLibraryPath: library });
    const manifest: PackageManifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
    expect(manifest.bun).toEqual({ version: '1.4.2', bundled: false });
    expect(manifest.files['bun']).toBeUndefined();
    expect(existsSync(join(result.directory, 'bun'))).toBe(false);
    expect(readFileSync(join(result.directory, '.local', 'native', 'libwormdb_ffi.dylib'), 'utf8')).toBe('CUSTOM_DYLIB');
  });
});
