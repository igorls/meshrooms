// The desktop-first local UI, for real: a loopback room service, a browser that hosts a room, and this machine's person
// device (the daemon, run in the foreground from this checkout) joined to it and admitted by the host. The page the
// daemon serves on 127.0.0.1 then shows the room, sends, reacts and adds a task, and the host's browser sees each.
//
// Everything of the person and the daemon lives in a scratch home folder (HOME and USERPROFILE point there), never the
// real ~/.meshrooms. Needs `bun run build` (the daemon serves dist/), Playwright with Chromium, and a room service:
//   MESHROOMS_BROWSER_PORT=14332 bun run server/browser/main.ts
//   MESHROOMS_BROWSER_TEST_ORIGIN=http://127.0.0.1:14332 node scripts/local-ui-smoke.mjs
//
// MESHROOMS_SMOKE_BRIDGE=<folder> runs a release instead: the desktop app's bridge bundle (bun, meshrooms.js, ui/;
// `bun run desktop:bridge`) or the npm package (packages/meshrooms). Its commands run as the app runs them, and the
// daemon starts as the app starts it (`daemon start`): installed into the scratch ~/.meshrooms/bin, with its UI beside it,
// verified against the hashes in the bundle and served from memory.
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MESHROOMS_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.MESHROOMS_BROWSER_TEST_ORIGIN || 'http://127.0.0.1:14332';
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('Use a loopback room service.');
const release = process.env.MESHROOMS_SMOKE_BRIDGE ? resolve(process.env.MESHROOMS_SMOKE_BRIDGE) : undefined;
const script = release ? [join(release, 'meshrooms.js'), join(release, 'bin', 'meshrooms.js')].find(existsSync) : undefined;
if (release && !script) throw new Error(`No meshrooms.js in ${release}.`);
const dist = resolve('dist');
if (!release && !existsSync(join(dist, 'index.html'))) throw new Error('Build the UI first (bun run build): the daemon serves dist/.');
const output = resolve('.impeccable/review'); mkdirSync(output, { recursive: true });
const bundledBun = release && [join(release, 'bun.exe'), join(release, 'bun')].find(existsSync);
const bun = process.env.MESHROOMS_BUN || bundledBun || 'bun';
// The bridge as it runs: a release's bundle with --no-env-file (as the app runs it), or this checkout's source.
const bridge = script ? ['--no-env-file', script] : ['server/agent-cli.ts'];

// The person's whole world, in a folder of this run's own.
const scratch = mkdtempSync(join(tmpdir(), 'meshrooms-local-ui-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MESHROOMS_/i.test(key)));
Object.assign(env, { HOME: scratch, USERPROFILE: scratch, MESHROOMS_LOCAL_PORT: '0', ...(release ? {} : { MESHROOMS_LOCAL_UI_DIR: dist }) });
const person = join(scratch, '.meshrooms', 'person'), daemonDir = join(scratch, '.meshrooms', 'daemon');
const cli = (...args) => cliWith(undefined, ...args);
/** With stdin: `person join` takes the app's proof (the running daemon's control token) on its first line, as the app sends it. */
const cliWith = (input, ...args) => {
  const run = spawnSync(bun, [...bridge, ...args], { env, encoding: 'utf8', timeout: 90_000, cwd: release ? scratch : undefined, ...(input === undefined ? {} : { input }) });
  if (run.status !== 0) throw new Error(`${args.join(' ')} failed: ${run.stderr || run.stdout}`);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
};
const until = async (look, what, ms = 60_000) => {
  for (const by = Date.now() + ms; Date.now() < by; await new Promise(r => setTimeout(r, 250))) { const seen = await look(); if (seen) return seen; }
  throw new Error(`Timed out waiting for ${what}.`);
};

const browser = await chromium.launch({ headless: true });
const errors = [];
let daemon;
const pages = [];
const log = openSync(join(output, 'local-ui-daemon.log'), 'w');
async function page(viewport = { width: 1365, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const p = await context.newPage(); p.on('pageerror', e => errors.push(e.message)); pages.push(p);
  p.setDefaultTimeout(30_000); return p;
}
const visible = (p, text) => p.getByText(text, { exact: true }).first().waitFor();
const flat = text => text.replace(/\s+/g, ' ').trim();
const visibleMessage = (p, text) => p.waitForFunction(t => [...document.querySelectorAll('.message-text')].some(el => el.innerText.replace(/\s+/g, ' ').trim() === t), flat(text), { timeout: 45_000 });
async function send(p, text) { await p.getByRole('combobox', { name: /^Message / }).fill(text); await p.getByRole('button', { name: 'Send', exact: true }).click(); }
async function snapshot(p, name) { await p.screenshot({ path: resolve(output, name), fullPage: true, animations: 'disabled' }); }
try {
  // The host: a browser on the hosted site, as anyone would use it.
  const host = await page();
  await host.goto(`${origin}/rooms`);
  await host.getByLabel('Your name', { exact: true }).fill('Alex');
  await host.getByLabel('Room name', { exact: true }).fill('Local UI check');
  if (process.env.MESHROOMS_TEST_INVITE) await host.getByLabel('Invite code', { exact: true }).fill(process.env.MESHROOMS_TEST_INVITE);
  await host.getByRole('button', { name: 'Create room', exact: true }).click();
  await host.waitForURL(/\/r\//); const roomUrl = host.url(), roomId = roomUrl.split('/r/')[1];

  // The person device: the daemon (a release's as the app starts it, else in the foreground from this checkout), then
  // person init and join.
  if (release) cli('daemon', 'start');
  else daemon = spawn(bun, [...bridge, 'daemon', 'run'], { env, stdio: ['ignore', log, log], windowsHide: true });
  const api = await until(() => { try { return JSON.parse(readFileSync(join(daemonDir, 'local-api.json'), 'utf8')); } catch { return undefined; } }, 'the daemon\'s local API');
  assert.equal(new URL(api.url).hostname, '127.0.0.1');
  if (release) {
    // Installed beside the bundle the daemon runs from, and served from there only once verified.
    const version = cli('version').version, installed = join(scratch, '.meshrooms', 'bin', `ui-${version}`);
    assert.ok(existsSync(join(installed, 'index.html')), `The UI was not installed into ${installed}.`);
    await until(() => readFileSync(join(daemonDir, 'daemon.log'), 'utf8').includes('serving the verified UI'), 'the daemon to serve the verified UI');
  }
  cli('person', 'init');
  // Joining is the app's (its window asks first): a bare join is refused, and the app's proof lets it through.
  assert.throws(() => cliWith('', 'person', 'join', roomUrl, '--name', 'Robin'), /Join rooms from the Meshrooms app/);
  const proof = createHmac('sha256', api.secret).update('meshrooms-local-control').digest('base64url');
  const joined = cliWith(`${proof}\n`, 'person', 'join', roomUrl, '--name', 'Robin');
  assert.equal(joined.roomId, roomId);
  await host.getByRole('button', { name: 'Admit', exact: true }).click();
  await until(() => cli('person', 'rooms').some(r => r.roomId === roomId && r.state === 'joined'), 'the person device to be admitted');
  // Messages go to the devices in the room when they are sent: this one reaches the person device with no page open.
  await visible(host, 'Connected to 1 other device');
  const before = 'Written before the page opened';
  await send(host, before); await visible(host, 'Stored on 1 of 1 devices');

  // The local page, opened as the tray's Open Meshrooms does: a one-time link from person open.
  const { url } = cli('person', 'open');
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/#access=[\w-]{43}$/);
  const local = await page();
  // Every request the local page makes, pages, scripts, fonts, pictures and API calls alike, for the check below.
  const requests = [];
  local.on('request', request => requests.push(request.url()));
  const ownOrigin = () => {
    const page = new URL(url).origin, elsewhere = requests.filter(u => !u.startsWith('blob:') && !u.startsWith('data:') && new URL(u).origin !== page);
    assert.deepEqual(elsewhere, [], 'The local page talks to its own origin (127.0.0.1:<port>) only.');
  };
  await local.goto(url);
  // The ticket is spent and gone from the address; the page lists the room.
  await local.waitForURL(u => !u.hash && u.pathname === '/rooms');
  await local.getByRole('link', { name: /Local UI check/ }).first().click();
  await local.waitForURL(new RegExp(`/r/${roomId}$`));
  await visibleMessage(local, before);
  await visible(local, 'Connected to 1 other device');
  ownOrigin();
  assert.ok(requests.some(u => u.includes('/api/local/rooms/')) && requests.some(u => u.includes('/assets/')));
  await snapshot(local, 'local-ui-room.png');

  // Sent from the local page: the person device signs it, and the host's browser receives it peer to peer.
  const hello = 'Hello from the app on this computer';
  await send(local, hello);
  await visibleMessage(local, hello);
  await visibleMessage(host, hello);
  // And the other way: the host's message arrives on the local page through the person device.
  const reply = 'The browser hears the app';
  await send(host, reply);
  await visibleMessage(local, reply);

  // A reaction from the local page reaches the host.
  const target = local.locator('article.browser-message', { has: local.locator('.message-text', { hasText: reply }) });
  await target.hover();
  await target.getByRole('button', { name: /^Add a reaction to/ }).click();
  await target.getByRole('option').first().click();
  const emoji = await target.locator('.browser-reaction span[aria-hidden="true"]').first().innerText({ timeout: 20_000 });
  const hosted = host.locator('article.browser-message', { has: host.locator('.message-text', { hasText: reply }) });
  await hosted.locator('.browser-reaction', { hasText: emoji }).waitFor({ timeout: 45_000 });

  // A task added on the local page reaches the host's board.
  const task = 'Ship the local UI';
  await local.getByRole('button', { name: /^Tasks/ }).click();
  await local.locator('#task-title').fill(task);
  await local.getByRole('button', { name: 'Add', exact: true }).click();
  await local.locator('.task-board .task-title', { hasText: task }).waitFor({ timeout: 30_000 });
  await host.getByRole('button', { name: /^Tasks/ }).click();
  await host.locator('.task-board .task-title', { hasText: task }).waitFor({ timeout: 45_000 });
  // A file attached on the local page: uploaded to the person device, which signs the message and serves the file.
  await local.locator('input[type=file][multiple]').setInputFiles({ name: 'local-note.txt', mimeType: 'text/plain', buffer: Buffer.from('From the app on this computer.\n') });
  await local.getByRole('button', { name: 'Send', exact: true }).click();
  await local.locator('a.attachment-file', { hasText: 'local-note.txt' }).waitFor({ timeout: 30_000 });
  await host.locator('a.attachment-file', { hasText: 'local-note.txt' }).waitFor({ timeout: 45_000 });
  // A decision opened on the local page: the host votes and the local page counts it, then the local page votes.
  await local.getByRole('button', { name: 'Decide', exact: true }).click();
  await local.locator('#decision-question').fill('Ship the local UI?');
  await local.getByLabel('Option 1', { exact: true }).fill('Yes');
  await local.getByLabel('Option 2', { exact: true }).fill('Not yet');
  await local.getByRole('button', { name: 'Ask the room', exact: true }).click();
  const option = (p, label) => p.getByRole('article', { name: 'Decision: Ship the local UI?' }).locator('.browser-decision-options button', { hasText: label });
  await option(host, 'Yes').click({ timeout: 45_000 });
  await option(local, 'Yes').locator('.browser-decision-count', { hasText: '1' }).waitFor({ timeout: 45_000 });
  await option(local, 'Not yet').click();
  await option(host, 'Not yet').locator('.browser-decision-count', { hasText: '1' }).waitFor({ timeout: 45_000 });
  await snapshot(local, 'local-ui-after.png'); await snapshot(host, 'local-ui-host.png');

  // Host actions, signed by the person device: in a second room it is a device of the host's own (a companion the host
  // confirms with its code), so the local page admits a guest and changes a setting there.
  await host.goto(`${origin}/rooms`);
  await host.getByLabel('Room name', { exact: true }).fill('Local host check');
  await host.getByRole('button', { name: 'Create room', exact: true }).click();
  await host.waitForURL(/\/r\//); const hostedUrl = host.url(), hostedId = hostedUrl.split('/r/')[1];
  cli('person', 'companion', hostedUrl);
  const code = await until(() => cli('person', 'rooms').find(r => r.roomId === hostedId && r.code)?.code, 'the companion code');
  await host.getByRole('button', { name: 'Room details', exact: true }).click();
  await host.locator('summary', { hasText: 'Add another device' }).click();
  await host.getByLabel('Device code', { exact: true }).fill(code);
  await host.getByRole('button', { name: 'Approve my device', exact: true }).click();
  await until(() => cli('person', 'rooms').some(r => r.roomId === hostedId && r.state === 'joined'), 'the companion to be admitted');
  await local.goto(`${new URL(url).origin}/r/${hostedId}`);
  await visible(local, 'Room host');
  const guest = await page({ width: 390, height: 844 });
  await guest.goto(hostedUrl);
  await guest.getByLabel('Your name', { exact: true }).fill('Sam');
  await guest.getByRole('button', { name: 'Ask to join', exact: true }).click();
  await local.getByRole('button', { name: 'Admit', exact: true }).click({ timeout: 45_000 });
  await guest.getByRole('combobox', { name: /^Message / }).waitFor({ timeout: 45_000 });
  await local.locator('.browser-requests').waitFor({ state: 'detached', timeout: 20_000 });
  await visible(local, '2 people in this room');
  await local.getByRole('button', { name: 'Room details', exact: true }).click();
  const handOff = local.locator('label.browser-setting', { hasText: 'Agents can hand tasks to each other' }).locator('input');
  await handOff.click();
  await visible(local, 'Agents can now hand tasks to each other.');
  await until(async () => { await host.reload(); await host.getByRole('button', { name: 'Room details', exact: true }).click();
    return host.locator('label.browser-setting', { hasText: 'Agents can hand tasks to each other' }).locator('input').isChecked(); }, 'the setting to reach the host', 45_000);
  await snapshot(local, 'local-ui-host-actions.png');

  // After everything above (rooms, files, pictures, decisions, host actions), still nothing but its own origin.
  ownOrigin();

  // The token belongs to this page: a fresh page without a ticket is not signed in.
  const stranger = await page();
  await stranger.goto(`${new URL(url).origin}/rooms`);
  await stranger.getByText('to sign in on this browser').first().waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, room: roomId.slice(0, 8), localApi: new URL(url).origin }));
} catch (error) {
  console.error(error);
  // What each page showed, for whoever reads the failure.
  for (const [i, p] of pages.entries()) {
    await p.screenshot({ path: resolve(output, `local-ui-failure-${i}.png`), fullPage: true }).catch(() => {});
    console.error(`page ${i} (${p.url()}): ${(await p.locator('body').innerText().catch(() => '')).slice(0, 1500)}`);
  }
  if (errors.length) console.error('page errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  daemon?.kill();
  if (release) try { cli('daemon', 'stop'); } catch (error) { console.error(error); }
  // The runners the daemon started outlive it by design; this run's are stopped by their proof of life.
  for (const room of existsSync(join(person, 'browser-agents')) ? readdirSync(join(person, 'browser-agents')) : []) {
    try { process.kill(JSON.parse(readFileSync(join(person, 'browser-agents', room, 'runner-alive.json'), 'utf8')).pid); } catch { /* Gone already. */ }
  }
  await new Promise(r => setTimeout(r, 1000));
  if (process.env.MESHROOMS_SMOKE_KEEP === '1') console.error(`kept ${scratch}`);
  else try { rmSync(scratch, { recursive: true, force: true }); } catch { /* A runner still closing; the folder is in the temp folder. */ }
}
