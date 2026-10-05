import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLAUDE_VERIFIED, CODEX_VERIFIED, SESSION_LIMIT, TITLE_CODE_POINTS, claudeSessionFolder, folderLabel, freshClaudeSession, freshCodexThread, harnessScanner, headLines, hermesIdFresh,
  listClaudeSessions, listCodexThreads, listSessions,
  parseClaudeVersion, parseCodexVersion, plainText, promptTitle, runBounded, scanHarnesses, type CommandResult, type ScanDeps,
} from './harnesses';
import { HERMES_VERIFIED_BUILD } from './hermes';
import { testDirectory } from '../test-directory';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const folder = () => { const dir = testDirectory('harnesses'); cleanups.push(dir.cleanup); return dir.path; };
const uuid = () => crypto.randomUUID();
const jsonl = (lines: unknown[]) => lines.map(line => JSON.stringify(line)).join('\n') + '\n';
/** Sets a file's last write `secondsAgo` seconds back, so listings order by it. */
const age = (path: string, secondsAgo: number) => { const at = new Date(Date.now() - secondsAgo * 1000); utimesSync(path, at, at); };

/** A Claude Code config folder with sessions in two projects, written as Claude Code writes them (synthetic text only). */
function claudeFixture() {
  const dir = folder(), projects = join(dir, 'projects');
  const a = join(projects, '-work-alpha'), b = join(projects, 'C--work-beta');
  mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true });
  const first = uuid(), second = uuid(), third = uuid(), noTitle = uuid();
  writeFileSync(join(a, `${first}.jsonl`), jsonl([
    { type: 'queue-operation', operation: 'enqueue', content: 'x'.repeat(5_000) },
    { type: 'user', isMeta: true, cwd: '/work/alpha', message: { role: 'user', content: 'meta line, never a title' } },
    { type: 'user', cwd: '/work/alpha', message: { role: 'user', content: '<command-name>/clear</command-name>\n<command-args></command-args>' } },
    { type: 'user', cwd: '/work/alpha', message: { role: 'user', content: '<system-reminder>hidden</system-reminder>\nFix the \u202edrawkcab\u202c login\u0007 bug\nsecond line' } },
  ]));
  writeFileSync(join(b, `${second}.jsonl`), jsonl([
    { type: 'user', isSidechain: true, cwd: 'C:\\work\\beta', message: { role: 'user', content: 'a subagent prompt' } },
    { type: 'user', cwd: 'C:\\work\\beta', message: { role: 'user', content: [{ type: 'tool_result', content: 'not text' }] } },
    { type: 'user', cwd: 'C:\\work\\beta', message: { role: 'user', content: [{ type: 'text', text: 'Ä'.repeat(100) }] } },
  ]));
  writeFileSync(join(b, `${third}.jsonl`), jsonl([{ type: 'user', cwd: 'C:\\work\\beta', message: { role: 'user', content: 'Oldest one' } }]));
  writeFileSync(join(a, `${noTitle}.jsonl`), 'not json\n');
  writeFileSync(join(a, 'not-a-session.jsonl'), jsonl([{ type: 'user', message: { content: 'ignored' } }]));
  age(join(a, `${first}.jsonl`), 10); age(join(b, `${second}.jsonl`), 20); age(join(b, `${third}.jsonl`), 30); age(join(a, `${noTitle}.jsonl`), 40);
  return { dir, first, second, third, noTitle };
}

test('versions: only the version is kept, and only measured ones open the sessions', () => {
  expect(parseClaudeVersion('2.1.289 (Claude Code)\n')).toBe('2.1.289');
  expect(parseClaudeVersion('Claude Code 2.1.289')).toBeNull();
  expect(parseCodexVersion('codex-cli 0.159.2\n')).toBe('0.159.2');
  expect(parseCodexVersion('codex 0.159.2')).toBeNull();
  expect(CLAUDE_VERIFIED.test('2.1.289')).toBe(true);
  expect(CLAUDE_VERIFIED.test('3.0.0')).toBe(false);
  expect(CODEX_VERIFIED.test('0.159.2')).toBe(true);
  expect(CODEX_VERIFIED.test('0.160.0')).toBe(false);
});

test('titles and folder labels are plain capped text: no markup, control, format or bidi characters, never a path', () => {
  expect(plainText('a\u202eb\u0007c\u2028d\u200be', 60)).toBe('a b c d e');
  expect(plainText('x'.repeat(100), TITLE_CODE_POINTS)).toHaveLength(TITLE_CODE_POINTS);
  expect(Array.from(plainText('😀'.repeat(100), TITLE_CODE_POINTS)!)).toHaveLength(TITLE_CODE_POINTS);
  expect(plainText('   ', 10)).toBeNull();
  expect(promptTitle('<environment_context>\n<cwd>/x</cwd>\n</environment_context>')).toBeUndefined();
  expect(promptTitle('<command-message>a</command-message>\n\nRename the <b>button</b>')).toBe('Rename the button');
  expect(folderLabel('/home/someone/work/alpha')).toBe('alpha');
  expect(folderLabel('C:\\Users\\someone\\beta\\')).toBe('beta');
  expect(folderLabel(42)).toBeNull();
});

test('a transcript is read only from its start, and a line the limit cuts is dropped', () => {
  const dir = folder(), path = join(dir, 'big.jsonl');
  writeFileSync(path, `${'a'.repeat(10)}\n${'b'.repeat(100)}\n`);
  expect(headLines(path, 50)).toEqual(['a'.repeat(10)]);
  expect(headLines(join(dir, 'missing.jsonl'))).toEqual([]);
});

test('Claude Code sessions across projects, newest first, with the first thing typed as the title and the folder\'s last segment', () => {
  const f = claudeFixture();
  const { sessions, truncated } = listClaudeSessions(f.dir);
  expect(sessions.map(s => s.id)).toEqual([f.first, f.second, f.third, f.noTitle]);
  expect(truncated).toBe(false);
  expect(sessions[0]).toMatchObject({ title: 'Fix the drawkcab login bug', folder: 'alpha' });
  expect(sessions[0].lastActiveAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(sessions[1]).toMatchObject({ folder: 'beta' });
  expect(Array.from(sessions[1].title!)).toHaveLength(TITLE_CODE_POINTS);
  expect(sessions[3]).toMatchObject({ title: null, folder: null });
  // Capped, and the rest counted as more.
  expect(listClaudeSessions(f.dir, 2)).toMatchObject({ truncated: true });
  expect(listClaudeSessions(f.dir, 2).sessions).toHaveLength(2);
  expect(listClaudeSessions(join(f.dir, 'nothing'))).toEqual({ sessions: [], truncated: false });
  // Nothing in a listing is a path or the transcript's content beyond the title.
  expect(JSON.stringify(sessions)).not.toMatch(/work[\\/]|second line|meta line|subagent/);
  // The session's own folder, for binding it after approval: server-side only.
  expect(claudeSessionFolder(f.first, f.dir)).toBe('/work/alpha');
  expect(claudeSessionFolder(uuid(), f.dir)).toBeUndefined();
});

test('Codex threads: newest first, subagents\' threads left out, Codex\'s own thread name first', () => {
  const dir = folder(), day = join(dir, 'sessions', '2026', '10', '04');
  mkdirSync(day, { recursive: true });
  const named = uuid(), plain = uuid(), sub = uuid(), broken = uuid();
  const meta = (id: string, extra: object = {}) => ({ type: 'session_meta', payload: { id, cwd: '/work/gamma', originator: 'codex_exec', cli_version: '0.159.2', ...extra } });
  const file = (id: string) => join(day, `rollout-2026-10-04T10-00-00-${id}.jsonl`);
  writeFileSync(file(named), jsonl([meta(named)]));
  writeFileSync(file(plain), jsonl([meta(plain, { cwd: 'D:\\work\\delta' }),
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'developer text' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context><cwd>/x</cwd></environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Write the release notes' }] } }]));
  writeFileSync(file(sub), jsonl([meta(sub, { source: { subagent: { thread_spawn: {} } } })]));
  writeFileSync(file(broken), 'nope\n');
  writeFileSync(join(dir, 'session_index.jsonl'), jsonl([{ id: named, thread_name: 'Old name', updated_at: 'x' }, { id: named, thread_name: 'Rename\u202e the thread', updated_at: 'y' }]));
  age(file(named), 30); age(file(plain), 20); age(file(sub), 10); age(file(broken), 5);
  const { sessions } = listCodexThreads(dir);
  expect(sessions.map(s => s.id)).toEqual([plain, named]);
  expect(sessions[0]).toMatchObject({ title: 'Write the release notes', folder: 'delta' });
  expect(sessions[1]).toMatchObject({ title: 'Rename the thread', folder: 'gamma' });
  expect(listCodexThreads(dir, 1)).toMatchObject({ truncated: true });
  expect(listCodexThreads(join(dir, 'none'))).toEqual({ sessions: [], truncated: false });
});

/** A machine where `found` programs answer `--version` with what `answers` says. */
function machine(answers: Partial<Record<'claude' | 'codex' | 'hermes', CommandResult | 'missing'>>, dirs: { claudeDir?: string; codexHome?: string } = {}) {
  const asked: string[] = [];
  const deps: ScanDeps = {
    resolve: name => { if (answers[name as 'claude'] === 'missing' || answers[name as 'claude'] === undefined) throw new Error('not on PATH'); return { file: `/bin/${name}`, prefix: [] }; },
    run: async (program, args) => { asked.push(`${program.file} ${args.join(' ')}`); return answers[program.file.slice(5) as 'claude'] as CommandResult; },
    hermes: async args => {
      const answer = answers.hermes;
      if (answer === undefined || answer === 'missing') return { ok: false, reason: 'not-found' };
      if (args[0] === '--version') return answer;
      return { ok: true, stdout: 'No sessions found.\n' };
    },
    claudeDir: dirs.claudeDir ?? folder(), codexHome: dirs.codexHome ?? folder(),
  };
  return { deps, asked };
}

test('the scan: what is installed and which sessions can be listed, failing closed on what it doesn\'t know', async () => {
  const f = claudeFixture();
  const ok = (stdout: string): CommandResult => ({ ok: true, stdout });
  const { deps, asked } = machine({ claude: ok('2.1.289 (Claude Code)\n'), codex: ok('codex-cli 0.170.0\n'), hermes: ok(`Hermes Agent v${HERMES_VERIFIED_BUILD} (2026.1.1)\n`) }, { claudeDir: f.dir });
  const scan = await scanHarnesses(deps);
  expect(scan).toEqual([
    { harness: 'claude', label: 'Claude Code', detected: true, version: '2.1.289', sessionsAvailable: true },
    { harness: 'codex', label: 'Codex', detected: true, version: '0.170.0', sessionsAvailable: false, reason: 'unsupported-version' },
    { harness: 'hermes', label: 'Hermes', detected: true, version: HERMES_VERIFIED_BUILD, sessionsAvailable: true },
    { harness: 'exec', label: 'Custom command', detected: true, sessionsAvailable: false, reason: 'custom-command' },
  ]);
  // Only --version, with a fixed argv.
  expect(asked.sort()).toEqual(['/bin/claude --version', '/bin/codex --version']);
  expect((await listSessions('claude', deps)).sessions.map(s => s.id)).toEqual([f.first, f.second, f.third, f.noTitle]);
  expect(await listSessions('codex', deps)).toEqual({ harness: 'codex', sessionsAvailable: false, reason: 'unsupported-version', sessions: [], truncated: false });
  expect(await listSessions('hermes', deps)).toEqual({ harness: 'hermes', sessionsAvailable: true, sessions: [], truncated: false });
  expect(await listSessions('exec', deps)).toMatchObject({ sessionsAvailable: false, reason: 'custom-command' });

  // Missing, failing and unparsable programs.
  const other = machine({ claude: 'missing', codex: { ok: false, reason: 'timeout' }, hermes: ok('Hermes Agent v0.21.4 (2026.1.1)\n') });
  expect(await scanHarnesses(other.deps)).toEqual([
    { harness: 'claude', label: 'Claude Code', detected: false, sessionsAvailable: false, reason: 'not-found' },
    { harness: 'codex', label: 'Codex', detected: true, sessionsAvailable: false, reason: 'version-command-failed' },
    { harness: 'hermes', label: 'Hermes', detected: true, version: '0.21.4', sessionsAvailable: false, reason: 'unsupported-version' },
    { harness: 'exec', label: 'Custom command', detected: true, sessionsAvailable: false, reason: 'custom-command' },
  ]);
  const garbled = machine({ claude: ok('C:\\private\\path\\claude.exe crashed'), codex: { ok: false, reason: 'not-found' } });
  const [claude, codex] = await scanHarnesses(garbled.deps);
  expect(claude).toEqual({ harness: 'claude', label: 'Claude Code', detected: true, sessionsAvailable: false, reason: 'unsupported-version' });
  expect(codex).toMatchObject({ detected: false, reason: 'not-found' });
});

test('the daemon\'s scanner scans once per period, and asks again after a failure', async () => {
  let now = 0, scans = 0;
  const base = machine({ claude: { ok: true, stdout: '2.1.289 (Claude Code)\n' } });
  const deps = () => ({ ...base.deps, run: async (p: { file: string; prefix: string[] }, a: readonly string[]) => { scans++; return base.deps.run(p, a); } });
  const scanner = harnessScanner(deps, 30_000, () => now);
  await Promise.all([scanner.scan(), scanner.scan(), scanner.sessions('claude')]);
  expect(scans).toBe(1);
  now += 30_001;
  await scanner.scan();
  expect(scans).toBe(2);
});

test('a version command is bounded: its time, its output, and no shell', async () => {
  const bun = { file: process.execPath, prefix: [] };
  expect(await runBounded(bun, ['-e', 'console.log("2.1.289 (Claude Code)")'])).toEqual({ ok: true, stdout: '2.1.289 (Claude Code)\n' });
  expect(await runBounded(bun, ['-e', 'console.error("x".repeat(10000))'], 10_000, 1_000)).toEqual({ ok: false, reason: 'output-limit' });
  expect(await runBounded(bun, ['-e', 'setTimeout(() => {}, 10000)'], 300)).toEqual({ ok: false, reason: 'timeout' });
  expect(await runBounded(bun, ['-e', 'process.exit(3)'])).toEqual({ ok: false, reason: 'failed' });
  expect(await runBounded({ file: join(folder(), 'no-such-program'), prefix: [] }, ['--version'])).toEqual({ ok: false, reason: 'not-found' });
  // Arguments are passed as they are, never through a shell.
  expect(await runBounded(bun, ['-e', 'console.log(process.argv.at(-1))', '$(whoami) & echo hi'])).toEqual({ ok: true, stdout: '$(whoami) & echo hi\n' });
}, 20_000);

test('SESSION_LIMIT caps every listing', () => {
  const dir = folder(), project = join(dir, 'projects', '-many');
  mkdirSync(project, { recursive: true });
  for (let i = 0; i < SESSION_LIMIT + 3; i++) writeFileSync(join(project, `${uuid()}.jsonl`), jsonl([{ type: 'user', cwd: '/many', message: { content: `Prompt ${i}` } }]));
  expect(listClaudeSessions(dir)).toMatchObject({ truncated: true });
  expect(listClaudeSessions(dir).sessions).toHaveLength(SESSION_LIMIT);
});

test('a title is found in one pass: no input, however crafted, takes more than a moment', () => {
  const crafted = ['<a-'.repeat(400_000), '<x-y>'.repeat(200_000), '<'.repeat(1_000_000), `<b-b ${'a'.repeat(1_000_000)}`, '<a-b>'.repeat(50_000) + '</a-b>'.repeat(50_000),
    `${'<i>'.repeat(300_000)}title`, `<c-c>${'<'.repeat(100_000)}</c-c>Real title`];
  for (const prompt of crafted) {
    const at = performance.now();
    promptTitle(prompt);
    expect(performance.now() - at).toBeLessThan(250);
  }
  expect(promptTitle(`<c-c>${'<'.repeat(1_000)}</c-c>Real title`)).toBe('Real title');
  // A wrapper left open drops what follows it, rather than show its contents as the title.
  expect(promptTitle('<system-reminder>internal text, no end')).toBeUndefined();
});

test('a new session\'s id is the one this run made: Codex by its rollout, Claude Code by its transcript, Hermes by the time in its id', () => {
  const codex = folder(), day = join(codex, 'sessions', '2026', '10', '05'), wake = join(folder(), 'wake');
  mkdirSync(day, { recursive: true }); mkdirSync(wake);
  const made = crypto.randomUUID(), other = crypto.randomUUID(), sub = crypto.randomUUID(), forged = crypto.randomUUID();
  const rollout = (id: string, payload: object, file = id) => writeFileSync(join(day, `rollout-2026-10-05T10-00-00-${file}.jsonl`), jsonl([{ type: 'session_meta', payload: { id, ...payload } }]));
  const since = Date.now() - 1_000;
  rollout(made, { cwd: wake });
  rollout(other, { cwd: join(wake, '..', 'elsewhere') });
  rollout(sub, { cwd: wake, source: { subagent: {} } });
  rollout(made, { cwd: wake }, forged);
  expect(freshCodexThread(wake, since, codex)).toBe(made);
  // Nothing made since the run started: no id, whatever the run printed.
  expect(freshCodexThread(wake, Date.now() + 60_000, codex)).toBeUndefined();
  expect(freshCodexThread(join(wake, 'nope'), since, codex)).toBeUndefined();

  const claude = folder(), session = crypto.randomUUID();
  mkdirSync(join(claude, 'projects', wake.replace(/[^A-Za-z0-9]/g, '-')), { recursive: true });
  writeFileSync(join(claude, 'projects', wake.replace(/[^A-Za-z0-9]/g, '-'), `${session}.jsonl`), '{}\n');
  expect(freshClaudeSession(session, wake, since, claude)).toBe(true);
  expect(freshClaudeSession(session, wake, Date.now() + 60_000, claude)).toBe(false);
  expect(freshClaudeSession(crypto.randomUUID(), wake, since, claude)).toBe(false);
  expect(freshClaudeSession(session, join(wake, '..'), since, claude)).toBe(false);

  const stamp = (at: number) => { const d = new Date(at), p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_abcdef`; };
  const start = Date.now();
  expect(hermesIdFresh(stamp(start + 3_000), start, start + 10_000)).toBe(true);
  // An older session resumed under the same name reports its own, older id.
  expect(hermesIdFresh(stamp(start - 3_600_000), start, start + 10_000)).toBe(false);
  expect(hermesIdFresh(stamp(start + 3_600_000), start, start + 10_000)).toBe(false);
  expect(hermesIdFresh('not-an-id', start, start + 10_000)).toBe(false);
});
