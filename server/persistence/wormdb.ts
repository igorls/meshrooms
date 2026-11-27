import fs from 'node:fs';
import path from 'node:path';
import { dlopen, FFIType, JSCallback, ptr, toArrayBuffer, type FFIFunction, type Library } from 'bun:ffi';
import type { DurableStore, WormDBStoreOptions } from './store.ts';

if (process.arch !== 'x64' && process.arch !== 'arm64') {
  throw new Error(`WormDB FFI requires a 64-bit architecture (x64 or arm64), found: ${process.arch}`);
}

export const WORMDB_OK = 0;
export const WORMDB_NOT_FOUND = 1;
export const WORMDB_PROC_ERR = 2;
export const WORMDB_ERR = -1;
export const WORMDB_MAX_KEY_BYTES = 512;

const ENTRY_META_BYTES = 56;

const symbols = {
  wormdb_open_sync: {
    args: [FFIType.ptr],
    returns: FFIType.ptr,
  },
  wormdb_close: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  wormdb_set: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  wormdb_get: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  wormdb_free: {
    args: [FFIType.ptr, FFIType.u64],
    returns: FFIType.void,
  },
} as const;

const deleteSymbols = {
  wormdb_delete: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
} as const;

const getMetaSymbols = {
  wormdb_get_meta: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr],
    returns: FFIType.i32,
  },
} as const;

const scanPrefixSymbols = {
  wormdb_scan_prefix: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
} as const;

const checkpointSymbols = {
  wormdb_checkpoint_sync: {
    args: [FFIType.ptr],
    returns: FFIType.i32,
  },
} as const;

type WormDBLib = ReturnType<typeof dlopen<typeof symbols>>;
type WormDBDeleteLib = ReturnType<typeof dlopen<typeof deleteSymbols>>;
type WormDBGetMetaLib = ReturnType<typeof dlopen<typeof getMetaSymbols>>;
type WormDBScanPrefixLib = ReturnType<typeof dlopen<typeof scanPrefixSymbols>>;
type WormDBCheckpointLib = ReturnType<typeof dlopen<typeof checkpointSymbols>>;
type CheckpointFn = WormDBCheckpointLib['symbols']['wormdb_checkpoint_sync'];
type DbPointer = NonNullable<ReturnType<WormDBLib['symbols']['wormdb_open_sync']>>;

type WormDBBinarySymbols = WormDBLib['symbols']
  & WormDBDeleteLib['symbols']
  & WormDBGetMetaLib['symbols']
  & WormDBScanPrefixLib['symbols'];

type WormDBBinaryLib = {
  symbols: WormDBBinarySymbols;
};

export type WormDbCapabilities = {
  libraryPath: string;
  available: boolean;
  supportsDelete: boolean;
  supportsGetMeta: boolean;
  supportsScanPrefix: boolean;
  supportsVfsBinaryApi: boolean;
  supportsCheckpointSync: boolean;
};

type ProbedNativeLib = {
  cacheKey: string;
  capabilities: WormDbCapabilities;
  baseLib: WormDBLib | null;
  deleteLib: WormDBDeleteLib | null;
  getMetaLib: WormDBGetMetaLib | null;
  scanPrefixLib: WormDBScanPrefixLib | null;
  checkpointLib: WormDBCheckpointLib | null;
};

const libCache = new Map<string, WormDBLib>();
const probedLibCache = new Map<string, ProbedNativeLib>();

function defaultWormDbLibraryPath(): string {
  const root = path.resolve(import.meta.dir, '..', '..');
  const binary = process.platform === 'win32'
    ? ['bin', 'wormdb_ffi.dll']
    : ['lib', `libwormdb_ffi.${process.platform === 'darwin' ? 'dylib' : 'so'}`];
  const localLibrary = path.join(root, '.local', 'native', binary[1]);
  return path.resolve(
    process.env.WORMDB_LIBRARY_PATH
      || (fs.existsSync(localLibrary) ? localLibrary : path.join(root, '..', 'wormdb', 'zig-out', ...binary)),
  );
}

function tryDlopen<T extends Record<string, FFIFunction>>(
  resolvedPath: string,
  defs: T,
): Library<T> | null {
  try {
    return dlopen(resolvedPath, defs);
  } catch {
    return null;
  }
}

function probeNativeLib(libraryPath?: string): ProbedNativeLib {
  const rawPath = libraryPath ?? defaultWormDbLibraryPath();
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.includes('\0')) {
    return {
      cacheKey: '',
      capabilities: {
        libraryPath: typeof rawPath === 'string' ? rawPath : '',
        available: false,
        supportsDelete: false,
        supportsGetMeta: false,
        supportsScanPrefix: false,
        supportsVfsBinaryApi: false,
        supportsCheckpointSync: false,
      },
      baseLib: null,
      deleteLib: null,
      getMetaLib: null,
      scanPrefixLib: null,
      checkpointLib: null,
    };
  }

  const resolved = path.resolve(rawPath);
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(resolved);
  } catch {
    stat = undefined;
  }
  if (!stat || !stat.isFile()) {
    return {
      cacheKey: '',
      capabilities: {
        libraryPath: resolved,
        available: false,
        supportsDelete: false,
        supportsGetMeta: false,
        supportsScanPrefix: false,
        supportsVfsBinaryApi: false,
        supportsCheckpointSync: false,
      },
      baseLib: null,
      deleteLib: null,
      getMetaLib: null,
      scanPrefixLib: null,
      checkpointLib: null,
    };
  }

  const cacheKey = `${resolved}:${stat.size}:${stat.mtimeMs}`;
  const cached = probedLibCache.get(resolved);
  if (cached && cached.cacheKey === cacheKey) {
    return cached;
  }

  const baseLib = libCache.get(resolved) ?? tryDlopen(resolved, symbols);
  if (baseLib && !libCache.has(resolved)) {
    libCache.set(resolved, baseLib);
  }
  if (!baseLib) {
    const failed: ProbedNativeLib = {
      cacheKey,
      capabilities: {
        libraryPath: resolved,
        available: false,
        supportsDelete: false,
        supportsGetMeta: false,
        supportsScanPrefix: false,
        supportsVfsBinaryApi: false,
        supportsCheckpointSync: false,
      },
      baseLib: null,
      deleteLib: null,
      getMetaLib: null,
      scanPrefixLib: null,
      checkpointLib: null,
    };
    probedLibCache.set(resolved, failed);
    return failed;
  }

  const deleteLib = tryDlopen(resolved, deleteSymbols);
  const getMetaLib = tryDlopen(resolved, getMetaSymbols);
  const scanPrefixLib = tryDlopen(resolved, scanPrefixSymbols);
  const checkpointLib = tryDlopen(resolved, checkpointSymbols);

  const supportsDelete = deleteLib !== null;
  const supportsGetMeta = getMetaLib !== null;
  const supportsScanPrefix = scanPrefixLib !== null;
  const supportsCheckpointSync = checkpointLib !== null;
  const supportsVfsBinaryApi = supportsDelete && supportsGetMeta && supportsScanPrefix;

  const probed: ProbedNativeLib = {
    cacheKey,
    capabilities: {
      libraryPath: resolved,
      available: true,
      supportsDelete,
      supportsGetMeta,
      supportsScanPrefix,
      supportsVfsBinaryApi,
      supportsCheckpointSync,
    },
    baseLib,
    deleteLib,
    getMetaLib,
    scanPrefixLib,
    checkpointLib,
  };
  probedLibCache.set(resolved, probed);
  return probed;
}

/**
 * Probes the WormDB native FFI library for base availability and optional v0.3 VFS symbols
 * (`wormdb_delete`, `wormdb_get_meta`, `wormdb_scan_prefix`, `wormdb_checkpoint_sync`).
 * Never throws when the library is missing or lacks newer symbols.
 */
export function probeWormDbCapabilities(libraryPath?: string): WormDbCapabilities {
  return { ...probeNativeLib(libraryPath).capabilities };
}

function getOrLoadLib(libraryPath: string): WormDBLib {
  const resolved = path.resolve(libraryPath);
  let loaded = libCache.get(resolved);
  if (!loaded) {
    if (!fs.existsSync(resolved)) {
      throw new Error(`WormDB native library not found at: ${resolved}`);
    }
    try { loaded = dlopen(resolved, symbols); } catch (error) {
      // A library built from WormDB source older than the pins lacks a symbol, most often wormdb_open_sync.
      const reason = error instanceof Error ? error.message : String(error);
      if (!/symbol/i.test(reason)) throw error;
      throw new Error(`The WormDB native library at ${resolved} does not match this version of Meshrooms (${reason}). `
        + 'Rebuild it from the commits pinned in native/ (see docs/native-build.md), or point WORMDB_LIBRARY_PATH at a current build.', { cause: error });
    }
    libCache.set(resolved, loaded);
  }
  return loaded;
}

function getOrLoadBinaryLib(libraryPath: string): { lib: WormDBBinaryLib; checkpointFn: CheckpointFn | null } {
  const resolved = path.resolve(libraryPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`WormDB native library not found at: ${resolved}`);
  }
  const probed = probeNativeLib(resolved);
  if (!probed.capabilities.available || !probed.baseLib) {
    // Delegate to getOrLoadLib to surface the exact loader/symbol error message.
    getOrLoadLib(resolved);
    throw new Error(`Failed to load WormDB native library at: ${resolved}`);
  }
  if (!probed.capabilities.supportsVfsBinaryApi || !probed.deleteLib || !probed.getMetaLib || !probed.scanPrefixLib) {
    const missing: string[] = [];
    if (!probed.capabilities.supportsDelete) missing.push('wormdb_delete');
    if (!probed.capabilities.supportsGetMeta) missing.push('wormdb_get_meta');
    if (!probed.capabilities.supportsScanPrefix) missing.push('wormdb_scan_prefix');
    throw new Error(
      `The WormDB native library at ${resolved} is missing required VFS binary KV symbols (${missing.join(', ')}). `
      + 'Rebuild WormDB from a build exporting these symbols (see docs/native-build.md), or point WORMDB_LIBRARY_PATH at a compatible build.',
    );
  }

  return {
    lib: {
      symbols: {
        ...probed.baseLib.symbols,
        ...probed.deleteLib.symbols,
        ...probed.getMetaLib.symbols,
        ...probed.scanPrefixLib.symbols,
      },
    },
    checkpointFn: probed.checkpointLib ? probed.checkpointLib.symbols.wormdb_checkpoint_sync : null,
  };
}

const DUMMY_BUF = Buffer.alloc(1);

function encodeCheckedKey(key: string, label = 'Key'): Buffer {
  if (typeof key !== 'string') {
    throw new TypeError(`${label} must be a string`);
  }
  const keyBuf = Buffer.from(key, 'utf-8');
  if (keyBuf.byteLength > WORMDB_MAX_KEY_BYTES) {
    throw new RangeError(`${label} exceeds maximum length of ${WORMDB_MAX_KEY_BYTES} UTF-8 bytes`);
  }
  return keyBuf;
}

export type WormDbEntryMeta = {
  timestampMs: number;
  isWorm: boolean;
  valueLen: number;
  valueSha256: Uint8Array;
};

export type WormDbBinaryEntry = {
  key: string;
  value: Uint8Array;
};

export type WormDbScanOptions = {
  limit?: number;
  afterKey?: string;
  beforeKey?: string;
  direction?: 'first' | 'last';
};

export interface WormDbBinaryHandle {
  readonly dataDir: string;
  readonly libraryPath: string;
  readonly supportsCheckpointSync: boolean;
  readonly isClosed: boolean;
  readonly isFenced: boolean;
  readonly fenceReason: string | undefined;
  get(key: string): Uint8Array | null;
  getMeta(key: string): WormDbEntryMeta | null;
  set(key: string, value: Uint8Array): void;
  delete(key: string): boolean;
  scanPrefix(prefix: string, options?: WormDbScanOptions): WormDbBinaryEntry[];
  checkpointSync(): void;
  close(): void;
}

export class WormDBStore implements DurableStore {
  private readonly dbPtr: DbPointer;
  private readonly lib: WormDBLib;
  private closed = false;
  readonly dataDir: string;
  readonly libraryPath: string;

  constructor(dbPtr: DbPointer, lib: WormDBLib, dataDir: string, libraryPath: string) {
    this.dbPtr = dbPtr;
    this.lib = lib;
    this.dataDir = dataDir;
    this.libraryPath = libraryPath;
  }

  read(key: string): string | null {
    if (this.closed) {
      throw new Error('Cannot read from a closed WormDBStore');
    }
    if (typeof key !== 'string') {
      throw new TypeError('Key must be a string');
    }

    const keyBuf = Buffer.from(key, 'utf-8');
    const keyPtr = keyBuf.byteLength > 0 ? ptr(keyBuf) : ptr(DUMMY_BUF);

    const outValBuf = new BigUint64Array(1);
    const outLenBuf = new BigUint64Array(1);

    const rc = this.lib.symbols.wormdb_get(
      this.dbPtr,
      keyPtr,
      BigInt(keyBuf.byteLength),
      ptr(outValBuf),
      ptr(outLenBuf),
    );

    if (rc === WORMDB_NOT_FOUND) {
      return null;
    }
    if (rc !== WORMDB_OK) {
      throw new Error(`WormDB read failed with code ${rc}`);
    }

    const readLen = Number(outLenBuf[0]);
    if (readLen === 0) {
      return '';
    }

    const readPtr = outValBuf[0];
    try {
      const ab = toArrayBuffer(readPtr, 0, readLen);
      return Buffer.from(ab).toString('utf-8');
    } finally {
      this.lib.symbols.wormdb_free(readPtr, BigInt(readLen));
    }
  }

  write(key: string, value: string): void {
    if (this.closed) {
      throw new Error('Cannot write to a closed WormDBStore');
    }
    if (typeof key !== 'string') {
      throw new TypeError('Key must be a string');
    }
    if (typeof value !== 'string') {
      throw new TypeError('Value must be a string');
    }

    const keyBuf = Buffer.from(key, 'utf-8');
    const valBuf = Buffer.from(value, 'utf-8');
    const keyPtr = keyBuf.byteLength > 0 ? ptr(keyBuf) : ptr(DUMMY_BUF);
    const valPtr = valBuf.byteLength > 0 ? ptr(valBuf) : ptr(DUMMY_BUF);

    const rc = this.lib.symbols.wormdb_set(
      this.dbPtr,
      keyPtr,
      BigInt(keyBuf.byteLength),
      valPtr,
      BigInt(valBuf.byteLength),
    );

    if (rc !== WORMDB_OK) {
      throw new Error(`WormDB write failed with code ${rc}`);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const ptrToClose = this.dbPtr;
    this.lib.symbols.wormdb_close(ptrToClose);
  }
}

export function openWormDBStore(options: WormDBStoreOptions): DurableStore {
  if (!options || typeof options !== 'object') {
    throw new TypeError('WormDBStoreOptions must be an object');
  }
  if (typeof options.dataDir !== 'string' || options.dataDir.length === 0) {
    throw new TypeError('options.dataDir is required and must be a non-empty string');
  }
  if (typeof options.libraryPath !== 'string' || options.libraryPath.length === 0) {
    throw new TypeError('options.libraryPath is required and must be a non-empty string');
  }

  if (options.dataDir.includes('\0')) {
    throw new Error('options.dataDir contains invalid NUL character');
  }
  if (options.libraryPath.includes('\0')) {
    throw new Error('options.libraryPath contains invalid NUL character');
  }

  const resolvedLib = path.resolve(options.libraryPath);
  const lib = getOrLoadLib(resolvedLib);
  const resolvedDir = path.resolve(options.dataDir);
  fs.mkdirSync(resolvedDir, { recursive: true });

  const dirBuf = Buffer.from(resolvedDir + '\0', 'utf-8');
  const dbPtr = lib.symbols.wormdb_open_sync(ptr(dirBuf));

  if (!dbPtr || dbPtr === 0n || Number(dbPtr) === 0) {
    throw new Error(`Failed to open WormDB database at: ${resolvedDir}`);
  }

  return new WormDBStore(dbPtr, lib, resolvedDir, resolvedLib);
}

export class WormDbBinaryStore implements WormDbBinaryHandle {
  private readonly dbPtr: DbPointer;
  private readonly lib: WormDBBinaryLib;
  private readonly checkpointFn: CheckpointFn | null;
  private closed = false;
  private fencedMessage: string | null = null;
  readonly dataDir: string;
  readonly libraryPath: string;

  constructor(
    dbPtr: DbPointer,
    lib: WormDBBinaryLib,
    checkpointFn: CheckpointFn | null,
    dataDir: string,
    libraryPath: string,
  ) {
    this.dbPtr = dbPtr;
    this.lib = lib;
    this.checkpointFn = checkpointFn;
    this.dataDir = dataDir;
    this.libraryPath = libraryPath;
  }

  get supportsCheckpointSync(): boolean {
    return this.checkpointFn !== null;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isFenced(): boolean {
    return this.fencedMessage !== null;
  }

  get fenceReason(): string | undefined {
    return this.fencedMessage ?? undefined;
  }

  private assertOpen(op: string): void {
    if (this.closed) {
      throw new Error(`Cannot ${op} on a closed WormDbBinaryStore`);
    }
  }

  private assertWritable(op: string): void {
    this.assertOpen(op);
    if (this.fencedMessage !== null) {
      throw new Error(`WormDbBinaryStore is fenced (${this.fencedMessage}); reopen to recover`);
    }
  }

  private latchFence(reason: string): never {
    if (this.fencedMessage === null) {
      this.fencedMessage = reason;
    }
    throw new Error(reason);
  }

  get(key: string): Uint8Array | null {
    this.assertOpen('read');
    const keyBuf = encodeCheckedKey(key);
    const keyPtr = keyBuf.byteLength > 0 ? ptr(keyBuf) : ptr(DUMMY_BUF);

    const outValBuf = new BigUint64Array(1);
    const outLenBuf = new BigUint64Array(1);

    const rc = this.lib.symbols.wormdb_get(
      this.dbPtr,
      keyPtr,
      BigInt(keyBuf.byteLength),
      ptr(outValBuf),
      ptr(outLenBuf),
    );

    if (rc === WORMDB_NOT_FOUND) {
      return null;
    }
    if (rc !== WORMDB_OK) {
      throw new Error(`WormDB binary read failed with code ${rc}`);
    }

    const readLen = Number(outLenBuf[0]);
    if (readLen === 0) {
      return new Uint8Array(0);
    }

    const readPtr = outValBuf[0];
    try {
      const ab = toArrayBuffer(readPtr, 0, readLen);
      return new Uint8Array(ab).slice();
    } finally {
      this.lib.symbols.wormdb_free(readPtr, BigInt(readLen));
    }
  }

  getMeta(key: string): WormDbEntryMeta | null {
    this.assertOpen('read metadata');
    const keyBuf = encodeCheckedKey(key);
    const keyPtr = keyBuf.byteLength > 0 ? ptr(keyBuf) : ptr(DUMMY_BUF);
    const metaBuf = new Uint8Array(ENTRY_META_BYTES);

    const rc = this.lib.symbols.wormdb_get_meta(
      this.dbPtr,
      keyPtr,
      BigInt(keyBuf.byteLength),
      ptr(metaBuf),
    );

    if (rc === WORMDB_NOT_FOUND) {
      return null;
    }
    if (rc !== WORMDB_OK) {
      throw new Error(`WormDB metadata read failed with code ${rc}`);
    }

    const view = new DataView(metaBuf.buffer, metaBuf.byteOffset, metaBuf.byteLength);
    return {
      timestampMs: Number(view.getBigUint64(0, true)),
      isWorm: view.getInt32(8, true) !== 0,
      valueLen: Number(view.getBigUint64(16, true)),
      valueSha256: metaBuf.slice(24, 56),
    };
  }

  set(key: string, value: Uint8Array): void {
    this.assertWritable('write');
    const keyBuf = encodeCheckedKey(key);
    if (!(value instanceof Uint8Array)) {
      throw new TypeError('Value must be a Uint8Array');
    }

    const keyPtr = keyBuf.byteLength > 0 ? ptr(keyBuf) : ptr(DUMMY_BUF);
    const valPtr = value.byteLength > 0 ? ptr(value) : ptr(DUMMY_BUF);

    const rc = this.lib.symbols.wormdb_set(
      this.dbPtr,
      keyPtr,
      BigInt(keyBuf.byteLength),
      valPtr,
      BigInt(value.byteLength),
    );

    if (rc !== WORMDB_OK) {
      this.latchFence(`WormDB binary write failed with code ${rc}`);
    }
  }

  delete(key: string): boolean {
    this.assertWritable('delete');
    const keyBuf = encodeCheckedKey(key);
    const existing = this.getMeta(key);
    if (existing === null) {
      return false;
    }
    if (existing.isWorm) {
      throw new Error('Cannot delete a WORM-protected key');
    }

    const keyPtr = keyBuf.byteLength > 0 ? ptr(keyBuf) : ptr(DUMMY_BUF);
    const rc = this.lib.symbols.wormdb_delete(
      this.dbPtr,
      keyPtr,
      BigInt(keyBuf.byteLength),
    );

    if (rc !== WORMDB_OK) {
      this.latchFence(`WormDB delete failed with code ${rc}`);
    }
    return true;
  }

  scanPrefix(prefix: string, options?: WormDbScanOptions): WormDbBinaryEntry[] {
    this.assertOpen('scan');
    const prefixBuf = encodeCheckedKey(prefix, 'Prefix');
    const afterKey = options?.afterKey;
    const beforeKey = options?.beforeKey;
    const limit = options?.limit;
    const direction = options?.direction ?? 'first';

    let afterKeyBuf: Buffer | null = null;
    if (afterKey !== undefined) {
      if (typeof afterKey !== 'string') {
        throw new TypeError('afterKey must be a string');
      }
      afterKeyBuf = Buffer.from(afterKey, 'utf-8');
    }

    let beforeKeyBuf: Buffer | null = null;
    if (beforeKey !== undefined) {
      if (typeof beforeKey !== 'string') {
        throw new TypeError('beforeKey must be a string');
      }
      beforeKeyBuf = Buffer.from(beforeKey, 'utf-8');
    }

    if (limit !== undefined) {
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) {
        throw new RangeError('limit must be a non-negative integer');
      }
    }
    if (direction !== 'first' && direction !== 'last') {
      throw new RangeError("direction must be 'first' or 'last'");
    }
    if (afterKeyBuf !== null && beforeKeyBuf !== null && Buffer.compare(afterKeyBuf, beforeKeyBuf) >= 0) {
      return [];
    }

    const maxLimit = limit !== undefined && limit > 0 ? limit : undefined;
    // Fast native tail cut when scanning the latest N entries with no cursor filters.
    const nativeLimit = direction === 'last' && afterKeyBuf === null && beforeKeyBuf === null && maxLimit !== undefined
      ? BigInt(maxLimit)
      : 0n;

    const collected: { keyBytes: Buffer; key: string; value: Uint8Array }[] = [];
    let callbackError: unknown = null;

    const cb = new JSCallback(
      (_ctx, keyPtr, keyLenRaw, valPtr, valLenRaw, _metaPtr) => {
        try {
          const keyLen = Number(keyLenRaw);
          const keyBytes = keyLen === 0
            ? Buffer.alloc(0)
            : Buffer.from(new Uint8Array(toArrayBuffer(keyPtr, 0, keyLen)).slice());

          if (afterKeyBuf !== null && Buffer.compare(keyBytes, afterKeyBuf) <= 0) {
            return 0;
          }
          if (beforeKeyBuf !== null && Buffer.compare(keyBytes, beforeKeyBuf) >= 0) {
            return 0;
          }

          const valLen = Number(valLenRaw);
          const value = valLen === 0
            ? new Uint8Array(0)
            : new Uint8Array(toArrayBuffer(valPtr, 0, valLen)).slice();

          collected.push({
            keyBytes,
            key: keyBytes.toString('utf-8'),
            value,
          });
          return 0;
        } catch (err) {
          callbackError = err;
          return 1;
        }
      },
      {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr],
        returns: FFIType.i32,
      },
    );

    let rc: number;
    try {
      const prefixPtr = prefixBuf.byteLength > 0 ? ptr(prefixBuf) : ptr(DUMMY_BUF);
      rc = this.lib.symbols.wormdb_scan_prefix(
        this.dbPtr,
        prefixPtr,
        BigInt(prefixBuf.byteLength),
        nativeLimit,
        null,
        cb.ptr,
      );
    } finally {
      cb.close();
    }

    if (callbackError !== null) {
      throw callbackError;
    }
    if (rc !== WORMDB_OK) {
      throw new Error(`WormDB scan_prefix failed with code ${rc}`);
    }

    collected.sort((a, b) => Buffer.compare(a.keyBytes, b.keyBytes));
    const sliced = maxLimit !== undefined
      ? (direction === 'last' ? collected.slice(-maxLimit) : collected.slice(0, maxLimit))
      : collected;
    return sliced.map(({ key, value }) => ({ key, value }));
  }

  checkpointSync(): void {
    this.assertWritable('checkpoint');
    if (this.checkpointFn === null) {
      throw new Error('WormDB native library does not export wormdb_checkpoint_sync');
    }

    const rc = this.checkpointFn(this.dbPtr);
    if (rc !== WORMDB_OK) {
      this.latchFence(`WormDB checkpoint_sync failed with code ${rc}`);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const ptrToClose = this.dbPtr;
    this.lib.symbols.wormdb_close(ptrToClose);
  }
}

export function openWormDbBinary(options: WormDBStoreOptions): WormDbBinaryHandle {
  if (!options || typeof options !== 'object') {
    throw new TypeError('WormDBStoreOptions must be an object');
  }
  if (typeof options.dataDir !== 'string' || options.dataDir.length === 0) {
    throw new TypeError('options.dataDir is required and must be a non-empty string');
  }
  if (typeof options.libraryPath !== 'string' || options.libraryPath.length === 0) {
    throw new TypeError('options.libraryPath is required and must be a non-empty string');
  }
  if (options.dataDir.includes('\0')) {
    throw new Error('options.dataDir contains invalid NUL character');
  }
  if (options.libraryPath.includes('\0')) {
    throw new Error('options.libraryPath contains invalid NUL character');
  }

  const resolvedLib = path.resolve(options.libraryPath);
  const { lib, checkpointFn } = getOrLoadBinaryLib(resolvedLib);
  const resolvedDir = path.resolve(options.dataDir);
  fs.mkdirSync(resolvedDir, { recursive: true, mode: 0o700 });

  const dirBuf = Buffer.from(resolvedDir + '\0', 'utf-8');
  const dbPtr = lib.symbols.wormdb_open_sync(ptr(dirBuf));

  if (!dbPtr || dbPtr === 0n || Number(dbPtr) === 0) {
    throw new Error(`Failed to open WormDB database at: ${resolvedDir}`);
  }

  return new WormDbBinaryStore(dbPtr, lib, checkpointFn, resolvedDir, resolvedLib);
}
