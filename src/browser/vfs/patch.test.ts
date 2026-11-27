import { describe, expect, test } from 'bun:test';
import { VfsError } from './constants';
import { FugueMaxDoc, fugueIdKey, VfsInvalidOpError, type FugueLocalOpMeta } from './fuguemax';
import {
  buildPatchOp,
  buildRevertOp,
  detectConcurrentEditsDuringRevert,
  diffCodePoints,
  isOpConcurrentWithRevert,
  VfsConflictError,
  type VfsConflictReason,
  type VfsEditHunk,
} from './patch';

const COMMIT_V1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

function expectVfsConflict(
  fn: () => unknown,
  expectedReason?: VfsConflictReason,
  expectedHunkIndex?: number,
): VfsConflictError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(VfsConflictError);
  expect(caught).toBeInstanceOf(VfsError);
  const err = caught as VfsConflictError;
  expect(err.code).toBe('VFS_CONFLICT');
  if (expectedReason !== undefined) {
    expect(err.reason).toBe(expectedReason);
  }
  if (expectedHunkIndex !== undefined) {
    expect(err.conflicts[0]?.hunkIndex).toBe(expectedHunkIndex);
  }
  return err;
}

describe('Safe LLM anchor patching (patch.ts)', () => {
  test('auto-rebases disjoint concurrent human edits across replace, insert_after, insert_before, prepend, append', () => {
    const doc = new FugueMaxDoc();
    const human = makeMetaFactory('dev-human', 'alice');
    const agent = makeMetaFactory('dev-agent', 'codex');

    doc.localInsert(
      0,
      '# Spec\n\n## Intro\nAlpha line.\n\n## Details\nBeta line.\n\n## Footer\nEnd.',
      human(),
    );
    const baseRev = doc.frontierRev();

    // Concurrently, human edits the Intro paragraph (disjoint from Details & Footer!)
    const introPos = doc.getText().indexOf('Alpha line.');
    doc.localReplace(introPos, 'Alpha line.'.length, 'Human-revised intro 🚀.', human());

    // Agent patches Details & inserts after Details & appends at EOF based on stale baseRev
    const hunks: VfsEditHunk[] = [
      { op: 'replace', before: '## Details\n', old: 'Beta line.', new: 'Updated beta line.' },
      { op: 'insert_before', anchor: '## Footer', text: 'Added note.\n\n' },
    ];

    const res = buildPatchOp(doc, {
      baseRev,
      hunks,
      meta: agent(),
      apply: true,
    });

    expect(res.rebased).toBe(true);
    expect(res.baseRev).toBe(baseRev);
    expect(doc.getText()).toBe(
      '# Spec\n\n## Intro\nHuman-revised intro 🚀.\n\n## Details\nUpdated beta line.\n\nAdded note.\n\n## Footer\nEnd.',
    );

    // Prepend and append auto-rebase cleanly when human edits the middle of the doc
    const baseRev2 = doc.frontierRev();
    const midPos = Array.from(doc.getText().slice(0, doc.getText().indexOf('Updated beta'))).length;
    doc.localInsert(midPos, '[human-tag] ', human());

    const res2 = buildPatchOp(doc, {
      baseRev: baseRev2,
      hunks: [
        { op: 'prepend', text: '<!-- header -->\n' },
        { op: 'append', text: '\n<!-- footer -->' },
      ],
      meta: agent(),
      apply: true,
    });

    expect(res2.rebased).toBe(true);
    expect(doc.getText().startsWith('<!-- header -->\n# Spec')).toBe(true);
    expect(doc.getText()).toContain('[human-tag] Updated beta line.');
    expect(doc.getText().endsWith('End.\n<!-- footer -->')).toBe(true);
  });

  test('replace uses minimal Myers diff and preserves original FugueMax IDs of untouched characters', () => {
    const doc = new FugueMaxDoc();
    const human = makeMetaFactory('dev-human', 'alice');
    const agent = makeMetaFactory('dev-agent', 'codex');

    doc.localInsert(0, 'Hello 🌍 world!', human());
    const baseRev = doc.frontierRev();
    const origElements = doc.visibleElements();
    const origHelloIds = origElements.slice(0, 6).map((e) => fugueIdKey(e.id)); // "Hello "
    const origWorldIds = origElements.slice(8).map((e) => fugueIdKey(e.id)); // "world!"

    buildPatchOp(doc, {
      baseRev,
      hunks: [{ op: 'replace', old: 'Hello 🌍 world!', new: 'Hello 🚀 world!' }],
      meta: agent(),
      apply: true,
    });

    expect(doc.getText()).toBe('Hello 🚀 world!');
    const afterElements = doc.visibleElements();
    // "Hello " and "world!" kept their exact original IDs; only 🌍 -> 🚀 changed!
    expect(afterElements.slice(0, 6).map((e) => fugueIdKey(e.id))).toEqual(origHelloIds);
    expect(afterElements.slice(8).map((e) => fugueIdKey(e.id))).toEqual(origWorldIds);
    expect(afterElements[6]!.deviceId).toBe('dev-agent');
  });

  test('rejects concurrent human tombstone inside old/anchor/context span with VFS_CONFLICT', () => {
    const doc = new FugueMaxDoc();
    const human = makeMetaFactory('dev-human', 'alice');
    const agent = makeMetaFactory('dev-agent', 'codex');

    doc.localInsert(0, 'const limit = 100;\nconst timeout = 5000;\n', human());
    const baseRev = doc.frontierRev();

    // Human deletes "00" inside "100"
    const idx = doc.getText().indexOf('100') + 1;
    doc.localDelete(idx, 2, human());

    expectVfsConflict(
      () =>
        buildPatchOp(doc, {
          baseRev,
          hunks: [{ op: 'replace', old: 'limit = 100', new: 'limit = 200' }],
          meta: agent(),
        }),
      'tombstoned',
      0,
    );

    // Tombstone inside `before` context also fails closed!
    const doc2 = new FugueMaxDoc();
    doc2.localInsert(0, 'header:\nvalue = 1\n', human());
    const base2 = doc2.frontierRev();
    doc2.localDelete(0, 1, human()); // deletes 'h' from 'header:'

    expectVfsConflict(
      () =>
        buildPatchOp(doc2, {
          baseRev: base2,
          hunks: [{ op: 'replace', before: 'header:\n', old: 'value = 1', new: 'value = 2' }],
          meta: agent(),
        }),
      'tombstoned',
      0,
    );
  });

  test('rejects concurrent human insertion strictly INSIDE old/anchor span (strict visible-DFS contiguity)', () => {
    const doc = new FugueMaxDoc();
    const human = makeMetaFactory('dev-human', 'alice');
    const agent = makeMetaFactory('dev-agent', 'codex');

    doc.localInsert(0, 'The quick brown fox jumps over the lazy dog.', human());
    const baseRev = doc.frontierRev();

    // Human inserts "very " strictly INSIDE "quick brown" without deleting ANY original char!
    // Every original element ID of "quick brown" is STILL visible, yet non-contiguous!
    const insertPos = doc.getText().indexOf('brown');
    doc.localInsert(insertPos, 'very ', human());
    expect(doc.getText()).toBe('The quick very brown fox jumps over the lazy dog.');

    // Replace hunk must fail closed with mid-span-insertion!
    expectVfsConflict(
      () =>
        buildPatchOp(doc, {
          baseRev,
          hunks: [{ op: 'replace', old: 'quick brown', new: 'fast red' }],
          meta: agent(),
        }),
      'mid-span-insertion',
      0,
    );

    // insert_after with anchor interrupted by concurrent insertion also fails closed!
    expectVfsConflict(
      () =>
        buildPatchOp(doc, {
          baseRev,
          hunks: [{ op: 'insert_after', anchor: 'quick brown', text: ' clever' }],
          meta: agent(),
        }),
      'mid-span-insertion',
      0,
    );

    // Original doc untouched on conflict
    expect(doc.getText()).toBe('The quick very brown fox jumps over the lazy dog.');
  });

  test('rejects concurrent insertion at insert_after, insert_before, prepend, and append seams', () => {
    const human = makeMetaFactory('dev-human', 'alice');
    const agent = makeMetaFactory('dev-agent', 'codex');

    // 1. insert_after seam insertion (right neighbor still visible)
    {
      const doc = new FugueMaxDoc();
      doc.localInsert(0, 'Hello world', human());
      const baseRev = doc.frontierRev();
      doc.localInsert(5, ' dear', human()); // right after "Hello"
      expect(doc.getText()).toBe('Hello dear world');

      expectVfsConflict(
        () =>
          buildPatchOp(doc, {
            baseRev,
            hunks: [{ op: 'insert_after', anchor: 'Hello', text: ' brave' }],
            meta: agent(),
          }),
        'seam-insertion',
        0,
      );
    }

    // 2. insert_after seam insertion when right neighbor was deleted AND replaced
    {
      const doc = new FugueMaxDoc();
      doc.localInsert(0, '# Header\nOld body', human());
      const baseRev = doc.frontierRev();
      doc.localReplace(9, 'Old body'.length, 'Human body', human());

      expectVfsConflict(
        () =>
          buildPatchOp(doc, {
            baseRev,
            hunks: [{ op: 'insert_after', anchor: '# Header\n', text: 'Agent body\n' }],
            meta: agent(),
          }),
        'seam-insertion',
        0,
      );
    }

    // 3. insert_after at EOF when human appended after anchor
    {
      const doc = new FugueMaxDoc();
      doc.localInsert(0, 'Line 1\nLine 2', human());
      const baseRev = doc.frontierRev();
      doc.localInsert(doc.visibleElements().length, '\nHuman line 3', human());

      expectVfsConflict(
        () =>
          buildPatchOp(doc, {
            baseRev,
            hunks: [{ op: 'insert_after', anchor: 'Line 2', text: '\nAgent line 3' }],
            meta: agent(),
          }),
        'seam-insertion',
        0,
      );
    }

    // 4. insert_before seam insertion (both mid-doc and BOF)
    {
      const doc = new FugueMaxDoc();
      doc.localInsert(0, 'Alpha Beta', human());
      const baseRev = doc.frontierRev();
      doc.localInsert(6, 'Middle ', human()); // right before "Beta"

      expectVfsConflict(
        () =>
          buildPatchOp(doc, {
            baseRev,
            hunks: [{ op: 'insert_before', anchor: 'Beta', text: 'Agent ' }],
            meta: agent(),
          }),
        'seam-insertion',
        0,
      );

      // BOF insert_before
      const doc2 = new FugueMaxDoc();
      doc2.localInsert(0, 'First line', human());
      const base2 = doc2.frontierRev();
      doc2.localInsert(0, 'Prepended\n', human());

      expectVfsConflict(
        () =>
          buildPatchOp(doc2, {
            baseRev: base2,
            hunks: [{ op: 'insert_before', anchor: 'First line', text: 'Agent header\n' }],
            meta: agent(),
          }),
        'seam-insertion',
        0,
      );
    }

    // 5. prepend boundary-changed when human prepends concurrently
    {
      const doc = new FugueMaxDoc();
      doc.localInsert(0, 'Body text', human());
      const baseRev = doc.frontierRev();
      doc.localInsert(0, 'Human title\n', human());

      expectVfsConflict(
        () =>
          buildPatchOp(doc, {
            baseRev,
            hunks: [{ op: 'prepend', text: 'Agent title\n' }],
            meta: agent(),
          }),
        'boundary-changed',
        0,
      );
    }

    // 6. append boundary-changed when human appends concurrently
    {
      const doc = new FugueMaxDoc();
      doc.localInsert(0, 'Body text', human());
      const baseRev = doc.frontierRev();
      doc.localInsert(doc.visibleElements().length, '\nHuman end', human());

      expectVfsConflict(
        () =>
          buildPatchOp(doc, {
            baseRev,
            hunks: [{ op: 'append', text: '\nAgent end' }],
            meta: agent(),
          }),
        'boundary-changed',
        0,
      );
    }
  });

  test('rejects ambiguous anchors, missing anchors, overlapping hunks, and unknown baseRev with VFS_CONFLICT', () => {
    const doc = new FugueMaxDoc();
    const human = makeMetaFactory('dev-human', 'alice');
    const agent = makeMetaFactory('dev-agent', 'codex');

    doc.localInsert(0, 'item: foo\nitem: foo\nother: bar\n', human());
    const baseRev = doc.frontierRev();

    // Ambiguous (>1 matches) includes candidate line numbers
    const ambig = expectVfsConflict(
      () =>
        buildPatchOp(doc, {
          baseRev,
          hunks: [{ op: 'replace', old: 'item: foo', new: 'item: baz' }],
          meta: agent(),
        }),
      'anchor-ambiguous',
      0,
    );
    expect(ambig.conflicts[0]?.candidateLines).toEqual([1, 2]);

    // Missing (0 matches)
    expectVfsConflict(
      () =>
        buildPatchOp(doc, {
          baseRev,
          hunks: [{ op: 'replace', old: 'does not exist', new: 'x' }],
          meta: agent(),
        }),
      'anchor-not-found',
      0,
    );

    // Overlapping hunks in one patch (core overlap AND insert strictly inside replace's before/after context)
    expectVfsConflict(
      () =>
        buildPatchOp(doc, {
          baseRev,
          hunks: [
            { op: 'replace', old: 'other: bar', new: 'other: baz' },
            { op: 'insert_after', anchor: 'other:', text: ' extra' },
          ],
          meta: agent(),
        }),
      'overlapping-hunks',
      1,
    );

    const ctxDoc = new FugueMaxDoc();
    ctxDoc.localInsert(0, 'section:\n  key: old\nend\n', human());
    const ctxRev = ctxDoc.frontierRev();
    expectVfsConflict(
      () =>
        buildPatchOp(ctxDoc, {
          baseRev: ctxRev,
          hunks: [
            { op: 'replace', before: 'section:\n  ', old: 'key: old', after: '\nend', new: 'key: new' },
            { op: 'insert_after', anchor: 'section:', text: ' # comment' },
          ],
          meta: agent(),
        }),
      'overlapping-hunks',
      1,
    );

    // Unknown baseRev
    expectVfsConflict(
      () =>
        buildPatchOp(doc, {
          baseRev: 'f:0000000000000000',
          hunks: [{ op: 'append', text: 'x' }],
          meta: agent(),
        }),
      'base-rev-unknown',
    );
  });
});

describe('CRDT-safe compensating reversion & concurrent-edit-during-revert (patch.ts)', () => {
  test('compensating revert converges across offline peer reconnect with ZERO resurrected text', () => {
    const peerA = new FugueMaxDoc();
    const peerB = new FugueMaxDoc();
    const peerC = new FugueMaxDoc();

    const metaA = makeMetaFactory('dev-a', 'alice');
    const metaB = makeMetaFactory('dev-b', 'bob');

    // v1: initial document synced to A, B, C
    const op1 = peerA.localInsert(0, 'Line 1\nLine 2\nLine 3\n', metaA());
    peerB.applyOp(op1.op, op1.opHash);
    peerC.applyOp(op1.op, op1.opHash);
    const v1Frontier = peerA.frontier();
    const v1Text = peerA.getText();

    // v2: Peer B deletes "Line 2\n" and inserts "Bad edit\n"; synced to A and C
    const op2 = peerB.localReplace(7, 'Line 2\n'.length, 'Bad edit\n', metaB());
    peerA.applyOp(op2.op, op2.opHash);
    peerC.applyOp(op2.op, op2.opHash);
    expect(peerC.getText()).toBe('Line 1\nBad edit\nLine 3\n');

    // Peer C now goes OFFLINE holding v2!
    // v3: Peer A adds more text on top of v2; synced to B
    const op3 = peerA.localInsert(peerA.visibleElements().length, 'Extra line 4\n', metaA());
    peerB.applyOp(op3.op, op3.opHash);
    expect(peerA.getText()).toBe('Line 1\nBad edit\nLine 3\nExtra line 4\n');

    // Peer A reverts v3 -> v1 using compensating forward op
    const revResult = buildRevertOp(peerA, {
      targetFrontier: v1Frontier,
      revertsCommit: COMMIT_V1,
      meta: metaA(),
      apply: true,
    });

    expect(revResult.noChanges).toBe(false);
    expect(revResult.nextText).toBe(v1Text);
    expect(revResult.op.revertsCommit).toBe(COMMIT_V1);
    expect(revResult.deletedCodePoints).toBe('Bad edit\nExtra line 4\n'.length);
    expect(revResult.restoredCodePoints).toBe('Line 2\n'.length);
    expect(peerA.getText()).toBe(v1Text);

    // Deliver revert op to Peer B
    peerB.applyOp(revResult.op, revResult.opHash);
    expect(peerB.getText()).toBe(v1Text);

    // Offline Peer C reconnects and exchanges ALL ops with A & B (even re-delivering v2!)
    peerC.applyOp(op3.op, op3.opHash);
    peerC.applyOp(revResult.op, revResult.opHash);
    peerA.applyOp(op2.op, op2.opHash); // duplicate re-delivery must NOT resurrect "Bad edit"

    expect(peerA.getText()).toBe(v1Text);
    expect(peerB.getText()).toBe(v1Text);
    expect(peerC.getText()).toBe(v1Text);
    expect(peerA.frontierRev()).toBe(peerB.frontierRev());
    expect(peerA.frontierRev()).toBe(peerC.frontierRev());

    // Zero concurrent-edit-during-revert warnings because C made no unseen edits
    expect(detectConcurrentEditsDuringRevert(peerA)).toEqual([]);
  });

  test('detectConcurrentEditsDuringRevert accurately identifies concurrent unseen edits without false positives', () => {
    const peerA = new FugueMaxDoc();
    const peerC = new FugueMaxDoc();
    const metaA = makeMetaFactory('dev-a', 'alice');
    const metaC = makeMetaFactory('dev-c', 'charlie');

    // v1 synced to A and C
    const op1 = peerA.localInsert(0, 'Alpha\nBeta\n', metaA());
    peerC.applyOp(op1.op, op1.opHash);
    const v1Frontier = peerA.frontier();

    // v2 synced to A and C (strictly BEFORE revert)
    const op2 = peerA.localInsert(peerA.visibleElements().length, 'Gamma\n', metaA());
    peerC.applyOp(op2.op, op2.opHash);

    // Peer C goes offline at v2 (exact same frontier as revert.parents!) and makes TWO unseen edits
    const offlineC1 = peerC.localInsert(0, '[Charlie offline]\n', metaC());
    const offlineC2 = peerC.localInsert(peerC.visibleElements().length, 'Delta\n', metaC());

    // Meanwhile Peer A reverts v2 -> v1
    const revert = buildRevertOp(peerA, {
      targetFrontier: v1Frontier,
      revertsCommit: COMMIT_V1,
      meta: metaA(),
      apply: true,
    });
    expect(peerA.getText()).toBe('Alpha\nBeta\n');

    // Peer A also makes a follow-up edit strictly AFTER the revert
    const afterRevert = peerA.localInsert(peerA.visibleElements().length, 'Post-revert\n', metaA());

    // Now Peer C reconnects and both peers exchange all ops!
    peerA.applyOp(offlineC1.op, offlineC1.opHash);
    peerA.applyOp(offlineC2.op, offlineC2.opHash);
    peerC.applyOp(revert.op, revert.opHash);
    peerC.applyOp(afterRevert.op, afterRevert.opHash);

    // Both peers converge identically, preserving Charlie's offline edits without silent loss
    expect(peerA.getText()).toBe(peerC.getText());
    expect(peerA.frontierRev()).toBe(peerC.frontierRev());
    expect(peerA.getText()).toContain('[Charlie offline]');
    expect(peerA.getText()).toContain('Delta');
    expect(peerA.getText()).toContain('Post-revert');
    expect(peerA.getText()).not.toContain('Gamma');

    // Exact concurrency classification:
    expect(isOpConcurrentWithRevert(peerA, op1.opHash, revert.opHash)).toBe(false); // before revert
    expect(isOpConcurrentWithRevert(peerA, op2.opHash, revert.opHash)).toBe(false); // before revert
    expect(isOpConcurrentWithRevert(peerA, afterRevert.opHash, revert.opHash)).toBe(false); // after revert
    expect(isOpConcurrentWithRevert(peerA, offlineC1.opHash, revert.opHash)).toBe(true); // concurrent!
    expect(isOpConcurrentWithRevert(peerA, offlineC2.opHash, revert.opHash)).toBe(true); // concurrent!

    const warnings = detectConcurrentEditsDuringRevert(peerA);
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.kind).toBe('concurrent-edit-during-revert');
    expect(warnings[0]!.revertOpId).toBe(revert.op.opId);
    expect(warnings[0]!.revertOpHash).toBe(revert.opHash);
    expect(warnings[0]!.revertsCommit).toBe(COMMIT_V1);
    expect([...warnings[0]!.concurrentOpIds].sort()).toEqual([offlineC1.op.opId, offlineC2.op.opId].sort());
    expect(warnings[0]!.concurrentAuthors).toEqual([{ memberId: 'charlie', deviceId: 'dev-c' }]);

    // Peer C detects the exact same warning!
    expect(detectConcurrentEditsDuringRevert(peerC, revert.op.opId)).toEqual(warnings);
  });

  test('reverting to an equivalent revision emits a zero-churn no-op compensating revert', () => {
    const doc = new FugueMaxDoc();
    const meta = makeMetaFactory('dev-a', 'alice');

    doc.localInsert(0, 'stable text', meta());
    const v1Frontier = doc.frontier();
    doc.localReplace(0, 'stable'.length, 'broken', meta());

    // First revert restores "stable text" with fresh IDs
    const rev1 = buildRevertOp(doc, {
      targetFrontier: v1Frontier,
      revertsCommit: COMMIT_V1,
      meta: meta(),
      apply: true,
    });
    expect(rev1.noChanges).toBe(false);
    expect(doc.getText()).toBe('stable text');

    // Second revert to v1 sees identical text and produces a clean no-op
    const rev2 = buildRevertOp(doc, {
      targetFrontier: v1Frontier,
      revertsCommit: COMMIT_V1,
      meta: meta(),
      apply: true,
    });
    expect(rev2.noChanges).toBe(true);
    expect(rev2.op.ops).toEqual([]);
    expect(doc.getText()).toBe('stable text');
  });

  test('strictly validates revertsCommit as UUID or 64-hex in buildRevertOp', () => {
    const doc = new FugueMaxDoc({ roomId: 'room-1', nodeId: 'doc-1' });
    const meta = makeMetaFactory('dev-a', 'alice');
    doc.localInsert(0, 'v1', meta());
    const v1 = doc.frontier();
    doc.localInsert(2, ' v2', meta());

    for (const bad of ['', 'commit-v1', '../evil', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', 'g'.repeat(64)]) {
      expect(() =>
        buildRevertOp(doc, { targetFrontier: v1, revertsCommit: bad, meta: meta() }),
      ).toThrow(VfsInvalidOpError);
    }

    const okHex = buildRevertOp(doc, { targetFrontier: v1, revertsCommit: 'f'.repeat(64), meta: meta() });
    expect(okHex.op.revertsCommit).toBe('f'.repeat(64));
  });
});

describe('Patch DoS resistance & bounded linear-space Myers diff (patch.ts)', () => {
  test('1-char anchor on a 128 KiB doc fails fast as anchor-ambiguous in < 50ms (no O(matches * n) blowup)', () => {
    const doc = new FugueMaxDoc({ roomId: 'room-1', nodeId: 'doc-1' });
    const human = makeMetaFactory('dev-human', 'alice');
    const agent = makeMetaFactory('dev-agent', 'codex');

    // Build 128 KiB doc with 65,536 occurrences of 'a\n' via valid <= 12 KiB ops
    // (note: '\n' escapes to 2 JSON bytes, so 2048 pairs = 4 KiB text / ~6.4 KiB JSON)
    const chunk4K = 'a\n'.repeat(2048); // 4,096 bytes
    let cpLen = 0;
    for (let i = 0; i < 32; i++) {
      doc.localInsert(cpLen, chunk4K, human());
      cpLen += chunk4K.length;
    }
    expect(doc.utf8ByteLength()).toBe(128 * 1024);
    const baseRev = doc.frontierRev();

    const t0 = performance.now();
    const err = expectVfsConflict(
      () =>
        buildPatchOp(doc, {
          baseRev,
          hunks: [{ op: 'replace', old: 'a', new: 'b' }],
          meta: agent(),
        }),
      'anchor-ambiguous',
      0,
    );
    const elapsedMs = performance.now() - t0;
    expect(elapsedMs).toBeLessThan(50);
    expect(err.conflicts[0]?.candidateLines?.length).toBeLessThanOrEqual(10);
    expect(err.conflicts[0]?.candidateLines?.slice(0, 3)).toEqual([1, 2, 3]);

    // Adversarial worst-case KMP pattern ('a\n'*500 + 'z') also completes cleanly in < 50ms!
    const t1 = performance.now();
    expectVfsConflict(
      () =>
        buildPatchOp(doc, {
          baseRev,
          hunks: [{ op: 'replace', old: `${'a\n'.repeat(500)}z`, new: 'x' }],
          meta: agent(),
        }),
      'anchor-not-found',
      0,
    );
    expect(performance.now() - t1).toBeLessThan(50);
  });

  test('linear-space Myers diff reconstructs randomized inputs accurately and handles 256 KiB rewrites fast with tiny memory', () => {
    // 1. Randomized correctness across 80 pairs (including Unicode emoji)
    const alphabet = ['a', 'b', 'c', '\n', '🌍', '🚀'];
    let seed = 1337;
    const nextRand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let trial = 0; trial < 80; trial++) {
      const lenA = Math.floor(nextRand() * 35);
      const lenB = Math.floor(nextRand() * 35);
      const a = Array.from({ length: lenA }, () => alphabet[Math.floor(nextRand() * alphabet.length)]!);
      const b = Array.from({ length: lenB }, () => alphabet[Math.floor(nextRand() * alphabet.length)]!);
      const segs = diffCodePoints(a, b);
      // Reconstruct b by applying segs to a
      const rebuilt: string[] = [];
      let cursor = 0;
      for (const seg of segs) {
        if (seg.t === 'eq') {
          expect(seg.baseStart).toBe(cursor);
          for (let i = 0; i < seg.len; i++) rebuilt.push(a[seg.baseStart + i]!);
          cursor += seg.len;
        } else if (seg.t === 'del') {
          expect(seg.baseStart).toBe(cursor);
          cursor += seg.len;
        } else {
          rebuilt.push(...seg.text);
        }
      }
      expect(cursor).toBe(a.length);
      expect(rebuilt).toEqual(b);
    }

    // 2. 256 KiB full-file rewrite (exceeds MYERS_MAX_D = 2048 -> bounded fallback, tiny peak memory!)
    const prefix = Array.from('HEADER\n');
    const suffix = Array.from('\nFOOTER');
    const oldBig = [...prefix, ...Array.from('a'.repeat(256 * 1024)), ...suffix];
    const newBig = [...prefix, ...Array.from('b'.repeat(256 * 1024)), ...suffix];

    const t0 = performance.now();
    const segs = diffCodePoints(oldBig, newBig);
    const elapsedMs = performance.now() - t0;
    expect(elapsedMs).toBeLessThan(200);
    // Preserves common prefix and common suffix, single del + ins in middle!
    expect(segs.length).toBe(4);
    expect(segs[0]).toEqual({ t: 'eq', baseStart: 0, len: prefix.length });
    expect(segs[1]).toEqual({ t: 'del', baseStart: prefix.length, len: 256 * 1024 });
    expect(segs[2]?.t).toBe('ins');
    expect(segs[2]?.t === 'ins' ? segs[2].text.length : 0).toBe(256 * 1024);
    expect(segs[3]).toEqual({ t: 'eq', baseStart: prefix.length + 256 * 1024, len: suffix.length });
  });
});
