import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { RoomPrototype, Wordmark } from './prototype/RoomPrototype';
import type { SetupStatus } from './setup';
import { createSetupTransport, SessionRequiredError, sessionRequiredEvent } from './transport';

type Screen = 'loading' | 'access' | 'error' | 'identity' | 'preferences' | 'review' | 'settings' | 'rooms';
const route = () => {
  const query = new URLSearchParams(location.search);
  return { intentId: query.get('setup') || undefined, settings: query.get('settings') === '1' };
};

export function FirstRun({ accessTicket }: { accessTicket: string | null }) {
  const demo = new URLSearchParams(location.search).get('demo') === '1';
  return demo ? <RoomPrototype /> : <LocalEntry accessTicket={accessTicket} />;
}

function LocalEntry({ accessTicket }: { accessTicket: string | null }) {
  const [transport] = useState(createSetupTransport);
  const ticket = useRef(accessTicket);
  const loadSequence = useRef(0);
  const reconnectNeeded = useRef(false);
  const [screen, setScreen] = useState<Screen>('loading');
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [humanName, setHumanName] = useState('');
  const [machineName, setMachineName] = useState('');
  const [startAtLogin, setStartAtLogin] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [roomMounted, setRoomMounted] = useState(false);
  const [selectedRoomId, setSelectedRoomId] = useState<string>();
  const [connectionRevision, setConnectionRevision] = useState(0);
  const titleRef = useRef<HTMLHeadingElement>(null);

  function enterRooms(roomId?: string) {
    const url = new URL(location.href);
    url.searchParams.delete('setup'); url.searchParams.delete('settings');
    if (roomId) url.searchParams.set('room', roomId);
    history.replaceState(null, '', url);
    setSelectedRoomId(roomId); setRoomMounted(true); setScreen('rooms'); setError('');
  }
  async function load() {
    const sequence = ++loadSequence.current;
    setScreen('loading'); setError('');
    const requested = route();
    try {
      if (ticket.current) {
        try { await transport.exchange(ticket.current); ticket.current = null; }
        catch (failure) { if (failure instanceof SessionRequiredError) ticket.current = null; }
      }
      // Even a consumed or expired fragment may arrive with a valid owner cookie.
      const next = await transport.status(requested.intentId);
      if (sequence !== loadSequence.current) return;
      if (reconnectNeeded.current) { reconnectNeeded.current = false; setConnectionRevision(value => value + 1); }
      setStatus(next); setHumanName(next.humanName); setMachineName(next.machineName);
      setStartAtLogin(next.startup.preference === 'login');
      if (!next.completed) setScreen('identity');
      else if (requested.settings) setScreen('settings');
      else if (next.pending?.status === 'pending') setScreen('review');
      else enterRooms(next.pending?.roomId);
    } catch (failure) {
      if (sequence !== loadSequence.current) return;
      if (failure instanceof SessionRequiredError) reconnectNeeded.current = true;
      setScreen(failure instanceof SessionRequiredError ? 'access' : 'error');
      setError(failure instanceof Error ? failure.message : 'Could not load local setup. Retry when the daemon is available.');
    }
  }
  useEffect(() => {
    void load();
    const unauthorized = () => { reconnectNeeded.current = true; setScreen('access'); setError(''); };
    const navigation = () => { void load(); };
    window.addEventListener(sessionRequiredEvent, unauthorized);
    window.addEventListener('popstate', navigation);
    return () => {
      loadSequence.current++;
      window.removeEventListener(sessionRequiredEvent, unauthorized);
      window.removeEventListener('popstate', navigation);
    };
  }, []);
  useEffect(() => { if (screen !== 'rooms' && screen !== 'loading') titleRef.current?.focus({ preventScroll: true }); }, [screen]);

  function openSettings() {
    const url = new URL(location.href); url.searchParams.set('settings', '1');
    history.pushState(null, '', url); void load();
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending || !status) return;
    if (screen === 'identity') { setScreen('preferences'); setError(''); return; }
    const intentId = screen !== 'settings' && status.pending?.status === 'pending' ? status.pending.id : undefined;
    setPending(true); setError('');
    try {
      const result = await transport.save({ humanName: humanName.trim(), machineName: machineName.trim(), startAtLogin, intentId });
      enterRooms(result.roomId);
    } catch (failure) {
      if (failure instanceof SessionRequiredError) setScreen('access');
      else setError(failure instanceof Error ? failure.message : 'Could not confirm setup. Try the same action again.');
    } finally { setPending(false); }
  }

  const pendingRoom = status?.pending?.status === 'pending' ? status.pending : undefined;
  const firstRun = screen === 'identity' || screen === 'preferences';
  const heading = screen === 'identity' ? 'You and this machine' : screen === 'preferences' ? 'How Meshrooms runs' : screen === 'review' ? 'Create this room?' : screen === 'settings' ? 'Local settings' : screen === 'access' ? 'Open Meshrooms through your agent' : screen === 'error' ? 'Local setup is unavailable' : 'Opening Meshrooms…';
  const identityFields = <div className="setup-fields"><label>Your name<input name="humanName" autoComplete="name" value={humanName} onChange={event => setHumanName(event.target.value)} required maxLength={64} /><span>This name appears beside your messages.</span></label><label>Machine name<input name="machineName" autoComplete="off" value={machineName} onChange={event => setMachineName(event.target.value)} required maxLength={64} /><span>A label for this local daemon.</span></label></div>;
  const preferences = status && <div className="setup-preferences"><label className="startup-choice"><input type="checkbox" checked={startAtLogin} onChange={event => setStartAtLogin(event.target.checked)} disabled={!status.startup.supported} aria-describedby="startup-status" /><span><strong>Start Meshrooms when I sign in</strong><span>The daemon can keep running when you close this browser.</span></span></label><p className="startup-status" id="startup-status">{status.startup.message || (status.startup.supported ? status.startup.installed ? 'Start-at-login entry is installed.' : 'No start-at-login entry is installed.' : 'Start at login is not supported on this machine.')}{status.startup.message && status.startup.supported && <span>{status.startup.installed ? 'Startup entry installed.' : 'No startup entry installed.'}</span>}</p><details className="setup-advanced"><summary>Advanced</summary><div><h3>Storage location</h3><code>{status.dataDir}</code><p>Changing this location requires a separate migration.</p></div></details><p className="setup-local-note">Local only. MeshGuard is not connected.</p></div>;
  const roomReview = pendingRoom && <section className="setup-request" aria-label="Requested room"><h2>{pendingRoom.title}</h2><p>{pendingRoom.project || 'No project label'}</p><div className="setup-identities"><div><span className="avatar" aria-hidden="true">{(humanName || 'Y').slice(0, 1)}</span><div><strong>{humanName || 'You'} <span className="role-label">human</span></strong><span>Your participant on this machine</span></div></div><div><span className="avatar agent" aria-hidden="true"><svg width="19" height="19" viewBox="0 0 20 20" fill="none"><path d="M6 4 2 10l4 6m8-12 4 6-4 6M11 3 9 17" stroke="currentColor" strokeWidth="1.7" /></svg></span><div><strong>{pendingRoom.agentName} <span className="role-label">agent</span></strong><span>Awaiting your approval to connect</span></div></div></div></section>;

  let contents: ReactNode;
  if (screen === 'loading') contents = <p className="setup-intro" role="status">Checking this machine’s local setup.</p>;
  else if (screen === 'access') contents = <><p className="setup-intro">Ask your agent to open a fresh local Meshrooms link, then return here.</p><button className="primary" onClick={() => void load()}>Retry</button></>;
  else if (screen === 'error') contents = <><p className="setup-error" role="alert">{error}</p><button className="primary" onClick={() => void load()}>Retry</button></>;
  else contents = <form onSubmit={save} aria-label={heading}>
    {screen === 'identity' && <><p className="setup-intro">Choose how you appear in rooms and name this machine.</p>{identityFields}{pendingRoom && <div className="setup-agent-note"><span className="role-label">agent</span><strong>{pendingRoom.agentName}</strong><span>will join as a separate participant after you approve.</span></div>}</>}
    {screen === 'preferences' && <><p className="setup-intro">Choose how the local daemon starts. You can change this later in Settings.</p>{preferences}{roomReview}</>}
    {screen === 'review' && <><p className="setup-intro">Review the room and participants before creating it on <strong>{status?.machineName}</strong>.</p>{roomReview}<p className="setup-local-note">Your saved machine settings stay unchanged. Local only; MeshGuard is not connected.</p></>}
    {screen === 'settings' && <><p className="setup-intro">These settings apply to this machine’s daemon.</p>{identityFields}<h2 className="setup-section-heading">How Meshrooms runs</h2>{preferences}</>}
    {error && <p className="setup-error" role="alert">{error}</p>}
    <div className="setup-actions">{screen === 'preferences' ? <button type="button" className="secondary" disabled={pending} onClick={() => setScreen('identity')}>Back</button> : (screen === 'settings' || screen === 'review') ? <button type="button" className="secondary" disabled={pending} onClick={() => enterRooms()}>Back to rooms</button> : <span />}<button className="primary" type="submit" disabled={pending}>{pending ? 'Saving…' : screen === 'identity' ? 'Continue' : screen === 'settings' ? 'Save settings' : pendingRoom ? 'Create room' : 'Save and open rooms'}</button></div>
  </form>;

  return <>
    {roomMounted && <div hidden={screen !== 'rooms'}><RoomPrototype onSettings={openSettings} selectedRoomId={selectedRoomId} connectionRevision={connectionRevision} /></div>}
    {screen !== 'rooms' && <div className="setup-layout"><aside className="setup-rail"><Wordmark demo={false} />{firstRun && <ol className="setup-steps" aria-label="Setup progress"><li aria-current={screen === 'identity' ? 'step' : undefined}>You and this machine</li><li aria-current={screen === 'preferences' ? 'step' : undefined}>How Meshrooms runs</li></ol>}<p>One daemon on this machine.<br />Independent rooms for your work.</p></aside><main className="setup-main"><div className="setup-content"><h1 ref={titleRef} tabIndex={-1}>{heading}</h1>{firstRun && <p className="setup-progress">Step {screen === 'identity' ? '1' : '2'} of 2</p>}{contents}</div></main></div>}
  </>;
}
