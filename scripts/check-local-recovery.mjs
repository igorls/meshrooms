// Runs only in the local UI smoke's scratch person home and loopback room service.
import assert from 'node:assert/strict';

export async function checkLocalRecovery(page) {
  const composer = () => page.locator('.browser-composer').getByRole('combobox', { name: /^Message / });
  const draft = 'Unsent text kept through reconnection. Café 日本語 🧪';
  await composer().fill(draft);

  // Failure before a room can be read must not masquerade as a new-room or join form.
  const unavailable = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'The app is temporarily unavailable.' }) });
  await page.route('**/api/local/**', unavailable);
  await page.reload();
  await page.getByRole('heading', { name: 'Cannot reach Meshrooms on this computer', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Create room', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Ask to join', exact: true }).count(), 0);
  await page.unroute('**/api/local/**', unavailable);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await composer().waitFor();
  assert.equal(await composer().inputValue(), draft);

  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'reconnection-draft.txt', mimeType: 'text/plain', buffer: Buffer.from('An attachment that stays unpublished.') });
  await page.locator('.pending-file.ready').waitFor();
  // Interrupt the real long poll: the room must stop claiming its cached connection is live.
  await page.context().setOffline(true);
  await page.getByText('Connection to this computer interrupted', { exact: true }).waitFor({ timeout: 45_000 });
  assert.equal(await page.locator('.browser-connection-dot.is-connected').count(), 0);
  assert.equal(await composer().inputValue(), draft);
  await page.getByRole('button', { name: 'Remove reconnection-draft.txt', exact: true }).waitFor();
  await page.screenshot({ path: '.impeccable/review/local-ui-reconnecting.png', fullPage: true });
  await page.context().setOffline(false);
  await page.locator('.browser-recovery').waitFor({ state: 'hidden', timeout: 45_000 });
  await page.locator('.browser-connection-dot.is-connected').waitFor();
  assert.equal(await composer().inputValue(), draft, 'Automatic recovery preserves unsent text.');
  await page.getByRole('button', { name: 'Remove reconnection-draft.txt', exact: true }).click();

  // While a POST awaits confirmation, navigation warns and new typing survives a rejected send.
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const failSend = async route => { await held; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'The send was interrupted.' }) }); };
  await page.route('**/api/local/rooms/*/send', failSend);
  try {
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('button', { name: 'Sending…', exact: true }).waitFor();
    await composer().fill('Typed while sending.');
    const roomUrl = page.url();
    await Promise.all([
      page.waitForEvent('dialog').then(async dialog => { assert.equal(dialog.type(), 'beforeunload'); await dialog.dismiss(); }),
      page.getByRole('link', { name: 'Meshrooms rooms', exact: true }).click({ noWaitAfter: true }),
    ]);
    assert.equal(page.url(), roomUrl);
  } finally { release(); }
  await page.getByRole('alert').filter({ hasText: 'The send was interrupted.' }).waitFor();
  assert.equal(await composer().inputValue(), `${draft}\nTyped while sending.`);
  await page.unroute('**/api/local/rooms/*/send', failSend);

  // An expired session is terminal for this tab, not an endless reconnect or a stale green status.
  await page.context().setOffline(true);
  await page.getByText('Connection to this computer interrupted', { exact: true }).waitFor({ timeout: 45_000 });
  await page.route('**/api/local/events?**', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Session expired.' }) }));
  await page.context().setOffline(false);
  await page.getByText('Sign in again from the app', { exact: true }).waitFor({ timeout: 45_000 });
  assert.equal(await composer().inputValue(), `${draft}\nTyped while sending.`);
  assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isEnabled(), false);
  assert.equal(await page.locator('.browser-connection-dot.is-connected').count(), 0);
  await page.screenshot({ path: '.impeccable/review/local-ui-sign-in-again.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const sendBox = await page.getByRole('button', { name: 'Send', exact: true }).boundingBox();
  assert.ok(sendBox && sendBox.y + sendBox.height <= 844, 'Recovery leaves the mobile composer reachable.');
  await page.screenshot({ path: '.impeccable/review/local-ui-sign-in-mobile.png', fullPage: true });
}
