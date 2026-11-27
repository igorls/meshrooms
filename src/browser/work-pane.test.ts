import { describe, expect, test } from 'bun:test';
import type { Task } from '../collab';
import type { TaskEvent } from './board';
import type { Decision } from './decisions';
import { RECENT_DONE_MS, ago, decisionOfTask, resolveWork, taskFromDecision, taskHistory, workCount, workList } from './work-pane';

const NOW = Date.parse('2026-11-27T15:00:00Z');
let serial = 0;
const task = (extra: Partial<Task> = {}): Task => ({
  id: `t${++serial}`, title: `Task ${serial}`, notes: '', status: 'todo', createdBy: 'me', updatedBy: 'me',
  updatedAt: new Date(NOW - 60_000).toISOString(), revision: 1, ...extra,
});
const decision = (extra: Partial<Decision> = {}): Decision => ({
  key: `sam:d${++serial}`, id: `d${serial}`, question: 'Which font?', context: '', mode: 'choice',
  options: [{ id: 'a', label: 'Manrope', addedBy: 'sam' }, { id: 'b', label: 'Inter', addedBy: 'sam' }], askAgents: false,
  closesAt: null, state: 'open', createdBy: 'sam', createdAt: NOW - 1000, updatedAt: NOW - 1000, revision: 1, votes: [],
  tally: { result: 'no-votes', optionIds: [], tally: {}, voters: 0, people: 2 }, settled: false, verified: true, uncounted: 0, ...extra,
});
const decided = (extra: Partial<Decision> = {}) => decision({ state: 'closed', tally: { result: 'decided', optionIds: ['a'], tally: { a: 2 }, voters: 2, people: 2 }, ...extra });

describe('the work list', () => {
  test('in progress, open decisions, to do, then recently finished; newest first within each', () => {
    const older = task({ status: 'doing', updatedAt: new Date(NOW - 3_600_000).toISOString() }), newer = task({ status: 'doing' });
    const queued = task(), done = task({ status: 'done' }), stale = task({ status: 'done', updatedAt: new Date(NOW - RECENT_DONE_MS - 1).toISOString() });
    const list = workList([older, queued, done, stale, newer], [], NOW);
    expect(list.doing).toEqual([newer, older]);
    expect(list.todo).toEqual([queued]);
    expect(list.done).toEqual([done]);
    expect(workCount(list)).toBe(4);
  });

  test('open decisions closing soonest first, then the newest without a deadline; closed ones are left out', () => {
    const later = decision({ closesAt: NOW + 3_600_000 }), sooner = decision({ closesAt: NOW + 60_000 });
    const oldNoClose = decision({ createdAt: NOW - 9000 }), newNoClose = decision({ createdAt: NOW - 10 });
    expect(workList([], [oldNoClose, later, decided(), newNoClose, sooner], NOW).decisions).toEqual([sooner, later, newNoClose, oldNoClose]);
  });
});

describe('the selected work', () => {
  test('resolves to what the room holds now, and to nothing once it is gone', () => {
    const t = task(), d = decision();
    expect(resolveWork({ kind: 'task', id: t.id }, [t], [d])).toEqual({ kind: 'task', task: t });
    expect(resolveWork({ kind: 'decision', key: d.key }, [t], [d])).toEqual({ kind: 'decision', decision: d });
    expect(resolveWork({ kind: 'task', id: 'gone' }, [t], [d])).toBeUndefined();
    expect(resolveWork(undefined, [t], [d])).toBeUndefined();
  });

  test('a task keeps only its own history', () => {
    const events = [{ id: 'e1', taskId: 'a' }, { id: 'e2', taskId: 'b' }, { id: 'e3', taskId: 'a' }] as TaskEvent[];
    expect(taskHistory(events, 'a').map(e => e.id)).toEqual(['e1', 'e3']);
  });
});

describe('a decision and the task made from it', () => {
  test('found both ways by the title "Turn into a task" gives it', () => {
    const d = decided(), made = task({ title: 'Which font → Manrope' }), other = task({ title: 'Which font' });
    const tasks = [other, made], decisions = [decision(), d];
    expect(taskFromDecision(d, tasks, decisions)).toBe(made);
    expect(decisionOfTask(made, decisions, tasks)).toBe(d);
    expect(decisionOfTask(other, decisions, tasks)).toBeUndefined();
  });

  test('alike decisions pair with their tasks in the order both were made, never sharing one', () => {
    const first = decided({ createdAt: NOW - 9000 }), second = decided({ createdAt: NOW - 100 });
    const made = task({ title: 'Which font → Manrope' }), decisions = [second, first];
    expect(taskFromDecision(first, [made], decisions)).toBe(made);
    expect(taskFromDecision(second, [made], decisions)).toBeUndefined();
    expect(decisionOfTask(made, decisions, [made])).toBe(first);
    const again = task({ title: 'Which font → Manrope' });
    expect(taskFromDecision(second, [made, again], decisions)).toBe(again);
    expect(decisionOfTask(again, decisions, [made, again])).toBe(second);
  });

  test('none while the decision is open, a draw, or its result is still being checked', () => {
    const made = task({ title: 'Which font → Manrope' });
    for (const d of [decision(), decided({ verified: false }), decided({ tally: { result: 'draw', optionIds: ['a', 'b'], tally: { a: 1, b: 1 }, voters: 2, people: 2 } })])
      expect(taskFromDecision(d, [made], [d])).toBeUndefined();
  });
});

test('relative times', () => {
  expect(ago(NOW - 10_000, NOW)).toBe('just now');
  expect(ago(NOW - 5 * 60_000, NOW)).toBe('5 min ago');
  expect(ago(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago');
  expect(ago(NOW - 30 * 3_600_000, NOW)).toBe('yesterday');
  expect(ago(NOW + 60_000, NOW)).toBe('just now');
});
