/**
 * Bridge Room VFS Runtime & RPC Dispatcher (`server/vfs-runtime.ts`).
 *
 * Manages the single persistent `VfsRoomEngine` owned by `runBridge`:
 * - Selects `MemoryVfsStore` for stateless (`MESHROOMS_AGENT_KEY` / `useMemoryOnly`) runs.
 * - Prefers native `WormDbFfiVfsStore` rooted at `<roomDir>/vfs` when `libwormdb_ffi` is
 *   present and loads cleanly, falling back seamlessly to crash-safe `BunFileVfsStore` when
 *   the native shared library is absent or incompatible.
 * - Derives the room-and-device-scoped at-rest sealing key via `deriveVfsDeviceSealKey`.
 * - Dispatches validated `VfsRpcRequest` items (reads + mutations), enforcing `canWrite`
 *   floor checks BEFORE touching the engine on mutations, paginating `vfs-read` at UTF-8
 *   code-point boundaries (64 KiB default), broadcasting outbound `VfsRecordPacket`s, and
 *   mapping all VFS errors to structured HTTP-like replies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { importEncPrivateJwk, type SignFn } from '../src/browser/relay-crypto.ts';
import { VfsError } from '../src/browser/vfs/constants.ts';
import {
  VfsRoomEngine,
  VfsUnauthorizedError,
  type VfsActorRole,
} from '../src/browser/vfs/engine.ts';
import { deriveVfsDeviceSealKey, utf8Bytes } from '../src/browser/vfs/envelope.ts';
import { VfsInvalidOpError, VfsSizeLimitError } from '../src/browser/vfs/fuguemax.ts';
import { VfsConflictError } from '../src/browser/vfs/patch.ts';
import { VfsPathError, foldVfsPath, normalizeVfsPath } from '../src/browser/vfs/path.ts';
import {
  MemoryVfsStore,
  type VfsRoomStore,
  type VfsStore,
  type VfsStoreKind,
  type VfsStoreQuotas,
} from '../src/browser/vfs/store.ts';
import type { VfsRecordPacket } from '../src/browser/vfs/wire.ts';
import { defaultOptions } from './daemon.ts';
import { BunFileVfsStore } from './persistence/vfs-bunfile.ts';
import { WormDbFfiVfsStore } from './persistence/vfs-wormdb.ts';
import {
  VFS_RPC_DEFAULT_READ_LIMIT,
  VFS_RPC_MAX_HISTORY_LIMIT,
  VFS_RPC_MAX_READ_LIMIT,
  VFS_RPC_UUID_RE,
  parseVfsOutboxItem,
  type VfsChangesReplyData,
  type VfsDeleteReplyData,
  type VfsDiffReplyData,
  type VfsHistoryReplyData,
  type VfsListReplyData,
  type VfsMutationOp,
  type VfsMutationRpc,
  type VfsPatchReplyData,
  type VfsReadReplyData,
  type VfsRevertReplyData,
  type VfsRpcErrorReply,
  type VfsRpcOp,
  type VfsRpcReply,
  type VfsRpcRequest,
  type VfsWriteReplyData,
} from './vfs-rpc.ts';

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

export type OpenBridgeVfsRuntimeOptions = {
  /** Agent/person room directory (`<dataDir>/browser-agents/<roomId>`). Unused when `useMemoryOnly` is true. */
  roomDir?: string;
  roomId: string;
  selfMemberId: string;
  selfDeviceId: string;
  selfRole?: VfsActorRole;
  /** Device ECDH private key (`CryptoKey` or `JsonWebKey` from `identity.encPrivateJwk`). */
  selfEncPrivateKey?: CryptoKey | JsonWebKey;
  /** Alias for `selfEncPrivateKey` (accepts `CryptoKey`, `CryptoKeyPair`, or `JsonWebKey`). */
  selfEncKey?: CryptoKey | CryptoKeyPair | JsonWebKey;
  selfEncVersion?: number;
  /** Device ECDSA P-256 signing callback (`SignFn`). */
  sign?: SignFn;
  /** Optional ECDSA P-256 signing key (`CryptoKey`, `CryptoKeyPair`, or `JsonWebKey`). */
  selfSignKey?: CryptoKey | CryptoKeyPair | JsonWebKey;
  /** Optional explicit 32-byte at-rest sealing key; derived via `deriveVfsDeviceSealKey` when omitted. */
  deviceSealKey?: Uint8Array;
  /** Optional secret input for `deriveVfsDeviceSealKey` (defaults to `selfEncPrivateKey`). */
  identitySecret?: CryptoKey | JsonWebKey | Uint8Array;
  isHost?: boolean;
  pinnedHost?: string;
  /** Stateless mode (`MESHROOMS_AGENT_KEY`): uses `MemoryVfsStore` with zero disk I/O. */
  useMemoryOnly?: boolean;
  /** Optional explicit path to `libwormdb_ffi.{so,dylib,dll}`; defaults to `defaultOptions().libraryPath`. */
  libraryPath?: string;
  /** Optional per-room Hot KV / Cold CAS storage quotas. */
  quotas?: VfsStoreQuotas;
  /** Optional diagnostic logger for native-library fallback messages. */
  log?: (message: string) => void;
  now?: () => number;
};

export type BridgeVfsFloorCheck =
  | boolean
  | ((req: VfsMutationRpc) => boolean | { allowed: boolean; reason?: string });

export type BridgeVfsRpcContext = {
  /**
   * Floor authorization check for mutations (`vfs-write`, `vfs-patch`, `vfs-revert`, `vfs-delete`).
   * Checked BEFORE invoking `VfsRoomEngine`; rejected with `403 VFS_FLOOR_BLOCKED` when false.
   * Read-only queries (`vfs-list`, `vfs-read`, `vfs-history`, `vfs-diff`, `vfs-changes`) ignore this.
   */
  canWrite: BridgeVfsFloorCheck;
  /** Optional refusal reason used when `canWrite` is `false` (or returns `{ allowed: false }`). */
  floorRefusal?: string;
  /** Optional member ID override for mutations (defaults to `engine.selfMemberId`). */
  actorMemberId?: string;
  /** Optional actor role override for mutations (defaults to `engine.selfRole`). */
  actorRole?: VfsActorRole;
  /** Broadcasts outbound encrypted `VfsRecordPacket`s to WebRTC peers and E2E relay. */
  broadcast: (packets: readonly VfsRecordPacket[]) => void | Promise<void>;
  /** Optional hook invoked after a non-replayed mutation succeeds. */
  onVfsChange?: (op: VfsMutationOp, nodeId: string) => void;
};

export type BridgeVfsRuntime = {
  readonly engine: VfsRoomEngine;
  readonly store: VfsStore;
  readonly roomStore: VfsRoomStore;
  readonly storeKind: VfsStoreKind;
  handleRpcRequest: (rawRequest: VfsRpcRequest | unknown, ctx: BridgeVfsRpcContext) => Promise<VfsRpcReply>;
  close: () => Promise<void>;
};

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function isCryptoKey(value: unknown): value is CryptoKey {
  return typeof CryptoKey !== 'undefined' && value instanceof CryptoKey;
}

function isCryptoKeyPair(value: unknown): value is CryptoKeyPair {
  return !!value && typeof value === 'object' && 'privateKey' in value && isCryptoKey((value as CryptoKeyPair).privateKey);
}

async function resolveEncPrivateKey(options: OpenBridgeVfsRuntimeOptions): Promise<CryptoKey> {
  const raw = options.selfEncPrivateKey ?? options.selfEncKey;
  if (!raw) {
    throw new VfsError('VFS_INVALID_KEY', 'openBridgeVfsRuntime requires selfEncPrivateKey or selfEncKey.');
  }
  if (isCryptoKey(raw)) return raw;
  if (isCryptoKeyPair(raw)) return raw.privateKey;
  return await importEncPrivateJwk(raw as JsonWebKey, false);
}

async function resolveSignKeyOption(
  raw: CryptoKey | CryptoKeyPair | JsonWebKey | undefined,
): Promise<CryptoKey | CryptoKeyPair | undefined> {
  if (!raw) return undefined;
  if (isCryptoKey(raw) || isCryptoKeyPair(raw)) return raw;
  return await crypto.subtle.importKey(
    'jwk',
    raw,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

/**
 * Distinguishes native FFI load / symbol / platform errors (safe to fall back to `BunFileVfsStore`)
 * from security / corruption failures like symlink rejection (must fail closed).
 */
function shouldFallbackToBunFileStore(err: unknown): boolean {
  if (err instanceof VfsError) {
    if (err.code !== 'VFS_STORAGE_FAILED') return false;
    const msg = err.message.toLowerCase();
    if (msg.includes('symlink') || msg.includes('symbolic link') || msg.includes('invalid storage')) {
      return false;
    }
    return /not found|enoent|dlopen|symbol|architecture|wormdb/i.test(msg);
  }
  return true;
}

async function openRoomStore(options: OpenBridgeVfsRuntimeOptions): Promise<{
  store: VfsStore;
  roomStore: VfsRoomStore;
  storeKind: VfsStoreKind;
}> {
  if (options.useMemoryOnly) {
    const store = new MemoryVfsStore();
    const roomStore = await store.openRoom(options.roomId, options.quotas);
    return { store, roomStore, storeKind: 'memory' };
  }

  if (!options.roomDir || typeof options.roomDir !== 'string' || options.roomDir.includes('\0')) {
    throw new VfsError('VFS_INVALID_KEY', 'openBridgeVfsRuntime requires roomDir unless useMemoryOnly is true.');
  }

  const vfsBaseDir = path.join(options.roomDir, 'vfs');
  const libraryPath = options.libraryPath ?? defaultOptions().libraryPath;

  if (libraryPath && fs.existsSync(libraryPath)) {
    const wormStore = new WormDbFfiVfsStore({ baseDir: vfsBaseDir, libraryPath });
    try {
      const roomStore = await wormStore.openRoom(options.roomId, options.quotas);
      return { store: wormStore, roomStore, storeKind: 'wormdb-ffi' };
    } catch (err) {
      await wormStore.close().catch(() => {});
      if (!shouldFallbackToBunFileStore(err)) {
        throw err;
      }
      options.log?.(
        `vfs: native WormDB FFI unavailable (${err instanceof Error ? err.message : String(err)}); falling back to BunFileVfsStore`,
      );
    }
  } else {
    options.log?.('vfs: native WormDB FFI library not found; using BunFileVfsStore');
  }

  const bunStore = new BunFileVfsStore({ baseDir: vfsBaseDir });
  try {
    const roomStore = await bunStore.openRoom(options.roomId, options.quotas);
    return { store: bunStore, roomStore, storeKind: 'bun-file' };
  } catch (err) {
    await bunStore.close().catch(() => {});
    throw err;
  }
}

/**
 * Slices a UTF-8 string cleanly at UTF-8 byte boundaries `[offset, offset + limit)` without ever
 * splitting a multi-byte Unicode scalar value.
 */
function sliceUtf8Page(
  fullText: string,
  requestedOffset: number,
  requestedLimit: number,
): {
  text: string;
  bytes: number;
  totalBytes: number;
  offset: number;
  limit: number;
  truncated: boolean;
  nextOffset?: number;
} {
  const fullBytes = utf8Bytes(fullText);
  const totalBytes = fullBytes.byteLength;
  const limit = Math.max(1, Math.min(VFS_RPC_MAX_READ_LIMIT, requestedLimit));
  let start = Math.max(0, requestedOffset);

  if (start >= totalBytes) {
    return {
      text: '',
      bytes: 0,
      totalBytes,
      offset: start,
      limit,
      truncated: false,
    };
  }

  // If caller passed a mid-character byte offset, advance to the next valid UTF-8 code-point start.
  while (start < totalBytes && (fullBytes[start]! & 0xc0) === 0x80) {
    start++;
  }
  if (start >= totalBytes) {
    return {
      text: '',
      bytes: 0,
      totalBytes,
      offset: start,
      limit,
      truncated: false,
    };
  }

  let end = Math.min(totalBytes, start + limit);
  // Step back off any trailing UTF-8 continuation bytes so we never split a multi-byte character.
  while (end < totalBytes && end > start && (fullBytes[end]! & 0xc0) === 0x80) {
    end--;
  }
  // Guarantee forward progress even if caller requested a tiny limit (< 4 B) on a multi-byte scalar.
  if (end === start && start < totalBytes) {
    end = start + 1;
    while (end < totalBytes && (fullBytes[end]! & 0xc0) === 0x80) {
      end++;
    }
  }

  const pageBytes = fullBytes.subarray(start, end);
  const text = utf8Decoder.decode(pageBytes);
  const truncated = end < totalBytes;

  return {
    text,
    bytes: pageBytes.byteLength,
    totalBytes,
    offset: start,
    limit,
    truncated,
    ...(truncated ? { nextOffset: end } : {}),
  };
}

function evaluateFloorCheck(
  req: VfsMutationRpc,
  ctx: BridgeVfsRpcContext,
): { allowed: true } | { allowed: false; reason: string } {
  const fallback = ctx.floorRefusal || 'Floor policy currently forbids agent VFS mutations.';
  if (typeof ctx.canWrite === 'boolean') {
    return ctx.canWrite ? { allowed: true } : { allowed: false, reason: fallback };
  }
  const verdict = ctx.canWrite(req);
  if (typeof verdict === 'boolean') {
    return verdict ? { allowed: true } : { allowed: false, reason: fallback };
  }
  return verdict.allowed
    ? { allowed: true }
    : { allowed: false, reason: verdict.reason || fallback };
}

/** Maps any VFS engine or validation error into a canonical HTTP-like `VfsRpcErrorReply`. */
export function mapVfsRpcError(
  id: string,
  op: VfsRpcOp | string | undefined,
  err: unknown,
): VfsRpcErrorReply {
  if (err instanceof VfsConflictError) {
    return {
      ok: false,
      id,
      ...(op ? { op } : {}),
      status: 409,
      code: 'VFS_CONFLICT',
      error: err.message,
      details: {
        baseRev: err.baseRev,
        currentRev: err.currentRev,
        reason: err.reason,
        conflicts: err.conflicts,
      },
    };
  }

  if (err instanceof VfsUnauthorizedError) {
    return {
      ok: false,
      id,
      ...(op ? { op } : {}),
      status: 403,
      code: 'VFS_UNAUTHORIZED',
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    };
  }

  if (err instanceof VfsPathError) {
    return {
      ok: false,
      id,
      ...(op ? { op } : {}),
      status: 400,
      code: 'VFS_INVALID_PATH',
      error: err.message,
      details: { reason: err.reason, rawPath: err.rawPath },
    };
  }

  if (err instanceof VfsSizeLimitError) {
    return {
      ok: false,
      id,
      ...(op ? { op } : {}),
      status: 413,
      code: 'VFS_SIZE_LIMIT',
      error: err.message,
      details: { byteLength: err.byteLength, limitBytes: err.limitBytes },
    };
  }

  if (err instanceof VfsInvalidOpError) {
    return {
      ok: false,
      id,
      ...(op ? { op } : {}),
      status: 400,
      code: 'VFS_INVALID_OP',
      error: err.message,
      details: { reason: err.reason },
    };
  }

  if (err instanceof VfsError) {
    let status = err.status;
    if (status === undefined) {
      switch (err.code) {
        case 'VFS_NOT_FOUND':
          status = 404;
          break;
        case 'VFS_ALREADY_EXISTS':
        case 'VFS_CONFLICT':
          status = 409;
          break;
        case 'VFS_EPOCH_UNAUTHORIZED':
          status = 403;
          break;
        case 'VFS_EPOCH_UNINITIALIZED':
        case 'VFS_NO_ONLINE_PEER':
        case 'VFS_STORAGE_CLOSED':
        case 'VFS_STORAGE_FENCED':
          status = 503;
          break;
        case 'VFS_LIMIT_EXCEEDED':
        case 'VFS_STORAGE_QUOTA':
          status = 413;
          break;
        case 'VFS_STORAGE_FAILED':
          status = 500;
          break;
        default:
          status = 400;
          break;
      }
    }
    return {
      ok: false,
      id,
      ...(op ? { op } : {}),
      status,
      code: err.code,
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    };
  }

  return {
    ok: false,
    id,
    ...(op ? { op } : {}),
    status: 500,
    code: 'VFS_INTERNAL_ERROR',
    error: err instanceof Error ? err.message : String(err),
  };
}

// ---------------------------------------------------------------------------
// Public Factory
// ---------------------------------------------------------------------------

/**
 * Opens the bridge's persistent (or stateless in-memory) Room VFS runtime and returns
 * the engine, backing store metadata, RPC request dispatcher, and clean shutdown hook.
 */
export async function openBridgeVfsRuntime(
  options: OpenBridgeVfsRuntimeOptions,
): Promise<BridgeVfsRuntime> {
  const encPrivateKey = await resolveEncPrivateKey(options);
  const signKey = await resolveSignKeyOption(options.selfSignKey);
  const deviceSealKey = options.deviceSealKey
    ? new Uint8Array(options.deviceSealKey)
    : await deriveVfsDeviceSealKey(options.identitySecret ?? encPrivateKey, {
        roomId: options.roomId,
        deviceId: options.selfDeviceId,
      });

  const { store, roomStore, storeKind } = await openRoomStore(options);

  let engine: VfsRoomEngine;
  try {
    engine = await VfsRoomEngine.open({
      roomId: options.roomId,
      store: roomStore,
      selfMemberId: options.selfMemberId,
      selfDeviceId: options.selfDeviceId,
      selfRole: options.selfRole ?? 'agent',
      selfEncPrivateKey: encPrivateKey,
      selfEncVersion: options.selfEncVersion ?? 1,
      sign: options.sign,
      selfSignKey: signKey,
      deviceSealKey,
      isHost: options.isHost ?? false,
      pinnedHost: options.pinnedHost,
      now: options.now,
    });
  } catch (err) {
    await roomStore.close().catch(() => {});
    await store.close().catch(() => {});
    throw err;
  }

  let closed = false;

  const handleRpcRequest = async (
    rawRequest: VfsRpcRequest | unknown,
    ctx: BridgeVfsRpcContext,
  ): Promise<VfsRpcReply> => {
    const parsed = parseVfsOutboxItem(rawRequest);
    if (!parsed.ok) {
      return {
        ok: false,
        id: parsed.id ?? '',
        ...(parsed.op ? { op: parsed.op } : {}),
        status: 400,
        code: 'VFS_INVALID_REQUEST',
        error: parsed.error,
      };
    }

    const req = parsed.request;
    const actorMemberId = ctx.actorMemberId ?? engine.selfMemberId;
    const actorRole = ctx.actorRole ?? engine.selfRole;

    // Enforce floor policy on ALL mutations BEFORE touching VfsRoomEngine.
    if (req.type === 'vfs-mutation') {
      const floor = evaluateFloorCheck(req, ctx);
      if (!floor.allowed) {
        return {
          ok: false,
          id: req.id,
          op: req.op,
          status: 403,
          code: 'VFS_FLOOR_BLOCKED',
          error: floor.reason,
        };
      }
    }

    try {
      switch (req.op) {
        case 'vfs-list': {
          const docs = engine.listDocs({ includeDeleted: req.includeDeleted ?? false });
          const data: VfsListReplyData = {
            docs,
            activeEpoch: engine.keyring.activeEpoch,
          };
          return { ok: true, id: req.id, op: req.op, status: 200, data };
        }

        case 'vfs-read': {
          const doc = engine.readDoc(
            req.nodeIdOrPath,
            req.rev !== undefined ? { rev: req.rev } : undefined,
          );
          const page = sliceUtf8Page(
            doc.text,
            req.offset ?? 0,
            req.limit ?? VFS_RPC_DEFAULT_READ_LIMIT,
          );
          const data: VfsReadReplyData = {
            nodeId: doc.nodeId,
            path: doc.path,
            rawPath: doc.rawPath,
            rev: doc.rev,
            text: page.text,
            bytes: page.bytes,
            totalBytes: page.totalBytes,
            offset: page.offset,
            limit: page.limit,
            truncated: page.truncated,
            ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
            overSoftLimit: doc.overSoftLimit,
            deleted: doc.deleted,
            createdBy: doc.createdBy,
            updatedBy: doc.updatedBy,
            updatedAt: doc.updatedAt,
          };
          return { ok: true, id: req.id, op: req.op, status: 200, data };
        }

        case 'vfs-history': {
          const doc = engine.readDoc(req.nodeIdOrPath);
          const limit = Math.min(req.limit ?? VFS_RPC_MAX_HISTORY_LIMIT, VFS_RPC_MAX_HISTORY_LIMIT);
          const entries = engine.history(doc.nodeId, { limit });
          const data: VfsHistoryReplyData = {
            nodeId: doc.nodeId,
            path: doc.path,
            entries,
          };
          return { ok: true, id: req.id, op: req.op, status: 200, data };
        }

        case 'vfs-diff': {
          const data: VfsDiffReplyData = engine.diff(
            req.nodeIdOrPath,
            req.fromRev,
            req.toRev ?? 'head',
          );
          return { ok: true, id: req.id, op: req.op, status: 200, data };
        }

        case 'vfs-changes': {
          const data: VfsChangesReplyData = engine.recentChanges(req.afterCursor ?? 0);
          return { ok: true, id: req.id, op: req.op, status: 200, data };
        }

        case 'vfs-write': {
          const liveDocs = engine.listDocs({ includeDeleted: false });
          let created = false;
          let result;

          if (req.targetKind === 'nodeId') {
            // Explicit nodeId target never auto-creates a document named after the UUID.
            result = await engine.writeDoc({
              nodeIdOrPath: req.nodeIdOrPath,
              content: req.content,
              baseRev: req.baseRev,
              requestId: req.id,
              message: req.message,
              actorMemberId,
              actorRole,
            });
          } else {
            const lowerTarget = req.nodeIdOrPath.toLowerCase();
            const byId = VFS_RPC_UUID_RE.test(lowerTarget)
              ? liveDocs.find(d => d.nodeId === lowerTarget)
              : undefined;

            if (byId) {
              result = await engine.writeDoc({
                nodeIdOrPath: byId.nodeId,
                content: req.content,
                baseRev: req.baseRev,
                requestId: req.id,
                message: req.message,
                actorMemberId,
                actorRole,
              });
            } else {
              // Validate & normalize path before deciding between update vs create.
              const normalized = normalizeVfsPath(req.nodeIdOrPath);
              const folded = foldVfsPath(normalized);
              const byPath = liveDocs.find(
                d => foldVfsPath(d.path) === folded || foldVfsPath(d.rawPath) === folded,
              );
              if (byPath || req.baseRev !== undefined) {
                result = await engine.writeDoc({
                  nodeIdOrPath: byPath ? byPath.nodeId : normalized,
                  content: req.content,
                  baseRev: req.baseRev,
                  requestId: req.id,
                  message: req.message,
                  actorMemberId,
                  actorRole,
                });
              } else {
                created = true;
                result = await engine.createDoc({
                  path: normalized,
                  content: req.content,
                  requestId: req.id,
                  message: req.message,
                  actorMemberId,
                  actorRole,
                });
              }
            }
          }

          if (result.outbound.length > 0) {
            await ctx.broadcast(result.outbound);
          }
          if (!result.replayed) {
            ctx.onVfsChange?.('vfs-write', result.nodeId);
          }
          const { outbound: _outbound, ...rest } = result;
          const data: VfsWriteReplyData = { ...rest, created };
          return { ok: true, id: req.id, op: req.op, status: 200, data };
        }

        case 'vfs-patch': {
          const result = await engine.patchDoc({
            nodeIdOrPath: req.nodeIdOrPath,
            baseRev: req.baseRev,
            hunks: req.hunks,
            requestId: req.id,
            message: req.message,
            actorMemberId,
            actorRole,
          });
          if (result.outbound.length > 0) {
            await ctx.broadcast(result.outbound);
          }
          if (!result.replayed) {
            ctx.onVfsChange?.('vfs-patch', result.nodeId);
          }
          const { outbound: _outbound, ...rest } = result;
          const data: VfsPatchReplyData = rest;
          return { ok: true, id: req.id, op: req.op, status: 200, data };
        }

        case 'vfs-revert': {
          const result = await engine.revertDoc({
            nodeIdOrPath: req.nodeIdOrPath,
            targetCommitId: req.targetCommitId,
            baseRev: req.baseRev,
            requestId: req.id,
            message: req.message,
            actorMemberId,
            actorRole,
          });
          if (result.outbound.length > 0) {
            await ctx.broadcast(result.outbound);
          }
          if (!result.replayed) {
            ctx.onVfsChange?.('vfs-revert', result.nodeId);
          }
          const { outbound: _outbound, ...rest } = result;
          const data: VfsRevertReplyData = rest;
          return { ok: true, id: req.id, op: req.op, status: 200, data };
        }

        case 'vfs-delete': {
          const result = req.restore === true
            ? await engine.restoreDoc({
                nodeIdOrPath: req.nodeIdOrPath,
                requestId: req.id,
                path: req.path,
                message: req.message,
                actorMemberId,
                actorRole,
              })
            : await engine.deleteDoc({
                nodeIdOrPath: req.nodeIdOrPath,
                requestId: req.id,
                message: req.message,
                actorMemberId,
                actorRole,
              });
          if (result.outbound.length > 0) {
            await ctx.broadcast(result.outbound);
          }
          if (!result.replayed) {
            ctx.onVfsChange?.('vfs-delete', result.nodeId);
          }
          const { outbound: _outbound, ...rest } = result;
          const data: VfsDeleteReplyData = rest;
          return { ok: true, id: req.id, op: req.op, status: 200, data };
        }
      }
    } catch (err) {
      return mapVfsRpcError(req.id, req.op, err);
    }
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await engine.close();
    } finally {
      await store.close();
    }
  };

  return {
    engine,
    store,
    roomStore,
    storeKind,
    handleRpcRequest,
    close,
  };
}
