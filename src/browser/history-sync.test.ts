import { describe, expect, test } from 'bun:test';
import { addresses, evaluateWake, mayAgentSpeak } from '../collab';
import {
  analyzeHistory,
  buildHistoryHave,
  canonicalMessageKeys,
  currentAudienceUntil,
  entryDigest,
  HISTORY_CHUNK_CHARS,
  HISTORY_SERVE_BURST,
  historyChunks,
  isHistoryHavePacket,
  isHistoryPacket,
  MAX_MESSAGE_SEQ,
  MAX_SEQ_JUMP,
  mayServeMessage,
  mergeHistoryMessages,
  messageKey,
  nextAuthorSeq,
  PeerRateLimiter,
  selectHistoryEntries,
  storedCursorIndex,
  validMessageSeq,
  withinSeqJump,
  type HistoryCursor,
  type HistoryStoredMessage,
} from './history-sync';
import type { RoomStatus } from './protocol';
import { HISTORY_QUOTA_BURST, HISTORY_QUOTA_PER_MINUTE, ReceiveQuota } from './quota';
import type { SignedRoster } from './relay-crypto';
import { addRetractions, applyRetractions, retractedStub, type RetractBody } from './retractions';

const ROOM = '11111111-1111-4111-8111-111111111111';
const DEV_A = 'a'.repeat(64);
const DEV_B = 'b'.repeat(64);
const DEV_B_PHONE = 'c'.repeat(64);
const DEV_C = 'd'.repeat(64);
const DEV_OUTSIDER = 'e'.repeat(64);

const MEM_A = '22222222-2222-4222-8222-222222222222';
const MEM_B = '33333333-3333-4333-8333-333333333333';
const MEM_C = '44444444-4444-4444-8444-444444444444';

function makeMsg(overrides: {
  id?: string;
  deviceId?: string;
  memberId?: string;
  text?: string;
  at?: number;
  visibility?: 'members' | 'room';
  seq?: number;
  audienceUntil?: number;
  receivedAt?: number;
  replicated?: true;
  retracted?: true;
} = {}): HistoryStoredMessage {
  const m: HistoryStoredMessage = {
    packet: {
      body: {
        kind: 'message',
        roomId: ROOM,
        id: overrides.id ?? crypto.randomUUID(),
        deviceId: overrides.deviceId ?? DEV_A,
        memberId: overrides.memberId ?? MEM_A,
        text: overrides.text ?? 'hello',
        at: overrides.at ?? 1000,
        ...(overrides.visibility !== undefined ? { visibility: overrides.visibility } : {}),
        ...(overrides.seq !== undefined ? { seq: overrides.seq } : {}),
        ...(overrides.audienceUntil !== undefined ? { audienceUntil: overrides.audienceUntil } : {}),
      },
      signature: 's'.repeat(88),
    },
    targets: [],
    receipts: [],
    ...(overrides.receivedAt !== undefined ? { receivedAt: overrides.receivedAt } : {}),
    ...(overrides.replicated ? { replicated: true } : {}),
  };
  return overrides.retracted ? retractedStub(m) : m;
}

const roomStatus: Pick<RoomStatus, 'devices' | 'members'> = {
  members: [
    { id: MEM_A, name: 'Alice', role: 'human', joinedAt: 1000 },
    { id: MEM_B, name: 'Bob', role: 'human', joinedAt: 1500 },
    { id: MEM_C, name: 'Carol', role: 'human', joinedAt: 5000 },
  ],
  devices: [
    { id: DEV_A, publicKey: 'k'.repeat(88), label: 'Alice Desktop', memberId: MEM_A, admittedAt: 1000 },
    { id: DEV_B, publicKey: 'k'.repeat(88), label: 'Bob Desktop', memberId: MEM_B, admittedAt: 1500 },
    // Bob paired his phone later (at 6000), AFTER Carol joined (at 5000), but Bob's member.joinedAt is still 1500!
    { id: DEV_B_PHONE, publicKey: 'k'.repeat(88), label: 'Bob Phone', memberId: MEM_B, admittedAt: 6000 },
    { id: DEV_C, publicKey: 'k'.repeat(88), label: 'Carol Browser', memberId: MEM_C, admittedAt: 5000 },
  ],
};

describe('history-sync visibility and authorization', () => {
  test('newcomer receives only room entries; linked companion device receives its member earlier members entries', () => {
    const membersEarly = makeMsg({ text: 'members before carol', at: 2000, receivedAt: 2000, visibility: 'members', seq: 1, audienceUntil: 1500 });
    const legacyEarly = makeMsg({ text: 'legacy before carol', at: 2100, receivedAt: 2100 });
    const roomEarly = makeMsg({ text: 'public room history', at: 2200, receivedAt: 2200, visibility: 'room', seq: 2 });
    const membersAfterCarol = makeMsg({ text: 'after carol joined', at: 5500, receivedAt: 5500, visibility: 'members', seq: 3, audienceUntil: 5000 });
    const deleted = makeMsg({ text: 'secret deleted', at: 2300, receivedAt: 2300, visibility: 'room', seq: 4, retracted: true });

    // Carol (newcomer at 5000) gets ONLY roomEarly and membersAfterCarol — never membersEarly, legacyEarly, or deleted stub.
    expect(mayServeMessage(membersEarly, DEV_C, roomStatus, MEM_A)).toBe(false);
    expect(mayServeMessage(legacyEarly, DEV_C, roomStatus, MEM_A)).toBe(false);
    expect(mayServeMessage(roomEarly, DEV_C, roomStatus, MEM_A)).toBe(true);
    expect(mayServeMessage(membersAfterCarol, DEV_C, roomStatus, MEM_A)).toBe(true);
    expect(mayServeMessage(deleted, DEV_C, roomStatus, MEM_A)).toBe(false);

    // Bob's phone (admitted at 6000, member.joinedAt = 1500) gets ALL non-retracted messages from >= 1500!
    expect(mayServeMessage(membersEarly, DEV_B_PHONE, roomStatus, MEM_A)).toBe(true);
    expect(mayServeMessage(legacyEarly, DEV_B_PHONE, roomStatus, MEM_A)).toBe(true);
    expect(mayServeMessage(roomEarly, DEV_B_PHONE, roomStatus, MEM_A)).toBe(true);
    expect(mayServeMessage(membersAfterCarol, DEV_B_PHONE, roomStatus, MEM_A)).toBe(true);
    expect(mayServeMessage(deleted, DEV_B_PHONE, roomStatus, MEM_A)).toBe(false);

    // Unadmitted outsider gets nothing.
    expect(mayServeMessage(roomEarly, DEV_OUTSIDER, roomStatus, MEM_A)).toBe(false);
  });

  test('delayed delivery across a join never leaks members messages (both signed audienceUntil and legacy fallback)', () => {
    // Alice sends at t=2000 while only Alice (1000) and Bob (1500) are in the room.
    // Carol joins at t=5000; Bob's offline device receives Alice's message late via outbox resend at t=6000.
    const statusBeforeCarol: Pick<RoomStatus, 'devices' | 'members'> = {
      members: roomStatus.members!.slice(0, 2),
      devices: roomStatus.devices!.slice(0, 2),
    };
    const audienceUntil = currentAudienceUntil(statusBeforeCarol);
    expect(audienceUntil).toBe(1500);

    const signedAudienceLate = makeMsg({ at: 2000, receivedAt: 6000, visibility: 'members', seq: 1, audienceUntil });
    expect(mayServeMessage(signedAudienceLate, DEV_C, roomStatus, MEM_B)).toBe(false);
    expect(mayServeMessage(signedAudienceLate, DEV_B_PHONE, roomStatus, MEM_B)).toBe(true);

    // Even for an older message without `audienceUntil`, receipt time is bounded by `body.at` so delayed delivery never leaks to Carol.
    const legacyLate = makeMsg({ at: 2000, receivedAt: 6000, visibility: 'members', seq: 2 });
    expect(mayServeMessage(legacyLate, DEV_C, roomStatus, MEM_B)).toBe(false);
    expect(mayServeMessage(legacyLate, DEV_B_PHONE, roomStatus, MEM_B)).toBe(true);

    // Signed `audienceUntil` is immune to client clock skew: even if Alice's and Bob's local clocks are slow (at=50, receivedAt=50),
    // Bob (joinedAt=1500 <= audienceUntil=1500) still qualifies while Carol (5000) does not!
    const slowClock = makeMsg({ at: 50, receivedAt: 50, visibility: 'members', seq: 3, audienceUntil: 1500 });
    expect(mayServeMessage(slowClock, DEV_B_PHONE, roomStatus, MEM_A)).toBe(true);
    expect(mayServeMessage(slowClock, DEV_C, roomStatus, MEM_A)).toBe(false);
  });

  test('uses serving peer receipt time against skewed future author clocks, prevents multi-hop leaks, and enforces verifiedRoster device-to-member mapping', () => {
    // Author future-dated `at` to 9999 (after Carol joined at 5000), but serving peer received it live at 2000!
    const skewedFuture = makeMsg({ at: 9999, receivedAt: 2000, visibility: 'members', seq: 1 });
    expect(mayServeMessage(skewedFuture, DEV_C, roomStatus, MEM_A)).toBe(false);
    expect(mayServeMessage(skewedFuture, DEV_B_PHONE, roomStatus, MEM_A)).toBe(true);

    // Bob's phone received a members-only entry via history replication at 6000 (`replicated: true`).
    // Bob's phone MUST NOT leak it to Carol (joinedAt 5000 <= 6000), while still serving it to Bob's own devices!
    const replicatedOnPhone = makeMsg({ at: 2000, receivedAt: 6000, visibility: 'members', seq: 1, replicated: true });
    expect(mayServeMessage(replicatedOnPhone, DEV_C, roomStatus, MEM_B)).toBe(false);
    expect(mayServeMessage(replicatedOnPhone, DEV_B, roomStatus, MEM_B)).toBe(true);

    // Replicated `room` entries remain servable to everyone.
    const replicatedRoom = makeMsg({ at: 2000, receivedAt: 6000, visibility: 'room', seq: 2, replicated: true });
    expect(mayServeMessage(replicatedRoom, DEV_C, roomStatus, MEM_B)).toBe(true);

    // Host-signed verifiedRoster prevents a tampered `status.devices` from mapping Carol's device to Bob's older memberId!
    const tamperedStatus: Pick<RoomStatus, 'devices' | 'members'> = {
      members: roomStatus.members,
      devices: roomStatus.devices!.map(d => d.id === DEV_C ? { ...d, memberId: MEM_B } : d),
    };
    const hostRoster: SignedRoster = {
      body: {
        v: 1, room: ROOM, version: 1, prev: '', at: 5000, host: DEV_A, removed: [],
        devices: [
          { id: DEV_A, sign: 'k'.repeat(88), enc: 'e'.repeat(88), encVersion: 1, encSig: 's'.repeat(88), memberId: MEM_A, role: 'human' },
          { id: DEV_C, sign: 'k'.repeat(88), enc: 'e'.repeat(88), encVersion: 1, encSig: 's'.repeat(88), memberId: MEM_C, role: 'human' },
        ],
      },
      signature: 's'.repeat(88),
    };
    const membersEarly = makeMsg({ at: 2000, receivedAt: 2000, visibility: 'members', seq: 1, audienceUntil: 1500 });
    expect(mayServeMessage(membersEarly, DEV_C, tamperedStatus, MEM_A, hostRoster)).toBe(false);
  });
});

describe('history-sync vector analysis, equivocation, gaps, DoS safety, and convergence', () => {
  test('computes contiguous vector, coalesced sparse ranges, gap ranges, and stops advancing past equivocation', () => {
    const m1 = makeMsg({ deviceId: DEV_A, seq: 1, at: 2100, receivedAt: 2100 });
    const m2a = makeMsg({ deviceId: DEV_A, seq: 2, at: 2200, receivedAt: 2200, text: 'version A' });
    const m2b = makeMsg({ deviceId: DEV_A, seq: 2, at: 2201, receivedAt: 2201, text: 'version B' });
    const m3 = makeMsg({ deviceId: DEV_A, seq: 3, at: 2300, receivedAt: 2300 });
    // Device B has seq 1 and seq 3..4 (missing seq 2 = gap!)
    const b1 = makeMsg({ deviceId: DEV_B, memberId: MEM_B, seq: 1, at: 2150, receivedAt: 2150 });
    const b3 = makeMsg({ deviceId: DEV_B, memberId: MEM_B, seq: 3, at: 2350, receivedAt: 2350 });
    const b4 = makeMsg({ deviceId: DEV_B, memberId: MEM_B, seq: 4, at: 2360, receivedAt: 2360 });

    const analysis = analyzeHistory([m1, m2a, m2b, m3, b1, b3, b4]);
    expect(analysis.equivocatingDevices.has(DEV_A)).toBe(true);
    expect(analysis.equivocatingDevices.has(DEV_B)).toBe(false);
    expect(analysis.equivocatingMessageIds.has(m2a.packet.body.id)).toBe(true);
    expect(analysis.equivocatingMessageIds.has(m2b.packet.body.id)).toBe(true);
    expect(analysis.firstConflictSeq.get(DEV_A)).toBe(2);
    // Vector for DEV_A stops at 1 (before conflict at 2)!
    expect(analysis.vector[DEV_A]).toBe(1);
    expect(analysis.haveSeqs[DEV_A]).toEqual([[3, 3]]);
    // Vector for DEV_B stops at 1 (before gap at 2), sparse coalesces [3, 4], gap is [2, 2]!
    expect(analysis.vector[DEV_B]).toBe(1);
    expect(analysis.haveSeqs[DEV_B]).toEqual([[3, 4]]);
    expect(analysis.gapsByDevice.get(DEV_B)).toEqual([[2, 2]]);
    expect(analysis.hasGaps).toBe(true);

    // Peers forward BOTH equivocating entries even when a peer only saw one side (`m2a`) and advanced its vector to 3!
    const peerHave = buildHistoryHave(ROOM, [m1, m2a, m3]);
    expect(peerHave.vector[DEV_A]).toBe(3);
    const forUnawarePeer = selectHistoryEntries([m1, m2a, m2b, m3], peerHave, DEV_B_PHONE, roomStatus, MEM_A);
    expect(forUnawarePeer.entries.map(e => e.body.id).sort()).toEqual([m2a.packet.body.id, m2b.packet.body.id].sort());

    // Once that peer holds both conflicting entries, its `conflictIds` prevent resending them!
    const awareHave = buildHistoryHave(ROOM, [m1, m2a, m2b, m3]);
    expect(selectHistoryEntries([m1, m2a, m2b, m3], awareHave, DEV_B_PHONE, roomStatus, MEM_A).entries).toEqual([]);

    // When requester only has m1 (vector 1), peer sends m3, m2b, m2a!
    const newcomerHave = buildHistoryHave(ROOM, [m1]);
    const selected = selectHistoryEntries([m1, m2a, m2b, m3], newcomerHave, DEV_B_PHONE, roomStatus, MEM_A);
    const ids = selected.entries.map(e => e.body.id);
    expect(ids).toContain(m2a.packet.body.id);
    expect(ids).toContain(m2b.packet.body.id);
    expect(ids).toContain(m3.packet.body.id);
    expect(ids).not.toContain(m1.packet.body.id);
  });

  test('huge seq (1e9) is rejected by validators and analyzeHistory stays O(N) with range gaps even on pre-existing huge seq', () => {
    expect(validMessageSeq(1e9)).toBe(false);
    expect(validMessageSeq(MAX_MESSAGE_SEQ + 1)).toBe(false);
    expect(validMessageSeq(MAX_MESSAGE_SEQ)).toBe(true);
    expect(withinSeqJump(10 + MAX_SEQ_JUMP, 10)).toBe(true);
    expect(withinSeqJump(10 + MAX_SEQ_JUMP + 1, 10)).toBe(false);
    expect(withinSeqJump(1e9, 0)).toBe(false);

    // Even if a persisted log already held a huge seq, analyzeHistory never loops 1..maxSeq!
    const huge = makeMsg({ deviceId: DEV_A, seq: 1e9, at: 2000 });
    const start = performance.now();
    const analysis = analyzeHistory([huge]);
    expect(performance.now() - start).toBeLessThan(50);
    expect(analysis.gapsByDevice.get(DEV_A)).toEqual([[1, 999_999_999]]);
    expect(analysis.hasGaps).toBe(true);
  });

  test('author with >128 messages (200 seqs) converges completely without stalling or re-shipping', () => {
    const serverMsgs = Array.from({ length: 200 }, (_, i) =>
      makeMsg({ deviceId: DEV_A, seq: i + 1, at: 2000 + i, receivedAt: 2000 + i, visibility: 'room', text: `msg ${i + 1}` }),
    );
    let clientMsgs: HistoryStoredMessage[] = [];
    let rounds = 0;
    let totalSent = 0;

    while (rounds < 10) {
      const have = buildHistoryHave(ROOM, clientMsgs);
      expect(isHistoryHavePacket(have, ROOM)).toBe(true);
      const { entries, more } = selectHistoryEntries(serverMsgs, have, DEV_C, roomStatus, MEM_A);
      rounds++;
      totalSent += entries.length;
      const { messages, added } = mergeHistoryMessages(
        clientMsgs,
        entries.map(packet => ({ packet, targets: [], receipts: [], receivedAt: 6000, replicated: true as const })),
      );
      expect(added.length).toBe(entries.length); // Zero duplicate re-ships!
      clientMsgs = messages;
      if (!more) break;
    }

    expect(rounds).toBe(4); // 64 + 64 + 64 + 8 = 200!
    expect(totalSent).toBe(200);
    expect(clientMsgs).toHaveLength(200);
    expect(clientMsgs.map(m => m.packet.body.seq)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    // Final history-have advertises vector 200 with zero sparse ranges!
    const finalHave = buildHistoryHave(ROOM, clientMsgs);
    expect(finalHave.vector[DEV_A]).toBe(200);
    expect(finalHave.haveSeqs).toBeUndefined();
    expect(selectHistoryEntries(serverMsgs, finalHave, DEV_C, roomStatus, MEM_A).entries).toEqual([]);
  });

  test('selects newest-first, paginates cleanly with `more`, and excludes already-held legacy digests keyed by (deviceId, id)', () => {
    const legacy1 = makeMsg({ at: 1600, receivedAt: 1600 });
    const legacy2 = makeMsg({ at: 1700, receivedAt: 1700 });
    const seq1 = makeMsg({ seq: 1, at: 1800, receivedAt: 1800, visibility: 'room' });
    const seq2 = makeMsg({ seq: 2, at: 1900, receivedAt: 1900, visibility: 'room' });
    const seq3 = makeMsg({ seq: 3, at: 2000, receivedAt: 2000, visibility: 'room' });

    const all = [legacy1, legacy2, seq1, seq2, seq3];
    const emptyHave = buildHistoryHave(ROOM, []);
    const page1 = selectHistoryEntries(all, emptyHave, DEV_B_PHONE, roomStatus, MEM_A, 2);
    expect(page1.more).toBe(true);
    expect(page1.entries.map(e => e.body.id)).toEqual([seq3.packet.body.id, seq2.packet.body.id]);

    // After applying page 1, requester's updated history-have carries coalesced range [[2, 3]], so page 2 returns seq1 & legacy2!
    const have2 = buildHistoryHave(ROOM, [seq2, seq3]);
    expect(have2.haveSeqs?.[DEV_A]).toEqual([[2, 3]]);
    const page2 = selectHistoryEntries(all, have2, DEV_B_PHONE, roomStatus, MEM_A, 2);
    expect(page2.more).toBe(true);
    expect(page2.entries.map(e => e.body.id)).toEqual([seq1.packet.body.id, legacy2.packet.body.id]);

    // After applying page 2, requester has vector[DEV_A]=3 and legacy2 digest, so page 3 returns ONLY legacy1 with more=false!
    const have3 = buildHistoryHave(ROOM, [seq1, seq2, seq3, legacy2]);
    expect(have3.vector[DEV_A]).toBe(3);
    expect(have3.legacyIds).toContain(entryDigest(DEV_A, legacy2.packet.body.id));
    // Another device using the exact same chosen ID gets a completely distinct digest and cannot shadow Alice's legacy message!
    expect(entryDigest(DEV_B, legacy2.packet.body.id)).not.toBe(entryDigest(DEV_A, legacy2.packet.body.id));
    const page3 = selectHistoryEntries(all, have3, DEV_B_PHONE, roomStatus, MEM_A, 2);
    expect(page3.more).toBe(false);
    expect(page3.entries.map(e => e.body.id)).toEqual([legacy1.packet.body.id]);
  });

  test('buildHistoryHave stays strictly under HISTORY_CHUNK_CHARS even with maxed vectors, sparse ranges, conflicts, and legacy IDs', () => {
    const msgs: HistoryStoredMessage[] = [];
    for (let d = 0; d < 256; d++) {
      const dev = d.toString(16).padStart(64, '0');
      msgs.push(makeMsg({ deviceId: dev, seq: 1, at: 1000 + d }));
      msgs.push(makeMsg({ deviceId: dev, seq: 3, at: 2000 + d }));
      msgs.push(makeMsg({ deviceId: dev, seq: 5, at: 3000 + d }));
    }
    for (let c = 0; c < 150; c++) {
      msgs.push(makeMsg({ deviceId: DEV_A, seq: 10 + c, at: 4000 + c, text: 'a' }));
      msgs.push(makeMsg({ deviceId: DEV_A, seq: 10 + c, at: 4000 + c, text: 'b' }));
    }
    for (let l = 0; l < 600; l++) {
      msgs.push(makeMsg({ deviceId: DEV_B, at: 5000 + l }));
    }
    const have = buildHistoryHave(ROOM, msgs);
    expect(JSON.stringify(have).length).toBeLessThanOrEqual(HISTORY_CHUNK_CHARS);
    expect(isHistoryHavePacket(have, ROOM)).toBe(true);
  });

  test('chunks stay under HISTORY_CHUNK_CHARS and packets validate strictly', () => {
    const bigEntries = Array.from({ length: 12 }, (_, i) =>
      makeMsg({ seq: i + 1, at: 2000 + i, text: 'x'.repeat(2500), visibility: 'room' }).packet,
    );
    const chunks = historyChunks(ROOM, bigEntries, true);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length; i++) {
      expect(isHistoryPacket(chunks[i], ROOM)).toBe(true);
      expect(JSON.stringify(chunks[i]).length).toBeLessThanOrEqual(HISTORY_CHUNK_CHARS + 200);
      expect(chunks[i].more).toBe(i === chunks.length - 1 ? true : undefined);
    }

    expect(isHistoryHavePacket(buildHistoryHave(ROOM, []), ROOM)).toBe(true);
    expect(isHistoryHavePacket({ kind: 'history-have', roomId: ROOM, vector: { 'bad-key': 1 } }, ROOM)).toBe(false);
    expect(isHistoryHavePacket({ kind: 'history-have', roomId: ROOM, vector: { [DEV_A]: 1e9 } }, ROOM)).toBe(false);
    expect(isHistoryHavePacket({ kind: 'history-have', roomId: ROOM, vector: {}, haveSeqs: { [DEV_A]: [[5, 3]] } }, ROOM)).toBe(false);
    expect(isHistoryHavePacket({ kind: 'history-have', roomId: 'other', vector: {} }, ROOM)).toBe(false);
    expect(isHistoryPacket({ kind: 'history', roomId: ROOM, entries: 'nope' }, ROOM)).toBe(false);
  });

  test('ID squatting: deduplication keys by (deviceId, id), flags collidingMessageIds, and retractions target only the matching member', () => {
    const sharedId = crypto.randomUUID();
    const squatted = makeMsg({ id: sharedId, deviceId: DEV_B, memberId: MEM_B, seq: 1, at: 1900, text: 'squatted fake' });
    const real = makeMsg({ id: sharedId, deviceId: DEV_A, memberId: MEM_A, seq: 1, at: 2000, text: 'real message' });

    const { messages, added } = mergeHistoryMessages([squatted], [real]);
    expect(added).toHaveLength(1);
    expect(messages).toHaveLength(2);
    expect(analyzeHistory(messages).collidingMessageIds.has(sharedId)).toBe(true);

    // Bob retracts his squatted copy -> only Bob's copy becomes a stub; Alice's real message stays live!
    const bobRetract = { body: { kind: 'retract' as const, roomId: ROOM, id: crypto.randomUUID(), deviceId: DEV_B, memberId: MEM_B, at: 2100, target: sharedId }, signature: 's'.repeat(88) };
    const { log } = addRetractions([], [bobRetract], messages);
    expect(log).toHaveLength(1);
    const applied = applyRetractions(messages, log.map(op => op.body));
    const bobCopy = applied.messages.find(m => m.packet.body.deviceId === DEV_B)!;
    const aliceCopy = applied.messages.find(m => m.packet.body.deviceId === DEV_A)!;
    expect(bobCopy.retracted).toBe(true);
    expect(aliceCopy.retracted).toBeUndefined();
    expect(aliceCopy.packet.body.text).toBe('real message');

    // Alice can still retract her own copy even when Bob's copy sits later in `messages`!
    const aliceRetract = { body: { kind: 'retract' as const, roomId: ROOM, id: crypto.randomUUID(), deviceId: DEV_A, memberId: MEM_A, at: 2200, target: sharedId }, signature: 's'.repeat(88) };
    const { log: log2 } = addRetractions([], [aliceRetract], [real, squatted]);
    expect(log2).toHaveLength(1);
  });

  test('mergeHistoryMessages never reorders live messages, preserving positional agent cursors even under slow author clocks or future outliers', () => {
    const m1 = makeMsg({ deviceId: DEV_A, seq: 1, at: 1000, text: 'earlier live' });
    const cursorMsg = makeMsg({ deviceId: DEV_A, seq: 2, at: 5000, text: 'cursor message' });
    // Arrived live AFTER cursorMsg, but author's clock ran slow (at=4000 < 5000)!
    const slowLive = makeMsg({ deviceId: DEV_B, memberId: MEM_B, seq: 1, at: 4000, text: '@Agent please check this' });
    const replicatedOld = makeMsg({ deviceId: DEV_A, seq: 3, at: 2000, text: 'replicated old', replicated: true });

    const { messages: merged } = mergeHistoryMessages([m1, cursorMsg, slowLive], [replicatedOld]);
    const ids = merged.map(m => m.packet.body.id);
    // Relative order of existing live messages MUST NOT change!
    expect(ids.indexOf(cursorMsg.packet.body.id)).toBeLessThan(ids.indexOf(slowLive.packet.body.id));
    expect(ids).toEqual([m1.packet.body.id, replicatedOld.packet.body.id, cursorMsg.packet.body.id, slowLive.packet.body.id]);

    // Agent evaluating wake from `after: cursorMsg.id` STILL wakes for `slowLive`!
    const agentId = MEM_C;
    const roomView = {
      floor: 'humans-first' as const,
      participants: [
        { id: MEM_A, role: 'human' as const },
        { id: MEM_B, role: 'human' as const },
        { id: agentId, role: 'agent' as const },
      ],
      messages: merged.map(m => ({
        id: m.packet.body.id,
        authorId: m.packet.body.memberId,
        author: m.packet.body.memberId === MEM_A ? 'Alice' : 'Bob',
        role: 'human' as const,
        text: m.packet.body.text,
        time: new Date(m.packet.body.at).toISOString(),
        ...(m.packet.body.text.includes('@Agent') ? { mentions: [agentId] } : {}),
      })),
    };
    const woke = evaluateWake(roomView, agentId, cursorMsg.packet.body.id, 0);
    expect(woke.state).toBe('addressed');
    expect(woke.addressed).toEqual([slowLive.packet.body.id]);

    // An earlier future-clock outlier does not pull later replicated messages before `cursorMsg`!
    const outlier = makeMsg({ deviceId: DEV_B, memberId: MEM_B, seq: 2, at: 999_999, text: 'future clock' });
    const missedMention = makeMsg({ deviceId: DEV_A, seq: 4, at: 5500, text: '@Agent missed while offline', replicated: true });
    const { messages: merged2 } = mergeHistoryMessages([outlier, cursorMsg], [missedMention]);
    expect(merged2.map(m => m.packet.body.id)).toEqual([outlier.packet.body.id, cursorMsg.packet.body.id, missedMention.packet.body.id]);
  });

  test('PeerRateLimiter and ReceiveQuota history bucket bound floods deterministically', () => {
    let clock = 0;
    const limiter = new PeerRateLimiter(() => clock, 30, HISTORY_SERVE_BURST);
    for (let i = 0; i < HISTORY_SERVE_BURST; i++) expect(limiter.take(DEV_B)).toBe(true);
    expect(limiter.take(DEV_B)).toBe(false);
    // Refills 1 token every 2 seconds (30/min).
    clock += 2000;
    expect(limiter.take(DEV_B)).toBe(true);
    expect(limiter.take(DEV_B)).toBe(false);

    const quota = new ReceiveQuota(() => clock);
    for (let i = 0; i < HISTORY_QUOTA_BURST; i++) expect(quota.take(MEM_A, 'history')).toBe(true);
    expect(quota.take(MEM_A, 'history')).toBe(false);
    // Live message quota remains independent; history refills at HISTORY_QUOTA_PER_MINUTE (600/min = 1 per 100ms).
    expect(quota.take(MEM_A, 'message')).toBe(true);
    clock += Math.ceil(60_000 / HISTORY_QUOTA_PER_MINUTE);
    expect(quota.take(MEM_A, 'history')).toBe(true);
    expect(quota.take(MEM_A, 'history')).toBe(false);

    // Entry-counted PeerRateLimiter charges cost = entries.length and reports retryAfterMs with throttled hints.
    const entryLimiter = new PeerRateLimiter(() => clock, 600, 128);
    expect(entryLimiter.take(DEV_B, 64)).toBe(true);
    expect(entryLimiter.take(DEV_B, 64)).toBe(true);
    expect(entryLimiter.take(DEV_B, 64)).toBe(false);
    expect(entryLimiter.retryAfterMs(DEV_B, 64)).toBeGreaterThanOrEqual(6000);
    expect(entryLimiter.maySendRetryHint(DEV_B, 1000)).toBe(true);
    expect(entryLimiter.maySendRetryHint(DEV_B, 1000)).toBe(false);
    clock += 1000;
    expect(entryLimiter.maySendRetryHint(DEV_B, 1000)).toBe(true);
  });

  test('server-side pagination cursor converges >64 disjoint ranges (2,000 odd seqs), far-future at stall attacks, >128 conflicts, and >512 legacy entries with zero re-ships', () => {
    const runCursorSync = (serverHeld: HistoryStoredMessage[], requesterDev: string, requesterStatus: Pick<RoomStatus, 'devices' | 'members'>) => {
      let receiverHeld: HistoryStoredMessage[] = [];
      let cursor: HistoryCursor | undefined;
      let rounds = 0;
      const seenKeys = new Set<string>();
      let duplicatesSent = 0;
      while (rounds < 200) {
        const have = buildHistoryHave(ROOM, receiverHeld, { cursor });
        expect(isHistoryHavePacket(have, ROOM)).toBe(true);
        const { entries, more, nextCursor } = selectHistoryEntries(serverHeld, have, requesterDev, requesterStatus, MEM_A);
        rounds++;
        for (const e of entries) {
          const k = messageKey(e.body.deviceId, e.body.id);
          if (seenKeys.has(k)) duplicatesSent++;
          seenKeys.add(k);
        }
        const incoming = entries.map(packet => ({ packet, targets: [], receipts: [], receivedAt: 99_999, replicated: true as const }));
        receiverHeld = mergeHistoryMessages(receiverHeld, incoming).messages;
        if (!more) break;
        expect(nextCursor).toBeDefined();
        cursor = nextCursor;
      }
      return { receiverHeld, rounds, duplicatesSent };
    };

    // 1. 2,000 odd-seq messages (> MAX_SPARSE_RANGES_PER_DEVICE = 64 disjoint ranges!).
    const oddMsgs: HistoryStoredMessage[] = [];
    for (let i = 0; i < 2000; i++) {
      oddMsgs.push(makeMsg({ deviceId: DEV_A, memberId: MEM_A, seq: i * 2 + 1, at: 1000 + i, receivedAt: 1000 + i, visibility: 'room' }));
    }
    const oddSync = runCursorSync(oddMsgs, DEV_C, roomStatus);
    expect(oddSync.receiverHeld).toHaveLength(2000);
    expect(oddSync.duplicatesSent).toBe(0);

    // 2. Malicious member signs 130 disjoint seqs with far-future `at = 4_000_000_000_000`:
    //    honest messages are NEVER starved and sync finishes cleanly!
    const attackHeld: HistoryStoredMessage[] = [];
    for (let i = 0; i < 130; i++) {
      attackHeld.push(makeMsg({ deviceId: DEV_B, memberId: MEM_B, seq: i * 2 + 1, at: 4_000_000_000_000 + i, receivedAt: 5000 + i, visibility: 'room', text: `attack-${i}` }));
    }
    for (let i = 1; i <= 20; i++) {
      attackHeld.push(makeMsg({ deviceId: DEV_A, memberId: MEM_A, seq: i, at: 2000 + i, receivedAt: 2000 + i, visibility: 'room', text: `honest-${i}` }));
    }
    const attackSync = runCursorSync(attackHeld, DEV_C, roomStatus);
    expect(attackSync.receiverHeld).toHaveLength(150);
    expect(attackSync.duplicatesSent).toBe(0);
    expect(attackSync.receiverHeld.filter(m => m.packet.body.deviceId === DEV_A)).toHaveLength(20);

    // 3. >128 equivocation conflicts (150 conflicting seqs = 300 entries).
    const conflictMsgs: HistoryStoredMessage[] = [];
    for (let seq = 1; seq <= 150; seq++) {
      conflictMsgs.push(makeMsg({ deviceId: DEV_A, memberId: MEM_A, seq, at: 1000 + seq, receivedAt: 1000 + seq, visibility: 'room', text: `A-${seq}` }));
      conflictMsgs.push(makeMsg({ deviceId: DEV_A, memberId: MEM_A, seq, at: 1000 + seq, receivedAt: 1000 + seq, visibility: 'room', text: `B-${seq}` }));
    }
    const conflictSync = runCursorSync(conflictMsgs, DEV_C, roomStatus);
    expect(conflictSync.receiverHeld).toHaveLength(300);
    expect(conflictSync.duplicatesSent).toBe(0);

    // 4. >512 legacy (seq-less) messages (600 entries) synced to same-member companion device (`DEV_B_PHONE`).
    const legacyMsgs: HistoryStoredMessage[] = [];
    for (let i = 0; i < 600; i++) {
      legacyMsgs.push(makeMsg({ deviceId: DEV_B, memberId: MEM_B, seq: undefined, at: 1000 + i, receivedAt: 1000 + i, visibility: 'members', text: `legacy-${i}` }));
    }
    const legacySync = runCursorSync(legacyMsgs, DEV_B_PHONE, roomStatus);
    expect(legacySync.receiverHeld).toHaveLength(600);
    expect(legacySync.duplicatesSent).toBe(0);
  });

  test('colliding IDs: first-seen canonical resolution protects agent cursors, replyTo wakes/speak, and retraction op ID squatting', () => {
    const sharedId = crypto.randomUUID();
    const agentId = MEM_C;
    const aliceOriginal = makeMsg({ id: sharedId, deviceId: DEV_A, memberId: MEM_A, seq: 1, at: 2000, receivedAt: 2000, text: '@Agent original question' });
    const honestMid = makeMsg({ deviceId: DEV_A, memberId: MEM_A, seq: 2, at: 2500, receivedAt: 2500, text: '@Agent second question' });
    // Backdated colliding copy from Mallory (at = 500 < 2000, received later at 3000)!
    const malloryBackdated = makeMsg({ id: sharedId, deviceId: DEV_B, memberId: MEM_B, seq: 1, at: 500, receivedAt: 3000, text: 'spoofed backdated copy', replicated: true });

    // mergeHistoryMessages refuses to insert Mallory's backdated collision ahead of Alice's original!
    const { messages: mergedBackdated } = mergeHistoryMessages([aliceOriginal, honestMid], [malloryBackdated]);
    expect(mergedBackdated.map(m => messageKey(m.packet.body.deviceId, m.packet.body.id))).toEqual([
      messageKey(DEV_A, sharedId),
      messageKey(DEV_B, sharedId),
      messageKey(DEV_A, honestMid.packet.body.id),
    ]);

    // And when Mallory's colliding copy arrives after `honestMid` (`at = 3000`), it sits at the end:
    const malloryForward = makeMsg({ id: sharedId, deviceId: DEV_B, memberId: MEM_B, seq: 1, at: 3000, receivedAt: 3000, text: 'spoofed forward copy', replicated: true });
    const { messages: merged } = mergeHistoryMessages([aliceOriginal, honestMid], [malloryForward]);
    expect(merged.map(m => messageKey(m.packet.body.deviceId, m.packet.body.id))).toEqual([
      messageKey(DEV_A, sharedId),
      messageKey(DEV_A, honestMid.packet.body.id),
      messageKey(DEV_B, sharedId),
    ]);

    const canonical = canonicalMessageKeys(merged);
    expect(canonical.get(sharedId)).toBe(messageKey(DEV_A, sharedId));

    const toViewMessages = (list: HistoryStoredMessage[]) => {
      const canon = canonicalMessageKeys(list);
      return list.map(m => ({
        id: m.packet.body.id,
        authorId: m.packet.body.memberId,
        author: m.packet.body.memberId === MEM_A ? 'Alice' : 'Mallory',
        role: 'human' as const,
        text: m.packet.body.text,
        time: new Date(m.packet.body.at).toISOString(),
        deviceId: m.packet.body.deviceId,
        ...(canon.get(m.packet.body.id) !== messageKey(m.packet.body.deviceId, m.packet.body.id) ? { collidingCopy: true as const } : {}),
        ...(m.packet.body.text.includes('@Agent') ? { mentions: [agentId] } : {}),
      }));
    };

    const roomView = {
      floor: 'humans-first' as const,
      participants: [
        { id: MEM_A, role: 'human' as const },
        { id: MEM_B, role: 'human' as const },
        { id: agentId, role: 'agent' as const },
      ],
      messages: toViewMessages(merged),
    };

    // 1. Agent cursor at `sharedId`: neither rewinds before Alice's original NOR skips `honestMid`!
    const woke1 = evaluateWake(roomView, agentId, sharedId, 0);
    expect(woke1.state).toBe('addressed');
    expect(woke1.addressed).toEqual([honestMid.packet.body.id]);
    // Because the last unseen message is Mallory's colliding copy, cursor is composite `<DEV_B>:<sharedId>` so next poll doesn't loop!
    expect(woke1.cursor).toBe(`${DEV_B}:${sharedId}`);
    expect(storedCursorIndex(merged, woke1.cursor!)).toBe(2);
    const woke2 = evaluateWake(roomView, agentId, woke1.cursor, 0);
    expect(woke2.state).toBe('waiting');
    expect(woke2.messages).toHaveLength(0);

    // 2. Even if a backdated colliding copy somehow appeared earlier in an array, first-seen canonical `collidingCopy` still prevents rewind!
    const reversed = [malloryBackdated, aliceOriginal, honestMid];
    const reversedView = { ...roomView, messages: toViewMessages(reversed) };
    const wokeRev = evaluateWake(reversedView, agentId, sharedId, 0);
    expect(wokeRev.addressed).toEqual([honestMid.packet.body.id]);
    expect(wokeRev.messages.map(m => m.id)).toEqual([honestMid.packet.body.id]);

    // 3. Reply target resolution (`addresses` & `mayAgentSpeak`) resolves `replyTo: sharedId` to canonical first-seen copy, ignoring Mallory's earlier-placed colliding copy!
    const agentReplyTargetId = crypto.randomUUID();
    const agentOriginal = makeMsg({ id: agentReplyTargetId, deviceId: DEV_C, memberId: agentId, seq: 1, at: 2000, receivedAt: 2000, text: 'agent statement' });
    const malloryTargetCollision = makeMsg({ id: agentReplyTargetId, deviceId: DEV_B, memberId: MEM_B, seq: 2, at: 1000, receivedAt: 3000, text: 'mallory collision', replicated: true });
    const replyFromAlice = { id: crypto.randomUUID(), authorId: MEM_A, author: 'Alice', role: 'human' as const, text: 'sounds good', time: new Date(4000).toISOString(), replyTo: agentReplyTargetId };
    const replyMessages = [
      ...toViewMessages([malloryTargetCollision, agentOriginal]).map(m => m.authorId === agentId ? { ...m, role: 'agent' as const } : m),
      replyFromAlice,
    ];
    expect(addresses(replyFromAlice, agentId, replyMessages)).toBe(true);
    expect(mayAgentSpeak({ floor: 'humans-first', participants: roomView.participants, messages: replyMessages }, agentId, replyFromAlice.id)).toBe(true);

    // 4. Retraction op ID squatting: Mallory reusing Alice's retraction op ID cannot block Alice's real retraction!
    const sharedOpId = crypto.randomUUID();
    const targetMsg = makeMsg({ deviceId: DEV_A, memberId: MEM_A, seq: 10, at: 5000, text: 'to delete' });
    const malloryOther = makeMsg({ deviceId: DEV_B, memberId: MEM_B, seq: 10, at: 5001, text: 'mallory msg' });
    const malloryOp = { body: { kind: 'retract' as const, roomId: ROOM, id: sharedOpId, deviceId: DEV_B, memberId: MEM_B, at: 5002, target: malloryOther.packet.body.id }, signature: 's'.repeat(88) };
    const aliceOp = { body: { kind: 'retract' as const, roomId: ROOM, id: sharedOpId, deviceId: DEV_A, memberId: MEM_A, at: 5003, target: targetMsg.packet.body.id }, signature: 's'.repeat(88) };
    const r1 = addRetractions([], [malloryOp], [targetMsg, malloryOther]);
    const r2 = addRetractions(r1.log, [aliceOp], [targetMsg, malloryOther]);
    expect(r2.added).toHaveLength(1);
    expect(r2.log).toHaveLength(2);
    const applied = applyRetractions([targetMsg, malloryOther], r2.log.map(op => op.body));
    expect(applied.messages[0].retracted).toBe(true);
  });

  test('gap warning ignores late-joiner leading prefixes and retracted interior seqs while still flagging genuine interior withholding', () => {
    // Late joiner receives only seqs 51..55 (`room`-visible history turned on mid-room):
    // protocol `hasGaps` is true (so companion devices can ask for 1..50), but UI `hasVisibleGaps` MUST be false!
    const lateJoinerMsgs = [51, 52, 53, 54, 55].map(seq => makeMsg({ deviceId: DEV_A, memberId: MEM_A, seq, at: 5000 + seq, visibility: 'room' }));
    const lateMeta = analyzeHistory(lateJoinerMsgs);
    expect(lateMeta.hasGaps).toBe(true);
    expect(lateMeta.hasVisibleGaps).toBe(false);

    // Interior gap (seq 1 and seq 3 held, seq 2 missing) WITH no retraction -> `hasVisibleGaps` is true!
    const withGap = [1, 3].map(seq => makeMsg({ deviceId: DEV_A, memberId: MEM_A, seq, at: 1000 + seq, visibility: 'room' }));
    expect(analyzeHistory(withGap).hasVisibleGaps).toBe(true);

    // Same interior gap explained by a signed retraction carrying `seq: 2` -> `hasVisibleGaps` is false!
    const retractWithSeq: RetractBody = { kind: 'retract', roomId: ROOM, id: crypto.randomUUID(), deviceId: DEV_A, memberId: MEM_A, at: 2000, target: crypto.randomUUID(), targetDeviceId: DEV_A, seq: 2 };
    expect(analyzeHistory(withGap, [retractWithSeq]).hasVisibleGaps).toBe(false);

    // Same interior gap explained by a legacy unresolved retraction (no `seq` field) from Alice -> `hasVisibleGaps` is false!
    const legacyRetract: RetractBody = { kind: 'retract', roomId: ROOM, id: crypto.randomUUID(), deviceId: DEV_A, memberId: MEM_A, at: 2000, target: crypto.randomUUID() };
    expect(analyzeHistory(withGap, [legacyRetract]).hasVisibleGaps).toBe(false);

    // Unrelated member's retraction does NOT hide Alice's withheld seq 2!
    const otherRetract: RetractBody = { kind: 'retract', roomId: ROOM, id: crypto.randomUUID(), deviceId: DEV_B, memberId: MEM_B, at: 2000, target: crypto.randomUUID() };
    expect(analyzeHistory(withGap, [otherRetract]).hasVisibleGaps).toBe(true);
  });

  test('buildHistoryHave sets windowFullAt at full window (unless half-cap skewed) so peers skip immediately-evicted old history', () => {
    const msgs: HistoryStoredMessage[] = [];
    for (let i = 1; i <= 10; i++) {
      // Spread across 3 members so nobody holds >= half.
      const dev = i % 3 === 0 ? DEV_A : i % 3 === 1 ? DEV_B : DEV_C;
      const mem = i % 3 === 0 ? MEM_A : i % 3 === 1 ? MEM_B : MEM_C;
      msgs.push(makeMsg({ deviceId: dev, memberId: mem, seq: i, at: 10_000 + i * 10, visibility: 'room' }));
    }
    const haveFull = buildHistoryHave(ROOM, msgs, { maxStored: 10 });
    expect(haveFull.windowFullAt).toBe(10_010);
    const oldEntry = makeMsg({ deviceId: DEV_A, memberId: MEM_A, seq: 1, at: 5_000, receivedAt: 5_000, visibility: 'room' });
    const newerEntry = makeMsg({ deviceId: DEV_A, memberId: MEM_A, seq: 2, at: 10_050, receivedAt: 10_050, visibility: 'room' });
    const selected = selectHistoryEntries([oldEntry, newerEntry], haveFull, DEV_C, roomStatus, MEM_A);
    expect(selected.entries.map(e => e.body.id)).toEqual([newerEntry.packet.body.id]);

    // When one member holds >= half (half-cap eviction applies), windowFullAt is omitted!
    const skewed = Array.from({ length: 10 }, (_, i) => makeMsg({ deviceId: DEV_A, memberId: MEM_A, seq: i + 1, at: 10_000 + i }));
    expect(buildHistoryHave(ROOM, skewed, { maxStored: 10 }).windowFullAt).toBeUndefined();
  });

  test('nextAuthorSeq increments past held messages and persisted floor', () => {
    const m1 = makeMsg({ deviceId: DEV_A, seq: 1, at: 100 });
    const m3 = makeMsg({ deviceId: DEV_A, seq: 3, at: 300, retracted: true });
    expect(nextAuthorSeq([m1, m3], DEV_A, 0)).toBe(4);
    expect(nextAuthorSeq([m1], DEV_A, 7)).toBe(8);
  });
});
