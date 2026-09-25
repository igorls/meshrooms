import { expect, test } from 'bun:test';
import { compactBoard, foldBoard, issueLabel, issueLinkFrom, mentionedRepositories, newIssueUrl, repositoryFrom, syncChunks, taskBody, taskTimeline, validIssueLink, validTaskBody, type TaskBody } from '../../src/browser/board';

const roomId = crypto.randomUUID(), alex = crypto.randomUUID(), sam = crypto.randomUUID(), codex = crypto.randomUUID();
const device = 'a'.repeat(64);
const op = (memberId: string, change: Parameters<typeof taskBody>[0]['change'], current?: ReturnType<typeof foldBoard>[number], extra: Partial<TaskBody> = {}) =>
  ({ ...taskBody({ roomId, deviceId: device, memberId, current, change }), ...extra });

test('the last revision of each task wins, and every device folds concurrent edits the same way', () => {
  const create = op(alex, { title: 'Fix header', assigneeId: codex });
  const [task] = foldBoard([create]);
  expect(task).toMatchObject({ title: 'Fix header', status: 'todo', assigneeId: codex, assignedBy: alex, assignedRevision: 1, createdBy: alex, revision: 1 });
  // Two people edit revision 1 at once: both produce revision 2; time, then operation id, picks the same winner everywhere.
  const a = op(alex, { status: 'doing' }, task, { at: 2000, id: '00000000-0000-4000-8000-000000000001' });
  const b = op(sam, { notes: 'use flex' }, task, { at: 2000, id: '00000000-0000-4000-8000-000000000002' });
  const one = foldBoard([create, a, b]), other = foldBoard([b, create, a]);
  expect(one).toEqual(other);
  expect(one[0]).toMatchObject({ revision: 2, notes: 'use flex', status: 'todo', updatedBy: sam });
  const next = op(sam, { status: 'done', assigneeId: null }, one[0]);
  expect(foldBoard([create, a, b, next])[0]).toMatchObject({ revision: 3, status: 'done', notes: 'use flex' });
  expect(foldBoard([create, a, b, next])[0].assigneeId).toBeUndefined();
});

test('a removed task disappears for everyone, and boards keep creation order', () => {
  const first = op(alex, { title: 'First' }, undefined, { at: 1000 }), second = op(sam, { title: 'Second' }, undefined, { at: 2000 });
  expect(foldBoard([second, first]).map(t => t.title)).toEqual(['First', 'Second']);
  const removed = { ...taskBody({ roomId, deviceId: device, memberId: sam, current: foldBoard([first])[0], change: {}, removed: true }) };
  expect(foldBoard([first, second, removed]).map(t => t.title)).toEqual(['Second']);
});

test('operations are validated, and board exchange stays under the data channel limit', () => {
  const good = op(alex, { title: 'Valid', notes: 'n'.repeat(2000) });
  expect(validTaskBody(good, roomId)).toBe(true);
  expect(validTaskBody({ ...good, roomId: crypto.randomUUID() }, roomId)).toBe(false);
  expect(validTaskBody({ ...good, status: 'blocked' }, roomId)).toBe(false);
  expect(validTaskBody({ ...good, title: ' ' }, roomId)).toBe(false);
  expect(validTaskBody({ ...good, notes: 'n'.repeat(2001) }, roomId)).toBe(false);
  expect(validTaskBody({ ...good, assigneeId: 'someone' }, roomId)).toBe(false);
  expect(() => taskBody({ roomId, deviceId: device, memberId: alex, change: { title: '' } })).toThrow('title');
  const packets = Array.from({ length: 40 }, () => ({ body: op(alex, { title: 'T', notes: 'x'.repeat(1900) }), signature: 's'.repeat(88) }));
  const chunks = syncChunks(roomId, packets);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.flatMap(c => c.ops)).toHaveLength(40);
  for (const chunk of chunks) expect(JSON.stringify(chunk).length).toBeLessThan(20_000);
});

test("Gemini's review: removal wins, clocks never decide, and a losing edit does not take assignment credit", () => {
  const create = op(alex, { title: 'Review', assigneeId: codex }, undefined, { at: 1000 });
  const [task] = foldBoard([create]);
  // 2. A removal wins over a simultaneous edit, and over a later edit made without seeing the removal.
  const removal = { ...taskBody({ roomId, deviceId: device, memberId: sam, current: task, change: {}, removed: true }), at: 1500, id: '00000000-0000-4000-8000-000000000001' };
  const edit = op(alex, { notes: 'later' }, task, { at: 9000, id: 'ffffffff-ffff-4fff-bfff-ffffffffffff' });
  expect(foldBoard([create, removal, edit])).toEqual([]);
  expect(foldBoard([create, edit, op(alex, { status: 'done' }, foldBoard([create, edit])[0]), removal])).toEqual([]);
  // 3. At the same revision the operation id decides, not the clock: a device far in the future still loses.
  const future = op(sam, { title: 'Future clock' }, task, { at: 9_999_999_999_999, id: '00000000-0000-4000-8000-00000000000a' });
  const now = op(alex, { title: 'Normal clock' }, task, { at: 2000, id: '00000000-0000-4000-8000-00000000000b' });
  expect(foldBoard([create, future, now])[0].title).toBe('Normal clock');
  // 5. A losing concurrent reassignment does not move the credit away from whoever assigned the current assignee.
  const reassign = op(sam, { assigneeId: sam }, task, { id: '00000000-0000-4000-8000-000000000001' });
  const retitle = op(alex, { title: 'Review v2' }, task, { id: '00000000-0000-4000-8000-000000000002' });
  expect(foldBoard([create, reassign, retitle])[0]).toMatchObject({ title: 'Review v2', assigneeId: codex, assignedBy: alex, assignedRevision: 1 });
});

test('compaction keeps the same board with far fewer operations', () => {
  let ops: TaskBody[] = [];
  const apply = (memberId: string, change: Parameters<typeof taskBody>[0]['change'], taskId?: string, removed = false) => {
    const current = taskId ? foldBoard(ops).find(t => t.id === taskId) : undefined;
    const body = taskBody({ roomId, deviceId: device, memberId, current, taskId, change, removed });
    ops.push(body); return body.taskId;
  };
  const a = apply(alex, { title: 'A', assigneeId: codex }), b = apply(sam, { title: 'B' }), c = apply(sam, { title: 'C' });
  for (let i = 0; i < 120; i++) apply(i % 2 ? alex : sam, { status: (['todo', 'doing', 'done'] as const)[i % 3], notes: `step ${i}` }, a);
  apply(sam, { assigneeId: sam }, b); apply(alex, { assigneeId: null }, b); apply(alex, { assigneeId: sam }, b); apply(sam, { status: 'doing' }, b);
  apply(alex, {}, c, true);
  const packets = ops.map(body => ({ body, signature: 's' }));
  const compacted = compactBoard(packets);
  expect(compacted.length).toBeLessThan(40);
  expect(foldBoard(compacted.map(p => p.body))).toEqual(foldBoard(ops));
  expect(foldBoard(ops).find(t => t.id === b)).toMatchObject({ assigneeId: sam, assignedBy: alex });
  expect(compactBoard(compacted)).toEqual(compacted);
});

test("Copilot's review: a late concurrent edit decides the same way on compacted and full boards", () => {
  const ops: TaskBody[] = [op(alex, { title: 'Late edits', assigneeId: codex })];
  for (let i = 0; i < 80; i++) ops.push(op(i % 2 ? alex : sam, { notes: `step ${i}` }, foldBoard(ops)[0]));
  const compacted = compactBoard(ops.map(body => ({ body, signature: 's' }))).map(p => p.body);
  expect(compacted.length).toBeLessThan(ops.length);
  // An offline peer's edit made at an older revision reassigns the task; its id loses or wins against the kept winner.
  const at = ops[ops.length - 5];
  for (const id of ['00000000-0000-4000-8000-000000000000', 'ffffffff-ffff-4fff-bfff-ffffffffffff']) {
    const late = { ...at, id, memberId: sam, assigneeId: sam, notes: 'offline edit' };
    expect(foldBoard([...compacted, late])).toEqual(foldBoard([...ops, late]));
  }
});

test('the task timeline describes each winning change against the state before it', () => {
  const ops: TaskBody[] = [];
  const at = (minutes: number) => 1_000_000 + minutes * 60_000;
  const apply = (memberId: string, minutes: number, change: Parameters<typeof taskBody>[0]['change'], taskId?: string, removed = false) => {
    const current = taskId ? foldBoard(ops).find(t => t.id === taskId) : undefined;
    const body = { ...taskBody({ roomId, deviceId: device, memberId, current, taskId, change, removed }), at: at(minutes) };
    ops.push(body); return body.taskId;
  };
  const strip = ({ id: _, taskId: __, at: ___, ...event }: ReturnType<typeof taskTimeline>[number]) => event;
  const fix = apply(alex, 0, { title: 'Fix header' });
  apply(alex, 10, { assigneeId: codex }, fix);
  apply(codex, 20, { status: 'doing' }, fix);
  // Quick consecutive changes by one person read as one line with the net change.
  apply(codex, 21, { status: 'done' }, fix);
  apply(codex, 22, { notes: 'shipped' }, fix);
  apply(sam, 30, { title: 'Fix the header' }, fix);
  apply(sam, 40, { assigneeId: sam }, fix);
  apply(sam, 50, { assigneeId: null, status: 'todo' }, fix);
  // Changed and changed back within the window: nothing to say.
  apply(alex, 60, { status: 'doing' }, fix); apply(alex, 61, { status: 'todo' }, fix);
  const quick = apply(sam, 70, { title: 'Scratch', assigneeId: codex });
  apply(sam, 71, {}, quick, true);
  expect(taskTimeline(ops).map(strip)).toEqual([
    { memberId: alex, title: 'Fix header', created: true },
    { memberId: alex, title: 'Fix header', assigneeId: codex },
    { memberId: codex, title: 'Fix header', status: 'done', notes: true },
    { memberId: sam, title: 'Fix the header', renamedFrom: 'Fix header' },
    { memberId: sam, title: 'Fix the header', assigneeId: sam },
    { memberId: sam, title: 'Fix the header', assigneeId: null, status: 'todo' },
    // Created and removed by one person moments apart: only the removal is shown.
    { memberId: sam, title: 'Scratch', removed: true },
  ]);
  // Compaction drops intermediate history once a task is long; the lines left never claim a change they cannot see.
  for (let i = 0; i < 40; i++) apply(sam, 100 + i * 10, { notes: `pass ${i}` }, fix);
  const compacted = taskTimeline(compactBoard(ops.map(body => ({ body, signature: 's' }))).map(p => p.body)).filter(e => e.taskId === fix).map(strip);
  expect(compacted[0]).toEqual({ memberId: alex, title: 'Fix header', created: true });
  expect(compacted[1]).toMatchObject({ memberId: sam, updated: true });
  expect(taskTimeline([])).toEqual([]);
});

test('a task links one GitHub issue or pull request, and only a real one', () => {
  const link = 'https://github.com/igorls/meshrooms/issues/42';
  // Pasted forms become the one link a task keeps.
  expect(issueLinkFrom(' https://github.com/igorls/meshrooms/issues/42#issuecomment-1 ')).toBe(link);
  expect(issueLinkFrom('https://www.github.com/igorls/meshrooms/pull/7/files?diff=split')).toBe('https://github.com/igorls/meshrooms/pull/7');
  expect(issueLinkFrom('igorls/meshrooms#42')).toBe(link);
  for (const bad of ['http://github.com/igorls/meshrooms/issues/42', 'https://github.com.evil.dev/igorls/meshrooms/issues/42', 'https://gitlab.com/a/b/issues/1',
    'https://github.com/igorls/meshrooms/issues/x', 'https://github.com/igorls/../issues/1', 'igorls/..#1', 'javascript:alert(1)', 'meshrooms#42'])
    expect(issueLinkFrom(bad)).toBeUndefined();
  expect(validIssueLink('https://github.com/igorls/../issues/1')).toBe(false);
  expect(issueLabel('https://github.com/igorls/meshrooms/pull/7')).toBe('igorls/meshrooms#7');
  expect(repositoryFrom('https://github.com/igorls/meshrooms/tree/main/src')).toBe('igorls/meshrooms');
  expect(repositoryFrom('igorls/meshrooms.git')).toBe('igorls/meshrooms');
  expect(repositoryFrom('igorls')).toBeUndefined();
  // GitHub's own form, prefilled; the person submits it with their account.
  const opened = new URL(newIssueUrl('igorls/meshrooms', 'Fix header & footer', 'Line one\nLine two'));
  expect(opened.origin + opened.pathname).toBe('https://github.com/igorls/meshrooms/issues/new');
  expect([opened.searchParams.get('title'), opened.searchParams.get('body')]).toEqual(['Fix header & footer', 'Line one\nLine two']);
  expect(() => newIssueUrl('igorls/..', 't', '')).toThrow('owner/name');

  // Linking and unlinking are signed task changes like any other; an edit keeps the link.
  const created = op(alex, { title: 'Header', issue: link });
  const linked = foldBoard([created])[0];
  expect(linked.issue).toBe(link);
  const renamed = op(sam, { title: 'Header, again' }, linked);
  expect(foldBoard([created, renamed])[0].issue).toBe(link);
  const unlinked = op(sam, { issue: null }, foldBoard([created, renamed])[0]);
  expect(unlinked.issue).toBeUndefined();
  expect(foldBoard([created, renamed, unlinked])[0].issue).toBeUndefined();
  expect(() => op(alex, { title: 'Bad', issue: 'https://example.com/issues/1' })).toThrow('GitHub issue');
  expect(validTaskBody({ ...created, issue: 'https://example.com/igorls/meshrooms/issues/1' }, roomId)).toBe(false);
  expect(validTaskBody(created, roomId)).toBe(true);
  // The conversation says so.
  const later = (body: TaskBody, at: number) => ({ ...body, at });
  const events = taskTimeline([later(created, 1_000), later(renamed, 500_000), later(unlinked, 1_000_000)]);
  expect(events.map(e => e.issue)).toEqual([link, undefined, null]);
});

test('repositories mentioned in the conversation are suggested for pinning, most recent first', () => {
  expect(mentionedRepositories([
    'see https://github.com/igorls/wormdb/issues/3.',
    'and https://github.com/igorls/meshrooms/pull/22, https://github.com/igorls/wormdb',
    'not https://github.com.evil.dev/x/y or http://github.com/a/b',
  ])).toEqual(['igorls/meshrooms', 'igorls/wormdb']);
  expect(mentionedRepositories(Array.from({ length: 9 }, (_, i) => `https://github.com/org/r${i}`), 3)).toEqual(['org/r8', 'org/r7', 'org/r6']);
});
