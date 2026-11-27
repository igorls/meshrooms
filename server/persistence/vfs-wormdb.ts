/**
 * Native WormDB FFI `VfsStore` adapter (`WormDbFfiVfsStore`).
 *
 * - Per-room isolated Tier 1 Hot KV WormDB instance at `<baseDir>/<roomId>/wormdb` opened via
 *   `openWormDbBinary` (synchronous per-write WAL fsync + optional `wormdb_checkpoint_sync`).
 * - Bounded LRU open-handle pool (`maxOpenRooms = 16` by default) that evicts idle handles only
 *   when `inFlight === 0`, transparently reopening on demand without losing room quota state or
 *   breaking room-scoped fail-closed fences.
 * - Tier 2 Cold Encrypted CAS at `<baseDir>/<roomId>/blocks/<cid[0..2]>/<cid>` reusing the shared
 *   symlink-hardened, fsync'd `FsColdCasStore` from `./vfs-bunfile.ts`.
 */

import path from 'node:path';
import { VfsError, vfsRoomPrefix } from '../../src/browser/vfs/constants.ts';
import {
  compareUtf8Lex,
  copyBytes,
  kvEntryBytes,
  resolveVfsStoreQuotas,
  validateScanPrefixOptions,
  validateVfsKvKey,
  validateVfsKvPrefix,
  validateVfsRoomId,
  VfsRoomFence,
  type ResolvedVfsStoreQuotas,
  type VfsKvEntry,
  type VfsPutBlockOptions,
  type VfsRoomStats,
  type VfsRoomStore,
  type VfsScanPrefixOptions,
  type VfsStore,
  type VfsStoreKind,
  type VfsStoreQuotas,
} from '../../src/browser/vfs/store.ts';
import { defaultOptions } from '../daemon.ts';
import type { WormDBStoreOptions } from './store.ts';
import {
  acquireRoomLock,
  assertNoSymlinkComponents,
  assertRoomNotLockedByOther,
  destroyRoomDirectory,
  ensureSafeDir,
  FsColdCasStore,
  prepareBaseDir,
  type FsIoHooks,
  type RoomDirectoryLock,
} from './vfs-bunfile.ts';
import { openWormDbBinary, type WormDbBinaryHandle } from './wormdb.ts';

export const DEFAULT_WORMDB_MAX_OPEN_ROOMS = 16;

export type WormDbFfiVfsStoreOptions = {
  baseDir: string;
  libraryPath?: string;
  maxOpenRooms?: number;
  ioHooks?: FsIoHooks;
  /** Optional handle factory override for deterministic unit testing of pooling & fault latching. */
  openBinaryHandle?: (options: WormDBStoreOptions) => WormDbBinaryHandle;
};

type PoolEntry = {
  roomId: string;
  handle: WormDbBinaryHandle;
  inFlight: number;
  lastUsedSeq: number;
};

type WormDbRoomAccounting = {
  roomId: string;
  lock: RoomDirectoryLock;
  keySizes: Map<string, number>;
  hotKvBytes: number;
  cas: FsColdCasStore;
  handles: Set<WormDbFfiVfsRoomStore>;
  supportsCheckpointSync: boolean;
};

export class WormDbFfiVfsRoomStore implements VfsRoomStore {
  readonly kind: VfsStoreKind = 'wormdb-ffi';
  readonly quotas: ResolvedVfsStoreQuotas;
  readonly fence: VfsRoomFence;
  private closed = false;

  constructor(
    readonly roomId: string,
    private readonly accounting: WormDbRoomAccounting,
    quotas: ResolvedVfsStoreQuotas,
    private readonly store: WormDbFfiVfsStore,
  ) {
    this.quotas = quotas;
    this.fence = new VfsRoomFence(roomId);
  }

  get isFenced(): boolean {
    return this.fence.fenced;
  }

  get supportsCheckpointSync(): boolean {
    return this.accounting.supportsCheckpointSync;
  }

  private assertUsable(): void {
    if (this.closed) {
      throw new VfsError('VFS_STORAGE_CLOSED', `VFS room store for ${this.roomId} is closed.`);
    }
    this.fence.assertOpen();
  }

  /** Internal helper for `destroyRoom` / `store.close()`. */
  forceClose(): void {
    this.closed = true;
  }

  private failAndFence(context: string, cause: unknown): never {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const reason = `${context}: ${detail}`;
    this.fence.trip(reason);
    for (const h of this.accounting.handles) {
      h.fence.trip(reason);
    }
    this.store.invalidateRoomOnFault(this.roomId);
    if (cause instanceof VfsError && cause.code === 'VFS_STORAGE_FAILED') {
      throw cause;
    }
    throw new VfsError('VFS_STORAGE_FAILED', reason, { cause });
  }

  async kvGet(key: string): Promise<Uint8Array | undefined> {
    this.assertUsable();
    validateVfsKvKey(this.roomId, key);
    try {
      const value = this.store.withRoomHandle(this.roomId, handle => handle.get(key));
      return value === null ? undefined : value;
    } catch (err) {
      this.failAndFence('WormDB kvGet failed', err);
    }
  }

  async kvPut(key: string, value: Uint8Array): Promise<void> {
    this.assertUsable();
    validateVfsKvKey(this.roomId, key);
    if (!(value instanceof Uint8Array)) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'KV value must be a Uint8Array.');
    }

    const nextSize = kvEntryBytes(key, value);
    const prevSize = this.accounting.keySizes.get(key) ?? 0;
    const delta = nextSize - prevSize;
    if (delta > 0 && this.accounting.hotKvBytes + delta > this.quotas.hotKvMaxBytes) {
      throw new VfsError(
        'VFS_STORAGE_QUOTA',
        `Hot KV quota exceeded for room ${this.roomId} (${this.accounting.hotKvBytes + delta} > ${this.quotas.hotKvMaxBytes}).`,
        { details: { hotKvBytes: this.accounting.hotKvBytes, delta, hotKvMaxBytes: this.quotas.hotKvMaxBytes } },
      );
    }

    const copied = copyBytes(value);
    try {
      this.store.withRoomHandle(this.roomId, handle => {
        handle.set(key, copied);
      });
    } catch (err) {
      this.failAndFence('WormDB kvPut failed', err);
    }

    this.accounting.keySizes.set(key, nextSize);
    this.accounting.hotKvBytes += delta;
  }

  async kvPutIfAbsent(key: string, value: Uint8Array): Promise<boolean> {
    this.assertUsable();
    validateVfsKvKey(this.roomId, key);
    if (!(value instanceof Uint8Array)) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'KV value must be a Uint8Array.');
    }

    const nextSize = kvEntryBytes(key, value);
    const copied = copyBytes(value);

    const inserted = this.store.withRoomHandle(this.roomId, handle => {
      let existingMeta;
      try {
        existingMeta = handle.getMeta(key);
      } catch (err) {
        this.failAndFence('WormDB kvPutIfAbsent metadata check failed', err);
      }
      if (existingMeta !== null) {
        return false;
      }

      if (this.accounting.hotKvBytes + nextSize > this.quotas.hotKvMaxBytes) {
        throw new VfsError(
          'VFS_STORAGE_QUOTA',
          `Hot KV quota exceeded for room ${this.roomId} (${this.accounting.hotKvBytes + nextSize} > ${this.quotas.hotKvMaxBytes}).`,
          { details: { hotKvBytes: this.accounting.hotKvBytes, delta: nextSize, hotKvMaxBytes: this.quotas.hotKvMaxBytes } },
        );
      }

      try {
        handle.set(key, copied);
      } catch (err) {
        this.failAndFence('WormDB kvPutIfAbsent write failed', err);
      }
      return true;
    });

    if (inserted) {
      this.accounting.keySizes.set(key, nextSize);
      this.accounting.hotKvBytes += nextSize;
    }
    return inserted;
  }

  async kvDelete(key: string): Promise<boolean> {
    this.assertUsable();
    validateVfsKvKey(this.roomId, key);

    let deleted: boolean;
    try {
      deleted = this.store.withRoomHandle(this.roomId, handle => handle.delete(key));
    } catch (err) {
      this.failAndFence('WormDB kvDelete failed', err);
    }

    if (deleted) {
      const prevSize = this.accounting.keySizes.get(key) ?? 0;
      this.accounting.keySizes.delete(key);
      this.accounting.hotKvBytes = Math.max(0, this.accounting.hotKvBytes - prevSize);
    }
    return deleted;
  }

  async kvScanPrefix(prefix: string, opts?: VfsScanPrefixOptions): Promise<VfsKvEntry[]> {
    this.assertUsable();
    validateVfsKvPrefix(this.roomId, prefix);
    const { afterKey, beforeKey, limit, direction } = validateScanPrefixOptions(opts);
    if (afterKey !== undefined && beforeKey !== undefined && compareUtf8Lex(afterKey, beforeKey) >= 0) {
      return [];
    }

    try {
      const entries = this.store.withRoomHandle(this.roomId, handle =>
        handle.scanPrefix(prefix, {
          ...(afterKey !== undefined ? { afterKey } : {}),
          ...(beforeKey !== undefined ? { beforeKey } : {}),
          ...(limit !== undefined && limit > 0 ? { limit } : {}),
          direction,
        }),
      );
      // Explicitly enforce ascending UTF-8 bytewise sort in the adapter rather than trusting native scan order.
      entries.sort((a, b) => compareUtf8Lex(a.key, b.key));
      return entries;
    } catch (err) {
      this.failAndFence('WormDB kvScanPrefix failed', err);
    }
  }

  async putBlock(cid: string, bytes: Uint8Array, opts?: VfsPutBlockOptions): Promise<boolean> {
    this.assertUsable();
    try {
      return await this.accounting.cas.putBlock(cid, bytes, this.quotas, opts);
    } catch (err) {
      if (
        err instanceof VfsError
        && (
          err.code === 'VFS_INVALID_ENVELOPE'
          || err.code === 'VFS_STORAGE_QUOTA'
          || err.code === 'VFS_INVALID_KEY'
          || err.code === 'VFS_LIMIT_EXCEEDED'
        )
      ) {
        throw err;
      }
      this.failAndFence('Cold CAS putBlock failed', err);
    }
  }

  async getBlock(cid: string): Promise<Uint8Array | undefined> {
    this.assertUsable();
    return this.accounting.cas.getBlock(cid);
  }

  async hasBlock(cid: string): Promise<boolean> {
    this.assertUsable();
    return this.accounting.cas.hasBlock(cid);
  }

  async deleteBlock(cid: string): Promise<boolean> {
    this.assertUsable();
    try {
      return this.accounting.cas.deleteBlock(cid);
    } catch (err) {
      if (err instanceof VfsError && (err.code === 'VFS_INVALID_ENVELOPE' || err.code === 'VFS_INVALID_KEY')) {
        throw err;
      }
      this.failAndFence('Cold CAS deleteBlock failed', err);
    }
  }

  async checkpoint(): Promise<void> {
    this.assertUsable();
    try {
      this.store.withRoomHandle(this.roomId, handle => {
        if (handle.supportsCheckpointSync) {
          handle.checkpointSync();
        }
      });
    } catch (err) {
      this.failAndFence('WormDB checkpoint_sync failed', err);
    }
  }

  async stats(): Promise<VfsRoomStats> {
    if (this.closed) {
      throw new VfsError('VFS_STORAGE_CLOSED', `VFS room store for ${this.roomId} is closed.`);
    }
    return {
      hotKvBytes: this.accounting.hotKvBytes,
      hotKvKeys: this.accounting.keySizes.size,
      coldCasBytes: this.accounting.cas.coldCasBytes,
      coldCasBlocks: this.accounting.cas.coldCasBlocks,
      fenced: this.fence.fenced,
      ...(this.fence.reason !== undefined ? { fencedReason: this.fence.reason } : {}),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.store.releaseRoomWrapper(this);
  }
}

export class WormDbFfiVfsStore implements VfsStore {
  readonly kind: VfsStoreKind = 'wormdb-ffi';
  readonly baseDir: string;
  readonly libraryPath: string;
  readonly maxOpenRooms: number;

  private readonly ioHooks?: FsIoHooks;
  private readonly openBinaryHandleFn: (options: WormDBStoreOptions) => WormDbBinaryHandle;
  private readonly pool = new Map<string, PoolEntry>();
  private readonly rooms = new Map<string, WormDbRoomAccounting>();
  private lruClock = 0;
  private closed = false;

  constructor(options: WormDbFfiVfsStoreOptions) {
    this.baseDir = prepareBaseDir(options.baseDir);
    const libPath = options.libraryPath ?? defaultOptions().libraryPath;
    if (typeof libPath !== 'string' || libPath.length === 0 || libPath.includes('\0')) {
      throw new VfsError('VFS_INVALID_KEY', 'libraryPath must be a non-empty string without NUL bytes.');
    }
    this.libraryPath = path.resolve(libPath);

    const maxOpen = options.maxOpenRooms ?? DEFAULT_WORMDB_MAX_OPEN_ROOMS;
    if (!Number.isSafeInteger(maxOpen) || maxOpen < 1) {
      throw new VfsError('VFS_INVALID_KEY', 'maxOpenRooms must be a positive safe integer.');
    }
    this.maxOpenRooms = maxOpen;
    this.ioHooks = options.ioHooks;
    this.openBinaryHandleFn = options.openBinaryHandle ?? openWormDbBinary;
  }

  /** Number of native WormDB handles currently resident in the LRU pool. */
  get openHandleCount(): number {
    return this.pool.size;
  }

  private evictOneIdleLru(excludeRoomId?: string): boolean {
    let victim: PoolEntry | null = null;
    for (const entry of this.pool.values()) {
      if (entry.roomId === excludeRoomId) continue;
      if (entry.inFlight > 0) continue;
      if (victim === null || entry.lastUsedSeq < victim.lastUsedSeq) {
        victim = entry;
      }
    }
    if (!victim) return false;
    this.pool.delete(victim.roomId);
    try { victim.handle.close(); } catch { /* Best effort. */ }
    return true;
  }

  private acquirePoolEntry(roomId: string): PoolEntry {
    const existing = this.pool.get(roomId);
    if (existing) {
      existing.lastUsedSeq = ++this.lruClock;
      existing.inFlight++;
      return existing;
    }

    while (this.pool.size >= this.maxOpenRooms) {
      if (!this.evictOneIdleLru(roomId)) {
        // All currently pooled handles have operations in flight; permit a temporary slot and
        // evict as soon as a handle drops back to idle.
        break;
      }
    }

    const wormdbDir = ensureSafeDir(this.baseDir, [roomId, 'wormdb']);
    // Refuse symlinked WAL/snapshot files before passing the directory to native WormDB.
    assertNoSymlinkComponents(this.baseDir, [roomId, 'wormdb', 'wormdb.wal'], 'file');
    assertNoSymlinkComponents(this.baseDir, [roomId, 'wormdb', 'wormdb.snapshot'], 'file');
    assertNoSymlinkComponents(this.baseDir, [roomId, 'wormdb', 'wormdb.snapshot.tmp'], 'file');

    const handle = this.openBinaryHandleFn({
      dataDir: wormdbDir,
      libraryPath: this.libraryPath,
    });

    const entry: PoolEntry = {
      roomId,
      handle,
      inFlight: 1,
      lastUsedSeq: ++this.lruClock,
    };
    this.pool.set(roomId, entry);
    return entry;
  }

  /** Executes a synchronous WormDB operation while pinning the room's handle against LRU eviction. */
  withRoomHandle<T>(roomId: string, fn: (handle: WormDbBinaryHandle) => T): T {
    const entry = this.acquirePoolEntry(roomId);
    try {
      return fn(entry.handle);
    } finally {
      entry.inFlight--;
      if (entry.inFlight === 0 && this.pool.size > this.maxOpenRooms) {
        this.evictOneIdleLru();
      }
    }
  }

  /** Closes and removes a room's pooled native handle (e.g., on fence or room close). */
  dropPooledHandle(roomId: string): void {
    const entry = this.pool.get(roomId);
    if (!entry) return;
    this.pool.delete(roomId);
    try { entry.handle.close(); } catch { /* Best effort. */ }
  }

  /** Drops both the pooled native handle and tainted in-memory accounting on an I/O fault. */
  invalidateRoomOnFault(roomId: string): void {
    const acc = this.rooms.get(roomId);
    this.rooms.delete(roomId);
    this.dropPooledHandle(roomId);
    acc?.lock.release();
  }

  releaseRoomWrapper(wrapper: WormDbFfiVfsRoomStore): void {
    const acc = this.rooms.get(wrapper.roomId);
    if (!acc) return;
    acc.handles.delete(wrapper);
    if (acc.handles.size === 0) {
      this.rooms.delete(wrapper.roomId);
      this.dropPooledHandle(wrapper.roomId);
      acc.lock.release();
    }
  }

  private openAccounting(roomId: string): WormDbRoomAccounting {
    if (this.rooms.has(roomId)) {
      throw new VfsError('VFS_STORAGE_FENCED', 'Room VFS directory is locked by another handle/process', {
        details: { roomId },
      });
    }

    ensureSafeDir(this.baseDir, [roomId]);
    const lock = acquireRoomLock(this.baseDir, roomId);

    try {
      const cas = new FsColdCasStore(this.baseDir, roomId, this.ioHooks);
      const keySizes = new Map<string, number>();
      let hotKvBytes = 0;
      let supportsCheckpointSync = false;

      const roomPrefix = vfsRoomPrefix(roomId);
      this.withRoomHandle(roomId, handle => {
        supportsCheckpointSync = handle.supportsCheckpointSync;
        const entries = handle.scanPrefix(roomPrefix);
        for (const entry of entries) {
          const size = kvEntryBytes(entry.key, entry.value);
          keySizes.set(entry.key, size);
          hotKvBytes += size;
        }
      });

      const acc: WormDbRoomAccounting = {
        roomId,
        lock,
        keySizes,
        hotKvBytes,
        cas,
        handles: new Set(),
        supportsCheckpointSync,
      };
      this.rooms.set(roomId, acc);
      return acc;
    } catch (err) {
      this.dropPooledHandle(roomId);
      lock.release();
      if (err instanceof VfsError) throw err;
      throw new VfsError(
        'VFS_STORAGE_FAILED',
        `Failed to open WormDB room ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  async openRoom(roomId: string, quotas?: Partial<VfsStoreQuotas>): Promise<WormDbFfiVfsRoomStore> {
    if (this.closed) {
      throw new VfsError('VFS_STORAGE_CLOSED', 'WormDbFfiVfsStore is closed.');
    }
    validateVfsRoomId(roomId);
    const resolved = resolveVfsStoreQuotas(this.kind, quotas);
    const acc = this.openAccounting(roomId);
    const wrapper = new WormDbFfiVfsRoomStore(roomId, acc, resolved, this);
    acc.handles.add(wrapper);
    return wrapper;
  }

  async destroyRoom(roomId: string): Promise<void> {
    if (this.closed) {
      throw new VfsError('VFS_STORAGE_CLOSED', 'WormDbFfiVfsStore is closed.');
    }
    validateVfsRoomId(roomId);
    const acc = this.rooms.get(roomId);
    if (acc) {
      for (const h of [...acc.handles]) {
        h.forceClose();
      }
      acc.handles.clear();
      this.rooms.delete(roomId);
      this.dropPooledHandle(roomId);
      acc.lock.release();
    } else {
      assertRoomNotLockedByOther(this.baseDir, roomId);
      this.dropPooledHandle(roomId);
    }
    destroyRoomDirectory(this.baseDir, roomId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const locksToRelease: RoomDirectoryLock[] = [];
    for (const acc of this.rooms.values()) {
      for (const h of [...acc.handles]) {
        h.forceClose();
      }
      acc.handles.clear();
      locksToRelease.push(acc.lock);
    }
    this.rooms.clear();
    for (const roomId of [...this.pool.keys()]) {
      this.dropPooledHandle(roomId);
    }
    for (const lock of locksToRelease) {
      lock.release();
    }
  }
}
