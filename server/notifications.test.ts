import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { authorizeBinding, daemonDir } from './agent-daemon';
import { WATCH_CONFIG, WATCH_STATE } from './agent-watch';
import { AGENTS_FILE, fileApproval, identityHome } from './agents';
import { PERSON_STATUS_FILE, personStatusOf } from './browser-agent';
import { localControlToken, readLocalApi, startLocalApi } from './local-api';
import {
  CAP_PER_MINUTE, COALESCE_MS, NOTIFY_FILE, NotificationWatch, Notifier, PREVIEW_POINTS, compose, notifyLevel, plainLine, preview, setNotifyLevel, type NotifyItem,
} from './notifications';
import { initPerson, recordPersonRoom } from './person';
import { testDirectory } from './test-directory';

const cleanups: (() => void)[] = [];
const until = async <T>(look: () => T | undefined | false, ms = 5_000) => {
  for (const by = Date.now() + ms; Date.now() < by; await Bun.sleep(25)) { const seen = look(); if (seen) return seen; }
  throw new Error('timed out');
};
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
// The daemon's folder (where bindings are trusted) and the registry move to a folder of this file's own.
const keys = ['MESHROOMS_AGENT_REGISTRY', 'MESHROOMS_DAEMON_DIR', 'MESHROOMS_PERSON_HOME'] as const;
let sandbox: { dir: ReturnType<typeof testDirectory>; saved: (string | undefined)[] } | undefined;
beforeAll(() => {
  const dir = testDirectory('notifications-home');
  sandbox = { dir, saved: keys.map(key => process.env[key]) };
  for (const key of keys) delete process.env[key];
  process.env.MESHROOMS_AGENT_REGISTRY = join(dir.path, 'agent-homes.json');
});
afterAll(() => {
  keys.forEach((key, i) => { if (sandbox!.saved[i] === undefined) delete process.env[key]; else process.env[key] = sandbox!.saved[i]; });
  sandbox?.dir.cleanup();
});

const roomId = crypto.randomUUID(), other = crypto.randomUUID(), me = crypto.randomUUID(), alex = crypto.randomUUID(), wren = crypto.randomUUID();
const mention = (text: string, room = roomId, title = 'Launch'): NotifyItem => ({ kind: 'mention', roomId: room, room: title, sender: 'Alex', text });
/** A clock the test moves. */
const clock = (start = 1_000_000) => { let now = start; return { now: () => now, at: (ms: number) => { now = ms; }, tick: (ms: number) => { now += ms; } }; };

test('one entry per room per 30 s: the first goes at once, what follows is merged into one when the window ends', () => {
  const time = clock(), notifier = new Notifier(time.now);
  const start = notifier.since('').cursor;
  notifier.add(mention('@Robin can you look?'));
  let read = notifier.since(start);
  expect(read.notifications).toEqual([expect.objectContaining({ title: 'Launch', body: 'Alex mentioned you: @Robin can you look?', count: 1, target: { kind: 'room', roomId } })]);
  // Two more mentions and a reply within the window: held.
  time.tick(1_000); notifier.add(mention('@Robin one'));
  time.tick(1_000); notifier.add(mention('@Robin two'));
  time.tick(1_000); notifier.add({ kind: 'reply', roomId, room: 'Launch', sender: 'Wren', text: 'Done' });
  notifier.flush();
  expect(notifier.since(read.cursor).notifications).toEqual([]);
  // Another room is its own: it goes at once.
  notifier.add(mention('@Robin elsewhere', other, 'Ops'));
  read = notifier.since(read.cursor);
  expect(read.notifications.map(n => n.title)).toEqual(['Ops']);
  // The window ends: one entry for what came, with counts.
  time.at(1_000_000 + COALESCE_MS - 1); notifier.flush();
  expect(notifier.since(read.cursor).notifications).toEqual([]);
  time.at(1_000_000 + COALESCE_MS); notifier.flush();
  read = notifier.since(read.cursor);
  expect(read.notifications).toEqual([expect.objectContaining({ title: 'Launch', body: '2 new mentions and 1 reply to you in Launch', count: 3, target: { kind: 'room', roomId } })]);
  // A quiet room is ready again after its window: the next one goes at once.
  time.tick(COALESCE_MS); notifier.add(mention('@Robin later'));
  expect(notifier.since(read.cursor).notifications.map(n => n.body)).toEqual(['Alex mentioned you: @Robin later']);
});

test('at most ten entries a minute across all rooms; the rest wait, merged, and go as the minute allows', () => {
  const time = clock(), notifier = new Notifier(time.now), start = notifier.since('').cursor;
  const rooms = Array.from({ length: 14 }, () => crypto.randomUUID());
  for (const room of rooms) notifier.add(mention('@Robin hi', room, `Room ${room.slice(0, 4)}`));
  // A second burst in the first rooms merges into what waits there.
  for (const room of rooms) notifier.add(mention('@Robin again', room, `Room ${room.slice(0, 4)}`));
  let read = notifier.since(start);
  expect(read.notifications).toHaveLength(CAP_PER_MINUTE);
  time.tick(30_000); notifier.flush();
  expect(notifier.since(read.cursor).notifications).toHaveLength(0);
  time.tick(30_000); notifier.flush();
  read = notifier.since(read.cursor);
  // The minute passed: the four rooms that never got one go first (they waited longest), each merged.
  expect(read.notifications).toHaveLength(CAP_PER_MINUTE);
  expect(read.notifications.slice(0, 4).map(n => n.target)).toEqual(rooms.slice(10).map(roomId => ({ kind: 'room', roomId })));
  expect(read.notifications[0].body).toBe(`2 new mentions in Room ${rooms[10].slice(0, 4)}`);
  // Never more than the cap in any minute.
  time.tick(1_000); notifier.flush();
  expect(notifier.since(read.cursor).notifications).toHaveLength(0);
});

test('the feed cursor: none starts at the end, another daemon\'s or an unknown one resets, and only the last entries are kept', () => {
  const time = clock(), notifier = new Notifier(time.now);
  expect(notifier.since('')).toEqual({ cursor: `${notifier.epoch}.0`, notifications: [] });
  expect(notifier.since('deadbeef.0')).toMatchObject({ reset: true });
  expect(notifier.since(`${notifier.epoch}.5`)).toMatchObject({ reset: true });
  expect(() => notifier.since('nonsense')).toThrow('cursor');
  for (let i = 0; i < 250; i++) { time.tick(60_000); notifier.add(mention('@Robin', crypto.randomUUID())); }
  expect(notifier.since(`${notifier.epoch}.1`)).toMatchObject({ reset: true });
  expect(notifier.since(`${notifier.epoch}.240`).notifications).toHaveLength(10);
});

test('what a notification shows: plain text, a name and at most 80 code points, no controls, bidi, paths or file names', () => {
  expect(plainLine('Plan\u202Egnp.exe\u202C room\r\nnext\u2028line\u0007', 60)).toBe('Plangnp.exe room next line');
  expect(plainLine('a\u200Bb\u2066c\u2069d\uFE0Fe\u{E0041}f', 60)).toBe('abcdef');
  const long = '😀'.repeat(200), shown = preview(long);
  expect(Array.from(shown)).toHaveLength(PREVIEW_POINTS);
  expect(shown.endsWith('…')).toBe(true);
  expect(preview('see C:\\Users\\Jane Doe\\secret\\plan.txt, then /home/jane/notes.md')).toBe('see <path>, then <path>');
  expect(preview('https://example.com/a/b stays')).toBe('https://example.com/a/b stays');
  // An attachment-only message has no text (shownText): the file is never named.
  expect(compose([{ kind: 'message', roomId, room: 'Launch', sender: 'Alex', text: '' }], { message: 1 }, 1).body).toBe('Alex sent a file.');
  expect(compose([{ kind: 'mention', roomId, room: 'Lau\u202Ench', sender: 'Al\u0000ex', text: '@Robin' }], { mention: 1 }, 1)).toMatchObject({ title: 'Launch', body: 'Al ex mentioned you: @Robin' });
  expect(compose([{ kind: 'request', roomId, room: null, name: '', agent: true }], { request: 1 }, 1)).toMatchObject({ title: 'Meshrooms', body: 'An agent, an agent, is waiting to join.' });
  expect(compose([{ kind: 'agent', roomId, room: 'Launch', agent: 'Wren', state: 'approval-wall', reason: 'the wake stopped for an approval in /home/jane/x' }], { agent: 1 }, 1))
    .toEqual({ title: 'Wren needs attention', body: 'It stopped for an approval in Launch: the wake stopped for an approval in <path>', count: 1, target: { kind: 'review' } });
  expect(compose([{ kind: 'approval', approval: 'identity', name: 'Fern' }], { approval: 1 }, 1)).toMatchObject({ title: 'Approval waiting', target: { kind: 'app' } });
  expect(compose([{ kind: 'approval', approval: 'identity', name: 'Fern' }, { kind: 'approval', approval: 'identity', name: 'Oak' }], { approval: 2 }, 2))
    .toMatchObject({ title: '2 approvals waiting', target: { kind: 'app' } });
});

/** A person in one room they host, its runner's files written as a runner would: the roster and a little history. */
async function hostedRoom() {
  const dir = testDirectory('notifications'); cleanups.push(dir.cleanup);
  const home = join(dir.path, 'person');
  await initPerson(home);
  const agent = recordPersonRoom({ roomId, origin: 'http://127.0.0.1:1', kind: 'person', name: 'Robin', joinedAt: 1_000 }, home);
  writeFileSync(join(agent.dir, 'members.json'), JSON.stringify({ memberId: me, ownerId: me, title: 'Launch', members: [
    { id: alex, name: 'Alex', role: 'human' }, { id: me, name: 'Robin', role: 'human' }, { id: wren, name: 'Wren', role: 'agent', operatorId: me }], devices: [] }));
  const message = (memberId: string, text: string, extra: Record<string, unknown> = {}) =>
    ({ packet: { body: { kind: 'message', roomId, id: crypto.randomUUID(), deviceId: 'a'.repeat(64), memberId, text, at: Date.now(), ...extra }, signature: 'x' }, targets: [], receipts: [] });
  const mine = message(me, 'My plan');
  const history: unknown[] = [message(alex, 'Hello'), mine];
  writeFileSync(join(agent.dir, 'messages.json'), JSON.stringify(history));
  const add = (...more: unknown[]) => { history.push(...more); writeFileSync(join(agent.dir, 'messages.json'), JSON.stringify(history)); };
  return { dir: dir.path, home, agent, message, mine, add };
}

test('messages: a mention or a reply to the person notifies; plain ones only in a room set to all; none in one set to off, or their own', async () => {
  const room = await hostedRoom(), time = clock(), watch = new NotificationWatch(room.home, time.now);
  const { EventFeed } = await import('./local-api');
  const feed = new EventFeed(room.home);
  feed.onEvent(event => watch.event(event));
  feed.poll();
  const start = watch.notifier.since('').cursor;
  // What was there at the start is the baseline.
  expect(watch.notifier.since(start).notifications).toEqual([]);
  room.add(room.message(alex, 'just chatting'), room.message(me, '@Robin talking to myself'));
  feed.poll();
  expect(watch.notifier.since(start).notifications).toEqual([]);
  room.add(room.message(alex, '@Robin can you look at the plan?'));
  feed.poll();
  let read = watch.notifier.since(start);
  expect(read.notifications).toEqual([expect.objectContaining({ title: 'Launch', body: 'Alex mentioned you: @Robin can you look at the plan?', target: { kind: 'room', roomId } })]);
  // A reply to the person's message, the next window.
  time.tick(COALESCE_MS);
  room.add(room.message(wren, 'Looks good', { replyTo: room.mine.packet.body.id }));
  feed.poll();
  read = watch.notifier.since(read.cursor);
  expect(read.notifications.map(n => n.body)).toEqual(['Wren replied: Looks good']);
  // All messages, then off: the person's own setting, in the person folder.
  expect(notifyLevel(room.home, roomId)).toBe('mentions');
  setNotifyLevel(room.home, roomId, 'all');
  time.tick(COALESCE_MS);
  room.add(room.message(alex, 'plain news'));
  feed.poll();
  read = watch.notifier.since(read.cursor);
  expect(read.notifications.map(n => n.body)).toEqual(['Alex: plain news']);
  setNotifyLevel(room.home, roomId, 'off');
  time.tick(COALESCE_MS);
  room.add(room.message(alex, '@Robin are you there?'));
  feed.poll();
  expect(watch.notifier.since(read.cursor).notifications).toEqual([]);
  expect(JSON.parse(readFileSync(join(room.home, NOTIFY_FILE), 'utf8'))).toEqual({ rooms: { [roomId]: 'off' } });
  // Back to the default: the entry goes.
  setNotifyLevel(room.home, roomId, 'mentions');
  expect(JSON.parse(readFileSync(join(room.home, NOTIFY_FILE), 'utf8'))).toEqual({ rooms: {} });
  expect(() => setNotifyLevel(room.home, roomId, 'loud')).toThrow('level');
  expect(() => setNotifyLevel(room.home, crypto.randomUUID(), 'all')).toThrow('not in that room');
});

test('someone waiting for the person as host notifies once per request, a guest\'s agent too; a device being paired does not', async () => {
  const room = await hostedRoom(), time = clock(), watch = new NotificationWatch(room.home, time.now), start = watch.notifier.since('').cursor;
  const status = (requests: { id: string; kind: string; name: string; state: string }[], ownerId = me) => writeFileSync(join(room.agent.dir, PERSON_STATUS_FILE),
    JSON.stringify(personStatusOf({ roomId, title: 'Launch', epoch: 'e', hostOnline: true, memberId: me, ownerId, deviceId: 'b'.repeat(64), requests: requests as never }, [], {})));
  const sam = crypto.randomUUID(), bot = crypto.randomUUID(), pairing = crypto.randomUUID();
  status([{ id: sam, kind: 'person', name: 'Sam', state: 'pending' }, { id: pairing, kind: 'companion', name: 'Companion device', state: 'pending' }]);
  watch.poll();
  let read = watch.notifier.since(start);
  expect(read.notifications).toEqual([expect.objectContaining({ title: 'Launch', body: 'Sam asked to join.', target: { kind: 'room', roomId } })]);
  // The same request again is no news; a guest's agent is, in the next window.
  time.tick(COALESCE_MS);
  status([{ id: sam, kind: 'person', name: 'Sam', state: 'pending' }, { id: bot, kind: 'agent', name: 'Helper', state: 'pending' }]);
  watch.poll();
  read = watch.notifier.since(read.cursor);
  expect(read.notifications.map(n => n.body)).toEqual(['Helper, an agent, is waiting to join.']);
  // In a room the person doesn't host, requests are the host's business.
  time.tick(COALESCE_MS);
  status([{ id: crypto.randomUUID(), kind: 'person', name: 'Kim', state: 'pending' }], alex);
  watch.poll();
  expect(watch.notifier.since(read.cursor).notifications).toEqual([]);
});

/** An identity of the person's in the room, bound to a new exec session, its folder as the daemon would leave it. */
function boundIdentity(home: string, name = 'Wren') {
  const id = crypto.randomUUID(), dir = join(identityHome(home, id), 'browser-agents', roomId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'room.json'), JSON.stringify({ origin: 'http://127.0.0.1:1', roomId }));
  writeFileSync(join(dir, 'members.json'), JSON.stringify({ memberId: wren, title: 'Launch', members: [], devices: [] }));
  writeFileSync(join(dir, 'runner-alive.json'), JSON.stringify({ at: Date.now() }));
  const config = { roomId, harness: 'exec', command: 'agent {prompt_file}', cwd: dir, generation: crypto.randomUUID(), enabled: true };
  authorizeBinding(dir, config, daemonDir());
  writeFileSync(join(dir, WATCH_CONFIG), JSON.stringify(config));
  const identities = (() => { try { return JSON.parse(readFileSync(join(home, AGENTS_FILE), 'utf8')); } catch { return []; } })();
  writeFileSync(join(home, AGENTS_FILE), JSON.stringify([...identities, { id, name, harness: 'exec', command: 'agent {prompt_file}', createdAt: 1, bound: { [roomId]: { kind: 'new', state: 'bound', at: 1 } } }]));
  return { id, dir };
}

test('an agent the person operates that its watcher pauses at an approval wall or halts notifies once, leading to Review; what stood at the start does not', async () => {
  const room = await hostedRoom(), time = clock();
  const wrenAgent = boundIdentity(room.home), oak = boundIdentity(room.home, 'Oak');
  // Oak was halted before the daemon started: the start notice lists it, this does not.
  writeFileSync(join(oak.dir, WATCH_STATE), JSON.stringify({ wakes: [], noProgress: 0, halted: { reason: 'the session ownership broke', at: 1 } }));
  const watch = new NotificationWatch(room.home, time.now), start = watch.notifier.since('').cursor;
  watch.poll();
  expect(watch.notifier.since(start).notifications).toEqual([]);
  writeFileSync(join(wrenAgent.dir, WATCH_STATE), JSON.stringify({ wakes: [], noProgress: 0, paused: { reason: 'the wake stopped for an approval with no one to answer', at: 2, hard: true } }));
  for (let i = 0; i < 5; i++) watch.poll();
  const read = watch.notifier.since(start);
  expect(read.notifications).toEqual([{ seq: 1, at: expect.any(String), title: 'Wren needs attention', count: 1, target: { kind: 'review' },
    body: 'It stopped for an approval in Launch: the wake stopped for an approval with no one to answer' }]);
  // Still paused: no news.
  for (let i = 0; i < 10; i++) { time.tick(COALESCE_MS); watch.poll(); }
  expect(watch.notifier.since(read.cursor).notifications).toEqual([]);
});

test('a binding changed outside watch (no longer trusted) notifies once; a breach pause is kept in the agent\'s record', async () => {
  const room = await hostedRoom(), time = clock(), wrenAgent = boundIdentity(room.home);
  const watch = new NotificationWatch(room.home, time.now), start = watch.notifier.since('').cursor;
  watch.poll();
  // Someone edits watch.json behind watch's back: the daemon reads it as off, untrusted.
  const config = JSON.parse(readFileSync(join(wrenAgent.dir, WATCH_CONFIG), 'utf8'));
  writeFileSync(join(wrenAgent.dir, WATCH_CONFIG), JSON.stringify({ ...config, command: 'calc {prompt_file}' }));
  for (let i = 0; i < 5; i++) watch.poll();
  const read = watch.notifier.since(start);
  expect(read.notifications).toEqual([expect.objectContaining({ title: 'Wren needs attention', body: 'It stopped waking: its binding was changed outside Meshrooms, in Launch.', target: { kind: 'review' } })]);
  // A breach pause of the binding as it now stands is recorded with the agent, whatever is done to its wakes later.
  const other = boundIdentity(room.home, 'Oak'), generation = JSON.parse(readFileSync(join(other.dir, WATCH_CONFIG), 'utf8')).generation;
  writeFileSync(join(other.dir, WATCH_STATE), JSON.stringify({ wakes: [], noProgress: 0, paused: { reason: 'the wake reached outside the room', at: 77, hard: true, generation } }));
  for (let i = 0; i < 5; i++) watch.poll();
  await until(() => JSON.parse(readFileSync(join(room.home, AGENTS_FILE), 'utf8')).find((i: { name: string }) => i.name === 'Oak').bound[roomId].held);
  expect(JSON.parse(readFileSync(join(room.home, AGENTS_FILE), 'utf8')).find((i: { name: string }) => i.name === 'Oak').bound[roomId].held)
    .toEqual({ kind: 'hard-pause', reason: 'the wake reached outside the room', at: 77 });
});

test('the feed long-polls: a wait ends at the next entry, or empty at its time; waits are capped', async () => {
  const time = clock(), notifier = new Notifier(time.now), start = notifier.since('').cursor;
  const waiting = notifier.wait(start, 5_000);
  await Bun.sleep(20);
  expect(notifier.waiting).toBe(1);
  notifier.add(mention('@Robin now'));
  expect((await waiting).notifications.map(n => n.body)).toEqual(['Alex mentioned you: @Robin now']);
  const cursor = notifier.since(start).cursor;
  const began = Date.now();
  expect(await notifier.wait(cursor, 100)).toEqual({ cursor, notifications: [] });
  expect(Date.now() - began).toBeGreaterThanOrEqual(90);
  // Another daemon's cursor answers at once, and so does no cursor.
  expect(await notifier.wait('deadbeef.0', 5_000)).toMatchObject({ reset: true });
  expect(await notifier.wait('', 5_000)).toMatchObject({ notifications: [] });
  const aborted = new AbortController(), held = [1, 2, 3, 4].map(() => notifier.wait(cursor, 5_000, aborted.signal));
  await Bun.sleep(20);
  await expect(notifier.wait(cursor, 5_000)).rejects.toThrow('Too many');
  aborted.abort();
  await Promise.all(held);
  expect(notifier.waiting).toBe(0);
});

test('a request waiting for approval in the app notifies once, leading to the app', async () => {
  const room = await hostedRoom(), time = clock(), watch = new NotificationWatch(room.home, time.now), start = watch.notifier.since('').cursor;
  watch.poll();
  await fileApproval({ kind: 'identity', name: 'Fern', harness: 'claude' }, room.home);
  for (let i = 0; i < 5; i++) watch.poll();
  const read = watch.notifier.since(start);
  expect(read.notifications).toEqual([expect.objectContaining({ title: 'Approval waiting', body: 'An agent asks for a new agent, Fern. Approve or reject it in the Meshrooms app.', target: { kind: 'app' } })]);
  for (let i = 0; i < 10; i++) { time.tick(COALESCE_MS); watch.poll(); }
  expect(watch.notifier.since(read.cursor).notifications).toEqual([]);
});

test('the feed is the app\'s: the control token reads it, the page is refused; the page may set its rooms\' levels', async () => {
  const room = await hostedRoom(), daemon = join(room.dir, 'daemon');
  const api = startLocalApi({ dir: daemon, home: room.home, port: 0, log: () => {} });
  cleanups.push(() => api.stop());
  const base = `http://127.0.0.1:${api.port}`, control = { Authorization: `Bearer ${localControlToken(readLocalApi(daemon)!.secret)}` };
  const { ticket } = await (await fetch(`${base}/api/local/ticket`, { method: 'POST', headers: control })).json() as { ticket: string };
  const { token } = await (await fetch(`${base}/api/local/session`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) })).json() as { token: string };
  const page = { Authorization: `Bearer ${token}`, Origin: base };
  expect((await fetch(`${base}/api/local/notifications`, { headers: page })).status).toBe(403);
  expect((await fetch(`${base}/api/local/app/review`, { headers: page })).status).toBe(403);
  expect((await fetch(`${base}/api/local/app/rooms/${roomId}/agents/${wren}/resume`, { method: 'POST', headers: page })).status).toBe(403);
  // The control token from a browser (it sends an Origin) is refused as ever.
  expect((await fetch(`${base}/api/local/notifications`, { headers: { ...control, Origin: base } })).status).toBe(403);
  const first = await (await fetch(`${base}/api/local/notifications`, { headers: control })).json() as { cursor: string; notifications: unknown[] };
  expect(first.notifications).toEqual([]);
  room.add(room.message(alex, '@Robin the release is ready'));
  api.feed.poll(); api.notifications.poll();
  const next = await (await fetch(`${base}/api/local/notifications?after=${first.cursor}`, { headers: control })).json() as { notifications: { body: string }[] };
  expect(next.notifications.map(n => n.body)).toEqual(['Alex mentioned you: @Robin the release is ready']);
  // The level, from the page.
  const set = await fetch(`${base}/api/local/rooms/${roomId}/notify`, { method: 'POST', headers: { ...page, 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'all' }) });
  expect(await set.json()).toEqual({ roomId, level: 'all' });
  expect(await (await fetch(`${base}/api/local/rooms/${roomId}/notify`, { headers: page })).json()).toEqual({ roomId, level: 'all' });
  expect((await fetch(`${base}/api/local/rooms/${roomId}/notify`, { method: 'POST', headers: { ...page, 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'x' }) })).status).toBe(400);
  expect((await fetch(`${base}/api/local/rooms/${other}/notify`, { headers: page })).status).toBe(404);
});
