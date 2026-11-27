// History after desktop pairing (docs/flows/history-replication.md), for real: a loopback room service; Alex's browser
// hosts a room; Robin's browser joins it, and both talk; Robin also talks in a room of her own. Then Robin pairs this
// machine's person device (the daemon, in the foreground from this checkout), as in scripts/pairing-smoke.mjs. The page
// the daemon serves must show both rooms' earlier messages: Robin was a member when they were sent, and a newly linked
// device of hers receives her member's history. A message sent after pairing must arrive too. Then Casey joins Alex's
// room with history for newcomers off, and must see none of the earlier messages.
//
// Everything of the person and the daemon lives in a scratch home folder (HOME and USERPROFILE point there), never the
// real ~/.meshrooms. Needs `bun run build`, Playwright with Chromium, and a room service built from this checkout:
//   MESHROOMS_BROWSER_PORT=14340 bun run server/browser/main.ts
//   MESHROOMS_BROWSER_TEST_ORIGIN=http://127.0.0.1:14340 node scripts/history-pairing-smoke.mjs
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MESHROOMS_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.MESHROOMS_BROWSER_TEST_ORIGIN || 'http://127.0.0.1:14340';
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('Use a loopback room service.');
const dist = resolve('dist');
if (!existsSync(join(dist, 'index.html'))) throw new Error('Build the UI first (bun run build): the daemon serves dist/.');
const output = resolve('.impeccable/review'); mkdirSync(output, { recursive: true });
const bun = process.env.MESHROOMS_BUN || 'bun';

const scratch = mkdtempSync(join(tmpdir(), 'meshrooms-history-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MESHROOMS_/i.test(key)));
Object.assign(env, { HOME: scratch, USERPROFILE: scratch, MESHROOMS_LOCAL_PORT: '0', MESHROOMS_LOCAL_UI_DIR: dist, MESHROOMS_ROOM_SERVICE: origin });
const person = join(scratch, '.meshrooms', 'person'), daemonDir = join(scratch, '.meshrooms', 'daemon');
const cli = (args, input) => {
  const run = spawnSync(bun, ['server/agent-cli.ts', ...args], { env, encoding: 'utf8', timeout: 120_000, ...(input === undefined ? {} : { input }) });
  if (run.status !== 0) throw new Error(`${args.join(' ')} failed: ${run.stderr || run.stdout}`);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
};
const until = async (look, what, ms = 60_000) => {
  for (const by = Date.now() + ms; Date.now() < by; await new Promise(r => setTimeout(r, 250))) { const seen = await look(); if (seen) return seen; }
  throw new Error(`Timed out waiting for ${what}.`);
};

const browser = await chromium.launch({ headless: true });
const errors = [], pages = [];
let daemon;
const log = openSync(join(output, 'history-pairing-daemon.log'), 'w');
async function page() {
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  const p = await context.newPage(); p.on('pageerror', e => errors.push(e.message)); pages.push(p);
  p.setDefaultTimeout(30_000); return p;
}
async function createRoom(p, name, title) {
  await p.goto(`${origin}/rooms`);
  await p.getByLabel('Your name', { exact: true }).fill(name);
  await p.getByLabel('Room name', { exact: true }).fill(title);
  if (process.env.MESHROOMS_TEST_INVITE) await p.getByLabel('Invite code', { exact: true }).fill(process.env.MESHROOMS_TEST_INVITE);
  await p.getByRole('button', { name: 'Create room', exact: true }).click();
  await p.waitForURL(/\/r\//);
  return p.url().split('/r/')[1];
}
const composer = p => p.locator('.browser-composer').getByRole('combobox', { name: /^Message / });
async function say(p, text) { await composer(p).fill(text); await composer(p).press('Enter'); await shown(p, text); }
const shown = (p, text, timeout = 30_000) => p.getByText(text, { exact: true }).first().waitFor({ timeout });

try {
  // Before pairing: Alex and Robin talk in Alex's room, and Robin in a room of her own.
  const alex = await page(), robin = await page();
  const hosted = await createRoom(alex, 'Alex', 'History check');
  await robin.goto(`${origin}/r/${hosted}`);
  await robin.getByLabel('Your name', { exact: true }).fill('Robin');
  await robin.getByRole('button', { name: 'Ask to join', exact: true }).click();
  await alex.getByRole('button', { name: 'Admit', exact: true }).click();
  await composer(robin).waitFor({ timeout: 45_000 });
  // A message goes to the devices its sender knows when sending: Robin speaks first, so Alex's page knows her device.
  await say(robin, 'Robin, before pairing');
  await shown(alex, 'Robin, before pairing');
  await say(alex, 'Alex, before pairing');
  await shown(robin, 'Alex, before pairing');
  const own = await createRoom(robin, 'Robin', 'Robin alone');
  await composer(robin).waitFor({ timeout: 45_000 });
  await say(robin, 'Robin, in her own room before pairing');
  await robin.goto(`${origin}/r/${hosted}`);
  await composer(robin).waitFor({ timeout: 45_000 });

  // Pairing, as scripts/pairing-smoke.mjs does it: the app's side is `person pair` with the secret on stdin.
  daemon = spawn(bun, ['server/agent-cli.ts', 'daemon', 'run'], { env, stdio: ['ignore', log, log], windowsHide: true });
  await until(() => { try { return JSON.parse(readFileSync(join(daemonDir, 'local-api.json'), 'utf8')); } catch { return undefined; } }, 'the daemon\'s local API');
  await robin.getByRole('button', { name: 'Have the desktop app?', exact: true }).click();
  await robin.getByRole('button', { name: 'Use the desktop app', exact: true }).click();
  await robin.getByRole('button', { name: 'Close room details', exact: true }).click();
  const link = new URL(await robin.locator('a.browser-pairing-open').getAttribute('href'));
  const proof = createHmac('sha256', JSON.parse(readFileSync(join(daemonDir, 'local-api.json'), 'utf8')).secret).update('meshrooms-local-control').digest('base64url');
  cli(['person', 'pair', '--origin', origin, '--rooms', link.searchParams.get('rooms'), '--name', 'Robin', '--device', link.searchParams.get('device')],
    `${proof}\n${link.searchParams.get('secret')}\n`);
  await robin.getByRole('button', { name: 'Finish desktop pairing', exact: true }).click();
  await robin.getByRole('button', { name: 'Confirm pairing', exact: true }).click();
  await robin.getByText('Paired. Open Meshrooms on this computer.').waitFor({ timeout: 45_000 });
  await until(() => { const rooms = cli(['person', 'rooms']); return [hosted, own].every(id => rooms.some(r => r.roomId === id && r.state === 'joined')); }, 'the person device to join both rooms');

  // The page the daemon serves: both rooms' earlier messages arrive from Robin's other devices and Alex's.
  const { url } = cli(['person', 'open']);
  const local = await page();
  await local.goto(url);
  await local.waitForURL(u => !u.hash && u.pathname === '/rooms');
  await local.getByRole('link', { name: /History check/ }).first().click();
  await local.waitForURL(new RegExp(`/r/${hosted}$`));
  await composer(local).waitFor({ timeout: 45_000 });
  await shown(local, 'Alex, before pairing', 60_000);
  await shown(local, 'Robin, before pairing');
  await say(alex, 'Alex, after pairing');
  await shown(local, 'Alex, after pairing');
  await local.screenshot({ path: resolve(output, 'history-pairing-local.png'), fullPage: true });
  await local.getByRole('link', { name: /Robin alone/ }).first().click();
  await local.waitForURL(new RegExp(`/r/${own}$`));
  await shown(local, 'Robin, in her own room before pairing', 60_000);

  // A newcomer, with history for newcomers off (the default), sees only what is said after admission.
  const casey = await page();
  await casey.goto(`${origin}/r/${hosted}`);
  await casey.getByLabel('Your name', { exact: true }).fill('Casey');
  await casey.getByRole('button', { name: 'Ask to join', exact: true }).click();
  await alex.getByRole('button', { name: 'Admit', exact: true }).click();
  await composer(casey).waitFor({ timeout: 45_000 });
  // A message goes to the devices its sender knows when sending: Alex replies only once Casey's device has reached her.
  await say(casey, 'Casey, just joined');
  await shown(alex, 'Casey, just joined');
  await say(alex, 'Alex, after Casey joined');
  await shown(casey, 'Alex, after Casey joined');
  // Long enough for a history exchange with every peer to have finished.
  await new Promise(r => setTimeout(r, 8_000));
  assert.equal(await casey.getByText(/before pairing|after pairing/).count(), 0, 'A newcomer sees no earlier message while history for newcomers is off.');
  await casey.screenshot({ path: resolve(output, 'history-pairing-newcomer.png'), fullPage: true });

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, rooms: [hosted, own].map(id => id.slice(0, 8)) }));
} catch (error) {
  console.error(error);
  for (const [i, p] of pages.entries()) {
    await p.screenshot({ path: resolve(output, `history-pairing-failure-${i}.png`), fullPage: true }).catch(() => {});
    console.error(`page ${i} (${p.url()}): ${(await p.locator('body').innerText().catch(() => '')).slice(0, 1500)}`);
  }
  if (errors.length) console.error('page errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  daemon?.kill();
  // The runners the daemon started outlive it by design; this run's are stopped by their proof of life.
  for (const room of existsSync(join(person, 'browser-agents')) ? readdirSync(join(person, 'browser-agents')) : []) {
    try { process.kill(JSON.parse(readFileSync(join(person, 'browser-agents', room, 'runner-alive.json'), 'utf8')).pid); } catch { /* Gone already. */ }
  }
  await new Promise(r => setTimeout(r, 1000));
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* A runner still closing; the folder is in the temp folder. */ }
}
