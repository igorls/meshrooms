/**
 * Shared conformance test suite for every `VfsStore` / `VfsRoomStore` adapter
 * (`MemoryVfsStore`, `IndexedDbVfsStore`, `WormDbFfiVfsStore`, `BunFileVfsStore`).
 */

import { describe, expect, test } from 'bun:test';
import {
  VFS_MAX_KV_KEY_BYTES,
  VfsError,
  vfsMetaKey,
  vfsNodeHeadKey,
  vfsObjKey,
  vfsOpKey,
  vfsOpPrefix,
  vfsRoomPrefix,
  type VfsErrorCode,
} from './constants';
import { computeCid, utf8Bytes } from './envelope';
import {
  VFS_BLOCK_MAX_BYTES,
  kvEntryBytes,
  writeBeforePublish,
  type VfsStore,
} from './store';

export type VfsStoreConformanceHarness = {
  /** Creates a fresh store instance for one test. */
  create: () => Promise<VfsStore> | VfsStore;
  /** Reopens the SAME underlying backing store after `close()` (used when `persistent: true`). */
  reopen?: () => Promise<VfsStore> | VfsStore;
  /** Cleans up temporary files/databases after each test. */
  cleanup?: () => Promise<void> | void;
};

export type VfsStoreConformanceFactory = () => Promise<VfsStoreConformanceHarness> | VfsStoreConformanceHarness;

export type VfsStoreConformanceOptions = {
  /** Set `true` for durable adapters (IndexedDB, WormDB FFI, BunFile) to exercise close + reopen durability. */
  persistent?: boolean;
};

const ROOM_1 = '11111111-1111-4111-8111-111111111111';
const ROOM_2 = '22222222-2222-4222-8222-222222222222';
const NODE_1 = '33333333-3333-4333-8333-333333333333';
const DEV_A = 'a'.repeat(64);
const MEMBER_A = 'aaaa1111-1111-4111-8111-111111111111';
const MEMBER_B = 'bbbb2222-2222-4222-8222-222222222222';

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

async function withHarness(
  factory: VfsStoreConformanceFactory,
  body: (harness: VfsStoreConformanceHarness) => Promise<void>,
) {
  const harness = await factory();
  try {
    await body(harness);
  } finally {
    await harness.cleanup?.();
  }
}

export function runVfsStoreConformanceSuite(
  label: string,
  factory: VfsStoreConformanceFactory,
  options: VfsStoreConformanceOptions = {},
): void {
  const persistent = options.persistent ?? false;

  describe(`${label} — VfsStore Conformance Suite`, () => {
    test('KV CRUD: binary, empty, NUL values, defensive copies, and kvPutIfAbsent', async () => {
      await withHarness(factory, async harness => {
        const store = await harness.create();
        try {
          const room = await store.openRoom(ROOM_1);
          const kMeta = vfsMetaKey(ROOM_1);
          const kEmpty = vfsNodeHeadKey(ROOM_1, NODE_1);
          const kBin = vfsOpKey(ROOM_1, NODE_1, DEV_A, 1, '01234567');

          expect(await room.kvGet(kMeta)).toBeUndefined();
          expect(await room.kvDelete(kMeta)).toBe(false);

          // Binary payload with embedded NUL bytes & high bytes
          const binaryVal = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xff, 0x00, 0x42]);
          await room.kvPut(kBin, binaryVal);
          // Mutate caller buffer after put -> stored bytes must be unaffected
          binaryVal[0] = 0xee;
          const gotBin = await room.kvGet(kBin);
          expect(gotBin).toEqual(new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xff, 0x00, 0x42]));
          // Mutate returned buffer -> stored bytes must be unaffected
          gotBin![0] = 0xdd;
          expect(await room.kvGet(kBin)).toEqual(new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xff, 0x00, 0x42]));

          // Empty value is distinct from absent key
          await room.kvPut(kEmpty, new Uint8Array(0));
          const gotEmpty = await room.kvGet(kEmpty);
          expect(gotEmpty).toBeInstanceOf(Uint8Array);
          expect(gotEmpty!.byteLength).toBe(0);

          // kvPutIfAbsent inserts once and never overwrites
          expect(await room.kvPutIfAbsent(kMeta, utf8Bytes('first'))).toBe(true);
          expect(await room.kvPutIfAbsent(kMeta, utf8Bytes('second'))).toBe(false);
          expect(await room.kvGet(kMeta)).toEqual(utf8Bytes('first'));

          // Overwrite via kvPut succeeds
          await room.kvPut(kMeta, utf8Bytes('updated'));
          expect(await room.kvGet(kMeta)).toEqual(utf8Bytes('updated'));

          // Delete returns true once, then false
          expect(await room.kvDelete(kMeta)).toBe(true);
          expect(await room.kvDelete(kMeta)).toBe(false);
          expect(await room.kvGet(kMeta)).toBeUndefined();

          await room.close();
        } finally {
          await store.close();
        }
      });
    });

    test('kvScanPrefix: strictly ascending UTF-8 order, limit (first N), and exclusive afterKey pagination', async () => {
      await withHarness(factory, async harness => {
        const store = await harness.create();
        try {
          const room = await store.openRoom(ROOM_1);
          const prefix = vfsOpPrefix(ROOM_1, NODE_1, DEV_A);
          // Insert out of order across 1-digit and 2-digit seq numbers
          const seqs = [12, 3, 1, 20, 2, 10, 5];
          for (const seq of seqs) {
            await room.kvPut(vfsOpKey(ROOM_1, NODE_1, DEV_A, seq, 'abcdef01'), utf8Bytes(`seq-${seq}`));
          }
          // Unrelated key in same room must not appear in op prefix scan
          await room.kvPut(vfsMetaKey(ROOM_1), utf8Bytes('meta'));

          const expectedOrder = [...seqs]
            .sort((a, b) => a - b)
            .map(s => vfsOpKey(ROOM_1, NODE_1, DEV_A, s, 'abcdef01'));

          // Full scan
          const all = await room.kvScanPrefix(prefix);
          expect(all.map(e => e.key)).toEqual(expectedOrder);
          expect(all.map(e => new TextDecoder().decode(e.value))).toEqual([
            'seq-1', 'seq-2', 'seq-3', 'seq-5', 'seq-10', 'seq-12', 'seq-20',
          ]);

          // limit > 0 MUST return the FIRST N keys (NOT tail!) when direction is omitted or 'first'
          const first3 = await room.kvScanPrefix(prefix, { limit: 3 });
          expect(first3.map(e => e.key)).toEqual(expectedOrder.slice(0, 3));
          const first3Explicit = await room.kvScanPrefix(prefix, { limit: 3, direction: 'first' });
          expect(first3Explicit.map(e => e.key)).toEqual(expectedOrder.slice(0, 3));

          // direction: 'last' returns the LAST N matching keys in ascending UTF-8 order
          const latest1 = await room.kvScanPrefix(prefix, { limit: 1, direction: 'last' });
          expect(latest1.map(e => e.key)).toEqual(expectedOrder.slice(-1));
          expect(new TextDecoder().decode(latest1[0]!.value)).toBe('seq-20');

          const last3 = await room.kvScanPrefix(prefix, { limit: 3, direction: 'last' });
          expect(last3.map(e => e.key)).toEqual(expectedOrder.slice(-3));

          // Paginate forward 2 at a time using exclusive afterKey
          const collected: string[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < 10; page++) {
            const batch = await room.kvScanPrefix(prefix, { limit: 2, ...(cursor ? { afterKey: cursor } : {}) });
            if (batch.length === 0) break;
            collected.push(...batch.map(e => e.key));
            cursor = batch.at(-1)!.key;
          }
          expect(collected).toEqual(expectedOrder);

          // Paginate backward 2 at a time using direction: 'last' + exclusive beforeKey
          const backPages: string[][] = [];
          let upperCursor: string | undefined;
          for (let page = 0; page < 10; page++) {
            const batch = await room.kvScanPrefix(prefix, {
              limit: 2,
              direction: 'last',
              ...(upperCursor ? { beforeKey: upperCursor } : {}),
            });
            if (batch.length === 0) break;
            backPages.unshift(batch.map(e => e.key));
            upperCursor = batch[0]!.key;
          }
          expect(backPages.flat()).toEqual(expectedOrder);

          // Combined afterKey + beforeKey range window (both 'first' and 'last')
          const midFirst = await room.kvScanPrefix(prefix, {
            afterKey: expectedOrder[1],
            beforeKey: expectedOrder[5],
            limit: 2,
            direction: 'first',
          });
          expect(midFirst.map(e => e.key)).toEqual(expectedOrder.slice(2, 4));

          const midLast = await room.kvScanPrefix(prefix, {
            afterKey: expectedOrder[1],
            beforeKey: expectedOrder[5],
            limit: 2,
            direction: 'last',
          });
          expect(midLast.map(e => e.key)).toEqual(expectedOrder.slice(3, 5));

          // Inverted or empty cursor bounds cleanly return []
          expect(await room.kvScanPrefix(prefix, { afterKey: expectedOrder[4], beforeKey: expectedOrder[2] })).toEqual([]);
          expect(await room.kvScanPrefix(prefix, { afterKey: expectedOrder[2], beforeKey: expectedOrder[2] })).toEqual([]);
          expect(await room.kvScanPrefix(prefix, { beforeKey: prefix })).toEqual([]);

          // Invalid scan options rejected with VFS_INVALID_KEY
          await expectVfsError(room.kvScanPrefix(prefix, { beforeKey: 'bad\0key' }), 'VFS_INVALID_KEY');
          await expectVfsError(room.kvScanPrefix(prefix, { direction: 'sideways' as 'first' }), 'VFS_INVALID_KEY');

          // Room-wide prefix scan includes all keys in the room
          const wholeRoom = await room.kvScanPrefix(vfsRoomPrefix(ROOM_1));
          expect(wholeRoom.length).toBe(seqs.length + 1);

          await room.close();
        } finally {
          await store.close();
        }
      });
    });

    test('namespace isolation and strict KV key validation (cross-room, NUL, >512B)', async () => {
      await withHarness(factory, async harness => {
        const store = await harness.create();
        try {
          const r1 = await store.openRoom(ROOM_1);
          const r2 = await store.openRoom(ROOM_2);

          await r1.kvPut(vfsMetaKey(ROOM_1), utf8Bytes('room-1-secret'));
          await r2.kvPut(vfsMetaKey(ROOM_2), utf8Bytes('room-2-secret'));

          expect(await r1.kvGet(vfsMetaKey(ROOM_1))).toEqual(utf8Bytes('room-1-secret'));
          expect(await r2.kvGet(vfsMetaKey(ROOM_2))).toEqual(utf8Bytes('room-2-secret'));

          // Room 1 cannot access Room 2's keys or arbitrary un-prefixed keys
          await expectVfsError(r1.kvGet(vfsMetaKey(ROOM_2)), 'VFS_INVALID_KEY');
          await expectVfsError(r1.kvPut(vfsMetaKey(ROOM_2), utf8Bytes('x')), 'VFS_INVALID_KEY');
          await expectVfsError(r1.kvDelete(vfsMetaKey(ROOM_2)), 'VFS_INVALID_KEY');
          await expectVfsError(r1.kvScanPrefix(vfsRoomPrefix(ROOM_2)), 'VFS_INVALID_KEY');
          await expectVfsError(r1.kvPut('not-prefixed', utf8Bytes('x')), 'VFS_INVALID_KEY');
          await expectVfsError(r1.kvPut(`${vfsRoomPrefix(ROOM_1)}bad\0key`, utf8Bytes('x')), 'VFS_INVALID_KEY');
          const tooLongKey = `${vfsRoomPrefix(ROOM_1)}${'x'.repeat(VFS_MAX_KV_KEY_BYTES)}`;
          await expectVfsError(r1.kvPut(tooLongKey, utf8Bytes('x')), 'VFS_INVALID_KEY');

          // CAS blocks are also isolated per room
          const blk = utf8Bytes('shared-content-isolated-per-room');
          const cid = await computeCid(blk);
          expect(await r1.putBlock(cid, blk)).toBe(true);
          expect(await r1.hasBlock(cid)).toBe(true);
          expect(await r2.hasBlock(cid)).toBe(false);
          expect(await r2.getBlock(cid)).toBeUndefined();

          await r1.close();
          await r2.close();
        } finally {
          await store.close();
        }
      });
    });

    test('CAS blocks: CID verification, idempotency, empty block, delete, and coldCasMaxBytes + 50% fairness', async () => {
      await withHarness(factory, async harness => {
        const store = await harness.create();
        try {
          const room = await store.openRoom(ROOM_1, {
            hotKvMaxBytes: 1024 * 1024,
            coldCasMaxBytes: 1000,
            perMemberCasFraction: 0.5,
          });

          // Empty block is valid
          const empty = new Uint8Array(0);
          const emptyCid = await computeCid(empty);
          expect(await room.putBlock(emptyCid, empty)).toBe(true);
          expect(await room.hasBlock(emptyCid)).toBe(true);
          expect(await room.getBlock(emptyCid)).toEqual(empty);
          expect(await room.deleteBlock(emptyCid)).toBe(true);

          // Invalid CID format or mismatched SHA-256 rejected
          const b1 = new Uint8Array(400).fill(0x11);
          const cid1 = await computeCid(b1);
          await expectVfsError(room.putBlock('not-a-cid', b1), 'VFS_INVALID_ENVELOPE');
          await expectVfsError(room.putBlock('0'.repeat(64), b1), 'VFS_INVALID_ENVELOPE');
          await expectVfsError(room.getBlock('bad-cid'), 'VFS_INVALID_ENVELOPE');
          await expectVfsError(room.hasBlock('bad-cid'), 'VFS_INVALID_ENVELOPE');

          // Member A stores 400 B (<= 500 B fairness cap)
          expect(await room.putBlock(cid1, b1, { authorMemberId: MEMBER_A })).toBe(true);
          // Idempotent repeat returns false and does not double-count
          expect(await room.putBlock(cid1, b1, { authorMemberId: MEMBER_A })).toBe(false);
          expect((await room.stats()).coldCasBytes).toBe(400);
          expect((await room.stats()).coldCasBlocks).toBe(1);

          // Member A tries to add 200 B -> 600 > 500 per-member cap -> VFS_STORAGE_QUOTA!
          const b2 = new Uint8Array(200).fill(0x22);
          const cid2 = await computeCid(b2);
          await expectVfsError(room.putBlock(cid2, b2, { authorMemberId: MEMBER_A }), 'VFS_STORAGE_QUOTA');
          expect(await room.hasBlock(cid2)).toBe(false);

          // Member B can STILL store 450 B (400 + 450 <= 1000 total, 450 <= 500 member B cap)
          const b3 = new Uint8Array(450).fill(0x33);
          const cid3 = await computeCid(b3);
          expect(await room.putBlock(cid3, b3, { authorMemberId: MEMBER_B })).toBe(true);
          expect((await room.stats()).coldCasBytes).toBe(850);

          // Room-wide cap: 850 + 200 > 1000 -> VFS_STORAGE_QUOTA even without authorMemberId
          await expectVfsError(room.putBlock(cid2, b2), 'VFS_STORAGE_QUOTA');

          // Deleting Member A's 400 B block frees both room and Member A's fairness budget
          expect(await room.deleteBlock(cid1)).toBe(true);
          expect(await room.deleteBlock(cid1)).toBe(false);
          expect(await room.putBlock(cid2, b2, { authorMemberId: MEMBER_A })).toBe(true);
          expect(await room.getBlock(cid2)).toEqual(b2);

          // Per-block max size cap (`VFS_BLOCK_MAX_BYTES`) rejects giant blocks with VFS_LIMIT_EXCEEDED without fencing
          const giant = new Uint8Array(VFS_BLOCK_MAX_BYTES + 1).fill(0x7e);
          const giantCid = await computeCid(giant);
          await expectVfsError(room.putBlock(giantCid, giant), 'VFS_LIMIT_EXCEEDED');
          expect(room.isFenced).toBe(false);
          expect(await room.hasBlock(giantCid)).toBe(false);
          expect(await room.getBlock(cid2)).toEqual(b2);

          await room.close();
        } finally {
          await store.close();
        }
      });
    });

    test('hotKvMaxBytes quota enforcement and overwrite delta accounting', async () => {
      await withHarness(factory, async harness => {
        const store = await harness.create();
        try {
          const k1 = vfsMetaKey(ROOM_1);
          const k2 = vfsNodeHeadKey(ROOM_1, NODE_1);
          const v1 = new Uint8Array(100).fill(0xaa);
          const exactBudget = kvEntryBytes(k1, v1);

          const room = await store.openRoom(ROOM_1, { hotKvMaxBytes: exactBudget, coldCasMaxBytes: 1024 });
          await room.kvPut(k1, v1);
          expect((await room.stats()).hotKvBytes).toBe(exactBudget);
          expect((await room.stats()).hotKvKeys).toBe(1);

          // Any extra key breaches hotKvMaxBytes
          await expectVfsError(room.kvPut(k2, new Uint8Array(1)), 'VFS_STORAGE_QUOTA');
          await expectVfsError(room.kvPutIfAbsent(k2, new Uint8Array(1)), 'VFS_STORAGE_QUOTA');
          // Growing existing key by 1 byte breaches hotKvMaxBytes
          await expectVfsError(room.kvPut(k1, new Uint8Array(101)), 'VFS_STORAGE_QUOTA');

          // Overwriting existing key with equal or smaller payload succeeds!
          await room.kvPut(k1, new Uint8Array(100).fill(0xbb));
          expect(await room.kvGet(k1)).toEqual(new Uint8Array(100).fill(0xbb));
          await room.kvPut(k1, new Uint8Array(10).fill(0xcc));
          expect((await room.stats()).hotKvBytes).toBe(kvEntryBytes(k1, new Uint8Array(10)));

          // Deleting frees space completely
          await room.kvDelete(k1);
          expect((await room.stats()).hotKvBytes).toBe(0);
          expect((await room.stats()).hotKvKeys).toBe(0);

          await room.close();
        } finally {
          await store.close();
        }
      });
    });

    test('writeBeforePublish commits in order and never writes publishKey on earlier failure', async () => {
      await withHarness(factory, async harness => {
        const store = await harness.create();
        try {
          const room = await store.openRoom(ROOM_1);
          const blkBytes = utf8Bytes('cold-cas-block-payload');
          const blkCid = await computeCid(blkBytes);
          const kObj = vfsObjKey(ROOM_1, blkCid);
          const kPub = vfsMetaKey(ROOM_1);

          // Failure on bad CID aborts BEFORE writing publishKey
          await expectVfsError(
            writeBeforePublish(room, {
              blocks: [{ cid: '0'.repeat(64), bytes: blkBytes }],
              kvEntries: [{ key: kObj, value: utf8Bytes('obj') }],
              publishKey: kPub,
              publishValue: utf8Bytes('published-v1'),
            }),
            'VFS_INVALID_ENVELOPE',
          );
          expect(await room.kvGet(kPub)).toBeUndefined();
          expect(await room.kvGet(kObj)).toBeUndefined();

          // Happy path writes block -> kvEntry -> publishKey
          const res = await writeBeforePublish(room, {
            blocks: [{ cid: blkCid, bytes: blkBytes, authorMemberId: MEMBER_A }],
            kvEntries: [{ key: kObj, value: utf8Bytes('obj-bytes'), ifAbsent: true }],
            publishKey: kPub,
            publishValue: utf8Bytes('published-v1'),
          });
          expect(res).toEqual({ blocksInserted: 1, kvWritten: 1 });
          expect(await room.hasBlock(blkCid)).toBe(true);
          expect(await room.kvGet(kObj)).toEqual(utf8Bytes('obj-bytes'));
          expect(await room.kvGet(kPub)).toEqual(utf8Bytes('published-v1'));

          await room.close();
        } finally {
          await store.close();
        }
      });
    });

    test('destroyRoom wipes target room without disturbing sibling rooms; close fails closed', async () => {
      await withHarness(factory, async harness => {
        const store = await harness.create();
        try {
          const r1 = await store.openRoom(ROOM_1);
          const r2 = await store.openRoom(ROOM_2);
          const blk = utf8Bytes('room-block');
          const cid = await computeCid(blk);

          await r1.kvPut(vfsMetaKey(ROOM_1), utf8Bytes('r1'));
          await r1.putBlock(cid, blk);
          await r2.kvPut(vfsMetaKey(ROOM_2), utf8Bytes('r2'));
          await r2.putBlock(cid, blk);

          await r1.checkpoint();
          await r1.close();
          // Idempotent close & fail-closed on subsequent operations
          await r1.close();
          await expectVfsError(r1.kvGet(vfsMetaKey(ROOM_1)), 'VFS_STORAGE_CLOSED');
          await expectVfsError(r1.kvPut(vfsMetaKey(ROOM_1), utf8Bytes('x')), 'VFS_STORAGE_CLOSED');
          await expectVfsError(r1.putBlock(cid, blk), 'VFS_STORAGE_CLOSED');
          await expectVfsError(r1.stats(), 'VFS_STORAGE_CLOSED');

          await store.destroyRoom(ROOM_1);

          // Room 2 is completely intact
          expect(await r2.kvGet(vfsMetaKey(ROOM_2))).toEqual(utf8Bytes('r2'));
          expect(await r2.getBlock(cid)).toEqual(blk);

          // Reopening Room 1 sees clean empty state
          const r1Fresh = await store.openRoom(ROOM_1);
          expect(await r1Fresh.kvGet(vfsMetaKey(ROOM_1))).toBeUndefined();
          expect(await r1Fresh.hasBlock(cid)).toBe(false);
          expect((await r1Fresh.stats()).hotKvKeys).toBe(0);
          expect((await r1Fresh.stats()).coldCasBlocks).toBe(0);

          await r1Fresh.close();
          await r2.close();
        } finally {
          await store.close();
        }
      });
    });

    if (persistent) {
      test('persists KV, CAS blocks, stats, and per-member CAS fairness across close + reopen', async () => {
        await withHarness(factory, async harness => {
          if (!harness.reopen) {
            throw new Error(`Persistent conformance harness for "${label}" must provide reopen().`);
          }
          const kMeta = vfsMetaKey(ROOM_1);
          const kEmpty = vfsNodeHeadKey(ROOM_1, NODE_1);
          const kBin = vfsOpKey(ROOM_1, NODE_1, DEV_A, 1, '12345678');
          const binVal = new Uint8Array([0, 255, 1, 0, 99]);
          const blkA = new Uint8Array(400).fill(0x5a);
          const cidA = await computeCid(blkA);
          const blkA2 = new Uint8Array(200).fill(0x6b);
          const cidA2 = await computeCid(blkA2);

          const store1 = await harness.create();
          try {
            const room1 = await store1.openRoom(ROOM_1, {
              hotKvMaxBytes: 1024 * 1024,
              coldCasMaxBytes: 1000,
              perMemberCasFraction: 0.5,
            });
            await room1.kvPut(kMeta, utf8Bytes('persisted-meta'));
            await room1.kvPut(kEmpty, new Uint8Array(0));
            await room1.kvPut(kBin, binVal);
            expect(await room1.putBlock(cidA, blkA, { authorMemberId: MEMBER_A })).toBe(true);
            await room1.checkpoint();
            await room1.close();
          } finally {
            await store1.close();
          }

          const store2 = await harness.reopen();
          try {
            const room2 = await store2.openRoom(ROOM_1, {
              hotKvMaxBytes: 1024 * 1024,
              coldCasMaxBytes: 1000,
              perMemberCasFraction: 0.5,
            });
            expect(await room2.kvGet(kMeta)).toEqual(utf8Bytes('persisted-meta'));
            const emptyVal = await room2.kvGet(kEmpty);
            expect(emptyVal).toBeInstanceOf(Uint8Array);
            expect(emptyVal!.byteLength).toBe(0);
            expect(await room2.kvGet(kBin)).toEqual(binVal);
            expect(await room2.hasBlock(cidA)).toBe(true);
            expect(await room2.getBlock(cidA)).toEqual(blkA);

            const st = await room2.stats();
            expect(st.hotKvKeys).toBe(3);
            expect(st.hotKvBytes).toBe(
              kvEntryBytes(kMeta, utf8Bytes('persisted-meta'))
              + kvEntryBytes(kEmpty, new Uint8Array(0))
              + kvEntryBytes(kBin, binVal),
            );
            expect(st.coldCasBlocks).toBe(1);
            expect(st.coldCasBytes).toBe(400);
            expect(st.fenced).toBe(false);

            // Reconstructed per-member CAS fairness still enforces Member A's 500 B cap!
            await expectVfsError(room2.putBlock(cidA2, blkA2, { authorMemberId: MEMBER_A }), 'VFS_STORAGE_QUOTA');
            // Member B can still store within its 500 B cap
            expect(await room2.putBlock(cidA2, blkA2, { authorMemberId: MEMBER_B })).toBe(true);

            await room2.close();
          } finally {
            await store2.close();
          }
        });
      });
    }
  });
}
