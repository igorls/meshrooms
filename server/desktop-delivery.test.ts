import { expect, test } from 'bun:test';
import { DesktopError } from './codex-desktop';
import { desktopDeliveryStep, resolveDesktopDelivery, type DesktopDelivery, type DeliveryDeps } from './desktop-delivery';
import { watchDesktop } from './desktop-watch';
import { emptyState, type WatchConfig, type WatchState } from './agent-watch';
import { BrowserAgent } from './browser-agent';
import { agentCli } from './agent-cli';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('watchDesktop records idle at startup, prefixes activity notes with wakeup, skips live leases, and does not spin while halted until resolved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-desktop-watch-'));
  try {
    const roomId = crypto.randomUUID(), alex = crypto.randomUUID(), wren = crypto.randomUUID(), deviceId = 'a'.repeat(64);
    const agent = new BrowserAgent(dir, 'http://127.0.0.1:1', roomId);
    writeFileSync(join(agent.dir, 'members.json'), JSON.stringify({ memberId: wren, ownerId: alex, members: [{ id: alex, name: 'Alex', role: 'human' }, { id: wren, name: 'Wren', role: 'agent', operatorId: alex }], devices: [] }));
    const config: WatchConfig = { roomId, harness: 'codex', codexDelivery: 'desktop', session: 'thread-1', generation: 'gen-1', cwd: dir, maxWakesPerHour: 20, maxAgentWakesPerHour: 40, runTimeoutMinutes: 10, allowTools: [], launcher: 'meshrooms.js', agentHome: dir, binDir: dir, roomDir: agent.dir };
    let state: WatchState = emptyState();
    let now = 1_000_000, ticks = 0, claims = 0, writes = 0, sends = 0, liveHold: 'none' | 'attached' = 'attached', failUncertain = false;
    const mention = { kind: 'message', roomId, id: crypto.randomUUID(), deviceId, memberId: alex, text: '@Wren ping', at: now };
    writeFileSync(join(agent.dir, 'messages.json'), JSON.stringify([{ packet: { body: mention, signature: '' }, targets: [], receipts: [] }]));

    // 1. Live listener attached: records idle on startup, sets wakeup-prefixed live note, does NOT claim or send.
    await watchDesktop(agent, config, {
      now: () => now,
      sleep: async ms => { now += ms; ticks++; },
      ready: () => true,
      current: () => ticks < 2,
      ensureRunner: async () => {},
      readState: () => structuredClone(state),
      writeState: s => { writes++; state = structuredClone(s); },
      log: () => {},
      claim: () => { claims++; return { started: () => {}, release: () => {} }; },
      withdraw: () => {},
      live: { check: () => ({ hold: liveHold }), begin: () => true, end: () => {}, restoreCursor: () => {} },
      send: async (_, beforeSend) => { sends++; beforeSend(); return { turnId: 'turn-1' }; },
    });
    expect(agent.activity()?.state).toBe('idle');
    expect(agent.activity()?.note).toMatch(/^wakeup /);
    expect(claims).toBe(0);
    expect(sends).toBe(0);

    // 2. Live listener detaches; delivery becomes uncertain -> halts and stops spinning on subsequent ticks.
    liveHold = 'none'; failUncertain = true; ticks = 0; writes = 0; claims = 0; sends = 0;
    await watchDesktop(agent, config, {
      now: () => now,
      sleep: async ms => { now += ms; ticks++; },
      ready: () => true,
      current: () => ticks < 8,
      ensureRunner: async () => {},
      readState: () => structuredClone(state),
      writeState: s => { writes++; state = structuredClone(s); },
      log: () => {},
      claim: () => { claims++; return { started: () => {}, release: () => {} }; },
      withdraw: () => {},
      live: { check: () => ({ hold: 'none' }), begin: () => true, end: () => {}, restoreCursor: () => {} },
      send: async (_, beforeSend) => { sends++; beforeSend(); if (failUncertain) throw new DesktopError('uncertain', 'lost ack'); return { turnId: 'turn-2' }; },
    });
    expect(state.halted?.generation).toBe('gen-1');
    expect(state.desktop?.state).toBe('uncertain');
    expect(agent.activity()?.note).toMatch(/^wakeup /);
    // Even after 8 ticks (past the old 5s retry timer), it claimed and sent ONLY ONCE!
    expect(claims).toBe(1);
    expect(sends).toBe(1);

    // 3. Operator resolves uncertain delivery to retry -> loop detects it, clears halt, delivers once, sets wakeup note.
    resolveDesktopDelivery(agent.dir, state.desktop!.id!, 'retry');
    failUncertain = false; ticks = 0; claims = 0; sends = 0;
    await watchDesktop(agent, config, {
      now: () => now,
      sleep: async ms => { now += ms; ticks++; },
      ready: () => true,
      current: () => ticks < 3,
      ensureRunner: async () => {},
      readState: () => structuredClone(state),
      writeState: s => { state = structuredClone(s); },
      log: () => {},
      claim: () => { claims++; return { started: () => {}, release: () => {} }; },
      withdraw: () => {},
      live: { check: () => ({ hold: 'none' }), begin: () => true, end: () => {}, restoreCursor: () => {} },
      send: async (_, beforeSend) => { sends++; beforeSend(); return { turnId: 'turn-2' }; },
    });
    expect(state.halted).toBeUndefined();
    expect(state.desktop).toMatchObject({ state: 'accepted', turnId: 'turn-2' });
    expect(agent.activity()?.note).toBe('wakeup room event accepted by Codex desktop');
    expect(claims).toBe(1);
    expect(sends).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== 'win32')('startWatch fails fast when --codex-delivery desktop is selected on Windows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-win-desktop-'));
  const savedAgent = process.env.MESHROOMS_AGENT_HOME, savedPerson = process.env.MESHROOMS_PERSON_HOME;
  try {
    const roomId = crypto.randomUUID();
    const agent = new BrowserAgent(dir, 'http://127.0.0.1:1', roomId);
    writeFileSync(join(agent.dir, 'room.json'), JSON.stringify({ origin: 'http://127.0.0.1:1', roomId }));
    process.env.MESHROOMS_AGENT_HOME = dir;
    process.env.MESHROOMS_PERSON_HOME = join(dir, 'person');
    await expect(agentCli(['watch', '--room', roomId, '--harness', 'codex', '--codex-delivery', 'desktop', '--session', crypto.randomUUID()]))
      .rejects.toThrow('--codex-delivery headless');
  } finally {
    if (savedAgent === undefined) delete process.env.MESHROOMS_AGENT_HOME; else process.env.MESHROOMS_AGENT_HOME = savedAgent;
    if (savedPerson === undefined) delete process.env.MESHROOMS_PERSON_HOME; else process.env.MESHROOMS_PERSON_HOME = savedPerson;
    rmSync(dir, { recursive: true, force: true });
  }
});
