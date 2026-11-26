import { describe, expect, test } from 'bun:test';
import { base64, deviceId, encode } from './protocol';
import {
  RELAY_MAX_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
  SEALED_STATE_MAX_BYTES,
  appendHostPin,
  decodeAgentKeySecret,
  decryptRelayEnvelope,
  encodeAgentKeySecret,
  encryptRelayEnvelope,
  envelopeAad,
  exportRawPublicKey,
  generateEncKeyPair,
  hashRosterBody,
  importEncPrivateJwk,
  importEncPublicKey,
  isValidRelayEnvelopeShape,
  parseHostPin,
  sealAgentState,
  signDelegatedEntry,
  signEncBinding,
  signRoster,
  stripHostPinFromFragment,
  unsealAgentState,
  verifyDelegatedRosterEntry,
  verifyEncBinding,
  verifyRelayEnvelopeSig,
  verifyRoster,
  type AgentKeySecret,
  type RelayEnvelope,
  type RosterBody,
  type RosterEntry,
  type SignFn,
} from './relay-crypto';
import { fakeStorage, installFakeIndexedDB } from './test-indexeddb';
import { decryptWithEncKey, deriveSharedSecret, identity, resetIdentityCache, signDeviceEncKey } from './storage';

type TestDevice = {
  id: string;
  signPub: string;
  signKeys: CryptoKeyPair;
  encPub: string;
  encKeys: CryptoKeyPair;
  encVersion: number;
  memberId: string;
  role: 'human' | 'agent';
  operatorId?: string;
  wakeable?: true;
  sign: SignFn;
};

async function makeDevice(opts: {
  memberId: string;
  role?: 'human' | 'agent';
  operatorId?: string;
  wakeable?: true;
  encVersion?: number;
  extractable?: boolean;
}): Promise<TestDevice> {
  const extractable = opts.extractable ?? false;
  const signKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, extractable, ['sign', 'verify']);
  const signPub = base64(await crypto.subtle.exportKey('raw', signKeys.publicKey));
  const id = await deviceId(signPub);
  const encKeys = await generateEncKeyPair(extractable);
  const encPub = await exportRawPublicKey(encKeys.publicKey);
  const sign: SignFn = async value =>
    base64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKeys.privateKey, encode(value)));
  return {
    id,
    signPub,
    signKeys,
    encPub,
    encKeys,
    encVersion: opts.encVersion ?? 1,
    memberId: opts.memberId,
    role: opts.role ?? 'human',
    ...(opts.operatorId ? { operatorId: opts.operatorId } : {}),
    ...(opts.wakeable ? { wakeable: true as const } : {}),
    sign,
  };
}

async function makeRosterEntry(dev: TestDevice, room: string): Promise<RosterEntry> {
  const encSig = await signEncBinding(dev.sign, {
    room,
    deviceId: dev.id,
    enc: dev.encPub,
    encVersion: dev.encVersion,
  });
  return {
    id: dev.id,
    sign: dev.signPub,
    enc: dev.encPub,
    encVersion: dev.encVersion,
    encSig,
    memberId: dev.memberId,
    role: dev.role,
    ...(dev.operatorId ? { operatorId: dev.operatorId } : {}),
    ...(dev.wakeable ? { wakeable: true as const } : {}),
  };
}

describe('5.1 ECDH P-256 keys and encSig bindings', () => {
  test('generates distinct P-256 ECDH keypairs and binds them to device ECDSA identity', async () => {
    const dev = await makeDevice({ memberId: 'member-1' });
    expect(dev.encKeys.privateKey.extractable).toBe(false);
    expect(dev.encPub).toHaveLength(88);
    expect(dev.encPub).not.toBe(dev.signPub);

    const imported = await importEncPublicKey(dev.encPub);
    expect(await exportRawPublicKey(imported)).toBe(dev.encPub);

    const encSig = await signEncBinding(dev.sign, {
      room: 'room-1',
      deviceId: dev.id,
      enc: dev.encPub,
      encVersion: 1,
    });
    expect(await verifyEncBinding(dev.signPub, { room: 'room-1', deviceId: dev.id, enc: dev.encPub, encVersion: 1 }, encSig)).toBe(true);

    // Rejects wrong room, version, enc key, deviceId, or signing key.
    expect(await verifyEncBinding(dev.signPub, { room: 'room-2', deviceId: dev.id, enc: dev.encPub, encVersion: 1 }, encSig)).toBe(false);
    expect(await verifyEncBinding(dev.signPub, { room: 'room-1', deviceId: dev.id, enc: dev.encPub, encVersion: 2 }, encSig)).toBe(false);
    const other = await makeDevice({ memberId: 'member-2' });
    expect(await verifyEncBinding(dev.signPub, { room: 'room-1', deviceId: dev.id, enc: other.encPub, encVersion: 1 }, encSig)).toBe(false);
    expect(await verifyEncBinding(dev.signPub, { room: 'room-1', deviceId: other.id, enc: dev.encPub, encVersion: 1 }, encSig)).toBe(false);
    expect(await verifyEncBinding(other.signPub, { room: 'room-1', deviceId: dev.id, enc: dev.encPub, encVersion: 1 }, encSig)).toBe(false);

    // Rejects reusing the ECDSA signing key as the ECDH encryption key.
    const reusedSig = await signEncBinding(dev.sign, { room: 'room-1', deviceId: dev.id, enc: dev.signPub, encVersion: 1 });
    expect(await verifyEncBinding(dev.signPub, { room: 'room-1', deviceId: dev.id, enc: dev.signPub, encVersion: 1 }, reusedSig)).toBe(false);

    // Rejects malformed public keys on import.
    await expect(importEncPublicKey('short')).rejects.toThrow();
    const badPrefix = new Uint8Array(65);
    badPrefix[0] = 0x02;
    await expect(importEncPublicKey(base64(badPrefix.buffer))).rejects.toThrow();
  });
});

describe('5.2 Host-signed monotonic roster and Section 8 #9 adversarial attacks', () => {
  const room = 'room-alpha';

  test('verifies chained rosters, host pins, and delegated entries', async () => {
    const host = await makeDevice({ memberId: 'alice' });
    const guest = await makeDevice({ memberId: 'bob' });
    const bobPhone = await makeDevice({ memberId: 'bob' });
    const bobAgent = await makeDevice({ memberId: 'agent-1', role: 'agent', operatorId: 'bob', wakeable: true });

    const hostEntry = await makeRosterEntry(host, room);
    const guestEntry = await makeRosterEntry(guest, room);
    const v1Body: RosterBody = {
      v: 1, room, version: 1, prev: '', at: 1_700_000_001_000, host: host.id,
      devices: [hostEntry, guestEntry], removed: [],
    };
    const v1 = await signRoster(v1Body, host.sign);
    const res1 = await verifyRoster(v1, { roomId: room, expectedHostPin: host.id.slice(0, 16) });
    expect(res1.ok).toBe(true);

    // Bob certifies his own companion device and his own agent.
    const phoneBase = await makeRosterEntry(bobPhone, room);
    const phoneEntry: RosterEntry = {
      ...phoneBase,
      cert: await signDelegatedEntry(guest.sign, room, phoneBase, guest.id),
    };
    const agentBase = await makeRosterEntry(bobAgent, room);
    const agentEntry: RosterEntry = {
      ...agentBase,
      cert: await signDelegatedEntry(guest.sign, room, agentBase, guest.id),
    };

    // Standalone delegated verification while host is offline.
    expect((await verifyDelegatedRosterEntry(phoneEntry, v1, room)).ok).toBe(true);
    expect((await verifyDelegatedRosterEntry(agentEntry, v1, room)).ok).toBe(true);

    // Host folds delegated entries into v2.
    const v2Body: RosterBody = {
      v: 1, room, version: 2, prev: await hashRosterBody(v1.body), at: 1_700_000_002_000, host: host.id,
      devices: [hostEntry, guestEntry, phoneEntry, agentEntry], removed: [],
    };
    const v2 = await signRoster(v2Body, host.sign);
    const res2 = await verifyRoster(v2, { roomId: room, previous: v1, expectedHostPin: host.id.slice(0, 16) });
    expect(res2.ok).toBe(true);
  });

  test('Section 8 #9a: rejects substituted encryption key even when signed by host', async () => {
    const host = await makeDevice({ memberId: 'alice' });
    const victim = await makeDevice({ memberId: 'bob' });
    const attacker = await makeDevice({ memberId: 'mallory' });

    const hostEntry = await makeRosterEntry(host, room);
    const victimEntry = await makeRosterEntry(victim, room);
    // Coordinator substitutes victim's enc key with attacker's enc key (victim never signed it).
    const substituted: RosterEntry = { ...victimEntry, enc: attacker.encPub };
    const signed = await signRoster({
      v: 1, room, version: 1, prev: '', at: 1_700_000_001_000, host: host.id,
      devices: [hostEntry, substituted], removed: [],
    }, host.sign);

    const res = await verifyRoster(signed, { roomId: room });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('encSig');
  });

  test('Section 8 #9b: rejects roster rollback, prev-hash break, and host pin mismatch', async () => {
    const host = await makeDevice({ memberId: 'alice' });
    const guest = await makeDevice({ memberId: 'bob' });
    const hostEntry = await makeRosterEntry(host, room);
    const guestEntry = await makeRosterEntry(guest, room);

    const v1 = await signRoster({
      v: 1, room, version: 1, prev: '', at: 1_700_000_001_000, host: host.id,
      devices: [hostEntry, guestEntry], removed: [],
    }, host.sign);
    const v2 = await signRoster({
      v: 1, room, version: 2, prev: await hashRosterBody(v1.body), at: 1_700_000_002_000, host: host.id,
      devices: [hostEntry], removed: [{ id: guest.id, at: 1_700_000_002_000, revoked: true }],
    }, host.sign);
    expect((await verifyRoster(v2, { roomId: room, previous: v1 })).ok).toBe(true);

    // Replay v1 after seeing v2 (to re-add revoked guest): refused.
    const rollbackPrev = await verifyRoster(v1, { roomId: room, previous: v2 });
    expect(rollbackPrev.ok).toBe(false);
    const rollbackMin = await verifyRoster(v1, { roomId: room, minVersion: 2 });
    expect(rollbackMin.ok).toBe(false);

    // Same version replay: refused.
    const sameVersion = await verifyRoster(v2, { roomId: room, previous: v2 });
    expect(sameVersion.ok).toBe(false);

    // Wrong prev hash: refused.
    const badPrev = await signRoster({
      v: 1, room, version: 3, prev: '0'.repeat(64), at: 1_700_000_003_000, host: host.id,
      devices: [hostEntry], removed: [{ id: guest.id, at: 1_700_000_002_000, revoked: true }],
    }, host.sign);
    expect((await verifyRoster(badPrev, { roomId: room, previous: v2 })).ok).toBe(false);

    // Wrong host pin: refused.
    const wrongPin = await verifyRoster(v1, { roomId: room, expectedHostPin: 'deadbeef00000000' });
    expect(wrongPin.ok).toBe(false);

    // Wrong room: refused.
    expect((await verifyRoster(v1, { roomId: 'other-room' })).ok).toBe(false);
  });

  test('Section 8 #9c: rejects delegated entry from removed certifier, wrong authority, or delegation chain', async () => {
    const host = await makeDevice({ memberId: 'alice' });
    const bob = await makeDevice({ memberId: 'bob' });
    const carol = await makeDevice({ memberId: 'carol' });
    const bobCompanion = await makeDevice({ memberId: 'bob' });
    const bobCompanion2 = await makeDevice({ memberId: 'bob' });
    const bobAgent = await makeDevice({ memberId: 'agent-b', role: 'agent', operatorId: 'bob' });

    const hostEntry = await makeRosterEntry(host, room);
    const bobEntry = await makeRosterEntry(bob, room);
    const carolEntry = await makeRosterEntry(carol, room);

    const compBase = await makeRosterEntry(bobCompanion, room);
    const compCertifiedByBob: RosterEntry = {
      ...compBase,
      cert: await signDelegatedEntry(bob.sign, room, compBase, bob.id),
    };

    // Bob is removed, yet his delegated companion stays in devices -> MUST BE REFUSED.
    const revokedCertifierRoster = await signRoster({
      v: 1, room, version: 1, prev: '', at: 1_700_000_001_000, host: host.id,
      devices: [hostEntry, carolEntry, compCertifiedByBob],
      removed: [{ id: bob.id, at: 1_700_000_001_000, revoked: true }],
    }, host.sign);
    expect((await verifyRoster(revokedCertifierRoster, { roomId: room })).ok).toBe(false);

    // Standalone check also rejects removed certifier.
    const cleanAfterRemoval = await signRoster({
      v: 1, room, version: 1, prev: '', at: 1_700_000_001_000, host: host.id,
      devices: [hostEntry, carolEntry],
      removed: [{ id: bob.id, at: 1_700_000_001_000, revoked: true }],
    }, host.sign);
    expect((await verifyDelegatedRosterEntry(compCertifiedByBob, cleanAfterRemoval, room)).ok).toBe(false);

    // Carol cannot certify Bob's companion (different memberId).
    const badMemberCert: RosterEntry = {
      ...compBase,
      cert: await signDelegatedEntry(carol.sign, room, compBase, carol.id),
    };
    const badMemberRoster = await signRoster({
      v: 1, room, version: 1, prev: '', at: 1_700_000_001_000, host: host.id,
      devices: [hostEntry, bobEntry, carolEntry, badMemberCert], removed: [],
    }, host.sign);
    expect((await verifyRoster(badMemberRoster, { roomId: room })).ok).toBe(false);

    // Carol cannot certify Bob's agent (operatorId !== carol).
    const agentBase = await makeRosterEntry(bobAgent, room);
    const badAgentCert: RosterEntry = {
      ...agentBase,
      cert: await signDelegatedEntry(carol.sign, room, agentBase, carol.id),
    };
    const badAgentRoster = await signRoster({
      v: 1, room, version: 1, prev: '', at: 1_700_000_001_000, host: host.id,
      devices: [hostEntry, bobEntry, carolEntry, badAgentCert], removed: [],
    }, host.sign);
    expect((await verifyRoster(badAgentRoster, { roomId: room })).ok).toBe(false);

    // Delegation chain forbidden: delegated bobCompanion cannot certify bobCompanion2.
    const comp2Base = await makeRosterEntry(bobCompanion2, room);
    const chainedEntry: RosterEntry = {
      ...comp2Base,
      cert: await signDelegatedEntry(bobCompanion.sign, room, comp2Base, bobCompanion.id),
    };
    const chainedRoster = await signRoster({
      v: 1, room, version: 1, prev: '', at: 1_700_000_001_000, host: host.id,
      devices: [hostEntry, bobEntry, compCertifiedByBob, chainedEntry], removed: [],
    }, host.sign);
    expect((await verifyRoster(chainedRoster, { roomId: room })).ok).toBe(false);
  });

  test('Section 8 #9d: host transfer N -> N+1 (old host signs) -> N+2 (new host signs) and hijack rejection', async () => {
    const oldHost = await makeDevice({ memberId: 'alice' });
    const newHost = await makeDevice({ memberId: 'bob' });
    const third = await makeDevice({ memberId: 'carol' });

    const oldEntry = await makeRosterEntry(oldHost, room);
    const newEntry = await makeRosterEntry(newHost, room);
    const thirdEntry = await makeRosterEntry(third, room);

    const v1 = await signRoster({
      v: 1, room, version: 1, prev: '', at: 1_700_000_001_000, host: oldHost.id,
      devices: [oldEntry, newEntry], removed: [],
    }, oldHost.sign);
    expect((await verifyRoster(v1, { roomId: room, expectedHostPin: oldHost.id.slice(0, 16) })).ok).toBe(true);

    // Unauthorized hijack: newHost tries to sign v2 claiming host without oldHost signing it -> REFUSED.
    const v2Body: RosterBody = {
      v: 1, room, version: 2, prev: await hashRosterBody(v1.body), at: 1_700_000_002_000, host: newHost.id,
      devices: [oldEntry, newEntry], removed: [],
    };
    const hijackedV2 = await signRoster(v2Body, newHost.sign);
    expect((await verifyRoster(hijackedV2, { roomId: room, previous: v1 })).ok).toBe(false);

    // Legitimate transfer: oldHost signs v2 naming newHost -> ACCEPTED (even with oldHost pin!).
    const validV2 = await signRoster(v2Body, oldHost.sign);
    const res2 = await verifyRoster(validV2, { roomId: room, previous: v1, expectedHostPin: oldHost.id.slice(0, 16) });
    expect(res2.ok).toBe(true);
    if (res2.ok) expect(res2.hostDeviceId).toBe(newHost.id);

    // Deposed oldHost tries to sign v3 -> REFUSED.
    const v3Body: RosterBody = {
      v: 1, room, version: 3, prev: await hashRosterBody(validV2.body), at: 1_700_000_003_000, host: newHost.id,
      devices: [oldEntry, newEntry, thirdEntry], removed: [],
    };
    const deposedV3 = await signRoster(v3Body, oldHost.sign);
    expect((await verifyRoster(deposedV3, { roomId: room, previous: validV2 })).ok).toBe(false);

    // New host signs v3 -> ACCEPTED.
    const validV3 = await signRoster(v3Body, newHost.sign);
    const res3 = await verifyRoster(validV3, { roomId: room, previous: validV2, expectedHostPin: newHost.id.slice(0, 16) });
    expect(res3.ok).toBe(true);
  });
});

describe('Host pin URL fragment helpers', () => {
  const hostId = '0123456789abcdef' + 'a'.repeat(48);

  test('appends, parses, replaces, and preserves existing invite tokens', () => {
    const pinnedRoom = appendHostPin('https://meshrooms.wormdb.dev/r/room1', hostId);
    expect(pinnedRoom).toBe('https://meshrooms.wormdb.dev/r/room1#h=0123456789abcdef');
    expect(parseHostPin(pinnedRoom)).toBe('0123456789abcdef');

    const pinnedAgent = appendHostPin('https://meshrooms.wormdb.dev/r/room1#secretToken123', hostId);
    expect(pinnedAgent).toBe('https://meshrooms.wormdb.dev/r/room1#secretToken123&h=0123456789abcdef');
    expect(parseHostPin(pinnedAgent)).toBe('0123456789abcdef');
    expect(stripHostPinFromFragment('#secretToken123&h=0123456789abcdef')).toBe('secretToken123');

    // Re-pinning replaces previous h= without duplicating.
    const otherId = 'fedcba9876543210' + 'b'.repeat(48);
    const repinned = appendHostPin(pinnedAgent, otherId);
    expect(repinned).toBe('https://meshrooms.wormdb.dev/r/room1#secretToken123&h=fedcba9876543210');
    expect(parseHostPin(repinned)).toBe('fedcba9876543210');

    expect(parseHostPin('https://meshrooms.wormdb.dev/r/room1')).toBeUndefined();
    expect(parseHostPin('https://meshrooms.wormdb.dev/r/room1#tokOnly')).toBeUndefined();
    expect(parseHostPin('#h=not-hex!')).toBeUndefined();
    expect(parseHostPin('#h=1234')).toBeUndefined();
  });
});

describe('5.3 Relay envelope E2EE, padding buckets, and Section 8 #10 adversarial attacks', () => {
  const room = 'room-relay-1';

  test('multi-recipient encrypt/decrypt, key version binding, and bucketed padding', async () => {
    const alice = await makeDevice({ memberId: 'alice' });
    const bob = await makeDevice({ memberId: 'bob' });
    const carol = await makeDevice({ memberId: 'carol' });
    const outsider = await makeDevice({ memberId: 'outsider' });

    const recipients = [await makeRosterEntry(bob, room), await makeRosterEntry(carol, room)];
    const packet1 = { body: { kind: 'message', text: 'hi' }, signature: 'sig1' };
    const packet2 = { body: { kind: 'message', text: 'x'.repeat(500) }, signature: 'sig2' };

    const env1 = await encryptRelayEnvelope(packet1, {
      room, from: alice.id, id: crypto.randomUUID(), seq: 1, rosterVersion: 3, lane: 'primary',
      sign: alice.sign,
      recipients, wake: [carol.id], hold: true,
    });
    const env2 = await encryptRelayEnvelope(packet2, {
      room, from: alice.id, id: crypto.randomUUID(), seq: 2, rosterVersion: 3, lane: 'primary',
      sign: alice.sign,
      recipients,
    });

    // Both small packets land in the 1024-byte padding bucket -> identical ciphertext length!
    expect(env1.ct.length).toBe(env2.ct.length);
    expect(env1.v).toBe(RELAY_PROTOCOL_VERSION);
    expect(env1.wake).toEqual([carol.id]);
    expect(env1.hold).toBe(true);

    // Both recipients decrypt identically.
    const decBob = await decryptRelayEnvelope<typeof packet1>(env1, {
      room, senderSignKey: alice.signPub, selfDeviceId: bob.id, selfEncPrivateKey: bob.encKeys.privateKey, selfEncVersion: bob.encVersion,
    });
    expect(decBob.packet).toEqual(packet1);
    expect(decBob.rosterVersion).toBe(3);

    const decCarol = await decryptRelayEnvelope<typeof packet1>(env1, {
      room, senderSignKey: alice.signPub, selfDeviceId: carol.id, selfEncPrivateKey: carol.encKeys.privateKey, selfEncVersion: carol.encVersion,
    });
    expect(decCarol.packet).toEqual(packet1);

    // Non-recipient fails.
    await expect(decryptRelayEnvelope(env1, {
      room, senderSignKey: alice.signPub, selfDeviceId: outsider.id, selfEncPrivateKey: outsider.encKeys.privateKey, selfEncVersion: outsider.encVersion,
    })).rejects.toThrow();

    // Wrong encVersion fails DEK unwrap.
    await expect(decryptRelayEnvelope(env1, {
      room, senderSignKey: alice.signPub, selfDeviceId: bob.id, selfEncPrivateKey: bob.encKeys.privateKey, selfEncVersion: 2,
    })).rejects.toThrow();

    // 12,000-byte binary file chunk (~16 KB base64 JSON) fits inside 32 KB wire cap with 16 recipients!
    const manyRecipients: RosterEntry[] = [];
    for (let i = 0; i < 16; i++) {
      manyRecipients.push(await makeRosterEntry(await makeDevice({ memberId: `m-${i}` }), room));
    }
    const chunkPayload = { kind: 'file-chunk', sha256: 'a'.repeat(64), offset: 0, data: 'A'.repeat(16000) };
    const fileEnv = await encryptRelayEnvelope(chunkPayload, {
      room, from: alice.id, id: crypto.randomUUID(), seq: 3, rosterVersion: 3, lane: 'file',
      sign: alice.sign,
      recipients: manyRecipients,
    });
    expect(new TextEncoder().encode(JSON.stringify(fileEnv)).byteLength).toBeLessThanOrEqual(RELAY_MAX_FRAME_BYTES);
  });

  test('Section 8 #10: refuses cross-room splice, swapped recipients, changed from, reflection, tampered AAD fields, and oversized frames', async () => {
    const alice = await makeDevice({ memberId: 'alice' });
    const bob = await makeDevice({ memberId: 'bob' });
    const carol = await makeDevice({ memberId: 'carol' });
    const bobEntry = await makeRosterEntry(bob, room);
    const carolEntry = await makeRosterEntry(carol, room);

    const env = await encryptRelayEnvelope({ kind: 'message', text: 'secret' }, {
      room, from: alice.id, id: crypto.randomUUID(), seq: 7, rosterVersion: 4, lane: 'primary',
      sign: alice.sign,
      recipients: [bobEntry, carolEntry], wake: [carol.id], hold: true,
    });

    const bobOpts = {
      room, senderSignKey: alice.signPub, selfDeviceId: bob.id, selfEncPrivateKey: bob.encKeys.privateKey, selfEncVersion: bob.encVersion,
    };

    // 1. Cross-room splice (delivered to wrong room, or room header rewritten).
    await expect(decryptRelayEnvelope(env, { ...bobOpts, room: 'other-room' })).rejects.toThrow();
    await expect(decryptRelayEnvelope({ ...env, room: 'other-room' }, { ...bobOpts, room: 'other-room' })).rejects.toThrow();

    // 2. Swapped recipient list (removed carol, or added extra recipient).
    const removedRecipient: RelayEnvelope = { ...env, to: { [bob.id]: env.to[bob.id] } };
    await expect(decryptRelayEnvelope(removedRecipient, bobOpts)).rejects.toThrow();
    const addedRecipient: RelayEnvelope = { ...env, to: { ...env.to, [alice.id]: env.to[carol.id] } };
    await expect(decryptRelayEnvelope(addedRecipient, bobOpts)).rejects.toThrow();

    // 3. Changed `from`.
    await expect(decryptRelayEnvelope({ ...env, from: carol.id }, bobOpts)).rejects.toThrow();

    // 4. Reflected frame (`from === selfDeviceId`).
    await expect(decryptRelayEnvelope({ ...env, from: bob.id }, bobOpts)).rejects.toThrow(/reflected/i);
    await expect(encryptRelayEnvelope({ ok: 1 }, {
      room, from: alice.id, id: crypto.randomUUID(), seq: 1, rosterVersion: 1, lane: 'primary',
      sign: alice.sign,
      recipients: [await makeRosterEntry(alice, room)],
    })).rejects.toThrow();

    // 5. Tampered wake / hold / lane / seq / roster / id.
    await expect(decryptRelayEnvelope({ ...env, wake: [bob.id] }, bobOpts)).rejects.toThrow();
    await expect(decryptRelayEnvelope({ ...env, wake: undefined }, bobOpts)).rejects.toThrow();
    await expect(decryptRelayEnvelope({ ...env, hold: undefined }, bobOpts)).rejects.toThrow();
    await expect(decryptRelayEnvelope({ ...env, lane: 'file' }, bobOpts)).rejects.toThrow();
    await expect(decryptRelayEnvelope({ ...env, seq: 8 }, bobOpts)).rejects.toThrow();
    await expect(decryptRelayEnvelope({ ...env, roster: 5 }, bobOpts)).rejects.toThrow();
    await expect(decryptRelayEnvelope({ ...env, id: crypto.randomUUID() }, bobOpts)).rejects.toThrow();

    // 6. minRosterVersion & expectedFrom enforcement.
    await expect(decryptRelayEnvelope(env, { ...bobOpts, minRosterVersion: 5 })).rejects.toThrow();
    await expect(decryptRelayEnvelope(env, { ...bobOpts, expectedFrom: carol.id })).rejects.toThrow();

    // 7. Oversized frame (> 32 KB) rejected on both encrypt and decrypt.
    await expect(encryptRelayEnvelope({ big: 'x'.repeat(25_000) }, {
      room, from: alice.id, id: crypto.randomUUID(), seq: 1, rosterVersion: 1, lane: 'file',
      sign: alice.sign,
      recipients: [bobEntry],
    })).rejects.toThrow();
    const oversized: RelayEnvelope = { ...env, ct: 'A'.repeat(RELAY_MAX_FRAME_BYTES) };
    await expect(decryptRelayEnvelope(oversized, bobOpts)).rejects.toThrow();

    // Verify AAD sorts recipients deterministically regardless of insertion order.
    const reversedTo: Record<string, string> = {};
    for (const k of Object.keys(env.to).reverse()) reversedTo[k] = env.to[k];
    expect(envelopeAad(env)).toEqual(envelopeAad({ ...env, to: reversedTo }));
  });
});

describe('Relay envelope sender authentication (envelope signature)', () => {
  const room = 'room-sender-auth';
  const setup = async () => {
    const alice = await makeDevice({ memberId: 'alice' });
    const bob = await makeDevice({ memberId: 'bob' });
    const mallory = await makeDevice({ memberId: 'mallory' });
    const bobEntry = await makeRosterEntry(bob, room);
    const bobOpts = (senderSignKey: string) => ({
      room, senderSignKey, selfDeviceId: bob.id, selfEncPrivateKey: bob.encKeys.privateKey, selfEncVersion: bob.encVersion,
    });
    const seal = (from: TestDevice, signer: TestDevice, extra: Record<string, unknown> = {}) => encryptRelayEnvelope({ kind: 'activity', note: 'hi' }, {
      room, from: from.id, sign: signer.sign, id: crypto.randomUUID(), seq: 1, rosterVersion: 1, lane: 'primary', recipients: [bobEntry], ...extra,
    });
    return { alice, bob, mallory, bobOpts, seal };
  };

  test('an envelope verifies and decrypts under the real sender\'s roster key', async () => {
    const { alice, bobOpts, seal } = await setup();
    const env = await seal(alice, alice);
    expect(env.sig).toHaveLength(88);
    const out = await decryptRelayEnvelope<{ note: string }>(env, bobOpts(alice.signPub));
    expect(out.packet.note).toBe('hi');
  });

  test('regression: a member who only knows the recipient\'s PUBLIC key cannot forge `from` (formerly decrypted as the victim)', async () => {
    const { alice, mallory, bobOpts, seal } = await setup();
    // Mallory addresses bob using bob's public enc key from the roster, claims to be alice, and even picks the roster version.
    const forged = await seal(alice, mallory, { rosterVersion: 9_000_000_000_000 });
    expect(forged.from).toBe(alice.id);
    await expect(decryptRelayEnvelope(forged, bobOpts(alice.signPub))).rejects.toThrow(/sender signature invalid/);
    // Mallory's own key obviously verifies her own envelope, but only the roster key of the CLAIMED sender is ever used.
    await expect(decryptRelayEnvelope(forged, bobOpts(mallory.signPub))).resolves.toBeDefined();
  });

  test('no routing or ciphertext field can be changed after signing, and a missing signature is not an envelope', async () => {
    const { alice, bobOpts, seal } = await setup();
    const env = await seal(alice, alice, { wake: [], hold: true });
    const other = await seal(alice, alice);
    const tampered: Record<string, RelayEnvelope> = {
      roster: { ...env, roster: env.roster + 1 },
      seq: { ...env, seq: env.seq + 1 },
      id: { ...env, id: crypto.randomUUID() },
      lane: { ...env, lane: 'file' },
      hold: { ...env, hold: undefined },
      epk: { ...env, epk: other.epk },
      iv: { ...env, iv: other.iv },
      ct: { ...env, ct: other.ct },
      to: { ...env, to: { ...env.to, [alice.id]: Object.values(env.to)[0] } },
    };
    for (const [field, mutated] of Object.entries(tampered)) {
      await expect(decryptRelayEnvelope(mutated, bobOpts(alice.signPub)), field).rejects.toThrow();
    }
    // A signature lifted from another envelope of the same sender does not carry over.
    await expect(decryptRelayEnvelope({ ...env, sig: other.sig }, bobOpts(alice.signPub))).rejects.toThrow(/sender signature invalid/);
    const { sig: _sig, ...unsigned } = env;
    expect(isValidRelayEnvelopeShape(unsigned)).toBe(false);
    await expect(decryptRelayEnvelope(unsigned, bobOpts(alice.signPub))).rejects.toThrow(/Invalid relay envelope shape/);
    expect(isValidRelayEnvelopeShape({ ...env, sig: 'short' })).toBe(false);
  });

  test('a signature does not depend on the key order of `to`, and encrypting without a signer is refused', async () => {
    const { alice, bobOpts, seal } = await setup();
    const env = await seal(alice, alice);
    const reordered = { ...env, to: Object.fromEntries(Object.entries(env.to).reverse()) };
    expect(await verifyRelayEnvelopeSig(reordered, alice.signPub)).toBe(true);
    await expect(decryptRelayEnvelope(reordered, bobOpts(alice.signPub))).resolves.toBeDefined();
    await expect(encryptRelayEnvelope({ x: 1 }, {
      room, from: alice.id, id: crypto.randomUUID(), seq: 1, rosterVersion: 1, lane: 'primary', recipients: [await makeRosterEntry(await makeDevice({ memberId: 'z' }), room)],
    } as never)).rejects.toThrow(/must be signed/);
  });

  test('a sixteen-recipient file frame with a signature still fits the 32 KB wire cap', async () => {
    const { alice } = await setup();
    const recipients: RosterEntry[] = [];
    for (let i = 0; i < 16; i++) recipients.push(await makeRosterEntry(await makeDevice({ memberId: `m-${i}` }), room));
    const env = await encryptRelayEnvelope({ kind: 'file-chunk', data: 'A'.repeat(16_000) }, {
      room, from: alice.id, sign: alice.sign, id: crypto.randomUUID(), seq: 1, rosterVersion: 1, lane: 'file', recipients,
    });
    expect(new TextEncoder().encode(JSON.stringify(env)).byteLength).toBeLessThanOrEqual(RELAY_MAX_FRAME_BYTES);
  });

  test('envelope ids with whitespace, control chars, or non-ASCII are rejected so nothing can bypass RelayReplayGuard', async () => {
    const { alice, bobOpts, seal } = await setup();
    const valid = await seal(alice, alice);
    for (const badId of ['has space', 'tab\there', 'line\nbreak', 'non-ascii-é', 'x'.repeat(129)]) {
      expect(isValidRelayEnvelopeShape({ ...valid, id: badId })).toBe(false);
      await expect(seal(alice, alice, { id: badId })).rejects.toThrow(/printable ASCII/);
      await expect(decryptRelayEnvelope({ ...valid, id: badId }, bobOpts(alice.signPub))).rejects.toThrow(/Invalid relay envelope shape/);
    }
  });
});

describe('6.3 & 6.4 Sealed agent state and MESHROOMS_AGENT_KEY', () => {
  test('seals and unseals state with non-extractable CryptoKey, JsonWebKey interop, and raw secret', async () => {
    const agent = await makeDevice({ memberId: 'agent-1', role: 'agent', extractable: true });
    const encJwk = await crypto.subtle.exportKey('jwk', agent.encKeys.privateKey);
    const nonExtractableKey = await importEncPrivateJwk(encJwk, false);
    expect(nonExtractableKey.extractable).toBe(false);

    const ctx = { room: 'room-s1', deviceId: agent.id };
    const state = { cursor: 42, highestRosterVersion: 7, recent: [{ id: 'm1', text: 'hello' }] };

    // Seal with JWK, unseal with non-extractable CryptoKey (and vice-versa)!
    const blob = await sealAgentState(state, encJwk, ctx);
    expect(await unsealAgentState(blob, nonExtractableKey, ctx)).toEqual(state);

    const blob2 = await sealAgentState(state, nonExtractableKey, ctx);
    expect(await unsealAgentState(blob2, encJwk, ctx)).toEqual(state);

    // Wrong room, wrong deviceId, wrong key, or tampered blob all fail.
    await expect(unsealAgentState(blob, nonExtractableKey, { room: 'other', deviceId: agent.id })).rejects.toThrow();
    await expect(unsealAgentState(blob, nonExtractableKey, { room: 'room-s1', deviceId: 'other-dev' })).rejects.toThrow();
    const otherAgent = await makeDevice({ memberId: 'agent-2', role: 'agent' });
    await expect(unsealAgentState(blob, otherAgent.encKeys.privateKey, ctx)).rejects.toThrow();
    const tampered = blob.slice(0, -4) + (blob.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    await expect(unsealAgentState(tampered, nonExtractableKey, ctx)).rejects.toThrow();

    // Raw Uint8Array secret also works.
    const rawSecret = crypto.getRandomValues(new Uint8Array(32));
    const rawBlob = await sealAgentState(state, rawSecret, ctx);
    expect(await unsealAgentState(rawBlob, rawSecret, ctx)).toEqual(state);

    // Oversized state (> 256 KB) rejected on both seal and unseal.
    await expect(sealAgentState({ pad: 'z'.repeat(SEALED_STATE_MAX_BYTES) }, rawSecret, ctx)).rejects.toThrow();
    await expect(unsealAgentState('A'.repeat(SEALED_STATE_MAX_BYTES + 4), rawSecret, ctx)).rejects.toThrow();
  });

  test('encodes and strictly validates MESHROOMS_AGENT_KEY secrets', async () => {
    const dev = await makeDevice({ memberId: 'agent-1', role: 'agent', extractable: true });
    const signJwk = await crypto.subtle.exportKey('jwk', dev.signKeys.privateKey);
    const encJwk = await crypto.subtle.exportKey('jwk', dev.encKeys.privateKey);

    const secret: AgentKeySecret = {
      origin: 'https://meshrooms.wormdb.dev',
      roomId: 'room-xyz',
      signJwk,
      encJwk,
      encVersion: 1,
      hostPin: '0123456789ABCDEF',
    };
    const encoded = encodeAgentKeySecret(secret);
    const decoded = decodeAgentKeySecret(`  ${encoded}\n`);
    expect(decoded.origin).toBe('https://meshrooms.wormdb.dev');
    expect(decoded.roomId).toBe('room-xyz');
    expect(decoded.encVersion).toBe(1);
    expect(decoded.hostPin).toBe('0123456789abcdef');
    expect(decoded.signJwk.d).toBe(signJwk.d);
    expect(decoded.encJwk.d).toBe(encJwk.d);

    // Rejects invalid origin, reused key, bad encVersion, bad hostPin, malformed base64.
    expect(() => encodeAgentKeySecret({ ...secret, origin: 'https://meshrooms.wormdb.dev/path' })).toThrow();
    expect(() => encodeAgentKeySecret({ ...secret, origin: 'ftp://example.com' })).toThrow();
    expect(() => encodeAgentKeySecret({ ...secret, roomId: '   ' })).toThrow();
    expect(() => encodeAgentKeySecret({ ...secret, encJwk: signJwk })).toThrow();
    expect(() => encodeAgentKeySecret({ ...secret, encVersion: 0 })).toThrow();
    expect(() => encodeAgentKeySecret({ ...secret, hostPin: 'not-hex!' })).toThrow();
    expect(() => decodeAgentKeySecret('')).toThrow();
    expect(() => decodeAgentKeySecret('!!!not-base64!!!')).toThrow();
  });
});

describe('Browser storage.ts ECDH identity upgrade and decryption helpers', () => {
  test('seamlessly upgrades a legacy stored Identity with non-exportable ECDH keys and decrypts relay envelopes', async () => {
    installFakeIndexedDB();
    const priorIdentity = fakeStorage.records.get('identity');
    resetIdentityCache();
    try {
      // Seed a legacy pre-relay identity record (ECDSA only, no encKeys).
      const legacyKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const legacyPub = base64(await crypto.subtle.exportKey('raw', legacyKeys.publicKey));
      const legacyId = await deviceId(legacyPub);
      fakeStorage.records.set('identity', { id: legacyId, publicKey: legacyPub, keys: legacyKeys });

      const upgraded = await identity();
      expect(upgraded.id).toBe(legacyId);
      expect(upgraded.publicKey).toBe(legacyPub);
      expect(upgraded.encKeys.privateKey.extractable).toBe(false);
      expect(upgraded.encPublicKey).toHaveLength(88);
      expect(upgraded.encPublicKey).not.toBe(legacyPub);
      expect(upgraded.encVersion).toBe(1);
      expect(await verifyEncBinding(upgraded.publicKey, {
        room: '*',
        deviceId: upgraded.id,
        enc: upgraded.encPublicKey,
        encVersion: upgraded.encVersion,
      }, upgraded.encSig)).toBe(true);

      // Room-scoped signing helper verifies against specific roomId.
      const room = 'room-browser-1';
      const roomBinding = await signDeviceEncKey(room);
      expect(await verifyEncBinding(upgraded.publicKey, {
        room,
        deviceId: upgraded.id,
        enc: roomBinding.enc,
        encVersion: roomBinding.encVersion,
      }, roomBinding.encSig)).toBe(true);

      // Encrypt a relay envelope from a peer to this browser identity and decrypt with decryptWithEncKey.
      const sender = await makeDevice({ memberId: 'peer-1' });
      const browserEntry: RosterEntry = {
        id: upgraded.id,
        sign: upgraded.publicKey,
        enc: roomBinding.enc,
        encVersion: roomBinding.encVersion,
        encSig: roomBinding.encSig,
        memberId: 'browser-member',
        role: 'human',
      };
      const env = await encryptRelayEnvelope({ kind: 'message', text: 'hello browser' }, {
        room,
        from: sender.id,
        sign: sender.sign,
        id: crypto.randomUUID(),
        seq: 1,
        rosterVersion: 1,
        lane: 'primary',
        recipients: [browserEntry],
      });
      const decrypted = await decryptWithEncKey<{ kind: string; text: string }>(env, { room, senderSignKey: sender.signPub });
      expect(decrypted.packet).toEqual({ kind: 'message', text: 'hello browser' });
      expect(decrypted.rosterVersion).toBe(1);

      // deriveSharedSecret produces a 32-byte shared secret matching peer ECDH.
      const secretA = new Uint8Array(await deriveSharedSecret(sender.encPub));
      const secretB = new Uint8Array(await crypto.subtle.deriveBits(
        { name: 'ECDH', public: await importEncPublicKey(upgraded.encPublicKey) },
        sender.encKeys.privateKey,
        256,
      ));
      expect(secretA).toEqual(secretB);
    } finally {
      if (priorIdentity === undefined) fakeStorage.records.delete('identity');
      else fakeStorage.records.set('identity', priorIdentity);
      resetIdentityCache();
    }
  });
});
