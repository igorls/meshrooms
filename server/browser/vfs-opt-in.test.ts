import { afterEach, expect, test } from 'bun:test';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserAgent, RUNNER_ALIVE, fetchPassiveVfsChanges, vfsOptedIn, vfsRpcCall } from '../browser-agent';
import { testDirectory } from '../test-directory';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function agentWithProof(proof: Record<string, unknown> | undefined) {
  const dir = testDirectory('vfs-opt-in');
  cleanups.push(dir.cleanup);
  const agent = new BrowserAgent(dir.path, 'http://127.0.0.1:1', crypto.randomUUID());
  const now = Date.now();
  if (proof) writeFileSync(join(agent.dir, RUNNER_ALIVE), JSON.stringify({ pid: process.pid, at: now, startedAt: now, loopAt: now, ...proof }));
  return agent;
}

test('the Room VFS is opt-in: on only with MESHROOMS_VFS=1', () => {
  expect(vfsOptedIn({})).toBe(false);
  expect(vfsOptedIn({ MESHROOMS_VFS: '0' })).toBe(false);
  expect(vfsOptedIn({ MESHROOMS_VFS: 'true' })).toBe(false);
  expect(vfsOptedIn({ MESHROOMS_VFS: '1' })).toBe(true);
});

test('a live runner without the VFS gets vfs-* refused at once, never a timeout, and listen asks it nothing', async () => {
  const agent = agentWithProof({});
  const started = Date.now();
  await expect(vfsRpcCall(agent, { op: 'vfs-list' } as never, { timeoutMs: 10_000 })).rejects.toMatchObject({ code: 'VFS_DISABLED', status: 403 });
  expect(Date.now() - started).toBeLessThan(1_000);
  // Nothing was queued for a runner that would never answer it.
  const outbox = join(agent.dir, 'outbox');
  expect((() => { try { return readdirSync(outbox).filter(f => f.endsWith('.json')); } catch { return []; } })()).toEqual([]);
  expect(await fetchPassiveVfsChanges(agent, 0, 2_000)).toBeUndefined();
  expect(Date.now() - started).toBeLessThan(1_500);
});

test('a live runner with the VFS on still takes the request (it waits for the runner\'s answer)', async () => {
  const agent = agentWithProof({ vfs: true });
  await expect(vfsRpcCall(agent, { op: 'vfs-list' } as never, { timeoutMs: 200 })).rejects.not.toMatchObject({ code: 'VFS_DISABLED' });
});
