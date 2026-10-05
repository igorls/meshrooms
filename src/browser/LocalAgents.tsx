/**
 * The person's agents on this computer, in a room's details on the local page (desktop-first steps 5 and 6). Where the
 * hosted site makes a one-time agent link, the local page lists the agent identities the app keeps, puts one into the
 * room, makes a new one from a harness found here, and binds it to a session: a new one at once, an existing one only
 * once the person approves it in the Meshrooms app.
 *
 * Everything shown here comes from the machine (names, models, room titles, session titles, folder labels, errors) and
 * is rendered as plain text: React text nodes only, never markup, links or mentions.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { duration } from './activity';
import type { AgentBinding, AgentRoom, HarnessId, HarnessScan, HarnessSession, LocalAgent, LocalAgents } from './source';

/** `readAt`: when the read that brought it started, so only a later one can say a filed session was answered. */
type Listing = { agents: LocalAgent[]; approvalsWaiting: number; readAt: number };
/** An existing session filed for the app (when), per identity and room, until the app answers (approved, rejected or expired). */
type Pending = Record<string, number>;
const pendingKey = (identityId: string, roomId: string) => `${identityId}:${roomId}`;

/**
 * The person's identities, read while `active` (the event feed doesn't report agent changes, so this polls): every few
 * seconds, and faster while something moves (a new session starting, an agent waiting for the host, an approval waiting).
 */
export function useLocalAgents(api: LocalAgents | undefined, active: boolean) {
  const [listing, setListing] = useState<Listing>();
  const [problem, setProblem] = useState('');
  const [pending, setPending] = useState<Pending>({});
  const [reads, reread] = useState(0);
  const fast = useRef(false);
  fast.current = Object.keys(pending).length > 0 || !!listing?.agents.some(a => a.rooms.some(r => r.binding.state === 'starting' || r.state === 'waiting' || (r.binding.wakes === 'on' && r.binding.listening === false)));
  useEffect(() => {
    if (!api || !active) return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      const readAt = Date.now();
      try { const next = await api.list(); if (!stopped) { setListing({ ...next, readAt }); setProblem(''); } }
      catch (error) { if (!stopped) setProblem((error as Error).message); }
      if (!stopped) timer = setTimeout(read, fast.current ? 1500 : 4000);
    };
    void read();
    return () => { stopped = true; clearTimeout(timer); };
  }, [api, active, reads]);
  // A filed session is no longer waiting once the app answered: bound as the existing session, or nothing waits any more.
  useEffect(() => {
    if (!listing || !Object.keys(pending).length) return;
    const still = Object.fromEntries(Object.entries(pending).filter(([key, filedAt]) => {
      if (listing.readAt <= filedAt) return true;
      const [identityId, roomId] = key.split(':'), room = listing.agents.find(a => a.id === identityId)?.rooms.find(r => r.roomId === roomId);
      return listing.approvalsWaiting > 0 && !(room?.binding.kind === 'existing' && room.binding.state === 'bound');
    })) as Pending;
    if (Object.keys(still).length !== Object.keys(pending).length) setPending(still);
  }, [listing, pending]);
  return { listing, problem, pending, refresh: () => reread(n => n + 1),
    markPending: (identityId: string, roomId: string) => setPending(current => ({ ...current, [pendingKey(identityId, roomId)]: Date.now() })) };
}
export type LocalAgentsState = ReturnType<typeof useLocalAgents>;

/** The identity behind a member of this room, when the person operates it from this computer. */
export const identityOfMember = (listing: Listing | undefined, roomId: string, memberId: string) => {
  for (const agent of listing?.agents ?? []) {
    const room = agent.rooms.find(r => r.roomId === roomId && r.memberId === memberId);
    if (room) return { agent, room };
  }
  return undefined;
};

const FAILURES: Record<NonNullable<AgentBinding['reason']>, string> = {
  'bootstrap-failed': 'The new session could not start.',
  'bind-refused': 'The new session started, but it could not be bound to this room.',
  'not-finished': 'The new session did not finish starting.',
};
/** How the agent wakes in this room, in a few words: the chip's and the people list's line. */
export function wakeLabel(binding: AgentBinding) {
  if (binding.state === 'starting') return 'Starting a new session';
  if (binding.state === 'failed') return 'New session failed';
  if (binding.wakes === 'on' && binding.listening === false) return 'Starting…';
  return { unbound: 'No session yet', on: 'Wakes when addressed', off: 'Not waking', paused: 'Waking paused', halted: 'Waking stopped' }[binding.wakes];
}
/** The longer story of a binding, as plain sentences: what happens next, and why it stopped when it did. */
function bindingLines(binding: AgentBinding): string[] {
  if (binding.state === 'starting') return ['Starting a new session for this room. This can take a few minutes.'];
  if (binding.state === 'failed') return [FAILURES[binding.reason ?? 'bootstrap-failed'], ...(binding.error ? [binding.error] : [])];
  const why = binding.offReason ? [binding.offReason] : [];
  switch (binding.wakes) {
    case 'unbound': return ['Not bound to a session yet, so nothing wakes it here.'];
    case 'on': return [binding.kind === 'existing' ? 'Bound to one of your sessions. It wakes when someone addresses it.' : 'Bound to a new session. It wakes when someone addresses it.'];
    case 'off': return ['Not waking. It stays in the room.', ...why];
    case 'paused': return ['Waking is paused.', ...why];
    case 'halted': return ['Waking stopped and needs your attention in the Meshrooms app.', ...why];
  }
}
function roomLine(room: AgentRoom) {
  if (room.state === 'waiting') return 'Waiting for the host to let it in.';
  if (room.state === 'closed') return 'This room is closed.';
  if (room.state === 'removed') return 'Removed from this room.';
  return room.runner === 'down' ? 'In this room. Connecting from this computer…' : 'In this room.';
}
const NOT_HERE: Record<string, string> = {
  'not-found': 'not found', 'version-command-failed': 'version unknown', 'unsupported-version': 'sessions unavailable', 'listing-command-failed': 'sessions unavailable', 'unsupported-schema': 'sessions unavailable',
};
function harnessOption(h: HarnessScan) {
  if (h.harness === 'exec') return `${h.label} (in the Meshrooms app)`;
  const version = h.version ? ` ${h.version}` : '';
  return !h.detected ? `${h.label} (${h.reason === 'not-found' ? 'not found' : 'not available'})` : h.reason && NOT_HERE[h.reason] ? `${h.label}${version} (${NOT_HERE[h.reason]})` : `${h.label}${version}`;
}
function lastActive(session: HarnessSession, now: number) {
  if (session.lastActiveAt) { const at = Date.parse(session.lastActiveAt); if (Number.isFinite(at)) { const ago = duration(now - at); return ago === 'just now' ? 'Active just now' : `Active ${ago} ago`; } }
  return session.lastActiveLabel ? `Active ${session.lastActiveLabel}` : undefined;
}

/** "Your agents" in a room's details, on the local page. */
export function LocalAgentsSection({ api, state, roomId, selfName, focus }: { api: LocalAgents; state: LocalAgentsState; roomId: string; selfName?: string; focus?: { id: string; at: number } }) {
  const { listing, problem: listProblem, pending, refresh, markPending } = state;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState('');
  const [harnesses, setHarnesses] = useState<HarnessScan[]>();
  const [harnessProblem, setHarnessProblem] = useState('');
  const [name, setName] = useState('');
  const [harness, setHarness] = useState<HarnessId>();
  const [model, setModel] = useState('');
  const [confirming, setConfirming] = useState<string>();
  /** Whose existing sessions are listed, and the listing. */
  const [choosing, setChoosing] = useState<{ identityId: string; sessions?: HarnessSession[]; truncated?: boolean; unavailable?: string }>();
  const [now, setNow] = useState(() => Date.now());
  const newAgent = useRef<HTMLDetailsElement>(null);
  const agents = listing?.agents ?? [];

  useEffect(() => {
    let stopped = false;
    void api.harnesses().then(list => { if (stopped) return; setHarnesses(list); setHarness(current => current ?? list.find(h => h.detected && h.harness !== 'exec')?.harness); })
      .catch(error => { if (!stopped) setHarnessProblem((error as Error).message); });
    return () => { stopped = true; };
  }, [api]);
  // A member's "Sessions" in the people list brings its agent here.
  useEffect(() => {
    if (!focus) return;
    const row = document.getElementById(`local-agent-${focus.id}`);
    row?.scrollIntoView({ block: 'nearest' }); row?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [focus]);
  useEffect(() => { if (listing && !agents.length && newAgent.current) newAgent.current.open = true; }, [listing, agents.length]);
  useEffect(() => { if (!done) return; const timer = setTimeout(() => setDone(''), 6000); return () => clearTimeout(timer); }, [done]);

  async function run(work: () => Promise<string | void>) {
    if (busy) return;
    setBusy(true); setProblem(''); setDone('');
    try { const said = await work(); if (said) setDone(said); refresh(); }
    catch (error) { setProblem((error as Error).message); }
    finally { setBusy(false); }
  }
  function create(event: FormEvent) {
    event.preventDefault();
    const chosen = harness;
    if (!chosen) return;
    void run(async () => {
      const made = await api.create({ name: name.trim(), harness: chosen, ...(model.trim() ? { model: model.trim() } : {}) });
      setName(''); setModel('');
      if (newAgent.current) newAgent.current.open = false;
      return `${made.name} is ready. Add it to this room to bring it in.`;
    });
  }
  const putIn = (agent: LocalAgent) => run(async () => {
    const put = await api.putIntoRoom(roomId, agent.id);
    return put.state === 'waiting' ? `${agent.name} is waiting for the host to let it in.` : `${agent.name} joined the room.`;
  });
  const bindNew = (agent: LocalAgent, room: AgentRoom) => run(async () => {
    setChoosing(undefined);
    const bound = await api.bind(roomId, room.memberId ?? agent.id, 'new');
    return 'state' in bound && bound.state === 'bound' ? `${agent.name} is bound to a new session.` : undefined;
  });
  const showSessions = (agent: LocalAgent) => {
    if (choosing?.identityId === agent.id) { setChoosing(undefined); return; }
    setNow(Date.now());
    void run(async () => {
      setChoosing({ identityId: agent.id });
      const listed = await api.sessions(agent.harness);
      setChoosing({ identityId: agent.id, ...(listed.sessionsAvailable ? { sessions: listed.sessions, truncated: listed.truncated }
        : { unavailable: `${agent.label} sessions can’t be listed on this computer${listed.reason && NOT_HERE[listed.reason] ? ` (${NOT_HERE[listed.reason]})` : ''}.` }) });
    });
  };
  const bindExisting = (agent: LocalAgent, room: AgentRoom, session: HarnessSession) => run(async () => {
    const answer = await api.bind(roomId, room.memberId ?? agent.id, session.id);
    setChoosing(undefined);
    if ('approval' in answer) markPending(agent.id, roomId);
  });
  const stop = (agent: LocalAgent, room: AgentRoom) => run(async () => {
    await api.unbind(roomId, room.memberId ?? agent.id);
    return `${agent.name} no longer wakes here. It stays in the room.`;
  });
  const remove = (agent: LocalAgent) => run(async () => {
    await api.remove(agent.id);
    setConfirming(undefined);
    return `${agent.name} was deleted from this computer.`;
  });

  const exec = harnesses?.find(h => h.harness === 'exec');
  const usable = harnesses?.filter(h => h.harness !== 'exec' && h.detected) ?? [];
  return <section className="browser-agents browser-local-agents" aria-labelledby="browser-local-agents-title"><h3 id="browser-local-agents-title">Your agents {agents.length > 0 && <span>{agents.length}</span>}</h3>
    <p>Agents on this computer, with you as their operator{selfName ? <> (<strong>{selfName}</strong>)</> : null}. Only you and the host can remove one from this room.</p>
    {listProblem && !listing && <p role="alert" className="browser-agent-problem">{listProblem}</p>}
    {!!listing?.approvalsWaiting && <p className="browser-agent-waiting">{listing.approvalsWaiting === 1 ? 'One request waits' : `${listing.approvalsWaiting} requests wait`} for you in the Meshrooms app.</p>}
    {agents.length > 0 && <ul className="browser-local-agent-list">
      {agents.map(agent => {
        const here = agent.rooms.find(r => r.roomId === roomId), elsewhere = agent.rooms.filter(r => r.roomId !== roomId);
        const inRoom = here && (here.state === 'connected' || here.state === 'waiting');
        const waitingApproval = here && pending[pendingKey(agent.id, roomId)];
        const list = choosing?.identityId === agent.id ? choosing : undefined;
        return <li key={agent.id} id={`local-agent-${agent.id}`} className="browser-person browser-local-agent"><div>
          <strong>{agent.name}</strong>
          <span className="agent-runtime">{[agent.label, agent.model].filter(Boolean).join(' · ')}</span>
          <span>{elsewhere.length ? `${here ? 'Also in' : 'In'} ${elsewhere.map(r => r.title || 'a room').join(', ')}` : here ? '' : 'In no room yet'}</span>
          {here && <span>{roomLine(here)}</span>}
          {inRoom && bindingLines(here.binding).map((line, i) => <span key={i} className={i ? 'agent-activity-note' : undefined}>{line}</span>)}
          {waitingApproval && <p role="status" className="browser-agent-waiting">Approve this in the Meshrooms app. Waiting for your approval…</p>}
          {!here && <button className="secondary browser-local-agent-add" disabled={busy} onClick={() => void putIn(agent)}>Add to this room</button>}
          {inRoom && <div className="browser-local-agent-actions">
            {here.binding.state !== 'starting' && <button className="secondary" disabled={busy} onClick={() => void bindNew(agent, here)}>Start a new session</button>}
            {agent.harness !== 'exec' && here.binding.state !== 'starting' && <button className="browser-text-link" aria-expanded={!!list} disabled={busy && !list} onClick={() => showSessions(agent)}>Use an existing session</button>}
            {/* While a new session starts, the agent takes no other change (the daemon holds it until bound or failed). */}
            {here.binding.state !== 'starting' && (here.binding.wakes === 'on' || here.binding.wakes === 'paused' || here.binding.wakes === 'halted') && <button className="browser-text-link" disabled={busy} onClick={() => void stop(agent, here)}>Stop waking</button>}
          </div>}
          {inRoom && list && <div className="browser-local-sessions" role="group" aria-label={`${agent.label} sessions on this computer`}>
            {list.unavailable ? <p>{list.unavailable}</p> : !list.sessions ? <p aria-busy="true">Reading {agent.label} sessions…</p> : !list.sessions.length ? <p>No {agent.label} sessions on this computer yet.</p> : <>
              <p>Binding one of your sessions needs your approval in the Meshrooms app.</p>
              <ul>{list.sessions.map(session => {
                const active = lastActive(session, now);
                return <li key={session.id}><div><strong>{session.title || 'Untitled session'}</strong><span>{[session.folder, active].filter(Boolean).join(' · ')}</span></div>
                  <button className="browser-text-link" disabled={busy} aria-label={`Use the session ${session.title || 'Untitled session'}`} onClick={() => void bindExisting(agent, here, session)}>Use</button></li>;
              })}</ul>
              {list.truncated && <p>Showing the {list.sessions.length} most recent.</p>}</>}
          </div>}
          {!agent.rooms.length && (confirming === agent.id ? <div className="browser-confirm" role="group" aria-label={`Confirm deleting ${agent.name}`}>
            <p>Delete {agent.name} from this computer? Its key and folder are removed. This can’t be undone.</p>
            <div><button className="secondary" disabled={busy} onClick={() => void remove(agent)}>Delete agent</button><button className="browser-text-link" onClick={() => setConfirming(undefined)}>Cancel</button></div>
          </div> : <button className="browser-remove" disabled={busy} aria-label={`Delete ${agent.name}`} onClick={() => setConfirming(agent.id)}>Delete</button>)}
        </div></li>;
      })}
    </ul>}
    {problem && <p role="alert" className="browser-agent-problem">{problem}</p>}
    {done && <p role="status" className="browser-agent-done">{done}</p>}
    <details ref={newAgent} id="browser-new-agent" className="browser-link-device browser-new-agent"><summary>New agent</summary>
      <form onSubmit={create}>
        <label>Agent name<input id="browser-agent-name" value={name} onChange={e => setName(e.target.value)} required maxLength={64} placeholder="Codex" autoComplete="off" /></label>
        <label className="browser-agent-harness">Harness<select value={harness ?? ''} onChange={e => setHarness(e.target.value as HarnessId)} disabled={!harnesses?.length}>
          {!harnesses && <option value="">{harnessProblem || 'Looking for harnesses on this computer…'}</option>}
          {harnesses && !usable.length && <option value="">None found on this computer</option>}
          {harnesses?.map(h => <option key={h.harness} value={h.harness} disabled={h.harness === 'exec' || !h.detected}>{harnessOption(h)}</option>)}</select></label>
        {exec && <p>Custom command: Set up custom commands in the Meshrooms app.</p>}
        {harnesses && !usable.length && <p>Install Claude Code, Codex or Hermes on this computer to make an agent here.</p>}
        <label><span>Model <span className="browser-optional">(optional)</span></span><input value={model} onChange={e => setModel(e.target.value)} maxLength={100} placeholder="The harness’s default" autoComplete="off" spellCheck={false} /></label>
        <button className="secondary" disabled={busy || !name.trim() || !harness || !usable.some(h => h.harness === harness)}>Create agent</button>
      </form>
    </details>
    <p>Or ask your agent to run <code>meshrooms agent request …</code>; you’ll approve it in the Meshrooms app.</p>
  </section>;
}
