import { useState, type FormEvent, type ReactNode } from 'react';
import { MentionText } from '../prototype/Collaboration';
import type { Participant } from '../room';
import { MAX_OPTIONS, type Decision, type DecisionMode } from './decisions';
import type { BrowserMember } from './protocol';

/** Who may change a decision's terms or close it: its creator, the creator's operator, or the host. */
export function isSteward(decision: Decision, viewerId: string | undefined, ownerId: string | undefined, members: BrowserMember[]) {
  if (!viewerId) return false;
  if (viewerId === decision.createdBy || viewerId === ownerId) return true;
  return members.some(m => m.id === decision.createdBy && m.role === 'agent' && m.operatorId === viewerId);
}

/** "Decided: Ship it", "Draw: A, B", "No votes", "Withdrawn", or the live state of an open decision. */
export function decisionSummary(decision: Decision) {
  const label = (id: string) => decision.options.find(o => o.id === id)?.label ?? 'an option';
  if (decision.state === 'withdrawn') return 'Withdrawn';
  const t = decision.tally;
  // A close counts only once its pinned votes arrive and add up; until then the result is not shown as final.
  if (decision.state === 'closed' && !decision.verified) return 'Checking the result';
  if (decision.state === 'closed') {
    if (t.result === 'decided') return `Decided: ${label(t.optionIds[0])}`;
    if (t.result === 'draw') return `Draw: ${t.optionIds.map(label).join(', ')}`;
    return 'Closed with no votes';
  }
  return `${t.voters} of ${t.people} ${t.people === 1 ? 'person' : 'people'} voted`;
}

function timeLeft(closesAt: number, now: number) {
  const minutes = Math.ceil((closesAt - now) / 60_000);
  if (minutes <= 0) return 'closing';
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h left` : `${Math.round(hours / 24)} days left`;
}

type CardProps = {
  decision: Decision; viewerId?: string; ownerId?: string; members: BrowserMember[]; participants: Participant[]; now: number; highlight?: boolean;
  avatar: (memberId: string) => ReactNode; nameOf: (memberId: string) => string;
  onVote: (optionId: string | null, comment: string) => Promise<void>; onAddOption: (label: string) => Promise<void>;
  onClose: () => Promise<void>; onWithdraw: () => Promise<void>; onTasks?: () => void;
};

/** A decision in the conversation: people vote, agents advise, and the card shows the tally and outcome. */
export function DecisionCard({ decision, viewerId, ownerId, members, participants, now, highlight, avatar, nameOf, onVote, onAddOption, onClose, onWithdraw, onTasks }: CardProps) {
  const [comment, setComment] = useState('');
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const open = decision.state === 'open';
  const mine = decision.votes.find(v => v.memberId === viewerId);
  const viewer = members.find(m => m.id === viewerId);
  const viewerIsAgent = viewer?.role === 'agent';
  const steward = isSteward(decision, viewerId, ownerId, members);
  const people = decision.votes.filter(v => v.counts && v.optionId);
  const advice = decision.votes.filter(v => !v.counts && v.optionId);
  const most = Math.max(1, ...decision.options.map(o => decision.tally.tally[o.id] ?? 0));
  const winners = decision.state === 'closed' && decision.verified ? decision.tally.optionIds : [];
  const label = (id: string | null) => decision.options.find(o => o.id === id)?.label ?? 'an option';
  const act = (work: () => Promise<void>) => { setBusy(true); setError(''); work().catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false)); };
  const creator = nameOf(decision.createdBy);

  return <article id={`decision-${decision.key}`} className={`browser-decision ${highlight ? 'browser-message-highlight' : ''} ${open ? '' : 'is-closed'}`} aria-label={`Decision: ${decision.question}`}>
    <header>
      <span className="browser-decision-kind">{decision.mode === 'plan-review' ? 'Plan review' : 'Decision'}</span>
      <span className="browser-decision-by">asked by {decision.createdBy === viewerId ? 'you' : creator}</span>
      <span className={`browser-decision-state ${open ? '' : 'is-final'}`}>{open && decision.closesAt ? `${decisionSummary(decision)} · ${timeLeft(decision.closesAt, now)}` : decisionSummary(decision)}</span>
    </header>
    <h3>{decision.question}</h3>
    {decision.context && <div className="message-text browser-decision-context"><MentionText text={decision.context} participants={participants} viewerId={viewerId} /></div>}
    <ol className="browser-decision-options">
      {decision.options.map(option => {
        const count = decision.tally.tally[option.id] ?? 0;
        const voters = people.filter(v => v.optionId === option.id);
        const chosen = mine?.optionId === option.id;
        return <li key={option.id} className={`${chosen ? 'is-chosen' : ''} ${winners.includes(option.id) ? 'is-winner' : ''}`}>
          <button type="button" disabled={!open || busy || !viewerId} aria-pressed={chosen}
            title={viewerIsAgent ? 'Agents advise; only people’s votes count' : chosen ? 'Your vote. Choose again to take it back.' : 'Vote for this option'}
            onClick={() => act(() => onVote(chosen ? null : option.id, comment))}>
            <span className="browser-decision-label">{option.label}</span>
            <span className="browser-decision-count">{count}</span>
            <span className="browser-decision-bar" aria-hidden="true"><span style={{ width: `${(count / most) * 100}%` }} /></span>
          </button>
          {voters.length > 0 && <span className="browser-decision-voters">{voters.map(v => <span key={v.memberId} title={`${nameOf(v.memberId)}${v.comment ? `: ${v.comment}` : ''}`}>{avatar(v.memberId)}</span>)}</span>}
        </li>;
      })}
    </ol>
    {advice.length > 0 && <div className="browser-decision-advice">
      <h4>Agents recommend <span>(advice, not counted)</span></h4>
      <ul>{advice.map(v => <li key={v.memberId}>{avatar(v.memberId)}<span><strong>{nameOf(v.memberId)}</strong> · {label(v.optionId)}{v.comment && <> — {v.comment}</>}</span></li>)}</ul>
    </div>}
    {people.some(v => v.comment) && <details className="browser-decision-reasons"><summary>People’s reasons</summary>
      <ul>{people.filter(v => v.comment).map(v => <li key={v.memberId}><strong>{nameOf(v.memberId)}</strong> · {label(v.optionId)} — {v.comment}</li>)}</ul>
    </details>}
    {open && viewerId && <div className="browser-decision-actions">
      <label className="sr-only" htmlFor={`decision-comment-${decision.key}`}>Reason for your vote</label>
      <input id={`decision-comment-${decision.key}`} value={comment} maxLength={500} placeholder={mine ? 'Add or change your reason, then vote again' : 'Reason (optional)'} onChange={e => setComment(e.target.value)} />
      {decision.mode === 'choice' && decision.options.length < MAX_OPTIONS && <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (adding.trim()) act(async () => { await onAddOption(adding); setAdding(''); }); }}>
        <label className="sr-only" htmlFor={`decision-add-${decision.key}`}>Add an option</label>
        <input id={`decision-add-${decision.key}`} value={adding} maxLength={120} placeholder="Add an option" onChange={e => setAdding(e.target.value)} />
        <button type="submit" className="secondary" disabled={busy || !adding.trim()}>Add</button>
      </form>}
      {steward && <span className="browser-decision-steward">
        <button type="button" className="secondary" disabled={busy} onClick={() => act(onClose)}>Close now</button>
        <button type="button" className="browser-remove" disabled={busy} onClick={() => act(onWithdraw)}>Withdraw</button>
      </span>}
    </div>}
    {decision.state === 'closed' && !decision.verified && <p className="browser-decision-note">Checking the result against the counted votes as they arrive…</p>}
    {decision.state === 'closed' && decision.uncounted > 0 && <p className="browser-decision-note">{decision.uncounted} {decision.uncounted === 1 ? 'vote' : 'votes'} from people arrived after it closed and {decision.uncounted === 1 ? 'isn’t' : 'aren’t'} counted.</p>}
    {!open && decision.state === 'closed' && decision.verified && decision.tally.result === 'decided' && onTasks && <div className="browser-decision-actions"><button type="button" className="secondary" onClick={onTasks}>Turn into a task</button></div>}
    {error && <p className="browser-decision-error" role="alert">{error}</p>}
  </article>;
}

export type DecisionDraft = { question: string; context: string; mode: DecisionMode; options: string[]; askAgents: boolean; closesAt: number | null };

/** Open a decision from the composer: a question with options, or a plan to approve. */
export function DecisionForm({ agents, onSubmit, onCancel }: { agents: number; onSubmit: (draft: DecisionDraft) => Promise<void>; onCancel: () => void }) {
  const [question, setQuestion] = useState('');
  const [context, setContext] = useState('');
  const [mode, setMode] = useState<DecisionMode>('choice');
  const [options, setOptions] = useState(['', '']);
  const [askAgents, setAskAgents] = useState(agents > 0);
  const [deadline, setDeadline] = useState('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const filled = options.map(o => o.trim()).filter(Boolean);
  const valid = !!question.trim() && (mode === 'plan-review' || (filled.length >= 2 && new Set(filled).size === filled.length));
  function submit(e: FormEvent) {
    e.preventDefault(); if (!valid || busy) return;
    const minutes = { none: 0, '15m': 15, '1h': 60, '1d': 1440 }[deadline] ?? 0;
    setBusy(true); setError('');
    onSubmit({ question: question.trim(), context: context.trim(), mode, options: filled, askAgents, closesAt: minutes ? Date.now() + minutes * 60_000 : null })
      .catch(err => { setError(err instanceof Error ? err.message : String(err)); setBusy(false); });
  }
  return <form className="browser-decision-form" onSubmit={submit} aria-label="New decision">
    <div className="browser-decision-modes" role="radiogroup" aria-label="Kind of decision">
      <label><input type="radio" name="decision-mode" checked={mode === 'choice'} onChange={() => setMode('choice')} />Choose between options</label>
      <label><input type="radio" name="decision-mode" checked={mode === 'plan-review'} onChange={() => setMode('plan-review')} />Review a plan</label>
    </div>
    <label>Question<input value={question} maxLength={200} required placeholder={mode === 'plan-review' ? 'Approve the plan for …?' : 'Which approach should we take?'} onChange={e => setQuestion(e.target.value)} /></label>
    <label>{mode === 'plan-review' ? 'Plan' : 'Context'} <span>(optional, Markdown)</span><textarea value={context} maxLength={4000} rows={mode === 'plan-review' ? 6 : 3} onChange={e => setContext(e.target.value)} /></label>
    {mode === 'choice' ? <fieldset><legend>Options</legend>
      {options.map((option, i) => <span key={i} className="browser-decision-option-input">
        <input value={option} maxLength={120} aria-label={`Option ${i + 1}`} placeholder={`Option ${i + 1}`} onChange={e => setOptions(options.map((o, j) => j === i ? e.target.value : o))} />
        {options.length > 2 && <button type="button" className="browser-close" aria-label={`Remove option ${i + 1}`} onClick={() => setOptions(options.filter((_, j) => j !== i))}>×</button>}
      </span>)}
      {options.length < MAX_OPTIONS && <button type="button" className="secondary" onClick={() => setOptions([...options, ''])}>Add option</button>}
    </fieldset> : <p className="browser-decision-note">People answer Approve, Request changes or Reject.</p>}
    <div className="browser-decision-settings">
      <label><input type="checkbox" checked={askAgents} disabled={!agents} onChange={e => setAskAgents(e.target.checked)} />Ask agents for advice</label>
      <label>Closes <select value={deadline} onChange={e => setDeadline(e.target.value)}>
        <option value="none">when a majority decides</option><option value="15m">in 15 minutes</option><option value="1h">in an hour</option><option value="1d">in a day</option>
      </select></label>
    </div>
    <p className="browser-decision-note">People’s votes decide by majority, and a tie is a draw. Agents advise but aren’t counted. Votes are visible to everyone.</p>
    {error && <p className="browser-decision-error" role="alert">{error}</p>}
    <div className="browser-decision-form-actions"><button type="button" className="secondary" onClick={onCancel}>Cancel</button><button type="submit" className="primary" disabled={!valid || busy}>Ask the room</button></div>
  </form>;
}

/** Open decisions first, then closed ones; each jumps to its card in the conversation. */
export function DecisionList({ decisions, onShow, onClose }: { decisions: Decision[]; onShow: (id: string) => void; onClose: () => void }) {
  const open = decisions.filter(d => d.state === 'open'), done = decisions.filter(d => d.state !== 'open').reverse();
  const row = (d: Decision) => <li key={d.key}><button type="button" onClick={() => onShow(d.key)}><strong>{d.question}</strong><span>{decisionSummary(d)}</span></button></li>;
  return <aside id="browser-decisions" className="browser-details browser-decisions-panel" aria-label="Decisions" onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
    <header className="browser-details-heading"><h2>Decisions</h2><button className="browser-close" aria-label="Close decisions" onClick={onClose}>×</button></header>
    <section><h3>Open <span>{open.length}</span></h3>{open.length ? <ul>{open.map(row)}</ul> : <p>No open decisions. Use Decide in the composer to ask the room.</p>}</section>
    {done.length > 0 && <section><h3>Closed <span>{done.length}</span></h3><ul>{done.map(row)}</ul></section>}
  </aside>;
}
