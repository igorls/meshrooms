// UI-only pagination fixture in the local smoke's isolated room. No synthetic messages are sent or stored.
import assert from 'node:assert/strict';

export async function checkLocalHistory(page) {
  const room = new URL(page.url()).pathname.split('/r/')[1];
  const pattern = `**/api/local/rooms/${room}/view*`, readPattern = `**/api/local/rooms/${room}/read`;
  const id = index => `00000000-0000-4000-8001-${String(index).padStart(12, '0')}`;
  let template, held, release;
  const messages = (start, end) => Array.from({ length: end - start }, (_, n) => {
    const index = start + n;
    const device = template.status.devices.find(d => d.memberId === template.memberId)?.id;
    return { packet: { body: { kind: 'message', id: id(index), roomId: room, deviceId: device, memberId: template.memberId,
      text: `Stored history ${index}. A longer message used to check that reading position is preserved when older messages load.`, at: Date.UTC(2026, 9, 20, 12) + index * 60_000 }, signature: '' }, targets: [], receipts: [] };
  });
  const views = async route => {
    const older = new URL(route.request().url()).searchParams.has('before');
    if (older) await held;
    else template = await (await route.fetch()).json();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...template,
      messages: older ? messages(0, 25) : messages(25, 50), more: !older, taskOps: [], decisionOps: [], reactions: [], files: {} }) });
  };
  await page.route(pattern, views);
  // The fixture's synthetic ids are never posted as real read positions.
  const reads = route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  await page.route(readPattern, reads);
  try {
    for (const viewport of [{ width: 1365, height: 900 }, { width: 390, height: 844 }]) {
      held = new Promise(resolve => { release = resolve; });
      await page.setViewportSize(viewport);
      await page.reload();
      const transcript = page.locator('.browser-transcript'), composer = page.locator('.browser-composer').getByRole('combobox', { name: /^Message / });
      const anchor = page.locator(`[id="message-${id(25)}"]`);
      await anchor.waitFor();
      await composer.fill('A draft while reading earlier messages.');
      await transcript.evaluate(node => { node.scrollTop = 0; });
      const offset = () => anchor.evaluate(node => node.getBoundingClientRect().top - node.closest('.browser-transcript').getBoundingClientRect().top);
      const before = await offset();
      await page.getByRole('button', { name: 'Show earlier messages', exact: true }).click();
      await page.getByRole('button', { name: 'Loading earlier messages…', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isEnabled(), true, 'Loading history does not block composing.');
      await composer.fill('Still typing while history loads.');
      release();
      await page.locator(`[id="message-${id(0)}"]`).waitFor();
      await page.getByRole('button', { name: 'Loading earlier messages…', exact: true }).waitFor({ state: 'hidden' });
      assert.equal(await page.locator('article.browser-message').count(), 50);
      assert.ok(Math.abs(await offset() - before) < 3, 'Prepending history preserves the previously visible message.');
      assert.equal(await composer.inputValue(), 'Still typing while history loads.');
      assert.equal(await composer.evaluate(node => node === document.activeElement), true, 'History loading does not steal composer focus.');
      await page.screenshot({ path: `.impeccable/review/local-ui-history-${viewport.width}.png`, fullPage: true });
      await composer.fill('');
    }
    await page.setViewportSize({ width: 1365, height: 900 });
    const composer = page.locator('.browser-composer').getByRole('combobox', { name: /^Message / });
    await composer.fill('A draft waiting in the other room.');
    const expand = page.getByRole('button', { name: 'Expand sidebar', exact: true });
    if (await expand.count()) await expand.click();
    await page.locator('.browser-room-nav a[href^="/r/"]:not([aria-current="page"])').first().click();
    const back = page.locator(`.browser-room-nav a[href="/r/${room}"]`);
    await back.locator('.browser-room-draft').waitFor();
    await back.click();
    await composer.waitFor();
    assert.equal(await composer.inputValue(), 'A draft waiting in the other room.');
    await composer.fill('');
  } finally {
    release?.();
    await page.unroute(pattern, views); await page.unroute(readPattern, reads);
  }
  await page.reload();
  await page.locator('.browser-composer').waitFor();
}
