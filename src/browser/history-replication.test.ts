import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserLobby } from '../../server/browser/lobby';
import { BrowserAgent, relayListenOnce } from '../../server/browser-agent';
import { listRetiredDevices, MAX_HISTORY_FORMER_DEVICES, openAdmission, upsertRetiredDevice } from '../../server/browser/store';
import { attachmentRef } from './files';
import { MAX_STORED_MESSAGES } from './history';
import {
  analyzeHistory,
  buildHistoryHave,
  HISTORY_ACCEPT_ENTRIES_BURST,
  HISTORY_SERVE_BURST,
  historyChunks,
  MAX_SEQ_JUMP,
  type HistoryPacket,
} from './history-sync';
import { BrowserPeers, type SavedMessage } from './peers';
import { signerOf, type RoomStatus } from './protocol';
import { HISTORY_QUOTA_BURST, QUOTA_QUIET_MS } from './quota';
import { encryptRelayEnvelope, signRoster, type RosterBody, type RosterEntry } from './relay-crypto';
import { claimFence, identity as browserIdentity, resetIdentityCache } from './storage';
import { fakeStorage, installFakeIndexedDB } from './test-indexeddb';

const dirs: string[] = [];
const tempDir = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function waitFor(fn: () => boolean, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await Bun.sleep(15);
  }
  throw new Error('Timed out waiting for condition');
}

/** Minimal paired DataChannel mock for driving `BrowserPeers` history & file replication in-process. */
function makeChannelPair() {
  const mk = () => {
    const ch = {
      readyState: 'open',
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      onopen: undefined as (() => void) | undefined,
      onclose: undefined as (() => void) | undefined,
      onmessage: undefined as ((event: { data: string }) => void) | undefined,
      sent: [] as string[],
      peer: undefined as any,
      addEventListener() {},
      removeEventListener() {},
      send(data: string) {
        ch.sent.push(data);
        queueMicrotask(() => ch.peer?.onmessage?.({ data }));
      },
      close() { ch.readyState = 'closed'; ch.onclose?.(); },
    };
    return ch;
  };
  const a = mk(), b = mk();
  a.peer = b; b.peer = a;
  return { a, b };
}

describe('History replication (docs/flows/history-replication.md)', () => {
  test('lobby records member joinedAt, preserves it for companion devices, preserves priorMembers on voluntary rejoin, discloses historyForNewcomers, and bounds retired keys', async () => {
    let clock = 10_000;
    const lobby = new BrowserLobby(':memory:', { origin: 'https://rooms.example', now: () => clock });
    try {
      const mkClient = async () => {
        const home = tempDir('mr-hist-lobby-');
        const room = '11111111-1111-4111-8111-111111111111';
        const agent = new BrowserAgent(home, 'https://rooms.example', room);
        const id = await agent.ensureIdentity();
        return {
          agent,
          id: id.id,
          session: crypto.randomUUID(),
          async send(action: string, roomId: string, payload: Record<string, unknown> = {}) {
            const command = { protocol: 'meshrooms-browser-v1' as const, origin: 'https://rooms.example', id: crypto.randomUUID(), at: clock, action, roomId, payload };
            return lobby.execute({ command: command as never, publicKey: id.publicKey, signature: await agent.sign(command) });
          },
        };
      };

      const host = await mkClient(), bobDesktop = await mkClient(), bobPhone = await mkClient(), carol = await mkClient();
      const room = crypto.randomUUID();
      await host.send('create', room, { title: 'Core', name: 'Host', label: 'Desktop' });

      // Default off on publicRoom & pre-admission status
      expect(lobby.publicRoom(room)).toEqual({ roomId: room, title: 'Core', historyForNewcomers: false });
      const carolPre = await carol.send('status', room, { session: carol.session }) as RoomStatus;
      expect(carolPre.memberId).toBeUndefined();
      expect(carolPre.historyForNewcomers).toBe(false);

      // Admit Bob at t = 20_000
      clock = 20_000;
      await bobDesktop.send('request', room, { kind: 'person', name: 'Bob', label: 'Laptop' });
      const reqBob = ((await host.send('status', room, { session: host.session })) as RoomStatus).requests![0];
      await host.send('decide', room, { requestId: reqBob.id, admit: true });

      // Enable historyForNewcomers at t = 25_000; verify disclosure on publicRoom and pre-admission status
      clock = 25_000;
      await host.send('settings', room, { historyForNewcomers: true });
      expect(lobby.publicRoom(room).historyForNewcomers).toBe(true);
      expect(((await carol.send('status', room, { session: carol.session })) as RoomStatus).historyForNewcomers).toBe(true);

      // Link Bob's companion phone at t = 40_000 — Bob's member.joinedAt MUST stay 20_000!
      clock = 40_000;
      await bobPhone.send('request', room, { kind: 'companion', name: 'Bob', label: 'Phone' });
      const code = ((await bobPhone.send('status', room, { session: bobPhone.session })) as RoomStatus).request!.code!;
      await bobDesktop.send('link', room, { code });

      const status = await host.send('status', room, { session: host.session }) as RoomStatus;
      const bobMember = status.members!.find(m => m.name === 'Bob')!;
      const bobPhoneDev = status.devices!.find(d => d.id === bobPhone.id)!;
      expect(bobMember.joinedAt).toBe(20_000);
      expect(bobPhoneDev.admittedAt).toBe(40_000);
      expect(status.settings?.historyForNewcomers).toBe(true);

      // Carol joins, leaves voluntarily, then rejoins with the same browser device -> priorMembers keeps earlier records verifiable!
      clock = 50_000;
      await carol.send('request', room, { kind: 'person', name: 'Carol', label: 'Browser' });
      const reqCarol1 = ((await host.send('status', room, { session: host.session })) as RoomStatus).requests!.find(r => r.name === 'Carol')!;
      await host.send('decide', room, { requestId: reqCarol1.id, admit: true });
      const carolOldMemberId = ((await carol.send('status', room, { session: carol.session })) as RoomStatus).memberId!;

      clock = 60_000;
      await carol.send('remove', room, { deviceId: carol.id });

      clock = 70_000;
      await carol.send('request', room, { kind: 'person', name: 'Carol', label: 'Browser' });
      const reqCarol2 = ((await host.send('status', room, { session: host.session })) as RoomStatus).requests!.find(r => r.name === 'Carol')!;
      await host.send('decide', room, { requestId: reqCarol2.id, admit: true });
      const afterRejoin = await host.send('status', room, { session: host.session }) as RoomStatus;
      const carolDev = afterRejoin.devices!.find(d => d.id === carol.id)!;
      expect(carolDev.memberId).not.toBe(carolOldMemberId);
      expect(carolDev.priorMembers).toEqual([{ memberId: carolOldMemberId, retiredAt: 60_000 }]);
      // Earlier message dated before voluntary leave still verifies under prior memberId; later timestamp does not!
      expect(signerOf(afterRejoin, carol.id, 55_000, carolOldMemberId)?.memberId).toBe(carolOldMemberId);
      expect(signerOf(afterRejoin, carol.id, 65_000, carolOldMemberId)?.memberId).toBe(carolDev.memberId);
    } finally {
      lobby.close();
    }

    // Store-level test: listRetiredDevices stays strictly bounded (e.g. MAX_HISTORY_FORMER_DEVICES).
    const db = openAdmission(':memory:', 1000);
    try {
      const room = crypto.randomUUID();
      for (let i = 0; i < 12; i++) {
        upsertRetiredDevice(db, room, { id: `${i.toString(16).padStart(64, '0')}`, publicKey: 'k'.repeat(88), memberId: crypto.randomUUID(), role: 'human', retiredAt: 1000 + i });
      }
      expect(listRetiredDevices(db, room, 5)).toHaveLength(5);
      expect(listRetiredDevices(db, room, MAX_HISTORY_FORMER_DEVICES)).toHaveLength(12);
    } finally {
      db.close();
    }
  });

  test('newcomer visibility, companion history, tamper/reattribute/huge-seq rejection, equivocation, gap recovery, ID squatting, rate limits, >128-msg convergence, and real BrowserPeers file visibility', async () => {
    installFakeIndexedDB();
    fakeStorage.records.clear();
    resetIdentityCache();

    const roomId = crypto.randomUUID();
    const local = await browserIdentity();
    const tmp = tempDir('mr-hist-peers-');
    const hostAgent = new BrowserAgent(join(tmp, 'h'), 'https://rooms.example', roomId);
    const companionAgent = new BrowserAgent(join(tmp, 'c'), 'https://rooms.example', roomId);
    const newcomerAgent = new BrowserAgent(join(tmp, 'n'), 'https://rooms.example', roomId);
    const otherPeerAgent = new BrowserAgent(join(tmp, 'o'), 'https://rooms.example', roomId);
    const hostId = await hostAgent.ensureIdentity();
    const companionId = await companionAgent.ensureIdentity();
    const newcomerId = await newcomerAgent.ensureIdentity();
    const otherPeerId = await otherPeerAgent.ensureIdentity();

    const hostMember = crypto.randomUUID();
    const aliceMember = crypto.randomUUID(); // local browser + companionAgent are TWO devices of Alice!
    const newcomerMember = crypto.randomUUID();
    const otherMember = crypto.randomUUID();

    let clock = 2000;
    const status: RoomStatus = {
      roomId,
      title: 'Replication',
      epoch: 'e1',
      hostOnline: true,
      deviceId: local.id,
      memberId: aliceMember,
      ownerId: hostMember,
      settings: { floor: 'humans-first', agentAssignmentsWake: false, guestAgentApproval: true, hostApprovesDevices: false, historyForNewcomers: false },
      members: [
        { id: hostMember, name: 'Host', role: 'human', joinedAt: 1000 },
        { id: aliceMember, name: 'Alice', role: 'human', joinedAt: 1500 },
        { id: otherMember, name: 'Other', role: 'human', joinedAt: 1500 },
        { id: newcomerMember, name: 'Newcomer', role: 'human', joinedAt: 5000 },
      ],
      devices: [
        { id: hostId.id, publicKey: hostId.publicKey, label: 'Host', memberId: hostMember, admittedAt: 1000 },
        { id: local.id, publicKey: local.publicKey, label: 'Alice Desktop', memberId: aliceMember, admittedAt: 1500 },
        // Companion device linked at 6000 (AFTER Newcomer at 5000), but Alice joined at 1500!
        { id: companionId.id, publicKey: companionId.publicKey, label: 'Alice Phone', memberId: aliceMember, admittedAt: 6000 },
        { id: otherPeerId.id, publicKey: otherPeerId.publicKey, label: 'Other', memberId: otherMember, admittedAt: 1500 },
        { id: newcomerId.id, publicKey: newcomerId.publicKey, label: 'Newcomer', memberId: newcomerMember, admittedAt: 5000 },
      ],
    };

    const engine = new BrowserPeers({} as never, roomId, local.id, 's1', () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => clock) as any;
    engine.fenced(await claimFence(`owner:${local.id}:${roomId}`));
    await engine.load();
    // Before Newcomer joined: only Host, Alice, Other are in status.members!
    const statusBeforeNewcomer: RoomStatus = {
      ...status,
      members: status.members!.filter(m => m.id !== newcomerMember),
      devices: status.devices!.filter(d => d.id !== newcomerId.id),
    };
    engine.status = statusBeforeNewcomer;

    // 1. Alice sends a `members`-only message with a secret attachment at t = 2000 -> seq 1, audienceUntil = 1500!
    const secretBytes = new TextEncoder().encode('members-only secret file');
    const publicBytes = new TextEncoder().encode('room-visible shared file');
    const secretRef = await attachmentRef(secretBytes, 'secret.txt');
    const publicRef = await attachmentRef(publicBytes, 'public.txt');

    await engine.send('private before newcomer', undefined, [{ ref: secretRef, bytes: secretBytes }]);
    expect(engine.messages[0].packet.body.visibility).toBe('members');
    expect(engine.messages[0].packet.body.seq).toBe(1);
    expect(engine.messages[0].packet.body.audienceUntil).toBe(1500);

    // 2. Host turns historyForNewcomers ON -> Alice sends a `room`-visible message with a public attachment at t = 3000 -> seq 2
    clock = 3000;
    engine.status = { ...status, settings: { ...status.settings!, historyForNewcomers: true } };
    await engine.send('public room history', undefined, [{ ref: publicRef, bytes: publicBytes }]);
    expect(engine.messages[1].packet.body.visibility).toBe('room');
    expect(engine.messages[1].packet.body.seq).toBe(2);
    expect(engine.messages[1].packet.body.audienceUntil).toBeUndefined();

    // Helper to attach a simulated peer channel to `engine`.
    const connectFakePeer = (requesterDeviceId: string) => {
      const { a, b } = makeChannelPair();
      const fakePc = { connectionState: 'connected', iceConnectionState: 'connected', close() {} } as any;
      const peer = { pc: fakePc, session: 'p1', started: clock, sent: new Map(), resync: { sent() {}, request() {}, due: () => false } } as any;
      engine.peers.set(requesterDeviceId, peer);
      engine.connectChannel(peer, requesterDeviceId, a as any);
      return { a, b, peer };
    };

    const askEngine = async (requesterDeviceId: string) => {
      const { a, b } = connectFakePeer(requesterDeviceId);
      b.send(JSON.stringify(buildHistoryHave(roomId, [])));
      await Bun.sleep(40);
      const historyPackets = a.sent
        .map(raw => JSON.parse(raw))
        .filter((p: any) => p.kind === 'history') as HistoryPacket[];
      return historyPackets.flatMap(p => p.entries);
    };

    // Newcomer (joinedAt 5000) receives ONLY seq 2 (`room`), NEVER seq 1 (`members`)!
    const newcomerEntries = await askEngine(newcomerId.id);
    expect(newcomerEntries.map(e => e.body.text)).toEqual(['public room history']);

    // Companion phone (admittedAt 6000, Alice joinedAt 1500) receives BOTH seq 1 (`members`) AND seq 2 (`room`)!
    const companionEntries = await askEngine(companionId.id);
    expect(companionEntries.map(e => e.body.text).sort()).toEqual(['private before newcomer', 'public room history']);

    // 3. Real BrowserPeers FileTransfers wiring test: newcomer gets `file-missing` for secret.txt & `file-done` for public.txt,
    //    while companion gets `file-done` for secret.txt!
    const newcomerConn = connectFakePeer(newcomerId.id);
    const companionConn = connectFakePeer(companionId.id);
    newcomerConn.b.send(JSON.stringify({ kind: 'file-want', roomId, sha256: secretRef.sha256, offset: 0 }));
    newcomerConn.b.send(JSON.stringify({ kind: 'file-want', roomId, sha256: publicRef.sha256, offset: 0 }));
    companionConn.b.send(JSON.stringify({ kind: 'file-want', roomId, sha256: secretRef.sha256, offset: 0 }));

    const parsed = (list: string[]) => list.map(raw => JSON.parse(raw));
    await waitFor(() =>
      parsed(newcomerConn.a.sent).some(p => p.kind === 'file-missing' && p.sha256 === secretRef.sha256)
      && parsed(newcomerConn.a.sent).some(p => p.kind === 'file-done' && p.sha256 === publicRef.sha256)
      && parsed(companionConn.a.sent).some(p => p.kind === 'file-done' && p.sha256 === secretRef.sha256),
    );
    expect(parsed(newcomerConn.a.sent).some(p => p.kind === 'file-chunk' && p.sha256 === secretRef.sha256)).toBe(false);

    // 4. Serve rate limit ignores request digest: varying a vector counter every time is still throttled after HISTORY_SERVE_BURST!
    const floodConn = connectFakePeer(otherPeerId.id);
    const beforeCount = floodConn.a.sent.length;
    for (let i = 0; i < HISTORY_SERVE_BURST + 6; i++) {
      // Distinct counter every single request!
      floodConn.b.send(JSON.stringify({ kind: 'history-have', roomId, vector: { [otherPeerId.id]: i } }));
    }
    await Bun.sleep(60);
    const servedResponses = floodConn.a.sent.slice(beforeCount).map(r => JSON.parse(r)).filter((p: any) => p.kind === 'history');
    expect(servedResponses.filter((p: any) => p.entries.length > 0).length).toBe(HISTORY_SERVE_BURST);
    // Throttled requests receive at most one bounded `retryAfterMs` hint per second instead of stalling silently or amplifying floods.
    const retryHints = servedResponses.filter((p: any) => p.entries.length === 0 && typeof p.retryAfterMs === 'number');
    expect(retryHints.length).toBe(1);
    expect(retryHints[0].retryAfterMs).toBeGreaterThanOrEqual(250);

    // 5. Tampered, reattributed, huge-seq (1e9), and jump-past-maxHeld entries are rejected by acceptHistory.
    const hostBody1 = { kind: 'message' as const, roomId, id: crypto.randomUUID(), deviceId: hostId.id, memberId: hostMember, text: 'host msg 1', at: 2100, visibility: 'room' as const, seq: 1 };
    const hostSig1 = await hostAgent.sign(hostBody1);
    const tamperedSig = hostSig1.slice(0, -4) + (hostSig1.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const reattributedBody = { ...hostBody1, id: crypto.randomUUID(), memberId: otherMember, seq: 99 };
    const reattributedSig = await hostAgent.sign(reattributedBody);
    const hugeSeqBody = { ...hostBody1, id: crypto.randomUUID(), text: 'huge seq attack', seq: 1_000_000_000 };
    const jumpSeqBody = { ...hostBody1, id: crypto.randomUUID(), text: 'seq jump attack', seq: 1 + MAX_SEQ_JUMP + 50 };

    // Equivocation: host signs TWO different messages for seq = 2!
    const hostBody2a = { kind: 'message' as const, roomId, id: crypto.randomUUID(), deviceId: hostId.id, memberId: hostMember, text: 'host seq 2 A', at: 2200, visibility: 'room' as const, seq: 2 };
    const hostBody2b = { kind: 'message' as const, roomId, id: crypto.randomUUID(), deviceId: hostId.id, memberId: hostMember, text: 'host seq 2 B', at: 2205, visibility: 'room' as const, seq: 2 };
    // Gap: peer sends host seq 1 and seq 4 (withholding seq 3!), then another peer supplies seq 3!
    const hostBody3 = { kind: 'message' as const, roomId, id: crypto.randomUUID(), deviceId: hostId.id, memberId: hostMember, text: 'host seq 3 (recovered)', at: 2300, visibility: 'room' as const, seq: 3 };
    const hostBody4 = { kind: 'message' as const, roomId, id: crypto.randomUUID(), deviceId: hostId.id, memberId: hostMember, text: 'host seq 4', at: 2400, visibility: 'room' as const, seq: 4 };

    await engine.acceptHistory(otherPeerId.id, {
      kind: 'history',
      roomId,
      entries: [
        { body: { ...hostBody1, id: crypto.randomUUID(), text: 'tampered' }, signature: tamperedSig },
        { body: reattributedBody, signature: reattributedSig },
        { body: hugeSeqBody, signature: await hostAgent.sign(hugeSeqBody) },
        { body: hostBody1, signature: hostSig1 },
        { body: jumpSeqBody, signature: await hostAgent.sign(jumpSeqBody) },
        { body: hostBody2a, signature: await hostAgent.sign(hostBody2a) },
        { body: hostBody2b, signature: await hostAgent.sign(hostBody2b) },
        { body: hostBody4, signature: await hostAgent.sign(hostBody4) },
      ],
    }, false);

    const texts = engine.messages.map((m: SavedMessage) => m.packet.body.text);
    expect(texts).not.toContain('tampered');
    expect(texts).not.toContain('huge seq attack');
    expect(texts).not.toContain('seq jump attack');
    expect(texts).toContain('host msg 1');
    expect(texts).toContain('host seq 2 A');
    expect(texts).toContain('host seq 2 B');
    expect(texts).toContain('host seq 4');

    // Equivocation detected + vector stopped at 1 + gap range [[3, 3]] visible!
    const beforeFill = analyzeHistory(engine.messages);
    expect(beforeFill.equivocatingDevices.has(hostId.id)).toBe(true);
    expect(beforeFill.vector[hostId.id]).toBe(1);
    expect(beforeFill.gapsByDevice.get(hostId.id)).toEqual([[3, 3]]);
    expect(beforeFill.hasGaps).toBe(true);

    // Another peer supplies the withheld seq 3 -> gap disappears, equivocation warning stays!
    await engine.acceptHistory(hostId.id, {
      kind: 'history',
      roomId,
      entries: [{ body: hostBody3, signature: await hostAgent.sign(hostBody3) }],
    }, false);
    const afterFill = analyzeHistory(engine.messages);
    expect(afterFill.gapsByDevice.get(hostId.id)).toBeUndefined();
    expect(afterFill.hasGaps).toBe(false);
    expect(afterFill.equivocatingDevices.has(hostId.id)).toBe(true);

    // 6. ID squatting: Other signs a fake message with the SAME ID as Host's real message and pushes it first!
    const squattedId = crypto.randomUUID();
    const fakeCopy = { kind: 'message' as const, roomId, id: squattedId, deviceId: otherPeerId.id, memberId: otherMember, text: 'squatted fake', at: 2450, visibility: 'room' as const, seq: 1 };
    const realCopy = { kind: 'message' as const, roomId, id: squattedId, deviceId: hostId.id, memberId: hostMember, text: 'real host msg', at: 2460, visibility: 'room' as const, seq: 5 };
    await engine.acceptHistory(otherPeerId.id, {
      kind: 'history',
      roomId,
      entries: [{ body: fakeCopy, signature: await otherPeerAgent.sign(fakeCopy) }],
    }, false);
    // Real message arrives later via history (or live!) and is NOT blocked by Other's squatted ID!
    await engine.acceptHistory(hostId.id, {
      kind: 'history',
      roomId,
      entries: [{ body: realCopy, signature: await hostAgent.sign(realCopy) }],
    }, false);
    expect(engine.messages.some((m: SavedMessage) => m.packet.body.deviceId === hostId.id && m.packet.body.id === squattedId && m.packet.body.text === 'real host msg')).toBe(true);
    expect(analyzeHistory(engine.messages).collidingMessageIds.has(squattedId)).toBe(true);

    // Add a reaction to `squattedId` before Other deletes its colliding copy -> Host's reaction MUST SURVIVE!
    await engine.react(squattedId, '👍');
    expect(engine.chips().some((c: any) => c.messageId === squattedId && c.emoji === '👍')).toBe(true);

    // Other retracts its squatted copy -> Host's real message AND its reactions stay live!
    const squatRetract = { kind: 'retract' as const, roomId, id: crypto.randomUUID(), deviceId: otherPeerId.id, memberId: otherMember, at: 2500, target: squattedId };
    await engine.acceptRetractions({ roomId, ops: [{ body: squatRetract, signature: await otherPeerAgent.sign(squatRetract) }] }, false);
    const hostMsgAfterRetract = engine.messages.find((m: SavedMessage) => m.packet.body.deviceId === hostId.id && m.packet.body.id === squattedId)!;
    const otherMsgAfterRetract = engine.messages.find((m: SavedMessage) => m.packet.body.deviceId === otherPeerId.id && m.packet.body.id === squattedId)!;
    expect(otherMsgAfterRetract.retracted).toBe(true);
    expect(hostMsgAfterRetract.retracted).toBeUndefined();
    expect(hostMsgAfterRetract.packet.body.text).toBe('real host msg');
    expect(engine.chips().some((c: any) => c.messageId === squattedId && c.emoji === '👍')).toBe(true);

    // Live path ID squatting + live huge-seq rejection: even when Other already squatted `liveSquatId`,
    // Host's real live message with `liveSquatId` is still stored & receipted, while a live `seq: 1e9` is refused!
    const liveSquatId = crypto.randomUUID();
    const otherLiveFake = { kind: 'message' as const, roomId, id: liveSquatId, deviceId: otherPeerId.id, memberId: otherMember, text: 'live squat', at: 2510, visibility: 'room' as const, seq: 2 };
    await engine.acceptHistory(otherPeerId.id, { kind: 'history', roomId, entries: [{ body: otherLiveFake, signature: await otherPeerAgent.sign(otherLiveFake) }] }, false);
    const hostLiveConn = connectFakePeer(hostId.id);
    const hostLiveReal = { kind: 'message' as const, roomId, id: liveSquatId, deviceId: hostId.id, memberId: hostMember, text: 'live real host', at: 2520, visibility: 'room' as const, seq: 6 };
    const hostLiveHuge = { kind: 'message' as const, roomId, id: crypto.randomUUID(), deviceId: hostId.id, memberId: hostMember, text: 'live huge seq', at: 2530, visibility: 'room' as const, seq: 1_000_000_000 };
    hostLiveConn.b.send(JSON.stringify({ body: hostLiveReal, signature: await hostAgent.sign(hostLiveReal) }));
    hostLiveConn.b.send(JSON.stringify({ body: hostLiveHuge, signature: await hostAgent.sign(hostLiveHuge) }));
    await waitFor(() => engine.messages.some((m: SavedMessage) => m.packet.body.deviceId === hostId.id && m.packet.body.id === liveSquatId));
    expect(engine.messages.some((m: SavedMessage) => m.packet.body.id === hostLiveHuge.id)).toBe(false);

    // 7. History receive quota: pushing >HISTORY_QUOTA_BURST entries from one member caps at HISTORY_QUOTA_BURST!
    const quotaEntries = [];
    for (let i = 1; i <= HISTORY_QUOTA_BURST + 32; i++) {
      const body = { kind: 'message' as const, roomId, id: crypto.randomUUID(), deviceId: newcomerId.id, memberId: newcomerMember, text: `burst ${i}`, at: 5100 + i, visibility: 'room' as const, seq: i };
      quotaEntries.push({ body, signature: await newcomerAgent.sign(body) });
    }
    for (let i = 0; i < quotaEntries.length; i += 64) {
      await engine.acceptHistory(newcomerId.id, { kind: 'history', roomId, entries: quotaEntries.slice(i, i + 64) }, false);
    }
    const acceptedFromNewcomer = engine.messages.filter((m: SavedMessage) => m.packet.body.deviceId === newcomerId.id);
    expect(acceptedFromNewcomer).toHaveLength(HISTORY_QUOTA_BURST);

    // 8. End-to-end >128-message convergence (200 messages from one author across live BrowserPeers channel pair)!
    const convRoom = crypto.randomUUID();
    const sender = new BrowserPeers({} as never, convRoom, local.id, 's-send', () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => clock) as any;
    const receiver = new BrowserPeers({} as never, convRoom, hostId.id, 's-recv', () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => clock) as any;
    sender.fenced(await claimFence(`owner:${local.id}:${convRoom}`));
    receiver.fenced(await claimFence(`owner:${hostId.id}:${convRoom}`));
    await sender.load();
    await receiver.load();
    const convStatus: RoomStatus = {
      roomId: convRoom, title: 'Conv200', epoch: 'e1', hostOnline: true,
      deviceId: local.id, memberId: aliceMember, ownerId: hostMember,
      settings: { floor: 'humans-first', agentAssignmentsWake: false, guestAgentApproval: true, hostApprovesDevices: false, historyForNewcomers: true },
      members: [
        { id: hostMember, name: 'Host', role: 'human', joinedAt: 1000 },
        { id: aliceMember, name: 'Alice', role: 'human', joinedAt: 1000 },
      ],
      devices: [
        { id: hostId.id, publicKey: hostId.publicKey, label: 'Host', memberId: hostMember, admittedAt: 1000 },
        { id: local.id, publicKey: local.publicKey, label: 'Alice', memberId: aliceMember, admittedAt: 1000 },
      ],
    };
    sender.status = convStatus;
    receiver.status = { ...convStatus, deviceId: hostId.id, memberId: hostMember };

    // Pre-populate 200 signed messages from `hostId` on `sender` and let `receiver` sync them automatically over a paired channel!
    const twoHundred: SavedMessage[] = [];
    for (let i = 1; i <= 200; i++) {
      const body = { kind: 'message' as const, roomId: convRoom, id: crypto.randomUUID(), deviceId: hostId.id, memberId: hostMember, text: `hist-${i}`, at: 1000 + i, visibility: 'room' as const, seq: i };
      twoHundred.push({ packet: { body, signature: await hostAgent.sign(body) }, targets: [], receipts: [], receivedAt: 1000 + i });
    }
    sender.messages = twoHundred;

    const pair = makeChannelPair();
    const mkPeer = () => ({ pc: { connectionState: 'connected', iceConnectionState: 'connected', close() {} }, session: 'p', started: clock, sent: new Map(), resync: { sent() {}, request() {}, due: () => false } } as any);
    const pOnSender = mkPeer(), pOnReceiver = mkPeer();
    sender.peers.set(hostId.id, pOnSender);
    receiver.peers.set(local.id, pOnReceiver);
    sender.connectChannel(pOnSender, hostId.id, pair.a as any);
    receiver.connectChannel(pOnReceiver, local.id, pair.b as any);

    await waitFor(() => receiver.messages.length === 200, 6000);
    expect(receiver.messages.map((m: SavedMessage) => m.packet.body.seq)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));

    await sender.close();
    await receiver.close();
    await engine.close();
  });

  test('pairing sync with limiters ON: 300 x 3 KB agent messages (75+ chunks) AND >HISTORY_QUOTA_BURST + serve retryAfterMs recover to 100% convergence', async () => {
    installFakeIndexedDB();
    fakeStorage.records.clear();
    resetIdentityCache();

    const roomId = crypto.randomUUID();
    const local = await browserIdentity();
    const tmp = tempDir('mr-hist-3kb-');
    const hostAgent = new BrowserAgent(join(tmp, 'h'), 'https://rooms.example', roomId);
    const hostId = await hostAgent.ensureIdentity();
    const hostMember = crypto.randomUUID();
    const aliceMember = crypto.randomUUID();

    let clock = 10_000;
    const sender = new BrowserPeers({} as never, roomId, local.id, 's-send', () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => clock) as any;
    const receiver = new BrowserPeers({} as never, roomId, hostId.id, 's-recv', () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => clock) as any;
    sender.fenced(await claimFence(`owner:${local.id}:${roomId}`));
    receiver.fenced(await claimFence(`owner:${hostId.id}:${roomId}`));
    await sender.load();
    await receiver.load();

    const roomStatus: RoomStatus = {
      roomId, title: 'BusyAgentRoom', epoch: 'e1', hostOnline: true,
      deviceId: local.id, memberId: aliceMember, ownerId: hostMember,
      settings: { floor: 'open', agentAssignmentsWake: false, guestAgentApproval: false, hostApprovesDevices: false, historyForNewcomers: true },
      members: [
        { id: hostMember, name: 'Host', role: 'human', joinedAt: 1000 },
        { id: aliceMember, name: 'Alice', role: 'human', joinedAt: 1000 },
      ],
      devices: [
        { id: hostId.id, publicKey: hostId.publicKey, label: 'Host', memberId: hostMember, admittedAt: 1000 },
        { id: local.id, publicKey: local.publicKey, label: 'Alice', memberId: aliceMember, admittedAt: 1000 },
      ],
    };
    sender.status = roomStatus;
    receiver.status = { ...roomStatus, deviceId: hostId.id, memberId: hostMember };

    // Build 300 realistic 3 KB agent messages (forces ~75+ wire chunks across 5 rounds — previously broke at chunk 32!).
    const payload = 'x'.repeat(3000);
    const longMessages: SavedMessage[] = [];
    for (let i = 1; i <= 300; i++) {
      const body = { kind: 'message' as const, roomId, id: crypto.randomUUID(), deviceId: hostId.id, memberId: hostMember, text: `agent-${i} ${payload}`, at: 2000 + i, visibility: 'room' as const, seq: i };
      longMessages.push({ packet: { body, signature: await hostAgent.sign(body) }, targets: [], receipts: [], receivedAt: 2000 + i });
    }
    sender.messages = longMessages;

    const pair = makeChannelPair();
    const mkPeer = () => ({ pc: { connectionState: 'connected', iceConnectionState: 'connected', close() {} }, session: 'p', started: clock, sent: new Map(), resync: { sent() {}, request() {}, due: () => false } } as any);
    const pOnSender = mkPeer(), pOnReceiver = mkPeer();
    sender.peers.set(hostId.id, pOnSender);
    receiver.peers.set(local.id, pOnReceiver);
    sender.connectChannel(pOnSender, hostId.id, pair.a as any);
    receiver.connectChannel(pOnReceiver, local.id, pair.b as any);

    await waitFor(() => receiver.messages.length === 300, 10_000);
    // Confirm the sync genuinely spanned >32 chunks (old bug dropped chunks past 32!).
    const chunksSent = pair.a.sent.map(s => JSON.parse(s)).filter((p: any) => p.kind === 'history');
    expect(chunksSent.length).toBeGreaterThan(50);

    // Now test BOTH serve-rate-limit retryAfterMs recovery AND per-member quota drop recovery past HISTORY_QUOTA_BURST!
    // Exhaust sender's serve limiter & add 300 more messages (total 600 > HISTORY_QUOTA_BURST = 512 from one author!).
    for (let i = 301; i <= 600; i++) {
      const body = { kind: 'message' as const, roomId, id: crypto.randomUUID(), deviceId: hostId.id, memberId: hostMember, text: `extra-${i}`, at: 2000 + i, visibility: 'room' as const, seq: i };
      longMessages.push({ packet: { body, signature: await hostAgent.sign(body) }, targets: [], receipts: [], receivedAt: 2000 + i });
    }
    sender.messages = longMessages;
    // Drain sender's serve burst so the very first request triggers `retryAfterMs`!
    for (let i = 0; i < HISTORY_SERVE_BURST; i++) sender.historyServeLimiter.take(hostId.id);

    // Kick off a fresh sync request from receiver; advance fake clock + tick() until all 600 converge!
    receiver.requestSync(local.id);
    for (let step = 0; step < 30 && receiver.messages.length < 600; step++) {
      await Bun.sleep(25);
      clock += Math.max(QUOTA_QUIET_MS + 1000, 10_000);
      receiver.tick();
      sender.tick();
    }
    await waitFor(() => receiver.messages.length === 600, 10_000);
    expect(receiver.messages.length).toBe(600);

    // Verify `requestSync` during a pending `retryAfterMs` backoff does NOT cancel the retry or stall inside `maySendRetryHint`'s 1s window,
    // AND requester-side round timeout recovers even from a silent rate-limit drop or full SendQueue!
    for (let i = 601; i <= 700; i++) {
      const body = { kind: 'message' as const, roomId, id: crypto.randomUUID(), deviceId: hostId.id, memberId: hostMember, text: `burst-${i}`, at: 2000 + i, visibility: 'room' as const, seq: i };
      longMessages.push({ packet: { body, signature: await hostAgent.sign(body) }, targets: [], receipts: [], receivedAt: 2000 + i });
    }
    sender.messages = longMessages;
    // Drain sender's serve burst so the initial request returns a `retryAfterMs` hint and starts `maySendRetryHint`'s 1s quiet window.
    for (let i = 0; i < HISTORY_SERVE_BURST; i++) sender.historyServeLimiter.take(hostId.id);
    receiver.requestSync(local.id);
    await waitFor(() => receiver.historyRetryAt.has(local.id), 3000);
    // Trigger `requestSync` AGAIN immediately (<1s, simulating `quotaDrops.due()` or incoming-gate drain):
    // must keep `historyRetryAt` intact and NOT fire an early `history-have` into the quiet window!
    const havesBefore = pair.b.sent.filter(s => JSON.parse(s).kind === 'history-have').length;
    receiver.requestSync(local.id);
    expect(receiver.historyRetryAt.has(local.id)).toBe(true);
    expect(pair.b.sent.filter(s => JSON.parse(s).kind === 'history-have').length).toBe(havesBefore);
    // Advance clock past backoff & converge all 700 messages cleanly!
    for (let step = 0; step < 20 && receiver.messages.length < 700; step++) {
      await Bun.sleep(20);
      clock += 6_000;
      receiver.tick();
      sender.tick();
    }
    await waitFor(() => receiver.messages.length === 700, 10_000);
    expect(receiver.messages.length).toBe(700);

    // Silent drop recovery via requester-side round timeout (e.g. response lost or refused silently within 1s hint window):
    for (let i = 701; i <= 720; i++) {
      const body = { kind: 'message' as const, roomId, id: crypto.randomUUID(), deviceId: hostId.id, memberId: hostMember, text: `silent-${i}`, at: 2000 + i, visibility: 'room' as const, seq: i };
      longMessages.push({ packet: { body, signature: await hostAgent.sign(body) }, targets: [], receipts: [], receivedAt: 2000 + i });
    }
    sender.messages = longMessages;
    // Exhaust serve burst AND consume `maySendRetryHint` so the first request is dropped with NO retry hint at all!
    for (let i = 0; i < HISTORY_SERVE_BURST; i++) sender.historyServeLimiter.take(hostId.id);
    sender.historyServeLimiter.maySendRetryHint(hostId.id);
    receiver.requestSync(local.id);
    await Bun.sleep(40);
    expect(receiver.historyRetryAt.has(local.id)).toBe(false);
    expect(receiver.messages.length).toBe(700);
    // Advance clock past HISTORY_ROUND_TIMEOUT_MS -> requester retries automatically and converges to 720!
    for (let step = 0; step < 10 && receiver.messages.length < 720; step++) {
      clock += 6_000;
      receiver.tick();
      sender.tick();
      await Bun.sleep(25);
    }
    await waitFor(() => receiver.messages.length === 720, 5_000);
    expect(receiver.messages.length).toBe(720);

    // Unsolicited `retryAfterMs` hint when no request is in flight is ignored (schedules no retry & sends no history-have).
    expect(receiver.historyInFlight.has(local.id)).toBe(false);
    const havesBeforeUnsolicited = pair.b.sent.filter(s => JSON.parse(s).kind === 'history-have').length;
    await receiver.acceptHistory(local.id, { kind: 'history', roomId, entries: [], retryAfterMs: 250 }, false, pOnReceiver);
    expect(receiver.historyRetryAt.has(local.id)).toBe(false);
    clock += 1_000;
    receiver.tick();
    expect(pair.b.sent.filter(s => JSON.parse(s).kind === 'history-have').length).toBe(havesBeforeUnsolicited);

    // Verify full-window churn protection: once receiver is at MAX_STORED_MESSAGES (5,000),
    // receiving an older already-evicted entry does NOT trigger a storage write or loop!
    const fullMsgs: SavedMessage[] = [];
    for (let i = 1; i <= MAX_STORED_MESSAGES; i++) {
      const body = { kind: 'message' as const, roomId, id: crypto.randomUUID(), deviceId: hostId.id, memberId: hostMember, text: `w-${i}`, at: 100_000 + i, visibility: 'room' as const, seq: 1000 + i };
      fullMsgs.push({ packet: { body, signature: 's'.repeat(88) }, targets: [], receipts: [], receivedAt: 100_000 + i });
    }
    receiver.messages = fullMsgs;
    let putCalls = 0;
    const origPut = receiver.put.bind(receiver);
    receiver.put = async (...args: any[]) => { putCalls++; return origPut(...args); };
    const veryOldBody = { kind: 'message' as const, roomId, id: crypto.randomUUID(), deviceId: hostId.id, memberId: hostMember, text: 'already evicted', at: 500, visibility: 'room' as const, seq: 1 };
    const sentBefore = pair.b.sent.length;
    await receiver.acceptHistory(local.id, {
      kind: 'history',
      roomId,
      entries: [{ body: veryOldBody, signature: await hostAgent.sign(veryOldBody) }],
      more: true,
    }, false, pOnReceiver);
    expect(putCalls).toBe(0);
    expect(receiver.messages.length).toBe(MAX_STORED_MESSAGES);
    expect(pair.b.sent.length).toBe(sentBefore);

    await sender.close();
    await receiver.close();
  });

  test('cold bridge path (relayListenOnce) enforces history accept limiter and per-member history quota', async () => {
    const roomId = crypto.randomUUID();
    const tmp = tempDir('mr-hist-cold-');
    const hostAgent = new BrowserAgent(join(tmp, 'host'), 'https://rooms.example', roomId);
    const readerAgent = new BrowserAgent(join(tmp, 'reader'), 'https://rooms.example', roomId);
    const hostId = await hostAgent.ensureIdentity();
    const readerId = await readerAgent.ensureIdentity();
    const hostMember = crypto.randomUUID();
    const readerMember = crypto.randomUUID();

    const hostEnc = await hostAgent.encBinding();
    const readerEnc = await readerAgent.encBinding();
    const devices: RosterEntry[] = ([
      { id: hostId.id, sign: hostId.publicKey, enc: hostEnc.enc, encVersion: hostEnc.encVersion, encSig: hostEnc.encSig, memberId: hostMember, role: 'human' as const },
      { id: readerId.id, sign: readerId.publicKey, enc: readerEnc.enc, encVersion: readerEnc.encVersion, encSig: readerEnc.encSig, memberId: readerMember, role: 'agent' as const, wakeable: true as const },
    ] satisfies RosterEntry[]).sort((a, b) => a.id.localeCompare(b.id));
    const rosterBody: RosterBody = { v: 1, room: roomId, version: 1, prev: '', at: Date.now(), host: hostId.id, devices, removed: [] };
    const roster = await signRoster(rosterBody, v => hostAgent.sign(v));
    const status: RoomStatus = {
      roomId, title: 'Cold', epoch: 'e1', hostOnline: true, relayUrl: 'wss://relay.example/api/relay/v1',
      deviceId: readerId.id, memberId: readerMember, ownerId: hostMember, roster,
      settings: { floor: 'open', agentAssignmentsWake: false, guestAgentApproval: false, hostApprovesDevices: false, historyForNewcomers: true },
      members: [
        { id: hostMember, name: 'Host', role: 'human', joinedAt: 1000 },
        { id: readerMember, name: 'Reader', role: 'agent', joinedAt: 1000 },
      ],
      devices: [
        { id: hostId.id, publicKey: hostId.publicKey, label: 'Host', memberId: hostMember, admittedAt: 1000, enc: hostEnc.enc, encVersion: hostEnc.encVersion, encSig: hostEnc.encSig },
        { id: readerId.id, publicKey: readerId.publicKey, label: 'Reader', memberId: readerMember, admittedAt: 1000, enc: readerEnc.enc, encVersion: readerEnc.encVersion, encSig: readerEnc.encSig, wakeable: true },
      ],
    };

    // Pack HISTORY_QUOTA_BURST + 32 valid history entries using real `historyChunks` (<15 KB each) into the cold inbox!
    const total = HISTORY_QUOTA_BURST + 32;
    const allEntries = [];
    for (let i = 1; i <= total; i++) {
      const body = { kind: 'message' as const, roomId, id: crypto.randomUUID(), deviceId: hostId.id, memberId: hostMember, text: `cold-${i}`, at: 5000 + i, visibility: 'room' as const, seq: i };
      allEntries.push({ body, signature: await hostAgent.sign(body) });
    }
    const envelopes: { cursor: number; envelope: Awaited<ReturnType<typeof encryptRelayEnvelope>> }[] = [];
    for (const chunk of historyChunks(roomId, allEntries)) {
      const env = await encryptRelayEnvelope(chunk, {
        room: roomId, from: hostId.id, id: crypto.randomUUID(), seq: envelopes.length + 1,
        rosterVersion: 1, lane: 'primary', sign: v => hostAgent.sign(v),
        recipients: [devices.find(d => d.id === readerId.id)!],
      });
      envelopes.push({ cursor: envelopes.length + 1, envelope: env });
    }
    expect(total).toBeLessThan(HISTORY_ACCEPT_ENTRIES_BURST);

    // Stub command('status') + createRelayClient on readerAgent to exercise the real `relayListenOnce` loop.
    (readerAgent as any).command = async () => status;
    (readerAgent as any).createRelayClient = async () => ({
      getSealedState: async () => ({ state: null }),
      putSealedState: async () => {},
      drainOnce: async () => ({ frames: envelopes, carrier: 'https' as const }),
      sendOnce: async () => {},
      ackInboxCursor: async () => {},
      nextSeq: () => 1,
      stop: () => {},
    });

    await relayListenOnce(readerAgent, { waitSeconds: 0, now: () => 1_000_000 });
    // Per-member history quota MUST cap stored entries at HISTORY_QUOTA_BURST!
    expect(readerAgent.messages().length).toBe(HISTORY_QUOTA_BURST);
  });
});
