import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  VfsError,
  vfsMetaKey,
  vfsNodeHeadKey,
  vfsOpKey,
  vfsOpPrefix,
  vfsRoomPrefix,
  type VfsErrorCode,
} from '../../src/browser/vfs/constants.ts';
import { computeCid, utf8Bytes } from '../../src/browser/vfs/envelope.ts';
import { compareUtf8Lex, kvEntryBytes } from '../../src/browser/vfs/store.ts';
import { runVfsStoreConformanceSuite } from '../../src/browser/vfs/store-conformance.ts';
import { defaultOptions } from '../daemon.ts';
import { testDirectory } from '../test-directory.ts';
import { BunFileVfsStore, VFS_ROOM_LOCK_FILE, type FsIoHooks } from './vfs-bunfile.ts';
import { WormDbFfiVfsStore } from './vfs-wormdb.ts';
import {
  openWormDbBinary,
  probeWormDbCapabilities,
  WORMDB_MAX_KEY_BYTES,
  type WormDbBinaryEntry,
  type WormDbBinaryHandle,
  type WormDbEntryMeta,
  type WormDbScanOptions,
} from './wormdb.ts';

const CANDIDATE_LIB = defaultOptions().libraryPath;
const WORMDB_CAPS = probeWormDbCapabilities(CANDIDATE_LIB);
const HAS_WORMDB_VFS_API = WORMDB_CAPS.supportsVfsBinaryApi;

const ROOM_A = 'aaaa1111-1111-4111-8111-111111111111';
const ROOM_B = 'bbbb2222-2222-4222-8222-222222222222';
const ROOM_C = 'cccc3333-3333-4333-8333-333333333333';
const ROOM_D = 'dddd4444-4444-4444-8444-444444444444';
const ROOM_E = 'eeee5555-5555-4555-8555-555555555555';
const NODE_1 = '12345678-1234-4123-8123-1234567890ab';
const DEV_1 = 'f'.repeat(64);
const MEMBER_1 = '99991111-1111-4111-8111-111111111111';

const dirsToClean: ReturnType<typeof testDirectory>[] = [];

function makeTempDir(label: string): string {
  const dir = testDirectory(label);
  dirsToClean.push(dir);
  return dir.path;
}

afterEach(() => {
  while (dirsToClean.length > 0) {
    dirsToClean.pop()!.cleanup();
  }
});

async function expectVfsError(promise: Promise<unknown>, code: VfsErrorCode) {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(VfsError);
  expect((caught as VfsError).code).toBe(code);
}

// ---------------------------------------------------------------------------
// 1. BunFileVfsStore — Full Conformance Suite (persistent: true)
// ---------------------------------------------------------------------------

runVfsStoreConformanceSuite(
  'BunFileVfsStore',
  () => {
    const dir = testDirectory('vfs-bunfile-conf');
    return {
      create: () => new BunFileVfsStore({ baseDir: dir.path }),
      reopen: () => new BunFileVfsStore({ baseDir: dir.path }),
      cleanup: () => dir.cleanup(),
    };
  },
  { persistent: true },
);

// ---------------------------------------------------------------------------
// 2. BunFileVfsStore — WAL Compaction, Corruption, CAS Tampering, Symlinks, Fence
// ---------------------------------------------------------------------------

describe('BunFileVfsStore — Durability, Compaction & Security', () => {
  test('WAL grows under heavy overwrites+deletes, checkpoint truncates kv.wal to 0, and reopen recovers', async () => {
    const baseDir = makeTempDir('bunfile-ckpt');
    const hotKey = vfsMetaKey(ROOM_A);
    const binKey = vfsNodeHeadKey(ROOM_A, NODE_1);
    const binVal = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xff, 0x00]);
    const postKey = vfsOpKey(ROOM_A, NODE_1, DEV_1, 1, 'deadbeef');
    const walPath = path.join(baseDir, ROOM_A, 'kv.wal');
    const snapPath = path.join(baseDir, ROOM_A, 'kv.snap');

    const store1 = new BunFileVfsStore({ baseDir });
    try {
      const room = await store1.openRoom(ROOM_A);
      await room.kvPut(binKey, binVal);

      const payload = new Uint8Array(512);
      for (let i = 0; i < 60; i++) {
        payload.fill(i & 0xff);
        await room.kvPut(hotKey, payload);
      }
      for (let i = 1; i <= 25; i++) {
        const k = vfsOpKey(ROOM_A, NODE_1, DEV_1, i + 100, 'abcdef01');
        await room.kvPut(k, new Uint8Array(128).fill(i));
        await room.kvDelete(k);
      }

      const walBefore = fs.statSync(walPath).size;
      expect(walBefore).toBeGreaterThan(30_000);

      await room.checkpoint();

      expect(fs.statSync(walPath).size).toBe(0);
      expect(fs.statSync(snapPath).size).toBeGreaterThan(0);

      if (process.platform !== 'win32') {
        expect(fs.statSync(walPath).mode & 0o777).toBe(0o600);
        expect(fs.statSync(snapPath).mode & 0o777).toBe(0o600);
      }

      // Post-checkpoint write appends cleanly on top of empty WAL.
      await room.kvPut(postKey, utf8Bytes('after-checkpoint'));
      expect(fs.statSync(walPath).size).toBeGreaterThan(0);
      await room.close();
    } finally {
      await store1.close();
    }

    // Reopen and verify snapshot + post-checkpoint WAL replay.
    const store2 = new BunFileVfsStore({ baseDir });
    try {
      const room = await store2.openRoom(ROOM_A);
      expect(await room.kvGet(hotKey)).toEqual(new Uint8Array(512).fill(59));
      expect(await room.kvGet(binKey)).toEqual(binVal);
      expect(await room.kvGet(postKey)).toEqual(utf8Bytes('after-checkpoint'));
      expect(await room.kvGet(vfsOpKey(ROOM_A, NODE_1, DEV_1, 101, 'abcdef01'))).toBeUndefined();
      expect((await room.stats()).hotKvKeys).toBe(3);
      await room.close();
    } finally {
      await store2.close();
    }
  });

  test('recovers cleanly from torn tail partial write (header prefix and truncated payload)', async () => {
    const baseDir = makeTempDir('bunfile-torn');
    const k1 = vfsMetaKey(ROOM_A);
    const k2 = vfsNodeHeadKey(ROOM_A, NODE_1);
    const walPath = path.join(baseDir, ROOM_A, 'kv.wal');

    const store1 = new BunFileVfsStore({ baseDir });
    try {
      const room = await store1.openRoom(ROOM_A);
      await room.kvPut(k1, utf8Bytes('committed-1'));
      await room.kvPut(k2, utf8Bytes('committed-2'));
      await room.close();
    } finally {
      await store1.close();
    }

    const fullWal = fs.readFileSync(walPath);

    // Case A: truncated header at EOF (partial "MV" magic prefix).
    fs.writeFileSync(walPath, Buffer.concat([fullWal, Buffer.from([0x4d, 0x56])]));
    const storeA = new BunFileVfsStore({ baseDir });
    try {
      const room = await storeA.openRoom(ROOM_A);
      expect(await room.kvGet(k1)).toEqual(utf8Bytes('committed-1'));
      expect(await room.kvGet(k2)).toEqual(utf8Bytes('committed-2'));
      expect(fs.statSync(walPath).size).toBe(fullWal.byteLength);
      await room.close();
    } finally {
      await storeA.close();
    }

    // Case B: valid third record cut off mid-payload at EOF -> discards only record 3.
    const storeB1 = new BunFileVfsStore({ baseDir });
    try {
      const room = await storeB1.openRoom(ROOM_A);
      await room.kvPut(vfsOpKey(ROOM_A, NODE_1, DEV_1, 7, '11223344'), utf8Bytes('record-three-payload'));
      await room.close();
    } finally {
      await storeB1.close();
    }
    const threeWal = fs.readFileSync(walPath);
    fs.writeFileSync(walPath, threeWal.subarray(0, threeWal.byteLength - 5));

    const storeB2 = new BunFileVfsStore({ baseDir });
    try {
      const room = await storeB2.openRoom(ROOM_A);
      expect(await room.kvGet(k1)).toEqual(utf8Bytes('committed-1'));
      expect(await room.kvGet(k2)).toEqual(utf8Bytes('committed-2'));
      expect(await room.kvGet(vfsOpKey(ROOM_A, NODE_1, DEV_1, 7, '11223344'))).toBeUndefined();
      expect(fs.statSync(walPath).size).toBe(fullWal.byteLength);
      await room.close();
    } finally {
      await storeB2.close();
    }

    // Case C: zero-filled final tail record (NTFS crash zero-fill) -> truncates back to last valid offset.
    fs.writeFileSync(walPath, Buffer.concat([fullWal, Buffer.alloc(64, 0x00)]));
    const storeC = new BunFileVfsStore({ baseDir });
    try {
      const room = await storeC.openRoom(ROOM_A);
      expect(await room.kvGet(k1)).toEqual(utf8Bytes('committed-1'));
      expect(await room.kvGet(k2)).toEqual(utf8Bytes('committed-2'));
      expect(fs.statSync(walPath).size).toBe(fullWal.byteLength);
      await room.close();
    } finally {
      await storeC.close();
    }

    // Case D: arbitrary garbage bytes at EOF -> treated as torn final record and truncated.
    fs.writeFileSync(walPath, Buffer.concat([fullWal, Buffer.from(new Uint8Array(48).fill(0xa5))]));
    const storeD = new BunFileVfsStore({ baseDir });
    try {
      const room = await storeD.openRoom(ROOM_A);
      expect(await room.kvGet(k1)).toEqual(utf8Bytes('committed-1'));
      expect(await room.kvGet(k2)).toEqual(utf8Bytes('committed-2'));
      expect(fs.statSync(walPath).size).toBe(fullWal.byteLength);
      await room.close();
    } finally {
      await storeD.close();
    }

    // Case E: corrupted final record at EOF (bit-flip in final record's body CRC) -> truncated cleanly!
    const corruptTail = Buffer.from(threeWal);
    corruptTail[corruptTail.byteLength - 2] ^= 0xff;
    fs.writeFileSync(walPath, corruptTail);
    const storeE = new BunFileVfsStore({ baseDir });
    try {
      const room = await storeE.openRoom(ROOM_A);
      expect(await room.kvGet(k1)).toEqual(utf8Bytes('committed-1'));
      expect(await room.kvGet(k2)).toEqual(utf8Bytes('committed-2'));
      expect(await room.kvGet(vfsOpKey(ROOM_A, NODE_1, DEV_1, 7, '11223344'))).toBeUndefined();
      expect(fs.statSync(walPath).size).toBe(fullWal.byteLength);
      await room.close();
    } finally {
      await storeE.close();
    }
  });

  test('fails closed on middle WAL corruption (payload bit-flip, header length corruption, magic corruption) and corrupt snapshot', async () => {
    const baseDir = makeTempDir('bunfile-corrupt');
    const k1 = vfsMetaKey(ROOM_A);
    const k2 = vfsNodeHeadKey(ROOM_A, NODE_1);
    const k3 = vfsOpKey(ROOM_A, NODE_1, DEV_1, 1, 'aabbccdd');
    const walPath = path.join(baseDir, ROOM_A, 'kv.wal');
    const snapPath = path.join(baseDir, ROOM_A, 'kv.snap');

    const store1 = new BunFileVfsStore({ baseDir });
    try {
      const room = await store1.openRoom(ROOM_A);
      await room.kvPut(k1, utf8Bytes('rec-1-value'));
      await room.kvPut(k2, utf8Bytes('rec-2-value'));
      await room.kvPut(k3, utf8Bytes('rec-3-value'));
      await room.close();
    } finally {
      await store1.close();
    }

    const originalWal = fs.readFileSync(walPath);

    // 1. Flip a byte inside record #1's payload -> body CRC mismatch -> VFS_STORAGE_FAILED.
    const bodyCorrupt = Buffer.from(originalWal);
    bodyCorrupt[25] ^= 0x01;
    fs.writeFileSync(walPath, bodyCorrupt);
    const s1 = new BunFileVfsStore({ baseDir });
    await expectVfsError(s1.openRoom(ROOM_A), 'VFS_STORAGE_FAILED');
    await s1.close();

    // 2. Corrupt record #1's valLen header field to huge value -> header CRC mismatch (NOT mistaken for torn tail!).
    const lenCorrupt = Buffer.from(originalWal);
    lenCorrupt[17] ^= 0xff;
    fs.writeFileSync(walPath, lenCorrupt);
    const s2 = new BunFileVfsStore({ baseDir });
    await expectVfsError(s2.openRoom(ROOM_A), 'VFS_STORAGE_FAILED');
    await s2.close();

    // 3. Corrupt record #1's magic -> VFS_STORAGE_FAILED.
    const magicCorrupt = Buffer.from(originalWal);
    magicCorrupt[0] ^= 0x01;
    fs.writeFileSync(walPath, magicCorrupt);
    const s3 = new BunFileVfsStore({ baseDir });
    await expectVfsError(s3.openRoom(ROOM_A), 'VFS_STORAGE_FAILED');
    await s3.close();

    // Restore valid WAL, checkpoint to kv.snap, then flip 1 bit in kv.snap -> VFS_STORAGE_FAILED.
    fs.writeFileSync(walPath, originalWal);
    const s4 = new BunFileVfsStore({ baseDir });
    try {
      const room = await s4.openRoom(ROOM_A);
      await room.checkpoint();
      await room.close();
    } finally {
      await s4.close();
    }

    const snapBuf = fs.readFileSync(snapPath);
    snapBuf[snapBuf.byteLength - 40] ^= 0x80;
    fs.writeFileSync(snapPath, snapBuf);

    const s5 = new BunFileVfsStore({ baseDir });
    await expectVfsError(s5.openRoom(ROOM_A), 'VFS_STORAGE_FAILED');
    await s5.close();
  });

  test('detects on-disk Cold CAS block tampering on getBlock and enforces 0o600 permissions', async () => {
    const baseDir = makeTempDir('bunfile-cas-tamper');
    const payload = utf8Bytes('encrypted-cas-chunk-data');
    const cid = await computeCid(payload);
    const blockPath = path.join(baseDir, ROOM_A, 'blocks', cid.slice(0, 2), cid);
    const metaPath = `${blockPath}.meta`;

    const store = new BunFileVfsStore({ baseDir });
    try {
      const room = await store.openRoom(ROOM_A);
      expect(await room.putBlock(cid, payload, { authorMemberId: MEMBER_1 })).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.statSync(blockPath).mode & 0o777).toBe(0o600);
        expect(fs.statSync(metaPath).mode & 0o777).toBe(0o600);
      }

      // Corrupt 1 byte on disk.
      const tampered = fs.readFileSync(blockPath);
      tampered[0] ^= 0x01;
      fs.writeFileSync(blockPath, tampered);

      await expectVfsError(room.getBlock(cid), 'VFS_INVALID_ENVELOPE');
      // Calling putBlock(cid, validBytes) directly heals the corrupted block atomically and returns true!
      expect(await room.putBlock(cid, payload, { authorMemberId: MEMBER_1 })).toBe(true);
      expect(await room.getBlock(cid)).toEqual(payload);
      expect((await room.stats()).coldCasBlocks).toBe(1);
      expect((await room.stats()).coldCasBytes).toBe(payload.byteLength);
      // Subsequent idempotent putBlock returns false.
      expect(await room.putBlock(cid, payload, { authorMemberId: MEMBER_1 })).toBe(false);
      await room.close();
    } finally {
      await store.close();
    }
  });

  test('recovers gracefully from a single corrupt .meta sidecar on open without bricking the room', async () => {
    const baseDir = makeTempDir('bunfile-corrupt-meta');
    const payload = utf8Bytes('valid-block-with-corrupt-sidecar');
    const cid = await computeCid(payload);
    const blockPath = path.join(baseDir, ROOM_A, 'blocks', cid.slice(0, 2), cid);
    const metaPath = `${blockPath}.meta`;

    const store1 = new BunFileVfsStore({ baseDir });
    try {
      const room = await store1.openRoom(ROOM_A);
      expect(await room.putBlock(cid, payload, { authorMemberId: MEMBER_1 })).toBe(true);
      await room.close();
    } finally {
      await store1.close();
    }

    // Corrupt the .meta sidecar on disk with malformed JSON.
    expect(fs.existsSync(metaPath)).toBe(true);
    fs.writeFileSync(metaPath, '{corrupted-sidecar-json');

    // Reopen must NOT fail: corrupt sidecar is removed and block size is recomputed from disk.
    const store2 = new BunFileVfsStore({ baseDir });
    try {
      const room = await store2.openRoom(ROOM_A);
      expect(fs.existsSync(metaPath)).toBe(false);
      expect(await room.getBlock(cid)).toEqual(payload);
      const st = await room.stats();
      expect(st.coldCasBlocks).toBe(1);
      expect(st.coldCasBytes).toBe(payload.byteLength);
      await room.close();
    } finally {
      await store2.close();
    }
  });

  test('inter-process O_EXCL room directory lock blocks concurrent/double open and reclaims dead-PID stale lock', async () => {
    const baseDir = makeTempDir('bunfile-lock');
    const lockPath = path.join(baseDir, ROOM_A, VFS_ROOM_LOCK_FILE);

    const store1 = new BunFileVfsStore({ baseDir });
    const store2 = new BunFileVfsStore({ baseDir });
    try {
      const room1 = await store1.openRoom(ROOM_A);
      expect(fs.existsSync(lockPath)).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.statSync(lockPath).mode & 0o777).toBe(0o600);
      }

      // Second BunFileVfsStore instance cannot open same roomDir while first is open -> VFS_STORAGE_FENCED.
      await expectVfsError(store2.openRoom(ROOM_A), 'VFS_STORAGE_FENCED');
      // Same store instance double-opening without closing also fails closed -> VFS_STORAGE_FENCED.
      await expectVfsError(store1.openRoom(ROOM_A), 'VFS_STORAGE_FENCED');
      // Another store cannot destroy a room held by an active lock -> VFS_STORAGE_FENCED.
      await expectVfsError(store2.destroyRoom(ROOM_A), 'VFS_STORAGE_FENCED');

      await room1.kvPut(vfsMetaKey(ROOM_A), utf8Bytes('held-by-store1'));
      await room1.close();
      expect(fs.existsSync(lockPath)).toBe(false);

      // Once closed, store2 acquires the lock cleanly and reads store1's data.
      const room2 = await store2.openRoom(ROOM_A);
      expect(await room2.kvGet(vfsMetaKey(ROOM_A))).toEqual(utf8Bytes('held-by-store1'));
      await room2.close();
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      await store1.close();
      await store2.close();
    }

    // Spawn a tiny short-lived child that exits immediately to obtain a guaranteed-dead PID.
    const exited = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf-8' });
    const deadPid = exited.pid;
    expect(typeof deadPid).toBe('number');
    expect(deadPid).toBeGreaterThan(0);

    // Plant a stale lockfile owned by that dead PID -> must be automatically reclaimed on openRoom!
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: deadPid, acquiredAt: Date.now() - 60_000, token: 'dead-owner-token' }),
      { mode: 0o600 },
    );

    const store3 = new BunFileVfsStore({ baseDir });
    try {
      const room3 = await store3.openRoom(ROOM_A);
      const liveLock = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as { pid: number; token: string };
      expect(liveLock.pid).toBe(process.pid);
      expect(liveLock.token).not.toBe('dead-owner-token');

      // Mutate token externally to prove close() only removes lockfile when token matches.
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), token: 'foreign-token' }));
      await room3.close();
      expect(fs.existsSync(lockPath)).toBe(true);
      fs.unlinkSync(lockPath);
    } finally {
      await store3.close();
    }
  });

  test.skipIf(process.platform === 'win32')('rejects planted symlinks in room dir, WAL, CAS shard, and CAS block', async () => {
    const baseDir = makeTempDir('bunfile-symlink');
    const decoyDir = makeTempDir('bunfile-decoy');
    const decoyFile = path.join(decoyDir, 'secret.txt');
    fs.writeFileSync(decoyFile, 'do-not-touch');

    // 1. Symlink at room directory.
    fs.symlinkSync(decoyDir, path.join(baseDir, ROOM_A));
    const store1 = new BunFileVfsStore({ baseDir });
    await expectVfsError(store1.openRoom(ROOM_A), 'VFS_STORAGE_FAILED');
    await store1.close();

    // 2. Symlink at kv.wal.
    const roomBDir = path.join(baseDir, ROOM_B);
    fs.mkdirSync(roomBDir, { recursive: true, mode: 0o700 });
    fs.symlinkSync(decoyFile, path.join(roomBDir, 'kv.wal'));
    const store2 = new BunFileVfsStore({ baseDir });
    await expectVfsError(store2.openRoom(ROOM_B), 'VFS_STORAGE_FAILED');
    await store2.close();

    // 3. Symlink planted at CAS block file.
    const blk = utf8Bytes('symlink-block-check');
    const cid = await computeCid(blk);
    const store3 = new BunFileVfsStore({ baseDir });
    try {
      const room = await store3.openRoom(ROOM_C);
      const shardDir = path.join(baseDir, ROOM_C, 'blocks', cid.slice(0, 2));
      fs.mkdirSync(shardDir, { recursive: true, mode: 0o700 });
      fs.symlinkSync(decoyFile, path.join(shardDir, cid));

      await expectVfsError(room.getBlock(cid), 'VFS_STORAGE_FAILED');
      await expectVfsError(room.hasBlock(cid), 'VFS_STORAGE_FAILED');
      await expectVfsError(room.putBlock(cid, blk), 'VFS_STORAGE_FAILED');
      await room.close();
    } finally {
      await store3.close();
    }
  });

  test('fail-closed VfsRoomFence latches on WAL sync, snapshot sync, dir sync, and WAL truncate errors without losing data', async () => {
    const baseDir = makeTempDir('bunfile-fence');
    const k1 = vfsMetaKey(ROOM_A);
    const k2 = vfsNodeHeadKey(ROOM_A, NODE_1);
    const walPath = path.join(baseDir, ROOM_A, 'kv.wal');
    const snapPath = path.join(baseDir, ROOM_A, 'kv.snap');

    // Case 1: WAL fsync failure trips fence and blocks all subsequent room operations.
    let failWalSync = false;
    const hooks1: FsIoHooks = {
      beforeWalSync: () => {
        if (failWalSync) throw new Error('injected EIO on WAL fsync');
      },
    };
    const s1 = new BunFileVfsStore({ baseDir, ioHooks: hooks1 });
    try {
      const room = await s1.openRoom(ROOM_A);
      await room.kvPut(k1, utf8Bytes('durable-v1'));
      failWalSync = true;
      await expectVfsError(room.kvPut(k2, utf8Bytes('uncertain-v2')), 'VFS_STORAGE_FAILED');
      expect(room.isFenced).toBe(true);
      expect((await room.stats()).fenced).toBe(true);
      expect((await room.stats()).fencedReason).toContain('WAL append/sync failed');

      await expectVfsError(room.kvGet(k1), 'VFS_STORAGE_FENCED');
      await expectVfsError(room.kvPut(k1, utf8Bytes('blocked')), 'VFS_STORAGE_FENCED');
      await expectVfsError(room.checkpoint(), 'VFS_STORAGE_FENCED');
      await room.close();
    } finally {
      await s1.close();
    }

    // Case 2: Snapshot sync failure trips fence AND preserves intact kv.wal without truncation.
    const hooks2: FsIoHooks = {
      beforeSnapSync: () => {
        throw new Error('injected EIO on snapshot fsync');
      },
    };
    const s2 = new BunFileVfsStore({ baseDir, ioHooks: hooks2 });
    try {
      const room = await s2.openRoom(ROOM_A);
      expect(await room.kvGet(k1)).toEqual(utf8Bytes('durable-v1'));
      const walBefore = fs.statSync(walPath).size;
      expect(walBefore).toBeGreaterThan(0);

      await expectVfsError(room.checkpoint(), 'VFS_STORAGE_FAILED');
      expect(room.isFenced).toBe(true);
      expect(fs.statSync(walPath).size).toBe(walBefore);
      expect(fs.existsSync(snapPath)).toBe(false);
      await expectVfsError(room.kvPut(k1, utf8Bytes('blocked')), 'VFS_STORAGE_FENCED');
      await room.close();
    } finally {
      await s2.close();
    }

    // Case 3: Dir sync failure trips fence AND preserves intact kv.wal without truncation.
    const hooks3: FsIoHooks = {
      beforeSnapDirSync: () => {
        throw new Error('injected EIO on dir fsync');
      },
    };
    const s3 = new BunFileVfsStore({ baseDir, ioHooks: hooks3 });
    try {
      const room = await s3.openRoom(ROOM_A);
      const walBefore = fs.statSync(walPath).size;
      await expectVfsError(room.checkpoint(), 'VFS_STORAGE_FAILED');
      expect(room.isFenced).toBe(true);
      expect(fs.statSync(walPath).size).toBe(walBefore);
      await room.close();
    } finally {
      await s3.close();
    }

    // Case 4: WAL truncate failure trips fence while new kv.snap remains cleanly recoverable.
    const hooks4: FsIoHooks = {
      beforeWalTruncate: () => {
        throw new Error('injected EIO on WAL truncate');
      },
    };
    const s4 = new BunFileVfsStore({ baseDir, ioHooks: hooks4 });
    try {
      const room = await s4.openRoom(ROOM_A);
      await expectVfsError(room.checkpoint(), 'VFS_STORAGE_FAILED');
      expect(room.isFenced).toBe(true);
      expect(fs.existsSync(snapPath)).toBe(true);
      await room.close();
    } finally {
      await s4.close();
    }

    // Final clean reopen recovers all data and compacts cleanly.
    const s5 = new BunFileVfsStore({ baseDir });
    try {
      const room = await s5.openRoom(ROOM_A);
      expect(await room.kvGet(k1)).toEqual(utf8Bytes('durable-v1'));
      await room.checkpoint();
      expect(fs.statSync(walPath).size).toBe(0);
      await room.close();
    } finally {
      await s5.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. WormDbFfiVfsStore — Synthetic Pool Eviction, Legacy Feature Detection & Fence Tests
// ---------------------------------------------------------------------------

describe('WormDbFfiVfsStore — LRU Pool, Feature Detection & Fault Fencing (Synthetic)', () => {
  function createMockHandleFactory(opts?: {
    supportsCheckpointSync?: boolean;
    failSetOnKey?: string;
    failCheckpoint?: boolean;
    reverseScanOrder?: boolean;
  }) {
    const backing = new Map<string, Map<string, Uint8Array>>();
    let openCount = 0;
    let closeCount = 0;
    let checkpointCalls = 0;

    const factory = ({ dataDir, libraryPath }: { dataDir: string; libraryPath: string }): WormDbBinaryHandle => {
      openCount++;
      let kv = backing.get(dataDir);
      if (!kv) {
        kv = new Map();
        backing.set(dataDir, kv);
      }
      let closed = false;
      let fenced: string | undefined;
      const supports = opts?.supportsCheckpointSync ?? true;

      return {
        dataDir,
        libraryPath,
        get supportsCheckpointSync() { return supports; },
        get isClosed() { return closed; },
        get isFenced() { return fenced !== undefined; },
        get fenceReason() { return fenced; },
        get(key: string): Uint8Array | null {
          if (closed) throw new Error('closed');
          const v = kv!.get(key);
          return v ? new Uint8Array(v) : null;
        },
        getMeta(key: string): WormDbEntryMeta | null {
          if (closed) throw new Error('closed');
          const v = kv!.get(key);
          if (!v) return null;
          return {
            timestampMs: 1,
            isWorm: false,
            valueLen: v.byteLength,
            valueSha256: new Uint8Array(createHash('sha256').update(v).digest()),
          };
        },
        set(key: string, value: Uint8Array): void {
          if (closed || fenced) throw new Error('closed or fenced');
          if (opts?.failSetOnKey && key === opts.failSetOnKey) {
            fenced = 'injected set failure';
            throw new Error(fenced);
          }
          kv!.set(key, new Uint8Array(value));
        },
        delete(key: string): boolean {
          if (closed || fenced) throw new Error('closed or fenced');
          return kv!.delete(key);
        },
        scanPrefix(prefix: string, scanOpts?: WormDbScanOptions): WormDbBinaryEntry[] {
          if (closed) throw new Error('closed');
          const keys = [...kv!.keys()]
            .filter(k => k.startsWith(prefix))
            .filter(k => scanOpts?.afterKey === undefined || compareUtf8Lex(k, scanOpts.afterKey) > 0)
            .filter(k => scanOpts?.beforeKey === undefined || compareUtf8Lex(k, scanOpts.beforeKey) < 0)
            .sort(compareUtf8Lex);
          const sliced = scanOpts?.limit && scanOpts.limit > 0
            ? (scanOpts.direction === 'last' ? keys.slice(-scanOpts.limit) : keys.slice(0, scanOpts.limit))
            : keys;
          const entries = sliced.map(k => ({ key: k, value: new Uint8Array(kv!.get(k)!) }));
          if (opts?.reverseScanOrder) {
            entries.reverse();
          }
          return entries;
        },
        checkpointSync(): void {
          if (closed || fenced) throw new Error('closed or fenced');
          if (!supports) throw new Error('not supported');
          if (opts?.failCheckpoint) {
            fenced = 'injected checkpoint failure';
            throw new Error(fenced);
          }
          checkpointCalls++;
        },
        close(): void {
          if (closed) return;
          closed = true;
          closeCount++;
        },
      };
    };

    return {
      factory,
      metrics: () => ({ openCount, closeCount, checkpointCalls }),
    };
  }

  test('evicts idle LRU handles when exceeding maxOpenRooms and reopens transparently', async () => {
    const baseDir = makeTempDir('wormdb-lru-mock');
    const mock = createMockHandleFactory();
    const store = new WormDbFfiVfsStore({
      baseDir,
      libraryPath: '/virtual/libwormdb_ffi.so',
      maxOpenRooms: 2,
      openBinaryHandle: mock.factory,
    });

    try {
      const rA = await store.openRoom(ROOM_A);
      const rB = await store.openRoom(ROOM_B);
      expect(store.openHandleCount).toBe(2);

      await rA.kvPut(vfsMetaKey(ROOM_A), utf8Bytes('room-a'));
      await rB.kvPut(vfsMetaKey(ROOM_B), utf8Bytes('room-b'));

      // Opening Room C & D evicts idle LRU handles while keeping pool bounded at 2.
      const rC = await store.openRoom(ROOM_C);
      await rC.kvPut(vfsMetaKey(ROOM_C), utf8Bytes('room-c'));
      expect(store.openHandleCount).toBeLessThanOrEqual(2);

      const rD = await store.openRoom(ROOM_D);
      await rD.kvPut(vfsMetaKey(ROOM_D), utf8Bytes('room-d'));
      expect(store.openHandleCount).toBeLessThanOrEqual(2);

      // Previously evicted Room A reopens transparently on read/write.
      expect(await rA.kvGet(vfsMetaKey(ROOM_A))).toEqual(utf8Bytes('room-a'));
      expect(await rB.kvGet(vfsMetaKey(ROOM_B))).toEqual(utf8Bytes('room-b'));
      expect(await rC.kvGet(vfsMetaKey(ROOM_C))).toEqual(utf8Bytes('room-c'));
      expect(await rD.kvGet(vfsMetaKey(ROOM_D))).toEqual(utf8Bytes('room-d'));
      expect(store.openHandleCount).toBeLessThanOrEqual(2);
      expect(mock.metrics().closeCount).toBeGreaterThanOrEqual(2);

      await rA.close();
      await rB.close();
      await rC.close();
      await rD.close();
      expect(store.openHandleCount).toBe(0);
    } finally {
      await store.close();
    }
  });

  test('gracefully no-ops checkpoint() when library lacks wormdb_checkpoint_sync, and fences on checkpoint error', async () => {
    const baseDir = makeTempDir('wormdb-ckpt-mock');

    // Older library without wormdb_checkpoint_sync.
    const legacy = createMockHandleFactory({ supportsCheckpointSync: false });
    const legacyStore = new WormDbFfiVfsStore({
      baseDir,
      libraryPath: '/virtual/legacy.so',
      openBinaryHandle: legacy.factory,
    });
    try {
      const room = await legacyStore.openRoom(ROOM_A);
      expect(room.supportsCheckpointSync).toBe(false);
      await room.kvPut(vfsMetaKey(ROOM_A), utf8Bytes('legacy-ok'));
      await room.checkpoint();
      expect(room.isFenced).toBe(false);
      expect(legacy.metrics().checkpointCalls).toBe(0);
      await room.close();
    } finally {
      await legacyStore.close();
    }

    // Current library where wormdb_checkpoint_sync returns error -> trips VfsRoomFence.
    const failing = createMockHandleFactory({ supportsCheckpointSync: true, failCheckpoint: true });
    const failStore = new WormDbFfiVfsStore({
      baseDir,
      libraryPath: '/virtual/current.so',
      openBinaryHandle: failing.factory,
    });
    try {
      const room = await failStore.openRoom(ROOM_B);
      expect(room.supportsCheckpointSync).toBe(true);
      await room.kvPut(vfsMetaKey(ROOM_B), utf8Bytes('before-ckpt-fail'));
      await expectVfsError(room.checkpoint(), 'VFS_STORAGE_FAILED');
      expect(room.isFenced).toBe(true);
      expect((await room.stats()).fenced).toBe(true);
      await expectVfsError(room.kvGet(vfsMetaKey(ROOM_B)), 'VFS_STORAGE_FENCED');
      await expectVfsError(room.kvPut(vfsMetaKey(ROOM_B), utf8Bytes('blocked')), 'VFS_STORAGE_FENCED');
      expect(failStore.openHandleCount).toBe(0);
      await room.close();
    } finally {
      await failStore.close();
    }
  });

  test('probeWormDbCapabilities never throws on missing library, and WormDbFfiVfsStore enforces lock & compareUtf8Lex scan sorting', async () => {
    const missing = probeWormDbCapabilities('/nonexistent/path/libwormdb_ffi.so');
    expect(missing.available).toBe(false);
    expect(missing.supportsVfsBinaryApi).toBe(false);
    expect(missing.supportsCheckpointSync).toBe(false);

    const baseDir = makeTempDir('wormdb-sort-lock-mock');
    const mock = createMockHandleFactory({ reverseScanOrder: true });
    const store1 = new WormDbFfiVfsStore({
      baseDir,
      libraryPath: '/virtual/libwormdb_ffi.so',
      openBinaryHandle: mock.factory,
    });
    const store2 = new WormDbFfiVfsStore({
      baseDir,
      libraryPath: '/virtual/libwormdb_ffi.so',
      openBinaryHandle: mock.factory,
    });
    try {
      const room1 = await store1.openRoom(ROOM_A);
      // Second WormDbFfiVfsStore cannot concurrently open the same roomDir -> VFS_STORAGE_FENCED.
      await expectVfsError(store2.openRoom(ROOM_A), 'VFS_STORAGE_FENCED');

      const prefix = vfsOpPrefix(ROOM_A, NODE_1, DEV_1);
      const k1 = vfsOpKey(ROOM_A, NODE_1, DEV_1, 1, '11111111');
      const k2 = vfsOpKey(ROOM_A, NODE_1, DEV_1, 2, '22222222');
      const k3 = vfsOpKey(ROOM_A, NODE_1, DEV_1, 3, '33333333');
      await room1.kvPut(k3, utf8Bytes('3'));
      await room1.kvPut(k1, utf8Bytes('1'));
      await room1.kvPut(k2, utf8Bytes('2'));

      // Even though mock handle returned reversed order, adapter explicitly sorts via compareUtf8Lex!
      const scanned = await room1.kvScanPrefix(prefix);
      expect(scanned.map(e => e.key)).toEqual([k1, k2, k3]);
      const last2 = await room1.kvScanPrefix(prefix, { limit: 2, direction: 'last' });
      expect(last2.map(e => e.key)).toEqual([k2, k3]);

      await room1.close();
      // Once closed, store2 acquires the room lock cleanly.
      const room2 = await store2.openRoom(ROOM_A);
      expect((await room2.kvScanPrefix(prefix)).map(e => e.key)).toEqual([k1, k2, k3]);
      await room2.close();
    } finally {
      await store1.close();
      await store2.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Native WormDB FFI Integration Suite (gated on probed v0.3 VFS symbols!)
// ---------------------------------------------------------------------------

if (HAS_WORMDB_VFS_API) {
  runVfsStoreConformanceSuite(
    'WormDbFfiVfsStore (native)',
    () => {
      const dir = testDirectory('vfs-wormdb-conf');
      return {
        create: () => new WormDbFfiVfsStore({ baseDir: dir.path, libraryPath: CANDIDATE_LIB }),
        reopen: () => new WormDbFfiVfsStore({ baseDir: dir.path, libraryPath: CANDIDATE_LIB }),
        cleanup: () => dir.cleanup(),
      };
    },
    { persistent: true },
  );
}

describe.skipIf(!HAS_WORMDB_VFS_API)('WormDbFfiVfsStore & openWormDbBinary — Real Native FFI', () => {
  test('openWormDbBinary handles binary/NUL/empty values, subarray byteOffset, getMeta, scanPrefix first/last, key >512B, and optional checkpointSync', () => {
    const dataDir = makeTempDir('wormdb-bin-direct');
    const handle = openWormDbBinary({ dataDir, libraryPath: CANDIDATE_LIB });
    try {
      expect(handle.supportsCheckpointSync).toBe(WORMDB_CAPS.supportsCheckpointSync);
      expect(handle.isFenced).toBe(false);
      expect(handle.get('missing')).toBeNull();
      expect(handle.getMeta('missing')).toBeNull();
      expect(handle.delete('missing')).toBe(false);

      // Subarray view with non-zero byteOffset must persist the exact slice.
      const backing = new Uint8Array([9, 8, 7, 0x00, 0x11, 0x22, 0x00, 0xff, 6, 5]);
      const slice = backing.subarray(3, 8);
      handle.set('p:02', slice);
      handle.set('p:01', new Uint8Array(0));
      handle.set('p:03', utf8Bytes('three'));
      handle.set('p:04', utf8Bytes('four'));

      const empty = handle.get('p:01');
      expect(empty).toBeInstanceOf(Uint8Array);
      expect(empty!.byteLength).toBe(0);
      expect(handle.get('p:02')).toEqual(new Uint8Array([0x00, 0x11, 0x22, 0x00, 0xff]));

      const meta = handle.getMeta('p:03');
      expect(meta).not.toBeNull();
      expect(meta!.isWorm).toBe(false);
      expect(meta!.valueLen).toBe(5);
      expect(meta!.timestampMs).toBeGreaterThan(0);
      expect(Buffer.from(meta!.valueSha256).toString('hex')).toBe(
        createHash('sha256').update('three').digest('hex'),
      );

      // Ascending-first limit + exclusive afterKey pagination + direction: 'last' + beforeKey.
      const first2 = handle.scanPrefix('p:', { limit: 2 });
      expect(first2.map(e => e.key)).toEqual(['p:01', 'p:02']);
      const next2 = handle.scanPrefix('p:', { limit: 2, afterKey: 'p:02' });
      expect(next2.map(e => e.key)).toEqual(['p:03', 'p:04']);
      const latest1 = handle.scanPrefix('p:', { limit: 1, direction: 'last' });
      expect(latest1.map(e => e.key)).toEqual(['p:04']);
      const prev2 = handle.scanPrefix('p:', { limit: 2, direction: 'last', beforeKey: 'p:04' });
      expect(prev2.map(e => e.key)).toEqual(['p:02', 'p:03']);

      // Key > 512 UTF-8 bytes rejected.
      expect(() => handle.set('k'.repeat(WORMDB_MAX_KEY_BYTES + 1), new Uint8Array(1))).toThrow(RangeError);

      expect(handle.delete('p:04')).toBe(true);
      expect(handle.delete('p:04')).toBe(false);
      expect(handle.get('p:04')).toBeNull();

      // Real wormdb_checkpoint_sync shrinks wormdb.wal to 0 bytes (gated on probed symbol!).
      const walPath = path.join(dataDir, 'wormdb.wal');
      const snapPath = path.join(dataDir, 'wormdb.snapshot');
      expect(fs.statSync(walPath).size).toBeGreaterThan(0);
      if (WORMDB_CAPS.supportsCheckpointSync) {
        handle.checkpointSync();
        expect(fs.statSync(walPath).size).toBe(0);
        expect(fs.statSync(snapPath).size).toBeGreaterThan(0);
      } else {
        expect(() => handle.checkpointSync()).toThrow(/wormdb_checkpoint_sync/);
      }
    } finally {
      handle.close();
    }

    // Reopen verifies persisted/compacted state integrity.
    const reopened = openWormDbBinary({ dataDir, libraryPath: CANDIDATE_LIB });
    try {
      expect(reopened.get('p:01')).toEqual(new Uint8Array(0));
      expect(reopened.get('p:02')).toEqual(new Uint8Array([0x00, 0x11, 0x22, 0x00, 0xff]));
      expect(reopened.get('p:03')).toEqual(utf8Bytes('three'));
      expect(reopened.get('p:04')).toBeNull();
    } finally {
      reopened.close();
    }
  });

  test('WormDbFfiVfsStore compacts real wormdb.wal via wormdb_checkpoint_sync when supported and preserves KV + Cold CAS across reopen', async () => {
    const baseDir = makeTempDir('wormdb-vfs-ckpt');
    const hotKey = vfsMetaKey(ROOM_A);
    const keepKey = vfsNodeHeadKey(ROOM_A, NODE_1);
    const postKey = vfsOpKey(ROOM_A, NODE_1, DEV_1, 1, '11223344');
    const walPath = path.join(baseDir, ROOM_A, 'wormdb', 'wormdb.wal');
    const snapPath = path.join(baseDir, ROOM_A, 'wormdb', 'wormdb.snapshot');
    const casPayload = new Uint8Array(2048).fill(0x42);
    const casCid = await computeCid(casPayload);

    const store1 = new WormDbFfiVfsStore({ baseDir, libraryPath: CANDIDATE_LIB });
    try {
      const room = await store1.openRoom(ROOM_A);
      expect(room.supportsCheckpointSync).toBe(WORMDB_CAPS.supportsCheckpointSync);

      await room.kvPut(keepKey, new Uint8Array([0x00, 0xfe, 0xff, 0x00]));
      expect(await room.putBlock(casCid, casPayload, { authorMemberId: MEMBER_1 })).toBe(true);

      const buf = new Uint8Array(512);
      for (let i = 0; i < 80; i++) {
        buf.fill(i & 0xff);
        await room.kvPut(hotKey, buf);
      }
      for (let i = 1; i <= 30; i++) {
        const k = vfsOpKey(ROOM_A, NODE_1, DEV_1, i + 200, 'cafebabe');
        await room.kvPut(k, new Uint8Array(128).fill(i));
        await room.kvDelete(k);
      }

      const walBefore = fs.statSync(walPath).size;
      expect(walBefore).toBeGreaterThan(40_000);

      await room.checkpoint();

      if (WORMDB_CAPS.supportsCheckpointSync) {
        expect(fs.statSync(walPath).size).toBe(0);
        expect(fs.statSync(snapPath).size).toBeGreaterThan(0);
      }

      // Post-checkpoint write appends cleanly.
      await room.kvPut(postKey, utf8Bytes('post-ckpt-native'));
      expect(fs.statSync(walPath).size).toBeGreaterThan(0);
      await room.close();
    } finally {
      await store1.close();
    }

    const store2 = new WormDbFfiVfsStore({ baseDir, libraryPath: CANDIDATE_LIB });
    try {
      const room = await store2.openRoom(ROOM_A);
      expect(await room.kvGet(hotKey)).toEqual(new Uint8Array(512).fill(79));
      expect(await room.kvGet(keepKey)).toEqual(new Uint8Array([0x00, 0xfe, 0xff, 0x00]));
      expect(await room.kvGet(postKey)).toEqual(utf8Bytes('post-ckpt-native'));
      expect(await room.kvGet(vfsOpKey(ROOM_A, NODE_1, DEV_1, 201, 'cafebabe'))).toBeUndefined();
      expect(await room.getBlock(casCid)).toEqual(casPayload);

      const st = await room.stats();
      expect(st.hotKvKeys).toBe(3);
      expect(st.hotKvBytes).toBe(
        kvEntryBytes(hotKey, new Uint8Array(512))
        + kvEntryBytes(keepKey, new Uint8Array(4))
        + kvEntryBytes(postKey, utf8Bytes('post-ckpt-native')),
      );
      expect(st.coldCasBlocks).toBe(1);
      expect(st.coldCasBytes).toBe(2048);

      // Prefix scan still works cleanly on reopened compacted snapshot + WAL.
      const all = await room.kvScanPrefix(vfsRoomPrefix(ROOM_A));
      expect(all.length).toBe(3);
      await room.close();
    } finally {
      await store2.close();
    }
  });

  test('WormDbFfiVfsStore enforces bounded LRU pool with real native handles across 5 rooms', async () => {
    const baseDir = makeTempDir('wormdb-vfs-lru');
    const store = new WormDbFfiVfsStore({
      baseDir,
      libraryPath: CANDIDATE_LIB,
      maxOpenRooms: 2,
    });
    const roomIds = [ROOM_A, ROOM_B, ROOM_C, ROOM_D, ROOM_E];

    try {
      const handles = [];
      for (let i = 0; i < roomIds.length; i++) {
        const room = await store.openRoom(roomIds[i]);
        await room.kvPut(vfsMetaKey(roomIds[i]), utf8Bytes(`native-room-${i}`));
        expect(store.openHandleCount).toBeLessThanOrEqual(2);
        handles.push(room);
      }

      // Every room reads back and checkpoints cleanly despite LRU evictions.
      for (let i = 0; i < roomIds.length; i++) {
        expect(await handles[i].kvGet(vfsMetaKey(roomIds[i]))).toEqual(utf8Bytes(`native-room-${i}`));
        await handles[i].checkpoint();
        expect(store.openHandleCount).toBeLessThanOrEqual(2);
      }

      for (const h of handles) await h.close();
      expect(store.openHandleCount).toBe(0);
    } finally {
      await store.close();
    }
  });

  test.skipIf(process.platform === 'win32')('WormDbFfiVfsStore rejects symlinked wormdb.wal and tampered Cold CAS blocks', async () => {
    const baseDir = makeTempDir('wormdb-vfs-sec');
    const decoyDir = makeTempDir('wormdb-vfs-decoy');
    const decoyFile = path.join(decoyDir, 'outside.txt');
    fs.writeFileSync(decoyFile, 'outside');

    // Plant symlink at <room>/wormdb/wormdb.wal.
    const wdbDir = path.join(baseDir, ROOM_A, 'wormdb');
    fs.mkdirSync(wdbDir, { recursive: true, mode: 0o700 });
    fs.symlinkSync(decoyFile, path.join(wdbDir, 'wormdb.wal'));

    const store = new WormDbFfiVfsStore({ baseDir, libraryPath: CANDIDATE_LIB });
    try {
      await expectVfsError(store.openRoom(ROOM_A), 'VFS_STORAGE_FAILED');

      // On-disk CAS block tampering detected with VFS_INVALID_ENVELOPE.
      const roomB = await store.openRoom(ROOM_B);
      const blk = utf8Bytes('wormdb-native-cas-block');
      const cid = await computeCid(blk);
      expect(await roomB.putBlock(cid, blk)).toBe(true);
      const blockPath = path.join(baseDir, ROOM_B, 'blocks', cid.slice(0, 2), cid);
      const raw = fs.readFileSync(blockPath);
      raw[0] ^= 0xff;
      fs.writeFileSync(blockPath, raw);
      await expectVfsError(roomB.getBlock(cid), 'VFS_INVALID_ENVELOPE');
      await roomB.close();
    } finally {
      await store.close();
    }
  });
});
