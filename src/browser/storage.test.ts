import { beforeEach, describe, expect, test } from 'bun:test';
import { fakeStorage, installFakeIndexedDB } from './test-indexeddb';
import { FenceError, StorageError, claimFence, onStorageProblem, persistStorage, read, update, write } from './storage';

installFakeIndexedDB();
beforeEach(() => { fakeStorage.failWith = undefined; });

describe('browser storage (SYNC-4)', () => {
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
