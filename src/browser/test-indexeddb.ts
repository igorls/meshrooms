/**
 * A minimal in-memory IndexedDB (and Web Locks) for tests of browser modules under Bun: one database with one object
 * store, puts, deletes and gets in transactions that complete asynchronously, and failures on demand. Not used by the app.
 */
export const fakeStorage = {
  records: new Map<string, unknown>(),
  /** Completed read-write transactions. */
  writes: 0,
  opens: 0,
  /** When set, read-write transactions abort with a DOMException of this name (e.g. QuotaExceededError). */
  failWith: undefined as string | undefined,
  db: undefined as FakeDatabase | undefined,
};

class FakeRequest<T> {
  onsuccess?: () => void; onerror?: () => void; onupgradeneeded?: () => void; onblocked?: () => void;
  result!: T; error: DOMException | null = null;
}

class FakeTransaction {
  oncomplete?: () => void; onabort?: () => void; onerror?: () => void;
  error: DOMException | null = null;
  private aborted = false;
  private changes: (() => void)[] = [];
  constructor(private mode: string) { setTimeout(() => this.finish(), 0); }
  objectStore() {
    return {
      put: (value: unknown, key: string) => { this.changes.push(() => fakeStorage.records.set(key, value)); },
      delete: (key: string) => { this.changes.push(() => fakeStorage.records.delete(key)); },
      get: (key: string) => {
        const request = new FakeRequest<unknown>();
        setTimeout(() => { request.result = fakeStorage.records.get(key); request.onsuccess?.(); }, 0);
        return request;
      },
    };
  }
  abort() { this.aborted = true; }
  private finish() {
    if (this.mode === 'readwrite' && (fakeStorage.failWith || this.aborted)) {
      this.error = new DOMException('The transaction was aborted.', fakeStorage.failWith ?? 'AbortError');
      this.onabort?.(); return;
    }
    if (this.mode === 'readwrite') { for (const change of this.changes) change(); fakeStorage.writes++; }
    this.oncomplete?.();
  }
}

export class FakeDatabase {
  closed = false;
  onclose?: () => void; onversionchange?: () => void;
  createObjectStore() {}
  close() { this.closed = true; }
  transaction(_store: string, mode = 'readonly') {
    if (this.closed) throw new DOMException('The database connection is closing.', 'InvalidStateError');
    return new FakeTransaction(mode);
  }
}

export function installFakeIndexedDB() {
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open() {
      const request = new FakeRequest<FakeDatabase>();
      setTimeout(() => {
        fakeStorage.opens++; request.result = fakeStorage.db = new FakeDatabase();
        request.onupgradeneeded?.(); request.onsuccess?.();
      }, 0);
      return request;
    },
  };
  if (!navigator.locks) Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (name: string, options: unknown, callback?: (lock: unknown) => unknown) =>
      (typeof options === 'function' ? options as (lock: unknown) => unknown : callback!)({ name }),
  } });
}
