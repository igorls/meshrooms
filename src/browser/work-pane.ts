/**
 * "This work": the side pane's view of one piece of the room's work (a task or a decision), and the list it is picked
 * from. Everything here is read from what the room already holds; nothing is sent.
 */
import type { Task } from '../collab';
import type { TaskEvent } from './board';
import { decisionTaskTitle, type Decision } from './decisions';

export type WorkRef = { kind: 'task'; id: string } | { kind: 'decision'; key: string };
/** How long a finished task stays in the work list. */
export const RECENT_DONE_MS = 3 * 24 * 60 * 60_000;
/** To-do tasks the list shows before "Show all". */
export const TODO_PREVIEW = 5;

export type WorkList = { doing: Task[]; decisions: Decision[]; todo: Task[]; done: Task[] };

const updated = (t: Task) => Date.parse(t.updatedAt) || 0;
const newest = (a: Task, b: Task) => updated(b) - updated(a);

/** The room's work for the pane's list: what moves now first, then what waits on a vote, then the queue, then what just finished. */
export function workList(tasks: Task[], decisions: Decision[], now: number): WorkList {
  return {
    doing: tasks.filter(t => t.status === 'doing').sort(newest),
    decisions: decisions.filter(d => d.state === 'open')
      .sort((a, b) => (a.closesAt ?? Infinity) - (b.closesAt ?? Infinity) || b.createdAt - a.createdAt),
    todo: tasks.filter(t => t.status === 'todo').sort(newest),
    done: tasks.filter(t => t.status === 'done' && now - updated(t) <= RECENT_DONE_MS).sort(newest),
  };
}

export const workCount = (list: WorkList) => list.doing.length + list.decisions.length + list.todo.length + list.done.length;

/** The selected work as the room holds it now, or undefined once it is gone (a removed task, a decision not held). */
export function resolveWork(ref: WorkRef | undefined, tasks: Task[], decisions: Decision[]) {
  if (!ref) return undefined;
  if (ref.kind === 'task') { const task = tasks.find(t => t.id === ref.id); return task && { kind: 'task' as const, task }; }
  const decision = decisions.find(d => d.key === ref.key);
  return decision && { kind: 'decision' as const, decision };
}

/** One task's changes, oldest first. */
export const taskHistory = (events: TaskEvent[], taskId: string) => events.filter(e => e.taskId === taskId);

/** The title "Turn into a task" gives a decided decision's task, or undefined while it has no single winner. */
function outcomeTitle(decision: Decision) {
  if (decision.state !== 'closed' || !decision.verified || decision.tally.result !== 'decided') return undefined;
  const chosen = decision.options.find(o => o.id === decision.tally.optionIds[0])?.label;
  return chosen === undefined ? undefined : decisionTaskTitle(decision.question, chosen, 120);
}
/**
 * Decided decisions that give this title, oldest first. They pair up with the tasks of that title in the order both
 * were made (the board lists tasks oldest first), so two alike decisions never both claim one task.
 */
const alike = (title: string, decisions: Decision[]) =>
  decisions.filter(d => outcomeTitle(d) === title).sort((a, b) => a.createdAt - b.createdAt || (a.key < b.key ? -1 : 1));
/** The task made from this decision with "Turn into a task", if the board still holds it under that title. */
export function taskFromDecision(decision: Decision, tasks: Task[], decisions: Decision[]) {
  const title = outcomeTitle(decision);
  if (title === undefined) return undefined;
  const at = alike(title, decisions).findIndex(d => d.key === decision.key);
  return at < 0 ? undefined : tasks.filter(t => t.title === title)[at];
}
/** The decision a task was made from, by the same rule. */
export function decisionOfTask(task: Task, decisions: Decision[], tasks: Task[]) {
  const at = tasks.filter(t => t.title === task.title).findIndex(t => t.id === task.id);
  return at < 0 ? undefined : alike(task.title, decisions)[at];
}

/** "just now", "5 min ago", "3 h ago", "yesterday", then a date. */
export function ago(at: number, now: number) {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  if (minutes < 48 * 60) return 'yesterday';
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
