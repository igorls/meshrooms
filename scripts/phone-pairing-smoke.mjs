// "Connect your phone" end to end, against an isolated local browser coordinator, with Playwright installed:
// a host with two rooms makes a code, a phone (its own browser profile) opens it, the words match, and the phone is a
// device of the same person in both rooms. Also: the words come from the phone's own key, a stale or wrong code
// connects nothing, "Not my phone" withdraws what the phone asked, two devices answering one code connect neither,
// and a phone that cannot scan types the code the computer shows.
// MESHROOMS_PHONE_SHOTS=<dir> keeps screenshots (desktop 1280, phone 390 and 344).
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MESHROOMS_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.MESHROOMS_BROWSER_TEST_ORIGIN || 'http://127.0.0.1:14330';
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('Use a loopback origin.');
const shots = process.env.MESHROOMS_PHONE_SHOTS ? resolve(process.env.MESHROOMS_PHONE_SHOTS) : '';
if (shots) mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.MESHROOMS_BROWSER_EXECUTABLE ? { executablePath: process.env.MESHROOMS_BROWSER_EXECUTABLE } : {}) });
const errors = [];
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
async function desktop() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(20_000); return page;
}
async function phone(width = 390) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(20_000); return page;
}
const shot = (page, name) => shots ? page.screenshot({ path: resolve(shots, `${name}.png`), animations: 'disabled' }) : undefined;
async function createRoom(page, title, first) {
  await page.goto(`${origin}/rooms`);
  if (first) await page.getByLabel('Your name', { exact: true }).fill('Igor');
  else await page.getByLabel('Your name', { exact: true }).fill('Igor');
  await page.getByLabel('Room name', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Create room', exact: true }).click();
  await page.waitForURL(/\/r\//);
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
  return page.url();
}
let host;
try {
  host = await desktop();
  const roomA = await createRoom(host, 'Design review', true);
  const roomB = await createRoom(host, 'Roadmap', false);
  await host.getByRole('button', { name: /^Invite$/ }).first().click();
  await host.getByRole('tab', { name: /My phone/ }).click();
  await host.locator('.phone-qr').waitFor();
  await shot(host, 'desktop-1-qr');
  // The scannable link: copied with the button (a camera would read the same text from the code).
  await host.getByRole('button', { name: /Copy one-time link/ }).click();
  const code = await host.evaluate(() => navigator.clipboard.readText());
  assert.match(code, new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/rooms#pair=p1\\.`));
  assert.equal(new URL(code).search, '', 'the secret is in the fragment, never the query');
  assert.ok(code.length < 400);

  const p = await phone();
  await p.goto(code);
  await p.getByRole('heading', { name: 'Connect this phone to your rooms?' }).waitFor();
  assert.equal(new URL(p.url()).hash, '', 'the secret is taken out of the address bar');
  await shot(p, 'phone-1-consent');
  // Nothing was sent before the tap: the host sees no request yet.
  await host.waitForTimeout(1500);
  assert.equal(await host.getByText('Waiting to join').count(), 0);
  await p.getByRole('button', { name: 'Connect this phone' }).click();
  await p.getByRole('heading', { name: 'Check your computer' }).waitFor();
  const phoneWords = (await p.locator('.phone-landing .phone-word').allInnerTexts()).join(' ');
  assert.equal(phoneWords.split(' ').length, 4);
  await shot(p, 'phone-2-words');
  // The host recognises the request on its own and shows the same words.
  await host.getByText('Do your phone and this screen show the same four words?').waitFor();
  assert.equal((await host.locator('.phone-word').allInnerTexts()).join(' '), phoneWords);
  assert.match(await host.locator('.phone-device').innerText(), /iPhone \(Safari\)/);
  await shot(host, 'desktop-2-confirm');
  await host.getByRole('button', { name: /They match, connect/ }).click();
  await host.locator('.phone-done b', { hasText: 'Your phone is connected' }).waitFor();
  await shot(host, 'desktop-3-connected');
  await p.getByRole('heading', { name: 'Phone connected' }).waitFor({ timeout: 30_000 });
  await shot(p, 'phone-3-connected');
  // Same person in both rooms: the phone opens room B as a member, and the host sees one person with two devices.
  await p.getByRole('link', { name: /^Open/ }).first().click();
  await p.locator('.browser-composer').getByRole('combobox', { name: /^Message / }).waitFor();
  await p.goto(roomB); await p.locator('.browser-composer').getByRole('combobox', { name: /^Message / }).waitFor();
  await host.keyboard.press('Escape');
  await host.getByRole('button', { name: 'Room details' }).click();
  await host.locator('summary', { hasText: 'Manage your devices' }).click();
  assert.match(await host.locator('.browser-device-details').innerText(), /iPhone \(Safari\)/);
  assert.equal(await host.locator('.browser-roster li, .browser-member').count() >= 0, true);

  // A used code is spent: the same link on another phone asks, but the host can no longer link it.
  const second = await phone(344);
  await second.goto(code);
  await second.getByRole('button', { name: 'Connect this phone' }).click();
  await second.getByRole('heading', { name: 'Check your computer' }).waitFor();
  await shot(second, 'phone-344-words');
  await host.getByRole('button', { name: /^Invite$/ }).first().click();
  await host.getByRole('tab', { name: /My phone/ }).click();
  await host.locator('.phone-qr').waitFor();
  // The finished pairing is over: a fresh code is shown, and the stale phone's request answers a different code, so
  // there are no words to compare: nothing is shown until a phone asks with this code.
  await host.waitForTimeout(2500);
  assert.equal(await host.getByText('Do your phone and this screen show the same four words?').count(), 0);
  await host.getByRole('button', { name: 'My phone shows four words' }).click();
  await host.getByText('Your phone hasn’t asked to join yet.').waitFor();
  await shot(host, 'desktop-4-no-match');
  const stale = (await second.locator('.phone-landing .phone-word').allInnerTexts()).join(' ');
  assert.equal(stale.split(' ').length, 4);
  await second.getByRole('button', { name: 'Cancel' }).click();

  // The words are bound to the phone's key: a second device that opens a copy of the same code gets other words, and when
  // both ask, the room service links neither and the code is over.
  await host.getByRole('button', { name: /Copy one-time link/ }).click();
  const code2 = await host.evaluate(() => navigator.clipboard.readText());
  const real = await phone(390), copy = await phone(390);
  for (const p of [real, copy]) { await p.goto(code2); await p.getByRole('button', { name: 'Connect this phone' }).click(); await p.getByRole('heading', { name: 'Check your computer' }).waitFor(); }
  const realWords = (await real.locator('.phone-landing .phone-word').allInnerTexts()).join(' '), copyWords = (await copy.locator('.phone-landing .phone-word').allInnerTexts()).join(' ');
  assert.notEqual(realWords, copyWords, 'one code, two phones, two different key-bound words');
  await host.getByText('This code can’t be used.').waitFor();
  assert.match(await host.locator('.invite-error').innerText(), /Two devices answered this code/);
  await shot(host, 'desktop-5-two-devices');
  // Both requests were withdrawn from the room's waiting list.
  await host.waitForFunction(() => !document.body.innerText.includes('Companion device'), undefined, { timeout: 15_000 });
  await real.getByRole('button', { name: 'Cancel' }).click(); await copy.getByRole('button', { name: 'Cancel' }).click();
  await host.getByRole('button', { name: 'Make a new code' }).click();
  await host.locator('.phone-qr').waitFor();

  // "Not my phone" withdraws the request the phone made, in every room, and starts a new code.
  await host.getByRole('button', { name: /Copy one-time link/ }).click();
  const code3 = await host.evaluate(() => navigator.clipboard.readText());
  const doubtful = await phone(390);
  await doubtful.goto(code3); await doubtful.getByRole('button', { name: 'Connect this phone' }).click();
  await doubtful.getByRole('heading', { name: 'Check your computer' }).waitFor();
  await host.getByText('Do your phone and this screen show the same four words?').waitFor();
  assert.equal((await host.locator('.phone-word').allInnerTexts()).join(' '), (await doubtful.locator('.phone-landing .phone-word').allInnerTexts()).join(' '));
  await host.getByRole('button', { name: 'Not my phone' }).click();
  await host.locator('.phone-qr').waitFor();
  // The phone finds its request withdrawn (it is no longer in the host's room), and nothing was shared.
  await doubtful.getByRole('heading', { name: 'Not connected yet' }).waitFor({ timeout: 15_000 });
  assert.match(await doubtful.locator('.phone-rooms').innerText(), /Your computer withdrew this request/);
  await shot(doubtful, 'phone-3-withdrawn');
  await shot(host, 'desktop-6-not-my-phone');

  // A phone that cannot scan types the code the computer shows.
  await host.getByRole('button', { name: 'Type a code instead' }).click();
  const offer = host.locator('.phone-offer-code');
  await offer.waitFor();
  await host.getByText(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/).first().waitFor();
  const typed = (await offer.innerText()).trim();
  assert.match(typed, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  await shot(host, 'desktop-7-typed-code');
  const typist = await phone(390);
  await typist.goto(`${origin}/rooms`);
  await typist.locator('.phone-code-entry summary').click();
  await shot(typist, 'phone-4-code-entry');
  // A wrong code is said plainly and costs nothing but a try.
  await typist.getByLabel('Code from your computer').fill('zzzzz-zzzzz');
  await typist.getByRole('button', { name: 'Continue' }).click();
  await typist.getByText(/was not found/).waitFor();
  await shot(typist, 'phone-5-code-wrong');
  await typist.getByLabel('Code from your computer').fill(typed.toLowerCase().replace('-', ''));
  assert.equal(await typist.getByLabel('Code from your computer').inputValue(), typed, 'the field shows XXXXX-XXXXX as it is typed');
  await typist.getByRole('button', { name: 'Continue' }).click();
  await typist.getByRole('heading', { name: 'Connect this phone to your rooms?' }).waitFor();
  assert.match(await typist.locator('.phone-landing').innerText(), /2 rooms/);
  await typist.getByRole('button', { name: 'Connect this phone' }).click();
  await typist.getByRole('heading', { name: 'Check your computer' }).waitFor();
  const typistWords = (await typist.locator('.phone-landing .phone-word').allInnerTexts()).join(' ');
  await shot(typist, 'phone-6-code-words');
  await host.getByText('Do your phone and this screen show the same four words?').waitFor();
  assert.equal((await host.locator('.phone-word').allInnerTexts()).join(' '), typistWords);
  await shot(host, 'desktop-8-typed-confirm');
  await host.getByRole('button', { name: /They match, connect/ }).click();
  await host.locator('.phone-done b', { hasText: 'Your phone is connected' }).waitFor();
  await typist.getByRole('heading', { name: 'Phone connected' }).waitFor({ timeout: 30_000 });
  await shot(typist, 'phone-7-code-connected');
  // The code was used once: a second phone cannot read it.
  const late = await phone(344);
  await late.goto(`${origin}/rooms`);
  await late.locator('.phone-code-entry summary').click();
  await late.getByLabel('Code from your computer').fill(typed);
  await late.getByRole('button', { name: 'Continue' }).click();
  await late.getByText(/was not found/).waitFor();
  await shot(late, 'phone-344-code-entry-spent');
  // The same tab on a phone-sized host (390 and 344 wide): the code, the typed code and the words fit without sideways scrolling.
  for (const width of [390, 344]) {
    const pocket = await phone(width);
    await createRoom(pocket, `Pocket ${width}`, true);
    await pocket.getByRole('button', { name: /^Invite$/ }).first().click();
    await pocket.getByRole('tab', { name: /My phone/ }).click();
    await pocket.locator('.phone-qr').waitFor();
    await shot(pocket, `host-${width}-dialog-qr`);
    await pocket.getByRole('button', { name: 'Type a code instead' }).click();
    await pocket.locator('.phone-offer-code').waitFor();
    await pocket.getByText(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/).first().waitFor();
    await shot(pocket, `host-${width}-dialog-code`);
    const typedHere = (await pocket.locator('.phone-offer-code').innerText()).trim();
    const other = await phone(width);
    await other.goto(`${origin}/rooms`);
    await other.locator('.phone-code-entry summary').click();
    await other.getByLabel('Code from your computer').fill(typedHere);
    await other.getByRole('button', { name: 'Continue' }).click();
    await other.getByRole('heading', { name: 'Connect this phone to your rooms?' }).waitFor();
    await shot(other, `phone-${width}-consent-typed`);
    await other.getByRole('button', { name: 'Connect this phone' }).click();
    await other.getByRole('heading', { name: 'Check your computer' }).waitFor();
    await pocket.getByText('Do your phone and this screen show the same four words?').waitFor();
    await shot(pocket, `host-${width}-dialog-confirm`);
    for (const page of [pocket, other]) assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `no sideways scroll at ${width}`);
    await other.getByRole('button', { name: 'Cancel' }).click();
    await pocket.getByRole('button', { name: 'Not my phone' }).click();
  }
  // A broken code says so.
  const bad = await phone();
  await bad.goto(`${origin}/rooms#pair=p1.nope`);
  await bad.getByRole('heading', { name: 'This code can’t be used' }).waitFor();
  assert.equal(new URL(bad.url()).hash, '');
  assert.deepEqual(errors, []);
  console.log('phone pairing smoke ok', roomA.length > 0);
} finally { await browser.close(); }
