import { afterEach, beforeEach, expect, test } from 'bun:test';
import { fakeStorage, installFakeIndexedDB } from './test-indexeddb';
import { BrowserApi, PROTOCOL_HEADER, PROTOCOL_VERSION, UPGRADE_REQUIRED, type ApiError } from './client';
import { BrowserSource } from './source';

installFakeIndexedDB();

const originalFetch = globalThis.fetch;
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');

beforeEach(() => {
  fakeStorage.records.clear();
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://meshrooms.example' } });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
  else Reflect.deleteProperty(globalThis, 'location');
});

function fakeFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect });
}

test('BrowserApi preserves HTTP status on non-JSON proxy 429 and 502 responses instead of failing JSON parsing', async () => {
  const seenIds: string[] = [];
  let reply: () => Response = () => new Response('<html><body>429 Too Many Requests</body></html>', { status: 429, headers: { 'Content-Type': 'text/html' } });
  fakeFetch(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { command: { id: string } };
    seenIds.push(body.command.id);
    return reply();
  });
  const api = new BrowserApi();
  const roomId = crypto.randomUUID();
  // A proxy HTML 429 keeps status 429 (so background rooms back off) and clears the pending command id.
  await expect(api.command('create', roomId, { title: 'Work' })).rejects.toMatchObject({ status: 429, message: expect.stringContaining('Too many requests') });
  // A subsequent 502 uses a fresh id (because the 429 cleared pending), keeps status 502, and retains its id for retry.
  reply = () => new Response('<html><body>502 Bad Gateway</body></html>', { status: 502, headers: { 'Content-Type': 'text/html' } });
  await expect(api.command('create', roomId, { title: 'Work' })).rejects.toMatchObject({ status: 502 });
  reply = () => Response.json({ roomId, title: 'Work', epoch: 'e', hostOnline: true, deviceId: 'd' });
  expect(await api.command('create', roomId, { title: 'Work' })).toMatchObject({ roomId });
  expect(seenIds).toHaveLength(3);
  expect(seenIds[1]).not.toBe(seenIds[0]);
  expect(seenIds[2]).toBe(seenIds[1]);
});

test('BrowserSource.room preserves status on a non-JSON 429 response', async () => {
  fakeFetch(async () => new Response('<html>429 Too Many Requests</html>', { status: 429, headers: { 'Content-Type': 'text/html' } }));
  const source = new BrowserSource();
  await expect(source.room(crypto.randomUUID())).rejects.toMatchObject({ status: 429, message: expect.stringContaining('Too many requests') });
});

test('BrowserApi.command aborts in-flight fetch when caller signal aborts', async () => {
  let seenSignal: AbortSignal | undefined;
  fakeFetch((_input, init) => new Promise((_resolve, reject) => {
    seenSignal = init?.signal ?? undefined;
    seenSignal?.addEventListener('abort', () => reject(seenSignal!.reason ?? new DOMException('Aborted', 'AbortError')));
  }));
  const api = new BrowserApi();
  const controller = new AbortController();
  const pending = api.command('status', crypto.randomUUID(), { session: 's' }, controller.signal);
  await Bun.sleep(10);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(seenSignal?.aborted).toBe(true);
});

test('BrowserSource.open backs off exponentially on 429, wakes on visibilitychange/online, and aborts in-flight status on dispose', async () => {
  const roomId = crypto.randomUUID();
  const calls: { at: number; signal?: AbortSignal }[] = [];
  let mode: '429' | 'ok' | 'hang' = '429';
  const api = {
    command: async (_action: string, _roomId: string, _payload: Record<string, unknown>, signal?: AbortSignal) => {
      calls.push({ at: Date.now(), signal });
      if (mode === '429') throw Object.assign(new Error('Too many requests.'), { status: 429 });
      if (mode === 'hang') return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
      return { roomId, title: 'Room', epoch: 'e', hostOnline: true, deviceId: 'dev', memberId: 'm', members: [], devices: [] };
    },
  } as unknown as BrowserApi;
  const docTarget = new EventTarget();
  const doc = Object.assign(docTarget, { visibilityState: 'hidden' as 'hidden' | 'visible' });
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  const noop = () => {};
  const source = new BrowserSource(api, 200, 40);
  const opened = source.open(roomId, 'dev', {
    ready: noop, status: noop, messages: noop, network: noop, board: noop, files: noop,
    activity: noop, decisions: noop, reactions: noop, position: noop, closed: noop, recent: noop, lost: noop,
  });
  try {
    // 1st poll: 429 -> backoff 40ms (sleep 240ms). 2nd poll: 429 -> backoff 80ms (sleep 280ms).
    const waitCalls = async (n: number) => {
      for (let i = 0; i < 200 && calls.length < n; i++) await Bun.sleep(10);
      expect(calls.length).toBeGreaterThanOrEqual(n);
    };
    await waitCalls(2);
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(200);
    // Switch to OK on 3rd poll so backoff resets to 0, then verify visibilitychange wakes the 200ms timer immediately.
    mode = 'ok';
    await waitCalls(3);
    expect(calls[2].at - calls[1].at).toBeGreaterThanOrEqual(240);
    // Let the 3rd poll finish and enter sleep, then wake immediately with visibilitychange.
    await Bun.sleep(20);
    const beforeWake = calls.length;
    mode = 'hang';
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    await waitCalls(beforeWake + 1);
    const hanging = calls.at(-1)!;
    expect(hanging.signal?.aborted).toBe(false);
    // Disposing aborts the in-flight status poll immediately and resolves done cleanly.
    opened.dispose();
    await opened.done;
    expect(hanging.signal?.aborted).toBe(true);
  } finally {
    opened.dispose();
    await opened.done.catch(() => {});
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else delete (globalThis as { document?: unknown }).document;
  }
});

test('BrowserApi parses Retry-After header on 429 into ApiError.retryAfterMs (OPS-11)', async () => {
  fakeFetch(async () => new Response(JSON.stringify({ error: 'Slow down' }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '7' },
  }));
  const api = new BrowserApi();
  await expect(api.command('status', crypto.randomUUID(), { session: 's' })).rejects.toMatchObject({
    status: 429,
    retryAfterMs: 7000,
  });
});

test('BrowserApi sends X-Meshrooms-Protocol: 1 header and preserves status 426 and upgrade-required code (OPS-6)', async () => {
  const seenHeaders: HeadersInit[] = [];
  let reply: () => Response = () => new Response(
    JSON.stringify({ error: 'Please reload to upgrade your Meshrooms client.', code: UPGRADE_REQUIRED }),
    { status: 426, headers: { 'Content-Type': 'application/json' } },
  );
  fakeFetch(async (_input, init) => {
    seenHeaders.push(init?.headers ?? {});
    return reply();
  });
  const api = new BrowserApi();
  const roomId = crypto.randomUUID();
  await expect(api.command('status', roomId, { session: 's' })).rejects.toMatchObject({
    status: 426,
    code: UPGRADE_REQUIRED,
    message: 'Please reload to upgrade your Meshrooms client.',
  });
  expect((seenHeaders[0] as Record<string, string>)[PROTOCOL_HEADER]).toBe(PROTOCOL_VERSION);

  // Non-JSON 426 from a proxy still preserves status 426, upgrade-required code, and a reload fallback message.
  reply = () => new Response('<html>426 Upgrade Required</html>', { status: 426, headers: { 'Content-Type': 'text/html' } });
  await expect(api.command('create', roomId, { title: 'Work' })).rejects.toMatchObject({
    status: 426,
    code: UPGRADE_REQUIRED,
    message: expect.stringContaining('Reload'),
  });
});

test('BrowserSource.open stops polling immediately on HTTP 426 and preserves status/code on the surfaced error (OPS-6)', async () => {
  const roomId = crypto.randomUUID();
  let polls = 0;
  const networkEvents: { problem: string; error?: ApiError }[] = [];
  const api = {
    command: async () => {
      polls++;
      throw Object.assign(new Error('Reload to upgrade Meshrooms.'), { status: 426, code: UPGRADE_REQUIRED });
    },
  } as unknown as BrowserApi;
  const noop = () => {};
  const source = new BrowserSource(api, 40, 20);
  const opened = source.open(roomId, 'dev', {
    ready: noop, status: noop, messages: noop,
    network: (problem, _signIn, error) => networkEvents.push({ problem, error }),
    board: noop, files: noop, activity: noop, decisions: noop, reactions: noop, position: noop, closed: noop, recent: noop, lost: noop,
  });
  await expect(opened.done).rejects.toMatchObject({
    status: 426,
    code: UPGRADE_REQUIRED,
    message: 'Reload to upgrade Meshrooms.',
  });
  // Wait past several poll intervals to guarantee polling completely stopped.
  await Bun.sleep(150);
  expect(polls).toBe(1);
  expect(networkEvents).toHaveLength(1);
  expect(networkEvents[0]).toMatchObject({
    problem: 'Reload to upgrade Meshrooms.',
    error: { status: 426, code: UPGRADE_REQUIRED },
  });
});

test('BrowserApi bounds and prunes pending retry entries across repeated failed commands (OPS-6)', async () => {
  let clock = 1_000_000;
  const seenIds: string[] = [];
  let fail = true;
  fakeFetch(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { command: { id: string } };
    seenIds.push(body.command.id);
    if (fail) return new Response('<html>502</html>', { status: 502 });
    return Response.json({ roomId: 'r', title: 'T', epoch: 'e', hostOnline: true, deviceId: 'd' });
  });
  const api = new BrowserApi(2, 1_000, () => clock);
  const roomId = crypto.randomUUID();
  // Fill beyond maxPending=2: key1 is evicted when key3 fails.
  await expect(api.command('create', roomId, { title: 'k1' })).rejects.toMatchObject({ status: 502 });
  await expect(api.command('create', roomId, { title: 'k2' })).rejects.toMatchObject({ status: 502 });
  await expect(api.command('create', roomId, { title: 'k3' })).rejects.toMatchObject({ status: 502 });
  // Retrying k3 reuses its id (still retained), while retrying k1 mints a new id (evicted by cap).
  fail = false;
  await api.command('create', roomId, { title: 'k3' });
  expect(seenIds[3]).toBe(seenIds[2]);
  await api.command('create', roomId, { title: 'k1' });
  expect(seenIds[4]).not.toBe(seenIds[0]);
  // Advance past TTL: k2 expires and gets a fresh id on retry.
  clock += 2_000;
  await api.command('create', roomId, { title: 'k2' });
  expect(seenIds[5]).not.toBe(seenIds[1]);
});
