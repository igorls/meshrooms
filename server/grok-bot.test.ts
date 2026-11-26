/**
 * `grok setup|check|keepalive|wake`: a Grok Bot woken through its webhook routine. The webhook is a local mock server and the room
 * a fake peek sequence, so nothing here reaches a real routine or room. Asserted: the key is sent only in the
 * Authorization header and never comes back in a result, room text never goes into the body, the exit codes match what
 * the watcher counts, the 0600 file is refused when anyone else could read it, and the setup page takes one submission
 * from itself only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentCli } from './agent-cli';
import { HOME_SECRETS } from './agent-watch';
import { GROK_DIR, GROK_EXIT, grokKeepalive, grokPing, grokSetup, grokWake, grokWakeGuard, grokWebhookFile, normalizeKey, readGrokWebhook, webhookUrlProblem, writeGrokWebhook, volatileAgentHome, type GrokKeepaliveDeps, type GrokRoomHealth, type PeekLike } from './grok-bot';

/** Synthetic fixtures. Never a real room id or key. */
const ROOM = '00000000-0000-4000-8000-000000000001';
const OTHER_ROOM = '00000000-0000-4000-8000-000000000002';
const KEY = 'test-key-not-a-real-secret-0123456789';
const posix = process.platform !== 'win32';

const folders: string[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'meshrooms-grok-')); folders.push(dir); return dir; };
afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A mock webhook: answers with the statuses given in order (the last repeats), and records every request. */
function mockWebhook(statuses: number[] = [200]) {
  const requests: { authorization: string | null; body: any }[] = [];
  let i = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push({ authorization: request.headers.get('authorization'), body: await request.json() });
    return new Response('{}', { status: statuses[Math.min(i++, statuses.length - 1)] });
  } });
  return { url: `http://127.0.0.1:${server.port}/hooks/routine`, requests, stop: () => server.stop(true) };
}
/** A room that has `work` until the routine's listen moves the cursor, after `readAfter` polls (never, when undefined). */
function fakeRoom(options: { work?: boolean; admitted?: boolean; readAfter?: number; clearAfter?: number } = {}) {
  let polls = 0, cursor = '{"after":"m1","boardAfter":0,"decisionsAfter":0}';
  const peek = (): PeekLike => ({ admitted: options.admitted ?? true, work: options.clearAfter !== undefined && polls >= options.clearAfter ? false : options.work ?? true,
    addressed: ['secret message text that must stay in the room'], tasks: ['t1', 't2'], decisions: [] });
  return { peek, cursor: () => { polls++; if (options.readAfter !== undefined && polls > options.readAfter) cursor = '{"after":"m2","boardAfter":0,"decisionsAfter":0}'; return cursor; } };
}
/** A clock the sleeps advance, so a ten-minute timeout runs in no time. */
const clock = () => { let t = 1_700_000_000_000; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };

describe('grok — the webhook it accepts', () => {
  test('https, or http only to this machine; no credentials in the URL', () => {
    expect(webhookUrlProblem('https://hooks.example/r/abc')).toBeUndefined();
    expect(webhookUrlProblem('http://127.0.0.1:9/x')).toBeUndefined();
    expect(webhookUrlProblem('http://hooks.example/r/abc')).toContain('https');
    expect(webhookUrlProblem('https://user:pw@hooks.example/x')).toContain('user name');
    expect(webhookUrlProblem('not a url')).toBeDefined();
    expect(webhookUrlProblem('')).toBeDefined();
  });
  test('the key, or the header line the routine panel offers to copy', () => {
    expect(normalizeKey(KEY)).toBe(KEY);
    expect(normalizeKey(`Bearer ${KEY}`)).toBe(KEY);
    expect(normalizeKey(`Authorization: Bearer ${KEY}\n`)).toBe(KEY);
    expect(normalizeKey('two words')).toBeUndefined();
    expect(normalizeKey('')).toBeUndefined();
    expect(normalizeKey(undefined)).toBeUndefined();
  });
  test('the file is written 0600 and read back; a readable, linked or malformed one is refused', () => {
    const dir = scratch(), file = join(dir, 'grok', 'webhook.json');
    writeGrokWebhook(file, { url: 'https://hooks.example/r/abc', key: `Bearer ${KEY}` });
    if (posix) expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readGrokWebhook(file)).toEqual({ url: 'https://hooks.example/r/abc', key: KEY });
    if (posix) {
      chmodSync(file, 0o644);
      expect(() => readGrokWebhook(file)).toThrow(/other users/);
      chmodSync(file, 0o600);
      const link = join(dir, 'link.json'); symlinkSync(file, link);
      expect(() => readGrokWebhook(link)).toThrow(/regular file/);
      expect(() => readGrokWebhook(file, 'linux', (process.getuid?.() ?? 0) + 1)).toThrow(/another user/);
    }
    const bad = join(dir, 'bad.json'); writeFileSync(bad, JSON.stringify({ version: 1, url: 'http://hooks.example/x', key: KEY }), { mode: 0o600 });
    expect(() => readGrokWebhook(bad)).toThrow(/https/);
    expect(() => readGrokWebhook(join(dir, 'missing.json'))).toThrow(/grok setup/);
  });
  test('bots on the same box get separate webhook files from their agent homes', () => {
    expect(grokWebhookFile('/home/example', { MESHROOMS_AGENT_HOME: '/home/example/bot-a' })).not.toBe(grokWebhookFile('/home/example', { MESHROOMS_AGENT_HOME: '/home/example/bot-b' }));
  });
  test('its folder is one every other harness\'s wake is denied', () => {
    expect(HOME_SECRETS).toContain(GROK_DIR);
  });
});

describe('grok wake — what the watcher sees', () => {
  test('posts once with the key in the header and counts in the body, then succeeds when the routine reads the room', async () => {
    const hook = mockWebhook(), room = fakeRoom({ readAfter: 3 }), time = clock();
    try {
      const result = await grokWake({ room: ROOM, webhook: { url: hook.url, key: KEY }, ...room, ...time, pollMs: 5_000 });
      expect(result.state).toBe('handled');
      expect(result.exitCode).toBe(GROK_EXIT.ok);
      expect(hook.requests).toHaveLength(1);
      expect(hook.requests[0].authorization).toBe(`Bearer ${KEY}`);
      const body = hook.requests[0].body;
      expect(body).toMatchObject({ source: 'meshrooms', event: 'room-has-work', room: ROOM, work: { messages: 1, tasks: 2, decisions: 0 } });
      // Room text stays in the room, and the key goes only in the header.
      expect(JSON.stringify(body)).not.toContain('secret message');
      expect(JSON.stringify(body)).not.toContain(KEY);
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect(result.webhookHost).toBe(new URL(hook.url).host);
    } finally { hook.stop(); }
  });

  test('nothing read the room in time: exit 2, so the watcher backs off and pauses as for any harness', async () => {
    const hook = mockWebhook(), time = clock();
    try {
      const result = await grokWake({ room: ROOM, webhook: { url: hook.url, key: KEY }, ...fakeRoom(), ...time, timeoutMs: 10 * 60_000, pollMs: 5_000 });
      expect(result.state).toBe('timeout');
      expect(result.exitCode).toBe(GROK_EXIT.timeout);
      expect(result.waitedSeconds).toBe(600);
      expect(hook.requests).toHaveLength(1);
    } finally { hook.stop(); }
  });

  test('no work: no post at all; not admitted: a failure, with no post', async () => {
    const hook = mockWebhook();
    try {
      expect((await grokWake({ room: ROOM, webhook: { url: hook.url, key: KEY }, ...fakeRoom({ work: false }), ...clock() })).state).toBe('no-work');
      const out = await grokWake({ room: ROOM, webhook: { url: hook.url, key: KEY }, ...fakeRoom({ admitted: false }), ...clock() });
      expect(out.state).toBe('not-admitted');
      expect(out.exitCode).toBe(GROK_EXIT.failed);
      expect(hook.requests).toHaveLength(0);
    } finally { hook.stop(); }
  });

  test('work that went away without a read (a deleted message) ends the wait', async () => {
    const hook = mockWebhook();
    try {
      const out = await grokWake({ room: ROOM, webhook: { url: hook.url, key: KEY }, ...fakeRoom({ clearAfter: 3 }), ...clock() });
      expect(out.state).toBe('cleared');
      expect(out.exitCode).toBe(GROK_EXIT.ok);
    } finally { hook.stop(); }
  });

  test('a refused key is not retried; a busy service is, and then the wake goes on', async () => {
    const refused = mockWebhook([401]);
    try {
      const out = await grokWake({ room: ROOM, webhook: { url: refused.url, key: KEY }, ...fakeRoom({ readAfter: 1 }), ...clock(), retryMs: 1 });
      expect(out.state).toBe('rejected');
      expect(out.status).toBe(401);
      expect(out.message).toContain('key');
      expect(out.exitCode).toBe(GROK_EXIT.failed);
      expect(refused.requests).toHaveLength(1);
    } finally { refused.stop(); }
    const busy = mockWebhook([503, 429, 200]);
    try {
      const out = await grokWake({ room: ROOM, webhook: { url: busy.url, key: KEY }, ...fakeRoom({ readAfter: 1 }), ...clock(), retryMs: 1 });
      expect(out.state).toBe('handled');
      expect(busy.requests).toHaveLength(3);
    } finally { busy.stop(); }
  });

  test('an unreachable webhook fails, and its error never carries the key', async () => {
    const out = await grokWake({ room: ROOM, webhook: { url: 'https://hooks.example/r', key: KEY }, ...fakeRoom(), ...clock(), retryMs: 1,
      fetch: async () => { throw new Error(`connect failed for Bearer ${KEY}`); } });
    expect(out.state).toBe('unreachable');
    expect(out.exitCode).toBe(GROK_EXIT.failed);
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(out.message).toContain('network error');
  });

  test('check --ping posts a test event the routine can tell apart', async () => {
    const hook = mockWebhook();
    try {
      const out = await grokPing({ url: hook.url, key: KEY });
      expect(out.pinged).toBe(true);
      expect(hook.requests[0].body.event).toBe('test');
      expect(JSON.stringify(out)).not.toContain(KEY);
    } finally { hook.stop(); }
  });
});

describe('grok setup — the one-time page', () => {
  test('serves the form at its secret path only, takes a POST from itself only, and writes the file 0600', async () => {
    const file = join(scratch(), 'grok', 'webhook.json');
    let announced: any;
    const done = grokSetup({ file, timeoutMs: 30_000, announce: line => { announced = line; } });
    while (!announced) await Bun.sleep(5);
    const page = new URL(announced.setupUrl), origin = page.origin;
    expect(page.hostname).toBe('127.0.0.1');
    expect((await fetch(`${origin}/setup/guess`)).status).toBe(404);
    const form = await fetch(page);
    expect(form.status).toBe(200);
    const html = await form.text();
    expect(html).toContain('name="url"');
    expect(html).toContain('type="password"');
    const body = new URLSearchParams({ url: 'https://hooks.example/r/abc', key: `Authorization: Bearer ${KEY}` });
    // Another site in the same browser can't submit it.
    expect((await fetch(page, { method: 'POST', body, headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await fetch(page, { method: 'POST', body, headers: { origin, 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await fetch(page, { method: 'POST', body })).status).toBe(403);
    expect((await fetch(page, { method: 'POST', body: new URLSearchParams({ url: 'http://hooks.example/x', key: KEY }), headers: { origin } })).status).toBe(400);
    const saved = await fetch(page, { method: 'POST', body, headers: { origin } });
    expect(saved.status).toBe(200);
    const result = await done;
    expect(result).toEqual({ saved: true, file, webhookHost: 'hooks.example' });
    expect(readGrokWebhook(file)).toEqual({ url: 'https://hooks.example/r/abc', key: KEY });
    if (posix) expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(announced)).not.toContain(KEY);
  });

  test('gives up when nothing is submitted', async () => {
    const result = await grokSetup({ file: join(scratch(), 'w.json'), timeoutMs: 50, announce: () => {} });
    expect(result.saved).toBe(false);
  });
});

describe('grok — wake mode', () => {
  const env = { MESHROOMS_WAKE_ROOM: ROOM, MESHROOMS_WAKE_DIR: '/tmp' };
  test('only grok wake, for the wake\'s own room', () => {
    expect(grokWakeGuard('wake', { '--room': ROOM }, env)).toBe('/tmp');
    expect(() => grokWakeGuard('wake', { '--room': OTHER_ROOM }, env)).toThrow(ROOM);
    for (const sub of ['setup', 'check', 'keepalive', undefined]) expect(() => grokWakeGuard(sub, {}, env)).toThrow(/isn't available/);
    expect(grokWakeGuard('setup', {}, {})).toBeUndefined();
  });
  test('the refusals hold at the real CLI entry', async () => {
    const refuse = async (argv: string[]) => {
      const saved = { ...process.env };
      try { Object.assign(process.env, env); await agentCli(argv); return undefined; }
      catch (error) { return error instanceof Error ? error.message : String(error); }
      finally { for (const key of Object.keys(env)) delete process.env[key]; Object.assign(process.env, saved); }
    };
    expect(await refuse(['grok', 'setup'])).toContain("isn't available");
    expect(await refuse(['grok', 'check', '--ping'])).toContain("isn't available");
    expect(await refuse(['grok', 'wake', '--room', OTHER_ROOM])).toContain(`use --room ${ROOM}`);
  });
  test('check names the host and never the key', async () => {
    const file = join(scratch(), 'webhook.json');
    writeGrokWebhook(file, { url: 'https://hooks.example/r/abc', key: KEY });
    const out = await agentCli(['grok', 'check', '--webhook-file', file]);
    expect(out).toEqual({ ok: true, file, webhookHost: 'hooks.example' });
  });
});

describe('grok keepalive', () => {
  const healthy: GrokRoomHealth = { roomId: ROOM, title: 'Design review', wakes: 'on', runner: true };
  /** Fake deps on a fake clock: the daemon's answer, the rooms each read returns (the last repeats), the webhook. */
  const deps = (options: { daemon?: { running: boolean; started: boolean } | Error; rooms?: GrokRoomHealth[][]; webhook?: string; home?: string; bun?: string } = {}) => {
    let now = 0, reads = 0, slept = 0;
    const d: GrokKeepaliveDeps = {
      agentHome: options.home ?? '/home/me/.meshrooms/agents-grokky',
      startDaemon: async () => { if (options.daemon instanceof Error) throw options.daemon; return options.daemon ?? { running: true, started: false }; },
      rooms: () => { const all = options.rooms ?? [[healthy]]; return all[Math.min(reads++, all.length - 1)]; },
      webhookProblem: () => options.webhook, bunVersion: options.bun ?? '1.4.4',
      now: () => now, sleep: async ms => { now += ms; slept += ms; },
    };
    return { d, slept: () => slept, reads: () => reads };
  };

  test('a daemon already running, a room with wakes on and a saved webhook: ok, exit 0, nothing to tell, no waiting', async () => {
    const f = deps();
    const result = await grokKeepalive(f.d, '/tmp');
    expect(result).toMatchObject({ ok: true, exitCode: GROK_EXIT.ok, daemon: { running: true, started: false }, webhook: 'ok', attention: [] });
    expect(f.slept()).toBe(0);
  });

  test('after a box restart the daemon it starts gets a moment to bring the rooms back before they are reported', async () => {
    const down = { ...healthy, runner: false };
    const f = deps({ daemon: { running: true, started: true }, rooms: [[down], [down], [down], [healthy]] });
    const result = await grokKeepalive(f.d, '/tmp');
    expect(result).toMatchObject({ ok: true, daemon: { started: true }, rooms: [healthy] });
    expect(f.slept()).toBe(3_000);
    // A room that never comes back is reported once the moment is over.
    const never = deps({ daemon: { running: true, started: true }, rooms: [[down]] });
    const late = await grokKeepalive({ ...never.d, settleMs: 5_000 }, '/tmp');
    expect(late.ok).toBe(false);
    expect(late.attention).toEqual(["The connection to \"Design review\" isn't up yet."]);
    expect(never.slept()).toBe(5_000);
  });

  test('what needs the person is said in words, by room title, never with a room id, a path or the webhook', async () => {
    const f = deps({ webhook: 'none is saved', home: '/workspace/build/agents-grokky', bun: '1.3.9', rooms: [[
      { ...healthy, wakes: 'paused', reason: 'harness did not respond' },
      { roomId: OTHER_ROOM, title: 'Old', wakes: 'on', runner: true, closed: true },
      { roomId: OTHER_ROOM, title: null, wakes: 'unbound', runner: true },
    ]] });
    const result = await grokKeepalive(f.d, '/tmp');
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(GROK_EXIT.failed);
    expect(result.webhook).toBe('problem');
    expect(result.attention).toEqual([
      "The wake routine's webhook can't be used (none is saved); run grok setup again.",
      'Wakes in "Design review" are paused: harness did not respond.',
      'The room "Old" was closed; leave it (unbind, stop) and take it out of the wake routine.',
      'Wakes in one room are unbound.',
      'The agent folder is in a temporary or build folder that can be cleared, which would lose this agent; move it under ~/.meshrooms.',
      'Bun 1.3.9 is older than 1.4.2; run bun upgrade.',
    ]);
    for (const line of result.attention) { expect(line).not.toContain(ROOM); expect(line).not.toContain(OTHER_ROOM); expect(line).not.toContain('/workspace'); }
  });

  test('a running daemon that does not look after this agent folder is reported, never ok', async () => {
    const result = await grokKeepalive({ ...deps().d, startDaemon: async () => ({ running: true, started: false, supervisesAgentHome: false }) }, '/tmp');
    expect(result.ok).toBe(false);
    expect(result.attention).toEqual(["The machine's Meshrooms daemon does not look after this agent folder; run connect for it again so the daemon takes it on."]);
  });

  test('a daemon that will not start, or an agent in no room, is reported, never ok', async () => {
    const failed = await grokKeepalive(deps({ daemon: new Error('The daemon did not start.\nmore detail') }).d, '/tmp');
    expect(failed).toMatchObject({ ok: false, daemon: { running: false }, attention: ['The Meshrooms daemon would not start: The daemon did not start.'] });
    const alone = await grokKeepalive(deps({ rooms: [[]] }).d, '/tmp');
    expect(alone).toMatchObject({ ok: false, attention: ['This agent is in no room yet.'] });
  });

  test('an agent folder in a folder that gets cleared is told apart from one that persists', () => {
    expect(volatileAgentHome('/home/me/.meshrooms/agents-grokky', '/tmp')).toBe(false);
    expect(volatileAgentHome('/workspace/scratch/agents', '/tmp')).toBe(false);
    for (const home of ['/workspace/dist/agents', '/workspace/.cache/m', '/home/me/project/target/x', '/tmp/agents', '/var/x/tmp/a']) expect(volatileAgentHome(home, '/tmp')).toBe(true);
    expect(volatileAgentHome('/tmpfoo/agents', '/tmp')).toBe(false);
  });
});
