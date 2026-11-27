/**
 * Opens Room details and returns it. A wide page reopens the side panel the person left open (in any room), so after a
 * reload or in a new room it may be open already, and clicking its header button then would close it.
 */
export async function openRoomDetails(page) {
  const button = page.getByRole('button', { name: 'Room details', exact: true });
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  return page.locator('#browser-room-details');
}
