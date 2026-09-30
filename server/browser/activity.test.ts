import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IDLE_STALE_MS, PACKET_STALE_MS, WORKING_STALE_MS, activityPacket, deriveActivity, duration, receiveActivity, validActivityPacket, type ActivityPacket,
} from '../../src/browser/activity';
import { BrowserAgent, activityAnnouncer, listenBrowser } from '../browser-agent';

const roomId = crypto.randomUUID(), T = 1_790_000_000_000;
const id = () => crypto.randomUUID();
const idle = (extra: Partial<ActivityPacket> = {}): ActivityPacket => ({ kind: 'activity', roomId, at: T, state: 'idle', since: T - 60_000, heartbeat: T - 1000, ...extra });

test('activity packets are checked field by field', () => {
  const working = idle({ state: 'working', on: { messages: [id()], tasks: [id()] }, note: 'Running the test suite' });
  expect(validActivityPacket(idle(), roomId)).toBe(true);
  expect(validActivityPacket(working, roomId)).toBe(true);
  const bad: unknown[] = [
    null, [], 'activity', idle({ roomId: crypto.randomUUID() }), { ...idle(), kind: 'activitty' }, { ...idle(), extra: 1 }, { ...idle(), state: 'sleeping' },
    idle({ since: T }), idle({ heartbeat: T + 1 }), idle({ at: 1.5 }), idle({ since: -1 }), idle({ since: '1' as never }),
    idle({ on: { messages: [id()] } }), // Only a working agent is on something.
    { ...working, on: { messages: ['not-a-uuid'] } }, { ...working, on: { messages: [] } }, { ...working, on: { tasks: Array.from({ length: 9 }, id) } },
    { ...working, on: (() => { const one = id(); return { tasks: [one, one] }; })() }, { ...working, on: { messages: [id()], files: [id()] } }, { ...working, on: [id()] },
    { ...working, note: 'x'.repeat(141) }, { ...working, note: '' }, { ...working, note: '   ' }, { ...working, note: 'line\nbreak' },
    { ...working, note: 'bell\u0007' }, { ...working, note: 'flip \u202egnp.exe' }, { ...working, note: 7 },
  ];
  for (const packet of bad) expect(validActivityPacket(packet, roomId)).toBe(false);
  expect(validActivityPacket({ ...working, note: 'x'.repeat(140) }, roomId)).toBe(true);
  // The largest valid packet stays far under the 20,000-character data channel limit.
  const largest = { ...working, on: { messages: Array.from({ length: 8 }, id), tasks: Array.from({ length: 8 }, id) }, note: '\u{1F600}'.repeat(70) };
  expect(validActivityPacket(largest, roomId)).toBe(true);
  expect(JSON.stringify(largest).length).toBeLessThan(2000);
});

test('the bridge sends only known fields, and nothing for a damaged activity file', () => {
  const file = { state: 'working', since: T - 5000, heartbeat: T - 10, on: { messages: [id()], secret: 'x' }, note: 'Fixing', token: 'x' };
  expect(activityPacket(roomId, file, T)).toBeUndefined(); // An unknown field inside `on` is not trimmed away silently.
  const clean = activityPacket(roomId, { ...file, on: { messages: file.on.messages } }, T)!;
  expect(clean).toEqual({ kind: 'activity', roomId, at: T, state: 'working', since: T - 5000, heartbeat: T - 10, on: { messages: file.on.messages }, note: 'Fixing' });
  expect(activityPacket(roomId, { state: 'idle', since: T, heartbeat: T - 1 }, T)).toBeUndefined();
  expect(activityPacket(roomId, undefined, T)).toBeUndefined();
});

test('receivers measure on the sender clock, so skew between machines cancels out', () => {
  // The agent's clock runs an hour ahead of this browser's.
  const record = receiveActivity(idle({ at: T + 3_600_000, since: T + 3_600_000 - 120_000, heartbeat: T + 3_600_000 - 5000 }), T);
  expect(record).toMatchObject({ since: T - 120_000, heartbeat: T - 5000, receivedAt: T });
  expect(deriveActivity([record], true, T)).toEqual({ state: 'idle', since: T - 120_000 });
});

test('offline, online, idle and working, with staleness', () => {
  const at = (packet: ActivityPacket, receivedAt = T) => receiveActivity(packet, receivedAt);
  expect(deriveActivity([at(idle())], false, T)).toEqual({ state: 'offline' });
  expect(deriveActivity([undefined], true, T)).toEqual({ state: 'online' });
  expect(deriveActivity([], false, T)).toEqual({ state: 'offline' });
  // A bridge that stopped sending while its channel stays open.
  expect(deriveActivity([at(idle())], true, T + PACKET_STALE_MS + 1)).toMatchObject({ state: 'idle', quiet: PACKET_STALE_MS + 1001 });
  expect(deriveActivity([at(idle())], true, T + PACKET_STALE_MS - 1)).not.toHaveProperty('quiet');
  // Packets keep coming, but the agent stopped calling listen.
  const notListening = at(idle({ heartbeat: T - IDLE_STALE_MS - 1 }));
  expect(deriveActivity([notListening], true, T)).toMatchObject({ state: 'idle', quiet: IDLE_STALE_MS + 1 });
  const task = id(), working = idle({ state: 'working', since: T - 1000, heartbeat: T - 1000, on: { tasks: [task] }, note: 'Fixing the header' });
  expect(deriveActivity([at(working)], true, T + WORKING_STALE_MS - 2000)).toEqual({ state: 'working', since: T - 1000, on: { tasks: [task] }, note: 'Fixing the header' });
  expect(deriveActivity([at(working)], true, T + WORKING_STALE_MS)).toMatchObject({ state: 'working', quiet: WORKING_STALE_MS + 1000 });
  // An agent on two connected devices: the freshest report wins.
  expect(deriveActivity([at(working, T - 20_000), at(idle())], true, T)).toMatchObject({ state: 'idle' });
  expect(duration(59_000)).toBe('just now');
  expect(duration(12 * 60_000)).toBe('12 min');
  expect(duration(3 * 3_600_000)).toBe('3 h');
  expect(duration(3 * 86_400_000)).toBe('3 d');
});

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const alex = id(), wren = id();
function room() {
  const home = mkdtempSync(join(tmpdir(), 'mr-bridge-activity-')); dirs.push(home);
  const agent = new BrowserAgent(home, 'http://127.0.0.1:1', roomId);
  writeFileSync(join(agent.dir, 'members.json'), JSON.stringify({ memberId: wren, members: [{ id: alex, name: 'Alex', role: 'human' }, { id: wren, name: 'Wren', role: 'agent', operatorId: alex }], devices: [] }));
  return agent;
}
function say(agent: BrowserAgent, text: string) {
  const body = { kind: 'message', roomId, id: id(), deviceId: 'a'.repeat(64), memberId: alex, text, at: Date.now() };
  const file = join(agent.dir, 'messages.json');
  writeFileSync(file, JSON.stringify([...agent.messages(), { packet: { body, signature: '' }, targets: [], receipts: [] }]));
  return body.id;
}

test('listen records idle while waiting and working on what woke the agent, until it listens again', async () => {
  const agent = room();
  const hello = say(agent, 'Morning, everyone');
  const first = await listenBrowser(agent, undefined, 1);
  expect(first.state).toBe('history');
  const quiet = agent.activity()!;
  expect(quiet).toMatchObject({ state: 'idle' });
  await listenBrowser(agent, hello, 1);
  expect(agent.activity()).toMatchObject({ state: 'idle', since: quiet.since }); // Timeouts keep counting from when it went idle.
  expect(agent.activity()!.heartbeat).toBeGreaterThan(quiet.heartbeat);
  const ask = say(agent, '@Wren can you check the header?');
  const woke = await listenBrowser(agent, hello, 1) as { state: string; cursor: string };
  expect(woke.state).toBe('addressed');
  const working = agent.activity()!;
  expect(working).toMatchObject({ state: 'working', on: { messages: [ask] } });
  expect(working.since).toBeGreaterThan(quiet.since);
  agent.noteActivity('Reading the header styles');
  expect(agent.activity()).toMatchObject({ state: 'working', since: working.since, note: 'Reading the header styles' });
  expect(() => agent.noteActivity('two\nlines')).toThrow('one line');
  expect(() => agent.noteActivity('x'.repeat(141))).toThrow('140');
  await listenBrowser(agent, woke.cursor, 1);
  const after = agent.activity()!;
  expect(after).toMatchObject({ state: 'idle' });
  expect(after).not.toHaveProperty('note'); // The note described the work, which is over.
  expect(after.since).toBeGreaterThanOrEqual(working.since);
  agent.noteActivity('Back at 3pm'); agent.noteActivity('');
  expect(agent.activity()).not.toHaveProperty('note');
});

test('a half-hour listen keeps its heartbeat fresh, so the roster never shows it without a check-in', async () => {
  const agent = room();
  const hello = say(agent, 'Morning, everyone');
  let now = Date.now();
  setSystemTime(new Date(now));
  try {
    writeFileSync(join(agent.dir, 'runner-alive.json'), JSON.stringify({ pid: process.pid, at: now }));
    const waiting = listenBrowser(agent, hello, 1800);
    const started = now, beats: number[] = [];
    // The clock jumps 90 s per 600 ms of real time, more than a heartbeat period each time, so the test takes seconds.
    while (now - started < 1800_000) {
      await Bun.sleep(600);
      beats.push(agent.activity()!.heartbeat);
      // A browser receiving the announced heartbeat now: still idle and waiting, never "no check-in".
      expect(deriveActivity([{ ...agent.activity()!, receivedAt: now }], true, now)).toMatchObject({ state: 'idle' });
      expect(deriveActivity([{ ...agent.activity()!, receivedAt: now }], true, now)).not.toHaveProperty('quiet');
      // Its runner is alive throughout, as `run` proves every second.
      now += 90_000; setSystemTime(new Date(now)); writeFileSync(join(agent.dir, 'runner-alive.json'), JSON.stringify({ pid: process.pid, at: now }));
    }
    expect(await waiting).toMatchObject({ state: 'timeout' });
    const gaps = beats.slice(1).map((beat, i) => beat - beats[i]);
    expect(beats.at(-1)! - started).toBeGreaterThan(1700_000); // Still beating near the end of the half hour.
    expect(Math.max(...gaps)).toBeLessThan(IDLE_STALE_MS);
  } finally { setSystemTime(); }
}, 120_000);

test('run announces changes at once, repeats every 30 seconds, and greets channels as they open', () => {
  const agent = room();
  let now = T;
  const sent: string[][] = [[], [], []];
  const channel = (i: number, readyState = 'open') => ({ readyState, send: (text: string) => { if (i === 2) throw new Error('closing'); sent[i].push(text); } });
  const channels = [channel(0), channel(1, 'connecting'), channel(2)];
  const announcer = activityAnnouncer(agent, () => [...channels, undefined], () => now);
  announcer.tick();
  expect(sent[0]).toEqual([]); // Nothing before the agent's first listen.
  agent.recordActivity('idle', undefined, T - 5000);
  announcer.tick(); now += 1000; announcer.tick();
  expect(sent[0].length).toBe(1);
  expect(sent[1]).toEqual([]);
  expect(JSON.parse(sent[0][0])).toEqual({ kind: 'activity', roomId, at: T, state: 'idle', since: T - 5000, heartbeat: T - 5000 });
  agent.touchActivity(T + 500); now += 1000; announcer.tick();
  expect(sent[0].length).toBe(1); // A heartbeat alone waits for the next repeat.
  now = T + 30_000; announcer.tick();
  expect(sent[0].length).toBe(2);
  expect(JSON.parse(sent[0][1])).toMatchObject({ heartbeat: T + 500, at: T + 30_000 });
  const task = id();
  agent.recordActivity('working', { tasks: [task], messages: [] }, now); now += 1000; announcer.tick();
  expect(JSON.parse(sent[0][2])).toMatchObject({ state: 'working', on: { tasks: [task] } });
  const opened = channel(1); announcer.opened(opened);
  expect(sent[1].length).toBe(1);
  expect(sent[0].length).toBe(3);
});
