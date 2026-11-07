// Shared by the hosted and desktop-local browser smokes: exercise real navigation, reload and unsent file protection.
import assert from 'node:assert/strict';

export async function checkRoomDraft(page, roomTitle, replyText) {
  const roomUrl = page.url();
  const composer = () => page.locator('.browser-composer').getByRole('combobox', { name: /^Message / });
  const target = page.locator('article.browser-message', { has: page.locator('.message-text', { hasText: replyText }) }).first();
  await target.hover();
  await target.getByRole('button', { name: /^Reply to/ }).click();
  const draft = 'A private draft kept through navigation.\nCafé 日本語 🧪';
  await composer().fill(draft);
  await page.getByText('Draft saved in this tab.', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Meshrooms rooms', exact: true }).click();
  await page.waitForURL(/\/rooms$/);
  await page.getByRole('link', { name: roomTitle, exact: true }).first().click();
  await composer().waitFor();
  assert.equal(await composer().inputValue(), draft, 'Room navigation preserves unpublished text.');
  await page.getByRole('button', { name: 'Cancel reply', exact: true }).waitFor();
  await page.reload(); await composer().waitFor();
  assert.equal(await composer().inputValue(), draft, 'Reload preserves text and the reply target.');
  await page.getByRole('button', { name: 'Cancel reply', exact: true }).waitFor();
  assert.equal(await page.locator('.message-text').filter({ hasText: 'A private draft kept through navigation.' }).count(), 0, 'A draft is never published by navigation.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const sent = page.locator('article.browser-message').filter({ has: page.locator('.message-text', { hasText: 'A private draft kept through navigation.' }) });
  await sent.waitFor();
  assert.ok((await sent.locator('.browser-reply-reference').innerText()).includes(replyText), 'The restored reply is sent to its original message.');
  await page.reload(); await composer().waitFor();
  assert.equal(await composer().inputValue(), '', 'A sent draft does not come back.');
  assert.equal(await page.getByRole('button', { name: 'Cancel reply', exact: true }).count(), 0);
  assert.equal(await page.getByText('Draft saved in this tab.', { exact: true }).count(), 0);

  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'unsent-draft.txt', mimeType: 'text/plain', buffer: Buffer.from('An unpublished attachment.') });
  await page.locator('.pending-file.ready').waitFor();
  await Promise.all([
    page.waitForEvent('dialog').then(async warning => { assert.equal(warning.type(), 'beforeunload'); await warning.dismiss(); }),
    page.getByRole('link', { name: 'Meshrooms rooms', exact: true }).click({ noWaitAfter: true }),
  ]);
  assert.equal(page.url(), roomUrl);
  await page.getByRole('button', { name: 'Remove unsent-draft.txt', exact: true }).click();
}
