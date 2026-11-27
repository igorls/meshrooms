/**
 * Crash-safe pure-Bun filesystem `VfsStore` adapter (`BunFileVfsStore`) plus shared
 * symlink-hardened Tier 2 Cold Encrypted CAS storage (`FsColdCasStore`) reused by
 * `WormDbFfiVfsStore`.
 *
 * Tier 1 Hot KV (`<baseDir>/<roomId>/kv.wal` + `kv.snap`):
 * - Binary-safe append-only WAL (`"MVW1"` magic + IEEE CRC-32 + op tag PUT/DEL + u32 keyLen +
 *   u32 valLen + raw UTF-8 key + raw value bytes), `fsync`'d on every write.
 * - Atomic `checkpoint()`: writes `"MVS1"` snapshot + trailing SHA-256 to `kv.snap.tmp` (`0o600`),
 *   `fsync`s the temp file, atomically renames over `kv.snap`, `fsync`s the parent directory, and
 *   ONLY THEN truncates + `fsync`s `kv.wal`.
 * - Recovery tolerates a truncated tail partial write at EOF (truncates back to last valid record
 *   boundary and `fsync`s), while failing closed on any magic mismatch, middle corruption, invalid
 *   key, CRC mismatch on a full record, or snapshot SHA-256 mismatch.
 *
 * Tier 2 Cold Encrypted CAS (`<baseDir>/<roomId>/blocks/<cid[0..2]>/<cid>`):
 * - Symlink-hardened via segment-by-segment `lstatSync` checks and `O_NOFOLLOW`.
 * - Atomic `0o600` temp file -> `write` -> `fsync` -> `rename` -> parent directory `fsync`.
 * - Verifies `SHA-256(bytes) === cid` on both `putBlock` and `getBlock`.
 * - Persists per-member CAS attribution in sibling `<cid>.meta` sidecars written atomically
 *   before `<cid>` so per-member fairness quotas reconstruct accurately across reopen without
 *   polluting Tier 1 Hot KV key counts or byte budgets.
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  VFS_MAX_KV_KEY_BYTES,
  VfsError,
  vfsRoomPrefix,
} from '../../src/browser/vfs/constants.ts';
import {
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

// ---------------------------------------------------------------------------
// Shared Symlink-Hardened Filesystem & Atomic Durability Helpers
// ---------------------------------------------------------------------------

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = fs.constants.O_DIRECTORY ?? 0;
const HEX_2 = /^[a-f0-9]{2}$/;
const HEX_64 = /^[a-f0-9]{64}$/;

export type FsIoHooks = {
  beforeWalWrite?: () => void;
  beforeWalSync?: () => void;
  beforeSnapSync?: () => void;
  beforeSnapDirSync?: () => void;
  beforeWalTruncate?: () => void;
  beforeBlockWrite?: () => void;
};

/** Flush directory metadata for atomic rename durability (POSIX; NTFS no-op on Windows). */
export function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Walks `relativeSegments` beneath `baseRealDir` using `lstatSync`, rejecting any symbolic link
 * or type mismatch. Returns the `lstatSync` result of the final segment, or `undefined` if absent.
 */
export function assertNoSymlinkComponents(
  baseRealDir: string,
  relativeSegments: readonly string[],
  expectLeaf: 'dir' | 'file' | 'any' = 'any',
): fs.Stats | undefined {
  let current = baseRealDir;
  for (let i = 0; i < relativeSegments.length; i++) {
    const seg = relativeSegments[i];
    if (!seg || seg === '.' || seg === '..' || seg.includes('/') || seg.includes('\\') || seg.includes('\0')) {
      throw new VfsError('VFS_STORAGE_FAILED', `Invalid storage path segment: "${seg}".`);
    }
    current = path.join(current, seg);
    const st = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!st) {
      return undefined;
    }
    if (st.isSymbolicLink()) {
      throw new VfsError('VFS_STORAGE_FAILED', `Refusing to follow symbolic link in VFS storage at "${seg}".`);
    }
    const isLast = i === relativeSegments.length - 1;
    if (!isLast) {
      if (!st.isDirectory()) {
        throw new VfsError('VFS_STORAGE_FAILED', `Expected directory in VFS storage at "${seg}".`);
      }
    } else {
      if (expectLeaf === 'dir' && !st.isDirectory()) {
        throw new VfsError('VFS_STORAGE_FAILED', `Expected directory in VFS storage at "${seg}".`);
      }
      if (expectLeaf === 'file' && !st.isFile()) {
        throw new VfsError('VFS_STORAGE_FAILED', `Expected regular file in VFS storage at "${seg}".`);
      }
      return st;
    }
  }
  return fs.lstatSync(baseRealDir);
}

/** Creates nested directories beneath `baseRealDir` (`0o700`), rejecting symlinks at every level. */
export function ensureSafeDir(baseRealDir: string, relativeSegments: readonly string[]): string {
  let current = baseRealDir;
  for (let i = 0; i < relativeSegments.length; i++) {
    const seg = relativeSegments[i];
    if (!seg || seg === '.' || seg === '..' || seg.includes('/') || seg.includes('\\') || seg.includes('\0')) {
      throw new VfsError('VFS_STORAGE_FAILED', `Invalid storage directory segment: "${seg}".`);
    }
    current = path.join(current, seg);
    const st = fs.lstatSync(current, { throwIfNoEntry: false });
    if (st) {
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new VfsError('VFS_STORAGE_FAILED', `Refusing non-directory or symlink at "${seg}".`);
      }
    } else {
      fs.mkdirSync(current, { mode: 0o700 });
      syncDirectory(path.dirname(current));
    }
  }
  return current;
}

function writeAllSync(fd: number, data: Uint8Array, startPosition?: number): void {
  let offset = 0;
  let pos = startPosition;
  while (offset < data.byteLength) {
    const written = pos === undefined
      ? fs.writeSync(fd, data, offset, data.byteLength - offset)
      : fs.writeSync(fd, data, offset, data.byteLength - offset, pos);
    if (written <= 0) {
      throw new Error('Short write while persisting VFS bytes');
    }
    offset += written;
    if (pos !== undefined) pos += written;
  }
}

/**
 * Writes `data` atomically to `<baseRealDir>/<...dirSegments>/<fileName>` with mode `0o600`:
 * temp file (`O_EXCL | O_NOFOLLOW`) -> write -> `fsync` -> `close` -> `rename` -> dir `fsync`.
 */
export function writeFileAtomicSync(
  baseRealDir: string,
  dirSegments: readonly string[],
  fileName: string,
  data: Uint8Array,
  options?: { beforeSync?: () => void; beforeDirSync?: () => void },
): void {
  const dirPath = ensureSafeDir(baseRealDir, dirSegments);
  // Ensure existing destination (if any) is not a symlink or directory.
  assertNoSymlinkComponents(baseRealDir, [...dirSegments, fileName], 'file');

  const tempName = `.${fileName}.${randomUUID()}.tmp`;
  const tempPath = path.join(dirPath, tempName);
  const targetPath = path.join(dirPath, fileName);

  const fd = fs.openSync(
    tempPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
    0o600,
  );
  let closed = false;
  let renamed = false;
  try {
    writeAllSync(fd, data);
    options?.beforeSync?.();
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    closed = true;

    fs.renameSync(tempPath, targetPath);
    renamed = true;

    options?.beforeDirSync?.();
    syncDirectory(dirPath);
  } catch (err) {
    if (!closed) {
      try { fs.closeSync(fd); } catch { /* Best effort. */ }
    }
    if (!renamed) {
      try { fs.unlinkSync(tempPath); } catch { /* Best effort. */ }
    }
    throw err;
  }
}

/** Reads a regular file beneath `baseRealDir` without following symlinks (`undefined` if missing). */
export function readFileSafeSync(
  baseRealDir: string,
  fileSegments: readonly string[],
): Uint8Array | undefined {
  const st = assertNoSymlinkComponents(baseRealDir, fileSegments, 'file');
  if (!st) return undefined;

  const fullPath = path.join(baseRealDir, ...fileSegments);
  let fd: number;
  try {
    fd = fs.openSync(fullPath, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    const fstat = fs.fstatSync(fd);
    if (!fstat.isFile()) {
      throw new VfsError('VFS_STORAGE_FAILED', 'Refusing to read non-regular VFS file.');
    }
    const buf = fs.readFileSync(fd);
    return copyBytes(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  } finally {
    fs.closeSync(fd);
  }
}

/** Resolves and creates `baseDir` (`0o700`), rejecting if it is a non-directory. */
export function prepareBaseDir(baseDir: string): string {
  if (typeof baseDir !== 'string' || baseDir.length === 0) {
    throw new VfsError('VFS_INVALID_KEY', 'baseDir must be a non-empty string.');
  }
  if (baseDir.includes('\0')) {
    throw new VfsError('VFS_INVALID_KEY', 'baseDir must not contain NUL bytes.');
  }
  const resolved = path.resolve(baseDir);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const real = fs.realpathSync(resolved);
  const st = fs.lstatSync(real);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new VfsError('VFS_STORAGE_FAILED', `VFS baseDir is not a directory: ${real}`);
  }
  return real;
}

/** Safely removes `<baseRealDir>/<roomId>` without traversing a symlinked room directory. */
export function destroyRoomDirectory(baseRealDir: string, roomId: string): void {
  validateVfsRoomId(roomId);
  const st = assertNoSymlinkComponents(baseRealDir, [roomId], 'dir');
  if (!st) return;
  const roomDir = path.join(baseRealDir, roomId);
  fs.rmSync(roomDir, { recursive: true, force: true });
  syncDirectory(baseRealDir);
}

// ---------------------------------------------------------------------------
// Inter-Process Room Directory Lock (`<baseDir>/<roomId>/.vfs.lock`, O_EXCL)
// ---------------------------------------------------------------------------

export const VFS_ROOM_LOCK_FILE = '.vfs.lock';
const ROOM_LOCKED_MESSAGE = 'Room VFS directory is locked by another handle/process';

type RoomLockRecord = {
  pid: number;
  acquiredAt: number;
  token: string;
};

export type RoomDirectoryLock = {
  readonly roomId: string;
  readonly lockPath: string;
  readonly token: string;
  release(): void;
};

function isPidDead(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ESRCH';
  }
}

function parseRoomLockRecord(raw: Uint8Array): RoomLockRecord | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw).toString('utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.pid !== 'number' || !Number.isInteger(obj.pid) || obj.pid <= 0) return null;
    if (typeof obj.acquiredAt !== 'number' || !Number.isFinite(obj.acquiredAt)) return null;
    if (typeof obj.token !== 'string' || obj.token.length === 0) return null;
    return { pid: obj.pid, acquiredAt: obj.acquiredAt, token: obj.token };
  } catch {
    return null;
  }
}

/**
 * Acquires an atomic `O_EXCL` lockfile (`<baseRealDir>/<roomId>/.vfs.lock`, `0o600`)
 * containing `{ pid, acquiredAt, token }`. Automatically reclaims ONLY if the recorded
 * PID is confirmed dead (`process.kill(pid, 0)` throws `ESRCH`); if alive (including
 * same-PID double-open without closing) or unreadable, fails closed with `VFS_STORAGE_FENCED`.
 */
export function acquireRoomLock(baseRealDir: string, roomId: string): RoomDirectoryLock {
  validateVfsRoomId(roomId);
  const roomDir = ensureSafeDir(baseRealDir, [roomId]);
  const lockSegments = [roomId, VFS_ROOM_LOCK_FILE];
  const lockPath = path.join(roomDir, VFS_ROOM_LOCK_FILE);
  const token = randomUUID();
  const payload = Buffer.from(
    JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), token } satisfies RoomLockRecord),
    'utf-8',
  );
  const payloadBytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);

  for (let attempt = 0; attempt < 3; attempt++) {
    assertNoSymlinkComponents(baseRealDir, lockSegments, 'file');
    let fd: number;
    try {
      fd = fs.openSync(
        lockPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
        0o600,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        throw err;
      }
      // Existing lockfile present: inspect PID and reclaim ONLY if confirmed dead (ESRCH).
      const existingBytes = readFileSafeSync(baseRealDir, lockSegments);
      if (!existingBytes) {
        // Lockfile disappeared concurrently; retry atomic creation.
        continue;
      }
      const existing = parseRoomLockRecord(existingBytes);
      if (!existing || !isPidDead(existing.pid)) {
        throw new VfsError('VFS_STORAGE_FENCED', ROOM_LOCKED_MESSAGE, {
          details: { roomId, holderPid: existing?.pid },
        });
      }
      // Verify the lockfile still carries the same dead-PID token before unlinking, then retry O_EXCL.
      const recheckBytes = readFileSafeSync(baseRealDir, lockSegments);
      const recheck = recheckBytes ? parseRoomLockRecord(recheckBytes) : null;
      if (recheck && recheck.pid === existing.pid && recheck.token === existing.token) {
        try {
          fs.unlinkSync(lockPath);
          syncDirectory(roomDir);
        } catch (unlinkErr) {
          if ((unlinkErr as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            throw unlinkErr;
          }
        }
      }
      continue;
    }

    let closed = false;
    try {
      writeAllSync(fd, payloadBytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      closed = true;
      syncDirectory(roomDir);
    } catch (err) {
      if (!closed) {
        try { fs.closeSync(fd); } catch { /* Best effort. */ }
      }
      try { fs.unlinkSync(lockPath); } catch { /* Best effort. */ }
      throw err;
    }

    let released = false;
    return {
      roomId,
      lockPath,
      token,
      release(): void {
        if (released) return;
        released = true;
        try {
          const currentBytes = readFileSafeSync(baseRealDir, lockSegments);
          if (!currentBytes) return;
          const current = parseRoomLockRecord(currentBytes);
          if (!current || current.token !== token) return;
          fs.unlinkSync(lockPath);
          syncDirectory(roomDir);
        } catch {
          // Best effort on release (directory may already have been destroyed).
        }
      },
    };
  }

  throw new VfsError('VFS_STORAGE_FENCED', ROOM_LOCKED_MESSAGE, { details: { roomId } });
}

/** Rejects `destroyRoom` if another live handle/process holds `<roomDir>/.vfs.lock`. */
export function assertRoomNotLockedByOther(baseRealDir: string, roomId: string): void {
  validateVfsRoomId(roomId);
  const st = assertNoSymlinkComponents(baseRealDir, [roomId], 'dir');
  if (!st) return;
  const existingBytes = readFileSafeSync(baseRealDir, [roomId, VFS_ROOM_LOCK_FILE]);
  if (!existingBytes) return;
  const existing = parseRoomLockRecord(existingBytes);
  if (!existing || !isPidDead(existing.pid)) {
    throw new VfsError('VFS_STORAGE_FENCED', ROOM_LOCKED_MESSAGE, {
      details: { roomId, holderPid: existing?.pid },
    });
  }
}

// ---------------------------------------------------------------------------
// Shared Tier 2 Cold Encrypted CAS Store (`<baseDir>/<roomId>/blocks/<xx>/<cid>`)
// ---------------------------------------------------------------------------

type BlockMetaJson = {
  authorMemberId?: string;
};

export class FsColdCasStore {
  private readonly blockSizes = new Map<string, number>();
  private readonly blockAuthors = new Map<string, string>();
  private readonly memberCasBytes = new Map<string, number>();
  private totalBytes = 0;

  constructor(
    private readonly baseRealDir: string,
    readonly roomId: string,
    private readonly ioHooks?: FsIoHooks,
  ) {
    validateVfsRoomId(roomId);
    this.reconstructFromDisk();
  }

  get coldCasBytes(): number {
    return this.totalBytes;
  }

  get coldCasBlocks(): number {
    return this.blockSizes.size;
  }

  private reconstructFromDisk(): void {
    const blocksStat = assertNoSymlinkComponents(this.baseRealDir, [this.roomId, 'blocks'], 'dir');
    if (!blocksStat) return;

    const blocksDir = path.join(this.baseRealDir, this.roomId, 'blocks');
    for (const shardName of fs.readdirSync(blocksDir)) {
      const shardStat = assertNoSymlinkComponents(this.baseRealDir, [this.roomId, 'blocks', shardName], 'any');
      if (!shardStat) continue;
      if (!HEX_2.test(shardName)) continue;
      if (!shardStat.isDirectory()) {
        throw new VfsError('VFS_STORAGE_FAILED', `Expected directory for CAS shard "${shardName}".`);
      }

      const shardDir = path.join(blocksDir, shardName);
      for (const entryName of fs.readdirSync(shardDir)) {
        const entrySegments = [this.roomId, 'blocks', shardName, entryName];
        const st = assertNoSymlinkComponents(this.baseRealDir, entrySegments, 'any');
        if (!st) continue;

        if (entryName.endsWith('.tmp')) {
          if (!st.isFile()) {
            throw new VfsError('VFS_STORAGE_FAILED', `Expected regular temp file at "${entryName}".`);
          }
          // Abandoned pre-rename temp file from a prior crash; clean up best effort.
          try { fs.unlinkSync(path.join(shardDir, entryName)); } catch { /* Best effort. */ }
          continue;
        }
        if (!HEX_64.test(entryName)) continue;
        if (!st.isFile()) {
          throw new VfsError('VFS_STORAGE_FAILED', `Expected regular CAS block file at "${entryName}".`);
        }
        if (!entryName.startsWith(shardName)) continue;

        const size = st.size;
        this.blockSizes.set(entryName, size);
        this.totalBytes += size;

        const metaBytes = readFileSafeSync(this.baseRealDir, [this.roomId, 'blocks', shardName, `${entryName}.meta`]);
        if (metaBytes) {
          let validMeta = false;
          try {
            const parsed = JSON.parse(Buffer.from(metaBytes).toString('utf-8')) as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              const metaObj = parsed as BlockMetaJson;
              if (metaObj.authorMemberId === undefined) {
                validMeta = true;
              } else if (typeof metaObj.authorMemberId === 'string' && metaObj.authorMemberId.length > 0) {
                validMeta = true;
                this.blockAuthors.set(entryName, metaObj.authorMemberId);
                this.memberCasBytes.set(
                  metaObj.authorMemberId,
                  (this.memberCasBytes.get(metaObj.authorMemberId) ?? 0) + size,
                );
              }
            }
          } catch {
            validMeta = false;
          }
          if (!validMeta) {
            // Recover gracefully from a single corrupt .meta sidecar: remove it and keep the
            // valid block file's size recomputed directly from disk rather than bricking the room.
            try {
              fs.unlinkSync(path.join(shardDir, `${entryName}.meta`));
              syncDirectory(shardDir);
            } catch {
              // Best effort if concurrently removed.
            }
          }
        }
      }
    }
  }

  async putBlock(
    cid: string,
    bytes: Uint8Array,
    quotas: ResolvedVfsStoreQuotas,
    opts?: VfsPutBlockOptions,
  ): Promise<boolean> {
    assertBlockSizeWithinCap(bytes);
    await verifyBlockCid(cid, bytes);

    const shard = cid.slice(0, 2);
    const dirSegments = [this.roomId, 'blocks', shard];
    const fileSegments = [this.roomId, 'blocks', shard, cid];
    const existingBytes = readFileSafeSync(this.baseRealDir, fileSegments);
    let prevSize = this.blockSizes.get(cid) ?? 0;
    const prevAuthor = this.blockAuthors.get(cid);
    if (existingBytes !== undefined) {
      if (bytesEqual(existingBytes, bytes)) {
        if (!this.blockSizes.has(cid)) {
          this.blockSizes.set(cid, existingBytes.byteLength);
          this.totalBytes += existingBytes.byteLength;
        }
        return false;
      }
      // Existing block on disk is corrupted (bytes do not match verified CID payload);
      // fall through to atomically replace it with valid bytes and return true.
      if (!this.blockSizes.has(cid)) {
        prevSize = 0;
      }
    } else if (this.blockSizes.has(cid)) {
      this.blockSizes.delete(cid);
      this.totalBytes = Math.max(0, this.totalBytes - prevSize);
      if (prevAuthor !== undefined) {
        this.blockAuthors.delete(cid);
        const prevUsed = this.memberCasBytes.get(prevAuthor) ?? 0;
        const reduced = Math.max(0, prevUsed - prevSize);
        if (reduced === 0) this.memberCasBytes.delete(prevAuthor);
        else this.memberCasBytes.set(prevAuthor, reduced);
      }
      prevSize = 0;
    }

    const size = bytes.byteLength;
    const nextTotalBytes = Math.max(0, this.totalBytes - prevSize) + size;
    if (nextTotalBytes > quotas.coldCasMaxBytes) {
      throw new VfsError(
        'VFS_STORAGE_QUOTA',
        `Cold CAS quota exceeded for room ${this.roomId} (${nextTotalBytes} > ${quotas.coldCasMaxBytes}).`,
        { details: { coldCasBytes: this.totalBytes, size, coldCasMaxBytes: quotas.coldCasMaxBytes } },
      );
    }

    const author = opts?.authorMemberId;
    if (author !== undefined) {
      const memberCap = perMemberCasLimitBytes(quotas);
      const memberUsed = this.memberCasBytes.get(author) ?? 0;
      const adjustedMemberUsed = prevAuthor === author ? Math.max(0, memberUsed - prevSize) : memberUsed;
      if (adjustedMemberUsed + size > memberCap) {
        throw new VfsError(
          'VFS_STORAGE_QUOTA',
          `Per-member CAS fairness quota exceeded for ${author} (${adjustedMemberUsed + size} > ${memberCap}).`,
          { details: { authorMemberId: author, memberUsed: adjustedMemberUsed, size, memberCap } },
        );
      }
    }

    this.ioHooks?.beforeBlockWrite?.();
    if (author !== undefined) {
      const metaPayload = Buffer.from(JSON.stringify({ authorMemberId: author }), 'utf-8');
      writeFileAtomicSync(
        this.baseRealDir,
        dirSegments,
        `${cid}.meta`,
        new Uint8Array(metaPayload.buffer, metaPayload.byteOffset, metaPayload.byteLength),
      );
    } else if (prevAuthor !== undefined) {
      const metaSegments = [this.roomId, 'blocks', shard, `${cid}.meta`];
      if (assertNoSymlinkComponents(this.baseRealDir, metaSegments, 'file')) {
        try {
          const shardDir = path.join(this.baseRealDir, this.roomId, 'blocks', shard);
          fs.unlinkSync(path.join(shardDir, `${cid}.meta`));
          syncDirectory(shardDir);
        } catch { /* Best effort. */ }
      }
    }
    writeFileAtomicSync(this.baseRealDir, dirSegments, cid, bytes);

    if (prevAuthor !== undefined) {
      this.blockAuthors.delete(cid);
      const prevUsed = this.memberCasBytes.get(prevAuthor) ?? 0;
      const reduced = Math.max(0, prevUsed - prevSize);
      if (reduced === 0) this.memberCasBytes.delete(prevAuthor);
      else this.memberCasBytes.set(prevAuthor, reduced);
    }
    this.blockSizes.set(cid, size);
    this.totalBytes = nextTotalBytes;
    if (author !== undefined) {
      this.blockAuthors.set(cid, author);
      this.memberCasBytes.set(author, (this.memberCasBytes.get(author) ?? 0) + size);
    }
    return true;
  }

  async getBlock(cid: string): Promise<Uint8Array | undefined> {
    validateBlockCid(cid);
    const shard = cid.slice(0, 2);
    const bytes = readFileSafeSync(this.baseRealDir, [this.roomId, 'blocks', shard, cid]);
    if (!bytes) return undefined;
    await verifyBlockCid(cid, bytes);
    return bytes;
  }

  hasBlock(cid: string): boolean {
    validateBlockCid(cid);
    const shard = cid.slice(0, 2);
    const st = assertNoSymlinkComponents(this.baseRealDir, [this.roomId, 'blocks', shard, cid], 'file');
    return st !== undefined;
  }

  deleteBlock(cid: string): boolean {
    validateBlockCid(cid);
    const shard = cid.slice(0, 2);
    const fileSegments = [this.roomId, 'blocks', shard, cid];
    const st = assertNoSymlinkComponents(this.baseRealDir, fileSegments, 'file');
    if (!st) {
      return false;
    }

    const shardDir = path.join(this.baseRealDir, this.roomId, 'blocks', shard);
    const blockPath = path.join(shardDir, cid);
    fs.unlinkSync(blockPath);
    syncDirectory(shardDir);

    const metaSegments = [this.roomId, 'blocks', shard, `${cid}.meta`];
    const metaStat = assertNoSymlinkComponents(this.baseRealDir, metaSegments, 'file');
    if (metaStat) {
      try {
        fs.unlinkSync(path.join(shardDir, `${cid}.meta`));
        syncDirectory(shardDir);
      } catch {
        // Block is already gone; an orphaned .meta file is ignored on reopen.
      }
    }

    const trackedSize = this.blockSizes.get(cid) ?? st.size;
    this.blockSizes.delete(cid);
    this.totalBytes = Math.max(0, this.totalBytes - trackedSize);

    const author = this.blockAuthors.get(cid);
    if (author !== undefined) {
      this.blockAuthors.delete(cid);
      const prev = this.memberCasBytes.get(author) ?? 0;
      const next = Math.max(0, prev - trackedSize);
      if (next === 0) this.memberCasBytes.delete(author);
      else this.memberCasBytes.set(author, next);
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Standard IEEE 802.3 CRC-32 & Binary WAL/Snapshot Codecs for BunFileVfsStore
// ---------------------------------------------------------------------------

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC32_TABLE[i] = c >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.byteLength; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const WAL_MAGIC = new Uint8Array([0x4d, 0x56, 0x57, 0x31]); // "MVW1"
const SNAP_MAGIC = new Uint8Array([0x4d, 0x56, 0x53, 0x31]); // "MVS1"
const SNAP_VERSION = 1;
// 21-byte WAL record header:
//   [0..4]   magic "MVW1"
//   [4..8]   u32 LE headerCrc32 over [12..21] (protects op + keyLen + valLen against corrupt length fields)
//   [8..12]  u32 LE bodyCrc32 over [21..21 + keyLen + valLen]
//   [12]     op tag (0x01 PUT, 0x02 DEL)
//   [13..17] u32 LE keyLen
//   [17..21] u32 LE valLen
const WAL_HEADER_BYTES = 21;
const WAL_OP_PUT = 0x01;
const WAL_OP_DEL = 0x02;
const SNAP_HEADER_BYTES = 12;
const SNAP_HASH_BYTES = 32;
const MAX_WAL_VALUE_BYTES = 128 * 1024 * 1024;

function magicMatches(buf: Uint8Array, offset: number, magic: Uint8Array, len = 4): boolean {
  for (let i = 0; i < len; i++) {
    if (buf[offset + i] !== magic[i]) return false;
  }
  return true;
}

function encodeWalRecord(op: number, key: string, value: Uint8Array): Uint8Array {
  const keyBytes = Buffer.from(key, 'utf-8');
  const totalLen = WAL_HEADER_BYTES + keyBytes.byteLength + value.byteLength;
  const buf = new Uint8Array(totalLen);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  buf.set(WAL_MAGIC, 0);
  buf[12] = op;
  view.setUint32(13, keyBytes.byteLength, true);
  view.setUint32(17, value.byteLength, true);
  buf.set(keyBytes, WAL_HEADER_BYTES);
  if (value.byteLength > 0) {
    buf.set(value, WAL_HEADER_BYTES + keyBytes.byteLength);
  }
  const headerChecksum = crc32(buf.subarray(12, WAL_HEADER_BYTES));
  const bodyChecksum = crc32(buf.subarray(WAL_HEADER_BYTES));
  view.setUint32(4, headerChecksum, true);
  view.setUint32(8, bodyChecksum, true);
  return buf;
}

function encodeSnapshot(kv: Map<string, Uint8Array<ArrayBuffer>>): Uint8Array {
  const keys = [...kv.keys()].sort(compareUtf8Lex);
  const encodedEntries: { keyBytes: Buffer; valBytes: Uint8Array }[] = [];
  let bodySize = SNAP_HEADER_BYTES;
  for (const key of keys) {
    const keyBytes = Buffer.from(key, 'utf-8');
    const valBytes = kv.get(key)!;
    encodedEntries.push({ keyBytes, valBytes });
    bodySize += 8 + keyBytes.byteLength + valBytes.byteLength;
  }

  const out = new Uint8Array(bodySize + SNAP_HASH_BYTES);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  out.set(SNAP_MAGIC, 0);
  view.setUint32(4, SNAP_VERSION, true);
  view.setUint32(8, encodedEntries.length, true);

  let offset = SNAP_HEADER_BYTES;
  for (const { keyBytes, valBytes } of encodedEntries) {
    view.setUint32(offset, keyBytes.byteLength, true);
    view.setUint32(offset + 4, valBytes.byteLength, true);
    offset += 8;
    out.set(keyBytes, offset);
    offset += keyBytes.byteLength;
    if (valBytes.byteLength > 0) {
      out.set(valBytes, offset);
      offset += valBytes.byteLength;
    }
  }

  const digest = createHash('sha256').update(out.subarray(0, bodySize)).digest();
  out.set(digest, bodySize);
  return out;
}

function isAllZeroBytes(buf: Uint8Array, from: number): boolean {
  for (let i = from; i < buf.byteLength; i++) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

function isValidWalRecordAt(roomId: string, buf: Uint8Array, view: DataView, pos: number): boolean {
  if (pos + WAL_HEADER_BYTES > buf.byteLength) return false;
  if (!magicMatches(buf, pos, WAL_MAGIC)) return false;

  const expectedHeaderCrc = view.getUint32(pos + 4, true);
  const expectedBodyCrc = view.getUint32(pos + 8, true);
  const actualHeaderCrc = crc32(buf.subarray(pos + 12, pos + WAL_HEADER_BYTES));
  if (actualHeaderCrc !== expectedHeaderCrc) return false;

  const op = buf[pos + 12];
  const keyLen = view.getUint32(pos + 13, true);
  const valLen = view.getUint32(pos + 17, true);
  if ((op !== WAL_OP_PUT && op !== WAL_OP_DEL) || keyLen === 0 || keyLen > VFS_MAX_KV_KEY_BYTES) return false;
  if (op === WAL_OP_DEL && valLen !== 0) return false;
  if (valLen > MAX_WAL_VALUE_BYTES) return false;

  const recordEnd = pos + WAL_HEADER_BYTES + keyLen + valLen;
  if (recordEnd > buf.byteLength) return false;

  const actualBodyCrc = crc32(buf.subarray(pos + WAL_HEADER_BYTES, recordEnd));
  if (actualBodyCrc !== expectedBodyCrc) return false;

  const keyStart = pos + WAL_HEADER_BYTES;
  const key = Buffer.from(buf.subarray(keyStart, keyStart + keyLen)).toString('utf-8');
  try {
    validateVfsKvKey(roomId, key);
  } catch {
    return false;
  }
  return true;
}

function hasLaterValidWalRecord(roomId: string, buf: Uint8Array, view: DataView, searchFrom: number): boolean {
  const maxStart = buf.byteLength - WAL_HEADER_BYTES;
  for (let pos = searchFrom; pos <= maxStart; pos++) {
    if (
      buf[pos] === WAL_MAGIC[0]
      && buf[pos + 1] === WAL_MAGIC[1]
      && buf[pos + 2] === WAL_MAGIC[2]
      && buf[pos + 3] === WAL_MAGIC[3]
      && isValidWalRecordAt(roomId, buf, view, pos)
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// BunFileVfsStore — Crash-Safe Pure-Bun WAL + Snapshot + Cold CAS VfsStore
// ---------------------------------------------------------------------------

type BunFileRoomEngine = {
  roomId: string;
  roomDir: string;
  lock: RoomDirectoryLock;
  walFd: number;
  walOffset: number;
  kv: Map<string, Uint8Array<ArrayBuffer>>;
  hotKvBytes: number;
  cas: FsColdCasStore;
  handles: Set<BunFileVfsRoomStore>;
  closed: boolean;
};

export type BunFileVfsStoreOptions = {
  baseDir: string;
  ioHooks?: FsIoHooks;
};

export class BunFileVfsRoomStore implements VfsRoomStore {
  readonly kind: VfsStoreKind = 'bun-file';
  readonly quotas: ResolvedVfsStoreQuotas;
  readonly fence: VfsRoomFence;
  private closed = false;

  constructor(
    readonly roomId: string,
    private readonly engine: BunFileRoomEngine,
    quotas: ResolvedVfsStoreQuotas,
    private readonly ioHooks: FsIoHooks | undefined,
    private readonly onHandleClose: (handle: BunFileVfsRoomStore) => void,
    private readonly onEngineFault: (roomId: string, reason: string) => void,
  ) {
    this.quotas = quotas;
    this.fence = new VfsRoomFence(roomId);
  }

  get isFenced(): boolean {
    return this.fence.fenced;
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
    this.onEngineFault(this.roomId, reason);
    if (cause instanceof VfsError && cause.code === 'VFS_STORAGE_FAILED') {
      throw cause;
    }
    throw new VfsError('VFS_STORAGE_FAILED', reason, { cause });
  }

  private appendWalOrFence(op: number, key: string, value: Uint8Array): void {
    const record = encodeWalRecord(op, key, value);
    try {
      this.ioHooks?.beforeWalWrite?.();
      writeAllSync(this.engine.walFd, record, this.engine.walOffset);
      this.ioHooks?.beforeWalSync?.();
      fs.fsyncSync(this.engine.walFd);
      this.engine.walOffset += record.byteLength;
    } catch (err) {
      this.failAndFence('BunFile WAL append/sync failed', err);
    }
  }

  async kvGet(key: string): Promise<Uint8Array | undefined> {
    this.assertUsable();
    validateVfsKvKey(this.roomId, key);
    const val = this.engine.kv.get(key);
    return val ? copyBytes(val) : undefined;
  }

  async kvPut(key: string, value: Uint8Array): Promise<void> {
    this.assertUsable();
    validateVfsKvKey(this.roomId, key);
    if (!(value instanceof Uint8Array)) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'KV value must be a Uint8Array.');
    }
    const existing = this.engine.kv.get(key);
    const nextSize = kvEntryBytes(key, value);
    const prevSize = existing ? kvEntryBytes(key, existing) : 0;
    const delta = nextSize - prevSize;
    if (delta > 0 && this.engine.hotKvBytes + delta > this.quotas.hotKvMaxBytes) {
      throw new VfsError(
        'VFS_STORAGE_QUOTA',
        `Hot KV quota exceeded for room ${this.roomId} (${this.engine.hotKvBytes + delta} > ${this.quotas.hotKvMaxBytes}).`,
        { details: { hotKvBytes: this.engine.hotKvBytes, delta, hotKvMaxBytes: this.quotas.hotKvMaxBytes } },
      );
    }

    const copied = copyBytes(value);
    this.appendWalOrFence(WAL_OP_PUT, key, copied);
    this.engine.kv.set(key, copied);
    this.engine.hotKvBytes += delta;
  }

  async kvPutIfAbsent(key: string, value: Uint8Array): Promise<boolean> {
    this.assertUsable();
    validateVfsKvKey(this.roomId, key);
    if (!(value instanceof Uint8Array)) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'KV value must be a Uint8Array.');
    }
    if (this.engine.kv.has(key)) return false;

    const size = kvEntryBytes(key, value);
    if (this.engine.hotKvBytes + size > this.quotas.hotKvMaxBytes) {
      throw new VfsError(
        'VFS_STORAGE_QUOTA',
        `Hot KV quota exceeded for room ${this.roomId} (${this.engine.hotKvBytes + size} > ${this.quotas.hotKvMaxBytes}).`,
        { details: { hotKvBytes: this.engine.hotKvBytes, delta: size, hotKvMaxBytes: this.quotas.hotKvMaxBytes } },
      );
    }

    const copied = copyBytes(value);
    this.appendWalOrFence(WAL_OP_PUT, key, copied);
    this.engine.kv.set(key, copied);
    this.engine.hotKvBytes += size;
    return true;
  }

  async kvDelete(key: string): Promise<boolean> {
    this.assertUsable();
    validateVfsKvKey(this.roomId, key);
    const existing = this.engine.kv.get(key);
    if (!existing) return false;

    this.appendWalOrFence(WAL_OP_DEL, key, new Uint8Array(0));
    this.engine.kv.delete(key);
    this.engine.hotKvBytes = Math.max(0, this.engine.hotKvBytes - kvEntryBytes(key, existing));
    return true;
  }

  async kvScanPrefix(prefix: string, opts?: VfsScanPrefixOptions): Promise<VfsKvEntry[]> {
    this.assertUsable();
    validateVfsKvPrefix(this.roomId, prefix);
    const { afterKey, beforeKey, limit, direction } = validateScanPrefixOptions(opts);
    if (afterKey !== undefined && beforeKey !== undefined && compareUtf8Lex(afterKey, beforeKey) >= 0) {
      return [];
    }

    const matchedKeys: string[] = [];
    for (const k of this.engine.kv.keys()) {
      if (!k.startsWith(prefix)) continue;
      if (afterKey !== undefined && compareUtf8Lex(k, afterKey) <= 0) continue;
      if (beforeKey !== undefined && compareUtf8Lex(k, beforeKey) >= 0) continue;
      matchedKeys.push(k);
    }
    matchedKeys.sort(compareUtf8Lex);
    const slice = limit !== undefined && limit > 0
      ? (direction === 'last' ? matchedKeys.slice(-limit) : matchedKeys.slice(0, limit))
      : matchedKeys;
    return slice.map(k => ({ key: k, value: copyBytes(this.engine.kv.get(k)!) }));
  }

  async putBlock(cid: string, bytes: Uint8Array, opts?: VfsPutBlockOptions): Promise<boolean> {
    this.assertUsable();
    try {
      return await this.engine.cas.putBlock(cid, bytes, this.quotas, opts);
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
    return this.engine.cas.getBlock(cid);
  }

  async hasBlock(cid: string): Promise<boolean> {
    this.assertUsable();
    return this.engine.cas.hasBlock(cid);
  }

  async deleteBlock(cid: string): Promise<boolean> {
    this.assertUsable();
    try {
      return this.engine.cas.deleteBlock(cid);
    } catch (err) {
      if (err instanceof VfsError && (err.code === 'VFS_INVALID_ENVELOPE' || err.code === 'VFS_INVALID_KEY')) {
        throw err;
      }
      this.failAndFence('Cold CAS deleteBlock failed', err);
    }
  }

  async checkpoint(): Promise<void> {
    this.assertUsable();
    const baseRealDir = path.dirname(this.engine.roomDir);
    try {
      const snapBytes = encodeSnapshot(this.engine.kv);
      writeFileAtomicSync(baseRealDir, [this.roomId], 'kv.snap', snapBytes, {
        beforeSync: this.ioHooks?.beforeSnapSync,
        beforeDirSync: this.ioHooks?.beforeSnapDirSync,
      });

      this.ioHooks?.beforeWalTruncate?.();
      fs.ftruncateSync(this.engine.walFd, 0);
      fs.fsyncSync(this.engine.walFd);
      this.engine.walOffset = 0;
    } catch (err) {
      this.failAndFence('BunFile checkpoint failed', err);
    }
  }

  async stats(): Promise<VfsRoomStats> {
    if (this.closed) {
      throw new VfsError('VFS_STORAGE_CLOSED', `VFS room store for ${this.roomId} is closed.`);
    }
    return {
      hotKvBytes: this.engine.hotKvBytes,
      hotKvKeys: this.engine.kv.size,
      coldCasBytes: this.engine.cas.coldCasBytes,
      coldCasBlocks: this.engine.cas.coldCasBlocks,
      fenced: this.fence.fenced,
      ...(this.fence.reason !== undefined ? { fencedReason: this.fence.reason } : {}),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onHandleClose(this);
  }
}

export class BunFileVfsStore implements VfsStore {
  readonly kind: VfsStoreKind = 'bun-file';
  readonly baseDir: string;
  private readonly ioHooks?: FsIoHooks;
  private closed = false;
  private readonly engines = new Map<string, BunFileRoomEngine>();

  constructor(options: BunFileVfsStoreOptions) {
    this.baseDir = prepareBaseDir(options.baseDir);
    this.ioHooks = options.ioHooks;
  }

  private loadSnapshotInto(roomId: string, kv: Map<string, Uint8Array<ArrayBuffer>>): void {
    const snapBytes = readFileSafeSync(this.baseDir, [roomId, 'kv.snap']);
    if (!snapBytes) return;

    if (snapBytes.byteLength < SNAP_HEADER_BYTES + SNAP_HASH_BYTES) {
      throw new VfsError('VFS_STORAGE_FAILED', `Corrupt kv.snap for room ${roomId}: truncated file.`);
    }
    if (!magicMatches(snapBytes, 0, SNAP_MAGIC)) {
      throw new VfsError('VFS_STORAGE_FAILED', `Corrupt kv.snap for room ${roomId}: invalid magic.`);
    }

    const bodyLen = snapBytes.byteLength - SNAP_HASH_BYTES;
    const expectedDigest = snapBytes.subarray(bodyLen);
    const actualDigest = createHash('sha256').update(snapBytes.subarray(0, bodyLen)).digest();
    for (let i = 0; i < SNAP_HASH_BYTES; i++) {
      if (actualDigest[i] !== expectedDigest[i]) {
        throw new VfsError('VFS_STORAGE_FAILED', `Corrupt kv.snap for room ${roomId}: SHA-256 mismatch.`);
      }
    }

    const view = new DataView(snapBytes.buffer, snapBytes.byteOffset, snapBytes.byteLength);
    const version = view.getUint32(4, true);
    if (version !== SNAP_VERSION) {
      throw new VfsError('VFS_STORAGE_FAILED', `Unsupported kv.snap version ${version} for room ${roomId}.`);
    }
    const entryCount = view.getUint32(8, true);

    let offset = SNAP_HEADER_BYTES;
    for (let i = 0; i < entryCount; i++) {
      if (offset + 8 > bodyLen) {
        throw new VfsError('VFS_STORAGE_FAILED', `Corrupt kv.snap for room ${roomId}: truncated entry header.`);
      }
      const keyLen = view.getUint32(offset, true);
      const valLen = view.getUint32(offset + 4, true);
      offset += 8;

      if (keyLen === 0 || keyLen > VFS_MAX_KV_KEY_BYTES || offset + keyLen + valLen > bodyLen) {
        throw new VfsError('VFS_STORAGE_FAILED', `Corrupt kv.snap for room ${roomId}: invalid entry bounds.`);
      }
      const key = Buffer.from(snapBytes.subarray(offset, offset + keyLen)).toString('utf-8');
      validateVfsKvKey(roomId, key);
      offset += keyLen;

      const value = copyBytes(snapBytes.subarray(offset, offset + valLen));
      offset += valLen;
      kv.set(key, value);
    }

    if (offset !== bodyLen) {
      throw new VfsError('VFS_STORAGE_FAILED', `Corrupt kv.snap for room ${roomId}: trailing garbage bytes.`);
    }
  }

  private openAndReplayWal(roomId: string, kv: Map<string, Uint8Array<ArrayBuffer>>): { walFd: number; walOffset: number } {
    assertNoSymlinkComponents(this.baseDir, [roomId, 'kv.wal'], 'file');
    const walPath = path.join(this.baseDir, roomId, 'kv.wal');
    const walFd = fs.openSync(walPath, fs.constants.O_RDWR | fs.constants.O_CREAT | O_NOFOLLOW, 0o600);

    try {
      const fstat = fs.fstatSync(walFd);
      if (!fstat.isFile()) {
        throw new VfsError('VFS_STORAGE_FAILED', `kv.wal for room ${roomId} is not a regular file.`);
      }
      if (fstat.size === 0) {
        return { walFd, walOffset: 0 };
      }

      const raw = fs.readFileSync(walFd);
      const buf = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const totalLen = buf.byteLength;
      let offset = 0;

      const truncateTornTail = () => {
        fs.ftruncateSync(walFd, offset);
        fs.fsyncSync(walFd);
        return { walFd, walOffset: offset };
      };

      while (offset < totalLen) {
        const remaining = totalLen - offset;

        if (remaining < WAL_HEADER_BYTES) {
          // Fewer than WAL_HEADER_BYTES remain at EOF (partial header, zero-fill, or torn tail).
          return truncateTornTail();
        }

        if (!magicMatches(buf, offset, WAL_MAGIC)) {
          // Distinguish a zero-filled / garbage final tail from mid-WAL corruption.
          if (hasLaterValidWalRecord(roomId, buf, view, offset + 1)) {
            throw new VfsError('VFS_STORAGE_FAILED', `Corrupt kv.wal magic at offset ${offset} for room ${roomId}.`);
          }
          return truncateTornTail();
        }

        const expectedHeaderCrc = view.getUint32(offset + 4, true);
        const expectedBodyCrc = view.getUint32(offset + 8, true);
        const actualHeaderCrc = crc32(buf.subarray(offset + 12, offset + WAL_HEADER_BYTES));
        if (actualHeaderCrc !== expectedHeaderCrc) {
          if (hasLaterValidWalRecord(roomId, buf, view, offset + 1)) {
            throw new VfsError('VFS_STORAGE_FAILED', `Corrupt kv.wal header CRC at offset ${offset} for room ${roomId}.`);
          }
          return truncateTornTail();
        }

        const op = buf[offset + 12];
        const keyLen = view.getUint32(offset + 13, true);
        const valLen = view.getUint32(offset + 17, true);

        if (
          (op !== WAL_OP_PUT && op !== WAL_OP_DEL)
          || keyLen === 0
          || keyLen > VFS_MAX_KV_KEY_BYTES
          || (op === WAL_OP_DEL && valLen !== 0)
          || valLen > MAX_WAL_VALUE_BYTES
        ) {
          if (hasLaterValidWalRecord(roomId, buf, view, offset + 1)) {
            throw new VfsError('VFS_STORAGE_FAILED', `Corrupt kv.wal header fields at offset ${offset} for room ${roomId}.`);
          }
          return truncateTornTail();
        }

        const recordEnd = offset + WAL_HEADER_BYTES + keyLen + valLen;
        if (recordEnd > totalLen) {
          if (hasLaterValidWalRecord(roomId, buf, view, offset + 1)) {
            throw new VfsError('VFS_STORAGE_FAILED', `Corrupt kv.wal length at offset ${offset} for room ${roomId}.`);
          }
          // Incomplete final record payload at EOF: truncate back to last valid record boundary.
          return truncateTornTail();
        }

        const actualBodyCrc = crc32(buf.subarray(offset + WAL_HEADER_BYTES, recordEnd));
        if (actualBodyCrc !== expectedBodyCrc) {
          // If any valid frame follows, OR non-zero trailing bytes exist after this header-CRC-valid
          // frame's boundary, this is mid-WAL corruption -> fail closed! Otherwise it is a torn
          // final record at EOF (possibly followed by NTFS zero-fill) -> truncate to last valid offset.
          if (
            hasLaterValidWalRecord(roomId, buf, view, offset + 1)
            || (recordEnd < totalLen && !isAllZeroBytes(buf, recordEnd))
          ) {
            throw new VfsError('VFS_STORAGE_FAILED', `Corrupt kv.wal body CRC mismatch at offset ${offset} for room ${roomId}.`);
          }
          return truncateTornTail();
        }

        const keyStart = offset + WAL_HEADER_BYTES;
        const valStart = keyStart + keyLen;
        const key = Buffer.from(buf.subarray(keyStart, valStart)).toString('utf-8');
        validateVfsKvKey(roomId, key);

        if (op === WAL_OP_PUT) {
          kv.set(key, copyBytes(buf.subarray(valStart, recordEnd)));
        } else {
          kv.delete(key);
        }

        offset = recordEnd;
      }

      return { walFd, walOffset: offset };
    } catch (err) {
      try { fs.closeSync(walFd); } catch { /* Best effort. */ }
      throw err;
    }
  }

  private openEngine(roomId: string): BunFileRoomEngine {
    const existing = this.engines.get(roomId);
    if (existing && !existing.closed) {
      throw new VfsError('VFS_STORAGE_FENCED', ROOM_LOCKED_MESSAGE, { details: { roomId } });
    }

    const roomDir = ensureSafeDir(this.baseDir, [roomId]);
    const lock = acquireRoomLock(this.baseDir, roomId);
    let walFd: number | undefined;

    try {
      const kv = new Map<string, Uint8Array<ArrayBuffer>>();
      this.loadSnapshotInto(roomId, kv);
      const wal = this.openAndReplayWal(roomId, kv);
      walFd = wal.walFd;
      const cas = new FsColdCasStore(this.baseDir, roomId, this.ioHooks);

      let hotKvBytes = 0;
      const prefix = vfsRoomPrefix(roomId);
      for (const [key, value] of kv.entries()) {
        if (!key.startsWith(prefix)) {
          throw new VfsError('VFS_STORAGE_FAILED', `Key outside room namespace in ${roomId}.`);
        }
        hotKvBytes += kvEntryBytes(key, value);
      }

      const engine: BunFileRoomEngine = {
        roomId,
        roomDir,
        lock,
        walFd,
        walOffset: wal.walOffset,
        kv,
        hotKvBytes,
        cas,
        handles: new Set(),
        closed: false,
      };
      this.engines.set(roomId, engine);
      return engine;
    } catch (err) {
      if (walFd !== undefined) {
        try { fs.closeSync(walFd); } catch { /* Best effort. */ }
      }
      lock.release();
      throw err;
    }
  }

  private closeEngine(roomId: string): void {
    const engine = this.engines.get(roomId);
    if (!engine) return;
    this.engines.delete(roomId);
    if (!engine.closed) {
      engine.closed = true;
      try { fs.closeSync(engine.walFd); } catch { /* Best effort. */ }
      engine.lock.release();
    }
  }

  async openRoom(roomId: string, quotas?: Partial<VfsStoreQuotas>): Promise<BunFileVfsRoomStore> {
    if (this.closed) {
      throw new VfsError('VFS_STORAGE_CLOSED', 'BunFileVfsStore is closed.');
    }
    validateVfsRoomId(roomId);
    const resolved = resolveVfsStoreQuotas(this.kind, quotas);
    const engine = this.openEngine(roomId);

    const handle = new BunFileVfsRoomStore(
      roomId,
      engine,
      resolved,
      this.ioHooks,
      closedHandle => {
        engine.handles.delete(closedHandle);
        if (engine.handles.size === 0) {
          this.closeEngine(roomId);
        }
      },
      (faultRoomId, reason) => {
        // Propagate engine I/O fault to any sibling handle sharing this room engine and drop the engine.
        for (const h of engine.handles) {
          h.fence.trip(reason);
        }
        this.closeEngine(faultRoomId);
      },
    );
    engine.handles.add(handle);
    return handle;
  }

  async destroyRoom(roomId: string): Promise<void> {
    if (this.closed) {
      throw new VfsError('VFS_STORAGE_CLOSED', 'BunFileVfsStore is closed.');
    }
    validateVfsRoomId(roomId);
    const engine = this.engines.get(roomId);
    if (engine) {
      for (const h of [...engine.handles]) {
        h.forceClose();
      }
      engine.handles.clear();
      this.closeEngine(roomId);
    } else {
      assertRoomNotLockedByOther(this.baseDir, roomId);
    }
    destroyRoomDirectory(this.baseDir, roomId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [roomId, engine] of [...this.engines.entries()]) {
      for (const h of [...engine.handles]) {
        h.forceClose();
      }
      engine.handles.clear();
      this.closeEngine(roomId);
    }
  }
}
