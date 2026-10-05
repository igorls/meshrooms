// Desktop notifications and the "agents live" notice, for real (desktop-first M5; desktop/src-tauri/src/notify.rs,
// server/notifications.ts): a loopback room service; Alex's browser hosts a room; this machine's person (Robin) is in
// it through the daemon, with one agent of theirs (a fake exec harness that never runs a model) bound to a new session.
// The development build of the app runs in the background against a scratch home folder (HOME and USERPROFILE point
// there, never the real ~/.meshrooms) with MESHROOMS_DEV_NOTIFIED, so every notification it would post is written to a
// file instead, and MESHROOMS_DEV_OPENED, so what a click would open is written too: nothing shows on the desktop but
// the Review window, which the check opens and the app's exit closes.
//
// It checks, in order: the app's start posts one "1 agent live in 1 room" notice once the agent listens; a mention from
// Alex's browser reaches the person device with no local tab open and is posted (room title, sender, the text); plain
// chat is not; clicking the mention opens the local page at the room; the person's presence holds with no tab open
// (the room service gives Alex's browser the app's device as online); clicking the notice opens Review, where Pause
// and Resume work; and when the daemon stops and the app starts it again, one more notice says the agent is back.
//
// Needs `bun run build:bridge` (the development app and this run's daemon use it), the development app (`cargo build`
// in desktop/src-tauri; its path in MESHROOMS_DESKTOP_APP), Playwright with Chromium, and a room service:
//   MESHROOMS_BROWSER_PORT=14336 MESHROOMS_BROWSER_DATA=<scratch> bun run server/browser/main.ts
//   MESHROOMS_BROWSER_TEST_ORIGIN=http://127.0.0.1:14336 MESHROOMS_DESKTOP_APP=<exe> node scripts/notifications-smoke.mjs
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MESHROOMS_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.MESHROOMS_BROWSER_TEST_ORIGIN || 'http://127.0.0.1:14336';
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('Use a loopback room service.');
const app = process.env.MESHROOMS_DESKTOP_APP;
if (!app || !existsSync(app)) throw new Error('Set MESHROOMS_DESKTOP_APP to the development build of the app (cargo build in desktop/src-tauri).');
const script = resolve('packages/meshrooms/bin/meshrooms.js');
if (!existsSync(script)) throw new Error('Build the bridge first (bun run build:bridge): the development app runs it.');
const output = resolve(process.env.MESHROOMS_SMOKE_OUT || '.impeccable/review'); mkdirSync(output, { recursive: true });
const bun = process.env.MESHROOMS_BUN || 'bun';
const bunPath = process.platform === 'win32' ? spawnSync('where', [bun], { encoding: 'utf8' }).stdout.split(/\r?\n/).find(l => l.toLowerCase().endsWith('.exe')) : spawnSync('which', [bun], { encoding: 'utf8' }).stdout.trim();
if (!bunPath) throw new Error('bun was not found on PATH.');

const scratch = mkdtempSync(join(tmpdir(), 'meshrooms-notifications-'));
const notified = join(scratch, 'notified.jsonl'), opened = join(scratch, 'opened.txt'), fake = join(scratch, 'fake-agent.js');
// The agent's harness: a custom command that does nothing (no model ever runs). It is never woken here anyway.
writeFileSync(fake, 'process.exit(0);\n');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MESHROOMS_/i.test(key)));
Object.assign(env, { HOME: scratch, USERPROFILE: scratch, MESHROOMS_LOCAL_PORT: '0' });
const appEnv = { ...env, MESHROOMS_DEV_NOTIFIED: notified, MESHROOMS_DEV_OPENED: opened };
const person = join(scratch, '.meshrooms', 'person'), daemonDir = join(scratch, '.meshrooms', 'daemon');
const bridgeWith = (input, ...args) => {
  const run = spawnSync(bunPath, ['--no-env-file', script, ...args], { env, encoding: 'utf8', timeout: 120_000, cwd: scratch, ...(input === undefined ? {} : { input }) });
  if (run.status !== 0) throw new Error(`${args.join(' ')} failed: ${run.stderr || run.stdout}`);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
};
const bridge = (...args) => bridgeWith(undefined, ...args);
const until = async (look, what, ms = 60_000) => {
  for (const by = Date.now() + ms; Date.now() < by; await new Promise(r => setTimeout(r, 250))) { const seen = await look(); if (seen) return seen; }
  throw new Error(`Timed out waiting for ${what}.`);
};
const endpoint = () => { try { return JSON.parse(readFileSync(join(daemonDir, 'local-api.json'), 'utf8')); } catch { return undefined; } };
const proofOf = api => createHmac('sha256', api.secret).update('meshrooms-local-control').digest('base64url');
const notices = () => existsSync(notified) ? readFileSync(notified, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const openedLines = () => existsSync(opened) ? readFileSync(opened, 'utf8').split('\n').filter(Boolean) : [];

// The app: its stderr is the development trace (notify:, review:, tray status:), kept and searched from a mark.
let shell, said = '', daemon;
const appLog = openSync(join(output, 'notifications-app.log'), 'w'), daemonLog = openSync(join(output, 'notifications-daemon.log'), 'w');
const mark = () => said.length;
const heard = (text, from = 0, ms = 60_000) => until(() => said.indexOf(text, from) >= 0, `the app to say "${text}"`, ms);
const hand = arg => { const run = spawnSync(app, [arg], { env: appEnv, encoding: 'utf8', timeout: 30_000, windowsHide: true }); if (run.error) throw run.error; };
const reviewView = async () => {
  const from = mark();
  hand('--dev-review-view');
  await heard('review view: ', from);
  return JSON.parse(said.slice(said.indexOf('review view: ', from) + 'review view: '.length).split('\n')[0]);
};

const browser = await chromium.launch({ headless: true });
const errors = [], pages = [];
async function page() {
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  const p = await context.newPage(); p.on('pageerror', e => errors.push(e.message)); pages.push(p);
  p.setDefaultTimeout(30_000); return p;
}
try {
  // Alex hosts the room; what the room service tells Alex's browser about the room's devices is kept.
  const alex = await page();
  let seen;
  alex.on('response', async response => {
    if (!response.url().endsWith('/api/lobby') || response.request().method() !== 'POST') return;
    try { const body = await response.json(); if (Array.isArray(body?.devices) && Array.isArray(body?.members)) seen = body; } catch { /* Not a status. */ }
  });
  await alex.goto(`${origin}/rooms`);
  await alex.getByLabel('Your name', { exact: true }).fill('Alex');
  await alex.getByLabel('Room name', { exact: true }).fill('Notify check');
  if (process.env.MESHROOMS_TEST_INVITE) await alex.getByLabel('Invite code', { exact: true }).fill(process.env.MESHROOMS_TEST_INVITE);
  await alex.getByRole('button', { name: 'Create room', exact: true }).click();
  await alex.waitForURL(/\/r\//);
  const roomUrl = alex.url(), roomId = roomUrl.split('/r/')[1];

  // The daemon, with the app's approval routes on (a custom-command agent is made only through them), from the bridge.
  daemon = spawn(bunPath, ['--no-env-file', script, 'daemon', 'run', '--approvals'], { env, stdio: ['ignore', daemonLog, daemonLog], windowsHide: true, cwd: scratch });
  let api = await until(endpoint, 'the daemon\'s local API', 90_000);
  bridge('person', 'init');
  bridgeWith(`${proofOf(api)}\n`, 'person', 'join', roomUrl, '--name', 'Robin');
  await alex.getByRole('button', { name: 'Admit', exact: true }).click();
  const robin = await until(() => bridge('person', 'rooms').find(r => r.roomId === roomId && r.state === 'joined'), 'the person device to be admitted', 90_000);
  const robinId = robin.members.find(m => m.self).id;
  // The agent: made in the app (a custom command), put into the room, admitted by Alex, bound to a new session.
  const call = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${api.port}${path}`, { method, headers: { Authorization: `Bearer ${proofOf(api)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const made = await call('POST', '/api/local/app/agents', { name: 'Wren', harness: 'exec', command: `"${bunPath}" "${fake}" {prompt_file}` });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal((await call('POST', `/api/local/rooms/${roomId}/agents`, { identity: made.body.agent.id })).status, 201);
  await alex.getByRole('button', { name: 'Admit', exact: true }).click();
  const member = await until(async () => (await call('GET', '/api/local/agents')).body.agents[0].rooms[0]?.memberId, 'the agent to be admitted', 90_000);
  await until(async () => (await call('POST', `/api/local/rooms/${roomId}/agents/${member}/bind`, { session: 'new' })).status === 200, 'the agent to be bound', 60_000);
  await until(async () => (await call('GET', '/api/local/agents')).body.agents[0].rooms[0].binding.listening, 'the agent\'s watcher to listen', 120_000);

  // The app starts: once its first read of the feed answers, one notice says who is live.
  shell = spawn(app, ['--background'], { env: appEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  for (const stream of [shell.stdout, shell.stderr]) stream.on('data', chunk => { said += chunk.toString(); writeSync(appLog, chunk); });
  const start = await until(() => notices()[0], 'the agents live notice', 120_000);
  assert.deepEqual(start, { title: '1 agent live in 1 room', body: 'All listening. Click to review them.', target: { kind: 'review' } });

  // Alex chats, then mentions Robin. No local tab is open: the person device is the daemon's.
  await alex.getByRole('combobox', { name: /^Message / }).fill('Morning, everyone.');
  await alex.getByRole('button', { name: 'Send', exact: true }).click();
  await alex.getByRole('combobox', { name: /^Message / }).fill('@Robin can you check the release notes?');
  await alex.getByRole('button', { name: 'Send', exact: true }).click();
  const mention = await until(() => notices().find(n => n.target.kind === 'room'), 'the mention notification', 90_000);
  assert.deepEqual(mention, { title: 'Meshrooms · Notify check', body: 'Alex mentioned you: @Robin can you check the release notes?', target: { kind: 'room', roomId } });
  await new Promise(r => setTimeout(r, 6_000));
  assert.equal(notices().filter(n => n.target.kind === 'room').length, 1, 'plain chat posted nothing');
  // Clicking it opens the local page at the room, through `person open --room`.
  let from = mark();
  hand('--dev-notify-click=last');
  await heard('notify: clicked Room', from);
  const link = await until(() => openedLines()[0], 'the local page at the room');
  assert.match(link, new RegExp(`^http://127\\.0\\.0\\.1:\\d+/r/${roomId}#access=[\\w-]{43}$`));

  // Presence with no tab open: the room service gives Alex's browser the app's device as online (it holds a session).
  await until(() => seen?.devices?.some(d => d.memberId === robinId && d.session), 'Robin\'s device online in Alex\'s browser', 60_000);
  const presence = seen.devices.filter(d => d.memberId === robinId).map(d => ({ online: !!d.session }));

  // Clicking the live notice opens Review: the agent is live; Pause, then Resume.
  from = mark();
  hand('--dev-notify-click=0');
  await heard('notify: clicked Review', from);
  let view = await until(async () => { const v = await reviewView(); return v.loaded && v.agents.length && v; }, 'the Review window to read the agents');
  assert.deepEqual({ name: view.agents[0].name, title: view.agents[0].title, state: view.agents[0].state, canPause: view.agents[0].canPause }, { name: 'Wren', title: 'Notify check', state: 'live', canPause: true });
  hand('--dev-review-pause=0');
  view = await until(async () => { const v = await reviewView(); return v.agents[0]?.state === 'paused' && v; }, 'the agent to be paused', 60_000);
  assert.equal(view.agents[0].reason, 'Paused from the app.');
  hand('--dev-review-resume=0');
  await until(async () => (await reviewView()).agents[0]?.state === 'live', 'the agent to be live again', 90_000);

  // The daemon stops; the app starts it again (no tray hold), and says once more who is back.
  const before = notices().length;
  bridge('daemon', 'stop');
  daemon = undefined;
  const back = await until(() => notices().slice(before).find(n => n.target.kind === 'review'), 'the notice after the daemon came back', 240_000);
  assert.deepEqual(back, { title: '1 agent live in 1 room', body: 'All listening. Click to review them.', target: { kind: 'review' } });
  api = endpoint();

  // With MESHROOMS_SMOKE_REAL_TOAST=1: the last notice once more as a real one, through the real path (one toast on
  // this desktop).
  if (process.env.MESHROOMS_SMOKE_REAL_TOAST === '1') {
    from = mark();
    hand('--dev-notify-real');
    await heard('notify: toast shown', from, 20_000);
  }

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, room: roomId.slice(0, 8), notices: notices().map(n => n.title), presence }));
} catch (error) {
  console.error(error);
  console.error('notices:', JSON.stringify(notices()));
  console.error(said.split('\n').filter(line => /^(notify|review|dev action|tray status)/.test(line)).slice(-40).join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  shell?.kill();
  // The daemon (this run's, or the one the app started) and the runners are stopped here.
  try { bridge('daemon', 'stop'); } catch { /* Not running. */ }
  daemon?.kill();
  const rooms = [join(person, 'browser-agents'), ...(existsSync(join(person, 'agents')) ? readdirSync(join(person, 'agents')).map(id => join(person, 'agents', id, 'browser-agents')) : [])];
  for (const base of rooms) for (const room of existsSync(base) ? readdirSync(base) : []) {
    for (const file of ['runner-alive.json']) try { process.kill(JSON.parse(readFileSync(join(base, room, file), 'utf8')).pid); } catch { /* Gone already. */ }
    for (const file of ['runner.pid', 'watch.pid']) try { process.kill(Number(readFileSync(join(base, room, file), 'utf8'))); } catch { /* Gone already. */ }
  }
  await new Promise(r => setTimeout(r, 1000));
  if (process.env.MESHROOMS_SMOKE_KEEP === '1') console.error(`kept ${scratch}`);
  else try { rmSync(scratch, { recursive: true, force: true }); } catch { /* A runner still closing; the folder is in the temp folder. */ }
}
