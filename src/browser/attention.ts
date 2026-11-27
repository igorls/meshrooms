/**
 * "Needs you": what in the open room is waiting on this person, from what the room already holds (no protocol).
 * - Messages for them (an @mention of them, or a reply to one of theirs) from the last day that they haven't engaged
 *   with since: no reply from them to it, no reaction from them on it, and nothing they wrote in the room after it.
 * - Open decisions they haven't voted on: until it closes, or for three days when it has no deadline.
 * - Tasks they created or handed out that someone else finished in the last three days.
 * Opening a message or a task from the strip marks it seen on this device, and Clear marks all of it seen (decisions
 * included); voting clears a decision anywhere.
 */
import { mentionedIds, type Task } from '../collab';
import type { Participant } from '../room';
import type { Decision } from './decisions';

export const MESSAGE_WINDOW_MS = 24 * 60 * 60_000;
export const TASK_WINDOW_MS = 3 * 24 * 60 * 60_000;
/** How long an open decision with no deadline asks for a vote. One with a deadline asks until it closes. */
export const DECISION_WINDOW_MS = 3 * 24 * 60 * 60_000;
/** How many seen marks a room keeps: enough for a busy day, small enough for localStorage. */
export const MAX_SEEN = 300;

export type AttentionMessage = { id: string; memberId: string; text: string; at: number; replyTo?: string; retracted?: boolean };
type Viewer = { memberId: string; participants: Pick<Participant, 'id' | 'name' | 'role'>[] };
export type MessagesInput = Viewer & {
  /** In arrival order, as the room stores them; one copy per id (the canonical one). */
  messages: AttentionMessage[];
  reactions: { messageId: string; memberIds: string[] }[];
};
export type ForYou = { id: string; memberId: string; how: 'mention' | 'reply'; at: number };
export type WindowInput = Viewer & { decisions: Decision[]; tasks: Task[]; seen: ReadonlySet<string>; now: number };
export type AttentionInput = MessagesInput & WindowInput;
export type Attention = {
  messages: Omit<ForYou, 'at'>[];
  decisions: Decision[];
  tasks: Task[];
};

/** A done task's finish: who moved it to done, when, and at which revision (the last change, for a task without it). */
export const finishOf = (task: Task) => task.finished ?? { by: task.updatedBy, at: task.updatedAt, revision: task.revision };
/** The mark a task leaves when seen: finishing it again later asks again; editing its notes or link doesn't. */
export const taskMark = (task: Task) => `task:${task.id}@${finishOf(task).revision}`;
export const messageMark = (id: string) => `message:${id}`;
export const decisionMark = (decision: Pick<Decision, 'key'>) => `decision:${decision.key}`;

/**
 * Messages for this person that they haven't engaged with, at any age. It reads the whole conversation, so it doesn't
 * take the clock: callers keep it while only time passes and apply the windows with `attentionAt`.
 */
export function messagesForYou({ memberId, participants, messages, reactions }: MessagesInput): ForYou[] {
  const authorOf = new Map(messages.map(m => [m.id, m.memberId]));
  const repliedTo = new Set<string>();
  let lastOwn = -1;
  messages.forEach((m, i) => { if (m.memberId === memberId) { lastOwn = i; if (m.replyTo) repliedTo.add(m.replyTo); } });
  const reacted = new Set(reactions.filter(r => r.memberIds.includes(memberId)).map(r => r.messageId));
  const forYou: ForYou[] = [];
  for (let i = lastOwn + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.memberId === memberId || m.retracted || repliedTo.has(m.id) || reacted.has(m.id)) continue;
    if (mentionedIds(m.text, participants, { broadcast: false }).includes(memberId)) forYou.push({ id: m.id, memberId: m.memberId, how: 'mention', at: m.at });
    else if (m.replyTo && authorOf.get(m.replyTo) === memberId) forYou.push({ id: m.id, memberId: m.memberId, how: 'reply', at: m.at });
  }
  return forYou;
}

/** What needs this person now: the messages for them, the decisions and the tasks, within their windows and not seen. */
export function attentionAt(forYou: ForYou[], { memberId, participants, decisions, tasks, seen, now }: WindowInput): Attention {
  const messages = forYou.filter(m => now - m.at <= MESSAGE_WINDOW_MS && !seen.has(messageMark(m.id))).map(({ at: _, ...m }) => m);

  const viewer = participants.find(p => p.id === memberId);
  // Only people's votes count, so only a person is asked for one.
  const asked = viewer?.role === 'human'
    ? decisions.filter(d => d.state === 'open' && !d.votes.some(v => v.memberId === memberId && v.optionId)
      && (d.closesAt !== null || now - d.createdAt <= DECISION_WINDOW_MS) && !seen.has(decisionMark(d)))
      .sort((a, b) => (a.closesAt ?? Infinity) - (b.closesAt ?? Infinity) || a.createdAt - b.createdAt)
    : [];

  const review = tasks.filter(t => {
    if (t.status !== 'done' || !(t.createdBy === memberId || t.assignedBy === memberId)) return false;
    const finish = finishOf(t);
    return finish.by !== memberId && now - Date.parse(finish.at) <= TASK_WINDOW_MS && !seen.has(taskMark(t));
  }).sort((a, b) => Date.parse(finishOf(a).at) - Date.parse(finishOf(b).at));

  return { messages, decisions: asked, tasks: review };
}

export function attentionOf(input: AttentionInput): Attention {
  return attentionAt(messagesForYou(input), input);
}

export const attentionCount = (a: Attention) => a.messages.length + a.decisions.length + a.tasks.length;

const seenKey = (roomId: string) => `meshrooms:attention-seen:${roomId}`;
export function loadSeen(roomId: string): Set<string> {
  try {
    const list = JSON.parse(localStorage.getItem(seenKey(roomId)) || '[]');
    return new Set(Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : []);
  } catch { return new Set(); }
}
/** Adds marks, keeping the newest MAX_SEEN, and returns the new set. */
export function markSeen(roomId: string, current: ReadonlySet<string>, marks: string[]): Set<string> {
  const next = [...current.values()].filter(m => !marks.includes(m)).concat(marks).slice(-MAX_SEEN);
  try { localStorage.setItem(seenKey(roomId), JSON.stringify(next)); } catch {}
  return new Set(next);
}
