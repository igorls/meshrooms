import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { packageBridge } from './package-runtime';

// Shell control-flow/component tests only. The real shell, Git worktrees,
// packageBridge provenance and Bun guards run against disposable fixtures.
// Native builds, signing, notarization and DMG creation are command stubs:
// passing these tests is NOT evidence of a signed immutable native release.
const contractTest = test.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64');
const identity = 'Developer ID Application: Release Contract Fixture (TESTTEAM00)';
const appleKeys = ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_PATH', 'API_PRIVATE_KEYS_DIR'];
type Manifest = { git: { commit: string | null; dirty: boolean; releaseCommit: string | null }; [key: string]: unknown };
type Event = { command: string; args: string[]; cwd: string; target: string; identity: string | null; appleEnv: (string | null)[]; appExists: boolean; appContent: string | null };

// Every operator-facing command is intercepted, with no fallback to its real
// implementation. Only Bun -e guards/version/hash checks are delegated to Bun.
const commandStub = String.raw`
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
const [command, ...args] = process.argv.slice(2);
const target = process.env.CARGO_TARGET_DIR ?? '';
const app = join(target, 'release/bundle/macos/Meshrooms.app');
const bridge = join(app, 'Contents/Resources/bridge');
const entry = join(bridge, 'meshrooms.js');
appendFileSync(process.env.CONTRACT_LOG!, JSON.stringify({
  command, args, cwd: process.cwd(), target,
  identity: process.env.APPLE_SIGNING_IDENTITY ?? null,
  appleEnv: ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_PATH', 'API_PRIVATE_KEYS_DIR'].map(k => process.env[k] ?? null),
  appExists: existsSync(app), appContent: existsSync(entry) ? readFileSync(entry, 'utf8') : null,
}) + '\n');
function fail() { console.error('Unexpected component command:', command, args); process.exit(93); }
if (command === 'uname') {
  if (args[0] === '-s') console.log('Darwin');
  else if (args[0] === '-m') console.log('arm64');
  else fail();
} else if (command === 'bun') {
  if (args[0] === '-e') {
    const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
    process.exit(result.status ?? 94);
  } else if (args[0] === 'install' && args[1] === '--frozen-lockfile') {
    // No dependency installation in component tests.
  } else if (args[0] === 'run' && args[1] === 'build:bridge') {
    // No compilation in component tests.
  } else if (args[0] === 'run' && args[1] === 'scripts/package-runtime.ts') {
    const out = args[args.indexOf('--out') + 1];
    cpSync(process.env.CONTRACT_SEED!, out, { recursive: true });
  } else if (args[0] === '../node_modules/@tauri-apps/cli/tauri.js') {
    mkdirSync(dirname(bridge), { recursive: true });
    cpSync(join(process.cwd(), '../.local/packages/desktop-bridge'), bridge, { recursive: true });
  } else if (args[0].endsWith('/scripts/package-macos-dmg.ts')) {
    // Simulate an uncommitted build replacing the shared app during staging.
    writeFileSync(process.env.CONTRACT_SHARED!, 'concurrent-uncommitted-build');
    const input = args[args.indexOf('--app') + 1];
    const bytes = readFileSync(join(input, 'Contents/Resources/bridge/meshrooms.js'), 'utf8');
    if (bytes !== 'bridge component fixture\n') fail();
    writeFileSync(args[args.indexOf('--out') + 1], 'component-only DMG fixture\n');
  } else fail();
} else if (command === 'codesign') {
  // Simulate the shared build changing during each signing/verification step.
  writeFileSync(process.env.CONTRACT_SHARED!, 'concurrent-uncommitted-build');
  if (args[0] === '-d') console.log('<key>com.apple.security.cs.allow-jit</key><true/>');
  else if (args[0] === '-dv') console.error('TeamIdentifier=TESTTEAM00');
  else if (!args.includes('--sign') && !args.includes('--verify')) fail();
} else if (command === 'ditto') {
  writeFileSync(args.at(-1)!, 'component-only ZIP fixture\n');
} else if (command === 'xcrun') {
  if (!['notarytool', 'stapler'].includes(args[0])) fail();
} else if (command === 'spctl') {
  if (args[0] !== '--assess') fail();
} else if (command === 'security') {
  // Tests must never discover a real Keychain identity.
  fail();
} else fail();
`;

const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
async function fixture(check: (f: {
  root: string; sandbox: string; seed: string; manifest: Manifest; commit: string; shared: string;
  git: (...args: string[]) => string;
  run: (args: string[]) => { status: number | null; output: string; events: Event[] };
}) => void | Promise<void>) {
  const sandbox = mkdtempSync(join(tmpdir(), 'mr-release-contract-'));
  const root = join(sandbox, 'checkout with spaces'), bin = join(sandbox, 'bin'), temp = join(sandbox, 'tmp');
  const seed = join(sandbox, 'seed'), log = join(sandbox, 'commands.jsonl');
  const env = {
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: temp,
    HOME: sandbox, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    APPLE_SIGNING_IDENTITY: identity, CARGO_TARGET_DIR: join(root, 'desktop/src-tauri/target'),
    CONTRACT_SEED: seed, CONTRACT_LOG: log,
    CONTRACT_SHARED: join(root, 'desktop/src-tauri/target/release/bundle/macos/Meshrooms.app/Contents/Resources/bridge/meshrooms.js'),
    ...Object.fromEntries(appleKeys.map(key => [key, 'component-fixture-only'])),
  };
  function put(path: string, content: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
  function git(...args: string[]) {
    const result = spawnSync('/usr/bin/git', args, { cwd: root, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Fixture git failed (${result.status}): ${result.stderr}`);
    return result.stdout.trim();
  }
  try {
    for (const dir of [root, bin, temp]) mkdirSync(dir, { recursive: true });
    put(join(sandbox, 'command-stub.ts'), commandStub);
    for (const name of ['bun', 'uname', 'codesign', 'xcrun', 'spctl', 'ditto', 'security']) {
      const path = join(bin, name);
      put(path, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(sandbox, 'command-stub.ts'))} ${shellQuote(name)} "$@"\n`);
      chmodSync(path, 0o755);
    }
    put(join(root, '.gitignore'), ['desktop/src-tauri/target/', '.local/', ''].join('\n'));
    put(join(root, 'desktop/src-tauri/tauri.conf.json'), '{"version":"1.2.3"}\n');
    put(join(root, 'packages/meshrooms/package.json'), '{"version":"1.2.3"}\n');
    put(join(root, 'packages/meshrooms/bin/meshrooms.js'), 'bridge component fixture\n');
    put(join(root, 'packages/meshrooms/THIRD_PARTY_LICENSES.txt'), 'license fixture\n');
    put(join(root, 'THIRD_PARTY_NOTICES.md'), 'notice fixture\n');
    put(join(root, 'LICENSE'), 'license fixture\n');
    mkdirSync(join(root, 'scripts'));
    copyFileSync(join(import.meta.dir, 'macos-release.sh'), join(root, 'scripts/macos-release.sh'));
    git('init', '--quiet');
    git('add', '.');
    git('-c', 'user.name=Contract Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Release contract fixture');
    const commit = git('rev-parse', 'HEAD');
    const fakeBun = join(sandbox, 'fixture-bun');
    put(fakeBun, '#!/bin/sh\nprintf "component-version\\n"\n'); chmodSync(fakeBun, 0o755);
    // Real packageBridge (no codesignIdentity) produces the nested manifest.
    await packageBridge({ sourceDir: root, outputDir: seed, bunPath: fakeBun });
    const manifest: Manifest = JSON.parse(readFileSync(join(seed, 'manifest.json'), 'utf8'));
    put(env.CONTRACT_SHARED, 'shared-before-release');
    const run = (args: string[]) => {
      writeFileSync(log, '');
      const result = spawnSync('/bin/bash', ['scripts/macos-release.sh', ...args], { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
      if (result.error) throw result.error;
      const events: Event[] = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      return { status: result.status, output: result.stdout + result.stderr, events };
    };
    await check({ root, sandbox, seed, manifest, commit, shared: env.CONTRACT_SHARED, git, run });
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
}

contractTest('shell component: genuine clean provenance, private target through DMG, and --no-notarize', () => fixture(f => {
  expect(f.manifest.git).toEqual({ commit: f.commit, dirty: false, releaseCommit: f.commit });
  const result = f.run(['--ref', f.commit, '--no-notarize', '--notary-profile', 'unused-component-profile']);
  expect(result.status).toBe(0);
  expect(result.output).toContain('==> Done');
  const packaging = result.events.find(e => e.command === 'bun' && e.args[1] === 'scripts/package-runtime.ts')!;
  expect(packaging.args).toEqual(['run', 'scripts/package-runtime.ts', '--bridge', '--out', '.local/packages/desktop-bridge', '--codesign-identity', identity]);
  const build = result.events.find(e => e.command === 'bun' && e.args[0].endsWith('/tauri.js'))!;
  expect(build.args).toEqual(['../node_modules/@tauri-apps/cli/tauri.js', 'build', '--bundles', 'app', '--no-sign', '--config', 'src-tauri/tauri.release.conf.json']);
  const work = dirname(dirname(build.cwd));
  const target = join(work, 'target'), app = join(target, 'release/bundle/macos/Meshrooms.app');
  expect(build.target).toBe(target);
  expect(work.startsWith(join(f.sandbox, 'tmp') + '/')).toBe(true);
  expect(packaging.cwd).toBe(join(work, 'source'));
  expect(build.identity).toBeNull();
  expect(build.appleEnv).toEqual(appleKeys.map(() => null));
  const codesign = result.events.filter(e => e.command === 'codesign');
  expect(codesign[0].args).toEqual(['--force', '--options', 'runtime', '--timestamp', '--sign', identity, app]);
  expect(codesign.some(e => e.args.includes('--deep') && e.args.includes('--sign'))).toBe(false);
  expect(codesign.some(e => e.args.join(' ') === ['--verify', '--deep', '--strict', '--verbose=2', app].join(' '))).toBe(true);
  for (const event of codesign) {
    expect(event.target).toBe(target);
    expect(event.appExists).toBe(true);
    expect(event.appContent).toBe('bridge component fixture\n');
  }
  const dmg = result.events.find(e => e.command === 'bun' && e.args[0].endsWith('/scripts/package-macos-dmg.ts'))!;
  const output = join(f.root, '.release/Meshrooms_1.2.3_aarch64.dmg');
  expect(dmg.args).toEqual([join(work, 'source/scripts/package-macos-dmg.ts'), '--app', app, '--out', output]);
  expect(dmg.target).toBe(target);
  expect(dmg.appExists).toBe(true);
  expect(readFileSync(output, 'utf8')).toBe('component-only DMG fixture\n');
  expect(readFileSync(f.shared, 'utf8')).toBe('concurrent-uncommitted-build');
  expect(result.events.filter(e => ['xcrun', 'ditto', 'spctl', 'security'].includes(e.command))).toEqual([]);
  expect(existsSync(work)).toBe(false);
  expect(f.git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree '))).toEqual([`worktree ${f.root}`]);
}));

contractTest('shell component: default notarization retains Keychain-profile CLI for app and DMG', () => fixture(f => {
  const profile = 'component profile with spaces';
  const result = f.run(['--notary-profile', profile]);
  expect(result.status).toBe(0);
  const build = result.events.find(e => e.command === 'bun' && e.args[0].endsWith('/tauri.js'))!;
  const work = dirname(dirname(build.cwd)), app = join(work, 'target/release/bundle/macos/Meshrooms.app');
  const output = join(f.root, '.release/Meshrooms_1.2.3_aarch64.dmg');
  expect(result.events.filter(e => e.command === 'xcrun').map(e => e.args)).toEqual([
    ['notarytool', 'history', '--keychain-profile', profile],
    ['notarytool', 'submit', join(work, 'Meshrooms.zip'), '--keychain-profile', profile, '--wait'],
    ['stapler', 'staple', app], ['stapler', 'validate', app],
    ['notarytool', 'submit', output, '--keychain-profile', profile, '--wait'],
    ['stapler', 'staple', output], ['stapler', 'validate', output],
  ]);
  expect(result.events.filter(e => e.command === 'spctl').map(e => e.args)).toEqual([
    ['--assess', '--type', 'execute', '--verbose=4', app],
    ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', output],
  ]);
  expect(existsSync(work)).toBe(false);
}));

function expectProvenanceFailure(f: Parameters<Parameters<typeof fixture>[0]>[0]) {
  const result = f.run(['--no-notarize']);
  expect(result.status).not.toBe(0);
  expect(result.events.some(e => e.command === 'bun' && e.args[0].endsWith('/tauri.js'))).toBe(false);
  expect(result.events.some(e => ['codesign', 'ditto', 'xcrun', 'spctl'].includes(e.command))).toBe(false);
  expect(existsSync(join(f.root, '.release'))).toBe(false);
  const packaging = result.events.find(e => e.command === 'bun' && e.args[1] === 'scripts/package-runtime.ts')!;
  expect(existsSync(dirname(packaging.cwd))).toBe(false);
  expect(readFileSync(f.shared, 'utf8')).toBe('shared-before-release');
  return result;
}

contractTest('shell component: genuine dirty packageBridge provenance fails before native build/sign/stage', () => fixture(async f => {
  writeFileSync(join(f.root, 'LICENSE'), 'uncommitted component fixture\n');
  const dirtySeed = join(f.sandbox, 'dirty-seed');
  await packageBridge({ sourceDir: f.root, outputDir: dirtySeed, bunPath: join(f.sandbox, 'fixture-bun') });
  const dirty: Manifest = JSON.parse(readFileSync(join(dirtySeed, 'manifest.json'), 'utf8'));
  expect(dirty.git).toEqual({ commit: f.commit, dirty: true, releaseCommit: null });
  copyFileSync(join(dirtySeed, 'manifest.json'), join(f.seed, 'manifest.json'));
  expect(expectProvenanceFailure(f).output).toContain('Bridge manifest does not pin the clean release commit');
}));

const invalidProvenance: [string, (m: Manifest) => unknown][] = [
  ['legacy top-level releaseCommit', m => ({ releaseCommit: m.git.releaseCommit })],
  ['missing git', () => ({})], ['null manifest', () => null], ['array manifest', () => []],
  ['null git', m => ({ ...m, git: null })], ['array git', m => ({ ...m, git: [] })],
  ['missing dirty', m => ({ ...m, git: { commit: m.git.commit, releaseCommit: m.git.releaseCommit } })],
  ['string dirty', m => ({ ...m, git: { ...m.git, dirty: 'false' } })],
  ['dirty with forged releaseCommit', m => ({ ...m, git: { ...m.git, dirty: true } })],
  ['null releaseCommit', m => ({ ...m, git: { ...m.git, releaseCommit: null } })],
  ['missing releaseCommit', m => ({ ...m, git: { commit: m.git.commit, dirty: false } })],
  ['malformed releaseCommit', m => ({ ...m, git: { ...m.git, releaseCommit: 'not-a-commit' } })],
  ['mismatched releaseCommit', m => ({ ...m, git: { ...m.git, releaseCommit: '0'.repeat(40) } })],
  ['null commit', m => ({ ...m, git: { ...m.git, commit: null } })],
  ['missing commit', m => ({ ...m, git: { dirty: false, releaseCommit: m.git.releaseCommit } })],
  ['mismatched commit', m => ({ ...m, git: { ...m.git, commit: '0'.repeat(40) } })],
];
for (const [name, mutate] of invalidProvenance) {
  contractTest(`shell component: rejects ${name} provenance`, () => fixture(f => {
    writeFileSync(join(f.seed, 'manifest.json'), JSON.stringify(mutate(f.manifest)));
    expect(expectProvenanceFailure(f).output).toContain('Bridge manifest does not pin the clean release commit');
  }));
}
contractTest('shell component: rejects invalid manifest JSON', () => fixture(f => {
  writeFileSync(join(f.seed, 'manifest.json'), '{');
  expectProvenanceFailure(f);
}));
contractTest('shell component: rejects absent manifest', () => fixture(f => {
  rmSync(join(f.seed, 'manifest.json'));
  expectProvenanceFailure(f);
}));
contractTest('shell component: CLI rejects unknown options and missing values before operator commands', () => fixture(f => {
  for (const args of [['--library', 'unused'], ['--unknown'], ['--ref'], ['--notary-profile']]) {
    const result = f.run(args);
    expect(result.status).not.toBe(0);
    expect(result.events).toEqual([]);
    expect(result.output).toContain(args[0].startsWith('--notary') || args[0] === '--ref' ? 'missing value' : 'Unknown argument');
  }
}));
