import { describe, expect, test } from 'bun:test';
import { VfsError, vfsMetaKey, vfsNodeHeadKey, vfsRoomPrefix, type VfsErrorCode } from './constants';
import { computeCid, utf8Bytes } from './envelope';
import { MemoryVfsStore, kvEntryBytes } from './store';
import { runVfsStoreConformanceSuite } from './store-conformance';
import {
  DEFAULT_VFS_IDB_NAME,
  IndexedDbVfsStore,
  VFS_IDB_STORE_BLOCKS,
  VFS_IDB_STORE_KV,
  VFS_IDB_STORE_META,
  openBrowserVfsStore,
  roomFenceStorageKey,
  type IdbKeyRangeFactory,
} from './store-indexeddb';

// ---------------------------------------------------------------------------
// Spec-accurate in-memory IDBFactory test harness (zero external dependencies)
// ---------------------------------------------------------------------------

type KeyRangeLike = {
  lower?: string;
  upper?: string;
  lowerOpen: boolean;
  upperOpen: boolean;
  includes(key: unknown): boolean;
};

const fakeKeyRange: IdbKeyRangeFactory = {
  bound(lower: unknown, upper: unknown, lowerOpen = false, upperOpen = false): IDBKeyRange {
    const lo = String(lower);
    const hi = String(upper);
    return {
      lower: lo,
      upper: hi,
      lowerOpen,
      upperOpen,
      includes(key: unknown): boolean {
        if (typeof key !== 'string') return false;
        if (lowerOpen ? key <= lo : key < lo) return false;
        if (upperOpen ? key >= hi : key > hi) return false;
        return true;
      },
    } as IDBKeyRange;
  },
  lowerBound(lower: unknown, open = false): IDBKeyRange {
    const lo = String(lower);
    return {
      lower: lo,
      upper: undefined,
      lowerOpen: open,
      upperOpen: false,
      includes(key: unknown): boolean {
        if (typeof key !== 'string') return false;
        return open ? key > lo : key >= lo;
      },
    } as IDBKeyRange;
  },
};

function isKeyRangeLike(v: unknown): v is KeyRangeLike {
  return !!v && typeof v === 'object' && typeof (v as KeyRangeLike).includes === 'function';
}

function cloneStructured<T>(value: T): T {
  if (value instanceof Uint8Array) {
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    return copy as T;
  }
  if (Array.isArray(value)) {
    return value.map(cloneStructured) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = cloneStructured(v);
    }
    return out as T;
  }
  return value;
}

class FakeIDBFactory {
  private readonly dbs = new Map<string, { version: number; stores: Map<string, Map<string, unknown>> }>();
  failOpenWith?: Error;
  failNextTxWith?: Error;
  failNextPutWith?: Error;
  blockNextOpen = false;

  /** Direct backing-store accessor for simulating on-disk corruption in tests. */
  getRawStore(dbName: string, storeName: string): Map<string, unknown> | undefined {
    return this.dbs.get(dbName)?.stores.get(storeName);
  }

  asFactory(): IDBFactory {
    return {
      open: (name: string, version = 1) => this.open(name, version),
      deleteDatabase: (name: string) => {
        const req: Record<string, unknown> = { result: undefined, error: null };
        queueMicrotask(() => {
          this.dbs.delete(name);
          if (typeof req.onsuccess === 'function') (req.onsuccess as () => void)();
        });
        return req as unknown as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory;
  }

  private open(name: string, version: number): IDBOpenDBRequest {
    const req: Record<string, unknown> = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      onblocked: null,
    };

    queueMicrotask(() => {
      if (this.blockNextOpen) {
        this.blockNextOpen = false;
        if (typeof req.onblocked === 'function') (req.onblocked as () => void)();
        return;
      }
      if (this.failOpenWith) {
        const err = this.failOpenWith;
        req.error = err;
        if (typeof req.onerror === 'function') (req.onerror as () => void)();
        return;
      }

      let dbRecord = this.dbs.get(name);
      const needsUpgrade = !dbRecord || dbRecord.version < version;
      if (!dbRecord) {
        dbRecord = { version: 0, stores: new Map() };
        this.dbs.set(name, dbRecord);
      }

      let isClosed = false;
      const handle: Record<string, unknown> = {
        name,
        version,
        onclose: null,
        onversionchange: null,
        get objectStoreNames() {
          const names = [...dbRecord!.stores.keys()];
          return {
            contains: (storeName: string) => dbRecord!.stores.has(storeName),
            length: names.length,
            item: (i: number) => names[i] ?? null,
            [Symbol.iterator]: () => names[Symbol.iterator](),
          };
        },
        createObjectStore: (storeName: string) => {
          if (!dbRecord!.stores.has(storeName)) {
            dbRecord!.stores.set(storeName, new Map());
          }
          return {};
        },
        close: () => {
          isClosed = true;
        },
        transaction: (storeNames: string | string[], mode: IDBTransactionMode = 'readonly') => {
          if (isClosed) {
            throw new DOMException('The database connection is closing.', 'InvalidStateError');
          }
          const names = Array.isArray(storeNames) ? storeNames : [storeNames];
          for (const s of names) {
            if (!dbRecord!.stores.has(s)) {
              throw new DOMException(`Object store "${s}" not found.`, 'NotFoundError');
            }
          }
          return this.createTransaction(dbRecord!, names, mode);
        },
      };

      req.result = handle;
      if (needsUpgrade) {
        dbRecord.version = version;
        if (typeof req.onupgradeneeded === 'function') {
          (req.onupgradeneeded as () => void)();
        }
      }
      if (typeof req.onsuccess === 'function') {
        (req.onsuccess as () => void)();
      }
    });

    return req as unknown as IDBOpenDBRequest;
  }

  private createTransaction(
    dbRecord: { version: number; stores: Map<string, Map<string, unknown>> },
    storeNames: string[],
    mode: IDBTransactionMode,
  ): IDBTransaction {
    // Working snapshots per store so `tx.abort()` rolls back atomically.
    const working = new Map<string, Map<string, unknown>>();
    for (const name of storeNames) {
      const live = dbRecord.stores.get(name)!;
      const snap = new Map<string, unknown>();
      for (const [k, v] of live.entries()) {
        snap.set(k, cloneStructured(v));
      }
      working.set(name, snap);
    }

    let aborted = false;
    let finished = false;
    let pendingReqs = 0;
    let commitScheduled = false;

    const tx: Record<string, unknown> = {
      mode,
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      abort: () => {
        if (finished || aborted) return;
        aborted = true;
        finished = true;
        queueMicrotask(() => {
          if (typeof tx.onabort === 'function') (tx.onabort as () => void)();
        });
      },
      objectStore: (name: string) => {
        const map = working.get(name);
        if (!map) {
          throw new DOMException(`Store "${name}" not in transaction scope.`, 'NotFoundError');
        }
        return makeStoreProxy(map);
      },
    };

    const scheduleFinishCheck = () => {
      if (commitScheduled || finished || aborted) return;
      commitScheduled = true;
      queueMicrotask(() => {
        commitScheduled = false;
        if (finished || aborted || pendingReqs > 0) return;

        // Allow injecting a commit-time / transaction-level fault.
        if (this.failNextTxWith) {
          const err = this.failNextTxWith;
          this.failNextTxWith = undefined;
          aborted = true;
          finished = true;
          tx.error = err;
          if (typeof tx.onerror === 'function') (tx.onerror as (e: unknown) => void)({ target: tx });
          if (typeof tx.onabort === 'function') (tx.onabort as () => void)();
          return;
        }

        finished = true;
        if (mode === 'readwrite') {
          for (const [storeName, snap] of working.entries()) {
            dbRecord.stores.set(storeName, snap);
          }
        }
        if (typeof tx.oncomplete === 'function') {
          (tx.oncomplete as () => void)();
        }
      });
    };

    const runReq = <T>(exec: () => T): IDBRequest<T> => {
      if (finished || aborted) {
        throw new DOMException('Transaction is no longer active.', 'TransactionInactiveError');
      }
      pendingReqs += 1;
      const req: Record<string, unknown> = {
        result: undefined,
        error: null,
        onsuccess: null,
        onerror: null,
      };
      queueMicrotask(() => {
        try {
          if (aborted) return;
          const res = exec();
          req.result = res;
          if (typeof req.onsuccess === 'function') {
            (req.onsuccess as () => void)();
          }
        } catch (err) {
          req.error = err;
          tx.error = err;
          if (typeof req.onerror === 'function') {
            (req.onerror as (e: unknown) => void)({ target: req });
          }
          if (typeof tx.onerror === 'function') {
            (tx.onerror as (e: unknown) => void)({ target: req });
          }
          if (!aborted) {
            aborted = true;
            finished = true;
            if (typeof tx.onabort === 'function') {
              (tx.onabort as () => void)();
            }
          }
        } finally {
          pendingReqs -= 1;
          scheduleFinishCheck();
        }
      });
      return req as unknown as IDBRequest<T>;
    };

    const makeStoreProxy = (map: Map<string, unknown>) => ({
      get: (key: string) => runReq(() => cloneStructured(map.get(key))),
      getKey: (key: string) => runReq(() => (map.has(key) ? key : undefined)),
      put: (value: unknown, key: string) => {
        if (mode !== 'readwrite') {
          throw new DOMException('ReadOnly transaction.', 'ReadOnlyError');
        }
        return runReq(() => {
          if (this.failNextPutWith) {
            const err = this.failNextPutWith;
            this.failNextPutWith = undefined;
            throw err;
          }
          map.set(key, cloneStructured(value));
          return key;
        });
      },
      delete: (keyOrRange: string | KeyRangeLike) => {
        if (mode !== 'readwrite') {
          throw new DOMException('ReadOnly transaction.', 'ReadOnlyError');
        }
        return runReq(() => {
          if (isKeyRangeLike(keyOrRange)) {
            for (const k of [...map.keys()]) {
              if (keyOrRange.includes(k)) map.delete(k);
            }
          } else {
            map.delete(keyOrRange);
          }
          return undefined;
        });
      },
      openCursor: (range?: KeyRangeLike | null, direction: IDBCursorDirection = 'next') => {
        if (finished || aborted) {
          throw new DOMException('Transaction is no longer active.', 'TransactionInactiveError');
        }
        pendingReqs += 1;
        const req: Record<string, unknown> = {
          result: null,
          error: null,
          onsuccess: null,
          onerror: null,
        };

        // Spec-accurate JS UTF-16 code-unit ascending key order.
        const matchingKeys = [...map.keys()]
          .filter((k) => (!range ? true : range.includes(k)))
          .sort();
        if (direction === 'prev' || direction === 'prevunique') {
          matchingKeys.reverse();
        }

        let idx = 0;
        const emitStep = () => {
          queueMicrotask(() => {
            if (aborted) {
              pendingReqs = Math.max(0, pendingReqs - 1);
              return;
            }
            if (idx >= matchingKeys.length) {
              req.result = null;
              if (typeof req.onsuccess === 'function') (req.onsuccess as () => void)();
              pendingReqs -= 1;
              scheduleFinishCheck();
              return;
            }
            const k = matchingKeys[idx]!;
            let continued = false;
            req.result = {
              key: k,
              primaryKey: k,
              value: cloneStructured(map.get(k)),
              continue: () => {
                continued = true;
                idx += 1;
                emitStep();
              },
            };
            if (typeof req.onsuccess === 'function') (req.onsuccess as () => void)();
            if (!continued) {
              pendingReqs -= 1;
              scheduleFinishCheck();
            }
          });
        };

        emitStep();
        return req as unknown as IDBRequest<IDBCursorWithValue | null>;
      },
    });

    // Ensure an empty transaction also completes cleanly.
    scheduleFinishCheck();
    return tx as unknown as IDBTransaction;
  }
}

async function expectVfsError(promise: Promise<unknown>, code: VfsErrorCode): Promise<VfsError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(VfsError);
  const vfsErr = caught as VfsError;
  expect(vfsErr.code).toBe(code);
  return vfsErr;
}

// ---------------------------------------------------------------------------
// 1. Full Shared Conformance Suite (with `persistent: true` close + reopen!)
// ---------------------------------------------------------------------------

runVfsStoreConformanceSuite(
  'IndexedDbVfsStore',
  () => {
    const fakeIdb = new FakeIDBFactory();
    const dbName = `${DEFAULT_VFS_IDB_NAME}-${crypto.randomUUID()}`;
    return {
      create: () => IndexedDbVfsStore.open({ idb: fakeIdb.asFactory(), keyRange: fakeKeyRange, dbName }),
      reopen: () => IndexedDbVfsStore.open({ idb: fakeIdb.asFactory(), keyRange: fakeKeyRange, dbName }),
    };
  },
  { persistent: true },
);

// ---------------------------------------------------------------------------
// 2. IndexedDbVfsStore-Specific Resilience, Fencing & Private-Mode Fallback
// ---------------------------------------------------------------------------

const ROOM_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const ROOM_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const NODE_A = 'cccccccc-3333-4333-8333-333333333333';

describe('IndexedDbVfsStore dedicated resilience, fencing, corruption & private fallback', () => {
  test('QuotaExceededError aborts transaction cleanly, trips VfsRoomFence fail-closed, and recovers after reopen', async () => {
    const fakeIdb = new FakeIDBFactory();
    const dbName = 'meshrooms-vfs-quota-test';
    const store = await IndexedDbVfsStore.open({ idb: fakeIdb.asFactory(), keyRange: fakeKeyRange, dbName });

    const room = await store.openRoom(ROOM_A);
    const k1 = vfsMetaKey(ROOM_A);
    const k2 = vfsNodeHeadKey(ROOM_A, NODE_A);

    await room.kvPut(k1, utf8Bytes('committed-ok'));
    expect((await room.stats()).hotKvKeys).toBe(1);

    // Inject browser QuotaExceededError on next IndexedDB put
    fakeIdb.failNextPutWith = new DOMException('Browser storage quota exceeded', 'QuotaExceededError');
    await expectVfsError(room.kvPut(k2, utf8Bytes('should-rollback')), 'VFS_STORAGE_QUOTA');

    // Room fence MUST now be latched fail-closed!
    expect(room.isFenced).toBe(true);
    const st = await room.stats();
    expect(st.fenced).toBe(true);
    expect(st.fencedReason).toContain('QuotaExceededError');
    expect(st.hotKvKeys).toBe(1);

    // All subsequent reads and writes fail closed with VFS_STORAGE_FENCED
    await expectVfsError(room.kvGet(k1), 'VFS_STORAGE_FENCED');
    await expectVfsError(room.kvPut(k2, utf8Bytes('blocked')), 'VFS_STORAGE_FENCED');
    await expectVfsError(room.kvScanPrefix(vfsRoomPrefix(ROOM_A)), 'VFS_STORAGE_FENCED');
    await expectVfsError(room.checkpoint(), 'VFS_STORAGE_FENCED');

    await room.close();
    await store.close();

    // Reopen recovers cleanly: k1 survived, aborted k2 was rolled back!
    const reopenedStore = await IndexedDbVfsStore.open({ idb: fakeIdb.asFactory(), keyRange: fakeKeyRange, dbName });
    const reopenedRoom = await reopenedStore.openRoom(ROOM_A);
    expect(reopenedRoom.isFenced).toBe(false);
    expect(await reopenedRoom.kvGet(k1)).toEqual(utf8Bytes('committed-ok'));
    expect(await reopenedRoom.kvGet(k2)).toBeUndefined();
    expect((await reopenedRoom.stats()).hotKvKeys).toBe(1);
    expect((await reopenedRoom.stats()).hotKvBytes).toBe(kvEntryBytes(k1, utf8Bytes('committed-ok')));

    await reopenedRoom.close();
    await reopenedStore.close();
  });

  test('unexpected AbortError on transaction trips VfsRoomFence fail-closed without corrupting sibling room', async () => {
    const fakeIdb = new FakeIDBFactory();
    const store = await IndexedDbVfsStore.open({ idb: fakeIdb.asFactory(), keyRange: fakeKeyRange });

    const rA = await store.openRoom(ROOM_A);
    const rB = await store.openRoom(ROOM_B);
    await rB.kvPut(vfsMetaKey(ROOM_B), utf8Bytes('sibling-healthy'));

    fakeIdb.failNextTxWith = new DOMException('Disk I/O error', 'AbortError');
    await expectVfsError(rA.kvPut(vfsMetaKey(ROOM_A), utf8Bytes('boom')), 'VFS_STORAGE_FAILED');

    expect(rA.isFenced).toBe(true);
    await expectVfsError(rA.kvGet(vfsMetaKey(ROOM_A)), 'VFS_STORAGE_FENCED');

    // Sibling room B remains completely unfenced and operational!
    expect(rB.isFenced).toBe(false);
    expect(await rB.kvGet(vfsMetaKey(ROOM_B))).toEqual(utf8Bytes('sibling-healthy'));

    await rA.close();
    await rB.close();
    await store.close();
  });

  test('detects on-disk CAS block corruption on getBlock() via SHA-256 verification', async () => {
    const fakeIdb = new FakeIDBFactory();
    const dbName = 'meshrooms-vfs-corrupt-test';
    const store = await IndexedDbVfsStore.open({ idb: fakeIdb.asFactory(), keyRange: fakeKeyRange, dbName });
    const room = await store.openRoom(ROOM_A);

    const payload = utf8Bytes('authentic-encrypted-cas-block');
    const cid = await computeCid(payload);
    expect(await room.putBlock(cid, payload)).toBe(true);
    expect(await room.getBlock(cid)).toEqual(payload);

    // Tamper with a single byte directly in the backing IndexedDB object store
    const rawBlocks = fakeIdb.getRawStore(dbName, VFS_IDB_STORE_BLOCKS)!;
    const rawRec = rawBlocks.get(`${ROOM_A}:${cid}`) as { bytes: Uint8Array };
    rawRec.bytes[0] = rawRec.bytes[0]! ^ 0xff;

    await expectVfsError(room.getBlock(cid), 'VFS_INVALID_ENVELOPE');

    // Calling putBlock with valid bytes atomically heals the corrupted block and returns true
    expect(await room.putBlock(cid, payload)).toBe(true);
    expect(await room.getBlock(cid)).toEqual(payload);
    expect((await room.stats()).coldCasBlocks).toBe(1);
    expect((await room.stats()).coldCasBytes).toBe(payload.byteLength);

    await room.close();
    await store.close();
  });

  test('preserves exact UTF-8 byte ordering even when keys contain high Unicode code units (>= 0xd800)', async () => {
    const fakeIdb = new FakeIDBFactory();
    const store = await IndexedDbVfsStore.open({ idb: fakeIdb.asFactory(), keyRange: fakeKeyRange });
    const room = await store.openRoom(ROOM_A);
    const p = `${vfsRoomPrefix(ROOM_A)}u:`;

    // U+E000 (UTF-8: EE 80 80, UTF-16: E000) MUST sort BEFORE U+1F680 🚀 (UTF-8: F0 9F 9A 80, UTF-16: D83D DE80)!
    const kPua = `${p}\uE000`;
    const kEmoji = `${p}🚀`;
    const kAscii = `${p}a`;

    await room.kvPut(kEmoji, utf8Bytes('emoji'));
    await room.kvPut(kPua, utf8Bytes('pua'));
    await room.kvPut(kAscii, utf8Bytes('ascii'));

    const scanned = await room.kvScanPrefix(p);
    expect(scanned.map((e) => e.key)).toEqual([kAscii, kPua, kEmoji]);

    const afterPua = await room.kvScanPrefix(p, { afterKey: kPua });
    expect(afterPua.map((e) => e.key)).toEqual([kEmoji]);

    const lastOne = await room.kvScanPrefix(p, { limit: 1, direction: 'last' });
    expect(lastOne.map((e) => e.key)).toEqual([kEmoji]);

    const beforeEmoji = await room.kvScanPrefix(p, { limit: 1, direction: 'last', beforeKey: kEmoji });
    expect(beforeEmoji.map((e) => e.key)).toEqual([kPua]);

    await room.close();
    await store.close();
  });

  test('cross-tab ownership fence aborts displaced Tab A writes with VFS_STORAGE_FENCED without corrupting Tab B', async () => {
    const fakeIdb = new FakeIDBFactory();
    const dbName = 'meshrooms-vfs-multitab-fence';
    const kMeta = vfsMetaKey(ROOM_A);
    const kNode = vfsNodeHeadKey(ROOM_A, NODE_A);
    const kExtra = `${vfsRoomPrefix(ROOM_A)}extra`;
    const blk1 = utf8Bytes('tab-a-initial-block');
    const cid1 = await computeCid(blk1);
    const blk2 = utf8Bytes('tab-a-displaced-block');
    const cid2 = await computeCid(blk2);

    const tabA = await IndexedDbVfsStore.open({ idb: fakeIdb.asFactory(), keyRange: fakeKeyRange, dbName });
    const tabB = await IndexedDbVfsStore.open({ idb: fakeIdb.asFactory(), keyRange: fakeKeyRange, dbName });

    try {
      // Tab A opens room and commits initial KV + CAS block.
      const roomA = await tabA.openRoom(ROOM_A);
      await roomA.kvPut(kMeta, utf8Bytes('from-tab-a'));
      expect(await roomA.putBlock(cid1, blk1)).toBe(true);

      // Tab B opens the same room on the same IDB -> takes ownership & reconstructs ground-truth meta.
      const roomB = await tabB.openRoom(ROOM_A);
      expect(roomB.ownerToken).not.toBe(roomA.ownerToken);
      expect(await roomB.kvGet(kMeta)).toEqual(utf8Bytes('from-tab-a'));
      expect(await roomB.getBlock(cid1)).toEqual(blk1);
      await roomB.kvPut(kNode, utf8Bytes('from-tab-b'));

      const metaRaw = fakeIdb.getRawStore(dbName, VFS_IDB_STORE_META)!;
      const snapshotMetaBefore = JSON.stringify(metaRaw.get(`room:${ROOM_A}`));
      const snapshotFenceBefore = JSON.stringify(metaRaw.get(roomFenceStorageKey(ROOM_A)));

      // Displaced Tab A tries kvPut -> fails closed with VFS_STORAGE_FENCED and latches fence!
      await expectVfsError(roomA.kvPut(kMeta, utf8Bytes('stale-overwrite')), 'VFS_STORAGE_FENCED');
      expect(roomA.isFenced).toBe(true);
      expect((await roomA.stats()).fenced).toBe(true);
      expect((await roomA.stats()).fencedReason).toContain('ownership');
      await expectVfsError(roomA.kvGet(kMeta), 'VFS_STORAGE_FENCED');

      // Tab B's KV, blocks, vfs_meta, and fence record are 100% untouched!
      expect(await roomB.kvGet(kMeta)).toEqual(utf8Bytes('from-tab-a'));
      expect(await roomB.kvGet(kNode)).toEqual(utf8Bytes('from-tab-b'));
      expect(JSON.stringify(metaRaw.get(`room:${ROOM_A}`))).toBe(snapshotMetaBefore);
      expect(JSON.stringify(metaRaw.get(roomFenceStorageKey(ROOM_A)))).toBe(snapshotFenceBefore);

      // Verify EVERY other mutating transaction (kvPutIfAbsent, kvDelete, putBlock, deleteBlock, checkpoint, destroyRoom)
      // also checks ownerToken atomically and fails closed with VFS_STORAGE_FENCED when displaced!
      const testDisplacedOp = async (op: (staleStore: IndexedDbVfsStore, staleRoom: Awaited<ReturnType<IndexedDbVfsStore['openRoom']>>) => Promise<unknown>) => {
        const staleTab = await IndexedDbVfsStore.open({ idb: fakeIdb.asFactory(), keyRange: fakeKeyRange, dbName });
        const staleRoom = await staleTab.openRoom(ROOM_A);
        const ownerTab = await IndexedDbVfsStore.open({ idb: fakeIdb.asFactory(), keyRange: fakeKeyRange, dbName });
        const ownerRoom = await ownerTab.openRoom(ROOM_A);
        const metaBefore = JSON.stringify(metaRaw.get(`room:${ROOM_A}`));
        try {
          await expectVfsError(op(staleTab, staleRoom), 'VFS_STORAGE_FENCED');
          expect(staleRoom.isFenced).toBe(true);
          expect(JSON.stringify(metaRaw.get(`room:${ROOM_A}`))).toBe(metaBefore);
          expect(await ownerRoom.kvGet(kNode)).toEqual(utf8Bytes('from-tab-b'));
          expect(await ownerRoom.getBlock(cid1)).toEqual(blk1);
        } finally {
          await staleRoom.close();
          await staleTab.close();
          await ownerRoom.close();
          await ownerTab.close();
        }
      };

      await testDisplacedOp((_s, r) => r.kvPutIfAbsent(kExtra, utf8Bytes('nope')));
      await testDisplacedOp((_s, r) => r.kvDelete(kNode));
      await testDisplacedOp((_s, r) => r.putBlock(cid2, blk2));
      await testDisplacedOp((_s, r) => r.deleteBlock(cid1));
      await testDisplacedOp((_s, r) => r.checkpoint());
      await testDisplacedOp((s) => s.destroyRoom(ROOM_A));

      await roomA.close();
      await roomB.close();
    } finally {
      await tabA.close();
      await tabB.close();
    }
  });

  test('destroyRoom cleans all three stores (vfs_kv, vfs_blocks, vfs_meta) for target room while isolating siblings', async () => {
    const fakeIdb = new FakeIDBFactory();
    const dbName = 'meshrooms-vfs-destroy-test';
    const store = await IndexedDbVfsStore.open({ idb: fakeIdb.asFactory(), keyRange: fakeKeyRange, dbName });

    const rA = await store.openRoom(ROOM_A);
    const rB = await store.openRoom(ROOM_B);
    const blkA = utf8Bytes('block-for-room-a');
    const cidA = await computeCid(blkA);
    const blkB = utf8Bytes('block-for-room-b');
    const cidB = await computeCid(blkB);

    await rA.kvPut(vfsMetaKey(ROOM_A), utf8Bytes('a-meta'));
    await rA.putBlock(cidA, blkA);
    await rB.kvPut(vfsMetaKey(ROOM_B), utf8Bytes('b-meta'));
    await rB.putBlock(cidB, blkB);

    await store.destroyRoom(ROOM_A);

    // Handle rA was force-closed
    await expectVfsError(rA.kvGet(vfsMetaKey(ROOM_A)), 'VFS_STORAGE_CLOSED');

    // Backing IDB stores have zero leftover entries for ROOM_A, and intact entries for ROOM_B
    const kvRaw = fakeIdb.getRawStore(dbName, VFS_IDB_STORE_KV)!;
    const blkRaw = fakeIdb.getRawStore(dbName, VFS_IDB_STORE_BLOCKS)!;
    const metaRaw = fakeIdb.getRawStore(dbName, VFS_IDB_STORE_META)!;

    expect([...kvRaw.keys()]).toEqual([vfsMetaKey(ROOM_B)]);
    expect([...blkRaw.keys()]).toEqual([`${ROOM_B}:${cidB}`]);
    expect(metaRaw.has(`room:${ROOM_A}`)).toBe(false);
    expect(metaRaw.has(`room:${ROOM_B}`)).toBe(true);
    expect(metaRaw.has(roomFenceStorageKey(ROOM_A))).toBe(false);
    expect(metaRaw.has(roomFenceStorageKey(ROOM_B))).toBe(true);

    expect(await rB.kvGet(vfsMetaKey(ROOM_B))).toEqual(utf8Bytes('b-meta'));
    expect(await rB.getBlock(cidB)).toEqual(blkB);

    await rB.close();
    await store.close();
  });

  test('openBrowserVfsStore returns persistent IndexedDbVfsStore when healthy and requests persist()', async () => {
    const fakeIdb = new FakeIDBFactory();
    let persistCalled = false;

    const result = await openBrowserVfsStore({
      idb: fakeIdb.asFactory(),
      keyRange: fakeKeyRange,
      storageManager: {
        persist: async () => {
          persistCalled = true;
          return true;
        },
      },
    });

    expect(persistCalled).toBe(true);
    expect(result.persistent).toBe(true);
    if (result.persistent) {
      expect(result.persistedGrant).toBe(true);
      expect(result.store).toBeInstanceOf(IndexedDbVfsStore);
      expect(result.store.dbName).toBe(DEFAULT_VFS_IDB_NAME);
      const room = await result.store.openRoom(ROOM_A);
      await room.kvPut(vfsMetaKey(ROOM_A), utf8Bytes('ok'));
      expect(await room.kvGet(vfsMetaKey(ROOM_A))).toEqual(utf8Bytes('ok'));
      await room.close();
      await result.store.close();
    }
  });

  test('openBrowserVfsStore falls back explicitly to MemoryVfsStore on Safari Private SecurityError / InvalidStateError / unavailable IDB', async () => {
    // 1. Safari Private Browsing SecurityError
    const secIdb = new FakeIDBFactory();
    secIdb.failOpenWith = new DOMException('The operation is insecure.', 'SecurityError');
    const secRes = await openBrowserVfsStore({
      idb: secIdb.asFactory(),
      keyRange: fakeKeyRange,
      storageManager: { persist: async () => Promise.reject(new Error('denied')) },
    });
    expect(secRes.persistent).toBe(false);
    if (!secRes.persistent) {
      expect(secRes.store).toBeInstanceOf(MemoryVfsStore);
      expect(secRes.reason).toContain('SecurityError');
      const room = await secRes.store.openRoom(ROOM_A);
      await room.kvPut(vfsMetaKey(ROOM_A), utf8Bytes('ephemeral-ok'));
      expect(await room.kvGet(vfsMetaKey(ROOM_A))).toEqual(utf8Bytes('ephemeral-ok'));
      await room.close();
      await secRes.store.close();
    }

    // 2. Firefox Private / disabled storage InvalidStateError
    const invIdb = new FakeIDBFactory();
    invIdb.failOpenWith = new DOMException('A mutation operation was attempted on a database that did not allow mutations.', 'InvalidStateError');
    const invRes = await openBrowserVfsStore({ idb: invIdb.asFactory(), keyRange: fakeKeyRange });
    expect(invRes.persistent).toBe(false);
    if (!invRes.persistent) {
      expect(invRes.store).toBeInstanceOf(MemoryVfsStore);
      expect(invRes.reason).toContain('InvalidStateError');
      await invRes.store.close();
    }

    // 3. Completely absent IndexedDB (null)
    const noneRes = await openBrowserVfsStore({ idb: null });
    expect(noneRes.persistent).toBe(false);
    if (!noneRes.persistent) {
      expect(noneRes.store).toBeInstanceOf(MemoryVfsStore);
      expect(noneRes.reason).toContain('unavailable');
      await noneRes.store.close();
    }
  });
});
