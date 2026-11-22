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

test('LocalSource merges displaced messages on window advance, loads older-page files, and revokes Blob URLs', async () => {
  session('test-session');
  const roomId = crypto.randomUUID();
  const shaOlder = 'a'.repeat(64), shaLive = 'b'.repeat(64);
  const note = (text: string, at: number, sha?: string) => ({
    packet: {
      body: {
        kind: 'message', roomId, id: crypto.randomUUID(), deviceId: 'd', memberId: 'm', text, at,
        ...(sha ? { attachments: [{ id: crypto.randomUUID(), name: `${text}.png`, type: 'image/png', size: 4, sha256: sha }] } : {}),
      },
      signature: '',
    },
    targets: [], receipts: [],
  });
  const m1 = note('m1', 1, shaOlder), m2 = note('m2', 2), m3 = note('m3', 3, shaLive), m4 = note('m4', 4), m5 = note('m5', 5);
  let windowMsgs = [m2, m3], windowMore = true, windowFiles: Record<string, { held: boolean }> = { [shaLive]: { held: true } };
  let changed: (() => void) | undefined;
  const createdUrls: string[] = [], revokedUrls: string[] = [];
  const origCreate = URL.createObjectURL, origRevoke = URL.revokeObjectURL;
  let seq = 0;
  URL.createObjectURL = () => { const u = `blob:test-${++seq}`; createdUrls.push(u); return u; };
  URL.revokeObjectURL = (u: string) => { revokedUrls.push(u); };
  const makeView = (messages: unknown[], more: boolean, files: Record<string, { held: boolean }>) => Response.json({
    roomId, origin: 'http://127.0.0.1', title: 'Room', state: 'joined', memberId: 'm',
    status: { memberId: 'm', devices: [], connected: [], activity: {} },
    messages, deleted: [], more, taskOps: [], decisionOps: [], reactions: [], files, read: { at: 0 },
  });
  fakeFetch(async path => {
    const url = String(path);
    if (url.includes('/events')) {
      if (url.includes('after=&')) return Response.json({ cursor: 'c.0', events: [] });
      await new Promise<void>(resolve => { changed = resolve; });
      return Response.json({ cursor: `c.${++seq}`, events: [{ type: 'room', roomId }] });
    }
    if (url.includes('/files/') && url.endsWith('/want')) return Response.json({ ok: true });
    if (url.includes('/files/') || url.includes('/avatars/')) return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'Content-Type': 'image/png' } });
    if (url.includes('before=')) return makeView([m1], false, { [shaOlder]: { held: true } });
    return makeView(windowMsgs, windowMore, windowFiles);
  });
  let shown: any[] = [], fileView: Record<string, any> = {}, room: RoomSession | undefined;
  const events = new Proxy({}, {
    get: (_, name) => name === 'ready' ? (next: RoomSession) => { room = next; }
      : name === 'messages' ? (next: unknown[]) => { shown = next; }
      : name === 'files' ? (next: Record<string, any>) => { fileView = next; }
      : () => {},
  }) as RoomEvents;
  const until = async (look: () => unknown) => { for (let i = 0; i < 200 && !look(); i++) await Bun.sleep(10); expect(look()).toBeTruthy(); };
  const source = new LocalSource();
  const opened = source.open(roomId, 'local', events);
  try {
    await until(() => shown.length === 2 && !!fileView[shaLive]?.url);
    const liveUrl = fileView[shaLive].url;
    // Load older page: m1 and its older-page attachment shaOlder should appear and resolve to a Blob URL.
    await room!.loadOlder();
    await until(() => !!fileView[shaOlder]?.url);
    const olderUrl = fileView[shaOlder].url;
    expect(shown.map(m => m.packet.body.text)).toEqual(['m1', 'm2', 'm3']);
    // Sliding window advances past m2 to [m3, m4], then [m4, m5]: displaced m2 and m3 stay merged in older with zero holes!
    windowMsgs = [m3, m4];
    await until(() => changed);
    changed!(); changed = undefined;
    await until(() => shown.length === 4);
    expect(shown.map(m => m.packet.body.text)).toEqual(['m1', 'm2', 'm3', 'm4']);
    // Evict shaLive on the daemon side (held: false) while advancing window to [m4, m5]: its Blob URL must be revoked.
    windowMsgs = [m4, m5];
    windowFiles = { [shaLive]: { held: false } };
    await until(() => changed);
    changed!(); changed = undefined;
    await until(() => shown.length === 5);
    expect(shown.map(m => m.packet.body.text)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(revokedUrls).toContain(liveUrl);

    // Avatar replacement revokes the previous hash's Blob URL.
    let avatarLoads = 0;
    source.avatar(roomId, 'm', 'hash1', () => { avatarLoads++; });
    await until(() => avatarLoads === 1);
    const avatar1 = source.avatar(roomId, 'm', 'hash1', () => {})!;
    expect(avatar1).toBeTruthy();
    source.avatar(roomId, 'm', 'hash2', () => { avatarLoads++; });
    await until(() => avatarLoads === 2);
    const avatar2 = source.avatar(roomId, 'm', 'hash2', () => {})!;
    expect(revokedUrls).toContain(avatar1);

    // Disposing revokes all remaining file and room avatar Blob URLs.
    opened.dispose();
    expect(revokedUrls).toContain(olderUrl);
    expect(revokedUrls).toContain(avatar2);
  } finally {
    opened.dispose();
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  }
});

test('LocalSource enables hasOlder when a non-overlapping window advance sets view.more with empty older', async () => {
  session('test-session');
  const roomId = crypto.randomUUID();
  const note = (text: string, at: number) => ({ packet: { body: { kind: 'message', roomId, id: crypto.randomUUID(), deviceId: 'd', memberId: 'm', text, at }, signature: '' }, targets: [], receipts: [] });
  let windowMsgs = [note('first', 1)], windowMore = false, changed: (() => void) | undefined, seq = 0;
  fakeFetch(async path => {
    const url = String(path);
    if (url.includes('/events')) {
      if (url.includes('after=&')) return Response.json({ cursor: 'c.0', events: [] });
      await new Promise<void>(resolve => { changed = resolve; });
      return Response.json({ cursor: `c.${++seq}`, events: [{ type: 'room', roomId }] });
    }
    return Response.json({
      roomId, origin: 'http://127.0.0.1', title: 'Room', state: 'joined', memberId: 'm',
      status: { memberId: 'm', devices: [], connected: [], activity: {} },
      messages: windowMsgs, deleted: [], more: windowMore, taskOps: [], decisionOps: [], reactions: [], files: {}, read: { at: 0 },
    });
  });
  let shown: any[] = [], room: RoomSession | undefined;
  const events = new Proxy({}, {
    get: (_, name) => name === 'ready' ? (next: RoomSession) => { room = next; }
      : name === 'messages' ? (next: unknown[]) => { shown = next; } : () => {},
  }) as RoomEvents;
  const until = async (look: () => unknown) => { for (let i = 0; i < 200 && !look(); i++) await Bun.sleep(10); expect(look()).toBeTruthy(); };
  const opened = new LocalSource().open(roomId, 'local', events);
  try {
    await until(() => shown.length === 1);
    expect(room!.hasOlder()).toBe(false);
    // Window jumps completely past the initial message and reports more = true.
    windowMsgs = [note('after-gap', 600)];
    windowMore = true;
    await until(() => changed);
    changed!();
    await until(() => shown[0]?.packet.body.text === 'after-gap');
    expect(room!.hasOlder()).toBe(true);
  } finally {
    opened.dispose();
  }
});

test('LocalSource auto-fetches only raster images and fetches non-images on demand via requestFile (SEC-11)', async () => {
  session('test-session');
  const roomId = crypto.randomUUID();
  const imgSha = '1'.repeat(64), pdfSha = '2'.repeat(64);
  const msg = {
    packet: {
      body: {
        kind: 'message', roomId, id: crypto.randomUUID(), deviceId: 'd', memberId: 'm', text: 'files', at: 1,
        attachments: [
          { id: crypto.randomUUID(), name: 'photo.png', type: 'image/png', size: 100, sha256: imgSha },
          { id: crypto.randomUUID(), name: 'spec.pdf', type: 'application/pdf', size: 500, sha256: pdfSha },
        ],
      },
      signature: '',
    },
    targets: [], receipts: [],
  };
  const wantedPaths: string[] = [];
  fakeFetch(async path => {
    const url = String(path);
    if (url.includes('/events')) {
      if (url.includes('after=&')) return Response.json({ cursor: 'c.0', events: [] });
      return new Promise(() => {});
    }
    if (url.endsWith('/want')) {
      wantedPaths.push(url);
      return Response.json({ ok: true });
    }
    return Response.json({
      roomId, origin: 'http://127.0.0.1', title: 'Room', state: 'joined', memberId: 'm',
      status: { memberId: 'm', devices: [], connected: [], activity: {} },
      messages: [msg], deleted: [], more: false, taskOps: [], decisionOps: [], reactions: [],
      files: { [imgSha]: { held: false }, [pdfSha]: { held: false } }, read: { at: 0 },
    });
  });
  let fileView: Record<string, any> = {}, room: RoomSession | undefined;
  const events = new Proxy({}, {
    get: (_, name) => name === 'ready' ? (next: RoomSession) => { room = next; }
      : name === 'files' ? (next: Record<string, any>) => { fileView = next; } : () => {},
  }) as RoomEvents;
  const until = async (look: () => unknown) => { for (let i = 0; i < 200 && !look(); i++) await Bun.sleep(10); expect(look()).toBeTruthy(); };
  const opened = new LocalSource().open(roomId, 'local', events);
  try {
    await until(() => wantedPaths.some(p => p.includes(imgSha)));
    await Bun.sleep(30);
    // Only the raster image was auto-wanted; the PDF was NOT auto-fetched.
    expect(wantedPaths.some(p => p.includes(imgSha))).toBe(true);
    expect(wantedPaths.some(p => p.includes(pdfSha))).toBe(false);
    expect(fileView[pdfSha]?.transfer).toBeUndefined();
    // Clicking Download calls requestFile(pdfSha), immediately marking it waiting and posting /want.
    room!.requestFile(pdfSha);
    expect(fileView[pdfSha]?.transfer).toEqual({ state: 'waiting' });
    await until(() => wantedPaths.some(p => p.includes(pdfSha)));
  } finally {
    opened.dispose();
  }
});
