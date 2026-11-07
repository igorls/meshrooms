import { afterEach, expect, test } from 'bun:test';
import { LocalSource } from './local-source';
import type { RoomEvents, RoomSession } from './source';

const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'sessionStorage');
});
function session(token?: string) {
  const values = new Map(token ? [['meshrooms:local-session', token]] : []);
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
}
function fakeFetch(handler: (path: RequestInfo | URL) => Promise<Response>) {
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect });
}

test('a late successful request cannot revive a session another request rejected', async () => {
  session('test-session');
  let finish!: (value: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  fakeFetch(async path => String(path).includes('/agents')
    ? Response.json({ error: 'Expired' }, { status: 401 }) : pending);
  const source = new LocalSource();
  const late = source.agents.harnesses();
  await expect(source.agents.list()).rejects.toMatchObject({ status: 401 });
  finish(Response.json({ harnesses: [] }));
  await expect(late).rejects.toMatchObject({ status: 401 });
  expect(sessionStorage.getItem('meshrooms:local-session')).toBeNull();
});

test('an unusable one-time sign-in link asks for a fresh app link', async () => {
  session();
  fakeFetch(async () => Response.json({ error: 'Ticket expired' }, { status: 400 }));
  await expect(new LocalSource('expired-test-ticket').start()).rejects.toMatchObject({ status: 401 });
});

test('a lost sign-in response never leaves an endlessly retrying consumed ticket', async () => {
  session();
  fakeFetch(async () => { throw new TypeError('Network unavailable'); });
  await expect(new LocalSource('unconfirmed-test-ticket').start()).rejects.toMatchObject({ status: 401 });
});

test('a message deleted in an older page already loaded changes without a reload', async () => {
  session('test-session');
  const roomId = crypto.randomUUID();
  const note = (text: string, at: number) => ({ packet: { body: { kind: 'message', roomId, id: crypto.randomUUID(), deviceId: 'd', memberId: 'm', text, at }, signature: '' }, targets: [], receipts: [] });
  const gone = note('the secret', 1), kept = note('older', 2), newest = note('newest', 3);
  let deleted: string[] = [], changed: (() => void) | undefined;
  const view = (messages: unknown[], more: boolean) => Response.json({ roomId, origin: 'http://127.0.0.1', title: 'Room', state: 'joined', memberId: 'm',
    status: { memberId: 'm', devices: [], connected: [], activity: {} }, messages, deleted, more, taskOps: [], decisionOps: [], reactions: [], files: {}, read: { at: 0 } });
  fakeFetch(async path => {
    const url = String(path);
    if (url.includes('/events')) {
      if (url.includes('after=&')) return Response.json({ cursor: 'c.0', events: [] });
      await new Promise<void>(resolve => { changed = resolve; });
      return Response.json({ cursor: 'c.1', events: [{ type: 'room', roomId }] });
    }
    return url.includes('before=') ? view([gone, kept], false) : view([newest], true);
  });
  let shown: any[] = [], room: RoomSession | undefined;
  const events = new Proxy({}, { get: (_, name) => name === 'ready' ? (next: RoomSession) => { room = next; } : name === 'messages' ? (next: unknown[]) => { shown = next; } : () => {} }) as RoomEvents;
  const until = async (look: () => unknown) => { for (let i = 0; i < 200 && !look(); i++) await Bun.sleep(10); expect(look()).toBeTruthy(); };
  const opened = new LocalSource().open(roomId, 'local', events);
  await until(() => shown.length === 1);
  await room!.loadOlder();
  expect(shown.map(m => m.packet.body.text)).toEqual(['the secret', 'older', 'newest']);
  // Another device deletes it: only the newest window is read again, and it says what went from the pages before it.
  deleted = [gone.packet.body.id];
  await until(() => changed);
  changed!();
  await until(() => shown[0].retracted);
  expect(shown.map(m => m.packet.body.text)).toEqual(['', 'older', 'newest']);
  expect(JSON.stringify(shown)).not.toContain('the secret');
  opened.dispose();
});
