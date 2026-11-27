/**
 * Browser `IndexedDbVfsStore` adapter implementing `VfsStore` / `VfsRoomStore`
 * (`docs/flows/room-vfs.md` §3.3).
 *
 * Dedicated database rationale (`meshrooms-vfs-v1`, schema v1):
 * `src/browser/storage.ts` opens `meshrooms-browser-v1` at version 1 and closes/blocks
 * open tabs on version upgrades (`onversionchange` / `onblocked`). Storing VFS state in
 * its own dedicated IndexedDB database (`meshrooms-vfs-v1`, with `vfs_kv`, `vfs_blocks`,
 * and `vfs_meta` object stores) avoids multi-tab `VersionError` / `onblocked` disruption
 * to existing chat/identity tabs, keeps identity keys isolated from VFS storage churn,
 * and allows clean one-shot disposal after future Phase 2/3 migration to WormDB WASM+OPFS.
 *
 * All read-modify-write sequences inside IndexedDB transactions chain synchronously inside
 * `IDBRequest.onsuccess` callbacks (zero `await` across open transactions), matching
 * WebKit/Safari IndexedDB auto-commit semantics and ensuring `tx.abort()` rolls back
 * atomically before `tx.oncomplete` can fire.
 *
 * Pure TypeScript + WebCrypto + standard IndexedDB API (zero new dependencies).
 * Supports dependency-injected `IDBFactory` for deterministic testing in Bun.
 */

import { VfsError, vfsRoomPrefix } from './constants';
import {
  MemoryVfsStore,
  VfsRoomFence,
  assertBlockSizeWithinCap,
  bytesEqual,
  compareUtf8Lex,
  copyBytes,
  kvEntryBytes,
  perMemberCasLimitBytes,
  resolveVfsStoreQuotas,
  validateBlockCid,
  validateScanPrefixOptions,
  validateVfsKvKey,
  validateVfsKvPrefix,
  validateVfsRoomId,
  verifyBlockCid,
  type ResolvedVfsStoreQuotas,
  type VfsKvEntry,
  type VfsPutBlockOptions,
  type VfsRoomStats,
  type VfsRoomStore,
  type VfsScanPrefixOptions,
  type VfsStore,
  type VfsStoreKind,
  type VfsStoreQuotas,
} from './store';

export const DEFAULT_VFS_IDB_NAME = 'meshrooms-vfs-v1';
export const VFS_IDB_SCHEMA_VERSION = 1;

export const VFS_IDB_STORE_KV = 'vfs_kv';
export const VFS_IDB_STORE_BLOCKS = 'vfs_blocks';
export const VFS_IDB_STORE_META = 'vfs_meta';
export const VFS_IDB_FENCE_KEY_PREFIX = 'fence:';
const TAB_OWNERSHIP_LOST_REASON = 'Tab lost ownership of room VFS';

export type IdbKeyRangeFactory = {
  bound(
    lower: unknown,
    upper: unknown,
    lowerOpen?: boolean,
    upperOpen?: boolean,
  ): IDBKeyRange;
  lowerBound(lower: unknown, open?: boolean): IDBKeyRange;
};

export type IndexedDbVfsStoreOptions = {
  /** Custom `IDBFactory` (defaults to `globalThis.indexedDB`). */
  idb?: IDBFactory;
  /** Custom `IDBKeyRange` constructor/factory (defaults to `globalThis.IDBKeyRange`). */
  keyRange?: IdbKeyRangeFactory;
  /** Database name (defaults to `'meshrooms-vfs-v1'`). */
  dbName?: string;
};

export type BrowserStorageManagerLike = {
  persist?: () => Promise<boolean>;
};

export type OpenBrowserVfsStoreOptions = {
  /** Custom `IDBFactory` (pass `null` to simulate unavailable IndexedDB). */
  idb?: IDBFactory | null;
  /** Custom `IDBKeyRange` factory. */
  keyRange?: IdbKeyRangeFactory;
  /** Database name (defaults to `'meshrooms-vfs-v1'`). */
  dbName?: string;
  /** Request `navigator.storage.persist()` best-effort (default `true`). */
  requestPersist?: boolean;
  /** Custom storage manager for tests (defaults to `globalThis.navigator?.storage`). */
  storageManager?: BrowserStorageManagerLike | null;
};

export type OpenBrowserVfsStoreResult =
  | {
      store: IndexedDbVfsStore;
      persistent: true;
      persistedGrant?: boolean;
    }
  | {
      store: MemoryVfsStore;
      persistent: false;
      reason: string;
    };

type StoredBlockRecord = {
  roomId: string;
  cid: string;
  bytes: Uint8Array;
  size: number;
  authorMemberId?: string;
};

type PersistedRoomMeta = {
  v: 1;
  roomId: string;
  hotKvBytes: number;
  hotKvKeys: number;
  coldCasBytes: number;
  coldCasBlocks: number;
  memberCasBytes: Record<string, number>;
  hasHighCodeUnits: boolean;
};

type PersistedRoomFence = {
  v: 1;
  roomId: string;
  ownerToken: string;
  claimedAt: number;
};

// ---------------------------------------------------------------------------
// Key-Range & UTF-8 Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the tightest UTF-16 exclusive upper bound for all strings starting with `prefix`.
 * Returns `undefined` only if every code unit in `prefix` is `0xffff` (impossible for valid VFS keys).
 */
function nextPrefixUpperBound(prefix: string): string | undefined {
  for (let i = prefix.length - 1; i >= 0; i--) {
    const cu = prefix.charCodeAt(i);
    if (cu < 0xffff) {
      return prefix.slice(0, i) + String.fromCharCode(cu + 1);
    }
  }
  return undefined;
}

/** True if `str` contains any code unit >= `0xd800` where UTF-16 and UTF-8 sort orders can diverge. */
function hasHighCodeUnit(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) >= 0xd800) return true;
  }
  return false;
}

function makeBoundRange(
  factory: IdbKeyRangeFactory | undefined,
  lower: string,
  upper: string | undefined,
  lowerOpen: boolean,
  upperOpen: boolean,
): IDBKeyRange {
  const kr = factory ?? (typeof IDBKeyRange !== 'undefined' ? IDBKeyRange : undefined);
  if (kr) {
    return upper !== undefined
      ? kr.bound(lower, upper, lowerOpen, upperOpen)
      : kr.lowerBound(lower, lowerOpen);
  }
  // Fallback spec-shaped range for injected non-DOM test IDBFactory harnesses.
  return {
    lower,
    upper,
    lowerOpen,
    upperOpen,
    includes(key: unknown): boolean {
      if (typeof key !== 'string') return false;
      if (lowerOpen ? key <= lower : key < lower) return false;
      if (upper !== undefined && (upperOpen ? key >= upper : key > upper)) return false;
      return true;
    },
  } as IDBKeyRange;
}

function blockStorageKey(roomId: string, cid: string): string {
  return `${roomId}:${cid}`;
}

function roomMetaStorageKey(roomId: string): string {
  return `room:${roomId}`;
}

export function roomFenceStorageKey(roomId: string): string {
  return `${VFS_IDB_FENCE_KEY_PREFIX}${roomId}`;
}

function normalizeStoredBytes(raw: unknown): Uint8Array | undefined {
  if (raw instanceof Uint8Array) return copyBytes(raw);
  if (raw instanceof ArrayBuffer) return copyBytes(new Uint8Array(raw));
  if (ArrayBuffer.isView(raw)) {
    return copyBytes(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
  }
  return undefined;
}

function domErrorName(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'name' in err && typeof (err as { name: unknown }).name === 'string') {
    return (err as { name: string }).name;
  }
  return undefined;
}

function describeStorageError(err: unknown): string {
  const name = domErrorName(err);
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (name && msg) return `${name}: ${msg}`;
  if (name) return name;
  return msg || 'IndexedDB storage error';
}

function openIdbDatabase(idb: IDBFactory, dbName: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = idb.open(dbName, VFS_IDB_SCHEMA_VERSION);
    } catch (err) {
      reject(err);
      return;
    }

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VFS_IDB_STORE_KV)) {
        db.createObjectStore(VFS_IDB_STORE_KV);
      }
      if (!db.objectStoreNames.contains(VFS_IDB_STORE_BLOCKS)) {
        db.createObjectStore(VFS_IDB_STORE_BLOCKS);
      }
      if (!db.objectStoreNames.contains(VFS_IDB_STORE_META)) {
        db.createObjectStore(VFS_IDB_STORE_META);
      }
    };

    req.onsuccess = () => {
      resolve(req.result);
    };

    req.onerror = () => {
      reject(req.error ?? new Error(`Failed to open IndexedDB database "${dbName}".`));
    };

    req.onblocked = () => {
      reject(
        new VfsError(
          'VFS_STORAGE_FAILED',
          `IndexedDB database "${dbName}" upgrade blocked by another open tab.`,
        ),
      );
    };
  });
}

type TxControls<T> = {
  setResult(value: T): void;
  /** Aborts the transaction cleanly with an application-level `VfsError` WITHOUT tripping `VfsRoomFence`. */
  abortControlled(error: VfsError): void;
  /** Aborts the transaction due to lost cross-tab ownership (trips `VfsRoomFence` and rejects with `VFS_STORAGE_FENCED`). */
  abortFenced(reason: string): void;
  /** Aborts the transaction due to a storage/corruption error (trips `VfsRoomFence` if provided). */
  abortFatal(error: unknown): void;
};

/**
 * Runs an IndexedDB transaction synchronously (zero `await` across open requests)
 * and resolves ONLY after `tx.oncomplete` commits durably.
 * - `abortControlled(err)` aborts the transaction cleanly and rejects with `err`
 *   WITHOUT tripping `fence` (used for app-level quota / validation rejections).
 * - `abortFenced(reason)` aborts the transaction, trips `fence`, and rejects with
 *   `VFS_STORAGE_FENCED` (used when another tab claimed ownership of the room).
 * - Any underlying IndexedDB error (`QuotaExceededError`, `AbortError`,
 *   `InvalidStateError`, etc.) trips `fence` (fail-closed) and rejects with `VfsError`.
 */
function runSyncIdbTransaction<T>(opts: {
  db: IDBDatabase;
  stores: string[];
  mode: IDBTransactionMode;
  fence?: VfsRoomFence;
  roomId: string;
  body: (tx: IDBTransaction, ctl: TxControls<T>) => void;
}): Promise<T> {
  let tx: IDBTransaction;
  try {
    tx = opts.db.transaction(opts.stores, opts.mode);
  } catch (err) {
    const reason = describeStorageError(err);
    opts.fence?.trip(reason);
    return Promise.reject(
      new VfsError('VFS_STORAGE_FAILED', `IndexedDB transaction start failed: ${reason}`, {
        cause: err,
        details: { roomId: opts.roomId, domErrorName: domErrorName(err) },
      }),
    );
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let hasResult = false;
    let resultValue!: T;
    let controlledError: VfsError | undefined;
    let fencedReason: string | undefined;
    let fatalError: unknown;
    let capturedTxError: unknown;

    const finishWithError = () => {
      if (settled) return;
      settled = true;
      if (fencedReason !== undefined) {
        opts.fence?.trip(fencedReason);
        reject(
          new VfsError('VFS_STORAGE_FENCED', fencedReason, {
            details: { roomId: opts.roomId, reason: fencedReason },
          }),
        );
        return;
      }
      if (controlledError) {
        reject(controlledError);
        return;
      }
      if (fatalError instanceof VfsError && fatalError.code === 'VFS_INVALID_ENVELOPE') {
        // Data integrity / corruption error on read; report directly without swallowing code.
        reject(fatalError);
        return;
      }
      const rawErr = fatalError ?? tx.error ?? capturedTxError ?? new Error('IndexedDB transaction aborted.');
      const name = domErrorName(rawErr);
      const reason = describeStorageError(rawErr);
      opts.fence?.trip(reason);
      if (name === 'QuotaExceededError') {
        reject(
          new VfsError('VFS_STORAGE_QUOTA', `Browser IndexedDB quota exceeded: ${reason}`, {
            cause: rawErr,
            details: { roomId: opts.roomId, domErrorName: name, fenced: true },
          }),
        );
        return;
      }
      reject(
        new VfsError('VFS_STORAGE_FAILED', `IndexedDB transaction failed: ${reason}`, {
          cause: rawErr,
          details: { roomId: opts.roomId, domErrorName: name, fenced: true },
        }),
      );
    };

    tx.oncomplete = () => {
      if (settled) return;
      if (controlledError || fencedReason !== undefined || fatalError !== undefined) {
        finishWithError();
        return;
      }
      settled = true;
      resolve(hasResult ? resultValue : (undefined as T));
    };

    tx.onerror = (event) => {
      const targetErr = (event?.target as IDBRequest | null)?.error;
      capturedTxError ??= targetErr ?? tx.error;
    };

    tx.onabort = finishWithError;

    const ctl: TxControls<T> = {
      setResult(value: T) {
        hasResult = true;
        resultValue = value;
      },
      abortControlled(error: VfsError) {
        controlledError = error;
        try {
          tx.abort();
        } catch {
          finishWithError();
        }
      },
      abortFenced(reason: string) {
        fencedReason = reason;
        try {
          tx.abort();
        } catch {
          finishWithError();
        }
      },
      abortFatal(error: unknown) {
        fatalError = error;
        try {
          tx.abort();
        } catch {
          finishWithError();
        }
      },
    };

    try {
      opts.body(tx, ctl);
    } catch (err) {
      if (err instanceof VfsError && (err.code === 'VFS_STORAGE_QUOTA' || err.code === 'VFS_LIMIT_EXCEEDED')) {
        ctl.abortControlled(err);
      } else if (err instanceof VfsError && err.code === 'VFS_STORAGE_FENCED') {
        ctl.abortFenced(err.message);
      } else {
        ctl.abortFatal(err);
      }
    }
  });
}

function verifyRoomOwnershipInTx<T>(
  metaStore: IDBObjectStore,
  roomId: string,
  expectedOwnerToken: string,
  ctl: TxControls<T>,
  onOwned: () => void,
): void {
  const fenceReq = metaStore.get(roomFenceStorageKey(roomId));
  fenceReq.onsuccess = () => {
    const rec = fenceReq.result as PersistedRoomFence | undefined;
    if (!rec || rec.ownerToken !== expectedOwnerToken) {
      ctl.abortFenced(TAB_OWNERSHIP_LOST_REASON);
      return;
    }
    onOwned();
  };
}

function cloneMeta(meta: PersistedRoomMeta): PersistedRoomMeta {
  return {
    v: 1,
    roomId: meta.roomId,
    hotKvBytes: meta.hotKvBytes,
    hotKvKeys: meta.hotKvKeys,
    coldCasBytes: meta.coldCasBytes,
    coldCasBlocks: meta.coldCasBlocks,
    memberCasBytes: { ...meta.memberCasBytes },
    hasHighCodeUnits: meta.hasHighCodeUnits,
  };
}

// ---------------------------------------------------------------------------
// IndexedDbVfsRoomStore
// ---------------------------------------------------------------------------

export class IndexedDbVfsRoomStore implements VfsRoomStore {
  readonly kind: VfsStoreKind = 'indexeddb';
  readonly quotas: ResolvedVfsStoreQuotas;
  readonly fence: VfsRoomFence;
  readonly ownerToken: string;

  private meta: PersistedRoomMeta;
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    readonly roomId: string,
    private readonly getDb: () => IDBDatabase,
    private readonly keyRange: IdbKeyRangeFactory | undefined,
    quotas: ResolvedVfsStoreQuotas,
    ownerToken: string,
    initialMeta: PersistedRoomMeta,
    private readonly onClose: (handle: IndexedDbVfsRoomStore) => void,
  ) {
    this.quotas = quotas;
    this.ownerToken = ownerToken;
    this.meta = initialMeta;
    this.fence = new VfsRoomFence(roomId);
  }

  get isFenced(): boolean {
    return this.fence.fenced;
  }

  private assertUsable(): IDBDatabase {
    if (this.closed) {
      throw new VfsError('VFS_STORAGE_CLOSED', `VFS room store for ${this.roomId} is closed.`);
    }
    this.fence.assertOpen();
    return this.getDb();
  }

  /** Serializes mutating room transactions so quota accounting stays strictly consistent. */
  private enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Waits for any in-flight serialized writes on this handle to settle. */
  drainWrites(): Promise<void> {
    return this.writeChain.catch(() => undefined);
  }

  /** Internal helper called by `destroyRoom` / `store.close()`. */
  forceClose(): void {
    this.closed = true;
  }

  async kvGet(key: string): Promise<Uint8Array | undefined> {
    const db = this.assertUsable();
    validateVfsKvKey(this.roomId, key);

    return runSyncIdbTransaction<Uint8Array | undefined>({
      db,
      stores: [VFS_IDB_STORE_KV],
      mode: 'readonly',
      fence: this.fence,
      roomId: this.roomId,
      body: (tx, ctl) => {
        const req = tx.objectStore(VFS_IDB_STORE_KV).get(key);
        req.onsuccess = () => {
          const raw = req.result;
          if (raw === undefined) {
            ctl.setResult(undefined);
            return;
          }
          const normalized = normalizeStoredBytes(raw);
          if (!normalized) {
            ctl.abortFatal(new VfsError('VFS_INVALID_ENVELOPE', `Corrupted KV value at key "${key}".`));
            return;
          }
          ctl.setResult(normalized);
        };
      },
    });
  }

  async kvPut(key: string, value: Uint8Array): Promise<void> {
    this.assertUsable();
    validateVfsKvKey(this.roomId, key);
    if (!(value instanceof Uint8Array)) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'KV value must be a Uint8Array.');
    }
    const payload = copyBytes(value);
    const nextSize = kvEntryBytes(key, payload);
    const keyHasHigh = hasHighCodeUnit(key);

    await this.enqueueWrite(async () => {
      const db = this.assertUsable();
      let committedMeta: PersistedRoomMeta | undefined;

      await runSyncIdbTransaction<void>({
        db,
        stores: [VFS_IDB_STORE_KV, VFS_IDB_STORE_META],
        mode: 'readwrite',
        fence: this.fence,
        roomId: this.roomId,
        body: (tx, ctl) => {
          const kvStore = tx.objectStore(VFS_IDB_STORE_KV);
          const metaStore = tx.objectStore(VFS_IDB_STORE_META);
          verifyRoomOwnershipInTx(metaStore, this.roomId, this.ownerToken, ctl, () => {
            const getReq = kvStore.get(key);
            getReq.onsuccess = () => {
              const existingRaw = getReq.result;
              const existing = existingRaw !== undefined ? normalizeStoredBytes(existingRaw) : undefined;
              const prevSize = existing !== undefined ? kvEntryBytes(key, existing) : 0;
              const delta = nextSize - prevSize;

              if (delta > 0 && this.meta.hotKvBytes + delta > this.quotas.hotKvMaxBytes) {
                ctl.abortControlled(
                  new VfsError(
                    'VFS_STORAGE_QUOTA',
                    `Hot KV quota exceeded for room ${this.roomId} (${this.meta.hotKvBytes + delta} > ${this.quotas.hotKvMaxBytes}).`,
                    {
                      details: {
                        hotKvBytes: this.meta.hotKvBytes,
                        delta,
                        hotKvMaxBytes: this.quotas.hotKvMaxBytes,
                      },
                    },
                  ),
                );
                return;
              }

              const nextMeta = cloneMeta(this.meta);
              nextMeta.hotKvBytes = Math.max(0, nextMeta.hotKvBytes + delta);
              if (existing === undefined) {
                nextMeta.hotKvKeys += 1;
              }
              if (keyHasHigh) {
                nextMeta.hasHighCodeUnits = true;
              }

              kvStore.put(payload, key);
              metaStore.put(nextMeta, roomMetaStorageKey(this.roomId));
              committedMeta = nextMeta;
            };
          });
        },
      });

      if (committedMeta) {
        this.meta = committedMeta;
      }
    });
  }

  async kvPutIfAbsent(key: string, value: Uint8Array): Promise<boolean> {
    this.assertUsable();
    validateVfsKvKey(this.roomId, key);
    if (!(value instanceof Uint8Array)) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'KV value must be a Uint8Array.');
    }
    const payload = copyBytes(value);
    const entrySize = kvEntryBytes(key, payload);
    const keyHasHigh = hasHighCodeUnit(key);

    return this.enqueueWrite(async () => {
      const db = this.assertUsable();
      let committedMeta: PersistedRoomMeta | undefined;

      const inserted = await runSyncIdbTransaction<boolean>({
        db,
        stores: [VFS_IDB_STORE_KV, VFS_IDB_STORE_META],
        mode: 'readwrite',
        fence: this.fence,
        roomId: this.roomId,
        body: (tx, ctl) => {
          const kvStore = tx.objectStore(VFS_IDB_STORE_KV);
          const metaStore = tx.objectStore(VFS_IDB_STORE_META);
          verifyRoomOwnershipInTx(metaStore, this.roomId, this.ownerToken, ctl, () => {
            const getReq = kvStore.get(key);
            getReq.onsuccess = () => {
              if (getReq.result !== undefined) {
                ctl.setResult(false);
                return;
              }

              if (this.meta.hotKvBytes + entrySize > this.quotas.hotKvMaxBytes) {
                ctl.abortControlled(
                  new VfsError(
                    'VFS_STORAGE_QUOTA',
                    `Hot KV quota exceeded for room ${this.roomId} (${this.meta.hotKvBytes + entrySize} > ${this.quotas.hotKvMaxBytes}).`,
                    {
                      details: {
                        hotKvBytes: this.meta.hotKvBytes,
                        delta: entrySize,
                        hotKvMaxBytes: this.quotas.hotKvMaxBytes,
                      },
                    },
                  ),
                );
                return;
              }

              const nextMeta = cloneMeta(this.meta);
              nextMeta.hotKvBytes += entrySize;
              nextMeta.hotKvKeys += 1;
              if (keyHasHigh) {
                nextMeta.hasHighCodeUnits = true;
              }

              kvStore.put(payload, key);
              metaStore.put(nextMeta, roomMetaStorageKey(this.roomId));
              committedMeta = nextMeta;
              ctl.setResult(true);
            };
          });
        },
      });

      if (committedMeta) {
        this.meta = committedMeta;
      }
      return inserted;
    });
  }

  async kvDelete(key: string): Promise<boolean> {
    this.assertUsable();
    validateVfsKvKey(this.roomId, key);

    return this.enqueueWrite(async () => {
      const db = this.assertUsable();
      let committedMeta: PersistedRoomMeta | undefined;

      const deleted = await runSyncIdbTransaction<boolean>({
        db,
        stores: [VFS_IDB_STORE_KV, VFS_IDB_STORE_META],
        mode: 'readwrite',
        fence: this.fence,
        roomId: this.roomId,
        body: (tx, ctl) => {
          const kvStore = tx.objectStore(VFS_IDB_STORE_KV);
          const metaStore = tx.objectStore(VFS_IDB_STORE_META);
          verifyRoomOwnershipInTx(metaStore, this.roomId, this.ownerToken, ctl, () => {
            const getReq = kvStore.get(key);
            getReq.onsuccess = () => {
              const existingRaw = getReq.result;
              if (existingRaw === undefined) {
                ctl.setResult(false);
                return;
              }
              const existing = normalizeStoredBytes(existingRaw);
              const prevSize = existing !== undefined ? kvEntryBytes(key, existing) : 0;

              const nextMeta = cloneMeta(this.meta);
              nextMeta.hotKvBytes = Math.max(0, nextMeta.hotKvBytes - prevSize);
              nextMeta.hotKvKeys = Math.max(0, nextMeta.hotKvKeys - 1);

              kvStore.delete(key);
              metaStore.put(nextMeta, roomMetaStorageKey(this.roomId));
              committedMeta = nextMeta;
              ctl.setResult(true);
            };
          });
        },
      });

      if (committedMeta) {
        this.meta = committedMeta;
      }
      return deleted;
    });
  }

  async kvScanPrefix(prefix: string, opts?: VfsScanPrefixOptions): Promise<VfsKvEntry[]> {
    const db = this.assertUsable();
    validateVfsKvPrefix(this.roomId, prefix);
    const { afterKey, beforeKey, limit, direction } = validateScanPrefixOptions(opts);
    if (afterKey !== undefined && beforeKey !== undefined && compareUtf8Lex(afterKey, beforeKey) >= 0) {
      return [];
    }

    const prefixUpper = nextPrefixUpperBound(prefix);
    const fastUtf16Order =
      !this.meta.hasHighCodeUnits
      && (afterKey === undefined || !hasHighCodeUnit(afterKey))
      && (beforeKey === undefined || !hasHighCodeUnit(beforeKey));

    let lower = prefix;
    let lowerOpen = false;
    let upper = prefixUpper;
    const upperOpen = true;

    if (fastUtf16Order) {
      if (afterKey !== undefined && afterKey >= prefix) {
        lower = afterKey;
        lowerOpen = true;
      }
      if (beforeKey !== undefined) {
        if (beforeKey <= prefix) {
          return [];
        }
        if (upper === undefined || beforeKey < upper) {
          upper = beforeKey;
        }
      }
      if (upper !== undefined && (lower > upper || (lower === upper && (lowerOpen || upperOpen)))) {
        return [];
      }
    }

    const range = makeBoundRange(this.keyRange, lower, upper, lowerOpen, upperOpen);
    const cursorDir: IDBCursorDirection = fastUtf16Order && direction === 'last' ? 'prev' : 'next';
    const earlyStopLimit = fastUtf16Order && limit !== undefined && limit > 0 ? limit : 0;

    const entries = await runSyncIdbTransaction<VfsKvEntry[]>({
      db,
      stores: [VFS_IDB_STORE_KV],
      mode: 'readonly',
      fence: this.fence,
      roomId: this.roomId,
      body: (tx, ctl) => {
        const results: VfsKvEntry[] = [];
        ctl.setResult(results);
        const cursorReq = tx.objectStore(VFS_IDB_STORE_KV).openCursor(range, cursorDir);
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const k = String(cursor.key);
          if (!k.startsWith(prefix)) return;
          const val = normalizeStoredBytes(cursor.value);
          if (!val) {
            ctl.abortFatal(new VfsError('VFS_INVALID_ENVELOPE', `Corrupted KV value at key "${k}".`));
            return;
          }
          results.push({ key: k, value: val });
          if (earlyStopLimit > 0 && results.length >= earlyStopLimit) return;
          cursor.continue();
        };
      },
    });

    if (fastUtf16Order) {
      if (direction === 'last') {
        entries.reverse();
      }
      return entries;
    }

    // Fallback for keys with high code units (>= 0xd800) so UTF-8 byte ordering
    // matches WormDB / MemoryVfsStore identically.
    const filtered = entries.filter((e) => {
      if (afterKey !== undefined && compareUtf8Lex(e.key, afterKey) <= 0) return false;
      if (beforeKey !== undefined && compareUtf8Lex(e.key, beforeKey) >= 0) return false;
      return true;
    });
    filtered.sort((a, b) => compareUtf8Lex(a.key, b.key));
    if (limit !== undefined && limit > 0) {
      return direction === 'last' ? filtered.slice(-limit) : filtered.slice(0, limit);
    }
    return filtered;
  }

  async putBlock(cid: string, bytes: Uint8Array, opts?: VfsPutBlockOptions): Promise<boolean> {
    this.assertUsable();
    assertBlockSizeWithinCap(bytes);
    // Always verify SHA-256 BEFORE opening an IDB transaction (non-IDB awaits
    // auto-commit open browser IndexedDB transactions).
    await verifyBlockCid(cid, bytes);
    const payload = copyBytes(bytes);
    const size = payload.byteLength;
    const author = opts?.authorMemberId;
    const bKey = blockStorageKey(this.roomId, cid);

    return this.enqueueWrite(async () => {
      const db = this.assertUsable();
      let committedMeta: PersistedRoomMeta | undefined;

      const inserted = await runSyncIdbTransaction<boolean>({
        db,
        stores: [VFS_IDB_STORE_BLOCKS, VFS_IDB_STORE_META],
        mode: 'readwrite',
        fence: this.fence,
        roomId: this.roomId,
        body: (tx, ctl) => {
          const blkStore = tx.objectStore(VFS_IDB_STORE_BLOCKS);
          const metaStore = tx.objectStore(VFS_IDB_STORE_META);
          verifyRoomOwnershipInTx(metaStore, this.roomId, this.ownerToken, ctl, () => {
            const getReq = blkStore.get(bKey);
            getReq.onsuccess = () => {
              const existingRaw = getReq.result as StoredBlockRecord | undefined;
              let prevSize = 0;
              let prevAuthor: string | undefined;
              let replacingCorrupt = false;
              if (existingRaw !== undefined) {
                const existingBytes = normalizeStoredBytes(existingRaw?.bytes);
                if (existingBytes !== undefined && bytesEqual(existingBytes, payload)) {
                  ctl.setResult(false);
                  return;
                }
                // Existing stored block is corrupted (bytes do not match verified CID payload);
                // replace it atomically and return true.
                replacingCorrupt = true;
                prevSize = existingBytes !== undefined ? existingBytes.byteLength : typeof existingRaw.size === 'number' ? existingRaw.size : 0;
                if (typeof existingRaw.authorMemberId === 'string') {
                  prevAuthor = existingRaw.authorMemberId;
                }
              }

              const nextTotalBytes = Math.max(0, this.meta.coldCasBytes - prevSize) + size;
              if (nextTotalBytes > this.quotas.coldCasMaxBytes) {
                ctl.abortControlled(
                  new VfsError(
                    'VFS_STORAGE_QUOTA',
                    `Cold CAS quota exceeded for room ${this.roomId} (${nextTotalBytes} > ${this.quotas.coldCasMaxBytes}).`,
                    {
                      details: {
                        coldCasBytes: this.meta.coldCasBytes,
                        size,
                        coldCasMaxBytes: this.quotas.coldCasMaxBytes,
                      },
                    },
                  ),
                );
                return;
              }

              const nextMeta = cloneMeta(this.meta);
              if (prevAuthor !== undefined) {
                const prevUsed = nextMeta.memberCasBytes[prevAuthor] ?? 0;
                const reduced = Math.max(0, prevUsed - prevSize);
                if (reduced === 0) delete nextMeta.memberCasBytes[prevAuthor];
                else nextMeta.memberCasBytes[prevAuthor] = reduced;
              }
              if (author !== undefined) {
                const memberCap = perMemberCasLimitBytes(this.quotas);
                const memberUsed = nextMeta.memberCasBytes[author] ?? 0;
                if (memberUsed + size > memberCap) {
                  ctl.abortControlled(
                    new VfsError(
                      'VFS_STORAGE_QUOTA',
                      `Per-member CAS fairness quota exceeded for ${author} (${memberUsed + size} > ${memberCap}).`,
                      {
                        details: {
                          authorMemberId: author,
                          memberUsed,
                          size,
                          memberCap,
                        },
                      },
                    ),
                  );
                  return;
                }
                nextMeta.memberCasBytes[author] = memberUsed + size;
              }

              nextMeta.coldCasBytes = nextTotalBytes;
              if (!replacingCorrupt) {
                nextMeta.coldCasBlocks += 1;
              }

              const record: StoredBlockRecord = {
                roomId: this.roomId,
                cid,
                bytes: payload,
                size,
                ...(author !== undefined ? { authorMemberId: author } : {}),
              };

              blkStore.put(record, bKey);
              metaStore.put(nextMeta, roomMetaStorageKey(this.roomId));
              committedMeta = nextMeta;
              ctl.setResult(true);
            };
          });
        },
      });

      if (committedMeta) {
        this.meta = committedMeta;
      }
      return inserted;
    });
  }

  async getBlock(cid: string): Promise<Uint8Array | undefined> {
    const db = this.assertUsable();
    validateBlockCid(cid);
    const bKey = blockStorageKey(this.roomId, cid);

    const out = await runSyncIdbTransaction<Uint8Array | undefined>({
      db,
      stores: [VFS_IDB_STORE_BLOCKS],
      mode: 'readonly',
      fence: this.fence,
      roomId: this.roomId,
      body: (tx, ctl) => {
        const req = tx.objectStore(VFS_IDB_STORE_BLOCKS).get(bKey);
        req.onsuccess = () => {
          const raw = req.result as StoredBlockRecord | undefined;
          if (raw === undefined) {
            ctl.setResult(undefined);
            return;
          }
          const bytes = normalizeStoredBytes(raw?.bytes);
          if (!bytes) {
            ctl.abortFatal(new VfsError('VFS_INVALID_ENVELOPE', `Corrupted CAS block record for CID ${cid}.`));
            return;
          }
          ctl.setResult(bytes);
        };
      },
    });

    if (out === undefined) return undefined;
    // Cryptographic integrity verification on read (detects on-disk corruption/tampering).
    await verifyBlockCid(cid, out);
    return out;
  }

  async hasBlock(cid: string): Promise<boolean> {
    const db = this.assertUsable();
    validateBlockCid(cid);
    const bKey = blockStorageKey(this.roomId, cid);

    return runSyncIdbTransaction<boolean>({
      db,
      stores: [VFS_IDB_STORE_BLOCKS],
      mode: 'readonly',
      fence: this.fence,
      roomId: this.roomId,
      body: (tx, ctl) => {
        const store = tx.objectStore(VFS_IDB_STORE_BLOCKS);
        const req = typeof store.getKey === 'function' ? store.getKey(bKey) : store.get(bKey);
        req.onsuccess = () => {
          ctl.setResult(req.result !== undefined);
        };
      },
    });
  }

  async deleteBlock(cid: string): Promise<boolean> {
    this.assertUsable();
    validateBlockCid(cid);
    const bKey = blockStorageKey(this.roomId, cid);

    return this.enqueueWrite(async () => {
      const db = this.assertUsable();
      let committedMeta: PersistedRoomMeta | undefined;

      const deleted = await runSyncIdbTransaction<boolean>({
        db,
        stores: [VFS_IDB_STORE_BLOCKS, VFS_IDB_STORE_META],
        mode: 'readwrite',
        fence: this.fence,
        roomId: this.roomId,
        body: (tx, ctl) => {
          const blkStore = tx.objectStore(VFS_IDB_STORE_BLOCKS);
          const metaStore = tx.objectStore(VFS_IDB_STORE_META);
          verifyRoomOwnershipInTx(metaStore, this.roomId, this.ownerToken, ctl, () => {
            const getReq = blkStore.get(bKey);
            getReq.onsuccess = () => {
              const raw = getReq.result as StoredBlockRecord | undefined;
              if (raw === undefined) {
                ctl.setResult(false);
                return;
              }
              const bytes = normalizeStoredBytes(raw?.bytes);
              const size = bytes !== undefined ? bytes.byteLength : typeof raw.size === 'number' ? raw.size : 0;

              const nextMeta = cloneMeta(this.meta);
              nextMeta.coldCasBytes = Math.max(0, nextMeta.coldCasBytes - size);
              nextMeta.coldCasBlocks = Math.max(0, nextMeta.coldCasBlocks - 1);
              if (typeof raw.authorMemberId === 'string') {
                const prev = nextMeta.memberCasBytes[raw.authorMemberId] ?? 0;
                const next = Math.max(0, prev - size);
                if (next === 0) delete nextMeta.memberCasBytes[raw.authorMemberId];
                else nextMeta.memberCasBytes[raw.authorMemberId] = next;
              }

              blkStore.delete(bKey);
              metaStore.put(nextMeta, roomMetaStorageKey(this.roomId));
              committedMeta = nextMeta;
              ctl.setResult(true);
            };
          });
        },
      });

      if (committedMeta) {
        this.meta = committedMeta;
      }
      return deleted;
    });
  }

  async checkpoint(): Promise<void> {
    await this.enqueueWrite(async () => {
      const db = this.assertUsable();
      // Every mutation commits durably in IndexedDB; checkpoint executes a
      // readwrite ownership-checked metadata sync barrier to verify the backing DB is healthy.
      await runSyncIdbTransaction<void>({
        db,
        stores: [VFS_IDB_STORE_META],
        mode: 'readwrite',
        fence: this.fence,
        roomId: this.roomId,
        body: (tx, ctl) => {
          const metaStore = tx.objectStore(VFS_IDB_STORE_META);
          verifyRoomOwnershipInTx(metaStore, this.roomId, this.ownerToken, ctl, () => {
            metaStore.put(cloneMeta(this.meta), roomMetaStorageKey(this.roomId));
          });
        },
      });
    });
  }

  async stats(): Promise<VfsRoomStats> {
    if (this.closed) {
      throw new VfsError('VFS_STORAGE_CLOSED', `VFS room store for ${this.roomId} is closed.`);
    }
    return {
      hotKvBytes: this.meta.hotKvBytes,
      hotKvKeys: this.meta.hotKvKeys,
      coldCasBytes: this.meta.coldCasBytes,
      coldCasBlocks: this.meta.coldCasBlocks,
      fenced: this.fence.fenced,
      ...(this.fence.reason !== undefined ? { fencedReason: this.fence.reason } : {}),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.drainWrites();
    this.closed = true;
    this.onClose(this);
  }
}

// ---------------------------------------------------------------------------
// IndexedDbVfsStore
// ---------------------------------------------------------------------------

export class IndexedDbVfsStore implements VfsStore {
  readonly kind: VfsStoreKind = 'indexeddb';
  readonly dbName: string;

  private readonly idb: IDBFactory;
  private readonly keyRange?: IdbKeyRangeFactory;
  private dbPromise?: Promise<IDBDatabase>;
  private activeDb?: IDBDatabase;
  private closed = false;
  private openHandles = new Set<IndexedDbVfsRoomStore>();
  private lastOwnerTokens = new Map<string, string>();

  constructor(options: IndexedDbVfsStoreOptions = {}) {
    const idb = options.idb ?? (typeof indexedDB !== 'undefined' ? indexedDB : undefined);
    if (!idb) {
      throw new VfsError('VFS_STORAGE_FAILED', 'IndexedDB is unavailable in this environment.');
    }
    this.idb = idb;
    this.keyRange = options.keyRange;
    this.dbName = options.dbName ?? DEFAULT_VFS_IDB_NAME;
  }

  /** Opens the database eagerly and returns a ready `IndexedDbVfsStore`. */
  static async open(options: IndexedDbVfsStoreOptions = {}): Promise<IndexedDbVfsStore> {
    const store = new IndexedDbVfsStore(options);
    await store.ensureDb();
    return store;
  }

  private async ensureDb(): Promise<IDBDatabase> {
    if (this.closed) {
      throw new VfsError('VFS_STORAGE_CLOSED', 'IndexedDbVfsStore is closed.');
    }
    if (this.activeDb) return this.activeDb;
    if (!this.dbPromise) {
      const opening = openIdbDatabase(this.idb, this.dbName)
        .then((db) => {
          if (this.closed) {
            db.close();
            throw new VfsError('VFS_STORAGE_CLOSED', 'IndexedDbVfsStore is closed.');
          }
          const handleDisconnect = (reason: string) => {
            if (this.activeDb === db) this.activeDb = undefined;
            if (this.dbPromise === opening) this.dbPromise = undefined;
            for (const room of this.openHandles) {
              room.fence.trip(reason);
            }
          };
          db.onclose = () => handleDisconnect('IndexedDB connection closed unexpectedly by browser.');
          db.onversionchange = () => {
            handleDisconnect('IndexedDB version change requested by another tab.');
            try {
              db.close();
            } catch {
              // Already closed.
            }
          };
          this.activeDb = db;
          return db;
        })
        .catch((err) => {
          if (this.dbPromise === opening) this.dbPromise = undefined;
          throw err;
        });
      this.dbPromise = opening;
    }
    return this.dbPromise;
  }

  private requireActiveDb(): IDBDatabase {
    if (this.closed) {
      throw new VfsError('VFS_STORAGE_CLOSED', 'IndexedDbVfsStore is closed.');
    }
    if (!this.activeDb) {
      throw new VfsError('VFS_STORAGE_FAILED', 'IndexedDB database handle is not open.');
    }
    return this.activeDb;
  }

  /**
   * Reconstructs exact room quota counters (`hotKvBytes`, `hotKvKeys`, `coldCasBytes`,
   * `coldCasBlocks`, `memberCasBytes`) directly from durable `vfs_kv` and `vfs_blocks`
   * AND claims room ownership by writing `fence:<roomId>` (`{ roomId, ownerToken, claimedAt }`)
   * plus ground-truth `room:<roomId>` in ONE atomic `readwrite` transaction so any displaced tab's
   * subsequent `readwrite` transaction fails closed with `VFS_STORAGE_FENCED`.
   */
  private reconstructAndClaimRoom(
    db: IDBDatabase,
    roomId: string,
    ownerToken: string,
  ): Promise<PersistedRoomMeta> {
    const kvPrefix = vfsRoomPrefix(roomId);
    const kvRange = makeBoundRange(this.keyRange, kvPrefix, nextPrefixUpperBound(kvPrefix), false, true);
    const blkPrefix = `${roomId}:`;
    const blkRange = makeBoundRange(this.keyRange, blkPrefix, `${roomId};`, false, true);

    return runSyncIdbTransaction<PersistedRoomMeta>({
      db,
      stores: [VFS_IDB_STORE_KV, VFS_IDB_STORE_BLOCKS, VFS_IDB_STORE_META],
      mode: 'readwrite',
      roomId,
      body: (tx, ctl) => {
        const meta: PersistedRoomMeta = {
          v: 1,
          roomId,
          hotKvBytes: 0,
          hotKvKeys: 0,
          coldCasBytes: 0,
          coldCasBlocks: 0,
          memberCasBytes: {},
          hasHighCodeUnits: false,
        };
        ctl.setResult(meta);

        const kvStore = tx.objectStore(VFS_IDB_STORE_KV);
        const blkStore = tx.objectStore(VFS_IDB_STORE_BLOCKS);
        const metaStore = tx.objectStore(VFS_IDB_STORE_META);

        const scanBlocksAndClaim = () => {
          const blkReq = blkStore.openCursor(blkRange, 'next');
          blkReq.onsuccess = () => {
            const cursor = blkReq.result;
            if (!cursor) {
              const fenceRecord: PersistedRoomFence = {
                v: 1,
                roomId,
                ownerToken,
                claimedAt: Date.now(),
              };
              metaStore.put(cloneMeta(meta), roomMetaStorageKey(roomId));
              metaStore.put(fenceRecord, roomFenceStorageKey(roomId));
              return;
            }
            const k = String(cursor.key);
            if (!k.startsWith(blkPrefix)) {
              const fenceRecord: PersistedRoomFence = {
                v: 1,
                roomId,
                ownerToken,
                claimedAt: Date.now(),
              };
              metaStore.put(cloneMeta(meta), roomMetaStorageKey(roomId));
              metaStore.put(fenceRecord, roomFenceStorageKey(roomId));
              return;
            }
            const rec = cursor.value as StoredBlockRecord | undefined;
            const bytes = normalizeStoredBytes(rec?.bytes);
            const size = bytes !== undefined ? bytes.byteLength : typeof rec?.size === 'number' ? rec.size : 0;
            meta.coldCasBlocks += 1;
            meta.coldCasBytes += size;
            if (typeof rec?.authorMemberId === 'string') {
              meta.memberCasBytes[rec.authorMemberId] = (meta.memberCasBytes[rec.authorMemberId] ?? 0) + size;
            }
            cursor.continue();
          };
        };

        const kvReq = kvStore.openCursor(kvRange, 'next');
        kvReq.onsuccess = () => {
          const cursor = kvReq.result;
          if (!cursor) {
            scanBlocksAndClaim();
            return;
          }
          const k = String(cursor.key);
          if (!k.startsWith(kvPrefix)) {
            scanBlocksAndClaim();
            return;
          }
          const val = normalizeStoredBytes(cursor.value);
          if (val !== undefined) {
            meta.hotKvKeys += 1;
            meta.hotKvBytes += kvEntryBytes(k, val);
            if (hasHighCodeUnit(k)) meta.hasHighCodeUnits = true;
          }
          cursor.continue();
        };
      },
    });
  }

  async openRoom(roomId: string, quotas?: Partial<VfsStoreQuotas>): Promise<IndexedDbVfsRoomStore> {
    if (this.closed) {
      throw new VfsError('VFS_STORAGE_CLOSED', 'IndexedDbVfsStore is closed.');
    }
    validateVfsRoomId(roomId);
    const resolved = resolveVfsStoreQuotas(this.kind, quotas);
    const db = await this.ensureDb();

    const ownerToken = crypto.randomUUID();
    const initialMeta = await this.reconstructAndClaimRoom(db, roomId, ownerToken);
    this.lastOwnerTokens.set(roomId, ownerToken);

    const handle = new IndexedDbVfsRoomStore(
      roomId,
      () => this.requireActiveDb(),
      this.keyRange,
      resolved,
      ownerToken,
      initialMeta,
      (h) => {
        this.openHandles.delete(h);
      },
    );
    this.openHandles.add(handle);
    return handle;
  }

  async destroyRoom(roomId: string): Promise<void> {
    if (this.closed) {
      throw new VfsError('VFS_STORAGE_CLOSED', 'IndexedDbVfsStore is closed.');
    }
    validateVfsRoomId(roomId);

    const matchingHandles = [...this.openHandles].filter((h) => h.roomId === roomId);
    await Promise.all(matchingHandles.map((h) => h.drainWrites()));

    const expectedOwnerToken = this.lastOwnerTokens.get(roomId);
    const db = await this.ensureDb();
    const kvPrefix = vfsRoomPrefix(roomId);
    const kvRange = makeBoundRange(this.keyRange, kvPrefix, nextPrefixUpperBound(kvPrefix), false, true);
    const blkPrefix = `${roomId}:`;
    const blkRange = makeBoundRange(this.keyRange, blkPrefix, `${roomId};`, false, true);

    await runSyncIdbTransaction<void>({
      db,
      stores: [VFS_IDB_STORE_KV, VFS_IDB_STORE_BLOCKS, VFS_IDB_STORE_META],
      mode: 'readwrite',
      roomId,
      body: (tx, ctl) => {
        const kvStore = tx.objectStore(VFS_IDB_STORE_KV);
        const blkStore = tx.objectStore(VFS_IDB_STORE_BLOCKS);
        const metaStore = tx.objectStore(VFS_IDB_STORE_META);

        const performDelete = () => {
          kvStore.delete(kvRange);
          blkStore.delete(blkRange);
          metaStore.delete(roomMetaStorageKey(roomId));
          metaStore.delete(roomFenceStorageKey(roomId));
        };

        if (expectedOwnerToken === undefined) {
          performDelete();
          return;
        }

        const fenceReq = metaStore.get(roomFenceStorageKey(roomId));
        fenceReq.onsuccess = () => {
          const rec = fenceReq.result as PersistedRoomFence | undefined;
          if (rec !== undefined && rec.ownerToken !== expectedOwnerToken) {
            for (const h of matchingHandles) {
              h.fence.trip(TAB_OWNERSHIP_LOST_REASON);
            }
            ctl.abortFenced(TAB_OWNERSHIP_LOST_REASON);
            return;
          }
          performDelete();
        };
      },
    });

    for (const handle of matchingHandles) {
      handle.forceClose();
      this.openHandles.delete(handle);
    }
    this.lastOwnerTokens.delete(roomId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const handles = [...this.openHandles];
    for (const handle of handles) {
      handle.forceClose();
    }
    this.openHandles.clear();
    this.lastOwnerTokens.clear();
    await Promise.all(handles.map((h) => h.drainWrites()));
    const db = this.activeDb;
    this.activeDb = undefined;
    this.dbPromise = undefined;
    if (db) {
      try {
        db.onclose = null;
        db.onversionchange = null;
        db.close();
      } catch {
        // Already closed.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Browser Entrypoint with Explicit Safari Private / Restricted Fallback
// ---------------------------------------------------------------------------

/**
 * Opens the browser Room VFS store:
 * 1. Requests `navigator.storage.persist()` best-effort (non-fatal if unsupported or denied).
 * 2. Attempts to open `IndexedDbVfsStore` (`meshrooms-vfs-v1`).
 * 3. If IndexedDB is unavailable or fails with `SecurityError` / `InvalidStateError` /
 *    restricted storage (e.g. Safari Private Browsing or sandboxed iframe), falls back
 *    explicitly to `MemoryVfsStore` returning `{ store, persistent: false, reason }` —
 *    never crashing and never silently claiming durability.
 */
export async function openBrowserVfsStore(
  options: OpenBrowserVfsStoreOptions = {},
): Promise<OpenBrowserVfsStoreResult> {
  let persistedGrant: boolean | undefined;

  if (options.requestPersist !== false) {
    try {
      const storageMgr =
        options.storageManager !== undefined
          ? options.storageManager
          : (typeof navigator !== 'undefined' ? navigator.storage : undefined);
      if (storageMgr && typeof storageMgr.persist === 'function') {
        persistedGrant = await storageMgr.persist();
      }
    } catch {
      // Storage persistence API is optional; never block opening storage.
    }
  }

  let idb: IDBFactory | null | undefined;
  if (options.idb !== undefined) {
    idb = options.idb;
  } else {
    try {
      idb = typeof indexedDB !== 'undefined' ? indexedDB : undefined;
    } catch (err) {
      return {
        store: new MemoryVfsStore(),
        persistent: false,
        reason: describeStorageError(err),
      };
    }
  }

  if (!idb) {
    return {
      store: new MemoryVfsStore(),
      persistent: false,
      reason: 'IndexedDB is unavailable in this browser context.',
    };
  }

  try {
    const store = await IndexedDbVfsStore.open({
      idb,
      keyRange: options.keyRange,
      dbName: options.dbName,
    });
    return {
      store,
      persistent: true,
      ...(persistedGrant !== undefined ? { persistedGrant } : {}),
    };
  } catch (err) {
    return {
      store: new MemoryVfsStore(),
      persistent: false,
      reason: describeStorageError(err),
    };
  }
}
