/**
 * The "My phone" tab of the Invite dialog (phone-pairing.ts): this device shows a one-time QR code (or, for a phone that
 * cannot scan, a typed code), the phone opens it, and when the four words match on both screens this device links the
 * phone in each room. The words come from the phone's key as well as the code: this device asks the room service which
 * request answers the code (`link {pairing, preview}`) and works them out from that request's key, so a copy of the code
 * on another device shows other words. The secret lives in this component's memory only, for five minutes, is spent by
 * the first confirmation, and is withdrawn from the rooms (`revoke`) when the person says "not my phone" or starts over.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RecentRoom } from './background';
import { formatCountdown } from './invite-state';
import { OFFER_MAX_ROOMS, encodeSecret, newOfferCode, newSecret, offerSecret, showOfferCode } from './pairing';
import { PHONE_MAX_ROOMS, PHONE_TTL_MS, cancelOffer, fileOffer, linkPhoneRooms, phoneUrl, previewPhone, revokePhoneRooms, type LinkProblem, type LinkState, type PairCommander, type PairLinker, type PhoneSeen } from './phone-pairing';
import { deviceFingerprint } from './protocol';
import { qrMatrix, qrPath } from './qr';

export type PhoneAsking = { label: string; fingerprint: string };
type Stage = 'qr' | 'confirm' | 'linking' | 'done' | 'expired';
type Mode = 'qr' | 'code';
type Run = {
  mode: Mode; code?: string; createdAt: number; expiresAt: number; stage: Stage; chosen: string[]; shown: RecentRoom[];
  /** The phone that answered the code, with the words only its key gives (previewPhone). */
  seen?: PhoneSeen; looking?: boolean; filing?: boolean;
  results: Record<string, { state: LinkState; problem?: string }>; problem?: string; failure?: string; copied?: boolean;
};

const STATE_TEXT: Record<LinkState, string> = { waiting: 'Connecting…', joined: 'Connected', host: 'Waiting for the host', missing: 'Your phone hasn’t asked here yet', failed: 'Not connected' };

function Glyph({ kind }: { kind: 'check' | 'clock' | 'shield' | 'link' | 'phone' }) {
  const paths = {
    check: <path d="m5 12 5 5 9-10" strokeWidth="2.6" />, clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    shield: <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />,
    link: <path d="m10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" />,
    phone: <><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5h2" /></>,
  };
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}

/** The code as one SVG path, on a white card with the quiet zone the scanners want. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const matrix = useMemo(() => qrMatrix(text, 'M'), [text]), size = matrix.length, quiet = 3;
  return <svg className="phone-qr" role="img" aria-label={label} viewBox={`${-quiet} ${-quiet} ${size + quiet * 2} ${size + quiet * 2}`} shapeRendering="crispEdges">
    <rect x={-quiet} y={-quiet} width={size + quiet * 2} height={size + quiet * 2} fill="#fff" /><path d={qrPath(matrix)} fill="#182634" /></svg>;
}

export function PhonePairing({ active, rooms, name, device, link, command, asking, onActiveChange, onUseCode, onNotice, onClose }: {
  /** The dialog is open on this tab. */
  active: boolean;
  /** This room first, then the person's other rooms. */
  rooms: RecentRoom[]; name: string; device?: string;
  /** `link {pairing}` in a room, with `preview` (which request answers the code) or `revoke` (withdraw the unused ones). */
  link: PairLinker;
  /** `pair-offer`, `pair-cancel`: a typed code for a phone that cannot scan. */
  command: PairCommander;
  /** A device that asked to join, in a room this device hosts: the one the code was made for, most likely. */
  asking?: PhoneAsking;
  onActiveChange?(active: boolean): void;
  /** The long device code of old, for a phone that cannot scan. */
  onUseCode(): void;
  onNotice(text: string): void; onClose(): void;
}): ReactNode {
  const [run, setRun] = useState<Run>();
  const [now, setNow] = useState(() => Date.now());
  const bodyRef = useRef<HTMLDivElement>(null);
  /** The secret of the code shown, while it lasts. */
  const held = useRef<{ secret: Uint8Array; stopped: boolean; rooms: string[]; code?: string } | undefined>(undefined);
  /** The latest room-service handles, for the clean-up that runs after the component is gone. */
  const service = useRef({ link, command }); service.current = { link, command };
  /**
   * Lets go of the code: it can no longer be used from here. `withdraw` rooms get their unused requests answering it removed
   * at the room service, and a typed code is taken off it, so nothing the phone asked stays in anyone's queue.
   */
  function release(withdraw: string[] = held.current?.rooms ?? []) {
    const h = held.current;
    if (!h) return;
    held.current = undefined; h.stopped = true;
    const text = encodeSecret(h.secret), { link: linkRoom, command: send } = service.current;
    h.secret.fill(0);
    if (withdraw.length) void revokePhoneRooms({ rooms: withdraw, secret: text, link: linkRoom });
    if (h.code && h.rooms.length) void cancelOffer({ code: h.code, roomId: h.rooms[0], command: send });
  }
  useEffect(() => () => release(), []);

  const pending = !!run && (run.stage === 'qr' || run.stage === 'confirm' || run.stage === 'linking');
  useEffect(() => { onActiveChange?.(pending); return () => onActiveChange?.(false); }, [pending, onActiveChange]);

  /** A new code: the QR code, or a typed one. Whatever was open before is withdrawn. */
  async function start(mode: Mode = 'qr', keep?: string[], problem?: string) {
    release();
    if (!device || !rooms.length) return;
    const at = Date.now(), cap = mode === 'code' ? OFFER_MAX_ROOMS : PHONE_MAX_ROOMS;
    const shown = rooms.slice(0, PHONE_MAX_ROOMS), chosen = (keep?.length ? shown.filter(r => keep.includes(r.id)) : shown).slice(0, cap).map(r => r.id);
    setNow(at);
    // A new code is read from its top: the page may have been scrolled to the buttons that asked for it.
    requestAnimationFrame(() => bodyRef.current?.scrollTo?.({ top: 0 }));
    if (mode === 'qr') {
      held.current = { secret: newSecret(), stopped: false, rooms: chosen };
      setRun({ mode, createdAt: at, expiresAt: at + PHONE_TTL_MS, stage: 'qr', chosen, shown, results: {}, ...(problem ? { problem } : {}) });
      return;
    }
    const code = newOfferCode(), secret = await offerSecret(code), mine = { secret, stopped: false, rooms: chosen, code };
    held.current = mine;
    setRun({ mode, code, createdAt: at, expiresAt: at + PHONE_TTL_MS, stage: 'qr', chosen, shown, filing: true, results: {} });
    try {
      await fileOffer({ code, rooms: chosen, command });
      // The code is shown only once the room service holds it: before that nobody could redeem it.
      if (!mine.stopped) setRun(current => current && current.createdAt === at ? { ...current, filing: false } : current);
    } catch (error) {
      if (held.current === mine) { release([]); setRun(undefined); }
      void start('qr', chosen, `Couldn’t make a typed code: ${(error as Error).message || 'try again'}`);
    }
  }
  // A code is made when the tab is first shown, and again only when the person asks (or after it was spent or expired).
  useEffect(() => {
    if (!active || !device) return;
    // Back after a phone was connected or a code ran out: a fresh code, not the old result.
    if (!run || run.stage === 'done' || run.stage === 'expired') void start(run?.mode ?? 'qr');
  }, [active, device, rooms.length]);
  // The countdown ticks while the dialog shows a code that is waiting; when it runs out the secret is dropped.
  useEffect(() => {
    if (!active || !pending) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, pending]);
  // Even with the dialog closed, a code that nobody used is dropped when its time is up.
  useEffect(() => {
    if (!run || (run.stage !== 'qr' && run.stage !== 'confirm')) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, run.expiresAt - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [run?.createdAt, run?.stage]);
  useEffect(() => {
    if (run && (run.stage === 'qr' || run.stage === 'confirm') && now >= run.expiresAt) { release(); setRun({ ...run, stage: 'expired' }); }
  }, [now, run]);

  const url = useMemo(() => {
    if (!run || run.mode !== 'qr' || !held.current || !device || (run.stage !== 'qr' && run.stage !== 'confirm') || !run.chosen.length) return '';
    return phoneUrl(location.origin, { secret: held.current.secret, device, name, rooms: run.chosen });
  }, [run?.stage, run?.chosen, run?.createdAt, run?.mode, device, name]);

  /**
   * The phone has asked: find its request and work out the words from its key. `quiet` is the automatic try when a device
   * is seen asking in this room, which says nothing when it finds nothing.
   */
  async function showWords(quiet = false) {
    const mine = held.current;
    if (!mine || !run || run.stage !== 'qr' || run.looking || run.filing) return;
    const at = run.createdAt;
    setRun(current => current && current.createdAt === at ? { ...current, looking: true, problem: undefined } : current);
    try {
      const seen = await previewPhone({ rooms: run.chosen, secret: mine.secret, link });
      if (mine.stopped) return;
      setRun(current => current && current.createdAt === at && current.stage === 'qr' ? seen ? { ...current, looking: false, stage: 'confirm', seen } : {
        ...current, looking: false, ...(quiet ? {} : { problem: run.mode === 'code' ? 'Your phone hasn’t asked to join yet. Type the code on it and tap “Connect this phone”, then try again.'
          : 'Your phone hasn’t asked to join yet. Scan the code, tap “Connect this phone” on it, then try again.' }) } : current);
    } catch (error) {
      if (mine.stopped) return;
      const e = error as LinkProblem;
      if (e.status === 409) {
        // Two devices answer one code: something is wrong, so neither is linked and this code is over.
        release();
        setRun(current => current && { ...current, looking: false, stage: 'expired', failure: 'Two devices answered this code, so nothing was connected. If you only scanned it once, someone else may have a copy. Make a new code.' });
        return;
      }
      setRun(current => current && current.createdAt === at ? { ...current, looking: false, ...(quiet ? {} : { problem: e.status === 429 ? 'Too many tries. Wait a few minutes, then try again.' : e.message || 'Couldn’t check your phone. Try again.' }) } : current);
    }
  }
  // A device seen asking in this room is looked up once, without the person pressing anything.
  const autoLooked = useRef('');
  useEffect(() => {
    if (!asking || !run || run.stage !== 'qr' || run.looking || run.filing || !held.current) return;
    const key = `${run.createdAt}:${asking.fingerprint}`;
    if (autoLooked.current === key) return;
    autoLooked.current = key;
    void showWords(true);
  }, [asking?.fingerprint, run?.createdAt, run?.stage, run?.filing]);

  async function confirm() {
    const secret = held.current;
    if (!secret || !run) return;
    if (Date.now() >= run.expiresAt) { release(); setRun({ ...run, stage: 'expired' }); return; }
    const chosen = run.chosen;
    setRun({ ...run, stage: 'linking', problem: undefined, results: Object.fromEntries(chosen.map(id => [id, { state: 'waiting' as LinkState }])) });
    const done = await linkPhoneRooms({
      rooms: chosen, secret: encodeSecret(secret.secret), stopped: () => secret.stopped, link,
      // Decided when it is reported, not when React gets to the update: the pairing is spent right after the last room.
      report: (id, state, problem) => { const live = !secret.stopped; setRun(current => current && live ? { ...current, results: { ...current.results, [id]: { state, ...(problem ? { problem } : {}) } } } : current); },
    });
    if (secret.stopped) return;
    const linked = Object.values(done.states).some(s => s === 'joined' || s === 'host');
    if (!linked) {
      // Nothing got in: keep the code if the phone may still ask.
      setRun(current => current && { ...current, stage: 'confirm', results: {}, problem: done.rateLimited ? 'Too many tries. Wait a few minutes, then confirm again.'
        : Object.values(done.states).every(s => s === 'missing') ? 'Your phone hasn’t asked to join yet. Tap “Connect this phone” on it first, then confirm again.' : 'None of your rooms accepted the phone. See the list for why.' });
      return;
    }
    // Spent: what the phone asked in rooms that did not get it is withdrawn, so no stranger-looking request is left behind.
    release(chosen.filter(id => done.states[id] !== 'joined' && done.states[id] !== 'host'));
    setRun(current => current && { ...current, stage: 'done', problem: undefined });
    onNotice('Your phone is connected.');
  }
  const again = () => void start(run?.mode ?? 'qr', run?.chosen);
  async function copyLink() {
    if (!url) return;
    try { await navigator.clipboard.writeText(url); setRun(current => current && { ...current, copied: true }); }
    catch { setRun(current => current && { ...current, problem: 'Couldn’t copy automatically.' }); }
  }
  function choose(id: string) {
    setRun(current => {
      if (!current || current.stage !== 'qr' || current.mode !== 'qr') return current;
      const on = current.chosen.includes(id);
      if (on && current.chosen.length === 1) return current;
      return { ...current, copied: false, chosen: on ? current.chosen.filter(r => r !== id) : current.shown.filter(r => r.id === id || current.chosen.includes(r.id)).map(r => r.id) };
    });
  }

  const stage: Stage | undefined = run?.stage;
  const left = run ? Math.max(0, run.expiresAt - now) : 0;
  const titleOf = (id: string) => run?.shown.find(r => r.id === id)?.title ?? rooms.find(r => r.id === id)?.title ?? 'Room';
  const words = (run?.seen?.words || '').split(' ').filter(Boolean);

  function body(): ReactNode {
    const qrSteps = <ol className="phone-steps">
      <li><span>1</span><div>Open your phone’s <b>camera</b> and point it at this code.</div></li>
      <li><span>2</span><div>Tap the link it shows, then <b>Connect this phone</b>.<small>It opens in your phone’s browser. Nothing to install.</small></div></li>
      <li><span>3</span><div>Check that the four words match, and confirm here.</div></li></ol>;
    if (!device && !run) return <p className="invite-lead" role="status">This browser isn’t ready yet.</p>;
    // Before the tab is first shown no code exists yet: the same layout, empty, so the dialog is already sized for it.
    if (!run || !stage) return <>
      <div className="phone-layout">
        <div className="phone-code"><div className="phone-qr-card"><span className="phone-qr-empty" role="status">Making a code…</span></div>
          <p className="phone-ttl"><Glyph kind="clock" /><span>Works once · lasts <b>{formatCountdown(PHONE_TTL_MS)}</b></span></p></div>
        {qrSteps}
      </div>
      <div><span className="invite-label">Rooms to connect · {Math.min(rooms.length, PHONE_MAX_ROOMS)}</span>
        <div className="phone-chips">{rooms.slice(0, PHONE_MAX_ROOMS).map(r => <span key={r.id} className="phone-chip is-on"><Glyph kind="check" /><span>{r.title}</span></span>)}</div></div></>;
    if (stage === 'expired') return <div className="invite-error" role="alert"><b>{run.failure ? 'This code can’t be used.' : 'The code expired.'}</b><br />{run.failure ?? 'Codes work once and last five minutes. Nothing was shared and no phone was connected. Make a new one to try again.'}</div>;
    if (stage === 'done') return <>
      <div className="phone-done"><span className="phone-big-check" aria-hidden="true"><Glyph kind="check" /></span><b>Your phone is connected</b><span>It joined as you, not as a new person.</span></div>
      <ul className="phone-rooms" aria-label="Rooms">{Object.entries(run.results).map(([id, r]) => <li key={id} className={`is-${r.state}`}><span className="phone-tick" aria-hidden="true">{r.state === 'joined' ? <Glyph kind="check" /> : r.state === 'host' ? <Glyph kind="clock" /> : '!'}</span><span>{titleOf(id)}</span><small>{r.problem && r.state === 'failed' ? r.problem : STATE_TEXT[r.state]}</small></li>)}</ul>
      <ul className="invite-facts"><li><Glyph kind="shield" /><span>Not yours? Remove it under <b>Room details › Manage your devices</b>.</span></li></ul></>;
    if (stage === 'confirm' || stage === 'linking') return <>
      <div><b className="phone-question">Do your phone and this screen show the same four words?</b><p className="invite-lead invite-muted">The words come from your phone’s own key, so a copy of the code on another device would show different ones.</p></div>
      <div className="phone-words" role="group" aria-label="Words to compare with your phone">{words.map((w, i) => <span key={i} className="phone-word">{w}</span>)}</div>
      {run.seen && <div className="phone-device"><span className="invite-badge is-phone is-big" aria-hidden="true"><Glyph kind="phone" /></span><span><b>{run.seen.label}</b><small>Key {deviceFingerprint(run.seen.deviceId)}</small></span></div>}
      {stage === 'linking' && <ul className="phone-rooms" aria-label="Rooms" aria-live="polite">{Object.entries(run.results).map(([id, r]) => <li key={id} className={`is-${r.state}`}><span className="phone-tick" aria-hidden="true">{r.state === 'joined' ? <Glyph kind="check" /> : r.state === 'waiting' ? '…' : r.state === 'host' ? <Glyph kind="clock" /> : '!'}</span><span>{titleOf(id)}</span><small>{r.problem && r.state === 'failed' ? r.problem : STATE_TEXT[r.state]}</small></li>)}</ul>}
      <p className="invite-warn"><Glyph kind="shield" /><span><b>Different words, or you didn’t start this?</b> Don’t connect. Someone else may have used the code: press “Not my phone” and it is withdrawn.</span></p>
      {run.problem && <p className="invite-problem" role="alert">{run.problem}</p>}</>;
    const roomChips = <div><span className="invite-label" id="phone-rooms-label">Rooms to connect · {run.chosen.length}</span>
      <div className="phone-chips" role="group" aria-labelledby="phone-rooms-label">{run.shown.filter(r => run.mode === 'qr' || run.chosen.includes(r.id)).map(r => { const on = run.chosen.includes(r.id);
        return <button key={r.id} type="button" role="checkbox" aria-checked={on} disabled={run.mode === 'code'} className={`phone-chip${on ? ' is-on' : ''}`} onClick={() => choose(r.id)}>{on && <Glyph kind="check" />}<span>{r.title}</span></button>; })}</div>
      {run.mode === 'qr' && rooms.length > run.shown.length && <p className="invite-lead invite-muted phone-more">The code holds {PHONE_MAX_ROOMS} rooms at most. Open a room and make a code there to add the rest.</p>}
      {run.mode === 'code' && rooms.length > run.chosen.length && <p className="invite-lead invite-muted phone-more">A typed code holds {OFFER_MAX_ROOMS} rooms at most. Open a room and make a code there to add the rest.</p>}</div>;
    if (run.mode === 'code') return <>
      <div className="phone-layout is-typed">
        <div className="phone-code"><div className={`phone-offer${left < 30_000 ? ' is-low' : ''}`}>
          <span className="invite-label" id="phone-offer-label">Your code</span>
          {run.filing || !run.code ? <span className="phone-offer-code is-empty" role="status">Making a code…</span> : <output className="phone-offer-code" aria-labelledby="phone-offer-label">{showOfferCode(run.code)}</output>}</div>
          <p className="phone-ttl"><Glyph kind="clock" /><span>Works once · expires in <b>{formatCountdown(left)}</b></span></p></div>
        <ol className="phone-steps">
          <li><span>1</span><div>On your phone, open <b>{location.host}/rooms</b>.</div></li>
          <li><span>2</span><div>Tap <b>Connect this phone with a code</b>, type this code and tap <b>Continue</b>, then <b>Connect this phone</b>.</div></li>
          <li><span>3</span><div>Tap <b>My phone shows four words</b> below, and check that they match.</div></li></ol>
      </div>
      {roomChips}
      <div className="phone-alt"><span>Can scan after all?</span>
        <button type="button" className="browser-text-link" onClick={() => void start('qr', run.chosen)}>Show the QR code instead</button>
        <button type="button" className="browser-text-link" onClick={onUseCode}>Use a long device code</button></div>
      {run.problem && <p className="invite-problem" role="alert">{run.problem}</p>}</>;
    return <>
      <div className="phone-layout">
        <div className="phone-code"><div className={`phone-qr-card${left < 30_000 ? ' is-low' : ''}`}>{url ? <QrCode text={url} label="QR code that connects your phone. It is a one-time secret." /> : <span className="phone-qr-empty">Choose a room</span>}</div>
          <p className="phone-ttl"><Glyph kind="clock" /><span>Works once · expires in <b>{formatCountdown(left)}</b></span></p></div>
        {qrSteps}
      </div>
      {roomChips}
      <div className="phone-alt"><span>Can’t scan?</span>
        <button type="button" className="browser-text-link" onClick={() => void start('code', run.chosen)}><Glyph kind="link" />Type a code instead</button>
        <button type="button" className="browser-text-link" onClick={() => void copyLink()} disabled={!url}>{run.copied ? 'Copied: send it to your phone' : 'Copy one-time link'}</button>
        <button type="button" className="browser-text-link" onClick={onUseCode}>Use a long device code</button></div>
      {run.problem && <p className="invite-problem" role="alert">{run.problem}</p>}</>;
  }
  function foot(): ReactNode {
    if (!run || !stage) return <button type="button" className="secondary" onClick={onClose}>Done</button>;
    if (stage === 'expired') return <><button type="button" className="phone-cta" onClick={again}>Make a new code</button><button type="button" className="invite-text" onClick={onClose}>Close</button></>;
    if (stage === 'done') return <><button type="button" className="primary invite-primary" onClick={onClose}>Done</button><button type="button" className="invite-text" onClick={() => void start(run.mode, run.chosen)}>Connect another phone</button></>;
    if (stage === 'confirm' || stage === 'linking') return <><button type="button" className="phone-cta" disabled={stage === 'linking'} onClick={() => void confirm()}>{stage === 'linking' ? 'Connecting…' : <><Glyph kind="check" />They match, connect</>}</button>
      <button type="button" className="invite-text phone-danger" disabled={stage === 'linking'} onClick={again}>Not my phone</button></>;
    return <><button type="button" className="phone-cta is-quiet" disabled={!!run.looking || !!run.filing} onClick={() => void showWords()}>{run.looking ? 'Looking for your phone…' : 'My phone shows four words'}</button>
      <span className="invite-foot-note">Anyone who sees this code in the next five minutes could try to use it. Don’t share a screenshot.</span></>;
  }
  return <div className="invite-panel" role="tabpanel" id="invite-panel-phone" aria-labelledby="invite-tab-phone">
    <div className="invite-body" ref={bodyRef}>{body()}</div>
    <div className="invite-foot">{foot()}</div>
  </div>;
}
