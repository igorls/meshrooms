import { describe, expect, test } from 'bun:test';
import { MAX_LIVE_TASKS_PER_MEMBER, MAX_REVISION_JUMP, capLiveTasks, foldBoard, mayAddTask, taskBody, withinRevisionJump, type TaskPacket } from './board';
import { QUOTA_BURST, QUOTA_QUIET_MS, QuotaDrops, ReceiveQuota } from './quota';
import { MAX_REACTION_KEYS_PER_MEMBER, capReactions, foldReactions, type ReactionBody, type ReactionPacket } from './reactions';

const roomId = crypto.randomUUID(), alice = crypto.randomUUID(), bob = crypto.randomUUID();

describe('receive quotas (SEC-5, DEC-6)', () => {
  test('60 a minute in bursts of 20, per member and per kind', () => {
    let now = 0; const quota = new ReceiveQuota(() => now);
    for (let i = 0; i < QUOTA_BURST; i++) expect(quota.take(alice, 'message')).toBe(true);
    expect(quota.take(alice, 'message')).toBe(false);
    // Other kinds and other members have their own allowance.
    expect(quota.take(alice, 'reaction')).toBe(true);
    expect(quota.take(alice, 'task')).toBe(true);
    expect(quota.take(bob, 'message')).toBe(true);
    now += 1000; // One more per second.
    expect(quota.take(alice, 'message')).toBe(true);
    expect(quota.take(alice, 'message')).toBe(false);
    now += 60_000; // Refills to the burst, not beyond.
    let taken = 0; while (quota.take(alice, 'message')) taken++;
    expect(taken).toBe(QUOTA_BURST);
    // Sustained: about 60 a minute.
    let sustained = 0;
    for (let i = 0; i < 600; i++) { now += 100; if (quota.take(alice, 'message')) sustained++; }
    expect(sustained).toBe(60);
  });

  test('a drop is reported at most once a minute per member and kind', () => {
    let now = 0; const quota = new ReceiveQuota(() => now);
    expect(quota.report(alice, 'message')).toBe(true);
    expect(quota.report(alice, 'message')).toBe(false);
    expect(quota.report(alice, 'task')).toBe(true);
    now += 60_000;
    expect(quota.report(alice, 'message')).toBe(true);
  });
});

describe('recovering state dropped over quota', () => {
  test('a peer is named once its burst has been quiet for a while, and once per burst', () => {
    let now = 0; const drops = new QuotaDrops(() => now);
    drops.drop('a'); now += 1000; drops.drop('a'); drops.drop('b');
    expect(drops.due()).toEqual([]);
    now += QUOTA_QUIET_MS;
    expect(drops.due()).toEqual(['a', 'b']);
    expect(drops.due()).toEqual([]);
    drops.drop('a'); now += QUOTA_QUIET_MS;
    expect(drops.due()).toEqual(['a']);
  });
});

describe('task revision jumps', () => {
  const create = { body: taskBody({ roomId, deviceId: 'a'.repeat(64), memberId: alice, change: { title: 'Fix header' } }), signature: '' };
  const at = (revision: number, from = create): TaskPacket => ({ body: { ...from.body, id: crypto.randomUUID(), revision }, signature: '' });

  test('refuses an operation that jumps far past the held revision, so nobody can freeze a task at the cap', () => {
    const held = [create.body];
    expect(withinRevisionJump(held, [at(1 + MAX_REVISION_JUMP)])).toHaveLength(1);
    expect(withinRevisionJump(held, [at(2 + MAX_REVISION_JUMP)])).toHaveLength(0);
    expect(withinRevisionJump(held, [at(1_000_000)])).toHaveLength(0);
    // A new task starts from 0.
    expect(withinRevisionJump([], [at(MAX_REVISION_JUMP)])).toHaveLength(1);
    expect(withinRevisionJump([], [at(MAX_REVISION_JUMP + 1)])).toHaveLength(0);
  });

  test('a single batch cannot bypass MAX_REVISION_JUMP by stepping +1000 repeatedly, while contiguous chains and bounded jumps still sync', () => {
    // Stepping +1000 repeatedly in one batch cannot climb past baseHighest + MAX_REVISION_JUMP.
    const stepping = [create, at(1000), at(2000), at(3000)];
    expect(withinRevisionJump([], stepping)).toEqual([create, at(1000)].map((_, i) => stepping[i]));
    const split = [at(1500), at(900), create];
    expect(withinRevisionJump([], split)).toEqual([split[1], split[2]]);
    // Contiguous 1-step chains (`rev = prev + 1`) are always allowed even past MAX_REVISION_JUMP.
    const contiguous = Array.from({ length: MAX_REVISION_JUMP + 50 }, (_, i) => i === 0 ? create : at(i + 1));
    expect(withinRevisionJump([], contiguous)).toHaveLength(MAX_REVISION_JUMP + 50);
    // A compacted board jumping within MAX_REVISION_JUMP and ending with a contiguous tail is accepted in arrival order.
    const compacted = [at(1002), at(1001), at(1000), at(400), create];
    expect(withinRevisionJump([], compacted)).toEqual(compacted);
    const other = { body: taskBody({ roomId, deviceId: 'a'.repeat(64), memberId: alice, change: { title: 'Other' } }), signature: '' };
    // Another task's revisions don't lift this one.
    expect(withinRevisionJump([other.body, { ...other.body, revision: 5000 }], [at(2000)])).toHaveLength(0);
  });
});

describe('live task cap', () => {
  const newTask = (memberId: string, i: number): TaskPacket => ({
    body: { ...taskBody({ roomId, deviceId: 'a'.repeat(64), memberId, change: { title: `Task ${i}` } }), at: i + 1 },
    signature: '',
  });
  /** Feed `ops` in `batches` the way a device stores them: each batch on top of what it kept. */
  const arrive = (batches: TaskPacket[][]) => batches.reduce<TaskPacket[]>((held, batch) => capLiveTasks([...held, ...batch]), []);
  const shuffled = <T,>(list: T[], seed: number) => {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) { seed = (seed * 1103515245 + 12345) % 2 ** 31; const j = seed % (i + 1); [copy[i], copy[j]] = [copy[j], copy[i]]; }
    return copy;
  };

  test('each member keeps their oldest cap-full of live tasks; others are not affected', () => {
    const flood = Array.from({ length: MAX_LIVE_TASKS_PER_MEMBER + 50 }, (_, i) => newTask(alice, i));
    const kept = capLiveTasks([...flood, newTask(bob, 9999)]);
    expect(kept.filter(p => p.body.memberId === alice).map(p => p.body.at)).toEqual(flood.slice(0, MAX_LIVE_TASKS_PER_MEMBER).map(p => p.body.at));
    expect(kept.filter(p => p.body.memberId === bob)).toHaveLength(1);
  });

  test('devices that receive the same operations in different batches and orders keep the same board', () => {
    const ops = [...Array.from({ length: MAX_LIVE_TASKS_PER_MEMBER + 30 }, (_, i) => newTask(alice, i)), newTask(bob, 1)];
    const removed = ops[3].body, edited = ops[7].body;
    ops.push({ body: { ...removed, id: crypto.randomUUID(), revision: 2, removed: true }, signature: '' });
    ops.push({ body: { ...edited, id: crypto.randomUUID(), revision: 2, notes: 'edited' }, signature: '' });
    const boards = [1, 2, 3, 4].map(seed => {
      const order = shuffled(ops, seed), size = 7 * seed;
      const batches = Array.from({ length: Math.ceil(order.length / size) }, (_, i) => order.slice(i * size, (i + 1) * size));
      return JSON.stringify(foldBoard(arrive(batches).map(p => p.body)));
    });
    expect(new Set(boards).size).toBe(1);
    expect(JSON.parse(boards[0])).toHaveLength(MAX_LIVE_TASKS_PER_MEMBER + 1);
  });

  test('an older task arriving late takes the place of the newest; a removal frees a place', () => {
    const tasks = Array.from({ length: MAX_LIVE_TASKS_PER_MEMBER + 1 }, (_, i) => newTask(alice, i));
    const late = arrive([tasks.slice(1), [tasks[0]]]).map(p => p.body.taskId);
    expect(late).not.toContain(tasks.at(-1)!.body.taskId);
    expect(late).toContain(tasks[0].body.taskId);
    const removal: TaskPacket = { body: { ...tasks[0].body, id: crypto.randomUUID(), revision: 2, removed: true }, signature: '' };
    expect(capLiveTasks([...tasks, removal]).map(p => p.body.taskId)).toContain(tasks.at(-1)!.body.taskId);
  });

  test('an edit by someone else that arrives before its task is kept once the task arrives', () => {
    const task = newTask(alice, 1), edit: TaskPacket = { body: { ...task.body, id: crypto.randomUUID(), memberId: bob, revision: 2, notes: 'by Bob' }, signature: '' };
    const bobFull = Array.from({ length: MAX_LIVE_TASKS_PER_MEMBER }, (_, i) => newTask(bob, i));
    // Alone, Bob's edit is the task's first step and counts against Bob, who is at the cap; with Alice's step it is Alice's.
    // (Dropped meanwhile, it comes back in the next exchange; here it arrives again with the task.)
    expect(arrive([bobFull, [edit], [task, edit]]).map(p => p.body.id)).toContain(edit.body.id);
  });

  test("this device refuses to sign a new task past its member's cap", () => {
    const held = Array.from({ length: MAX_LIVE_TASKS_PER_MEMBER }, (_, i) => newTask(alice, i).body);
    expect(mayAddTask(held, newTask(alice, 5000).body)).toBe(false);
    expect(mayAddTask(held, newTask(bob, 5000).body)).toBe(true);
    expect(mayAddTask(held.slice(1), newTask(alice, 5000).body)).toBe(true);
  });
});

describe('reaction cap', () => {
  const reaction = (memberId: string, messageId: string, revision = 1, removed = false, at = 1): ReactionPacket => ({
    body: { kind: 'reaction', roomId, id: crypto.randomUUID(), deviceId: 'a'.repeat(64), memberId, messageId, emoji: '👍', revision, at, ...(removed ? { removed: true as const } : {}) } as ReactionBody,
    signature: '' });
  const full = Array.from({ length: MAX_REACTION_KEYS_PER_MEMBER }, (_, i) => reaction(alice, crypto.randomUUID(), 1, false, i + 1));

  test('a member past the cap keeps their newest reactions; others are not affected', () => {
    const newer = reaction(alice, crypto.randomUUID(), 1, false, 10_000);
    const kept = capReactions([...full, newer, reaction(bob, crypto.randomUUID())]);
    expect(kept).toHaveLength(MAX_REACTION_KEYS_PER_MEMBER + 1);
    expect(kept).toContain(newer);
    expect(kept).not.toContain(full[0]);
  });

  test('a removal frees a place, and removals never count', () => {
    const removal = reaction(alice, full[5].body.messageId, 2, true, 50);
    expect(capReactions([...full, removal, reaction(alice, crypto.randomUUID(), 1, false, 10_000)])).toContain(full[0]);
  });

  test('devices that receive the same reactions in any order show the same chips', () => {
    const ops = [...full, ...Array.from({ length: 40 }, (_, i) => reaction(alice, crypto.randomUUID(), 1, false, 500 + i)), reaction(alice, full[9].body.messageId, 2, true, 600)];
    const chips = [1, 2, 3].map(seed => {
      let held: ReactionPacket[] = [];
      const order = [...ops];
      for (let i = order.length - 1; i > 0; i--) { seed = (seed * 1103515245 + 12345) % 2 ** 31; const j = seed % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
      for (let i = 0; i < order.length; i += 9) held = capReactions([...held, ...order.slice(i, i + 9)]);
      return JSON.stringify(foldReactions(held.map(p => p.body)).sort((a, b) => a.messageId < b.messageId ? -1 : 1));
    });
    expect(new Set(chips).size).toBe(1);
  });
});
