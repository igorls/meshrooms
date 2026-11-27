import { describe, expect, test } from 'bun:test';
import {
  computeDocOpHash,
  computeFrontierRev,
  FugueMaxDoc,
  sha256Hex,
  VfsInvalidOpError,
  VfsSizeLimitError,
  type FugueCheckpoint,
  type FugueLocalOpMeta,
  type VfsDocOpBody,
} from './fuguemax';

function makeMetaFactory(deviceId: string, memberId: string, roomId = 'room-1', nodeId = 'doc-1') {
  let seq = 0;
  let lamport = 0;
  return (overrides: Partial<FugueLocalOpMeta> = {}): FugueLocalOpMeta => {
    seq += 1;
    lamport += 1;
    return {
      roomId,
      nodeId,
      opId: `${deviceId}-op-${seq}`,
      deviceId,
      memberId,
      epoch: 1,
      seq,
      lamport,
      at: 1_700_000_000_000 + seq,
      ...overrides,
    };
  };
}

/** Deterministic PRNG (Mulberry32) so fuzz tests are 100% reproducible. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Produces a random valid causal topological ordering of `ops`. */
function randomCausalOrder(
  ops: Array<{ op: VfsDocOpBody; opHash: string }>,
  rng: () => number,
): Array<{ op: VfsDocOpBody; opHash: string }> {
  const byHash = new Map(ops.map((x) => [x.opHash, x]));
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const item of ops) {
    let deg = 0;
    for (const p of item.op.parents) {
      if (byHash.has(p)) {
        deg++;
        const list = dependents.get(p) ?? [];
        list.push(item.opHash);
        dependents.set(p, list);
      }
    }
    indeg.set(item.opHash, deg);
  }

  const ready: string[] = [];
  for (const [h, d] of indeg) {
    if (d === 0) ready.push(h);
  }

  const out: Array<{ op: VfsDocOpBody; opHash: string }> = [];
  while (ready.length > 0) {
    const pick = Math.floor(rng() * ready.length);
    const h = ready.splice(pick, 1)[0]!;
    out.push(byHash.get(h)!);
    for (const dep of dependents.get(h) ?? []) {
      const next = (indeg.get(dep) ?? 1) - 1;
      indeg.set(dep, next);
      if (next === 0) ready.push(dep);
    }
  }
  expect(out.length).toBe(ops.length);
  return out;
}

describe('FugueMax text CRDT (fuguemax.ts)', () => {
  test('pure-TS sha256Hex matches WebCrypto SHA-256 bit-for-bit', async () => {
    const inputs = [
      '',
      'abc',
      'a'.repeat(55),
      'a'.repeat(56),
      'a'.repeat(64),
      'a'.repeat(130),
      'Hello 🚀🌍 日本語 café\nline 2',
    ];
    const enc = new TextEncoder();
    for (const input of inputs) {
      const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
      const expected = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      expect(sha256Hex(input)).toBe(expected);
    }
  });

  test('sequential inserts, mid-run splits, deletes, and supplementary emoji code points', () => {
    const doc = new FugueMaxDoc();
    const meta = makeMetaFactory('dev-a', 'alice');

    doc.localInsert(0, 'Hello 🌍🚀!', meta());
    expect(doc.getText()).toBe('Hello 🌍🚀!');
    expect(doc.visibleElements().length).toBe(9); // H e l l o ' ' 🌍 🚀 !

    // Insert strictly between 🌍 (index 6) and 🚀 (index 7) — splits run mid-emoji safely
    doc.localInsert(7, '✨', meta());
    expect(doc.getText()).toBe('Hello 🌍✨🚀!');

    // Delete 🌍✨ (2 code points at index 6)
    doc.localDelete(6, 2, meta());
    expect(doc.getText()).toBe('Hello 🚀!');

    // Reject lone UTF-16 surrogates and NUL bytes
    expect(() => doc.localInsert(0, '\uD800', meta())).toThrow(VfsInvalidOpError);
    expect(() => doc.localInsert(0, '\uDFFF', meta())).toThrow(VfsInvalidOpError);
    expect(() => doc.localInsert(0, 'bad\0text', meta())).toThrow(VfsInvalidOpError);
  });

  test('concurrent insertions at the same index do NOT interleave (forward & backward FugueMax)', () => {
    // 1. Forward typing at index 0 by two concurrent peers
    const peerA = new FugueMaxDoc();
    const peerB = new FugueMaxDoc();
    const metaA = makeMetaFactory('dev-a', 'alice');
    const metaB = makeMetaFactory('dev-b', 'bob');

    const opsA: VfsDocOpBody[] = [];
    const wordA = 'hello ';
    for (let i = 0; i < wordA.length; i++) {
      opsA.push(peerA.localInsert(i, wordA[i]!, metaA()).op);
    }

    const opsB: VfsDocOpBody[] = [];
    const wordB = 'world!';
    for (let i = 0; i < wordB.length; i++) {
      opsB.push(peerB.localInsert(i, wordB[i]!, metaB()).op);
    }

    // Apply in both orders (A then B, B then A, and interleaved delivery)
    for (const op of opsB) peerA.applyOp(op);
    for (const op of opsA) peerB.applyOp(op);

    const peerInterleaved = new FugueMaxDoc();
    for (let i = 0; i < Math.max(opsA.length, opsB.length); i++) {
      if (i < opsA.length) peerInterleaved.applyOp(opsA[i]!);
      if (i < opsB.length) peerInterleaved.applyOp(opsB[i]!);
    }

    expect(peerA.getText()).toBe('hello world!');
    expect(peerB.getText()).toBe('hello world!');
    expect(peerInterleaved.getText()).toBe('hello world!');
    expect(peerA.frontierRev()).toBe(peerB.frontierRev());
    expect(peerA.frontierRev()).toBe(peerInterleaved.frontierRev());

    // 2. Classic FugueMax backward non-interleaving (descending rightOrigin):
    //    User 1 types "1", User 2 concurrently types "2".
    //    User 2 receives "1" (sees "12"), inserts "x" before "2" (rightOrigin = "2").
    //    User 1 (without "2") types "a" after "1" (rightOrigin = END).
    //    FugueMax MUST converge to "1ax2" (keeping "1a" and "x2" non-interleaved), NOT "1xa2"!
    const u1 = new FugueMaxDoc();
    const u2 = new FugueMaxDoc();
    const m1 = makeMetaFactory('dev-1', 'user1');
    const m2 = makeMetaFactory('dev-2', 'user2');

    const op1 = u1.localInsert(0, '1', m1()).op;
    const op2 = u2.localInsert(0, '2', m2()).op;

    u2.applyOp(op1);
    expect(u2.getText()).toBe('12');

    const opX = u2.localInsert(1, 'x', m2()).op; // between "1" and "2"
    expect(u2.getText()).toBe('1x2');

    const opA = u1.localInsert(1, 'a', m1()).op; // after "1", unseen "2"
    expect(u1.getText()).toBe('1a');

    // Sync in opposite directions
    u1.applyOp(op2);
    u1.applyOp(opX);
    u2.applyOp(opA);

    expect(u1.getText()).toBe('1ax2');
    expect(u2.getText()).toBe('1ax2');
    expect(u1.frontierRev()).toBe(u2.frontierRev());
  });

  test('concurrent overlapping deletes and mid-run splits converge identically', () => {
    const a = new FugueMaxDoc();
    const b = new FugueMaxDoc();
    const ma = makeMetaFactory('dev-a', 'alice');
    const mb = makeMetaFactory('dev-b', 'bob');

    const init = a.localInsert(0, '0123456789', ma()).op;
    b.applyOp(init);

    // Peer A deletes "2345" and inserts "X" at index 2 (between "1" and "6")
    const delA = a.localDelete(2, 4, ma()).op;
    const insA = a.localInsert(2, 'X', ma()).op;
    expect(a.getText()).toBe('01X6789');

    // Concurrently, Peer B deletes overlapping "4567" and inserts "Y" after "1"
    const delB = b.localDelete(4, 4, mb()).op;
    const insB = b.localInsert(2, 'Y', mb()).op;
    expect(b.getText()).toBe('01Y2389');

    a.applyOp(delB);
    a.applyOp(insB);
    b.applyOp(delA);
    b.applyOp(insA);

    expect(a.getText()).toBe(b.getText());
    expect(a.getText()).toBe('01XY89');
    expect(a.frontierRev()).toBe(b.frontierRev());

    // Re-applying duplicate ops is idempotent
    const dup = a.applyOp(delB);
    expect(dup.duplicate).toBe(true);
    expect(dup.applied).toBe(false);
    expect(a.getText()).toBe('01XY89');
  });

  test('buffers out-of-order ops and drains them automatically once parents arrive', () => {
    const author = new FugueMaxDoc();
    const meta = makeMetaFactory('dev-a', 'alice');

    const op1 = author.localInsert(0, 'alpha ', meta());
    const op2 = author.localInsert(6, 'beta ', meta());
    const op3 = author.localInsert(11, 'gamma', meta());

    const receiver = new FugueMaxDoc();
    const r3 = receiver.applyOp(op3.op, op3.opHash);
    expect(r3.buffered).toBe(true);
    expect(r3.applied).toBe(false);
    expect(receiver.pendingCount()).toBe(1);

    const r2 = receiver.applyOp(op2.op, op2.opHash);
    expect(r2.buffered).toBe(true);
    expect(receiver.pendingCount()).toBe(2);

    const r1 = receiver.applyOp(op1.op, op1.opHash);
    expect(r1.applied).toBe(true);
    expect(r1.drained.length).toBe(2);
    expect(receiver.pendingCount()).toBe(0);
    expect(receiver.getText()).toBe('alpha beta gamma');
    expect(receiver.frontierRev()).toBe(author.frontierRev());
  });

  test('randomized multi-peer permutation convergence: 5 peers x 175 ops across 20 random causal orders', () => {
    const rng = makeRng(20261127);
    const peerCount = 5;
    const peers = Array.from({ length: peerCount }, (_, i) => ({
      doc: new FugueMaxDoc(),
      meta: makeMetaFactory(`peer-${i}`, `member-${i}`),
    }));

    const tokens = ['a', 'b', 'xy', 'hello', ' ', '\n', '🚀', 'é', '123', '—', '🌍✨'];
    const allOps: Array<{ op: VfsDocOpBody; opHash: string }> = [];

    const totalOps = 175;
    for (let step = 0; step < totalOps; step++) {
      const pIdx = Math.floor(rng() * peerCount);
      const peer = peers[pIdx]!;
      const curLen = peer.doc.visibleElements().length;

      // Generate an op (70% insert, 30% delete when non-empty)
      let produced: { op: VfsDocOpBody; opHash: string };
      if (curLen === 0 || rng() < 0.7) {
        const pos = Math.floor(rng() * (curLen + 1));
        const token = tokens[Math.floor(rng() * tokens.length)]!;
        produced = peer.doc.localInsert(pos, token, peer.meta());
      } else {
        const pos = Math.floor(rng() * curLen);
        const maxDel = Math.min(curLen - pos, 5);
        const len = 1 + Math.floor(rng() * maxDel);
        produced = peer.doc.localDelete(pos, len, peer.meta());
      }
      allOps.push(produced);

      // Simulate partial gossip / partitions: randomly sync 1-2 other peers occasionally
      if (rng() < 0.45) {
        const other = peers[Math.floor(rng() * peerCount)]!;
        if (other !== peer) {
          // Deliver a random causally-closed prefix from allOps or just peer's ops
          for (const rec of peer.doc.getAppliedOps()) {
            other.doc.applyOp(rec.op, rec.opHash);
          }
        }
      }
    }

    // Deliver all ops to every live peer to get reference converged state
    for (const peer of peers) {
      for (const item of allOps) {
        peer.doc.applyOp(item.op, item.opHash);
      }
    }

    const expectedText = peers[0]!.doc.getText();
    const expectedFrontier = peers[0]!.doc.frontier();
    const expectedRev = peers[0]!.doc.frontierRev();
    const expectedIds = peers[0]!.doc.visibleElements().map((e) => `${e.deviceId}:${e.counter}`);

    for (let i = 1; i < peerCount; i++) {
      expect(peers[i]!.doc.getText()).toBe(expectedText);
      expect(peers[i]!.doc.frontier()).toEqual(expectedFrontier);
      expect(peers[i]!.doc.frontierRev()).toBe(expectedRev);
    }

    // Replay all 175 ops in 20 independent random valid causal topological orders
    for (let trial = 0; trial < 20; trial++) {
      const order = randomCausalOrder(allOps, makeRng(1000 + trial * 7919));
      const replica = new FugueMaxDoc();
      for (const item of order) {
        replica.applyOp(item.op, item.opHash);
      }
      expect(replica.pendingCount()).toBe(0);
      expect(replica.getText()).toBe(expectedText);
      expect(replica.frontier()).toEqual(expectedFrontier);
      expect(replica.frontierRev()).toBe(expectedRev);
      expect(replica.visibleElements().map((e) => `${e.deviceId}:${e.counter}`)).toEqual(expectedIds);
    }
  });

  test('resolves Byzantine counter equivocation deterministically (lower opHash wins regardless of arrival order)', () => {
    const honest = new FugueMaxDoc();
    const mHonest = makeMetaFactory('dev-honest', 'alice');
    const base = honest.localInsert(0, 'base:', mHonest());

    // Equivocating peer creates two conflicting ops at the SAME counterStart = 0
    const fork1 = honest.clone();
    const fork2 = honest.clone();
    const eqMeta = makeMetaFactory('dev-evil', 'mallory');
    const opA = fork1.localInsert(5, 'VERSION_A', eqMeta({ opId: 'eq-a', seq: 1 }));
    const opB = fork2.localInsert(5, 'VERSION_B', eqMeta({ opId: 'eq-b', seq: 1 }));
    expect(opA.op.counterStart).toBe(0);
    expect(opB.op.counterStart).toBe(0);

    const peerAB = new FugueMaxDoc();
    peerAB.applyOp(base.op, base.opHash);
    peerAB.applyOp(opA.op, opA.opHash);
    const resAB = peerAB.applyOp(opB.op, opB.opHash);
    expect(resAB.equivocationDetected).toBe(true);

    const peerBA = new FugueMaxDoc();
    peerBA.applyOp(base.op, base.opHash);
    peerBA.applyOp(opB.op, opB.opHash);
    const resBA = peerBA.applyOp(opA.op, opA.opHash);
    expect(resBA.equivocationDetected).toBe(true);

    const winnerText = opA.opHash < opB.opHash ? 'base:VERSION_A' : 'base:VERSION_B';
    expect(peerAB.getText()).toBe(winnerText);
    expect(peerBA.getText()).toBe(winnerText);
    expect(peerAB.frontierRev()).toBe(peerBA.frontierRev());
  });

  test('fails atomically when a multi-sub-op packet has an invalid second sub-op', () => {
    const doc = new FugueMaxDoc();
    const meta = makeMetaFactory('dev-a', 'alice');
    doc.localInsert(0, 'intact', meta());
    const revBefore = doc.frontierRev();

    const malformed: VfsDocOpBody = {
      v: 1,
      kind: 'vfs-doc-op',
      roomId: 'room-1',
      nodeId: 'doc-1',
      opId: 'bad-atomic-op',
      deviceId: 'dev-b',
      memberId: 'bob',
      epoch: 1,
      seq: 1,
      lamport: 2,
      at: 1_700_000_000_010,
      visibility: 'room',
      parents: doc.frontier(),
      counterStart: 0,
      ops: [
        { t: 'ins', parent: null, side: 'R', rightOrigin: null, text: 'PARTIAL' },
        { t: 'ins', parent: ['nonexistent-dev', 999], side: 'R', rightOrigin: null, text: 'BOOM' },
      ],
    };

    expect(() => doc.applyOp(malformed)).toThrow(VfsInvalidOpError);
    expect(doc.getText()).toBe('intact');
    expect(doc.utf8ByteLength()).toBe(6);
    expect(doc.frontierRev()).toBe(revBefore);
  });

  test('clone() after compact fromCheckpoint() preserves post-checkpoint materializeAt()', () => {
    const doc = new FugueMaxDoc();
    const meta = makeMetaFactory('dev-a', 'alice');
    doc.localInsert(0, 'v1', meta());
    const cp = doc.exportCheckpoint(); // compact (no opLog)

    const restored = FugueMaxDoc.fromCheckpoint(cp);
    const revAtCp = restored.frontierRev();
    restored.localInsert(2, ' + v2', meta());
    const revAtV2 = restored.frontierRev();
    restored.localInsert(7, ' + v3', meta());

    const cloned = restored.clone();
    expect(cloned.getText()).toBe('v1 + v2 + v3');
    expect(cloned.materializeAt(revAtCp).text).toBe('v1');
    expect(cloned.materializeAt(revAtV2).text).toBe('v1 + v2');
  });

  test('tracks bounded frontierMap (256 entries) and materializeAt historical frontiers', () => {
    const doc = new FugueMaxDoc({ maxFrontierMapEntries: 256 });
    const meta = makeMetaFactory('dev-a', 'alice');

    const snapshots: Array<{ rev: string; frontier: string[]; text: string }> = [];
    snapshots.push({ rev: doc.frontierRev(), frontier: doc.frontier(), text: '' });

    for (let i = 0; i < 270; i++) {
      doc.localInsert(doc.visibleElements().length, `${i},`, meta());
      snapshots.push({
        rev: doc.frontierRev(),
        frontier: doc.frontier(),
        text: doc.getText(),
      });
    }

    // Bounded to last 256 frontiers
    expect(doc.getFrontierMap().size).toBe(256);
    expect(doc.resolveFrontier(snapshots[0]!.rev)).toBeNull(); // evicted
    expect(doc.resolveFrontier(snapshots[270]!.rev)).toEqual(snapshots[270]!.frontier);
    expect(doc.frontierRev()).toMatch(/^f:[0-9a-f]{16}$/);
    expect(computeFrontierRev(doc.frontier())).toBe(doc.frontierRev());

    // Materialize by rev digest (within 256 window) and by explicit frontier opHashes (even evicted from map!)
    const early = doc.materializeAt(snapshots[5]!.frontier);
    expect(early.text).toBe(snapshots[5]!.text);
    expect(early.rev).toBe(snapshots[5]!.rev);
    expect(early.visible.map((e) => e.char).join('')).toBe(snapshots[5]!.text);

    const recent = doc.materializeAt(snapshots[200]!.rev);
    expect(recent.text).toBe(snapshots[200]!.text);
    expect(recent.rev).toBe(snapshots[200]!.rev);

    // Empty frontier materializes to empty doc
    const empty = doc.materializeAt([]);
    expect(empty.text).toBe('');
    expect(empty.visible.length).toBe(0);
  });

  test('checkpoint export/import round-trips full tree including tombstones and converges with future concurrent ops', () => {
    const a = new FugueMaxDoc();
    const b = new FugueMaxDoc();
    const ma = makeMetaFactory('dev-a', 'alice');
    const mb = makeMetaFactory('dev-b', 'bob');

    const op1 = a.localInsert(0, 'Hello 🌍 world', ma()).op;
    b.applyOp(op1);

    // Peer B goes offline and inserts right after 🌍 before A deletes 🌍
    const offlineOpB = b.localInsert(7, ' [offline]', mb()).op;

    // Peer A deletes 🌍 and adds suffix
    const op2 = a.localDelete(6, 2, ma()).op; // deletes "🌍 "
    const op3 = a.localInsert(6, 'Mars ', ma()).op;
    expect(a.getText()).toBe('Hello Mars world');

    // Serialize lightweight checkpoint (without opLog) via JSON round-trip
    const rawJson = JSON.stringify(a.exportCheckpoint());
    const parsed = JSON.parse(rawJson) as FugueCheckpoint;
    const restored = FugueMaxDoc.fromCheckpoint(parsed);

    expect(restored.getText()).toBe(a.getText());
    expect(restored.frontier()).toEqual(a.frontier());
    expect(restored.frontierRev()).toBe(a.frontierRev());

    // Now apply Peer B's offline op (which references tombstoned 🌍!) to BOTH `a` and `restored`,
    // and sync `a`'s ops to `b`
    a.applyOp(offlineOpB);
    restored.applyOp(offlineOpB);
    b.applyOp(op2);
    b.applyOp(op3);

    expect(restored.getText()).toBe(a.getText());
    expect(b.getText()).toBe(a.getText());
    expect(restored.frontierRev()).toBe(a.frontierRev());
    expect(b.frontierRev()).toBe(a.frontierRev());
    expect(computeDocOpHash(op1)).toHaveLength(64);
  });

  test('enforces soft (256 KiB) and hard (1 MiB) doc UTF-8 byte limits without corrupting state', () => {
    // Configurable limits test
    const small = new FugueMaxDoc({ softLimitBytes: 10, hardLimitBytes: 20 });
    const ms = makeMetaFactory('dev-s', 'alice');

    small.localInsert(0, '1234567890', ms());
    expect(small.utf8ByteLength()).toBe(10);
    expect(small.isOverSoftLimit()).toBe(false);

    small.localInsert(10, '12345', ms());
    expect(small.utf8ByteLength()).toBe(15);
    expect(small.isOverSoftLimit()).toBe(true);

    // Exceeding hard limit fails closed and leaves doc intact
    const revBefore = small.frontierRev();
    let caught: unknown;
    try {
      small.localInsert(15, '678901', ms());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VfsSizeLimitError);
    expect((caught as VfsSizeLimitError).code).toBe('VFS_SIZE_LIMIT');
    expect(small.getText()).toBe('123456789012345');
    expect(small.frontierRev()).toBe(revBefore);

    // Default 256 KiB soft / 1 MiB hard limits (inserted in valid <= 12 KiB ops!)
    const large = new FugueMaxDoc({ roomId: 'room-1', nodeId: 'doc-1' });
    const ml = makeMetaFactory('dev-l', 'alice');
    const chunk8K = 'a'.repeat(8 * 1024);
    let largeLen = 0;
    for (let i = 0; i < 32; i++) {
      large.localInsert(largeLen, chunk8K, ml());
      largeLen += chunk8K.length;
    }
    expect(large.utf8ByteLength()).toBe(256 * 1024);
    expect(large.isOverSoftLimit()).toBe(false);
    large.localInsert(largeLen, 'b', ml());
    largeLen += 1;
    expect(large.isOverSoftLimit()).toBe(true);

    // Fill up to exact 1 MiB minus 1 byte using valid 8 KiB chunks, then push past 1 MiB
    for (let i = 0; i < 95; i++) {
      large.localInsert(largeLen, chunk8K, ml());
      largeLen += chunk8K.length;
    }
    large.localInsert(largeLen, 'c'.repeat(8 * 1024 - 1), ml());
    expect(large.utf8ByteLength()).toBe(1024 * 1024);
    expect(() => large.localInsert(0, 'X', ml())).toThrow(VfsSizeLimitError);
    expect(large.utf8ByteLength()).toBe(1024 * 1024);
  });

  test('rejects oversized equivocating op atomically across both delivery orders (zero divergence)', () => {
    const hardLimitBytes = 32;
    const makeBase = () => {
      const doc = new FugueMaxDoc({ softLimitBytes: 16, hardLimitBytes });
      const m = makeMetaFactory('dev-honest', 'alice');
      const base = doc.localInsert(0, 'base:', m()); // 5 bytes
      return { doc, base };
    };

    const { doc: srcA, base } = makeBase();
    const { doc: srcB } = makeBase();
    const evilMeta = makeMetaFactory('dev-evil', 'mallory');

    // Craft small opA and oversized opB (> hardLimitBytes) at same counterStart = 0,
    // searching opId until opB has strictly LOWER opHash than opA (worst-case attack!).
    const opA = srcA.localInsert(5, 'SMALL', evilMeta({ opId: 'eq-small', seq: 1 }));
    let opB: { op: VfsDocOpBody; opHash: string } | null = null;
    for (let nonce = 0; nonce < 100; nonce++) {
      const candidate: VfsDocOpBody = {
        ...evilMeta({ opId: `eq-huge-${nonce}`, seq: 1 }),
        v: 1,
        kind: 'vfs-doc-op',
        visibility: 'room',
        parents: [base.opHash],
        counterStart: 0,
        ops: [{ t: 'ins', parent: ['dev-honest', 4], side: 'R', rightOrigin: null, text: 'X'.repeat(40) }],
      };
      const hash = computeDocOpHash(candidate);
      if (hash < opA.opHash) {
        opB = { op: candidate, opHash: hash };
        break;
      }
    }
    expect(opB).not.toBeNull();
    expect(opB!.opHash < opA.opHash).toBe(true);

    // Order 1: opA -> oversized opB (must throw VfsSizeLimitError atomically and preserve opA)
    const { doc: peerAB } = makeBase();
    peerAB.applyOp(opA.op, opA.opHash);
    const revBefore = peerAB.frontierRev();
    expect(() => peerAB.applyOp(opB!.op, opB!.opHash)).toThrow(VfsSizeLimitError);
    expect(peerAB.getText()).toBe('base:SMALL');
    expect(peerAB.frontierRev()).toBe(revBefore);

    // Order 2: oversized opB -> opA (must throw VfsSizeLimitError then accept opA)
    const { doc: peerBA } = makeBase();
    expect(() => peerBA.applyOp(opB!.op, opB!.opHash)).toThrow(VfsSizeLimitError);
    peerBA.applyOp(opA.op, opA.opHash);
    expect(peerBA.getText()).toBe('base:SMALL');
    expect(peerBA.frontierRev()).toBe(peerAB.frontierRev());
  });

  test('isolates invalid buffered pending ops so valid parent applyOp() still succeeds and drains honest children', () => {
    const author = new FugueMaxDoc({ softLimitBytes: 16, hardLimitBytes: 32 });
    const ma = makeMetaFactory('dev-a', 'alice');
    const opP = author.localInsert(0, 'parent:', ma());
    const opC1 = author.localInsert(7, 'child1', ma());
    const opC2 = author.localInsert(13, '+child2', ma());

    // Malicious buffered op M1 (dangling rightOrigin) waiting on P
    const badDangling: VfsDocOpBody = {
      v: 1,
      kind: 'vfs-doc-op',
      roomId: 'room-1',
      nodeId: 'doc-1',
      opId: 'malicious-dangling',
      deviceId: 'dev-evil',
      memberId: 'mallory',
      epoch: 1,
      seq: 1,
      lamport: 2,
      at: 1_700_000_000_002,
      visibility: 'room',
      parents: [opP.opHash],
      counterStart: 0,
      ops: [{ t: 'ins', parent: null, side: 'R', rightOrigin: ['ghost-dev', 42], text: 'BAD' }],
    };

    // Malicious buffered op M2 (> hardLimitBytes) waiting on P
    const badOversized: VfsDocOpBody = {
      v: 1,
      kind: 'vfs-doc-op',
      roomId: 'room-1',
      nodeId: 'doc-1',
      opId: 'malicious-huge',
      deviceId: 'dev-evil2',
      memberId: 'mallory2',
      epoch: 1,
      seq: 1,
      lamport: 2,
      at: 1_700_000_000_003,
      visibility: 'room',
      parents: [opP.opHash],
      counterStart: 0,
      ops: [{ t: 'ins', parent: null, side: 'R', rightOrigin: null, text: 'Z'.repeat(40) }],
    };

    const receiver = new FugueMaxDoc({ softLimitBytes: 16, hardLimitBytes: 32 });
    expect(receiver.applyOp(badDangling).buffered).toBe(true);
    expect(receiver.applyOp(badOversized).buffered).toBe(true);
    expect(receiver.applyOp(opC2.op, opC2.opHash).buffered).toBe(true);
    expect(receiver.applyOp(opC1.op, opC1.opHash).buffered).toBe(true);
    expect(receiver.pendingCount()).toBe(4);

    // Applying valid parent P must NOT throw, must discard both malicious ops,
    // and must drain both honest C1 and C2!
    const res = receiver.applyOp(opP.op, opP.opHash);
    expect(res.applied).toBe(true);
    expect(res.drained.sort()).toEqual([opC1.opHash, opC2.opHash].sort());
    expect(res.rejectedPending.length).toBe(2);
    expect(receiver.pendingCount()).toBe(0);
    expect(receiver.getText()).toBe('parent:child1+child2');
    expect(receiver.frontierRev()).toBe(author.frontierRev());
  });

  test('enforces pre-apply anti-DoS bounds (maxParents, maxDelRunLen, counterJump, safe ints, tuple shapes)', () => {
    const doc = new FugueMaxDoc();
    const baseMeta = makeMetaFactory('dev-a', 'alice');
    const makeRaw = (overrides: Partial<VfsDocOpBody>): VfsDocOpBody => ({
      v: 1,
      kind: 'vfs-doc-op',
      roomId: 'room-1',
      nodeId: 'doc-1',
      opId: 'raw-op',
      deviceId: 'dev-a',
      memberId: 'alice',
      epoch: 1,
      seq: 1,
      lamport: 1,
      at: 1_700_000_000_001,
      visibility: 'room',
      parents: [],
      counterStart: 0,
      ops: [{ t: 'ins', parent: null, side: 'R', rightOrigin: null, text: 'ok' }],
      ...overrides,
    });

    // 1. parents.length > 16 rejected
    const tooManyParents = makeRaw({ parents: Array.from({ length: 17 }, (_, i) => `h${i}`) });
    expect(() => doc.applyOp(tooManyParents)).toThrow(VfsInvalidOpError);

    // 2. del run len > 65_536 rejected
    const hugeDel = makeRaw({ ops: [{ t: 'del', runs: [['dev-a', 0, 65_537]] }] });
    expect(() => doc.applyOp(hugeDel)).toThrow(VfsInvalidOpError);

    // 3. counterStart unsafe integer / overflow rejected
    const unsafeCounter = makeRaw({ counterStart: Number.MAX_SAFE_INTEGER });
    expect(() => doc.applyOp(unsafeCounter)).toThrow(VfsInvalidOpError);

    // 4. malformed parent / rightOrigin tuples rejected
    const badParentTuple = makeRaw({
      ops: [{ t: 'ins', parent: ['', 0] as unknown as readonly [string, number], side: 'R', text: 'x' }],
    });
    expect(() => doc.applyOp(badParentTuple)).toThrow(VfsInvalidOpError);

    const badNegativeParent = makeRaw({
      ops: [{ t: 'ins', parent: ['dev-a', -1] as unknown as readonly [string, number], side: 'R', text: 'x' }],
    });
    expect(() => doc.applyOp(badNegativeParent)).toThrow(VfsInvalidOpError);

    const badRightOrigin = makeRaw({
      ops: [{ t: 'ins', parent: null, side: 'R', rightOrigin: ['dev-a', 1.5] as unknown as readonly [string, number], text: 'x' }],
    });
    expect(() => doc.applyOp(badRightOrigin)).toThrow(VfsInvalidOpError);

    // 5. counterJump > 100_000 rejected in applyReadyOp (when parents are satisfied)
    const hugeJump = makeRaw({ counterStart: 100_001 });
    expect(() => doc.applyOp(hugeJump)).toThrow(VfsInvalidOpError);

    // 6. Out-of-order valid op with high counterStart STILL buffers cleanly until parent arrives
    const author = new FugueMaxDoc({ roomId: 'room-1', nodeId: 'doc-1', maxCounterJump: 5 });
    const p1 = author.localInsert(0, '123456', baseMeta()); // counters 0..5 -> next = 6
    const p2 = author.localInsert(6, '78', baseMeta()); // counterStart = 6 (jump 6 > 5 if checked before buffering!)
    const receiver = new FugueMaxDoc({ roomId: 'room-1', nodeId: 'doc-1', maxCounterJump: 5 });
    expect(receiver.applyOp(p2.op, p2.opHash).buffered).toBe(true);
    const applied = receiver.applyOp(p1.op, p1.opHash);
    expect(applied.applied).toBe(true);
    expect(applied.drained).toEqual([p2.opHash]);
    expect(receiver.getText()).toBe('12345678');

    // 7. VFS_OP_MAX_PLAINTEXT_BYTES (12 KiB) & VFS_OP_MAX_SUBOPS (64) enforced
    const tooLargeOp = makeRaw({ ops: [{ t: 'ins', parent: null, side: 'R', rightOrigin: null, text: 'a'.repeat(12 * 1024 + 1) }] });
    expect(() => doc.applyOp(tooLargeOp)).toThrow(VfsInvalidOpError);

    const tooManySubs = makeRaw({
      ops: Array.from({ length: 65 }, () => ({ t: 'ins' as const, parent: null, side: 'R' as const, rightOrigin: null, text: 'x' })),
    });
    expect(() => doc.applyOp(tooManySubs)).toThrow(VfsInvalidOpError);

    // 8. seqJump & lamportJump bounds enforced
    const hugeSeqJump = makeRaw({ seq: 50_001 });
    expect(() => doc.applyOp(hugeSeqJump)).toThrow(VfsInvalidOpError);

    const hugeLamportJump = makeRaw({ lamport: 10_001 });
    expect(() => doc.applyOp(hugeLamportJump)).toThrow(VfsInvalidOpError);

    // 9. revertsCommit strictly validated (UUID or 64-hex only)
    const badRevert = makeRaw({ revertsCommit: 'commit-v1' });
    expect(() => doc.applyOp(badRevert)).toThrow(VfsInvalidOpError);
    const goodUuidRevert = makeRaw({ opId: 'rev-uuid', revertsCommit: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    expect(new FugueMaxDoc({ roomId: 'room-1', nodeId: 'doc-1' }).applyOp(goodUuidRevert).applied).toBe(true);
    const goodHexRevert = makeRaw({ opId: 'rev-hex', revertsCommit: 'a'.repeat(64) });
    expect(new FugueMaxDoc({ roomId: 'room-1', nodeId: 'doc-1' }).applyOp(goodHexRevert).applied).toBe(true);
  });

  test('binds FugueMaxDoc to { roomId, nodeId } across applyOp and exportCheckpoint/fromCheckpoint', () => {
    const docA = new FugueMaxDoc({ roomId: 'room-a', nodeId: 'node-a' });
    const docB = new FugueMaxDoc({ roomId: 'room-a', nodeId: 'node-b' });
    const docOtherRoom = new FugueMaxDoc({ roomId: 'room-b', nodeId: 'node-a' });
    expect(docA.roomId).toBe('room-a');
    expect(docA.nodeId).toBe('node-a');

    const metaA = makeMetaFactory('dev-a', 'alice', 'room-a', 'node-a');
    const { op, opHash } = docA.localInsert(0, 'Secret for doc A', metaA());

    // Valid op for docA MUST NOT apply into docB or docOtherRoom
    expect(() => docB.applyOp(op, opHash)).toThrow(VfsInvalidOpError);
    expect(() => docOtherRoom.applyOp(op, opHash)).toThrow(VfsInvalidOpError);
    expect(docB.getText()).toBe('');
    expect(docOtherRoom.getText()).toBe('');

    // Checkpoint persists roomId & nodeId and rejects mismatched load options
    const cp = docA.exportCheckpoint();
    expect(cp.roomId).toBe('room-a');
    expect(cp.nodeId).toBe('node-a');
    const restored = FugueMaxDoc.fromCheckpoint(cp);
    expect(restored.roomId).toBe('room-a');
    expect(restored.nodeId).toBe('node-a');
    expect(() => FugueMaxDoc.fromCheckpoint(cp, { roomId: 'room-a', nodeId: 'node-b' })).toThrow(VfsInvalidOpError);
    expect(() => FugueMaxDoc.fromCheckpoint(cp, { roomId: 'room-b', nodeId: 'node-a' })).toThrow(VfsInvalidOpError);
  });

  test('enforces per-member pending cap, pending TTL eviction, and compaction ceiling', () => {
    let clock = 1_000_000;
    const doc = new FugueMaxDoc({
      roomId: 'room-1',
      nodeId: 'doc-1',
      maxPendingOpsPerMember: 3,
      maxPendingOps: 10,
      pendingOpTtlMs: 5_000,
      maxAppliedOps: 4,
      now: () => clock,
    });

    const missingParent = 'f'.repeat(64);
    const makePending = (memberId: string, deviceId: string, i: number): VfsDocOpBody => ({
      v: 1,
      kind: 'vfs-doc-op',
      roomId: 'room-1',
      nodeId: 'doc-1',
      opId: `${memberId}-pend-${i}`,
      deviceId,
      memberId,
      epoch: 1,
      seq: i + 1,
      lamport: i + 1,
      at: clock,
      visibility: 'room',
      parents: [missingParent],
      counterStart: i,
      ops: [{ t: 'ins', parent: null, side: 'R', rightOrigin: null, text: 'x' }],
    });

    // Member A can buffer at most 3 pending ops; 4th throws without starving Member B!
    for (let i = 0; i < 3; i++) {
      expect(doc.applyOp(makePending('member-a', 'dev-a', i)).buffered).toBe(true);
    }
    expect(doc.pendingCountForMember('member-a')).toBe(3);
    expect(() => doc.applyOp(makePending('member-a', 'dev-a', 3))).toThrow(VfsInvalidOpError);

    // Member B is unaffected and buffers cleanly
    expect(doc.applyOp(makePending('member-b', 'dev-b', 0)).buffered).toBe(true);
    expect(doc.pendingCount()).toBe(4);

    // Advancing clock past TTL evicts expired pending ops so Member A can buffer again
    clock += 5_000;
    expect(doc.applyOp(makePending('member-a', 'dev-a', 4)).buffered).toBe(true);
    expect(doc.pendingCount()).toBe(1);
    expect(doc.pendingCountForMember('member-a')).toBe(1);
    expect(doc.pendingCountForMember('member-b')).toBe(0);

    // Compaction ceiling (maxAppliedOps = 4) rejects 5th op until compact() is called
    const meta = makeMetaFactory('dev-honest', 'alice');
    for (let i = 0; i < 4; i++) {
      doc.localInsert(doc.visibleElements().length, `${i}`, meta());
    }
    expect(doc.appliedOpCount()).toBe(4);
    expect(() => doc.localInsert(doc.visibleElements().length, '5', meta())).toThrow(VfsInvalidOpError);

    doc.compact();
    expect(doc.appliedOpCount()).toBe(0);
    doc.localInsert(doc.visibleElements().length, '5', meta());
    expect(doc.getText()).toBe('01235');
  });

  test('guards anti-amplification on repeated counterStart equivocation spam and verifies explicitOpHash', () => {
    const baseDoc = new FugueMaxDoc({ roomId: 'room-1', nodeId: 'doc-1' });
    const mHonest = makeMetaFactory('dev-honest', 'alice');
    const base = baseDoc.localInsert(0, 'root:', mHonest());

    // 1. Mismatched explicitOpHash is ALWAYS rejected
    expect(() => baseDoc.applyOp(base.op, '0'.repeat(64))).toThrow(VfsInvalidOpError);
    const meta2 = makeMetaFactory('dev-b', 'bob');
    const nextOp = baseDoc.clone().localInsert(5, 'ok', meta2()).op;
    expect(() => baseDoc.applyOp(nextOp, '0'.repeat(64))).toThrow(VfsInvalidOpError);

    // 2. Generate 30 distinct equivocating ops at counterStart = 0 sorted by ascending opHash
    const evilOps: Array<{ op: VfsDocOpBody; opHash: string }> = [];
    for (let i = 0; i < 30; i++) {
      const op: VfsDocOpBody = {
        v: 1,
        kind: 'vfs-doc-op',
        roomId: 'room-1',
        nodeId: 'doc-1',
        opId: `spam-${i}`,
        deviceId: 'dev-evil',
        memberId: 'mallory',
        epoch: 1,
        seq: 1,
        lamport: 2,
        at: 1_700_000_000_000 + i,
        visibility: 'room',
        parents: [base.opHash],
        counterStart: 0,
        ops: [{ t: 'ins', parent: ['dev-honest', 4], side: 'R', rightOrigin: null, text: `V${i}` }],
      };
      evilOps.push({ op, opHash: computeDocOpHash(op) });
    }
    evilOps.sort((a, b) => (a.opHash < b.opHash ? -1 : 1));

    // Winner (lowest hash) + 1 proof accepted; spam #3..#30 rejected in O(1) without growing appliedOps!
    const peer = baseDoc.clone();
    expect(peer.applyOp(evilOps[0]!.op, evilOps[0]!.opHash).applied).toBe(true);
    const proofRes = peer.applyOp(evilOps[1]!.op, evilOps[1]!.opHash);
    expect(proofRes.equivocationDetected).toBe(true);
    const countAfterProof = peer.appliedOpCount();

    const startMs = performance.now();
    for (let i = 2; i < evilOps.length; i++) {
      expect(() => peer.applyOp(evilOps[i]!.op, evilOps[i]!.opHash)).toThrow(VfsInvalidOpError);
    }
    expect(performance.now() - startMs).toBeLessThan(50);
    expect(peer.appliedOpCount()).toBe(countAfterProof);
    // Duplicate replay of winner is still O(1) idempotent
    expect(peer.applyOp(evilOps[0]!.op, evilOps[0]!.opHash).duplicate).toBe(true);
  });

  test('enforces 100% order-independent acceptance for out-of-cone deletes and concurrent size limits', () => {
    // 1. Delete outside op.parents causal cone MUST fail in BOTH arrival orders!
    const srcA = new FugueMaxDoc({ roomId: 'room-1', nodeId: 'doc-1' });
    const opA = srcA.localInsert(0, 'hello', makeMetaFactory('dev-a', 'alice')());

    const illegalDel: VfsDocOpBody = {
      v: 1,
      kind: 'vfs-doc-op',
      roomId: 'room-1',
      nodeId: 'doc-1',
      opId: 'bad-del-outside-cone',
      deviceId: 'dev-evil',
      memberId: 'mallory',
      epoch: 1,
      seq: 1,
      lamport: 1,
      at: 1_700_000_000_050,
      visibility: 'room',
      parents: [], // Does NOT include opA.opHash!
      counterStart: 0,
      ops: [{ t: 'del', runs: [['dev-a', 0, 5]] }],
    };

    const peer1 = new FugueMaxDoc({ roomId: 'room-1', nodeId: 'doc-1' });
    peer1.applyOp(opA.op, opA.opHash);
    expect(() => peer1.applyOp(illegalDel)).toThrow(VfsInvalidOpError);
    expect(peer1.getText()).toBe('hello');

    const peer2 = new FugueMaxDoc({ roomId: 'room-1', nodeId: 'doc-1' });
    expect(() => peer2.applyOp(illegalDel)).toThrow(VfsInvalidOpError);
    peer2.applyOp(opA.op, opA.opHash);
    expect(peer2.getText()).toBe('hello');
    expect(peer1.frontierRev()).toBe(peer2.frontierRev());

    // 2. Concurrent size-limit acceptance is 100% order-independent across all 6 permutations!
    const opts = { roomId: 'room-1', nodeId: 'doc-1', softLimitBytes: 10, hardLimitBytes: 20 };
    const seed = new FugueMaxDoc(opts);
    const base = seed.localInsert(0, '0123456789', makeMetaFactory('dev-0', 'root')()); // 10 bytes

    const branchA = seed.clone();
    const branchB = seed.clone();
    const branchC = seed.clone();
    const branchBad = seed.clone();

    const insA = branchA.localInsert(10, 'AAAAAAAAAA', makeMetaFactory('dev-a', 'alice')()); // +10B -> 20B <= 20B
    const insB = branchB.localInsert(10, 'BBBBBBBBBB', makeMetaFactory('dev-b', 'bob')()); // +10B -> 20B <= 20B
    const delC = branchC.localDelete(0, 10, makeMetaFactory('dev-c', 'carol')()); // -10B -> 0B <= 20B
    const badOp: VfsDocOpBody = {
      v: 1,
      kind: 'vfs-doc-op',
      roomId: 'room-1',
      nodeId: 'doc-1',
      opId: 'over-cone-limit',
      deviceId: 'dev-evil',
      memberId: 'mallory',
      epoch: 1,
      seq: 1,
      lamport: 2,
      at: 1_700_000_000_099,
      visibility: 'room',
      parents: [base.opHash],
      counterStart: 0,
      ops: [{ t: 'ins', parent: ['dev-0', 9], side: 'R', rightOrigin: null, text: 'Z'.repeat(15) }], // 10 + 15 = 25 > 20!
    };
    expect(() => branchBad.applyOp(badOp)).toThrow(VfsSizeLimitError);

    const trio = [insA, insB, delC];
    const perms = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    let expectedText: string | undefined;
    let expectedRev: string | undefined;
    for (const perm of perms) {
      const p = new FugueMaxDoc(opts);
      p.applyOp(base.op, base.opHash);
      for (const idx of perm) {
        const item = trio[idx]!;
        expect(p.applyOp(item.op, item.opHash).applied).toBe(true);
      }
      // Even after delC reduced visibleBytes, badOp (10 + 15 > 20 on [base]) MUST STILL BE REJECTED!
      expect(() => p.applyOp(badOp)).toThrow(VfsSizeLimitError);
      if (expectedText === undefined) {
        expectedText = p.getText();
        expectedRev = p.frontierRev();
      } else {
        expect(p.getText()).toBe(expectedText);
        expect(p.frontierRev()).toBe(expectedRev!);
      }
    }
    expect(expectedText).toBe('AAAAAAAAAABBBBBBBBBB');
  });
});
