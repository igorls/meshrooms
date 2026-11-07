// Render the bundled status page with a deterministic IPC fixture. Native command authorization is tested in Rust.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const output = resolve('.impeccable/review'); mkdirSync(output, { recursive: true });
const files = new Set(['index.html', 'main.js', 'style.css', 'home.css']);
const server = createServer((request, response) => {
  const name = new URL(request.url, 'http://localhost').pathname.slice(1) || 'index.html';
  if (!files.has(name)) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html');
  response.end(readFileSync(resolve('desktop/ui', name)));
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 500, height: 720 }, colorScheme: 'light' });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.fixture = { running: null, detail: 'Checking the background service…', busy: false, loginOn: false, loginEnabled: true, approvals: 0 };
    window.actions = [];
    window.roomActions = [];
    window.__TAURI__ = { core: { invoke: async (command, args) => {
      if (command === 'home_view') { if (window.failRead) throw Error('Status could not be read.'); return structuredClone(window.fixture); }
      if (command !== 'home_action') throw new Error('Unexpected command');
      window.actions.push(args.action);
      if (args.action === 'room') window.roomActions.push(args.room);
      if (args.action === 'start' || args.action === 'open' && window.fixture.running === false) Object.assign(window.fixture, { busy: true, activity: 'Starting the background connection…' });
      if (args.action === 'login') window.fixture.loginOn = !window.fixture.loginOn;
    } } };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const update = async patch => {
    await page.evaluate(patch => { Object.assign(window.fixture, patch); document.dispatchEvent(new Event('visibilitychange')); }, patch);
  };
  await page.getByText('Checking background service…', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /Open your rooms/ }).isEnabled(), false);
  await update({ running: false });
  await page.getByText('Background service stopped', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Start and open your rooms', exact: true }).click();
  await page.getByText('Starting the background connection…', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Start background service', exact: true }).isEnabled(), false);
  assert.deepEqual(await page.evaluate(() => window.actions), ['open']);
  const firstRoom = '00000000-0000-4000-8000-000000000001';
  const secondRoom = '00000000-0000-4000-8000-000000000002';
  const rooms = [{ id: firstRoom, title: 'Design room', state: 'joined', unread: 3, mentions: 1, waiting: 0 },
    { id: secondRoom, title: 'Research room', state: 'waiting', unread: 0, mentions: 0, waiting: 0 }];
  await update({ running: true, busy: false, activity: '', approvals: 2, rooms });
  await page.getByText('2 requests waiting for you', { exact: true }).waitFor();
  await page.getByRole('button', { name: /Open your rooms/ }).click();
  await page.getByRole('button', { name: /^Review agents/ }).click();
  await page.getByRole('button', { name: /^Approvals/ }).click();
  await page.getByRole('button', { name: 'Open logs', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await page.getByRole('checkbox', { name: /^Start at login/ }).check();
  await page.getByText('Meshrooms will open in the tray.', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.actions), ['open', 'open', 'review', 'approvals', 'logs', 'refresh', 'login']);
  const shortcut = page.getByRole('button', { name: /^Open Design room,/ });
  await shortcut.click();
  assert.deepEqual(await page.evaluate(() => window.roomActions), [firstRoom]);
  await shortcut.focus();
  await update({ rooms: [{ ...rooms[0], unread: 4 }, rooms[1]] });
  await page.getByText('4 unread · 1 mention', { exact: true }).waitFor();
  assert.equal(await shortcut.evaluate(button => button === document.activeElement), true, 'Room counts preserve shortcut focus.');
  await page.getByRole('button', { name: /^Open Research room, Waiting for approval/ }).waitFor();
  const review = page.getByRole('button', { name: /^Review agents/ });
  await review.focus();
  await update({ approvals: 1 });
  await page.getByText('1 request waiting for you', { exact: true }).waitFor();
  assert.equal(await review.evaluate(button => button === document.activeElement), true, 'Status refresh preserves keyboard focus.');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: resolve(output, 'desktop-home-light.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight), false, 'The normal status view fits its default window.');
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.screenshot({ path: resolve(output, 'desktop-home-dark.png') });
  await page.evaluate(() => { window.failRead = true; document.dispatchEvent(new Event('visibilitychange')); });
  await page.getByText('Status unavailable', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /Open your rooms/ }).isEnabled(), false, 'A failed status read must not leave stale running controls enabled.');
  await page.evaluate(() => { window.failRead = false; document.dispatchEvent(new Event('visibilitychange')); });
  await page.getByText('Background service running', { exact: true }).waitFor();
  await update({ rooms: null, roomsProblem: 'Cannot read your rooms.' });
  await page.getByText('Cannot read your rooms.', { exact: true }).waitFor();
  assert.equal(await shortcut.count(), 0, 'Failed room reads do not keep stale shortcuts.');
  await update({ rooms, roomsProblem: null });
  const problem = '<img src=x onerror="window.untrusted=true"> The service did not start. ' + 'A long diagnostic. '.repeat(15);
  await update({ running: false, problem });
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByRole('alert').innerText(), problem.trim());
  assert.equal(await page.locator('#problem img').count(), 0);
  assert.equal(await page.evaluate(() => window.untrusted), undefined);
  await page.setViewportSize({ width: 400, height: 500 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: 'Start background service', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, 'desktop-home-recovery.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, scope: 'Bundled desktop UI with an IPC fixture', checks: ['unknown and stopped status', 'start and open recovery', 'failed status reads discard stale running state', 'start progress and disabled duplicate actions', 'fixed action routing', 'login state', 'approval counts', 'focus retention', 'light and dark layout', 'small-window recovery', 'inert diagnostic text'] }));
} finally {
  await browser.close();
  server.close();
}
