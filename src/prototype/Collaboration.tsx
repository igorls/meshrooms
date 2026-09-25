import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { AGENTS_MENTION, TASK_STATUSES, groupTasks, matchesTaskFilter, mentionSegments, type Floor, type Task, type TaskFilter, type TaskStatus } from '../collab';
import { parseMarkdown, repoRef, safeHref, type Block, type Inline, type RepoRef } from '../markdown';
import type { Attachment, Participant, RoomSnapshot, TaskDraft } from '../room';

const statusLabels: Record<TaskStatus, string> = { todo: 'To do', doing: 'In progress', done: 'Done' };

const refGlyphs: Record<RepoRef['kind'], ReactNode> = {
  pull: <><circle cx="4" cy="3.5" r="1.5" /><circle cx="4" cy="12.5" r="1.5" /><circle cx="12" cy="12.5" r="1.5" /><path d="M4 5v6M12 11V7a2 2 0 0 0-2-2H7.5M9 3.5 7.5 5 9 6.5" /></>,
  issue: <><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" /></>,
  commit: <><circle cx="8" cy="8" r="2.5" /><path d="M1.5 8h4M10.5 8h4" /></>,
};
function RefIcon({ kind }: { kind: RepoRef['kind'] }) {
  return <svg className="md-ref-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{refGlyphs[kind]}</svg>;
}

/** Message markdown with @mentions marked; mentions of the viewer are stronger. Code stays literal. */
export function MentionText({ text, participants, viewerId }: { text: string; participants: Participant[]; viewerId?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const viewer = participants.find(p => p.id === viewerId)?.name.toLowerCase();
  const mentions = (value: string) => mentionSegments(value, participants).map((segment, index) => segment.mention
    ? <span key={index} className={`mention ${segment.text.slice(1).toLowerCase() === viewer ? 'you' : ''}`}>{segment.text}</span>
    : segment.text);
  const inline = (nodes: Inline[]): ReactNode[] => nodes.map((node, key) => {
    switch (node.type) {
      case 'text': return <Fragment key={key}>{mentions(node.text)}</Fragment>;
      case 'strong': return <strong key={key}>{inline(node.children)}</strong>;
      case 'em': return <em key={key}>{inline(node.children)}</em>;
      case 'code': return <code key={key}>{node.text}</code>;
      case 'link': {
        const ref = repoRef(node.href);
        if (!ref) return <a key={key} href={node.href} target="_blank" rel="noopener noreferrer">{inline(node.children)}</a>;
        // A pasted URL becomes the short name; a link the author labeled keeps its label.
        const bare = node.children.length === 1 && node.children[0].type === 'text' && safeHref(node.children[0].text) === node.href;
        return <a key={key} className={`md-ref md-ref-${ref.kind}`} href={node.href} title={node.href} target="_blank" rel="noopener noreferrer"><RefIcon kind={ref.kind} />{bare ? ref.label : inline(node.children)}</a>;
      }
      case 'br': return <br key={key} />;
    }
  });
  const block = (node: Block, key: number): ReactNode => {
    switch (node.type) {
      case 'paragraph': return <p key={key}>{inline(node.children)}</p>;
      case 'heading': return <p key={key} className="md-heading"><strong>{inline(node.children)}</strong></p>;
      case 'code': return <figure key={key} className="md-code">{node.lang && <figcaption>{node.lang}</figcaption>}<pre><code>{node.text}</code></pre></figure>;
      case 'quote': return <blockquote key={key}>{node.children.map(block)}</blockquote>;
      case 'rule': return <hr key={key} />;
      case 'list': {
        // A leading paragraph stays inline so tight lists read like lists, not stacked paragraphs.
        const items = node.items.map((item, index) => <li key={index}>{item.map((child, at) => !at && child.type === 'paragraph' ? <Fragment key={at}>{inline(child.children)}</Fragment> : block(child, at))}</li>);
        return node.ordered ? <ol key={key} start={node.start === 1 ? undefined : node.start}>{items}</ol> : <ul key={key}>{items}</ul>;
      }
    }
  };
  return <>{blocks.map(block)}</>;
}

export function FloorControl({ floor, disabled, onChange }: { floor: Floor; disabled: boolean; onChange: (floor: Floor) => void }) {
  return <div className="floor-control" role="group" aria-label="When agents reply">
    <span>Agents reply</span>
    <button aria-pressed={floor === 'humans-first'} disabled={disabled} onClick={() => floor !== 'humans-first' && onChange('humans-first')}>When mentioned</button>
    <button aria-pressed={floor === 'open'} disabled={disabled} onClick={() => floor !== 'open' && onChange('open')}>To every message</button>
  </div>;
}

export function floorNote(floor: Floor | undefined, hasAgents: boolean) {
  if (!hasAgents || !floor) return 'Only what you send is shared with this room. Drafts stay in this browser view.';
  return floor === 'humans-first'
    ? 'Agents are listening. They reply only when you @mention them, write @agents, reply to them, or assign them a task.'
    : 'Open floor: agents may reply to every message from a person. @mention to direct a request.';
}

export type MentionOption = { key: string; label: string; detail: string; agent: boolean };
type MentionState = { start: number; query: string; active: number } | null;

/** @-autocomplete for the composer textarea. The caller owns the draft text. */
export function useMentions(participants: Participant[], viewerId: string | undefined, input: RefObject<HTMLTextAreaElement | null>, setDraft: (text: string) => void) {
  const [state, setState] = useState<MentionState>(null);
  const agents = participants.filter(p => p.role === 'agent');
  const options: MentionOption[] = [
    ...participants.filter(p => p.id !== viewerId).sort((a, b) => a.role === b.role ? 0 : a.role === 'agent' ? -1 : 1)
      .map(p => {
        const operator = participants.find(o => o.id === p.operatorId);
        const detail = p.role === 'agent' ? operator ? `agent · ${operator.id === viewerId ? 'yours' : `${operator.name}'s`}` : 'agent' : p.machine ? `human · ${p.machine}` : 'human';
        return { key: p.id, label: p.name, detail, agent: p.role === 'agent' };
      }),
    ...(agents.length > 1 ? [{ key: AGENTS_MENTION, label: AGENTS_MENTION, detail: `all ${agents.length} agents`, agent: true }] : []),
  ].filter(option => !state || option.label.toLowerCase().startsWith(state.query.toLowerCase()));
  const open = !!state && options.length > 0;

  function track(text: string, caret: number) {
    const before = text.slice(0, caret); const at = before.lastIndexOf('@');
    const query = at >= 0 ? before.slice(at + 1) : '';
    if (at < 0 || (at > 0 && /[\p{L}\p{N}_]/u.test(before[at - 1])) || query.length > 32 || /\n/.test(query)) { setState(null); return; }
    setState(current => ({ start: at, query, active: current?.start === at ? current.active : 0 }));
  }
  function choose(option: MentionOption) {
    const element = input.current; if (!element || !state) return;
    const insert = `@${option.label} `; const end = state.start + 1 + state.query.length;
    const text = element.value.slice(0, state.start) + insert + element.value.slice(end);
    setDraft(text); setState(null);
    requestAnimationFrame(() => { element.focus(); element.setSelectionRange(state.start + insert.length, state.start + insert.length); });
  }
  /** Returns true when the key was consumed by the suggestion list. */
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open || !state) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); const step = event.key === 'ArrowDown' ? 1 : -1;
      setState({ ...state, active: (state.active + step + options.length) % options.length }); return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); choose(options[Math.min(state.active, options.length - 1)]); return true; }
    if (event.key === 'Escape') { event.preventDefault(); setState(null); return true; }
    return false;
  }
  function start() {
    const element = input.current; if (!element) return;
    const caret = element.selectionStart ?? element.value.length; const before = element.value.slice(0, caret);
    const text = before + (before && !/\s$/.test(before) ? ' @' : '@') + element.value.slice(caret);
    const next = caret + (text.length - element.value.length);
    setDraft(text); element.focus(); requestAnimationFrame(() => { element.setSelectionRange(next, next); track(text, next); });
  }
  const activeId = open ? `mention-option-${Math.min(state!.active, options.length - 1)}` : undefined;
  const list = open ? <ul className="mention-list" id="mention-list" role="listbox" aria-label="Mention someone">{options.map((option, index) =>
    <li key={option.key} id={`mention-option-${index}`} role="option" aria-selected={index === state!.active}
      onMouseDown={event => { event.preventDefault(); choose(option); }}>
      <span className={`mention-avatar ${option.agent ? 'agent' : ''}`} aria-hidden="true">{option.label.slice(0, 1).toUpperCase()}</span>
      <strong>@{option.label}</strong><span className="role-label">{option.detail}</span>
    </li>)}</ul> : null;
  return { track, onKeyDown, start, close: () => setState(null), list, inputProps: {
    role: 'combobox', 'aria-autocomplete': 'list' as const, 'aria-expanded': open, 'aria-controls': open ? 'mention-list' : undefined, 'aria-activedescendant': activeId,
  } };
}

/**
 * Keeps a conversation at its latest message while the reader is there, including when content grows after render
 * (images, code blocks, a taller composer). Scrolling up releases it; arrivals are then counted until the reader returns.
 */
export function useStickToBottom(threshold = 80) {
  const element = useRef<HTMLElement | null>(null), pinned = useRef(true), lastTop = useRef(0);
  const [unread, setUnread] = useState(0);
  const toBottom = useCallback(() => {
    pinned.current = true; setUnread(0);
    if (element.current) element.current.scrollTop = element.current.scrollHeight;
  }, []);
  const ref = useCallback((node: HTMLElement | null) => {
    element.current = node; if (!node) return;
    const follow = () => { if (pinned.current) node.scrollTop = node.scrollHeight; };
    const sizes = new ResizeObserver(follow);
    const watch = () => { sizes.observe(node); for (const child of node.children) sizes.observe(child); };
    const children = new MutationObserver(() => { watch(); follow(); });
    watch(); children.observe(node, { childList: true }); follow();
    return () => { sizes.disconnect(); children.disconnect(); if (element.current === node) element.current = null; };
  }, []);
  const onScroll = useCallback(() => {
    const el = element.current; if (!el?.clientHeight) return;
    const distance = el.scrollHeight - el.clientHeight - el.scrollTop, up = el.scrollTop < lastTop.current;
    lastTop.current = el.scrollTop;
    // Only the reader moves the view up, and any upward scroll releases it, so content arriving mid-gesture never pulls
    // them back. Scrolls that don't move up come from layout (a taller composer, new content) and keep the pin as is.
    if (up && distance > 1) pinned.current = false;
    else if (distance < threshold) pinned.current = true;
    if (pinned.current) setUnread(0);
  }, [threshold]);
  /** Your own message always shows; others' are counted while the reader is scrolled up. */
  const arrived = useCallback((own: boolean) => { if (own) toBottom(); else if (!pinned.current) setUnread(count => count + 1); }, [toBottom]);
  return { ref, onScroll, toBottom, arrived, unread };
}

/** Sizes a textarea to its content; its CSS max-height caps the growth, after which it scrolls. */
export function useAutoGrow(input: RefObject<HTMLTextAreaElement | null>, value: string) {
  const fit = useCallback(() => {
    const el = input.current, parent = el?.parentElement; if (!el || !parent) return;
    // Hold the parent's height while measuring so the collapse never reaches the layout around it (and a pinned
    // conversation's scroll position).
    parent.style.minHeight = `${parent.offsetHeight}px`;
    el.style.height = 'auto'; el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
    parent.style.minHeight = '';
  }, [input]);
  useLayoutEffect(fit, [fit, value]);
  useEffect(() => { addEventListener('resize', fit); return () => removeEventListener('resize', fit); }, [fit]);
}

type BoardActions = {
  create: (task: TaskDraft & { title: string }) => Promise<void>;
  update: (task: Task, changes: TaskDraft) => Promise<void>;
  remove: (task: Task) => Promise<void>;
};

/** Finished tasks shown before "Show all"; boards collect many and the latest are the ones people check. */
const DONE_PREVIEW = 10;
/** Board width at which the statuses sit side by side as columns. */
const WIDE_BOARD = 700;
const DONE_KEY = 'meshrooms:board-done';
const emptyText: Record<TaskStatus, string> = { todo: 'Nothing waiting.', doing: 'Nobody is working on a task.', done: 'No finished tasks yet.' };

function Chevron({ open }: { open: boolean }) {
  return <svg className={`board-chevron ${open ? 'open' : ''}`} width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>;
}

/** `working` names the agents currently working on each task, by task id (browser rooms report agent activity). */
export function TaskBoard({ room, viewerId, disabled, onClose, actions, highlight, working }: { room: RoomSnapshot; viewerId?: string; disabled: boolean; onClose: () => void; actions: BoardActions; highlight?: string; working?: Record<string, string[]> }) {
  const [title, setTitle] = useState(''); const [assignee, setAssignee] = useState(''); const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [doneOpen, setDoneOpen] = useState(() => { try { return localStorage.getItem(DONE_KEY) === 'open'; } catch { return false; } });
  const [allDone, setAllDone] = useState(false);
  const [wide, setWide] = useState(false);
  const board = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const sizes = new ResizeObserver(() => setWide(node.offsetWidth >= WIDE_BOARD));
    sizes.observe(node);
    return () => sizes.disconnect();
  }, []);
  const tasks = room.tasks || []; const local = room.participants.filter(p => p.state === 'local');
  const open = tasks.filter(t => t.status !== 'done').length;
  const filters: { key: TaskFilter; label: string }[] = [{ key: 'all', label: 'All' }, ...(viewerId ? [{ key: 'mine' as const, label: 'Mine' }] : []), { key: 'unassigned', label: 'Unassigned' },
    ...room.participants.filter(p => p.role === 'agent' && tasks.some(t => t.assigneeId === p.id)).map(p => ({ key: `member:${p.id}` as const, label: p.name }))];
  // An agent's filter goes when its last task does.
  const active = filters.some(f => f.key === filter) ? filter : 'all';
  const groups = groupTasks(tasks, active, viewerId);
  const openMatching = (key: TaskFilter) => tasks.filter(t => t.status !== 'done' && matchesTaskFilter(t, key, viewerId)).length;
  // A task shown from the conversation must be on screen: drop a filter that hides it and open the finished work it is in.
  // Its card scrolls itself into view once it renders.
  useEffect(() => {
    const task = tasks.find(t => t.id === highlight); if (!task) return;
    const shown = matchesTaskFilter(task, active, viewerId) ? active : 'all';
    if (shown !== active) setFilter('all');
    if (task.status !== 'done') return;
    setDoneOpen(true);
    if (!groupTasks(tasks, shown, viewerId).done.slice(0, DONE_PREVIEW).includes(task)) setAllDone(true);
  }, [highlight]);
  function toggleDone() {
    const next = !doneOpen; setDoneOpen(next);
    try { localStorage.setItem(DONE_KEY, next ? 'open' : 'closed'); } catch { /* storage may be unavailable */ }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!title.trim() || busy) return; setBusy(true);
    try { await actions.create({ title: title.trim(), assigneeId: assignee || undefined }); setTitle(''); setAssignee(''); }
    catch { /* The room view reports the error; keep the draft for a retry. */ }
    finally { setBusy(false); }
  }
  return <aside ref={board} className={`task-board ${wide ? 'is-wide' : ''}`} id="task-board" aria-labelledby="task-board-title">
    <div className="board-heading"><div><h2 id="task-board-title">Tasks</h2><p>{open} open · {room.paired ? 'On this machine only; the paired node does not see this board.' : 'Everyone in this room can add, assign, and move tasks.'}</p></div>
      <button className="icon-button" aria-label="Close tasks" onClick={onClose}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg></button></div>
    <form className="task-add" onSubmit={submit}>
      <label className="sr-only" htmlFor="task-title">New task</label>
      <input id="task-title" value={title} onChange={e => setTitle(e.target.value)} placeholder="Add a task…" maxLength={120} />
      <div><label className="sr-only" htmlFor="task-assignee">Assign to</label>
        <select id="task-assignee" value={assignee} onChange={e => setAssignee(e.target.value)}><option value="">Unassigned</option>{local.map(p => <option key={p.id} value={p.id}>{p.id === viewerId ? `${p.name} (you)` : p.name}{p.role === 'agent' ? ' · agent' : ''}</option>)}</select>
        <button className="primary" type="submit" disabled={disabled || busy || !title.trim()}>{busy ? 'Adding…' : 'Add'}</button></div>
    </form>
    {tasks.length > 0 && <div className="board-filters" role="group" aria-label="Show tasks">{filters.map(f =>
      <button key={f.key} aria-pressed={active === f.key} onClick={() => setFilter(f.key)}>{f.label}<span>{openMatching(f.key)}<span className="sr-only"> open</span></span></button>)}</div>}
    <div className="board-columns">{TASK_STATUSES.map(status => {
      const items = groups[status], done = status === 'done';
      // Narrow boards fold finished work away; wide ones give it a column of its own.
      const folded = done && !wide && !doneOpen;
      const shown = done && !allDone ? items.slice(0, DONE_PREVIEW) : items;
      const count = <span>{items.length}</span>;
      return <section key={status} className={`board-column ${status}`} aria-labelledby={`board-${status}`}>
        <h3 id={`board-${status}`}>{done && !wide
          ? <button className="board-disclosure" aria-expanded={!folded} aria-controls={folded ? undefined : 'board-done-list'} onClick={toggleDone}><Chevron open={!folded} />{statusLabels[status]}{count}</button>
          : <>{statusLabels[status]}{count}</>}</h3>
        {!folded && <div className="board-list" id={done ? 'board-done-list' : undefined}>
          {items.length === 0 ? <p className="board-empty">{active === 'all' ? emptyText[status] : 'None match this filter.'}</p>
            : <ul>{shown.map(task => <TaskCard key={task.id} task={task} room={room} viewerId={viewerId} disabled={disabled} actions={actions} highlighted={task.id === highlight} working={working?.[task.id]} />)}</ul>}
          {done && items.length > DONE_PREVIEW && <button className="board-more" onClick={() => setAllDone(!allDone)}>{allDone ? 'Show recent only' : `Show all ${items.length}`}</button>}
        </div>}
      </section>;
    })}</div>
  </aside>;
}

function TaskCard({ task, room, viewerId, disabled, actions, highlighted, working }: { task: Task; room: RoomSnapshot; viewerId?: string; disabled: boolean; actions: BoardActions; highlighted?: boolean; working?: string[] }) {
  const card = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!highlighted) return;
    card.current?.scrollIntoView({ block: 'nearest' }); card.current?.querySelector<HTMLButtonElement>('.task-title')?.focus({ preventScroll: true });
  }, [highlighted]);
  const [expanded, setExpanded] = useState(false); const [notesOpen, setNotesOpen] = useState(false); const [notes, setNotes] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const name = (id?: string) => id === viewerId ? 'You' : room.participants.find(p => p.id === id)?.name || 'Former member';
  const assignee = room.participants.find(p => p.id === task.assigneeId);
  const local = room.participants.filter(p => p.state === 'local');
  async function run(action: () => Promise<void>) { setBusy(true); try { await action(); } catch { /* Reported by the room view. */ } finally { setBusy(false); } }
  const next: TaskStatus | undefined = task.status === 'todo' ? 'doing' : task.status === 'doing' ? 'done' : undefined;
  const lock = disabled || busy;
  return <li ref={card} className={`task-card ${highlighted ? 'task-card-highlight' : ''}`}>
    <div className="task-top">
      <button className="task-title" aria-expanded={expanded} onClick={() => { setExpanded(!expanded); setNotes(null); }}>{task.title}</button>
      {next ? <button className="task-advance" disabled={lock} onClick={() => run(() => actions.update(task, { status: next }))}>{next === 'doing' ? 'Start' : 'Done'}</button>
        : <button className="task-advance" disabled={lock} onClick={() => run(() => actions.update(task, { status: 'todo' }))}>Reopen</button>}
    </div>
    <div className="task-meta">
      {assignee ? <span className={`task-assignee ${assignee.role}`}><span className={`mention-avatar ${assignee.role === 'agent' ? 'agent' : ''}`} aria-hidden="true">{assignee.name.slice(0, 1).toUpperCase()}</span>{assignee.id === viewerId ? 'You' : assignee.name}{assignee.role === 'agent' && <span className="role-label">agent</span>}</span> : <span className="task-assignee none">Unassigned</span>}
      {!!working?.length && <span className="task-working">{working.join(', ')} working</span>}
      {task.notes && !expanded && <button className="task-notes-toggle" aria-expanded={notesOpen} onClick={() => setNotesOpen(!notesOpen)}>Notes<Chevron open={notesOpen} /></button>}
    </div>
    {notesOpen && task.notes && !expanded && <p className="task-notes">{task.notes}</p>}
    {expanded && <div className="task-details">
      <label>Assignee<select value={task.assigneeId || ''} disabled={lock} onChange={e => run(() => actions.update(task, { assigneeId: e.target.value || null }))}><option value="">Unassigned</option>{local.map(p => <option key={p.id} value={p.id}>{p.id === viewerId ? `${p.name} (you)` : p.name}{p.role === 'agent' ? ' · agent' : ''}</option>)}</select></label>
      <label>Status<select value={task.status} disabled={lock} onChange={e => run(() => actions.update(task, { status: e.target.value as TaskStatus }))}>{TASK_STATUSES.map(s => <option key={s} value={s}>{statusLabels[s]}</option>)}</select></label>
      <label>Notes<textarea value={notes ?? task.notes} onChange={e => setNotes(e.target.value)} maxLength={2000} rows={3} placeholder="Acceptance criteria, branch, links…" /></label>
      <div className="task-actions">
        <button className="text-button danger" disabled={lock} onClick={() => run(() => actions.remove(task))}>Remove</button>
        <button className="secondary" disabled={lock || notes === null || notes === task.notes} onClick={() => run(async () => { await actions.update(task, { notes: notes ?? '' }); setNotes(null); })}>Save notes</button>
      </div>
      <p className="task-history">Added by {name(task.createdBy)} · updated by {name(task.updatedBy)} {new Date(task.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
    </div>}
  </li>;
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_FILES = 4;
export type PendingFile = { key: string; file: File; name: string; preview?: string; status: 'uploading' | 'ready' | 'failed'; attachment?: Attachment; error?: string };

export function formatBytes(size: number) {
  return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.round(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
}
/** Clipboard screenshots arrive as "image.png"; give them a name that says what and when. */
export function uploadName(file: File) {
  if (file.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(file.name)) return file.name;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  return `screenshot-${stamp}.${file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'}`;
}
export const attachmentUrl = (roomId: string, id: string) => `/api/node/attachments/${roomId}/${id}`;

function FileIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H5v18h14V8zM14 3v5h5" /></svg>;
}

export function PendingFiles({ files, onRemove, onRetry }: { files: PendingFile[]; onRemove: (key: string) => void; onRetry: (key: string) => void }) {
  if (!files.length) return null;
  return <ul className="pending-files" aria-label="Attachments for this message">{files.map(item => <li key={item.key} className={`pending-file ${item.status}`}>
    {item.preview ? <img src={item.preview} alt="" /> : <span className="pending-icon"><FileIcon /></span>}
    <span className="pending-copy"><strong>{item.name}</strong><span role="status">{item.status === 'uploading' ? 'Uploading…' : item.status === 'failed' ? item.error || 'Upload failed' : formatBytes(item.file.size)}</span></span>
    {item.status === 'failed' && <button type="button" className="text-button" onClick={() => onRetry(item.key)}>Retry</button>}
    <button type="button" className="pending-remove" aria-label={`Remove ${item.name}`} onClick={() => onRemove(item.key)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg></button>
  </li>)}</ul>;
}

/** Where an attachment's bytes are: a URL, or a note while they are not on this device yet (browser rooms fetch them from peers). */
export type AttachmentSource = (attachment: Attachment) => { url?: string; note?: string };

/** Images render inline and open full size; other files are downloads. */
export function MessageAttachments({ roomId, attachments, author, source }: { roomId: string; attachments: Attachment[]; author: string; source?: AttachmentSource }) {
  const [open, setOpen] = useState<Attachment | null>(null);
  const locate: AttachmentSource = source || (a => ({ url: attachmentUrl(roomId, a.id) }));
  const images = attachments.filter(a => a.kind === 'image'); const files = attachments.filter(a => a.kind !== 'image');
  const viewing = open && locate(open).url;
  return <div className="message-attachments">
    {images.length > 0 && <div className={`attachment-images count-${Math.min(images.length, 4)}`}>{images.map(image => {
      const { url, note } = locate(image);
      return url ? <button key={image.id} className="attachment-image" onClick={() => setOpen(image)} aria-label={`Open ${image.name} from ${author}`}>
        <img src={url} alt={image.name} width={image.width} height={image.height} loading="lazy" decoding="async" />
      </button> : <div key={image.id} className="attachment-image attachment-waiting" role="img" aria-label={`${image.name}: ${note}`} style={image.width && image.height ? { aspectRatio: `${image.width} / ${image.height}` } : undefined}>
        <span><strong>{image.name}</strong><small>{note}</small></span></div>;
    })}</div>}
    {files.map(file => {
      const { url, note } = locate(file);
      const label = <><FileIcon /><span><strong>{file.name}</strong><small>{note || `${file.type === 'application/pdf' ? 'PDF' : file.type === 'text/plain' ? 'Text' : 'File'} · ${formatBytes(file.size)}`}</small></span></>;
      return url ? <a key={file.id} className="attachment-file" href={url} download={file.name}>{label}</a> : <span key={file.id} className="attachment-file attachment-waiting">{label}</span>;
    })}
    {open && viewing && <ImageViewer url={viewing} image={open} author={author} onClose={() => setOpen(null)} />}
  </div>;
}

/** The whole image on screen, the viewer's width with the rest scrolling, or the image's own pixels. */
type ImageView = 'fit' | 'width' | 'actual';
/** Views from smallest to largest, for the zoom cursor. */
const VIEW_SIZES: ImageView[] = ['fit', 'width', 'actual'];

/**
 * Fitting a long page or a log on screen shrinks it to a sliver, so an image that would show at less than half the
 * width it could have opens at the viewer's width instead, scrolling down. A click switches to the other useful view:
 * actual size when the width still scales it down (phones), otherwise the whole image; a second click switches back.
 */
export function imageViews(image: { width: number; height: number }, stage: { width: number; height: number }): { start: ImageView; other?: ImageView } {
  const across = Math.min(stage.width / image.width, 1), whole = Math.min(across, stage.height / image.height);
  if (whole < across / 2) return { start: 'width', other: across < 1 ? 'actual' : 'fit' };
  return whole < 1 ? { start: 'fit', other: 'actual' } : { start: 'fit' };
}

function ImageViewer({ url, image, author, onClose }: { url: string; image: Attachment; author: string; onClose: () => void }) {
  const stage = useRef<HTMLDivElement>(null), chosen = useRef<{ start: ImageView; other?: ImageView }>({ start: 'fit' });
  const [natural, setNatural] = useState<{ width: number; height: number }>();
  const [views, setViews] = useState(chosen.current);
  const [view, setView] = useState<ImageView>('fit');
  const other = views.other, next = view === views.start ? other : views.start;
  const toggle = other && next ? () => { setView(next); stage.current?.scrollTo(0, 0); } : undefined;
  // Choose again when the viewer changes size (a resized window, a rotated phone). Measuring the box with its scrollbar
  // means a scrollbar appearing in one view can't flip the choice back and forth.
  useEffect(() => {
    const box = stage.current;
    if (!box || !natural) return;
    const choose = () => {
      const found = imageViews(natural, { width: box.offsetWidth, height: box.offsetHeight });
      if (found.start === chosen.current.start && found.other === chosen.current.other) return;
      chosen.current = found; setViews(found); setView(found.start);
    };
    choose();
    const sizes = new ResizeObserver(choose);
    sizes.observe(box);
    return () => sizes.disconnect();
  }, [natural]);
  const label = next === 'fit' ? 'Fit to screen' : next === 'width' ? 'Fit width' : 'Actual size';
  return <dialog className="image-viewer" aria-label={image.name} ref={element => { if (element && !element.open) element.showModal(); }}
    onClose={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="viewer-bar"><span><strong>{image.name}</strong><small>{author} · {image.width && image.height ? `${image.width}×${image.height} · ` : ''}{formatBytes(image.size)}</small></span>
      {toggle && <button className="secondary" onClick={toggle}>{label}</button>}
      <a className="secondary" href={url} download={image.name}>Download</a>
      <button className="icon-button" aria-label="Close image" onClick={onClose} autoFocus><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg></button></div>
    <div className="viewer-stage" ref={stage} tabIndex={0} aria-label={`${image.name}, scrollable`} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <img src={url} alt={image.name} className={`view-${view}${toggle ? ` zoom-${VIEW_SIZES.indexOf(next!) > VIEW_SIZES.indexOf(view) ? 'in' : 'out'}` : ''}`} onLoad={event => { const img = event.currentTarget; if (img.naturalWidth && img.naturalHeight) setNatural({ width: img.naturalWidth, height: img.naturalHeight }); }} onClick={toggle} />
    </div>
  </dialog>;
}
