import { describe, expect, test } from 'bun:test';
import { base64, deviceId, encode, verify } from '../protocol';
import { base64ToBytes, bytesToBase64, generateEncKeyPair, type SignFn } from '../relay-crypto';
import {
  VFS_ENVELOPE_HEADER_BYTES,
  VFS_ENVELOPE_OVERHEAD_BYTES,
  VFS_FLAG_DEFLATE_RAW,
  VFS_KEY_PREFIX,
  VFS_OP_HKDF_DOMAIN,
  VFS_OP_MAX_PLAINTEXT_BYTES,
  VfsError,
  VfsObjKind,
  vfsBmetaKey,
  vfsCommitKey,
  vfsEpochKey,
  vfsMetaKey,
  vfsNodeHeadKey,
  vfsObjKey,
  vfsOpKey,
  vfsOpPrefix,
  vfsReqKey,
  vfsSnapKey,
  vfsSyncKey,
  type VfsErrorCode,
  type VfsObjKindValue,
} from './constants';
import {
  buildVfsEnvelopeAad,
  computeCid,
  concatBytes,
  constantTimeEqual,
  deflateSnapPayload,
  deriveVfsDeviceSealKey,
  encodeSignedVfsPayload,
  generateVfsKey,
  inflateSnapPayload,
  isCanonicalP256LowSSignature,
  opBindingKey,
  openSignedVfsOp,
  openVfsEnvelope,
  parseVfsEnvelopeHeader,
  sealSignedVfsOp,
  sealVfsEnvelope,
  signVfsPayload,
  utf8Bytes,
  verifyVfsPayload,
  vfsSignaturePayload,
} from './envelope';

const ROOM_A = '11111111-1111-4111-8111-111111111111';
const ROOM_B = '22222222-2222-4222-8222-222222222222';
const NODE_A = '33333333-3333-4333-8333-333333333333';
const NODE_B = '44444444-4444-4444-8444-444444444444';
const ACTOR_A = '55555555-5555-4555-8555-555555555555';
const REQ_A = '66666666-6666-4666-8666-666666666666';
const OP_ID_1 = '77777777-7777-4777-8777-777777777777';
const OP_ID_2 = '88888888-8888-4888-8888-888888888888';
const DEV_HEX = 'a'.repeat(64);
const CID_HEX = 'b'.repeat(64);
const OP_HASH_1 = '0123456789abcdef'.repeat(4);
const OP_HASH_2 = 'fedcba9876543210'.repeat(4);

async function makeSigner() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = base64(await crypto.subtle.exportKey('raw', keys.publicKey));
  const id = await deviceId(publicKey);
  const sign: SignFn = async value =>
    base64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, encode(value)));
  return { id, publicKey, keys, sign };
}

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

describe('VFS constants & opaque KV key builders', () => {
  test('builds canonical lexicographically ordered keys without plaintext paths', () => {
    expect(vfsMetaKey(ROOM_A)).toBe(`${VFS_KEY_PREFIX}${ROOM_A}:meta`);
    expect(vfsEpochKey(ROOM_A, 1)).toBe(`${VFS_KEY_PREFIX}${ROOM_A}:epoch:00000001`);
    expect(vfsEpochKey(ROOM_A, 16)).toBe(`${VFS_KEY_PREFIX}${ROOM_A}:epoch:00000010`);
    expect(vfsEpochKey(ROOM_A, 2) < vfsEpochKey(ROOM_A, 16)).toBe(true);

    expect(vfsNodeHeadKey(ROOM_A, NODE_A)).toBe(`${VFS_KEY_PREFIX}${ROOM_A}:node:${NODE_A}:head`);

    const op9 = vfsOpKey(ROOM_A, NODE_A, DEV_HEX, 9, OP_HASH_1);
    const op10 = vfsOpKey(ROOM_A, NODE_A, DEV_HEX, 10, OP_HASH_1);
    const op9Equiv = vfsOpKey(ROOM_A, NODE_A, DEV_HEX, 9, OP_HASH_2);
    expect(op9.startsWith(vfsOpPrefix(ROOM_A, NODE_A, DEV_HEX))).toBe(true);
    expect(op9 < op10).toBe(true);
    // Equivocating ops at same (deviceId, seq) keep distinct keys via <opHash8>.
    expect(op9).not.toBe(op9Equiv);

    expect(vfsSnapKey(ROOM_A, NODE_A, 1000, CID_HEX) < vfsSnapKey(ROOM_A, NODE_A, 2000, CID_HEX)).toBe(true);
    expect(vfsObjKey(ROOM_A, CID_HEX)).toBe(`${VFS_KEY_PREFIX}${ROOM_A}:obj:${CID_HEX}`);
    expect(vfsBmetaKey(ROOM_A, CID_HEX)).toBe(`${VFS_KEY_PREFIX}${ROOM_A}:bmeta:${CID_HEX}`);
    expect(vfsCommitKey(ROOM_A, 1700000000000, OP_ID_1)).toMatch(/^vfs:v1:[a-f0-9-]+:commit:[a-f0-9]{12}:[a-f0-9]{16}$/);
    expect(vfsSyncKey(ROOM_A, DEV_HEX)).toBe(`${VFS_KEY_PREFIX}${ROOM_A}:sync:${DEV_HEX}`);
    expect(vfsReqKey(ROOM_A, ACTOR_A, REQ_A)).toBe(`${VFS_KEY_PREFIX}${ROOM_A}:req:${ACTOR_A}:${REQ_A}`);
  });

  test('rejects invalid UUIDs, non-hex IDs, zero epoch/seq, and path-like strings', () => {
    expect(() => vfsMetaKey('../etc/passwd')).toThrow(VfsError);
    expect(() => vfsEpochKey(ROOM_A, 0)).toThrow(VfsError);
    expect(() => vfsOpKey(ROOM_A, NODE_A, 'not-hex', 1, OP_HASH_1)).toThrow(VfsError);
    expect(() => vfsOpKey(ROOM_A, NODE_A, DEV_HEX, 0, OP_HASH_1)).toThrow(VfsError);
    expect(() => vfsObjKey(ROOM_A, 'short')).toThrow(VfsError);
  });
});

describe('VfsEnvelopeV1 binary format & AEAD', () => {
  test('round-trips every VfsObjKind with exact 56-byte overhead', async () => {
    const rk = generateVfsKey();
    const bk = generateVfsKey();
    const sealKey = generateVfsKey();

    const cases: { kind: VfsObjKindValue; epoch: number; key: Uint8Array; bindingKey: string; flags?: number; payload: Uint8Array }[] = [
      { kind: VfsObjKind.DocOp, epoch: 1, key: rk, bindingKey: opBindingKey(DEV_HEX, 1, OP_ID_1), payload: utf8Bytes('{"op":"doc"}') },
      { kind: VfsObjKind.Snap, epoch: 0, key: sealKey, bindingKey: vfsSnapKey(ROOM_A, NODE_A, 100, CID_HEX), payload: utf8Bytes('snap-raw') },
      { kind: VfsObjKind.Snap, epoch: 1, key: rk, bindingKey: vfsSnapKey(ROOM_A, NODE_A, 200, CID_HEX), flags: VFS_FLAG_DEFLATE_RAW, payload: utf8Bytes('snap-deflated') },
      { kind: VfsObjKind.Commit, epoch: 2, key: rk, bindingKey: opBindingKey(DEV_HEX, 2, OP_ID_2), payload: utf8Bytes('{"commit":true}') },
      { kind: VfsObjKind.TreeOp, epoch: 1, key: rk, bindingKey: opBindingKey(DEV_HEX, 3, OP_ID_1), payload: utf8Bytes('{"tree":"create"}') },
      { kind: VfsObjKind.Manifest, epoch: 1, key: rk, bindingKey: NODE_A, payload: utf8Bytes('{"chunks":[]}') },
      { kind: VfsObjKind.Chunk, epoch: 1, key: bk, bindingKey: NODE_A, payload: new Uint8Array([0, 1, 2, 255, 128, 64]) },
      { kind: VfsObjKind.DeviceLocal, epoch: 0, key: sealKey, bindingKey: vfsMetaKey(ROOM_A), payload: new Uint8Array(0) },
    ];

    for (const c of cases) {
      const sealed = await sealVfsEnvelope({
        roomId: ROOM_A,
        epoch: c.epoch,
        objKind: c.kind,
        key: c.key,
        plaintext: c.payload,
        bindingKey: c.bindingKey,
        flags: c.flags,
      });

      expect(sealed.bytes.byteLength).toBe(c.payload.byteLength + VFS_ENVELOPE_OVERHEAD_BYTES);
      expect(sealed.cid).toBe(await computeCid(sealed.bytes));
      expect(sealed.cid).toMatch(/^[a-f0-9]{64}$/);

      const parsed = parseVfsEnvelopeHeader(sealed.bytes);
      expect(parsed.version).toBe(1);
      expect(parsed.objKind).toBe(c.kind);
      expect(parsed.flags).toBe(c.flags ?? 0);
      expect(parsed.epoch).toBe(c.epoch);

      const opened = await openVfsEnvelope({
        bytes: sealed.bytes,
        roomId: ROOM_A,
        key: c.key,
        bindingKey: c.bindingKey,
        expectedObjKind: c.kind,
        expectedEpoch: c.epoch,
        expectedCid: sealed.cid,
      });
      expect(new Uint8Array(opened.plaintext)).toEqual(new Uint8Array(c.payload));
      expect(opened.cid).toBe(sealed.cid);
    }
  });

  test('deterministic CID stability for signed ops/commits vs randomized CID for CAS/local objects', async () => {
    const rk = generateVfsKey();
    const binding = opBindingKey(DEV_HEX, 42, OP_ID_1);
    const payload = utf8Bytes('{"body":{"hello":"world"},"signature":"sig"}');

    for (const kind of [VfsObjKind.DocOp, VfsObjKind.Commit, VfsObjKind.TreeOp] as const) {
      const a = await sealVfsEnvelope({ roomId: ROOM_A, epoch: 1, objKind: kind, key: rk, plaintext: payload, bindingKey: binding });
      const b = await sealVfsEnvelope({ roomId: ROOM_A, epoch: 1, objKind: kind, key: rk, plaintext: payload, bindingKey: binding });
      expect(a.cid).toBe(b.cid);
      expect(a.opHash).toBe(b.opHash);
      expect(a.bytes).toEqual(b.bytes);
      expect(a.header.salt).toEqual(b.header.salt);
      expect(a.header.iv).toEqual(b.header.iv);
    }

    for (const kind of [VfsObjKind.Snap, VfsObjKind.Manifest, VfsObjKind.Chunk, VfsObjKind.DeviceLocal] as const) {
      const epoch = kind === VfsObjKind.DeviceLocal ? 0 : 1;
      const a = await sealVfsEnvelope({ roomId: ROOM_A, epoch, objKind: kind, key: rk, plaintext: payload, bindingKey: NODE_A });
      const b = await sealVfsEnvelope({ roomId: ROOM_A, epoch, objKind: kind, key: rk, plaintext: payload, bindingKey: NODE_A });
      expect(a.cid).not.toBe(b.cid);
      expect(a.header.salt).not.toEqual(b.header.salt);
      expect(a.header.iv).not.toEqual(b.header.iv);
    }
  });

  test('tampering with ANY byte (every header byte, ciphertext byte, or GCM tag byte) fails closed', async () => {
    const rk = generateVfsKey();
    const binding = opBindingKey(DEV_HEX, 7, OP_ID_1);
    const det = await sealVfsEnvelope({
      roomId: ROOM_A,
      epoch: 1,
      objKind: VfsObjKind.DocOp,
      key: rk,
      plaintext: utf8Bytes('hello vfs world'),
      bindingKey: binding,
    });

    for (let i = 0; i < det.bytes.byteLength; i++) {
      const mutated = new Uint8Array(det.bytes);
      mutated[i] ^= 0x01;
      let failed = false;
      try {
        await openVfsEnvelope({ bytes: mutated, roomId: ROOM_A, key: rk, bindingKey: binding });
      } catch (err) {
        failed = err instanceof VfsError;
      }
      expect(failed).toBe(true);
    }

    // Also test every byte of a random-IV CAS chunk.
    const bk = generateVfsKey();
    const chunk = await sealVfsEnvelope({
      roomId: ROOM_A,
      epoch: 1,
      objKind: VfsObjKind.Chunk,
      key: bk,
      plaintext: utf8Bytes('binary-chunk-data'),
      bindingKey: NODE_A,
    });
    for (let i = 0; i < chunk.bytes.byteLength; i++) {
      const mutated = new Uint8Array(chunk.bytes);
      mutated[i] ^= 0x80;
      let failed = false;
      try {
        await openVfsEnvelope({ bytes: mutated, roomId: ROOM_A, key: bk, bindingKey: NODE_A });
      } catch (err) {
        failed = err instanceof VfsError;
      }
      expect(failed).toBe(true);
    }
  });

  test('defeats insider malleability: attacker holding RK_e cannot re-encrypt with a substituted salt16', async () => {
    const rk = generateVfsKey();
    const binding = opBindingKey(DEV_HEX, 5, OP_ID_1);
    const inner = utf8Bytes('{"body":{"op":"authentic"},"signature":"' + 'A'.repeat(88) + '"}');

    // Attacker holds RK_e and tries to fabricate a valid AES-GCM ciphertext using a chosen fake salt16
    // with the correctly derived (K_op', iv') for that fake salt16, attempting to split the op's CID.
    const fakeSalt = new Uint8Array(16).fill(0x42);
    const hkdfKey = await crypto.subtle.importKey('raw', rk, 'HKDF', false, ['deriveBits']);
    const info = utf8Bytes(`${VFS_OP_HKDF_DOMAIN}${ROOM_A}|1|${VfsObjKind.DocOp}`);
    const okm = new Uint8Array(
      await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: fakeSalt, info }, hkdfKey, (32 + 12) * 8),
    );
    const fakeKey = await crypto.subtle.importKey('raw', okm.slice(0, 32), { name: 'AES-GCM' }, false, ['encrypt']);
    const fakeIv = okm.slice(32, 44);

    const header = new Uint8Array(VFS_ENVELOPE_HEADER_BYTES);
    header.set([0x4d, 0x56, 0x46, 0x53], 0);
    header[4] = 1;
    header[5] = VfsObjKind.DocOp;
    header[6] = 0;
    header[7] = 0;
    new DataView(header.buffer).setUint32(8, 1, false);
    header.set(fakeSalt, 12);
    header.set(fakeIv, 28);

    const aad = buildVfsEnvelopeAad(header, ROOM_A, binding);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: fakeIv, additionalData: aad }, fakeKey, inner));
    const malleableEnv = concatBytes(header, ct);

    await expectVfsError(
      openVfsEnvelope({ bytes: malleableEnv, roomId: ROOM_A, key: rk, bindingKey: binding }),
      'VFS_MALLEABLE_ENVELOPE',
    );
  });

  test('rejects substituted IV on deterministic op before AES-GCM with VFS_MALLEABLE_ENVELOPE', async () => {
    const rk = generateVfsKey();
    const binding = opBindingKey(DEV_HEX, 5, OP_ID_1);
    const sealed = await sealVfsEnvelope({
      roomId: ROOM_A,
      epoch: 1,
      objKind: VfsObjKind.DocOp,
      key: rk,
      plaintext: utf8Bytes('payload'),
      bindingKey: binding,
    });
    const mutated = new Uint8Array(sealed.bytes);
    mutated[28] ^= 0xff; // Flip first IV byte
    await expectVfsError(
      openVfsEnvelope({ bytes: mutated, roomId: ROOM_A, key: rk, bindingKey: binding }),
      'VFS_MALLEABLE_ENVELOPE',
    );
  });

  test('enforces cross-room, cross-epoch, cross-bindingKey, wrong-key, and expectedCid isolation', async () => {
    const rk1 = generateVfsKey();
    const rk2 = generateVfsKey();
    const binding1 = opBindingKey(DEV_HEX, 1, OP_ID_1);
    const binding2 = opBindingKey(DEV_HEX, 2, OP_ID_1);

    const sealed = await sealVfsEnvelope({
      roomId: ROOM_A,
      epoch: 1,
      objKind: VfsObjKind.DocOp,
      key: rk1,
      plaintext: utf8Bytes('secret doc edit'),
      bindingKey: binding1,
    });

    // Cross-room isolation
    await expectVfsError(
      openVfsEnvelope({ bytes: sealed.bytes, roomId: ROOM_B, key: rk1, bindingKey: binding1 }),
      'VFS_MALLEABLE_ENVELOPE', // HKDF info includes roomId -> derived IV differs immediately!
    );
    // Cross-bindingKey isolation (same room/key, swapped seq)
    await expectVfsError(
      openVfsEnvelope({ bytes: sealed.bytes, roomId: ROOM_A, key: rk1, bindingKey: binding2 }),
      'VFS_DECRYPT_FAILED',
    );
    // Wrong room key (different epoch key)
    await expectVfsError(
      openVfsEnvelope({ bytes: sealed.bytes, roomId: ROOM_A, key: rk2, bindingKey: binding1 }),
      'VFS_MALLEABLE_ENVELOPE',
    );
    // Expected epoch mismatch
    await expectVfsError(
      openVfsEnvelope({ bytes: sealed.bytes, roomId: ROOM_A, key: rk1, bindingKey: binding1, expectedEpoch: 2 }),
      'VFS_INVALID_ENVELOPE',
    );
    // Expected CID mismatch (pre-decryption)
    await expectVfsError(
      openVfsEnvelope({ bytes: sealed.bytes, roomId: ROOM_A, key: rk1, bindingKey: binding1, expectedCid: CID_HEX }),
      'VFS_INVALID_ENVELOPE',
    );

    // Random-IV chunk cross-room & cross-nodeId AAD isolation
    const chunk = await sealVfsEnvelope({
      roomId: ROOM_A,
      epoch: 1,
      objKind: VfsObjKind.Chunk,
      key: rk1,
      plaintext: utf8Bytes('chunk-bytes'),
      bindingKey: NODE_A,
    });
    await expectVfsError(
      openVfsEnvelope({ bytes: chunk.bytes, roomId: ROOM_B, key: rk1, bindingKey: NODE_A }),
      'VFS_DECRYPT_FAILED',
    );
    await expectVfsError(
      openVfsEnvelope({ bytes: chunk.bytes, roomId: ROOM_A, key: rk1, bindingKey: NODE_B }),
      'VFS_DECRYPT_FAILED',
    );
  });

  test('rejects deflate flag on non-snap object kinds and non-zero epoch on local records', async () => {
    const key = generateVfsKey();
    await expectVfsError(
      sealVfsEnvelope({
        roomId: ROOM_A,
        epoch: 1,
        objKind: VfsObjKind.Chunk,
        key,
        plaintext: utf8Bytes('x'),
        bindingKey: NODE_A,
        flags: VFS_FLAG_DEFLATE_RAW,
      }),
      'VFS_INVALID_ENVELOPE',
    );
    await expectVfsError(
      sealVfsEnvelope({
        roomId: ROOM_A,
        epoch: 1,
        objKind: VfsObjKind.DeviceLocal,
        key,
        plaintext: utf8Bytes('x'),
        bindingKey: vfsMetaKey(ROOM_A),
      }),
      'VFS_INVALID_ENVELOPE',
    );
  });
});

describe('VFS P-256 signed op/commit helpers & device seal key', () => {
  test('sealSignedVfsOp / openSignedVfsOp round-trip and reject forgery or outer/inner mismatch', async () => {
    const alice = await makeSigner();
    const bob = await makeSigner();
    const rk = generateVfsKey();

    const body = {
      kind: 'vfs-doc-op' as const,
      v: 1 as const,
      roomId: ROOM_A,
      opId: OP_ID_1,
      deviceId: alice.id,
      memberId: ACTOR_A,
      epoch: 1,
      seq: 1,
      lamport: 1,
      at: 1_750_000_000_000,
      nodeId: NODE_A,
      parents: [],
      counterStart: 0,
      ops: [{ t: 'ins', parent: null, side: 'R', text: 'Hello' }],
    };

    const sealed = await sealSignedVfsOp({
      body,
      objKind: VfsObjKind.DocOp,
      roomKey: rk,
      sign: alice.sign,
    });

    const opened = await openSignedVfsOp({
      bytes: sealed.envelope.bytes,
      roomId: ROOM_A,
      epoch: 1,
      objKind: VfsObjKind.DocOp,
      nodeId: NODE_A,
      deviceId: alice.id,
      seq: 1,
      opId: OP_ID_1,
      roomKey: rk,
      expectedCid: sealed.cid,
      resolvePublicKey: b => (b.deviceId === alice.id ? alice.publicKey : undefined),
    });

    expect(opened.body).toEqual(body);
    expect(opened.cid).toBe(sealed.cid);
    expect(opened.opHash).toBe(sealed.opHash);

    // Wrong signer public key fails signature check.
    await expectVfsError(
      openSignedVfsOp({
        bytes: sealed.envelope.bytes,
        roomId: ROOM_A,
        epoch: 1,
        objKind: VfsObjKind.DocOp,
        nodeId: NODE_A,
        deviceId: alice.id,
        seq: 1,
        opId: OP_ID_1,
        roomKey: rk,
        resolvePublicKey: () => bob.publicKey,
      }),
      'VFS_INVALID_SIGNATURE',
    );

    // Cross-protocol signature (signed raw without VFS_SIG_DOMAIN) must not verify.
    const rawSig = await alice.sign(body);
    expect(await verifyVfsPayload({ body, signature: rawSig }, alice.publicKey)).toBe(false);

    // Domain-separated signature verifies regardless of input key insertion order.
    const reordered = { seq: 1, roomId: ROOM_A, opId: OP_ID_1 };
    const signedReordered = await signVfsPayload(reordered, alice.sign);
    expect(
      await verifyVfsPayload({ body: { opId: OP_ID_1, roomId: ROOM_A, seq: 1 }, signature: signedReordered.signature }, alice.publicKey),
    ).toBe(true);
  });

  test('enforces ECDSA P-256 low-S canonicalization and defeats (r, n - s) malleability CID splitting', async () => {
    const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    const alice = await makeSigner();
    const rk = generateVfsKey();

    // 1. signVfsPayload ALWAYS canonicalizes to low-S across many signatures and verifies cleanly.
    for (let i = 0; i < 24; i++) {
      const signed = await signVfsPayload({ i, roomId: ROOM_A }, alice.sign);
      expect(isCanonicalP256LowSSignature(signed.signature)).toBe(true);
      expect(await verifyVfsPayload(signed, alice.publicKey)).toBe(true);
    }

    // 2. Regression test: flip s -> n - s on a valid signed op, re-seal with RK_e, and verify rejection.
    const body = {
      kind: 'vfs-doc-op' as const,
      v: 1 as const,
      roomId: ROOM_A,
      opId: OP_ID_1,
      deviceId: alice.id,
      memberId: ACTOR_A,
      epoch: 1,
      seq: 1,
      lamport: 1,
      at: 1_750_000_000_000,
      nodeId: NODE_A,
      parents: [],
      counterStart: 0,
      ops: [{ t: 'ins', parent: null, side: 'R', text: 'Low-S only' }],
    };

    const sealed = await sealSignedVfsOp({
      body,
      objKind: VfsObjKind.DocOp,
      roomKey: rk,
      sign: alice.sign,
    });
    expect(isCanonicalP256LowSSignature(sealed.signed.signature)).toBe(true);

    // Compute the malleable high-S twin (r, n - s).
    const sigRaw = base64ToBytes(sealed.signed.signature);
    let s = 0n;
    for (let i = 32; i < 64; i++) s = (s << 8n) | BigInt(sigRaw[i]!);
    const highS = P256_N - s;
    const malleableRaw = new Uint8Array(sigRaw);
    let v = highS;
    for (let i = 63; i >= 32; i--) {
      malleableRaw[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    const highSSig = bytesToBase64(malleableRaw);
    expect(highSSig).not.toBe(sealed.signed.signature);

    // Confirm raw WebCrypto verify WOULD accept the high-S twin (showing why low-S enforcement is critical).
    expect(await verify(alice.publicKey, vfsSignaturePayload(sealed.signed.body), highSSig)).toBe(true);

    // verifyVfsPayload MUST reject high-S BEFORE WebCrypto verify.
    expect(await verifyVfsPayload({ body: sealed.signed.body, signature: highSSig }, alice.publicKey)).toBe(false);

    // Insider holding RK_e re-seals with the high-S twin to fabricate a distinct CID/opHash.
    const binding = opBindingKey(alice.id, 1, OP_ID_1);
    const malleableInner = encodeSignedVfsPayload({ body: sealed.signed.body, signature: highSSig });
    const reEncrypted = await sealVfsEnvelope({
      roomId: ROOM_A,
      epoch: 1,
      objKind: VfsObjKind.DocOp,
      key: rk,
      plaintext: malleableInner,
      bindingKey: binding,
    });
    expect(reEncrypted.cid).not.toBe(sealed.cid);
    expect(reEncrypted.opHash).not.toBe(sealed.opHash);

    await expectVfsError(
      openSignedVfsOp({
        bytes: reEncrypted.bytes,
        roomId: ROOM_A,
        epoch: 1,
        objKind: VfsObjKind.DocOp,
        nodeId: NODE_A,
        deviceId: alice.id,
        seq: 1,
        opId: OP_ID_1,
        roomKey: rk,
        resolvePublicKey: () => alice.publicKey,
      }),
      'VFS_MALLEABLE_ENVELOPE',
    );

    // Non-canonical base64 padding bits on the 86th char (same 64 bytes -> different string) also rejected!
    const b64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const idx85 = b64Alphabet.indexOf(sealed.signed.signature[85]!);
    const nonCanonSig = `${sealed.signed.signature.slice(0, 85)}${b64Alphabet[idx85 ^ 1]!}${sealed.signed.signature.slice(86)}`;
    expect(base64ToBytes(nonCanonSig)).toEqual(sigRaw);
    expect(await verifyVfsPayload({ body: sealed.signed.body, signature: nonCanonSig }, alice.publicKey)).toBe(false);
    const nonCanonEnv = await sealVfsEnvelope({
      roomId: ROOM_A,
      epoch: 1,
      objKind: VfsObjKind.DocOp,
      key: rk,
      plaintext: encodeSignedVfsPayload({ body: sealed.signed.body, signature: nonCanonSig }),
      bindingKey: binding,
    });
    await expectVfsError(
      openSignedVfsOp({
        bytes: nonCanonEnv.bytes,
        roomId: ROOM_A,
        epoch: 1,
        objKind: VfsObjKind.DocOp,
        nodeId: NODE_A,
        deviceId: alice.id,
        seq: 1,
        opId: OP_ID_1,
        roomKey: rk,
        resolvePublicKey: () => alice.publicKey,
      }),
      'VFS_MALLEABLE_ENVELOPE',
    );

    // Zero r / s scalars rejected as malleable before WebCrypto verify.
    const zeroSig = bytesToBase64(new Uint8Array(64));
    expect(await verifyVfsPayload({ body: sealed.signed.body, signature: zeroSig }, alice.publicKey)).toBe(false);
  });

  test('binds outer nodeId and objKind/body.kind across DocOp, TreeOp, and Commit', async () => {
    const alice = await makeSigner();
    const rk = generateVfsKey();

    const docBody = {
      kind: 'vfs-doc-op' as const,
      v: 1 as const,
      roomId: ROOM_A,
      opId: OP_ID_1,
      deviceId: alice.id,
      memberId: ACTOR_A,
      epoch: 1,
      seq: 1,
      lamport: 1,
      at: 1_750_000_000_000,
      nodeId: NODE_A,
      parents: [],
      counterStart: 0,
      ops: [{ t: 'ins', parent: null, side: 'R', text: 'Doc A only' }],
    };

    // Sealing with mismatched objKind vs body.kind is rejected.
    await expectVfsError(
      sealSignedVfsOp({ body: docBody, objKind: VfsObjKind.TreeOp, roomKey: rk, sign: alice.sign }),
      'VFS_INVALID_ENVELOPE',
    );
    await expectVfsError(
      sealSignedVfsOp({ body: docBody, objKind: VfsObjKind.Commit, roomKey: rk, sign: alice.sign }),
      'VFS_INVALID_ENVELOPE',
    );

    const sealedDoc = await sealSignedVfsOp({
      body: docBody,
      objKind: VfsObjKind.DocOp,
      roomKey: rk,
      sign: alice.sign,
    });

    // Opening DocOp for NODE_A with outer nodeId = NODE_B MUST fail!
    await expectVfsError(
      openSignedVfsOp({
        bytes: sealedDoc.envelope.bytes,
        roomId: ROOM_A,
        epoch: 1,
        objKind: VfsObjKind.DocOp,
        nodeId: NODE_B,
        deviceId: alice.id,
        seq: 1,
        opId: OP_ID_1,
        roomKey: rk,
        resolvePublicKey: () => alice.publicKey,
      }),
      'VFS_INVALID_ENVELOPE',
    );

    // Omitting nodeId when opening a DocOp MUST fail!
    await expectVfsError(
      openSignedVfsOp({
        bytes: sealedDoc.envelope.bytes,
        roomId: ROOM_A,
        epoch: 1,
        objKind: VfsObjKind.DocOp,
        deviceId: alice.id,
        seq: 1,
        opId: OP_ID_1,
        roomKey: rk,
        resolvePublicKey: () => alice.publicKey,
      }),
      'VFS_INVALID_ENVELOPE',
    );

    // Manually sealing a signed vfs-doc-op inside a TreeOp envelope fails openSignedVfsOp!
    const mismatchEnv = await sealVfsEnvelope({
      roomId: ROOM_A,
      epoch: 1,
      objKind: VfsObjKind.TreeOp,
      key: rk,
      plaintext: encodeSignedVfsPayload(sealedDoc.signed),
      bindingKey: opBindingKey(alice.id, 1, OP_ID_1),
    });
    await expectVfsError(
      openSignedVfsOp({
        bytes: mismatchEnv.bytes,
        roomId: ROOM_A,
        epoch: 1,
        objKind: VfsObjKind.TreeOp,
        nodeId: NODE_A,
        deviceId: alice.id,
        seq: 1,
        opId: OP_ID_1,
        roomKey: rk,
        resolvePublicKey: () => alice.publicKey,
      }),
      'VFS_INVALID_ENVELOPE',
    );

    // Tree-scoped Commit (no nodeId) succeeds without nodeId, while doc-scoped Commit enforces nodeId.
    const treeCommitBody = {
      kind: 'vfs-commit' as const,
      v: 1 as const,
      roomId: ROOM_A,
      opId: OP_ID_2,
      deviceId: alice.id,
      memberId: ACTOR_A,
      epoch: 1,
      seq: 2,
      lamport: 2,
      at: 1_750_000_000_100,
      scope: 'tree' as const,
    };
    const sealedTreeCommit = await sealSignedVfsOp({
      body: treeCommitBody,
      objKind: VfsObjKind.Commit,
      roomKey: rk,
      sign: alice.sign,
    });
    const openedTreeCommit = await openSignedVfsOp({
      bytes: sealedTreeCommit.envelope.bytes,
      roomId: ROOM_A,
      epoch: 1,
      objKind: VfsObjKind.Commit,
      deviceId: alice.id,
      seq: 2,
      opId: OP_ID_2,
      roomKey: rk,
      resolvePublicKey: () => alice.publicKey,
    });
    expect(openedTreeCommit.body).toEqual(treeCommitBody);

    const docCommitBody = {
      kind: 'vfs-commit' as const,
      v: 1 as const,
      roomId: ROOM_A,
      opId: OP_ID_2,
      deviceId: alice.id,
      memberId: ACTOR_A,
      epoch: 1,
      seq: 3,
      lamport: 3,
      at: 1_750_000_000_200,
      scope: 'doc' as const,
      nodeId: NODE_A,
    };
    const sealedDocCommit = await sealSignedVfsOp({
      body: docCommitBody,
      objKind: VfsObjKind.Commit,
      roomKey: rk,
      sign: alice.sign,
    });
    // Omitting nodeId or passing NODE_B for a doc-scoped Commit MUST fail.
    await expectVfsError(
      openSignedVfsOp({
        bytes: sealedDocCommit.envelope.bytes,
        roomId: ROOM_A,
        epoch: 1,
        objKind: VfsObjKind.Commit,
        deviceId: alice.id,
        seq: 3,
        opId: OP_ID_2,
        roomKey: rk,
        resolvePublicKey: () => alice.publicKey,
      }),
      'VFS_INVALID_ENVELOPE',
    );
    await expectVfsError(
      openSignedVfsOp({
        bytes: sealedDocCommit.envelope.bytes,
        roomId: ROOM_A,
        epoch: 1,
        objKind: VfsObjKind.Commit,
        nodeId: NODE_B,
        deviceId: alice.id,
        seq: 3,
        opId: OP_ID_2,
        roomKey: rk,
        resolvePublicKey: () => alice.publicKey,
      }),
      'VFS_INVALID_ENVELOPE',
    );
    const openedDocCommit = await openSignedVfsOp({
      bytes: sealedDocCommit.envelope.bytes,
      roomId: ROOM_A,
      epoch: 1,
      objKind: VfsObjKind.Commit,
      nodeId: NODE_A,
      deviceId: alice.id,
      seq: 3,
      opId: OP_ID_2,
      roomKey: rk,
      resolvePublicKey: () => alice.publicKey,
    });
    expect(openedDocCommit.body.nodeId).toBe(NODE_A);
  });

  test('enforces VFS_OP_MAX_PLAINTEXT_BYTES and bounded deflate-raw snapshot zip-bomb limits', async () => {
    const alice = await makeSigner();
    const rk = generateVfsKey();

    // 1. Oversized op plaintext (> 12 KiB) rejected by sealSignedVfsOp & sealVfsEnvelope & openSignedVfsOp
    const oversizedBody = {
      kind: 'vfs-doc-op' as const,
      v: 1 as const,
      roomId: ROOM_A,
      opId: OP_ID_1,
      deviceId: alice.id,
      memberId: ACTOR_A,
      epoch: 1,
      seq: 1,
      lamport: 1,
      at: 1_750_000_000_000,
      nodeId: NODE_A,
      parents: [],
      counterStart: 0,
      ops: [{ t: 'ins', parent: null, side: 'R', text: 'x'.repeat(VFS_OP_MAX_PLAINTEXT_BYTES + 1) }],
    };
    await expectVfsError(
      sealSignedVfsOp({ body: oversizedBody, objKind: VfsObjKind.DocOp, roomKey: rk, sign: alice.sign }),
      'VFS_LIMIT_EXCEEDED',
    );

    // Oversized binary envelope rejected pre-decryption in openSignedVfsOp
    const fakeHugeEnv = new Uint8Array(VFS_ENVELOPE_OVERHEAD_BYTES + VFS_OP_MAX_PLAINTEXT_BYTES + 1);
    await expectVfsError(
      openSignedVfsOp({
        bytes: fakeHugeEnv,
        roomId: ROOM_A,
        epoch: 1,
        objKind: VfsObjKind.DocOp,
        nodeId: NODE_A,
        deviceId: alice.id,
        seq: 1,
        opId: OP_ID_1,
        roomKey: rk,
        resolvePublicKey: () => alice.publicKey,
      }),
      'VFS_LIMIT_EXCEEDED',
    );

    // 2. Normal snapshot deflate-raw round-trip succeeds, while zip-bomb (> 10x ratio) fails closed!
    const normalPayload = utf8Bytes(JSON.stringify({ v: 1, runs: Array.from({ length: 20 }, (_, i) => [i, `text-${i}-${(i * 7919) % 997}`]) }));
    const compressed = await deflateSnapPayload(normalPayload);
    const inflated = await inflateSnapPayload(compressed);
    expect(constantTimeEqual(inflated, normalPayload)).toBe(true);

    const zipBombRaw = new Uint8Array(64 * 1024); // 64 KiB of zeros -> compresses to ~80 bytes (> 800x ratio!)
    const zipBombCompressed = await deflateSnapPayload(zipBombRaw);
    expect(zipBombCompressed.byteLength).toBeLessThan(1024);
    await expectVfsError(inflateSnapPayload(zipBombCompressed), 'VFS_LIMIT_EXCEEDED');
  });

  test('defeats insider JSON malleability / false-equivocation framing in openSignedVfsOp', async () => {
    const alice = await makeSigner();
    const rk = generateVfsKey();

    const body = {
      kind: 'vfs-doc-op' as const,
      v: 1 as const,
      roomId: ROOM_A,
      opId: OP_ID_1,
      deviceId: alice.id,
      memberId: ACTOR_A,
      epoch: 1,
      seq: 1,
      lamport: 1,
      at: 1_750_000_000_000,
      nodeId: NODE_A,
      parents: [],
      counterStart: 0,
      ops: [{ t: 'ins', parent: null, side: 'R', text: 'Authentic' }],
    };

    const sealed = await sealSignedVfsOp({
      body,
      objKind: VfsObjKind.DocOp,
      roomKey: rk,
      sign: alice.sign,
    });
    const binding = opBindingKey(alice.id, 1, OP_ID_1);

    // Malicious insider holding RK_e (NOT Alice's ECDSA key) extracts Alice's valid `{ body, signature }`
    // and tries distinct non-canonical re-encodings to create a second valid CID for Alice's (deviceId, seq):
    const canonicalStr = JSON.stringify({ body: sealed.signed.body, signature: sealed.signed.signature });
    const variants: Uint8Array[] = [
      // 1) Appended trailing whitespace
      utf8Bytes(`${canonicalStr} `),
      // 2) Reordered top-level keys (`signature` before `body`)
      utf8Bytes(JSON.stringify({ signature: sealed.signed.signature, body: sealed.signed.body })),
      // 3) Extra top-level property `"junk": 1`
      utf8Bytes(JSON.stringify({ body: sealed.signed.body, junk: 1, signature: sealed.signed.signature })),
      // 4) Reordered keys inside `body`
      utf8Bytes(JSON.stringify({ body: Object.fromEntries(Object.entries(sealed.signed.body).reverse()), signature: sealed.signed.signature })),
    ];

    for (const mutatedInner of variants) {
      const reencrypted = await sealVfsEnvelope({
        roomId: ROOM_A,
        epoch: 1,
        objKind: VfsObjKind.DocOp,
        key: rk,
        plaintext: mutatedInner,
        bindingKey: binding,
      });
      expect(reencrypted.cid).not.toBe(sealed.cid);
      await expectVfsError(
        openSignedVfsOp({
          bytes: reencrypted.bytes,
          roomId: ROOM_A,
          epoch: 1,
          objKind: VfsObjKind.DocOp,
          nodeId: NODE_A,
          deviceId: alice.id,
          seq: 1,
          opId: OP_ID_1,
          roomKey: rk,
          resolvePublicKey: () => alice.publicKey,
        }),
        'VFS_MALLEABLE_ENVELOPE',
      );
    }
  });

  test('deriveVfsDeviceSealKey derives deterministic room+device-scoped keys from non-extractable ECDH CryptoKey', async () => {
    const encPair = await generateEncKeyPair(false);
    const k1 = await deriveVfsDeviceSealKey(encPair.privateKey, { roomId: ROOM_A, deviceId: DEV_HEX });
    const k2 = await deriveVfsDeviceSealKey(encPair.privateKey, { roomId: ROOM_A, deviceId: DEV_HEX });
    const kOtherRoom = await deriveVfsDeviceSealKey(encPair.privateKey, { roomId: ROOM_B, deviceId: DEV_HEX });
    const kOtherDev = await deriveVfsDeviceSealKey(encPair.privateKey, { roomId: ROOM_A, deviceId: 'c'.repeat(64) });

    expect(k1.byteLength).toBe(32);
    expect(constantTimeEqual(k1, k2)).toBe(true);
    expect(constantTimeEqual(k1, kOtherRoom)).toBe(false);
    expect(constantTimeEqual(k1, kOtherDev)).toBe(false);
  });
});
