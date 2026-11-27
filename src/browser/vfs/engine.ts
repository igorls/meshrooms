/**
 * Unified Persistent Room VFS Engine (`VfsRoomEngine`) (`docs/flows/room-vfs.md`).
 *
 * Runtime-agnostic across `MemoryVfsStore`, `IndexedDbVfsStore`, `WormDbFfiVfsStore`,
 * and `BunFileVfsStore` — pure TypeScript + WebCrypto with zero Node/Bun-only imports.
 *
 * Responsibilities:
 * - Room Key-Epoch Ring (`VfsKeyring`) persistence (`vfsEpochKey`), host-only Epoch-1 bootstrap
 *   and forward rotation, buffered key-epoch/wrap assembly, and offline-host human key grants.
 * - Encrypted replicated document CRUD (`createDoc`, `writeDoc`, `patchDoc`, `revertDoc`,
 *   `deleteDoc`, `restoreDoc`, `readDoc`, `listDocs`, `history`, `diff`) over FugueMax CRDT,
 *   deterministic `VfsTreeOpBody` folding with `conflictPath` collision convergence, Decision 4
 *   soft-delete permissions, `requestId` idempotency, and `writeBeforePublish` crash ordering.
 * - P2P anti-entropy (`buildHave`, `handleHave`, `acceptRecord`, `acceptOps`) with O(1)
 *   `frontierHash`, bounded `<= 14 KB` / `<= 64` op pages, P-256 signature & revoked-device
 *   verification, periodic device-sealed `snap:*` checkpoints, and passive `VfsChangeEvent` feed.
 */

import { base64, encode, verify } from '../protocol';
import {
  base64ToBytes,
  bytesToBase64,
  canonicalJson,
  canonicalize,
  type RosterEntry,
  type SignFn,
  type SignedRoster,
} from '../relay-crypto';
import {
  VFS_DOC_HARD_LIMIT_BYTES,
  VFS_DOC_SOFT_LIMIT_BYTES,
  VFS_KEY_WRAP_SIG_DOMAIN,
  VFS_MAX_DOCS_MVP,
  VFS_MAX_DOCS_PER_MEMBER,
  VFS_MAX_LAMPORT_JUMP,
  VFS_MAX_RECEIPTS_PER_ACTOR,
  VFS_MAX_SEQ,
  VFS_PROTOCOL_VERSION,
  VFS_ROOT_DIR_ID,
  VFS_SNAP_EVERY_BYTES,
  VFS_SNAP_EVERY_OPS,
  VfsError,
  VfsObjKind,
  vfsCommitKey,
  vfsCommitPrefix,
  vfsEpochKey,
  vfsMetaKey,
  vfsNodeHeadKey,
  vfsObjKey,
  vfsOpKey,
  vfsReqKey,
  vfsRoomPrefix,
  vfsSnapKey,
  vfsSnapPrefix,
} from './constants';
import {
  deriveVfsDeviceSealKey,
  openSignedVfsOp,
  openVfsEnvelope,
  sealSignedVfsOp,
  sealVfsEnvelope,
  sha256Hex,
  utf8Bytes,
  type VfsSignedOpHeaderFields,
} from './envelope';
import {
  FugueMaxDoc,
  computeDocOpHash,
  computeFrontierRev,
  validateTextScalars,
  type FugueCheckpoint,
  type FugueLocalOpMeta,
  type VfsAuthorStamp,
  type VfsDocOpBody,
} from './fuguemax';
import {
  VfsKeyring,
  hashEpochHeaderBody,
  isValidKeyEpochHeaderShape,
  isValidKeyGrantPacketShape,
  isValidKeyWrapChunkShape,
  openEpochRecordFromStorage,
  sealEpochRecordForStorage,
  verifyKeyEpochHeader,
  type VfsEpochRecord,
  type VfsKeyEpochHeader,
  type VfsKeyGrantPacket as KeyringVfsKeyGrantPacket,
  type VfsKeyWrapChunk,
} from './keyring';
import {
  VfsConflictError,
  buildPatchOp,
  buildRevertOp,
  detectConcurrentEditsDuringRevert,
  type ConcurrentEditDuringRevert,
  type VfsEditHunk,
} from './patch';
import {
  conflictPath,
  foldVfsPath,
  normalizeVfsPath,
  utf8ByteLength,
} from './path';
import {
  validateVfsRoomId,
  writeBeforePublish,
  type VfsRoomStore,
} from './store';
import {
  VFS_HAVE_MAX_CONFLICT_IDS,
  VFS_HAVE_MAX_HEADS,
  chunkVfsOpsPages,
  computeVfsFrontierHash,
  decodeVfsRecordEnvelope,
  isVfsHavePacket,
  isVfsKeyEpochPacket,
  isVfsKeyGrantPacket,
  isVfsKeyWrapPacket,
  isVfsOpsPacket,
  isVfsRecordPacket,
  wrapKeyEpochPacket,
  wrapKeyGrantPacket,
  wrapKeyWrapPacket,
  type VfsHavePacket,
  type VfsKeyEpochPacket,
  type VfsKeyGrantPacket,
  type VfsKeyWrapPacket,
  type VfsOpsPacket,
  type VfsRecordObjKind,
  type VfsRecordPacket,
} from './wire';

const LOWER_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const MAX_PENDING_KEY_HEADERS = 32;
const MAX_PENDING_WRAP_CHUNKS_PER_HEADER = 64;
const MAX_CHANGE_FEED_EVENTS = 256;
/** Max JSON-encoded UTF-8 byte budget per insert op so every signed op stays safely under 12 KiB. */
const MAX_DOC_OP_INSERT_JSON_BYTES = 8 * 1024;
/** Max visible code points deleted per chunked delete op in `writeDoc` (stays well under 12 KiB & 65,536 run cap). */
const MAX_DOC_OP_DELETE_CODEPOINTS = 16_384;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

/** Splits validated text into chunks whose JSON-escaped UTF-8 length fits under `MAX_DOC_OP_INSERT_JSON_BYTES`. */
function splitTextForSignedOps(text: string): string[] {
  const cps = validateTextScalars(text);
  if (cps.length === 0) return [];
  if (utf8ByteLength(JSON.stringify(text)) <= MAX_DOC_OP_INSERT_JSON_BYTES) {
    return [text];
  }
  const chunks: string[] = [];
  let buf = '';
  let bufJsonBytes = 2; // surrounding quotes
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i]!;
    const chJsonBytes = utf8ByteLength(JSON.stringify(ch)) - 2;
    if (buf.length > 0 && bufJsonBytes + chJsonBytes > MAX_DOC_OP_INSERT_JSON_BYTES) {
      chunks.push(buf);
      buf = ch;
      bufJsonBytes = 2 + chJsonBytes;
    } else {
      buf += ch;
      bufJsonBytes += chJsonBytes;
    }
  }
  if (buf.length > 0) chunks.push(buf);
  return chunks;
}

// ---------------------------------------------------------------------------
// Error & Public Types
// ---------------------------------------------------------------------------

/** Permission rejection error (e.g. Decision 4 soft-delete/restore authorization). */
export class VfsUnauthorizedError extends Error {
  override readonly name = 'VfsUnauthorizedError';
  readonly code = 'VFS_UNAUTHORIZED' as const;
  readonly status = 403 as const;
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.details = details;
  }
}

export type VfsActorRole = 'human' | 'agent';

export type VfsSignerInfo = {
  deviceId: string;
  memberId: string;
  signPublicKey: string;
  role: VfsActorRole;
  /** When `true`, the device has been revoked and its records must be rejected. */
  revoked?: boolean;
};

export type VfsSignerLookup = (
  deviceId: string,
) => VfsSignerInfo | undefined | Promise<VfsSignerInfo | undefined>;

export type VfsKeyAcceptContext = {
  roster: SignedRoster;
  trustedPriorHosts?: Readonly<Record<string, string>>;
};

export type VfsTreeAction =
  | { t: 'create'; nodeKind: 'doc'; parentId: string; path: string; mime?: string }
  | { t: 'delete' }
  | { t: 'restore'; path?: string }
  | { t: 'rename'; path: string };

export type VfsTreeOpBody = VfsAuthorStamp & {
  kind: 'vfs-tree-op';
  nodeId: string;
  parents: string[];
  action: VfsTreeAction;
};

export type VfsCommitBody = VfsAuthorStamp & {
  kind: 'vfs-commit';
  commitId: string;
  scope: 'doc' | 'tree';
  nodeId: string;
  parentCommits: string[];
  docFrontier: string[];
  docRev: string;
  path?: string;
  contentSha256?: string;
  message?: string;
  revertsCommit?: string;
  revertOpHash?: string;
};

export type VfsDocSummary = {
  nodeId: string;
  /** Conflict-resolved display path (`notes (conflict-a1b2c3d4).md` on concurrent same-path creation). */
  path: string;
  /** Original un-suffixed NFC path stored in the tree op. */
  rawPath: string;
  hasConflict: boolean;
  rev: string;
  bytes: number;
  overSoftLimit: boolean;
  deleted: boolean;
  createdBy: string;
  updatedBy: string;
  updatedAt: number;
};

export type VfsReadDocResult = {
  nodeId: string;
  path: string;
  rawPath: string;
  rev: string;
  text: string;
  bytes: number;
  overSoftLimit: boolean;
  deleted: boolean;
  createdBy: string;
  updatedBy: string;
  updatedAt: number;
};

export type VfsWriteResult = {
  nodeId: string;
  path: string;
  rev: string;
  commitId: string;
  bytes: number;
  overSoftLimit: boolean;
  replayed: boolean;
  outbound: VfsRecordPacket[];
};

export type VfsPatchResult = VfsWriteResult & {
  baseRev: string;
  rebased: boolean;
};

export type VfsRevertResult = VfsWriteResult & {
  targetCommitId: string;
  noChanges: boolean;
  concurrentEditsDuringRevert: ConcurrentEditDuringRevert[];
};

export type VfsDeleteResult = {
  nodeId: string;
  path: string;
  deleted: boolean;
  commitId: string;
  replayed: boolean;
  outbound: VfsRecordPacket[];
};

export type VfsHistoryEntry = {
  commitId: string;
  scope: 'doc' | 'tree';
  nodeId: string;
  rev: string;
  docFrontier: string[];
  authorMemberId: string;
  authorDeviceId: string;
  at: number;
  lamport: number;
  message?: string;
  path?: string;
  revertsCommit?: string;
  concurrentEditsDuringRevert?: ConcurrentEditDuringRevert[];
};

export type VfsDiffLine = {
  type: 'context' | 'add' | 'del';
  text: string;
};

export type VfsDiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: VfsDiffLine[];
};

export type VfsDiffResult = {
  nodeId: string;
  path: string;
  fromRev: string;
  toRev: string;
  identical: boolean;
  addedLines: number;
  removedLines: number;
  hunks: VfsDiffHunk[];
  unified: string;
};

export type VfsChangeEventKind =
  | 'doc-created'
  | 'doc-updated'
  | 'doc-reverted'
  | 'doc-deleted'
  | 'doc-restored'
  | 'epoch-updated';

export type VfsChangeEvent = {
  cursor: number;
  kind: VfsChangeEventKind;
  roomId: string;
  nodeId?: string;
  path?: string;
  rev?: string;
  commitId?: string;
  epoch?: number;
  authorMemberId?: string;
  authorDeviceId?: string;
  at: number;
  source: 'self' | 'remote';
};

export type VfsAcceptRecordResult = {
  accepted: boolean;
  duplicate: boolean;
  buffered: boolean;
  cid: string;
  objKind: VfsRecordObjKind;
  nodeId: string;
  equivocationDetected?: boolean;
};

export type VfsAcceptOpsResult = {
  applied: number;
  duplicates: number;
  buffered: number;
  rejected: Array<{ cid: string; code: string; message: string }>;
};

export type VfsHandleHaveResult = {
  keyPackets: Array<VfsKeyEpochPacket | VfsKeyWrapPacket>;
  opsPages: VfsOpsPacket[];
};

export type VfsRoomEngineOptions = {
  roomId: string;
  store: VfsRoomStore;
  selfMemberId: string;
  selfDeviceId: string;
  selfRole?: VfsActorRole;
  /** Device ECDH private key (used to unwrap epoch keys & derive `deviceSealKey` if omitted). */
  selfEncPrivateKey?: CryptoKey;
  /** Alias for `selfEncPrivateKey` (accepts a `CryptoKey` or `CryptoKeyPair`). */
  selfEncKey?: CryptoKey | CryptoKeyPair;
  selfEncVersion?: number;
  /** Optional ECDSA P-256 private signing key (used to construct `sign` when `sign` is omitted). */
  selfSignKey?: CryptoKey | CryptoKeyPair;
  /** Device P-256 signing callback (`SignFn`). */
  sign?: SignFn;
  /** Optional 32-byte at-rest device sealing key (derived from `selfEncPrivateKey` when omitted). */
  deviceSealKey?: Uint8Array;
  isHost?: boolean;
  pinnedHost?: string;
  now?: () => number;
};

// ---------------------------------------------------------------------------
// Persisted Device-Sealed Schemas (Epoch 0, VfsObjKind.DeviceLocal / Snap)
// ---------------------------------------------------------------------------

type PersistedEpochBundle = {
  header: VfsKeyEpochHeader;
  wrapChunks: VfsKeyWrapChunk[];
};

type PersistedEngineMeta = {
  v: 1;
  deviceSeq: number;
  lamport: number;
  pinnedHost?: string;
  epochBundles: PersistedEpochBundle[];
};

type PersistedOpIndexEntry = {
  v: 1;
  epoch: number;
  objKind: VfsRecordObjKind;
  nodeId: string;
  deviceId: string;
  seq: number;
  opId: string;
  cid: string;
  receivedAt: number;
  signerRole: VfsActorRole;
  signerMemberId: string;
};

type PersistedNodeHead = {
  v: 1;
  nodeId: string;
  rawPath: string;
  deleted: boolean;
  createdBy: string;
  updatedBy: string;
  updatedAt: number;
  currentRev: string;
  latestCommitId?: string;
};

type PersistedReceipt = {
  v: 1;
  requestId: string;
  actorId: string;
  at: number;
  kind: 'write' | 'patch' | 'revert' | 'delete';
  result: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Internal In-Memory State Structures
// ---------------------------------------------------------------------------

type StoredTreeOp = {
  op: VfsTreeOpBody;
  opHash: string;
  signerRole: VfsActorRole;
};

type DocRecord = {
  nodeId: string;
  created: boolean;
  rawPath: string;
  deleted: boolean;
  createdBy: string;
  createdByDeviceId: string;
  createdLamport: number;
  createdDeviceId: string;
  createdSeq: number;
  updatedBy: string;
  updatedAt: number;
  doc: FugueMaxDoc;
  treeOps: Map<string, StoredTreeOp>;
  commits: Map<string, VfsCommitBody>;
  latestCommitId?: string;
  deltaOpsSinceSnap: number;
  deltaBytesSinceSnap: number;
};

type IndexedRecord = PersistedOpIndexEntry & {
  opKvKey: string;
};

// ---------------------------------------------------------------------------
// Pure Helper Functions
// ---------------------------------------------------------------------------

function makeSignFnFromKey(keyOrPair: CryptoKey | CryptoKeyPair): SignFn {
  const priv = 'privateKey' in keyOrPair ? keyOrPair.privateKey : keyOrPair;
  return async (value: unknown) =>
    base64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, encode(value)));
}

function resolveEncPrivateKey(opts: VfsRoomEngineOptions): CryptoKey {
  if (opts.selfEncPrivateKey) return opts.selfEncPrivateKey;
  if (opts.selfEncKey) {
    return 'privateKey' in opts.selfEncKey ? opts.selfEncKey.privateKey : opts.selfEncKey;
  }
  throw new VfsError('VFS_INVALID_ENVELOPE', 'VfsRoomEngine requires selfEncPrivateKey or selfEncKey.');
}

function resolveSignFn(opts: VfsRoomEngineOptions): SignFn {
  if (opts.sign) return opts.sign;
  if (opts.selfSignKey) return makeSignFnFromKey(opts.selfSignKey);
  throw new VfsError('VFS_INVALID_ENVELOPE', 'VfsRoomEngine requires sign or selfSignKey.');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function compareTreeOpOrder(a: StoredTreeOp, b: StoredTreeOp): number {
  if (a.op.lamport !== b.op.lamport) return a.op.lamport - b.op.lamport;
  if (a.op.deviceId !== b.op.deviceId) return a.op.deviceId < b.op.deviceId ? -1 : 1;
  if (a.op.seq !== b.op.seq) return a.op.seq - b.op.seq;
  return a.opHash < b.opHash ? -1 : a.opHash > b.opHash ? 1 : 0;
}

function compareCreateOrder(a: DocRecord, b: DocRecord): number {
  if (a.createdLamport !== b.createdLamport) return a.createdLamport - b.createdLamport;
  if (a.createdDeviceId !== b.createdDeviceId) return a.createdDeviceId < b.createdDeviceId ? -1 : 1;
  if (a.createdSeq !== b.createdSeq) return a.createdSeq - b.createdSeq;
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
}

function encodeSyncCursor(rec: Pick<IndexedRecord, 'objKind' | 'seq' | 'deviceId' | 'cid'>): string {
  const rank = rec.objKind === VfsObjKind.TreeOp ? 0 : rec.objKind === VfsObjKind.DocOp ? 1 : 2;
  const seqHex = rec.seq.toString(16).padStart(12, '0');
  return `${rank}:${seqHex}:${rec.deviceId}:${rec.cid.slice(0, 16)}`;
}

function compareSyncOrder(a: IndexedRecord, b: IndexedRecord): number {
  const ca = encodeSyncCursor(a);
  const cb = encodeSyncCursor(b);
  return ca < cb ? -1 : ca > cb ? 1 : 0;
}

function validateTreeOpBodyShape(body: unknown, roomId: string, nodeId: string): VfsTreeOpBody {
  if (!isPlainObject(body)) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'VfsTreeOpBody must be an object.');
  }
  if (body.v !== VFS_PROTOCOL_VERSION || body.kind !== 'vfs-tree-op') {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid VfsTreeOpBody version or kind.');
  }
  if (body.roomId !== roomId || body.nodeId !== nodeId) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'VfsTreeOpBody roomId/nodeId mismatch.');
  }
  if (typeof body.memberId !== 'string' || !LOWER_UUID.test(body.memberId)) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'VfsTreeOpBody invalid memberId.');
  }
  if (typeof body.lamport !== 'number' || !Number.isSafeInteger(body.lamport) || body.lamport < 1) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'VfsTreeOpBody invalid lamport.');
  }
  if (typeof body.at !== 'number' || !Number.isSafeInteger(body.at) || body.at <= 0) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'VfsTreeOpBody invalid timestamp.');
  }
  if (!Array.isArray(body.parents) || body.parents.length > 16) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'VfsTreeOpBody invalid parents.');
  }
  if (!isPlainObject(body.action) || typeof body.action.t !== 'string') {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'VfsTreeOpBody missing action.');
  }
  const act = body.action;
  switch (act.t) {
    case 'create':
      if (act.nodeKind !== 'doc' || typeof act.parentId !== 'string' || typeof act.path !== 'string') {
        throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid VfsTreeOpBody create action.');
      }
      normalizeVfsPath(act.path);
      break;
    case 'delete':
      break;
    case 'restore':
      if (act.path !== undefined) {
        if (typeof act.path !== 'string') {
          throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid VfsTreeOpBody restore path.');
        }
        normalizeVfsPath(act.path);
      }
      break;
    case 'rename':
      if (typeof act.path !== 'string') {
        throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid VfsTreeOpBody rename path.');
      }
      normalizeVfsPath(act.path);
      break;
    default:
      throw new VfsError('VFS_INVALID_ENVELOPE', `Unsupported VfsTreeOpBody action "${act.t}".`);
  }
  return body as unknown as VfsTreeOpBody;
}

function validateCommitBodyShape(body: unknown, roomId: string, nodeId: string): VfsCommitBody {
  if (!isPlainObject(body)) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'VfsCommitBody must be an object.');
  }
  if (body.v !== VFS_PROTOCOL_VERSION || body.kind !== 'vfs-commit') {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid VfsCommitBody version or kind.');
  }
  if (body.roomId !== roomId || body.nodeId !== nodeId) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'VfsCommitBody roomId/nodeId mismatch.');
  }
  if (typeof body.commitId !== 'string' || !LOWER_UUID.test(body.commitId)) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'VfsCommitBody invalid commitId.');
  }
  if (body.scope !== 'doc' && body.scope !== 'tree') {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'VfsCommitBody invalid scope.');
  }
  if (!Array.isArray(body.parentCommits) || !Array.isArray(body.docFrontier)) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'VfsCommitBody missing parentCommits or docFrontier.');
  }
  if (typeof body.docRev !== 'string' || body.docRev.length === 0) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'VfsCommitBody missing docRev.');
  }
  if (typeof body.lamport !== 'number' || !Number.isSafeInteger(body.lamport) || body.lamport < 1) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'VfsCommitBody invalid lamport.');
  }
  if (typeof body.at !== 'number' || !Number.isSafeInteger(body.at) || body.at <= 0) {
    throw new VfsError('VFS_INVALID_ENVELOPE', 'VfsCommitBody invalid timestamp.');
  }
  return body as unknown as VfsCommitBody;
}

// ---------------------------------------------------------------------------
// Line-Level Unified Diff Engine
// ---------------------------------------------------------------------------

function splitLinesForDiff(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function computeLineDiffOps(
  a: readonly string[],
  b: readonly string[],
): Array<{ type: 'context' | 'add' | 'del'; text: string }> {
  let prefix = 0;
  const minLen = Math.min(a.length, b.length);
  while (prefix < minLen && a[prefix] === b[prefix]) prefix++;

  let suffix = 0;
  while (suffix < minLen - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
    suffix++;
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  const ops: Array<{ type: 'context' | 'add' | 'del'; text: string }> = [];
  for (let i = 0; i < prefix; i++) ops.push({ type: 'context', text: a[i]! });

  const n = midA.length;
  const m = midB.length;
  if (n === 0 && m === 0) {
    // identical middle
  } else if (n === 0) {
    for (const line of midB) ops.push({ type: 'add', text: line });
  } else if (m === 0) {
    for (const line of midA) ops.push({ type: 'del', text: line });
  } else if (n * m <= 250_000) {
    // Exact LCS DP for typical documents
    const dp = new Int32Array((n + 1) * (m + 1));
    const stride = m + 1;
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        if (midA[i] === midB[j]) {
          dp[i * stride + j] = dp[(i + 1) * stride + (j + 1)]! + 1;
        } else {
          const down = dp[(i + 1) * stride + j]!;
          const right = dp[i * stride + (j + 1)]!;
          dp[i * stride + j] = down >= right ? down : right;
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ type: 'context', text: midA[i]! });
        i++;
        j++;
      } else if (dp[(i + 1) * stride + j]! >= dp[i * stride + (j + 1)]!) {
        ops.push({ type: 'del', text: midA[i]! });
        i++;
      } else {
        ops.push({ type: 'add', text: midB[j]! });
        j++;
      }
    }
    while (i < n) ops.push({ type: 'del', text: midA[i++]! });
    while (j < m) ops.push({ type: 'add', text: midB[j++]! });
  } else {
    // Bounded O(N+M) fallback for very large files
    for (const line of midA) ops.push({ type: 'del', text: line });
    for (const line of midB) ops.push({ type: 'add', text: line });
  }

  for (let i = a.length - suffix; i < a.length; i++) {
    ops.push({ type: 'context', text: a[i]! });
  }
  return ops;
}

function buildUnifiedDiff(
  path: string,
  fromText: string,
  toText: string,
  contextLines = 3,
): { hunks: VfsDiffHunk[]; unified: string; addedLines: number; removedLines: number; identical: boolean } {
  if (fromText === toText) {
    return { hunks: [], unified: '', addedLines: 0, removedLines: 0, identical: true };
  }
  const aLines = splitLinesForDiff(fromText);
  const bLines = splitLinesForDiff(toText);
  const raw = computeLineDiffOps(aLines, bLines);

  let addedLines = 0;
  let removedLines = 0;
  const annotated: Array<{ type: 'context' | 'add' | 'del'; text: string; oldLine: number; newLine: number }> = [];
  let oldLn = 1;
  let newLn = 1;
  for (const op of raw) {
    if (op.type === 'context') {
      annotated.push({ ...op, oldLine: oldLn++, newLine: newLn++ });
    } else if (op.type === 'del') {
      removedLines++;
      annotated.push({ ...op, oldLine: oldLn++, newLine: newLn });
    } else {
      addedLines++;
      annotated.push({ ...op, oldLine: oldLn, newLine: newLn++ });
    }
  }

  // Group changes into hunks with `contextLines` surrounding context.
  const changeIndices: number[] = [];
  for (let i = 0; i < annotated.length; i++) {
    if (annotated[i]!.type !== 'context') changeIndices.push(i);
  }
  const hunks: VfsDiffHunk[] = [];
  let idx = 0;
  while (idx < changeIndices.length) {
    const startChange = changeIndices[idx]!;
    let endChange = startChange;
    while (idx + 1 < changeIndices.length && changeIndices[idx + 1]! - endChange <= contextLines * 2 + 1) {
      idx++;
      endChange = changeIndices[idx]!;
    }
    const hunkStart = Math.max(0, startChange - contextLines);
    const hunkEnd = Math.min(annotated.length - 1, endChange + contextLines);
    const slice = annotated.slice(hunkStart, hunkEnd + 1);
    const first = slice[0]!;
    let oldCount = 0;
    let newCount = 0;
    const lines: VfsDiffLine[] = [];
    for (const item of slice) {
      if (item.type !== 'add') oldCount++;
      if (item.type !== 'del') newCount++;
      lines.push({ type: item.type, text: item.text });
    }
    hunks.push({
      oldStart: oldCount === 0 ? Math.max(0, first.oldLine - 1) : first.oldLine,
      oldLines: oldCount,
      newStart: newCount === 0 ? Math.max(0, first.newLine - 1) : first.newLine,
      newLines: newCount,
      lines,
    });
    idx++;
  }

  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const l of h.lines) {
      const prefix = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
      out.push(`${prefix}${l.text}`);
    }
  }
  return { hunks, unified: out.join('\n'), addedLines, removedLines, identical: false };
}

// ---------------------------------------------------------------------------
// VfsRoomEngine
// ---------------------------------------------------------------------------

export class VfsRoomEngine {
  readonly roomId: string;
  readonly store: VfsRoomStore;
  readonly selfMemberId: string;
  readonly selfDeviceId: string;
  readonly selfRole: VfsActorRole;
  readonly isHost: boolean;
  readonly keyring: VfsKeyring;

  private readonly deviceSealKey: Uint8Array;
  private readonly signFn: SignFn;
  private readonly nowFn: () => number;

  private deviceSeq = 0;
  private lamport = 0;

  private docs = new Map<string, DocRecord>();
  private recordsByCid = new Map<string, IndexedRecord>();
  private deviceSeqCids = new Map<string, Set<string>>();
  private deviceSeqNumbers = new Map<string, Set<number>>();
  private conflictedDeviceSeqs = new Set<string>();
  private conflictIds = new Set<string>();
  private cachedFrontierHash: string | null = null;

  private epochBundles = new Map<number, PersistedEpochBundle>();
  private pendingKeyHeaders = new Map<string, VfsKeyEpochHeader>();
  private pendingWrapChunks = new Map<string, VfsKeyWrapChunk[]>();

  private receipts = new Map<string, PersistedReceipt>();
  private receiptKeysByActor = new Map<string, string[]>();

  private changeCursor = 0;
  private changeEvents: VfsChangeEvent[] = [];
  private changeListeners = new Set<(event: VfsChangeEvent) => void>();

  private constructor(params: {
    roomId: string;
    store: VfsRoomStore;
    selfMemberId: string;
    selfDeviceId: string;
    selfRole: VfsActorRole;
    isHost: boolean;
    keyring: VfsKeyring;
    deviceSealKey: Uint8Array;
    signFn: SignFn;
    nowFn: () => number;
  }) {
    this.roomId = params.roomId;
    this.store = params.store;
    this.selfMemberId = params.selfMemberId;
    this.selfDeviceId = params.selfDeviceId;
    this.selfRole = params.selfRole;
    this.isHost = params.isHost;
    this.keyring = params.keyring;
    this.deviceSealKey = params.deviceSealKey;
    this.signFn = params.signFn;
    this.nowFn = params.nowFn;
  }

  /**
   * Opens and hydrates a persistent `VfsRoomEngine` from `options.store`.
   * Reconstructs the `VfsKeyring`, `FugueMaxDoc` instances (from latest `snap:*` + tail `op:*`),
   * tree metadata, commit history, idempotency receipts, and O(1) `frontierHash` index.
   */
  static async open(options: VfsRoomEngineOptions): Promise<VfsRoomEngine> {
    const roomId = validateVfsRoomId(options.roomId);
    if (options.store.roomId !== roomId) {
      throw new VfsError('VFS_INVALID_KEY', 'VfsRoomStore roomId does not match engine roomId.');
    }
    if (!LOWER_UUID.test(options.selfMemberId)) {
      throw new VfsError('VFS_INVALID_KEY', 'Invalid selfMemberId: expected lowercase UUID.');
    }
    if (!HEX_64.test(options.selfDeviceId)) {
      throw new VfsError('VFS_INVALID_KEY', 'Invalid selfDeviceId: expected 64 lowercase hex chars.');
    }

    const encPriv = resolveEncPrivateKey(options);
    const signFn = resolveSignFn(options);
    const nowFn = options.now ?? (() => Date.now());
    const deviceSealKey = options.deviceSealKey
      ? new Uint8Array(options.deviceSealKey)
      : await deriveVfsDeviceSealKey(encPriv, { roomId, deviceId: options.selfDeviceId });

    // Pre-read persisted room metadata so TOFU `pinnedHost` survives close + reopen.
    let persistedPinnedHost: string | undefined;
    const metaKey = vfsMetaKey(roomId);
    const rawMeta = await options.store.kvGet(metaKey);
    if (rawMeta) {
      const openedMeta = await openVfsEnvelope({
        bytes: rawMeta,
        roomId,
        key: deviceSealKey,
        bindingKey: metaKey,
        expectedObjKind: VfsObjKind.DeviceLocal,
        expectedEpoch: 0,
      });
      const parsedMeta = JSON.parse(textDecoder.decode(openedMeta.plaintext)) as Partial<PersistedEngineMeta>;
      if (parsedMeta && parsedMeta.v === 1 && typeof parsedMeta.pinnedHost === 'string') {
        persistedPinnedHost = parsedMeta.pinnedHost;
      }
    }

    const keyring = new VfsKeyring({
      roomId,
      selfDeviceId: options.selfDeviceId,
      selfEncPrivateKey: encPriv,
      selfEncVersion: options.selfEncVersion ?? 1,
      sign: signFn,
      pinnedHost: options.pinnedHost ?? persistedPinnedHost,
      now: nowFn,
    });

    const engine = new VfsRoomEngine({
      roomId,
      store: options.store,
      selfMemberId: options.selfMemberId,
      selfDeviceId: options.selfDeviceId,
      selfRole: options.selfRole ?? 'human',
      isHost: options.isHost ?? false,
      keyring,
      deviceSealKey,
      signFn,
      nowFn,
    });

    await engine.hydrateFromStore();
    return engine;
  }

  // -------------------------------------------------------------------------
  // Hydration from Persistent VfsRoomStore
  // -------------------------------------------------------------------------

  private async sealDeviceLocal(kvKey: string, payload: unknown): Promise<Uint8Array<ArrayBuffer>> {
    const sealed = await sealVfsEnvelope({
      roomId: this.roomId,
      epoch: 0,
      objKind: VfsObjKind.DeviceLocal,
      key: this.deviceSealKey,
      plaintext: utf8Bytes(canonicalJson(payload)),
      bindingKey: kvKey,
    });
    return sealed.bytes;
  }

  private async openDeviceLocal<T>(kvKey: string, bytes: Uint8Array): Promise<T> {
    const opened = await openVfsEnvelope({
      bytes,
      roomId: this.roomId,
      key: this.deviceSealKey,
      bindingKey: kvKey,
      expectedObjKind: VfsObjKind.DeviceLocal,
      expectedEpoch: 0,
    });
    try {
      return JSON.parse(textDecoder.decode(opened.plaintext)) as T;
    } catch (cause) {
      throw new VfsError('VFS_INVALID_ENVELOPE', `Corrupted device-sealed JSON at ${kvKey}.`, { cause });
    }
  }

  private async hydrateFromStore(): Promise<void> {
    const roomPrefix = vfsRoomPrefix(this.roomId);

    // 1. Hydrate room key epochs (`epoch:*`).
    const epochEntries = await this.store.kvScanPrefix(`${roomPrefix}epoch:`);
    const epochRecords: VfsEpochRecord[] = [];
    for (const entry of epochEntries) {
      const hexPart = entry.key.slice(`${roomPrefix}epoch:`.length);
      const epoch = Number.parseInt(hexPart, 16);
      if (!Number.isInteger(epoch) || epoch < 1) continue;
      const rec = await openEpochRecordFromStorage(this.roomId, epoch, entry.value, this.deviceSealKey);
      epochRecords.push(rec);
    }
    if (epochRecords.length > 0) {
      await this.keyring.hydrate(epochRecords);
    }

    // 2. Hydrate room engine metadata (`meta`: clocks + cached epoch broadcast bundles).
    const metaKey = vfsMetaKey(this.roomId);
    const metaBytes = await this.store.kvGet(metaKey);
    if (metaBytes) {
      const meta = await this.openDeviceLocal<PersistedEngineMeta>(metaKey, metaBytes);
      if (meta && meta.v === 1) {
        if (Number.isSafeInteger(meta.deviceSeq) && meta.deviceSeq > this.deviceSeq) {
          this.deviceSeq = meta.deviceSeq;
        }
        if (Number.isSafeInteger(meta.lamport) && meta.lamport > this.lamport) {
          this.lamport = meta.lamport;
        }
        if (Array.isArray(meta.epochBundles)) {
          for (const bundle of meta.epochBundles) {
            if (isValidKeyEpochHeaderShape(bundle.header) && Array.isArray(bundle.wrapChunks)) {
              this.epochBundles.set(bundle.header.body.epoch, bundle);
            }
          }
        }
      }
    }

    // 3. Hydrate requestId idempotency receipts (`req:*`).
    const reqEntries = await this.store.kvScanPrefix(`${roomPrefix}req:`);
    for (const entry of reqEntries) {
      const receipt = await this.openDeviceLocal<PersistedReceipt>(entry.key, entry.value);
      if (receipt && receipt.v === 1) {
        this.receipts.set(entry.key, receipt);
        const list = this.receiptKeysByActor.get(receipt.actorId) ?? [];
        list.push(entry.key);
        this.receiptKeysByActor.set(receipt.actorId, list);
      }
    }

    // 4. Hydrate indexed replicated records (`op:*`) and cached checkpoints (`snap:*`).
    const opEntries = await this.store.kvScanPrefix(`${roomPrefix}op:`);
    const indexed: IndexedRecord[] = [];
    const nodeIds = new Set<string>();
    for (const entry of opEntries) {
      const meta = await this.openDeviceLocal<PersistedOpIndexEntry>(entry.key, entry.value);
      if (!meta || meta.v !== 1) continue;
      const rec: IndexedRecord = { ...meta, opKvKey: entry.key };
      indexed.push(rec);
      nodeIds.add(rec.nodeId);
      this.trackIndexedRecord(rec);
    }

    // 5. Restore latest `snap:*` checkpoint per node (if any) before replaying tail ops.
    for (const nodeId of nodeIds) {
      const snapEntries = await this.store.kvScanPrefix(vfsSnapPrefix(this.roomId, nodeId), {
        direction: 'last',
        limit: 1,
      });
      if (snapEntries.length > 0) {
        const latestSnap = snapEntries[snapEntries.length - 1]!;
        const opened = await openVfsEnvelope({
          bytes: latestSnap.value,
          roomId: this.roomId,
          key: this.deviceSealKey,
          bindingKey: latestSnap.key,
          expectedObjKind: VfsObjKind.Snap,
          expectedEpoch: 0,
        });
        const checkpoint = JSON.parse(textDecoder.decode(opened.plaintext)) as FugueCheckpoint;
        const docRec = this.ensureDocRecord(nodeId);
        docRec.doc = FugueMaxDoc.fromCheckpoint(checkpoint, {
          roomId: this.roomId,
          nodeId,
          now: this.nowFn,
        });
      }
    }

    // 6. Replay all stored records in deterministic order: TreeOps -> DocOps -> Commits.
    indexed.sort(compareSyncOrder);
    for (const rec of indexed) {
      const envBytes = await this.store.kvGet(vfsObjKey(this.roomId, rec.cid));
      if (!envBytes) continue;
      const roomKey = this.keyring.getKey(rec.epoch);
      if (!roomKey) continue;

      const opened = await openVfsEnvelope({
        bytes: envBytes,
        roomId: this.roomId,
        key: roomKey,
        bindingKey: `${rec.deviceId}:${rec.seq}:${rec.opId}`,
        expectedObjKind: rec.objKind,
        expectedEpoch: rec.epoch,
        expectedCid: rec.cid,
      });
      const signed = JSON.parse(textDecoder.decode(opened.plaintext)) as { body: Record<string, unknown> };
      const body = signed.body;
      if (typeof body.lamport === 'number' && body.lamport > this.lamport) {
        this.lamport = body.lamport;
      }
      if (rec.deviceId === this.selfDeviceId && rec.seq > this.deviceSeq) {
        this.deviceSeq = rec.seq;
      }

      if (rec.objKind === VfsObjKind.TreeOp) {
        const treeBody = validateTreeOpBodyShape(body, this.roomId, rec.nodeId);
        const docRec = this.ensureDocRecord(rec.nodeId);
        docRec.treeOps.set(opened.opHash!, {
          op: treeBody,
          opHash: opened.opHash!,
          signerRole: rec.signerRole,
        });
        this.foldTreeOps(docRec);
      } else if (rec.objKind === VfsObjKind.DocOp) {
        const docBody = body as unknown as VfsDocOpBody;
        const docRec = this.ensureDocRecord(rec.nodeId);
        const docOpHash = computeDocOpHash(docBody);
        if (!docRec.doc.getAppliedOp(docOpHash)) {
          docRec.doc.applyOp(docBody, docOpHash);
        }
        if (docBody.at >= docRec.updatedAt) {
          docRec.updatedAt = docBody.at;
          docRec.updatedBy = docBody.memberId;
        }
      } else if (rec.objKind === VfsObjKind.Commit) {
        const commitBody = validateCommitBodyShape(body, this.roomId, rec.nodeId);
        const docRec = this.ensureDocRecord(rec.nodeId);
        docRec.commits.set(commitBody.commitId, commitBody);
        if (commitBody.at >= docRec.updatedAt) {
          docRec.updatedAt = commitBody.at;
          docRec.updatedBy = commitBody.memberId;
          docRec.latestCommitId = commitBody.commitId;
        }
      }
    }
  }

  private ensureDocRecord(nodeId: string): DocRecord {
    let rec = this.docs.get(nodeId);
    if (!rec) {
      rec = {
        nodeId,
        created: false,
        rawPath: '',
        deleted: false,
        createdBy: '',
        createdByDeviceId: '',
        createdLamport: Number.MAX_SAFE_INTEGER,
        createdDeviceId: '',
        createdSeq: Number.MAX_SAFE_INTEGER,
        updatedBy: '',
        updatedAt: 0,
        doc: new FugueMaxDoc({ roomId: this.roomId, nodeId, now: this.nowFn }),
        treeOps: new Map(),
        commits: new Map(),
        deltaOpsSinceSnap: 0,
        deltaBytesSinceSnap: 0,
      };
      this.docs.set(nodeId, rec);
    }
    return rec;
  }

  private trackIndexedRecord(rec: IndexedRecord): void {
    this.recordsByCid.set(rec.cid, rec);
    this.cachedFrontierHash = null;

    const seqKey = `${rec.deviceId}:${rec.seq}`;
    let cidsAtSeq = this.deviceSeqCids.get(seqKey);
    if (!cidsAtSeq) {
      cidsAtSeq = new Set();
      this.deviceSeqCids.set(seqKey, cidsAtSeq);
    }
    cidsAtSeq.add(rec.cid);
    if (cidsAtSeq.size > 1) {
      this.conflictedDeviceSeqs.add(seqKey);
      for (const c of cidsAtSeq) {
        if (this.conflictIds.size < VFS_HAVE_MAX_CONFLICT_IDS) {
          this.conflictIds.add(c.slice(0, 16));
        }
      }
    }

    let seqs = this.deviceSeqNumbers.get(rec.deviceId);
    if (!seqs) {
      seqs = new Set();
      this.deviceSeqNumbers.set(rec.deviceId, seqs);
    }
    seqs.add(rec.seq);
  }

  private foldTreeOps(docRec: DocRecord): void {
    const ordered = [...docRec.treeOps.values()].sort(compareTreeOpOrder);
    let created = false;
    let rawPath = '';
    let deleted = false;
    let createdBy = '';
    let createdByDeviceId = '';
    let createdLamport = Number.MAX_SAFE_INTEGER;
    let createdDeviceId = '';
    let createdSeq = Number.MAX_SAFE_INTEGER;
    let updatedBy = docRec.updatedBy;
    let updatedAt = docRec.updatedAt;

    for (const item of ordered) {
      const { op, signerRole } = item;
      const act = op.action;
      if (act.t === 'create') {
        if (!created) {
          created = true;
          rawPath = normalizeVfsPath(act.path);
          deleted = false;
          createdBy = op.memberId;
          createdByDeviceId = op.deviceId;
          createdLamport = op.lamport;
          createdDeviceId = op.deviceId;
          createdSeq = op.seq;
          if (op.at >= updatedAt) {
            updatedAt = op.at;
            updatedBy = op.memberId;
          }
        }
      } else if (act.t === 'delete') {
        if (!created) continue;
        // Decision 4: humans can soft-delete any doc; agents can only soft-delete docs they created.
        if (signerRole !== 'human' && op.memberId !== createdBy) continue;
        deleted = true;
        if (op.at >= updatedAt) {
          updatedAt = op.at;
          updatedBy = op.memberId;
        }
      } else if (act.t === 'restore') {
        if (!created) continue;
        // Decision 4: humans-only restore.
        if (signerRole !== 'human') continue;
        deleted = false;
        if (act.path !== undefined) {
          rawPath = normalizeVfsPath(act.path);
        }
        if (op.at >= updatedAt) {
          updatedAt = op.at;
          updatedBy = op.memberId;
        }
      } else if (act.t === 'rename') {
        if (!created) continue;
        rawPath = normalizeVfsPath(act.path);
        if (op.at >= updatedAt) {
          updatedAt = op.at;
          updatedBy = op.memberId;
        }
      }
    }

    docRec.created = created;
    docRec.rawPath = rawPath;
    docRec.deleted = deleted;
    docRec.createdBy = createdBy;
    docRec.createdByDeviceId = createdByDeviceId;
    docRec.createdLamport = createdLamport;
    docRec.createdDeviceId = createdDeviceId;
    docRec.createdSeq = createdSeq;
    docRec.updatedBy = updatedBy;
    docRec.updatedAt = updatedAt;
  }

  /** Computes the causal DAG frontier of `docRec.treeOps` (only unreferenced tips, capped to <= 16). */
  private treeOpFrontier(docRec: DocRecord): string[] {
    const referenced = new Set<string>();
    for (const item of docRec.treeOps.values()) {
      for (const parent of item.op.parents) {
        referenced.add(parent);
      }
    }
    const tips = [...docRec.treeOps.keys()].filter(hash => !referenced.has(hash)).sort();
    return tips.slice(0, 16);
  }

  /** Computes deterministic conflict-resolved display paths across all live docs. */
  private computeDisplayPaths(): Map<string, { displayPath: string; hasConflict: boolean }> {
    const groups = new Map<string, DocRecord[]>();
    for (const rec of this.docs.values()) {
      if (!rec.created || rec.deleted) continue;
      const folded = foldVfsPath(rec.rawPath);
      const bucket = groups.get(folded) ?? [];
      bucket.push(rec);
      groups.set(folded, bucket);
    }

    const out = new Map<string, { displayPath: string; hasConflict: boolean }>();
    for (const bucket of groups.values()) {
      bucket.sort(compareCreateOrder);
      const first = bucket[0]!;
      out.set(first.nodeId, { displayPath: first.rawPath, hasConflict: false });
      for (let i = 1; i < bucket.length; i++) {
        const loser = bucket[i]!;
        out.set(loser.nodeId, {
          displayPath: conflictPath(loser.rawPath, loser.nodeId),
          hasConflict: true,
        });
      }
    }
    return out;
  }

  private displayPathFor(docRec: DocRecord, displayMap?: Map<string, { displayPath: string; hasConflict: boolean }>): {
    displayPath: string;
    hasConflict: boolean;
  } {
    if (docRec.deleted) {
      return { displayPath: docRec.rawPath, hasConflict: false };
    }
    const map = displayMap ?? this.computeDisplayPaths();
    return map.get(docRec.nodeId) ?? { displayPath: docRec.rawPath, hasConflict: false };
  }

  private resolveDoc(nodeIdOrPath: string, includeDeleted = false): DocRecord {
    if (typeof nodeIdOrPath !== 'string' || nodeIdOrPath.length === 0) {
      throw new VfsError('VFS_NOT_FOUND', 'Document identifier or path is required.');
    }

    // 1. Direct lookup by UUID `nodeId`.
    const direct = this.docs.get(nodeIdOrPath.toLowerCase());
    if (direct && direct.created) {
      if (!includeDeleted && direct.deleted) {
        throw new VfsError('VFS_NOT_FOUND', `Document "${nodeIdOrPath}" is soft-deleted.`);
      }
      return direct;
    }

    // 2. Lookup by resolved display path or raw path (case-folded).
    let normalized: string;
    try {
      normalized = normalizeVfsPath(nodeIdOrPath);
    } catch {
      throw new VfsError('VFS_NOT_FOUND', `Document "${nodeIdOrPath}" not found.`);
    }
    const targetFolded = foldVfsPath(normalized);
    const displayMap = this.computeDisplayPaths();

    // Prefer exact match against conflict-resolved displayPath on live docs first.
    for (const rec of this.docs.values()) {
      if (!rec.created || rec.deleted) continue;
      const resolved = displayMap.get(rec.nodeId)?.displayPath ?? rec.rawPath;
      if (foldVfsPath(resolved) === targetFolded) {
        return rec;
      }
    }

    // Fall back to soft-deleted docs when `includeDeleted` is requested (e.g. `restoreDoc`, `readDoc`).
    if (includeDeleted) {
      const deletedMatches = [...this.docs.values()]
        .filter(r => r.created && r.deleted && foldVfsPath(r.rawPath) === targetFolded)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      if (deletedMatches.length > 0) {
        return deletedMatches[0]!;
      }
    }

    throw new VfsError('VFS_NOT_FOUND', `Document "${nodeIdOrPath}" not found.`);
  }

  private nextSeq(): number {
    this.deviceSeq += 1;
    if (this.deviceSeq > VFS_MAX_SEQ) {
      throw new VfsError('VFS_LIMIT_EXCEEDED', `Device sequence number exceeded ${VFS_MAX_SEQ}.`);
    }
    return this.deviceSeq;
  }

  private nextLamport(): number {
    this.lamport += 1;
    return this.lamport;
  }

  private buildMetaSnapshot(): PersistedEngineMeta {
    return {
      v: 1,
      deviceSeq: this.deviceSeq,
      lamport: this.lamport,
      ...(this.keyring.hostPin ? { pinnedHost: this.keyring.hostPin } : {}),
      epochBundles: [...this.epochBundles.values()].sort((a, b) => a.header.body.epoch - b.header.body.epoch),
    };
  }

  private async persistEngineMeta(): Promise<void> {
    const metaKey = vfsMetaKey(this.roomId);
    const bytes = await this.sealDeviceLocal(metaKey, this.buildMetaSnapshot());
    await this.store.kvPut(metaKey, bytes);
  }

  private buildNodeHeadPayload(docRec: DocRecord): PersistedNodeHead {
    return {
      v: 1,
      nodeId: docRec.nodeId,
      rawPath: docRec.rawPath,
      deleted: docRec.deleted,
      createdBy: docRec.createdBy,
      updatedBy: docRec.updatedBy,
      updatedAt: docRec.updatedAt,
      currentRev: docRec.doc.frontierRev(),
      ...(docRec.latestCommitId ? { latestCommitId: docRec.latestCommitId } : {}),
    };
  }

  private async maybeWriteDocCheckpoint(docRec: DocRecord, deltaBytes: number): Promise<void> {
    docRec.deltaOpsSinceSnap += 1;
    docRec.deltaBytesSinceSnap += deltaBytes;
    if (docRec.deltaOpsSinceSnap < VFS_SNAP_EVERY_OPS && docRec.deltaBytesSinceSnap < VFS_SNAP_EVERY_BYTES) {
      return;
    }

    const checkpoint = docRec.doc.exportCheckpoint({ includeOpLog: true });
    const plaintext = utf8Bytes(canonicalJson(checkpoint));
    const snapDigest = await sha256Hex(plaintext);
    const snapKey = vfsSnapKey(this.roomId, docRec.nodeId, this.nowFn(), snapDigest);
    const sealed = await sealVfsEnvelope({
      roomId: this.roomId,
      epoch: 0,
      objKind: VfsObjKind.Snap,
      key: this.deviceSealKey,
      plaintext,
      bindingKey: snapKey,
    });
    await this.store.kvPut(snapKey, sealed.bytes);
    docRec.deltaOpsSinceSnap = 0;
    docRec.deltaBytesSinceSnap = 0;
  }

  private emitChange(event: Omit<VfsChangeEvent, 'cursor' | 'roomId'>): VfsChangeEvent {
    const full: VfsChangeEvent = {
      cursor: ++this.changeCursor,
      roomId: this.roomId,
      ...event,
    };
    this.changeEvents.push(full);
    if (this.changeEvents.length > MAX_CHANGE_FEED_EVENTS) {
      this.changeEvents.splice(0, this.changeEvents.length - MAX_CHANGE_FEED_EVENTS);
    }
    for (const listener of this.changeListeners) {
      try {
        listener(full);
      } catch {
        // Passive listeners must never break engine mutations.
      }
    }
    return full;
  }

  /** Subscribes to passive VFS change events (returns an unsubscribe function). */
  onChange(listener: (event: VfsChangeEvent) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /** Returns passive change events strictly newer than `afterCursor` (non-waking `listen` feed). */
  recentChanges(afterCursor = 0): { events: VfsChangeEvent[]; cursor: number } {
    const events = this.changeEvents.filter(e => e.cursor > afterCursor);
    return { events, cursor: this.changeCursor };
  }

  private async checkIdempotentReceipt<T>(actorId: string, requestId: string): Promise<T | undefined> {
    const reqKey = vfsReqKey(this.roomId, actorId, requestId);
    const existing = this.receipts.get(reqKey);
    if (!existing) return undefined;
    return {
      ...(existing.result as T),
      replayed: true,
      outbound: [],
    };
  }

  private async prepareReceiptKv(
    actorId: string,
    requestId: string,
    kind: PersistedReceipt['kind'],
    result: Record<string, unknown>,
  ): Promise<{ key: string; value: Uint8Array<ArrayBuffer>; receipt: PersistedReceipt }> {
    const key = vfsReqKey(this.roomId, actorId, requestId);
    const stripped = { ...result };
    delete stripped.outbound;
    delete stripped.replayed;
    const receipt: PersistedReceipt = {
      v: 1,
      requestId,
      actorId,
      at: this.nowFn(),
      kind,
      result: stripped,
    };
    const value = await this.sealDeviceLocal(key, receipt);
    return { key, value, receipt };
  }

  private async recordReceiptInMemoryAndPrune(key: string, receipt: PersistedReceipt): Promise<void> {
    this.receipts.set(key, receipt);
    const list = this.receiptKeysByActor.get(receipt.actorId) ?? [];
    list.push(key);
    while (list.length > VFS_MAX_RECEIPTS_PER_ACTOR) {
      const oldest = list.shift()!;
      this.receipts.delete(oldest);
      try {
        await this.store.kvDelete(oldest);
      } catch {
        // Best-effort pruning of expired idempotency receipts.
      }
    }
    this.receiptKeysByActor.set(receipt.actorId, list);
  }

  // -------------------------------------------------------------------------
  // Key Management API (Bootstrap, Rotate, Broadcast Accept, Delegated Grants)
  // -------------------------------------------------------------------------

  /** Host-only Epoch-1 bootstrap: persists epoch 1 sealed under `deviceSealKey` and returns wire packets. */
  async bootstrapEpoch1(roster: SignedRoster): Promise<{
    epoch: number;
    record: VfsEpochRecord;
    packets: Array<VfsKeyEpochPacket | VfsKeyWrapPacket>;
  }> {
    const minted = await this.keyring.bootstrapEpoch1(roster);
    const sealed = await sealEpochRecordForStorage(this.roomId, minted.record, this.deviceSealKey);
    this.epochBundles.set(minted.record.epoch, { header: minted.header, wrapChunks: minted.wrapChunks });
    const metaKey = vfsMetaKey(this.roomId);
    const metaBytes = await this.sealDeviceLocal(metaKey, this.buildMetaSnapshot());
    await writeBeforePublish(this.store, {
      kvEntries: [{ key: sealed.kvKey, value: sealed.bytes }],
      publishKey: metaKey,
      publishValue: metaBytes,
    });

    const packets: Array<VfsKeyEpochPacket | VfsKeyWrapPacket> = [
      wrapKeyEpochPacket(minted.header),
      ...minted.wrapChunks.map(wrapKeyWrapPacket),
    ];
    this.emitChange({
      kind: 'epoch-updated',
      epoch: minted.record.epoch,
      authorMemberId: this.selfMemberId,
      authorDeviceId: this.selfDeviceId,
      at: minted.record.createdAt,
      source: 'self',
    });
    return { epoch: minted.record.epoch, record: minted.record, packets };
  }

  /** Host-only forward epoch rotation (`RK_e -> RK_{e+1}`): persists & returns wire packets. */
  async rotateEpoch(roster: SignedRoster): Promise<{
    epoch: number;
    record: VfsEpochRecord;
    packets: Array<VfsKeyEpochPacket | VfsKeyWrapPacket>;
  }> {
    const prevEpoch = this.keyring.activeEpoch;
    const minted = await this.keyring.rotateEpoch(roster);
    const kvEntries: Array<{ key: string; value: Uint8Array }> = [];

    const prevRec = this.keyring.getRecord(prevEpoch);
    if (prevRec) {
      const sealedPrev = await sealEpochRecordForStorage(this.roomId, prevRec, this.deviceSealKey);
      kvEntries.push({ key: sealedPrev.kvKey, value: sealedPrev.bytes });
    }
    const sealedNew = await sealEpochRecordForStorage(this.roomId, minted.record, this.deviceSealKey);
    kvEntries.push({ key: sealedNew.kvKey, value: sealedNew.bytes });

    this.epochBundles.set(minted.record.epoch, { header: minted.header, wrapChunks: minted.wrapChunks });
    const metaKey = vfsMetaKey(this.roomId);
    const metaBytes = await this.sealDeviceLocal(metaKey, this.buildMetaSnapshot());
    await writeBeforePublish(this.store, {
      kvEntries,
      publishKey: metaKey,
      publishValue: metaBytes,
    });

    const packets: Array<VfsKeyEpochPacket | VfsKeyWrapPacket> = [
      wrapKeyEpochPacket(minted.header),
      ...minted.wrapChunks.map(wrapKeyWrapPacket),
    ];
    this.emitChange({
      kind: 'epoch-updated',
      epoch: minted.record.epoch,
      authorMemberId: this.selfMemberId,
      authorDeviceId: this.selfDeviceId,
      at: minted.record.createdAt,
      source: 'self',
    });
    return { epoch: minted.record.epoch, record: minted.record, packets };
  }

  private async tryInstallBufferedEpoch(
    headerHash: string,
    ctx: VfsKeyAcceptContext,
  ): Promise<VfsEpochRecord | null> {
    const header = this.pendingKeyHeaders.get(headerHash);
    if (!header) return null;
    const chunks = this.pendingWrapChunks.get(headerHash) ?? [];
    const hasSelfWrap = chunks.some(c => Object.prototype.hasOwnProperty.call(c.body.wraps, this.selfDeviceId));
    if (!hasSelfWrap) return null;

    const record = await this.keyring.acceptEpochBroadcast({
      header,
      wrapChunks: chunks,
      roster: ctx.roster,
      trustedPriorHosts: ctx.trustedPriorHosts,
    });

    this.pendingKeyHeaders.delete(headerHash);
    this.pendingWrapChunks.delete(headerHash);
    this.epochBundles.set(record.epoch, { header, wrapChunks: [...chunks] });

    const sealed = await sealEpochRecordForStorage(this.roomId, record, this.deviceSealKey);
    const metaKey = vfsMetaKey(this.roomId);
    const metaBytes = await this.sealDeviceLocal(metaKey, this.buildMetaSnapshot());
    await writeBeforePublish(this.store, {
      kvEntries: [{ key: sealed.kvKey, value: sealed.bytes }],
      publishKey: metaKey,
      publishValue: metaBytes,
    });

    this.emitChange({
      kind: 'epoch-updated',
      epoch: record.epoch,
      authorDeviceId: header.body.hostDeviceId,
      at: record.createdAt,
      source: 'remote',
    });
    return record;
  }

  /** Verifies and buffers an inbound `vfs-key-epoch` packet, installing immediately if wraps are ready. */
  async acceptKeyEpoch(
    pkt: VfsKeyEpochPacket | VfsKeyEpochHeader,
    ctx: VfsKeyAcceptContext,
  ): Promise<{ accepted: boolean; installed: VfsEpochRecord | null }> {
    let header: VfsKeyEpochHeader;
    if (isVfsKeyEpochPacket(pkt, this.roomId)) {
      header = pkt.header;
    } else if (isValidKeyEpochHeaderShape(pkt) && pkt.body.roomId === this.roomId) {
      header = pkt;
    } else {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid vfs-key-epoch packet.');
    }

    const { headerHash } = await verifyKeyEpochHeader(header, {
      roomId: this.roomId,
      roster: ctx.roster,
      pinnedHost: this.keyring.hostPin,
      trustedPriorHosts: ctx.trustedPriorHosts,
    });

    // Idempotent if we already hold this exact epoch header.
    const existing = this.keyring.getRecord(header.body.epoch);
    if (existing) {
      if (existing.headerHash === headerHash && existing.header.body.keyCommit === header.body.keyCommit) {
        return { accepted: true, installed: existing };
      }
      throw new VfsError('VFS_EPOCH_ROLLBACK', `Conflicting header for already-held epoch ${header.body.epoch}.`);
    }

    if (this.pendingKeyHeaders.size >= MAX_PENDING_KEY_HEADERS && !this.pendingKeyHeaders.has(headerHash)) {
      const oldest = this.pendingKeyHeaders.keys().next().value;
      if (oldest !== undefined) {
        this.pendingKeyHeaders.delete(oldest);
        this.pendingWrapChunks.delete(oldest);
      }
    }
    this.pendingKeyHeaders.set(headerHash, header);
    const installed = await this.tryInstallBufferedEpoch(headerHash, ctx);
    return { accepted: true, installed };
  }

  /** Verifies host signature on an inbound `vfs-key-wrap` packet and installs the epoch once its header is present. */
  async acceptKeyWrap(
    pkt: VfsKeyWrapPacket | VfsKeyWrapChunk,
    ctx: VfsKeyAcceptContext,
  ): Promise<{ accepted: boolean; installed: VfsEpochRecord | null }> {
    let chunk: VfsKeyWrapChunk;
    if (isVfsKeyWrapPacket(pkt, this.roomId)) {
      chunk = pkt.chunk;
    } else if (isValidKeyWrapChunkShape(pkt) && pkt.body.roomId === this.roomId) {
      chunk = pkt;
    } else {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid vfs-key-wrap packet.');
    }

    // Verify sender is the verified host (or a trusted prior host) and authenticate the chunk signature
    // BEFORE caching it in `epochBundles` or `pendingWrapChunks` (prevents wrap-cache poisoning).
    const senderDeviceId = chunk.body.senderDeviceId;
    let senderSignPub: string | undefined;
    if (senderDeviceId === ctx.roster.body.host) {
      senderSignPub = ctx.roster.body.devices.find(d => d.id === senderDeviceId)?.sign;
    } else if (ctx.trustedPriorHosts?.[senderDeviceId]) {
      senderSignPub = ctx.trustedPriorHosts[senderDeviceId];
    }
    if (!senderSignPub) {
      throw new VfsError('VFS_EPOCH_UNAUTHORIZED', 'VfsKeyWrapChunk sender is not the verified room host.', {
        status: 403,
      });
    }
    const sigOk = await verify(
      senderSignPub,
      canonicalize({ d: VFS_KEY_WRAP_SIG_DOMAIN, body: chunk.body }),
      chunk.signature,
    );
    if (!sigOk) {
      throw new VfsError('VFS_INVALID_SIGNATURE', 'Invalid host signature on VfsKeyWrapChunk.');
    }

    const { headerHash, epoch } = chunk.body;
    const existing = this.keyring.getRecord(epoch);
    if (existing && existing.headerHash === headerHash) {
      // Cache additional verified wrap chunks so this peer can serve them if needed, and return idempotently.
      const bundle = this.epochBundles.get(epoch);
      if (bundle && !bundle.wrapChunks.some(c => c.body.chunkIndex === chunk.body.chunkIndex)) {
        bundle.wrapChunks.push(chunk);
        await this.persistEngineMeta();
      }
      return { accepted: true, installed: existing };
    }

    if (this.pendingWrapChunks.size >= MAX_PENDING_KEY_HEADERS && !this.pendingWrapChunks.has(headerHash)) {
      const oldest = this.pendingWrapChunks.keys().next().value;
      if (oldest !== undefined) this.pendingWrapChunks.delete(oldest);
    }
    const list = this.pendingWrapChunks.get(headerHash) ?? [];
    if (
      list.length < MAX_PENDING_WRAP_CHUNKS_PER_HEADER
      && !list.some(c => c.body.chunkIndex === chunk.body.chunkIndex)
    ) {
      list.push(chunk);
      this.pendingWrapChunks.set(headerHash, list);
    }

    const installed = await this.tryInstallBufferedEpoch(headerHash, ctx);
    return { accepted: true, installed };
  }

  /** Creates a delegated `vfs-key-grant` wire packet (admitted human only, works while host is offline). */
  async createKeyGrant(
    target: RosterEntry,
    roster: SignedRoster,
    epochs?: readonly number[],
  ): Promise<VfsKeyGrantPacket> {
    const grant = await this.keyring.createKeyGrant({
      recipient: target,
      roster,
      epochs,
    });
    return wrapKeyGrantPacket(grant);
  }

  /** Verifies and installs a delegated `vfs-key-grant` packet (verifies host `keyCommit` on every epoch). */
  async acceptKeyGrant(
    pkt: VfsKeyGrantPacket | KeyringVfsKeyGrantPacket,
    ctx: VfsKeyAcceptContext,
  ): Promise<VfsEpochRecord[]> {
    let grant: KeyringVfsKeyGrantPacket;
    if (isVfsKeyGrantPacket(pkt, this.roomId)) {
      grant = pkt.grant;
    } else if (isValidKeyGrantPacketShape(pkt) && pkt.body.roomId === this.roomId) {
      grant = pkt;
    } else {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid vfs-key-grant packet.');
    }

    const installed = await this.keyring.acceptKeyGrant({
      grant,
      roster: ctx.roster,
      trustedPriorHosts: ctx.trustedPriorHosts,
    });

    const kvEntries: Array<{ key: string; value: Uint8Array }> = [];
    for (const rec of installed) {
      const sealed = await sealEpochRecordForStorage(this.roomId, rec, this.deviceSealKey);
      kvEntries.push({ key: sealed.kvKey, value: sealed.bytes });
    }
    const metaKey = vfsMetaKey(this.roomId);
    const metaBytes = await this.sealDeviceLocal(metaKey, this.buildMetaSnapshot());
    await writeBeforePublish(this.store, {
      kvEntries,
      publishKey: metaKey,
      publishValue: metaBytes,
    });

    if (installed.length > 0) {
      const latest = installed[installed.length - 1]!;
      this.emitChange({
        kind: 'epoch-updated',
        epoch: latest.epoch,
        authorDeviceId: grant.body.granterDeviceId,
        at: grant.body.at,
        source: 'remote',
      });
    }
    return installed;
  }

  // -------------------------------------------------------------------------
  // Record Sealing & Persistence Helper
  // -------------------------------------------------------------------------

  private async sealRecord<T extends VfsAuthorStamp & VfsSignedOpHeaderFields & { nodeId: string }>(
    body: T,
    objKind: VfsRecordObjKind,
    roomKey: Uint8Array,
    signerRole: VfsActorRole,
  ): Promise<{
    packet: VfsRecordPacket;
    envelopeBytes: Uint8Array<ArrayBuffer>;
    indexEntry: IndexedRecord;
    indexKvValue: Uint8Array<ArrayBuffer>;
    opHash: string;
  }> {
    const sealed = await sealSignedVfsOp({
      body,
      objKind,
      roomKey,
      sign: this.signFn,
    });
    const opKvKey = vfsOpKey(this.roomId, body.nodeId, body.deviceId, body.seq, sealed.opHash);
    const indexPayload: PersistedOpIndexEntry = {
      v: 1,
      epoch: body.epoch,
      objKind,
      nodeId: body.nodeId,
      deviceId: body.deviceId,
      seq: body.seq,
      opId: body.opId,
      cid: sealed.cid,
      receivedAt: this.nowFn(),
      signerRole,
      signerMemberId: body.memberId,
    };
    const indexKvValue = await this.sealDeviceLocal(opKvKey, indexPayload);
    const packet: VfsRecordPacket = {
      kind: 'vfs-record',
      v: VFS_PROTOCOL_VERSION,
      roomId: this.roomId,
      epoch: body.epoch,
      objKind,
      nodeId: body.nodeId,
      deviceId: body.deviceId,
      seq: body.seq,
      opId: body.opId,
      cid: sealed.cid,
      env: bytesToBase64(sealed.envelope.bytes),
    };
    return {
      packet,
      envelopeBytes: sealed.envelope.bytes,
      indexEntry: { ...indexPayload, opKvKey },
      indexKvValue,
      opHash: sealed.opHash,
    };
  }

  // -------------------------------------------------------------------------
  // Document Read, List, History & Diff API
  // -------------------------------------------------------------------------

  listDocs(opts?: { includeDeleted?: boolean }): VfsDocSummary[] {
    const includeDeleted = opts?.includeDeleted ?? false;
    const displayMap = this.computeDisplayPaths();
    const results: VfsDocSummary[] = [];

    for (const rec of this.docs.values()) {
      if (!rec.created) continue;
      if (!includeDeleted && rec.deleted) continue;
      const { displayPath, hasConflict } = this.displayPathFor(rec, displayMap);
      const bytes = rec.doc.utf8ByteLength();
      results.push({
        nodeId: rec.nodeId,
        path: displayPath,
        rawPath: rec.rawPath,
        hasConflict,
        rev: rec.doc.frontierRev(),
        bytes,
        overSoftLimit: bytes > VFS_DOC_SOFT_LIMIT_BYTES,
        deleted: rec.deleted,
        createdBy: rec.createdBy,
        updatedBy: rec.updatedBy,
        updatedAt: rec.updatedAt,
      });
    }

    results.sort((a, b) => {
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
    });
    return results;
  }

  private resolveTargetFrontier(docRec: DocRecord, rev: string): { frontier: string[]; label: string } {
    if (rev === 'head') {
      return { frontier: docRec.doc.frontier(), label: docRec.doc.frontierRev() };
    }
    if (rev === '' || rev === 'empty') {
      return { frontier: [], label: computeFrontierRev([]) };
    }
    const commit = docRec.commits.get(rev.toLowerCase());
    if (commit) {
      return { frontier: [...commit.docFrontier], label: commit.commitId };
    }
    const resolved = docRec.doc.resolveFrontier(rev);
    if (resolved) {
      return { frontier: resolved, label: rev };
    }
    // Check if any commit matches the `f:<16-hex>` digest even if frontierMap rolled over.
    for (const c of docRec.commits.values()) {
      if (c.docRev === rev) {
        return { frontier: [...c.docFrontier], label: rev };
      }
    }
    throw new VfsError('VFS_NOT_FOUND', `Revision "${rev}" not found on document ${docRec.nodeId}.`);
  }

  readDoc(nodeIdOrPath: string, opts?: { rev?: string }): VfsReadDocResult {
    const docRec = this.resolveDoc(nodeIdOrPath, true);
    const { displayPath } = this.displayPathFor(docRec);

    let text: string;
    let rev: string;
    if (opts?.rev !== undefined) {
      const target = this.resolveTargetFrontier(docRec, opts.rev);
      const materialized = docRec.doc.materializeAt(target.frontier);
      text = materialized.text;
      rev = materialized.rev;
    } else {
      text = docRec.doc.getText();
      rev = docRec.doc.frontierRev();
    }

    const bytes = utf8ByteLength(text);
    return {
      nodeId: docRec.nodeId,
      path: displayPath,
      rawPath: docRec.rawPath,
      rev,
      text,
      bytes,
      overSoftLimit: bytes > VFS_DOC_SOFT_LIMIT_BYTES,
      deleted: docRec.deleted,
      createdBy: docRec.createdBy,
      updatedBy: docRec.updatedBy,
      updatedAt: docRec.updatedAt,
    };
  }

  history(nodeIdOrPath: string, opts?: { limit?: number }): VfsHistoryEntry[] {
    const docRec = this.resolveDoc(nodeIdOrPath, true);
    const commits = [...docRec.commits.values()].sort((a, b) => {
      if (a.lamport !== b.lamport) return b.lamport - a.lamport;
      if (a.at !== b.at) return b.at - a.at;
      return a.commitId < b.commitId ? -1 : a.commitId > b.commitId ? 1 : 0;
    });

    const slice = opts?.limit !== undefined && opts.limit > 0 ? commits.slice(0, opts.limit) : commits;
    return slice.map(c => {
      const warnings = c.revertsCommit !== undefined
        ? detectConcurrentEditsDuringRevert(docRec.doc, c.revertOpHash)
        : [];
      return {
        commitId: c.commitId,
        scope: c.scope,
        nodeId: c.nodeId,
        rev: c.docRev,
        docFrontier: [...c.docFrontier],
        authorMemberId: c.memberId,
        authorDeviceId: c.deviceId,
        at: c.at,
        lamport: c.lamport,
        ...(c.message !== undefined ? { message: c.message } : {}),
        ...(c.path !== undefined ? { path: c.path } : {}),
        ...(c.revertsCommit !== undefined ? { revertsCommit: c.revertsCommit } : {}),
        ...(warnings.length > 0 ? { concurrentEditsDuringRevert: warnings } : {}),
      };
    });
  }

  diff(nodeIdOrPath: string, fromRev: string, toRev = 'head'): VfsDiffResult {
    const docRec = this.resolveDoc(nodeIdOrPath, true);
    const { displayPath } = this.displayPathFor(docRec);
    const fromTarget = this.resolveTargetFrontier(docRec, fromRev);
    const toTarget = this.resolveTargetFrontier(docRec, toRev);

    const fromState = docRec.doc.materializeAt(fromTarget.frontier);
    const toState = docRec.doc.materializeAt(toTarget.frontier);
    const built = buildUnifiedDiff(displayPath, fromState.text, toState.text);
    return {
      nodeId: docRec.nodeId,
      path: displayPath,
      fromRev: fromState.rev,
      toRev: toState.rev,
      ...built,
    };
  }

  // -------------------------------------------------------------------------
  // Document Mutation API (Create, Write, Patch, Revert, Delete, Restore)
  // -------------------------------------------------------------------------

  async createDoc(params: {
    path: string;
    content: string;
    requestId: string;
    message?: string;
    actorMemberId?: string;
    actorRole?: VfsActorRole;
  }): Promise<VfsWriteResult> {
    const activeEpoch = this.keyring.requireActiveEpoch();
    const actorMemberId = params.actorMemberId ?? this.selfMemberId;
    const actorRole = params.actorRole ?? this.selfRole;
    const replayed = await this.checkIdempotentReceipt<VfsWriteResult>(actorMemberId, params.requestId);
    if (replayed) return replayed;

    const normalizedPath = normalizeVfsPath(params.path);
    validateTextScalars(params.content);
    const contentBytes = utf8ByteLength(params.content);
    if (contentBytes > VFS_DOC_HARD_LIMIT_BYTES) {
      throw new VfsError(
        'VFS_LIMIT_EXCEEDED',
        `Document content (${contentBytes} bytes) exceeds hard ceiling (${VFS_DOC_HARD_LIMIT_BYTES} bytes).`,
      );
    }

    // Enforce MVP live document caps and local duplicate-path check.
    const folded = foldVfsPath(normalizedPath);
    let liveTotal = 0;
    let liveByActor = 0;
    const displayMap = this.computeDisplayPaths();
    for (const existing of this.docs.values()) {
      if (!existing.created || existing.deleted) continue;
      liveTotal++;
      if (existing.createdBy === actorMemberId) liveByActor++;
      const shown = displayMap.get(existing.nodeId)?.displayPath ?? existing.rawPath;
      if (foldVfsPath(shown) === folded || foldVfsPath(existing.rawPath) === folded) {
        throw new VfsError('VFS_ALREADY_EXISTS', `Document already exists at "${normalizedPath}".`);
      }
    }
    if (liveTotal >= VFS_MAX_DOCS_MVP) {
      throw new VfsError('VFS_LIMIT_EXCEEDED', `Room reached maximum live document cap (${VFS_MAX_DOCS_MVP}).`);
    }
    if (liveByActor >= VFS_MAX_DOCS_PER_MEMBER) {
      throw new VfsError(
        'VFS_LIMIT_EXCEEDED',
        `Member reached maximum live document cap (${VFS_MAX_DOCS_PER_MEMBER}).`,
      );
    }

    const nodeId = crypto.randomUUID().toLowerCase();
    const now = this.nowFn();
    const prevSeq = this.deviceSeq;
    const prevLamport = this.lamport;

    try {
      const treeSeq = this.nextSeq();
      const treeLamport = this.nextLamport();
      const treeBody: VfsTreeOpBody = canonicalize({
        v: 1,
        kind: 'vfs-tree-op',
        roomId: this.roomId,
        nodeId,
        opId: crypto.randomUUID().toLowerCase(),
        deviceId: this.selfDeviceId,
        memberId: actorMemberId,
        epoch: activeEpoch.epoch,
        seq: treeSeq,
        lamport: treeLamport,
        at: now,
        visibility: 'room',
        parents: [],
        action: {
          t: 'create',
          nodeKind: 'doc',
          parentId: VFS_ROOT_DIR_ID,
          path: normalizedPath,
          mime: 'text/plain',
        },
      });
      const sealedTree = await this.sealRecord(treeBody, VfsObjKind.TreeOp, activeEpoch.key, actorRole);

      const scratchDoc = new FugueMaxDoc({ roomId: this.roomId, nodeId, now: this.nowFn });
      const sealedDocs: Array<Awaited<ReturnType<VfsRoomEngine['sealRecord']>>> = [];
      const insertChunks = splitTextForSignedOps(params.content);
      let insertCursor = 0;

      for (const chunk of insertChunks) {
        const docSeq = this.nextSeq();
        const docLamport = this.nextLamport();
        const createdOp = scratchDoc.localInsert(insertCursor, chunk, {
          roomId: this.roomId,
          nodeId,
          opId: crypto.randomUUID().toLowerCase(),
          deviceId: this.selfDeviceId,
          memberId: actorMemberId,
          epoch: activeEpoch.epoch,
          seq: docSeq,
          lamport: docLamport,
          at: now,
          visibility: 'room',
        });
        insertCursor += validateTextScalars(chunk).length;
        sealedDocs.push(await this.sealRecord(createdOp.op, VfsObjKind.DocOp, activeEpoch.key, actorRole));
      }

      const commitId = crypto.randomUUID().toLowerCase();
      const commitSeq = this.nextSeq();
      const commitLamport = this.nextLamport();
      const contentSha256 = await sha256Hex(utf8Bytes(params.content));
      const commitBody: VfsCommitBody = canonicalize({
        v: 1,
        kind: 'vfs-commit',
        roomId: this.roomId,
        nodeId,
        opId: crypto.randomUUID().toLowerCase(),
        deviceId: this.selfDeviceId,
        memberId: actorMemberId,
        epoch: activeEpoch.epoch,
        seq: commitSeq,
        lamport: commitLamport,
        at: now,
        visibility: 'room',
        commitId,
        scope: 'doc',
        parentCommits: [],
        docFrontier: scratchDoc.frontier(),
        docRev: scratchDoc.frontierRev(),
        path: normalizedPath,
        contentSha256,
        ...(params.message !== undefined ? { message: params.message } : {}),
      });
      const sealedCommit = await this.sealRecord(commitBody, VfsObjKind.Commit, activeEpoch.key, actorRole);

      const rev = scratchDoc.frontierRev();
      const result: VfsWriteResult = {
        nodeId,
        path: normalizedPath,
        rev,
        commitId,
        bytes: contentBytes,
        overSoftLimit: contentBytes > VFS_DOC_SOFT_LIMIT_BYTES,
        replayed: false,
        outbound: [
          sealedTree.packet,
          ...sealedDocs.map(s => s.packet),
          sealedCommit.packet,
        ],
      };

      const receiptPrepared = await this.prepareReceiptKv(actorMemberId, params.requestId, 'write', result);
      const commitIdxKey = vfsCommitKey(this.roomId, now, commitId);
      const commitIdxBytes = await this.sealDeviceLocal(commitIdxKey, {
        nodeId,
        commitId,
        cid: sealedCommit.packet.cid,
      });

      const nodeHeadKey = vfsNodeHeadKey(this.roomId, nodeId);
      const nodeHeadBytes = await this.sealDeviceLocal(nodeHeadKey, {
        v: 1,
        nodeId,
        rawPath: normalizedPath,
        deleted: false,
        createdBy: actorMemberId,
        updatedBy: actorMemberId,
        updatedAt: now,
        currentRev: rev,
        latestCommitId: commitId,
      } satisfies PersistedNodeHead);

      const metaKey = vfsMetaKey(this.roomId);
      const metaBytes = await this.sealDeviceLocal(metaKey, this.buildMetaSnapshot());

      const kvEntries: Array<{ key: string; value: Uint8Array; ifAbsent?: boolean }> = [
        { key: vfsObjKey(this.roomId, sealedTree.packet.cid), value: sealedTree.envelopeBytes, ifAbsent: true },
        { key: sealedTree.indexEntry.opKvKey, value: sealedTree.indexKvValue, ifAbsent: true },
        ...sealedDocs.flatMap(sd => [
          { key: vfsObjKey(this.roomId, sd.packet.cid), value: sd.envelopeBytes, ifAbsent: true },
          { key: sd.indexEntry.opKvKey, value: sd.indexKvValue, ifAbsent: true },
        ]),
        { key: vfsObjKey(this.roomId, sealedCommit.packet.cid), value: sealedCommit.envelopeBytes, ifAbsent: true },
        { key: sealedCommit.indexEntry.opKvKey, value: sealedCommit.indexKvValue, ifAbsent: true },
        { key: commitIdxKey, value: commitIdxBytes },
        { key: receiptPrepared.key, value: receiptPrepared.value },
        { key: nodeHeadKey, value: nodeHeadBytes },
      ];

      await writeBeforePublish(this.store, {
        kvEntries,
        publishKey: metaKey,
        publishValue: metaBytes,
      });

      // Commit to in-memory state only after durable storage succeeded.
      const docRec = this.ensureDocRecord(nodeId);
      docRec.doc = scratchDoc;
      docRec.treeOps.set(sealedTree.opHash, { op: treeBody, opHash: sealedTree.opHash, signerRole: actorRole });
      this.foldTreeOps(docRec);
      docRec.commits.set(commitId, commitBody);
      docRec.latestCommitId = commitId;
      docRec.updatedBy = actorMemberId;
      docRec.updatedAt = now;

      this.trackIndexedRecord(sealedTree.indexEntry);
      for (const sd of sealedDocs) {
        this.trackIndexedRecord(sd.indexEntry);
        await this.maybeWriteDocCheckpoint(docRec, sd.envelopeBytes.byteLength);
      }
      this.trackIndexedRecord(sealedCommit.indexEntry);
      await this.recordReceiptInMemoryAndPrune(receiptPrepared.key, receiptPrepared.receipt);

      const { displayPath } = this.displayPathFor(docRec);
      result.path = displayPath;
      this.emitChange({
        kind: 'doc-created',
        nodeId,
        path: displayPath,
        rev,
        commitId,
        authorMemberId: actorMemberId,
        authorDeviceId: this.selfDeviceId,
        at: now,
        source: 'self',
      });
      return result;
    } catch (err) {
      this.deviceSeq = prevSeq;
      this.lamport = prevLamport;
      throw err;
    }
  }

  async writeDoc(params: {
    nodeIdOrPath: string;
    content: string;
    baseRev?: string;
    requestId: string;
    message?: string;
    actorMemberId?: string;
    actorRole?: VfsActorRole;
  }): Promise<VfsWriteResult> {
    const activeEpoch = this.keyring.requireActiveEpoch();
    const actorMemberId = params.actorMemberId ?? this.selfMemberId;
    const actorRole = params.actorRole ?? this.selfRole;
    const replayed = await this.checkIdempotentReceipt<VfsWriteResult>(actorMemberId, params.requestId);
    if (replayed) return replayed;

    const docRec = this.resolveDoc(params.nodeIdOrPath, false);
    const headRev = docRec.doc.frontierRev();
    if (params.baseRev !== undefined && params.baseRev !== headRev) {
      // Also allow matching the latest commit's ID if caller passed commitId as baseRev.
      const commitMatch = docRec.commits.get(params.baseRev.toLowerCase());
      if (!commitMatch || commitMatch.docRev !== headRev) {
        throw new VfsConflictError(params.baseRev, headRev, [
          {
            hunkIndex: -1,
            reason: 'boundary-changed',
            message: `Document changed since baseRev "${params.baseRev}" (current head "${headRev}").`,
          },
        ]);
      }
    }

    validateTextScalars(params.content);
    const contentBytes = utf8ByteLength(params.content);
    if (contentBytes > VFS_DOC_HARD_LIMIT_BYTES) {
      throw new VfsError(
        'VFS_LIMIT_EXCEEDED',
        `Document content (${contentBytes} bytes) exceeds hard ceiling (${VFS_DOC_HARD_LIMIT_BYTES} bytes).`,
      );
    }

    const now = this.nowFn();
    const prevSeq = this.deviceSeq;
    const prevLamport = this.lamport;

    try {
      const scratchDoc = docRec.doc.clone();
      const curLen = scratchDoc.visibleElements().length;
      const insertChunks = splitTextForSignedOps(params.content);
      const appliedLocalOps: Array<{ op: VfsDocOpBody; opHash: string }> = [];
      const sealedDocs: Array<Awaited<ReturnType<VfsRoomEngine['sealRecord']>>> = [];

      const makeOpMeta = () => ({
        roomId: this.roomId,
        nodeId: docRec.nodeId,
        opId: crypto.randomUUID().toLowerCase(),
        deviceId: this.selfDeviceId,
        memberId: actorMemberId,
        epoch: activeEpoch.epoch,
        seq: this.nextSeq(),
        lamport: this.nextLamport(),
        at: now,
        visibility: 'room' as const,
      });

      const canSingleReplace =
        curLen <= MAX_DOC_OP_DELETE_CODEPOINTS
        && insertChunks.length <= 1
        && (curLen === 0 || (() => {
          const delSub = scratchDoc.planDeleteAt(0, curLen);
          return delSub.t === 'del' && delSub.runs.length <= 64;
        })());

      if (canSingleReplace && (curLen > 0 || insertChunks.length === 1)) {
        const replaced = scratchDoc.localReplace(0, curLen, params.content, makeOpMeta());
        appliedLocalOps.push(replaced);
        sealedDocs.push(await this.sealRecord(replaced.op, VfsObjKind.DocOp, activeEpoch.key, actorRole));
      } else {
        // Chunk deletions first so each signed op stays strictly below 12 KiB (even on heavily fragmented docs).
        let remaining = curLen;
        while (remaining > 0) {
          let step = Math.min(remaining, MAX_DOC_OP_DELETE_CODEPOINTS);
          while (step > 1) {
            const candidate = scratchDoc.planDeleteAt(0, step);
            if (candidate.t === 'del' && candidate.runs.length <= 64) break;
            step = Math.max(1, Math.floor(step / 2));
          }
          const delOp = scratchDoc.localDelete(0, step, makeOpMeta());
          appliedLocalOps.push(delOp);
          sealedDocs.push(await this.sealRecord(delOp.op, VfsObjKind.DocOp, activeEpoch.key, actorRole));
          remaining -= step;
        }
        let insertCursor = 0;
        for (const chunk of insertChunks) {
          const insOp = scratchDoc.localInsert(insertCursor, chunk, makeOpMeta());
          insertCursor += validateTextScalars(chunk).length;
          appliedLocalOps.push(insOp);
          sealedDocs.push(await this.sealRecord(insOp.op, VfsObjKind.DocOp, activeEpoch.key, actorRole));
        }
      }

      const commitId = crypto.randomUUID().toLowerCase();
      const commitSeq = this.nextSeq();
      const commitLamport = this.nextLamport();
      const contentSha256 = await sha256Hex(utf8Bytes(params.content));
      const { displayPath } = this.displayPathFor(docRec);
      const commitBody: VfsCommitBody = canonicalize({
        v: 1,
        kind: 'vfs-commit',
        roomId: this.roomId,
        nodeId: docRec.nodeId,
        opId: crypto.randomUUID().toLowerCase(),
        deviceId: this.selfDeviceId,
        memberId: actorMemberId,
        epoch: activeEpoch.epoch,
        seq: commitSeq,
        lamport: commitLamport,
        at: now,
        visibility: 'room',
        commitId,
        scope: 'doc',
        parentCommits: docRec.latestCommitId ? [docRec.latestCommitId] : [],
        docFrontier: scratchDoc.frontier(),
        docRev: scratchDoc.frontierRev(),
        path: displayPath,
        contentSha256,
        ...(params.message !== undefined ? { message: params.message } : {}),
      });
      const sealedCommit = await this.sealRecord(commitBody, VfsObjKind.Commit, activeEpoch.key, actorRole);

      const rev = scratchDoc.frontierRev();
      const result: VfsWriteResult = {
        nodeId: docRec.nodeId,
        path: displayPath,
        rev,
        commitId,
        bytes: contentBytes,
        overSoftLimit: contentBytes > VFS_DOC_SOFT_LIMIT_BYTES,
        replayed: false,
        outbound: [...sealedDocs.map(sd => sd.packet), sealedCommit.packet],
      };

      const receiptPrepared = await this.prepareReceiptKv(actorMemberId, params.requestId, 'write', result);
      const commitIdxKey = vfsCommitKey(this.roomId, now, commitId);
      const commitIdxBytes = await this.sealDeviceLocal(commitIdxKey, {
        nodeId: docRec.nodeId,
        commitId,
        cid: sealedCommit.packet.cid,
      });

      const nodeHeadKey = vfsNodeHeadKey(this.roomId, docRec.nodeId);
      const nodeHeadBytes = await this.sealDeviceLocal(nodeHeadKey, {
        ...this.buildNodeHeadPayload(docRec),
        updatedBy: actorMemberId,
        updatedAt: now,
        currentRev: rev,
        latestCommitId: commitId,
      });
      const metaKey = vfsMetaKey(this.roomId);
      const metaBytes = await this.sealDeviceLocal(metaKey, this.buildMetaSnapshot());

      await writeBeforePublish(this.store, {
        kvEntries: [
          ...sealedDocs.flatMap(sd => [
            { key: vfsObjKey(this.roomId, sd.packet.cid), value: sd.envelopeBytes, ifAbsent: true },
            { key: sd.indexEntry.opKvKey, value: sd.indexKvValue, ifAbsent: true },
          ]),
          { key: vfsObjKey(this.roomId, sealedCommit.packet.cid), value: sealedCommit.envelopeBytes, ifAbsent: true },
          { key: sealedCommit.indexEntry.opKvKey, value: sealedCommit.indexKvValue, ifAbsent: true },
          { key: commitIdxKey, value: commitIdxBytes },
          { key: receiptPrepared.key, value: receiptPrepared.value },
          { key: nodeHeadKey, value: nodeHeadBytes },
        ],
        publishKey: metaKey,
        publishValue: metaBytes,
      });

      for (const item of appliedLocalOps) {
        docRec.doc.applyOp(item.op, item.opHash);
      }
      docRec.commits.set(commitId, commitBody);
      docRec.latestCommitId = commitId;
      docRec.updatedBy = actorMemberId;
      docRec.updatedAt = now;

      for (const sd of sealedDocs) {
        this.trackIndexedRecord(sd.indexEntry);
        await this.maybeWriteDocCheckpoint(docRec, sd.envelopeBytes.byteLength);
      }
      this.trackIndexedRecord(sealedCommit.indexEntry);
      await this.recordReceiptInMemoryAndPrune(receiptPrepared.key, receiptPrepared.receipt);

      this.emitChange({
        kind: 'doc-updated',
        nodeId: docRec.nodeId,
        path: displayPath,
        rev,
        commitId,
        authorMemberId: actorMemberId,
        authorDeviceId: this.selfDeviceId,
        at: now,
        source: 'self',
      });
      return result;
    } catch (err) {
      this.deviceSeq = prevSeq;
      this.lamport = prevLamport;
      throw err;
    }
  }

  async patchDoc(params: {
    nodeIdOrPath: string;
    baseRev: string;
    hunks: readonly VfsEditHunk[];
    requestId: string;
    message?: string;
    actorMemberId?: string;
    actorRole?: VfsActorRole;
  }): Promise<VfsPatchResult> {
    const activeEpoch = this.keyring.requireActiveEpoch();
    const actorMemberId = params.actorMemberId ?? this.selfMemberId;
    const actorRole = params.actorRole ?? this.selfRole;
    const replayed = await this.checkIdempotentReceipt<VfsPatchResult>(actorMemberId, params.requestId);
    if (replayed) return replayed;

    const docRec = this.resolveDoc(params.nodeIdOrPath, true);
    if (docRec.deleted) {
      throw new VfsConflictError(params.baseRev, docRec.doc.frontierRev(), [
        {
          hunkIndex: -1,
          reason: 'doc-deleted',
          message: `Document "${docRec.rawPath}" has been soft-deleted.`,
        },
      ]);
    }

    const baseCommit = docRec.commits.get(params.baseRev.toLowerCase());
    const now = this.nowFn();
    const prevSeq = this.deviceSeq;
    const prevLamport = this.lamport;

    try {
      const docSeq = this.nextSeq();
      const docLamport = this.nextLamport();
      const meta: FugueLocalOpMeta = {
        roomId: this.roomId,
        nodeId: docRec.nodeId,
        opId: crypto.randomUUID().toLowerCase(),
        deviceId: this.selfDeviceId,
        memberId: actorMemberId,
        epoch: activeEpoch.epoch,
        seq: docSeq,
        lamport: docLamport,
        at: now,
        visibility: 'room',
      };

      const built = buildPatchOp(docRec.doc, {
        baseRev: params.baseRev,
        ...(baseCommit ? { baseFrontier: baseCommit.docFrontier } : {}),
        hunks: params.hunks,
        meta,
        apply: false,
      });

      const scratchDoc = docRec.doc.clone();
      scratchDoc.applyOp(built.op, built.opHash);
      const nextBytes = scratchDoc.utf8ByteLength();
      const sealedDoc = await this.sealRecord(built.op, VfsObjKind.DocOp, activeEpoch.key, actorRole);

      const commitId = crypto.randomUUID().toLowerCase();
      const commitSeq = this.nextSeq();
      const commitLamport = this.nextLamport();
      const contentSha256 = await sha256Hex(utf8Bytes(built.nextText));
      const { displayPath } = this.displayPathFor(docRec);
      const commitBody: VfsCommitBody = canonicalize({
        v: 1,
        kind: 'vfs-commit',
        roomId: this.roomId,
        nodeId: docRec.nodeId,
        opId: crypto.randomUUID().toLowerCase(),
        deviceId: this.selfDeviceId,
        memberId: actorMemberId,
        epoch: activeEpoch.epoch,
        seq: commitSeq,
        lamport: commitLamport,
        at: now,
        visibility: 'room',
        commitId,
        scope: 'doc',
        parentCommits: docRec.latestCommitId ? [docRec.latestCommitId] : [],
        docFrontier: scratchDoc.frontier(),
        docRev: built.nextRev,
        path: displayPath,
        contentSha256,
        ...(params.message !== undefined ? { message: params.message } : {}),
      });
      const sealedCommit = await this.sealRecord(commitBody, VfsObjKind.Commit, activeEpoch.key, actorRole);

      const result: VfsPatchResult = {
        nodeId: docRec.nodeId,
        path: displayPath,
        baseRev: params.baseRev,
        rev: built.nextRev,
        commitId,
        rebased: built.rebased,
        bytes: nextBytes,
        overSoftLimit: nextBytes > VFS_DOC_SOFT_LIMIT_BYTES,
        replayed: false,
        outbound: [sealedDoc.packet, sealedCommit.packet],
      };

      const receiptPrepared = await this.prepareReceiptKv(actorMemberId, params.requestId, 'patch', result);
      const commitIdxKey = vfsCommitKey(this.roomId, now, commitId);
      const commitIdxBytes = await this.sealDeviceLocal(commitIdxKey, {
        nodeId: docRec.nodeId,
        commitId,
        cid: sealedCommit.packet.cid,
      });
      const nodeHeadKey = vfsNodeHeadKey(this.roomId, docRec.nodeId);
      const nodeHeadBytes = await this.sealDeviceLocal(nodeHeadKey, {
        ...this.buildNodeHeadPayload(docRec),
        updatedBy: actorMemberId,
        updatedAt: now,
        currentRev: built.nextRev,
        latestCommitId: commitId,
      });
      const metaKey = vfsMetaKey(this.roomId);
      const metaBytes = await this.sealDeviceLocal(metaKey, this.buildMetaSnapshot());

      await writeBeforePublish(this.store, {
        kvEntries: [
          { key: vfsObjKey(this.roomId, sealedDoc.packet.cid), value: sealedDoc.envelopeBytes, ifAbsent: true },
          { key: sealedDoc.indexEntry.opKvKey, value: sealedDoc.indexKvValue, ifAbsent: true },
          { key: vfsObjKey(this.roomId, sealedCommit.packet.cid), value: sealedCommit.envelopeBytes, ifAbsent: true },
          { key: sealedCommit.indexEntry.opKvKey, value: sealedCommit.indexKvValue, ifAbsent: true },
          { key: commitIdxKey, value: commitIdxBytes },
          { key: receiptPrepared.key, value: receiptPrepared.value },
          { key: nodeHeadKey, value: nodeHeadBytes },
        ],
        publishKey: metaKey,
        publishValue: metaBytes,
      });

      docRec.doc.applyOp(built.op, built.opHash);
      docRec.commits.set(commitId, commitBody);
      docRec.latestCommitId = commitId;
      docRec.updatedBy = actorMemberId;
      docRec.updatedAt = now;

      this.trackIndexedRecord(sealedDoc.indexEntry);
      this.trackIndexedRecord(sealedCommit.indexEntry);
      await this.maybeWriteDocCheckpoint(docRec, sealedDoc.envelopeBytes.byteLength);
      await this.recordReceiptInMemoryAndPrune(receiptPrepared.key, receiptPrepared.receipt);

      this.emitChange({
        kind: 'doc-updated',
        nodeId: docRec.nodeId,
        path: displayPath,
        rev: built.nextRev,
        commitId,
        authorMemberId: actorMemberId,
        authorDeviceId: this.selfDeviceId,
        at: now,
        source: 'self',
      });
      return result;
    } catch (err) {
      this.deviceSeq = prevSeq;
      this.lamport = prevLamport;
      throw err;
    }
  }

  async revertDoc(params: {
    nodeIdOrPath: string;
    targetCommitId: string;
    baseRev?: string;
    requestId: string;
    message?: string;
    actorMemberId?: string;
    actorRole?: VfsActorRole;
  }): Promise<VfsRevertResult> {
    const activeEpoch = this.keyring.requireActiveEpoch();
    const actorMemberId = params.actorMemberId ?? this.selfMemberId;
    const actorRole = params.actorRole ?? this.selfRole;
    const replayed = await this.checkIdempotentReceipt<VfsRevertResult>(actorMemberId, params.requestId);
    if (replayed) return replayed;

    const docRec = this.resolveDoc(params.nodeIdOrPath, false);
    const headRev = docRec.doc.frontierRev();
    if (params.baseRev !== undefined && params.baseRev !== headRev) {
      throw new VfsConflictError(params.baseRev, headRev, [
        {
          hunkIndex: -1,
          reason: 'boundary-changed',
          message: `Document changed since baseRev "${params.baseRev}" (current head "${headRev}").`,
        },
      ]);
    }

    const target = this.resolveTargetFrontier(docRec, params.targetCommitId);
    const now = this.nowFn();
    const prevSeq = this.deviceSeq;
    const prevLamport = this.lamport;

    try {
      const docSeq = this.nextSeq();
      const docLamport = this.nextLamport();
      const built = buildRevertOp(docRec.doc, {
        targetFrontier: target.frontier,
        revertsCommit: target.label,
        meta: {
          roomId: this.roomId,
          nodeId: docRec.nodeId,
          opId: crypto.randomUUID().toLowerCase(),
          deviceId: this.selfDeviceId,
          memberId: actorMemberId,
          epoch: activeEpoch.epoch,
          seq: docSeq,
          lamport: docLamport,
          at: now,
          visibility: 'room',
        },
        apply: false,
      });

      const scratchDoc = docRec.doc.clone();
      scratchDoc.applyOp(built.op, built.opHash);
      const nextBytes = scratchDoc.utf8ByteLength();
      const sealedDoc = await this.sealRecord(built.op, VfsObjKind.DocOp, activeEpoch.key, actorRole);

      const commitId = crypto.randomUUID().toLowerCase();
      const commitSeq = this.nextSeq();
      const commitLamport = this.nextLamport();
      const contentSha256 = await sha256Hex(utf8Bytes(built.nextText));
      const { displayPath } = this.displayPathFor(docRec);
      const commitBody: VfsCommitBody = canonicalize({
        v: 1,
        kind: 'vfs-commit',
        roomId: this.roomId,
        nodeId: docRec.nodeId,
        opId: crypto.randomUUID().toLowerCase(),
        deviceId: this.selfDeviceId,
        memberId: actorMemberId,
        epoch: activeEpoch.epoch,
        seq: commitSeq,
        lamport: commitLamport,
        at: now,
        visibility: 'room',
        commitId,
        scope: 'doc',
        parentCommits: docRec.latestCommitId ? [docRec.latestCommitId] : [],
        docFrontier: scratchDoc.frontier(),
        docRev: built.nextRev,
        path: displayPath,
        contentSha256,
        revertsCommit: target.label,
        revertOpHash: built.opHash,
        ...(params.message !== undefined ? { message: params.message } : {}),
      });
      const sealedCommit = await this.sealRecord(commitBody, VfsObjKind.Commit, activeEpoch.key, actorRole);
      const concurrentWarnings = detectConcurrentEditsDuringRevert(scratchDoc, built.opHash);

      const result: VfsRevertResult = {
        nodeId: docRec.nodeId,
        path: displayPath,
        rev: built.nextRev,
        commitId,
        targetCommitId: target.label,
        noChanges: built.noChanges,
        bytes: nextBytes,
        overSoftLimit: nextBytes > VFS_DOC_SOFT_LIMIT_BYTES,
        concurrentEditsDuringRevert: concurrentWarnings,
        replayed: false,
        outbound: [sealedDoc.packet, sealedCommit.packet],
      };

      const receiptPrepared = await this.prepareReceiptKv(actorMemberId, params.requestId, 'revert', result);
      const commitIdxKey = vfsCommitKey(this.roomId, now, commitId);
      const commitIdxBytes = await this.sealDeviceLocal(commitIdxKey, {
        nodeId: docRec.nodeId,
        commitId,
        cid: sealedCommit.packet.cid,
      });
      const nodeHeadKey = vfsNodeHeadKey(this.roomId, docRec.nodeId);
      const nodeHeadBytes = await this.sealDeviceLocal(nodeHeadKey, {
        ...this.buildNodeHeadPayload(docRec),
        updatedBy: actorMemberId,
        updatedAt: now,
        currentRev: built.nextRev,
        latestCommitId: commitId,
      });
      const metaKey = vfsMetaKey(this.roomId);
      const metaBytes = await this.sealDeviceLocal(metaKey, this.buildMetaSnapshot());

      await writeBeforePublish(this.store, {
        kvEntries: [
          { key: vfsObjKey(this.roomId, sealedDoc.packet.cid), value: sealedDoc.envelopeBytes, ifAbsent: true },
          { key: sealedDoc.indexEntry.opKvKey, value: sealedDoc.indexKvValue, ifAbsent: true },
          { key: vfsObjKey(this.roomId, sealedCommit.packet.cid), value: sealedCommit.envelopeBytes, ifAbsent: true },
          { key: sealedCommit.indexEntry.opKvKey, value: sealedCommit.indexKvValue, ifAbsent: true },
          { key: commitIdxKey, value: commitIdxBytes },
          { key: receiptPrepared.key, value: receiptPrepared.value },
          { key: nodeHeadKey, value: nodeHeadBytes },
        ],
        publishKey: metaKey,
        publishValue: metaBytes,
      });

      docRec.doc.applyOp(built.op, built.opHash);
      docRec.commits.set(commitId, commitBody);
      docRec.latestCommitId = commitId;
      docRec.updatedBy = actorMemberId;
      docRec.updatedAt = now;

      this.trackIndexedRecord(sealedDoc.indexEntry);
      this.trackIndexedRecord(sealedCommit.indexEntry);
      await this.maybeWriteDocCheckpoint(docRec, sealedDoc.envelopeBytes.byteLength);
      await this.recordReceiptInMemoryAndPrune(receiptPrepared.key, receiptPrepared.receipt);

      this.emitChange({
        kind: 'doc-reverted',
        nodeId: docRec.nodeId,
        path: displayPath,
        rev: built.nextRev,
        commitId,
        authorMemberId: actorMemberId,
        authorDeviceId: this.selfDeviceId,
        at: now,
        source: 'self',
      });
      return result;
    } catch (err) {
      this.deviceSeq = prevSeq;
      this.lamport = prevLamport;
      throw err;
    }
  }

  /**
   * Soft-deletes a document. Enforces Decision 4:
   * - Humans may soft-delete any document.
   * - Agents may ONLY soft-delete documents they created (`doc.createdBy === actorMemberId`).
   */
  async deleteDoc(params: {
    nodeIdOrPath: string;
    requestId: string;
    actorRole?: VfsActorRole;
    actorMemberId?: string;
    message?: string;
  }): Promise<VfsDeleteResult> {
    const activeEpoch = this.keyring.requireActiveEpoch();
    const actorRole = params.actorRole ?? this.selfRole;
    const actorMemberId = params.actorMemberId ?? this.selfMemberId;
    const replayed = await this.checkIdempotentReceipt<VfsDeleteResult>(actorMemberId, params.requestId);
    if (replayed) return replayed;

    const docRec = this.resolveDoc(params.nodeIdOrPath, false);
    if (actorRole !== 'human' && docRec.createdBy !== actorMemberId) {
      throw new VfsUnauthorizedError(
        'Agents may only soft-delete documents they created; ask a human room member to delete shared documents.',
        { nodeId: docRec.nodeId, createdBy: docRec.createdBy, actorMemberId, actorRole },
      );
    }

    const { displayPath } = this.displayPathFor(docRec);
    const now = this.nowFn();
    const prevSeq = this.deviceSeq;
    const prevLamport = this.lamport;

    try {
      const treeSeq = this.nextSeq();
      const treeLamport = this.nextLamport();
      const treeBody: VfsTreeOpBody = canonicalize({
        v: 1,
        kind: 'vfs-tree-op',
        roomId: this.roomId,
        nodeId: docRec.nodeId,
        opId: crypto.randomUUID().toLowerCase(),
        deviceId: this.selfDeviceId,
        memberId: actorMemberId,
        epoch: activeEpoch.epoch,
        seq: treeSeq,
        lamport: treeLamport,
        at: now,
        visibility: 'room',
        parents: this.treeOpFrontier(docRec),
        action: { t: 'delete' },
      });
      const sealedTree = await this.sealRecord(treeBody, VfsObjKind.TreeOp, activeEpoch.key, actorRole);

      const commitId = crypto.randomUUID().toLowerCase();
      const commitSeq = this.nextSeq();
      const commitLamport = this.nextLamport();
      const commitBody: VfsCommitBody = canonicalize({
        v: 1,
        kind: 'vfs-commit',
        roomId: this.roomId,
        nodeId: docRec.nodeId,
        opId: crypto.randomUUID().toLowerCase(),
        deviceId: this.selfDeviceId,
        memberId: actorMemberId,
        epoch: activeEpoch.epoch,
        seq: commitSeq,
        lamport: commitLamport,
        at: now,
        visibility: 'room',
        commitId,
        scope: 'tree',
        parentCommits: docRec.latestCommitId ? [docRec.latestCommitId] : [],
        docFrontier: docRec.doc.frontier(),
        docRev: docRec.doc.frontierRev(),
        path: displayPath,
        message: params.message ?? `Soft-deleted ${displayPath}`,
      });
      const sealedCommit = await this.sealRecord(commitBody, VfsObjKind.Commit, activeEpoch.key, actorRole);

      const result: VfsDeleteResult = {
        nodeId: docRec.nodeId,
        path: displayPath,
        deleted: true,
        commitId,
        replayed: false,
        outbound: [sealedTree.packet, sealedCommit.packet],
      };

      const receiptPrepared = await this.prepareReceiptKv(actorMemberId, params.requestId, 'delete', result);
      const commitIdxKey = vfsCommitKey(this.roomId, now, commitId);
      const commitIdxBytes = await this.sealDeviceLocal(commitIdxKey, {
        nodeId: docRec.nodeId,
        commitId,
        cid: sealedCommit.packet.cid,
      });
      const nodeHeadKey = vfsNodeHeadKey(this.roomId, docRec.nodeId);
      const nodeHeadBytes = await this.sealDeviceLocal(nodeHeadKey, {
        ...this.buildNodeHeadPayload(docRec),
        deleted: true,
        updatedBy: actorMemberId,
        updatedAt: now,
        latestCommitId: commitId,
      });
      const metaKey = vfsMetaKey(this.roomId);
      const metaBytes = await this.sealDeviceLocal(metaKey, this.buildMetaSnapshot());

      await writeBeforePublish(this.store, {
        kvEntries: [
          { key: vfsObjKey(this.roomId, sealedTree.packet.cid), value: sealedTree.envelopeBytes, ifAbsent: true },
          { key: sealedTree.indexEntry.opKvKey, value: sealedTree.indexKvValue, ifAbsent: true },
          { key: vfsObjKey(this.roomId, sealedCommit.packet.cid), value: sealedCommit.envelopeBytes, ifAbsent: true },
          { key: sealedCommit.indexEntry.opKvKey, value: sealedCommit.indexKvValue, ifAbsent: true },
          { key: commitIdxKey, value: commitIdxBytes },
          { key: receiptPrepared.key, value: receiptPrepared.value },
          { key: nodeHeadKey, value: nodeHeadBytes },
        ],
        publishKey: metaKey,
        publishValue: metaBytes,
      });

      docRec.treeOps.set(sealedTree.opHash, { op: treeBody, opHash: sealedTree.opHash, signerRole: actorRole });
      this.foldTreeOps(docRec);
      docRec.commits.set(commitId, commitBody);
      docRec.latestCommitId = commitId;
      docRec.updatedBy = actorMemberId;
      docRec.updatedAt = now;

      this.trackIndexedRecord(sealedTree.indexEntry);
      this.trackIndexedRecord(sealedCommit.indexEntry);
      await this.recordReceiptInMemoryAndPrune(receiptPrepared.key, receiptPrepared.receipt);

      this.emitChange({
        kind: 'doc-deleted',
        nodeId: docRec.nodeId,
        path: displayPath,
        rev: docRec.doc.frontierRev(),
        commitId,
        authorMemberId: actorMemberId,
        authorDeviceId: this.selfDeviceId,
        at: now,
        source: 'self',
      });
      return result;
    } catch (err) {
      this.deviceSeq = prevSeq;
      this.lamport = prevLamport;
      throw err;
    }
  }

  /** Restores a soft-deleted document (Decision 4: humans only). */
  async restoreDoc(params: {
    nodeIdOrPath: string;
    requestId: string;
    actorRole?: VfsActorRole;
    actorMemberId?: string;
    path?: string;
    message?: string;
  }): Promise<VfsDeleteResult> {
    const activeEpoch = this.keyring.requireActiveEpoch();
    const actorRole = params.actorRole ?? this.selfRole;
    const actorMemberId = params.actorMemberId ?? this.selfMemberId;
    if (actorRole !== 'human') {
      throw new VfsUnauthorizedError('Only human room members may restore soft-deleted documents.', {
        actorMemberId,
        actorRole,
      });
    }

    const replayed = await this.checkIdempotentReceipt<VfsDeleteResult>(actorMemberId, params.requestId);
    if (replayed) return replayed;

    const docRec = this.resolveDoc(params.nodeIdOrPath, true);
    const restoredPath = params.path !== undefined ? normalizeVfsPath(params.path) : undefined;
    const now = this.nowFn();
    const prevSeq = this.deviceSeq;
    const prevLamport = this.lamport;

    try {
      const treeSeq = this.nextSeq();
      const treeLamport = this.nextLamport();
      const treeBody: VfsTreeOpBody = canonicalize({
        v: 1,
        kind: 'vfs-tree-op',
        roomId: this.roomId,
        nodeId: docRec.nodeId,
        opId: crypto.randomUUID().toLowerCase(),
        deviceId: this.selfDeviceId,
        memberId: actorMemberId,
        epoch: activeEpoch.epoch,
        seq: treeSeq,
        lamport: treeLamport,
        at: now,
        visibility: 'room',
        parents: this.treeOpFrontier(docRec),
        action: { t: 'restore', ...(restoredPath !== undefined ? { path: restoredPath } : {}) },
      });
      const sealedTree = await this.sealRecord(treeBody, VfsObjKind.TreeOp, activeEpoch.key, actorRole);

      const commitId = crypto.randomUUID().toLowerCase();
      const commitSeq = this.nextSeq();
      const commitLamport = this.nextLamport();
      const targetPath = restoredPath ?? docRec.rawPath;
      const commitBody: VfsCommitBody = canonicalize({
        v: 1,
        kind: 'vfs-commit',
        roomId: this.roomId,
        nodeId: docRec.nodeId,
        opId: crypto.randomUUID().toLowerCase(),
        deviceId: this.selfDeviceId,
        memberId: actorMemberId,
        epoch: activeEpoch.epoch,
        seq: commitSeq,
        lamport: commitLamport,
        at: now,
        visibility: 'room',
        commitId,
        scope: 'tree',
        parentCommits: docRec.latestCommitId ? [docRec.latestCommitId] : [],
        docFrontier: docRec.doc.frontier(),
        docRev: docRec.doc.frontierRev(),
        path: targetPath,
        message: params.message ?? `Restored ${targetPath}`,
      });
      const sealedCommit = await this.sealRecord(commitBody, VfsObjKind.Commit, activeEpoch.key, actorRole);

      const result: VfsDeleteResult = {
        nodeId: docRec.nodeId,
        path: targetPath,
        deleted: false,
        commitId,
        replayed: false,
        outbound: [sealedTree.packet, sealedCommit.packet],
      };

      const receiptPrepared = await this.prepareReceiptKv(actorMemberId, params.requestId, 'delete', result);
      const commitIdxKey = vfsCommitKey(this.roomId, now, commitId);
      const commitIdxBytes = await this.sealDeviceLocal(commitIdxKey, {
        nodeId: docRec.nodeId,
        commitId,
        cid: sealedCommit.packet.cid,
      });
      const nodeHeadKey = vfsNodeHeadKey(this.roomId, docRec.nodeId);
      const nodeHeadBytes = await this.sealDeviceLocal(nodeHeadKey, {
        ...this.buildNodeHeadPayload(docRec),
        rawPath: targetPath,
        deleted: false,
        updatedBy: actorMemberId,
        updatedAt: now,
        latestCommitId: commitId,
      });
      const metaKey = vfsMetaKey(this.roomId);
      const metaBytes = await this.sealDeviceLocal(metaKey, this.buildMetaSnapshot());

      await writeBeforePublish(this.store, {
        kvEntries: [
          { key: vfsObjKey(this.roomId, sealedTree.packet.cid), value: sealedTree.envelopeBytes, ifAbsent: true },
          { key: sealedTree.indexEntry.opKvKey, value: sealedTree.indexKvValue, ifAbsent: true },
          { key: vfsObjKey(this.roomId, sealedCommit.packet.cid), value: sealedCommit.envelopeBytes, ifAbsent: true },
          { key: sealedCommit.indexEntry.opKvKey, value: sealedCommit.indexKvValue, ifAbsent: true },
          { key: commitIdxKey, value: commitIdxBytes },
          { key: receiptPrepared.key, value: receiptPrepared.value },
          { key: nodeHeadKey, value: nodeHeadBytes },
        ],
        publishKey: metaKey,
        publishValue: metaBytes,
      });

      docRec.treeOps.set(sealedTree.opHash, { op: treeBody, opHash: sealedTree.opHash, signerRole: actorRole });
      this.foldTreeOps(docRec);
      docRec.commits.set(commitId, commitBody);
      docRec.latestCommitId = commitId;
      docRec.updatedBy = actorMemberId;
      docRec.updatedAt = now;

      this.trackIndexedRecord(sealedTree.indexEntry);
      this.trackIndexedRecord(sealedCommit.indexEntry);
      await this.recordReceiptInMemoryAndPrune(receiptPrepared.key, receiptPrepared.receipt);

      const { displayPath } = this.displayPathFor(docRec);
      result.path = displayPath;
      this.emitChange({
        kind: 'doc-restored',
        nodeId: docRec.nodeId,
        path: displayPath,
        rev: docRec.doc.frontierRev(),
        commitId,
        authorMemberId: actorMemberId,
        authorDeviceId: this.selfDeviceId,
        at: now,
        source: 'self',
      });
      return result;
    } catch (err) {
      this.deviceSeq = prevSeq;
      this.lamport = prevLamport;
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // P2P Anti-Entropy Sync API (`buildHave`, `handleHave`, `acceptRecord`, `acceptOps`)
  // -------------------------------------------------------------------------

  /** Returns the room's O(1) deterministic SHA-256 digest over all replicated record CIDs. */
  async getFrontierHash(): Promise<string> {
    if (this.cachedFrontierHash === null) {
      this.cachedFrontierHash = await computeVfsFrontierHash(this.recordsByCid.keys());
    }
    return this.cachedFrontierHash;
  }

  private computeContiguousHeads(): Record<string, number> {
    const deviceIds = [...this.deviceSeqNumbers.keys()].sort().slice(0, VFS_HAVE_MAX_HEADS);
    const heads: Record<string, number> = {};
    for (const devId of deviceIds) {
      const seqs = this.deviceSeqNumbers.get(devId)!;
      let contiguous = 0;
      while (seqs.has(contiguous + 1) && !this.conflictedDeviceSeqs.has(`${devId}:${contiguous + 1}`)) {
        contiguous++;
      }
      heads[devId] = contiguous;
    }
    return heads;
  }

  async buildHave(opts?: { cursor?: string; nodeId?: string }): Promise<VfsHavePacket> {
    const frontierHash = await this.getFrontierHash();
    const heads = this.computeContiguousHeads();
    const conflicts = [...this.conflictIds].sort();
    return {
      kind: 'vfs-have',
      v: VFS_PROTOCOL_VERSION,
      roomId: this.roomId,
      deviceId: this.selfDeviceId,
      frontierHash,
      latestEpoch: this.keyring.activeEpoch,
      heads,
      ...(opts?.cursor !== undefined ? { cursor: opts.cursor } : {}),
      ...(opts?.nodeId !== undefined ? { nodeId: opts.nodeId } : {}),
      ...(conflicts.length > 0 ? { conflictIds: conflicts } : {}),
    };
  }

  async handleHave(have: VfsHavePacket): Promise<VfsHandleHaveResult> {
    if (!isVfsHavePacket(have, this.roomId)) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'Invalid vfs-have packet.');
    }

    // 1. Collect any missing key epoch bundles (`epoch > have.latestEpoch`).
    const keyPackets: Array<VfsKeyEpochPacket | VfsKeyWrapPacket> = [];
    for (const epoch of this.keyring.listEpochs()) {
      if (epoch <= have.latestEpoch) continue;
      const bundle = this.epochBundles.get(epoch);
      if (!bundle) continue;
      keyPackets.push(wrapKeyEpochPacket(bundle.header));
      for (const chunk of bundle.wrapChunks) {
        keyPackets.push(wrapKeyWrapPacket(chunk));
      }
    }

    // 2. O(1) fast-path: identical frontierHash means zero missing ops.
    const selfFrontier = await this.getFrontierHash();
    if (have.frontierHash === selfFrontier) {
      return { keyPackets, opsPages: [] };
    }

    // 3. Collect records missing from remote's `heads` vector (and any conflicted seqs).
    const candidates: IndexedRecord[] = [];
    for (const rec of this.recordsByCid.values()) {
      if (have.nodeId !== undefined && rec.nodeId !== have.nodeId) continue;
      const remoteSeq = have.heads[rec.deviceId] ?? have.heads[`${rec.nodeId}:${rec.deviceId}`] ?? 0;
      const isConflicted = this.conflictedDeviceSeqs.has(`${rec.deviceId}:${rec.seq}`);
      if (rec.seq <= remoteSeq && !isConflicted) continue;
      if (have.cursor !== undefined && encodeSyncCursor(rec) <= have.cursor) continue;
      candidates.push(rec);
    }

    candidates.sort(compareSyncOrder);

    const recordPackets: VfsRecordPacket[] = [];
    for (const rec of candidates) {
      const envBytes = await this.store.kvGet(vfsObjKey(this.roomId, rec.cid));
      if (!envBytes) continue;
      recordPackets.push({
        kind: 'vfs-record',
        v: VFS_PROTOCOL_VERSION,
        roomId: this.roomId,
        epoch: rec.epoch,
        objKind: rec.objKind,
        nodeId: rec.nodeId,
        deviceId: rec.deviceId,
        seq: rec.seq,
        opId: rec.opId,
        cid: rec.cid,
        env: bytesToBase64(envBytes),
      });
    }

    const opsPages = chunkVfsOpsPages(this.roomId, this.selfDeviceId, recordPackets, {
      cursorOf: r => encodeSyncCursor(r),
    });
    return { keyPackets, opsPages };
  }

  /**
   * Verifies, decrypts, persists (`writeBeforePublish`), and applies one inbound `VfsRecordPacket`.
   * Rejects unknown/revoked devices, unknown epochs, tampered/malleable envelopes, mismatched
   * outer/inner fields, invalid P-256 signatures, forged member attribution, and unauthorized
   * Decision 4 soft-deletes/restores.
   */
  async acceptRecord(
    record: VfsRecordPacket,
    signerLookup: VfsSignerLookup,
  ): Promise<VfsAcceptRecordResult> {
    if (!isVfsRecordPacket(record, this.roomId)) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'Malformed vfs-record packet.');
    }

    // Fast idempotent check on already-persisted CID.
    if (this.recordsByCid.has(record.cid)) {
      return {
        accepted: false,
        duplicate: true,
        buffered: false,
        cid: record.cid,
        objKind: record.objKind,
        nodeId: record.nodeId,
      };
    }

    // 1. Verify signer exists and is NOT revoked.
    const signer = await signerLookup(record.deviceId);
    if (!signer) {
      throw new VfsError('VFS_INVALID_SIGNATURE', `Unknown VFS record signer device ${record.deviceId}.`);
    }
    if (signer.revoked) {
      throw new VfsError(
        'VFS_EPOCH_UNAUTHORIZED',
        `Rejected VFS record from revoked device ${record.deviceId}.`,
        { status: 403 },
      );
    }

    // 2. Resolve room epoch key.
    const roomKey = this.keyring.getKey(record.epoch);
    if (!roomKey) {
      throw new VfsError('VFS_EPOCH_UNKNOWN', `No room key held for VFS epoch ${record.epoch}.`);
    }

    // 3. Decrypt, verify unified AAD + deterministic anti-malleability + outer nodeId/kind binding + P-256 signature.
    const envBytes = decodeVfsRecordEnvelope(record);
    const opened = await openSignedVfsOp<VfsSignedOpHeaderFields & VfsAuthorStamp & { nodeId?: string }>({
      bytes: envBytes,
      roomId: this.roomId,
      epoch: record.epoch,
      objKind: record.objKind,
      nodeId: record.nodeId,
      deviceId: record.deviceId,
      seq: record.seq,
      opId: record.opId,
      roomKey,
      expectedCid: record.cid,
      resolvePublicKey: () => signer.signPublicKey,
    });

    const body = opened.body;
    // Defeat inner-attribution spoofing (compromised device cannot claim another memberId or nodeId).
    if (body.memberId !== signer.memberId) {
      throw new VfsError('VFS_INVALID_SIGNATURE', 'Decrypted VFS record memberId does not match authenticated signer.');
    }
    if (body.nodeId !== record.nodeId) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'Decrypted VFS record nodeId does not match outer vfs-record.');
    }
    if (
      typeof body.lamport !== 'number'
      || !Number.isSafeInteger(body.lamport)
      || body.lamport < 1
      || body.lamport > Math.max(this.lamport, 1) + VFS_MAX_LAMPORT_JUMP
    ) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'VFS record lamport clock out of bounds.');
    }

    const now = this.nowFn();
    let buffered = false;
    let equivocationDetected = false;
    let changeKind: VfsChangeEventKind | undefined;
    let commitId: string | undefined;

    const docRec = this.ensureDocRecord(record.nodeId);

    // 4. Validate payload semantics & permissions BEFORE persisting!
    let validatedTree: VfsTreeOpBody | null = null;
    let validatedDocOp: { op: VfsDocOpBody; docOpHash: string } | null = null;
    let validatedCommit: VfsCommitBody | null = null;

    if (record.objKind === VfsObjKind.TreeOp) {
      validatedTree = validateTreeOpBodyShape(body, this.roomId, record.nodeId);
      if (validatedTree.action.t === 'create') {
        // Enforce live room & per-member document caps on inbound creates for brand-new nodes.
        if (!docRec.created) {
          let liveTotal = 0;
          let liveByAuthor = 0;
          for (const d of this.docs.values()) {
            if (!d.created || d.deleted) continue;
            liveTotal++;
            if (d.createdBy === signer.memberId) liveByAuthor++;
          }
          if (liveTotal >= VFS_MAX_DOCS_MVP) {
            throw new VfsError('VFS_LIMIT_EXCEEDED', `Inbound create exceeds room doc cap (${VFS_MAX_DOCS_MVP}).`);
          }
          if (liveByAuthor >= VFS_MAX_DOCS_PER_MEMBER) {
            throw new VfsError(
              'VFS_LIMIT_EXCEEDED',
              `Inbound create exceeds per-member doc cap (${VFS_MAX_DOCS_PER_MEMBER}).`,
            );
          }
        }
        changeKind = 'doc-created';
      } else if (validatedTree.action.t === 'delete') {
        if (docRec.created && signer.role !== 'human' && docRec.createdBy !== signer.memberId) {
          throw new VfsUnauthorizedError('Rejected unauthorized remote agent soft-delete of another member\'s doc.');
        }
        changeKind = 'doc-deleted';
      } else if (validatedTree.action.t === 'restore') {
        if (signer.role !== 'human') {
          throw new VfsUnauthorizedError('Rejected unauthorized remote non-human restore.');
        }
        changeKind = 'doc-restored';
      } else {
        changeKind = 'doc-updated';
      }
    } else if (record.objKind === VfsObjKind.DocOp) {
      const docOp = body as unknown as VfsDocOpBody;
      const docOpHash = computeDocOpHash(docOp);
      // Validate atomically on a clone first; apply directly to `docRec.doc` after persistence so
      // `docRec.doc`'s buffered `pendingOps` are preserved and drained when parents arrive.
      const scratch = docRec.doc.clone();
      scratch.applyOp(docOp, docOpHash);
      validatedDocOp = { op: docOp, docOpHash };
      changeKind = docOp.revertsCommit !== undefined ? 'doc-reverted' : 'doc-updated';
    } else if (record.objKind === VfsObjKind.Commit) {
      validatedCommit = validateCommitBodyShape(body, this.roomId, record.nodeId);
      commitId = validatedCommit.commitId;
    }

    // 5. Persist via `writeBeforePublish` (immutable obj -> op index -> commit index -> node head -> meta).
    const opKvKey = vfsOpKey(this.roomId, record.nodeId, record.deviceId, record.seq, opened.opHash);
    const indexPayload: PersistedOpIndexEntry = {
      v: 1,
      epoch: record.epoch,
      objKind: record.objKind,
      nodeId: record.nodeId,
      deviceId: record.deviceId,
      seq: record.seq,
      opId: record.opId,
      cid: record.cid,
      receivedAt: now,
      signerRole: signer.role,
      signerMemberId: signer.memberId,
    };
    const indexKvValue = await this.sealDeviceLocal(opKvKey, indexPayload);
    const kvEntries: Array<{ key: string; value: Uint8Array; ifAbsent?: boolean }> = [
      { key: vfsObjKey(this.roomId, record.cid), value: envBytes, ifAbsent: true },
      { key: opKvKey, value: indexKvValue, ifAbsent: true },
    ];

    if (validatedCommit) {
      const commitIdxKey = vfsCommitKey(this.roomId, validatedCommit.at, validatedCommit.commitId);
      const commitIdxBytes = await this.sealDeviceLocal(commitIdxKey, {
        nodeId: record.nodeId,
        commitId: validatedCommit.commitId,
        cid: record.cid,
      });
      kvEntries.push({ key: commitIdxKey, value: commitIdxBytes });
    }

    const nextLamport = Math.max(this.lamport, body.lamport);
    const nextMeta: PersistedEngineMeta = {
      ...this.buildMetaSnapshot(),
      lamport: nextLamport,
    };
    const metaKey = vfsMetaKey(this.roomId);
    const metaBytes = await this.sealDeviceLocal(metaKey, nextMeta);

    await writeBeforePublish(this.store, {
      kvEntries,
      publishKey: metaKey,
      publishValue: metaBytes,
    });

    // 6. Apply to in-memory state after durable persistence succeeded.
    this.lamport = nextLamport;
    if (record.deviceId === this.selfDeviceId && record.seq > this.deviceSeq) {
      this.deviceSeq = record.seq;
    }

    if (validatedTree) {
      docRec.treeOps.set(opened.opHash, {
        op: validatedTree,
        opHash: opened.opHash,
        signerRole: signer.role,
      });
      this.foldTreeOps(docRec);
    } else if (validatedDocOp) {
      const liveApply = docRec.doc.applyOp(validatedDocOp.op, validatedDocOp.docOpHash);
      buffered = liveApply.buffered;
      equivocationDetected = liveApply.equivocationDetected;
      if (validatedDocOp.op.at >= docRec.updatedAt) {
        docRec.updatedAt = validatedDocOp.op.at;
        docRec.updatedBy = validatedDocOp.op.memberId;
      }
      await this.maybeWriteDocCheckpoint(docRec, envBytes.byteLength);
    } else if (validatedCommit) {
      if (!docRec.commits.has(validatedCommit.commitId)) {
        docRec.commits.set(validatedCommit.commitId, validatedCommit);
      }
      if (validatedCommit.at >= docRec.updatedAt) {
        docRec.updatedAt = validatedCommit.at;
        docRec.updatedBy = validatedCommit.memberId;
        docRec.latestCommitId = validatedCommit.commitId;
      }
    }

    if (docRec.created) {
      const nodeHeadKey = vfsNodeHeadKey(this.roomId, docRec.nodeId);
      const nodeHeadBytes = await this.sealDeviceLocal(nodeHeadKey, this.buildNodeHeadPayload(docRec));
      await this.store.kvPut(nodeHeadKey, nodeHeadBytes);
    }

    this.trackIndexedRecord({ ...indexPayload, opKvKey });

    if (changeKind && docRec.created) {
      const { displayPath } = this.displayPathFor(docRec);
      this.emitChange({
        kind: changeKind,
        nodeId: docRec.nodeId,
        path: displayPath,
        rev: docRec.doc.frontierRev(),
        ...(commitId ? { commitId } : {}),
        authorMemberId: signer.memberId,
        authorDeviceId: record.deviceId,
        at: body.at,
        source: 'remote',
      });
    }

    return {
      accepted: true,
      duplicate: false,
      buffered,
      cid: record.cid,
      objKind: record.objKind,
      nodeId: record.nodeId,
      ...(equivocationDetected ? { equivocationDetected: true } : {}),
    };
  }

  /** Applies a validated `VfsOpsPacket` page, isolating per-record rejections so one bad op cannot starve valid ops. */
  async acceptOps(
    opsPacket: VfsOpsPacket,
    signerLookup: VfsSignerLookup,
  ): Promise<VfsAcceptOpsResult> {
    if (!isVfsOpsPacket(opsPacket, this.roomId)) {
      throw new VfsError('VFS_INVALID_ENVELOPE', 'Malformed vfs-ops packet.');
    }

    let applied = 0;
    let duplicates = 0;
    let buffered = 0;
    const rejected: Array<{ cid: string; code: string; message: string }> = [];

    for (const rec of opsPacket.records) {
      try {
        const res = await this.acceptRecord(rec, signerLookup);
        if (res.duplicate) duplicates++;
        else if (res.buffered) buffered++;
        else if (res.accepted) applied++;
      } catch (err) {
        const maybeCode = (err as { code?: unknown } | null)?.code;
        const code = typeof maybeCode === 'string' ? maybeCode : 'VFS_INVALID_ENVELOPE';
        rejected.push({
          cid: rec.cid,
          code,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { applied, duplicates, buffered, rejected };
  }

  /** Flushes underlying store durability checkpoint (e.g. `wormdb_checkpoint_sync`). */
  async checkpoint(): Promise<void> {
    await this.store.checkpoint();
  }

  /** Closes the underlying room store handle. */
  async close(): Promise<void> {
    this.changeListeners.clear();
    await this.store.close();
  }
}
