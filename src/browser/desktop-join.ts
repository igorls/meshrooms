/**
 * "Open in Meshrooms" on the hosted room page (internal/docs/design/desktop-first.md, "Join links open the app"). Once
 * this browser has paired with the desktop app (DesktopPairing sets PAIRED_FLAG), a room's page offers to open it there:
 * a plain link to `meshrooms://join?origin=<this site>&room=<id>`, which the app parses strictly (links.rs) and acts on
 * only through its own window. The site can't tell whether the app is installed, so this is a button the person presses,
 * never a redirect or a localhost probe.
 */

/** Set once this browser paired with the desktop app (DesktopPairing). Read here to offer opening rooms in the app. */
export const PAIRED_FLAG = 'meshrooms:paired';

/** The app's join link for a room of this site. */
export function joinLink(origin: string, roomId: string) {
  return `meshrooms://join?${new URLSearchParams({ origin, room: roomId })}`;
}

/** Whether this browser paired with the desktop app. Storage that can't be read means no. */
export function pairedHere(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage) {
  try { return storage?.getItem(PAIRED_FLAG) === '1'; } catch { return false; }
}
