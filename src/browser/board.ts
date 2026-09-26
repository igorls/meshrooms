import { TASK_STATUSES, type Task, type TaskStatus } from '../collab';
import { validRepository } from './protocol';

/**
 * Browser-room task board. The room service never sees tasks: each change is a signed operation carrying the task's
 * whole state at one revision, sent between devices like a message. Every device folds the same operations the same
 * way, so boards converge; peers exchange their operations when they connect so later arrivals see current tasks.
 */
export type TaskBody = {
  kind: 'task'; roomId: string; id: string; deviceId: string; memberId: string; at: number;
  taskId: string; revision: number; title: string; notes: string; status: TaskStatus; assigneeId: string | null; removed?: true;
  /** A linked GitHub issue or pull request; absent when none. */
  issue?: string;
};
export type TaskPacket = { body: TaskBody; signature: string };
/** Unsigned envelope for exchanging a board; every operation inside is verified against its own author's device. */
export type BoardSync = { kind: 'board'; roomId: string; ops: TaskPacket[] };
export type TaskChange = { title?: string; notes?: string; status?: TaskStatus; assigneeId?: string | null; issue?: string | null };

/** A GitHub issue or pull request link, the only kind of link a task carries. */
export const validIssueLink = (v: unknown): v is string => {
  const parts = typeof v === 'string' && v.length <= 200 && /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/\d{1,9}$/.exec(v);
  return !!parts && validRepository(parts[1]);
};
const onGitHub = (url: URL) => url.protocol === 'https:' && ['github.com', 'www.github.com'].includes(url.hostname.toLowerCase());
/**
 * The link a task keeps for a pasted issue or pull request: a GitHub link (its comment anchor, query or tab such as
 * /files dropped) or `owner/name#42`, which GitHub forwards to the pull request when 42 is one.
 */
export function issueLinkFrom(text: string): string | undefined {
  const value = text.trim(), short = /^([^\s/#]+\/[^\s/#]+)#(\d{1,9})$/.exec(value);
  if (short) return validRepository(short[1]) ? `https://github.com/${short[1]}/issues/${short[2]}` : undefined;
  let url: URL; try { url = new URL(value); } catch { return undefined; }
  if (!onGitHub(url)) return undefined;
  const [owner, name, kind, number] = url.pathname.split('/').filter(Boolean), link = `https://github.com/${owner}/${name}/${kind}/${number}`;
  return validIssueLink(link) ? link : undefined;
}
/** `owner/name` from a typed name or any GitHub link inside the repository. */
export function repositoryFrom(text: string): string | undefined {
  const value = text.trim().replace(/\.git$/, '');
  if (validRepository(value)) return value;
  let url: URL; try { url = new URL(value); } catch { return undefined; }
  if (!onGitHub(url)) return undefined;
  const [owner, name = ''] = url.pathname.split('/').filter(Boolean), repository = `${owner}/${name.replace(/\.git$/, '')}`;
  return validRepository(repository) ? repository : undefined;
}
/** GitHub repositories people linked in the conversation, most recently mentioned first. */
export function mentionedRepositories(texts: string[], limit = 5): string[] {
  const found: string[] = [];
  for (const text of [...texts].reverse()) {
    for (const [link] of text.matchAll(/https:\/\/(?:www\.)?github\.com\/[^\s)>\]"'`]+/gi)) {
      const repository = repositoryFrom(link.replace(/[.,;:!?]+$/, ''));
      if (repository && !found.some(r => r.toLowerCase() === repository.toLowerCase())) found.push(repository);
      if (found.length >= limit) return found;
    }
  }
  return found;
}
/** `owner/name#42` for a linked issue or pull request. */
export function issueLabel(link: string) {
  const [, owner, name, , number] = new URL(link).pathname.split('/');
  return `${owner}/${name}#${number}`;
}
/** GitHub's own new-issue page, prefilled; the person submits it with their own account, so Meshrooms holds no token. */
export function newIssueUrl(repository: string, title: string, body: string) {
  if (!validRepository(repository)) throw new Error('Link a repository as owner/name first.');
  const query = new URLSearchParams({ title, body });
  return `https://github.com/${repository}/issues/new?${query}`;
}

export const MAX_TASK_OPS = 2000;
/** Devices compact their board past this many operations, keeping it well under MAX_TASK_OPS. */
export const COMPACT_AT = 1000;
/** Data channel messages over 20,000 characters are dropped, so exchanged boards are split well below that. */
export const SYNC_CHUNK_CHARS = 15_000;
const id = (value: unknown) => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);

export function validTaskBody(b: any, roomId: string): b is TaskBody {
  return !!b && b.kind === 'task' && b.roomId === roomId && id(b.id) && id(b.taskId) && id(b.memberId)
    && typeof b.deviceId === 'string' && /^[a-f0-9]{64}$/.test(b.deviceId)
    && Number.isSafeInteger(b.at) && b.at > 0 && Number.isSafeInteger(b.revision) && b.revision >= 1 && b.revision <= 1_000_000
    && typeof b.title === 'string' && !!b.title.trim() && b.title.length <= 120 && typeof b.notes === 'string' && b.notes.length <= 2000
    && TASK_STATUSES.includes(b.status) && (b.assigneeId === null || id(b.assigneeId)) && (b.removed === undefined || b.removed === true)
    && (b.issue === undefined || validIssueLink(b.issue));
}

/**
 * Operations of one task in the order every device applies them: revision, then operation id. Device clocks never
 * decide a conflict, so a skewed clock cannot win; `at` is shown to people only.
 */
function compare(a: TaskBody, b: TaskBody) { return a.revision - b.revision || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }

/**
 * The operations that decide a task, in order: at each revision only its winner counts, so a losing concurrent edit
 * cannot change who is credited with the assignment.
 */
function chain(list: TaskBody[]) {
  const sorted = [...list].sort(compare);
  return sorted.filter((op, i) => sorted[i + 1]?.revision !== op.revision);
}
/** Where the current assignee was set: the chain position after the last operation with a different assignee. */
function assignmentIndex(steps: TaskBody[]) {
  const final = steps.at(-1)!.assigneeId;
  let index = steps.length - 1;
  while (index > 0 && steps[index - 1].assigneeId === final) index--;
  return index;
}
function group(ops: TaskBody[]) {
  const byTask = new Map<string, TaskBody[]>();
  for (const op of ops) byTask.set(op.taskId, [...(byTask.get(op.taskId) || []), op]);
  return byTask;
}

/**
 * The current board. The last operation of each task wins, but a removal always wins: once anyone removes a task,
 * a concurrent or later edit made without seeing the removal does not bring it back. Oldest tasks first.
 */
export function foldBoard(ops: TaskBody[]): Task[] {
  const tasks: (Task & { createdAt: number })[] = [];
  for (const [taskId, list] of group(ops)) {
    if (list.some(op => op.removed)) continue;
    const steps = chain(list), last = steps.at(-1)!, assigned = steps[assignmentIndex(steps)];
    tasks.push({ id: taskId, title: last.title, notes: last.notes, status: last.status, ...(last.issue ? { issue: last.issue } : {}),
      ...(last.assigneeId ? { assigneeId: last.assigneeId, assignedBy: assigned.memberId, assignedRevision: assigned.revision } : {}),
      createdBy: steps[0].memberId, updatedBy: last.memberId, updatedAt: new Date(last.at).toISOString(), revision: last.revision, createdAt: steps[0].at });
  }
  return tasks.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)).map(({ createdAt: _, ...task }) => task);
}

/** Late edits trail a task by a few revisions; this many recent steps per task keep deciding them after compaction. */
const KEPT_TAIL = 32;

/**
 * One line of task history for the conversation, as of `at`. A field is set only when it changed; a null assignee
 * means unassigned. `updated` stands for a change whose previous state is no longer known.
 */
export type TaskEvent = {
  id: string; taskId: string; memberId: string; at: number; title: string;
  created?: true; removed?: true; updated?: true; renamedFrom?: string; status?: TaskStatus; assigneeId?: string | null; notes?: true;
  /** The issue the change linked, or null when it unlinked one. */
  issue?: string | null;
};
/** Consecutive changes by one person to one task within this window read as one line. */
export const TASK_EVENT_WINDOW = 120_000;

/**
 * Task history, one line per change that decided the board: each winning operation compared with the one before it.
 * A run of quick changes by the same person becomes one line describing the net change. Compaction drops operations,
 * so a change whose predecessor is gone is reported only as an update, and its intermediate steps not at all.
 */
export function taskTimeline(ops: TaskBody[]): TaskEvent[] {
  const events: TaskEvent[] = [];
  for (const list of group(ops).values()) {
    const sorted = [...list].sort(compare), removal = sorted.find(op => op.removed);
    const steps = chain(sorted.filter(op => !op.removed && (!removal || compare(op, removal) < 0)));
    const lines: TaskEvent[] = [];
    let start = 0;
    steps.forEach((last, i) => {
      const next = steps[i + 1];
      if (next && next.memberId === last.memberId && next.revision === last.revision + 1 && next.at - last.at <= TASK_EVENT_WINDOW) return;
      const first = steps[start], before = steps[start - 1]; start = i + 1;
      const line: TaskEvent = { id: last.id, taskId: last.taskId, memberId: last.memberId, at: last.at, title: last.title };
      if (!before) Object.assign(line, first.revision === 1 ? { created: true } : { updated: true }, first.revision === 1 && last.status !== 'todo' ? { status: last.status } : {}, first.revision === 1 && last.assigneeId ? { assigneeId: last.assigneeId } : {},
        first.revision === 1 && last.issue ? { issue: last.issue } : {});
      else if (before.revision + 1 !== first.revision) line.updated = true;
      else {
        if (before.title !== last.title) line.renamedFrom = before.title;
        if (before.status !== last.status) line.status = last.status;
        if (before.assigneeId !== last.assigneeId) line.assigneeId = last.assigneeId;
        if (before.notes !== last.notes) line.notes = true;
        if ((before.issue ?? null) !== (last.issue ?? null)) line.issue = last.issue ?? null;
        if (Object.keys(line).length === 5) return; // Changed and changed back.
      }
      lines.push(line);
    });
    if (removal) {
      const previous = lines.at(-1);
      if (previous?.memberId === removal.memberId && removal.at - previous.at <= TASK_EVENT_WINDOW) lines.pop();
      lines.push({ id: removal.id, taskId: removal.taskId, memberId: removal.memberId, at: removal.at, title: removal.title, removed: true });
    }
    events.push(...lines);
  }
  return events.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

/**
 * Drops operations no longer needed to fold the same board, so a busy room stays under MAX_TASK_OPS. Per task it keeps
 * the first chain step, the steps around the assignment and the last KEPT_TAIL steps; a removed task keeps one removal.
 * Operations are only dropped, never rewritten, so every signature still verifies. A late edit at a kept revision wins or
 * loses exactly as it would against the full history, so task content always converges; assignment credit converges
 * too unless an edit arrives more than KEPT_TAIL revisions late. Callers compact only when the board grows large.
 */
export function compactBoard<T extends { body: TaskBody }>(packets: T[]): T[] {
  const keep = new Set<string>();
  for (const list of group(packets.map(p => p.body)).values()) {
    const removal = [...list].sort(compare).find(op => op.removed);
    if (removal) { keep.add(removal.id); continue; }
    const steps = chain(list), at = assignmentIndex(steps);
    for (const index of [0, at - 1, at]) if (index >= 0) keep.add(steps[index].id);
    for (let index = Math.max(at, steps.length - KEPT_TAIL); index < steps.length; index++) keep.add(steps[index].id);
  }
  return packets.filter(p => keep.has(p.body.id));
}

/** The unsigned body for creating (no current task) or changing a task; the caller signs and sends it. */
export function taskBody(input: { roomId: string; deviceId: string; memberId: string; current?: Task; taskId?: string; change: TaskChange; removed?: boolean }): TaskBody {
  const { current, change } = input;
  const title = (change.title ?? current?.title ?? '').trim(), notes = (change.notes ?? current?.notes ?? '').trim();
  if (!title || title.length > 120) throw new Error('Give the task a title of up to 120 characters.');
  if (notes.length > 2000) throw new Error('Keep task notes to 2,000 characters.');
  const issue = change.issue !== undefined ? change.issue : current?.issue ?? null;
  if (issue !== null && !validIssueLink(issue)) throw new Error('Link a GitHub issue or pull request, like https://github.com/owner/name/issues/42.');
  return { kind: 'task', roomId: input.roomId, id: crypto.randomUUID(), deviceId: input.deviceId, memberId: input.memberId, at: Date.now(),
    taskId: current?.id ?? input.taskId ?? crypto.randomUUID(), revision: (current?.revision ?? 0) + 1, title, notes,
    status: change.status ?? current?.status ?? 'todo', assigneeId: change.assigneeId !== undefined ? change.assigneeId : current?.assigneeId ?? null,
    ...(issue ? { issue } : {}), ...(input.removed ? { removed: true as const } : {}) };
}

/** Split a board into sync envelopes that stay under the data channel limit. */
export function syncChunks(roomId: string, ops: TaskPacket[]): BoardSync[] {
  const chunks: BoardSync[] = []; let current: TaskPacket[] = [], size = 0;
  for (const op of ops) {
    const length = JSON.stringify(op).length;
    if (current.length && size + length > SYNC_CHUNK_CHARS) { chunks.push({ kind: 'board', roomId, ops: current }); current = []; size = 0; }
    current.push(op); size += length;
  }
  if (current.length) chunks.push({ kind: 'board', roomId, ops: current });
  return chunks;
}
