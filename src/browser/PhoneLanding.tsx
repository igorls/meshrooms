/**
 * The page a phone opens from the QR code (`/rooms#pair=…`, phone-pairing.ts). It sends nothing until the person taps
 * "Connect this phone": a link preview or a prefetch can't start a pairing. Then it asks to join each room as a
 * companion, shows the four words the trusted device shows too, and follows the rooms until the trusted device has
 * linked them. The secret lives in this component only, for five minutes, and the address bar no longer holds it.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { RoomSource } from './source';
import { PHONE_TTL_MS, askPhoneRooms, deviceLabel, phoneFinished, phoneRoomFrom, type PhoneLink, type PhoneRoomState } from './phone-pairing';
import { formatCountdown } from './invite-state';
import { pairingSas } from './pairing';
import { identity } from './storage';
import { deviceFingerprint } from './protocol';

type Stage = 'consent' | 'asking' | 'waiting' | 'done' | 'expired';
type Room = { id: string; state: PhoneRoomState; title?: string; problem?: string };
const POLL_MS = 2500;

const ROOM_TEXT: Record<PhoneRoomState, string> = { asking: 'Asking…', asked: 'Waiting for your computer', joined: 'Connected', host: 'Waiting for the host', failed: 'Not connected' };

/** A fragment that was there but is not a pairing: said plainly, with the way out. */
export function PhoneInvalid(): ReactNode {
  return <section className="browser-entry phone-landing"><h1>This code can’t be used</h1>
    <p>It is incomplete or has been changed. Make a new one on your computer: open a room, choose <strong>Invite</strong>, then <strong>My phone</strong>.</p>
    <div className="browser-entry-actions"><a className="browser-text-link" href="/rooms">Start or open a room</a></div></section>;
}

export function PhoneLanding({ link, source, onLeave, viaCode }: { link: PhoneLink; source: RoomSource; onLeave(): void; viaCode?: boolean }): ReactNode {
  const [stage, setStage] = useState<Stage>('consent');
  const [rooms, setRooms] = useState<Room[]>(() => link.rooms.map(id => ({ id, state: 'asking' })));
  const [phrase, setPhrase] = useState(''), [key, setKey] = useState('');
  const [problem, setProblem] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const latest = useRef(rooms); latest.current = rooms;
  const secret = useRef<Uint8Array | undefined>(link.secret);
  const deadline = useRef(Math.min(Date.now() + PHONE_TTL_MS, link.expiresAt ?? Infinity)), changedAt = useRef(Date.now()), stopped = useRef(false);
  const drop = () => { stopped.current = true; secret.current?.fill(0); secret.current = undefined; };
  useEffect(() => () => drop(), []);
  const update = (id: string, patch: Partial<Room>) => setRooms(list => list.map(r => r.id === id ? { ...r, ...patch } : r));

  /** Cancel: take back what this phone asked for, in every room still waiting, so nothing is left in a host's queue. */
  async function cancel() {
    const asked = latest.current.filter(r => r.state === 'asked' || r.state === 'host').map(r => r.id);
    drop(); onLeave();
    for (const id of asked) {
      try {
        const status = await source.command('status', id, { session: crypto.randomUUID() }) as { request?: { id: string; state: string; linkedMemberId?: string } };
        if (status.request?.state === 'pending' && !status.request.linkedMemberId) await source.command('cancel', id, { requestId: status.request.id });
      } catch { /* The request expires in ten minutes anyway. */ }
    }
  }

  async function connect() {
    const held = secret.current;
    if (!held || Date.now() >= deadline.current) { drop(); setStage('expired'); return; }
    setStage('asking'); setProblem(''); changedAt.current = Date.now();
    try {
      const me = await identity();
      setKey(deviceFingerprint(me.id));
      // The words come from this phone's own key as well as the code: the computer works them out from the key the room service holds for the request.
      setPhrase(await pairingSas(held, me.publicKey));
      await askPhoneRooms({ rooms: link.rooms, secret: held, trustedDevice: link.device, publicKey: me.publicKey, label: deviceLabel(navigator.userAgent, navigator.maxTouchPoints),
        request: (id, payload) => source.command('request', id, payload),
        report: (id, state, why) => { if (!stopped.current) update(id, { state, ...(why ? { problem: why } : {}) }); } });
      if (stopped.current) return;
      setStage('waiting'); changedAt.current = Date.now();
      for (const id of link.rooms) void source.room(id).then(r => { if ('title' in r && !stopped.current) update(id, { title: r.title }); }).catch(() => {});
    } catch (error) { setProblem((error as Error).message || 'Couldn’t reach Meshrooms. Try again.'); setStage('consent'); }
  }
  // While the trusted device has not linked the rooms: read them, slowly, and only until this code runs out.
  useEffect(() => {
    if (stage !== 'waiting') return;
    let alive = true;
    const tick = async () => {
      setNow(Date.now());
      if (Date.now() >= deadline.current) { drop(); if (alive) setStage(latest.current.some(r => r.state === 'joined' || r.state === 'host') ? 'done' : 'expired'); return; }
      for (const room of latest.current.filter(r => r.state === 'asked' || r.state === 'host')) {
        try {
          const status = await source.command('status', room.id, { session: crypto.randomUUID() }) as { memberId?: string; request?: { state: string; linkedMemberId?: string } };
          const next = phoneRoomFrom(status, room.state);
          if (alive && !stopped.current && (next.state !== room.state || next.problem)) { changedAt.current = Date.now(); update(room.id, { state: next.state, ...(next.problem ? { problem: next.problem } : {}) }); }
        } catch { /* The next tick tries again. */ }
      }
      if (alive && phoneFinished(latest.current.map(r => r.state), Date.now() - changedAt.current)) { drop(); setStage('done'); }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [stage]);

  const words = phrase.split(' ').filter(Boolean);
  const first = rooms.find(r => r.state === 'joined');
  const roomList = (labels: (r: Room) => string) => <ul className="phone-rooms" aria-label="Rooms" aria-live="polite">{rooms.map(r => <li key={r.id} className={`is-${r.state}`}>
    <span className="phone-tick" aria-hidden="true">{r.state === 'joined' ? '✓' : r.state === 'failed' ? '!' : r.state === 'host' ? '…' : '·'}</span><span>{r.title ?? 'Room'}</span><small>{labels(r)}</small>
    {r.state === 'joined' && <a className="browser-text-link" href={`/r/${r.id}`}>Open</a>}</li>)}</ul>;

  if (stage === 'consent') return <section className="browser-entry phone-landing" aria-labelledby="phone-landing-title">
    <p className="phone-origin"><span aria-hidden="true">🔒</span> {location.host}</p>
    <h1 id="phone-landing-title">Connect this phone to your rooms?</h1>
    <p>This phone will join {link.rooms.length === 1 ? <strong>1 room</strong> : <strong>{link.rooms.length} rooms</strong>} as {link.name ? <strong>{link.name}</strong> : 'you'}, the same person, not a new one.</p>
    <p className="invite-warn phone-warn"><span>{viaCode ? <><b>Only continue if you typed a code your own computer showed you.</b> If someone else gave you this code, cancel.</> : <><b>Only continue if you just opened this from your own computer.</b> If someone sent you this link, close the page.</>}</span></p>
    {problem && <p role="alert" className="browser-error">{problem}</p>}
    <div className="phone-actions"><button type="button" className="primary" onClick={() => void connect()}>Connect this phone</button><button type="button" className="secondary" onClick={() => void cancel()}>Cancel</button></div>
  </section>;
  if (stage === 'expired') return <section className="browser-entry phone-landing"><h1>The code expired</h1>
    <p>Codes work once and last five minutes. Nothing was shared. On your computer, open <strong>Invite</strong> then <strong>My phone</strong> for a new one, and scan it again.</p>
    <div className="browser-entry-actions"><a className="browser-text-link" href="/rooms">Start or open a room</a></div></section>;
  if (stage === 'done') return <section className="browser-entry phone-landing"><div className="phone-done"><span className="phone-big-check" aria-hidden="true">✓</span>
    <h1>{first ? 'Phone connected' : 'Not connected yet'}</h1>
    <p>{first ? 'You’re in as yourself on this phone.' : 'Your computer didn’t finish linking this phone. Nothing was shared. Try again from your computer.'}</p></div>
    {roomList(r => r.state === 'asked' ? 'Not linked from your computer' : r.problem && r.state === 'failed' ? r.problem : ROOM_TEXT[r.state])}
    <div className="phone-actions">{first ? <a className="primary" href={`/r/${first.id}`}>Open {first.title ?? 'your room'}</a> : <a className="primary" href="/rooms">Back to Meshrooms</a>}</div></section>;
  return <section className="browser-entry phone-landing" aria-busy={stage === 'asking'} aria-labelledby="phone-landing-title">
    <h1 id="phone-landing-title">{stage === 'asking' ? 'Connecting…' : 'Check your computer'}</h1>
    {stage === 'waiting' && <>
      <p>Your computer should show these four words. If it does, tap <strong>They match, connect</strong> there.</p>
      <div className="phone-words" role="group" aria-label="Four words to compare with your computer">{words.map((w, i) => <span key={i} className="phone-word">{w}</span>)}</div>
      <p className="phone-wait"><span className="phone-spin" aria-hidden="true" />Waiting for your computer · expires in <b>{formatCountdown(deadline.current - now)}</b>{key && <> · this phone is Key {key}</>}</p></>}
    {roomList(r => r.problem && r.state === 'failed' ? r.problem : ROOM_TEXT[r.state])}
    <p className="invite-lead invite-muted">If the words differ, or you didn’t start this, cancel and close the page.</p>
    <div className="phone-actions"><button type="button" className="secondary" onClick={() => void cancel()}>Cancel</button></div>
  </section>;
}
