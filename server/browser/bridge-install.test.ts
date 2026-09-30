import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { agentCli, isRunnerCommand } from '../agent-cli';
import { BRIDGE_VERSION, BridgeTooOld, MANIFEST, assertPrivateDir, binDir, bunTooOld, busyOnWindows, checkBridgeVersion, compareVersions, installBridge, launcherSource, runningBundle } from '../agent-install';
import { buildAgent } from '../../scripts/build-agent';
import { deviceId } from '../../src/browser/protocol';
import { testDirectory } from '../test-directory';
import { CURRENT_AGENT_VERSION, MIN_AGENT_VERSION } from './agent-version';
import packageJson from '../../packages/meshrooms/package.json';

test('versions order like semver, prereleases before their release', () => {
  const sorted = ['0.1.0-alpha.3', '0.2.0-alpha.9', '0.2.0-beta.1', '0.2.0-beta.2', '0.2.0-beta.10', '0.2.0-rc.1', '0.2.0', '0.2.1', '0.10.0', '1.0.0'];
  for (let i = 0; i < sorted.length; i++) for (let j = 0; j < sorted.length; j++)
    expect(Math.sign(compareVersions(sorted[i], sorted[j]))).toBe(Math.sign(i - j));
  expect(compareVersions('1.0.0-beta', '1.0.0-beta.1')).toBe(-1);
  expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
  expect(() => compareVersions('latest', '1.0.0')).toThrow('Not a version');
  expect(bunTooOld('1.3.9')).toBe(true);
  expect(bunTooOld('1.4.2')).toBe(false);
  expect(bunTooOld('1.4.2-canary.3+abc')).toBe(false);
  expect(bunTooOld('1.5.0')).toBe(false);
});

test('the room service never rejects the bridge this repository ships', () => {
  expect(BRIDGE_VERSION).toBe(packageJson.version);
  expect(compareVersions(BRIDGE_VERSION, MIN_AGENT_VERSION)).toBeGreaterThanOrEqual(0);
  // The join guide and health name this version exactly; bumping the package means bumping it (and publishing first).
  expect(CURRENT_AGENT_VERSION).toBe(packageJson.version);
  // The npm package, not the private repository root, is what `bunx @wormdb/meshrooms` runs.
  expect(packageJson.name).toBe('@wormdb/meshrooms');
  expect(packageJson.bin).toEqual({ meshrooms: 'bin/meshrooms.js' });
  expect(packageJson.engines.bun).toBe('>=1.4.2');
  expect(JSON.parse(readFileSync(join(import.meta.dir, '../../package.json'), 'utf8')).private).toBe(true);
});

test('docs and the site name the bridge by the exact version this repository ships', () => {
  const root = join(import.meta.dir, '../..');
  for (const file of ['README.md', 'skills/meshrooms/SKILL.md', 'packages/meshrooms/README.md', 'packages/meshrooms/package.json', 'website/index.html', 'website/site.js']) {
    const text = readFileSync(join(root, file), 'utf8');
    const versions = [...text.matchAll(/@wormdb\/meshrooms@(\d[^\s'"`<]*)/g)].map(m => m[1]);
    expect(versions.length, file).toBeGreaterThan(0);
    for (const version of versions) expect(version, file).toBe(packageJson.version);
    // A bare package name before a command runs whatever bunx cached; the downloaded bundle is the old flow.
    expect(text, file).not.toMatch(/bunx @wormdb\/meshrooms\s+[a-z]/);
    expect(text, file).not.toMatch(/meshrooms-agent\.js (connect|listen|send)/);
  }
});

test('the bridge installs under the home folder on every OS, never the current folder', () => {
  const home = process.platform === 'win32' ? 'C:\\Users\\Jane Doe' : '/home/jane doe';
  expect(binDir({}, home)).toBe(join(home, '.meshrooms', 'bin'));
  expect(binDir({ MESHROOMS_BIN_DIR: join(home, 'tools', 'meshrooms') }, home)).toBe(join(home, 'tools', 'meshrooms'));
  expect(binDir({}, '/home/jane')).toBe(resolve('/home/jane', '.meshrooms', 'bin'));
  expect(binDir({}, '/home/jane')).not.toContain(process.cwd());
  // From source, runners run the source; a built bundle installs itself first.
  expect(runningBundle('/repo/server/agent-install.ts')).toBeUndefined();
  expect(runningBundle('/home/jane/.bun/install/cache/meshrooms/bin/meshrooms.js')).toBe('/home/jane/.bun/install/cache/meshrooms/bin/meshrooms.js');
});

test('installing keeps a versioned copy and a launcher that never moves back to an older version', async () => {
  const dir = testDirectory('bridge-install');
  try {
    const bin = join(dir.path, 'bin'), cache = join(dir.path, 'bunx-cache');
    mkdirSync(cache);
    const bundle = (tag: string) => { const file = join(cache, `${tag}.js`); writeFileSync(file, `export async function main(argv) { console.log(JSON.stringify({ tag: ${JSON.stringify(tag)}, argv })); }\n`); return file; };
    const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
    const first = installBridge(bundle('beta-1'), '0.2.0-beta.1', bin);
    expect(first).toMatchObject({ dir: bin, launcher: join(bin, 'meshrooms.js'), version: '0.2.0-beta.1' });
    expect(readdirSync(bin).sort()).toEqual([MANIFEST, 'meshrooms-0.2.0-beta.1.js', 'meshrooms.js']);
    expect(readFileSync(first.launcher, 'utf8')).toBe(launcherSource('0.2.0-beta.1', hash(join(bin, 'meshrooms-0.2.0-beta.1.js'))));
    expect(JSON.parse(readFileSync(join(bin, MANIFEST), 'utf8')).versions['0.2.0-beta.1'].sha256).toBe(hash(join(bin, 'meshrooms-0.2.0-beta.1.js')));

    // A newer bridge takes over the launcher; an older bunx cache run afterwards installs its copy but leaves it.
    expect(installBridge(bundle('beta-2'), '0.2.0-beta.2', bin).version).toBe('0.2.0-beta.2');
    expect(installBridge(bundle('beta-1'), '0.2.0-beta.1', bin).version).toBe('0.2.0-beta.2');
    expect(readFileSync(first.launcher, 'utf8')).toContain("'./meshrooms-0.2.0-beta.2.js'");

    // A file that only looks like a newer version was never installed, so it is never chosen.
    writeFileSync(join(bin, 'meshrooms-99.0.0.js'), 'export async function main() { console.log("dropped"); }\n');
    expect(installBridge(bundle('beta-1'), '0.2.0-beta.1', bin).version).toBe('0.2.0-beta.2');

    // The launcher runs the installed copy even after the bunx cache (or the downloaded file) is gone.
    rmSync(cache, { recursive: true });
    const run = Bun.spawnSync([process.execPath, first.launcher, 'listen', '--room', 'r'], { cwd: dir.path });
    expect(JSON.parse(run.stdout.toString())).toEqual({ tag: 'beta-2', argv: ['listen', '--room', 'r'] });
    expect(readdirSync(bin).filter(f => f.endsWith('.tmp') || f.endsWith('.lock'))).toEqual([]);
    expect(() => installBridge(join(cache, 'gone.js'), '0.2.0-beta.3', bin)).toThrow('MESHROOMS_BIN_DIR');

    // An installed copy changed afterwards is not run, and the next install stops choosing it.
    writeFileSync(join(bin, 'meshrooms-0.2.0-beta.2.js'), 'export async function main() { console.log("changed"); }\n');
    const refused = Bun.spawnSync([process.execPath, first.launcher, 'listen'], { cwd: dir.path });
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout.toString()).toBe('');
    expect(refused.stderr.toString()).toContain('changed since it was installed');
    mkdirSync(cache);
    expect(installBridge(bundle('beta-1'), '0.2.0-beta.1', bin).version).toBe('0.2.0-beta.1');
    expect(Object.keys(JSON.parse(readFileSync(join(bin, MANIFEST), 'utf8')).versions)).toEqual(['0.2.0-beta.1']);
  } finally { dir.cleanup(); }
});

test('bridges of two versions installing at the same time leave the launcher on the newer one', async () => {
  const dir = testDirectory('bridge-install-race');
  try {
    const install = join(import.meta.dir, '..', 'agent-install.ts').replaceAll('\\', '/');
    for (let round = 0; round < 4; round++) {
      const bin = join(dir.path, `bin-${round}`).replaceAll('\\', '/');
      const racers = ['0.2.0-beta.1', '0.2.0-beta.2', '0.2.0-beta.1', '0.2.0-beta.2'].map((version, i) => {
        const source = join(dir.path, `bundle-${round}-${i}.js`).replaceAll('\\', '/');
        writeFileSync(source, `export async function main() { console.log(${JSON.stringify(version)}); }\n`);
        return Bun.spawn([process.execPath, '-e', `import { installBridge } from '${install}'; installBridge('${source}', '${version}', '${bin}');`], { stderr: 'pipe' });
      });
      // A racer that fails says why, so a failure on CI is not just "Received: 1".
      for (const racer of racers) {
        const failed = await racer.exited ? await new Response(racer.stderr).text() : '';
        expect(failed, `round ${round}`).toBe('');
      }
      expect(readFileSync(join(bin, 'meshrooms.js'), 'utf8')).toContain("'./meshrooms-0.2.0-beta.2.js'");
      expect(Object.keys(JSON.parse(readFileSync(join(bin, MANIFEST), 'utf8')).versions).sort()).toEqual(['0.2.0-beta.1', '0.2.0-beta.2']);
    }
  } finally { dir.cleanup(); }
}, 60_000);

test('on Windows a lock that is still being deleted is contention, not a permission error', () => {
  const failure = (code: string) => Object.assign(new Error(code), { code });
  // Creating install.lock while the last holder's delete is pending fails with EPERM there (CI run 36619991998).
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    expect(busyOnWindows(failure(code), 'win32')).toBe(true);
    expect(busyOnWindows(failure(code), 'linux')).toBe(false);
    expect(busyOnWindows(failure(code), 'darwin')).toBe(false);
  }
  for (const code of ['ENOENT', 'EEXIST', 'ENOSPC']) expect(busyOnWindows(failure(code), 'win32')).toBe(false);
});

test.skipIf(process.platform === 'win32')('on macOS and Linux the bridge refuses a folder other users can change', () => {
  const dir = testDirectory('bridge-install-mode');
  try {
    const bin = join(dir.path, 'bin'), source = join(dir.path, 'bundle.js');
    writeFileSync(source, 'export async function main() {}\n');
    mkdirSync(bin, { mode: 0o700 }); chmodSync(bin, 0o777);
    expect(() => installBridge(source, '0.2.0-beta.1', bin)).toThrow('other users can write to');
    expect(existsSync(join(bin, 'meshrooms.js'))).toBe(false);
    chmodSync(bin, 0o700);
    expect(installBridge(source, '0.2.0-beta.1', bin).version).toBe('0.2.0-beta.1');
    expect(() => assertPrivateDir(bin, process.getuid!() + 1)).toThrow('belongs to another user');
  } finally { dir.cleanup(); }
});

test('runners are recognised from the installed launcher and from bridges downloaded before it', () => {
  const room = crypto.randomUUID();
  for (const command of [
    `"C:\\Users\\Jane Doe\\.bun\\bin\\bun.exe" "C:\\Users\\Jane Doe\\.meshrooms\\bin\\meshrooms.js" run --room ${room}`,
    `C:\\Users\\jane\\.bun\\bin\\bun.exe C:\\Users\\jane\\.meshrooms\\bin\\meshrooms.js run --room ${room}`,
    `/home/jane/.bun/bin/bun /home/jane/.meshrooms/bin/meshrooms.js run --room ${room}`,
    `/Users/Jane Doe/.bun/bin/bun /Users/Jane Doe/.meshrooms/bin/meshrooms.js run --room ${room}`,
    `/home/jane/.bun/bin/bun /home/jane/project/meshrooms-agent.js run --room ${room}`,
    `"C:\\Program Files\\bun\\bun.exe" "C:\\work\\repo\\meshrooms-agent.js" run --room ${room}`,
    `bun /repo/server/agent-cli.ts run --room ${room}`,
  ]) expect(isRunnerCommand(command, room)).toBe(true);
  for (const command of [
    `/home/jane/.bun/bin/bun /home/jane/.meshrooms/bin/meshrooms.js run --room ${crypto.randomUUID()}`,
    `vim /home/jane/.meshrooms/bin/meshrooms.js run --room ${room}`,
    `/home/jane/.bun/bin/bun /home/jane/notmeshrooms.js run --room ${room}`,
    `/home/jane/.bun/bin/bun /home/jane/.meshrooms/bin/meshrooms.js listen --room ${room}`,
  ]) expect(isRunnerCommand(command, room)).toBe(false);
});

test('the version handshake tells an outdated bridge how to update', async () => {
  const answering = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as unknown as typeof fetch;
  const check = (command: string, fetcher: typeof fetch) => checkBridgeVersion('https://rooms.example', command, { version: '0.2.0-beta.1', fetcher, sleep: async () => {} });
  let error: unknown;
  // The update names the exact version the service wants: bunx can answer @latest (or no version) from an older cache.
  try { await check('connect', answering({ ok: true, minAgentVersion: '0.3.0', currentAgentVersion: '0.3.1' })); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(BridgeTooOld);
  expect((error as Error).message).toContain("bunx @wormdb/meshrooms@0.3.1 connect '<the same link>'");
  expect((error as Error).message).toContain('The link was not used');
  await expect(check('listen', answering({ ok: true, minAgentVersion: '0.2.0', currentAgentVersion: '0.2.0' }))).rejects.toThrow('bunx @wormdb/meshrooms@0.2.0 listen');
  // A service from before it named a current version (or naming one it would itself refuse, or garbage) gets @latest.
  for (const current of [undefined, '0.2.0-beta.9', 'latest'])
    await expect(check('listen', answering({ ok: true, minAgentVersion: '0.2.0', currentAgentVersion: current }))).rejects.toThrow('bunx @wormdb/meshrooms@latest listen');
  expect(await check('connect', answering({ ok: true, minAgentVersion: '0.2.0-beta.1' }))).toEqual({ minimum: '0.2.0-beta.1' });
  expect(await check('connect', answering({ ok: true, minAgentVersion: '0.2.0-beta.1', currentAgentVersion: '0.2.0-beta.2' }))).toEqual({ minimum: '0.2.0-beta.1', current: '0.2.0-beta.2' });
  // A service from before the handshake answers its health without a minimum; that is not a reason to refuse.
  expect(await check('connect', answering({ ok: true }))).toEqual({});
  // The bridge says which version asks.
  let agent = '';
  await check('run', (async (_url: string, init: RequestInit) => { agent = new Headers(init.headers).get('user-agent') || ''; return Response.json({ ok: true }); }) as unknown as typeof fetch);
  expect(agent).toBe('meshrooms/0.2.0-beta.1');
});

test('connect fails closed when it cannot ask the service, after retrying; other commands carry on', async () => {
  const counting = (respond: () => Response | Promise<Response>) => {
    const calls = { count: 0, waits: [] as number[] };
    const fetcher = (async () => { calls.count++; return respond(); }) as unknown as typeof fetch;
    return { calls, options: { version: '0.2.0-beta.1', fetcher, sleep: async (ms: number) => { calls.waits.push(ms); } } };
  };
  for (const [what, respond] of [
    ['an error status', () => Response.json({ ok: true, minAgentVersion: '0.1.0' }, { status: 503 })],
    ['a page that is not the service', () => new Response('<h1>Back soon</h1>')],
    ['JSON that is not its health', () => Response.json({ status: 'up' })],
    ['a garbled minimum', () => Response.json({ ok: true, minAgentVersion: 'latest' })],
    ['a timeout or refused connection', () => { throw new Error('The operation timed out.'); }],
  ] as const) {
    const connect = counting(respond);
    await expect(checkBridgeVersion('https://rooms.example', 'connect', connect.options), what).rejects.toThrow('so this link was not used');
    expect(connect.calls.count, what).toBe(3);
    expect(connect.calls.waits, what).toEqual([500, 1000]);
    const listen = counting(respond);
    expect(await checkBridgeVersion('https://rooms.example', 'listen', listen.options), what).toBeUndefined();
    expect(listen.calls.count, what).toBe(1);
  }
  // A service that answers on the second try lets connect go on.
  let tries = 0;
  const flaky = (async () => ++tries === 1 ? new Response('', { status: 502 }) : Response.json({ ok: true, minAgentVersion: '0.2.0-beta.1' })) as unknown as typeof fetch;
  expect(await checkBridgeVersion('https://rooms.example', 'connect', { version: '0.2.0-beta.1', fetcher: flaky, sleep: async () => {} })).toEqual({ minimum: '0.2.0-beta.1' });
});

/**
 * A room service stand-in: /api/lobby/health reports `minimum`; `status` answers for this device, and after the link is
 * redeemed the agent waits for the host (so the runner keeps polling rather than exiting).
 */
function fakeRoom(minimum: string, current?: string) {
  let redeemed = false;
  return Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    if (new URL(request.url).pathname === '/api/lobby/health') return Response.json({ ok: true, revision: 'test', minAgentVersion: minimum, currentAgentVersion: current });
    const { command, publicKey } = await request.json() as any;
    if (command.action === 'agent-redeem') { redeemed = true; return Response.json({ ok: true }); }
    if (command.action === 'status') return Response.json({ roomId: command.roomId, deviceId: await deviceId(publicKey), title: 'Room', epoch: 'e', hostOnline: true,
      ...(redeemed ? { request: { state: 'pending' } } : {}) });
    return Response.json({ error: 'Not in this test.' }, { status: 400 });
  } });
}
const token = 'x'.repeat(43);

test('a bridge older than the service accepts stops before using the link', async () => {
  const dir = testDirectory('bridge-too-old'), server = fakeRoom('99.0.0', '99.0.1'), room = crypto.randomUUID();
  const before = { home: process.env.MESHROOMS_AGENT_HOME, bin: process.env.MESHROOMS_BIN_DIR };
  process.env.MESHROOMS_AGENT_HOME = join(dir.path, 'agents'); process.env.MESHROOMS_BIN_DIR = join(dir.path, 'bin');
  try {
    await expect(agentCli(['connect', `http://127.0.0.1:${server.port}/agent/${room}#${token}`])).rejects.toThrow("bunx @wormdb/meshrooms@99.0.1 connect '<the same link>'");
    expect(existsSync(join(dir.path, 'agents'))).toBe(false);
    expect(existsSync(join(dir.path, 'bin'))).toBe(false);
  } finally {
    server.stop(true);
    for (const [key, value] of [['MESHROOMS_AGENT_HOME', before.home], ['MESHROOMS_BIN_DIR', before.bin]] as const) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    dir.cleanup();
  }
});

test('the built bridge connects without writing into the current folder, and its runner outlives the bunx copy', async () => {
  const dir = testDirectory('bridge-connect'), server = fakeRoom(MIN_AGENT_VERSION, CURRENT_AGENT_VERSION), room = crypto.randomUUID();
  const project = join(dir.path, 'project'), cache = join(dir.path, 'bunx-cache'), bin = join(dir.path, 'bin');
  mkdirSync(project);
  const env = { ...process.env, MESHROOMS_AGENT_HOME: join(dir.path, 'agents'), MESHROOMS_BIN_DIR: bin };
  const run = async (script: string, args: string[]) => {
    const child = Bun.spawn([process.execPath, script, ...args], { cwd: project, env, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, err, code };
  };
  let runner: number | undefined;
  const runners: number[] = [];
  try {
    const { file } = await buildAgent(cache);
    const connected = await run(file, ['connect', `http://127.0.0.1:${server.port}/agent/${room}#${token}`, '--harness', 'Test', '--model', 'test-model']);
    expect(connected.err).toBe('');
    const result = JSON.parse(connected.out);
    runner = result.runnerPid;
    runners.push(runner!);
    expect(result).toMatchObject({ state: 'waiting-for-host', roomId: room, bridge: { version: BRIDGE_VERSION, launcher: join(bin, 'meshrooms.js') } });
    // Next steps run the installed launcher, which never goes through bunx's cache; bunx comes only with an exact version.
    const next = result.next.join('\n');
    expect(next).toContain(`bun "${join(bin, 'meshrooms.js')}" listen --room ${room}`);
    expect(next).toContain(`bunx @wormdb/meshrooms@${CURRENT_AGENT_VERSION} <command>`);
    expect(next).not.toMatch(/bunx @wormdb\/meshrooms(?!@\d)/);
    // Nothing lands in the project; the bridge lives in its own folder.
    expect(readdirSync(project)).toEqual([]);
    expect(readdirSync(bin).sort()).toEqual([MANIFEST, `meshrooms-${BRIDGE_VERSION}.js`, 'meshrooms.js']);

    // Clearing the bunx cache (or deleting a downloaded bridge) leaves the runner and the installed launcher working.
    rmSync(cache, { recursive: true });
    const launcher = join(bin, 'meshrooms.js');
    const status = await run(launcher, ['status', '--room', room]);
    expect(status.err).toBe('');
    expect(JSON.parse(status.out)).toMatchObject({ roomId: room, runner: runner });

    // A runner of another version (here: recorded as older), or one from a downloaded meshrooms-agent.js that recorded
    // no version, is replaced by the installed version on the next command that needs it.
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const record = join(dir.path, 'agents', 'browser-agents', room, 'runner.json');
    expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({ pid: runner, version: BRIDGE_VERSION });
    for (const older of [() => writeFileSync(record, JSON.stringify({ pid: runner, version: '0.1.0' })), () => rmSync(record)]) {
      older();
      const before = runner!;
      expect((await run(launcher, ['decisions', '--room', room])).err).toBe('');
      runner = JSON.parse((await run(launcher, ['status', '--room', room])).out).runner;
      runners.push(runner!);
      expect(runner).toBeNumber();
      expect(runner).not.toBe(before);
      expect(alive(before)).toBe(false);
      expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({ pid: runner, version: BRIDGE_VERSION });
    }
    // A runner of the installed version is kept.
    expect((await run(launcher, ['decisions', '--room', room])).err).toBe('');
    expect(JSON.parse((await run(launcher, ['status', '--room', room])).out).runner).toBe(runner);

    expect(JSON.parse((await run(launcher, ['stop', '--room', room])).out)).toEqual({ stopped: true });
    expect(readdirSync(project)).toEqual([]);
  } finally {
    for (const pid of runners) try { process.kill(pid); } catch { /* Already gone. */ }
    server.stop(true);
    dir.cleanup();
  }
}, 60_000);

test('the bridge replaces its state files through Windows sharing errors instead of crashing', async () => {
  const { replaceFile } = await import('../browser-agent');
  const dir = testDirectory('replace-file');
  try {
    const target = join(dir.path, 'activity.json');
    writeFileSync(target, '{"old":true}');
    const busy = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    const leftovers = () => readdirSync(dir.path).filter(name => name.endsWith('.tmp'));
    let attempts = 0;
    const flaky = (from: string, to: string) => { if (++attempts < 3) throw busy(); require('node:fs').renameSync(from, to); };
    if (process.platform === 'win32') {
      // A reader holding the file open for a moment: retried, then written.
      replaceFile(target, '{"new":true}', flaky);
      expect(attempts).toBe(3);
      expect(readFileSync(target, 'utf8')).toBe('{"new":true}');
      // Still busy past the retry window: the error stands and no temporary file is left behind.
      expect(() => replaceFile(target, '{"never":true}', () => { throw busy(); })).toThrow(/EPERM/);
      expect(readFileSync(target, 'utf8')).toBe('{"new":true}');
    } else {
      // Elsewhere EPERM is a real permission error: not retried.
      expect(() => replaceFile(target, '{"new":true}', flaky)).toThrow(/EPERM/);
      expect(attempts).toBe(1);
    }
    expect(leftovers()).toEqual([]);
  } finally { dir.cleanup(); }
});
