// The app's Approvals window, for real (desktop-first M4; desktop/src-tauri/src/approvals.rs): a loopback room service;
// Alex's browser hosts a room; this machine's person (Robin) is in it through the daemon, run with the app's approval
// routes on, as the app starts it. The development build of the app runs in the background against a scratch home folder
// (HOME and USERPROFILE point there, never the real ~/.meshrooms) with MESHROOMS_DEV_NOTIFIED, so the notifications it
// would post are written to a file instead. The Approvals window is opened by clicking the "Approval waiting" notice (the
// only window this opens on the desktop; the app's exit closes it), and its development hooks (--dev-approvals-*) press its
// buttons through the same code, without a mouse.
//
// It checks, in order: an identity an agent asks for (`agent request`) is posted as a notice whose click opens the
// window, which lists every field it would make, and the tray counts it; approving makes exactly that identity. A second
// request is changed (approvals.json, as anything of the user's may write it) between the window listing it and Approve:
// nothing is made, and the window shows it again, as it now reads, marked "This changed since you opened it."; then it
// is rejected, and nothing is made. The identity is put into the room from the local page and the page asks to bind one
// of its existing sessions: the window shows the agent, the room, the harness, the session and the full working folder,
// and approving binds that session in that folder. Last, the window makes a custom-command agent.
//
// The harnesses are fakes: claude, codex and hermes on PATH are this run's own scripts, ahead of anything installed, so
// no real Claude Code, Codex or Hermes ever runs. Screenshots of the window's states are taken from approvals.html in a
// browser, its IPC stubbed with the views the app gave during the run.
//
// Needs `bun run build` (the daemon serves dist/ to the local page), `bun run build:bridge` (the development app runs
// it), the development app (`cargo build` in desktop/src-tauri; its path in MESHROOMS_DESKTOP_APP), Playwright with
// Chromium, and a room service:
//   MESHROOMS_BROWSER_PORT=14337 MESHROOMS_BROWSER_DATA=<scratch> bun run server/browser/main.ts
//   MESHROOMS_BROWSER_TEST_ORIGIN=http://127.0.0.1:14337 MESHROOMS_DESKTOP_APP=<exe> node scripts/approvals-smoke.mjs
// Screenshots and logs go to .impeccable/review (MESHROOMS_SMOKE_OUT to choose another folder).
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MESHROOMS_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.MESHROOMS_BROWSER_TEST_ORIGIN || 'http://127.0.0.1:14337';
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('Use a loopback room service.');
const app = process.env.MESHROOMS_DESKTOP_APP;
if (!app || !existsSync(app)) throw new Error('Set MESHROOMS_DESKTOP_APP to the development build of the app (cargo build in desktop/src-tauri).');
const script = resolve('packages/meshrooms/bin/meshrooms.js');
if (!existsSync(script)) throw new Error('Build the bridge first (bun run build:bridge): the development app runs it.');
const dist = resolve('dist');
if (!existsSync(join(dist, 'index.html'))) throw new Error('Build the UI first (bun run build): the daemon serves dist/.');
const output = resolve(process.env.MESHROOMS_SMOKE_OUT || '.impeccable/review'); mkdirSync(output, { recursive: true });
const bun = process.env.MESHROOMS_BUN || 'bun';
const bunPath = process.platform === 'win32' ? spawnSync('where', [bun], { encoding: 'utf8' }).stdout.split(/\r?\n/).find(l => l.toLowerCase().endsWith('.exe')) : spawnSync('which', [bun], { encoding: 'utf8' }).stdout.trim();
if (!bunPath) throw new Error('bun was not found on PATH.');

const scratch = mkdtempSync(join(tmpdir(), 'meshrooms-approvals-'));
const fakeBin = join(scratch, 'fake-bin'), claudeConfig = join(scratch, '.claude'), notified = join(scratch, 'notified.jsonl'), opened = join(scratch, 'opened.txt');
mkdirSync(fakeBin, { recursive: true });
const FAKE_VERSION = '2.0.99';
// The fake Claude Code: a version, and a session's transcript on a first run. It is never woken here.
writeFileSync(join(fakeBin, 'claude.js'), `const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log(${JSON.stringify(`${FAKE_VERSION} (Claude Code)`)}); process.exit(0); }
if (!args.includes('--resume') && !args.includes('--continue')) {
  const id = crypto.randomUUID(), dir = path.join(${JSON.stringify(claudeConfig)}, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.jsonl'), JSON.stringify({ type: 'user', cwd: process.cwd(), message: { role: 'user', content: 'Meshrooms first prompt' } }) + '\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Ready.', session_id: id }));
}
process.exit(0);
`);
writeFileSync(join(fakeBin, 'codex.js'), `if (process.argv.includes('--version')) { console.log('codex-cli 0.159.0'); process.exit(0); } process.exit(1);\n`);
writeFileSync(join(fakeBin, 'hermes.js'), 'process.exit(1);\n');
for (const name of ['claude', 'codex', 'hermes']) {
  if (process.platform === 'win32') writeFileSync(join(fakeBin, `${name}.cmd`), `@ECHO off\r\nnode "%dp0%\\${name}.js" %*\r\n`);
  else writeFileSync(join(fakeBin, name), `#!/bin/sh\nexec node "${join(fakeBin, `${name}.js`)}" "$@"\n`, { mode: 0o755 });
}
// One existing session to bind: a synthetic transcript, working in a folder of the scratch home.
const work = join(scratch, 'design-work'), existing = randomUUID();
mkdirSync(work, { recursive: true });
mkdirSync(join(claudeConfig, 'projects', work.replace(/[^A-Za-z0-9]/g, '-')), { recursive: true });
writeFileSync(join(claudeConfig, 'projects', work.replace(/[^A-Za-z0-9]/g, '-'), `${existing}.jsonl`),
  `${JSON.stringify({ type: 'user', cwd: work, message: { role: 'user', content: 'Synthetic design review' } })}\n`);
// The custom command: a program that does nothing (no model ever runs). It is never woken here anyway.
const fakeAgent = join(scratch, 'fake-agent.js');
writeFileSync(fakeAgent, 'process.exit(0);\n');

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MESHROOMS_|CLAUDE_CONFIG_DIR$|CODEX_HOME$|HERMES_HOME$)/i.test(key)));
const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
Object.assign(env, { HOME: scratch, USERPROFILE: scratch, MESHROOMS_LOCAL_PORT: '0', MESHROOMS_LOCAL_UI_DIR: dist, [pathKey]: `${fakeBin}${delimiter}${env[pathKey] ?? ''}` });
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
const identities = () => bridge('agent', 'list').agents;
const approvalsFile = join(person, 'approvals.json');

// The app: its stderr is the development trace (approvals:, notify:, tray approvals:), kept and searched from a mark.
let shell, said = '', daemon;
const appLog = openSync(join(output, 'approvals-app.log'), 'w'), daemonLog = openSync(join(output, 'approvals-daemon.log'), 'w');
const mark = () => said.length;
const heard = (text, from = 0, ms = 60_000) => until(() => said.indexOf(text, from) >= 0, `the app to say "${text}"`, ms);
/** A second launch, as a check presses a button: the running app takes it. Awaited, never spawnSync: the second launch
 * waits for the app's answer, and the app's trace must keep being read meanwhile, or a long line blocks the app on a full
 * stderr (Linux, where it is a socket) and neither ever finishes. */
const hand = arg => new Promise((done, fail) => {
  const child = spawn(app, [arg], { env: appEnv, stdio: 'ignore', windowsHide: true });
  const timer = setTimeout(() => { child.kill(); fail(new Error(`The app did not take ${arg} within 30 s.`)); }, 30_000);
  child.on('error', error => { clearTimeout(timer); fail(error); });
  child.on('exit', () => { clearTimeout(timer); done(); });
});
/** What the Approvals window shows now (the app's own view of it). */
const windowView = async () => {
  const from = mark();
  await hand('--dev-approvals-view');
  await heard('approvals view: ', from);
  return JSON.parse(said.slice(said.indexOf('approvals view: ', from) + 'approvals view: '.length).split('\n')[0]);
};
const rowsOf = item => Object.fromEntries(item.rows.map(r => [r.label, r.value]));
const views = {};

const browser = await chromium.launch({ headless: true });
const errors = [], pages = [], shots = [];
async function page(viewport = { width: 1365, height: 1000 }) {
  const context = await browser.newContext({ viewport });
  const p = await context.newPage(); p.on('pageerror', e => errors.push(e.message)); pages.push(p);
  p.setDefaultTimeout(30_000); return p;
}
try {
  const alex = await page();
  await alex.goto(`${origin}/rooms`);
  await alex.getByLabel('Your name', { exact: true }).fill('Alex');
  await alex.getByLabel('Room name', { exact: true }).fill('Approvals check');
  if (process.env.MESHROOMS_TEST_INVITE) await alex.getByLabel('Invite code', { exact: true }).fill(process.env.MESHROOMS_TEST_INVITE);
  await alex.getByRole('button', { name: 'Create room', exact: true }).click();
  await alex.waitForURL(/\/r\//);
  const roomUrl = alex.url(), roomId = roomUrl.split('/r/')[1];

  // The daemon, with the app's approval routes on, from the bridge the app runs.
  daemon = spawn(bunPath, ['--no-env-file', script, 'daemon', 'run', '--approvals'], { env, stdio: ['ignore', daemonLog, daemonLog], windowsHide: true, cwd: scratch });
  const api = await until(endpoint, 'the daemon\'s local API', 90_000);
  bridge('person', 'init');
  bridgeWith(`${proofOf(api)}\n`, 'person', 'join', roomUrl, '--name', 'Robin');
  await alex.getByRole('button', { name: 'Admit', exact: true }).click();
  await until(() => bridge('person', 'rooms').some(r => r.roomId === roomId && r.state === 'joined'), 'the person device to be admitted', 90_000);

  // The app, in the background: it reads the feed, and the tray counts what waits.
  shell = spawn(app, ['--background'], { env: appEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  for (const stream of [shell.stdout, shell.stderr]) stream.on('data', chunk => { said += chunk.toString(); writeSync(appLog, chunk); });
  await heard('notify: the daemon answers', 0, 120_000);
  await heard('tray approvals: 0 waiting', 0, 60_000);

  // 1. An agent asks for an identity. The notice opens the Approvals window, which shows every field; the tray counts it.
  let from = mark();
  const elm = bridge('agent', 'request', '--name', 'Elm', '--harness', 'claude', '--model', 'sonnet');
  const notice = await until(() => notices().find(n => n.target.kind === 'app'), 'the approval notice', 90_000);
  assert.deepEqual(notice, { title: 'Meshrooms · Approval waiting', body: notice.body, target: { kind: 'app' } });
  await heard('tray approvals: 1 waiting', from, 30_000);
  from = mark();
  await hand('--dev-notify-click=last');
  await heard('notify: clicked Approvals', from);
  let view = await until(async () => { const v = await windowView(); return v.items.length === 1 && v; }, 'the window to list the request');
  views.identity = view;
  const asked = view.items[0];
  assert.equal(asked.id, elm.approvalId);
  assert.equal(asked.kind, 'identity');
  assert.deepEqual(rowsOf(asked), { Name: 'Elm', Harness: 'Claude Code', Model: 'sonnet' });
  assert.equal(asked.canApprove, true);
  assert.match(asked.who, /meshrooms agent request/);
  assert.equal(identities().some(i => i.name === 'Elm'), false, 'nothing is made before Approve');
  from = mark();
  await hand(`--dev-approvals-approve=${asked.id}:${asked.digest}`);
  await until(() => identities().some(i => i.name === 'Elm'), 'Elm to be made');
  await heard('tray approvals: 0 waiting', from, 30_000);
  view = await until(async () => { const v = await windowView(); return !v.busy && !v.items.length && v.note && v; }, 'the window to show it done');
  assert.equal(view.note, 'Made Elm. Put it into a room from the Meshrooms page.');
  const elmIdentity = identities().find(i => i.name === 'Elm');
  assert.deepEqual({ harness: elmIdentity.harness, model: elmIdentity.model, custom: elmIdentity.custom, rooms: elmIdentity.rooms }, { harness: 'claude', model: 'sonnet', custom: false, rooms: [] });

  // 2. A request that changes between the window listing it and Approve: nothing is made, and it is shown again as it
  // now reads, marked. Then Reject: still nothing made.
  const fern = bridge('agent', 'request', '--name', 'Fern', '--harness', 'claude', '--model', 'sonnet');
  view = await until(async () => { const v = await windowView(); return v.items.some(i => i.id === fern.approvalId) && v; }, 'the window to list the second request');
  const shown = view.items.find(i => i.id === fern.approvalId);
  const filed = JSON.parse(readFileSync(approvalsFile, 'utf8'));
  writeFileSync(approvalsFile, JSON.stringify(filed.map(a => a.id === fern.approvalId ? { ...a, model: 'opus' } : a), null, 2));
  from = mark();
  await hand(`--dev-approvals-approve=${shown.id}:${shown.digest}`);
  await heard('approvals: approve', from);
  view = await until(async () => { const v = await windowView(); const item = v.items.find(i => i.id === fern.approvalId); return !v.busy && item?.changed && v; }, 'the changed request to be shown again, marked');
  views.changed = view;
  const changed = view.items.find(i => i.id === fern.approvalId);
  assert.equal(changed.changed, 'This changed since you opened it. Check it again.');
  assert.equal(rowsOf(changed).Model, 'opus', 'shown as it now reads');
  assert.notEqual(changed.digest, shown.digest);
  assert.equal(identities().some(i => i.name === 'Fern'), false, 'nothing was made');
  assert.equal(JSON.parse(readFileSync(approvalsFile, 'utf8')).find(a => a.id === fern.approvalId)?.model, 'opus', 'the request still waits');
  const outcome = said.slice(from).match(/approvals: approve (came to \w+|refused here[^\n]*)/)?.[1];
  await hand(`--dev-approvals-reject=${fern.approvalId}`);
  view = await until(async () => { const v = await windowView(); return !v.busy && !v.items.length && v.note && v; }, 'the request to be rejected');
  assert.equal(view.note, 'Rejected. Nothing was made or bound.');
  assert.equal(identities().some(i => i.name === 'Fern'), false);
  assert.deepEqual(JSON.parse(readFileSync(approvalsFile, 'utf8')), []);

  // 2b. A name the window can't show exactly as it is (a doubled space a cleaned line would hide): spelled out, and it can
  // only be rejected; Approve with its digest makes nothing.
  const ivy = bridge('agent', 'request', '--name', 'Ivy  Lee', '--harness', 'claude');
  view = await until(async () => { const v = await windowView(); return v.items.some(i => i.id === ivy.approvalId) && v; }, 'the window to list the odd name');
  views.inexact = view;
  const inexact = view.items.find(i => i.id === ivy.approvalId);
  assert.equal(rowsOf(inexact).Name, String.raw`Ivy\u{0020}\u{0020}Lee`);
  assert.equal(inexact.canApprove, false);
  from = mark();
  await hand(`--dev-approvals-approve=${inexact.id}:${inexact.digest}`);
  await heard('dev action: This request can\'t be shown exactly as it is', from, 30_000);
  assert.equal(identities().some(i => i.name.startsWith('Ivy')), false, 'nothing was made');
  await hand(`--dev-approvals-reject=${ivy.approvalId}`);
  await until(async () => { const v = await windowView(); return !v.busy && !v.items.length && v; }, 'the odd name to be rejected');
  // A name with a letter from another script (a Cyrillic о in Rоwan) can be approved, but is marked: it may look like another.
  const rowan = bridge('agent', 'request', '--name', 'Rоwan', '--harness', 'claude');
  view = await until(async () => { const v = await windowView(); return v.items.some(i => i.id === rowan.approvalId) && v; }, 'the window to list the marked name');
  views.nonAscii = view;
  const marked = view.items.find(i => i.id === rowan.approvalId);
  assert.deepEqual(marked.rows.find(r => r.label === 'Name'), { label: 'Name', value: 'Rоwan', nonAscii: true });
  assert.equal(marked.canApprove, true);
  await hand(`--dev-approvals-reject=${rowan.approvalId}`);
  await until(async () => { const v = await windowView(); return !v.busy && !v.items.length && v; }, 'the marked name to be rejected');

  // 3. Elm goes into the room from the local page; the host admits it; the page asks to bind an existing session.
  const { url } = bridge('person', 'open');
  const local = await page();
  await local.goto(url);
  await local.waitForURL(u => !u.hash && u.pathname === '/rooms');
  await local.getByRole('link', { name: /Approvals check/ }).first().click();
  await local.waitForURL(new RegExp(`/r/${roomId}$`));
  await local.getByRole('button', { name: 'Room details', exact: true }).click();
  const section = local.locator('#browser-room-details .browser-local-agents');
  const row = section.locator('li.browser-local-agent', { has: local.locator('strong', { hasText: 'Elm' }) });
  await row.getByRole('button', { name: 'Add to this room' }).click();
  const request = alex.locator('.browser-request', { hasText: 'Elm' });
  await request.getByRole('button', { name: 'Admit', exact: true }).click({ timeout: 60_000 });
  await row.getByText('In this room.').waitFor({ timeout: 60_000 });
  await row.getByRole('button', { name: 'Use an existing session' }).click();
  const sessions = row.locator('.browser-local-sessions');
  await sessions.getByText('Synthetic design review').waitFor();
  await sessions.locator('li', { hasText: 'Synthetic design review' }).getByRole('button', { name: /^Use the session/ }).click();
  await row.getByText('Approve this in the Meshrooms app. Waiting for your approval…').waitFor();
  view = await until(async () => { const v = await windowView(); return v.items.some(i => i.kind === 'bind-existing') && v; }, 'the window to list the bind');
  views.bind = view;
  const bind = view.items.find(i => i.kind === 'bind-existing');
  assert.deepEqual(rowsOf(bind), { Agent: 'Elm', 'Agent id': elmIdentity.id, Model: 'sonnet', Room: 'Approvals check', 'Room id': roomId, Harness: 'Claude Code',
    Session: 'Synthetic design review', 'Folder label': 'design-work', 'Working folder': work, 'Session id': existing });
  assert.match(bind.who, /Which one is not recorded/);
  assert.equal(bind.canApprove, true);
  await hand(`--dev-approvals-approve=${bind.id}:${bind.digest}`);
  await row.getByText('Bound to one of your sessions. It wakes when someone addresses it.').waitFor({ timeout: 60_000 });
  const record = JSON.parse(readFileSync(join(person, 'agents.json'), 'utf8')).find(i => i.name === 'Elm').bound[roomId];
  assert.deepEqual({ kind: record.kind, state: record.state, session: record.session, cwd: record.cwd }, { kind: 'existing', state: 'bound', session: existing, cwd: work });
  view = await until(async () => { const v = await windowView(); return !v.busy && !v.items.length && v.note && v; }, 'the window to show the bind done');
  assert.equal(view.note, `Bound Elm in Approvals check to that session, working in ${work}.`);

  // 4. A custom-command agent: Review reads the command back as it will run (nothing made yet), then Make this agent.
  const form = join(scratch, 'custom.json'), command = `"${bunPath}" "${fakeAgent}" --prompt-file {prompt_file}`;
  writeFileSync(form, JSON.stringify({ name: 'Oak', command, model: '' }));
  await hand(`--dev-approvals-custom-check=${form}`);
  view = await until(async () => { const v = await windowView(); return !v.busy && v.custom && v; }, 'the window to show the command for confirmation');
  views.customConfirm = view;
  assert.deepEqual(view.custom, { name: 'Oak', command, program: bunPath, args: [fakeAgent, '--prompt-file', '{prompt_file}'], model: null,
    nonAscii: { name: false, command: [...command].some(c => c.codePointAt(0) > 127) } });
  assert.equal(identities().some(i => i.name === 'Oak'), false, 'nothing is made before Make this agent');
  await hand('--dev-approvals-custom-make');
  await until(() => identities().some(i => i.name === 'Oak'), 'Oak to be made');
  const oak = identities().find(i => i.name === 'Oak');
  assert.deepEqual({ harness: oak.harness, custom: oak.custom }, { harness: 'exec', custom: true });
  view = await until(async () => { const v = await windowView(); return !v.busy && v.made === 1 && v; }, 'the window to show Oak made');
  assert.equal(view.note, `Made Oak, a custom-command agent. Each wake runs: ${command}. Put it into a room from the Meshrooms page.`);
  views.custom = view;

  // Screenshots: approvals.html with its IPC stubbed by the views the app gave above.
  const shotPage = await page({ width: 600, height: 760 });
  await shotPage.addInitScript(() => {
    window.__view = { loaded: false, items: [], busy: false, made: 0 };
    window.__TAURI__ = { core: { invoke: async command => command === 'approvals_view' ? window.__view : null } };
  });
  await shotPage.goto(pathToFileURL(resolve('desktop/ui/approvals.html')).href);
  const shoot = async (name, view, before) => {
    await shotPage.evaluate(v => { window.__view = v; }, view);
    if (before) await before();
    // Approve waits 1.5 s after a request first shows, and the window reads its view every 0.5 s.
    await shotPage.waitForTimeout(2_600);
    const path = join(output, name); await shotPage.screenshot({ path, fullPage: true }); shots.push(path);
  };
  await shoot('approvals-loading.png', { loaded: false, items: [], busy: false, made: 0 });
  await shoot('approvals-identity.png', views.identity);
  assert.equal(await shotPage.locator('button', { hasText: 'Approve' }).isEnabled(), true);
  assert.notEqual(await shotPage.evaluate(() => document.activeElement?.textContent), 'Approve', 'Approve is never focused for the person');
  await shoot('approvals-changed.png', views.changed);
  await shoot('approvals-bind.png', views.bind);
  await shoot('approvals-empty.png', { ...views.custom, note: null });
  await shoot('approvals-inexact.png', views.inexact);
  await shoot('approvals-non-ascii.png', views.nonAscii);
  await shoot('approvals-custom.png', { ...views.custom, note: null }, async () => {
    await shotPage.locator('#custom summary').click();
    await shotPage.fill('#custom-name', 'Oak');
    await shotPage.fill('#custom-command', 'my-agent --prompt-file {prompt_file}');
  });
  await shoot('approvals-custom-confirm.png', views.customConfirm);
  await shoot('approvals-custom-made.png', views.custom);
  await shotPage.emulateMedia({ colorScheme: 'dark' });
  await shoot('approvals-bind-dark.png', views.bind, () => shotPage.locator('#custom').evaluate(d => { d.open = false; }));

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, room: roomId.slice(0, 8), changedOutcome: outcome, notices: notices().map(n => n.title), screenshots: shots }));
} catch (error) {
  console.error(error);
  for (const [i, p] of pages.entries()) {
    await p.screenshot({ path: join(output, `approvals-failure-${i}.png`), fullPage: true }).catch(() => {});
    console.error(`page ${i} (${p.url()}): ${(await p.locator('body').innerText().catch(() => '')).slice(0, 2000)}`);
  }
  console.error(said.split('\n').filter(line => /^(approvals|notify|dev action|tray)/.test(line)).slice(-40).join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  shell?.kill();
  // The daemon (this run's, or one the app started) and the runners and watchers are stopped here.
  try { bridge('daemon', 'stop'); } catch { /* Not running. */ }
  daemon?.kill();
  const pids = [];
  const collect = dir => { for (const entry of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (entry.name === 'runner.pid' || entry.name === 'watch.pid') pids.push(Number(readFileSync(path, 'utf8')));
    else if (entry.name === 'runner-alive.json') try { pids.push(JSON.parse(readFileSync(path, 'utf8')).pid); } catch { /* Not one. */ }
  } };
  collect(person);
  for (const pid of new Set(pids.filter(Boolean))) try { process.kill(pid); } catch { /* Gone already. */ }
  await new Promise(r => setTimeout(r, 1500));
  if (process.env.MESHROOMS_SMOKE_KEEP === '1') console.error(`kept ${scratch}`);
  else try { rmSync(scratch, { recursive: true, force: true }); } catch { /* A runner still closing; the folder is in the temp folder. */ }
}
