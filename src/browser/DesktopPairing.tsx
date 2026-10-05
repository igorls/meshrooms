/**
 * "Use the desktop app" on the hosted site: pairs this browser with the Meshrooms app on this computer (pairing.ts).
 * The browser makes the secret, hands it to the app in a meshrooms://pair link, and shows the phrase the person types in
 * the app's own window. Once the app says it has asked to join, the person confirms here, and the browser links the
 * app's request in each of its rooms with the secret. Every link that finds nothing counts against this browser's wrong
 * codes in that room, so the browser links on the person's word, with a few retries, never by polling. The secret lives
 * in this component only, never in storage, and goes to the room service only inside the signed `link` of each room.
 */
import { useEffect, useRef, useState } from 'react';
import type { ApiError } from './client';
import type { RecentRoom } from './background';
import { PAIRING_NOT_FOUND } from './protocol';
import { PAIRING_TTL_MS, encodeSecret, newSecret, pairLink, pairingPhrase } from './pairing';
import { PAIRED_FLAG } from './desktop-join';

export { PAIRED_FLAG };
export const DOWNLOAD_URL = 'https://github.com/igorls/meshrooms/releases';
/** Links per room for one confirmation, a few seconds apart (the app may still be asking in later rooms). */
const TRIES = 3, BETWEEN_MS = 3_000;

type RoomState = 'waiting' | 'joined' | 'host' | 'missing' | 'failed';
type Run = { phrase: string; href: string; rooms: (RecentRoom & { state: RoomState; problem?: string })[]; linking?: boolean; outcome?: 'paired' | 'expired'; problem?: string };
const stateText: Record<RoomState, string> = { waiting: 'Waiting for the app', joined: 'Joined', host: 'Waiting for the host to admit it', missing: 'The app hasn’t asked here yet', failed: 'Not paired' };

export function DesktopPairing({ rooms, name, device, link }: { rooms: RecentRoom[]; name: string; device?: string; link(roomId: string, secret: string): Promise<Record<string, unknown>> }) {
  const [run, setRun] = useState<Run>();
  /** The secret of the pairing shown, while it lasts. */
  const pairing = useRef<{ secret: Uint8Array; until: number; stopped: boolean } | undefined>(undefined);
  const forget = () => { if (pairing.current) { pairing.current.stopped = true; pairing.current.secret.fill(0); } pairing.current = undefined; };
  useEffect(() => forget, []);

  async function start() {
    forget();
    const secret = newSecret(), list = rooms.slice(0, 64);
    if (!device) return;
    const href = pairLink({ origin: location.origin, name, device, rooms: list.map(r => r.id), secret });
    pairing.current = { secret, until: Date.now() + PAIRING_TTL_MS, stopped: false };
    setRun({ phrase: await pairingPhrase(secret), href, rooms: list.map(r => ({ ...r, state: 'waiting' })) });
    // Opening the app is the browser's to allow: some ask first, and the link shown opens it again.
    try { location.assign(href); } catch { /* The link shown does the same. */ }
  }

  /** The person says the app has asked: link each room still waiting, a few times while the app may still be asking. */
  async function confirm() {
    const held = pairing.current;
    if (!held || !run) return;
    if (Date.now() > held.until) { forget(); setRun({ ...run, outcome: 'expired' }); return; }
    let current: Run = { ...run, linking: true, problem: undefined, rooms: run.rooms.map(r => r.state === 'missing' ? { ...r, state: 'waiting' } : r) };
    const show = (next: Partial<Run>) => { current = { ...current, ...next }; if (!held.stopped) setRun(current); };
    const mark = (id: string, state: RoomState, problem?: string) => show({ rooms: current.rooms.map(r => r.id === id ? { id: r.id, title: r.title, state, ...(problem ? { problem } : {}) } : r) });
    show({});
    const n = encodeSecret(held.secret);
    for (let attempt = 0; attempt < TRIES && !held.stopped; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, BETWEEN_MS));
      for (const room of current.rooms.filter(r => r.state === 'waiting')) {
        if (held.stopped) return;
        try {
          const answer = await link(room.id, n);
          mark(room.id, answer.admitted === false ? 'host' : 'joined');
        } catch (error) {
          const e = error as ApiError;
          if (e.code === PAIRING_NOT_FOUND) continue;
          if (e.status === 429) { show({ problem: 'Too many tries in a room. Wait a few minutes, then confirm again.' }); attempt = TRIES; break; }
          mark(room.id, 'failed', e.message);
        }
      }
      if (!current.rooms.some(r => r.state === 'waiting')) break;
    }
    if (held.stopped) return;
    const rest = current.rooms.map(r => r.state === 'waiting' ? { ...r, state: 'missing' as const } : r);
    const linked = rest.some(r => r.state === 'joined' || r.state === 'host');
    if (linked) try { localStorage.setItem(PAIRED_FLAG, '1'); } catch { /* A convenience for later visits only. */ }
    // Done when no room is left to link; otherwise the person may confirm again once the app has asked there.
    const done = !rest.some(r => r.state === 'missing');
    show({ rooms: rest, linking: false, ...(done && linked ? { outcome: 'paired' as const } : {}) });
    if (done) forget();
  }
  function cancel() { forget(); setRun(undefined); }

  if (!rooms.length || !device) return null;
  if (!run) return <div className="browser-pairing">
    <p>Pair this browser with Meshrooms on this computer. The app joins your {rooms.length === 1 ? 'room' : `${rooms.length} rooms`} as another device of yours and keeps you present with no tab open.</p>
    <button className="secondary" onClick={() => void start()}>Use the desktop app</button>
  </div>;
  const waiting = run.rooms.some(r => r.state === 'waiting' || r.state === 'missing');
  return <div className="browser-pairing" aria-live="polite">
    {run.outcome === 'paired' ? <><h3>Paired. Open Meshrooms on this computer.</h3>
        <p>Your rooms are in the app now: open it from its menu to use them there.</p></>
      : run.outcome === 'expired' ? <p role="alert">This pairing expired. Start again when the app is open.</p>
      : <><p>Type this phrase in the Meshrooms app:</p>
        <code className="browser-link-code browser-pairing-phrase">{run.phrase}</code>
        <p>The app shows a window asking to pair with your browser. If it didn’t open, <a href={run.href} className="browser-pairing-open">open Meshrooms</a>. No app yet? <a href={DOWNLOAD_URL} target="_blank" rel="noreferrer">Download Meshrooms</a>.</p>
        <p>When the app says it has asked to join your rooms, confirm here.</p>
        {waiting && <button className="secondary" disabled={run.linking} onClick={() => void confirm()}>{run.linking ? 'Confirming…' : 'Confirm pairing'}</button>}</>}
    {run.problem && <p role="alert">{run.problem}</p>}
    <ul className="browser-pairing-rooms">{run.rooms.map(r => <li key={r.id}><span>{r.title}</span><span className={`is-${r.state}`}>{r.problem ?? stateText[r.state]}</span></li>)}</ul>
    <button className="browser-text-link" onClick={cancel}>{run.outcome ? 'Done' : 'Cancel pairing'}</button>
  </div>;
}
