import { expect, test } from 'bun:test';
import { taskBody, type TaskPacket } from '../../src/browser/board';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserAgent, PENDING_PROFILE, applyPendingProfile, boardTasks, readJson, readJsonStrict, runBridge, taskBrowser } from '../browser-agent';

const roomId = crypto.randomUUID(), alex = crypto.randomUUID(), codex = crypto.randomUUID();
const packet = (body: ReturnType<typeof taskBody>): TaskPacket => ({ body, signature: '' });

test('assignments carry the board cursor at which this device received them, not the per-task revision', () => {
  const other = packet(taskBody({ roomId, deviceId: 'a'.repeat(64), memberId: alex, change: { title: 'Unrelated' } }));
  const create = packet(taskBody({ roomId, deviceId: 'a'.repeat(64), memberId: alex, change: { title: 'Fix header' } }));
  const [, created] = boardTasks([other, create]);
  const assign = packet(taskBody({ roomId, deviceId: 'a'.repeat(64), memberId: alex, current: created, change: { assigneeId: codex } }));
  const ops = [other, create, assign];
  // Per-task revision 2, but the third operation on this board: listen --board-after 2 must still see it.
  expect(boardTasks(ops)[1]).toMatchObject({ assigneeId: codex, assignedBy: alex, assignedRevision: 3, revision: 2 });
  const [, assigned] = boardTasks(ops);
  const status = packet(taskBody({ roomId, deviceId: 'a'.repeat(64), memberId: codex, current: assigned, change: { status: 'doing' } }));
  expect(boardTasks([...ops, status])[1]).toMatchObject({ status: 'doing', assignedRevision: 3 });
});

test("Copilot's review: the bridge's board cursor keeps growing after compaction drops operations", () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-board-'));
  try {
    const agent = new BrowserAgent(dir, 'https://example.test', roomId);
    const create = packet(taskBody({ roomId, deviceId: 'a'.repeat(64), memberId: alex, change: { title: 'Fix header', assigneeId: codex } }));
    // An older tasks.json has no cursors: positions are the arrival order, as before.
    writeFileSync(join(agent.dir, 'tasks.json'), JSON.stringify([create]));
    expect(agent.boardCursor()).toBe(1);
    // After compaction the kept operation keeps its cursor and board.json remembers every arrival so far.
    writeFileSync(join(agent.dir, 'tasks.json'), JSON.stringify([{ ...create, seq: 1180 }]));
    writeFileSync(join(agent.dir, 'board.json'), JSON.stringify({ seq: 1201 }));
    expect(agent.boardCursor()).toBe(1201);
    expect(boardTasks(agent.taskOps())[0]).toMatchObject({ assigneeId: codex, assignedRevision: 1180 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runtime settings given before admission are reported once admitted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-profile-'));
  try {
    const agent = new BrowserAgent(dir, 'https://example.test', roomId) as any, sent: unknown[] = [], logs: string[] = [];
    agent.command = async (action: string, payload: unknown) => { sent.push([action, payload]); return {}; };
    await applyPendingProfile(agent, line => logs.push(line)); // Nothing pending: nothing sent.
    const runtime = { harness: 'Codex app', model: 'gpt-5.1-codex', reasoningEffort: 'high', serviceTier: 'fast' };
    writeFileSync(join(agent.dir, PENDING_PROFILE), JSON.stringify(runtime));
    await applyPendingProfile(agent, line => logs.push(line));
    expect(sent).toEqual([['profile', runtime]]);
    expect(existsSync(join(agent.dir, PENDING_PROFILE))).toBe(false);
    // A temporary failure leaves the same profile queued for the next room check.
    writeFileSync(join(agent.dir, PENDING_PROFILE), JSON.stringify(runtime));
    const send = agent.command;
    agent.command = async () => { throw Object.assign(new Error('Unavailable'), { status: 503 }); };
    await applyPendingProfile(agent, line => logs.push(line));
    expect(readJson<typeof runtime | null>(join(agent.dir, PENDING_PROFILE), null)).toEqual(runtime);
    agent.command = send;
    await applyPendingProfile(agent, line => logs.push(line));
    expect(sent).toEqual([['profile', runtime], ['profile', runtime]]);
    expect(existsSync(join(agent.dir, PENDING_PROFILE))).toBe(false);
    // A rejected value is logged and removed; the agent can run profile again.
    writeFileSync(join(agent.dir, PENDING_PROFILE), JSON.stringify({ model: '<bad>' }));
    agent.command = async () => { throw Object.assign(new Error('Give a model of up to 48 letters'), { status: 400 }); };
    await applyPendingProfile(agent, line => logs.push(line));
    expect(logs.at(-1)).toContain('run profile again');
    expect(existsSync(join(agent.dir, PENDING_PROFILE))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('task-add and task-update through the bridge link a #42 title to the room’s one pinned repository', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-autolink-'));
  try {
    const agent = new BrowserAgent(dir, 'https://example.test', roomId) as any;
    const members = [{ id: codex, name: 'Codex', role: 'agent' }, { id: alex, name: 'Alex', role: 'human' }];
    writeFileSync(join(agent.dir, 'members.json'), JSON.stringify({ memberId: codex, members, devices: [] }));
    // The room service's status carries the pinned repository; the bridge keeps it in settings.json.
    let stop = false;
    agent.command = async (action: string) => {
      if (action !== 'status') return {};
      if (stop) throw Object.assign(new Error('This room was closed by its host.'), { status: 410 });
      return { memberId: codex, ownerId: alex, epoch: 'one', members, devices: [], settings: { floor: 'humans-first' }, repositories: ['example/app'] };
    };
    const bridge = runBridge(agent, () => {}).catch(error => error);
    const added = await taskBrowser(agent, { requestId: crypto.randomUUID(), change: { title: '#42 Review the contract' } });
    expect(added).toMatchObject({ status: 'shared', task: { title: '#42 Review the contract', issue: 'https://github.com/example/app/issues/42' } });
    // --issue none keeps a new task unlinked, and after an unlink a retitle with the same reference stays unlinked.
    const none = await taskBrowser(agent, { requestId: crypto.randomUUID(), change: { title: '#43 Draft the notes', issue: null } });
    expect(none.task?.issue).toBeUndefined();
    await taskBrowser(agent, { requestId: crypto.randomUUID(), taskId: added.taskId, change: { issue: null } });
    const kept = await taskBrowser(agent, { requestId: crypto.randomUUID(), taskId: added.taskId, change: { title: '#42 Review the contract, v2' } });
    expect(kept.task).toMatchObject({ title: '#42 Review the contract, v2' });
    expect(kept.task?.issue).toBeUndefined();
    const retitled = await taskBrowser(agent, { requestId: crypto.randomUUID(), taskId: none.taskId, change: { title: '#44 Draft the notes' } });
    expect(retitled.task?.issue).toBe('https://github.com/example/app/issues/44');
    stop = true;
    expect(String(await bridge)).toContain('closed by its host');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test('readJson retries Windows EBUSY/EPERM contention and readJsonStrict fails closed instead of wiping existing state', async () => {
  const ebusy = () => Object.assign(new Error('resource busy'), { code: 'EBUSY' });
  const enoent = () => Object.assign(new Error('not found'), { code: 'ENOENT' });
  let attempts = 0;
  const val = readJson<number[]>('fake.json', [], () => { if (++attempts < 3) throw ebusy(); return '[1,2,3]'; }, 'win32');
  expect(val).toEqual([1, 2, 3]);
  expect(attempts).toBe(3);

  // readJsonStrict returns fallback ONLY for ENOENT; persistent read error or corrupt JSON throws!
  expect(readJsonStrict('missing.json', ['fallback'], () => { throw enoent(); }, 'win32')).toEqual(['fallback']);
  expect(() => readJsonStrict('corrupt.json', [], () => '{broken', 'win32')).toThrow();
  expect(() => readJsonStrict('denied.json', [], () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); }, 'linux')).toThrow('EACCES');

  // Corrupt tasks.json / messages.json on disk: runBridge logs the error and does NOT overwrite them with a 1-item array.
  const dir = mkdtempSync(join(tmpdir(), 'bridge-fail-closed-'));
  try {
    const agent = new BrowserAgent(dir, 'https://example.test', roomId) as any;
    const members = [{ id: codex, name: 'Codex', role: 'agent' }, { id: alex, name: 'Alex', role: 'human' }];
    writeFileSync(join(agent.dir, 'members.json'), JSON.stringify({ memberId: codex, members, devices: [] }));
    writeFileSync(join(agent.dir, 'tasks.json'), '{corrupt-existing-tasks');
    const reqId = crypto.randomUUID();
    writeFileSync(join(agent.dir, 'outbox', `${Date.now()}-${reqId}.json`), JSON.stringify({ type: 'task', id: reqId, taskId: reqId, change: { title: 'New task' } }));
    let stop = false;
    const logs: string[] = [];
    agent.command = async (action: string) => {
      if (action !== 'status') return {};
      if (stop) throw Object.assign(new Error('closed'), { status: 410 });
      return { memberId: codex, ownerId: alex, epoch: 'one', members, devices: [], settings: { floor: 'open' } };
    };
    const bridge = runBridge(agent, line => logs.push(line), { pause: () => Bun.sleep(20) }).catch(e => e);
    for (let i = 0; i < 40 && !logs.some(l => l.includes('outbox')); i++) await Bun.sleep(25);
    stop = true;
    await bridge;
    // Existing corrupt file was NOT wiped with a 1-item array, and outbox item stayed queued!
    expect(readFileSync(join(agent.dir, 'tasks.json'), 'utf8')).toBe('{corrupt-existing-tasks');
    expect(readdirSync(join(agent.dir, 'outbox')).some(f => f.endsWith(`-${reqId}.json`))).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test('AGT-8: task-update when the runner is stopped queues without duplicating and delivers once the runner starts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-agt8-'));
  try {
    const agent = new BrowserAgent(dir, 'https://example.test', roomId) as any;
    const members = [{ id: codex, name: 'Codex', role: 'agent' }, { id: alex, name: 'Alex', role: 'human' }];
    writeFileSync(join(agent.dir, 'members.json'), JSON.stringify({ memberId: codex, members, devices: [] }));
    const create = packet(taskBody({ roomId, deviceId: 'a'.repeat(64), memberId: alex, change: { title: 'Ship patch' } }));
    writeFileSync(join(agent.dir, 'tasks.json'), JSON.stringify([{ ...create, seq: 1 }]));
    const requestId = crypto.randomUUID(), taskId = create.body.taskId;

    // Runner is stopped: task-update queues cleanly and returns queued-for-bridge.
    expect(await taskBrowser(agent, { requestId, taskId, revision: 1, change: { status: 'doing' } }, 150)).toEqual({ taskId, status: 'queued-for-bridge' });
    expect(readdirSync(join(agent.dir, 'outbox')).filter(f => f.endsWith(`-${requestId}.json`))).toHaveLength(1);
    // Retrying with the same requestId while still stopped does not duplicate the outbox file.
    expect(await taskBrowser(agent, { requestId, taskId, revision: 1, change: { status: 'doing' } }, 150)).toEqual({ taskId, status: 'queued-for-bridge' });
    expect(readdirSync(join(agent.dir, 'outbox')).filter(f => f.endsWith(`-${requestId}.json`))).toHaveLength(1);

    // Once the runner starts, the queued task-update is signed and stored.
    let stop = false;
    agent.command = async (action: string) => {
      if (action !== 'status') return {};
      if (stop) throw Object.assign(new Error('closed'), { status: 410 });
      return { memberId: codex, ownerId: alex, epoch: 'one', members, devices: [], settings: { floor: 'humans-first' } };
    };
    const bridge = runBridge(agent, () => {}, { pause: () => Bun.sleep(20) }).catch(e => e);
    for (let i = 0; i < 60 && !agent.taskOps().some((p: TaskPacket) => p.body.id === requestId); i++) await Bun.sleep(50);
    expect(boardTasks(agent.taskOps()).find(t => t.id === taskId)).toMatchObject({ status: 'doing', revision: 2 });
    expect(readdirSync(join(agent.dir, 'outbox'))).toEqual([]);
    stop = true;
    await bridge;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

