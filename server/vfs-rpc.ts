/**
 * File-Mailbox RPC Schema & Symlink-Hardened Helpers for Room VFS (`server/vfs-rpc.ts`).
 *
 * Bridges sandboxed CLI / MCP commands (`vfs-list`, `vfs-read`, `vfs-write`, `vfs-patch`,
 * `vfs-history`, `vfs-diff`, `vfs-revert`, `vfs-delete`, `vfs-changes`) to the single
 * persistent `VfsRoomEngine` owned by `runBridge` without letting sandboxed harnesses touch
 * `identity.json` or the WormDB/VFS store directly:
 *
 * - Read queries land in `<roomDir>/outbox/q-<id>.json` (`0o600`, atomic temp + rename).
 * - Mutations land in `<roomDir>/outbox/<ts>-<requestId>.json` (`0o600`, atomic temp + rename).
 * - Ephemeral replies land in `<roomDir>/live/vfs-reply/<id>.json` (`0o600`, atomic symlink-
 *   replacing write), are read with `lstatSync().isFile()` + `O_NOFOLLOW`, and are unlinked
 *   immediately in `finally` so zero plaintext rests on disk.
 * - `sweepStaleVfsRpcReplies` purges orphaned reply files and stale `q-*.json` queries older
 *   than 30 seconds (and removes any planted symlinks without following them).
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { VfsError, type VfsErrorCode } from '../src/browser/vfs/constants.ts';
import type {
  VfsChangeEvent,
  VfsDeleteResult,
  VfsDiffResult,
  VfsDocSummary,
  VfsHistoryEntry,
  VfsPatchResult,
  VfsRevertResult,
  VfsWriteResult,
} from '../src/browser/vfs/engine.ts';
import type { VfsEditHunk } from '../src/browser/vfs/patch.ts';
import { whileBusy } from './agent-install.ts';
import { ensureSafeDir, prepareBaseDir, syncDirectory } from './persistence/vfs-bunfile.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const VFS_RPC_OUTBOX_DIR = 'outbox';
export const VFS_RPC_LIVE_DIR = 'live';
export const VFS_RPC_REPLY_DIR = 'vfs-reply';

export const VFS_RPC_DEFAULT_TIMEOUT_MS = 10_000;
export const VFS_RPC_DEFAULT_POLL_MS = 25;
export const VFS_RPC_STALE_MAX_AGE_MS = 30_000;

/** Default page size for `vfs-read` (64 KiB UTF-8). */
export const VFS_RPC_DEFAULT_READ_LIMIT = 65_536;
/** Hard upper bound per `vfs-read` page (256 KiB UTF-8). */
export const VFS_RPC_MAX_READ_LIMIT = 256 * 1024;
/** Hard upper bound for `vfs-history` entries returned in one reply. */
export const VFS_RPC_MAX_HISTORY_LIMIT = 200;
/** Hard upper bound for reply JSON payload read by CLI (4 MiB). */
export const VFS_RPC_MAX_REPLY_BYTES = 4 * 1024 * 1024;
/** Hard upper bound for commit messages and target strings in RPC envelopes. */
export const VFS_RPC_MAX_MESSAGE_CHARS = 512;
export const VFS_RPC_MAX_TARGET_CHARS = 512;
export const VFS_RPC_MAX_HUNKS = 64;

export const VFS_RPC_UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

// ---------------------------------------------------------------------------
// RPC Request & Reply Types
// ---------------------------------------------------------------------------

export type VfsQueryOp = 'vfs-list' | 'vfs-read' | 'vfs-history' | 'vfs-diff' | 'vfs-changes';
export type VfsMutationOp = 'vfs-write' | 'vfs-patch' | 'vfs-revert' | 'vfs-delete';
export type VfsRpcOp = VfsQueryOp | VfsMutationOp;
export type VfsRpcTargetKind = 'path' | 'nodeId';

export type VfsListRpc = {
  type: 'vfs-query';
  id: string;
  op: 'vfs-list';
  includeDeleted?: boolean;
};

export type VfsReadRpc = {
  type: 'vfs-query';
  id: string;
  op: 'vfs-read';
  nodeIdOrPath: string;
  targetKind?: VfsRpcTargetKind;
  rev?: string;
  offset?: number;
  limit?: number;
};

export type VfsHistoryRpc = {
  type: 'vfs-query';
  id: string;
  op: 'vfs-history';
  nodeIdOrPath: string;
  targetKind?: VfsRpcTargetKind;
  limit?: number;
};

export type VfsDiffRpc = {
  type: 'vfs-query';
  id: string;
  op: 'vfs-diff';
  nodeIdOrPath: string;
  targetKind?: VfsRpcTargetKind;
  fromRev: string;
  toRev?: string;
};

export type VfsChangesRpc = {
  type: 'vfs-query';
  id: string;
  op: 'vfs-changes';
  afterCursor?: number;
};

export type VfsQueryRpc =
  | VfsListRpc
  | VfsReadRpc
  | VfsHistoryRpc
  | VfsDiffRpc
  | VfsChangesRpc;

export type VfsWriteRpc = {
  type: 'vfs-mutation';
  id: string;
  op: 'vfs-write';
  nodeIdOrPath: string;
  targetKind?: VfsRpcTargetKind;
  content: string;
  baseRev?: string;
  message?: string;
  replyTo?: string;
};

export type VfsPatchRpc = {
  type: 'vfs-mutation';
  id: string;
  op: 'vfs-patch';
  nodeIdOrPath: string;
  targetKind?: VfsRpcTargetKind;
  baseRev: string;
  hunks: VfsEditHunk[];
  message?: string;
  replyTo?: string;
};

export type VfsRevertRpc = {
  type: 'vfs-mutation';
  id: string;
  op: 'vfs-revert';
  nodeIdOrPath: string;
  targetKind?: VfsRpcTargetKind;
  targetCommitId: string;
  baseRev?: string;
  message?: string;
  replyTo?: string;
};

export type VfsDeleteRpc = {
  type: 'vfs-mutation';
  id: string;
  op: 'vfs-delete';
  nodeIdOrPath: string;
  targetKind?: VfsRpcTargetKind;
  restore?: boolean;
  path?: string;
  message?: string;
  replyTo?: string;
};

export type VfsMutationRpc =
  | VfsWriteRpc
  | VfsPatchRpc
  | VfsRevertRpc
  | VfsDeleteRpc;

export type VfsRpcRequest = VfsQueryRpc | VfsMutationRpc;

/** Input shape for `writeVfsRpcQuery` (`type` and `id` may be omitted and auto-populated). */
export type VfsQueryRpcInput =
  | (Omit<VfsListRpc, 'type' | 'id'> & { type?: 'vfs-query'; id?: string })
  | (Omit<VfsReadRpc, 'type' | 'id'> & { type?: 'vfs-query'; id?: string })
  | (Omit<VfsHistoryRpc, 'type' | 'id'> & { type?: 'vfs-query'; id?: string })
  | (Omit<VfsDiffRpc, 'type' | 'id'> & { type?: 'vfs-query'; id?: string })
  | (Omit<VfsChangesRpc, 'type' | 'id'> & { type?: 'vfs-query'; id?: string });

/** Input shape for `writeVfsRpcMutation` (`type` may be omitted; `id` is required for idempotency). */
export type VfsMutationRpcInput =
  | (Omit<VfsWriteRpc, 'type'> & { type?: 'vfs-mutation' })
  | (Omit<VfsPatchRpc, 'type'> & { type?: 'vfs-mutation' })
  | (Omit<VfsRevertRpc, 'type'> & { type?: 'vfs-mutation' })
  | (Omit<VfsDeleteRpc, 'type'> & { type?: 'vfs-mutation' });

export type VfsListReplyData = {
  docs: VfsDocSummary[];
  activeEpoch: number;
};

export type VfsReadReplyData = {
  nodeId: string;
  path: string;
  rawPath: string;
  rev: string;
  text: string;
  /** UTF-8 byte length of the returned `text` slice. */
  bytes: number;
  /** Total UTF-8 byte length of the full document at `rev`. */
  totalBytes: number;
  /** Starting UTF-8 byte offset of this slice. */
  offset: number;
  /** Effective UTF-8 byte limit applied to this read. */
  limit: number;
  truncated: boolean;
  nextOffset?: number;
  overSoftLimit: boolean;
  deleted: boolean;
  createdBy: string;
  updatedBy: string;
  updatedAt: number;
};

export type VfsHistoryReplyData = {
  nodeId: string;
  path: string;
  entries: VfsHistoryEntry[];
};

export type VfsDiffReplyData = VfsDiffResult;

export type VfsChangesReplyData = {
  events: VfsChangeEvent[];
  cursor: number;
};

export type VfsWriteReplyData = Omit<VfsWriteResult, 'outbound'> & {
  created: boolean;
};

export type VfsPatchReplyData = Omit<VfsPatchResult, 'outbound'>;
export type VfsRevertReplyData = Omit<VfsRevertResult, 'outbound'>;
export type VfsDeleteReplyData = Omit<VfsDeleteResult, 'outbound'>;

export type VfsRpcReplyDataByOp = {
  'vfs-list': VfsListReplyData;
  'vfs-read': VfsReadReplyData;
  'vfs-history': VfsHistoryReplyData;
  'vfs-diff': VfsDiffReplyData;
  'vfs-changes': VfsChangesReplyData;
  'vfs-write': VfsWriteReplyData;
  'vfs-patch': VfsPatchReplyData;
  'vfs-revert': VfsRevertReplyData;
  'vfs-delete': VfsDeleteReplyData;
};

export type VfsRpcErrorCode =
  | VfsErrorCode
  | 'VFS_UNAUTHORIZED'
  | 'VFS_FLOOR_BLOCKED'
  | 'VFS_INVALID_REQUEST'
  | 'VFS_INVALID_OP'
  | 'VFS_SIZE_LIMIT'
  | 'VFS_TIMEOUT'
  | 'VFS_INTERNAL_ERROR';

export type VfsRpcSuccessReply<T = unknown> = {
  ok: true;
  id: string;
  op: VfsRpcOp;
  status: 200;
  data: T;
};

export type VfsRpcErrorReply = {
  ok: false;
  id: string;
  op?: VfsRpcOp | string;
  status: number;
  code: VfsRpcErrorCode | string;
  error: string;
  details?: Record<string, unknown>;
};

export type VfsRpcReply<T = unknown> = VfsRpcSuccessReply<T> | VfsRpcErrorReply;

export type ParseVfsRpcResult =
  | { ok: true; request: VfsRpcRequest }
  | { ok: false; id?: string; op?: string; error: string };

export type VfsRpcWriteHandle<T extends VfsRpcRequest = VfsRpcRequest> = {
  id: string;
  fileName: string;
  filePath: string;
  request: T;
};

export type AwaitVfsRpcReplyOptions = {
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
};

export class VfsRpcTimeoutError extends Error {
  override readonly name = 'VfsRpcTimeoutError';
  readonly code = 'VFS_TIMEOUT' as const;
  readonly status = 504 as const;
  readonly id: string;

  constructor(id: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs} ms waiting for VFS RPC reply ${id}.`);
    this.id = id;
  }
}

// ---------------------------------------------------------------------------
// Validation & Parsing
// ---------------------------------------------------------------------------

export function isValidVfsRpcId(value: unknown): value is string {
  return typeof value === 'string' && VFS_RPC_UUID_RE.test(value);
}

/** Fast discriminator for `outboxProblem` / `deliverOutbox` in `server/browser-agent.ts`. */
export function isVfsRpcOutboxItem(item: unknown): item is { type: 'vfs-query' | 'vfs-mutation'; id?: unknown; op?: unknown } {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const type = (item as { type?: unknown }).type;
  return type === 'vfs-query' || type === 'vfs-mutation';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isValidTargetKind(value: unknown): value is VfsRpcTargetKind {
  return value === 'path' || value === 'nodeId';
}

function validateNonEmptyString(
  value: unknown,
  field: string,
  maxChars: number,
): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars || value.includes('\0')) {
    return `${field} must be a non-empty string of at most ${maxChars} characters`;
  }
  return null;
}

function validateOptionalMessage(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > VFS_RPC_MAX_MESSAGE_CHARS || value.includes('\0')) {
    return `message must be a string of at most ${VFS_RPC_MAX_MESSAGE_CHARS} characters`;
  }
  return null;
}

function validateOptionalTargetKind(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isValidTargetKind(value)) return 'targetKind must be "path" or "nodeId"';
  return null;
}

function validateOptionalReplyTo(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isValidVfsRpcId(value)) return 'replyTo must be a lowercase UUID';
  return null;
}

function isValidEditHunk(value: unknown): value is VfsEditHunk {
  if (!isPlainRecord(value)) return false;
  const op = value.op;
  const optStr = (v: unknown) => v === undefined || typeof v === 'string';
  if (op === 'replace') {
    return typeof value.old === 'string' && typeof value.new === 'string'
      && optStr(value.before) && optStr(value.after);
  }
  if (op === 'insert_after' || op === 'insert_before') {
    return typeof value.anchor === 'string' && typeof value.text === 'string'
      && optStr(value.before) && optStr(value.after);
  }
  if (op === 'append' || op === 'prepend') {
    return typeof value.text === 'string';
  }
  return false;
}

function normalizeEditHunk(hunk: VfsEditHunk): VfsEditHunk {
  if (hunk.op === 'replace') {
    return {
      op: 'replace',
      old: hunk.old,
      new: hunk.new,
      ...(hunk.before !== undefined ? { before: hunk.before } : {}),
      ...(hunk.after !== undefined ? { after: hunk.after } : {}),
    };
  }
  if (hunk.op === 'insert_after' || hunk.op === 'insert_before') {
    return {
      op: hunk.op,
      anchor: hunk.anchor,
      text: hunk.text,
      ...(hunk.before !== undefined ? { before: hunk.before } : {}),
      ...(hunk.after !== undefined ? { after: hunk.after } : {}),
    };
  }
  return { op: hunk.op, text: hunk.text };
}

/**
 * Strictly validates an untrusted JSON object read from `outbox/` into a typed `VfsRpcRequest`.
 * Rejects non-UUID ids, path traversal characters, malformed hunks, and invalid numeric bounds.
 */
export function parseVfsOutboxItem(item: unknown): ParseVfsRpcResult {
  if (!isPlainRecord(item)) {
    return { ok: false, error: 'VFS RPC item must be a JSON object' };
  }
  const id = typeof item.id === 'string' ? item.id : undefined;
  const op = typeof item.op === 'string' ? item.op : undefined;
  if (!isValidVfsRpcId(item.id)) {
    return { ok: false, id, op, error: 'VFS RPC id must be a lowercase UUID' };
  }
  const type = item.type;
  if (type === 'vfs-query') {
    switch (item.op) {
      case 'vfs-list': {
        if (item.includeDeleted !== undefined && typeof item.includeDeleted !== 'boolean') {
          return { ok: false, id: item.id, op: item.op, error: 'includeDeleted must be a boolean' };
        }
        return {
          ok: true,
          request: {
            type: 'vfs-query',
            id: item.id,
            op: 'vfs-list',
            ...(item.includeDeleted !== undefined ? { includeDeleted: item.includeDeleted } : {}),
          },
        };
      }
      case 'vfs-read': {
        const targetErr = validateNonEmptyString(item.nodeIdOrPath, 'nodeIdOrPath', VFS_RPC_MAX_TARGET_CHARS);
        if (targetErr) return { ok: false, id: item.id, op: item.op, error: targetErr };
        const kindErr = validateOptionalTargetKind(item.targetKind);
        if (kindErr) return { ok: false, id: item.id, op: item.op, error: kindErr };
        if (item.rev !== undefined) {
          const revErr = validateNonEmptyString(item.rev, 'rev', 128);
          if (revErr) return { ok: false, id: item.id, op: item.op, error: revErr };
        }
        if (item.offset !== undefined) {
          if (typeof item.offset !== 'number' || !Number.isSafeInteger(item.offset) || item.offset < 0) {
            return { ok: false, id: item.id, op: item.op, error: 'offset must be a non-negative integer' };
          }
        }
        if (item.limit !== undefined) {
          if (typeof item.limit !== 'number' || !Number.isSafeInteger(item.limit) || item.limit < 1) {
            return { ok: false, id: item.id, op: item.op, error: 'limit must be a positive integer' };
          }
        }
        return {
          ok: true,
          request: {
            type: 'vfs-query',
            id: item.id,
            op: 'vfs-read',
            nodeIdOrPath: item.nodeIdOrPath as string,
            ...(item.targetKind !== undefined ? { targetKind: item.targetKind as VfsRpcTargetKind } : {}),
            ...(item.rev !== undefined ? { rev: item.rev as string } : {}),
            ...(item.offset !== undefined ? { offset: item.offset } : {}),
            ...(item.limit !== undefined ? { limit: item.limit } : {}),
          },
        };
      }
      case 'vfs-history': {
        const targetErr = validateNonEmptyString(item.nodeIdOrPath, 'nodeIdOrPath', VFS_RPC_MAX_TARGET_CHARS);
        if (targetErr) return { ok: false, id: item.id, op: item.op, error: targetErr };
        const kindErr = validateOptionalTargetKind(item.targetKind);
        if (kindErr) return { ok: false, id: item.id, op: item.op, error: kindErr };
        if (item.limit !== undefined) {
          if (typeof item.limit !== 'number' || !Number.isSafeInteger(item.limit) || item.limit < 1) {
            return { ok: false, id: item.id, op: item.op, error: 'limit must be a positive integer' };
          }
        }
        return {
          ok: true,
          request: {
            type: 'vfs-query',
            id: item.id,
            op: 'vfs-history',
            nodeIdOrPath: item.nodeIdOrPath as string,
            ...(item.targetKind !== undefined ? { targetKind: item.targetKind as VfsRpcTargetKind } : {}),
            ...(item.limit !== undefined ? { limit: item.limit } : {}),
          },
        };
      }
      case 'vfs-diff': {
        const targetErr = validateNonEmptyString(item.nodeIdOrPath, 'nodeIdOrPath', VFS_RPC_MAX_TARGET_CHARS);
        if (targetErr) return { ok: false, id: item.id, op: item.op, error: targetErr };
        const kindErr = validateOptionalTargetKind(item.targetKind);
        if (kindErr) return { ok: false, id: item.id, op: item.op, error: kindErr };
        const fromErr = validateNonEmptyString(item.fromRev, 'fromRev', 128);
        if (fromErr) return { ok: false, id: item.id, op: item.op, error: fromErr };
        if (item.toRev !== undefined) {
          const toErr = validateNonEmptyString(item.toRev, 'toRev', 128);
          if (toErr) return { ok: false, id: item.id, op: item.op, error: toErr };
        }
        return {
          ok: true,
          request: {
            type: 'vfs-query',
            id: item.id,
            op: 'vfs-diff',
            nodeIdOrPath: item.nodeIdOrPath as string,
            ...(item.targetKind !== undefined ? { targetKind: item.targetKind as VfsRpcTargetKind } : {}),
            fromRev: item.fromRev as string,
            ...(item.toRev !== undefined ? { toRev: item.toRev as string } : {}),
          },
        };
      }
      case 'vfs-changes': {
        if (item.afterCursor !== undefined) {
          if (typeof item.afterCursor !== 'number' || !Number.isSafeInteger(item.afterCursor) || item.afterCursor < 0) {
            return { ok: false, id: item.id, op: item.op, error: 'afterCursor must be a non-negative integer' };
          }
        }
        return {
          ok: true,
          request: {
            type: 'vfs-query',
            id: item.id,
            op: 'vfs-changes',
            ...(item.afterCursor !== undefined ? { afterCursor: item.afterCursor } : {}),
          },
        };
      }
      default:
        return { ok: false, id: item.id, op, error: `Unknown VFS query op "${String(item.op)}"` };
    }
  }

  if (type === 'vfs-mutation') {
    const replyToErr = validateOptionalReplyTo(item.replyTo);
    if (replyToErr) return { ok: false, id: item.id, op, error: replyToErr };
    const messageErr = validateOptionalMessage(item.message);
    if (messageErr) return { ok: false, id: item.id, op, error: messageErr };

    switch (item.op) {
      case 'vfs-write': {
        const targetErr = validateNonEmptyString(item.nodeIdOrPath, 'nodeIdOrPath', VFS_RPC_MAX_TARGET_CHARS);
        if (targetErr) return { ok: false, id: item.id, op: item.op, error: targetErr };
        const kindErr = validateOptionalTargetKind(item.targetKind);
        if (kindErr) return { ok: false, id: item.id, op: item.op, error: kindErr };
        if (typeof item.content !== 'string') {
          return { ok: false, id: item.id, op: item.op, error: 'content must be a string' };
        }
        if (item.baseRev !== undefined) {
          const baseErr = validateNonEmptyString(item.baseRev, 'baseRev', 128);
          if (baseErr) return { ok: false, id: item.id, op: item.op, error: baseErr };
        }
        return {
          ok: true,
          request: {
            type: 'vfs-mutation',
            id: item.id,
            op: 'vfs-write',
            nodeIdOrPath: item.nodeIdOrPath as string,
            ...(item.targetKind !== undefined ? { targetKind: item.targetKind as VfsRpcTargetKind } : {}),
            content: item.content,
            ...(item.baseRev !== undefined ? { baseRev: item.baseRev as string } : {}),
            ...(item.message !== undefined ? { message: item.message as string } : {}),
            ...(item.replyTo !== undefined ? { replyTo: item.replyTo as string } : {}),
          },
        };
      }
      case 'vfs-patch': {
        const targetErr = validateNonEmptyString(item.nodeIdOrPath, 'nodeIdOrPath', VFS_RPC_MAX_TARGET_CHARS);
        if (targetErr) return { ok: false, id: item.id, op: item.op, error: targetErr };
        const kindErr = validateOptionalTargetKind(item.targetKind);
        if (kindErr) return { ok: false, id: item.id, op: item.op, error: kindErr };
        const baseErr = validateNonEmptyString(item.baseRev, 'baseRev', 128);
        if (baseErr) return { ok: false, id: item.id, op: item.op, error: baseErr };
        if (!Array.isArray(item.hunks) || item.hunks.length === 0 || item.hunks.length > VFS_RPC_MAX_HUNKS) {
          return {
            ok: false,
            id: item.id,
            op: item.op,
            error: `hunks must be a non-empty array of at most ${VFS_RPC_MAX_HUNKS} edit hunks`,
          };
        }
        const normalizedHunks: VfsEditHunk[] = [];
        for (let i = 0; i < item.hunks.length; i++) {
          const rawHunk = item.hunks[i];
          if (!isValidEditHunk(rawHunk)) {
            return { ok: false, id: item.id, op: item.op, error: `Invalid edit hunk at index ${i}` };
          }
          normalizedHunks.push(normalizeEditHunk(rawHunk));
        }
        return {
          ok: true,
          request: {
            type: 'vfs-mutation',
            id: item.id,
            op: 'vfs-patch',
            nodeIdOrPath: item.nodeIdOrPath as string,
            ...(item.targetKind !== undefined ? { targetKind: item.targetKind as VfsRpcTargetKind } : {}),
            baseRev: item.baseRev as string,
            hunks: normalizedHunks,
            ...(item.message !== undefined ? { message: item.message as string } : {}),
            ...(item.replyTo !== undefined ? { replyTo: item.replyTo as string } : {}),
          },
        };
      }
      case 'vfs-revert': {
        const targetErr = validateNonEmptyString(item.nodeIdOrPath, 'nodeIdOrPath', VFS_RPC_MAX_TARGET_CHARS);
        if (targetErr) return { ok: false, id: item.id, op: item.op, error: targetErr };
        const kindErr = validateOptionalTargetKind(item.targetKind);
        if (kindErr) return { ok: false, id: item.id, op: item.op, error: kindErr };
        const commitErr = validateNonEmptyString(item.targetCommitId, 'targetCommitId', 128);
        if (commitErr) return { ok: false, id: item.id, op: item.op, error: commitErr };
        if (item.baseRev !== undefined) {
          const baseErr = validateNonEmptyString(item.baseRev, 'baseRev', 128);
          if (baseErr) return { ok: false, id: item.id, op: item.op, error: baseErr };
        }
        return {
          ok: true,
          request: {
            type: 'vfs-mutation',
            id: item.id,
            op: 'vfs-revert',
            nodeIdOrPath: item.nodeIdOrPath as string,
            ...(item.targetKind !== undefined ? { targetKind: item.targetKind as VfsRpcTargetKind } : {}),
            targetCommitId: item.targetCommitId as string,
            ...(item.baseRev !== undefined ? { baseRev: item.baseRev as string } : {}),
            ...(item.message !== undefined ? { message: item.message as string } : {}),
            ...(item.replyTo !== undefined ? { replyTo: item.replyTo as string } : {}),
          },
        };
      }
      case 'vfs-delete': {
        const targetErr = validateNonEmptyString(item.nodeIdOrPath, 'nodeIdOrPath', VFS_RPC_MAX_TARGET_CHARS);
        if (targetErr) return { ok: false, id: item.id, op: item.op, error: targetErr };
        const kindErr = validateOptionalTargetKind(item.targetKind);
        if (kindErr) return { ok: false, id: item.id, op: item.op, error: kindErr };
        if (item.restore !== undefined && typeof item.restore !== 'boolean') {
          return { ok: false, id: item.id, op: item.op, error: 'restore must be a boolean' };
        }
        if (item.path !== undefined) {
          const pathErr = validateNonEmptyString(item.path, 'path', VFS_RPC_MAX_TARGET_CHARS);
          if (pathErr) return { ok: false, id: item.id, op: item.op, error: pathErr };
        }
        return {
          ok: true,
          request: {
            type: 'vfs-mutation',
            id: item.id,
            op: 'vfs-delete',
            nodeIdOrPath: item.nodeIdOrPath as string,
            ...(item.targetKind !== undefined ? { targetKind: item.targetKind as VfsRpcTargetKind } : {}),
            ...(item.restore !== undefined ? { restore: item.restore } : {}),
            ...(item.path !== undefined ? { path: item.path as string } : {}),
            ...(item.message !== undefined ? { message: item.message as string } : {}),
            ...(item.replyTo !== undefined ? { replyTo: item.replyTo as string } : {}),
          },
        };
      }
      default:
        return { ok: false, id: item.id, op, error: `Unknown VFS mutation op "${String(item.op)}"` };
    }
  }

  return { ok: false, id: item.id, op, error: `Unknown VFS RPC type "${String(type)}"` };
}

// ---------------------------------------------------------------------------
// Symlink-Hardened Atomic File Helpers
// ---------------------------------------------------------------------------

function writeAllSync(fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.byteLength) {
    const written = fs.writeSync(fd, data, offset, data.byteLength - offset);
    if (written <= 0) {
      throw new VfsError('VFS_STORAGE_FAILED', 'Short write while writing VFS RPC file.');
    }
    offset += written;
  }
}

/**
 * Atomically writes `data` (`0o600`) to `<dirPath>/<fileName>` via an `O_EXCL | O_NOFOLLOW` temp
 * file, `fsync`, rename, and directory `fsync`.
 *
 * When `replacePlantedSymlink` is true (used by the runner for `writeVfsRpcReply`), any planted
 * symlink at `<dirPath>/<fileName>` is unlinked and replaced atomically without ever following it.
 * When false (used by CLI writers), any existing symlink at `<dirPath>/<fileName>` is rejected.
 */
function writeAtomicRpcFile(
  dirPath: string,
  fileName: string,
  data: Uint8Array,
  replacePlantedSymlink: boolean,
): string {
  if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.includes('\0') || fileName === '.' || fileName === '..') {
    throw new VfsError('VFS_INVALID_KEY', `Invalid VFS RPC filename "${fileName}".`);
  }
  const targetPath = path.join(dirPath, fileName);
  const existing = fs.lstatSync(targetPath, { throwIfNoEntry: false });
  if (existing) {
    if (existing.isSymbolicLink()) {
      if (replacePlantedSymlink) {
        try { fs.unlinkSync(targetPath); } catch { /* May already be gone. */ }
      } else {
        throw new VfsError('VFS_STORAGE_FAILED', `Refusing to follow symbolic link at "${fileName}".`);
      }
    } else if (!existing.isFile()) {
      throw new VfsError('VFS_STORAGE_FAILED', `Expected regular file at "${fileName}".`);
    }
  }

  const tempPath = path.join(dirPath, `.${fileName}.${randomUUID()}.tmp`);
  const fd = fs.openSync(
    tempPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
    0o600,
  );
  let closed = false;
  let renamed = false;
  try {
    writeAllSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    closed = true;

    // On POSIX, rename(2) atomically replaces a symlink without following it; on Windows,
    // retrying brief contention via `whileBusy` handles transient antivirus/reader locks.
    whileBusy(() => fs.renameSync(tempPath, targetPath));
    renamed = true;
    syncDirectory(dirPath);
    return targetPath;
  } catch (err) {
    if (!closed) {
      try { fs.closeSync(fd); } catch { /* Best effort. */ }
    }
    if (!renamed) {
      try { fs.unlinkSync(tempPath); } catch { /* Best effort. */ }
    }
    throw err;
  }
}

function readRegularFileNoFollow(filePath: string, maxBytes: number): Uint8Array | undefined {
  const st = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!st) return undefined;
  if (st.isSymbolicLink()) {
    // Unlink the planted symlink itself (never its target) and fail closed.
    try { fs.unlinkSync(filePath); } catch { /* Best effort. */ }
    throw new VfsError('VFS_STORAGE_FAILED', `Refusing to follow symbolic link at "${path.basename(filePath)}".`);
  }
  if (!st.isFile()) {
    throw new VfsError('VFS_STORAGE_FAILED', `Expected regular file at "${path.basename(filePath)}".`);
  }

  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return undefined;
    if (code === 'ELOOP') {
      try { fs.unlinkSync(filePath); } catch { /* Best effort. */ }
      throw new VfsError('VFS_STORAGE_FAILED', `Refusing to follow symbolic link at "${path.basename(filePath)}".`);
    }
    throw err;
  }
  try {
    const fstat = fs.fstatSync(fd);
    if (!fstat.isFile()) {
      throw new VfsError('VFS_STORAGE_FAILED', `Expected regular file at "${path.basename(filePath)}".`);
    }
    if (fstat.size > maxBytes) {
      throw new VfsError(
        'VFS_LIMIT_EXCEEDED',
        `VFS RPC file "${path.basename(filePath)}" (${fstat.size} bytes) exceeds maximum allowed size (${maxBytes} bytes).`,
      );
    }
    const buf = fs.readFileSync(fd);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Safely inspects an existing subdirectory beneath `roomDir` without creating it or following
 * any symlink component. Returns the resolved path if all segments exist as real directories,
 * `undefined` if any segment does not exist, or throws `VFS_STORAGE_FAILED` if a symlink or
 * non-directory is encountered.
 */
function inspectSafeSubdir(roomDir: string, segments: readonly string[]): string | undefined {
  if (typeof roomDir !== 'string' || roomDir.length === 0 || roomDir.includes('\0')) {
    throw new VfsError('VFS_INVALID_KEY', 'roomDir must be a non-empty path.');
  }
  const resolved = path.resolve(roomDir);
  if (!fs.existsSync(resolved)) return undefined;
  const baseReal = fs.realpathSync(resolved);
  let current = baseReal;
  for (const seg of segments) {
    current = path.join(current, seg);
    const st = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!st) return undefined;
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new VfsError('VFS_STORAGE_FAILED', `Refusing symlink or non-directory at "${seg}".`);
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// Public Mailbox Functions
// ---------------------------------------------------------------------------

/** Returns the canonical reply path `<roomDir>/live/vfs-reply/<id>.json` after validating `id`. */
export function vfsRpcReplyPath(roomDir: string, id: string): string {
  if (!isValidVfsRpcId(id)) {
    throw new VfsError('VFS_INVALID_KEY', 'VFS RPC reply id must be a lowercase UUID.');
  }
  return path.join(roomDir, VFS_RPC_LIVE_DIR, VFS_RPC_REPLY_DIR, `${id}.json`);
}

/**
 * Writes a read-only VFS RPC query to `<roomDir>/outbox/q-<id>.json` (`0o600`, atomic).
 * Refuses symlinked `outbox/` or target paths.
 */
export function writeVfsRpcQuery(
  roomDir: string,
  query: VfsQueryRpcInput,
): VfsRpcWriteHandle<VfsQueryRpc> {
  const id = query.id ?? randomUUID().toLowerCase();
  const candidate = { ...query, type: 'vfs-query' as const, id };
  const parsed = parseVfsOutboxItem(candidate);
  if (!parsed.ok || parsed.request.type !== 'vfs-query') {
    throw new VfsError('VFS_INVALID_KEY', `Invalid VFS RPC query: ${parsed.ok ? 'unexpected type' : parsed.error}.`);
  }
  const baseReal = prepareBaseDir(roomDir);
  const outboxDir = ensureSafeDir(baseReal, [VFS_RPC_OUTBOX_DIR]);
  const fileName = `q-${parsed.request.id}.json`;
  const payload = Buffer.from(JSON.stringify(parsed.request), 'utf8');
  const filePath = writeAtomicRpcFile(outboxDir, fileName, payload, false);
  return { id: parsed.request.id, fileName, filePath, request: parsed.request };
}

/**
 * Writes a mutating VFS RPC request to `<roomDir>/outbox/<ts>-<requestId>.json` (`0o600`, atomic).
 * Refuses symlinked `outbox/` or target paths.
 */
export function writeVfsRpcMutation(
  roomDir: string,
  mutation: VfsMutationRpcInput,
  now: () => number = () => Date.now(),
): VfsRpcWriteHandle<VfsMutationRpc> {
  const candidate = { ...mutation, type: 'vfs-mutation' as const };
  const parsed = parseVfsOutboxItem(candidate);
  if (!parsed.ok || parsed.request.type !== 'vfs-mutation') {
    throw new VfsError('VFS_INVALID_KEY', `Invalid VFS RPC mutation: ${parsed.ok ? 'unexpected type' : parsed.error}.`);
  }
  const baseReal = prepareBaseDir(roomDir);
  const outboxDir = ensureSafeDir(baseReal, [VFS_RPC_OUTBOX_DIR]);
  const ts = String(Math.max(0, Math.floor(now()))).padStart(15, '0');
  const fileName = `${ts}-${parsed.request.id}.json`;
  const payload = Buffer.from(JSON.stringify(parsed.request), 'utf8');
  const filePath = writeAtomicRpcFile(outboxDir, fileName, payload, false);
  return { id: parsed.request.id, fileName, filePath, request: parsed.request };
}

/**
 * Runner-side helper: atomically writes an ephemeral `0o600` JSON reply to
 * `<roomDir>/live/vfs-reply/<id>.json`.
 *
 * Refuses symlinked `live/` or `live/vfs-reply/` directories, and safely replaces any symlink
 * pre-planted at `<id>.json` without ever following it or writing to its target.
 */
export function writeVfsRpcReply(
  roomDir: string,
  id: string,
  reply: VfsRpcReply,
): string {
  if (!isValidVfsRpcId(id)) {
    throw new VfsError('VFS_INVALID_KEY', 'VFS RPC reply id must be a lowercase UUID.');
  }
  const baseReal = prepareBaseDir(roomDir);
  const replyDir = ensureSafeDir(baseReal, [VFS_RPC_LIVE_DIR, VFS_RPC_REPLY_DIR]);
  const payload = Buffer.from(JSON.stringify(reply), 'utf8');
  return writeAtomicRpcFile(replyDir, `${id}.json`, payload, true);
}

/**
 * CLI-side helper: watches/polls for `<roomDir>/live/vfs-reply/<id>.json`, verifies
 * `lstatSync().isFile()` + `O_NOFOLLOW`, parses the JSON reply, and **immediately unlinks the
 * reply file in `finally`** so zero plaintext rests on disk.
 */
export async function awaitVfsRpcReply<T = unknown>(
  roomDir: string,
  id: string,
  timeoutMsOrOptions: number | AwaitVfsRpcReplyOptions = VFS_RPC_DEFAULT_TIMEOUT_MS,
): Promise<VfsRpcReply<T>> {
  if (!isValidVfsRpcId(id)) {
    throw new VfsError('VFS_INVALID_KEY', 'VFS RPC reply id must be a lowercase UUID.');
  }
  const opts: AwaitVfsRpcReplyOptions = typeof timeoutMsOrOptions === 'number'
    ? { timeoutMs: timeoutMsOrOptions }
    : timeoutMsOrOptions;
  const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs ?? VFS_RPC_DEFAULT_TIMEOUT_MS));
  const pollMs = Math.max(5, Math.min(250, Math.floor(opts.pollMs ?? VFS_RPC_DEFAULT_POLL_MS)));

  const baseReal = prepareBaseDir(roomDir);
  const replyDir = ensureSafeDir(baseReal, [VFS_RPC_LIVE_DIR, VFS_RPC_REPLY_DIR]);
  const fileName = `${id}.json`;

  const tryReadAndConsume = (): VfsRpcReply<T> | undefined => {
    // Re-verify parent directories were not swapped for symlinks while waiting.
    const verifiedDir = inspectSafeSubdir(roomDir, [VFS_RPC_LIVE_DIR, VFS_RPC_REPLY_DIR]);
    if (!verifiedDir) return undefined;
    const currentPath = path.join(verifiedDir, fileName);

    let consumed = false;
    let rawBytes: Uint8Array | undefined;
    try {
      rawBytes = readRegularFileNoFollow(currentPath, VFS_RPC_MAX_REPLY_BYTES);
      if (!rawBytes) return undefined;
      consumed = true;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
      const parsed = JSON.parse(text) as unknown;
      if (!isPlainRecord(parsed) || typeof parsed.ok !== 'boolean' || typeof parsed.id !== 'string') {
        throw new VfsError('VFS_INVALID_ENVELOPE', `Malformed VFS RPC reply JSON for ${id}.`);
      }
      if (parsed.id !== id) {
        throw new VfsError('VFS_INVALID_ENVELOPE', `Mismatched VFS RPC reply id: expected ${id}, got ${parsed.id}.`);
      }
      return parsed as VfsRpcReply<T>;
    } finally {
      if (consumed) {
        try { fs.unlinkSync(currentPath); } catch { /* Already unlinked. */ }
      }
    }
  };

  // Immediate check before attaching watcher/timers.
  const immediate = tryReadAndConsume();
  if (immediate !== undefined) return immediate;

  if (opts.signal?.aborted) {
    throw new VfsRpcTimeoutError(id, 0);
  }

  return await new Promise<VfsRpcReply<T>>((resolve, reject) => {
    let settled = false;
    let watcher: fs.FSWatcher | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (watcher) {
        try { watcher.close(); } catch { /* Best effort. */ }
        watcher = undefined;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
      if (opts.signal) {
        opts.signal.removeEventListener('abort', onAbort);
      }
    };

    const finishOk = (reply: VfsRpcReply<T>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(reply);
    };

    const finishErr = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const check = () => {
      if (settled) return;
      try {
        const reply = tryReadAndConsume();
        if (reply !== undefined) finishOk(reply);
      } catch (err) {
        finishErr(err);
      }
    };

    const onAbort = () => {
      finishErr(new VfsRpcTimeoutError(id, timeoutMs));
    };

    if (opts.signal) {
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      watcher = fs.watch(replyDir, (_eventType, changedName) => {
        if (!changedName || changedName === fileName) {
          check();
        }
      });
      watcher.on('error', () => {
        // Polling fallback continues safely if fs.watch encounters a transient platform error.
      });
    } catch {
      // Fall back silently to polling when fs.watch is unavailable in a confined sandbox.
    }

    pollTimer = setInterval(check, pollMs);
    deadlineTimer = setTimeout(() => {
      // One final check at the deadline before reporting timeout.
      check();
      if (!settled) {
        finishErr(new VfsRpcTimeoutError(id, timeoutMs));
      }
    }, timeoutMs);

    // Check once more right after registering watcher to avoid any race between initial read and watch.
    check();
  });
}

/**
 * Purges orphaned replies older than `maxAgeMs` (default 30s) in `<roomDir>/live/vfs-reply/`
 * and stale `q-*.json` queries older than `maxAgeMs` in `<roomDir>/outbox/`.
 *
 * Refuses to follow symlinked `live/`, `live/vfs-reply/`, or `outbox/` directories; unlinks any
 * planted symlinks found *inside* `live/vfs-reply/` immediately without following their targets.
 */
export function sweepStaleVfsRpcReplies(
  roomDir: string,
  maxAgeMs = VFS_RPC_STALE_MAX_AGE_MS,
  now: () => number = () => Date.now(),
): { removedReplies: number; removedQueries: number } {
  const cutoff = now() - Math.max(0, maxAgeMs);
  let removedReplies = 0;
  let removedQueries = 0;

  // 1. Sweep `<roomDir>/live/vfs-reply/`.
  try {
    const replyDir = inspectSafeSubdir(roomDir, [VFS_RPC_LIVE_DIR, VFS_RPC_REPLY_DIR]);
    if (replyDir) {
      for (const entry of fs.readdirSync(replyDir)) {
        const entryPath = path.join(replyDir, entry);
        let st: fs.Stats | undefined;
        try {
          st = fs.lstatSync(entryPath, { throwIfNoEntry: false });
        } catch {
          continue;
        }
        if (!st) continue;
        if (st.isSymbolicLink()) {
          // Always remove planted symlinks immediately without following their target.
          try { fs.unlinkSync(entryPath); removedReplies++; } catch { /* Best effort. */ }
          continue;
        }
        if (st.isFile() && st.mtimeMs <= cutoff) {
          try { fs.unlinkSync(entryPath); removedReplies++; } catch { /* Best effort. */ }
        }
      }
    }
  } catch {
    // Refuse to descend into a symlinked live/ or live/vfs-reply/ directory without throwing in prune().
  }

  // 2. Sweep stale `q-*.json` query files in `<roomDir>/outbox/`.
  try {
    const outboxDir = inspectSafeSubdir(roomDir, [VFS_RPC_OUTBOX_DIR]);
    if (outboxDir) {
      for (const entry of fs.readdirSync(outboxDir)) {
        if (!entry.startsWith('q-') || !entry.endsWith('.json')) continue;
        const entryPath = path.join(outboxDir, entry);
        let st: fs.Stats | undefined;
        try {
          st = fs.lstatSync(entryPath, { throwIfNoEntry: false });
        } catch {
          continue;
        }
        if (!st) continue;
        if (st.isSymbolicLink()) {
          try { fs.unlinkSync(entryPath); removedQueries++; } catch { /* Best effort. */ }
          continue;
        }
        if (st.isFile() && st.mtimeMs <= cutoff) {
          try { fs.unlinkSync(entryPath); removedQueries++; } catch { /* Best effort. */ }
        }
      }
    }
  } catch {
    // Refuse to descend into a symlinked outbox/ directory.
  }

  return { removedReplies, removedQueries };
}
