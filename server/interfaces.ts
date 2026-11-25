/**
 * Network interface enumeration that can't take the bridge down.
 *
 * Some sandboxes (cloud command environments among them) deny getifaddrs, so `os.networkInterfaces()` throws EPERM.
 * werift calls it, unguarded, every time it gathers ICE candidates (even with a relay-only policy), and multicast-dns
 * calls it from a socket callback when a remote `.local` candidate starts an mDNS lookup, where the throw escapes as an
 * uncaught exception. Either one ended the runner before it could try the room's relay.
 *
 * `guardNetworkInterfaces` wraps `os.networkInterfaces` once for the whole process: a failure returns no interfaces
 * instead of throwing and is logged once. The runner then gathers relay candidates only (TURN, over TLS on 443 where
 * that is all the network allows), and drops remote `.local` candidates, which it could not resolve anyway, before
 * werift sees them, so no mDNS socket is opened.
 */
import os from 'node:os';

const GUARDED = Symbol.for('meshrooms.networkInterfacesGuarded');
type Enumerate = typeof os.networkInterfaces;
type Guarded = Enumerate & { [GUARDED]?: { failed: boolean; reason: string; logs: Set<(line: string) => void> } };
type OsLike = { networkInterfaces: Enumerate };

/** The line logged once when interfaces can't be listed. */
export const INTERFACES_UNAVAILABLE = 'interfaces unavailable; relay-only';

/**
 * Wraps `target.networkInterfaces` (node:os by default) so a failure returns `{}` instead of throwing, then lists the
 * interfaces once. Returns whether listing works. `log` gets INTERFACES_UNAVAILABLE once: now if listing has failed, or
 * when it first fails later. Idempotent: a second call reuses the wrapper.
 */
export function guardNetworkInterfaces(log: (line: string) => void = console.error, target: OsLike = os): boolean {
  let current = target.networkInterfaces as Guarded;
  if (!current[GUARDED]) {
    const original = current.bind(target) as Enumerate;
    const state = { failed: false, reason: '', logs: new Set<(line: string) => void>() };
    const guarded = (() => {
      try { return original(); } catch (error) {
        if (!state.failed) {
          state.failed = true;
          const code = (error as { code?: unknown })?.code;
          state.reason = typeof code === 'string' && code ? code : error instanceof Error ? error.message : String(error);
          for (const report of state.logs) report(unavailableLine(state.reason));
          state.logs.clear();
        }
        return {};
      }
    }) as Guarded;
    guarded[GUARDED] = state;
    target.networkInterfaces = guarded;
    current = guarded;
  }
  const state = current[GUARDED]!;
  if (state.failed) { log(unavailableLine(state.reason)); return false; }
  state.logs.add(log);
  current();
  return !state.failed;
}
const unavailableLine = (reason: string) => `${INTERFACES_UNAVAILABLE} (listing network interfaces failed: ${reason})`;

/** Whether a guarded `target` has failed to list interfaces. False when it was never guarded or always worked. */
export function interfacesUnavailable(target: OsLike = os): boolean {
  return !!(target.networkInterfaces as Guarded)[GUARDED]?.failed;
}

/**
 * `sdp` without the `a=candidate` lines whose address is an mDNS name (`*.local`). With no interfaces such a candidate
 * can't be resolved, and resolving it would open a multicast socket that enumerates interfaces; dropping it makes it a
 * failed candidate while the peer's relay candidates still connect.
 */
export function withoutMdnsCandidates(sdp: string): { sdp: string; dropped: number } {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  let dropped = 0;
  const lines = sdp.split(eol).filter(line => {
    if (!line.startsWith('a=candidate:')) return true;
    const address = line.slice('a=candidate:'.length).split(' ')[4] ?? '';
    if (!/\.local\.?$/i.test(address)) return true;
    dropped++;
    return false;
  });
  return { sdp: lines.join(eol), dropped };
}
