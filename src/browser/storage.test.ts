import { beforeEach, describe, expect, test } from 'bun:test';
import { fakeStorage, installFakeIndexedDB } from './test-indexeddb';
import { StorageError, onStorageProblem, persistStorage, read, write } from './storage';

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
