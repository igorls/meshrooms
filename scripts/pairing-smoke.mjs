// Pairing the hosted browser with the desktop app, for real (src/browser/pairing.ts): a loopback room service; Alex's
// browser hosts a room; Robin's browser is a guest there and hosts a room of its own; this machine's person device (the
// daemon, in the foreground from this checkout) is the app's side. Robin's page offers "Use the desktop app": the smoke
// reads the meshrooms://pair link the page made, checks the phrase both sides derive, and hands the secret to
// `person pair` on stdin, as the app's native window does once the phrase is typed (pair.rs). Robin then confirms in the
// browser, the person device joins both rooms with no host approval, and the page the daemon serves lists them. A new
// room is then created from that page, as a new user with no browser would.
//
// Everything of the person and the daemon lives in a scratch home folder (HOME and USERPROFILE point there), never the
// real ~/.meshrooms. Needs `bun run build`, Playwright with Chromium, and a room service built from this checkout:
//   MESHROOMS_BROWSER_PORT=14333 bun run server/browser/main.ts
//   MESHROOMS_BROWSER_TEST_ORIGIN=http://127.0.0.1:14333 node scripts/pairing-smoke.mjs
import { createRequire } from 'node:module';
import { createHash, createHmac } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MESHROOMS_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.MESHROOMS_BROWSER_TEST_ORIGIN || 'http://127.0.0.1:14333';
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('Use a loopback room service.');
const dist = resolve('dist');
if (!existsSync(join(dist, 'index.html'))) throw new Error('Build the UI first (bun run build): the daemon serves dist/.');
const output = resolve('.impeccable/review'); mkdirSync(output, { recursive: true });
const bun = process.env.MESHROOMS_BUN || 'bun';
const words = JSON.parse(readFileSync(resolve('src/browser/pair-words.json'), 'utf8'));

const scratch = mkdtempSync(join(tmpdir(), 'meshrooms-pairing-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MESHROOMS_/i.test(key)));
// New rooms from the app go to this loopback service, never the public one.
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
const errors = [];
let daemon;
const pages = [];
const log = openSync(join(output, 'pairing-daemon.log'), 'w');
async function page(viewport = { width: 1365, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const p = await context.newPage(); p.on('pageerror', e => errors.push(e.message)); pages.push(p);
  p.setDefaultTimeout(30_000); return p;
}
async function snapshot(p, name) { await p.screenshot({ path: resolve(output, name), fullPage: true, animations: 'disabled' }); }
async function createRoom(p, name, title) {
  await p.goto(`${origin}/rooms`);
  await p.getByLabel('Your name', { exact: true }).fill(name);
  await p.getByLabel('Room name', { exact: true }).fill(title);
  if (process.env.MESHROOMS_TEST_INVITE) await p.getByLabel('Invite code', { exact: true }).fill(process.env.MESHROOMS_TEST_INVITE);
  await p.getByRole('button', { name: 'Create room', exact: true }).click();
  await p.waitForURL(/\/r\//);
  return p.url().split('/r/')[1];
}
try {
  // Alex hosts the first room; Robin asks to join it and Alex admits; Robin hosts a second room.
  const alex = await page(), robin = await page();
  const hosted = await createRoom(alex, 'Alex', 'Pairing check');
  await robin.goto(`${origin}/r/${hosted}`);
  await robin.getByLabel('Your name', { exact: true }).fill('Robin');
  await robin.getByRole('button', { name: 'Ask to join', exact: true }).click();
  await alex.getByRole('button', { name: 'Admit', exact: true }).click();
  await robin.getByRole('combobox', { name: /^Message / }).waitFor({ timeout: 45_000 });
  const own = await createRoom(robin, 'Robin', 'Robin hosts');
  await robin.getByRole('combobox', { name: /^Message / }).waitFor({ timeout: 45_000 });

  // The app's side: the daemon in the foreground from this checkout.
  daemon = spawn(bun, ['server/agent-cli.ts', 'daemon', 'run'], { env, stdio: ['ignore', log, log], windowsHide: true });
  await until(() => { try { return JSON.parse(readFileSync(join(daemonDir, 'local-api.json'), 'utf8')); } catch { return undefined; } }, 'the daemon\'s local API');

  // Robin's rooms list offers the desktop app; the page makes the link and shows the phrase.
  await robin.goto(`${origin}/rooms`);
  await robin.getByRole('button', { name: 'Use the desktop app', exact: true }).click();
  const shown = (await robin.locator('.browser-pairing-phrase').innerText()).trim();
  const href = await robin.locator('a.browser-pairing-open').getAttribute('href');
  await snapshot(robin, 'pairing-browser-phrase.png');
  const link = new URL(href);
  assert.equal(link.protocol, 'meshrooms:');
  assert.deepEqual([...link.searchParams.keys()], ['v', 'origin', 'name', 'device', 'rooms', 'secret']);
  assert.equal(link.searchParams.get('v'), '2');
  const device = link.searchParams.get('device');
  assert.match(device, /^[a-f0-9]{64}$/);
  assert.equal(link.searchParams.get('origin'), origin);
  assert.equal(link.searchParams.get('name'), 'Robin');
  assert.deepEqual(link.searchParams.get('rooms').split(',').sort(), [hosted, own].sort());
  const n = link.searchParams.get('secret');
  assert.match(n, /^[A-Za-z0-9_-]{43}$/);
  // The phrase the app derives from the secret (pair.rs) is the one the browser shows.
  const secret = Buffer.from(n, 'base64url'), digest = createHash('sha256').update(Buffer.concat([Buffer.from('phrase:'), secret])).digest();
  assert.equal(shown, [0, 1, 2, 3].map(i => words[digest[i]]).join(' '));

  // Confirming before the app has asked links nothing (and counts as a try): the page says the app hasn't asked yet.
  await robin.getByRole('button', { name: 'Confirm pairing', exact: true }).click();
  await robin.getByText('The app hasn’t asked here yet').first().waitFor({ timeout: 30_000 });

  // The app's window, once the phrase is typed: `person pair` with the secret on stdin, never on the command line.
  assert.throws(() => cli(['person', 'pair', '--origin', origin, '--rooms', `${hosted},${own}`, '--name', 'Robin', '--device', device, '--secret', n]), /read from stdin/);
  // A bare `person pair` (no proof that the app asks) is refused; the app proves itself with the daemon's control token,
  // from the endpoint file (a same-user program can read it too: friction, not a wall).
  assert.throws(() => cli(['person', 'pair', '--origin', origin, '--rooms', `${hosted},${own}`, '--name', 'Robin', '--device', device], `${n}\n`), /from the Meshrooms app/);
  const proof = createHmac('sha256', JSON.parse(readFileSync(join(daemonDir, 'local-api.json'), 'utf8')).secret).update('meshrooms-local-control').digest('base64url');
  const paired = cli(['person', 'pair', '--origin', origin, '--rooms', `${hosted},${own}`, '--name', 'Robin', '--device', device], `${proof}\n${n}\n`);
  assert.deepEqual(paired.rooms.map(r => r.state), ['waiting', 'waiting']);

  // Robin confirms in the browser: both rooms link, with no host approval (Alex hosts the first one).
  await robin.getByRole('button', { name: 'Confirm pairing', exact: true }).click();
  await robin.getByText('Paired. Open Meshrooms on this computer.').waitFor({ timeout: 45_000 });
  // After the links, nothing in the page's storage holds the secret.
  const stored = await robin.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  assert.ok(!stored.includes(n), 'the secret is never stored by the page');
  // One person per app: another browser device is refused.
  assert.throws(() => cli(['person', 'pair', '--origin', origin, '--rooms', hosted, '--name', 'Alex', '--device', 'a'.repeat(64)], `${proof}\n${n}\n`), /This app is paired with Robin/);
  assert.equal(await robin.evaluate(() => localStorage.getItem('meshrooms:paired')), '1');
  await snapshot(robin, 'pairing-browser-paired.png');
  await until(() => { const rooms = cli(['person', 'rooms']); return [hosted, own].every(id => rooms.some(r => r.roomId === id && r.state === 'joined')); }, 'the person device to join both rooms', 60_000);
  // In Alex's room, the app is a device of Robin's, not a new member.
  const alexRoom = cli(['person', 'rooms']).find(r => r.roomId === hosted);
  assert.deepEqual(alexRoom.members.map(m => m.name).sort(), ['Alex', 'Robin']);

  // The page the daemon serves lists both rooms.
  const { url } = cli(['person', 'open']);
  const local = await page();
  await local.goto(url);
  await local.waitForURL(u => !u.hash && u.pathname === '/rooms');
  await local.getByRole('link', { name: /Pairing check/ }).first().waitFor();
  await local.getByRole('link', { name: /Robin hosts/ }).first().waitFor();
  await local.getByRole('link', { name: /Pairing check/ }).first().click();
  await local.waitForURL(new RegExp(`/r/${hosted}$`));
  await local.getByRole('combobox', { name: /^Message / }).waitFor({ timeout: 45_000 });
  await snapshot(local, 'pairing-local-room.png');

  // A new room from the local page: made and hosted by the person device.
  await local.goto(`${new URL(url).origin}/rooms`);
  await local.getByLabel('Your name', { exact: true }).fill('Robin');
  await local.getByLabel('Room name', { exact: true }).fill('Made in the app');
  // The form names the room service the room goes to, since it isn't the public one.
  await local.getByText(`This room will be made on ${origin}, not the public Meshrooms service.`).waitFor();
  await local.getByRole('button', { name: 'Create room', exact: true }).click();
  await local.waitForURL(/\/r\//);
  const made = local.url().split('/r/')[1];
  await local.getByText('Room host').first().waitFor({ timeout: 45_000 });
  await until(() => cli(['person', 'rooms']).some(r => r.roomId === made && r.state === 'joined'), 'the new room to be joined');
  await snapshot(local, 'pairing-local-created.png');

  // Unpair, as the app's window runs it. The room made in the app has this device as its only host device: the check
  // names it, and without --anyway nothing is deleted.
  const check = cli(['person', 'unpair', '--check']);
  assert.deepEqual(check.soleHost.map(r => r.roomId), [made]);
  const stopped = cli(['person', 'unpair'], `${proof}\n`);
  assert.equal(stopped.unpaired, false);
  assert.deepEqual(stopped.failed.map(r => r.roomId), [made]);
  assert.ok(existsSync(join(person, 'identity.json')), 'nothing was deleted');
  // Anyway: the rooms are left (Alex's and Robin's keep only the browsers), the made room keeps this device and is
  // named as kept, the runners stop, and the person folder goes.
  const gone = cli(['person', 'unpair', '--anyway'], `${proof}\n`);
  assert.equal(gone.unpaired, true);
  assert.deepEqual(gone.kept.map(r => r.roomId), [made]);
  assert.ok(!existsSync(person), 'the person folder is gone');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, rooms: [hosted, own, made].map(id => id.slice(0, 8)) }));
} catch (error) {
  console.error(error);
  for (const [i, p] of pages.entries()) {
    await p.screenshot({ path: resolve(output, `pairing-failure-${i}.png`), fullPage: true }).catch(() => {});
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
  if (process.env.MESHROOMS_SMOKE_KEEP === '1') console.error(`kept ${scratch}`);
  else try { rmSync(scratch, { recursive: true, force: true }); } catch { /* A runner still closing; the folder is in the temp folder. */ }
}
