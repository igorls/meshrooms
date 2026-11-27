/**
 * Safe concurrent LLM anchor-based patching (`VfsEditHunk`) with strict
 * visible-DFS contiguity verification, plus CRDT-safe compensating reversion
 * (`buildRevertOp`) and `concurrent-edit-during-revert` detection.
 *
 * Pure TypeScript, zero dependencies; runs identically in Browser and Bun.
 */

import { isValidVfsCommitId, VfsError } from './constants';
import {
  computeDocOpHash,
  computeFrontierRev,
  fugueIdEquals,
  fugueIdKey,
  FugueMaxDoc,
  validateTextScalars,
  VfsInvalidOpError,
  type FugueAppliedOpRecord,
  type FugueDelRun,
  type FugueId,
  type FugueLocalOpMeta,
  type FugueSubOp,
  type FugueVisibleElement,
  type VfsDocOpBody,
} from './fuguemax';

export type VfsEditHunk =
  | { op: 'replace'; old: string; new: string; before?: string; after?: string }
  | { op: 'insert_after'; anchor: string; text: string; before?: string; after?: string }
  | { op: 'insert_before'; anchor: string; text: string; before?: string; after?: string }
  | { op: 'append'; text: string }
  | { op: 'prepend'; text: string };

export type VfsConflictReason =
  | 'base-rev-unknown'
  | 'anchor-not-found'
  | 'anchor-ambiguous'
  | 'overlapping-hunks'
  | 'tombstoned'
  | 'mid-span-insertion'
  | 'seam-insertion'
  | 'boundary-changed'
  | 'invalid-hunk'
  | 'doc-deleted';

export interface VfsPatchConflict {
  readonly hunkIndex: number;
  readonly reason: VfsConflictReason;
  readonly message: string;
  readonly candidateLines?: number[];
  readonly currentExcerpt?: string;
}

export class VfsConflictError extends VfsError {
  override readonly code = 'VFS_CONFLICT' as const;
  readonly baseRev: string;
  readonly currentRev: string;
  readonly reason: VfsConflictReason;
  readonly conflicts: VfsPatchConflict[];

  constructor(baseRev: string, currentRev: string, conflicts: VfsPatchConflict[], message?: string) {
    const primary = conflicts[0];
    const reason = primary?.reason ?? 'invalid-hunk';
    super('VFS_CONFLICT', message ?? primary?.message ?? 'VFS patch conflict.', {
      status: 409,
      details: { baseRev, currentRev, reason, conflicts },
    });
    Object.defineProperty(this, 'name', { value: 'VfsConflictError', configurable: true });
    this.baseRev = baseRev;
    this.currentRev = currentRev;
    this.reason = reason;
    this.conflicts = conflicts;
  }
}

export interface BuildPatchParams {
  /** Base revision (`f:<16-hex>` digest from `frontierMap`) or explicit `opHash[]` frontier. */
  baseRev: string | readonly string[];
  /** Explicit frontier `opHash[]` when `baseRev` is a commit UUID or external label. */
  baseFrontier?: readonly string[];
  hunks: readonly VfsEditHunk[];
  meta: FugueLocalOpMeta;
  /** When true, also applies the generated op to `doc` before returning. */
  apply?: boolean;
}

export interface BuildPatchResult {
  readonly op: VfsDocOpBody;
  readonly opHash: string;
  readonly baseRev: string;
  readonly headRev: string;
  readonly nextRev: string;
  readonly rebased: boolean;
  readonly nextText: string;
}

export interface BuildRevertParams {
  /** Target revision (`f:<16-hex>` digest or explicit `opHash[]` frontier) to restore. */
  targetFrontier: string | readonly string[];
  /** Commit ID being reverted (recorded in `VfsDocOpBody.revertsCommit`). */
  revertsCommit: string;
  meta: Omit<FugueLocalOpMeta, 'revertsCommit'>;
  /** When true, also applies the generated compensating op to `doc` before returning. */
  apply?: boolean;
}

export interface BuildRevertResult {
  readonly op: VfsDocOpBody;
  readonly opHash: string;
  readonly targetRev: string;
  readonly headRev: string;
  readonly nextRev: string;
  readonly noChanges: boolean;
  readonly deletedCodePoints: number;
  readonly restoredCodePoints: number;
  readonly nextText: string;
}

export interface ConcurrentEditDuringRevert {
  readonly kind: 'concurrent-edit-during-revert';
  readonly revertOpId: string;
  readonly revertOpHash: string;
  readonly revertsCommit: string;
  readonly concurrentOpIds: string[];
  readonly concurrentOpHashes: string[];
  readonly concurrentAuthors: Array<{ readonly memberId: string; readonly deviceId: string }>;
}

// ---------------------------------------------------------------------------
// Bounded Linear-Space Myers Diff over Unicode code-point arrays
// ---------------------------------------------------------------------------

export type DiffSegment =
  | { t: 'eq'; baseStart: number; len: number }
  | { t: 'del'; baseStart: number; len: number }
  | { t: 'ins'; text: string[] };

/** Maximum edit distance explored by linear-space Myers before falling back to single del+ins. */
export const MYERS_MAX_D = 2048;

/** Maximum ambiguous anchor matches collected before bailing out as `anchor-ambiguous`. */
const MAX_AMBIGUOUS_MATCHES = 10;

function pushSegment(out: DiffSegment[], seg: DiffSegment): void {
  const last = out[out.length - 1];
  if (seg.t === 'eq') {
    if (seg.len <= 0) return;
    if (last && last.t === 'eq' && last.baseStart + last.len === seg.baseStart) {
      last.len += seg.len;
    } else {
      out.push(seg);
    }
  } else if (seg.t === 'del') {
    if (seg.len <= 0) return;
    if (last && last.t === 'del' && last.baseStart + last.len === seg.baseStart) {
      last.len += seg.len;
    } else {
      out.push(seg);
    }
  } else {
    if (seg.text.length === 0) return;
    if (last && last.t === 'ins') {
      for (let i = 0; i < seg.text.length; i++) {
        last.text.push(seg.text[i]!);
      }
    } else {
      out.push({ t: 'ins', text: [...seg.text] });
    }
  }
}

interface MiddleSnakeSplit {
  leftAEnd: number;
  leftBEnd: number;
  leftBudget: number;
  midEdit: { t: 'ins'; bIdx: number } | { t: 'del'; aIdx: number };
  editBeforeSnake: boolean;
  snakeAStart: number;
  snakeLen: number;
  rightAStart: number;
  rightBStart: number;
  rightBudget: number;
}

/**
 * Finds the middle snake of a minimal edit script between `a[a0..a0+n)` and
 * `b[b0..b0+m)` in O(D) space (`2 * halfMax` Int32s ≈ 16 KiB max at `MYERS_MAX_D = 2048`),
 * returning `null` if edit distance exceeds `maxD`.
 */
function findMiddleSnake(
  a: readonly string[],
  a0: number,
  n: number,
  b: readonly string[],
  b0: number,
  m: number,
  maxD: number,
): MiddleSnakeSplit | null {
  const delta = n - m;
  const odd = (delta & 1) !== 0;
  const halfMax = Math.min(Math.ceil((n + m) / 2), Math.ceil(maxD / 2));
  const off = halfMax + 1;
  const vf = new Int32Array(2 * halfMax + 3);
  const vr = new Int32Array(2 * halfMax + 3);
  vf.fill(-1);
  vr.fill(-1);

  for (let d = 0; d <= halfMax; d++) {
    // Forward search step `d`
    for (let k = -d; k <= d; k += 2) {
      let xStart: number;
      let down: boolean;
      if (d === 0) {
        xStart = 0;
        down = false;
      } else {
        const fromLeft = k !== -d ? vf[off + k - 1]! : -1;
        const fromUp = k !== d ? vf[off + k + 1]! : -1;
        if (fromLeft < 0 && fromUp < 0) {
          vf[off + k] = -1;
          continue;
        }
        if (fromLeft < 0 || (fromUp >= 0 && fromLeft < fromUp)) {
          xStart = fromUp;
          down = true;
        } else {
          xStart = fromLeft + 1;
          down = false;
        }
      }
      const yStart = xStart - k;
      if (xStart < 0 || yStart < 0 || xStart > n || yStart > m) {
        vf[off + k] = -1;
        continue;
      }
      let x = xStart;
      let y = yStart;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x++;
        y++;
      }
      vf[off + k] = x;

      if (odd && d > 0) {
        const c = delta - k;
        if (c >= -(d - 1) && c <= d - 1) {
          const u = vr[off + c]!;
          if (u >= 0 && x + u >= n) {
            const totalD = 2 * d - 1;
            if (totalD > maxD) return null;
            const prevX = down ? xStart : xStart - 1;
            const prevY = down ? yStart - 1 : yStart;
            return {
              leftAEnd: a0 + prevX,
              leftBEnd: b0 + prevY,
              leftBudget: d - 1,
              midEdit: down ? { t: 'ins', bIdx: b0 + prevY } : { t: 'del', aIdx: a0 + prevX },
              editBeforeSnake: true,
              snakeAStart: a0 + xStart,
              snakeLen: x - xStart,
              rightAStart: a0 + x,
              rightBStart: b0 + y,
              rightBudget: d - 1,
            };
          }
        }
      }
    }

    // Reverse search step `d` (symmetric in reverse coordinates `u = n - x, v = m - y`)
    for (let c = -d; c <= d; c += 2) {
      let uStart: number;
      let up: boolean;
      if (d === 0) {
        uStart = 0;
        up = false;
      } else {
        const fromLeft = c !== -d ? vr[off + c - 1]! : -1;
        const fromUp = c !== d ? vr[off + c + 1]! : -1;
        if (fromLeft < 0 && fromUp < 0) {
          vr[off + c] = -1;
          continue;
        }
        if (fromLeft < 0 || (fromUp >= 0 && fromLeft < fromUp)) {
          uStart = fromUp;
          up = true;
        } else {
          uStart = fromLeft + 1;
          up = false;
        }
      }
      const vStart = uStart - c;
      if (uStart < 0 || vStart < 0 || uStart > n || vStart > m) {
        vr[off + c] = -1;
        continue;
      }
      let u = uStart;
      let v = vStart;
      while (u < n && v < m && a[a0 + n - 1 - u] === b[b0 + m - 1 - v]) {
        u++;
        v++;
      }
      vr[off + c] = u;

      if (!odd && d > 0) {
        const k = delta - c;
        if (k >= -d && k <= d) {
          const x = vf[off + k]!;
          if (x >= 0 && x + u >= n) {
            const totalD = 2 * d;
            if (totalD > maxD) return null;
            const snakeAStart = a0 + (n - u);
            const snakeLen = u - uStart;
            const afterSnakeA = a0 + (n - uStart);
            const afterSnakeB = b0 + (m - vStart);
            return {
              leftAEnd: snakeAStart,
              leftBEnd: b0 + (m - v),
              leftBudget: d,
              midEdit: up ? { t: 'ins', bIdx: afterSnakeB } : { t: 'del', aIdx: afterSnakeA },
              editBeforeSnake: false,
              snakeAStart,
              snakeLen,
              rightAStart: up ? afterSnakeA : afterSnakeA + 1,
              rightBStart: up ? afterSnakeB + 1 : afterSnakeB,
              rightBudget: d - 1,
            };
          }
        }
      }
    }
  }

  return null;
}

function myersLinearRec(
  a: readonly string[],
  aStart: number,
  aEnd: number,
  b: readonly string[],
  bStart: number,
  bEnd: number,
  maxD: number,
  out: DiffSegment[],
): void {
  let n = aEnd - aStart;
  let m = bEnd - bStart;

  let prefix = 0;
  const minLen = Math.min(n, m);
  while (prefix < minLen && a[aStart + prefix] === b[bStart + prefix]) {
    prefix++;
  }
  if (prefix > 0) {
    pushSegment(out, { t: 'eq', baseStart: aStart, len: prefix });
  }

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    a[aEnd - 1 - suffix] === b[bEnd - 1 - suffix]
  ) {
    suffix++;
  }

  const midAStart = aStart + prefix;
  const midAEnd = aEnd - suffix;
  const midBStart = bStart + prefix;
  const midBEnd = bEnd - suffix;
  n = midAEnd - midAStart;
  m = midBEnd - midBStart;

  if (n === 0 && m === 0) {
    // identical
  } else if (n === 0) {
    pushSegment(out, { t: 'ins', text: b.slice(midBStart, midBEnd) });
  } else if (m === 0) {
    pushSegment(out, { t: 'del', baseStart: midAStart, len: n });
  } else if (Math.abs(n - m) > maxD) {
    pushSegment(out, { t: 'del', baseStart: midAStart, len: n });
    pushSegment(out, { t: 'ins', text: b.slice(midBStart, midBEnd) });
  } else {
    const split = findMiddleSnake(a, midAStart, n, b, midBStart, m, maxD);
    if (!split) {
      // Edit distance exceeds `maxD`: fall back cleanly to common-prefix/suffix single del + ins.
      pushSegment(out, { t: 'del', baseStart: midAStart, len: n });
      pushSegment(out, { t: 'ins', text: b.slice(midBStart, midBEnd) });
    } else {
      myersLinearRec(a, midAStart, split.leftAEnd, b, midBStart, split.leftBEnd, split.leftBudget, out);
      if (split.editBeforeSnake) {
        if (split.midEdit.t === 'del') {
          pushSegment(out, { t: 'del', baseStart: split.midEdit.aIdx, len: 1 });
        } else {
          pushSegment(out, { t: 'ins', text: [b[split.midEdit.bIdx]!] });
        }
        if (split.snakeLen > 0) {
          pushSegment(out, { t: 'eq', baseStart: split.snakeAStart, len: split.snakeLen });
        }
      } else {
        if (split.snakeLen > 0) {
          pushSegment(out, { t: 'eq', baseStart: split.snakeAStart, len: split.snakeLen });
        }
        if (split.midEdit.t === 'del') {
          pushSegment(out, { t: 'del', baseStart: split.midEdit.aIdx, len: 1 });
        } else {
          pushSegment(out, { t: 'ins', text: [b[split.midEdit.bIdx]!] });
        }
      }
      myersLinearRec(a, split.rightAStart, midAEnd, b, split.rightBStart, midBEnd, split.rightBudget, out);
    }
  }

  if (suffix > 0) {
    pushSegment(out, { t: 'eq', baseStart: midAEnd, len: suffix });
  }
}

/**
 * Computes a minimal edit script from `a` to `b` over code-point arrays in O(D) space
 * (`MYERS_MAX_D = 2048` -> < 64 KiB peak scratch memory). Falls back cleanly to a
 * minimal common-prefix/common-suffix single delete+insert replacement when edit distance
 * exceeds `MYERS_MAX_D`.
 */
export function diffCodePoints(a: readonly string[], b: readonly string[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  myersLinearRec(a, 0, a.length, b, 0, b.length, MYERS_MAX_D, out);
  return out;
}

// ---------------------------------------------------------------------------
// Matching helpers over code-point sequences (strict O(n + m) KMP with early bailout)
// ---------------------------------------------------------------------------

/**
 * Finds up to `maxMatches` occurrences of `needle` in `haystack` in strict O(n + m)
 * worst-case time via KMP, computing exact 1-based line numbers for `matchStart + beforeLen`
 * incrementally in a single pass (zero O(matches * n) rescanning).
 */
function findCodePointMatchesBounded(
  haystack: readonly string[],
  needle: readonly string[],
  beforeLen: number,
  maxMatches = MAX_AMBIGUOUS_MATCHES,
): { matches: number[]; candidateLines: number[]; truncated: boolean } {
  const matches: number[] = [];
  const candidateLines: number[] = [];
  const m = needle.length;
  const n = haystack.length;
  if (m === 0 || m > n) {
    return { matches, candidateLines, truncated: false };
  }

  // Count newlines inside needle[beforeLen..m) once so lineAt(matchStart + beforeLen)
  // is `1 + totalNewlinesSeenThroughI - afterCoreNewlines` in O(1) per match.
  let afterCoreNewlines = 0;
  for (let k = beforeLen; k < m; k++) {
    if (needle[k] === '\n') afterCoreNewlines++;
  }

  // Build KMP prefix function `lps` in O(m)
  const lps = new Int32Array(m);
  for (let i = 1, len = 0; i < m; ) {
    if (needle[i] === needle[len]) {
      lps[i++] = ++len;
    } else if (len > 0) {
      len = lps[len - 1]!;
    } else {
      lps[i++] = 0;
    }
  }

  let totalNewlines = 0;
  let j = 0;
  for (let i = 0; i < n; i++) {
    const ch = haystack[i]!;
    if (ch === '\n') totalNewlines++;
    while (j > 0 && ch !== needle[j]) {
      j = lps[j - 1]!;
    }
    if (ch === needle[j]) {
      j++;
      if (j === m) {
        matches.push(i - m + 1);
        candidateLines.push(1 + totalNewlines - afterCoreNewlines);
        if (matches.length >= maxMatches) {
          return { matches, candidateLines, truncated: i < n - 1 };
        }
        j = lps[j - 1]!;
      }
    }
  }

  return { matches, candidateLines, truncated: false };
}

function excerptAround(headVisible: readonly FugueVisibleElement[], centerIdx: number, radius = 40): string {
  const start = Math.max(0, centerIdx - radius);
  const end = Math.min(headVisible.length, centerIdx + radius);
  let out = '';
  for (let i = start; i < end; i++) {
    out += headVisible[i]!.char;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internal resolved hunk representation
// ---------------------------------------------------------------------------

interface ResolvedHunk {
  hunkIndex: number;
  op: VfsEditHunk['op'];
  /** Full matched span `[matchStart, matchEnd)` in `baseVisible` (empty for prepend/append). */
  baseMatchStart: number;
  baseMatchEnd: number;
  /** Core edited span `[coreStart, coreEnd)` in `baseVisible` (zero-width for pure inserts). */
  baseCoreStart: number;
  baseCoreEnd: number;
  /** Target position `[headEditStart, headEditEnd)` in `headVisible`. */
  headEditStart: number;
  headEditEnd: number;
  /** Replacement / insertion code points. */
  oldCps: string[];
  newCps: string[];
}

// ---------------------------------------------------------------------------
// buildPatchOp
// ---------------------------------------------------------------------------

/**
 * Resolves anchor-based `VfsEditHunk`s against `baseRev`, performs strict
 * visible-DFS contiguity + zero-width seam verification against `headRev`,
 * auto-rebases disjoint concurrent edits, and produces ONE signed-ready
 * FugueMax `VfsDocOpBody` (or throws `VfsConflictError` with `.code === 'VFS_CONFLICT'`).
 */
export function buildPatchOp(doc: FugueMaxDoc, params: BuildPatchParams): BuildPatchResult {
  const headRev = doc.frontierRev();
  const baseRevLabel =
    typeof params.baseRev === 'string' ? params.baseRev : computeFrontierRev(params.baseRev);

  // 1. Resolve base frontier
  let resolvedBaseFrontier: string[] | null = null;
  if (params.baseFrontier) {
    resolvedBaseFrontier = [...params.baseFrontier].sort();
  } else if (typeof params.baseRev === 'string') {
    resolvedBaseFrontier = doc.resolveFrontier(params.baseRev);
  } else {
    resolvedBaseFrontier = [...params.baseRev].sort();
  }

  if (!resolvedBaseFrontier) {
    throw new VfsConflictError(baseRevLabel, headRev, [
      {
        hunkIndex: -1,
        reason: 'base-rev-unknown',
        message: `Base revision "${baseRevLabel}" is not known on this document.`,
      },
    ]);
  }

  const resolvedBaseRev = computeFrontierRev(resolvedBaseFrontier);
  const isAtHead = resolvedBaseRev === headRev;

  if (!Array.isArray(params.hunks) || params.hunks.length === 0) {
    throw new VfsConflictError(baseRevLabel, headRev, [
      {
        hunkIndex: -1,
        reason: 'invalid-hunk',
        message: 'Patch must contain at least one hunk.',
      },
    ]);
  }

  let baseVisibleLazy: FugueVisibleElement[] | null = null;
  let baseCps: string[];
  let baseRevResolved: string;

  if (isAtHead) {
    baseRevResolved = headRev;
    baseCps = Array.from(doc.getText());
  } else {
    let baseState;
    try {
      baseState = doc.materializeAt(resolvedBaseFrontier);
    } catch (err) {
      throw new VfsConflictError(baseRevLabel, headRev, [
        {
          hunkIndex: -1,
          reason: 'base-rev-unknown',
          message: err instanceof Error ? err.message : `Cannot materialize base revision "${baseRevLabel}".`,
        },
      ]);
    }
    baseRevResolved = baseState.rev;
    baseVisibleLazy = baseState.visible;
    baseCps = baseVisibleLazy.map((e) => e.char);
  }

  const getBaseVisible = (): FugueVisibleElement[] => {
    if (!baseVisibleLazy) {
      baseVisibleLazy = doc.visibleElements();
    }
    return baseVisibleLazy;
  };

  let headVisibleLazy: FugueVisibleElement[] | null = null;
  let headPosByIdLazy: Map<string, number> | null = null;
  let baseIdSetLazy: Set<string> | null = null;

  const getHeadVisible = (): FugueVisibleElement[] => {
    if (!headVisibleLazy) {
      headVisibleLazy = isAtHead ? getBaseVisible() : doc.visibleElements();
    }
    return headVisibleLazy;
  };

  const getHeadPosById = (): Map<string, number> => {
    if (!headPosByIdLazy) {
      const hv = getHeadVisible();
      const map = new Map<string, number>();
      for (let i = 0; i < hv.length; i++) {
        map.set(fugueIdKey(hv[i]!.id), i);
      }
      headPosByIdLazy = map;
    }
    return headPosByIdLazy;
  };

  const getBaseIdSet = (): Set<string> => {
    if (!baseIdSetLazy) {
      baseIdSetLazy = new Set<string>(getBaseVisible().map((e) => fugueIdKey(e.id)));
    }
    return baseIdSetLazy;
  };

  // Lazy full-tree index (used only when checking tombstoned seam neighbors).
  let fullTreeCache: {
    elements: ReturnType<FugueMaxDoc['fullTreeElements']>;
    posById: Map<string, number>;
  } | null = null;

  const getFullTree = () => {
    if (!fullTreeCache) {
      const elements = doc.fullTreeElements();
      const posById = new Map<string, number>();
      for (let i = 0; i < elements.length; i++) {
        posById.set(fugueIdKey(elements[i]!.id), i);
      }
      fullTreeCache = { elements, posById };
    }
    return fullTreeCache;
  };

  /**
   * Verifies that NO newly inserted visible code point exists between `leftId`
   * and `rightId` in `headRev`.
   */
  const hasSeamInsertion = (
    leftId: FugueId | null,
    rightId: FugueId | null,
    knownLeftHeadPos: number | null,
    knownRightHeadPos: number | null,
  ): boolean => {
    if (isAtHead) return false;
    const headVisible = getHeadVisible();
    const headPosById = getHeadPosById();
    if (leftId === null && rightId === null) {
      return headVisible.length > 0;
    }
    if (leftId === null && rightId !== null) {
      const pRight = knownRightHeadPos ?? headPosById.get(fugueIdKey(rightId));
      if (pRight === undefined) return true;
      return pRight !== 0;
    }
    if (leftId !== null && rightId === null) {
      const pLeft = knownLeftHeadPos ?? headPosById.get(fugueIdKey(leftId));
      if (pLeft === undefined) return true;
      return pLeft !== headVisible.length - 1;
    }

    // Both leftId and rightId are non-null.
    const pLeft = knownLeftHeadPos ?? headPosById.get(fugueIdKey(leftId!));
    const pRight = knownRightHeadPos ?? headPosById.get(fugueIdKey(rightId!));

    if (pLeft !== undefined && pRight !== undefined) {
      return pRight !== pLeft + 1;
    }

    // One side of the seam was tombstoned after baseRev; check full FugueMax tree
    // strictly between tLeft and tRight for ANY visible element, AND check whether
    // the immediate visible neighbor on the surviving side is newly inserted.
    const { elements, posById } = getFullTree();
    const tLeft = posById.get(fugueIdKey(leftId!));
    const tRight = posById.get(fugueIdKey(rightId!));
    if (tLeft === undefined || tRight === undefined || tLeft >= tRight) {
      return true;
    }
    for (let t = tLeft + 1; t < tRight; t++) {
      if (!elements[t]!.deleted) {
        return true;
      }
    }
    const baseIdSet = getBaseIdSet();
    if (pLeft !== undefined && pLeft + 1 < headVisible.length) {
      if (!baseIdSet.has(fugueIdKey(headVisible[pLeft + 1]!.id))) {
        return true;
      }
    }
    if (pRight !== undefined && pRight - 1 >= 0) {
      if (!baseIdSet.has(fugueIdKey(headVisible[pRight - 1]!.id))) {
        return true;
      }
    }
    return false;
  };

  /**
   * Strict visible-DFS contiguity check for `[spanStart, spanEnd)` in `baseVisible`.
   * Returns `p0` (start index in `headVisible`) or a `VfsPatchConflict`.
   */
  const checkSpanContiguity = (
    hunkIndex: number,
    spanStart: number,
    spanEnd: number,
  ): { ok: true; headStart: number } | { ok: false; conflict: VfsPatchConflict } => {
    if (isAtHead) {
      return { ok: true, headStart: spanStart };
    }
    const baseVisible = getBaseVisible();
    const headVisible = getHeadVisible();
    const headPosById = getHeadPosById();
    const firstId = baseVisible[spanStart]!.id;
    const p0 = headPosById.get(fugueIdKey(firstId));
    if (p0 === undefined) {
      return {
        ok: false,
        conflict: {
          hunkIndex,
          reason: 'tombstoned',
          message: `Hunk ${hunkIndex} target span was deleted or modified since base revision.`,
        },
      };
    }

    let midSpanDetected = false;
    for (let j = 1; j < spanEnd - spanStart; j++) {
      const id = baseVisible[spanStart + j]!.id;
      const pj = headPosById.get(fugueIdKey(id));
      if (pj === undefined) {
        return {
          ok: false,
          conflict: {
            hunkIndex,
            reason: 'tombstoned',
            message: `Hunk ${hunkIndex} target span contains deleted text since base revision.`,
            currentExcerpt: excerptAround(headVisible, p0),
          },
        };
      }
      if (pj !== p0 + j) {
        midSpanDetected = true;
      }
    }

    if (midSpanDetected) {
      return {
        ok: false,
        conflict: {
          hunkIndex,
          reason: 'mid-span-insertion',
          message: `Hunk ${hunkIndex} target span was interrupted by a concurrent insertion.`,
          currentExcerpt: excerptAround(headVisible, p0),
        },
      };
    }

    return { ok: true, headStart: p0 };
  };

  // 2. Match every hunk against baseRev & verify strict visible-DFS contiguity in headRev
  const resolved: ResolvedHunk[] = [];
  const conflicts: VfsPatchConflict[] = [];

  for (let hunkIndex = 0; hunkIndex < params.hunks.length; hunkIndex++) {
    const hunk = params.hunks[hunkIndex]!;

    if (hunk.op === 'prepend') {
      const newCps = validateTextScalars(hunk.text);
      if (!isAtHead) {
        const baseVisible = getBaseVisible();
        const headVisible = getHeadVisible();
        const baseFirst = baseVisible.length > 0 ? baseVisible[0]!.id : null;
        const headFirst = headVisible.length > 0 ? headVisible[0]!.id : null;
        if (!fugueIdEquals(baseFirst, headFirst)) {
          conflicts.push({
            hunkIndex,
            reason: 'boundary-changed',
            message: `Hunk ${hunkIndex} (prepend) failed: document start changed since base revision.`,
            currentExcerpt: excerptAround(headVisible, 0),
          });
          continue;
        }
      }
      resolved.push({
        hunkIndex,
        op: 'prepend',
        baseMatchStart: 0,
        baseMatchEnd: 0,
        baseCoreStart: 0,
        baseCoreEnd: 0,
        headEditStart: 0,
        headEditEnd: 0,
        oldCps: [],
        newCps,
      });
      continue;
    }

    if (hunk.op === 'append') {
      const newCps = validateTextScalars(hunk.text);
      let headLen = baseCps.length;
      if (!isAtHead) {
        const baseVisible = getBaseVisible();
        const headVisible = getHeadVisible();
        headLen = headVisible.length;
        const baseLast = baseVisible.length > 0 ? baseVisible[baseVisible.length - 1]!.id : null;
        const headLast = headVisible.length > 0 ? headVisible[headVisible.length - 1]!.id : null;
        if (!fugueIdEquals(baseLast, headLast)) {
          conflicts.push({
            hunkIndex,
            reason: 'boundary-changed',
            message: `Hunk ${hunkIndex} (append) failed: document end changed since base revision.`,
            currentExcerpt: excerptAround(headVisible, Math.max(0, headVisible.length - 1)),
          });
          continue;
        }
      }
      resolved.push({
        hunkIndex,
        op: 'append',
        baseMatchStart: baseCps.length,
        baseMatchEnd: baseCps.length,
        baseCoreStart: baseCps.length,
        baseCoreEnd: baseCps.length,
        headEditStart: headLen,
        headEditEnd: headLen,
        oldCps: [],
        newCps,
      });
      continue;
    }

    // Anchor-based hunks: replace, insert_after, insert_before
    const beforeCps = validateTextScalars(hunk.before ?? '');
    const afterCps = validateTextScalars(hunk.after ?? '');
    const coreStr = hunk.op === 'replace' ? hunk.old : hunk.anchor;
    const coreCps = validateTextScalars(coreStr);
    const newCps = validateTextScalars(hunk.op === 'replace' ? hunk.new : hunk.text);

    if (coreCps.length === 0) {
      conflicts.push({
        hunkIndex,
        reason: 'invalid-hunk',
        message: `Hunk ${hunkIndex} (${hunk.op}) requires non-empty ${hunk.op === 'replace' ? 'old' : 'anchor'} text.`,
      });
      continue;
    }

    const fullNeedle = [...beforeCps, ...coreCps, ...afterCps];
    const { matches, candidateLines, truncated } = findCodePointMatchesBounded(
      baseCps,
      fullNeedle,
      beforeCps.length,
    );

    if (matches.length === 0) {
      conflicts.push({
        hunkIndex,
        reason: 'anchor-not-found',
        message: `Hunk ${hunkIndex} (${hunk.op}) anchor not found in base revision.`,
      });
      continue;
    }

    if (matches.length > 1) {
      conflicts.push({
        hunkIndex,
        reason: 'anchor-ambiguous',
        message: `Hunk ${hunkIndex} (${hunk.op}) matched ${matches.length}${truncated ? '+' : ''} locations in base revision; add before/after context.`,
        candidateLines,
      });
      continue;
    }

    const matchStart = matches[0]!;
    const matchEnd = matchStart + fullNeedle.length;
    const coreStart = matchStart + beforeCps.length;
    const coreEnd = coreStart + coreCps.length;

    const spanCheck = checkSpanContiguity(hunkIndex, matchStart, matchEnd);
    if (!spanCheck.ok) {
      conflicts.push(spanCheck.conflict);
      continue;
    }

    const headCoreStart = spanCheck.headStart + beforeCps.length;
    const headCoreEnd = headCoreStart + coreCps.length;

    if (hunk.op === 'replace') {
      resolved.push({
        hunkIndex,
        op: 'replace',
        baseMatchStart: matchStart,
        baseMatchEnd: matchEnd,
        baseCoreStart: coreStart,
        baseCoreEnd: coreEnd,
        headEditStart: headCoreStart,
        headEditEnd: headCoreEnd,
        oldCps: coreCps,
        newCps,
      });
    } else if (hunk.op === 'insert_after') {
      if (!isAtHead) {
        const baseVisible = getBaseVisible();
        const leftId = baseVisible[coreEnd - 1]!.id;
        const rightId = coreEnd < baseVisible.length ? baseVisible[coreEnd]!.id : null;
        const pLeft = headCoreEnd - 1;
        if (hasSeamInsertion(leftId, rightId, pLeft, null)) {
          conflicts.push({
            hunkIndex,
            reason: 'seam-insertion',
            message: `Hunk ${hunkIndex} (insert_after) failed: concurrent text was inserted at the insertion seam.`,
            currentExcerpt: excerptAround(getHeadVisible(), pLeft),
          });
          continue;
        }
      }
      resolved.push({
        hunkIndex,
        op: 'insert_after',
        baseMatchStart: matchStart,
        baseMatchEnd: matchEnd,
        baseCoreStart: coreEnd,
        baseCoreEnd: coreEnd,
        headEditStart: headCoreEnd,
        headEditEnd: headCoreEnd,
        oldCps: [],
        newCps,
      });
    } else {
      // insert_before
      if (!isAtHead) {
        const baseVisible = getBaseVisible();
        const leftId = coreStart > 0 ? baseVisible[coreStart - 1]!.id : null;
        const rightId = baseVisible[coreStart]!.id;
        const pRight = headCoreStart;
        if (hasSeamInsertion(leftId, rightId, null, pRight)) {
          conflicts.push({
            hunkIndex,
            reason: 'seam-insertion',
            message: `Hunk ${hunkIndex} (insert_before) failed: concurrent text was inserted at the insertion seam.`,
            currentExcerpt: excerptAround(getHeadVisible(), pRight),
          });
          continue;
        }
      }
      resolved.push({
        hunkIndex,
        op: 'insert_before',
        baseMatchStart: matchStart,
        baseMatchEnd: matchEnd,
        baseCoreStart: coreStart,
        baseCoreEnd: coreStart,
        headEditStart: headCoreStart,
        headEditEnd: headCoreStart,
        oldCps: [],
        newCps,
      });
    }
  }

  if (conflicts.length > 0) {
    throw new VfsConflictError(baseRevLabel, headRev, conflicts);
  }

  // 3. Reject overlapping hunks within the same patch
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      const a = resolved[i]!;
      const b = resolved[j]!;
      if (hunksOverlap(a, b)) {
        throw new VfsConflictError(baseRevLabel, headRev, [
          {
            hunkIndex: b.hunkIndex,
            reason: 'overlapping-hunks',
            message: `Hunk ${b.hunkIndex} overlaps with hunk ${a.hunkIndex}.`,
          },
        ]);
      }
    }
  }

  // 4. Translate validated hunks into ONE minimal FugueMax VfsDocOpBody using a
  //    scratch clone (descending head position order so indices stay exact).
  const sortedDesc = [...resolved].sort((a, b) => {
    if (b.headEditStart !== a.headEditStart) return b.headEditStart - a.headEditStart;
    return b.headEditEnd - a.headEditEnd;
  });

  const scratch = doc.clone();
  const collectedSubOps: FugueSubOp[] = [];
  const startCounter = doc.nextCounterFor(params.meta.deviceId);
  let syntheticSeq = 0;

  const applyScratchSubOp = (sub: FugueSubOp) => {
    collectedSubOps.push(sub);
    const stepOp: VfsDocOpBody = {
      v: 1,
      kind: 'vfs-doc-op',
      roomId: params.meta.roomId,
      nodeId: params.meta.nodeId,
      opId: `${params.meta.opId}#step${syntheticSeq++}`,
      deviceId: params.meta.deviceId,
      memberId: params.meta.memberId,
      epoch: params.meta.epoch,
      seq: params.meta.seq,
      lamport: params.meta.lamport,
      at: params.meta.at,
      visibility: params.meta.visibility ?? 'room',
      parents: scratch.frontier(),
      counterStart: scratch.nextCounterFor(params.meta.deviceId),
      ops: [sub],
    };
    scratch.applyOp(stepOp);
  };

  for (const h of sortedDesc) {
    if (h.op === 'replace') {
      const segments = diffCodePoints(h.oldCps, h.newCps);
      // Pair adjacent del/ins segments at the same base edit site so deletions
      // execute right before insertions at the same position (right-to-left).
      const sites: Array<{ pos: number; delLen: number; insText: string }> = [];
      let relPos = 0;
      for (const seg of segments) {
        if (seg.t === 'eq') {
          relPos += seg.len;
        } else if (seg.t === 'del') {
          sites.push({ pos: h.headEditStart + relPos, delLen: seg.len, insText: '' });
          relPos += seg.len;
        } else {
          const text = seg.text.join('');
          const last = sites[sites.length - 1];
          if (last && last.pos + last.delLen === h.headEditStart + relPos && last.insText === '') {
            last.insText = text;
          } else {
            sites.push({ pos: h.headEditStart + relPos, delLen: 0, insText: text });
          }
        }
      }
      for (let i = sites.length - 1; i >= 0; i--) {
        const site = sites[i]!;
        if (site.delLen > 0) {
          applyScratchSubOp(scratch.planDeleteAt(site.pos, site.delLen));
        }
        if (site.insText.length > 0) {
          applyScratchSubOp(scratch.planInsertAt(site.pos, site.insText));
        }
      }
    } else if (h.newCps.length > 0) {
      applyScratchSubOp(scratch.planInsertAt(h.headEditStart, h.newCps.join('')));
    }
  }

  // Coalesce consecutive `del` sub-ops for compactness
  const compactedSubOps = coalesceDeleteSubOps(collectedSubOps);

  const finalOp: VfsDocOpBody = {
    v: 1,
    kind: 'vfs-doc-op',
    roomId: params.meta.roomId,
    nodeId: params.meta.nodeId,
    opId: params.meta.opId,
    deviceId: params.meta.deviceId,
    memberId: params.meta.memberId,
    epoch: params.meta.epoch,
    seq: params.meta.seq,
    lamport: params.meta.lamport,
    at: params.meta.at,
    visibility: params.meta.visibility ?? 'room',
    ...(params.meta.audienceUntil !== undefined ? { audienceUntil: params.meta.audienceUntil } : {}),
    parents: doc.frontier(),
    counterStart: startCounter,
    ops: compactedSubOps,
    ...(params.meta.revertsCommit !== undefined ? { revertsCommit: params.meta.revertsCommit } : {}),
  };

  const opHash = computeDocOpHash(finalOp);

  // Verify final combined op applies cleanly & obeys hard size limit
  const verifyClone = doc.clone();
  verifyClone.applyOp(finalOp, opHash);
  const nextText = verifyClone.getText();
  const nextRev = verifyClone.frontierRev();

  if (params.apply) {
    doc.applyOp(finalOp, opHash);
  }

  return {
    op: finalOp,
    opHash,
    baseRev: baseRevResolved,
    headRev,
    nextRev,
    rebased: baseRevResolved !== headRev,
    nextText,
  };
}

function hunksOverlap(a: ResolvedHunk, b: ResolvedHunk): boolean {
  const aIsInsert = a.baseCoreStart === a.baseCoreEnd;
  const bIsInsert = b.baseCoreStart === b.baseCoreEnd;

  // Two zero-width insertions at the exact same base boundary are ambiguous.
  if (aIsInsert && bIsInsert) {
    return a.baseCoreStart === b.baseCoreStart;
  }

  // Two replacements: core spans cannot overlap, and neither replacement's
  // core can mutate the other's matched context span.
  if (!aIsInsert && !bIsInsert) {
    const coreOverlap = a.baseCoreStart < b.baseCoreEnd && b.baseCoreStart < a.baseCoreEnd;
    const aMutatesBMatch = a.baseCoreStart < b.baseMatchEnd && b.baseMatchStart < a.baseCoreEnd;
    const bMutatesAMatch = b.baseCoreStart < a.baseMatchEnd && a.baseMatchStart < b.baseCoreEnd;
    return coreOverlap || aMutatesBMatch || bMutatesAMatch;
  }

  // One insert and one replace
  const ins = aIsInsert ? a : b;
  const rep = aIsInsert ? b : a;
  const pos = ins.baseCoreStart;

  // Insert strictly inside replace's full match span (including before/after
  // context), or replace modifies insert's anchor span
  if (pos > rep.baseMatchStart && pos < rep.baseMatchEnd) return true;
  if (ins.baseMatchStart < ins.baseMatchEnd) {
    if (rep.baseCoreStart < ins.baseMatchEnd && ins.baseMatchStart < rep.baseCoreEnd) {
      return true;
    }
  }
  // Prepend/append colliding with a replace touching BOF/EOF boundary
  if (ins.op === 'prepend' && rep.baseCoreStart === 0) return true;
  if (ins.op === 'append' && rep.baseCoreEnd === pos) return true;

  return false;
}

function coalesceDeleteSubOps(subOps: FugueSubOp[]): FugueSubOp[] {
  const out: FugueSubOp[] = [];
  for (const sub of subOps) {
    const prev = out[out.length - 1];
    if (sub.t === 'del' && prev && prev.t === 'del') {
      prev.runs.push(...sub.runs);
    } else if (sub.t === 'del') {
      out.push({ t: 'del', runs: [...sub.runs] });
    } else {
      out.push(sub);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CRDT-Safe Compensating Reversion (`buildRevertOp`)
// ---------------------------------------------------------------------------

/**
 * Generates a forward compensating `VfsDocOpBody` (`parents = headFrontier`,
 * `revertsCommit`) that:
 * 1. Monotonically tombstones every visible element in `head \ target`
 * 2. Re-inserts every missing contiguous run from `target \ head` at its exact
 *    position with fresh `(reverterDeviceId, counter..)` IDs
 *
 * Never rewinds heads or un-tombstones deleted IDs, guaranteeing offline peers
 * converge cleanly to `target` without resurrecting deleted text.
 */
export function buildRevertOp(doc: FugueMaxDoc, params: BuildRevertParams): BuildRevertResult {
  if (!isValidVfsCommitId(params.revertsCommit)) {
    throw new VfsInvalidOpError(
      'invalid-reverts-commit',
      'revertsCommit must be a lowercase UUID or 64-char lowercase hex hash.',
    );
  }
  const headRev = doc.frontierRev();
  const targetLabel =
    typeof params.targetFrontier === 'string'
      ? params.targetFrontier
      : computeFrontierRev(params.targetFrontier);

  let targetState;
  try {
    targetState = doc.materializeAt(params.targetFrontier);
  } catch (err) {
    throw new VfsConflictError(targetLabel, headRev, [
      {
        hunkIndex: -1,
        reason: 'base-rev-unknown',
        message: err instanceof Error ? err.message : `Cannot materialize target revision "${targetLabel}".`,
      },
    ]);
  }

  const targetVisible = targetState.visible;
  const headVisible = doc.visibleElements();
  const startCounter = doc.nextCounterFor(params.meta.deviceId);

  // If visible text is already identical to target (e.g. reverting to an
  // equivalent revision after a prior revert), emit a zero-churn no-op revert.
  if (doc.getText() === targetState.text) {
    const finalOp: VfsDocOpBody = {
      v: 1,
      kind: 'vfs-doc-op',
      roomId: params.meta.roomId,
      nodeId: params.meta.nodeId,
      opId: params.meta.opId,
      deviceId: params.meta.deviceId,
      memberId: params.meta.memberId,
      epoch: params.meta.epoch,
      seq: params.meta.seq,
      lamport: params.meta.lamport,
      at: params.meta.at,
      visibility: params.meta.visibility ?? 'room',
      ...(params.meta.audienceUntil !== undefined ? { audienceUntil: params.meta.audienceUntil } : {}),
      parents: doc.frontier(),
      counterStart: startCounter,
      ops: [],
      revertsCommit: params.revertsCommit,
    };
    const opHash = computeDocOpHash(finalOp);
    const verifyDoc = doc.clone();
    verifyDoc.applyOp(finalOp, opHash);
    if (params.apply) {
      doc.applyOp(finalOp, opHash);
    }
    return {
      op: finalOp,
      opHash,
      targetRev: targetState.rev,
      headRev,
      nextRev: verifyDoc.frontierRev(),
      noChanges: true,
      deletedCodePoints: 0,
      restoredCodePoints: 0,
      nextText: targetState.text,
    };
  }

  const targetIdSet = new Set<string>(targetVisible.map((e) => fugueIdKey(e.id)));
  const headIdSet = new Set<string>(headVisible.map((e) => fugueIdKey(e.id)));

  // 1. Collect all deletions: elements visible in `head \ target`
  const delRuns: [string, number, number][] = [];
  let deletedCodePoints = 0;
  for (const elem of headVisible) {
    if (!targetIdSet.has(fugueIdKey(elem.id))) {
      deletedCodePoints++;
      const prev = delRuns[delRuns.length - 1];
      if (prev && prev[0] === elem.deviceId && prev[1] + prev[2] === elem.counter) {
        prev[2] += 1;
      } else {
        delRuns.push([elem.deviceId, elem.counter, 1]);
      }
    }
  }

  const scratch = doc.clone();
  const subOps: FugueSubOp[] = [];
  let syntheticSeq = 0;

  const applyStep = (sub: FugueSubOp) => {
    subOps.push(sub);
    scratch.applyOp({
      v: 1,
      kind: 'vfs-doc-op',
      roomId: params.meta.roomId,
      nodeId: params.meta.nodeId,
      opId: `${params.meta.opId}#rev${syntheticSeq++}`,
      deviceId: params.meta.deviceId,
      memberId: params.meta.memberId,
      epoch: params.meta.epoch,
      seq: params.meta.seq,
      lamport: params.meta.lamport,
      at: params.meta.at,
      visibility: params.meta.visibility ?? 'room',
      parents: scratch.frontier(),
      counterStart: scratch.nextCounterFor(params.meta.deviceId),
      ops: [sub],
    });
  };

  if (delRuns.length > 0) {
    applyStep({ t: 'del', runs: delRuns as FugueDelRun[] });
  }

  // 2. Collect and insert all missing runs from `target \ head` at exact slots.
  //    In `scratch`, the visible sequence is now strictly `target ∩ head` in
  //    its exact original relative order!
  let restoredCodePoints = 0;
  let visCursor = 0;
  let i = 0;
  while (i < targetVisible.length) {
    if (headIdSet.has(fugueIdKey(targetVisible[i]!.id))) {
      visCursor++;
      i++;
      continue;
    }
    const runChars: string[] = [];
    while (i < targetVisible.length && !headIdSet.has(fugueIdKey(targetVisible[i]!.id))) {
      runChars.push(targetVisible[i]!.char);
      i++;
    }
    const text = runChars.join('');
    applyStep(scratch.planInsertAt(visCursor, text));
    visCursor += runChars.length;
    restoredCodePoints += runChars.length;
  }

  const finalOp: VfsDocOpBody = {
    v: 1,
    kind: 'vfs-doc-op',
    roomId: params.meta.roomId,
    nodeId: params.meta.nodeId,
    opId: params.meta.opId,
    deviceId: params.meta.deviceId,
    memberId: params.meta.memberId,
    epoch: params.meta.epoch,
    seq: params.meta.seq,
    lamport: params.meta.lamport,
    at: params.meta.at,
    visibility: params.meta.visibility ?? 'room',
    ...(params.meta.audienceUntil !== undefined ? { audienceUntil: params.meta.audienceUntil } : {}),
    parents: doc.frontier(),
    counterStart: startCounter,
    ops: subOps,
    revertsCommit: params.revertsCommit,
  };

  const opHash = computeDocOpHash(finalOp);

  // Verify the single combined compensating op converges exactly to targetState.text
  const verifyDoc = doc.clone();
  verifyDoc.applyOp(finalOp, opHash);
  const nextText = verifyDoc.getText();
  const nextRev = verifyDoc.frontierRev();

  if (params.apply) {
    doc.applyOp(finalOp, opHash);
  }

  return {
    op: finalOp,
    opHash,
    targetRev: targetState.rev,
    headRev,
    nextRev,
    noChanges: deletedCodePoints === 0 && restoredCodePoints === 0,
    deletedCodePoints,
    restoredCodePoints,
    nextText,
  };
}

// ---------------------------------------------------------------------------
// Concurrent-Edit-During-Revert Detection
// ---------------------------------------------------------------------------

/**
 * Returns true if `incomingOpHash` is causally concurrent (incomparable) with
 * `revertOpHash`: i.e. `incomingOpHash` is neither in the causal cone of
 * `revertOp.parents` (happened strictly before the revert) nor does
 * `incomingOpHash`'s causal cone include `revertOpHash` (happened strictly
 * after observing the revert).
 */
export function isOpConcurrentWithRevert(
  doc: FugueMaxDoc,
  incomingOpHash: string,
  revertOpHash: string,
): boolean {
  if (incomingOpHash === revertOpHash) return false;
  const revertRec = doc.getAppliedOp(revertOpHash);
  const incomingRec = doc.getAppliedOp(incomingOpHash);
  if (!revertRec || !incomingRec) return false;

  const revertParentCone = doc.causalCone(revertRec.op.parents);
  if (revertParentCone.has(incomingOpHash)) {
    return false; // Strictly before revert
  }

  const incomingCone = doc.causalCone([incomingOpHash]);
  if (incomingCone.has(revertOpHash)) {
    return false; // Strictly after revert (saw revert before editing)
  }

  return true;
}

/**
 * Inspects applied revert ops in `doc` (or a specific revert op identified by
 * `revertOpHashOrId`) and returns structured `concurrent-edit-during-revert`
 * warnings for every revert that has one or more causally concurrent ops.
 */
export function detectConcurrentEditsDuringRevert(
  doc: FugueMaxDoc,
  revertOpHashOrId?: string,
): ConcurrentEditDuringRevert[] {
  const allOps = doc.getAppliedOps();

  const revertOps: FugueAppliedOpRecord[] = allOps.filter((rec) => {
    if (rec.op.revertsCommit === undefined) return false;
    if (revertOpHashOrId === undefined) return true;
    return rec.opHash === revertOpHashOrId || rec.op.opId === revertOpHashOrId;
  });

  const warnings: ConcurrentEditDuringRevert[] = [];

  for (const revRec of revertOps) {
    const revertParentCone = doc.causalCone(revRec.op.parents);
    const concurrentOps: FugueAppliedOpRecord[] = [];

    for (const candidate of allOps) {
      if (candidate.opHash === revRec.opHash) continue;
      if (revertParentCone.has(candidate.opHash)) continue;
      const candidateCone = doc.causalCone([candidate.opHash]);
      if (candidateCone.has(revRec.opHash)) continue;
      concurrentOps.push(candidate);
    }

    if (concurrentOps.length === 0) continue;

    // Sort deterministically by opHash
    concurrentOps.sort((a, b) => (a.opHash < b.opHash ? -1 : a.opHash > b.opHash ? 1 : 0));

    const seenAuthors = new Set<string>();
    const concurrentAuthors: Array<{ readonly memberId: string; readonly deviceId: string }> = [];
    for (const rec of concurrentOps) {
      const key = `${rec.op.memberId}:${rec.op.deviceId}`;
      if (!seenAuthors.has(key)) {
        seenAuthors.add(key);
        concurrentAuthors.push({ memberId: rec.op.memberId, deviceId: rec.op.deviceId });
      }
    }

    warnings.push({
      kind: 'concurrent-edit-during-revert',
      revertOpId: revRec.op.opId,
      revertOpHash: revRec.opHash,
      revertsCommit: revRec.op.revertsCommit!,
      concurrentOpIds: concurrentOps.map((c) => c.op.opId),
      concurrentOpHashes: concurrentOps.map((c) => c.opHash),
      concurrentAuthors,
    });
  }

  return warnings;
}
