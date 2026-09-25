import type { Message, Participant } from './room';

/** Who may speak unprompted. Humans-first rooms keep agents listening until a person addresses them. */
export type Floor = 'humans-first' | 'open';
export const FLOORS: Floor[] = ['humans-first', 'open'];
export const DEFAULT_FLOOR: Floor = 'humans-first';

export type TaskStatus = 'todo' | 'doing' | 'done';
export const TASK_STATUSES: TaskStatus[] = ['todo', 'doing', 'done'];
export type Task = {
  id: string;
  title: string;
  notes: string;
  /** A linked GitHub issue or pull request (browser rooms). */
  issue?: string;
  status: TaskStatus;
  assigneeId?: string;
  /** Who set the current assignee, and the board revision at which it happened. */
  assignedBy?: string;
  assignedRevision?: number;
  createdBy: string;
  updatedBy: string;
  updatedAt: string;
  revision: number;
};

/** `@agents` addresses every agent in the room. */
export const AGENTS_MENTION = 'agents';
/** Nobody may be named `agents`: `@agents` must keep addressing every agent. */
export const reservedName = (name: string) => name.trim().toLowerCase() === AGENTS_MENTION;

const boundary = (char: string | undefined) => char === undefined || !/[\p{L}\p{N}_]/u.test(char);

/**
 * Participants addressed by `@Name` in text, matched case-insensitively against the room roster.
 * Longer names win, so `@Codex CLI` does not also count as `@Codex` when both exist.
 */
export function mentionedIds(text: string, participants: Pick<Participant, 'id' | 'name' | 'role'>[]): string[] {
  if (!text.includes('@')) return [];
  const lower = text.toLowerCase(); const taken = new Array<boolean>(text.length).fill(false); const found = new Set<string>();
  // `@agents` comes first so the stable sort keeps it ahead of any participant with an equally long name.
  const names = [{ key: AGENTS_MENTION, ids: participants.filter(p => p.role === 'agent').map(p => p.id) },
    ...participants.map(p => ({ key: p.name.toLowerCase(), ids: [p.id] }))].sort((a, b) => b.key.length - a.key.length);
  for (const { key, ids } of names) {
    let from = 0;
    while ((from = lower.indexOf(`@${key}`, from)) >= 0) {
      const end = from + key.length + 1;
      if (boundary(text[from - 1]) && boundary(text[end]) && !taken[from]) {
        for (let i = from; i < end; i++) taken[i] = true;
        ids.forEach(id => found.add(id));
      }
      from = end;
    }
  }
  return participants.map(p => p.id).filter(id => found.has(id));
}

/** Split text into plain and mention segments for display. */
export function mentionSegments(text: string, participants: Pick<Participant, 'id' | 'name' | 'role'>[]): { text: string; mention?: boolean }[] {
  if (!text.includes('@')) return [{ text }];
  const keys = [...new Set([...participants.map(p => p.name.toLowerCase()), AGENTS_MENTION])].sort((a, b) => b.length - a.length);
  const lower = text.toLowerCase(); const segments: { text: string; mention?: boolean }[] = []; let plain = 0; let i = 0;
  while ((i = lower.indexOf('@', i)) >= 0) {
    const key = boundary(text[i - 1]) ? keys.find(k => lower.startsWith(k, i + 1) && boundary(text[i + 1 + k.length])) : undefined;
    if (!key) { i++; continue; }
    if (i > plain) segments.push({ text: text.slice(plain, i) });
    segments.push({ text: text.slice(i, i + key.length + 1), mention: true });
    plain = i = i + key.length + 1;
  }
  if (plain < text.length) segments.push({ text: text.slice(plain) });
  return segments;
}

/** `agentAssignmentsWake`: a host setting in browser rooms that lets an agent's assignment wake another agent. */
type RoomView = { floor?: Floor; messages: Message[]; participants: Pick<Participant, 'id' | 'role' | 'operatorId' | 'wake'>[]; tasks?: Task[]; agentAssignmentsWake?: boolean };

/** A message addresses a participant by mentioning them or by replying to one of their messages. */
export function addresses(message: Message, participantId: string, messages: Message[]): boolean {
  if (message.authorId === participantId) return false;
  if (message.mentions?.includes(participantId)) return true;
  return !!message.replyTo && messages.find(m => m.id === message.replyTo)?.authorId === participantId;
}

const roleOf = (room: RoomView, id: string | undefined) => room.participants.find(p => p.id === id)?.role;
/** An agent set to operator-only wakes solely for its operator; otherwise any person may wake it. */
function mayWake(room: RoomView, agentId: string, authorId: string | undefined): boolean {
  const agent = room.participants.find(p => p.id === agentId);
  return agent?.wake !== 'operator' || (!!agent.operatorId && agent.operatorId === authorId);
}

/** Whether a message should wake an agent under the room's floor policy. Agents never wake themselves. */
export function wakes(room: RoomView, message: Message, agentId: string): boolean {
  if (message.authorId === agentId || !mayWake(room, agentId, message.authorId)) return false;
  if ((room.floor ?? DEFAULT_FLOOR) === 'open' && message.role === 'human') return true;
  if ((room.floor ?? DEFAULT_FLOOR) === 'humans-first' && message.role !== 'human') return false;
  return addresses(message, agentId, room.messages);
}

/**
 * Whether an assignment should wake its agent: from a person in humans-first rooms (or from another agent when the room
 * allows agents to hand work to each other), from anyone else in open rooms.
 */
export function assignmentWakes(room: RoomView, task: Task, agentId: string): boolean {
  if (task.assigneeId !== agentId || task.status === 'done' || !task.assignedBy || task.assignedBy === agentId || !mayWake(room, agentId, task.assignedBy)) return false;
  const assigner = roleOf(room, task.assignedBy);
  return (room.floor ?? DEFAULT_FLOOR) === 'open' || assigner === 'human' || (!!room.agentAssignmentsWake && assigner === 'agent');
}

/**
 * An agent may speak when replying to a message that woke it, or while holding open work a person assigned. An open
 * floor lets agents speak freely, except one set to operator-only: it still speaks only on its operator's behalf.
 */
export function mayAgentSpeak(room: RoomView, agentId: string, replyTo: string | undefined): boolean {
  const operatorOnly = room.participants.find(p => p.id === agentId)?.wake === 'operator';
  if ((room.floor ?? DEFAULT_FLOOR) === 'open' && !operatorOnly) return true;
  const target = replyTo ? room.messages.find(m => m.id === replyTo) : undefined;
  if (target && wakes(room, target, agentId)) return true;
  return (room.tasks || []).some(task => assignmentWakes(room, task, agentId));
}

export type WakeResult = {
  /** `history`: first read without a cursor. `addressed`: something needs this agent. `waiting`: only observed messages. */
  state: 'history' | 'addressed' | 'waiting';
  /** Every message after the cursor, including observed ones, so the agent has the conversation it was listening to. */
  messages: Message[];
  addressed: string[];
  tasks: Task[];
  cursor?: string;
  boardCursor?: number;
};

/**
 * Evaluate one snapshot for an agent. The message cursor only advances when the agent is woken,
 * so unaddressed messages accumulate as context rather than being consumed silently.
 */
export function evaluateWake(room: RoomView & { boardRevision?: number }, agentId: string, after: string | undefined, boardAfter: number | undefined): WakeResult {
  const index = after ? room.messages.findIndex(m => m.id === after) : -1;
  if (after && index < 0) throw new Error('The supplied cursor is not in this room. Read the room to establish a cursor.');
  const unseen = room.messages.slice(index + 1);
  const addressed = unseen.filter(m => wakes(room, m, agentId)).map(m => m.id);
  const tasks = boardAfter === undefined ? [] : (room.tasks || []).filter(t => (t.assignedRevision ?? 0) > boardAfter && assignmentWakes(room, t, agentId));
  const boardCursor = room.boardRevision ?? boardAfter;
  if (!after && unseen.length) return { state: 'history', messages: unseen, addressed, tasks, cursor: unseen.at(-1)!.id, boardCursor };
  if (addressed.length || tasks.length) return { state: 'addressed', messages: unseen, addressed, tasks, cursor: unseen.at(-1)?.id ?? after, boardCursor };
  return { state: 'waiting', messages: unseen, addressed: [], tasks: [], cursor: after, boardCursor: boardAfter };
}

/** Board filters: everyone's tasks, the viewer's, nobody's, or one member's (`member:<id>`). */
export type TaskFilter = 'all' | 'mine' | 'unassigned' | `member:${string}`;
export function matchesTaskFilter(task: Task, filter: TaskFilter, viewerId?: string): boolean {
  if (filter === 'all') return true;
  if (filter === 'mine') return !!viewerId && task.assigneeId === viewerId;
  if (filter === 'unassigned') return !task.assigneeId;
  return task.assigneeId === filter.slice('member:'.length);
}
/** Tasks by status in board order, except finished work: newest first, since boards show only the latest of it. */
export function groupTasks(tasks: Task[], filter: TaskFilter = 'all', viewerId?: string): Record<TaskStatus, Task[]> {
  const groups: Record<TaskStatus, Task[]> = { todo: [], doing: [], done: [] };
  for (const task of tasks) if (matchesTaskFilter(task, filter, viewerId)) groups[task.status].push(task);
  groups.done.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return groups;
}
