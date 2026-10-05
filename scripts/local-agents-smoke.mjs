// Agents and sessions on the local page, for real (desktop-first M4): a loopback room service, a browser that hosts a
// room, this machine's person device (the daemon, run in the foreground from this checkout, with the app's approval
// routes on) joined to it, and the page the daemon serves. From that page the person makes an agent, puts it into the
// room (the host admits it: a guest's agent waits), starts a new session for it, mentions it and reads its reply, stops
// its wakes, asks to bind an existing session (approved as the app approves it), and deletes an agent in no room.
//
// The harnesses are fakes: claude, codex and hermes on PATH are this run's own scripts, ahead of anything installed, so
// no real Claude Code, Codex or Hermes ever runs and no harness storage outside the scratch folder is touched. The fake
// Claude Code answers --version, makes a session's transcript when started without --resume (as a first run does), and
// on a wake listens to the room and replies, as a wake prompt asks.
//
// Everything of the person and the daemon lives in a scratch home folder (HOME and USERPROFILE point there). Needs
// `bun run build` (the daemon serves dist/), Playwright with Chromium, and a room service:
//   MESHROOMS_BROWSER_PORT=14332 bun run server/browser/main.ts
//   MESHROOMS_BROWSER_TEST_ORIGIN=http://127.0.0.1:14332 node scripts/local-agents-smoke.mjs
// Screenshots go to .impeccable/review (MESHROOMS_SMOKE_OUT to choose another folder).
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MESHROOMS_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.MESHROOMS_BROWSER_TEST_ORIGIN || 'http://127.0.0.1:14332';
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('Use a loopback room service.');
const dist = resolve('dist');
if (!existsSync(join(dist, 'index.html'))) throw new Error('Build the UI first (bun run build): the daemon serves dist/.');
const output = resolve(process.env.MESHROOMS_SMOKE_OUT || '.impeccable/review'); mkdirSync(output, { recursive: true });
const bun = process.env.MESHROOMS_BUN || 'bun';
// The fakes call the bridge as a wake does; they need bun by its full path, since a wake's PATH is its own.
const bunPath = process.platform === 'win32' ? spawnSync('where', [bun], { encoding: 'utf8' }).stdout.split(/\r?\n/).find(l => l.toLowerCase().endsWith('.exe')) : spawnSync('which', [bun], { encoding: 'utf8' }).stdout.trim();
if (!bunPath) throw new Error('bun was not found on PATH.');
const cliScript = resolve('server/agent-cli.ts');

const scratch = mkdtempSync(join(tmpdir(), 'meshrooms-local-agents-'));
const fakeBin = join(scratch, 'fake-bin'), claudeConfig = join(scratch, '.claude'), runs = join(scratch, 'fake-claude-runs.jsonl');
mkdirSync(fakeBin, { recursive: true });
const FAKE_VERSION = '2.0.99';
// The fake Claude Code: what this run's checks need of it, and nothing it could reach outside the scratch folder.
writeFileSync(join(fakeBin, 'claude.js'), `const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(runs)}, JSON.stringify({ args: args.map(a => a.slice(0, 80)), cwd: process.cwd(), at: Date.now() }) + '\\n');
if (args.includes('--version')) { console.log(${JSON.stringify(`${FAKE_VERSION} (Claude Code)`)}); process.exit(0); }
const resumed = args.indexOf('--resume');
if (resumed < 0 && !args.includes('--continue')) {
  // A first run: a new session, its transcript in this folder's project, after a moment (so the page shows it starting).
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);
  const id = crypto.randomUUID(), dir = path.join(${JSON.stringify(claudeConfig)}, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.jsonl'), JSON.stringify({ type: 'user', cwd: process.cwd(), message: { role: 'user', content: 'Meshrooms first prompt' } }) + '\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Ready.', session_id: id }));
  process.exit(0);
}
// A wake: listen, reply to what addressed it.
const room = process.env.MESHROOMS_WAKE_ROOM;
const run = list => JSON.parse(cp.execFileSync(${JSON.stringify(bunPath)}, [${JSON.stringify(cliScript)}, ...list], { encoding: 'utf8', env: process.env }));
const heard = run(['listen', '--room', room, '--wait-seconds', '2']);
for (const id of heard.addressed || []) run(['send', '--room', room, '--request-id', crypto.randomUUID(), '--reply-to', id, '--text', 'On it.']);
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Replied.', session_id: resumed >= 0 ? args[resumed + 1] : undefined }));
`);
// Codex answers only its version; Hermes doesn't answer at all (shown as not available).
writeFileSync(join(fakeBin, 'codex.js'), `if (process.argv.includes('--version')) { console.log('codex-cli 0.159.0'); process.exit(0); } process.exit(1);\n`);
writeFileSync(join(fakeBin, 'hermes.js'), 'process.exit(1);\n');
for (const name of ['claude', 'codex', 'hermes']) {
  // An npm shim's shape, which the bridge runs through node without a shell (resolveProgram); a script elsewhere.
  if (process.platform === 'win32') writeFileSync(join(fakeBin, `${name}.cmd`), `@ECHO off\r\nnode "%dp0%\\${name}.js" %*\r\n`);
  else { writeFileSync(join(fakeBin, name), `#!/bin/sh\nexec node "${join(fakeBin, `${name}.js`)}" "$@"\n`, { mode: 0o755 }); }
}
// One existing session to list: a synthetic transcript, working in a folder of the scratch home.
const work = join(scratch, 'design-work'), existing = randomUUID();
mkdirSync(work, { recursive: true });
mkdirSync(join(claudeConfig, 'projects', work.replace(/[^A-Za-z0-9]/g, '-')), { recursive: true });
writeFileSync(join(claudeConfig, 'projects', work.replace(/[^A-Za-z0-9]/g, '-'), `${existing}.jsonl`),
  `${JSON.stringify({ type: 'user', cwd: work, message: { role: 'user', content: 'Synthetic design review' } })}\n`);

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MESHROOMS_|CLAUDE_CONFIG_DIR$|CODEX_HOME$|HERMES_HOME$)/i.test(key)));
const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
Object.assign(env, { HOME: scratch, USERPROFILE: scratch, MESHROOMS_LOCAL_PORT: '0', MESHROOMS_LOCAL_UI_DIR: dist, [pathKey]: `${fakeBin}${delimiter}${env[pathKey] ?? ''}` });
const person = join(scratch, '.meshrooms', 'person'), daemonDir = join(scratch, '.meshrooms', 'daemon');
const cli = (...args) => cliWith(undefined, ...args);
/** With stdin: `person join` takes the app's proof (the running daemon's control token) on its first line, as the app sends it. */
const cliWith = (input, ...args) => {
  const run = spawnSync(bun, ['server/agent-cli.ts', ...args], { env, encoding: 'utf8', timeout: 90_000, ...(input === undefined ? {} : { input }) });
  if (run.status !== 0) throw new Error(`${args.join(' ')} failed: ${run.stderr || run.stdout}`);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
};
const until = async (look, what, ms = 60_000) => {
  for (const by = Date.now() + ms; Date.now() < by; await new Promise(r => setTimeout(r, 250))) { const seen = await look(); if (seen) return seen; }
  throw new Error(`Timed out waiting for ${what}.`);
};
const fakeRuns = () => existsSync(runs) ? readFileSync(runs, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

const browser = await chromium.launch({ headless: true });
const errors = [], pages = [], shots = [];
let daemon;
const log = openSync(join(output, 'local-agents-daemon.log'), 'w');
async function page(viewport = { width: 1365, height: 1100 }) {
  const context = await browser.newContext({ viewport });
  const p = await context.newPage(); p.on('pageerror', e => errors.push(e.message)); pages.push(p);
  p.setDefaultTimeout(30_000); return p;
}
const flat = text => text.replace(/\s+/g, ' ').trim();
const visibleMessage = (p, text) => p.waitForFunction(t => [...document.querySelectorAll('.message-text')].some(el => el.innerText.replace(/\s+/g, ' ').trim() === t), flat(text), { timeout: 90_000 });
async function send(p, text) { await p.getByRole('combobox', { name: /^Message / }).fill(text); await p.getByRole('button', { name: 'Send', exact: true }).click(); }
/** The room details panel, as the person sees it. */
async function shot(p, name, target = p.locator('#browser-room-details')) {
  const path = resolve(output, name); await target.screenshot({ path, animations: 'disabled' }); shots.push(path);
}
try {
  const host = await page();
  await host.goto(`${origin}/rooms`);
  await host.getByLabel('Your name', { exact: true }).fill('Alex');
  await host.getByLabel('Room name', { exact: true }).fill('Agents check');
  if (process.env.MESHROOMS_TEST_INVITE) await host.getByLabel('Invite code', { exact: true }).fill(process.env.MESHROOMS_TEST_INVITE);
  await host.getByRole('button', { name: 'Create room', exact: true }).click();
  await host.waitForURL(/\/r\//); const roomUrl = host.url(), roomId = roomUrl.split('/r/')[1];

  // The daemon with the app's approval routes on, as the app will run it.
  daemon = spawn(bun, ['server/agent-cli.ts', 'daemon', 'run', '--approvals'], { env, stdio: ['ignore', log, log], windowsHide: true });
  const api = await until(() => { try { return JSON.parse(readFileSync(join(daemonDir, 'local-api.json'), 'utf8')); } catch { return undefined; } }, 'the daemon\'s local API');
  const proof = createHmac('sha256', api.secret).update('meshrooms-local-control').digest('base64url');
  const base = `http://127.0.0.1:${api.port}`, control = { Authorization: `Bearer ${proof}` };
  cli('person', 'init');
  cliWith(`${proof}\n`, 'person', 'join', roomUrl, '--name', 'Robin');
  await host.getByRole('button', { name: 'Admit', exact: true }).click();
  await until(() => cli('person', 'rooms').some(r => r.roomId === roomId && r.state === 'joined'), 'the person device to be admitted');

  const { url } = cli('person', 'open');
  const local = await page();
  await local.goto(url);
  await local.waitForURL(u => !u.hash && u.pathname === '/rooms');
  // Once signed in (the room is listed), as a person opens it.
  await local.getByRole('link', { name: /Agents check/ }).first().click();
  await local.waitForURL(new RegExp(`/r/${roomId}$`));
  await local.getByRole('button', { name: 'Room details', exact: true }).click();
  const panel = local.locator('#browser-room-details'), section = panel.locator('.browser-local-agents');

  // No agents yet: the new agent form is open, with the harnesses found here (the fakes) and the custom command shown
  // but not offered. The hosted site's agent link isn't on this page.
  await section.getByText('New agent', { exact: true }).waitFor();
  const harness = section.getByLabel('Harness');
  await until(async () => (await harness.locator('option').allInnerTexts()).some(t => t === `Claude Code ${FAKE_VERSION}`), 'the harness scan');
  const options = await harness.locator('option').evaluateAll(list => list.map(o => ({ text: o.textContent, disabled: o.disabled })));
  assert.deepEqual(options, [
    { text: `Claude Code ${FAKE_VERSION}`, disabled: false }, { text: 'Codex 0.159.0', disabled: false },
    { text: 'Hermes (not available)', disabled: true }, { text: 'Custom command (in the Meshrooms app)', disabled: true }]);
  await section.getByText('Custom command: Set up custom commands in the Meshrooms app.').waitFor();
  await section.getByText(/Or ask your agent to run/).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Connect an agent' }).count(), 0, 'The local page makes no agent link.');
  await shot(local, 'local-agents-new.png');

  // Two agents: Ash, which goes into the room, and one whose name is markup (shown as text) that is deleted unused.
  async function create(name, model) {
    if (!await section.locator('details.browser-new-agent').evaluate(d => d.open)) await section.getByText('New agent', { exact: true }).click();
    await section.getByLabel('Agent name').fill(name);
    await harness.selectOption('claude');
    await section.getByLabel(/^Model/).fill(model ?? '');
    await section.getByRole('button', { name: 'Create agent', exact: true }).click();
    await section.getByText(`${name} is ready. Add it to this room to bring it in.`).waitFor();
  }
  await create('Ash', 'sonnet');
  const markup = 'Oak <i>draft</i>';
  await create(markup);
  // The same name again: the server's refusal, as the page's plain message.
  await section.getByText('New agent', { exact: true }).click();
  await section.getByLabel('Agent name').fill('ash');
  await section.getByRole('button', { name: 'Create agent', exact: true }).click();
  await section.locator('.browser-agent-problem').filter({ hasText: /already/ }).waitFor();
  await section.getByText('New agent', { exact: true }).click();
  const row = name => section.locator('li.browser-local-agent', { has: local.locator('strong', { hasText: name }) });
  await row(markup).getByText(markup, { exact: true }).waitFor();
  assert.equal(await section.locator('i').count(), 0, 'A name is shown as text, never as markup.');
  await row('Ash').getByText('Claude Code · sonnet').waitFor();
  await shot(local, 'local-agents-list.png');

  // Into the room: a guest's agent waits for the host, who admits it from the hosted site.
  await row('Ash').getByRole('button', { name: 'Add to this room' }).click();
  await row('Ash').getByText('Waiting for the host to let it in.').waitFor({ timeout: 60_000 });
  await shot(local, 'local-agents-waiting.png');
  const request = host.locator('.browser-request', { hasText: 'Ash' });
  await request.getByText(/Agent · operated by Robin/).waitFor({ timeout: 60_000 });
  await request.getByRole('button', { name: 'Admit', exact: true }).click();
  await row('Ash').getByText('In this room.').waitFor({ timeout: 60_000 });
  await row('Ash').getByText('Not bound to a session yet, so nothing wakes it here.').waitFor();

  // A new session: started in the background, shown as starting, then bound.
  await row('Ash').getByRole('button', { name: 'Start a new session' }).click();
  await row('Ash').getByText(/^Starting a new session for this room/).waitFor({ timeout: 30_000 });
  await shot(local, 'local-agents-starting.png');
  await row('Ash').getByText('Bound to a new session. It wakes when someone addresses it.').waitFor({ timeout: 120_000 });
  assert.ok(fakeRuns().some(r => !r.args.includes('--version') && !r.args.includes('--resume')), 'The new session was a run of the fake Claude Code.');
  // Its state on the people list and the chip, with a way to its sessions.
  const member = panel.locator('.browser-person', { has: local.locator('strong', { hasText: /^Ash$/ }) }).first();
  await member.getByText('Wakes when addressed').waitFor();
  await until(async () => (await local.locator('.browser-agent-chip', { hasText: 'Ash' }).getAttribute('title') || '').includes('Wakes when addressed'), 'the chip to say it wakes', 30_000);
  await shot(local, 'local-agents-bound.png');
  await shot(local, 'local-agents-people.png', panel.locator('.browser-people'));
  // "Sessions" on the people list brings the person to that agent's controls.
  await member.getByRole('button', { name: 'Sessions', exact: true }).click();
  await until(() => local.evaluate(() => document.activeElement?.closest('li.browser-local-agent')?.querySelector('strong')?.textContent === 'Ash'), "the agent's controls to take focus", 10_000);

  // The person mentions it: the fake wakes (resuming the session), listens and replies. The watcher starts from the
  // moment it has the room's history (its listen cursor), so a mention sent before then isn't one it wakes for: wait.
  const ashId = cli('agent', 'list').agents.find(a => a.name === 'Ash').id;
  await until(() => existsSync(join(person, 'agents', ashId, 'browser-agents', roomId, 'live', 'listen-cursor.json')), 'the watcher to start listening', 90_000);
  await send(local, '@Ash can you take a look?');
  await visibleMessage(local, 'On it.');
  await visibleMessage(host, 'On it.');
  assert.ok(fakeRuns().some(r => r.args.includes('--resume')), 'The wake resumed the bound session.');
  await shot(local, 'local-agents-reply.png', local.locator('body'));

  // Stop waking: wakes off, still in the room.
  await row('Ash').getByRole('button', { name: 'Stop waking' }).click();
  await row('Ash').getByText('Not waking. It stays in the room.').waitFor({ timeout: 60_000 });
  await member.getByText('Not waking').waitFor();

  // An existing session: listed as plain text, filed for the app, shown as waiting for approval there.
  await row('Ash').getByRole('button', { name: 'Use an existing session' }).click();
  const sessions = row('Ash').locator('.browser-local-sessions');
  await sessions.getByText('Synthetic design review').waitFor();
  await sessions.getByText(/^design-work · Active/).waitFor();
  await shot(local, 'local-agents-sessions.png');
  await sessions.locator('li', { hasText: 'Synthetic design review' }).getByRole('button', { name: /^Use the session/ }).click();
  await row('Ash').getByText('Approve this in the Meshrooms app. Waiting for your approval…').waitFor();
  await section.getByText('One request waits for you in the Meshrooms app.').waitFor();
  await shot(local, 'local-agents-approval.png');
  // The app approves it (its control token; the page can't), and the page shows it bound.
  const listed = await (await fetch(`${base}/api/local/approvals`, { headers: control })).json();
  const filed = listed.approvals.find(a => a.kind === 'bind-existing' && a.session === existing);
  assert.ok(filed, 'The existing session was filed for the app.');
  const approved = await fetch(`${base}/api/local/approvals/${filed.id}/approve`, { method: 'POST', headers: { ...control, 'Content-Type': 'application/json' }, body: JSON.stringify({ digest: filed.digest }) });
  assert.equal(approved.status, 200, await approved.clone().text());
  await row('Ash').getByText('Bound to one of your sessions. It wakes when someone addresses it.').waitFor({ timeout: 60_000 });
  assert.equal(await row('Ash').getByText(/Approve this in the Meshrooms app/).count(), 0);
  await row('Ash').getByRole('button', { name: 'Stop waking' }).click();
  await row('Ash').getByText('Not waking. It stays in the room.').waitFor({ timeout: 60_000 });

  // Delete: only an agent in no room offers it, and only after a confirmation.
  assert.equal(await row('Ash').getByRole('button', { name: /^Delete/ }).count(), 0);
  await row(markup).getByRole('button', { name: `Delete ${markup}` }).click();
  await row(markup).getByRole('group', { name: `Confirm deleting ${markup}` }).waitFor();
  await shot(local, 'local-agents-delete.png');
  await row(markup).getByRole('button', { name: 'Delete agent', exact: true }).click();
  await section.getByText(`${markup} was deleted from this computer.`).waitFor();
  await row(markup).waitFor({ state: 'detached' });
  assert.deepEqual(cli('agent', 'list').agents.map(a => a.name), ['Ash']);

  // A phone-sized window shows the same panel.
  await local.setViewportSize({ width: 390, height: 1400 });
  await shot(local, 'local-agents-mobile.png');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, room: roomId.slice(0, 8), localApi: base, fakeRuns: fakeRuns().length, screenshots: shots }));
} catch (error) {
  console.error(error);
  for (const [i, p] of pages.entries()) {
    await p.screenshot({ path: resolve(output, `local-agents-failure-${i}.png`), fullPage: true }).catch(() => {});
    console.error(`page ${i} (${p.url()}): ${(await p.locator('body').innerText().catch(() => '')).slice(0, 2500)}`);
  }
  if (errors.length) console.error('page errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  daemon?.kill();
  // The runners and watchers the daemon started outlive it by design; this run's are stopped by their pid files.
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
