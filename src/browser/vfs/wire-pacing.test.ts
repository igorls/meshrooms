import { describe, expect, test } from 'bun:test';
import { base64, deviceId, encode } from '../protocol';
import {
  bytesToBase64,
  exportRawPublicKey,
  generateEncKeyPair,
  signEncBinding,
  signRoster,
  type RosterBody,
  type RosterEntry,
  type SignFn,
  type SignedRoster,
} from '../relay-crypto';
import {
  VFS_COALESCE_RELAY_MS,
  VFS_COALESCE_WEBRTC_MS,
  VFS_MAX_SEQ,
  VFS_RELAY_MAX_BLOCK_FRAMES_PER_MIN,
  VFS_RELAY_MAX_BYTES_PER_MIN,
  VFS_RELAY_MAX_FRAMES_PER_MIN,
  VFS_RELAY_MAX_OPS_FRAMES_PER_MIN,
  VfsError,
  VfsObjKind,
  type VfsErrorCode,
} from './constants';
import { generateVfsKey, opBindingKey, sealVfsEnvelope, utf8Bytes } from './envelope';
import { VfsKeyring } from './keyring';
import {
  VFS_COALESCE_MAX_BATCH_WINDOW_MS,
  VfsEditCoalescer,
  VfsRelayBudget,
  VfsSyncTracker,
  type VfsFlushReason,
} from './pacing';
import {
  VFS_BLOCK_CHUNK_MAX_BYTES,
  VFS_BLOCK_MAX_CIDS,
  VFS_HAVE_MAX_HEADS,
  VFS_OPS_MAX_BYTES,
  VFS_OPS_MAX_RECORDS,
  VFS_PACKET_KINDS,
  VFS_RELAY_SEND_OPTS,
  assertVfsRelaySafeOptions,
  chunkVfsOpsPages,
  computeVfsFrontierHash,
  decodeVfsRecordEnvelope,
  isVfsBlockChunkPacket,
  isVfsBlockHavePacket,
  isVfsBlockWantPacket,
  isVfsHavePacket,
  isVfsKeyEpochPacket,
  isVfsKeyGrantPacket,
  isVfsKeyWrapPacket,
  isVfsOpsPacket,
  isVfsPacket,
  isVfsPacketKind,
  isVfsRecordPacket,
  vfsPacketRelayLane,
  wrapKeyEpochPacket,
  wrapKeyGrantPacket,
  wrapKeyWrapPacket,
  type VfsBlockChunkPacket,
  type VfsBlockHavePacket,
  type VfsBlockWantPacket,
  type VfsHavePacket,
  type VfsOpsPacket,
  type VfsRecordObjKind,
  type VfsRecordPacket,
} from './wire';

const ROOM_1 = '11111111-1111-4111-8111-111111111111';
const ROOM_2 = '22222222-2222-4222-8222-222222222222';
const NODE_1 = '33333333-3333-4333-8333-333333333333';
const OP_1 = '44444444-4444-4444-8444-444444444444';
const DEV_A = 'a'.repeat(64);
const DEV_B = 'b'.repeat(64);
const CID_A = '1'.repeat(64);
const CID_B = '2'.repeat(64);
const CID_C = '3'.repeat(64);

function expectVfsErrorSync(fn: () => unknown, code: VfsErrorCode): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(VfsError);
  expect((caught as VfsError).code).toBe(code);
}

async function expectVfsErrorAsync(promise: Promise<unknown>, code: VfsErrorCode): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(VfsError);
  expect((caught as VfsError).code).toBe(code);
}

async function makeRecordPacket(overrides: Partial<{
  roomId: string;
  epoch: number;
  objKind: VfsRecordObjKind;
  nodeId: string;
  deviceId: string;
  seq: number;
  opId: string;
  payloadBytes: Uint8Array;
}> = {}): Promise<VfsRecordPacket> {
  const roomId = overrides.roomId ?? ROOM_1;
  const epoch = overrides.epoch ?? 1;
  const objKind = overrides.objKind ?? VfsObjKind.DocOp;
  const nodeId = overrides.nodeId ?? NODE_1;
  const device = overrides.deviceId ?? DEV_A;
  const seq = overrides.seq ?? 1;
  const opId = overrides.opId ?? OP_1;
  const rk = generateVfsKey();
  const payload = overrides.payloadBytes ?? utf8Bytes(`{"body":{"seq":${seq}},"signature":"${'s'.repeat(88)}"}`);
  const sealed = await sealVfsEnvelope({
    roomId,
    epoch,
    objKind,
    key: rk,
    plaintext: payload,
    bindingKey: opBindingKey(device, seq, opId),
  });
  return {
    kind: 'vfs-record',
    v: 1,
    roomId,
    epoch,
    objKind,
    nodeId,
    deviceId: device,
    seq,
    opId,
    cid: sealed.cid,
    env: bytesToBase64(sealed.bytes),
  };
}

async function makePeerIdentity(memberId: string) {
  const signKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const signPub = base64(await crypto.subtle.exportKey('raw', signKeys.publicKey));
  const id = await deviceId(signPub);
  const encKeys = await generateEncKeyPair(false);
  const encPub = await exportRawPublicKey(encKeys.publicKey);
  const sign: SignFn = async value =>
    base64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKeys.privateKey, encode(value)));
  const encSig = await signEncBinding(sign, { room: ROOM_1, deviceId: id, enc: encPub, encVersion: 1 });
  const entry: RosterEntry = { id, sign: signPub, enc: encPub, encVersion: 1, encSig, memberId, role: 'human' };
  return { id, memberId, signPub, encPub, encKeys, sign, entry };
}

describe('VFS Wire Protocol Validators (wire.ts)', () => {
  test('validates VfsRecordPacket and rejects truncated, corrupt, wrong-room, bad-base64, bad-CID, or non-deterministic kinds', async () => {
    const valid = await makeRecordPacket();
    expect(isVfsRecordPacket(valid)).toBe(true);
    expect(isVfsRecordPacket(valid, ROOM_1)).toBe(true);
    expect(isVfsPacket(valid, ROOM_1)).toBe(true);
    expect(isVfsPacketKind(valid.kind)).toBe(true);
    expect(vfsPacketRelayLane(valid)).toBe('primary');

    const rawEnv = decodeVfsRecordEnvelope(valid);
    expect(rawEnv.byteLength).toBeGreaterThanOrEqual(56);

    // Wrong roomId
    expect(isVfsRecordPacket(valid, ROOM_2)).toBe(false);
    expect(isVfsPacket(valid, ROOM_2)).toBe(false);

    // Invalid CID (short, uppercase, non-hex)
    expect(isVfsRecordPacket({ ...valid, cid: 'abc' }, ROOM_1)).toBe(false);
    expect(isVfsRecordPacket({ ...valid, cid: 'A'.repeat(64) }, ROOM_1)).toBe(false);
    expect(isVfsRecordPacket({ ...valid, cid: 'g'.repeat(64) }, ROOM_1)).toBe(false);

    // Invalid base64 (bad chars, whitespace, bad padding, truncated < 56 B)
    expect(isVfsRecordPacket({ ...valid, env: 'not base64!!!' }, ROOM_1)).toBe(false);
    expect(isVfsRecordPacket({ ...valid, env: `${valid.env.slice(0, 8)} ${valid.env.slice(8)}` }, ROOM_1)).toBe(false);
    expect(isVfsRecordPacket({ ...valid, env: bytesToBase64(rawEnv.slice(0, 39)) }, ROOM_1)).toBe(false);
    expect(isVfsRecordPacket({ ...valid, env: bytesToBase64(rawEnv.slice(0, 55)) }, ROOM_1)).toBe(false);
    expect(isVfsRecordPacket({ ...valid, env: '' }, ROOM_1)).toBe(false);

    // Corrupt magic bytes
    const badMagic = new Uint8Array(rawEnv);
    badMagic[0] ^= 0xff;
    expect(isVfsRecordPacket({ ...valid, env: bytesToBase64(badMagic) }, ROOM_1)).toBe(false);

    // Header objKind / epoch mismatch against outer packet metadata
    expect(isVfsRecordPacket({ ...valid, objKind: VfsObjKind.Commit }, ROOM_1)).toBe(false);
    expect(isVfsRecordPacket({ ...valid, epoch: 2 }, ROOM_1)).toBe(false);

    // Non-deterministic object kind (e.g. DeviceLocal / Snap / Chunk) rejected on vfs-record
    expect(isVfsRecordPacket({ ...valid, objKind: VfsObjKind.Snap }, ROOM_1)).toBe(false);
    expect(isVfsRecordPacket({ ...valid, objKind: VfsObjKind.DeviceLocal }, ROOM_1)).toBe(false);

    // Seq bounds & opId validation
    expect(isVfsRecordPacket({ ...valid, seq: 0 }, ROOM_1)).toBe(false);
    expect(isVfsRecordPacket({ ...valid, seq: VFS_MAX_SEQ + 1 }, ROOM_1)).toBe(false);
    expect(isVfsRecordPacket({ ...valid, opId: 'bad:op' }, ROOM_1)).toBe(false);
    expect(isVfsRecordPacket({ ...valid, opId: 'bad\0op' }, ROOM_1)).toBe(false);

    // Commit and TreeOp kinds pass cleanly
    const commitRec = await makeRecordPacket({ objKind: VfsObjKind.Commit, epoch: 2, seq: 3 });
    const treeRec = await makeRecordPacket({ objKind: VfsObjKind.TreeOp, epoch: 1, seq: 4 });
    expect(isVfsRecordPacket(commitRec, ROOM_1)).toBe(true);
    expect(isVfsRecordPacket(treeRec, ROOM_1)).toBe(true);

    expectVfsErrorSync(() => decodeVfsRecordEnvelope({ env: '!!!' }), 'VFS_INVALID_ENVELOPE');
  });

  test('validates VfsHavePacket bounds (heads keys/count, latestEpoch, conflictIds, size cap)', async () => {
    const frontier = await computeVfsFrontierHash([CID_A, CID_B]);
    const valid: VfsHavePacket = {
      kind: 'vfs-have',
      v: 1,
      roomId: ROOM_1,
      deviceId: DEV_A,
      frontierHash: frontier,
      latestEpoch: 0, // Uninitialized newcomer requesting epoch 1
      heads: {
        [DEV_A]: 5,
        [`${NODE_1}:${DEV_B}`]: 12,
      },
      cursor: 'cursor-1',
      nodeId: NODE_1,
      conflictIds: ['0123456789abcdef'],
    };
    expect(isVfsHavePacket(valid, ROOM_1)).toBe(true);
    expect(isVfsPacket(valid, ROOM_1)).toBe(true);
    expect(isVfsHavePacket(valid, ROOM_2)).toBe(false);

    // Bad frontierHash or negative latestEpoch
    expect(isVfsHavePacket({ ...valid, frontierHash: 'short' }, ROOM_1)).toBe(false);
    expect(isVfsHavePacket({ ...valid, latestEpoch: -1 }, ROOM_1)).toBe(false);

    // Invalid head keys (path-like, bad hex) or seq out of range
    expect(isVfsHavePacket({ ...valid, heads: { 'not-a-device': 1 } }, ROOM_1)).toBe(false);
    expect(isVfsHavePacket({ ...valid, heads: { [DEV_A]: -1 } }, ROOM_1)).toBe(false);
    expect(isVfsHavePacket({ ...valid, heads: { [DEV_A]: VFS_MAX_SEQ + 1 } }, ROOM_1)).toBe(false);

    // Exceeding VFS_HAVE_MAX_HEADS (256)
    const tooManyHeads: Record<string, number> = {};
    for (let i = 0; i <= VFS_HAVE_MAX_HEADS; i++) {
      tooManyHeads[i.toString(16).padStart(64, '0')] = i;
    }
    expect(isVfsHavePacket({ ...valid, heads: tooManyHeads }, ROOM_1)).toBe(false);

    // Oversize vfs-have (> 14,000 B JSON) even with <= 256 heads (`nodeId:deviceId` is 101 chars/entry)
    const oversizeHeads: Record<string, number> = {};
    for (let i = 0; i < 150; i++) {
      oversizeHeads[`${NODE_1}:${i.toString(16).padStart(64, '0')}`] = i;
    }
    expect(isVfsHavePacket({ ...valid, heads: oversizeHeads }, ROOM_1)).toBe(false);

    // Bad conflictId or cursor with NUL
    expect(isVfsHavePacket({ ...valid, conflictIds: ['not-16-hex'] }, ROOM_1)).toBe(false);
    expect(isVfsHavePacket({ ...valid, cursor: 'bad\0cursor' }, ROOM_1)).toBe(false);
  });

  test('validates VfsOpsPacket (<= 14 KB UTF-8 JSON, <= 64 records, roomId match, retryAfterMs)', async () => {
    const rec = await makeRecordPacket({ seq: 1 });
    const valid: VfsOpsPacket = {
      kind: 'vfs-ops',
      v: 1,
      roomId: ROOM_1,
      deviceId: DEV_A,
      records: [rec],
      more: true,
      nextCursor: 'c1',
    };
    expect(isVfsOpsPacket(valid, ROOM_1)).toBe(true);
    expect(isVfsPacket(valid, ROOM_1)).toBe(true);
    expect(isVfsOpsPacket(valid, ROOM_2)).toBe(false);

    // Rate-limit retry hint packet with empty records
    const rateLimited: VfsOpsPacket = {
      kind: 'vfs-ops',
      v: 1,
      roomId: ROOM_1,
      deviceId: DEV_A,
      records: [],
      more: false,
      retryAfterMs: 2_500,
    };
    expect(isVfsOpsPacket(rateLimited, ROOM_1)).toBe(true);
    expect(isVfsOpsPacket({ ...rateLimited, retryAfterMs: -1 }, ROOM_1)).toBe(false);
    expect(isVfsOpsPacket({ ...rateLimited, retryAfterMs: 600_001 }, ROOM_1)).toBe(false);

    // > 64 records rejected even if tiny
    const sixtyFive = Array.from({ length: VFS_OPS_MAX_RECORDS + 1 }, () => rec);
    expect(isVfsOpsPacket({ ...valid, records: sixtyFive }, ROOM_1)).toBe(false);

    // > 14,000 B JSON rejected even with 1 record
    const hugeRec = await makeRecordPacket({ payloadBytes: new Uint8Array(10_800).fill(0x41) });
    const hugeOps: VfsOpsPacket = { ...valid, records: [hugeRec] };
    expect(utf8Bytes(JSON.stringify(hugeOps)).byteLength).toBeGreaterThan(VFS_OPS_MAX_BYTES);
    expect(isVfsOpsPacket(hugeOps, ROOM_1)).toBe(false);

    // Nested record from wrong room rejected
    const otherRoomRec = await makeRecordPacket({ roomId: ROOM_2 });
    expect(isVfsOpsPacket({ ...valid, records: [otherRoomRec] }, ROOM_1)).toBe(false);
  });

  test('validates VfsKeyEpochPacket, VfsKeyWrapPacket, VfsKeyGrantPacket wrapping real VfsKeyring structs', async () => {
    const host = await makePeerIdentity('aaaa1111-1111-4111-8111-111111111111');
    const guest = await makePeerIdentity('bbbb2222-2222-4222-8222-222222222222');
    const rosterBody: RosterBody = {
      v: 1,
      room: ROOM_1,
      version: 1,
      prev: '',
      at: 1_750_000_000_000,
      host: host.id,
      devices: [host.entry, guest.entry],
      removed: [],
    };
    const roster: SignedRoster = await signRoster(rosterBody, host.sign);
    const kr = new VfsKeyring({
      roomId: ROOM_1,
      selfDeviceId: host.id,
      selfEncPrivateKey: host.encKeys.privateKey,
      selfEncVersion: 1,
      sign: host.sign,
    });
    const ep1 = await kr.bootstrapEpoch1(roster);
    const grant = await kr.createKeyGrant({ recipient: guest.entry, roster });

    const epochPkt = wrapKeyEpochPacket(ep1.header);
    const wrapPkt = wrapKeyWrapPacket(ep1.wrapChunks[0]);
    const grantPkt = wrapKeyGrantPacket(grant);

    expect(isVfsKeyEpochPacket(epochPkt, ROOM_1)).toBe(true);
    expect(isVfsKeyWrapPacket(wrapPkt, ROOM_1)).toBe(true);
    expect(isVfsKeyGrantPacket(grantPkt, ROOM_1)).toBe(true);
    expect(isVfsPacket(epochPkt, ROOM_1)).toBe(true);
    expect(isVfsPacket(wrapPkt, ROOM_1)).toBe(true);
    expect(isVfsPacket(grantPkt, ROOM_1)).toBe(true);

    // Cross-room outer vs inner mismatch rejected
    expect(isVfsKeyEpochPacket({ ...epochPkt, roomId: ROOM_2 })).toBe(false);
    expect(isVfsKeyWrapPacket({ ...wrapPkt, roomId: ROOM_2 })).toBe(false);
    expect(isVfsKeyGrantPacket({ ...grantPkt, roomId: ROOM_2 })).toBe(false);
    expect(isVfsKeyEpochPacket(epochPkt, ROOM_2)).toBe(false);
  });

  test('validates cold CAS block wire packets (want, have, chunk <= 12 KB slice)', () => {
    const want: VfsBlockWantPacket = { kind: 'vfs-block-want', v: 1, roomId: ROOM_1, deviceId: DEV_A, cids: [CID_A, CID_B] };
    const have: VfsBlockHavePacket = { kind: 'vfs-block-have', v: 1, roomId: ROOM_1, cids: [] };
    const slice = new Uint8Array(VFS_BLOCK_CHUNK_MAX_BYTES).fill(0x55);
    const chunk: VfsBlockChunkPacket = {
      kind: 'vfs-block-chunk',
      v: 1,
      roomId: ROOM_1,
      cid: CID_A,
      offset: 0,
      totalBytes: VFS_BLOCK_CHUNK_MAX_BYTES * 2,
      data: bytesToBase64(slice),
    };
    const emptyChunk: VfsBlockChunkPacket = {
      kind: 'vfs-block-chunk',
      v: 1,
      roomId: ROOM_1,
      cid: CID_A,
      offset: 0,
      totalBytes: 0,
      data: '',
    };

    expect(isVfsBlockWantPacket(want, ROOM_1)).toBe(true);
    expect(isVfsBlockHavePacket(have, ROOM_1)).toBe(true);
    expect(isVfsBlockChunkPacket(chunk, ROOM_1)).toBe(true);
    expect(isVfsBlockChunkPacket(emptyChunk, ROOM_1)).toBe(true);
    expect(vfsPacketRelayLane(want)).toBe('file');
    expect(vfsPacketRelayLane(have)).toBe('file');
    expect(vfsPacketRelayLane(chunk)).toBe('file');
    expect(VFS_PACKET_KINDS.length).toBe(9);

    // Want with empty cids or > 128 cids rejected
    expect(isVfsBlockWantPacket({ ...want, cids: [] }, ROOM_1)).toBe(false);
    const tooManyCids = Array.from({ length: VFS_BLOCK_MAX_CIDS + 1 }, (_, i) => i.toString(16).padStart(64, '0'));
    expect(isVfsBlockWantPacket({ ...want, cids: tooManyCids }, ROOM_1)).toBe(false);
    expect(isVfsBlockHavePacket({ ...have, cids: tooManyCids }, ROOM_1)).toBe(false);
    expect(isVfsBlockHavePacket({ ...have, cids: ['bad-cid'] }, ROOM_1)).toBe(false);

    // Chunk > 12,000 B rejected
    const oversizeSlice = new Uint8Array(VFS_BLOCK_CHUNK_MAX_BYTES + 1).fill(0x77);
    expect(isVfsBlockChunkPacket({ ...chunk, data: bytesToBase64(oversizeSlice) }, ROOM_1)).toBe(false);
    // Offset + len > totalBytes rejected
    expect(isVfsBlockChunkPacket({ ...chunk, offset: VFS_BLOCK_CHUNK_MAX_BYTES + 1 }, ROOM_1)).toBe(false);
    // Empty slice on non-empty totalBytes rejected
    expect(isVfsBlockChunkPacket({ ...chunk, data: '' }, ROOM_1)).toBe(false);
    // Invalid base64 rejected
    expect(isVfsBlockChunkPacket({ ...chunk, data: 'not*valid*b64!' }, ROOM_1)).toBe(false);
    // Unknown kind rejected
    expect(isVfsPacket({ kind: 'vfs-unknown', v: 1, roomId: ROOM_1 }, ROOM_1)).toBe(false);
  });

  test('chunkVfsOpsPages enforces <= 14 KB UTF-8 JSON and <= 64 records/page', async () => {
    expect(chunkVfsOpsPages(ROOM_1, DEV_A, [])).toEqual([]);

    // 70 small records -> split across pages with <= 64 records AND <= 14,000 B each
    const smallRecs: VfsRecordPacket[] = [];
    for (let i = 1; i <= 70; i++) {
      smallRecs.push(await makeRecordPacket({ seq: i, payloadBytes: utf8Bytes(`{"i":${i}}`) }));
    }
    const pages = chunkVfsOpsPages(ROOM_1, DEV_A, smallRecs, {
      cursorOf: r => `c:${r.seq}`,
    });
    expect(pages.length).toBeGreaterThanOrEqual(2);
    const flattened: number[] = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      expect(isVfsOpsPacket(p, ROOM_1)).toBe(true);
      expect(p.records.length).toBeLessThanOrEqual(VFS_OPS_MAX_RECORDS);
      expect(utf8Bytes(JSON.stringify(p)).byteLength).toBeLessThanOrEqual(VFS_OPS_MAX_BYTES);
      expect(p.more).toBe(i < pages.length - 1);
      if (i < pages.length - 1) {
        expect(p.nextCursor).toBe(`c:${p.records.at(-1)!.seq}`);
      } else {
        expect(p.nextCursor).toBeUndefined();
      }
      flattened.push(...p.records.map(r => r.seq));
    }
    expect(flattened).toEqual(smallRecs.map(r => r.seq));

    // Exact maxRecords split when byte budget allows > maxRecords
    const tinyPages = chunkVfsOpsPages(ROOM_1, DEV_A, smallRecs.slice(0, 7), {
      maxRecords: 3,
      hasMore: true,
      nextCursor: 'tail-cursor',
    });
    expect(tinyPages.map(p => p.records.length)).toEqual([3, 3, 1]);
    expect(tinyPages[0].more).toBe(true);
    expect(tinyPages[1].more).toBe(true);
    expect(tinyPages[2].more).toBe(true);
    expect(tinyPages[2].nextCursor).toBe('tail-cursor');

    // Byte-bound split on ~4 KB records -> at most 2-3 records per page, all <= 14,000 B
    const bigRecs: VfsRecordPacket[] = [];
    for (let i = 1; i <= 5; i++) {
      bigRecs.push(await makeRecordPacket({ seq: i, payloadBytes: new Uint8Array(3_500).fill(i) }));
    }
    const bigPages = chunkVfsOpsPages(ROOM_1, DEV_A, bigRecs);
    expect(bigPages.length).toBeGreaterThanOrEqual(2);
    for (const p of bigPages) {
      expect(isVfsOpsPacket(p, ROOM_1)).toBe(true);
      expect(utf8Bytes(JSON.stringify(p)).byteLength).toBeLessThanOrEqual(VFS_OPS_MAX_BYTES);
    }

    // Single record exceeding maxBytes fails closed with VFS_LIMIT_EXCEEDED
    const tooBigRec = await makeRecordPacket({ payloadBytes: new Uint8Array(11_000).fill(0xaa) });
    expectVfsErrorSync(() => chunkVfsOpsPages(ROOM_1, DEV_A, [tooBigRec]), 'VFS_LIMIT_EXCEEDED');
  });

  test('computeVfsFrontierHash is deterministic, order-invariant, and duplicate-invariant', async () => {
    const emptyA = await computeVfsFrontierHash([]);
    const emptyB = await computeVfsFrontierHash(new Set());
    expect(emptyA).toBe(emptyB);
    expect(emptyA).toMatch(/^[a-f0-9]{64}$/);

    const h1 = await computeVfsFrontierHash([CID_C, CID_A, CID_B]);
    const h2 = await computeVfsFrontierHash([CID_A, CID_B, CID_C]);
    const h3 = await computeVfsFrontierHash([CID_B, CID_A, CID_B, CID_C, CID_A]);
    const hOther = await computeVfsFrontierHash([CID_A, CID_B]);
    expect(h1).toBe(h2);
    expect(h1).toBe(h3);
    expect(h1).not.toBe(hOther);
    expect(h1).not.toBe(emptyA);

    await expectVfsErrorAsync(computeVfsFrontierHash(['not-hex-cid']), 'VFS_INVALID_ENVELOPE');
  });

  test('assertVfsRelaySafeOptions and VFS_RELAY_SEND_OPTS forbid hold:true and non-empty wake', () => {
    expect(Object.isFrozen(VFS_RELAY_SEND_OPTS)).toBe(true);
    expect(VFS_RELAY_SEND_OPTS.hold).toBe(false);
    expect(VFS_RELAY_SEND_OPTS.wake).toBeUndefined();

    // Safe shapes
    assertVfsRelaySafeOptions(VFS_RELAY_SEND_OPTS);
    assertVfsRelaySafeOptions(undefined);
    assertVfsRelaySafeOptions(null);
    assertVfsRelaySafeOptions({});
    assertVfsRelaySafeOptions({ hold: false });
    assertVfsRelaySafeOptions({ wake: [] });
    assertVfsRelaySafeOptions({ hold: false, wake: undefined });

    // Forbidden shapes
    expectVfsErrorSync(() => assertVfsRelaySafeOptions({ hold: true }), 'VFS_INVALID_ENVELOPE');
    expectVfsErrorSync(() => assertVfsRelaySafeOptions({ hold: 1 }), 'VFS_INVALID_ENVELOPE');
    expectVfsErrorSync(() => assertVfsRelaySafeOptions({ wake: ['member-1'] }), 'VFS_INVALID_ENVELOPE');
    expectVfsErrorSync(() => assertVfsRelaySafeOptions({ wake: true }), 'VFS_INVALID_ENVELOPE');
    expectVfsErrorSync(() => assertVfsRelaySafeOptions({ wake: 'member-1' }), 'VFS_INVALID_ENVELOPE');
    expectVfsErrorSync(() => assertVfsRelaySafeOptions({ hold: true, wake: ['member-1'] }), 'VFS_INVALID_ENVELOPE');
  });
});

describe('VFS Relay Pacing, Edit Coalescing & Sync Tracking (pacing.ts)', () => {
  test('VfsRelayBudget enforces 48 frames/min, 900 KiB/min, lane sub-caps, rate-limit backoff, and chat yield', () => {
    let now = 100_000;
    let chatQueued = false;
    const budget = new VfsRelayBudget({
      now: () => now,
      random: () => 0.5, // jitterFactor = 1.0
      chatPriorityPending: () => chatQueued,
    });

    expect(budget.maxFramesPerMin).toBe(VFS_RELAY_MAX_FRAMES_PER_MIN);
    expect(budget.maxBytesPerMin).toBe(VFS_RELAY_MAX_BYTES_PER_MIN);

    // 1) Frame cap: 48 small frames allowed, 49th rejected until oldest expires
    for (let i = 0; i < VFS_RELAY_MAX_FRAMES_PER_MIN; i++) {
      expect(budget.consume(1_000, now)).toBe(true);
      now += 100;
    }
    expect(budget.canSend(1_000, now)).toBe(false);
    expect(budget.consume(1_000, now)).toBe(false);
    const waitFrames = budget.nextAvailableMs(1_000, now);
    expect(waitFrames).toBe(100_000 + 60_000 - now);

    // Advancing past expiry frees slot
    now += waitFrames;
    expect(budget.canSend(1_000, now)).toBe(true);
    expect(budget.nextAvailableMs(1_000, now)).toBe(0);

    // 2) Byte cap: fresh window, 900 KiB total ceiling
    now += 120_000;
    const chunkBytes = 30 * 1024; // 30 * 30 KiB = 900 KiB exactly
    for (let i = 0; i < 30; i++) {
      expect(budget.consume(chunkBytes, now)).toBe(true);
      now += 50;
    }
    expect(budget.stats(now).bytesUsed).toBe(VFS_RELAY_MAX_BYTES_PER_MIN);
    expect(budget.canSend(1, now)).toBe(false);
    expect(budget.nextAvailableMs(1, now)).toBeGreaterThan(0);
    // Single frame larger than entire window cap is never sendable
    expect(budget.canSend(VFS_RELAY_MAX_BYTES_PER_MIN + 1, now)).toBe(false);
    expect(budget.nextAvailableMs(VFS_RELAY_MAX_BYTES_PER_MIN + 1, now)).toBe(Infinity);

    // 3) Chat priority yield pauses VFS immediately even with empty window
    now += 120_000;
    expect(budget.canSend(512, now)).toBe(true);
    chatQueued = true;
    expect(budget.canSend(512, now)).toBe(false);
    expect(budget.consume(512, now)).toBe(false);
    expect(budget.nextAvailableMs(512, now)).toBe(budget.chatPriorityYieldMs);
    expect(budget.stats(now).chatYielding).toBe(true);
    chatQueued = false;
    expect(budget.canSend(512, now)).toBe(true);

    // 4) Lane sub-caps: ops <= 30, block <= 18
    for (let i = 0; i < VFS_RELAY_MAX_OPS_FRAMES_PER_MIN; i++) {
      expect(budget.consume(100, now, 'ops')).toBe(true);
    }
    expect(budget.canSend(100, now, 'ops')).toBe(false);
    // Block lane still has its 18-frame budget available!
    for (let i = 0; i < VFS_RELAY_MAX_BLOCK_FRAMES_PER_MIN; i++) {
      expect(budget.consume(100, now, 'block')).toBe(true);
    }
    expect(budget.canSend(100, now, 'block')).toBe(false);

    // 5) Rate-limit backoff escalates 2s -> 5s -> 15s and clears after accepted send
    now += 120_000;
    expect(budget.noteRateLimited(now)).toBe(2_000);
    expect(budget.canSend(100, now)).toBe(false);
    expect(budget.nextAvailableMs(100, now)).toBe(2_000);
    now += 2_000;
    expect(budget.noteRateLimited(now)).toBe(5_000);
    now += 5_000;
    expect(budget.noteRateLimited(now)).toBe(15_000);
    now += 15_000;
    expect(budget.consume(100, now)).toBe(true);
    // Streak reset after successful consume
    expect(budget.noteRateLimited(now)).toBe(2_000);
  });

  test('VfsEditCoalescer coalesces per-node (300ms WebRTC / 1000ms Relay), caps at 2000ms max window, and flushes on commit/revert/close', async () => {
    let now = 1_000;
    let nextTimerId = 1;
    const timers = new Map<number, { fireAt: number; fn: () => void }>();
    const flushes: { nodeId: string; edits: string[]; reason: VfsFlushReason }[] = [];

    const advance = async (ms: number) => {
      now += ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.fireAt <= now)
          .sort((a, b) => a[1].fireAt - b[1].fireAt);
        if (due.length === 0) break;
        const [id, t] = due[0];
        timers.delete(id);
        t.fn();
        await Promise.resolve();
      }
    };

    const coalescer = new VfsEditCoalescer<string>({
      transport: 'webrtc',
      now: () => now,
      setTimer: (fn, ms) => {
        const id = nextTimerId++;
        timers.set(id, { fireAt: now + ms, fn });
        return id;
      },
      clearTimer: handle => {
        timers.delete(handle as number);
      },
      onFlush: (nodeId, edits, reason) => {
        flushes.push({ nodeId, edits, reason });
      },
    });

    expect(coalescer.intervalMs).toBe(VFS_COALESCE_WEBRTC_MS);

    // Rapid keystrokes on WebRTC coalesce and flush after 300ms quiet period
    coalescer.enqueue('doc-1', 'a');
    await advance(150);
    coalescer.enqueue('doc-1', 'b');
    expect(flushes.length).toBe(0);
    await advance(299);
    expect(flushes.length).toBe(0);
    await advance(1);
    expect(flushes).toEqual([{ nodeId: 'doc-1', edits: ['a', 'b'], reason: 'debounce' }]);

    // Relay mode uses 1,000 ms debounce interval
    coalescer.setTransport('relay');
    expect(coalescer.intervalMs).toBe(VFS_COALESCE_RELAY_MS);
    coalescer.enqueue('doc-1', 'r1');
    await advance(500);
    expect(flushes.length).toBe(1);
    await advance(500);
    expect(flushes[1]).toEqual({ nodeId: 'doc-1', edits: ['r1'], reason: 'debounce' });

    // Continuous typing every 200ms on WebRTC MUST flush at 2,000ms max batch window
    coalescer.setTransport('webrtc');
    const batchStart = now;
    for (let step = 0; step < 10; step++) {
      coalescer.enqueue('doc-2', `k${step}`);
      if (step < 9) await advance(200);
    }
    // 9 * 200ms = 1800ms elapsed; remaining max window is 200ms (less than 300ms debounce)
    await advance(200);
    expect(now - batchStart).toBe(VFS_COALESCE_MAX_BATCH_WINDOW_MS);
    expect(flushes[2]).toEqual({
      nodeId: 'doc-2',
      edits: ['k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9'],
      reason: 'max-window',
    });

    // Immediate flush on commit, revert, and close
    coalescer.enqueue('doc-1', 'c1');
    await coalescer.flushCommit('doc-1');
    expect(flushes[3]).toEqual({ nodeId: 'doc-1', edits: ['c1'], reason: 'commit' });

    coalescer.enqueue('doc-1', 'rev1');
    await coalescer.flushRevert('doc-1');
    expect(flushes[4]).toEqual({ nodeId: 'doc-1', edits: ['rev1'], reason: 'revert' });

    coalescer.enqueue('doc-1', 'final1');
    coalescer.enqueue('doc-2', 'final2');
    expect(coalescer.pendingCount()).toBe(2);
    await coalescer.close();
    expect(flushes.slice(5)).toEqual([
      { nodeId: 'doc-1', edits: ['final1'], reason: 'close' },
      { nodeId: 'doc-2', edits: ['final2'], reason: 'close' },
    ]);
    expect(coalescer.hasPending()).toBe(false);
    expectVfsErrorSync(() => coalescer.enqueue('doc-1', 'after-close'), 'VFS_STORAGE_CLOSED');
  });

  test('VfsSyncTracker prevents frontierHash loops, enforces maxRounds, handles retryAfterMs, and applies exponential timeout backoff', () => {
    let now = 50_000;
    const tracker = new VfsSyncTracker({
      maxRounds: 3,
      roundTimeoutMs: 5_000,
      baseRetryMs: 1_000,
      maxBackoffMs: 10_000,
      maxTimeouts: 3,
      now: () => now,
    });

    const F1 = '1'.repeat(64);
    const F2 = '2'.repeat(64);

    // Initial sync eligibility & in-flight deduplication
    expect(tracker.shouldSendHave('peer-1', F1, now)).toBe(true);
    tracker.markHaveSent('peer-1', F1, now);
    expect(tracker.shouldSendHave('peer-1', F1, now)).toBe(false);
    expect(tracker.getPeerState('peer-1')?.inFlight).toBe(true);

    // Matching frontierHash stops ping-pong sync loops immediately
    expect(tracker.recordRemoteHave('peer-1', F1, F1)).toEqual({ matched: true });
    expect(tracker.shouldSendHave('peer-1', F1, now)).toBe(false);

    // Local frontier advances -> peer becomes eligible again
    tracker.notifyFrontierChanged(F2);
    expect(tracker.shouldSendHave('peer-1', F2, now)).toBe(true);

    // Multi-round pagination up to maxRounds (3)
    tracker.markHaveSent('peer-1', F2, now);
    expect(
      tracker.recordOpsReceived('peer-1', { more: true, nextCursor: 'cur-1', currentFrontierHash: F2 }, now),
    ).toEqual({ action: 'continue', cursor: 'cur-1' });
    tracker.markHaveSent('peer-1', F2, now);
    expect(
      tracker.recordOpsReceived('peer-1', { more: true, nextCursor: 'cur-2', currentFrontierHash: F2 }, now),
    ).toEqual({ action: 'continue', cursor: 'cur-2' });
    // Retry-after hint holds cursor and blocks until elapsed
    tracker.markHaveSent('peer-1', F2, now);
    const waitDecision = tracker.recordOpsReceived(
      'peer-1',
      { more: true, nextCursor: 'cur-2', retryAfterMs: 3_000, currentFrontierHash: F2 },
      now,
    );
    expect(waitDecision).toEqual({ action: 'wait', retryAfterMs: 3_000, cursor: 'cur-2' });
    expect(tracker.shouldSendHave('peer-1', F2, now + 1_000)).toBe(false);
    // roundsUsed === 3 === maxRounds -> blocked until reset or new frontier
    expect(tracker.shouldSendHave('peer-1', F2, now + 3_000)).toBe(false);

    // Exponential backoff on unanswered round timeouts + pause after maxTimeouts
    tracker.resetPeer('peer-2');
    tracker.markHaveSent('peer-2', F1, now);
    expect(tracker.collectTimeouts(now + 4_999)).toEqual([]);

    // Timeout #1 -> 1,000 ms backoff
    now += 5_000;
    expect(tracker.collectTimeouts(now)).toEqual([
      { peerId: 'peer-2', consecutiveTimeouts: 1, paused: false, retryAfterMs: 1_000 },
    ]);
    expect(tracker.shouldSendHave('peer-2', F1, now + 999)).toBe(false);
    expect(tracker.shouldSendHave('peer-2', F1, now + 1_000)).toBe(true);

    // Timeout #2 -> 2,000 ms backoff
    now += 1_000;
    tracker.markHaveSent('peer-2', F1, now);
    now += 5_000;
    expect(tracker.collectTimeouts(now)).toEqual([
      { peerId: 'peer-2', consecutiveTimeouts: 2, paused: false, retryAfterMs: 2_000 },
    ]);
    expect(tracker.shouldSendHave('peer-2', F1, now + 1_999)).toBe(false);
    expect(tracker.shouldSendHave('peer-2', F1, now + 2_000)).toBe(true);

    // Timeout #3 == maxTimeouts -> paused until resetPeer (reconnect)
    now += 2_000;
    tracker.markHaveSent('peer-2', F1, now);
    now += 5_000;
    expect(tracker.collectTimeouts(now)).toEqual([
      { peerId: 'peer-2', consecutiveTimeouts: 3, paused: true, retryAfterMs: Infinity },
    ]);
    expect(tracker.shouldSendHave('peer-2', F1, now + 60_000)).toBe(false);

    // Reconnect resets peer cleanly
    tracker.resetPeer('peer-2');
    expect(tracker.shouldSendHave('peer-2', F1, now + 60_000)).toBe(true);

    // Repeating an identical differing remoteFrontierHash after done does NOT re-trigger a sync loop,
    // while a brand-new remoteFrontierHash DOES reopen sync!
    const F3 = '3'.repeat(64);
    const F4 = '4'.repeat(64);
    tracker.recordRemoteHave('peer-3', F3, F1);
    tracker.markHaveSent('peer-3', F1, now);
    expect(tracker.recordOpsReceived('peer-3', { more: false, currentFrontierHash: F1 }, now)).toEqual({ action: 'done' });
    expect(tracker.shouldSendHave('peer-3', F1, now)).toBe(false);
    // Same remote frontier echoed again -> still no loop
    expect(tracker.recordRemoteHave('peer-3', F3, F1)).toEqual({ matched: false });
    expect(tracker.shouldSendHave('peer-3', F1, now)).toBe(false);
    // Peer advances to F4 -> reopens sync cleanly
    expect(tracker.recordRemoteHave('peer-3', F4, F1)).toEqual({ matched: false });
    expect(tracker.shouldSendHave('peer-3', F1, now)).toBe(true);
  });
});
