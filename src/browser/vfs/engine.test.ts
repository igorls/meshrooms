import { afterEach, describe, expect, test } from 'bun:test';
import { BunFileVfsStore } from '../../../server/persistence/vfs-bunfile';
import { testDirectory } from '../../../server/test-directory';
import { base64, deviceId, encode } from '../protocol';
import {
  exportRawPublicKey,
  generateEncKeyPair,
  hashRosterBody,
  signDelegatedEntry,
  signEncBinding,
  signRoster,
  type RosterBody,
  type RosterEntry,
  type SignFn,
  type SignedRoster,
} from '../relay-crypto';
import { VfsError, VfsObjKind, type VfsErrorCode } from './constants';
import {
  VfsRoomEngine,
  VfsUnauthorizedError,
  type VfsChangeEvent,
  type VfsSignerInfo,
  type VfsSignerLookup,
} from './engine';
import { VfsConflictError } from './patch';
import { MemoryVfsStore, type VfsStore } from './store';
import { IndexedDbVfsStore } from './store-indexeddb';
import type { VfsKeyEpochPacket, VfsKeyWrapPacket, VfsRecordPacket } from './wire';

const ROOM_ID = '11111111-1111-4111-8111-111111111111';
const HOST_MEMBER = 'aaaa1111-1111-4111-8111-111111111111';
const GUEST_MEMBER = 'bbbb2222-2222-4222-8222-222222222222';
const AGENT_MEMBER = 'cccc3333-3333-4333-8333-333333333333';

const tempDirs: ReturnType<typeof testDirectory>[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    tempDirs.pop()!.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Test Peer, Roster & Mesh Helpers
// ---------------------------------------------------------------------------

type TestPeerIdentity = {
  id: string;
  memberId: string;
  role: 'human' | 'agent';
  operatorId?: string;
  signPub: string;
  signKeys: CryptoKeyPair;
  encPub: string;
  encKeys: CryptoKeyPair;
  encVersion: number;
  sign: SignFn;
};

async function createPeerIdentity(opts: {
  memberId: string;
  role: 'human' | 'agent';
  operatorId?: string;
}): Promise<TestPeerIdentity> {
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
    role: opts.role,
    operatorId: opts.operatorId,
    signPub,
    signKeys,
    encPub,
    encKeys,
    encVersion: 1,
    sign,
  };
}

async function toRosterEntry(peer: TestPeerIdentity, room = ROOM_ID): Promise<RosterEntry> {
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

async function buildRoster(opts: {
  version: number;
  prev?: SignedRoster;
  host: TestPeerIdentity;
  peers: TestPeerIdentity[];
  removed?: Array<{ id: string; at: number; revoked: boolean }>;
  at?: number;
}): Promise<SignedRoster> {
  const devices = await Promise.all(opts.peers.map(p => toRosterEntry(p)));
  const body: RosterBody = {
    v: 1,
    room: ROOM_ID,
    version: opts.version,
    prev: opts.prev ? await hashRosterBody(opts.prev.body) : '',
    at: opts.at ?? 1_750_000_000_000 + opts.version * 1_000,
    host: opts.host.id,
    devices,
    removed: opts.removed ?? [],
  };
  return signRoster(body, opts.host.sign);
}

function makeSignerLookup(
  roster: SignedRoster,
  extraKnown: ReadonlyMap<string, TestPeerIdentity> = new Map(),
): VfsSignerLookup {
  const removedMap = new Map(roster.body.removed.map(r => [r.id, r]));
  const activeMap = new Map(roster.body.devices.map(d => [d.id, d]));

  return (devId: string): VfsSignerInfo | undefined => {
    const rem = removedMap.get(devId);
    const active = activeMap.get(devId);
    if (active) {
      return {
        deviceId: active.id,
        memberId: active.memberId,
        signPublicKey: active.sign,
        role: active.role,
        revoked: false,
      };
    }
    const extra = extraKnown.get(devId);
    if (extra) {
      return {
        deviceId: extra.id,
        memberId: extra.memberId,
        signPublicKey: extra.signPub,
        role: extra.role,
        revoked: rem?.revoked ?? false,
      };
    }
    return undefined;
  };
}

async function openEngineForPeer(opts: {
  peer: TestPeerIdentity;
  store?: VfsStore;
  isHost?: boolean;
  pinnedHost?: string;
  now?: () => number;
}): Promise<{ engine: VfsRoomEngine; store: VfsStore }> {
  const store = opts.store ?? new MemoryVfsStore();
  const roomStore = await store.openRoom(ROOM_ID);
  const engine = await VfsRoomEngine.open({
    roomId: ROOM_ID,
    store: roomStore,
    selfMemberId: opts.peer.memberId,
    selfDeviceId: opts.peer.id,
    selfRole: opts.peer.role,
    selfEncPrivateKey: opts.peer.encKeys.privateKey,
    selfEncVersion: opts.peer.encVersion,
    sign: opts.peer.sign,
    isHost: opts.isHost ?? false,
    pinnedHost: opts.pinnedHost,
    now: opts.now,
  });
  return { engine, store };
}

async function deliverKeyPackets(
  target: VfsRoomEngine,
  packets: ReadonlyArray<VfsKeyEpochPacket | VfsKeyWrapPacket>,
  roster: SignedRoster,
): Promise<void> {
  for (const pkt of packets) {
    if (pkt.kind === 'vfs-key-epoch') {
      await target.acceptKeyEpoch(pkt, { roster });
    } else {
      await target.acceptKeyWrap(pkt, { roster });
    }
  }
}

async function deliverRecords(
  targets: readonly VfsRoomEngine[],
  records: readonly VfsRecordPacket[],
  signerLookup: VfsSignerLookup,
): Promise<void> {
  for (const target of targets) {
    for (const rec of records) {
      await target.acceptRecord(rec, signerLookup);
    }
  }
}

async function syncPair(
  a: VfsRoomEngine,
  b: VfsRoomEngine,
  roster: SignedRoster,
  signerLookup: VfsSignerLookup,
): Promise<void> {
  // Pull B -> A, then A -> B until frontiers match.
  for (let round = 0; round < 6; round++) {
    const hashA = await a.getFrontierHash();
    const hashB = await b.getFrontierHash();
    if (hashA === hashB && a.keyring.activeEpoch === b.keyring.activeEpoch) break;

    const haveA = await a.buildHave();
    const respB = await b.handleHave(haveA);
    await deliverKeyPackets(a, respB.keyPackets, roster);
    for (const page of respB.opsPages) {
      const res = await a.acceptOps(page, signerLookup);
      expect(res.rejected).toEqual([]);
    }

    const haveB = await b.buildHave();
    const respA = await a.handleHave(haveB);
    await deliverKeyPackets(b, respA.keyPackets, roster);
    for (const page of respA.opsPages) {
      const res = await b.acceptOps(page, signerLookup);
      expect(res.rejected).toEqual([]);
    }
  }
}

async function expectErrorCode(promise: Promise<unknown>, code: VfsErrorCode | 'VFS_UNAUTHORIZED') {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  if (code === 'VFS_UNAUTHORIZED') {
    expect(caught).toBeInstanceOf(VfsUnauthorizedError);
    expect((caught as VfsUnauthorizedError).code).toBe('VFS_UNAUTHORIZED');
  } else {
    expect(caught).toBeInstanceOf(VfsError);
    expect((caught as VfsError).code).toBe(code);
  }
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

// ---------------------------------------------------------------------------
// Minimal In-Memory IDBFactory for IndexedDbVfsStore Reopen Test
// ---------------------------------------------------------------------------

function createMiniIdbFactory(): IDBFactory {
  type DbData = Map<string, Map<string, unknown>>;
  const dbs = new Map<string, DbData>();

  const makeReq = <T>() => {
    const req: Record<string, unknown> = {
      result: undefined as T | undefined,
      error: null,
      onsuccess: null as ((ev: Event) => void) | null,
      onerror: null as ((ev: Event) => void) | null,
      onupgradeneeded: null as ((ev: Event) => void) | null,
    };
    return req;
  };

  const factory = {
    open(name: string) {
      const req = makeReq<IDBDatabase>();
      const existed = dbs.has(name);
      if (!existed) dbs.set(name, new Map());
      const stores = dbs.get(name)!;

      const db: Record<string, unknown> = {
        name,
        version: 1,
        objectStoreNames: {
          contains: (s: string) => stores.has(s),
        },
        createObjectStore(s: string) {
          if (!stores.has(s)) stores.set(s, new Map());
          return {};
        },
        transaction(storeNames: string | string[]) {
          const names = Array.isArray(storeNames) ? storeNames : [storeNames];
          let pending = 0;
          let completed = false;
          const tx: Record<string, unknown> = {
            error: null,
            oncomplete: null as (() => void) | null,
            onerror: null as (() => void) | null,
            onabort: null as (() => void) | null,
            abort() {
              if (!completed) {
                completed = true;
                queueMicrotask(() => (tx.onabort as (() => void) | null)?.());
              }
            },
            objectStore(storeName: string) {
              if (!names.includes(storeName)) throw new Error(`Unknown store ${storeName}`);
              const map = stores.get(storeName)!;
              const schedule = <T>(fn: () => T) => {
                const r = makeReq<T>();
                pending++;
                queueMicrotask(() => {
                  try {
                    r.result = fn();
                    (r.onsuccess as ((ev: Event) => void) | null)?.({ target: r } as unknown as Event);
                  } catch (err) {
                    r.error = err;
                    (r.onerror as ((ev: Event) => void) | null)?.({ target: r } as unknown as Event);
                  } finally {
                    pending--;
                    if (pending === 0 && !completed) {
                      completed = true;
                      (tx.oncomplete as (() => void) | null)?.();
                    }
                  }
                });
                return r;
              };
              return {
                get: (key: string) => schedule(() => map.get(key)),
                put: (value: unknown, key: string) => schedule(() => {
                  map.set(key, structuredClone(value));
                  return key;
                }),
                delete: (key: string) => schedule(() => {
                  map.delete(key);
                  return undefined;
                }),
                openCursor(range?: { lower?: string; upper?: string; lowerOpen?: boolean; upperOpen?: boolean }) {
                  const r = makeReq<unknown>();
                  pending++;
                  const keys = [...map.keys()]
                    .filter(k => {
                      if (!range) return true;
                      if (range.lower !== undefined) {
                        if (range.lowerOpen ? k <= range.lower : k < range.lower) return false;
                      }
                      if (range.upper !== undefined) {
                        if (range.upperOpen ? k >= range.upper : k > range.upper) return false;
                      }
                      return true;
                    })
                    .sort();
                  let idx = 0;
                  const emit = () => {
                    queueMicrotask(() => {
                      if (idx < keys.length) {
                        const key = keys[idx]!;
                        const cursor = {
                          key,
                          value: structuredClone(map.get(key)),
                          continue() {
                            idx++;
                            emit();
                          },
                          delete() {
                            map.delete(key);
                          },
                        };
                        r.result = cursor;
                        (r.onsuccess as ((ev: Event) => void) | null)?.({ target: r } as unknown as Event);
                      } else {
                        r.result = null;
                        (r.onsuccess as ((ev: Event) => void) | null)?.({ target: r } as unknown as Event);
                        pending--;
                        if (pending === 0 && !completed) {
                          completed = true;
                          (tx.oncomplete as (() => void) | null)?.();
                        }
                      }
                    });
                  };
                  emit();
                  return r;
                },
              };
            },
          };
          return tx;
        },
        close() {
          // no-op
        },
      };

      queueMicrotask(() => {
        req.result = db;
        if (!existed) {
          (req.onupgradeneeded as ((ev: Event) => void) | null)?.({ target: req } as unknown as Event);
        }
        (req.onsuccess as ((ev: Event) => void) | null)?.({ target: req } as unknown as Event);
      });
      return req;
    },
  };

  return factory as unknown as IDBFactory;
}

// ---------------------------------------------------------------------------
// 3-Peer Simulated Mesh Tests
// ---------------------------------------------------------------------------

describe('VfsRoomEngine — 3-Peer Mesh, Key Epochs, CRDT Sync & Crash Recovery', () => {
  test('Host bootstraps Epoch 1, Guest receives wraps (even out-of-order), Host goes offline, Guest delegates key grant to Agent', async () => {
    const hostPeer = await createPeerIdentity({ memberId: HOST_MEMBER, role: 'human' });
    const guestPeer = await createPeerIdentity({ memberId: GUEST_MEMBER, role: 'human' });
    const agentPeer = await createPeerIdentity({ memberId: AGENT_MEMBER, role: 'agent', operatorId: GUEST_MEMBER });

    const rosterV1 = await buildRoster({ version: 1, host: hostPeer, peers: [hostPeer, guestPeer] });

    // Delegate Agent admission signed by Guest while Host is offline!
    const rawAgentEntry = await toRosterEntry(agentPeer);
    const delegatedAgentEntry: RosterEntry = {
      ...rawAgentEntry,
      cert: await signDelegatedEntry(guestPeer.sign, ROOM_ID, rawAgentEntry, guestPeer.id),
    };

    const { engine: host } = await openEngineForPeer({ peer: hostPeer, isHost: true });
    const { engine: guest } = await openEngineForPeer({ peer: guestPeer, pinnedHost: hostPeer.id.slice(0, 16) });
    const { engine: agent } = await openEngineForPeer({ peer: agentPeer, pinnedHost: hostPeer.id.slice(0, 16) });

    // Uninitialized peers fail closed with VFS_EPOCH_UNINITIALIZED; non-hosts cannot bootstrap Epoch 1.
    await expectErrorCode(
      guest.createDoc({ path: 'early.md', content: 'nope', requestId: uuid(1) }),
      'VFS_EPOCH_UNINITIALIZED',
    );
    await expectErrorCode(guest.bootstrapEpoch1(rosterV1), 'VFS_EPOCH_UNAUTHORIZED');

    // Host bootstraps Epoch 1 and creates an initial document.
    const boot = await host.bootstrapEpoch1(rosterV1);
    expect(boot.epoch).toBe(1);
    expect(boot.packets.length).toBe(2); // 1 epoch header + 1 wrap chunk for guest

    // Guest receives wrap chunk BEFORE epoch header (out-of-order buffering!).
    const [epochPkt, wrapPkt] = boot.packets;
    const wrapFirst = await guest.acceptKeyWrap(wrapPkt as VfsKeyWrapPacket, { roster: rosterV1 });
    expect(wrapFirst.installed).toBeNull();
    const epochSecond = await guest.acceptKeyEpoch(epochPkt as VfsKeyEpochPacket, { roster: rosterV1 });
    expect(epochSecond.installed?.epoch).toBe(1);

    const created = await host.createDoc({
      path: 'plan.md',
      content: '# Room Plan\nInitial draft\n',
      requestId: uuid(2),
      message: 'Initial plan',
    });

    const knownPeers = new Map([
      [hostPeer.id, hostPeer],
      [guestPeer.id, guestPeer],
      [agentPeer.id, agentPeer],
    ]);
    const lookup = makeSignerLookup(rosterV1, knownPeers);
    await deliverRecords([guest], created.outbound, lookup);
    expect(guest.readDoc('plan.md').text).toBe('# Room Plan\nInitial draft\n');

    // Host is now offline: Guest creates a delegated VfsKeyGrantPacket for Agent!
    const grantPkt = await guest.createKeyGrant(delegatedAgentEntry, rosterV1);
    const installedForAgent = await agent.acceptKeyGrant(grantPkt, { roster: rosterV1 });
    expect(installedForAgent.length).toBe(1);
    expect(installedForAgent[0]!.epoch).toBe(1);

    // Agent syncs from Guest via buildHave / handleHave / acceptOps while Host stays offline.
    await syncPair(agent, guest, rosterV1, lookup);
    expect(agent.readDoc('plan.md').text).toBe('# Room Plan\nInitial draft\n');
    expect(await agent.getFrontierHash()).toBe(await guest.getFrontierHash());

    await host.close();
    await guest.close();
    await agent.close();
  });

  test('Concurrent human + agent edits: patchDoc disjoint auto-rebase succeeds, overlapping mid-span fails VFS_CONFLICT', async () => {
    const hostPeer = await createPeerIdentity({ memberId: HOST_MEMBER, role: 'human' });
    const guestPeer = await createPeerIdentity({ memberId: GUEST_MEMBER, role: 'human' });
    const agentPeer = await createPeerIdentity({ memberId: AGENT_MEMBER, role: 'agent', operatorId: HOST_MEMBER });

    const roster = await buildRoster({ version: 1, host: hostPeer, peers: [hostPeer, guestPeer, agentPeer] });
    const lookup = makeSignerLookup(roster);

    const { engine: host } = await openEngineForPeer({ peer: hostPeer, isHost: true });
    const { engine: guest } = await openEngineForPeer({ peer: guestPeer, pinnedHost: hostPeer.id });
    const { engine: agent } = await openEngineForPeer({ peer: agentPeer, pinnedHost: hostPeer.id });

    const boot = await host.bootstrapEpoch1(roster);
    await deliverKeyPackets(guest, boot.packets, roster);
    await deliverKeyPackets(agent, boot.packets, roster);

    const initial = '# Spec\n\n## Intro\nHello team.\n\n## Tasks\n- Item A\n- Item B\n';
    const created = await host.createDoc({ path: 'spec.md', content: initial, requestId: uuid(10) });
    await deliverRecords([guest, agent], created.outbound, lookup);
    const baseRev = agent.readDoc('spec.md').rev;

    // Guest edits the Intro section while Agent still holds `baseRev`.
    const guestPatch = await guest.patchDoc({
      nodeIdOrPath: 'spec.md',
      baseRev,
      hunks: [{ op: 'replace', old: 'Hello team.', new: 'Hello Meshrooms team!' }],
      requestId: uuid(11),
      message: 'Refine intro',
    });
    await deliverRecords([host, agent], guestPatch.outbound, lookup);

    // Agent patches the disjoint Tasks section against the older `baseRev` -> auto-rebases cleanly!
    const agentPatch = await agent.patchDoc({
      nodeIdOrPath: 'spec.md',
      baseRev,
      hunks: [{ op: 'insert_after', anchor: '- Item B\n', text: '- Item C\n' }],
      requestId: uuid(12),
      message: 'Add Item C',
    });
    expect(agentPatch.rebased).toBe(true);
    await deliverRecords([host, guest], agentPatch.outbound, lookup);

    const expected = '# Spec\n\n## Intro\nHello Meshrooms team!\n\n## Tasks\n- Item A\n- Item B\n- Item C\n';
    expect(host.readDoc('spec.md').text).toBe(expected);
    expect(guest.readDoc('spec.md').text).toBe(expected);
    expect(agent.readDoc('spec.md').text).toBe(expected);
    expect(await host.getFrontierHash()).toBe(await agent.getFrontierHash());

    // Now Agent tries to patch the Intro text using the stale `baseRev` -> fails closed VFS_CONFLICT!
    let conflictErr: unknown;
    try {
      await agent.patchDoc({
        nodeIdOrPath: 'spec.md',
        baseRev,
        hunks: [{ op: 'replace', old: 'Hello team.', new: 'Stale rewrite.' }],
        requestId: uuid(13),
      });
    } catch (err) {
      conflictErr = err;
    }
    expect(conflictErr).toBeInstanceOf(VfsConflictError);
    expect((conflictErr as VfsConflictError).code).toBe('VFS_CONFLICT');

    await host.close();
    await guest.close();
    await agent.close();
  });

  test('revertDoc emits compensating op (zero offline resurrection) and surfaces concurrent-edit-during-revert in history()', async () => {
    const hostPeer = await createPeerIdentity({ memberId: HOST_MEMBER, role: 'human' });
    const guestPeer = await createPeerIdentity({ memberId: GUEST_MEMBER, role: 'human' });
    const agentPeer = await createPeerIdentity({ memberId: AGENT_MEMBER, role: 'agent', operatorId: HOST_MEMBER });

    const roster = await buildRoster({ version: 1, host: hostPeer, peers: [hostPeer, guestPeer, agentPeer] });
    const lookup = makeSignerLookup(roster);

    const { engine: host } = await openEngineForPeer({ peer: hostPeer, isHost: true });
    const { engine: guest } = await openEngineForPeer({ peer: guestPeer, pinnedHost: hostPeer.id });
    const { engine: agent } = await openEngineForPeer({ peer: agentPeer, pinnedHost: hostPeer.id });

    const boot = await host.bootstrapEpoch1(roster);
    await deliverKeyPackets(guest, boot.packets, roster);
    await deliverKeyPackets(agent, boot.packets, roster);

    // v1 -> v2 synced to all 3 peers
    const v1 = await host.createDoc({
      path: 'runbook.md',
      content: 'Step 1: Verify backup\nStep 2: Deploy\n',
      requestId: uuid(20),
      message: 'Good runbook',
    });
    await deliverRecords([guest, agent], v1.outbound, lookup);

    const v2 = await guest.patchDoc({
      nodeIdOrPath: 'runbook.md',
      baseRev: guest.readDoc('runbook.md').rev,
      hunks: [{ op: 'replace', old: 'Step 2: Deploy', new: 'Step 2: BAD_DEPLOY_CMD' }],
      requestId: uuid(21),
      message: 'Accidental bad deploy command',
    });
    await deliverRecords([host, agent], v2.outbound, lookup);
    expect(agent.readDoc('runbook.md').text).toContain('BAD_DEPLOY_CMD');

    // Agent goes OFFLINE and makes a concurrent edit on top of v2 (before seeing Host's revert).
    const offlineEdit = await agent.patchDoc({
      nodeIdOrPath: 'runbook.md',
      baseRev: agent.readDoc('runbook.md').rev,
      hunks: [{ op: 'append', text: 'Note: checked metrics\n' }],
      requestId: uuid(22),
      message: 'Offline metrics note',
    });
    expect(offlineEdit.outbound.length).toBe(2);

    // Meanwhile, Host reverts back to v1 commit!
    const reverted = await host.revertDoc({
      nodeIdOrPath: 'runbook.md',
      targetCommitId: v1.commitId,
      requestId: uuid(23),
      message: 'Revert bad deploy command',
    });
    expect(host.readDoc('runbook.md').text).toBe('Step 1: Verify backup\nStep 2: Deploy\n');

    // Sync Host <-> Guest, then Agent reconnects and syncs with Host & Guest!
    await syncPair(host, guest, roster, lookup);
    await syncPair(agent, host, roster, lookup);
    await syncPair(agent, guest, roster, lookup);

    // Zero resurrection: BAD_DEPLOY_CMD is gone on ALL 3 peers, and all 3 converge identically!
    const finalHost = host.readDoc('runbook.md');
    const finalGuest = guest.readDoc('runbook.md');
    const finalAgent = agent.readDoc('runbook.md');
    expect(finalHost.text).not.toContain('BAD_DEPLOY_CMD');
    expect(finalHost.text).toContain('Step 2: Deploy');
    expect(finalGuest.text).toBe(finalHost.text);
    expect(finalAgent.text).toBe(finalHost.text);
    expect(finalGuest.rev).toBe(finalHost.rev);
    expect(finalAgent.rev).toBe(finalHost.rev);
    expect(await host.getFrontierHash()).toBe(await agent.getFrontierHash());

    // history() dynamically surfaces the concurrent-edit-during-revert warning!
    const hist = host.history('runbook.md');
    const revertEntry = hist.find(h => h.commitId === reverted.commitId);
    expect(revertEntry).toBeDefined();
    expect(revertEntry!.revertsCommit).toBe(v1.commitId);
    expect(revertEntry!.concurrentEditsDuringRevert?.length).toBe(1);
    expect(revertEntry!.concurrentEditsDuringRevert![0]!.kind).toBe('concurrent-edit-during-revert');
    expect(revertEntry!.concurrentEditsDuringRevert![0]!.concurrentAuthors.some(a => a.deviceId === agentPeer.id)).toBe(true);

    // diff() works cleanly between v1 and v2 historical commits.
    const diffRes = host.diff('runbook.md', v1.commitId, v2.commitId);
    expect(diffRes.identical).toBe(false);
    expect(diffRes.removedLines).toBe(1);
    expect(diffRes.addedLines).toBe(1);
    expect(diffRes.unified).toContain('-Step 2: Deploy');
    expect(diffRes.unified).toContain('+Step 2: BAD_DEPLOY_CMD');

    await host.close();
    await guest.close();
    await agent.close();
  });

  test('Concurrent doc creation at the same path converges deterministically with (conflict-<id>) suffix across all 3 peers', async () => {
    const hostPeer = await createPeerIdentity({ memberId: HOST_MEMBER, role: 'human' });
    const guestPeer = await createPeerIdentity({ memberId: GUEST_MEMBER, role: 'human' });
    const agentPeer = await createPeerIdentity({ memberId: AGENT_MEMBER, role: 'agent', operatorId: HOST_MEMBER });

    const roster = await buildRoster({ version: 1, host: hostPeer, peers: [hostPeer, guestPeer, agentPeer] });
    const lookup = makeSignerLookup(roster);

    const { engine: host } = await openEngineForPeer({ peer: hostPeer, isHost: true });
    const { engine: guest } = await openEngineForPeer({ peer: guestPeer, pinnedHost: hostPeer.id });
    const { engine: agent } = await openEngineForPeer({ peer: agentPeer, pinnedHost: hostPeer.id });

    const boot = await host.bootstrapEpoch1(roster);
    await deliverKeyPackets(guest, boot.packets, roster);
    await deliverKeyPackets(agent, boot.packets, roster);

    // Host and Guest both create `notes.md` while partitioned!
    const hostDoc = await host.createDoc({ path: 'notes.md', content: 'Host notes', requestId: uuid(30) });
    const guestDoc = await guest.createDoc({ path: 'notes.md', content: 'Guest notes', requestId: uuid(31) });

    // Deliver in opposite orders to Host/Guest vs Agent to prove arrival-order invariance.
    await deliverRecords([host], guestDoc.outbound, lookup);
    await deliverRecords([guest], hostDoc.outbound, lookup);
    await deliverRecords([agent], [...guestDoc.outbound, ...hostDoc.outbound], lookup);

    const hostList = host.listDocs();
    const guestList = guest.listDocs();
    const agentList = agent.listDocs();

    expect(hostList.length).toBe(2);
    expect(guestList.map(d => [d.nodeId, d.path, d.hasConflict])).toEqual(
      hostList.map(d => [d.nodeId, d.path, d.hasConflict]),
    );
    expect(agentList.map(d => [d.nodeId, d.path, d.hasConflict])).toEqual(
      hostList.map(d => [d.nodeId, d.path, d.hasConflict]),
    );

    const clean = hostList.find(d => !d.hasConflict)!;
    const conflicted = hostList.find(d => d.hasConflict)!;
    expect(clean.path).toBe('notes.md');
    expect(conflicted.path).toBe(`notes (conflict-${conflicted.nodeId.slice(0, 8)}).md`);
    // Both documents are intact and readable by their resolved display paths.
    expect(new Set([host.readDoc(clean.path).text, host.readDoc(conflicted.path).text])).toEqual(
      new Set(['Host notes', 'Guest notes']),
    );
    expect(hostDoc.nodeId).not.toBe(guestDoc.nodeId);

    await host.close();
    await guest.close();
    await agent.close();
  });

  test('Decision 4 permissions: agent cannot soft-delete human doc, can soft-delete own draft, human can restore', async () => {
    const hostPeer = await createPeerIdentity({ memberId: HOST_MEMBER, role: 'human' });
    const agentPeer = await createPeerIdentity({ memberId: AGENT_MEMBER, role: 'agent', operatorId: HOST_MEMBER });

    const roster = await buildRoster({ version: 1, host: hostPeer, peers: [hostPeer, agentPeer] });
    const lookup = makeSignerLookup(roster);

    const { engine: host } = await openEngineForPeer({ peer: hostPeer, isHost: true });
    const { engine: agent } = await openEngineForPeer({ peer: agentPeer, pinnedHost: hostPeer.id });

    const boot = await host.bootstrapEpoch1(roster);
    await deliverKeyPackets(agent, boot.packets, roster);

    const humanDoc = await host.createDoc({ path: 'architecture.md', content: 'Human spec', requestId: uuid(40) });
    const agentDraft = await agent.createDoc({ path: 'draft.md', content: 'Agent draft', requestId: uuid(41) });
    await deliverRecords([agent], humanDoc.outbound, lookup);
    await deliverRecords([host], agentDraft.outbound, lookup);

    // Agent CANNOT soft-delete human's document.
    await expectErrorCode(
      agent.deleteDoc({
        nodeIdOrPath: 'architecture.md',
        requestId: uuid(42),
        actorRole: 'agent',
        actorMemberId: AGENT_MEMBER,
      }),
      'VFS_UNAUTHORIZED',
    );

    // Agent CAN soft-delete its own draft.
    const deletedDraft = await agent.deleteDoc({
      nodeIdOrPath: 'draft.md',
      requestId: uuid(43),
      actorRole: 'agent',
      actorMemberId: AGENT_MEMBER,
    });
    expect(deletedDraft.deleted).toBe(true);
    await deliverRecords([host], deletedDraft.outbound, lookup);
    expect(host.listDocs().map(d => d.path)).toEqual(['architecture.md']);
    expect(host.listDocs({ includeDeleted: true }).find(d => d.nodeId === agentDraft.nodeId)?.deleted).toBe(true);

    // Agent CANNOT restore even its own soft-deleted draft (humans-only restore).
    await expectErrorCode(
      agent.restoreDoc({
        nodeIdOrPath: agentDraft.nodeId,
        requestId: uuid(44),
        actorRole: 'agent',
      }),
      'VFS_UNAUTHORIZED',
    );

    // Human CAN restore the soft-deleted draft.
    const restored = await host.restoreDoc({
      nodeIdOrPath: agentDraft.nodeId,
      requestId: uuid(45),
      actorRole: 'human',
    });
    expect(restored.deleted).toBe(false);
    await deliverRecords([agent], restored.outbound, lookup);
    expect(agent.listDocs().map(d => d.path)).toEqual(['architecture.md', 'draft.md']);

    // Remote enforcement: even if a malicious agent signs a delete for human's doc by spoofing local role,
    // honest peers reject it in acceptRecord() based on roster signer role!
    const spoofedDelete = await agent.deleteDoc({
      nodeIdOrPath: 'architecture.md',
      requestId: uuid(46),
      actorRole: 'human', // bypassed locally by compromised client
      actorMemberId: AGENT_MEMBER,
    });
    await expectErrorCode(host.acceptRecord(spoofedDelete.outbound[0]!, lookup), 'VFS_UNAUTHORIZED');
    expect(host.readDoc('architecture.md').deleted).toBe(false);

    await host.close();
    await agent.close();
  });

  test('Revocation rotateEpoch locks out revoked device from Epoch 2 and rejects its new records', async () => {
    const hostPeer = await createPeerIdentity({ memberId: HOST_MEMBER, role: 'human' });
    const guestPeer = await createPeerIdentity({ memberId: GUEST_MEMBER, role: 'human' });
    const agentPeer = await createPeerIdentity({ memberId: AGENT_MEMBER, role: 'agent', operatorId: HOST_MEMBER });

    const rosterV1 = await buildRoster({ version: 1, host: hostPeer, peers: [hostPeer, guestPeer, agentPeer] });
    const lookupV1 = makeSignerLookup(rosterV1);

    const { engine: host } = await openEngineForPeer({ peer: hostPeer, isHost: true });
    const { engine: guest } = await openEngineForPeer({ peer: guestPeer, pinnedHost: hostPeer.id });
    const { engine: agent } = await openEngineForPeer({ peer: agentPeer, pinnedHost: hostPeer.id });

    const boot = await host.bootstrapEpoch1(rosterV1);
    await deliverKeyPackets(guest, boot.packets, rosterV1);
    await deliverKeyPackets(agent, boot.packets, rosterV1);

    const created = await host.createDoc({ path: 'secret.md', content: 'Epoch 1 text', requestId: uuid(50) });
    await deliverRecords([guest, agent], created.outbound, lookupV1);

    // Host revokes Agent and rotates to Epoch 2!
    const rosterV2 = await buildRoster({
      version: 2,
      prev: rosterV1,
      host: hostPeer,
      peers: [hostPeer, guestPeer],
      removed: [{ id: agentPeer.id, at: 1_750_000_050_000, revoked: true }],
    });
    const knownPeers = new Map([
      [hostPeer.id, hostPeer],
      [guestPeer.id, guestPeer],
      [agentPeer.id, agentPeer],
    ]);
    const lookupV2 = makeSignerLookup(rosterV2, knownPeers);

    const rot = await host.rotateEpoch(rosterV2);
    expect(rot.epoch).toBe(2);
    await deliverKeyPackets(guest, rot.packets, rosterV2);
    expect(guest.keyring.activeEpoch).toBe(2);

    // Revoked Agent has no wrap in Epoch 2 packets and stays stuck at Epoch 1.
    await deliverKeyPackets(agent, rot.packets, rosterV2);
    expect(agent.keyring.activeEpoch).toBe(1);

    // Host writes confidential Epoch 2 update -> Guest decrypts cleanly, Agent cannot read it!
    const secretEdit = await host.writeDoc({
      nodeIdOrPath: 'secret.md',
      content: 'Epoch 2 confidential update',
      requestId: uuid(51),
    });
    await deliverRecords([guest], secretEdit.outbound, lookupV2);
    expect(guest.readDoc('secret.md').text).toBe('Epoch 2 confidential update');
    await expectErrorCode(agent.acceptRecord(secretEdit.outbound[0]!, lookupV2), 'VFS_EPOCH_UNKNOWN');

    // Revoked Agent signs a new Epoch 1 write -> rejected by Host & Guest as VFS_EPOCH_UNAUTHORIZED!
    const rogueWrite = await agent.writeDoc({
      nodeIdOrPath: 'secret.md',
      content: 'Rogue revoked edit',
      requestId: uuid(52),
    });
    await expectErrorCode(host.acceptRecord(rogueWrite.outbound[0]!, lookupV2), 'VFS_EPOCH_UNAUTHORIZED');
    await expectErrorCode(guest.acceptRecord(rogueWrite.outbound[0]!, lookupV2), 'VFS_EPOCH_UNAUTHORIZED');
    expect(host.readDoc('secret.md').text).toBe('Epoch 2 confidential update');

    await host.close();
    await guest.close();
    await agent.close();
  });

  test('requestId idempotency replays existing receipt without duplicate ops, and emits passive change feed', async () => {
    const hostPeer = await createPeerIdentity({ memberId: HOST_MEMBER, role: 'human' });
    const roster = await buildRoster({ version: 1, host: hostPeer, peers: [hostPeer] });

    const { engine: host } = await openEngineForPeer({ peer: hostPeer, isHost: true });
    const observed: VfsChangeEvent[] = [];
    const unsubscribe = host.onChange(ev => observed.push(ev));

    await host.bootstrapEpoch1(roster);
    const first = await host.createDoc({
      path: 'todo.md',
      content: 'Line 1\n',
      requestId: uuid(60),
      message: 'Create todo',
    });
    expect(first.replayed).toBe(false);
    expect(first.outbound.length).toBe(3);
    const frontierAfterFirst = await host.getFrontierHash();

    // Replay exact same requestId -> identical metadata, zero new ops, unchanged frontierHash!
    const second = await host.createDoc({
      path: 'todo.md',
      content: 'Line 1\n',
      requestId: uuid(60),
      message: 'Create todo',
    });
    expect(second.replayed).toBe(true);
    expect(second.outbound).toEqual([]);
    expect(second.nodeId).toBe(first.nodeId);
    expect(second.commitId).toBe(first.commitId);
    expect(second.rev).toBe(first.rev);
    expect(await host.getFrontierHash()).toBe(frontierAfterFirst);

    // Passive recentChanges(afterCursor) tracks cursor cleanly.
    expect(observed.map(e => e.kind)).toEqual(['epoch-updated', 'doc-created']);
    const feed1 = host.recentChanges(0);
    expect(feed1.events.length).toBe(2);
    const feed2 = host.recentChanges(feed1.cursor);
    expect(feed2.events.length).toBe(0);

    unsubscribe();
    await host.close();
  });

  test('Persistence & crash recovery across close + reopen on IndexedDbVfsStore AND BunFileVfsStore', async () => {
    const hostPeer = await createPeerIdentity({ memberId: HOST_MEMBER, role: 'human' });
    const roster = await buildRoster({ version: 1, host: hostPeer, peers: [hostPeer] });

    const runPersistenceRoundTrip = async (label: string, createStore: () => VfsStore) => {
      let savedNodeId = '';
      let savedRev = '';
      let savedFrontierHash = '';
      let savedCommit1 = '';
      let savedCommit2 = '';
      let savedHeads: Record<string, number> = {};

      // Session 1: bootstrap, create, patch, checkpoint, close.
      const store1 = createStore();
      try {
        const { engine: e1 } = await openEngineForPeer({ peer: hostPeer, store: store1, isHost: true });
        await e1.bootstrapEpoch1(roster);
        const c1 = await e1.createDoc({
          path: 'journal.md',
          content: `Journal (${label})\nEntry 1\n`,
          requestId: uuid(70),
          message: 'Initial journal',
        });
        const c2 = await e1.patchDoc({
          nodeIdOrPath: 'journal.md',
          baseRev: c1.rev,
          hunks: [{ op: 'append', text: 'Entry 2\n' }],
          requestId: uuid(71),
          message: 'Add Entry 2',
        });

        savedNodeId = c1.nodeId;
        savedRev = c2.rev;
        savedCommit1 = c1.commitId;
        savedCommit2 = c2.commitId;
        savedFrontierHash = await e1.getFrontierHash();
        savedHeads = (await e1.buildHave()).heads;

        await e1.checkpoint();
        await e1.close();
      } finally {
        await store1.close();
      }

      // Session 2: reopen fresh VfsRoomEngine on the SAME store!
      const store2 = createStore();
      try {
        const { engine: e2 } = await openEngineForPeer({ peer: hostPeer, store: store2, isHost: true });
        expect(e2.keyring.activeEpoch).toBe(1);
        expect(e2.keyring.hostPin).toBe(hostPeer.id);
        expect(await e2.getFrontierHash()).toBe(savedFrontierHash);
        expect((await e2.buildHave()).heads).toEqual(savedHeads);

        const doc = e2.readDoc('journal.md');
        expect(doc.nodeId).toBe(savedNodeId);
        expect(doc.rev).toBe(savedRev);
        expect(doc.text).toBe(`Journal (${label})\nEntry 1\nEntry 2\n`);

        const hist = e2.history('journal.md');
        expect(hist.length).toBe(2);
        expect(hist.map(h => h.commitId)).toContain(savedCommit1);
        expect(hist.map(h => h.commitId)).toContain(savedCommit2);

        // Historical diff & requestId idempotency survive reopen!
        const d = e2.diff('journal.md', savedCommit1, savedCommit2);
        expect(d.addedLines).toBe(1);
        expect(d.unified).toContain('+Entry 2');

        const replayed = await e2.patchDoc({
          nodeIdOrPath: 'journal.md',
          baseRev: savedRev,
          hunks: [{ op: 'append', text: 'Entry 2\n' }],
          requestId: uuid(71),
        });
        expect(replayed.replayed).toBe(true);
        expect(replayed.commitId).toBe(savedCommit2);

        // Post-reopen write advances seq monotonically without colliding with pre-reopen seqs.
        const c3 = await e2.patchDoc({
          nodeIdOrPath: 'journal.md',
          baseRev: savedRev,
          hunks: [{ op: 'append', text: 'Entry 3\n' }],
          requestId: uuid(72),
        });
        expect(c3.replayed).toBe(false);
        expect(e2.readDoc('journal.md').text).toBe(`Journal (${label})\nEntry 1\nEntry 2\nEntry 3\n`);
        expect((await e2.buildHave()).heads[hostPeer.id]!).toBeGreaterThan(savedHeads[hostPeer.id]!);

        await e2.close();
      } finally {
        await store2.close();
      }
    };

    // 1. IndexedDbVfsStore round-trip
    const idb = createMiniIdbFactory();
    const keyRange = {
      bound: (lower: unknown, upper: unknown, lowerOpen?: boolean, upperOpen?: boolean) =>
        ({ lower, upper, lowerOpen, upperOpen }) as unknown as IDBKeyRange,
      lowerBound: (lower: unknown, open?: boolean) =>
        ({ lower, lowerOpen: open }) as unknown as IDBKeyRange,
    };
    await runPersistenceRoundTrip(
      'indexeddb',
      () => new IndexedDbVfsStore({ idb, keyRange, dbName: 'vfs-engine-reopen-test' }),
    );

    // 2. BunFileVfsStore round-trip (real disk WAL + checkpoint snapshot)
    const dir = testDirectory('vfs-engine-bunfile');
    tempDirs.push(dir);
    await runPersistenceRoundTrip('bun-file', () => new BunFileVfsStore({ baseDir: dir.path }));
  });

  test('rejects forged key-wrap chunks and chunks >14 KB anti-entropy responses cleanly across multiple pages', async () => {
    const hostPeer = await createPeerIdentity({ memberId: HOST_MEMBER, role: 'human' });
    const guestPeer = await createPeerIdentity({ memberId: GUEST_MEMBER, role: 'human' });
    const roster = await buildRoster({ version: 1, host: hostPeer, peers: [hostPeer, guestPeer] });
    const lookup = makeSignerLookup(roster);

    const { engine: host } = await openEngineForPeer({ peer: hostPeer, isHost: true });
    const { engine: guest } = await openEngineForPeer({ peer: guestPeer, pinnedHost: hostPeer.id });

    const boot = await host.bootstrapEpoch1(roster);
    const wrapPkt = boot.packets.find((p): p is VfsKeyWrapPacket => p.kind === 'vfs-key-wrap')!;

    // Tamper signature on VfsKeyWrapPacket -> rejected immediately with VFS_INVALID_SIGNATURE.
    const forgedSig = (wrapPkt.chunk.signature[0] === 'A' ? 'B' : 'A') + wrapPkt.chunk.signature.slice(1);
    const forgedWrap: VfsKeyWrapPacket = {
      ...wrapPkt,
      chunk: { ...wrapPkt.chunk, signature: forgedSig },
    };
    await expectErrorCode(guest.acceptKeyWrap(forgedWrap, { roster }), 'VFS_INVALID_SIGNATURE');

    // Deliver authentic epoch packets to guest.
    await deliverKeyPackets(guest, boot.packets, roster);

    // Host creates 10 docs with ~2 KB each -> total exceeds 14 KB -> handleHave splits into multiple bounded pages!
    for (let i = 0; i < 10; i++) {
      await host.createDoc({
        path: `doc-${i}.md`,
        content: `Doc ${i}: ${'x'.repeat(1800)}\n`,
        requestId: uuid(200 + i),
      });
    }

    const have = await guest.buildHave();
    const resp = await host.handleHave(have);
    expect(resp.opsPages.length).toBeGreaterThan(1);
    for (let i = 0; i < resp.opsPages.length; i++) {
      const page = resp.opsPages[i]!;
      expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(14_000);
      expect(page.records.length).toBeLessThanOrEqual(64);
      expect(page.more).toBe(i < resp.opsPages.length - 1);
      const res = await guest.acceptOps(page, lookup);
      expect(res.rejected).toEqual([]);
    }

    expect(guest.listDocs().length).toBe(10);
    expect(await guest.getFrontierHash()).toBe(await host.getFrontierHash());

    // Subsequent handleHave hits O(1) frontierHash fast-path with zero ops pages.
    const secondResp = await host.handleHave(await guest.buildHave());
    expect(secondResp.opsPages).toEqual([]);

    await host.close();
    await guest.close();
  });

  test('out-of-order remote DocOps drain buffered pendingOps immediately when parent arrives (even after local edits)', async () => {
    const hostPeer = await createPeerIdentity({ memberId: HOST_MEMBER, role: 'human' });
    const guestPeer = await createPeerIdentity({ memberId: GUEST_MEMBER, role: 'human' });
    const roster = await buildRoster({ version: 1, host: hostPeer, peers: [hostPeer, guestPeer] });
    const lookup = makeSignerLookup(roster);

    const { engine: host } = await openEngineForPeer({ peer: hostPeer, isHost: true });
    const { engine: guest } = await openEngineForPeer({ peer: guestPeer, pinnedHost: hostPeer.id });

    const boot = await host.bootstrapEpoch1(roster);
    await deliverKeyPackets(guest, boot.packets, roster);

    // Host creates doc (treeOp, op1, commit1), then patches it twice (op2 depends on op1; op3 depends on op2).
    const c1 = await host.createDoc({
      path: 'ooo.md',
      content: 'Line 1\n',
      requestId: uuid(300),
    });
    const c2 = await host.patchDoc({
      nodeIdOrPath: 'ooo.md',
      baseRev: c1.rev,
      hunks: [{ op: 'append', text: 'Line 2\n' }],
      requestId: uuid(301),
    });
    const c3 = await host.patchDoc({
      nodeIdOrPath: 'ooo.md',
      baseRev: c2.rev,
      hunks: [{ op: 'append', text: 'Line 3\n' }],
      requestId: uuid(302),
    });

    const treeOp = c1.outbound.find(r => r.objKind === VfsObjKind.TreeOp)!;
    const op1 = c1.outbound.find(r => r.objKind === VfsObjKind.DocOp)!;
    const op2 = c2.outbound.find(r => r.objKind === VfsObjKind.DocOp)!;
    const op3 = c3.outbound.find(r => r.objKind === VfsObjKind.DocOp)!;

    // Deliver treeOp first, then deliver op3 and op2 BEFORE op1 (out of causal order!).
    await guest.acceptRecord(treeOp, lookup);
    const res3 = await guest.acceptRecord(op3, lookup);
    expect(res3.buffered).toBe(true);
    const res2 = await guest.acceptRecord(op2, lookup);
    expect(res2.buffered).toBe(true);
    expect(guest.readDoc('ooo.md').text).toBe('');

    // Now deliver op1 -> MUST immediately drain BOTH op2 and op3 in memory without reopen!
    const res1 = await guest.acceptRecord(op1, lookup);
    expect(res1.buffered).toBe(false);
    expect(guest.readDoc('ooo.md').text).toBe('Line 1\nLine 2\nLine 3\n');
    expect(guest.readDoc('ooo.md').rev).toBe(host.readDoc('ooo.md').rev);

    // Also verify a local patch while a remote child op is buffered does NOT discard pendingOps!
    const h4 = await host.patchDoc({
      nodeIdOrPath: 'ooo.md',
      baseRev: c3.rev,
      hunks: [{ op: 'append', text: 'Host 4\n' }],
      requestId: uuid(303),
    });
    const h5 = await host.patchDoc({
      nodeIdOrPath: 'ooo.md',
      baseRev: h4.rev,
      hunks: [{ op: 'append', text: 'Host 5\n' }],
      requestId: uuid(304),
    });
    const op4 = h4.outbound.find(r => r.objKind === VfsObjKind.DocOp)!;
    const op5 = h5.outbound.find(r => r.objKind === VfsObjKind.DocOp)!;

    // Buffer op5 on Guest, then have Guest perform a local prepend edit BEFORE op4 arrives.
    expect((await guest.acceptRecord(op5, lookup)).buffered).toBe(true);
    await guest.patchDoc({
      nodeIdOrPath: 'ooo.md',
      baseRev: c3.rev,
      hunks: [{ op: 'prepend', text: 'Guest Header\n' }],
      requestId: uuid(305),
    });
    // Now deliver op4 -> op5 MUST still be in pendingOps and drain immediately!
    await guest.acceptRecord(op4, lookup);
    expect(guest.readDoc('ooo.md').text).toBe('Guest Header\nLine 1\nLine 2\nLine 3\nHost 4\nHost 5\n');

    await host.close();
    await guest.close();
  });

  test('deleteDoc / restoreDoc keep treeOp parents bounded to DAG frontier across >16 cycles (sync + reopen)', async () => {
    const hostPeer = await createPeerIdentity({ memberId: HOST_MEMBER, role: 'human' });
    const guestPeer = await createPeerIdentity({ memberId: GUEST_MEMBER, role: 'human' });
    const roster = await buildRoster({ version: 1, host: hostPeer, peers: [hostPeer, guestPeer] });
    const lookup = makeSignerLookup(roster);

    const dir = testDirectory('vfs-engine-tree-frontier');
    tempDirs.push(dir);
    const hostStore1 = new BunFileVfsStore({ baseDir: dir.path });
    const { engine: host1 } = await openEngineForPeer({ peer: hostPeer, store: hostStore1, isHost: true });
    const { engine: guest } = await openEngineForPeer({ peer: guestPeer, pinnedHost: hostPeer.id });

    const boot = await host1.bootstrapEpoch1(roster);
    await deliverKeyPackets(guest, boot.packets, roster);

    const created = await host1.createDoc({
      path: 'cycled.md',
      content: 'Survives many delete/restore cycles',
      requestId: uuid(400),
    });

    // Perform 9 delete + restore cycles = 19 total tree ops (> 16 max parents limit!).
    let reqCounter = 401;
    for (let i = 0; i < 9; i++) {
      await host1.deleteDoc({ nodeIdOrPath: created.nodeId, requestId: uuid(reqCounter++), actorRole: 'human' });
      await host1.restoreDoc({ nodeIdOrPath: created.nodeId, requestId: uuid(reqCounter++), actorRole: 'human' });
    }

    // Replicate all 19 tree ops + commits to Guest via syncPair (zero rejections!).
    await syncPair(guest, host1, roster, lookup);
    expect(guest.readDoc('cycled.md').deleted).toBe(false);
    expect(guest.readDoc('cycled.md').text).toBe('Survives many delete/restore cycles');
    expect(await guest.getFrontierHash()).toBe(await host1.getFrontierHash());

    // Close and reopen Host from disk to prove validateTreeOpBodyShape accepts every persisted tree op!
    await host1.close();
    await hostStore1.close();

    const hostStore2 = new BunFileVfsStore({ baseDir: dir.path });
    const { engine: host2 } = await openEngineForPeer({ peer: hostPeer, store: hostStore2, isHost: true });
    expect(host2.readDoc('cycled.md').deleted).toBe(false);
    expect(host2.readDoc('cycled.md').text).toBe('Survives many delete/restore cycles');
    expect(await host2.getFrontierHash()).toBe(await guest.getFrontierHash());

    await host2.close();
    await hostStore2.close();
    await guest.close();
  });

  test('chunks large (>12 KiB) createDoc/writeDoc ops safely across peers and rejects cross-doc nodeId replay', async () => {
    const hostPeer = await createPeerIdentity({ memberId: HOST_MEMBER, role: 'human' });
    const guestPeer = await createPeerIdentity({ memberId: GUEST_MEMBER, role: 'human' });
    const roster = await buildRoster({ version: 1, host: hostPeer, peers: [hostPeer, guestPeer] });
    const lookup = makeSignerLookup(roster);

    const { engine: host } = await openEngineForPeer({ peer: hostPeer, isHost: true });
    const { engine: guest } = await openEngineForPeer({ peer: guestPeer, pinnedHost: hostPeer.id });
    const boot = await host.bootstrapEpoch1(roster);
    await deliverKeyPackets(guest, boot.packets, roster);

    const largeV1 = `${'A'.repeat(12_000)}café🚀${'B'.repeat(12_000)}`;
    const created = await host.createDoc({ path: 'large.md', content: largeV1, requestId: uuid(501) });
    // Multiple chunked DocOps should be emitted so every individual signed op stays under 12 KiB.
    expect(created.outbound.filter(p => p.objKind === VfsObjKind.DocOp).length).toBeGreaterThanOrEqual(3);

    await syncPair(guest, host, roster, lookup);
    expect(guest.readDoc('large.md').text).toBe(largeV1);

    const largeV2 = `${'C'.repeat(15_000)}ção✅${'D'.repeat(10_000)}`;
    const updated = await host.writeDoc({ nodeIdOrPath: created.nodeId, content: largeV2, requestId: uuid(502) });
    expect(updated.outbound.filter(p => p.objKind === VfsObjKind.DocOp).length).toBeGreaterThanOrEqual(4);

    await syncPair(guest, host, roster, lookup);
    expect(guest.readDoc('large.md').text).toBe(largeV2);
    expect(await guest.getFrontierHash()).toBe(await host.getFrontierHash());

    // Tampering outer record.nodeId to target another document must be rejected by openSignedVfsOp!
    const docB = await host.createDoc({ path: 'other.md', content: 'other doc', requestId: uuid(503) });
    const docBOp = docB.outbound.find(p => p.objKind === VfsObjKind.DocOp)!;
    const tampered: VfsRecordPacket = { ...docBOp, nodeId: created.nodeId };
    await expect(guest.acceptRecord(tampered, lookup)).rejects.toMatchObject({ code: 'VFS_INVALID_ENVELOPE' });

    await host.close();
    await guest.close();
  });
});
