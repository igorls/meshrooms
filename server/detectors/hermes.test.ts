import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectHermes, HERMES_MAX_OUTPUT_BYTES, HERMES_VERIFIED_BUILD, parseHermesSessions, parseHermesVersion, runHermesCommand, type HermesCommandResult, type HermesRunner } from './hermes';
import { cappedFixture, headerFixture, listingFixture, rowFixture, versionFixture } from './fixtures/hermes-fixtures';

const good = (stdout: string): HermesCommandResult => ({ ok: true, stdout });
function stub(results: HermesCommandResult[]) {
  const calls: string[][] = [];
  const runner: HermesRunner = async args => { calls.push([...args]); return results.shift() ?? { ok: false, reason: 'failed' }; };
  return { calls, runner };
}

describe('Hermes version and fixed-width schema gates', () => {
  test('version excludes installation diagnostics and admits only the measured build', async () => {
    expect(parseHermesVersion(versionFixture)).toBe(HERMES_VERIFIED_BUILD);
    for (const version of ['0.21.5', '0.21.6', '0.22.0', '0.21.5+6489.gffffff', 'garbage']) {
      const s = stub([good(`Hermes Agent v${version}\n`)]);
      const result = await detectHermes(s.runner);
      expect(result.sessionsAvailable).toBe(false);
      expect(s.calls).toEqual([['--version']]);
    }
    expect(parseHermesVersion('warning\n' + versionFixture)).toBeNull();
    expect(parseHermesVersion('x'.repeat(HERMES_MAX_OUTPUT_BYTES + 1))).toBeNull();
  });

  test('parses literal IDs and nullable labels, never manufactures timestamps or cwd', () => {
    expect(parseHermesSessions(listingFixture)).toEqual({ truncated: false, sessions: [
      { harness: 'hermes', id: '20000101_000000_aabbcc', title: 'Synthetic fixture title', workspaceLabel: 'fixture-project', lastActiveLabel: 'just now' },
      { harness: 'hermes', id: '20000101_000001_aabbcc', title: null, workspaceLabel: null, lastActiveLabel: null },
    ] });
    expect(parseHermesSessions('No sessions found.\n')).toEqual({ sessions: [], truncated: false });
    expect(parseHermesSessions(listingFixture.replace(/\n/g, '\r\n'))?.sessions.length).toBe(2);
  });

  test('handles spaces, CJK, emoji and markup strictly as plain strings', () => {
    const title = '🚀 fixture <b>not HTML</b>';
    const parsed = parseHermesSessions(headerFixture + rowFixture(title, '合成-fixture'));
    expect(parsed?.sessions[0].title).toBe(title);
    expect(parsed?.sessions[0].workspaceLabel).toBe('合成-fixture');
  });

  test('recognizes relative or date labels without guessing an exact timestamp', () => {
    for (const active of ['just now', 'yesterday', '12m ago', '5h ago', '4d ago', '2000-01-01', '?']) {
      expect(parseHermesSessions(headerFixture + rowFixture('Fixture', 'fixture', active))?.sessions[0].lastActiveLabel).toBe(active === '?' ? null : active);
    }
  });

  test('reports truncation rather than claiming a complete session inventory', () => {
    const parsed = parseHermesSessions(cappedFixture);
    expect(parsed?.truncated).toBe(true);
    expect(parsed?.sessions.length).toBe(20);
    expect(parseHermesSessions(cappedFixture.replace('  … more not shown (use --limit 40 to see more)', 'unexpected footer'))).toBeNull();
  });

  test('rejects malformed IDs without repair and invalidates the entire listing', () => {
    for (const id of ['20000101_000000_AABBCC', '20000101_000000_aabbc', '20000101_000000_aabbcc ', 'latest', '--resume']) {
      expect(parseHermesSessions(headerFixture + rowFixture('Fixture', 'fixture', 'just now', id))).toBeNull();
    }
    expect(parseHermesSessions(headerFixture + rowFixture() + rowFixture())).toBeNull();
    expect(parseHermesSessions(listingFixture + 'garbage\n')).toBeNull();
  });

  test('fails closed on layout drift, previews, controls, full paths and excessive output', () => {
    const invalid = [
      listingFixture.replace('Workspace', 'Directory'), listingFixture.replace('─'.repeat(110), '─'.repeat(109)),
      listingFixture.replace('Title', 'Other'), 'Preview   Last Active ID\n', headerFixture,
      headerFixture + rowFixture('Fixture\u202e', 'fixture'), headerFixture + rowFixture('Fixture', '/private/path'),
      headerFixture + rowFixture('Fixture', 'C:\\fixture'), headerFixture + rowFixture('Fixture', '..'),
      listingFixture.replace('just now', 'nonsense'), '\x1b[32m' + listingFixture,
      listingFixture.replace('Synthetic', 'Synthetic\n'), 'x'.repeat(HERMES_MAX_OUTPUT_BYTES + 1),
      headerFixture + Array.from({ length: 21 }, () => rowFixture()).join(''),
      headerFixture + rowFixture() + '  … more not shown (use --limit 40 to see more)\n',
    ];
    for (const output of invalid) expect(parseHermesSessions(output)).toBeNull();
  });
});

describe('read-only detector orchestration', () => {
  test('only invokes version and the bounded listing, returns no raw diagnostics', async () => {
    const s = stub([good(versionFixture), good(listingFixture)]);
    const result = await detectHermes(s.runner);
    expect(result.sessionsAvailable).toBe(true);
    expect(s.calls).toEqual([['--version'], ['sessions', 'list', '--limit', '20']]);
    expect(JSON.stringify(result)).not.toContain('HERMES_INSTALL_PLACEHOLDER');
  });

  test('absence, execution failures and schema errors return only static reason codes', async () => {
    for (const reason of ['not-found', 'failed', 'timeout', 'output-limit'] as const) {
      const s = stub([{ ok: false, reason }]);
      const result = await detectHermes(s.runner);
      expect(result.detected).toBe(false);
      expect(s.calls.length).toBe(1);
      const list = await detectHermes(stub([good(versionFixture), { ok: false, reason }]).runner);
      expect(list).toEqual({ harness: 'hermes', detected: true, version: HERMES_VERIFIED_BUILD, sessionsAvailable: false, reason: 'listing-command-failed' });
    }
    expect(await detectHermes(stub([good(versionFixture), good('PRIVATE_SYNTHETIC_ERROR')]).runner)).toEqual({ harness: 'hermes', detected: true, version: HERMES_VERIFIED_BUILD, sessionsAvailable: false, reason: 'unsupported-schema' });
    const throwing: HermesRunner = async () => { throw new Error('PRIVATE_SYNTHETIC_ERROR'); };
    expect(JSON.stringify(await detectHermes(throwing))).not.toContain('PRIVATE_SYNTHETIC_ERROR');
  });

  test('transport refuses every mutating or unbounded invocation', async () => {
    for (const args of [['sessions', 'delete', 'fixture'], ['sessions', 'list'], ['chat', '--resume', 'fixture'], ['--version; echo fixture']]) {
      expect(await runHermesCommand(args)).toEqual({ ok: false, reason: 'failed' });
    }
  });
});

// Actual child-process tests; fake executable is exclusively synthetic and outside the repo.
// No production timeout/output bounds are weakened to make these tests pass.
test('transport enforces stdout/stderr bounds, errors, missing binary and hard timeout', async () => {
  if (process.platform === 'win32') return; // Unix fixture launcher; Windows integration still needed.
  const dir = mkdtempSync(join(tmpdir(), 'hermes-detector-fixture-'));
  const oldPath = process.env.PATH, oldMode = process.env.HERMES_DETECTOR_FIXTURE_MODE;
  try {
    const launcher = join(dir, 'hermes');
    writeFileSync(launcher, `#!${process.execPath}\nconst mode = process.env.HERMES_DETECTOR_FIXTURE_MODE;\nif (mode === 'stdout') process.stdout.write('x'.repeat(200000));\nelse if (mode === 'stderr') process.stderr.write('x'.repeat(200000));\nelse if (mode === 'fail') { process.stderr.write('PRIVATE_SYNTHETIC_ERROR'); process.exit(3); }\nelse if (mode === 'hang') setInterval(() => {}, 1000);\nelse process.stdout.write('fixture');\n`);
    chmodSync(launcher, 0o700);
    process.env.PATH = dir;
    expect(await runHermesCommand(['--version'])).toEqual(good('fixture'));
    for (const mode of ['stdout', 'stderr']) {
      process.env.HERMES_DETECTOR_FIXTURE_MODE = mode;
      expect(await runHermesCommand(['--version'])).toEqual({ ok: false, reason: 'output-limit' });
    }
    process.env.HERMES_DETECTOR_FIXTURE_MODE = 'fail';
    expect(await runHermesCommand(['--version'])).toEqual({ ok: false, reason: 'failed' });
    process.env.HERMES_DETECTOR_FIXTURE_MODE = 'hang';
    expect(await runHermesCommand(['--version'])).toEqual({ ok: false, reason: 'timeout' });
    rmSync(launcher);
    expect(await runHermesCommand(['--version'])).toEqual({ ok: false, reason: 'not-found' });
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldMode === undefined) delete process.env.HERMES_DETECTOR_FIXTURE_MODE; else process.env.HERMES_DETECTOR_FIXTURE_MODE = oldMode;
    rmSync(dir, { recursive: true, force: true });
  }
}, 35_000);

// Opt-in real integration: don't print or assert against objects containing actual private metadata.
// A generic failure cannot dump IDs/titles/paths via bun's assertion diagnostics.
test.skipIf(process.env.HERMES_DETECTOR_INTEGRATION !== '1')('installed Hermes read-only integration (sanitized assertions)', async () => {
  const result = await detectHermes();
  if (!result.detected || !result.sessionsAvailable) throw new Error('Installed Hermes detector did not provide the verified schema');
  expect(result.version === HERMES_VERIFIED_BUILD).toBe(true);
  expect(result.sessions.length <= 20).toBe(true);
  expect(result.sessions.every(s => Object.keys(s).sort().join(',') === 'harness,id,lastActiveLabel,title,workspaceLabel')).toBe(true);
  expect(result.sessions.every(s => s.workspaceLabel === null || !/[\/\\:]/.test(s.workspaceLabel))).toBe(true);
}, 65_000);
