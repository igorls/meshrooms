import { beforeEach, describe, expect, test } from 'bun:test';
import type { Task } from '../collab';
import { DECISION_WINDOW_MS, MAX_SEEN, MESSAGE_WINDOW_MS, TASK_WINDOW_MS, attentionAt, attentionOf, decisionMark, loadSeen, markSeen, messageMark, messagesForYou, taskMark, type AttentionInput, type AttentionMessage } from './attention';
import type { Decision } from './decisions';

class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, String(value)); }
  removeItem(key: string) { this.items.delete(key); }
  clear() { this.items.clear(); }
}
const memory = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memory });
beforeEach(() => memory.clear());

const NOW = Date.parse('2026-11-27T15:00:00Z');
const participants = [
  { id: 'me', name: 'Alex', role: 'human' as const },
  { id: 'sam', name: 'Sam', role: 'human' as const },
  { id: 'bot', name: 'Helper', role: 'agent' as const },
];
let serial = 0;
const msg = (memberId: string, text: string, extra: Partial<AttentionMessage> = {}): AttentionMessage =>
  ({ id: `m${++serial}`, memberId, text, at: NOW - 60_000, ...extra });
const decision = (extra: Partial<Decision> = {}): Decision => ({
  key: `sam:d${++serial}`, id: `d${serial}`, question: 'Which font?', context: '', mode: 'choose', options: [], askAgents: false,
  closesAt: null, state: 'open', createdBy: 'sam', createdAt: NOW - 1000, updatedAt: NOW - 1000, revision: 1, votes: [],
  tally: { result: 'none', optionIds: [], tally: {}, voters: 0, people: 2 }, settled: false, ...extra,
} as unknown as Decision);
const task = (extra: Partial<Task> = {}): Task => ({
  id: `t${++serial}`, title: 'Fix the side panel', notes: '', status: 'done', assigneeId: 'bot', assignedBy: 'me', createdBy: 'me',
  updatedBy: 'bot', updatedAt: new Date(NOW - 60_000).toISOString(), revision: 3, ...extra,
});
const input = (extra: Partial<AttentionInput>): AttentionInput =>
  ({ memberId: 'me', participants, messages: [], reactions: [], decisions: [], tasks: [], seen: new Set(), now: NOW, ...extra });

describe('messages for you', () => {
  test('an @mention or a reply to your message, from a person or an agent', () => {
    const mine = msg('me', 'shipping today');
    const mention = msg('bot', '@Alex can you approve the font?'), reply = msg('sam', 'nice', { replyTo: mine.id });
    const a = attentionOf(input({ messages: [mine, mention, reply] }));
    expect(a.messages).toEqual([{ id: mention.id, memberId: 'bot', how: 'mention' }, { id: reply.id, memberId: 'sam', how: 'reply' }]);
  });

  test('not your own, not @agents, not messages that name someone else', () => {
    const a = attentionOf(input({ messages: [msg('me', '@Alex note to self'), msg('sam', '@agents status?'), msg('sam', '@Helper go')] }));
    expect(a.messages).toEqual([]);
  });

  test('anything you wrote after it means you have been here since', () => {
    const before = msg('sam', '@Alex question'), after = msg('sam', '@Alex another one');
    const a = attentionOf(input({ messages: [before, msg('me', 'back now'), after] }));
    expect(a.messages.map(m => m.id)).toEqual([after.id]);
  });

  test('your reply to it or your reaction on it clears it, wherever you wrote', () => {
    const asked = msg('sam', '@Alex one'), reacted = msg('sam', '@Alex two'), open = msg('sam', '@Alex three');
    const a = attentionOf(input({
      messages: [asked, reacted, open],
      reactions: [{ messageId: reacted.id, memberIds: ['me'] }],
    }));
    expect(a.messages.map(m => m.id)).toEqual([asked.id, open.id]);
    // A reply sent later sits after every message, so it also counts as "since": the earlier ones clear too.
    expect(attentionOf(input({ messages: [asked, open, msg('me', 'yes', { replyTo: asked.id })] })).messages).toEqual([]);
  });

  test('seen on this device, deleted, or older than a day: not asked again', () => {
    const seen = msg('sam', '@Alex seen'), gone = msg('sam', '@Alex gone', { retracted: true }), old = msg('sam', '@Alex old', { at: NOW - MESSAGE_WINDOW_MS - 1 });
    expect(attentionOf(input({ messages: [seen, gone, old], seen: new Set([messageMark(seen.id)]) })).messages).toEqual([]);
  });
});

describe('decisions', () => {
  test('open ones you have not voted on, soonest to close first', () => {
    const later = decision({ closesAt: NOW + 3_600_000 }), sooner = decision({ closesAt: NOW + 600_000 }), noClose = decision();
    const voted = decision({ votes: [{ op: 'o', memberId: 'me', optionId: 'a', comment: '', at: NOW, counts: true }] });
    const cleared = decision({ votes: [{ op: 'o', memberId: 'me', optionId: null, comment: '', at: NOW, counts: true }] });
    const closed = decision({ state: 'closed' });
    const a = attentionOf(input({ decisions: [later, voted, noClose, closed, cleared, sooner] }));
    expect(a.decisions.map(d => d.key)).toEqual([sooner.key, later.key, noClose.key, cleared.key]);
  });

  test('no deadline: asked for three days; a deadline: asked until it closes', () => {
    const stale = decision({ createdAt: NOW - DECISION_WINDOW_MS - 1 }), timed = decision({ createdAt: NOW - DECISION_WINDOW_MS - 1, closesAt: NOW + 60_000 });
    expect(attentionOf(input({ decisions: [stale, timed] })).decisions).toEqual([timed]);
  });

  test('cleared on this device: not asked again', () => {
    const d = decision(), other = decision();
    expect(attentionOf(input({ decisions: [d, other], seen: new Set([decisionMark(d)]) })).decisions).toEqual([other]);
  });

  test('an agent is never asked: its vote is only advice', () => {
    expect(attentionOf(input({ memberId: 'bot', decisions: [decision()] })).decisions).toEqual([]);
  });
});

describe('tasks to review', () => {
  test('finished by someone else, created or handed out by you, in the last three days', () => {
    const assigned = task({ createdBy: 'sam', assignedBy: 'me' }), created = task({ assignedBy: 'sam' });
    const doneByMe = task({ updatedBy: 'me' }), notMine = task({ createdBy: 'sam', assignedBy: 'sam' }), doing = task({ status: 'doing' });
    const old = task({ updatedAt: new Date(NOW - TASK_WINDOW_MS - 1).toISOString() });
    expect(attentionOf(input({ tasks: [assigned, created, doneByMe, notMine, doing, old] })).tasks.map(t => t.id)).toEqual([assigned.id, created.id]);
  });

  test('seen at one revision; finished again later, it asks again', () => {
    const t = task();
    expect(attentionOf(input({ tasks: [t], seen: new Set([taskMark(t)]) })).tasks).toEqual([]);
    expect(attentionOf(input({ tasks: [{ ...t, revision: 5 }], seen: new Set([taskMark(t)]) })).tasks.map(x => x.id)).toEqual([t.id]);
  });

  test('edits after the finish (notes, a link) neither bring it back nor change who finished it', () => {
    const finished = { by: 'bot', at: new Date(NOW - 60_000).toISOString(), revision: 3 };
    const t = task({ finished }), edited = { ...t, revision: 4, updatedBy: 'sam' };
    expect(attentionOf(input({ tasks: [edited] })).tasks).toEqual([edited]);
    expect(attentionOf(input({ tasks: [edited], seen: new Set([taskMark(t)]) })).tasks).toEqual([]);
    const again = { ...edited, revision: 7, finished: { ...finished, revision: 7 } };
    expect(attentionOf(input({ tasks: [again], seen: new Set([taskMark(t)]) })).tasks).toEqual([again]);
    // Finished by me, then edited by someone else: still mine to have seen.
    expect(attentionOf(input({ tasks: [{ ...edited, finished: { ...finished, by: 'me' } }] })).tasks).toEqual([]);
    // The three days run from the finish, not from the last edit.
    const old = { ...edited, updatedAt: new Date(NOW).toISOString(), finished: { ...finished, at: new Date(NOW - TASK_WINDOW_MS - 1).toISOString() } };
    expect(attentionOf(input({ tasks: [old] })).tasks).toEqual([]);
  });
});

describe('the conversation is read without the clock', () => {
  test('messagesForYou keeps every age; the day window applies at attentionAt', () => {
    const fresh = msg('sam', '@Alex hi'), old = msg('sam', '@Alex earlier', { at: NOW - MESSAGE_WINDOW_MS - 1 });
    const forYou = messagesForYou({ memberId: 'me', participants, messages: [old, fresh], reactions: [] });
    expect(forYou.map(m => m.id)).toEqual([old.id, fresh.id]);
    const at = (now: number) => attentionAt(forYou, { memberId: 'me', participants, decisions: [], tasks: [], seen: new Set(), now }).messages.map(m => m.id);
    expect(at(NOW)).toEqual([fresh.id]);
    expect(at(NOW + MESSAGE_WINDOW_MS)).toEqual([]);
  });
});

describe('seen marks', () => {
  test('kept per room, newest last, capped', () => {
    let seen = loadSeen('room-a');
    seen = markSeen('room-a', seen, ['message:1', 'task:t@1']);
    seen = markSeen('room-a', seen, ['message:1']);
    expect([...loadSeen('room-a')]).toEqual(['task:t@1', 'message:1']);
    expect(loadSeen('room-b').size).toBe(0);
    markSeen('room-a', seen, Array.from({ length: MAX_SEEN + 5 }, (_, i) => `message:x${i}`));
    expect(loadSeen('room-a').size).toBe(MAX_SEEN);
  });

  test('unreadable storage reads as nothing seen', () => {
    memory.setItem('meshrooms:attention-seen:room-c', '{not json');
    expect(loadSeen('room-c').size).toBe(0);
  });
});
