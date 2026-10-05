// Join links opening the desktop app, for real (desktop/src-tauri/src/join.rs, src/browser/desktop-join.ts): a loopback
// room service; Alex's browser hosts two rooms; Robin's browser is a guest in the first. The development build of the app
// runs in the background against a scratch home folder (HOME and USERPROFILE point there, never the real ~/.meshrooms),
// starts its own daemon, and is driven through its development hooks: links are handed to it as a second launch would
// (the single-instance plugin forwards them), and `--dev-join-*` / `--dev-pair-*` press the native windows' buttons.
// MESHROOMS_DEV_OPENED makes the app write what it would open in the browser to a file, which this smoke then opens in
// Chromium, so nothing opens on the desktop.
//
// It checks, in order: the hosted page offers only a hint before this browser paired; a join link before pairing says to
// pair first and offers the room in the browser; pairing through the app's window; the page then offers "Open in
// Meshrooms" with the app's join link; a link to a room the app is in opens the local page at that room; a link to a
// room it isn't in asks first, refuses a second link meanwhile, joins once Join is pressed, waits for the host, and opens
// the room once admitted; a link to another room service is refused.
//
// Needs `bun run build`, `bun run build:bridge`, the development app (`cargo build` in desktop/src-tauri; its path in
// MESHROOMS_DESKTOP_APP), Playwright with Chromium, and a room service built from this checkout:
//   MESHROOMS_BROWSER_PORT=14334 MESHROOMS_BROWSER_DATA=<scratch> bun run server/browser/main.ts
//   MESHROOMS_BROWSER_TEST_ORIGIN=http://127.0.0.1:14334 MESHROOMS_DESKTOP_APP=<exe> node scripts/join-link-smoke.mjs
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MESHROOMS_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.MESHROOMS_BROWSER_TEST_ORIGIN || 'http://127.0.0.1:14334';
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('Use a loopback room service.');
const app = process.env.MESHROOMS_DESKTOP_APP;
if (!app || !existsSync(app)) throw new Error('Set MESHROOMS_DESKTOP_APP to the development build of the app (cargo build in desktop/src-tauri).');
if (!existsSync(resolve('packages/meshrooms/bin/meshrooms.js'))) throw new Error('Build the bridge first (bun run build:bridge): the development app runs it.');
const output = resolve('.impeccable/review'); mkdirSync(output, { recursive: true });
const bun = process.env.MESHROOMS_BUN || 'bun';

const scratch = mkdtempSync(join(tmpdir(), 'meshrooms-join-link-'));
const opened = join(scratch, 'opened.txt');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MESHROOMS_/i.test(key)));
Object.assign(env, { HOME: scratch, USERPROFILE: scratch, MESHROOMS_LOCAL_PORT: '0', MESHROOMS_DEV_OPENED: opened });
const person = join(scratch, '.meshrooms', 'person'), daemonDir = join(scratch, '.meshrooms', 'daemon');
const bridge = (...args) => {
  const run = spawnSync(bun, ['--no-env-file', resolve('packages/meshrooms/bin/meshrooms.js'), ...args], { env, encoding: 'utf8', timeout: 120_000, cwd: scratch });
  if (run.status !== 0) throw new Error(`${args.join(' ')} failed: ${run.stderr || run.stdout}`);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
};
const until = async (look, what, ms = 60_000) => {
  for (const by = Date.now() + ms; Date.now() < by; await new Promise(r => setTimeout(r, 250))) { const seen = await look(); if (seen) return seen; }
  throw new Error(`Timed out waiting for ${what}.`);
};

// The app: its stderr is the development trace (join:, pairing:, tray status:), kept and searched from a mark.
let shell, said = '';
const appLog = openSync(join(output, 'join-link-app.log'), 'w');
const mark = () => said.length;
const heard = (text, from = 0, ms = 60_000) => until(() => said.indexOf(text, from) >= 0, `the app to say "${text}"`, ms);
/** A second launch, as the OS does with a link or as a check presses a button: the running app takes it. */
const hand = arg => {
  const run = spawnSync(app, [arg], { env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  if (run.error) throw run.error;
};
const view = async () => {
  const from = mark();
  hand('--dev-join-view');
  await heard('join view: ', from);
  return JSON.parse(said.slice(said.indexOf('join view: ', from) + 'join view: '.length).split('\n')[0]);
};
const openedLines = () => existsSync(opened) ? readFileSync(opened, 'utf8').split('\n').filter(Boolean) : [];
const nextOpened = async (count, what) => (await until(() => openedLines().length > count && openedLines(), what))[count];
/** After a room opens, the app refuses links for 10 s (join.rs OPEN_COOLDOWN), so a page firing links in a loop can't flood it. */
const cooldown = () => new Promise(r => setTimeout(r, 11_000));

const browser = await chromium.launch({ headless: true });
const errors = [];
const pages = [];
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
const joinHref = room => `meshrooms://join?${new URLSearchParams({ origin, room })}`;
try {
  // Alex hosts two rooms; Robin asks to join the first and Alex admits.
  const alex = await page(), robin = await page();
  const first = await createRoom(alex, 'Alex', 'Join check');
  const second = await createRoom(alex, 'Alex', 'Second room');
  await alex.goto(`${origin}/r/${first}`);
  await robin.goto(`${origin}/r/${first}`);
  await robin.getByLabel('Your name', { exact: true }).fill('Robin');
  await robin.getByRole('button', { name: 'Ask to join', exact: true }).click();
  await alex.getByRole('button', { name: 'Admit', exact: true }).click();
  await robin.getByRole('combobox', { name: /^Message / }).waitFor({ timeout: 45_000 });

  // Before pairing: the room page offers only a hint, which opens Room details at "Use the desktop app".
  assert.equal(await robin.getByRole('link', { name: 'Open in Meshrooms' }).count(), 0);
  await robin.getByRole('button', { name: 'Have the desktop app?', exact: true }).click();
  await robin.locator('details.browser-desktop-pairing[open]').waitFor();
  await robin.getByRole('button', { name: 'Use the desktop app', exact: true }).waitFor();
  await snapshot(robin, 'join-link-room-hint.png');
  // And the join page of a room this browser isn't in: a hint, never the button.
  const sam = await page();
  await sam.goto(`${origin}/r/${second}`);
  await sam.getByRole('button', { name: 'Ask to join', exact: true }).waitFor();
  await sam.getByText('Have the desktop app?').waitFor();
  assert.equal(await sam.getByRole('link', { name: 'Open in Meshrooms' }).count(), 0);
  await snapshot(sam, 'join-link-join-hint.png');

  // The app, in the background: it starts its daemon.
  shell = spawn(app, ['--background'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  for (const stream of [shell.stdout, shell.stderr]) stream.on('data', chunk => { said += chunk.toString(); writeSync(appLog, chunk); });
  await until(() => { try { return JSON.parse(readFileSync(join(daemonDir, 'local-api.json'), 'utf8')); } catch { return undefined; } }, 'the daemon\'s local API', 90_000);

  // Not paired yet: the window says to pair first, and offers the room in the browser.
  let from = mark();
  hand(joinHref(second));
  await heard('join: NotPaired', from);
  const notPaired = await view();
  assert.equal(notPaired.stage, 'not-paired');
  assert.equal(notPaired.origin, origin);
  hand('--dev-join-browse');
  assert.equal(await nextOpened(0, 'the room in the browser'), `${origin}/r/${second}`);
  hand('--dev-join-cancel');
  assert.equal((await view()).stage, 'none');

  // Pairing, through the app's window: the phrase Robin's browser shows, typed there, then the final Pair.
  await robin.goto(`${origin}/rooms`);
  await robin.getByRole('button', { name: 'Use the desktop app', exact: true }).click();
  const phrase = (await robin.locator('.browser-pairing-phrase').innerText()).trim();
  const pairLink = await robin.locator('a.browser-pairing-open').getAttribute('href');
  from = mark();
  hand(pairLink);
  await heard('pairing: asking', from);
  hand(`--dev-pair-phrase=${phrase}`);
  await heard('pairing: titles listed', from);
  hand('--dev-pair-confirm');
  await heard('pairing: requests sent', from, 90_000);
  await robin.getByRole('button', { name: 'Confirm pairing', exact: true }).click();
  await robin.getByText('Paired. Open Meshrooms on this computer.').waitFor({ timeout: 45_000 });
  assert.equal(await robin.evaluate(() => localStorage.getItem('meshrooms:paired')), '1');
  await until(() => bridge('person', 'rooms').some(r => r.roomId === first && r.state === 'joined'), 'the app to be in the first room', 90_000);
  hand('--dev-pair-reject');

  // Paired: the room page and the join page offer "Open in Meshrooms", a plain link to the app's join link.
  await robin.goto(`${origin}/r/${first}`);
  const inRoom = robin.getByRole('link', { name: 'Open in Meshrooms', exact: true });
  await inRoom.waitFor();
  assert.equal(await inRoom.getAttribute('href'), joinHref(first));
  assert.equal(await robin.getByRole('button', { name: 'Have the desktop app?' }).count(), 0);
  await snapshot(robin, 'join-link-room-open.png');
  await robin.setViewportSize({ width: 390, height: 844 });
  await snapshot(robin, 'join-link-room-open-mobile.png');
  await robin.setViewportSize({ width: 1365, height: 900 });
  await robin.goto(`${origin}/r/${second}`);
  const onJoin = robin.getByRole('link', { name: 'Open in Meshrooms', exact: true });
  await onJoin.waitFor();
  assert.equal(await onJoin.getAttribute('href'), joinHref(second));
  // The browser's own way in stays.
  await robin.getByRole('button', { name: 'Ask to join', exact: true }).waitFor();
  await snapshot(robin, 'join-link-join-open.png');

  // A room the app is in: no window, the local page opens at that room.
  from = mark();
  hand(joinHref(first));
  await heard('join: Open', from);
  const local = await page();
  const firstLink = await nextOpened(1, 'the local page at the first room');
  assert.match(firstLink, new RegExp(`^http://127\\.0\\.0\\.1:\\d+/r/${first}#access=[\\w-]{43}$`));
  // Within the cooldown after a room opened, a link (even a flood of them) is refused and opens nothing more.
  const flood = mark();
  for (let i = 0; i < 20; i++) hand(joinHref(first));
  await heard('join: refused a second join while one is pending', flood);
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(openedLines().length, 2, 'a flood of links opened no more tabs');
  await local.goto(firstLink);
  await local.waitForURL(u => !u.hash && u.pathname === `/r/${first}`);
  await local.getByRole('heading', { name: 'Join check' }).first().waitFor({ timeout: 45_000 });
  await local.getByRole('combobox', { name: /^Message / }).waitFor({ timeout: 45_000 });

  await cooldown();

  // A room it isn't in: the window asks, with the room's public title and the address, as Robin (the paired name).
  from = mark();
  hand(await onJoin.getAttribute('href'));
  await heard('join: title read; asking', from);
  const asking = await view();
  assert.deepEqual({ stage: asking.stage, title: asking.title, known: asking.known, origin: asking.origin, name: asking.name },
    { stage: 'confirm', title: 'Second room', known: true, origin, name: 'Robin' });
  // One join at a time: a second link meanwhile is refused, and the first is untouched.
  hand(joinHref(first));
  await heard('join: refused a second join while one is pending', from);
  assert.equal((await view()).stage, 'confirm');
  // Join: the request goes out with the app's proof; the window waits for the host.
  hand('--dev-join-confirm');
  await heard('join: asked', from, 90_000);
  assert.equal((await view()).stage, 'waiting');
  await alex.goto(`${origin}/r/${second}`);
  await alex.getByRole('button', { name: 'Admit', exact: true }).click();
  await heard('join: admitted; opening the room', from, 90_000);
  const secondLink = await nextOpened(2, 'the local page at the second room');
  assert.match(secondLink, new RegExp(`^http://127\\.0\\.0\\.1:\\d+/r/${second}#access=[\\w-]{43}$`));
  await local.goto(secondLink);
  await local.waitForURL(u => !u.hash && u.pathname === `/r/${second}`);
  await local.getByRole('heading', { name: 'Second room' }).first().waitFor({ timeout: 45_000 });
  await local.getByRole('combobox', { name: /^Message / }).waitFor({ timeout: 45_000 });
  await snapshot(local, 'join-link-local-second.png');
  assert.equal((await view()).stage, 'done');
  hand('--dev-join-cancel');

  await cooldown();
  // Another room service (here, the same one spelled localhost): one person per app, refused with whom it is paired.
  from = mark();
  hand(`meshrooms://join?${new URLSearchParams({ origin: origin.replace('127.0.0.1', 'localhost'), room: crypto.randomUUID() })}`);
  await heard('join: OtherService', from);
  const other = await view();
  assert.deepEqual({ stage: other.stage, pairedName: other.pairedName, pairedOrigin: other.pairedOrigin }, { stage: 'other-service', pairedName: 'Robin', pairedOrigin: origin });
  hand('--dev-join-cancel');
  // The bridge refuses it too, whatever asks.
  assert.equal(bridge('person', 'rooms').length, 2);

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, rooms: [first, second].map(id => id.slice(0, 8)), opened: openedLines().length }));
} catch (error) {
  console.error(error);
  for (const [i, p] of pages.entries()) {
    await p.screenshot({ path: resolve(output, `join-link-failure-${i}.png`), fullPage: true }).catch(() => {});
    console.error(`page ${i} (${p.url()}): ${(await p.locator('body').innerText().catch(() => '')).slice(0, 1500)}`);
  }
  if (errors.length) console.error('page errors:', errors);
  console.error(said.split('\n').filter(line => /^(join|pairing|dev action)/.test(line)).slice(-40).join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  shell?.kill();
  // The app leaves its daemon running by design; this run's daemon and runners are stopped here.
  try { bridge('daemon', 'stop'); } catch { /* Not running. */ }
  for (const room of existsSync(join(person, 'browser-agents')) ? readdirSync(join(person, 'browser-agents')) : []) {
    try { process.kill(JSON.parse(readFileSync(join(person, 'browser-agents', room, 'runner-alive.json'), 'utf8')).pid); } catch { /* Gone already. */ }
  }
  await new Promise(r => setTimeout(r, 1000));
  if (process.env.MESHROOMS_SMOKE_KEEP === '1') console.error(`kept ${scratch}`);
  else try { rmSync(scratch, { recursive: true, force: true }); } catch { /* A runner still closing; the folder is in the temp folder. */ }
}
