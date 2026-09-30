/**
 * A minimal in-memory IndexedDB and Web Locks for tests of browser modules under Bun. Not used by the app.
 * - IndexedDB: one database with one object store. Transactions run one at a time, in the order they were created (a
 *   schedule real IndexedDB may also choose), so a get and the puts made from its callback are atomic with respect to
 *   every other transaction, as a read-write transaction's are in a browser. Puts commit together when the
 *   transaction completes; failures on demand.
 * - Web Locks: exclusive locks with queueing, `ifAvailable`, `steal` (the stolen holder's request rejects with an
 *   AbortError) and `signal`, and `query()`.
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

/** Settles when the last transaction created so far has finished; the next one starts after it. */
let tail: Promise<void> = Promise.resolve();
class FakeTransaction {
  oncomplete?: () => void; onabort?: () => void; onerror?: () => void;
  error: DOMException | null = null;
  private aborted = false;
  private changes: (() => void)[] = [];
  /** Gets not answered yet: as in IndexedDB, the transaction stays open for what their callbacks do. */
  private pending = 0;
  private started: Promise<void>;
  private finished!: () => void;
  constructor(private mode: string) {
    const previous = tail;
    tail = new Promise(resolve => { this.finished = resolve; });
    this.started = previous.then(() => new Promise(resolve => setTimeout(resolve, 0)));
    void this.started.then(() => this.finish());
  }
  objectStore() {
    return {
      put: (value: unknown, key: string) => { this.changes.push(() => fakeStorage.records.set(key, value)); },
      delete: (key: string) => { this.changes.push(() => fakeStorage.records.delete(key)); },
      get: (key: string) => {
        const request = new FakeRequest<unknown>();
        this.pending++;
        void this.started.then(() => setTimeout(() => { request.result = fakeStorage.records.get(key); try { request.onsuccess?.(); } finally { this.pending--; } }, 0));
        return request;
      },
    };
  }
  abort() { this.aborted = true; }
  private finish() {
    if (this.pending) { setTimeout(() => this.finish(), 0); return; }
    try {
      if (this.mode === 'readwrite' && (fakeStorage.failWith || this.aborted)) {
        this.error = new DOMException('The transaction was aborted.', fakeStorage.failWith ?? 'AbortError');
        this.onabort?.(); return;
      }
      if (this.mode === 'readwrite') { for (const change of this.changes) change(); fakeStorage.writes++; }
      this.oncomplete?.();
    } finally { this.finished(); }
  }
}

type Waiter = { run: () => void };
/** Exclusive Web Locks as the app uses them. */
export class FakeLocks {
  private held = new Map<string, { steal: () => void }>();
  private queues = new Map<string, Waiter[]>();
  request<T>(name: string, options: LockOptions | ((lock: Lock | null) => T | Promise<T>), callback?: (lock: Lock | null) => T | Promise<T>): Promise<T> {
    const work = (typeof options === 'function' ? options : callback)!;
    const opts: LockOptions = typeof options === 'function' ? {} : options;
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        let lost = false;
        const entry = { steal: () => { lost = true; reject(new DOMException('The lock request was stolen.', 'AbortError')); } };
        this.held.set(name, entry);
        const release = () => { if (this.held.get(name) === entry) this.release(name); };
        Promise.resolve().then(() => work({ name, mode: 'exclusive' } as Lock))
          .then(value => { release(); if (!lost) resolve(value); }, error => { release(); if (!lost) reject(error); });
      };
      if (opts.signal?.aborted) { reject(opts.signal.reason); return; }
      if (opts.steal) { const holder = this.held.get(name); this.held.delete(name); holder?.steal(); run(); return; }
      const queue = this.queues.get(name) || [];
      if (!this.held.has(name) && !queue.length) { run(); return; }
      if (opts.ifAvailable) { Promise.resolve().then(() => work(null)).then(resolve, reject); return; }
      const waiter = { run };
      queue.push(waiter); this.queues.set(name, queue);
      opts.signal?.addEventListener('abort', () => {
        const at = queue.indexOf(waiter);
        if (at >= 0) { queue.splice(at, 1); reject(opts.signal!.reason); }
      });
    });
  }
  private release(name: string) {
    this.held.delete(name);
    this.queues.get(name)?.shift()?.run();
  }
  async query() {
    return { held: [...this.held.keys()].map(name => ({ name, mode: 'exclusive', clientId: 'test' })),
      pending: [...this.queues].flatMap(([name, queue]) => queue.map(() => ({ name, mode: 'exclusive', clientId: 'test' }))) };
  }
}
export const fakeLocks = new FakeLocks();

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
  Object.defineProperty(navigator, 'locks', { configurable: true, value: fakeLocks });
}
