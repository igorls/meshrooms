import { expect, test } from 'bun:test';
import { taskBody, type TaskPacket } from '../../src/browser/board';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserAgent, PENDING_PROFILE, applyPendingProfile, boardTasks, runBridge, taskBrowser } from '../browser-agent';

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

test("harness and model given before admission are reported once admitted", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-profile-'));
  try {
    const agent = new BrowserAgent(dir, 'https://example.test', roomId) as any, sent: unknown[] = [], logs: string[] = [];
    agent.command = async (action: string, payload: unknown) => { sent.push([action, payload]); return {}; };
    await applyPendingProfile(agent, line => logs.push(line)); // Nothing pending: nothing sent.
    writeFileSync(join(agent.dir, PENDING_PROFILE), JSON.stringify({ harness: 'Claude Code', model: 'claude-opus-5-5' }));
    await applyPendingProfile(agent, line => logs.push(line));
    expect(sent).toEqual([['profile', { harness: 'Claude Code', model: 'claude-opus-5-5' }]]);
    expect(existsSync(join(agent.dir, PENDING_PROFILE))).toBe(false);
    // A rejected value is logged and not retried forever; the agent can run profile again.
    writeFileSync(join(agent.dir, PENDING_PROFILE), JSON.stringify({ model: '<bad>' }));
    agent.command = async () => { throw new Error('Give a model of up to 48 letters'); };
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

