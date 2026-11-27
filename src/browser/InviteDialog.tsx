import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { PROMPT_HARNESS_META, agentPrompt, defaultAgentName, isLinkOnlyHarness, isPromptHarness, type PromptHarness } from './agent-prompt';
import { AGENT_LINK_TTL, agentLinkState, formatCountdown, inviteSteps, type AgentLinkState, type StepStatus } from './invite-state';
import type { RoomStatus } from './protocol';
import { PhonePairing, type PhoneAsking } from './PhonePairing';
import type { PairCommander, PairLinker } from './phone-pairing';
import type { RecentRoom } from './background';

export type InviteTab = 'person' | 'agent' | 'phone';
/** What the "My phone" tab needs: only the hosted page has it (the desktop app is the person's own computer). */
export type PhoneTab = { rooms: RecentRoom[]; name: string; device?: string; link: PairLinker; command: PairCommander; asking?: PhoneAsking; onActiveChange?(active: boolean): void; onUseCode(): void };
/** The secret in the prompt is never shown until the person asks to see the whole prompt. */
const MASK = 'https://●●●●●●●●●●●●●●●●●●●●●●●●';
const HARNESS_PREF = 'meshrooms:invite-harness';

type Link = { name: string; harness: PromptHarness; createdAt: number; expiresAt?: number; /** Dropped once the link is used, joined or expired: nothing secret is kept after that. */ prompt?: string; url?: string; preview: string };

function Icon({ kind }: { kind: 'person' | 'agent' | 'close' | 'check' | 'clock' | 'lock' | 'shield' | 'link' | 'phone' }) {
  const paths = {
    person: <><circle cx="10" cy="8" r="4" /><path d="M3 20c0-4 3-6 7-6s7 2 7 6M19 8v6M16 11h6" /></>,
    agent: <path d="m5 8 4 4-4 4M12 17h7" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    check: <path d="m5 12 5 5 9-10" strokeWidth="2.6" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
    shield: <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />,
    phone: <><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5h2" /></>,
    link: <path d="m10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" />,
  };
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}

function Steps({ state, copied, name, host, linkOnly, harnessLabel }: { state: AgentLinkState; copied: boolean; name: string; host: boolean; linkOnly?: boolean; harnessLabel?: string }) {
  const [a, b, c] = inviteSteps(state, copied);
  const rows: [StepStatus, string, string][] = [
    [a, linkOnly ? `Copy the link and paste it in ${harnessLabel ?? 'your agent'}` : `Copy the prompt and paste it to ${name}`, a === 'done' ? 'Copied' : 'Not copied yet'],
    [b, state === 'expired' ? `The link expired before ${name} used it` : linkOnly ? `${name} connects with the link` : `${name} opens the link`, b === 'bad' ? 'Expired' : b === 'now' ? 'Listening…' : b === 'done' ? 'Link used' : ''],
    [c, state === 'used' ? (host ? `${name} is connecting` : `Waiting for the host to let ${name} in`) : `${name} joins the room`, c === 'done' ? 'Just now' : state === 'used' && !host ? 'Needs host' : ''],
  ];
  return <ol className="invite-steps" role="status" aria-live="polite">{rows.map(([status, label, note], index) =>
    <li key={index} className={`invite-step is-${status}`}><span className="invite-dot" aria-hidden="true">{status === 'done' ? <Icon kind="check" /> : status === 'bad' ? '!' : index + 1}</span><span>{label}</span><span className="invite-step-note">{note}</span></li>)}</ol>;
}

/**
 * One place to bring someone into the room: a person (the room link, which the host approves) or an agent (a one-time
 * prompt). A dialog on desktop and a bottom sheet on phones. It stays mounted while the room is open, so a link that was
 * made keeps its state, and the agent joining is reported even after the dialog is closed.
 */
export function InviteDialog({ open, tab, onTab, onClose, roomId, roomTitle, roomOrigin, personLink, agentVersion, status, host, createAgentLink, localAgents, onOpenLocalAgents, onNotice, phone }: {
  open: boolean; tab: InviteTab; onTab: (tab: InviteTab) => void; onClose: () => void;
  roomId: string; roomTitle: string; roomOrigin: string; personLink: string; agentVersion?: string; status: RoomStatus; host: boolean;
  /** Makes a one-time agent link for this name; resolves to its token. */
  createAgentLink: (name: string) => Promise<string>;
  /** The local page keeps its agents on this computer: no link, they are added to the room from "Your agents". */
  localAgents: boolean; onOpenLocalAgents: () => void;
  onNotice: (text: string) => void;
  /** Offered on the hosted page: connect the person's own phone by QR code. */
  phone?: PhoneTab;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const tabs = useRef<Record<InviteTab, HTMLButtonElement | null>>({ person: null, agent: null, phone: null });
  const personInput = useRef<HTMLInputElement>(null);
  const [personCopied, setPersonCopied] = useState(false);
  const [harness, setHarness] = useState<PromptHarness>(() => { try { const saved = localStorage.getItem(HARNESS_PREF); return isPromptHarness(saved) ? saved : 'claude'; } catch { return 'claude'; } });
  const [name, setName] = useState(() => defaultAgentName(harness));
  const nameTouched = useRef(false);
  const [link, setLink] = useState<Link>();
  const [copied, setCopied] = useState<'prompt' | 'link'>();
  const [showFull, setShowFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const wasUsed = useRef(false);
  const announced = useRef('');
  const members = status.members ?? [];

  // Open and close the native dialog: it traps focus, closes on Esc and sits above everything.
  useEffect(() => {
    const element = dialog.current; if (!element) return;
    if (open && !element.open) { element.showModal(); requestAnimationFrame(() => tabs.current[tab]?.focus()); }
    else if (!open && element.open) element.close();
  }, [open]);
  useEffect(() => { setProblem(''); }, [tab, open]);
  // Every panel shares one grid cell, so switching tabs never changes the dialog's height. When a panel itself grows past the
  // others (a prompt was made, a QR code appeared), the dialog eases to its new height instead of jumping.
  useEffect(() => {
    const element = stage.current, box = dialog.current;
    if (!element || !box || typeof ResizeObserver === 'undefined') return;
    let last = 0, view = '', moving: Animation | undefined;
    const observer = new ResizeObserver(() => {
      if (moving) return;
      const height = box.getBoundingClientRect().height, viewport = `${innerWidth}x${innerHeight}`;
      if (box.open && last && view === viewport && Math.abs(height - last) > 1 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        moving = box.animate([{ height: `${last}px` }, { height: `${height}px` }], { duration: 340, easing: 'cubic-bezier(.22,1,.36,1)' });
        const settle = () => { moving = undefined; last = box.getBoundingClientRect().height; };
        moving.onfinish = settle; moving.oncancel = settle;
      }
      last = box.open ? height : 0; view = viewport;
    });
    observer.observe(element);
    return () => { observer.disconnect(); moving?.cancel(); };
  }, []);
  useEffect(() => { if (!personCopied) return; const timer = setTimeout(() => setPersonCopied(false), 4000); return () => clearTimeout(timer); }, [personCopied]);

  const listed = link && status.agentInvites?.find(i => i.name === link.name);
  const joinedMember = link && members.find(m => m.role === 'agent' && m.name === link.name && m.operatorId === status.memberId);
  const expiresAt = link && (listed?.expiresAt ?? link.expiresAt);
  const state: AgentLinkState | undefined = link && agentLinkState({ createdAt: link.createdAt, expiresAt, listed: !!listed, joined: !!joinedMember, wasUsed: wasUsed.current, now });
  if (state === 'used') wasUsed.current = true;
  // The countdown ticks while a link is waiting; otherwise nothing moves.
  useEffect(() => {
    if (state !== 'open') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state, link?.createdAt]);
  // Once a link is spent, nothing secret is kept in memory; only its masked preview stays on screen.
  useEffect(() => { if (state && state !== 'open' && (link?.prompt || link?.url)) setLink(current => current && { ...current, prompt: undefined, url: undefined }); }, [state, link?.prompt, link?.url]);
  useEffect(() => { if (listed && link && link.expiresAt !== listed.expiresAt) setLink(current => current && { ...current, expiresAt: listed.expiresAt }); }, [listed?.expiresAt, link?.createdAt]);
  // The agent joined while the dialog was closed: say so in the room.
  useEffect(() => {
    if (state === 'joined' && link && announced.current !== `${link.name}:${link.createdAt}`) {
      announced.current = `${link.name}:${link.createdAt}`;
      if (!open) onNotice(`${link.name} joined the room.`);
    }
  }, [state, open]);

  function pickHarness(next: PromptHarness) {
    setHarness(next); try { localStorage.setItem(HARNESS_PREF, next); } catch { /* Not remembered. */ }
    if (!nameTouched.current) setName(defaultAgentName(next));
  }
  async function make(chosenName: string, chosenHarness: PromptHarness) {
    if (busy) return;
    const trimmed = chosenName.trim(); if (!trimmed) return;
    setBusy(true); setProblem('');
    try {
      const token = await createAgentLink(trimmed);
      const url = `${roomOrigin}/agent/${roomId}#${token}`;
      const linkOnly = isLinkOnlyHarness(chosenHarness);
      const prompt = linkOnly ? undefined : agentPrompt({ origin: roomOrigin, roomId, link: url, name: trimmed, version: agentVersion, harness: chosenHarness });
      wasUsed.current = false; announced.current = '';
      setLink({ name: trimmed, harness: chosenHarness, createdAt: Date.now(), prompt, url, preview: prompt ? prompt.split(url).join(MASK) : MASK });
      setCopied(undefined); setShowFull(false); setNow(Date.now());
    } catch (error) { setProblem((error as Error).message || 'Couldn’t make the link. Try again.'); }
    finally { setBusy(false); }
  }
  async function copyPerson() {
    try { await navigator.clipboard.writeText(personLink); setPersonCopied(true); setProblem(''); }
    catch { personInput.current?.focus(); personInput.current?.select(); setProblem('Select the link and copy it.'); }
  }
  async function copyAgent(what: 'prompt' | 'link') {
    const text = what === 'prompt' ? link?.prompt : link?.url; if (!text) return;
    try { await navigator.clipboard.writeText(text); setCopied(what); setProblem(''); }
    catch { setShowFull(true); setProblem(`Couldn’t copy automatically. Select the ${what === 'link' ? 'link' : 'prompt'} and copy it.`); }
  }
  function again() { setLink(undefined); setCopied(undefined); setShowFull(false); setProblem(''); nameTouched.current = false; setName(defaultAgentName(harness)); }
  function moveTab(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next = event.key === 'Home' ? order[0] : event.key === 'End' ? order[order.length - 1] : order[Math.min(order.length - 1, Math.max(0, at + (event.key === 'ArrowLeft' ? -1 : 1)))];
    onTab(next); tabs.current[next]?.focus();
  }

  const order: InviteTab[] = phone ? ['person', 'agent', 'phone'] : ['person', 'agent'], at = Math.max(0, order.indexOf(tab));
  /** A panel in the shared cell: the one on show, or hidden and inert to the side it would slide in from. */
  function slide(key: InviteTab, node: ReactNode) {
    const index = order.indexOf(key), pos = index === at ? 'on' : index < at ? 'before' : 'after';
    return <div key={key} className="invite-slide" data-pos={pos} inert={pos !== 'on'}>{node}</div>;
  }
  const leftover = (status.agentInvites ?? []).filter(i => !link || i.name !== link.name);
  const shown = link?.harness ? PROMPT_HARNESS_META.find(h => h.id === link.harness) : undefined;
  const heading = `Invite to “${roomTitle}”`;

  function personPanel(): ReactNode {
    return <div className="invite-panel" role="tabpanel" id="invite-panel-person" aria-labelledby="invite-tab-person">
      <div className="invite-body">
        <p className="invite-lead">Share this link with a <b>person</b>. They open it in a browser, pick a name, and <b>you approve</b> them before they see anything.</p>
        <div><span className="invite-label" id="invite-person-label">Room link · for people</span>
          <div className="invite-field"><input ref={personInput} readOnly aria-labelledby="invite-person-label" value={personLink} onFocus={event => event.target.select()} />
            <button type="button" className={`primary invite-copy-inline${personCopied ? ' is-done' : ''}`} onClick={() => void copyPerson()}>{personCopied ? <><Icon kind="check" />Copied</> : <><Icon kind="link" />Copy link</>}</button></div></div>
        <ul className="invite-facts">
          <li><Icon kind="shield" /><span>New people wait for the host’s approval. Nobody joins by link alone.</span></li>
          <li><Icon kind="clock" /><span>This link doesn’t expire while the room is in use. Anyone who has it can ask to join.</span></li>
          <li><Icon kind="check" /><span>{status.settings?.historyForNewcomers ? 'History for newcomers is on: new members can read earlier messages shared with the room.' : 'History for newcomers is off: new members only see messages sent after they join.'}</span></li>
        </ul>
        {problem && <p className="invite-problem" role="alert">{problem}</p>}
        <p className="invite-cross">Want to bring an <b>AI agent</b> instead? This link <b>won’t work</b> for agents. <button type="button" className="browser-text-link" onClick={() => { onTab('agent'); tabs.current.agent?.focus(); }}>Invite an agent</button></p>
      </div>
      <div className="invite-foot"><span className="invite-foot-note">Link looks like <code>…/r/…</code> · people only</span><button type="button" className="secondary" onClick={onClose}>Done</button></div>
    </div>;
  }

  function chooseStep(): ReactNode {
    const linkOnly = isLinkOnlyHarness(harness);
    return <form className="invite-panel" role="tabpanel" id="invite-panel-agent" aria-labelledby="invite-tab-agent" onSubmit={event => { event.preventDefault(); void make(name, harness); }}>
      <div className="invite-body">
        <p className="invite-lead">{linkOnly
          ? <>Connect an <b>AI agent</b> in <b>BentoKit</b>. You’ll copy a one-time link and paste it into BentoKit’s Meshrooms channel settings. Use your own browser here, not one an agent is driving.</>
          : <>Connect an <b>AI agent</b> that you run (Claude Code, Codex, Grok Bot…). You’ll copy one prompt and paste it into the agent. It handles the rest. Use your own browser here, not one an agent is driving.</>}</p>
        <div><span className="invite-label" id="invite-harness-label">1 · Your agent runs on</span>
          <div className="invite-chips" role="radiogroup" aria-labelledby="invite-harness-label">{PROMPT_HARNESS_META.map(h =>
            <button key={h.id} type="button" role="radio" aria-checked={h.id === harness} className={`invite-chip${h.id === harness ? ' is-on' : ''}`} onClick={() => pickHarness(h.id)}><span className="invite-badge is-agent" aria-hidden="true">{h.badge}</span>{h.label}</button>)}</div></div>
        <div className="invite-name"><label className="invite-label" htmlFor="invite-agent-name">2 · Name in this room</label>
          <input id="invite-agent-name" value={name} onChange={event => { nameTouched.current = true; setName(event.target.value); }} required maxLength={64} placeholder="Agent name" autoComplete="off" />
          <small>Shown to everyone. You’ll be listed as its operator.</small></div>
        <section className="invite-does" aria-label="What your agent will do"><h3>What your agent will do</h3><ul>
          {linkOnly ? <>
            <li><Icon kind="check" /><span>Join as a <b>separate participant</b>{name.trim() ? <> named “{name.trim()}”</> : null}, operated by you.</span></li>
            <li><Icon kind="check" /><span>Connect directly from BentoKit (<b>Settings › Channels › Add Channel › Meshrooms</b>) — no CLI or Bun needed.</span></li>
          </> : <>
            <li><Icon kind="check" /><span>Read Meshrooms’ join guide, then join as a <b>separate participant</b>{name.trim() ? <> named “{name.trim()}”</> : null}, operated by you.</span></li>
            <li><Icon kind="check" /><span>Ask <b>you</b> before installing anything (it needs Bun).</span></li>
          </>}
          <li><Icon kind="check" /><span>Reply only when someone addresses it. Room messages are requests, not commands.</span></li>
          <li><Icon kind="check" /><span>You can remove it from the room at any time.</span></li></ul></section>
        {leftover.length > 0 && <p className="invite-lead invite-muted" role="status">{leftover.map(i => <span key={i.name} className="invite-leftover">An earlier link for <b>{i.name}</b> is still unused (expires at {new Date(i.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}). A link can’t be shown again; make a new {linkOnly ? 'link' : 'prompt'} if you lost it.</span>)}</p>}
        {problem && <p className="invite-problem" role="alert">{problem}</p>}
      </div>
      <div className="invite-foot"><button className="invite-cta" disabled={busy || !name.trim()}>{busy ? 'Creating…' : linkOnly ? 'Create one-time link' : 'Create one-time prompt'}</button><span className="invite-foot-note">Nothing is shared until you paste it</span></div>
    </form>;
  }

  function madeStep(current: Link, st: AgentLinkState): ReactNode {
    const linkOnly = isLinkOnlyHarness(current.harness);
    const secretText = linkOnly ? current.url : current.prompt;
    const spent = st !== 'open', dim = st === 'expired';
    const msLeft = Math.max(0, (expiresAt ?? current.createdAt + AGENT_LINK_TTL) - now);
    const preClass = [showFull && secretText ? 'is-full' : '', linkOnly ? 'is-link' : ''].filter(Boolean).join(' ') || undefined;
    const body = <>
      {st === 'joined' ? <div className="invite-joined"><span className="invite-badge is-agent is-big" aria-hidden="true">{shown?.badge ?? 'A'}</span><div><b>{current.name} is connected</b><span><i className="invite-live" aria-hidden="true" />Online · {shown?.label ?? 'Agent'} · operated by you</span></div></div>
        : <>
          {st === 'expired' && <p className="invite-error" role="alert"><b>This link expired before {current.name} used it.</b><br />Links work once and last 15 minutes. Nothing was shared and nobody joined. Make a new {linkOnly ? 'link' : 'prompt'} to try again.</p>}
          {st === 'open' && <p className="invite-warn"><Icon kind="lock" /><span><b>Contains a one-time secret.</b> {linkOnly ? 'Paste it only into BentoKit’s Meshrooms channel settings, never in chat, a room, or a ticket.' : 'Paste it only to your own agent, never in chat, a room, or a ticket.'}</span></p>}
          <section className={`invite-card${dim ? ' is-dim' : ''}`} aria-label={`${linkOnly ? 'Link' : 'Prompt'} for ${current.name}`}>
            <header><span className="invite-badge is-agent" aria-hidden="true"><Icon kind={linkOnly ? 'link' : 'agent'} /></span><div><b>{linkOnly ? 'Link' : 'Prompt'} for {current.name}</b><small>{linkOnly ? 'Paste into “Agent connect link” under Settings › Channels › Add Channel › Meshrooms' : 'Paste into your agent, not into the room'}</small></div>
              <span className={`invite-pill ${dim ? 'is-bad' : spent ? 'is-ok' : 'is-secret'}`}>{dim ? <><Icon kind="clock" />Expired</> : spent ? <><Icon kind="check" />Link used</> : <><Icon kind="lock" />One-time secret</>}</span></header>
            <pre className={preClass} tabIndex={showFull ? 0 : -1} onFocus={event => { if (showFull) { const range = document.createRange(); range.selectNodeContents(event.currentTarget); const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range); } }}>{showFull && secretText ? secretText : current.preview}</pre>
            <footer><span><Icon kind="clock" />{dim ? 'Expired' : spent ? 'Link used' : <>Works once · expires in <b>{formatCountdown(msLeft)}</b></>}</span>
              {secretText && <button type="button" className="browser-text-link" aria-expanded={showFull} onClick={() => setShowFull(!showFull)}>{showFull ? (linkOnly ? 'Hide full link' : 'Hide full prompt') : (linkOnly ? 'Show full link' : 'Show full prompt')}</button>}</footer>
          </section></>}
      <Steps state={st} copied={!!copied} name={current.name} host={host} linkOnly={linkOnly} harnessLabel={shown?.label} />
      {st === 'used' && !host && <p className="invite-lead invite-muted">{current.name} used the link. The host has to let it in because it’s a guest’s agent. This updates when they do.</p>}
      {st === 'joined' && <p className="invite-lead invite-muted">It joined as a separate participant. Mention it in the room (<b>@{current.name}</b>) to ask it something. The one-time link is now spent.</p>}
      {st === 'open' && <ul className="invite-facts">
        <li><Icon kind="shield" /><span>{copied ? 'This updates by itself. You can close this and keep chatting; the agent will appear in the room.' : linkOnly ? <>In BentoKit, open <b>Settings › Channels › Add Channel › Meshrooms</b>, paste the full link (including the part after #) into <b>Agent connect link</b>, and save.</> : 'Your agent reads the join guide first. It asks you before installing anything.'}</span></li>
        {linkOnly && <li><Icon kind="lock" /><span>If BentoKit’s <b>Access Control</b> shows <b>Pairing</b>, set it to <b>Public</b> or <b>Admin approval</b> so room members can reach the agent.</span></li>}
      </ul>}
      {problem && <p className="invite-problem" role="alert">{problem}</p>}
    </>;
    const foot = st === 'open' ? (linkOnly ? <>
        <button type="button" className={`invite-cta${copied ? ' is-done' : ''}`} onClick={() => void copyAgent('link')}>{copied ? <><Icon kind="check" />Link copied · paste it in {shown?.label ?? 'BentoKit'}</> : `Copy link for ${current.name}`}</button>
        {copied && <button type="button" className="invite-text" onClick={() => void copyAgent('link')}>Copy again</button>}</>
      : <>
        <button type="button" className={`invite-cta${copied ? ' is-done' : ''}`} onClick={() => void copyAgent('prompt')}>{copied ? <><Icon kind="check" />{copied === 'link' ? 'Link copied' : 'Copied'} · paste it to {current.name}</> : `Copy prompt for ${current.name}`}</button>
        {copied ? <button type="button" className="invite-text" onClick={() => void copyAgent('prompt')}>Copy again</button> : <button type="button" className="invite-text" onClick={() => void copyAgent('link')}>Copy link only (advanced)</button>}</>)
      : st === 'joined' ? <><button type="button" className="primary invite-primary" onClick={onClose}>Back to room</button><button type="button" className="invite-text" onClick={again}>Invite another agent</button></>
      : st === 'expired' ? <button type="button" className="invite-cta" disabled={busy} onClick={() => void make(current.name, current.harness)}>{busy ? 'Creating…' : linkOnly ? 'Make a new link' : 'Make a new prompt'}</button>
      : <><button type="button" className="secondary invite-primary" onClick={onClose}>Done</button><button type="button" className="invite-text" onClick={again}>Invite another agent</button></>;
    return <div className="invite-panel" role="tabpanel" id="invite-panel-agent" aria-labelledby="invite-tab-agent"><div className="invite-body">{body}</div><div className="invite-foot">{foot}</div></div>;
  }

  function localPanel(): ReactNode {
    return <div className="invite-panel" role="tabpanel" id="invite-panel-agent" aria-labelledby="invite-tab-agent">
      <div className="invite-body">
        <p className="invite-lead">The agents you keep on this computer join from the Meshrooms app: no link and no prompt. Pick one of them, or set up a new one.</p>
        <section className="invite-does" aria-label="What your agent will do"><h3>What your agent will do</h3><ul>
          <li><Icon kind="check" /><span>Join as a <b>separate participant</b>, operated by you.</span></li>
          <li><Icon kind="check" /><span>Reply only when someone addresses it. Room messages are requests, not commands.</span></li>
          <li><Icon kind="check" /><span>You can remove it from the room at any time.</span></li></ul></section>
      </div>
      <div className="invite-foot"><button type="button" className="invite-cta" onClick={onOpenLocalAgents}>Choose from my agents</button></div>
    </div>;
  }

  return <dialog ref={dialog} className="invite-dialog" aria-labelledby="invite-title" onClose={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="invite-sheet-grab" aria-hidden="true" />
    <header className="invite-head"><div><h2 id="invite-title">{heading}</h2><p>{phone ? 'Pick who you’re inviting, or connect your own phone. Each uses a different link.' : 'Pick who you’re inviting. A person and an agent use different links.'}</p></div>
      <button type="button" className="invite-x" aria-label="Close" onClick={onClose}><Icon kind="close" /></button></header>
    <div className={`invite-tabs${phone ? ' has-phone' : ''}`} data-tab={tab} role="tablist" aria-label="Who to invite" onKeyDown={moveTab}>
      <span className="invite-glider" aria-hidden="true" style={{ '--at': at, '--count': order.length } as CSSProperties} />
      <button type="button" role="tab" id="invite-tab-person" ref={element => { tabs.current.person = element; }} aria-selected={tab === 'person'} aria-controls="invite-panel-person" tabIndex={tab === 'person' ? 0 : -1} className={`invite-tab is-person${tab === 'person' ? ' is-on' : ''}`} onClick={() => onTab('person')}>
        <span className="invite-badge is-person" aria-hidden="true"><Icon kind="person" /></span><span className="invite-tab-text"><b><span className="invite-long">A </span>person</b><small>A teammate, in a browser</small></span></button>
      <button type="button" role="tab" id="invite-tab-agent" ref={element => { tabs.current.agent = element; }} aria-selected={tab === 'agent'} aria-controls="invite-panel-agent" tabIndex={tab === 'agent' ? 0 : -1} className={`invite-tab is-agent${tab === 'agent' ? ' is-on' : ''}`} onClick={() => onTab('agent')}>
        <span className="invite-badge is-agent" aria-hidden="true"><Icon kind="agent" /></span><span className="invite-tab-text"><b><span className="invite-long">An AI </span>agent</b><small>Claude, Codex, Grok Bot…</small></span></button>
      {phone && <button type="button" role="tab" id="invite-tab-phone" ref={element => { tabs.current.phone = element; }} aria-selected={tab === 'phone'} aria-controls="invite-panel-phone" tabIndex={tab === 'phone' ? 0 : -1} className={`invite-tab is-phone${tab === 'phone' ? ' is-on' : ''}`} onClick={() => onTab('phone')}>
        <span className="invite-badge is-phone" aria-hidden="true"><Icon kind="phone" /></span><span className="invite-tab-text"><b>My phone</b><small>Same you, all rooms</small></span></button>}
    </div>
    {/* All panels stay mounted in one cell: the tallest sets the height, and a code waiting for the phone survives a look at the
        other tabs. The phone panel makes no code until it is shown (`active`). */}
    <div className="invite-stage" ref={stage}>
      {slide('person', personPanel())}
      {slide('agent', localAgents ? localPanel() : link && state ? madeStep(link, state) : chooseStep())}
      {phone && slide('phone', <PhonePairing active={open && tab === 'phone'} rooms={phone.rooms} name={phone.name} device={phone.device} link={phone.link} command={phone.command} asking={phone.asking} onActiveChange={phone.onActiveChange} onUseCode={phone.onUseCode} onNotice={onNotice} onClose={onClose} />)}
    </div>
    <span className="sr-only" role="status">{personCopied && tab === 'person' ? 'Room link copied' : copied && tab === 'agent' && state === 'open' ? (copied === 'link' ? 'Link copied. Paste it into your agent' : 'Prompt copied. Paste it to your agent') : ''}</span>
  </dialog>;
}
