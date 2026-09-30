// Background rooms and unread counts, in real browsers against an isolated local coordinator (see
// docs/browser-rooms.md, "Reproduce checks"). Two profiles, A and B, share two rooms, R1 and R2.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MESHROOMS_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.MESHROOMS_BROWSER_TEST_ORIGIN || 'http://127.0.0.1:14330';
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('Run the background rooms check against a loopback coordinator.');
const output = resolve('.impeccable/review'); mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
const contexts = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function profile() {
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 } }); contexts.push(context);
  await context.addInitScript(() => {
    window.__testPeers = [];
    // Every status poll this page makes: which room, which session, when. Nothing else is recorded.
    window.__statusLog = [];
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      try {
        const command = typeof args[1]?.body === 'string' && String(args[0]).endsWith('/api/lobby') ? JSON.parse(args[1].body).command : undefined;
        if (command?.action === 'status' && command.payload?.session) window.__statusLog.push({ room: command.roomId, session: command.payload.session, at: Date.now() });
      } catch { /* Not a command. */ }
      return originalFetch(...args);
    };
    const Original = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Original { constructor(config) { super(config); window.__testPeers.push(this); } };
  });
  return context;
}
async function open(context, url) {
  const p = await context.newPage(); p.on('pageerror', e => errors.push(e.message));
  p.setDefaultTimeout(25_000);
  if (url) await p.goto(url);
  return p;
}
async function visible(p, text) { await p.getByText(text, { exact: true }).first().waitFor(); }
async function send(p, text) { await p.getByRole('combobox', { name: /^Message / }).fill(text); await p.getByRole('button', { name: 'Send', exact: true }).click(); }
const roomLink = (p, id) => p.locator(`.browser-room-nav a[href="/r/${id}"]`);
async function badge(p, id, scope = '.browser-room-nav') { const b = p.locator(`${scope} a[href="/r/${id}"] .browser-room-badge`); return (await b.count()) ? { text: await b.innerText(), mention: await b.evaluate(el => el.classList.contains('is-mention')) } : undefined; }
async function waitBadge(p, id, text, scope = '.browser-room-nav', timeout = 20_000) {
  await p.locator(`${scope} a[href="/r/${id}"] .browser-room-badge`).filter({ hasText: new RegExp(`^@?${text}$`) }).waitFor({ timeout });
}
const locks = p => p.evaluate(async () => { const q = await navigator.locks.query(); return (q.held || []).map(l => ({ name: l.name, client: l.clientId })); });
const held = (list, name) => list.filter(l => l.name === name);
/** Status polls for a room, from these pages' logs (and any collected before a page closed). */
const polls = async (pages, roomId) => (await Promise.all(pages.map(p => p.evaluate(() => window.__statusLog).catch(() => [])))).flat().filter(e => e.room === roomId);
/** The sessions that polled a room, with their first and last poll; two sessions of one device must never overlap. */
function sessions(log) {
  const spans = new Map();
  for (const e of log) { const s = spans.get(e.session) || { first: e.at, last: e.at }; s.first = Math.min(s.first, e.at); s.last = Math.max(s.last, e.at); spans.set(e.session, s); }
  return [...spans.values()].sort((a, b) => a.first - b.first);
}
function assertNoOverlap(spans, label) {
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i - 1].last <= spans[i].first, `${label}: two sessions of one device polled the same room at once (${JSON.stringify(spans)})`);
}
async function admit(host, guest, invite, name) {
  await guest.goto(invite);
  await guest.getByLabel('Your name', { exact: true }).fill(name);
  await guest.getByRole('button', { name: 'Ask to join', exact: true }).click();
  await host.getByRole('button', { name: 'Admit', exact: true }).click();
  await visible(guest, 'Connected to 1 other device'); await visible(host, 'Connected to 1 other device');
}
async function create(p, title) {
  await p.goto(`${origin}/rooms`);
  await p.getByLabel('Your name', { exact: true }).fill('Alex');
  await p.getByLabel('Room name', { exact: true }).fill(title);
  if (process.env.MESHROOMS_TEST_INVITE) await p.getByLabel('Invite code', { exact: true }).fill(process.env.MESHROOMS_TEST_INVITE);
  await p.getByRole('button', { name: 'Create room', exact: true }).click();
  await p.waitForURL(/\/r\//); return p.url();
}
const idOf = url => new URL(url).pathname.split('/').at(-1);
const evidence = {};
try {
  const A = await profile(), B = await profile();
  const a1 = await open(A); let b = await open(B);
  const r1 = await create(a1, 'Background check one'); await admit(a1, b, r1, 'Sam');
  const r2 = await create(a1, 'Background check two'); await admit(a1, b, r2, 'Sam');
  const R1 = idOf(r1), R2 = idOf(r2);

  // 1. A reads R1 while B writes in R2: A's leader tab holds R2 in the background and its badge appears.
  await a1.goto(r1); await visible(a1, 'Connected to 1 other device');
  let sent = Date.now();
  await send(b, 'A note for the other room.');
  await waitBadge(a1, R2, '1');
  evidence.badgeSeconds = Math.round((Date.now() - sent) / 100) / 10;
  assert.ok(evidence.badgeSeconds <= 15, `R2's badge took ${evidence.badgeSeconds} s`);
  assert.equal((await badge(a1, R2)).mention, false);
  assert.equal(await badge(a1, R1), undefined, 'The open room shows no badge.');
  // Stored by A's background connection, so B's receipt says so.
  await visible(b, 'Stored on 1 of 1 devices');

  // 2. A mention of A takes the mention style; the tab title counts the other rooms' unread.
  sent = Date.now();
  await send(b, '@Alex could you look at this when you have a minute?');
  await waitBadge(a1, R2, '2');
  evidence.mentionSeconds = Math.round((Date.now() - sent) / 100) / 10;
  assert.deepEqual(await badge(a1, R2), { text: '2', mention: true });
  assert.equal(await roomLink(a1, R2).locator('.sr-only').innerText(), ', 2 unread, 1 mention');
  assert.equal(await a1.title(), '(2) Background check one · Meshrooms');
  await a1.screenshot({ path: resolve(output, 'background-badges.png'), animations: 'disabled' });
  await a1.getByRole('button', { name: 'Collapse sidebar' }).click();
  await a1.locator('.browser-rail-collapsed').waitFor();
  assert.ok(await roomLink(a1, R2).locator('.browser-room-badge').isVisible(), 'The badge stays visible in the collapsed rail.');
  await a1.screenshot({ path: resolve(output, 'background-badges-collapsed.png'), animations: 'disabled' });
  await a1.getByRole('button', { name: 'Expand sidebar' }).click();
  // Phones have no room list: the rooms link carries the total.
  await a1.setViewportSize({ width: 390, height: 844 });
  assert.equal(await a1.locator('.browser-mobile-rooms .browser-room-badge').innerText(), '2');
  assert.equal(await a1.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await a1.screenshot({ path: resolve(output, 'background-badges-mobile.png'), animations: 'disabled' });
  await a1.setViewportSize({ width: 1365, height: 900 });

  // 3. Opening R2 shows its messages from this browser's storage: B, the only other device, is gone by then.
  const mention = b.locator('.browser-message').filter({ has: b.getByText('@Alex could you look at this when you have a minute?') });
  await mention.getByText('Stored on 1 of 1 devices').waitFor();
  await b.close();
  await roomLink(a1, R2).click(); await a1.waitForURL(`**/r/${R2}`);
  await visible(a1, 'A note for the other room.'); await a1.locator('.browser-message-for-you').waitFor();
  assert.equal(await a1.getByText('Connected to 1 other device', { exact: true }).count(), 0, 'Nobody was connected to deliver them.');
  b = await open(B, r2);
  await visible(a1, 'Connected to 1 other device'); await visible(b, 'Connected to 1 other device');
  assert.equal(await a1.getByText('A note for the other room.', { exact: true }).count(), 1);
  assert.equal(await a1.title(), 'Background check two · Meshrooms');

  // 4. Two tabs of profile A: one leader, one session per room, the same badges, and leadership moves on close.
  await a1.goto(r1); await visible(a1, 'Connected to 1 other device');
  assert.equal(await badge(a1, R2), undefined, 'Opening R2 cleared its badge.');
  const a2 = await open(A, `${origin}/rooms`);
  await a2.locator('.browser-recent').waitFor();
  let heldLocks = await locks(a2);
  assert.equal(held(heldLocks, 'meshrooms-background').length, 1);
  assert.equal(held(heldLocks, `meshrooms-room:${R1}`).length, 1);
  await a2.waitForFunction(id => navigator.locks.query().then(q => q.held.some(l => l.name === `meshrooms-connection:${id}`)), R2);
  heldLocks = await locks(a2);
  const leader = held(heldLocks, 'meshrooms-background')[0].client;
  assert.equal(held(heldLocks, `meshrooms-connection:${R2}`)[0].client, leader, 'The leader holds R2 in the background.');
  assert.notEqual(held(heldLocks, `meshrooms-connection:${R1}`)[0].client, undefined);
  await send(b, 'Both tabs should count this one.');
  await waitBadge(a1, R2, '1'); await waitBadge(a2, R2, '1', '.browser-recent');
  assert.equal(await a1.title(), '(1) Background check one · Meshrooms');
  assert.equal(await a2.title(), '(1) Meshrooms');
  // B keeps one connection to A's device: a second session would make it reconnect over and over.
  const peersBefore = await b.evaluate(() => window.__testPeers.length);
  await sleep(12_000);
  assert.equal(await b.evaluate(() => window.__testPeers.length), peersBefore, 'B reconnected to A while A had two tabs open.');
  assertNoOverlap(sessions(await polls([a1, a2], R2)), 'R2 with two tabs');
  assertNoOverlap(sessions(await polls([a1, a2], R1)), 'R1 with two tabs');
  // Close the leader (a1 has led since before a2 opened); a2 takes over and holds both rooms.
  assert.ok((await a1.evaluate(() => window.__statusLog.some(e => e.room !== location.pathname.split('/').at(-1)))), 'The first tab was the leader.');
  const leaderPolls = await polls([a1], R2);
  await a1.close();
  await a2.waitForFunction(ids => navigator.locks.query().then(q => ids.every(id => q.held.some(l => l.name === `meshrooms-connection:${id}`))), [R1, R2], { timeout: 20_000 });
  sent = Date.now();
  await send(b, 'Counted by the new leader.');
  await waitBadge(a2, R2, '2', '.browser-recent');
  evidence.handoverBadgeSeconds = Math.round((Date.now() - sent) / 100) / 10;
  assertNoOverlap(sessions([...leaderPolls, ...await polls([a2], R2)]), 'R2 across the leader handover');

  // 5. A second tab opens R2 while the leader holds it in the background: a clean takeover, nothing lost.
  const burst = ['Takeover one.', 'Takeover two.', 'Takeover three.', 'Takeover four.', 'Takeover five.'];
  const a3 = await open(A);
  const opening = a3.goto(r2);
  for (const text of burst) { await send(b, text); await sleep(400); }
  await opening;
  for (const text of ['A note for the other room.', 'Both tabs should count this one.', 'Counted by the new leader.', ...burst]) {
    await visible(a3, text);
    assert.equal(await a3.getByText(text, { exact: true }).count(), 1, `"${text}" shows once`);
  }
  await visible(a3, 'Connected to 1 other device');
  const lastOwn = b.locator('.browser-message').filter({ has: b.getByText('Takeover five.', { exact: true }) });
  await lastOwn.getByText('Stored on 1 of 1 devices').waitFor();
  assertNoOverlap(sessions([...leaderPolls, ...await polls([a2, a3], R2)]), 'R2 across the takeover');
  heldLocks = await locks(a3);
  assert.equal(held(heldLocks, `meshrooms-connection:${R2}`).length, 1);
  assert.notEqual(held(heldLocks, `meshrooms-connection:${R2}`)[0].client, held(heldLocks, 'meshrooms-background')[0].client, 'The tab showing R2 holds its connection, not the leader.');
  // Read in the tab that shows it: the other tab's badge clears.
  await a2.locator(`.browser-recent a[href="/r/${R2}"] .browser-room-badge`).waitFor({ state: 'detached' });
  assert.equal(await a2.title(), 'Meshrooms');

  // 6. Someone asks to join R2 while A, its host, reads R1 and has R2 only in the background: A sees who is waiting and can admit.
  await a3.close();
  await a2.goto(r1); await visible(a2, 'Connected to 1 other device');
  await a2.waitForFunction(id => navigator.locks.query().then(q => q.held.some(l => l.name === `meshrooms-connection:${id}`)), R2, { timeout: 20_000 });
  const C = await profile(), c = await open(C, r2);
  const guestName = 'Casey <b>not bold</b>';
  await c.getByLabel('Your name', { exact: true }).fill(guestName);
  sent = Date.now();
  await c.getByRole('button', { name: 'Ask to join', exact: true }).click();
  // The host's browser is online for R2, and now it can act on that.
  await visible(c, 'Waiting for approval');
  const waitingBadge = roomLink(a2, R2).locator('.browser-room-waiting');
  await waitingBadge.waitFor();
  evidence.waitingSeconds = Math.round((Date.now() - sent) / 100) / 10;
  assert.equal(await waitingBadge.innerText(), '1');
  assert.match(await roomLink(a2, R2).locator('.sr-only').allInnerTexts().then(t => t.join('')), /, 1 waiting to join/);
  await a2.waitForFunction(() => document.title === '(1 waiting) Background check one · Meshrooms');
  // With a message unread as well, both badges show, and the waiting one keeps its dark text on amber.
  await send(b, 'One more while someone waits.');
  await waitBadge(a2, R2, '1');
  await a2.waitForFunction(() => document.title === '(1 · 1 waiting) Background check one · Meshrooms');
  assert.equal(await waitingBadge.evaluate(el => getComputedStyle(el).color), 'rgb(24, 38, 52)');
  assert.match(await roomLink(a2, R2).locator('.sr-only').allInnerTexts().then(t => t.join('')), /^, 1 unread, 1 waiting to join$/);
  // The room's name keeps its width next to two badges, and both stay visible in the collapsed rail.
  assert.ok(await roomLink(a2, R2).locator('span').first().evaluate(el => el.getBoundingClientRect().width >= 80));
  await a2.getByRole('button', { name: 'Collapse sidebar' }).click();
  assert.ok(await waitingBadge.isVisible() && await roomLink(a2, R2).locator('.browser-room-badge').isVisible());
  await a2.screenshot({ path: resolve(output, 'background-waiting-collapsed.png'), animations: 'disabled' });
  await a2.getByRole('button', { name: 'Expand sidebar' }).click();
  const alert = a2.locator('.browser-join-notice');
  await alert.waitFor();
  // The guest's name is their own text: shown literally, never as markup.
  assert.equal(await alert.locator('span').first().innerText(), `${guestName} asked to join Background check two`);
  assert.equal(await alert.locator('b, img, script').count(), 0);
  await a2.screenshot({ path: resolve(output, 'background-waiting.png'), animations: 'disabled' });
  await alert.getByRole('link', { name: 'Open room', exact: true }).click();
  await a2.waitForURL(`**/r/${R2}`);
  await a2.getByRole('button', { name: 'Admit', exact: true }).click();
  await visible(c, 'Connected to 2 other devices');
  assert.equal(await a2.locator('.browser-join-notice').count(), 0);

  // 7. Another claim on R2's records (as a tab that took the room over would make) while a2 shows it: a2's next write
  // is fenced out. Its message isn't stored, the draft comes back, it stops polling, and it says how to get the room back.
  const fencedSession = await a2.evaluate(id => window.__statusLog.filter(e => e.room === id).at(-1).session, R2);
  await a2.evaluate(roomId => new Promise((resolve, reject) => {
    const open = indexedDB.open('meshrooms-browser-v1', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('records', 'readwrite'), store = tx.objectStore('records');
      const identity = store.get('identity');
      identity.onsuccess = () => {
        const key = `owner:${identity.result.id}:${roomId}`, current = store.get(key);
        current.onsuccess = () => store.put((current.result || 0) + 100, key);
      };
      tx.oncomplete = () => { open.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }), R2);
  const draft = 'Written in a tab that lost the room.';
  await send(a2, draft);
  await a2.getByText('This room is open in another tab. Reload to use it here.').waitFor();
  assert.equal(await a2.getByRole('combobox', { name: /^Message / }).inputValue(), draft, 'The draft comes back.');
  const pollsAfter = await a2.evaluate(s => window.__statusLog.filter(e => e.session === s).length, fencedSession);
  await sleep(4000);
  assert.equal(await a2.evaluate(s => window.__statusLog.filter(e => e.session === s).length, fencedSession), pollsAfter, 'A fenced-out tab stops polling.');
  assert.equal(await b.getByText(draft, { exact: true }).count(), 0);
  await a2.getByRole('button', { name: 'Reload', exact: true }).click();
  await a2.waitForURL(`**/r/${R2}`); await visible(a2, 'Connected to 2 other devices');
  await send(a2, 'Sent after reloading.'); await visible(b, 'Sent after reloading.');

  assert.deepEqual(errors, []);
  const result = { passed: true, browser: 'Chromium', scope: `Three isolated browser profiles on one ${process.platform} machine`, origin, rooms: [R1, R2], evidence,
    checks: ['background badge for another room', 'mention style and screen reader label', 'tab title count', 'collapsed rail badge', 'stored history on opening a background room', 'badge clears once read',
      'one leader and one session per room across two tabs', 'no peer reconnection churn', 'leader handover on close', 'foreground takeover without lost or duplicated messages',
      'waiting-to-join badge, title and notice for a room hosted in the background', 'guest name shown as plain text', 'admitting from the notice',
      'a tab whose room records were claimed elsewhere writes nothing, restores the draft, stops polling and recovers on reload'] };
  writeFileSync(resolve(output, 'browser-background-smoke.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  for (const context of contexts) for (const p of context.pages()) {
    console.error(JSON.stringify(await p.evaluate(async () => ({
      path: location.pathname, title: document.title,
      feedback: [...document.querySelectorAll('.browser-error,.browser-connection')].map(el => el.textContent),
      badges: [...document.querySelectorAll('.browser-room-badge')].map(el => `${el.closest('a')?.getAttribute('href')}: ${el.textContent}`),
      locks: (await navigator.locks.query()).held.map(l => l.name),
      polls: (window.__statusLog || []).length,
    })).catch(() => ({ closed: true }))));
  }
  throw error;
} finally { for (const context of contexts) await context.close(); await browser.close(); }
