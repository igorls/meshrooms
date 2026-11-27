import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { fakeStorage, installFakeIndexedDB } from '../test-indexeddb';
import { BrowserPeers, type SavedMessage } from '../peers';
import { Resync } from '../pacer';
import type { RoomStatus } from '../protocol';
import {
  QUOTA_QUIET_MS,
  ReceiveQuota,
  VFS_QUOTA_BURST,
  VFS_QUOTA_PER_MINUTE,
  VFS_SYNC_QUOTA_BURST,
  VFS_SYNC_QUOTA_PER_MINUTE,
} from '../quota';
import {
  decryptRelayEnvelope,
  encryptRelayEnvelope,
  exportRawPublicKey,
  generateEncKeyPair,
  hashRosterBody,
  signEncBinding,
  signRoster,
  type DecryptedRelayEnvelope,
  type RelayEnvelope,
  type RosterBody,
  type RosterEntry,
  type SignedRoster,
} from '../relay-crypto';
import type { RelayClient, RelayClientOptions, SendPacketOptions } from '../relay-client';
import { claimFence, identity as browserIdentity, resetIdentityCache, sign as browserSign } from '../storage';
import { MemoryVfsStore } from './store';
import { VfsRoomEngine } from './engine';
import { VfsRelayBudget, VfsSyncTracker } from './pacing';
import { VFS_PROTOCOL_VERSION } from './constants';
import { isVfsPacketKind, type VfsPacket } from './wire';

installFakeIndexedDB();

// ---------------------------------------------------------------------------
// Deterministic Crypto, Fake DataChannel & Sealed E2E Relay Harness
// ---------------------------------------------------------------------------

type TestDevice = {
  id: string;
  memberId: string;
  name: string;
  role: 'human' | 'agent';
  wakeable?: boolean;
  signKeys: CryptoKeyPair;
  signPublicKey: string;
  encKeys: CryptoKeyPair;
  encPublicKey: string;
  encSig: string;
  sign: (value: unknown) => Promise<string>;
};

async function createBrowserHostDevice(params: {
  roomId: string;
  memberId: string;
  name: string;
  role: 'human' | 'agent';
  wakeable?: boolean;
}): Promise<TestDevice> {
  const id = await browserIdentity();
  const encSig = await signEncBinding(browserSign, {
    room: params.roomId,
    deviceId: id.id,
    enc: id.encPublicKey,
    encVersion: id.encVersion,
  });
  return {
    id: id.id,
    memberId: params.memberId,
    name: params.name,
    role: params.role,
    ...(params.wakeable ? { wakeable: true } : {}),
    signKeys: id.keys,
    signPublicKey: id.publicKey,
    encKeys: id.encKeys,
    encPublicKey: id.encPublicKey,
    encSig,
    sign: browserSign,
  };
}

async function createTestDevice(params: {
  roomId: string;
  memberId: string;
  name: string;
  role: 'human' | 'agent';
  wakeable?: boolean;
}): Promise<TestDevice> {
  const signKeys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair;
  const signPublicKey = await exportRawPublicKey(signKeys.publicKey);
  const rawPub = Buffer.from(signPublicKey, 'base64');
  const id = Buffer.from(await crypto.subtle.digest('SHA-256', rawPub)).toString('hex');

  const sign = async (value: unknown): Promise<string> => {
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      signKeys.privateKey,
      new TextEncoder().encode(JSON.stringify(value)),
    );
    return Buffer.from(sig).toString('base64');
  };

  const encKeys = await generateEncKeyPair();
  const encPublicKey = await exportRawPublicKey(encKeys.publicKey);
  const encSig = await signEncBinding(
    sign,
    { room: params.roomId, deviceId: id, enc: encPublicKey, encVersion: 1 },
  );

  return {
    id,
    memberId: params.memberId,
    name: params.name,
    role: params.role,
    ...(params.wakeable ? { wakeable: true } : {}),
    signKeys,
    signPublicKey,
    encKeys,
    encPublicKey,
    encSig,
    sign,
  };
}

async function buildSignedRoster(
  roomId: string,
  host: TestDevice,
  devices: TestDevice[],
  opts?: {
    version?: number;
    previous?: SignedRoster;
    removed?: Array<{ id: string; at: number; revoked: boolean }>;
    at?: number;
  },
): Promise<SignedRoster> {
  const entries: RosterEntry[] = devices
    .map(d => ({
      id: d.id,
      sign: d.signPublicKey,
      enc: d.encPublicKey,
      encVersion: 1,
      encSig: d.encSig,
      memberId: d.memberId,
      role: d.role,
      ...(d.wakeable ? { wakeable: true as const } : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const body: RosterBody = {
    v: 1,
    room: roomId,
    version: opts?.version ?? (opts?.previous ? opts.previous.body.version + 1 : 1),
    prev: opts?.previous ? await hashRosterBody(opts.previous.body) : '',
    at: opts?.at ?? 10_000,
    host: host.id,
    devices: entries,
    removed: opts?.removed ?? [],
  };
  return signRoster(body, host.sign);
}

function buildStatus(params: {
  roomId: string;
  self: TestDevice;
  owner: TestDevice;
  devices: TestDevice[];
  roster?: SignedRoster;
  relayUrl?: string;
  formerDevices?: RoomStatus['formerDevices'];
}): RoomStatus {
  return {
    roomId: params.roomId,
    title: 'VFS Room',
    epoch: 'e1',
    hostOnline: true,
    deviceId: params.self.id,
    memberId: params.self.memberId,
    ownerId: params.owner.memberId,
    settings: {
      floor: 'people-and-agents',
      agentAssignmentsWake: true,
      historyForNewcomers: true,
      guestAgentApproval: false,
      hostApprovesDevices: false,
    },
    members: params.devices.map(d => ({ id: d.memberId, name: d.name, role: d.role })),
    devices: params.devices.map(d => ({
      id: d.id,
      publicKey: d.signPublicKey,
      label: d.name,
      memberId: d.memberId,
      admittedAt: 1000,
      enc: d.encPublicKey,
      encVersion: 1,
      encSig: d.encSig,
      ...(d.wakeable ? { wakeable: true as const } : {}),
    })),
    ...(params.formerDevices ? { formerDevices: params.formerDevices } : {}),
    ...(params.roster ? { roster: params.roster } : {}),
    ...(params.relayUrl ? { relayUrl: params.relayUrl } : {}),
  };
}

type FakeDataChannel = {
  readyState: string;
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  sent: string[];
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  peer?: FakeDataChannel;
  addEventListener: () => void;
  removeEventListener: () => void;
  send: (data: string) => void;
  close: () => void;
};

function makeChannelPair(): { a: FakeDataChannel; b: FakeDataChannel } {
  const mk = (): FakeDataChannel => {
    const ch: FakeDataChannel = {
      readyState: 'open',
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      sent: [],
      addEventListener() {},
      removeEventListener() {},
      send(data: string) {
        ch.sent.push(data);
        queueMicrotask(() => {
          if (ch.peer && ch.peer.readyState === 'open') {
            ch.peer.onmessage?.({ data });
          }
        });
      },
      close() {
        ch.readyState = 'closed';
        ch.onclose?.();
      },
    };
    return ch;
  };
  const a = mk();
  const b = mk();
  a.peer = b;
  b.peer = a;
  return { a, b };
}

type CapturedRelayFrame = {
  id: string;
  from: string;
  packet: unknown;
  options: SendPacketOptions;
  envelope: RelayEnvelope;
};

/**
 * In-memory E2E relay bus implementing the `RelayClient` surface with REAL `encryptRelayEnvelope`
 * and `decryptRelayEnvelope` using each device's P-256 ECDSA + ECDH keys.
 */
class FakeRelayBus {
  readonly captured: CapturedRelayFrame[] = [];
  readonly ackedByDevice = new Map<string, number[]>();
  private clients = new Map<string, FakeRelayEndpoint>();
  private cursor = 0;

  createEndpoint(device: TestDevice, options: RelayClientOptions): FakeRelayEndpoint {
    const ep = new FakeRelayEndpoint(this, device, options);
    this.clients.set(device.id, ep);
    return ep;
  }

  async deliver(sender: TestDevice, packet: unknown, opts: SendPacketOptions, id: string, seq: number) {
    const envelope = await encryptRelayEnvelope(packet, {
      ...opts,
      room: opts.recipients[0] ? this.clients.get(sender.id)!.roomId : this.clients.get(sender.id)!.roomId,
      from: sender.id,
      id,
      seq,
      sign: sender.sign,
    });
    this.captured.push({ id, from: sender.id, packet, options: opts, envelope });

    const senderEp = this.clients.get(sender.id);
    senderEp?.options.onAccepted?.(id);

    for (const recipient of opts.recipients) {
      const targetEp = this.clients.get(recipient.id);
      if (!targetEp || !targetEp.isConnected()) continue;
      const nextCursor = ++this.cursor;
      await targetEp.options.onEnvelope?.(envelope, { cursor: nextCursor, carrier: 'wss' });
    }
  }

  recordAck(deviceId: string, cursor: number) {
    const list = this.ackedByDevice.get(deviceId) ?? [];
    list.push(cursor);
    this.ackedByDevice.set(deviceId, list);
  }
}

class FakeRelayEndpoint {
  readonly roomId: string;
  private connected = false;
  private seq = 0;
  pendingPrimaryCount = 0;
  currentFileInFlightBytes = 0;
  private inflight: Promise<void> = Promise.resolve();

  constructor(
    private bus: FakeRelayBus,
    private device: TestDevice,
    readonly options: RelayClientOptions,
  ) {
    this.roomId = options.roomId;
  }

  isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    this.connected = true;
    this.options.onStateChange?.('wss');
  }

  stop(): void {
    this.connected = false;
    this.options.onStateChange?.('disconnected');
  }

  ackCursor(cursor: number): void {
    this.bus.recordAck(this.device.id, cursor);
  }

  enqueuePacket(plaintextPacket: unknown, options: SendPacketOptions): string {
    const id = options.id ?? crypto.randomUUID();
    const seq = ++this.seq;
    this.inflight = this.inflight.then(() =>
      this.bus.deliver(this.device, plaintextPacket, options, id, seq),
    );
    return id;
  }

  async flushDelivery(): Promise<void> {
    await this.inflight;
  }
}

async function openNode(params: {
  roomId: string;
  device: TestDevice;
  isHost: boolean;
  now?: () => number;
  withVfs?: boolean;
  vfsRelayBudget?: VfsRelayBudget;
  vfsSyncTracker?: VfsSyncTracker;
  relayBus?: FakeRelayBus;
  pinnedHost?: string;
}) {
  const errors: string[] = [];
  const receivedMessages: SavedMessage[] = [];
  const clock = params.now ?? (() => Date.now());

  let vfs: VfsRoomEngine | undefined;
  let store: MemoryVfsStore | undefined;
  if (params.withVfs !== false) {
    store = new MemoryVfsStore();
    const roomStore = await store.openRoom(params.roomId);
    vfs = await VfsRoomEngine.open({
      roomId: params.roomId,
      store: roomStore,
      selfMemberId: params.device.memberId,
      selfDeviceId: params.device.id,
      selfRole: params.device.role,
      selfEncPrivateKey: params.device.encKeys.privateKey,
      sign: params.device.sign,
      isHost: params.isHost,
      pinnedHost: params.pinnedHost,
      now: clock,
    });
  }

  let relayEndpoint: FakeRelayEndpoint | undefined;
  const peers = new BrowserPeers(
    {} as never,
    params.roomId,
    params.device.id,
    `sess-${params.device.id.slice(0, 8)}`,
    msgs => {
      receivedMessages.splice(0, receivedMessages.length, ...msgs);
    },
    msg => errors.push(msg),
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    clock,
    {
      hostPin: params.pinnedHost,
      vfs,
      vfsRelayBudget: params.vfsRelayBudget,
      vfsSyncTracker: params.vfsSyncTracker,
      ...(params.relayBus
        ? {
            createRelayClient: (opts: RelayClientOptions) => {
              relayEndpoint = params.relayBus!.createEndpoint(params.device, opts);
              return relayEndpoint as unknown as RelayClient;
            },
            decryptRelay: (envelope, opts) =>
              decryptRelayEnvelope(envelope, {
                room: opts.room,
                selfDeviceId: params.device.id,
                selfEncPrivateKey: params.device.encKeys.privateKey,
                selfEncVersion: 1,
                senderSignKey: opts.senderSignKey,
              }) as Promise<DecryptedRelayEnvelope<unknown>>,
          }
        : {}),
    },
  );

  peers.fenced(await claimFence(`owner:${params.device.id}:${params.roomId}`));
  await peers.load();

  const settle = async () => {
    const internal = peers as unknown as { incoming: { size: number }; serial: Promise<unknown> };
    for (let i = 0; i < 6; i++) {
      if (relayEndpoint) await relayEndpoint.flushDelivery();
      while (internal.incoming.size > 0) await Bun.sleep(2);
      await internal.serial;
      await Bun.sleep(4);
    }
  };

  return {
    peers,
    vfs,
    store,
    errors,
    receivedMessages,
    getRelayEndpoint: () => relayEndpoint,
    settle,
  };
}

function attachDirectChannel(
  node: Awaited<ReturnType<typeof openNode>>,
  remoteDeviceId: string,
  channel: FakeDataChannel,
  nowMs = 10_000,
) {
  const internal = node.peers as unknown as {
    peers: Map<string, unknown>;
    connectChannel: (peer: unknown, id: string, ch: unknown) => void;
  };
  const peer = {
    pc: { connectionState: 'connected', iceConnectionState: 'connected', close() {} },
    session: `sess-${remoteDeviceId.slice(0, 8)}`,
    started: nowMs,
    sent: new Map<string, number>(),
    resync: new Resync(),
  };
  internal.peers.set(remoteDeviceId, peer);
  internal.connectChannel(peer, remoteDeviceId, channel);
  return peer;
}

async function waitForCondition(predicate: () => boolean | Promise<boolean>, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for VFS transport convergence');
}

const activeNodes: Array<Awaited<ReturnType<typeof openNode>>> = [];

beforeEach(() => {
  fakeStorage.records.clear();
  fakeStorage.writes = 0;
  fakeStorage.failWith = undefined;
  resetIdentityCache();
});

afterEach(async () => {
  while (activeNodes.length > 0) {
    const node = activeNodes.pop()!;
    await node.peers.close();
    if (node.vfs) await node.vfs.close();
  }
});

// ---------------------------------------------------------------------------
// 1. Live WebRTC Sync + Catch-Up Anti-Entropy (create, patch, revert)
// ---------------------------------------------------------------------------

describe('VFS transport integration', () => {
  test('two BrowserPeers instances sync encrypted docs, patches, and reverts over live WebRTC + vfs-have anti-entropy', async () => {
    const roomId = crypto.randomUUID();
    const hostDev = await createTestDevice({
      roomId,
      memberId: crypto.randomUUID(),
      name: 'Alice',
      role: 'human',
    });
    const peerDev = await createTestDevice({
      roomId,
      memberId: crypto.randomUUID(),
      name: 'Bot',
      role: 'agent',
    });
    const roster = await buildSignedRoster(roomId, hostDev, [hostDev, peerDev]);

    const hostNode = await openNode({ roomId, device: hostDev, isHost: true, pinnedHost: hostDev.id });
    const peerNode = await openNode({ roomId, device: peerDev, isHost: false, pinnedHost: hostDev.id });
    activeNodes.push(hostNode, peerNode);

    await hostNode.peers.update(buildStatus({ roomId, self: hostDev, owner: hostDev, devices: [hostDev, peerDev], roster }));
    await peerNode.peers.update(buildStatus({ roomId, self: peerDev, owner: hostDev, devices: [hostDev, peerDev], roster }));

    const pair = makeChannelPair();
    attachDirectChannel(hostNode, peerDev.id, pair.a);
    attachDirectChannel(peerNode, hostDev.id, pair.b);
    await hostNode.settle();
    await peerNode.settle();

    // Host bootstraps Epoch 1 and creates a shared document.
    const epoch1 = await hostNode.vfs!.bootstrapEpoch1(roster);
    hostNode.peers.sendVfsPackets(epoch1.packets);

    const created = await hostNode.vfs!.createDoc({
      path: 'spec.md',
      content: 'Line 1: alpha\nLine 2: beta\nLine 3: gamma\n',
      requestId: crypto.randomUUID(),
      message: 'Initial spec',
    });
    hostNode.peers.sendVfsPackets(created.outbound);

    await waitForCondition(
      () => peerNode.vfs!.listDocs().length === 1 && peerNode.vfs!.readDoc('spec.md').text === 'Line 1: alpha\nLine 2: beta\nLine 3: gamma\n',
    );
    expect(peerNode.vfs!.readDoc('spec.md').text).toBe('Line 1: alpha\nLine 2: beta\nLine 3: gamma\n');

    // Collaborator patches Line 2 concurrently and broadcasts back to Host.
    const baseRev = peerNode.vfs!.readDoc('spec.md').rev;
    const patched = await peerNode.vfs!.patchDoc({
      nodeIdOrPath: 'spec.md',
      baseRev,
      hunks: [{ op: 'replace', old: 'Line 2: beta', new: 'Line 2: BETA-UPDATED' }],
      requestId: crypto.randomUUID(),
      message: 'Agent updated line 2',
    });
    peerNode.peers.sendVfsPackets(patched.outbound);

    await waitForCondition(() => hostNode.vfs!.readDoc('spec.md').text.includes('BETA-UPDATED'));
    expect(hostNode.vfs!.readDoc('spec.md').text).toBe('Line 1: alpha\nLine 2: BETA-UPDATED\nLine 3: gamma\n');

    // Host reverts back to the initial commit using compensating CRDT op.
    const reverted = await hostNode.vfs!.revertDoc({
      nodeIdOrPath: 'spec.md',
      targetCommitId: created.commitId,
      requestId: crypto.randomUUID(),
      message: 'Revert to initial spec',
    });
    hostNode.peers.sendVfsPackets(reverted.outbound);

    await waitForCondition(
      () => peerNode.vfs!.readDoc('spec.md').text === 'Line 1: alpha\nLine 2: beta\nLine 3: gamma\n'
        && peerNode.vfs!.history('spec.md').length === 3,
    );
    expect(await hostNode.vfs!.getFrontierHash()).toBe(await peerNode.vfs!.getFrontierHash());
    expect(peerNode.vfs!.history('spec.md')).toHaveLength(3);

    // Offline catch-up: Host writes a second document while a 3rd peer joins cold and pulls via vfs-have -> vfs-ops.
    const lateDev = await createTestDevice({
      roomId,
      memberId: crypto.randomUUID(),
      name: 'Carol',
      role: 'human',
    });
    const rosterV2 = await buildSignedRoster(roomId, hostDev, [hostDev, peerDev, lateDev], { previous: roster });
    const epoch2 = await hostNode.vfs!.rotateEpoch(rosterV2);
    const created2 = await hostNode.vfs!.createDoc({
      path: 'plan.md',
      content: 'Phase 1: core\nPhase 2: transport\n',
      requestId: crypto.randomUUID(),
      message: 'Add plan',
    });
    expect(epoch2.epoch).toBe(2);
    expect(created2.outbound.length).toBeGreaterThan(0);

    const lateNode = await openNode({ roomId, device: lateDev, isHost: false, pinnedHost: hostDev.id });
    activeNodes.push(lateNode);
    await hostNode.peers.update(buildStatus({ roomId, self: hostDev, owner: hostDev, devices: [hostDev, peerDev, lateDev], roster: rosterV2 }));
    await lateNode.peers.update(buildStatus({ roomId, self: lateDev, owner: hostDev, devices: [hostDev, peerDev, lateDev], roster: rosterV2 }));

    const latePair = makeChannelPair();
    attachDirectChannel(hostNode, lateDev.id, latePair.a);
    attachDirectChannel(lateNode, hostDev.id, latePair.b);

    // Wait for late peer to receive Epoch 2 wraps + plan.md automatically via vfs-have anti-entropy.
    await waitForCondition(() => lateNode.vfs!.listDocs().some(d => d.path === 'plan.md'));
    expect(lateNode.vfs!.readDoc('plan.md').text).toBe('Phase 1: core\nPhase 2: transport\n');
    expect(hostNode.errors).toEqual([]);
    expect(peerNode.errors).toEqual([]);
    expect(lateNode.errors).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // 2. Sealed E2E Relay Sync + Hard ZERO `hold: true` / ZERO `wake` Invariant
  // ---------------------------------------------------------------------------

  test('sealed E2E relay syncs VFS docs/patches/reverts and NEVER sets hold: true or wake (even with wakeable agents)', async () => {
    const roomId = crypto.randomUUID();
    const relayUrl = 'wss://relay.example/api/relay/v1';
    const bus = new FakeRelayBus();

    const hostDev = await createBrowserHostDevice({
      roomId,
      memberId: crypto.randomUUID(),
      name: 'Alice',
      role: 'human',
      wakeable: true,
    });
    const agentDev = await createTestDevice({
      roomId,
      memberId: crypto.randomUUID(),
      name: 'Bob',
      role: 'agent',
      wakeable: true,
    });
    const roster = await buildSignedRoster(roomId, hostDev, [hostDev, agentDev]);

    const hostNode = await openNode({ roomId, device: hostDev, isHost: true, relayBus: bus, pinnedHost: hostDev.id });
    const agentNode = await openNode({ roomId, device: agentDev, isHost: false, relayBus: bus, pinnedHost: hostDev.id });
    activeNodes.push(hostNode, agentNode);

    await hostNode.peers.update(buildStatus({ roomId, self: hostDev, owner: hostDev, devices: [hostDev, agentDev], roster, relayUrl }));
    await agentNode.peers.update(buildStatus({ roomId, self: agentDev, owner: hostDev, devices: [hostDev, agentDev], roster, relayUrl }));
    await hostNode.settle();
    await agentNode.settle();

    // Control check: a normal chat @mention to a wakeable agent DOES set hold: true and wake: [agentDev.id].
    await hostNode.peers.send('@Bob please review the shared notes');
    await hostNode.settle();
    await agentNode.settle();

    const chatFrame = bus.captured.find(
      f => f.from === hostDev.id && (f.packet as { body?: { kind?: string } })?.body?.kind === 'message',
    );
    expect(chatFrame).toBeDefined();
    expect(chatFrame!.options.hold).toBe(true);
    expect(chatFrame!.options.wake).toEqual([agentDev.id]);
    expect(chatFrame!.envelope.hold).toBe(true);
    expect(chatFrame!.envelope.wake).toEqual([agentDev.id]);

    // Now run full VFS sync strictly over the sealed E2E relay (NO WebRTC channels attached).
    const epoch1 = await hostNode.vfs!.bootstrapEpoch1(roster);
    hostNode.peers.sendVfsPackets(epoch1.packets);

    const created = await hostNode.vfs!.createDoc({
      path: 'relay-doc.md',
      content: 'Header\nOriginal line\nFooter\n',
      requestId: crypto.randomUUID(),
    });
    hostNode.peers.sendVfsPackets(created.outbound);

    await waitForCondition(
      () => agentNode.vfs!.listDocs().length === 1 && agentNode.vfs!.readDoc('relay-doc.md').text === 'Header\nOriginal line\nFooter\n',
    );
    expect(agentNode.vfs!.readDoc('relay-doc.md').text).toBe('Header\nOriginal line\nFooter\n');

    // Agent patches via sealed E2E relay.
    const patched = await agentNode.vfs!.patchDoc({
      nodeIdOrPath: 'relay-doc.md',
      baseRev: agentNode.vfs!.readDoc('relay-doc.md').rev,
      hunks: [{ op: 'replace', old: 'Original line', new: 'Relay-patched line' }],
      requestId: crypto.randomUUID(),
    });
    agentNode.peers.sendVfsPackets(patched.outbound);
    await waitForCondition(() => hostNode.vfs!.readDoc('relay-doc.md').text.includes('Relay-patched line'));

    // Host reverts via sealed E2E relay.
    const reverted = await hostNode.vfs!.revertDoc({
      nodeIdOrPath: 'relay-doc.md',
      targetCommitId: created.commitId,
      requestId: crypto.randomUUID(),
    });
    hostNode.peers.sendVfsPackets(reverted.outbound);
    await waitForCondition(() => agentNode.vfs!.readDoc('relay-doc.md').text === 'Header\nOriginal line\nFooter\n');

    // Trigger explicit anti-entropy sync over relay AND test sendViaRelay direct guard.
    await hostNode.peers.syncVfsNow(agentDev.id);
    const directGuardHave = await hostNode.vfs!.buildHave();
    (hostNode.peers as unknown as { sendViaRelay: (pkt: unknown, lane: 'primary', targets?: string[]) => void })
      .sendViaRelay(directGuardHave, 'primary', [agentDev.id]);
    await hostNode.settle();
    await agentNode.settle();

    expect(await hostNode.vfs!.getFrontierHash()).toBe(await agentNode.vfs!.getFrontierHash());

    // Hard Decision 1 + Loop-Safety assertion across EVERY captured VFS relay frame!
    const vfsFrames = bus.captured.filter(
      f => f.packet && typeof f.packet === 'object' && isVfsPacketKind((f.packet as { kind?: unknown }).kind),
    );
    expect(vfsFrames.length).toBeGreaterThanOrEqual(8);
    for (const frame of vfsFrames) {
      expect(frame.options.hold).not.toBe(true);
      expect(frame.options.wake).toBeUndefined();
      expect(frame.envelope.hold).toBeUndefined();
      expect(frame.envelope.wake).toBeUndefined();
    }
  });

  // ---------------------------------------------------------------------------
  // 3. VfsRelayBudget Pacing, Chat Priority Yield & 429 Backoff
  // ---------------------------------------------------------------------------

  test('VfsRelayBudget throttles VFS bursts, yields immediately to pending chat, and drains once clear', async () => {
    let clock = 100_000;
    const roomId = crypto.randomUUID();
    const relayUrl = 'wss://relay.example/api/relay/v1';
    const bus = new FakeRelayBus();

    const hostDev = await createBrowserHostDevice({ roomId, memberId: crypto.randomUUID(), name: 'Host', role: 'human' });
    const peerDev = await createTestDevice({ roomId, memberId: crypto.randomUUID(), name: 'Peer', role: 'human' });
    const roster = await buildSignedRoster(roomId, hostDev, [hostDev, peerDev]);

    const budget = new VfsRelayBudget({
      maxFramesPerMin: 5,
      maxOpsFramesPerMin: 4,
      windowMs: 60_000,
      now: () => clock,
      random: () => 0.5,
    });

    const hostNode = await openNode({
      roomId,
      device: hostDev,
      isHost: true,
      relayBus: bus,
      vfsRelayBudget: budget,
      now: () => clock,
      pinnedHost: hostDev.id,
    });
    const peerNode = await openNode({
      roomId,
      device: peerDev,
      isHost: false,
      relayBus: bus,
      now: () => clock,
      pinnedHost: hostDev.id,
    });
    activeNodes.push(hostNode, peerNode);

    await hostNode.peers.update(buildStatus({ roomId, self: hostDev, owner: hostDev, devices: [hostDev, peerDev], roster, relayUrl }));
    await peerNode.peers.update(buildStatus({ roomId, self: peerDev, owner: hostDev, devices: [hostDev, peerDev], roster, relayUrl }));
    await hostNode.settle();

    // Clear initial sync frames and advance window so budget starts fresh.
    clock += 65_000;
    const beforeCount = bus.captured.filter(
      f => f.from === hostDev.id && isVfsPacketKind((f.packet as { kind?: unknown })?.kind),
    ).length;

    await hostNode.vfs!.bootstrapEpoch1(roster);
    const have = await hostNode.vfs!.buildHave();
    const burst: VfsPacket[] = Array.from({ length: 7 }, () => ({ ...have }));
    hostNode.peers.sendVfsPackets(burst, [peerDev.id]);
    await hostNode.settle();

    // Ops sub-cap is 4/min: exactly 4 frames sent immediately, 3 queued in vfsRelayQueue.
    const sentImmediately = bus.captured.filter(
      f => f.from === hostDev.id && isVfsPacketKind((f.packet as { kind?: unknown })?.kind),
    ).length - beforeCount;
    expect(sentImmediately).toBe(4);
    expect(budget.stats(clock).opsFramesUsed).toBe(4);

    // Advance clock past window, but simulate queued chat on the relay primary lane (`pendingPrimaryCount = 2`).
    clock += 65_000;
    const hostRelay = hostNode.getRelayEndpoint()!;
    hostRelay.pendingPrimaryCount = 2;
    expect(budget.stats(clock).chatYielding).toBe(true);

    // Calling tick() while chat is pending MUST NOT drain queued VFS frames!
    (hostNode.peers as unknown as { tick: () => void }).tick();
    await hostNode.settle();
    const sentDuringChat = bus.captured.filter(
      f => f.from === hostDev.id && isVfsPacketKind((f.packet as { kind?: unknown })?.kind),
    ).length - beforeCount;
    expect(sentDuringChat).toBe(4);

    // Chat message itself still sends immediately without waiting on VFS!
    await hostNode.peers.send('Chat has strict priority over VFS');
    await hostNode.settle();
    expect(bus.captured.some(f => (f.packet as { body?: { text?: string } })?.body?.text === 'Chat has strict priority over VFS')).toBe(true);

    // Clear chat backlog -> tick() drains the remaining 3 queued VFS frames cleanly.
    hostRelay.pendingPrimaryCount = 0;
    expect(budget.stats(clock).chatYielding).toBe(false);
    (hostNode.peers as unknown as { tick: () => void }).tick();
    await hostNode.settle();
    const sentAfterDrain = bus.captured.filter(
      f => f.from === hostDev.id && isVfsPacketKind((f.packet as { kind?: unknown })?.kind),
    ).length - beforeCount;
    expect(sentAfterDrain).toBe(7);

    // Relay 429 rejection activates VfsRelayBudget exponential backoff.
    hostRelay.options.onRejected?.('env-429', 'rate_limited', 429);
    expect(budget.stats(clock).backoffRemainingMs).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // 4. ReceiveQuota Isolation ('vfs' & 'vfs-sync') + Chat Immunity + Recovery
  // ---------------------------------------------------------------------------

  test('ReceiveQuota drops abusive VFS floods without dropping chat and recovers after quiet window', async () => {
    // Unit-level bucket bounds check for 'vfs' and 'vfs-sync'.
    let unitClock = 0;
    const rq = new ReceiveQuota(() => unitClock);
    const m = crypto.randomUUID();
    for (let i = 0; i < VFS_QUOTA_BURST; i++) expect(rq.take(m, 'vfs')).toBe(true);
    expect(rq.take(m, 'vfs')).toBe(false);
    expect(rq.take(m, 'message')).toBe(true); // Chat unaffected.
    expect(rq.take(m, 'vfs-sync', VFS_SYNC_QUOTA_BURST)).toBe(true);
    expect(rq.take(m, 'vfs-sync', 1)).toBe(false);
    unitClock += 60_000;
    expect(rq.take(m, 'vfs', VFS_QUOTA_BURST)).toBe(true);
    expect(VFS_QUOTA_PER_MINUTE).toBe(60);
    expect(VFS_SYNC_QUOTA_PER_MINUTE).toBe(1024);

    // End-to-end BrowserPeers flood test: 40 live vfs-record packets flood Host, exceeding VFS_QUOTA_BURST (30).
    let clock = 50_000;
    const roomId = crypto.randomUUID();
    const hostDev = await createTestDevice({ roomId, memberId: crypto.randomUUID(), name: 'Host', role: 'human' });
    const floodDev = await createTestDevice({ roomId, memberId: crypto.randomUUID(), name: 'Flooder', role: 'agent' });
    const roster = await buildSignedRoster(roomId, hostDev, [hostDev, floodDev]);

    const hostNode = await openNode({ roomId, device: hostDev, isHost: true, now: () => clock, pinnedHost: hostDev.id });
    const floodNode = await openNode({ roomId, device: floodDev, isHost: false, now: () => clock, pinnedHost: hostDev.id });
    activeNodes.push(hostNode, floodNode);

    await hostNode.peers.update(buildStatus({ roomId, self: hostDev, owner: hostDev, devices: [hostDev, floodDev], roster }));
    await floodNode.peers.update(buildStatus({ roomId, self: floodDev, owner: hostDev, devices: [hostDev, floodDev], roster }));

    // Bootstrap Epoch 1 on both nodes before starting the flood.
    const epoch1 = await hostNode.vfs!.bootstrapEpoch1(roster);
    for (const pkt of epoch1.packets) {
      if (pkt.kind === 'vfs-key-epoch') await floodNode.vfs!.acceptKeyEpoch(pkt, { roster });
      if (pkt.kind === 'vfs-key-wrap') await floodNode.vfs!.acceptKeyWrap(pkt, { roster });
    }

    const pair = makeChannelPair();
    attachDirectChannel(hostNode, floodDev.id, pair.a, clock);
    attachDirectChannel(floodNode, hostDev.id, pair.b, clock);
    await hostNode.settle();
    await floodNode.settle();

    // Generate 20 docs (= 60 vfs-record packets: treeOp + docOp + commit each) on floodNode.
    const floodPackets: VfsPacket[] = [];
    for (let i = 0; i < 20; i++) {
      const created = await floodNode.vfs!.createDoc({
        path: `flood-${i}.md`,
        content: `doc body ${i}`,
        requestId: crypto.randomUUID(),
      });
      floodPackets.push(...created.outbound);
    }
    expect(floodPackets.length).toBe(60);

    // Silence quota debug output during test and blast all 60 live vfs-record frames to Host.
    const origDebug = console.debug;
    console.debug = () => {};
    try {
      for (const pkt of floodPackets) {
        pair.a.onmessage?.({ data: JSON.stringify(pkt) });
      }
      await hostNode.settle();

      // Host MUST have dropped the excess past VFS_QUOTA_BURST (30 records = 10 complete docs).
      expect(hostNode.vfs!.listDocs().length).toBeLessThan(20);
      expect(hostNode.vfs!.listDocs().length).toBeLessThanOrEqual(10);

      // Immediately after exhausting 'vfs' quota, chat messages from the SAME member still pass with ZERO drops!
      for (let i = 0; i < 5; i++) {
        const body = {
          kind: 'message',
          roomId,
          id: crypto.randomUUID(),
          deviceId: floodDev.id,
          memberId: floodDev.memberId,
          text: `Chat survives VFS flood #${i}`,
          at: clock + i,
          visibility: 'room' as const,
          seq: i + 1,
        };
        const packet = { body, signature: await floodDev.sign(body) };
        pair.a.onmessage?.({ data: JSON.stringify(packet) });
      }
      await hostNode.settle();
      expect(hostNode.receivedMessages).toHaveLength(5);

      // Advance clock past QUOTA_QUIET_MS + quota refill -> tick() triggers QuotaDrops -> requestSync -> vfs-have recovery!
      clock += QUOTA_QUIET_MS + 1_000;
      (hostNode.peers as unknown as { tick: () => void }).tick();
      const expectedFrontier = await floodNode.vfs!.getFrontierHash();
      await waitForCondition(async () => (await hostNode.vfs!.getFrontierHash()) === expectedFrontier);
      expect(hostNode.vfs!.listDocs()).toHaveLength(20);
      expect(await hostNode.vfs!.getFrontierHash()).toBe(expectedFrontier);
    } finally {
      console.debug = origDebug;
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Legacy Peers Without VFS Ignore All `vfs-*` Packets Cleanly
  // ---------------------------------------------------------------------------

  test('legacy BrowserPeers without VFS ignores unknown vfs-* packets over WebRTC & relay without crashing or dropping chat', async () => {
    const roomId = crypto.randomUUID();
    const relayUrl = 'wss://relay.example/api/relay/v1';
    const bus = new FakeRelayBus();

    const vfsDev = await createBrowserHostDevice({ roomId, memberId: crypto.randomUUID(), name: 'VfsNode', role: 'human' });
    const legacyDev = await createTestDevice({ roomId, memberId: crypto.randomUUID(), name: 'LegacyNode', role: 'human' });
    const roster = await buildSignedRoster(roomId, vfsDev, [vfsDev, legacyDev]);

    const vfsNode = await openNode({ roomId, device: vfsDev, isHost: true, withVfs: true, relayBus: bus, pinnedHost: vfsDev.id });
    const legacyNode = await openNode({ roomId, device: legacyDev, isHost: false, withVfs: false, relayBus: bus, pinnedHost: vfsDev.id });
    activeNodes.push(vfsNode, legacyNode);

    expect(legacyNode.peers.vfs()).toBeUndefined();

    await vfsNode.peers.update(buildStatus({ roomId, self: vfsDev, owner: vfsDev, devices: [vfsDev, legacyDev], roster, relayUrl }));
    await legacyNode.peers.update(buildStatus({ roomId, self: legacyDev, owner: vfsDev, devices: [vfsDev, legacyDev], roster, relayUrl }));

    // 1. Send VFS packets over sealed E2E relay to legacy peer.
    const epoch1 = await vfsNode.vfs!.bootstrapEpoch1(roster);
    const doc = await vfsNode.vfs!.createDoc({ path: 'readme.md', content: 'hello legacy', requestId: crypto.randomUUID() });
    const have = await vfsNode.vfs!.buildHave();
    const blockWant: VfsPacket = {
      kind: 'vfs-block-want',
      v: VFS_PROTOCOL_VERSION,
      roomId,
      deviceId: vfsDev.id,
      cids: ['a'.repeat(64)],
    };

    vfsNode.peers.sendVfsPackets([...epoch1.packets, ...doc.outbound, have, blockWant], [legacyDev.id]);
    await vfsNode.settle();
    await legacyNode.settle();

    // Every relayed VFS envelope MUST have its inbox cursor acknowledged (never stalling relay sync!).
    const acked = bus.ackedByDevice.get(legacyDev.id) ?? [];
    expect(acked.length).toBeGreaterThanOrEqual(epoch1.packets.length + doc.outbound.length + 2);

    // Chat over relay still arrives cleanly on legacy peer!
    await vfsNode.peers.send('Relay chat still works on legacy peer');
    await waitForCondition(() => legacyNode.receivedMessages.some(m => m.packet.body.text === 'Relay chat still works on legacy peer'));

    // 2. Also send VFS packets over WebRTC DataChannel to legacy peer followed by WebRTC chat.
    const pair = makeChannelPair();
    attachDirectChannel(vfsNode, legacyDev.id, pair.a);
    attachDirectChannel(legacyNode, vfsDev.id, pair.b);
    for (const pkt of [...epoch1.packets, ...doc.outbound, have, blockWant]) {
      pair.b.onmessage?.({ data: JSON.stringify(pkt) });
    }
    const chatBody = {
      kind: 'message',
      roomId,
      id: crypto.randomUUID(),
      deviceId: vfsDev.id,
      memberId: vfsDev.memberId,
      text: 'WebRTC chat still works after vfs-* packets',
      at: Date.now(),
      visibility: 'room' as const,
      seq: 99,
    };
    pair.b.onmessage?.({ data: JSON.stringify({ body: chatBody, signature: await vfsDev.sign(chatBody) }) });
    await legacyNode.settle();

    expect(legacyNode.receivedMessages.some(m => m.packet.body.text === 'WebRTC chat still works after vfs-* packets')).toBe(true);
    expect(legacyNode.errors).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // 6. Revoked Device Rejection & Historical Non-Revoked Former Device Support
  // ---------------------------------------------------------------------------

  test('BrowserPeers VFS signer lookup rejects revoked devices and accepts non-revoked formerDevices', async () => {
    const roomId = crypto.randomUUID();
    const hostDev = await createTestDevice({ roomId, memberId: crypto.randomUUID(), name: 'Host', role: 'human' });
    const revokedDev = await createTestDevice({ roomId, memberId: crypto.randomUUID(), name: 'Revoked', role: 'human' });
    const formerDev = await createTestDevice({ roomId, memberId: crypto.randomUUID(), name: 'Departed', role: 'human' });
    const relayPeerDev = await createTestDevice({ roomId, memberId: crypto.randomUUID(), name: 'RelayPeer', role: 'human' });

    const rosterInitial = await buildSignedRoster(roomId, hostDev, [hostDev, revokedDev, formerDev, relayPeerDev], { version: 1 });
    const hostNode = await openNode({ roomId, device: hostDev, isHost: true, pinnedHost: hostDev.id });
    const revokedNode = await openNode({ roomId, device: revokedDev, isHost: false, pinnedHost: hostDev.id });
    const formerNode = await openNode({ roomId, device: formerDev, isHost: false, pinnedHost: hostDev.id });
    activeNodes.push(hostNode, revokedNode, formerNode);

    const epoch1 = await hostNode.vfs!.bootstrapEpoch1(rosterInitial);
    for (const target of [revokedNode, formerNode]) {
      for (const pkt of epoch1.packets) {
        if (pkt.kind === 'vfs-key-epoch') await target.vfs!.acceptKeyEpoch(pkt, { roster: rosterInitial });
        if (pkt.kind === 'vfs-key-wrap') await target.vfs!.acceptKeyWrap(pkt, { roster: rosterInitial });
      }
    }

    const revokedDoc = await revokedNode.vfs!.createDoc({ path: 'bad.md', content: 'from revoked', requestId: crypto.randomUUID() });
    const formerDoc = await formerNode.vfs!.createDoc({ path: 'legacy-author.md', content: 'from departed', requestId: crypto.randomUUID() });

    // Roster v2 removes revokedDev (revoked: true) and formerDev (revoked: false).
    const rosterV2 = await buildSignedRoster(roomId, hostDev, [hostDev, relayPeerDev], {
      previous: rosterInitial,
      removed: [
        { id: revokedDev.id, at: 20_000, revoked: true },
        { id: formerDev.id, at: 20_000, revoked: false },
      ],
    });
    await hostNode.peers.update(buildStatus({
      roomId,
      self: hostDev,
      owner: hostDev,
      devices: [hostDev, relayPeerDev],
      roster: rosterV2,
      formerDevices: [
        { id: revokedDev.id, publicKey: revokedDev.signPublicKey, memberId: revokedDev.memberId, retiredAt: 20_000, revoked: true },
        { id: formerDev.id, publicKey: formerDev.signPublicKey, memberId: formerDev.memberId, retiredAt: 20_000 },
      ],
    }));

    const pair = makeChannelPair();
    attachDirectChannel(hostNode, relayPeerDev.id, pair.a);

    // RelayPeer forwards both records in a vfs-ops batch: revoked MUST be rejected, non-revoked former MUST be accepted!
    const opsPacket: VfsPacket = {
      kind: 'vfs-ops',
      v: VFS_PROTOCOL_VERSION,
      roomId,
      deviceId: relayPeerDev.id,
      records: [...revokedDoc.outbound, ...formerDoc.outbound],
      more: false,
    };
    pair.a.onmessage?.({ data: JSON.stringify(opsPacket) });
    await hostNode.settle();

    const docs = hostNode.vfs!.listDocs().map(d => d.path);
    expect(docs).toEqual(['legacy-author.md']);
    expect(hostNode.vfs!.readDoc('legacy-author.md').text).toBe('from departed');
    expect(hostNode.errors).toEqual([]);
  });
});
