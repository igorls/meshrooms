import fs from 'node:fs';
import path from 'node:path';
import { dlopen, FFIType, ptr, toArrayBuffer } from 'bun:ffi';
import type { DurableStore, WormDBStoreOptions } from './store.ts';

if (process.arch !== 'x64' && process.arch !== 'arm64') {
  throw new Error(`WormDB FFI requires a 64-bit architecture (x64 or arm64), found: ${process.arch}`);
}

export const WORMDB_OK = 0;
export const WORMDB_NOT_FOUND = 1;
export const WORMDB_PROC_ERR = 2;
export const WORMDB_ERR = -1;

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

type WormDBLib = ReturnType<typeof dlopen<typeof symbols>>;
type DbPointer = NonNullable<ReturnType<WormDBLib['symbols']['wormdb_open_sync']>>;

const libCache = new Map<string, WormDBLib>();

function getOrLoadLib(libraryPath: string): WormDBLib {
  const resolved = path.resolve(libraryPath);
  let loaded = libCache.get(resolved);
  if (!loaded) {
    if (!fs.existsSync(resolved)) {
      throw new Error(`WormDB native library not found at: ${resolved}`);
    }
    loaded = dlopen(resolved, symbols);
    libCache.set(resolved, loaded);
  }
  return loaded;
}

const DUMMY_BUF = Buffer.alloc(1);

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
