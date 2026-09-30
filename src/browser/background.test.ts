import { beforeEach, describe, expect, test } from 'bun:test';
import { fakeStorage, installFakeIndexedDB } from './test-indexeddb';
import { BACKGROUND_POLL_MS, BACKGROUND_ROOMS, BackgroundRoom, BackgroundRooms, RESTART_MAX_MS, Restarts, backgroundRooms, connectionLock, holdConnection } from './background';
import { claimFence, write } from './storage';

installFakeIndexedDB();

const rooms = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, title: `Room ${i}` }));

describe('background rooms', () => {
  test('keeps the most recently opened rooms no tab shows, up to the cap', () => {
    const list = rooms(14);
    const opened = { r13: 50, r2: 40, r7: 30, r0: 20 };
    const chosen = backgroundRooms(list, opened, new Set(['r2']));
    expect(chosen).toHaveLength(BACKGROUND_ROOMS);
    // Opened rooms first, newest first; the shown room is skipped; then the list order.
    expect(chosen.slice(0, 4)).toEqual(['r13', 'r7', 'r0', 'r1']);
    expect(chosen).not.toContain('r2');
    expect(chosen.at(-1)).toBe('r9');
    expect(backgroundRooms(list, {}, new Set(), 3)).toEqual(['r0', 'r1', 'r2']);
    expect(backgroundRooms([], {}, new Set())).toEqual([]);
  });

  test('polls inside the service presence window, within the rate budget', () => {
    // The service reports a device online for 10 s after its last poll.
    expect(BACKGROUND_POLL_MS).toBeLessThan(10_000 * 0.75);
    // A foreground room (40 polls a minute) plus a full background stays well under the 240/min loopback limit.
    const perMinute = 60_000 / 1500 + BACKGROUND_ROOMS * 60_000 / BACKGROUND_POLL_MS;
    expect(perMinute).toBeLessThanOrEqual(240 * 0.6);
  });
});

describe('background rooms and their claims', () => {
  const dev = 'device-under-test';
  const R = '55555555-5555-4555-8555-555555555555';
  const ownerKey = `owner:${dev}:${R}`, readKey = `read:${dev}:${R}`;
  const offline = { command: async () => { throw new Error('Cannot reach the room service.'); } };
  const connectionHeld = async () => (await navigator.locks.query()).held!.some(l => l.name === connectionLock(R));
  const until = async (check: () => boolean | Promise<boolean>, what: string, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (!await check()) { if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`); await Bun.sleep(1); }
  };
  const events = () => { const seen = { ended: 0, healthy: 0, gone: [] as string[] }; return { seen, events: { ended: () => { seen.ended++; }, healthy: () => { seen.healthy++; }, gone: (r: string) => { seen.gone.push(r); } } }; };
  beforeEach(() => { fakeStorage.records.clear(); });

  test('a background room fenced out by a takeover ends, writes nothing and releases the room', async () => {
    const { seen, events: on } = events();
    const room = new BackgroundRoom(offline, dev, R, on);
    expect(await room.started).toBe(true);
    // A tab takes the room over right after the background room claimed it, before its first write (the read baseline).
    await until(() => fakeStorage.records.get(ownerKey) === 1, 'the background claim');
    await claimFence(ownerKey);
    await room.done;
    expect(seen.ended).toBe(1);
    expect(fakeStorage.records.has(readKey)).toBe(false);
    expect(await connectionHeld()).toBe(false);
  });

  test('a room halted before its claim never claims; one halted during it stops there, and the next claim wins', async () => {
    const early = events();
    const before = new BackgroundRoom(offline, dev, R, early.events);
    void before.stop();
    await before.done;
    expect(fakeStorage.records.has(ownerKey)).toBe(false);
    expect(early.seen.ended).toBe(0);

    const late = events();
    const during = new BackgroundRoom(offline, dev, R, late.events);
    expect(await during.started).toBe(true);
    await during.stop(); // The claim was already under way: it completes, holding the lock, then nothing more runs.
    expect(fakeStorage.records.get(ownerKey)).toBe(1);
    expect(fakeStorage.records.has(readKey)).toBe(false);
    expect(late.seen.ended).toBe(0);
    // The tab that takes the lock next claims after it, so its writes are the ones that land.
    const next = await claimFence(ownerKey);
    expect(next.epoch).toBe(2);
    await write(readKey, { at: 1 }, next);
    expect(fakeStorage.records.get(readKey)).toEqual({ at: 1 });
  });

  test('restarts back off, doubling while failures continue, and reset once the room runs well', () => {
    let now = 0;
    const restarts = new Restarts(5000, () => now);
    expect(restarts.waiting(R)).toBe(false);
    restarts.failed(R);
    now = 4999; expect(restarts.waiting(R)).toBe(true);
    now = 5000; expect(restarts.waiting(R)).toBe(false);
    restarts.failed(R); // Second in a row: 10 s.
    now = 14_999; expect(restarts.waiting(R)).toBe(true);
    now = 15_000; expect(restarts.waiting(R)).toBe(false);
    for (let i = 0; i < 10; i++) restarts.failed(R);
    now += RESTART_MAX_MS - 1; expect(restarts.waiting(R)).toBe(true);
    now += 1; expect(restarts.waiting(R)).toBe(false);
    restarts.healthy(R); restarts.failed(R);
    now += 5000; expect(restarts.waiting(R)).toBe(false);
  });

  test('the leader starts a fenced-out room again after the backoff', async () => {
    const doc = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
    fakeStorage.records.set('recent-rooms', [{ id: R, title: 'Room' }]);
    const leader = new BackgroundRooms(dev, '', 50);
    try {
      await until(() => fakeStorage.records.get(ownerKey) === 1, 'the first claim');
      await claimFence(ownerKey); // Epoch 2: the room's baseline write is fenced out and it ends.
      // Not left dead: after the backoff the leader holds it again, with a new claim.
      await until(() => fakeStorage.records.get(ownerKey) === 3, 'the restart');
      await until(connectionHeld, 'the connection lock');
      await until(() => fakeStorage.records.has(readKey), 'the restarted room writing');
    } finally {
      leader.dispose();
      await until(async () => !await connectionHeld(), 'the room to stop');
      delete (globalThis as { document?: unknown }).document;
    }
  });

  test('a tab taking a room over waits for the holder, and takes it from one that never answers', async () => {
    // A holder that hands over in time.
    const quick = navigator.locks.request(connectionLock(R), () => Bun.sleep(20));
    expect(await holdConnection(R, async () => 'handed over', 1000)).toBe('handed over');
    await quick;
    // A frozen holder: its lock is taken, and its own request fails, so it stops.
    let lost: DOMException | undefined;
    void navigator.locks.request(connectionLock(R), () => new Promise(() => {})).catch(e => { lost = e; });
    await until(connectionHeld, 'the frozen holder');
    expect(await holdConnection(R, async () => 'taken', 30)).toBe('taken');
    expect(lost?.name).toBe('AbortError');
    expect(await connectionHeld()).toBe(false);
  });
});
