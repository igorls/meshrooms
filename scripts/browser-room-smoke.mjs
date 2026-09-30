// Run against an isolated local browser coordinator, with Playwright installed.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MESHROOMS_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.MESHROOMS_BROWSER_TEST_ORIGIN || 'http://127.0.0.1:14330';
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname) && !(origin === 'https://meshrooms.wormdb.dev' && process.env.MESHROOMS_BROWSER_ALLOW_PRODUCTION === '1')) throw new Error('Use loopback, or explicitly opt in to the Meshrooms production smoke test.');
const output = resolve('.impeccable/review'); mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
const contexts = [];
async function page(viewport = { width: 1365, height: 900 }) {
  const context = await browser.newContext({ viewport }); contexts.push(context);
  await context.addInitScript(({ relay, transport }) => {
    window.__testPeers = [];
    window.__testEpochs = [];
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (String(args[0]).endsWith('/api/lobby')) void response.clone().json().then(data => { if (data.epoch && !window.__testEpochs.includes(data.epoch)) window.__testEpochs.push(data.epoch); }).catch(() => {});
      return response;
    };
    const Original = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Original {
      constructor(config) {
        if (transport) config.iceServers = (config.iceServers || []).map(s => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(url => transport === 'tls' ? url.startsWith('turns:') : url.startsWith('turn:') && url.includes(`transport=${transport}`)) })).filter(s => s.urls.length);
        super({ ...config, ...(relay ? { iceTransportPolicy: 'relay' } : {}) }); window.__testPeers.push(this);
      }
    };
  }, { relay: process.env.MESHROOMS_TEST_FORCE_RELAY === '1', transport: process.env.MESHROOMS_TEST_TURN_TRANSPORT });
  const p = await context.newPage(); p.on('pageerror', e => errors.push(e.message));
  p.setDefaultTimeout(25_000); return p;
}
async function visible(p, text) { await p.getByText(text, { exact: true }).waitFor(); }
// Messages render as Markdown, so line breaks become elements; compare the rendered text instead.
const flat = text => text.replace(/\s+/g, ' ').trim();
async function visibleMessage(p, text) { await p.waitForFunction(t => [...document.querySelectorAll('.message-text')].some(el => el.innerText.replace(/\s+/g, ' ').trim() === t), flat(text)); }
async function send(p, text) { await p.getByRole('combobox', { name: /^Message / }).fill(text); await p.getByRole('button', { name: 'Send', exact: true }).click(); }
async function snapshot(p, name) { await p.evaluate(() => window.scrollTo(0, 0)); await p.screenshot({ path: resolve(output, name), fullPage: true, animations: 'disabled' }); }
try {
  const host = await page(), guest = await page({ width: 390, height: 844 }), companion = await page();
  await host.goto(`${origin}/rooms`);
  await host.getByLabel('Your name', { exact: true }).fill('Alex');
  await host.getByLabel('Room name', { exact: true }).fill('Browser invitation check');
  // A service that requires invite codes for room creation (the hosted beta) needs one minted for this run.
  if (process.env.MESHROOMS_TEST_INVITE) await host.getByLabel('Invite code', { exact: true }).fill(process.env.MESHROOMS_TEST_INVITE);
  await host.getByRole('button', { name: 'Create room', exact: true }).click();
  await host.waitForURL(/\/r\//); const invite = host.url();
  await guest.goto(invite);
  await guest.getByLabel('Your name', { exact: true }).fill('Sam');
  await guest.getByRole('button', { name: 'Ask to join', exact: true }).click();
  await host.getByRole('button', { name: 'Admit', exact: true }).waitFor();
  assert.equal(await guest.getByRole('combobox', { name: /^Message / }).count(), 0);
  await snapshot(host, 'waiting-host.png'); await snapshot(guest, 'waiting-mobile.png');
  await host.getByRole('button', { name: 'Admit', exact: true }).click();
  await visible(guest, 'Connected to 1 other device');
  await visible(host, 'Connected to 1 other device');
  const first = 'Browser to browser: café • 日本語 • 🧪';
  await send(host, first); await visible(guest, first); await visible(host, 'Stored on 1 of 1 devices');
  await send(guest, 'Received. No installation needed.'); await visible(host, 'Received. No installation needed.');
  await visible(guest, 'Stored on 1 of 1 devices');
  const restartGate = process.env.MESHROOMS_TEST_RESTART_GATE;
  if (restartGate) {
    writeFileSync(restartGate, 'ready'); console.log('Ready for coordinator restart.');
    const deadline = Date.now() + 120_000;
    while (!existsSync(restartGate) || readFileSync(restartGate, 'utf8').trim() !== 'restarted') {
      if (Date.now() >= deadline) throw new Error('Coordinator restart was not completed.');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    await host.waitForFunction(() => window.__testEpochs.length >= 2);
    await guest.waitForFunction(() => window.__testEpochs.length >= 2);
    await visible(host, 'Connected to 1 other device'); await visible(guest, 'Connected to 1 other device');
    await send(host, 'The conversation continues after a coordinator restart.');
    await visible(guest, 'The conversation continues after a coordinator restart.');
    assert.equal(await guest.getByText(first, { exact: true }).count(), 1);
  }
  await guest.reload(); await visible(guest, first); await visible(guest, 'Connected to 1 other device');
  assert.equal(await guest.getByText(first, { exact: true }).count(), 1);
  const duplicate = await guest.context().newPage(); await duplicate.goto(invite);
  await duplicate.getByText(/already open in another tab/).waitFor(); await duplicate.close();
  await companion.goto(invite);
  await companion.getByRole('button', { name: 'Use my existing identity', exact: true }).click();
  const code = await companion.locator('.browser-link-code').innerText();
  await host.getByRole('button', { name: 'Room details', exact: true }).click();
  await host.locator('details.browser-link-device > summary').click();
  await host.getByLabel('Device code', { exact: true }).fill(code);
  await host.getByRole('button', { name: 'Approve my device', exact: true }).click();
  await visible(companion, 'Connected to 2 other devices');
  await visible(host, 'Connected to 2 other devices');
  assert.equal(await host.locator('.browser-person').count(), 2);
  assert.equal(await companion.locator('.browser-person').count(), 2);
  await visible(host, 'Host · 2 devices');
  assert.equal(await companion.getByText(first, { exact: true }).count(), 0); // This slice does not backfill companion history.
  await send(companion, 'Same person, another device.');
  await visible(host, 'Same person, another device.'); await visible(guest, 'Same person, another device.');
  const author = host.locator('.browser-message').filter({ has: host.getByText('Same person, another device.', { exact: true }) });
  assert.equal(await author.locator('strong').innerText(), 'Alex');
  await visible(companion, 'Stored on 2 of 2 devices');
  await host.locator('details.browser-link-device > summary').click();
  await host.getByRole('button', { name: 'Close room details', exact: true }).click();
  await snapshot(host, 'desktop.png'); await snapshot(guest, 'mobile.png');
  await host.setViewportSize({ width: 1305, height: 1270 }); await snapshot(host, 'user-1305.png');
  await host.setViewportSize({ width: 1365, height: 900 });
  await host.getByRole('button', { name: 'Room details', exact: true }).click();
  await host.getByText('Manage your devices', { exact: true }).click();
  const labels = await host.locator('.browser-device-details strong').allTextContents();
  assert.equal(labels.length, 2); assert.notEqual(labels[0], labels[1]);
  await snapshot(host, 'devices-desktop.png');
  await host.getByText('Manage your devices', { exact: true }).click();
  await host.getByRole('button', { name: 'Close room details', exact: true }).click();
  // Secondary context must preserve drafts and restore focus when closed.
  const draft = 'A draft that stays while checking people.';
  await guest.getByRole('combobox', { name: /^Message / }).fill(draft);
  await guest.getByRole('button', { name: 'Room details', exact: true }).click();
  assert.equal(await guest.getByRole('combobox', { name: /^Message / }).isVisible(), false);
  await snapshot(guest, 'details-mobile.png');
  await guest.getByRole('heading', { name: 'Room details', exact: true }).press('Escape');
  assert.equal(await guest.getByRole('combobox', { name: /^Message / }).inputValue(), draft);
  assert.equal(await guest.getByRole('button', { name: 'Room details', exact: true }).evaluate(el => el === document.activeElement), true);
  await guest.getByRole('combobox', { name: /^Message / }).fill('');
  // Tablet/zoom-sized layout and long names keep controls inside the viewport.
  await host.setViewportSize({ width: 820, height: 900 });
  await snapshot(host, 'tablet.png');
  assert.equal(await host.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await host.setViewportSize({ width: 1365, height: 900 });
  const overflow = await guest.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, 'Mobile view must not overflow horizontally.');
  const collectRoutes = () => host.evaluate(async () => {
    const pairs = [];
    for (const peer of window.__testPeers) {
      if (peer.connectionState !== 'connected') continue;
      const stats = await peer.getStats();
      for (const report of stats.values()) if (report.type === 'transport' && report.selectedCandidatePairId) {
        const pair = stats.get(report.selectedCandidatePairId);
        pairs.push({ state: pair.state, local: stats.get(pair.localCandidateId)?.candidateType, remote: stats.get(pair.remoteCandidateId)?.candidateType });
      }
    }
    return pairs;
  });
  // Data-channel readiness can precede Chromium's selected-pair stats after
  // renegotiation. Wait for the evidence, never infer a relay from configuration.
  let routes = await collectRoutes();
  const statsDeadline = Date.now() + 10_000;
  while (!(routes.length >= 2 && routes.every(r => r.state === 'succeeded')) && Date.now() < statsDeadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
    routes = await collectRoutes();
  }
  assert.ok(routes.length >= 2 && routes.every(r => r.state === 'succeeded'), `Selected ICE routes: ${JSON.stringify(routes)}`);
  if (process.env.MESHROOMS_TEST_FORCE_RELAY === '1') assert.ok(routes.every(r => r.local === 'relay' || r.remote === 'relay'));
  const reading = 'An earlier discussion worth keeping in view.\n'.repeat(40);
  await send(host, reading); await visibleMessage(guest, reading);
  await guest.locator('.browser-transcript').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await guest.waitForFunction(() => !document.querySelector('.browser-unread'));
  await guest.locator('.browser-transcript').evaluate(el => { el.scrollTop = 0; });
  await send(host, 'New message while you read above.');
  await guest.getByRole('button', { name: 'New message', exact: true }).waitFor();
  assert.equal(await guest.locator('.browser-transcript').evaluate(el => el.scrollTop), 0, 'Incoming messages must preserve reading position.');
  await guest.getByRole('button', { name: 'New message', exact: true }).click();
  assert.ok(await guest.locator('.browser-transcript').evaluate(el => el.scrollTop) > 0);
  const composerBox = await guest.locator('.browser-composer').boundingBox();
  assert.ok(composerBox.y >= 0 && composerBox.y + composerBox.height <= 844, 'Composer stays in view while history scrolls.');
  assert.equal(await guest.evaluate(() => document.documentElement.scrollHeight > innerHeight), false);
  assert.equal(await guest.getByRole('log', { name: 'Conversation' }).count(), 1);
  await guest.locator('[aria-live="polite"]').filter({ hasText: 'Alex: New message while you read above.' }).waitFor();
  await host.getByRole('button', { name: 'Room details', exact: true }).click();
  await host.getByText('Manage your devices', { exact: true }).click();
  await host.getByRole('button', { name: /^Remove (Windows |Mac )?browser [0-9A-F]{6}$/i }).click();
  await companion.getByText('This device no longer has access. Ask the host to admit it again.', { exact: true }).waitFor();
  assert.equal(await companion.getByRole('combobox', { name: /^Message / }).count(), 0);
  await host.getByRole('button', { name: 'Close room details', exact: true }).click();
  await send(host, 'The remaining device still works.'); await visible(guest, 'The remaining device still works.');
  const compose = host.getByRole('combobox', { name: /^Message / });
  await compose.fill('Keyboard first line'); await compose.press('Shift+Enter'); await compose.pressSequentially('Second line');
  assert.equal(await compose.inputValue(), 'Keyboard first line\nSecond line');
  await compose.press('Enter'); await visibleMessage(guest, 'Keyboard first line\nSecond line');
  const visitor = await page(); await visitor.goto(invite);
  await visitor.getByLabel('Your name', { exact: true }).fill('Visitor');
  await visitor.getByRole('button', { name: 'Ask to join', exact: true }).click();
  await host.getByRole('button', { name: 'Decline', exact: true }).click();
  await visible(visitor, 'The host declined your request.');
  await visitor.getByRole('button', { name: 'Ask to join', exact: true }).click();
  await visitor.getByRole('button', { name: 'Cancel request', exact: true }).click();
  await visible(visitor, 'Join request canceled.');
  await visitor.getByRole('button', { name: 'Ask to join', exact: true }).click();
  // Backend expiry is covered with a controlled clock in lobby.test.ts; exercise its UI response here.
  let expiryPolls = 0;
  let observedPruning;
  const pruning = new Promise(resolve => { observedPruning = resolve; });
  await visitor.route('**/api/lobby', async route => {
    const response = await route.fetch();
    const data = await response.json();
    if (data.request?.state === 'pending') {
      if (++expiryPolls === 1) { data.request.state = 'expired'; data.request.expiresAt = Date.now() - 1; delete data.request.code; }
      else delete data.request;
    }
    await route.fulfill({ response, json: data });
    if (expiryPolls >= 3) observedPruning();
  });
  await visible(visitor, 'Your request expired. Ask to join again when you’re ready.');
  let deadline;
  await Promise.race([pruning, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Expiry pruning was not observed.')), 12_000); })]).finally(() => clearTimeout(deadline));
  await visible(visitor, 'Your request expired. Ask to join again when you’re ready.');
  assert.equal(await visitor.getByText('Request sent.', { exact: true }).count(), 0);
  await visitor.setViewportSize({ width: 390, height: 844 }); await snapshot(visitor, 'expired-mobile.png');
  assert.deepEqual(errors, []);
  const result = { passed: true, browser: 'Chromium', scope: `Isolated browser contexts on one ${process.platform} machine`, origin, roomId: new URL(invite).pathname.split('/').at(-1), relayTransport: process.env.MESHROOMS_TEST_TURN_TRANSPORT || 'automatic', routes,
    checks: ['pending admission isolation', 'live host admission', 'bidirectional Unicode messages and storage receipts', ...(restartGate ? ['live coordinator restart recovery'] : []), 'reload identity/history', 'duplicate tab ownership', 'companion identity and authorship', 'device removal', 'decline', 'cancel', 'mobile and tablet overflow', 'preserved reading position and unread feedback', 'anchored composer', 'room details draft and keyboard focus retention', 'Enter sends and Shift+Enter adds a line', 'live message announcement', 'expired request UI (simulated response)'],
    notQualified: ['real macOS execution', 'different-network NAT traversal', ...(process.env.MESHROOMS_TEST_FORCE_RELAY === '1' ? [] : ['TURN relay']), 'native agent bridge', 'companion history backfill'] };
  writeFileSync(resolve(output, 'browser-smoke.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  // Keep failure diagnostics bounded and exclude SDP, device keys, and credentials.
  for (const context of contexts) for (const p of context.pages()) {
    console.error(JSON.stringify(await p.evaluate(() => ({
      path: location.pathname,
      feedback: [...document.querySelectorAll('.browser-error,.browser-connection')].map(el => el.textContent),
      peers: (window.__testPeers || []).map(pc => ({ connection: pc.connectionState, ice: pc.iceConnectionState, gathering: pc.iceGatheringState, signaling: pc.signalingState, relayCandidate: / typ relay/.test(pc.localDescription?.sdp || '') })),
    })).catch(() => ({ closed: true }))));
  }
  throw error;
} finally { for (const context of contexts) await context.close(); await browser.close(); }
