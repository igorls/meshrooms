import { expect, test } from 'bun:test';
import { DesktopError } from './codex-desktop';
import { desktopDeliveryStep, type DesktopDelivery, type DeliveryDeps } from './desktop-delivery';
import { BrowserAgent } from './browser-agent';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const binding = { threadId: 'chat', roomId: 'room', generation: 'binding-one', cwd: '/project' };
const after = { after: 'message', boardAfter: 2, decisionsAfter: 3 };
function mailbox() {
  let stored: DesktopDelivery | undefined, cursor = 'before', snapshots = 0, pushes = 0, dispatches = 0;
  const operations: string[] = [], ids: string[] = [];
  const deps: DeliveryDeps = {
    read: () => stored ? structuredClone(stored) : undefined,
    save: d => { stored = structuredClone(d); operations.push(d.state); },
    cursor: () => cursor, commit: () => { cursor = JSON.stringify(after); operations.push('commit'); },
    snapshot: async id => { snapshots++; if (cursor !== 'before') return; return { output: JSON.stringify({ id, text: 'room message' }), cursor: after }; },
    send: async (event, beforeSend) => { pushes++; ids.push(event.id); beforeSend(); expect(stored?.state).toBe('sending'); return { turnId: 'turn' }; },
    beforeSend: () => { dispatches++; }, current: () => true, now: () => 1000,
  };
  return { deps, operations, ids, stored: () => stored, cursor: () => cursor, counts: () => ({ snapshots, pushes, dispatches }) };
}

test('receipt is saved before consuming the room; restarts never replay an accepted event', async () => {
  const m = mailbox();
  expect((await desktopDeliveryStep(binding, m.deps)).state).toBe('accepted');
  expect(m.operations).toEqual(['pending', 'sending', 'accepted', 'commit']);
  await desktopDeliveryStep(binding, m.deps);
  expect(m.counts().pushes).toBe(1); expect(m.stored()?.turnId).toBe('turn');
});

test('an offline desktop retains a stable pending event without consuming the room or spending an agent wake', async () => {
  const m = mailbox(); m.deps.send = async event => { m.ids.push(event.id); throw new DesktopError('unavailable', 'offline'); };
  expect((await desktopDeliveryStep(binding, m.deps)).state).toBe('pending');
  await desktopDeliveryStep(binding, m.deps);
  expect(m.ids[0]).toBe(m.ids[1]); expect(m.cursor()).toBe('before'); expect(m.counts().dispatches).toBe(0);
});

test('a crash after dispatch is uncertain across restarts and rebinding, with no automatic replay', async () => {
  const m = mailbox();
  m.deps.send = async (_, beforeSend) => { beforeSend(); throw new DesktopError('uncertain', 'lost ack'); };
  expect((await desktopDeliveryStep(binding, m.deps)).state).toBe('uncertain');
  m.deps.send = async () => { throw new Error('must not be called'); };
  expect((await desktopDeliveryStep({ ...binding, generation: 'new', threadId: 'another' }, m.deps)).state).toBe('uncertain');
  expect(m.cursor()).toBe('before');
});

test('a saved sending record from a terminated watcher is held as uncertain', async () => {
  const m = mailbox();
  m.deps.send = async (_, beforeSend) => { beforeSend(); throw new Error('crash'); };
  await expect(desktopDeliveryStep(binding, m.deps)).rejects.toThrow('crash');
  expect((await desktopDeliveryStep(binding, m.deps)).state).toBe('uncertain');
  expect(m.counts().dispatches).toBe(1);
});

test('a crash between saving the acceptance and committing the cursor recovers without another submission', async () => {
  const m = mailbox(), commit = m.deps.commit;
  m.deps.commit = () => { throw new Error('crash before cursor'); };
  await expect(desktopDeliveryStep(binding, m.deps)).rejects.toThrow('crash before cursor');
  expect(m.stored()?.state).toBe('accepted'); m.deps.commit = commit;
  await desktopDeliveryStep(binding, m.deps);
  expect(m.counts().pushes).toBe(1); expect(m.cursor()).toBe(JSON.stringify(after));
});

test('a binding changed during owner discovery is fenced before submission', async () => {
  const m = mailbox(); let current = true;
  m.deps.current = () => current;
  m.deps.send = async (_, beforeSend) => { current = false; beforeSend(); throw new Error('unreachable'); };
  expect((await desktopDeliveryStep(binding, m.deps)).state).toBe('pending');
  expect(m.counts().dispatches).toBe(0); expect(m.cursor()).toBe('before');
});

test('a bridge reader advancing the cursor cannot erase a pending event or have its newer cursor rewound', async () => {
  const m = mailbox(); let current = 'before'; m.deps.cursor = () => current;
  m.deps.send = async () => { throw new DesktopError('unavailable', 'offline'); };
  await desktopDeliveryStep(binding, m.deps);
  const id = m.stored()!.id; current = 'newer-reader-position';
  m.deps.send = async (event, beforeSend) => { expect(event.id).toBe(id); beforeSend(); return { turnId: 'turn' }; };
  m.deps.commit = () => { throw new Error('must not rewind'); };
  expect((await desktopDeliveryStep(binding, m.deps)).state).toBe('accepted');
  expect(current).toBe('newer-reader-position');
});

test('the shared cursor compare-and-set refuses a stale commit under the bridge reader lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-cursor-'));
  try {
    const agent = new BrowserAgent(dir, 'http://127.0.0.1:4320', crypto.randomUUID());
    agent.saveListenCursor({ boardAfter: 1, decisionsAfter: 1 });
    const before = JSON.stringify(agent.listenCursor());
    agent.saveListenCursor({ boardAfter: 2, decisionsAfter: 2 });
    expect(agent.saveListenCursor({ boardAfter: 3, decisionsAfter: 3 }, before)).toBe(false);
    expect(agent.listenCursor()).toEqual({ boardAfter: 2, decisionsAfter: 2 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
