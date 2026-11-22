import { beforeEach, describe, expect, test } from 'bun:test';
import { FakeDatabase, fakeStorage, installFakeIndexedDB } from './test-indexeddb';
import { FenceError, StorageError, claimFence, identity, isPlainObject, onStorageProblem, persistStorage, read, readArray, readRecord, update, write } from './storage';
import { BrowserPeers } from './peers';
import { taskBody } from './board';
import { openDecision } from './decisions';

installFakeIndexedDB();
beforeEach(() => { fakeStorage.failWith = undefined; fakeStorage.failOnRequestOnly = false; });

describe('browser storage', () => {
  test('a failed save is reported until a later save succeeds', async () => {
    const seen: (string | undefined)[] = [];
    const stop = onStorageProblem(problem => seen.push(problem));
    try {
      await write('a', 1);
      fakeStorage.failWith = 'QuotaExceededError';
      const failed = write('b', 2);
      await expect(failed).rejects.toBeInstanceOf(StorageError);
      await expect(write('b', 2)).rejects.toThrow('out of space');
      expect(seen.filter(Boolean)).toHaveLength(1); // Sticky: reported once, not per failure.
      fakeStorage.failWith = 'AbortError';
      await expect(write('b', 2)).rejects.toThrow('Could not save');
      fakeStorage.failWith = undefined;
      await write('b', 2);
      expect(seen.at(-1)).toBeUndefined();
      expect(await read<number>('b')).toBe(2);
    } finally { stop(); }
  });

  test('QuotaExceededError on tx.onerror is preserved even when tx.error is null on abort', async () => {
    const seen: (string | undefined)[] = [];
    const stop = onStorageProblem(problem => seen.push(problem));
    try {
      await write('q', 1);
      fakeStorage.failWith = 'QuotaExceededError';
      fakeStorage.failOnRequestOnly = true;
      await expect(write('q', 2)).rejects.toThrow('out of space');
      expect(seen.filter(Boolean)).toEqual([
        'This browser is out of space for Meshrooms: new messages and changes are not being saved here. Free some site storage.',
      ]);
      fakeStorage.failWith = undefined;
      fakeStorage.failOnRequestOnly = false;
      await write('q', 2);
      expect(seen.at(-1)).toBeUndefined();
    } finally { stop(); }
  });

  test('onupgradeneeded does not throw if the records store already exists', async () => {
    await write('upgrade-check', 1);
    const db = fakeStorage.db!;
    const reopened = new FakeDatabase();
    reopened.createObjectStore('records');
    expect(reopened.objectStoreNames.contains('records')).toBe(true);
    // Calling createObjectStore directly would throw ConstraintError, so a repeat upgrade must guard with contains().
    expect(() => reopened.createObjectStore('records')).toThrow();
    const originalOpen = indexedDB.open.bind(indexedDB);
    try {
      (indexedDB as unknown as { open: () => unknown }).open = () => {
        const req: { result: FakeDatabase; onupgradeneeded?: () => void; onsuccess?: () => void } = { result: reopened };
        setTimeout(() => { fakeStorage.db = reopened; req.onupgradeneeded?.(); req.onsuccess?.(); }, 0);
        return req;
      };
      db.close(); db.onclose?.();
      expect(await read<number>('upgrade-check')).toBe(1);
    } finally {
      (indexedDB as unknown as { open: unknown }).open = originalOpen;
    }
  });

  test('a database the browser closed, or another tab upgrades, is opened again without a reload', async () => {
    await write('x', 1);
    const opens = fakeStorage.opens;
    fakeStorage.db!.close(); fakeStorage.db!.onclose?.();
    await write('x', 2);
    expect(fakeStorage.opens).toBe(opens + 1);
    // Closed without the close event (a handle that went stale): the write reopens once and succeeds.
    fakeStorage.db!.close();
    await write('x', 3);
    expect(fakeStorage.opens).toBe(opens + 2);
    fakeStorage.db!.onversionchange?.();
    expect(fakeStorage.db!.closed).toBe(true);
    expect(await read<number>('x')).toBe(3);
    expect(fakeStorage.opens).toBe(opens + 3);
  });

  test('asks the browser to persist storage once joined, and ignores a refusal or a missing API', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'storage');
    let asked = 0;
    try {
      Object.defineProperty(navigator, 'storage', { configurable: true, value: { persist: () => { asked++; return Promise.reject(new Error('denied')); } } });
      persistStorage(); await Bun.sleep(0);
      expect(asked).toBe(1);
      Object.defineProperty(navigator, 'storage', { configurable: true, value: undefined });
      expect(() => persistStorage()).not.toThrow();
    } finally {
      if (original) Object.defineProperty(navigator, 'storage', original); else delete (navigator as { storage?: unknown }).storage;
    }
  });
});

describe('fenced writes', () => {
  test('a write under a superseded claim aborts whole, without a storage problem; the current claim writes', async () => {
    const seen: (string | undefined)[] = [];
    const stop = onStorageProblem(problem => seen.push(problem));
    try {
      const old = await claimFence('owner:d:r');
      await write('history', ['a'], old);
      const current = await claimFence('owner:d:r');
      // Every put and delete of the stale transaction is dropped together.
      await expect(update([['history', ['stale']], ['board', ['stale']]], ['files'], old)).rejects.toBeInstanceOf(FenceError);
      await expect(write('history', ['stale'], old)).rejects.not.toBeInstanceOf(StorageError);
      expect(await read<string[]>('history')).toEqual(['a']);
      expect(await read<string[]>('board')).toBeUndefined();
      await write('history', ['a', 'b'], current);
      expect(await read<string[]>('history')).toEqual(['a', 'b']);
      expect(seen.filter(Boolean)).toEqual([]);
    } finally { stop(); }
  });

  test('a write and a claim made at once: the one made first wins, never a mix', async () => {
    const mine = await claimFence('owner:d:order');
    // The write's transaction checks the epoch and writes before the claim's can start: it lands, then the claim.
    const [written, next] = await Promise.allSettled([write('order', 'first', mine), claimFence('owner:d:order')]);
    expect(written.status).toBe('fulfilled');
    expect(await read<string>('order')).toBe('first');
    // The claim made first: the write made right after it finds the new epoch and writes nothing.
    const claimed = claimFence('owner:d:order');
    const late = write('order', 'late', (next as PromiseFulfilledResult<{ key: string; epoch: number }>).value);
    await claimed;
    await expect(late).rejects.toBeInstanceOf(FenceError);
    expect(await read<string>('order')).toBe('first');
  });
});

describe('IndexedDB read validation and sanitization (OPS-8)', () => {
  test('read() validates stored values when a predicate is supplied and fails safely on corruption', async () => {
    const isNum = (v: unknown): v is number => typeof v === 'number';
    await write('valid-num', 42);
    await write('corrupt-num', { unexpected: true });
    expect(await read<number>('valid-num', isNum)).toBe(42);
    expect(await read<number>('corrupt-num', isNum)).toBeUndefined();
    expect(await read<number>('missing-num', isNum)).toBeUndefined();
    // Backward-compatible without validator: returns stored value as-is.
    expect(await read('corrupt-num')).toEqual({ unexpected: true });
    // A validator that throws is caught safely rather than crashing startup.
    const throwing = (_v: unknown): _v is string => { throw new TypeError('boom'); };
    expect(await read<string>('corrupt-num', throwing)).toBeUndefined();
  });

  test('readArray() and readRecord() drop corrupted entries and tolerate wrong top-level types', async () => {
    const isItem = (v: unknown): v is { id: string } => isPlainObject(v) && typeof v.id === 'string';
    await write('arr-bad-type', 'not-an-array');
    expect(await readArray('arr-bad-type', isItem)).toEqual([]);
    await write('arr-mixed', [{ id: 'a' }, null, 123, { id: 456 }, { id: 'b' }]);
    expect(await readArray('arr-mixed', isItem)).toEqual([{ id: 'a' }, { id: 'b' }]);

    const isEntry = (v: unknown, key: string): v is { size: number } =>
      key.startsWith('ok') && isPlainObject(v) && typeof v.size === 'number';
    await write('rec-bad-type', ['array-not-object']);
    expect(await readRecord('rec-bad-type', isEntry)).toEqual({});
    await write('rec-mixed', { ok1: { size: 10 }, badKey: { size: 20 }, ok2: null, ok3: { size: 'str' } });
    expect(await readRecord('rec-mixed', isEntry)).toEqual({ ok1: { size: 10 } });
  });

  test('BrowserPeers.load() recovers safely from corrupted IndexedDB records without crashing room startup', async () => {
    const device = await identity();
    const roomId = crypto.randomUUID(), memberId = crypto.randomUUID();
    const goodMsg = {
      packet: { body: { kind: 'message', roomId, id: crypto.randomUUID(), deviceId: device.id, memberId, text: 'hello', at: Date.now() }, signature: 'sig' },
      targets: [], receipts: [],
    };
    const goodTask = { body: taskBody({ roomId, deviceId: device.id, memberId, change: { title: 'Valid task' } }), signature: 'sig' };
    const goodDecision = { body: openDecision({ roomId, deviceId: device.id, memberId, question: 'Ship?', options: ['Yes', 'No'] }), signature: 'sig' };
    const sha = 'a'.repeat(64);
    const badSha = 'b'.repeat(64);

    // Mix valid records with null/malformed entries and wrong top-level shapes across all room stores.
    fakeStorage.records.set(`messages:${device.id}:${roomId}`, [goodMsg, null, { broken: true }, { packet: { body: null } }]);
    fakeStorage.records.set(`board:${device.id}:${roomId}`, [goodTask, 'corrupt', { body: { kind: 'task' }, signature: 'x' }]);
    fakeStorage.records.set(`decisions:${device.id}:${roomId}`, [goodDecision, null, { body: { kind: 'decision', state: 'closed' }, signature: 'x' }]);
    fakeStorage.records.set(`reactions:${device.id}:${roomId}`, 'not-an-array');
    fakeStorage.records.set(`retractions:${device.id}:${roomId}`, { broken: true });
    fakeStorage.records.set(`files:${device.id}:${roomId}`, { [sha]: { size: 3, type: 'image/png' }, [badSha]: { size: -1 }, notasha: { size: 1, type: 'text/plain' } });
    fakeStorage.records.set(`file:${device.id}:${roomId}:${sha}`, 'corrupted-not-a-blob');

    const loadedMessages: unknown[][] = [];
    const loadedTasks: unknown[][] = [];
    const loadedDecisions: unknown[][] = [];
    const engine = new BrowserPeers(
      {} as never, roomId, device.id, 'session',
      msgs => loadedMessages.push(msgs),
      () => {},
      tasks => loadedTasks.push(tasks),
      () => {}, () => {},
      dops => loadedDecisions.push(dops),
    );
    engine.fenced(await claimFence(`owner:${device.id}:${roomId}`));
    await engine.load();

    expect(loadedMessages.at(-1)).toHaveLength(1);
    expect(loadedTasks.at(-1)).toHaveLength(1);
    expect(loadedDecisions.at(-1)).toHaveLength(1);
    await engine.close();
  });
});
