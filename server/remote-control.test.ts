import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CONTROL_LOG, CONTROLLERS_FILE, MAX_PROMPT_BYTES, MAX_REPLY_BYTES, POLICY_FILE, REMOTE_PARTICIPANT, addController, cancelTurn, capReply, readControllers, readPolicy,
  changePolicy, policyAllowing, policyTrusting, readTurnReply, remoteOverview, removeController, runRemoteTurn, runTurnProgram, runningTurns, savePolicy, sweepPromptFiles, type AuditEntry, type RemoteDeps,
  type TurnResult,
} from './remote-control';
import { harnessScanner, type ScanDeps } from './detectors/harnesses';
import { listingFixture, versionFixture } from './detectors/fixtures/hermes-fixtures';
import { sessionKey, sessionLedger } from './agent-watch';
import { LOG_LIMIT } from './agent-daemon';
import { saveHarnessPreference } from './harness-apps';
import { localControlToken, readLocalApi, startLocalApi } from './local-api';
import { exportRawPublicKey, generateEncKeyPair, signEncBinding } from '../src/browser/relay-crypto';
import { base64, deviceId, encode } from '../src/browser/protocol';
import { testDirectory } from './test-directory';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const folder = () => { const dir = testDirectory('remote-control'); cleanups.push(dir.cleanup); return dir.path; };
const uuid = () => crypto.randomUUID();
const jsonl = (lines: unknown[]) => lines.map(line => JSON.stringify(line)).join('\n') + '\n';
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check: () => boolean, ms = 10_000) => { for (const end = Date.now() + ms; !check() && Date.now() < end;) await Bun.sleep(25); return check(); };
const sameFolder = (a: string, b: string) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
/** Flags a room wake adds to Claude Code, and the ones that bypass its permissions: a remote turn adds none of them. */
const CLAUDE_CONFINEMENT = ['--permission-mode', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--allowedTools', '--allowed-tools', '--disallowedTools',
  '--disallowed-tools', '--setting-sources', '--strict-mcp-config', '--mcp-config', '--add-dir', '--settings', '--continue'];

/** A browser's keys as the web app makes them: ECDSA for signing, ECDH for envelopes, bound to every room ('*'). */
async function browserKeys(room = '*') {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const sign = base64(await crypto.subtle.exportKey('raw', keys.publicKey));
  const signWith = async (value: unknown) => base64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, encode(value)));
  const enc = await exportRawPublicKey((await generateEncKeyPair()).publicKey), device = await deviceId(sign);
  return { device, sign, enc, encVersion: 1, encSig: await signEncBinding(signWith, { room, deviceId: device, enc, encVersion: 1 }), name: 'Laptop browser', origin: 'https://rooms.example' };
}

/**
 * A machine with one session of each harness, as each harness stores it (synthetic text only), and fake harness
 * programs: Bun scripts run by this Bun, so they behave the same everywhere. `fake(name, body)` replaces one.
 */
async function machine() {
  const root = folder(), home = join(root, 'person'), project = join(root, 'project'), bin = join(root, 'bin');
  const claudeDir = join(root, 'claude'), codexHome = join(root, 'codex'), agyCliDir = join(root, 'agy');
  for (const dir of [home, project, bin, agyCliDir]) mkdirSync(dir, { recursive: true });
  const ids = { claude: uuid(), codex: uuid(), agy: uuid(), hermes: '20000101_000000_aabbcc' };
  const claudeProject = join(claudeDir, 'projects', project.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(claudeProject, { recursive: true });
  writeFileSync(join(claudeProject, `${ids.claude}.jsonl`), jsonl([{ type: 'user', cwd: project, message: { role: 'user', content: 'Synthetic first prompt' } }]));
  const day = join(codexHome, 'sessions', '2026', '10', '04');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-2026-10-04T10-00-00-${ids.codex}.jsonl`), jsonl([{ type: 'session_meta', payload: { id: ids.codex, cwd: project, originator: 'codex_exec', cli_version: '0.160.0' } }]));
  const db = new Database(join(agyCliDir, 'conversation_summaries.db'));
  db.exec(`CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, last_modified_time TEXT,
    nesting_depth INTEGER DEFAULT 0, parent_conversation_id TEXT DEFAULT '', killed INTEGER DEFAULT 0)`);
  const insert = db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run(ids.agy, 'Synthetic chat', JSON.stringify([pathToFileURL(project).href]), new Date().toISOString().replace('T', ' ').replace('Z', '+00:00'), 0, '', 0);
  insert.finalize(); db.close();

  const scripts: Record<string, string> = {};
  const fake = (name: string, body: string) => {
    const file = join(bin, `${name}-${Object.keys(scripts).length}-${uuid().slice(0, 8)}.mjs`);
    writeFileSync(file, `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';\nconst argv = process.argv.slice(2);\n`
      + `appendFileSync(${JSON.stringify(join(root, 'runs.log'))}, ${JSON.stringify(name)} + '\\n');\n${body}\n`);
    scripts[name] = file;
  };
  // By default each echoes what it was given, in its own output format.
  fake('claude', `const stdin = await Bun.stdin.text();
await Bun.write(Bun.stdout, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: argv[argv.indexOf('--resume') + 1], permission_denials: [],
  result: JSON.stringify({ argv, cwd: process.cwd(), stdin }) }) + '\\n');`);
  fake('codex', `const stdin = await Bun.stdin.text();
await Bun.write(Bun.stderr, 'session id: ' + argv[2] + '\\n');
await Bun.write(Bun.stdout, JSON.stringify({ argv, cwd: process.cwd(), stdin }) + '\\n');`);
  fake('hermes', `const file = argv[argv.indexOf('--query-file') + 1];
await Bun.write(Bun.stdout, JSON.stringify({ argv, query: readFileSync(file, 'utf8') }) + '\\n');`);
  fake('agy', `const events = [{ event: 'init' }, { event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_name: 'view_file' } },
  { event: 'result', result: { status: 'SUCCESS', conversation_id: argv[argv.indexOf('--conversation') + 1], response: JSON.stringify({ argv, cwd: process.cwd() }) } }];
await Bun.write(Bun.stdout, events.map(e => JSON.stringify(e)).join('\\n') + '\\n');`);

  const versions: Record<string, string> = { claude: '2.1.300 (Claude Code)', codex: 'codex-cli 0.160.0', agy: '1.5.17' };
  const scan: ScanDeps = {
    resolve: name => { if (!scripts[name]) throw new Error(`Couldn't find ${name} on PATH.`); return { file: process.execPath, prefix: [scripts[name]] }; },
    run: async program => {
      const name = Object.keys(scripts).find(n => scripts[n] === program.prefix[0]);
      return name && versions[name] ? { ok: true, stdout: `${versions[name]}\n` } : { ok: false, reason: 'not-found' };
    },
    hermes: async args => ({ ok: true, stdout: args[0] === '--version' ? versionFixture : listingFixture }),
    claudeDir, codexHome, agyCliDir,
  };
  const deps: RemoteDeps = { home, scanner: harnessScanner(() => scan, 0), machine: scan, locks: join(root, 'locks'), pollMs: 20, codexDelivery: () => 'headless',
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome, AGY_CLI_HOME: agyCliDir, HERMES_HOME: join(root, 'hermes') } };
  const browser = await browserKeys();
  await addController(home, browser);
  const enable = (harnesses: string[] = ['claude', 'codex', 'hermes', 'agy'], trusted: string[] = []) => savePolicy(home, { enabled: true, harnesses, trusted });
  const prompt = (overrides: Record<string, unknown> = {}) => ({ requestId: uuid(), controller: browser.device, harness: 'claude', sessionId: ids.claude, text: 'Synthetic prompt', ...overrides });
  const runs = () => { try { return readFileSync(join(root, 'runs.log'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const audit = (): AuditEntry[] => { try { return readFileSync(join(home, CONTROL_LOG), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  return { root, home, project, ids, deps, browser, fake, enable, prompt, runs, audit };
}
type Machine = Awaited<ReturnType<typeof machine>>;
const failed = (result: TurnResult) => result.state === 'failed' ? result : undefined;
/** A fake harness that records its pid and its child's, then sleeps: for timeouts, cancels and the kill switch. */
const sleeper = (m: Machine, name = 'claude') => {
  const pids = join(m.root, `${name}-pids-${uuid().slice(0, 8)}.json`);
  m.fake(name, `const child = Bun.spawn([process.execPath, '-e', 'await Bun.sleep(60000)'], { stdout: 'ignore', stderr: 'ignore' });
writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid]));
await Bun.sleep(60_000);`);
  return () => { try { return JSON.parse(readFileSync(pids, 'utf8')) as number[]; } catch { return []; } };
};

test('controllers: kept only when the device id is the hash of the signing key and the encryption key is bound to it for every room', async () => {
  const home = join(folder(), 'person'), good = await browserKeys(), other = await browserKeys();
  const added = await addController(home, good, 1_000);
  expect(added).toMatchObject({ device: good.device, name: 'Laptop browser', origin: 'https://rooms.example', addedAt: 1_000 });
  expect(readControllers(home)).toEqual([added]);
  if (process.platform !== 'win32') expect(statSync(join(home, CONTROLLERS_FILE)).mode & 0o777).toBe(0o600);
  // A device id that isn't the hash of its key, an encryption key bound to one room only or by another key, a key
  // swapped after signing: each is refused, and nothing is written.
  await expect(addController(home, { ...other, device: good.device })).rejects.toThrow('device id is not the hash');
  await expect(addController(home, await browserKeys('a-room'))).rejects.toThrow('not bound to its signing key for every room');
  await expect(addController(home, { ...other, encSig: good.encSig })).rejects.toThrow('not bound');
  await expect(addController(home, { ...other, enc: good.enc })).rejects.toThrow('not bound');
  await expect(addController(home, { ...other, encVersion: 2 })).rejects.toThrow('not bound');
  await expect(addController(home, { ...other, sign: 'A'.repeat(88) })).rejects.toThrow('signing key is not a P-256');
  await expect(addController(home, { ...other, enc: 'B'.repeat(88) })).rejects.toThrow('encryption key is not a P-256');
  await expect(addController(home, { ...other, origin: 'http://rooms.example' })).rejects.toThrow('origin');
  await expect(addController(home, { ...other, origin: 'https://rooms.example/path' })).rejects.toThrow('origin');
  await expect(addController(home, { ...other, name: ' \u202e ' })).rejects.toThrow('name');
  expect(readControllers(home).map(c => c.device)).toEqual([good.device]);
  // Enrolling the same browser again replaces its entry; a damaged file controls nothing.
  await addController(home, { ...good, name: 'Renamed' }, 2_000);
  expect(readControllers(home)).toMatchObject([{ device: good.device, name: 'Renamed', addedAt: 2_000 }]);
  expect(removeController(home, other.device)).toBe(false);
  expect(removeController(home, good.device)).toBe(true);
  expect(readControllers(home)).toEqual([]);
  writeFileSync(join(home, CONTROLLERS_FILE), '{ not json');
  expect(readControllers(home)).toEqual([]);
});

test('policy: off by default, only the three fields, harnesses with sessions, trusted devices that are controllers', async () => {
  const m = await machine();
  expect(readPolicy(m.home)).toEqual({ enabled: false, harnesses: [], trusted: [] });
  for (const bad of [{ enabled: 'yes', harnesses: [], trusted: [] }, { enabled: true, harnesses: ['exec'], trusted: [] }, { enabled: true, harnesses: [], trusted: [], folders: [] },
    { enabled: true, harnesses: [], trusted: ['f'.repeat(64)] }, { enabled: true, harnesses: [], trusted: ['not-a-device'] }, []])
    expect(() => savePolicy(m.home, bad)).toThrow();
  expect(existsSync(join(m.home, POLICY_FILE))).toBe(false);
  expect(m.enable(['agy', 'claude', 'claude'], [m.browser.device])).toEqual({ enabled: true, harnesses: ['claude', 'agy'], trusted: [m.browser.device] });
  expect(readPolicy(m.home)).toEqual({ enabled: true, harnesses: ['claude', 'agy'], trusted: [m.browser.device] });
  if (process.platform !== 'win32') expect(statSync(join(m.home, POLICY_FILE)).mode & 0o777).toBe(0o600);
  // A revoked controller is no longer trusted; a policy that can't be read is off.
  removeController(m.home, m.browser.device);
  expect(readPolicy(m.home).trusted).toEqual([]);
  writeFileSync(join(m.home, POLICY_FILE), '{"enabled": true, "harnesses": ["claude"]}');
  expect(readPolicy(m.home).enabled).toBe(false);
});

test('every refusal answers before anything runs, and is audited', async () => {
  const m = await machine();
  const code = async (input: Record<string, unknown>, deps: RemoteDeps = m.deps) => failed(await runRemoteTurn(input, deps))?.code;
  expect(await code(m.prompt())).toBe('disabled');
  m.enable(['claude', 'codex']);
  expect(await code(m.prompt({ requestId: 'not-a-uuid' }))).toBe('invalid');
  expect(await code(m.prompt({ sessionId: '--dangerously-skip-permissions' }))).toBe('invalid');
  expect(await code(m.prompt({ text: 42 }))).toBe('invalid');
  expect(await code(m.prompt({ harness: 'dsh' }))).toBe('invalid');
  expect(await code(m.prompt({ controller: 'f'.repeat(64) }))).toBe('unknown-controller');
  expect(await code(m.prompt({ harness: 'hermes', sessionId: m.ids.hermes }))).toBe('not-allowed');
  expect(await code(m.prompt({ harness: 'exec' }))).toBe('not-allowed');
  expect(await code(m.prompt({ text: ' \n\t ' }))).toBe('empty');
  expect(await code(m.prompt({ text: 'é'.repeat(MAX_PROMPT_BYTES / 2 + 1) }))).toBe('too-large');
  expect(await code(m.prompt({ sessionId: uuid() }))).toBe('unknown-session');
  // Codex delivering to its desktop app, as the person's agent app settings say, is not supported yet.
  expect(await code(m.prompt({ harness: 'codex', sessionId: m.ids.codex }), { ...m.deps, codexDelivery: () => 'desktop' })).toBe('unsupported');
  saveHarnessPreference(m.home, 'codex', { enabled: true, codexDelivery: 'desktop' });
  const { codexDelivery: _, ...fromSettings } = m.deps;
  expect(await code(m.prompt({ harness: 'codex', sessionId: m.ids.codex }), fromSettings)).toBe('unsupported');
  // The person at the machine is asked first, unless the controller is trusted; a no is not-allowed, a yes holds.
  let asked = 0;
  const ask = (answer: boolean): RemoteDeps => ({ ...m.deps, askFirstUse: async () => { asked++; return answer; } });
  expect(await code(m.prompt(), ask(false))).toBe('not-allowed');
  expect(m.runs()).toEqual([]);
  expect((await runRemoteTurn(m.prompt(), ask(true))).state).toBe('done');
  expect((await runRemoteTurn(m.prompt(), ask(false))).state).toBe('done');
  expect(asked).toBe(2);
  m.enable(['claude'], [m.browser.device]);
  expect((await runRemoteTurn(m.prompt(), { ...m.deps, askFirstUse: async () => { throw new Error('a trusted controller is not asked'); } })).state).toBe('done');
  expect(m.audit().map(a => a.outcome)).toEqual(['disabled', 'invalid', 'invalid', 'invalid', 'invalid', 'unknown-controller', 'not-allowed', 'not-allowed', 'empty', 'too-large',
    'unknown-session', 'unsupported', 'unsupported', 'not-allowed', 'running', 'done', 'running', 'done', 'running', 'done']);
});

test('Claude Code resumes in the session\'s own folder with the prompt on stdin, and nothing added: no confinement, no bypass', async () => {
  const m = await machine();
  m.enable(['claude']);
  const result = await runRemoteTurn(m.prompt({ text: 'Say hello\n--allowedTools Bash' }), m.deps);
  expect(result).toMatchObject({ state: 'done', sessionId: m.ids.claude, truncated: false });
  const seen = JSON.parse((result as { reply: string }).reply) as { argv: string[]; cwd: string; stdin: string };
  expect(seen.argv).toEqual(['-p', '--resume', m.ids.claude, '--output-format', 'json']);
  for (const flag of CLAUDE_CONFINEMENT) expect(seen.argv).not.toContain(flag);
  expect(seen.stdin).toBe('Say hello\n--allowedTools Bash');
  expect(sameFolder(seen.cwd, m.project)).toBe(true);
});

test('each harness resumes its own way, and its whole reply comes back, cut at 256 KiB with truncated', async () => {
  const m = await machine();
  m.enable();
  const codex = await runRemoteTurn(m.prompt({ harness: 'codex', sessionId: m.ids.codex, text: 'Codex prompt' }), m.deps);
  const codexSeen = JSON.parse((codex as { reply: string }).reply);
  expect(codex).toMatchObject({ state: 'done', sessionId: m.ids.codex, truncated: false });
  expect(codexSeen).toMatchObject({ argv: ['exec', 'resume', m.ids.codex, '-'], stdin: 'Codex prompt' });
  expect(sameFolder(codexSeen.cwd, m.project)).toBe(true);
  const hermes = await runRemoteTurn(m.prompt({ harness: 'hermes', sessionId: m.ids.hermes, text: 'Hermes prompt' }), m.deps);
  const hermesSeen = JSON.parse((hermes as { reply: string }).reply);
  // Its event stream, and a run budget that ends the turn before the 10 minutes do: nothing that widens the session.
  expect(hermesSeen.argv).toEqual(['chat', '--resume', m.ids.hermes, '--oneshot', '--query-file', expect.any(String), '--format', 'stream-json', '--run-budget', '570']);
  expect(hermesSeen.query).toBe('Hermes prompt');
  // The prompt file is gone once the turn ends.
  expect(readdirSync(join(m.home, 'remote-turns'))).toEqual([]);
  const agy = await runRemoteTurn(m.prompt({ harness: 'agy', sessionId: m.ids.agy, text: 'Antigravity prompt' }), m.deps);
  const agySeen = JSON.parse((agy as { reply: string }).reply);
  expect(agy).toMatchObject({ state: 'done', sessionId: m.ids.agy });
  expect(agySeen.argv).toEqual(['-p', 'Antigravity prompt', '--conversation', m.ids.agy, '--disable-slash-commands', '--output-format', 'stream-json', '--print-timeout', '10m']);
  expect(sameFolder(agySeen.cwd, m.project)).toBe(true);
  // A prompt that starts with a dash can't pass for one of Antigravity's options.
  const dashed = JSON.parse((await runRemoteTurn(m.prompt({ harness: 'agy', sessionId: m.ids.agy, text: '--dangerously-skip-permissions' }), m.deps) as { reply: string }).reply);
  expect(dashed.argv.slice(0, 2)).toEqual(['-p', ' --dangerously-skip-permissions']);
  expect(dashed.argv.filter((arg: string) => arg.startsWith('--dangerously'))).toEqual([]);

  // A long reply is returned whole, not as a short summary; past 256 KiB it is cut at a character, and says so.
  const long = 'Lorem ipsum dolor sit amet. '.repeat(100);
  m.fake('claude', `await Bun.write(Bun.stdout, JSON.stringify({ is_error: false, session_id: 'x', result: ${JSON.stringify(long)}, permission_denials: [{ tool_name: 'Write' }, { tool_name: 'Write' }] }));`);
  expect(await runRemoteTurn(m.prompt(), m.deps)).toMatchObject({ state: 'done', reply: long, truncated: false, denied: ['Write'] });
  m.fake('codex', `await Bun.write(Bun.stdout, 'é'.repeat(${MAX_REPLY_BYTES}) + 'tail');`);
  const cut = await runRemoteTurn(m.prompt({ harness: 'codex', sessionId: m.ids.codex }), m.deps) as { state: string; reply: string; truncated: boolean };
  expect(cut).toMatchObject({ state: 'done', truncated: true });
  expect(Buffer.byteLength(cut.reply)).toBe(MAX_REPLY_BYTES);
  expect(cut.reply).toBe('é'.repeat(MAX_REPLY_BYTES / 2));
  expect(m.audit().at(-1)).toMatchObject({ outcome: 'done', replyBytes: MAX_REPLY_BYTES, truncated: true });
});

test('the reply parser keeps the full text for every harness, and reads busy sessions and failures as the watchers do', () => {
  const long = 'x'.repeat(600) + ' end';
  expect(readTurnReply('claude', JSON.stringify({ is_error: false, result: long, session_id: 's' }), '', 0)).toEqual({ ok: true, reply: long, truncated: false, sessionId: 's' });
  expect(readTurnReply('claude', JSON.stringify({ is_error: true, result: 'Credit balance is too low' }), '', 1)).toEqual({ ok: false, code: 'failed', message: 'Credit balance is too low' });
  expect(readTurnReply('claude', '', 'Error: no session\n', 1)).toMatchObject({ ok: false, code: 'failed', message: 'Error: no session' });
  expect(readTurnReply('claude', JSON.stringify({ result: 'y'.repeat(MAX_REPLY_BYTES + 10) }), '', 0)).toMatchObject({ ok: true, truncated: true });
  expect(readTurnReply('codex', `${long}\nsecond line\n`, 'session id: 00000000-0000-4000-8000-000000000001\n', 0))
    .toEqual({ ok: true, reply: `${long}\nsecond line`, truncated: false, sessionId: '00000000-0000-4000-8000-000000000001' });
  expect(readTurnReply('codex', '', 'Error: thread already has an active writer\n', 1)).toMatchObject({ ok: false, code: 'busy' });
  expect(readTurnReply('codex', '', 'ERROR: model refused\n', 1)).toEqual({ ok: false, code: 'failed', message: 'model refused' });
  expect(readTurnReply('hermes', `${long}\n`, '', 0)).toEqual({ ok: true, reply: long, truncated: false });
  expect(readTurnReply('hermes', jsonl([{ type: 'system' }, { type: 'result', session_id: 'h1', exit_code: 0, text: long }]), '', 0)).toEqual({ ok: true, reply: long, truncated: false, sessionId: 'h1' });
  expect(readTurnReply('hermes', '', 'hermes-refusal-reason: SESSION_NOT_OWNED\n', 1)).toMatchObject({ ok: false, code: 'busy' });
  expect(readTurnReply('hermes', jsonl([{ type: 'result', exit_code: 1, error: 'stopped' }]), 'Dangerous command requires approval\n', 1))
    .toEqual({ ok: false, code: 'failed', message: 'Hermes stopped for an approval, which remote prompts cannot give yet.' });
  // A reply that only mentions an approval is still a reply.
  expect(readTurnReply('hermes', jsonl([{ type: 'result', exit_code: 0, text: 'No approval was needed.' }]), 'approval mode: ask\n', 0)).toMatchObject({ ok: true, reply: 'No approval was needed.' });
  // A plain reply that holds a line of JSON among its text is still read as text.
  expect(readTurnReply('hermes', `Here is the event:\n{"type":"result","text":"no"}\n`, '', 0)).toMatchObject({ reply: 'Here is the event:\n{"type":"result","text":"no"}' });
  expect(readTurnReply('agy', jsonl([{ event: 'init' }, { event: 'result', result: { status: 'SUCCESS', conversation_id: 'a1', response: long } }]), '', 0))
    .toEqual({ ok: true, reply: long, truncated: false, sessionId: 'a1' });
  expect(readTurnReply('agy', jsonl([{ event: 'result', result: { status: 'WAITING' } }]), '', 0)).toMatchObject({ ok: false, code: 'failed', message: expect.stringMatching(/approval/) });
  expect(readTurnReply('agy', `${long}\n`, '', 0)).toEqual({ ok: true, reply: long, truncated: false });
  // Cut at a character, never inside one.
  expect(capReply('aé', 2)).toEqual({ reply: 'a', truncated: true });
  expect(capReply('😀😀', 5)).toEqual({ reply: '😀', truncated: true });
  expect(capReply('abc', 3)).toEqual({ reply: 'abc', truncated: false });
});

test('one turn per session: a second prompt is busy at once, another session is not, and a request id runs once', async () => {
  const m = await machine();
  m.enable();
  const pids = sleeper(m);
  let turnId = '';
  const first = runRemoteTurn(m.prompt(), { ...m.deps, onRunning: id => { turnId = id; } });
  expect(await until(() => !!turnId && pids().length === 2)).toBe(true);
  expect(runningTurns(m.home)).toMatchObject([{ turnId, harness: 'claude', sessionId: m.ids.claude, state: 'running' }]);
  expect(failed(await runRemoteTurn(m.prompt(), m.deps))).toMatchObject({ code: 'busy', message: expect.stringMatching(/Another remote prompt/) });
  const running = runningTurns(m.home)[0];
  expect(failed(await runRemoteTurn(m.prompt({ requestId: running.requestId, harness: 'codex', sessionId: m.ids.codex }), m.deps))?.code).toBe('duplicate');
  expect(await runRemoteTurn(m.prompt({ harness: 'codex', sessionId: m.ids.codex }), m.deps)).toMatchObject({ state: 'done' });
  expect(cancelTurn(turnId)).toBe(true);
  expect(failed(await first)?.code).toBe('cancelled');
  expect(runningTurns(m.home)).toEqual([]);
});

test('remote turns and room wakes share the session ledger: each waits for the other', async () => {
  const m = await machine();
  m.enable();
  const key = sessionKey({ harness: 'claude', session: m.ids.claude, cwd: '' }, m.deps.env);
  const room = sessionLedger(m.deps.locks, key, uuid(), { alive: () => true, holdMs: 60_000, ownedMs: 5_000, freshMs: 30_000 });
  const wake = room.claim();
  if (!('release' in wake)) throw new Error('the room should hold the session');
  // A wake runs: the prompt waits for it, and is told busy when it outlasts the wait.
  expect(failed(await runRemoteTurn(m.prompt(), { ...m.deps, waitMs: 200 }))).toMatchObject({ code: 'busy', message: expect.stringMatching(/room wake/) });
  const waiting = runRemoteTurn(m.prompt(), { ...m.deps, waitMs: 10_000 });
  expect(await until(() => runningTurns(m.home)[0]?.state === 'waiting')).toBe(true);
  wake.release();
  expect(await waiting).toMatchObject({ state: 'done' });
  // And the reverse: while a remote turn runs, a room's wake is told to wait for it.
  const pids = sleeper(m);
  const remote = runRemoteTurn(m.prompt(), m.deps);
  expect(await until(() => pids().length === 2)).toBe(true);
  expect(room.claim()).toMatchObject({ wait: 'running', room: REMOTE_PARTICIPANT });
  cancelTurn(runningTurns(m.home)[0].turnId);
  expect(failed(await remote)?.code).toBe('cancelled');
  expect('release' in room.claim()).toBe(true);
});

test('after every wait the policy and the controller are read again: a change made meanwhile refuses the turn, and nothing runs', async () => {
  const m = await machine();
  m.enable();
  const key = sessionKey({ harness: 'claude', session: m.ids.claude, cwd: '' }, m.deps.env);
  const room = sessionLedger(m.deps.locks, key, uuid(), { alive: () => true, holdMs: 60_000, ownedMs: 5_000, freshMs: 30_000 });
  // Changed on disk, not through savePolicy (which cancels at once): only the second read can catch it.
  const behind = async (change: () => void) => {
    const wake = room.claim();
    if (!('release' in wake)) throw new Error('the room should hold the session');
    const waiting = runRemoteTurn(m.prompt(), { ...m.deps, waitMs: 10_000 });
    expect(await until(() => runningTurns(m.home)[0]?.state === 'waiting')).toBe(true);
    change();
    wake.release();
    return failed(await waiting);
  };
  const policy = (value: unknown) => writeFileSync(join(m.home, POLICY_FILE), JSON.stringify(value));
  expect(await behind(() => policy({ enabled: false, harnesses: ['claude'], trusted: [] }))).toMatchObject({ code: 'disabled' });
  m.enable();
  expect(await behind(() => policy({ enabled: true, harnesses: ['codex'], trusted: [] }))).toMatchObject({ code: 'not-allowed' });
  m.enable();
  const controllers = readFileSync(join(m.home, CONTROLLERS_FILE), 'utf8');
  expect(await behind(() => writeFileSync(join(m.home, CONTROLLERS_FILE), JSON.stringify({ version: 1, controllers: [] })))).toMatchObject({ code: 'unknown-controller' });
  writeFileSync(join(m.home, CONTROLLERS_FILE), controllers);
  expect(m.runs()).toEqual([]);

  // The person's answer is a wait too: a controller revoked while they were asked is not remembered as allowed.
  let asked = 0;
  const askFirstUse = async () => { asked++; if (asked === 1) writeFileSync(join(m.home, CONTROLLERS_FILE), JSON.stringify({ version: 1, controllers: [] })); return true; };
  expect(failed(await runRemoteTurn(m.prompt(), { ...m.deps, askFirstUse }))).toMatchObject({ code: 'unknown-controller' });
  writeFileSync(join(m.home, CONTROLLERS_FILE), controllers);
  expect(await runRemoteTurn(m.prompt(), { ...m.deps, askFirstUse })).toMatchObject({ state: 'done' });
  expect(asked).toBe(2);
});

test('Codex and Antigravity run in the folder the session recorded or not at all, and only in a local one', async () => {
  const m = await machine();
  m.enable();
  const day = join(m.root, 'codex', 'sessions', '2026', '10', '05');
  mkdirSync(day, { recursive: true });
  const thread = (cwd?: string) => {
    const id = uuid();
    writeFileSync(join(day, `rollout-2026-10-05T10-00-00-${id}.jsonl`), jsonl([{ type: 'session_meta', payload: { id, ...(cwd === undefined ? {} : { cwd }), originator: 'codex_exec', cli_version: '0.160.0' } }]));
    return id;
  };
  const codex = async (cwd?: string) => failed(await runRemoteTurn(m.prompt({ harness: 'codex', sessionId: thread(cwd) }), m.deps));
  // Each is listed (Codex lists it), so only the folder refuses it. The home folder is never a stand-in.
  expect(await codex()).toMatchObject({ code: 'unknown-session', message: expect.stringMatching(/doesn't record where/) });
  expect(await codex(join(m.root, 'gone'))).toMatchObject({ code: 'failed', message: expect.stringMatching(/no longer on this machine/) });
  expect(await codex('\\\\fileserver\\share\\project')).toMatchObject({ code: 'failed', message: expect.stringMatching(/not a local folder/) });
  expect(await codex('//fileserver/share/project')).toMatchObject({ code: 'failed', message: expect.stringMatching(/not a local folder/) });
  expect(await codex('relative/project')).toMatchObject({ code: 'failed', message: expect.stringMatching(/not a local folder/) });
  const db = new Database(join(m.root, 'agy', 'conversation_summaries.db'));
  const agyId = uuid();
  const insert = db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run(agyId, 'No workspace', '[]', new Date().toISOString().replace('T', ' ').replace('Z', '+00:00'), 0, '', 0);
  // Finalized before closing, or Windows keeps the file open and the folder can't be removed.
  insert.finalize(); db.close();
  expect(failed(await runRemoteTurn(m.prompt({ harness: 'agy', sessionId: agyId }), m.deps))).toMatchObject({ code: 'unknown-session', message: expect.stringMatching(/doesn't record where/) });
  expect(m.runs()).toEqual([]);
});

test('a turn runs without the credentials its harness doesn\'t sign in with, and without the Hermes variables that skip its checks', async () => {
  const m = await machine();
  m.enable();
  const env = { ...m.deps.env, GITHUB_TOKEN: 'synthetic', NPM_TOKEN: 'synthetic', DATABASE_URL: 'synthetic', ANTHROPIC_API_KEY: 'synthetic', HERMES_YOLO_MODE: '1' };
  const names = 'result: JSON.stringify(Object.keys(process.env).map(k => k.toUpperCase()).sort())';
  m.fake('claude', `await Bun.write(Bun.stdout, JSON.stringify({ is_error: false, session_id: 'x', ${names} }));`);
  const claude = JSON.parse((await runRemoteTurn(m.prompt(), { ...m.deps, env }) as { reply: string }).reply) as string[];
  expect(claude).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'NO_COLOR', 'PATH']));
  for (const gone of ['GITHUB_TOKEN', 'NPM_TOKEN', 'DATABASE_URL', 'HERMES_YOLO_MODE']) expect(claude).not.toContain(gone);
  m.fake('hermes', `await Bun.write(Bun.stdout, JSON.stringify(Object.keys(process.env).map(k => k.toUpperCase())) + '\\n');`);
  const hermes = JSON.parse((await runRemoteTurn(m.prompt({ harness: 'hermes', sessionId: m.ids.hermes }), { ...m.deps, env }) as { reply: string }).reply) as string[];
  expect(hermes).toContain('HERMES_HOME');
  expect(hermes).not.toContain('HERMES_YOLO_MODE');
  expect(hermes).not.toContain('GITHUB_TOKEN');
});

test('prompt files a turn left behind are swept when the local API starts, and a running turn\'s is kept', async () => {
  const m = await machine();
  const dir = join(m.home, 'remote-turns');
  mkdirSync(dir, { recursive: true });
  const stale = `${uuid()}.txt`;
  writeFileSync(join(dir, stale), 'Synthetic leftover prompt');
  writeFileSync(join(dir, 'notes.md'), 'not a prompt file');
  expect(sweepPromptFiles(m.home)).toBe(1);
  expect(readdirSync(dir)).toEqual(['notes.md']);
  writeFileSync(join(dir, stale), 'Synthetic leftover prompt');
  const api = startLocalApi({ dir: join(m.root, 'daemon'), home: m.home, port: 0, log: () => {}, remote: m.deps });
  cleanups.push(() => api.stop());
  expect(readdirSync(dir)).toEqual(['notes.md']);
  expect(sweepPromptFiles(join(m.root, 'nobody'))).toBe(0);
});

test('a run whose start can\'t be recorded is stopped, never left running unseen', async () => {
  let pid = 0;
  const started = Date.now();
  const run = await runTurnProgram({ file: process.execPath, args: ['-e', 'await Bun.sleep(30000)'] }, { cwd: folder(), env: process.env, timeoutMs: 60_000,
    onStart: got => { pid = got; throw new Error('the ledger is gone'); } });
  expect(run.error).toMatch(/could not be recorded as running: the ledger is gone/);
  expect(Date.now() - started).toBeLessThan(20_000);
  expect(pid).toBeGreaterThan(0);
  expect(await until(() => !alive(pid))).toBe(true);
}, 40_000);

test('a turn past its timeout, or cancelled, has its whole process tree killed', async () => {
  const m = await machine();
  m.enable();
  let pids = sleeper(m);
  expect(failed(await runRemoteTurn(m.prompt(), { ...m.deps, timeoutMs: 2_000 }))).toMatchObject({ code: 'timeout', message: expect.stringMatching(/within 2 seconds/) });
  expect(pids()).toHaveLength(2);
  const [harness, child] = pids();
  expect(await until(() => !alive(harness) && !alive(child))).toBe(true);
  pids = sleeper(m);
  let turnId = '';
  const turn = runRemoteTurn(m.prompt(), { ...m.deps, onRunning: id => { turnId = id; } });
  expect(await until(() => !!turnId && pids().length === 2)).toBe(true);
  expect(cancelTurn(turnId)).toBe(true);
  expect(cancelTurn(turnId)).toBe(false);
  expect(failed(await turn)).toMatchObject({ code: 'cancelled', message: 'The turn was cancelled.' });
  const [harness2, child2] = pids();
  expect(await until(() => !alive(harness2) && !alive(child2))).toBe(true);
  expect(m.audit().map(a => a.outcome)).toEqual(['running', 'timeout', 'running', 'cancelled']);
}, 30_000);

test('turning remote control off, or revoking the controller, stops its turns at once', async () => {
  const m = await machine();
  m.enable();
  let pids = sleeper(m);
  let turn = runRemoteTurn(m.prompt(), m.deps);
  expect(await until(() => pids().length === 2)).toBe(true);
  savePolicy(m.home, { enabled: false, harnesses: ['claude'], trusted: [] });
  expect(failed(await turn)).toMatchObject({ code: 'cancelled', message: 'Remote control was turned off on this machine.' });
  expect(failed(await runRemoteTurn(m.prompt(), m.deps))?.code).toBe('disabled');
  m.enable();
  pids = sleeper(m);
  turn = runRemoteTurn(m.prompt(), m.deps);
  expect(await until(() => pids().length === 2)).toBe(true);
  expect(removeController(m.home, m.browser.device)).toBe(true);
  expect(failed(await turn)).toMatchObject({ code: 'cancelled', message: expect.stringMatching(/revoked/) });
  expect(failed(await runRemoteTurn(m.prompt(), m.deps))?.code).toBe('unknown-controller');
}, 30_000);

test('the audit log has ids, outcomes and sizes, never the prompt or the reply, and rotates at its limit', async () => {
  const m = await machine();
  m.enable();
  const secret = 'Synthetic secret prompt words';
  await runRemoteTurn(m.prompt({ text: secret }), m.deps);
  await runRemoteTurn(m.prompt({ sessionId: secret }), m.deps);
  await runRemoteTurn(m.prompt({ harness: 'codex', sessionId: m.ids.codex, text: `${secret} again` }), m.deps);
  // A harness that fails with the prompt in its error: the controller is told, the log is not.
  m.fake('claude', `const stdin = await Bun.stdin.text(); await Bun.write(Bun.stdout, JSON.stringify({ is_error: true, result: 'Refused: ' + stdin })); process.exit(1);`);
  expect(failed(await runRemoteTurn(m.prompt({ text: `${secret} failing` }), m.deps))?.message).toContain(secret);
  const log = readFileSync(join(m.home, CONTROL_LOG), 'utf8');
  expect(log).not.toContain('secret');
  expect(log).not.toContain('Synthetic');
  expect(log).not.toContain('Refused');
  const lines = m.audit();
  expect(lines.map(l => l.outcome)).toEqual(['running', 'done', 'invalid', 'running', 'done', 'running', 'failed']);
  // Only these fields, ever: none of them can carry text.
  const fields = ['at', 'controller', 'harness', 'sessionId', 'requestId', 'turnId', 'outcome', 'promptBytes', 'replyBytes', 'durationMs', 'truncated'];
  for (const line of lines) expect(Object.keys(line).filter(key => !fields.includes(key))).toEqual([]);
  expect(lines[1]).toMatchObject({ controller: m.browser.device, harness: 'claude', sessionId: m.ids.claude, promptBytes: secret.length });
  expect(lines[1].replyBytes).toBeGreaterThan(secret.length);
  expect(lines[1].requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(typeof lines[1].durationMs).toBe('number');
  // A field that isn't a well formed id is logged as null, so no text reaches the log through it.
  expect(lines[2]).toMatchObject({ outcome: 'invalid', sessionId: null, promptBytes: 'Synthetic prompt'.length, replyBytes: 0 });
  if (process.platform !== 'win32') expect(statSync(join(m.home, CONTROL_LOG)).mode & 0o777).toBe(0o600);
  // Past the limit, the log moves to control.log.1 (one older copy) and starts again.
  writeFileSync(join(m.home, CONTROL_LOG), 'x'.repeat(LOG_LIMIT + 1));
  await runRemoteTurn(m.prompt({ sessionId: uuid() }), m.deps);
  expect(statSync(join(m.home, `${CONTROL_LOG}.1`)).size).toBe(LOG_LIMIT + 1);
  expect(m.audit().map(l => l.outcome)).toEqual(['unknown-session']);
});

test('the local API serves remote control to the app only, and runs a turn to its reply', async () => {
  const m = await machine(), daemon = join(m.root, 'daemon');
  const api = startLocalApi({ dir: daemon, home: m.home, port: 0, log: () => {}, remote: m.deps });
  cleanups.push(() => api.stop());
  const base = `http://127.0.0.1:${api.port}`, control = { Authorization: `Bearer ${localControlToken(readLocalApi(daemon)!.secret)}` };
  const call = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = control) =>
    fetch(`${base}/api/local/app/remote/${path}`, { method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  // The page, signed in with its session token, is refused.
  const ticket = (await (await fetch(`${base}/api/local/ticket`, { method: 'POST', headers: control })).json() as { ticket: string }).ticket;
  const session = await (await fetch(`${base}/api/local/session`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) })).json() as { token: string };
  const page = await call('policy', 'GET', undefined, { Authorization: `Bearer ${session.token}`, Origin: base });
  expect(page.status).toBe(403);
  expect(await page.json()).toEqual({ error: 'This is for the Meshrooms app only.' });
  expect((await call('policy', 'PUT', { enabled: true }, { Authorization: `Bearer ${session.token}`, Origin: base })).status).toBe(403);
  expect(await (await call('policy')).json()).toEqual({ enabled: false, harnesses: [], trusted: [] });
  expect((await call('policy', 'PUT', { enabled: true, harnesses: ['exec'], trusted: [] })).status).toBe(400);
  expect(await (await call('policy', 'PUT', { enabled: true, harnesses: ['claude'], trusted: [] })).json()).toEqual({ enabled: true, harnesses: ['claude'], trusted: [] });
  expect(await (await call('controllers')).json()).toMatchObject({ controllers: [{ device: m.browser.device, name: 'Laptop browser' }] });
  const turn = await call('turn', 'POST', m.prompt({ text: 'From the app' }));
  expect(turn.status).toBe(200);
  expect(await turn.json()).toMatchObject({ state: 'done', sessionId: m.ids.claude });
  expect((await call('turn', 'POST', { ...m.prompt(), folder: '/elsewhere' })).status).toBe(400);
  expect(await (await call('turn', 'POST', m.prompt({ harness: 'codex', sessionId: m.ids.codex }))).json()).toMatchObject({ state: 'failed', code: 'not-allowed' });
  expect(await (await call('turns')).json()).toEqual({ turns: [] });
  expect(await (await call('cancel', 'POST', { turnId: uuid() })).json()).toEqual({ cancelled: false });
  expect(await (await call(`controllers/${m.browser.device}`, 'DELETE')).json()).toEqual({ removed: true });
  expect(await (await call('controllers')).json()).toEqual({ controllers: [] });
  expect((await call('nothing')).status).toBe(404);
  // Enrolment and the control socket's state need the daemon's control socket: without it they say so.
  expect((await call('status')).status).toBe(503);
  expect((await call('enrol', 'POST', {})).status).toBe(503);
  expect((await call('enrol', 'POST', {}, { Authorization: `Bearer ${session.token}`, Origin: base })).status).toBe(403);
});

test("the app's changes to the policy: harnesses turn it on, none off, and trust is per browser", () => {
  const device = 'a'.repeat(64), other = 'b'.repeat(64);
  const policy = { enabled: true, harnesses: ['claude' as const], trusted: [device] };
  expect(policyAllowing(policy, ['claude', 'codex'])).toEqual({ enabled: true, harnesses: ['claude', 'codex'], trusted: [device] });
  expect(policyAllowing(policy, [])).toEqual({ enabled: false, harnesses: [], trusted: [device] });
  expect(() => policyAllowing(policy, 'claude')).toThrow(/harnesses/);
  expect(policyTrusting(policy, other, true).trusted).toEqual([device, other]);
  expect(policyTrusting(policy, device, true).trusted).toEqual([device]);
  expect(policyTrusting(policy, device, false).trusted).toEqual([]);
});

test('the Remote control window\'s view: the policy read strictly, browsers online only through a ready connection', async () => {
  const m = await machine();
  m.enable(['claude'], [m.browser.device]);
  const connecting = { status: () => ({ connections: [{ origin: 'https://rooms.example', state: 'connecting', peers: [{ device: m.browser.device, online: true }] }] }) };
  const ready = { status: () => ({ connections: [{ origin: 'https://rooms.example', state: 'ready', peers: [{ device: m.browser.device, online: true }] }] }) };
  expect(remoteOverview(m.home, ready)).toMatchObject({ policy: { enabled: true, harnesses: ['claude'] }, machineKnown: true,
    browsers: [{ device: m.browser.device, name: 'Laptop browser', trusted: true, online: true }], connections: [{ origin: 'https://rooms.example', state: 'ready' }] });
  // Peers from a connection that isn't ready are old news.
  expect(remoteOverview(m.home, connecting).browsers[0].online).toBe(false);
  // Without the daemon's control socket, it can't tell.
  expect(remoteOverview(m.home)).toMatchObject({ machineKnown: false, browsers: [{ online: false }] });
  // A policy file that can't be read is unknown, never shown as off.
  writeFileSync(join(m.home, POLICY_FILE), 'not json');
  expect(remoteOverview(m.home, ready)).toMatchObject({ policy: null, policyProblem: expect.stringMatching(/can't be read/), browsers: [{ trusted: false }] });
});

test('one change at a time from the window: made on the policy as it is, never on an unreadable one, and a stale trust never blocks turning it off', async () => {
  const m = await machine();
  m.enable(['claude'], [m.browser.device]);
  expect(changePolicy(m.home, { allow: ['claude', 'codex'] })).toEqual({ enabled: true, harnesses: ['claude', 'codex'], trusted: [m.browser.device] });
  expect(changePolicy(m.home, { trust: { device: m.browser.device, trusted: false } }).trusted).toEqual([]);
  expect(() => changePolicy(m.home, { trust: { device: 'f'.repeat(64), trusted: true } })).toThrow(/not a controller/);
  expect(() => changePolicy(m.home, {})).toThrow(/allow or trust/);
  // A trust entry for a browser no longer enrolled (written by hand, say) doesn't stop the kill switch.
  writeFileSync(join(m.home, POLICY_FILE), JSON.stringify({ enabled: true, harnesses: ['claude'], trusted: ['e'.repeat(64)] }));
  expect(changePolicy(m.home, { allow: [] })).toEqual({ enabled: false, harnesses: [], trusted: [] });
  // An unreadable policy is left as it is.
  writeFileSync(join(m.home, POLICY_FILE), 'not json');
  expect(() => changePolicy(m.home, { allow: [] })).toThrow(/can't be read/);
  expect(readFileSync(join(m.home, POLICY_FILE), 'utf8')).toBe('not json');
  // Through the local API: the app's routes, the app's token only.
  writeFileSync(join(m.home, POLICY_FILE), JSON.stringify({ enabled: true, harnesses: ['claude'], trusted: [] }));
  const daemon = join(m.root, 'daemon');
  const api = startLocalApi({ dir: daemon, home: m.home, port: 0, log: () => {}, remote: m.deps, machine: { enrol: async () => ({}), status: () => ({ connections: [] }) } });
  cleanups.push(() => api.stop());
  const base = `http://127.0.0.1:${api.port}/api/local/app/remote`, control = { Authorization: `Bearer ${localControlToken(readLocalApi(daemon)!.secret)}`, 'Content-Type': 'application/json' };
  expect(await (await fetch(`${base}/overview`, { headers: control })).json()).toMatchObject({ policy: { enabled: true }, machineKnown: true, browsers: [{ device: m.browser.device }] });
  expect(await (await fetch(`${base}/change`, { method: 'POST', headers: control, body: JSON.stringify({ allow: [] }) })).json()).toEqual({ enabled: false, harnesses: [], trusted: [] });
  expect((await fetch(`${base}/change`, { method: 'POST', body: JSON.stringify({ allow: [] }), headers: { 'Content-Type': 'application/json' } })).status).not.toBe(200);
});

test('the remote control commands take --harnesses as a flag, and say so when the daemon isn\'t running', () => {
  const empty = folder();
  const run = (args: string[]) => {
    const proc = Bun.spawnSync({ cmd: [process.execPath, 'run', resolve('server/agent-cli.ts'), 'person', ...args], stdin: new TextEncoder().encode('\n'), stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, MESHROOMS_DAEMON_DIR: join(empty, 'daemon'), MESHROOMS_PERSON_HOME: join(empty, 'person'), MESHROOMS_AGENT_REGISTRY: join(empty, 'agents.json') }, timeout: 30_000 });
    return new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);
  };
  for (const args of [['remote-status', '--harnesses'], ['remote-status'], ['remote-allow', '--allow', 'none'], ['remote-revoke', '--device', 'a'.repeat(64)]]) {
    const out = run(args);
    expect(out).not.toContain('Give a value');
    expect(out).toContain("daemon isn't running");
  }
});
