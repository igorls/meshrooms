import { describe, expect, test } from 'bun:test';
import {
  VFS_COLD_CAS_MAX_BYTES_BROWSER,
  VFS_COLD_CAS_MAX_BYTES_NATIVE,
  VFS_HOT_KV_MAX_BYTES_BROWSER,
  VFS_HOT_KV_MAX_BYTES_NATIVE,
  VFS_MAX_KV_KEY_BYTES,
  VfsError,
  vfsMetaKey,
  vfsNodeHeadKey,
  vfsObjKey,
  vfsRoomPrefix,
  type VfsErrorCode,
} from './constants';
import { computeCid, utf8Bytes } from './envelope';
import {
  MemoryVfsStore,
  VFS_BLOCK_MAX_BYTES,
  VfsRoomFence,
  assertBlockSizeWithinCap,
  compareUtf8Lex,
  kvEntryBytes,
  resolveVfsStoreQuotas,
  validateBlockCid,
  validateScanPrefixOptions,
  validateVfsKvKey,
  validateVfsKvPrefix,
  validateVfsRoomId,
  verifyBlockCid,
  writeBeforePublish,
} from './store';
import { runVfsStoreConformanceSuite } from './store-conformance';

const ROOM_1 = '11111111-1111-4111-8111-111111111111';
const NODE_1 = '33333333-3333-4333-8333-333333333333';

async function expectVfsError(fn: () => unknown | Promise<unknown>, code: VfsErrorCode) {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(VfsError);
  expect((caught as VfsError).code).toBe(code);
}

// Run shared conformance suite against MemoryVfsStore.
runVfsStoreConformanceSuite('MemoryVfsStore', () => ({ create: () => new MemoryVfsStore() }), {
  persistent: false,
});

describe('VfsStore shared helpers & MemoryVfsStore specifics', () => {
  test('resolveVfsStoreQuotas applies browser vs native defaults and rejects invalid overrides', () => {
    const browser = resolveVfsStoreQuotas('indexeddb');
    expect(browser).toEqual({
      hotKvMaxBytes: VFS_HOT_KV_MAX_BYTES_BROWSER,
      coldCasMaxBytes: VFS_COLD_CAS_MAX_BYTES_BROWSER,
      perMemberCasFraction: 0.5,
    });

    const native = resolveVfsStoreQuotas('wormdb-ffi');
    expect(native).toEqual({
      hotKvMaxBytes: VFS_HOT_KV_MAX_BYTES_NATIVE,
      coldCasMaxBytes: VFS_COLD_CAS_MAX_BYTES_NATIVE,
      perMemberCasFraction: 0.5,
    });

    const bunFile = resolveVfsStoreQuotas('bun-file', { hotKvMaxBytes: 4096, perMemberCasFraction: 1 });
    expect(bunFile).toEqual({
      hotKvMaxBytes: 4096,
      coldCasMaxBytes: VFS_COLD_CAS_MAX_BYTES_NATIVE,
      perMemberCasFraction: 1,
    });

    expect(() => resolveVfsStoreQuotas('memory', { hotKvMaxBytes: -1 })).toThrow(VfsError);
    expect(() => resolveVfsStoreQuotas('memory', { coldCasMaxBytes: 1.5 })).toThrow(VfsError);
    expect(() => resolveVfsStoreQuotas('memory', { perMemberCasFraction: 0 })).toThrow(VfsError);
    expect(() => resolveVfsStoreQuotas('memory', { perMemberCasFraction: 1.01 })).toThrow(VfsError);
    expect(() => resolveVfsStoreQuotas('memory', { perMemberCasFraction: Number.NaN })).toThrow(VfsError);
  });

  test('compareUtf8Lex orders strictly by UTF-8 bytes (matching WormDB) and key validation enforces exact 512B boundary', async () => {
    // U+FFFF encodes to EF BF BF in UTF-8; U+10000 encodes to F0 90 80 80.
    // UTF-16 comparison gets this backwards (0xFFFF > 0xD800), UTF-8 byte order puts U+FFFF < U+10000.
    expect(compareUtf8Lex('\uffff', '\u{10000}')).toBeLessThan(0);
    expect(compareUtf8Lex('abc', 'abc')).toBe(0);
    expect(compareUtf8Lex('ab', 'abc')).toBeLessThan(0);

    const prefix = vfsRoomPrefix(ROOM_1);
    const exact512 = prefix + 'a'.repeat(VFS_MAX_KV_KEY_BYTES - utf8Bytes(prefix).byteLength);
    expect(utf8Bytes(exact512).byteLength).toBe(VFS_MAX_KV_KEY_BYTES);
    expect(validateVfsKvKey(ROOM_1, exact512)).toBe(exact512);
    expect(validateVfsKvPrefix(ROOM_1, prefix)).toBe(prefix);
    expect(() => validateVfsKvKey(ROOM_1, prefix)).toThrow(VfsError); // Empty suffix not a key
    expect(() => validateVfsKvKey(ROOM_1, exact512 + 'a')).toThrow(VfsError); // 513 bytes
    expect(() => validateVfsRoomId('not-a-uuid')).toThrow(VfsError);
    expect(() => validateBlockCid('ABCDEF'.repeat(10) + '1234')).toThrow(VfsError); // Uppercase rejected

    const bytes = utf8Bytes('hello-block');
    const cid = await computeCid(bytes);
    expect(await verifyBlockCid(cid, bytes)).toBe(cid);
    await expectVfsError(() => verifyBlockCid(cid, utf8Bytes('tampered')), 'VFS_INVALID_ENVELOPE');

    expect(() => assertBlockSizeWithinCap(new Uint8Array(VFS_BLOCK_MAX_BYTES))).not.toThrow();
    await expectVfsError(() => assertBlockSizeWithinCap(new Uint8Array(VFS_BLOCK_MAX_BYTES + 1)), 'VFS_LIMIT_EXCEEDED');

    expect(validateScanPrefixOptions()).toEqual({ direction: 'first' });
    expect(validateScanPrefixOptions({ limit: 1, direction: 'last', beforeKey: 'z' })).toEqual({
      limit: 1,
      direction: 'last',
      beforeKey: 'z',
    });
    await expectVfsError(() => validateScanPrefixOptions({ beforeKey: 'a\0b' }), 'VFS_INVALID_KEY');
    await expectVfsError(() => validateScanPrefixOptions({ direction: 'bad' as 'first' }), 'VFS_INVALID_KEY');
  });

  test('VfsRoomFence latches first failure reason and fences all data ops while stats() still reports fenced state', async () => {
    const fence = new VfsRoomFence(ROOM_1);
    expect(fence.fenced).toBe(false);
    expect(fence.reason).toBeUndefined();
    fence.assertOpen();

    fence.trip('WAL fsync I/O error');
    fence.trip('secondary error');
    expect(fence.fenced).toBe(true);
    expect(fence.reason).toBe('WAL fsync I/O error');
    await expectVfsError(() => fence.assertOpen(), 'VFS_STORAGE_FENCED');

    const store = new MemoryVfsStore();
    const room = await store.openRoom(ROOM_1);
    const k = vfsMetaKey(ROOM_1);
    const blk = utf8Bytes('blk');
    const cid = await computeCid(blk);
    await room.kvPut(k, utf8Bytes('ok'));
    await room.putBlock(cid, blk);

    room.fence.trip('injected storage error');
    expect(room.isFenced).toBe(true);

    // Every data operation fails closed with VFS_STORAGE_FENCED
    await expectVfsError(() => room.kvGet(k), 'VFS_STORAGE_FENCED');
    await expectVfsError(() => room.kvPut(k, utf8Bytes('new')), 'VFS_STORAGE_FENCED');
    await expectVfsError(() => room.kvPutIfAbsent(vfsNodeHeadKey(ROOM_1, NODE_1), utf8Bytes('x')), 'VFS_STORAGE_FENCED');
    await expectVfsError(() => room.kvDelete(k), 'VFS_STORAGE_FENCED');
    await expectVfsError(() => room.kvScanPrefix(vfsRoomPrefix(ROOM_1)), 'VFS_STORAGE_FENCED');
    await expectVfsError(() => room.putBlock(cid, blk), 'VFS_STORAGE_FENCED');
    await expectVfsError(() => room.getBlock(cid), 'VFS_STORAGE_FENCED');
    await expectVfsError(() => room.hasBlock(cid), 'VFS_STORAGE_FENCED');
    await expectVfsError(() => room.deleteBlock(cid), 'VFS_STORAGE_FENCED');
    await expectVfsError(() => room.checkpoint(), 'VFS_STORAGE_FENCED');

    // stats() stays readable so UI/diagnostics can surface the fence banner
    const st = await room.stats();
    expect(st.fenced).toBe(true);
    expect(st.fencedReason).toBe('injected storage error');

    await room.close();
    await store.close();
  });

  test('writeBeforePublish aborts before publishKey when an intermediate KV write hits quota', async () => {
    const store = new MemoryVfsStore();
    const kPub = vfsMetaKey(ROOM_1);
    const kObj = vfsObjKey(ROOM_1, 'a'.repeat(64));
    const smallBudget = kvEntryBytes(kObj, new Uint8Array(10));
    const room = await store.openRoom(ROOM_1, { hotKvMaxBytes: smallBudget, coldCasMaxBytes: 1024 });

    await expectVfsError(
      () =>
        writeBeforePublish(room, {
          kvEntries: [{ key: kObj, value: new Uint8Array(50) }],
          publishKey: kPub,
          publishValue: utf8Bytes('should-not-publish'),
        }),
      'VFS_STORAGE_QUOTA',
    );
    expect(await room.kvGet(kPub)).toBeUndefined();
    expect(await room.kvGet(kObj)).toBeUndefined();

    await store.close();
  });

  test('closing MemoryVfsStore closes active room handles and rejects further store calls', async () => {
    const store = new MemoryVfsStore();
    const room = await store.openRoom(ROOM_1);
    await store.close();
    await store.close(); // Idempotent

    await expectVfsError(() => room.kvGet(vfsMetaKey(ROOM_1)), 'VFS_STORAGE_CLOSED');
    await expectVfsError(() => store.openRoom(ROOM_1), 'VFS_STORAGE_CLOSED');
    await expectVfsError(() => store.destroyRoom(ROOM_1), 'VFS_STORAGE_CLOSED');
  });
});
