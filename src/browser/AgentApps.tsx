import { useEffect, useState } from 'react';
import type { AgentAppListing } from '../../server/harness-apps';
import type { HarnessId, LocalAgents } from './source';
import { Wordmark } from '../prototype/RoomPrototype';
import './agent-apps.css';

export function AgentApps({ api }: { api: LocalAgents }) {
  const [listing, setListing] = useState<AgentAppListing>();
  const [problem, setProblem] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string>();
  const [confirm, setConfirm] = useState<{ id: string; action: 'received' | 'retry' }>();
  async function refresh() {
    if (!api.apps) { setProblem('Update Meshrooms to manage agent apps on this computer.'); return; }
    try { setListing(await api.apps()); setProblem(''); }
    catch (error) { setProblem((error as Error).message); }
  }
  useEffect(() => { void refresh(); }, [api]);
  useEffect(() => {
    if (!api.deliveries || busy) return;
    let stopped = false;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void api.deliveries!().then(deliveries => { if (!stopped) setListing(current => current ? { ...current, deliveries } : current); }).catch(() => { /* Check apps reports connection errors. */ });
    }, 4_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [api, busy]);
  async function configure(id: HarnessId, enabled: boolean, codexDelivery?: 'desktop' | 'headless') {
    if (!api.configureApp) return;
    setBusy(id); setNotice('');
    try { await api.configureApp(id, { enabled, ...(id === 'codex' ? { codexDelivery: codexDelivery ?? 'desktop' } : {}) }); await refresh(); setNotice('Saved for new bindings. Existing bindings keep their current settings.'); }
    catch (error) { setProblem((error as Error).message); }
    finally { setBusy(undefined); }
  }
  async function resolve() {
    if (!confirm || !api.resolveDelivery) return;
    setBusy(confirm.id);
    try { await api.resolveDelivery(confirm.id, confirm.action); setConfirm(undefined); await refresh(); setNotice('Your decision was saved. The room watcher will pick it up.'); }
    catch (error) { setProblem((error as Error).message); }
    finally { setBusy(undefined); }
  }
  const apps = listing?.apps ?? [], uncertain = listing?.deliveries.filter(d => d.state === 'uncertain') ?? [];
  const available = apps.filter(a => a.id === 'codex' && a.codexDelivery === 'desktop' ? a.desktop?.available : a.scan?.detected && a.id !== 'exec').length;
  return <div className="agent-apps-page">
    <a className="skip-link" href="#agent-apps-main">Skip to agent apps</a>
    <header className="agent-apps-header"><a className="browser-brand" href="/rooms" aria-label="Meshrooms rooms"><Wordmark demo={false} /></a>
      <nav aria-label="Meshrooms"><a href="/rooms">Your rooms</a><a href="/agent-apps" aria-current="page">Agent apps</a></nav></header>
    <main id="agent-apps-main" className="agent-apps-main">
      <div className="agent-apps-heading"><div><p className="agent-apps-eyebrow">ON THIS COMPUTER</p><h1>Agent apps</h1>
        <p>Connect the agents you already work with.</p></div>
        <button className="secondary" disabled={!!busy} onClick={() => { setBusy('scan'); void refresh().finally(() => setBusy(undefined)); }}>{busy === 'scan' ? 'Checking…' : 'Check apps'}</button></div>
      <div className="agent-apps-overview"><span><strong>{listing ? available : '—'}</strong> apps available</span>
        <span><strong>{listing ? apps.filter(a => a.enabled).length : '—'}</strong> integrations enabled</span>
        <span><strong>{listing ? uncertain.length : '—'}</strong> {uncertain.length === 1 ? 'delivery' : 'deliveries'} to review</span></div>
      {problem && <p role="alert" className="browser-error">{problem} <button onClick={() => void refresh()}>Retry</button></p>}
      {notice && <p role="status" className="browser-notice">{notice}</p>}
      {!listing && !problem && <p aria-busy="true">Looking for agent apps…</p>}
      {uncertain.length > 0 && <section className="agent-apps-recovery" aria-labelledby="delivery-review"><h2 id="delivery-review">Check these deliveries</h2>
        <p>The desktop connection ended before Meshrooms received a confirmation. Check the chat before deciding what happens next.</p>
        {uncertain.map(d => <div className="agent-delivery" key={d.id}><div><strong>{d.title || 'Codex room event'}</strong><span>{d.createdAt ? new Date(d.createdAt).toLocaleString() : 'Time unavailable'}</span>
          <code>{d.id}</code><a href={`codex://threads/${d.threadId}`}>Open the bound chat</a></div>
          {confirm?.id === d.id ? <div className="agent-delivery-confirm" role="group" aria-label="Resolve uncertain delivery">
            <p>{confirm.action === 'retry' ? 'Retry only if the event is missing from the chat. It may arrive twice if Codex accepted the first attempt.' : 'Mark received only if you found this event in the bound chat. Meshrooms will continue with later messages.'}</p>
            <button className="secondary" disabled={!!busy} onClick={() => void resolve()}>{confirm.action === 'retry' ? 'Confirm retry' : 'Confirm received'}</button>
            <button className="browser-text-link" disabled={!!busy} onClick={() => setConfirm(undefined)}>Cancel</button></div>
            : <div className="agent-delivery-actions"><button className="secondary" disabled={!!busy} onClick={() => setConfirm({ id: d.id, action: 'received' })}>Mark received</button>
              <button className="browser-text-link" disabled={!!busy} onClick={() => setConfirm({ id: d.id, action: 'retry' })}>Retry delivery</button></div>}</div>)}
      </section>}
      <section className="agent-apps-grid" aria-label="Harness integrations">{apps.map(app => {
        const desktop = app.id === 'codex' && app.codexDelivery === 'desktop';
        const detected = desktop ? app.desktop?.available : app.scan?.detected;
        const status = !app.enabled ? 'Disabled' : app.id === 'exec' ? 'Custom setup' : detected ? desktop ? 'Desktop available' : 'Detected' : 'Setup needed';
        return <article className="agent-app-card" key={app.id} aria-labelledby={`app-${app.id}`}>
          <div className="agent-app-card-title"><div className={`agent-app-symbol is-${app.id}`} aria-hidden="true">{app.id === 'codex' ? 'C' : app.id === 'claude' ? '✳' : app.id === 'hermes' ? 'H' : '›_'}</div>
            <div><h2 id={`app-${app.id}`}>{app.label}</h2><span>{app.scan?.version ? `Version ${app.scan.version}` : app.id === 'exec' ? 'Your own harness' : desktop && detected ? 'Local desktop connection' : 'No version detected'}</span></div>
            <span className={`agent-app-status ${detected && app.enabled ? 'is-ready' : ''}`}>{status}</span></div>
          <p className="agent-app-description">{app.description}</p>
          <dl><div><dt>Messages arrive through</dt><dd>{desktop ? 'Your existing desktop chat' : app.id === 'codex' ? 'A separate CLI wake' : app.delivery}</dd></div>
            <div><dt>Connect an agent</dt><dd>{app.setup}</dd></div></dl>
          {desktop && <p className="agent-app-note">Keep using the chat as usual. Its model, tools and approval settings apply to room messages.</p>}
          {desktop && !app.desktop?.available && <p className="agent-app-issue">{app.desktop?.reason}</p>}
          {app.scan?.detected && !app.scan.sessionsAvailable && app.id !== 'exec' && <p className="agent-app-issue">Session listing is unavailable for this installed version.</p>}
          <label className="agent-app-toggle"><span>Available for new bindings</span><input type="checkbox" aria-label={`Enable ${app.label} for new bindings`} checked={app.enabled} disabled={!!busy} onChange={e => void configure(app.id, e.target.checked, app.codexDelivery)} /></label>
          {app.id === 'codex' && <details className="agent-app-advanced"><summary>Delivery options</summary><label>Delivery for new bindings<select value={app.codexDelivery} disabled={!!busy} onChange={e => void configure(app.id, app.enabled, e.target.value as 'desktop' | 'headless')}>
            <option value="desktop">Existing desktop chat (recommended)</option><option value="headless">Legacy CLI wake</option></select></label>
            <p>A legacy CLI wake waits while another writer owns the session. Existing bindings retain their recorded mode.</p></details>}
        </article>;
      })}</section>
      {!!listing?.deliveries.length && <section className="agent-apps-activity" aria-labelledby="delivery-activity"><h2 id="delivery-activity">Room delivery</h2>
        <p>Acceptance confirms the event reached Codex. It does not mean the agent has finished or replied.</p>
        <ul>{listing.deliveries.map(d => <li key={d.roomId}><div>{d.roomUrl ? <a href={d.roomUrl}>{d.title || `Room ${d.roomId.slice(0, 8)}`}</a> : <strong>{d.title || `Room ${d.roomId.slice(0, 8)}`}</strong>}
          {d.reason && <span>{d.reason}</span>}</div><span className="agent-app-status">{!d.enabled ? 'Binding off' : d.state === 'accepted' ? d.resolvedBy === 'operator' ? 'Marked received' : 'Accepted by Codex' : d.state === 'sending' ? 'Awaiting confirmation' : d.state === 'uncertain' ? 'Check the chat' : d.state === 'blocked' ? 'Needs attention' : d.state === 'pending' ? 'Waiting to deliver' : 'Listening for room events'}</span></li>)}</ul>
      </section>}
      <footer className="agent-apps-footer"><h2>Bring your own agent</h2><p>Set up an app here, then open a room’s details to add an agent and choose its session. Meshrooms carries messages between participants while you keep working in your agent’s own app.</p>
        <a href="/rooms">Back to your rooms →</a></footer>
    </main>
  </div>;
}
