import { describe, expect, test } from 'bun:test';
import { base64, deviceId, encode } from '../protocol';
import {
  bytesToBase64,
  canonicalize,
  exportRawPublicKey,
  generateEncKeyPair,
  hashRosterBody,
  importEncPublicKey,
  signDelegatedEntry,
  signEncBinding,
  signRoster,
  type RosterBody,
  type RosterEntry,
  type SignFn,
  type SignedRoster,
} from '../relay-crypto';
import {
  VFS_EPOCH_WRAP_DOMAIN,
  VFS_GRANT_WRAP_DOMAIN,
  VFS_KEY_COMMIT_DOMAIN,
  VFS_KEY_GRANT_SIG_DOMAIN,
  VFS_KEY_WRAP_SIG_DOMAIN,
  VfsError,
  VfsObjKind,
  type VfsErrorCode,
} from './constants';
import {
  concatBytes,
  constantTimeEqual,
  deriveVfsDeviceSealKey,
  generateVfsKey,
  opBindingKey,
  openVfsEnvelope,
  sealVfsEnvelope,
  sha256Hex,
  utf8Bytes,
} from './envelope';
import {
  VfsKeyring,
  computeVfsKeyCommit,
  hashEpochHeaderBody,
  openEpochRecordFromStorage,
  sealEpochRecordForStorage,
  verifyKeyEpochHeader,
  type VfsKeyWrapChunk,
  type VfsKeyWrapChunkBody,
} from './keyring';

const ROOM_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ROOM = '22222222-2222-4222-8222-222222222222';

type TestPeer = {
  id: string;
  memberId: string;
  role: 'human' | 'agent';
  operatorId?: string;
  signPub: string;
  encPub: string;
  encKeys: CryptoKeyPair;
  encVersion: number;
  sign: SignFn;
};

async function makePeer(opts: {
  memberId: string;
  role?: 'human' | 'agent';
  operatorId?: string;
  encVersion?: number;
}): Promise<TestPeer> {
  const signKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const signPub = base64(await crypto.subtle.exportKey('raw', signKeys.publicKey));
  const id = await deviceId(signPub);
  const encKeys = await generateEncKeyPair(false);
  const encPub = await exportRawPublicKey(encKeys.publicKey);
  const sign: SignFn = async value =>
    base64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKeys.privateKey, encode(value)));
  return {
    id,
    memberId: opts.memberId,
    role: opts.role ?? 'human',
    operatorId: opts.operatorId,
    signPub,
    encPub,
    encKeys,
    encVersion: opts.encVersion ?? 1,
    sign,
  };
}

async function toRosterEntry(peer: TestPeer, room = ROOM_ID): Promise<RosterEntry> {
  const encSig = await signEncBinding(peer.sign, {
    room,
    deviceId: peer.id,
    enc: peer.encPub,
    encVersion: peer.encVersion,
  });
  return {
    id: peer.id,
    sign: peer.signPub,
    enc: peer.encPub,
    encVersion: peer.encVersion,
    encSig,
    memberId: peer.memberId,
    role: peer.role,
    ...(peer.operatorId ? { operatorId: peer.operatorId } : {}),
  };
}

async function buildSignedRoster(options: {
  room?: string;
  version: number;
  prev?: SignedRoster;
  host: TestPeer;
  signer?: TestPeer;
  peers: TestPeer[];
  removed?: { id: string; at: number; revoked: boolean }[];
  at?: number;
}): Promise<SignedRoster> {
  const room = options.room ?? ROOM_ID;
  const devices = await Promise.all(options.peers.map(p => toRosterEntry(p, room)));
  const body: RosterBody = {
    v: 1,
    room,
    version: options.version,
    prev: options.prev ? await hashRosterBody(options.prev.body) : '',
    at: options.at ?? 1_750_000_000_000 + options.version * 1_000,
    host: options.host.id,
    devices,
    removed: options.removed ?? [],
  };
  return signRoster(body, (options.signer ?? options.host).sign);
}

function makeKeyring(peer: TestPeer, pinnedHost?: string, now = () => 1_750_000_010_000): VfsKeyring {
  return new VfsKeyring({
    roomId: ROOM_ID,
    selfDeviceId: peer.id,
    selfEncPrivateKey: peer.encKeys.privateKey,
    selfEncVersion: peer.encVersion,
    sign: peer.sign,
    pinnedHost,
    now,
  });
}

async function expectVfsError(promise: Promise<unknown> | (() => unknown), code: VfsErrorCode) {
  let caught: unknown;
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(VfsError);
  expect((caught as VfsError).code).toBe(code);
}

describe('VfsKeyring — host-only Epoch-1 bootstrap & fail-closed behavior', () => {
  test('uninitialized keyring fails closed with VFS_EPOCH_UNINITIALIZED', async () => {
    const guest = await makePeer({ memberId: 'aaaa1111-1111-4111-8111-111111111111' });
    const kr = makeKeyring(guest);
    expect(kr.isInitialized()).toBe(false);
    expect(kr.activeEpoch).toBe(0);
    await expectVfsError(() => kr.requireActiveEpoch(), 'VFS_EPOCH_UNINITIALIZED');
  });

  test('non-host cannot mint Epoch 1 (prevents dual-genesis forks)', async () => {
    const host = await makePeer({ memberId: 'aaaa1111-1111-4111-8111-111111111111' });
    const guest = await makePeer({ memberId: 'bbbb2222-2222-4222-8222-222222222222' });
    const roster = await buildSignedRoster({ version: 1, host, peers: [host, guest] });

    const guestKr = makeKeyring(guest, host.id.slice(0, 16));
    await expectVfsError(guestKr.bootstrapEpoch1(roster), 'VFS_EPOCH_UNAUTHORIZED');
    expect(guestKr.isInitialized()).toBe(false);
  });

  test('host bootstraps Epoch 1 and all active devices unwrap identical RK_1 verified against keyCommit', async () => {
    const host = await makePeer({ memberId: 'aaaa1111-1111-4111-8111-111111111111' });
    const guest = await makePeer({ memberId: 'bbbb2222-2222-4222-8222-222222222222' });
    const agent = await makePeer({
      memberId: 'cccc3333-3333-4333-8333-333333333333',
      role: 'agent',
      operatorId: host.memberId,
    });
    const roster = await buildSignedRoster({ version: 1, host, peers: [host, guest, agent] });

    const hostKr = makeKeyring(host, host.id.slice(0, 16));
    const guestKr = makeKeyring(guest, host.id.slice(0, 16));
    const agentKr = makeKeyring(agent, host.id.slice(0, 16));

    const { header, wrapChunks, record } = await hostKr.bootstrapEpoch1(roster);
    expect(header.body.epoch).toBe(1);
    expect(header.body.prevEpochHash).toBe('');
    expect(wrapChunks.length).toBe(1);
    expect(await computeVfsKeyCommit(ROOM_ID, 1, record.key)).toBe(header.body.keyCommit);

    // Calling bootstrapEpoch1 twice is rejected.
    await expectVfsError(hostKr.bootstrapEpoch1(roster), 'VFS_EPOCH_ROLLBACK');

    const guestRec = await guestKr.acceptEpochBroadcast({ header, wrapChunks, roster });
    const agentRec = await agentKr.acceptEpochBroadcast({ header, wrapChunks, roster });
    expect(constantTimeEqual(guestRec.key, record.key)).toBe(true);
    expect(constantTimeEqual(agentRec.key, record.key)).toBe(true);
    expect(guestKr.activeEpoch).toBe(1);
    expect(agentKr.activeEpoch).toBe(1);
  });

  test('solo host room bootstraps Epoch 1 cleanly with empty wrapChunks', async () => {
    const host = await makePeer({ memberId: 'aaaa1111-1111-4111-8111-111111111111' });
    const roster = await buildSignedRoster({ version: 1, host, peers: [host] });
    const hostKr = makeKeyring(host);
    const { wrapChunks, record } = await hostKr.bootstrapEpoch1(roster);
    expect(wrapChunks).toEqual([]);
    expect(hostKr.activeEpoch).toBe(1);
    expect(record.epoch).toBe(1);
  });

  test('defeats host wrap-equivocation via keyCommit verification', async () => {
    const host = await makePeer({ memberId: 'aaaa1111-1111-4111-8111-111111111111' });
    const guest = await makePeer({ memberId: 'bbbb2222-2222-4222-8222-222222222222' });
    const roster = await buildSignedRoster({ version: 1, host, peers: [host, guest] });

    // Honest header commits to realKey, but malicious host wraps fakeKey to guest under the same epk!
    const realKey = generateVfsKey();
    const fakeKey = generateVfsKey();
    const epkPair = await generateEncKeyPair(false);
    const epk = await exportRawPublicKey(epkPair.publicKey);
    const keyCommit = await computeVfsKeyCommit(ROOM_ID, 1, realKey);

    const headerBody = canonicalize({
      kind: 'vfs-key-epoch' as const,
      v: 1 as const,
      roomId: ROOM_ID,
      epoch: 1,
      prevEpochHash: '',
      rosterVersion: 1,
      hostDeviceId: host.id,
      at: 1_750_000_005_000,
      epk,
      keyCommit,
    });
    const header = {
      body: headerBody,
      signature: await host.sign(canonicalize({ d: 'meshrooms-vfs-epoch-header-v1', body: headerBody })),
    };
    const headerHash = await hashEpochHeaderBody(headerBody);

    // Manually wrap fakeKey for guest with exact protocol HKDF/AES-GCM parameters.
    const guestPub = await importEncPublicKey(guest.encPub);
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: guestPub }, epkPair.privateKey, 256);
    const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    const salt = utf8Bytes(`${ROOM_ID}|1|${headerHash}`);
    const info = utf8Bytes(`${VFS_EPOCH_WRAP_DOMAIN}${ROOM_ID}|1|${host.id}|${guest.id}|${guest.encVersion}`);
    const wrapKey = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info }, hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: info }, wrapKey, fakeKey));

    const chunkBody: VfsKeyWrapChunkBody = canonicalize({
      kind: 'vfs-key-wrap',
      v: 1,
      roomId: ROOM_ID,
      epoch: 1,
      headerHash,
      chunkIndex: 0,
      chunkCount: 1,
      senderDeviceId: host.id,
      wraps: { [guest.id]: bytesToBase64(concatBytes(iv, ct)) },
    });
    const fakeChunk: VfsKeyWrapChunk = {
      body: chunkBody,
      signature: await host.sign(canonicalize({ d: VFS_KEY_WRAP_SIG_DOMAIN, body: chunkBody })),
    };

    const guestKr = makeKeyring(guest, host.id.slice(0, 16));
    await expectVfsError(
      guestKr.acceptEpochBroadcast({ header, wrapChunks: [fakeChunk], roster }),
      'VFS_KEY_COMMIT_MISMATCH',
    );
    expect(guestKr.isInitialized()).toBe(false);
  });
});

describe('VfsKeyring — forward-only rotation, revocation & anti-rollback', () => {
  test('host rotates epoch on member revocation; active peer reads old+new, revoked peer locked out', async () => {
    const host = await makePeer({ memberId: 'aaaa1111-1111-4111-8111-111111111111' });
    const alice = await makePeer({ memberId: 'bbbb2222-2222-4222-8222-222222222222' });
    const eve = await makePeer({ memberId: 'eeee5555-5555-4555-8555-555555555555' });

    const rosterV1 = await buildSignedRoster({ version: 1, host, peers: [host, alice, eve] });
    const hostKr = makeKeyring(host);
    const aliceKr = makeKeyring(alice, host.id.slice(0, 16));
    const eveKr = makeKeyring(eve, host.id.slice(0, 16));

    const ep1 = await hostKr.bootstrapEpoch1(rosterV1);
    await aliceKr.acceptEpochBroadcast({ header: ep1.header, wrapChunks: ep1.wrapChunks, roster: rosterV1 });
    await eveKr.acceptEpochBroadcast({ header: ep1.header, wrapChunks: ep1.wrapChunks, roster: rosterV1 });

    // Seal an Epoch 1 op.
    const binding1 = opBindingKey(host.id, 1, '77777777-7777-4777-8777-777777777777');
    const op1 = await sealVfsEnvelope({
      roomId: ROOM_ID,
      epoch: 1,
      objKind: VfsObjKind.DocOp,
      key: hostKr.requireActiveEpoch().key,
      plaintext: utf8Bytes('epoch-1-text'),
      bindingKey: binding1,
    });

    // Host revokes Eve -> Roster v2 excludes Eve -> Host rotates to Epoch 2.
    const rosterV2 = await buildSignedRoster({
      version: 2,
      prev: rosterV1,
      host,
      peers: [host, alice],
      removed: [{ id: eve.id, at: 1_750_000_020_000, revoked: true }],
    });

    // Non-host cannot rotate epoch.
    await expectVfsError(aliceKr.rotateEpoch(rosterV2), 'VFS_EPOCH_UNAUTHORIZED');

    const ep2 = await hostKr.rotateEpoch(rosterV2);
    expect(ep2.header.body.epoch).toBe(2);
    expect(ep2.header.body.prevEpochHash).toBe(ep1.record.headerHash);
    expect(constantTimeEqual(ep2.record.key, ep1.record.key)).toBe(false);

    // Alice accepts Epoch 2 and can still read Epoch 1 + decrypt Epoch 2.
    await aliceKr.acceptEpochBroadcast({ header: ep2.header, wrapChunks: ep2.wrapChunks, roster: rosterV2 });
    expect(aliceKr.activeEpoch).toBe(2);
    expect(aliceKr.listEpochs()).toEqual([1, 2]);

    const binding2 = opBindingKey(host.id, 2, '88888888-8888-4888-8888-888888888888');
    const op2 = await sealVfsEnvelope({
      roomId: ROOM_ID,
      epoch: 2,
      objKind: VfsObjKind.DocOp,
      key: hostKr.requireActiveEpoch().key,
      plaintext: utf8Bytes('post-revocation-secret'),
      bindingKey: binding2,
    });

    // Alice decrypts both Epoch 1 and Epoch 2.
    const opened1 = await openVfsEnvelope({ bytes: op1.bytes, roomId: ROOM_ID, key: aliceKr.getKey(1)!, bindingKey: binding1 });
    const opened2 = await openVfsEnvelope({ bytes: op2.bytes, roomId: ROOM_ID, key: aliceKr.getKey(2)!, bindingKey: binding2 });
    expect(new TextDecoder().decode(opened1.plaintext)).toBe('epoch-1-text');
    expect(new TextDecoder().decode(opened2.plaintext)).toBe('post-revocation-secret');

    // Eve cannot unwrap Epoch 2 AND cannot decrypt op2 with Epoch 1 key.
    await expectVfsError(
      eveKr.acceptEpochBroadcast({ header: ep2.header, wrapChunks: ep2.wrapChunks, roster: rosterV2 }),
      'VFS_DECRYPT_FAILED',
    );
    await expectVfsError(
      openVfsEnvelope({ bytes: op2.bytes, roomId: ROOM_ID, key: eveKr.getKey(1)!, bindingKey: binding2 }),
      'VFS_MALLEABLE_ENVELOPE',
    );

    // Rollback & equivocation defenses on Alice:
    // 1) Replaying a different header for Epoch 2 fails.
    const hostKrFork = makeKeyring(host);
    const fork1 = await hostKrFork.bootstrapEpoch1(rosterV1);
    const fork2 = await hostKrFork.rotateEpoch(rosterV2);
    await expectVfsError(
      aliceKr.acceptEpochBroadcast({ header: fork2.header, wrapChunks: fork2.wrapChunks, roster: rosterV2 }),
      'VFS_EPOCH_ROLLBACK',
    );
    // 2) Replaying a different Epoch 1 fails.
    await expectVfsError(
      aliceKr.acceptEpochBroadcast({ header: fork1.header, wrapChunks: fork1.wrapChunks, roster: rosterV1 }),
      'VFS_EPOCH_ROLLBACK',
    );
    // 3) Broken prevEpochHash on Epoch 3 fails.
    const brokenHeaderBody = canonicalize({ ...ep2.header.body, epoch: 3, prevEpochHash: 'f'.repeat(64) });
    const brokenHeader = {
      body: brokenHeaderBody,
      signature: await host.sign(canonicalize({ d: 'meshrooms-vfs-epoch-header-v1', body: brokenHeaderBody })),
    };
    await expectVfsError(
      aliceKr.acceptEpochBroadcast({ header: brokenHeader, wrapChunks: ep2.wrapChunks, roster: rosterV2 }),
      'VFS_EPOCH_ROLLBACK',
    );
    // 4) Wrong host pin fails.
    const wrongPinKr = makeKeyring(alice, '0000000000000000');
    await expectVfsError(
      wrongPinKr.acceptEpochBroadcast({ header: ep1.header, wrapChunks: ep1.wrapChunks, roster: rosterV1 }),
      'VFS_EPOCH_UNAUTHORIZED',
    );
  });

  test('supports multi-chunk wrap distribution for >64 recipients', async () => {
    const host = await makePeer({ memberId: 'aaaa1111-1111-4111-8111-111111111111' });
    const others: TestPeer[] = [];
    for (let i = 0; i < 68; i++) {
      others.push(await makePeer({ memberId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }));
    }
    const roster = await buildSignedRoster({ version: 1, host, peers: [host, ...others] });
    const hostKr = makeKeyring(host);
    const { header, wrapChunks, record } = await hostKr.bootstrapEpoch1(roster);

    expect(wrapChunks.length).toBe(2);
    expect(Object.keys(wrapChunks[0].body.wraps).length).toBe(64);
    expect(Object.keys(wrapChunks[1].body.wraps).length).toBe(4);

    // Pick a peer guaranteed to land in chunk 1 (highest sorted deviceId).
    const lastPeer = [...others].sort((a, b) => (a.id < b.id ? -1 : 1)).at(-1)!;
    const lastKr = makeKeyring(lastPeer, host.id.slice(0, 16));
    const rec = await lastKr.acceptEpochBroadcast({ header, wrapChunks, roster });
    expect(constantTimeEqual(rec.key, record.key)).toBe(true);
  });
});

describe('VfsKeyring — offline-host delegated grants, host transfer & storage sealing', () => {
  test('admitted human grants RK_1..RK_2 to delegated newcomer while host is offline; newcomer verifies host keyCommit', async () => {
    const host = await makePeer({ memberId: 'aaaa1111-1111-4111-8111-111111111111' });
    const alice = await makePeer({ memberId: 'bbbb2222-2222-4222-8222-222222222222' });
    const agent = await makePeer({
      memberId: 'cccc3333-3333-4333-8333-333333333333',
      role: 'agent',
      operatorId: alice.memberId,
    });

    const rosterV1 = await buildSignedRoster({ version: 1, host, peers: [host, alice] });
    const hostKr = makeKeyring(host);
    const aliceKr = makeKeyring(alice, host.id.slice(0, 16));

    const ep1 = await hostKr.bootstrapEpoch1(rosterV1);
    await aliceKr.acceptEpochBroadcast({ header: ep1.header, wrapChunks: ep1.wrapChunks, roster: rosterV1 });

    const rosterV2 = await buildSignedRoster({ version: 2, prev: rosterV1, host, peers: [host, alice] });
    const ep2 = await hostKr.rotateEpoch(rosterV2);
    await aliceKr.acceptEpochBroadcast({ header: ep2.header, wrapChunks: ep2.wrapChunks, roster: rosterV2 });

    // Host is now offline. Alice certifies her new agent with a delegated cert and grants RK_1..RK_2!
    const agentBase = await toRosterEntry(agent);
    const cert = await signDelegatedEntry(alice.sign, ROOM_ID, agentBase, alice.id);
    const delegatedAgentEntry: RosterEntry = { ...agentBase, cert };

    const grant = await aliceKr.createKeyGrant({ recipient: delegatedAgentEntry, roster: rosterV2 });
    expect(grant.body.entries.length).toBe(2);

    const agentKr = makeKeyring(agent, host.id.slice(0, 16));
    const installed = await agentKr.acceptKeyGrant({ grant, roster: rosterV2 });
    expect(installed.length).toBe(2);
    expect(agentKr.activeEpoch).toBe(2);
    expect(constantTimeEqual(agentKr.getKey(1)!, ep1.record.key)).toBe(true);
    expect(constantTimeEqual(agentKr.getKey(2)!, ep2.record.key)).toBe(true);

    // An agent CANNOT issue key grants to others.
    const rosterV3 = await buildSignedRoster({ version: 3, prev: rosterV2, host, peers: [host, alice, agent] });
    const newcomer = await makePeer({ memberId: 'dddd4444-4444-4444-8444-444444444444' });
    const newcomerEntry = await toRosterEntry(newcomer);
    const rosterV4 = await buildSignedRoster({ version: 4, prev: rosterV3, host, peers: [host, alice, agent, newcomer] });
    await expectVfsError(
      agentKr.createKeyGrant({ recipient: newcomerEntry, roster: rosterV4 }),
      'VFS_EPOCH_UNAUTHORIZED',
    );

    // Malicious human granter trying to forge a header signed by Alice instead of Host fails closed!
    const forgedHeaderBody = { ...ep1.header.body, hostDeviceId: alice.id };
    const forgedGrant = {
      ...grant,
      body: {
        ...grant.body,
        entries: [{
          ...grant.body.entries[0],
          header: {
            body: forgedHeaderBody,
            signature: await alice.sign(canonicalize({ d: 'meshrooms-vfs-epoch-header-v1', body: forgedHeaderBody })),
          },
        }],
      },
    };
    const forgedGrantSigned = {
      body: forgedGrant.body,
      signature: await alice.sign(canonicalize({ d: 'meshrooms-vfs-key-grant-v1', body: forgedGrant.body })),
    };
    const victimKr = makeKeyring(agent, host.id.slice(0, 16));
    await expectVfsError(
      victimKr.acceptKeyGrant({ grant: forgedGrantSigned, roster: rosterV2 }),
      'VFS_EPOCH_UNAUTHORIZED',
    );

    // Malicious granter validly wrapping a DIFFERENT key under the real host-signed Epoch 1 header
    // MUST fail closed specifically with VFS_KEY_COMMIT_MISMATCH!
    const badEpkPair = await generateEncKeyPair(false);
    const badEpk = await exportRawPublicKey(badEpkPair.publicKey);
    const fakeRoomKey = generateVfsKey();
    const ep1HeaderHash = await hashEpochHeaderBody(ep1.header.body);
    const agentPub = await importEncPublicKey(agent.encPub);
    const grantShared = await crypto.subtle.deriveBits({ name: 'ECDH', public: agentPub }, badEpkPair.privateKey, 256);
    const grantHkdf = await crypto.subtle.importKey('raw', grantShared, 'HKDF', false, ['deriveKey']);
    const gSalt = utf8Bytes(`grant|${ROOM_ID}|1|${ep1HeaderHash}`);
    const gInfo = utf8Bytes(`${VFS_GRANT_WRAP_DOMAIN}${ROOM_ID}|1|${alice.id}|${agent.id}|${agent.encVersion}`);
    const gWrapKey = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: gSalt, info: gInfo },
      grantHkdf,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    );
    const gIv = new Uint8Array(12);
    crypto.getRandomValues(gIv);
    const gCt = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: gIv, additionalData: gInfo }, gWrapKey, fakeRoomKey),
    );
    const evilGrantBody = canonicalize({
      kind: 'vfs-key-grant' as const,
      v: 1 as const,
      roomId: ROOM_ID,
      rosterVersion: rosterV2.body.version,
      granterDeviceId: alice.id,
      recipientDeviceId: agent.id,
      recipientEncVersion: agent.encVersion,
      epk: badEpk,
      at: 1_750_000_050_000,
      entries: [{ header: ep1.header, wrappedKey: bytesToBase64(concatBytes(gIv, gCt)) }],
    });
    const evilGrant = {
      body: evilGrantBody,
      signature: await alice.sign(canonicalize({ d: VFS_KEY_GRANT_SIG_DOMAIN, body: evilGrantBody })),
    };
    const victim2 = makeKeyring(agent, host.id.slice(0, 16));
    await expectVfsError(
      victim2.acceptKeyGrant({ grant: evilGrant, roster: rosterV2 }),
      'VFS_KEY_COMMIT_MISMATCH',
    );
    expect(victim2.isInitialized()).toBe(false);
  });

  test('supports historical epoch verification across host transfer via trustedPriorHosts', async () => {
    const hostA = await makePeer({ memberId: 'aaaa1111-1111-4111-8111-111111111111' });
    const hostB = await makePeer({ memberId: 'bbbb2222-2222-4222-8222-222222222222' });
    const newcomer = await makePeer({ memberId: 'cccc3333-3333-4333-8333-333333333333' });

    const rosterV1 = await buildSignedRoster({ version: 1, host: hostA, peers: [hostA, hostB] });
    const krA = makeKeyring(hostA);
    const krB = makeKeyring(hostB, hostA.id.slice(0, 16));
    const ep1 = await krA.bootstrapEpoch1(rosterV1);
    await krB.acceptEpochBroadcast({ header: ep1.header, wrapChunks: ep1.wrapChunks, roster: rosterV1 });

    // Transfer host A -> B (v2 signed by A naming B, v3 signed by B).
    const rosterV2 = await buildSignedRoster({ version: 2, prev: rosterV1, host: hostB, signer: hostA, peers: [hostA, hostB] });
    const rosterV3 = await buildSignedRoster({ version: 3, prev: rosterV2, host: hostB, peers: [hostA, hostB, newcomer] });

    // Host B rotates to Epoch 2 after transfer.
    const krBAsNewHost = makeKeyring(hostB, hostB.id.slice(0, 16));
    await krBAsNewHost.hydrate([krB.getRecord(1)!]);
    const ep2 = await krBAsNewHost.rotateEpoch(rosterV3);

    const newcomerEntry = await toRosterEntry(newcomer);
    const grant = await krBAsNewHost.createKeyGrant({ recipient: newcomerEntry, roster: rosterV3 });

    // Without trustedPriorHosts, Epoch 1 (signed by former host A) fails closed.
    const krNew1 = makeKeyring(newcomer, hostB.id.slice(0, 16));
    await expectVfsError(krNew1.acceptKeyGrant({ grant, roster: rosterV3 }), 'VFS_EPOCH_UNAUTHORIZED');

    // With verified prior host key from roster chain, both epochs install and verify cleanly!
    const krNew2 = makeKeyring(newcomer, hostB.id.slice(0, 16));
    await krNew2.acceptKeyGrant({
      grant,
      roster: rosterV3,
      trustedPriorHosts: { [hostA.id]: hostA.signPub },
    });
    expect(krNew2.listEpochs()).toEqual([1, 2]);
    expect(constantTimeEqual(krNew2.getKey(1)!, ep1.record.key)).toBe(true);
    expect(constantTimeEqual(krNew2.getKey(2)!, ep2.record.key)).toBe(true);
  });

  test('existing member pinned to hostA accepts Epoch 2 broadcast from hostB after transfer-host only with trustedPriorHosts', async () => {
    const hostA = await makePeer({ memberId: 'aaaa1111-1111-4111-8111-111111111111' });
    const hostB = await makePeer({ memberId: 'bbbb2222-2222-4222-8222-222222222222' });
    const memberC = await makePeer({ memberId: 'cccc3333-3333-4333-8333-333333333333' });

    const rosterV1 = await buildSignedRoster({ version: 1, host: hostA, peers: [hostA, hostB, memberC] });
    const krA = makeKeyring(hostA);
    const krB = makeKeyring(hostB, hostA.id.slice(0, 16));
    const krC = makeKeyring(memberC, hostA.id.slice(0, 16));

    const ep1 = await krA.bootstrapEpoch1(rosterV1);
    await krB.acceptEpochBroadcast({ header: ep1.header, wrapChunks: ep1.wrapChunks, roster: rosterV1 });
    await krC.acceptEpochBroadcast({ header: ep1.header, wrapChunks: ep1.wrapChunks, roster: rosterV1 });
    expect(krC.hostPin).toBe(hostA.id);

    // Legitimate host transfer A -> B; Host B rotates to Epoch 2.
    const rosterV2 = await buildSignedRoster({ version: 2, prev: rosterV1, host: hostB, signer: hostA, peers: [hostA, hostB, memberC] });
    const rosterV3 = await buildSignedRoster({ version: 3, prev: rosterV2, host: hostB, peers: [hostA, hostB, memberC] });
    const ep2 = await krB.rotateEpoch(rosterV3);

    // Without trustedPriorHosts, existing member C (pinned to hostA) fails closed!
    await expectVfsError(
      krC.acceptEpochBroadcast({ header: ep2.header, wrapChunks: ep2.wrapChunks, roster: rosterV3 }),
      'VFS_EPOCH_UNAUTHORIZED',
    );
    expect(krC.activeEpoch).toBe(1);

    // With verified prior host A in trustedPriorHosts, member C transitions smoothly to Epoch 2 and pins hostB!
    await krC.acceptEpochBroadcast({
      header: ep2.header,
      wrapChunks: ep2.wrapChunks,
      roster: rosterV3,
      trustedPriorHosts: { [hostA.id]: hostA.signPub },
    });
    expect(krC.activeEpoch).toBe(2);
    expect(krC.hostPin).toBe(hostB.id);
    expect(constantTimeEqual(krC.getKey(2)!, ep2.record.key)).toBe(true);
  });

  test('backfilling Epoch 1 when Epoch 2 is already held rejects unchained fork and accepts authentic chain', async () => {
    const host = await makePeer({ memberId: 'aaaa1111-1111-4111-8111-111111111111' });
    const alice = await makePeer({ memberId: 'bbbb2222-2222-4222-8222-222222222222' });
    const bob = await makePeer({ memberId: 'cccc3333-3333-4333-8333-333333333333' });

    const rosterV1 = await buildSignedRoster({ version: 1, host, peers: [host, alice, bob] });
    const hostKr = makeKeyring(host);
    const aliceKr = makeKeyring(alice, host.id.slice(0, 16));
    const ep1 = await hostKr.bootstrapEpoch1(rosterV1);
    const ep2 = await hostKr.rotateEpoch(rosterV1);
    await aliceKr.acceptEpochBroadcast({ header: ep1.header, wrapChunks: ep1.wrapChunks, roster: rosterV1 });
    await aliceKr.acceptEpochBroadcast({ header: ep2.header, wrapChunks: ep2.wrapChunks, roster: rosterV1 });

    // Bob initially joins with ONLY Epoch 2 (e.g., snapshot-only join, then later backfills Epoch 1).
    const bobKr = makeKeyring(bob, host.id.slice(0, 16));
    await bobKr.acceptEpochBroadcast({ header: ep2.header, wrapChunks: ep2.wrapChunks, roster: rosterV1 });
    expect(bobKr.listEpochs()).toEqual([2]);

    // A rogue forked Epoch 1 signed by host (different keyCommit / headerHash) MUST NOT backfill!
    const forkHostKr = makeKeyring(host);
    await forkHostKr.bootstrapEpoch1(rosterV1);
    const bobEntry = await toRosterEntry(bob);
    const forkGrant = await forkHostKr.createKeyGrant({ recipient: bobEntry, roster: rosterV1, epochs: [1] });
    await expectVfsError(
      bobKr.acceptKeyGrant({ grant: forkGrant, roster: rosterV1 }),
      'VFS_EPOCH_ROLLBACK',
    );
    expect(bobKr.listEpochs()).toEqual([2]);

    // The authentic Epoch 1 matching ep2.prevEpochHash backfills cleanly!
    const realGrant = await aliceKr.createKeyGrant({ recipient: bobEntry, roster: rosterV1, epochs: [1] });
    await bobKr.acceptKeyGrant({ grant: realGrant, roster: rosterV1 });
    expect(bobKr.listEpochs()).toEqual([1, 2]);
    expect(constantTimeEqual(bobKr.getKey(1)!, ep1.record.key)).toBe(true);
  });

  test('rotateEpoch does not prematurely mark prev.revokedAt if mintEpoch fails', async () => {
    const host = await makePeer({ memberId: 'aaaa1111-1111-4111-8111-111111111111' });
    const guest = await makePeer({ memberId: 'bbbb2222-2222-4222-8222-222222222222' });
    const rosterV1 = await buildSignedRoster({ version: 1, host, peers: [host, guest] });
    const hostKr = makeKeyring(host);
    await hostKr.bootstrapEpoch1(rosterV1);
    expect(hostKr.getRecord(1)?.revokedAt).toBeUndefined();

    // Corrupt guest's enc key in a bad roster so wrapRoomKeyForRecipient fails during mintEpoch.
    const badRoster: SignedRoster = {
      ...rosterV1,
      body: {
        ...rosterV1.body,
        version: 2,
        devices: rosterV1.body.devices.map(d => (d.id === guest.id ? { ...d, enc: 'invalid-key' } : d)),
      },
    };
    let threw = false;
    try {
      await hostKr.rotateEpoch(badRoster);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(hostKr.activeEpoch).toBe(1);
    expect(hostKr.getRecord(1)?.revokedAt).toBeUndefined();
  });

  test('seals and restores EpochKeyRecords under K_device_seal and hydrates VfsKeyring', async () => {
    const host = await makePeer({ memberId: 'aaaa1111-1111-4111-8111-111111111111' });
    const roster = await buildSignedRoster({ version: 1, host, peers: [host] });
    const hostKr = makeKeyring(host);
    const ep1 = await hostKr.bootstrapEpoch1(roster);
    const ep2 = await hostKr.rotateEpoch(roster);

    const deviceSealKey = await deriveVfsDeviceSealKey(host.encKeys.privateKey, {
      roomId: ROOM_ID,
      deviceId: host.id,
    });
    const sealed1 = await sealEpochRecordForStorage(ROOM_ID, hostKr.getRecord(1)!, deviceSealKey);
    const sealed2 = await sealEpochRecordForStorage(ROOM_ID, ep2.record, deviceSealKey);

    const restored1 = await openEpochRecordFromStorage(ROOM_ID, 1, sealed1.bytes, deviceSealKey);
    const restored2 = await openEpochRecordFromStorage(ROOM_ID, 2, sealed2.bytes, deviceSealKey);

    // Cross-room & cross-epoch AAD binding rejects swapped storage keys.
    await expectVfsError(
      openEpochRecordFromStorage(OTHER_ROOM, 1, sealed1.bytes, deviceSealKey),
      'VFS_DECRYPT_FAILED',
    );
    await expectVfsError(
      openEpochRecordFromStorage(ROOM_ID, 2, sealed1.bytes, deviceSealKey),
      'VFS_DECRYPT_FAILED',
    );

    const freshKr = makeKeyring(host);
    await freshKr.hydrate([restored2, restored1]); // Out-of-order hydrate still chains cleanly!
    expect(freshKr.activeEpoch).toBe(2);
    expect(constantTimeEqual(freshKr.getKey(1)!, ep1.record.key)).toBe(true);
    expect(constantTimeEqual(freshKr.getKey(2)!, ep2.record.key)).toBe(true);
  });

  test('enforces >= 16 hex char host pin, monotonic rosterVersion in rotateEpoch/createKeyGrant, and spec keyCommit domain', async () => {
    const host = await makePeer({ memberId: 'aaaa1111-1111-4111-8111-111111111111' });
    const alice = await makePeer({ memberId: 'bbbb2222-2222-4222-8222-222222222222' });
    const eve = await makePeer({ memberId: 'eeee5555-5555-4555-8555-555555555555' });

    // 1. Spec keyCommit domain string matches `docs/flows/room-vfs.md` ("vfs-rk-commit-v1|")
    expect(VFS_KEY_COMMIT_DOMAIN).toBe('vfs-rk-commit-v1|');
    const rk = generateVfsKey();
    const expectedCommit = await sha256Hex(concatBytes(utf8Bytes(`vfs-rk-commit-v1|${ROOM_ID}|1|`), rk));
    expect(await computeVfsKeyCommit(ROOM_ID, 1, rk)).toBe(expectedCommit);

    // 2. Host pin < 16 hex chars (8 or 15 chars) MUST be rejected in VfsKeyring and verifyKeyEpochHeader
    await expectVfsError(() => makeKeyring(alice, host.id.slice(0, 8)), 'VFS_INVALID_ENVELOPE');
    await expectVfsError(() => makeKeyring(alice, host.id.slice(0, 15)), 'VFS_INVALID_ENVELOPE');
    expect(makeKeyring(alice, host.id.slice(0, 16)).hostPin).toBe(host.id.slice(0, 16));

    const rosterV1 = await buildSignedRoster({ version: 1, host, peers: [host, alice, eve] });
    const hostKr = makeKeyring(host);
    const aliceKr = makeKeyring(alice, host.id.slice(0, 16));
    const ep1 = await hostKr.bootstrapEpoch1(rosterV1);
    await aliceKr.acceptEpochBroadcast({ header: ep1.header, wrapChunks: ep1.wrapChunks, roster: rosterV1 });

    await expectVfsError(
      verifyKeyEpochHeader(ep1.header, { roomId: ROOM_ID, roster: rosterV1, pinnedHost: host.id.slice(0, 8) }),
      'VFS_EPOCH_UNAUTHORIZED',
    );
    await expectVfsError(
      verifyKeyEpochHeader(ep1.header, { roomId: ROOM_ID, roster: rosterV1, pinnedHost: host.id.slice(0, 15) }),
      'VFS_EPOCH_UNAUTHORIZED',
    );

    // 3. Monotonic rosterVersion enforced in BOTH rotateEpoch AND createKeyGrant (rejects stale rosterV1 after rosterV2!)
    const rosterV2 = await buildSignedRoster({
      version: 2,
      prev: rosterV1,
      host,
      peers: [host, alice],
      removed: [{ id: eve.id, at: 1_750_000_020_000, revoked: true }],
    });
    const ep2 = await hostKr.rotateEpoch(rosterV2);
    await aliceKr.acceptEpochBroadcast({ header: ep2.header, wrapChunks: ep2.wrapChunks, roster: rosterV2 });

    // Rotating again with stale rosterV1 (which still contained removed Eve!) MUST fail!
    await expectVfsError(hostKr.rotateEpoch(rosterV1), 'VFS_EPOCH_ROLLBACK');

    // Issuing a key grant with stale rosterV1 (which still contained removed Eve!) MUST fail!
    const eveEntry = await toRosterEntry(eve);
    await expectVfsError(aliceKr.createKeyGrant({ recipient: eveEntry, roster: rosterV1 }), 'VFS_EPOCH_ROLLBACK');

    // Issuing a key grant to removed Eve even with rosterV2 MUST also fail!
    await expectVfsError(aliceKr.createKeyGrant({ recipient: eveEntry, roster: rosterV2 }), 'VFS_EPOCH_UNAUTHORIZED');
  });
});
