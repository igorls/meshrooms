import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { TASK_STATUSES, type Task, type TaskStatus } from '../collab';
import { IssueChip, statusLabels } from '../prototype/Collaboration';
import type { TaskEvent } from './board';
import type { Decision } from './decisions';
import { decisionSummary, timeLeft } from './DecisionViews';
import { TODO_PREVIEW, ago, decisionOfTask, taskFromDecision, taskHistory, workCount, type WorkList, type WorkRef } from './work-pane';

type Glyph = TaskStatus | 'decision' | 'back' | 'board' | 'chat';
const GLYPHS: Record<Glyph, ReactNode> = {
  todo: <circle cx="12" cy="12" r="7.5" />,
  doing: <><circle cx="12" cy="12" r="7.5" /><path d="M12 4.5a7.5 7.5 0 0 1 0 15z" fill="currentColor" stroke="none" /></>,
  done: <><circle cx="12" cy="12" r="7.5" /><path d="m8.6 12.3 2.4 2.4 4.4-4.9" /></>,
  decision: <path d="M4.5 20h15M7 16.5V5.5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v11M9.5 10.5l1.8 1.8 3.4-3.6" />,
  back: <path d="M14.5 6.5 9 12l5.5 5.5" />,
  board: <><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M9.5 5v14M14.5 5v14" /></>,
  chat: <path d="M5 6.5A1.5 1.5 0 0 1 6.5 5h11A1.5 1.5 0 0 1 19 6.5v8a1.5 1.5 0 0 1-1.5 1.5H10l-4 3.5V16h-.5A1.5 1.5 0 0 1 5 14.5z" />,
};
export const WorkGlyph = ({ kind, size = 16 }: { kind: Glyph; size?: number }) =>
  <svg className={`work-glyph is-${kind}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{GLYPHS[kind]}</svg>;

type ViewProps = Omit<WorkPaneProps, 'work'>;
const refKey = (ref: WorkRef) => ref.kind === 'task' ? `task:${ref.id}` : `decision:${ref.key}`;

export type WorkPaneProps = {
  /** The selected work as the room holds it now; undefined shows the list. */
  work: { kind: 'task'; task: Task } | { kind: 'decision'; decision: Decision } | undefined;
  list: WorkList; tasks: Task[]; decisions: Decision[]; events: TaskEvent[];
  viewerId?: string; viewerIsPerson: boolean; now: number; disabled: boolean;
  /** "You" for the viewer, the member's name otherwise. */
  nameOf: (memberId: string) => string;
  avatar: (memberId: string) => ReactNode;
  /** A task change as a sentence about "this task". */
  describe: (event: TaskEvent) => string;
  /** The decision's card; `made` is the task already made from it, so the card stops offering to make another. */
  renderDecision: (decision: Decision, made: Task | undefined) => ReactNode;
  onSelect: (ref: WorkRef | undefined) => void;
  onStatus: (task: Task, status: TaskStatus) => Promise<void>;
  onShowOnBoard: (taskId: string) => void;
  onShowInConversation: (decisionKey: string) => void;
  onOpenBoard: () => void;
};

/**
 * "This work" in the side pane: the room's work as a list, or one task or decision with who owns it, what changed and
 * where it stands. Opening a task anywhere in the room (its line in the conversation, an agent's activity, "Needs you")
 * lands here.
 */
export function WorkPane(props: WorkPaneProps) {
  const { work, onSelect } = props;
  // The work just left, so going back puts focus on its row instead of the top of the list.
  const [left, setLeft] = useState<string>();
  const selected = work && refKey(work.kind === 'task' ? { kind: 'task', id: work.task.id } : { kind: 'decision', key: work.decision.key });
  // Only the work just left: one opened since, then removed, sends focus to the top of the list instead.
  useEffect(() => { if (selected) setLeft(undefined); }, [selected]);
  const back = () => { setLeft(selected); onSelect(undefined); };
  return work
    ? <WorkView key={selected} {...props} work={work} onBack={back} />
    : <WorkListView {...props} returnTo={left} />;
}

function WorkView({ work, onBack, ...props }: WorkPaneProps & { work: NonNullable<WorkPaneProps['work']>; onBack: () => void }) {
  const view = useRef<HTMLDivElement>(null);
  // Arriving at a piece of work moves focus to its title, as the task board does for a task shown from the conversation.
  useEffect(() => {
    view.current?.closest('.browser-details-body')?.scrollTo({ top: 0 });
    const title = view.current?.querySelector<HTMLElement>('h3'); if (!title) return;
    title.tabIndex = -1; title.focus({ preventScroll: true });
  }, []);
  return <div ref={view} className="work-view">
    <button type="button" className="work-back" onClick={onBack}><WorkGlyph kind="back" />All work</button>
    {work.kind === 'task' ? <TaskView task={work.task} {...props} /> : <DecisionView decision={work.decision} {...props} />}
  </div>;
}

function TaskView({ task, tasks, decisions, events, now, disabled, nameOf, avatar, describe, onSelect, onStatus, onShowOnBoard }: ViewProps & { task: Task }) {
  const [busy, setBusy] = useState<TaskStatus>();
  const history = taskHistory(events, task.id), from = decisionOfTask(task, decisions, tasks);
  const created = history.find(e => e.created);
  const assigner = task.assignedBy && task.assignedBy !== task.createdBy ? task.assignedBy : undefined;
  const person = (id: string) => <span className="work-person">{avatar(id)}<span>{nameOf(id)}</span></span>;
  async function move(status: TaskStatus) {
    if (status === task.status || busy) return;
    setBusy(status);
    try { await onStatus(task, status); } catch { /* Reported by the room view. */ } finally { setBusy(undefined); }
  }
  return <article className="work-detail" aria-labelledby={`work-title-${task.id}`}>
    <h3 id={`work-title-${task.id}`} className="work-title">{task.title}</h3>
    <p className="work-meta">
      <span className={`work-state is-${task.status}`}><WorkGlyph kind={task.status} size={14} />{statusLabels[task.status]}</span>
      <span>Updated {ago(Date.parse(task.updatedAt), now)} by {nameOf(task.updatedBy)}</span>
    </p>
    <div className="work-status" role="group" aria-label="Move this task">
      {TASK_STATUSES.map(s => <button key={s} type="button" aria-pressed={task.status === s} disabled={disabled || !!busy}
        className={busy === s ? 'is-busy' : undefined} onClick={() => void move(s)}>{statusLabels[s]}</button>)}
    </div>
    <dl className="work-facts">
      <div><dt>Owner</dt><dd>{task.assigneeId ? person(task.assigneeId) : <span className="work-none">Unassigned</span>}</dd></div>
      <div><dt>Created by</dt><dd>{person(task.createdBy)}</dd></div>
      {assigner && <div><dt>Assigned by</dt><dd>{person(assigner)}</dd></div>}
      {created && <div><dt>Created</dt><dd><time dateTime={new Date(created.at).toISOString()}>{ago(created.at, now)}</time></dd></div>}
      {task.issue && <div className="is-wide"><dt>Linked</dt><dd><IssueChip link={task.issue} /></dd></div>}
      {from && <div className="is-wide"><dt>Decided in</dt><dd><button type="button" className="work-link" onClick={() => onSelect({ kind: 'decision', key: from.key })}><WorkGlyph kind="decision" size={14} /><span>{from.question}</span></button></dd></div>}
    </dl>
    {task.notes && <section className="work-section" aria-labelledby={`work-notes-${task.id}`}>
      <h4 id={`work-notes-${task.id}`}>Notes</h4>
      <p className="work-notes">{task.notes}</p>
    </section>}
    <section className="work-section" aria-labelledby={`work-history-${task.id}`}>
      <h4 id={`work-history-${task.id}`}>History <span>{history.length}</span></h4>
      {history.length ? <ol className="work-history">
        {history.map(e => <li key={e.id}>
          <span className="work-history-avatar">{avatar(e.memberId)}</span>
          <p>{describe(e)}</p>
          <time dateTime={new Date(e.at).toISOString()} title={new Date(e.at).toLocaleString()}>{ago(e.at, now)}</time>
        </li>)}
      </ol> : <p className="work-quiet">Older changes were compacted away; the task’s current state is above.</p>}
    </section>
    <div className="work-actions">
      <button type="button" className="secondary" onClick={() => onShowOnBoard(task.id)}><WorkGlyph kind="board" />Show on task board</button>
    </div>
  </article>;
}

function DecisionView({ decision, tasks, decisions, renderDecision, onSelect, onShowInConversation }: ViewProps & { decision: Decision }) {
  const made = taskFromDecision(decision, tasks, decisions);
  return <div className="work-detail work-decision">
    {renderDecision(decision, made)}
    {made && <p className="work-made">Became the task <button type="button" className="work-link" onClick={() => onSelect({ kind: 'task', id: made.id })}>
      <WorkGlyph kind={made.status} size={14} /><span>{made.title}</span></button></p>}
    <div className="work-actions">
      <button type="button" className="secondary" onClick={() => onShowInConversation(decision.key)}><WorkGlyph kind="chat" />Show in conversation</button>
    </div>
  </div>;
}

function WorkListView({ list, tasks, viewerId, viewerIsPerson, now, nameOf, onSelect, onOpenBoard, returnTo }: ViewProps & { returnTo?: string }) {
  const [allTodo, setAllTodo] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = returnTo && root.current?.querySelector<HTMLElement>(`[data-work="${CSS.escape(returnTo)}"]`);
    if (row) { row.focus({ preventScroll: false }); return; }
    // The open work went away under the person (removed, or no longer held): its view took focus with it.
    if (document.activeElement && document.activeElement !== document.body) return;
    const first = root.current?.querySelector<HTMLElement>('.work-row, .work-empty button');
    if (first) first.focus(); else { root.current?.setAttribute('tabindex', '-1'); root.current?.focus(); }
  }, [returnTo]);
  if (!workCount(list)) return <div ref={root} className="work-empty">
    <WorkGlyph kind="board" size={28} />
    <h3>No work in this room yet</h3>
    <p>Tasks and decisions show up here as people and agents start them. Pick one to see who owns it, what changed and where it stands.</p>
    <button type="button" className="secondary" onClick={onOpenBoard}>{tasks.length ? 'Open the task board' : 'Add a task'}</button>
  </div>;

  const taskRow = (task: Task) => <li key={task.id}>
    <button type="button" className="work-row" data-work={`task:${task.id}`} onClick={() => onSelect({ kind: 'task', id: task.id })}>
      <span className={`work-row-glyph is-${task.status}`}><WorkGlyph kind={task.status} /></span>
      <span className="work-row-main">
        <span className="work-row-title">{task.title}</span>
        <span className="work-row-meta">{task.assigneeId ? nameOf(task.assigneeId) : 'Unassigned'} · {ago(Date.parse(task.updatedAt), now)}</span>
      </span>
    </button>
  </li>;
  const decisionRow = (d: Decision) => {
    const yours = viewerIsPerson && !d.votes.some(v => v.memberId === viewerId && v.optionId);
    return <li key={d.key}>
      <button type="button" className="work-row" data-work={`decision:${d.key}`} onClick={() => onSelect({ kind: 'decision', key: d.key })}>
        <span className="work-row-glyph is-decision"><WorkGlyph kind="decision" /></span>
        <span className="work-row-main">
          <span className="work-row-title">{d.question}</span>
          <span className="work-row-meta">{decisionSummary(d)}{d.closesAt ? ` · ${timeLeft(d.closesAt, now)}` : ''}</span>
        </span>
        {yours && <span className="work-row-tag">Your vote</span>}
      </button>
    </li>;
  };
  const todo = allTodo ? list.todo : list.todo.slice(0, TODO_PREVIEW);
  const group = (id: string, label: string, count: number, rows: ReactNode, more?: ReactNode) => count > 0 && <section className="work-group" aria-labelledby={`work-group-${id}`}>
    <h3 id={`work-group-${id}`}>{label} <span>{count}</span></h3>
    <ul>{rows}</ul>{more}
  </section>;
  return <div ref={root} className="work-list">
    {group('doing', 'In progress', list.doing.length, list.doing.map(taskRow))}
    {group('decisions', 'Open decisions', list.decisions.length, list.decisions.map(decisionRow))}
    {group('todo', 'To do', list.todo.length, todo.map(taskRow), list.todo.length > TODO_PREVIEW
      && <button type="button" className="work-more" aria-expanded={allTodo} onClick={() => setAllTodo(!allTodo)}>{allTodo ? 'Show fewer' : `Show all ${list.todo.length}`}</button>)}
    {group('done', 'Finished in the last 3 days', list.done.length, list.done.map(taskRow))}
  </div>;
}
