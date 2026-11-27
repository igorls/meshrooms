import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  exportRawPublicKey,
  generateEncKeyPair,
  signEncBinding,
  signRoster,
  type RosterBody,
  type RosterEntry,
  type SignedRoster,
} from '../src/browser/relay-crypto.ts';
import { VfsError } from '../src/browser/vfs/constants.ts';
import { utf8Bytes } from '../src/browser/vfs/envelope.ts';
import type { VfsRecordPacket } from '../src/browser/vfs/wire.ts';
import { defaultOptions } from './daemon.ts';
import {
  VFS_RPC_DEFAULT_READ_LIMIT,
  VfsRpcTimeoutError,
  awaitVfsRpcReply,
  isVfsRpcOutboxItem,
  parseVfsOutboxItem,
  sweepStaleVfsRpcReplies,
  vfsRpcReplyPath,
  writeVfsRpcMutation,
  writeVfsRpcQuery,
  writeVfsRpcReply,
  type VfsChangesReplyData,
  type VfsDeleteReplyData,
  type VfsDiffReplyData,
  type VfsHistoryReplyData,
  type VfsListReplyData,
  type VfsPatchReplyData,
  type VfsReadReplyData,
  type VfsRevertReplyData,
  type VfsRpcReply,
  type VfsWriteReplyData,
} from './vfs-rpc.ts';
import {
  openBridgeVfsRuntime,
  type BridgeVfsRpcContext,
  type BridgeVfsRuntime,
} from './vfs-runtime.ts';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
const openRuntimes: BridgeVfsRuntime[] = [];

function makeTempDir(prefix = 'meshrooms-vfs-rpc-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (openRuntimes.length > 0) {
    const rt = openRuntimes.pop()!;
    await rt.close().catch(() => {});
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup.
    }
  }
});

type TestActor = {
  memberId: string;
  deviceId: string;
  role: 'human' | 'agent';
  signPublicKey: string;
  signKey: CryptoKey;
  signJwk: JsonWebKey;
  encPublicKey: string;
  encPrivateKey: CryptoKey;
  encPrivateJwk: JsonWebKey;
  sign: (value: unknown) => Promise<string>;
  rosterEntry: (roomId: string) => Promise<RosterEntry>;
};

async function createTestActor(role: 'human' | 'agent'): Promise<TestActor> {
  const signPair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const rawSignPub = new Uint8Array(await crypto.subtle.exportKey('raw', signPair.publicKey));
  const signPublicKey = Buffer.from(rawSignPub).toString('base64');
  const deviceId = createHash('sha256').update(rawSignPub).digest('hex');
  const signJwk = await crypto.subtle.exportKey('jwk', signPair.privateKey);

  const encPair = await generateEncKeyPair(true);
  const encPublicKey = await exportRawPublicKey(encPair.publicKey);
  const encPrivateJwk = await crypto.subtle.exportKey('jwk', encPair.privateKey);

  const sign = async (value: unknown): Promise<string> => {
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      signPair.privateKey,
      utf8Bytes(JSON.stringify(value)),
    );
    return Buffer.from(sig).toString('base64');
  };

  const memberId = randomUUID().toLowerCase();

  return {
    memberId,
    deviceId,
    role,
    signPublicKey,
    signKey: signPair.privateKey,
    signJwk,
    encPublicKey,
    encPrivateKey: encPair.privateKey,
    encPrivateJwk,
    sign,
    async rosterEntry(roomId: string): Promise<RosterEntry> {
      const encSig = await signEncBinding(sign, {
        room: roomId,
        deviceId,
        enc: encPublicKey,
        encVersion: 1,
      });
      return {
        id: deviceId,
        memberId,
        role,
        sign: signPublicKey,
        enc: encPublicKey,
        encVersion: 1,
        encSig,
      };
    },
  };
}

async function buildSignedRoster(
  roomId: string,
  host: TestActor,
  actors: readonly TestActor[],
  version = 1,
): Promise<SignedRoster> {
  const devices = await Promise.all(actors.map(a => a.rosterEntry(roomId)));
  const body: RosterBody = {
    v: 1,
    room: roomId,
    version,
    prev: '',
    at: Date.now(),
    host: host.deviceId,
    devices,
    removed: [],
  };
  return await signRoster(body, host.sign);
}

function makeRpcCtx(overrides: Partial<BridgeVfsRpcContext> = {}): {
  ctx: BridgeVfsRpcContext;
  broadcasted: VfsRecordPacket[];
  changes: Array<{ op: string; nodeId: string }>;
} {
  const broadcasted: VfsRecordPacket[] = [];
  const changes: Array<{ op: string; nodeId: string }> = [];
  const ctx: BridgeVfsRpcContext = {
    canWrite: true,
    broadcast: packets => {
      broadcasted.push(...packets);
    },
    onVfsChange: (op, nodeId) => {
      changes.push({ op, nodeId });
    },
    ...overrides,
  };
  return { ctx, broadcasted, changes };
}

// ---------------------------------------------------------------------------
// 1. Parser & Schema Validation
// ---------------------------------------------------------------------------

describe('parseVfsOutboxItem & schema validation', () => {
  test('accepts all 5 query ops and all 4 mutation ops with optional fields', () => {
    const id = randomUUID().toLowerCase();
    const replyTo = randomUUID().toLowerCase();

    const validItems = [
      { type: 'vfs-query', id, op: 'vfs-list', includeDeleted: true },
      { type: 'vfs-query', id, op: 'vfs-read', nodeIdOrPath: 'notes.md', targetKind: 'path', rev: 'head', offset: 0, limit: 1024 },
      { type: 'vfs-query', id, op: 'vfs-history', nodeIdOrPath: id, targetKind: 'nodeId', limit: 20 },
      { type: 'vfs-query', id, op: 'vfs-diff', nodeIdOrPath: 'notes.md', fromRev: 'empty', toRev: 'head' },
      { type: 'vfs-query', id, op: 'vfs-changes', afterCursor: 3 },
      { type: 'vfs-mutation', id, op: 'vfs-write', nodeIdOrPath: 'notes.md', content: 'hello', baseRev: 'f:0123456789abcdef', message: 'edit', replyTo },
      {
        type: 'vfs-mutation',
        id,
        op: 'vfs-patch',
        nodeIdOrPath: 'notes.md',
        baseRev: 'f:0123456789abcdef',
        hunks: [
          { op: 'replace', old: 'a', new: 'b', before: 'x', after: 'y' },
          { op: 'insert_after', anchor: 'b', text: 'c' },
          { op: 'insert_before', anchor: 'b', text: '0' },
          { op: 'append', text: '\nend' },
          { op: 'prepend', text: 'start\n' },
        ],
        message: 'patch',
        replyTo,
      },
      { type: 'vfs-mutation', id, op: 'vfs-revert', nodeIdOrPath: 'notes.md', targetCommitId: id, message: 'undo', replyTo },
      { type: 'vfs-mutation', id, op: 'vfs-delete', nodeIdOrPath: 'notes.md', restore: true, path: 'restored.md', message: 'restore', replyTo },
    ];

    for (const item of validItems) {
      expect(isVfsRpcOutboxItem(item)).toBe(true);
      const parsed = parseVfsOutboxItem(item);
      expect(parsed.ok).toBe(true);
    }
  });

  test('rejects path-traversal ids, malformed replyTo, unknown ops, bad hunks, and bad bounds', () => {
    const id = randomUUID().toLowerCase();

    expect(isVfsRpcOutboxItem(null)).toBe(false);
    expect(isVfsRpcOutboxItem({ id, text: 'plain chat message' })).toBe(false);
    expect(isVfsRpcOutboxItem({ type: 'task', id })).toBe(false);

    const invalidItems: unknown[] = [
      null,
      'string',
      [],
      { type: 'vfs-query', id: '../escape', op: 'vfs-list' },
      { type: 'vfs-query', id: id.toUpperCase(), op: 'vfs-list' },
      { type: 'vfs-query', id, op: 'vfs-unknown' },
      { type: 'vfs-query', id, op: 'vfs-read', nodeIdOrPath: '' },
      { type: 'vfs-query', id, op: 'vfs-read', nodeIdOrPath: 'a\0b' },
      { type: 'vfs-query', id, op: 'vfs-read', nodeIdOrPath: 'a.md', offset: -1 },
      { type: 'vfs-query', id, op: 'vfs-read', nodeIdOrPath: 'a.md', limit: 0 },
      { type: 'vfs-query', id, op: 'vfs-read', nodeIdOrPath: 'a.md', targetKind: 'other' },
      { type: 'vfs-query', id, op: 'vfs-changes', afterCursor: -5 },
      { type: 'vfs-mutation', id, op: 'vfs-write', nodeIdOrPath: 'a.md', content: 'x', replyTo: 'not-a-uuid' },
      { type: 'vfs-mutation', id, op: 'vfs-write', nodeIdOrPath: 'a.md', content: 42 },
      { type: 'vfs-mutation', id, op: 'vfs-patch', nodeIdOrPath: 'a.md', baseRev: 'f:1', hunks: [] },
      { type: 'vfs-mutation', id, op: 'vfs-patch', nodeIdOrPath: 'a.md', baseRev: 'f:1', hunks: [{ op: 'replace', old: 'a' }] },
      { type: 'vfs-mutation', id, op: 'vfs-revert', nodeIdOrPath: 'a.md', targetCommitId: '' },
      { type: 'vfs-mutation', id, op: 'vfs-delete', nodeIdOrPath: 'a.md', restore: 'yes' },
      { type: 'vfs-other', id, op: 'vfs-list' },
    ];

    for (const item of invalidItems) {
      const parsed = parseVfsOutboxItem(item);
      expect(parsed.ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. File-Mailbox Permissions, Symlink Resistance, Ephemeral Unlink & Sweep
// ---------------------------------------------------------------------------

describe('file-mailbox RPC security, permissions, and ephemeral cleanup', () => {
  test('writes queries, mutations, and replies with 0o600 permissions and unlinks reply immediately', async () => {
    const roomDir = makeTempDir();
    const queryHandle = writeVfsRpcQuery(roomDir, { op: 'vfs-list', includeDeleted: false });
    const mutId = randomUUID().toLowerCase();
    const mutHandle = writeVfsRpcMutation(roomDir, {
      id: mutId,
      op: 'vfs-write',
      nodeIdOrPath: 'spec.md',
      content: 'hello',
    });

    expect(queryHandle.fileName).toBe(`q-${queryHandle.id}.json`);
    expect(mutHandle.fileName.endsWith(`-${mutId}.json`)).toBe(true);

    if (process.platform !== 'win32') {
      expect(fs.lstatSync(queryHandle.filePath).mode & 0o777).toBe(0o600);
      expect(fs.lstatSync(mutHandle.filePath).mode & 0o777).toBe(0o600);
    }

    const replyPath = writeVfsRpcReply(roomDir, queryHandle.id, {
      ok: true,
      id: queryHandle.id,
      op: 'vfs-list',
      status: 200,
      data: { docs: [], activeEpoch: 1 },
    });
    expect(replyPath).toBe(vfsRpcReplyPath(roomDir, queryHandle.id));
    if (process.platform !== 'win32') {
      expect(fs.lstatSync(replyPath).mode & 0o777).toBe(0o600);
    }

    const reply = await awaitVfsRpcReply<VfsListReplyData>(roomDir, queryHandle.id, 2_000);
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.activeEpoch).toBe(1);
    }
    // Zero plaintext resting on disk: reply file MUST be unlinked immediately.
    expect(fs.existsSync(replyPath)).toBe(false);
    expect(fs.readdirSync(path.dirname(replyPath))).toEqual([]);
  });

  test('awaitVfsRpcReply wakes up when reply arrives asynchronously and times out cleanly when absent', async () => {
    const roomDir = makeTempDir();
    const id = randomUUID().toLowerCase();

    setTimeout(() => {
      writeVfsRpcReply(roomDir, id, {
        ok: true,
        id,
        op: 'vfs-changes',
        status: 200,
        data: { events: [], cursor: 7 },
      });
    }, 35);

    const reply = await awaitVfsRpcReply<VfsChangesReplyData>(roomDir, id, { timeoutMs: 2_000, pollMs: 10 });
    expect(reply.ok).toBe(true);
    if (reply.ok) expect(reply.data.cursor).toBe(7);
    expect(fs.existsSync(vfsRpcReplyPath(roomDir, id))).toBe(false);

    const missingId = randomUUID().toLowerCase();
    await expect(awaitVfsRpcReply(roomDir, missingId, { timeoutMs: 60, pollMs: 10 })).rejects.toThrow(
      VfsRpcTimeoutError,
    );
  });

  test('awaitVfsRpcReply unlinks malformed JSON and mismatched-id replies in finally', async () => {
    const roomDir = makeTempDir();
    const badJsonId = randomUUID().toLowerCase();
    const replyDir = path.join(roomDir, 'live', 'vfs-reply');
    fs.mkdirSync(replyDir, { recursive: true, mode: 0o700 });
    const badJsonPath = path.join(replyDir, `${badJsonId}.json`);
    fs.writeFileSync(badJsonPath, '{not valid json', { mode: 0o600 });

    await expect(awaitVfsRpcReply(roomDir, badJsonId, 500)).rejects.toThrow();
    expect(fs.existsSync(badJsonPath)).toBe(false);

    const expectedId = randomUUID().toLowerCase();
    const wrongId = randomUUID().toLowerCase();
    const mismatchPath = writeVfsRpcReply(roomDir, expectedId, {
      ok: true,
      id: wrongId,
      op: 'vfs-list',
      status: 200,
      data: { docs: [], activeEpoch: 0 },
    });
    await expect(awaitVfsRpcReply(roomDir, expectedId, 500)).rejects.toThrow(VfsError);
    expect(fs.existsSync(mismatchPath)).toBe(false);
  });

  test('defends against symlink planting on outbox/, live/, live/vfs-reply/, and target files', async () => {
    if (process.platform === 'win32') return;

    const outsideDir = makeTempDir('meshrooms-decoy-');
    const decoyFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(decoyFile, 'DO-NOT-TOUCH', { mode: 0o600 });

    // 1. Symlinked outbox/ directory rejected by CLI writers.
    const room1 = makeTempDir();
    fs.symlinkSync(outsideDir, path.join(room1, 'outbox'));
    expect(() => writeVfsRpcQuery(room1, { op: 'vfs-list' })).toThrow(VfsError);
    expect(() =>
      writeVfsRpcMutation(room1, {
        id: randomUUID().toLowerCase(),
        op: 'vfs-write',
        nodeIdOrPath: 'a.md',
        content: 'hi',
      }),
    ).toThrow(VfsError);

    // 2. Planted symlink at outbox/q-<id>.json rejected without touching decoy.
    const room2 = makeTempDir();
    fs.mkdirSync(path.join(room2, 'outbox'), { recursive: true, mode: 0o700 });
    const qId = randomUUID().toLowerCase();
    fs.symlinkSync(decoyFile, path.join(room2, 'outbox', `q-${qId}.json`));
    expect(() => writeVfsRpcQuery(room2, { id: qId, op: 'vfs-list' })).toThrow(VfsError);
    expect(fs.readFileSync(decoyFile, 'utf8')).toBe('DO-NOT-TOUCH');

    // 3. Symlinked live/ or live/vfs-reply/ directory rejected by runner & CLI.
    const room3 = makeTempDir();
    fs.mkdirSync(path.join(room3, 'live'), { recursive: true, mode: 0o700 });
    fs.symlinkSync(outsideDir, path.join(room3, 'live', 'vfs-reply'));
    const rId = randomUUID().toLowerCase();
    expect(() =>
      writeVfsRpcReply(room3, rId, {
        ok: true,
        id: rId,
        op: 'vfs-list',
        status: 200,
        data: { docs: [], activeEpoch: 0 },
      }),
    ).toThrow(VfsError);
    await expect(awaitVfsRpcReply(room3, rId, 200)).rejects.toThrow(VfsError);

    // 4. Planted symlink at live/vfs-reply/<id>.json:
    //    - Runner `writeVfsRpcReply` replaces it atomically WITHOUT writing to decoyFile!
    const room4 = makeTempDir();
    const replyDir4 = path.join(room4, 'live', 'vfs-reply');
    fs.mkdirSync(replyDir4, { recursive: true, mode: 0o700 });
    const plantedReplyPath = path.join(replyDir4, `${rId}.json`);
    fs.symlinkSync(decoyFile, plantedReplyPath);
    writeVfsRpcReply(room4, rId, {
      ok: true,
      id: rId,
      op: 'vfs-list',
      status: 200,
      data: { docs: [], activeEpoch: 1 },
    });
    expect(fs.lstatSync(plantedReplyPath).isFile()).toBe(true);
    expect(fs.lstatSync(plantedReplyPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(decoyFile, 'utf8')).toBe('DO-NOT-TOUCH');

    // 5. Planted symlink at live/vfs-reply/<id>.json read by CLI `awaitVfsRpcReply`:
    //    - Refused (`VFS_STORAGE_FAILED`), planted symlink removed, decoy untouched!
    const cliId = randomUUID().toLowerCase();
    const plantedForCli = path.join(replyDir4, `${cliId}.json`);
    fs.symlinkSync(decoyFile, plantedForCli);
    await expect(awaitVfsRpcReply(room4, cliId, 200)).rejects.toThrow(VfsError);
    expect(fs.lstatSync(plantedForCli, { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.readFileSync(decoyFile, 'utf8')).toBe('DO-NOT-TOUCH');
  });

  test('sweepStaleVfsRpcReplies purges stale replies/queries & planted symlinks while preserving fresh items', () => {
    const roomDir = makeTempDir();
    const freshId = randomUUID().toLowerCase();
    const staleId = randomUUID().toLowerCase();
    const staleQuery = writeVfsRpcQuery(roomDir, { op: 'vfs-list' });
    const freshQuery = writeVfsRpcQuery(roomDir, { op: 'vfs-changes' });
    const mutHandle = writeVfsRpcMutation(roomDir, {
      id: randomUUID().toLowerCase(),
      op: 'vfs-write',
      nodeIdOrPath: 'keep.md',
      content: 'stay',
    });

    const staleReplyPath = writeVfsRpcReply(roomDir, staleId, {
      ok: true,
      id: staleId,
      op: 'vfs-list',
      status: 200,
      data: { docs: [], activeEpoch: 0 },
    });
    const freshReplyPath = writeVfsRpcReply(roomDir, freshId, {
      ok: true,
      id: freshId,
      op: 'vfs-list',
      status: 200,
      data: { docs: [], activeEpoch: 0 },
    });

    const nowMs = Date.now();
    const staleDate = new Date(nowMs - 45_000);
    fs.utimesSync(staleReplyPath, staleDate, staleDate);
    fs.utimesSync(staleQuery.filePath, staleDate, staleDate);
    fs.utimesSync(mutHandle.filePath, staleDate, staleDate);

    // Plant a symlink inside live/vfs-reply/ pointing outside; sweep removes the link, not target.
    const decoyDir = makeTempDir('meshrooms-sweep-decoy-');
    const decoyFile = path.join(decoyDir, 'victim.json');
    fs.writeFileSync(decoyFile, 'intact', { mode: 0o600 });
    const plantedLink = path.join(roomDir, 'live', 'vfs-reply', 'planted.json');
    if (process.platform !== 'win32') {
      fs.symlinkSync(decoyFile, plantedLink);
    }

    const swept = sweepStaleVfsRpcReplies(roomDir, 30_000, () => nowMs);
    expect(swept.removedReplies).toBe(process.platform !== 'win32' ? 2 : 1);
    expect(swept.removedQueries).toBe(1);

    expect(fs.existsSync(staleReplyPath)).toBe(false);
    expect(fs.existsSync(freshReplyPath)).toBe(true);
    expect(fs.existsSync(staleQuery.filePath)).toBe(false);
    expect(fs.existsSync(freshQuery.filePath)).toBe(true);
    // Mutations are NOT purged by query/reply sweep (delivery manages them).
    expect(fs.existsSync(mutHandle.filePath)).toBe(true);
    expect(fs.readFileSync(decoyFile, 'utf8')).toBe('intact');

    // Symlinked live/vfs-reply directory is never descended into.
    if (process.platform !== 'win32') {
      const linkRoom = makeTempDir();
      fs.mkdirSync(path.join(linkRoom, 'live'), { recursive: true, mode: 0o700 });
      fs.symlinkSync(decoyDir, path.join(linkRoom, 'live', 'vfs-reply'));
      fs.utimesSync(decoyFile, staleDate, staleDate);
      const res = sweepStaleVfsRpcReplies(linkRoom, 30_000, () => nowMs);
      expect(res.removedReplies).toBe(0);
      expect(fs.existsSync(decoyFile)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Bridge Runtime Store Selection & Persistence (Memory, BunFile, WormDB)
// ---------------------------------------------------------------------------

describe('openBridgeVfsRuntime store selection & persistence', () => {
  test('uses MemoryVfsStore when useMemoryOnly is true without touching disk', async () => {
    const roomId = randomUUID().toLowerCase();
    const actor = await createTestActor('human');
    const missingDir = path.join(os.tmpdir(), `meshrooms-never-created-${randomUUID()}`);

    const runtime = await openBridgeVfsRuntime({
      roomDir: missingDir,
      roomId,
      selfMemberId: actor.memberId,
      selfDeviceId: actor.deviceId,
      selfRole: 'human',
      selfEncPrivateKey: actor.encPrivateJwk,
      sign: actor.sign,
      isHost: true,
      useMemoryOnly: true,
    });
    openRuntimes.push(runtime);

    expect(runtime.storeKind).toBe('memory');
    expect(fs.existsSync(missingDir)).toBe(false);

    const roster = await buildSignedRoster(roomId, actor, [actor]);
    await runtime.engine.bootstrapEpoch1(roster);
    const { ctx } = makeRpcCtx();
    const res = await runtime.handleRpcRequest(
      {
        type: 'vfs-mutation',
        id: randomUUID().toLowerCase(),
        op: 'vfs-write',
        nodeIdOrPath: 'ephemeral.md',
        content: 'memory only',
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(fs.existsSync(missingDir)).toBe(false);
  });

  test('falls back cleanly to BunFileVfsStore when native library is absent or invalid, and persists across reopen', async () => {
    const roomId = randomUUID().toLowerCase();
    const roomDir = makeTempDir();
    const actor = await createTestActor('human');
    const logs: string[] = [];

    // 1. Missing library path -> BunFileVfsStore.
    const rt1 = await openBridgeVfsRuntime({
      roomDir,
      roomId,
      selfMemberId: actor.memberId,
      selfDeviceId: actor.deviceId,
      selfRole: 'human',
      selfEncPrivateKey: actor.encPrivateJwk,
      sign: actor.sign,
      isHost: true,
      libraryPath: path.join(roomDir, 'does-not-exist-libwormdb_ffi.so'),
      log: msg => logs.push(msg),
    });
    expect(rt1.storeKind).toBe('bun-file');
    expect(logs.some(m => m.includes('BunFileVfsStore'))).toBe(true);

    const roster = await buildSignedRoster(roomId, actor, [actor]);
    await rt1.engine.bootstrapEpoch1(roster);
    const { ctx } = makeRpcCtx();
    const writeRes = await rt1.handleRpcRequest(
      {
        type: 'vfs-mutation',
        id: randomUUID().toLowerCase(),
        op: 'vfs-write',
        nodeIdOrPath: 'persisted.md',
        content: 'survives restart',
      },
      ctx,
    );
    expect(writeRes.ok).toBe(true);
    await rt1.close();

    // 2. Corrupt shared library file -> dlopen fails -> falls back to BunFileVfsStore and reads persisted doc!
    const fakeLib = path.join(roomDir, 'corrupt_libwormdb_ffi.so');
    fs.writeFileSync(fakeLib, 'not an elf shared object');
    const rt2 = await openBridgeVfsRuntime({
      roomDir,
      roomId,
      selfMemberId: actor.memberId,
      selfDeviceId: actor.deviceId,
      selfRole: 'human',
      selfEncPrivateKey: actor.encPrivateKey,
      sign: actor.sign,
      isHost: true,
      libraryPath: fakeLib,
      log: msg => logs.push(msg),
    });
    openRuntimes.push(rt2);
    expect(rt2.storeKind).toBe('bun-file');

    const readRes = await rt2.handleRpcRequest(
      {
        type: 'vfs-query',
        id: randomUUID().toLowerCase(),
        op: 'vfs-read',
        nodeIdOrPath: 'persisted.md',
      },
      ctx,
    );
    expect(readRes.ok).toBe(true);
    if (readRes.ok) {
      expect((readRes.data as VfsReadReplyData).text).toBe('survives restart');
    }
  });

  test('uses native WormDbFfiVfsStore when libwormdb_ffi is present and persists across reopen', async () => {
    const defaultLib = defaultOptions().libraryPath;
    if (!defaultLib || !fs.existsSync(defaultLib)) {
      // Skip only when running in environments explicitly without the native .so (e.g. fallback CI run).
      return;
    }
    const roomId = randomUUID().toLowerCase();
    const roomDir = makeTempDir();
    const actor = await createTestActor('human');

    const rt1 = await openBridgeVfsRuntime({
      roomDir,
      roomId,
      selfMemberId: actor.memberId,
      selfDeviceId: actor.deviceId,
      selfRole: 'human',
      selfEncPrivateKey: actor.encPrivateJwk,
      sign: actor.sign,
      isHost: true,
      libraryPath: defaultLib,
    });
    expect(rt1.storeKind).toBe('wormdb-ffi');

    const roster = await buildSignedRoster(roomId, actor, [actor]);
    await rt1.engine.bootstrapEpoch1(roster);
    const { ctx } = makeRpcCtx();
    const writeRes = await rt1.handleRpcRequest(
      {
        type: 'vfs-mutation',
        id: randomUUID().toLowerCase(),
        op: 'vfs-write',
        nodeIdOrPath: 'wormdb-doc.md',
        content: 'stored in native wormdb',
      },
      ctx,
    );
    expect(writeRes.ok).toBe(true);
    await rt1.close();

    const rt2 = await openBridgeVfsRuntime({
      roomDir,
      roomId,
      selfMemberId: actor.memberId,
      selfDeviceId: actor.deviceId,
      selfRole: 'human',
      selfEncPrivateKey: actor.encPrivateJwk,
      sign: actor.sign,
      isHost: true,
      libraryPath: defaultLib,
    });
    openRuntimes.push(rt2);
    expect(rt2.storeKind).toBe('wormdb-ffi');

    const readRes = await rt2.handleRpcRequest(
      {
        type: 'vfs-query',
        id: randomUUID().toLowerCase(),
        op: 'vfs-read',
        nodeIdOrPath: 'wormdb-doc.md',
      },
      ctx,
    );
    expect(readRes.ok).toBe(true);
    if (readRes.ok) {
      expect((readRes.data as VfsReadReplyData).text).toBe('stored in native wormdb');
    }
  });
});

// ---------------------------------------------------------------------------
// 4. RPC Dispatch: All 9 Ops, Floor Blocking, Pagination, Conflicts, Decision 4
// ---------------------------------------------------------------------------

describe('BridgeVfsRuntime.handleRpcRequest full op coverage', () => {
  test('enforces floor block (403 VFS_FLOOR_BLOCKED) on all 4 mutations while allowing reads', async () => {
    const roomId = randomUUID().toLowerCase();
    const host = await createTestActor('human');
    const rt = await openBridgeVfsRuntime({
      roomId,
      selfMemberId: host.memberId,
      selfDeviceId: host.deviceId,
      selfRole: 'agent',
      selfEncPrivateKey: host.encPrivateKey,
      sign: host.sign,
      isHost: true,
      useMemoryOnly: true,
    });
    openRuntimes.push(rt);

    const roster = await buildSignedRoster(roomId, host, [host]);
    await rt.engine.bootstrapEpoch1(roster);

    // Seed one document while canWrite is true.
    const allowed = makeRpcCtx({ canWrite: true });
    const created = await rt.handleRpcRequest(
      {
        type: 'vfs-mutation',
        id: randomUUID().toLowerCase(),
        op: 'vfs-write',
        nodeIdOrPath: 'notes.md',
        content: 'line 1\nline 2\n',
      },
      allowed.ctx,
    );
    expect(created.ok).toBe(true);
    const createdData = (created as Extract<VfsRpcReply, { ok: true }>).data as VfsWriteReplyData;

    // Now block mutations via floor callback (simulating `mayAgentSpeak === false`).
    const blocked = makeRpcCtx({
      canWrite: req => ({
        allowed: false,
        reason: `Floor blocked for ${req.op}: wait for a human to address you.`,
      }),
    });

    const mutReqs = [
      { type: 'vfs-mutation', id: randomUUID().toLowerCase(), op: 'vfs-write', nodeIdOrPath: 'notes.md', content: 'nope' },
      {
        type: 'vfs-mutation',
        id: randomUUID().toLowerCase(),
        op: 'vfs-patch',
        nodeIdOrPath: 'notes.md',
        baseRev: createdData.rev,
        hunks: [{ op: 'append', text: 'nope' }],
      },
      {
        type: 'vfs-mutation',
        id: randomUUID().toLowerCase(),
        op: 'vfs-revert',
        nodeIdOrPath: 'notes.md',
        targetCommitId: createdData.commitId,
      },
      {
        type: 'vfs-mutation',
        id: randomUUID().toLowerCase(),
        op: 'vfs-delete',
        nodeIdOrPath: 'notes.md',
      },
    ] as const;

    for (const req of mutReqs) {
      const reply = await rt.handleRpcRequest(req, blocked.ctx);
      expect(reply.ok).toBe(false);
      if (!reply.ok) {
        expect(reply.status).toBe(403);
        expect(reply.code).toBe('VFS_FLOOR_BLOCKED');
        expect(reply.error).toContain(req.op);
      }
    }
    expect(blocked.broadcasted.length).toBe(0);
    expect(blocked.changes.length).toBe(0);

    // All 5 read queries still succeed while floor is blocked.
    const listReply = await rt.handleRpcRequest({ type: 'vfs-query', id: randomUUID().toLowerCase(), op: 'vfs-list' }, blocked.ctx);
    const readReply = await rt.handleRpcRequest({ type: 'vfs-query', id: randomUUID().toLowerCase(), op: 'vfs-read', nodeIdOrPath: 'notes.md' }, blocked.ctx);
    const histReply = await rt.handleRpcRequest({ type: 'vfs-query', id: randomUUID().toLowerCase(), op: 'vfs-history', nodeIdOrPath: 'notes.md' }, blocked.ctx);
    const diffReply = await rt.handleRpcRequest({ type: 'vfs-query', id: randomUUID().toLowerCase(), op: 'vfs-diff', nodeIdOrPath: 'notes.md', fromRev: 'empty' }, blocked.ctx);
    const changesReply = await rt.handleRpcRequest({ type: 'vfs-query', id: randomUUID().toLowerCase(), op: 'vfs-changes', afterCursor: 0 }, blocked.ctx);

    expect(listReply.ok).toBe(true);
    expect(readReply.ok).toBe(true);
    expect(histReply.ok).toBe(true);
    expect(diffReply.ok).toBe(true);
    expect(changesReply.ok).toBe(true);
  });

  test('returns 503 VFS_EPOCH_UNINITIALIZED before epoch bootstrap and maps path/not-found errors', async () => {
    const roomId = randomUUID().toLowerCase();
    const actor = await createTestActor('human');
    const rt = await openBridgeVfsRuntime({
      roomId,
      selfMemberId: actor.memberId,
      selfDeviceId: actor.deviceId,
      selfRole: 'human',
      selfEncPrivateKey: actor.encPrivateKey,
      sign: actor.sign,
      isHost: true,
      useMemoryOnly: true,
    });
    openRuntimes.push(rt);
    const { ctx } = makeRpcCtx();

    const listBefore = await rt.handleRpcRequest({ type: 'vfs-query', id: randomUUID().toLowerCase(), op: 'vfs-list' }, ctx);
    expect(listBefore.ok).toBe(true);
    if (listBefore.ok) {
      expect((listBefore.data as VfsListReplyData).activeEpoch).toBe(0);
    }

    const writeBeforeEpoch = await rt.handleRpcRequest(
      { type: 'vfs-mutation', id: randomUUID().toLowerCase(), op: 'vfs-write', nodeIdOrPath: 'a.md', content: 'hi' },
      ctx,
    );
    expect(writeBeforeEpoch.ok).toBe(false);
    if (!writeBeforeEpoch.ok) {
      expect(writeBeforeEpoch.status).toBe(503);
      expect(writeBeforeEpoch.code).toBe('VFS_EPOCH_UNINITIALIZED');
    }

    const roster = await buildSignedRoster(roomId, actor, [actor]);
    await rt.engine.bootstrapEpoch1(roster);

    const badPath = await rt.handleRpcRequest(
      { type: 'vfs-mutation', id: randomUUID().toLowerCase(), op: 'vfs-write', nodeIdOrPath: '../escape.md', content: 'x' },
      ctx,
    );
    expect(badPath.ok).toBe(false);
    if (!badPath.ok) {
      expect(badPath.status).toBe(400);
      expect(badPath.code).toBe('VFS_INVALID_PATH');
    }

    // Explicit targetKind: 'nodeId' on unknown UUID must NOT auto-create a file named after the UUID.
    const unknownId = randomUUID().toLowerCase();
    const missingNode = await rt.handleRpcRequest(
      {
        type: 'vfs-mutation',
        id: randomUUID().toLowerCase(),
        op: 'vfs-write',
        nodeIdOrPath: unknownId,
        targetKind: 'nodeId',
        content: 'should not create',
      },
      ctx,
    );
    expect(missingNode.ok).toBe(false);
    if (!missingNode.ok) {
      expect(missingNode.status).toBe(404);
      expect(missingNode.code).toBe('VFS_NOT_FOUND');
    }
    expect(rt.engine.listDocs()).toEqual([]);
  });

  test('executes full lifecycle: write (create/update/idempotent), UTF-8 paginated read, patch + conflict, history, diff, revert, changes', async () => {
    const roomId = randomUUID().toLowerCase();
    const actor = await createTestActor('human');
    const rt = await openBridgeVfsRuntime({
      roomId,
      selfMemberId: actor.memberId,
      selfDeviceId: actor.deviceId,
      selfRole: 'human',
      selfEncPrivateKey: actor.encPrivateKey,
      sign: actor.sign,
      isHost: true,
      useMemoryOnly: true,
    });
    openRuntimes.push(rt);
    const roster = await buildSignedRoster(roomId, actor, [actor]);
    await rt.engine.bootstrapEpoch1(roster);
    const { ctx, broadcasted } = makeRpcCtx();

    // 1. Create doc via vfs-write.
    const createReqId = randomUUID().toLowerCase();
    const v1Text = '# Plano\nLinha 1: café ☕\nLinha 2: ação 🚀\n';
    const w1 = await rt.handleRpcRequest(
      {
        type: 'vfs-mutation',
        id: createReqId,
        op: 'vfs-write',
        nodeIdOrPath: 'docs/plano.md',
        content: v1Text,
        message: 'initial draft',
      },
      ctx,
    );
    expect(w1.ok).toBe(true);
    const d1 = (w1 as Extract<VfsRpcReply, { ok: true }>).data as VfsWriteReplyData;
    expect(d1.created).toBe(true);
    expect(d1.replayed).toBe(false);
    expect('outbound' in d1).toBe(false);
    expect(broadcasted.length).toBeGreaterThanOrEqual(2);

    // 2. Idempotent replay with same requestId returns cached result and emits zero extra packets.
    const countBeforeReplay = broadcasted.length;
    const w1Replay = await rt.handleRpcRequest(
      {
        type: 'vfs-mutation',
        id: createReqId,
        op: 'vfs-write',
        nodeIdOrPath: 'docs/plano.md',
        content: v1Text,
      },
      ctx,
    );
    expect(w1Replay.ok).toBe(true);
    if (w1Replay.ok) {
      const replayData = w1Replay.data as VfsWriteReplyData;
      expect(replayData.replayed).toBe(true);
      expect(replayData.commitId).toBe(d1.commitId);
    }
    expect(broadcasted.length).toBe(countBeforeReplay);

    // 3. UTF-8 code-point-safe pagination (never splits multi-byte emoji or accented characters).
    let reconstructed = '';
    let nextOffset: number | undefined = 0;
    let pages = 0;
    while (nextOffset !== undefined) {
      const pageReply = await rt.handleRpcRequest(
        {
          type: 'vfs-query',
          id: randomUUID().toLowerCase(),
          op: 'vfs-read',
          nodeIdOrPath: 'docs/plano.md',
          offset: nextOffset,
          limit: 11,
        },
        ctx,
      );
      expect(pageReply.ok).toBe(true);
      const page = (pageReply as Extract<VfsRpcReply, { ok: true }>).data as VfsReadReplyData;
      expect(page.totalBytes).toBe(utf8Bytes(v1Text).byteLength);
      expect(page.text.includes('\uFFFD')).toBe(false);
      reconstructed += page.text;
      pages++;
      nextOffset = page.truncated ? page.nextOffset : undefined;
      expect(pages).toBeLessThan(20);
    }
    expect(reconstructed).toBe(v1Text);
    expect(pages).toBeGreaterThan(2);

    // Also verify default 64 KiB pagination boundary on a 75 KiB document.
    const bigText = `${'A'.repeat(40_000)}é🚀${'B'.repeat(35_000)}`;
    const bigWrite = await rt.handleRpcRequest(
      {
        type: 'vfs-mutation',
        id: randomUUID().toLowerCase(),
        op: 'vfs-write',
        nodeIdOrPath: 'big.txt',
        content: bigText,
      },
      ctx,
    );
    expect(bigWrite.ok).toBe(true);
    const bigPage1 = (
      await rt.handleRpcRequest(
        { type: 'vfs-query', id: randomUUID().toLowerCase(), op: 'vfs-read', nodeIdOrPath: 'big.txt' },
        ctx,
      )
    ) as Extract<VfsRpcReply, { ok: true }>;
    const bp1 = bigPage1.data as VfsReadReplyData;
    expect(bp1.limit).toBe(VFS_RPC_DEFAULT_READ_LIMIT);
    expect(bp1.truncated).toBe(true);
    expect(bp1.nextOffset).toBeGreaterThan(0);
    const bigPage2 = (
      await rt.handleRpcRequest(
        {
          type: 'vfs-query',
          id: randomUUID().toLowerCase(),
          op: 'vfs-read',
          nodeIdOrPath: 'big.txt',
          offset: bp1.nextOffset,
        },
        ctx,
      )
    ) as Extract<VfsRpcReply, { ok: true }>;
    const bp2 = bigPage2.data as VfsReadReplyData;
    expect(bp2.truncated).toBe(false);
    expect(bp1.text + bp2.text).toBe(bigText);

    // 4. Patch doc cleanly, then verify auto-rebase + 409 VFS_CONFLICT with structured details.
    const p1 = await rt.handleRpcRequest(
      {
        type: 'vfs-mutation',
        id: randomUUID().toLowerCase(),
        op: 'vfs-patch',
        nodeIdOrPath: 'docs/plano.md',
        baseRev: d1.rev,
        hunks: [{ op: 'replace', old: 'café ☕', new: 'chá 🍵' }],
        message: 'switch to tea',
      },
      ctx,
    );
    expect(p1.ok).toBe(true);
    const pd1 = (p1 as Extract<VfsRpcReply, { ok: true }>).data as VfsPatchReplyData;
    expect(pd1.rebased).toBe(false);

    // Non-overlapping patch based on older rev d1.rev auto-rebases cleanly!
    const p2 = await rt.handleRpcRequest(
      {
        type: 'vfs-mutation',
        id: randomUUID().toLowerCase(),
        op: 'vfs-patch',
        nodeIdOrPath: 'docs/plano.md',
        baseRev: d1.rev,
        hunks: [{ op: 'replace', old: 'ação 🚀', new: 'plano ✅' }],
        message: 'update line 2 concurrently',
      },
      ctx,
    );
    expect(p2.ok).toBe(true);
    const pd2 = (p2 as Extract<VfsRpcReply, { ok: true }>).data as VfsPatchReplyData;
    expect(pd2.rebased).toBe(true);

    // Conflicting patch targeting already-edited 'café ☕' from stale d1.rev -> 409 VFS_CONFLICT!
    const pConflict = await rt.handleRpcRequest(
      {
        type: 'vfs-mutation',
        id: randomUUID().toLowerCase(),
        op: 'vfs-patch',
        nodeIdOrPath: 'docs/plano.md',
        baseRev: d1.rev,
        hunks: [{ op: 'replace', old: 'café ☕', new: 'água 💧' }],
      },
      ctx,
    );
    expect(pConflict.ok).toBe(false);
    if (!pConflict.ok) {
      expect(pConflict.status).toBe(409);
      expect(pConflict.code).toBe('VFS_CONFLICT');
      expect(pConflict.details?.baseRev).toBe(d1.rev);
      expect(pConflict.details?.currentRev).toBe(pd2.rev);
      expect(Array.isArray(pConflict.details?.conflicts)).toBe(true);
    }

    // Stale baseRev on vfs-write also returns 409 VFS_CONFLICT.
    const writeConflict = await rt.handleRpcRequest(
      {
        type: 'vfs-mutation',
        id: randomUUID().toLowerCase(),
        op: 'vfs-write',
        nodeIdOrPath: 'docs/plano.md',
        baseRev: d1.rev,
        content: 'overwrite blindly',
      },
      ctx,
    );
    expect(writeConflict.ok).toBe(false);
    if (!writeConflict.ok) {
      expect(writeConflict.status).toBe(409);
      expect(writeConflict.code).toBe('VFS_CONFLICT');
    }

    // 5. History & Diff (`--to` defaults to `head`).
    const histReply = await rt.handleRpcRequest(
      { type: 'vfs-query', id: randomUUID().toLowerCase(), op: 'vfs-history', nodeIdOrPath: 'docs/plano.md', limit: 10 },
      ctx,
    );
    expect(histReply.ok).toBe(true);
    const hist = (histReply as Extract<VfsRpcReply, { ok: true }>).data as VfsHistoryReplyData;
    expect(hist.entries.length).toBe(3);

    const diffReply = await rt.handleRpcRequest(
      {
        type: 'vfs-query',
        id: randomUUID().toLowerCase(),
        op: 'vfs-diff',
        nodeIdOrPath: 'docs/plano.md',
        fromRev: d1.commitId,
      },
      ctx,
    );
    expect(diffReply.ok).toBe(true);
    const diff = (diffReply as Extract<VfsRpcReply, { ok: true }>).data as VfsDiffReplyData;
    expect(diff.identical).toBe(false);
    expect(diff.unified).toContain('-Linha 1: café ☕');
    expect(diff.unified).toContain('+Linha 1: chá 🍵');

    // 6. Revert back to commit 1 and verify restored content.
    const revReply = await rt.handleRpcRequest(
      {
        type: 'vfs-mutation',
        id: randomUUID().toLowerCase(),
        op: 'vfs-revert',
        nodeIdOrPath: 'docs/plano.md',
        targetCommitId: d1.commitId,
        message: 'back to v1',
      },
      ctx,
    );
    expect(revReply.ok).toBe(true);
    const revData = (revReply as Extract<VfsRpcReply, { ok: true }>).data as VfsRevertReplyData;
    expect(revData.targetCommitId).toBe(d1.commitId);

    const afterRevert = await rt.handleRpcRequest(
      { type: 'vfs-query', id: randomUUID().toLowerCase(), op: 'vfs-read', nodeIdOrPath: 'docs/plano.md' },
      ctx,
    );
    expect(afterRevert.ok).toBe(true);
    if (afterRevert.ok) {
      expect((afterRevert.data as VfsReadReplyData).text).toBe(v1Text);
    }

    // 7. Passive vfs-changes cursor advances monotonically.
    const changes1 = (
      await rt.handleRpcRequest(
        { type: 'vfs-query', id: randomUUID().toLowerCase(), op: 'vfs-changes', afterCursor: 0 },
        ctx,
      )
    ) as Extract<VfsRpcReply, { ok: true }>;
    const c1 = changes1.data as VfsChangesReplyData;
    expect(c1.events.length).toBeGreaterThanOrEqual(4);
    expect(c1.cursor).toBe(c1.events[c1.events.length - 1]!.cursor);

    const changes2 = (
      await rt.handleRpcRequest(
        { type: 'vfs-query', id: randomUUID().toLowerCase(), op: 'vfs-changes', afterCursor: c1.cursor },
        ctx,
      )
    ) as Extract<VfsRpcReply, { ok: true }>;
    expect((changes2.data as VfsChangesReplyData).events).toEqual([]);
  });

  test('enforces Decision 4 soft-delete & restore permissions via vfs-delete', async () => {
    const roomId = randomUUID().toLowerCase();
    const human = await createTestActor('human');
    const agentActor = await createTestActor('agent');

    const rt = await openBridgeVfsRuntime({
      roomId,
      selfMemberId: human.memberId,
      selfDeviceId: human.deviceId,
      selfRole: 'human',
      selfEncPrivateKey: human.encPrivateKey,
      sign: human.sign,
      isHost: true,
      useMemoryOnly: true,
    });
    openRuntimes.push(rt);
    const roster = await buildSignedRoster(roomId, human, [human, agentActor]);
    await rt.engine.bootstrapEpoch1(roster);

    const humanCtx = makeRpcCtx({ actorMemberId: human.memberId, actorRole: 'human' }).ctx;
    const agentCtx = makeRpcCtx({ actorMemberId: agentActor.memberId, actorRole: 'agent' }).ctx;

    // Human creates shared doc; agent creates own draft.
    const humanDoc = await rt.handleRpcRequest(
      { type: 'vfs-mutation', id: randomUUID().toLowerCase(), op: 'vfs-write', nodeIdOrPath: 'shared.md', content: 'human owned' },
      humanCtx,
    );
    const agentDoc = await rt.handleRpcRequest(
      { type: 'vfs-mutation', id: randomUUID().toLowerCase(), op: 'vfs-write', nodeIdOrPath: 'agent-draft.md', content: 'agent owned' },
      agentCtx,
    );
    expect(humanDoc.ok).toBe(true);
    expect(agentDoc.ok).toBe(true);

    // Agent CANNOT delete human's doc -> 403 VFS_UNAUTHORIZED.
    const agentDelHuman = await rt.handleRpcRequest(
      { type: 'vfs-mutation', id: randomUUID().toLowerCase(), op: 'vfs-delete', nodeIdOrPath: 'shared.md' },
      agentCtx,
    );
    expect(agentDelHuman.ok).toBe(false);
    if (!agentDelHuman.ok) {
      expect(agentDelHuman.status).toBe(403);
      expect(agentDelHuman.code).toBe('VFS_UNAUTHORIZED');
    }

    // Agent CAN soft-delete its own draft.
    const agentDelOwn = await rt.handleRpcRequest(
      { type: 'vfs-mutation', id: randomUUID().toLowerCase(), op: 'vfs-delete', nodeIdOrPath: 'agent-draft.md' },
      agentCtx,
    );
    expect(agentDelOwn.ok).toBe(true);
    if (agentDelOwn.ok) {
      expect((agentDelOwn.data as VfsDeleteReplyData).deleted).toBe(true);
    }

    // Agent CANNOT restore soft-deleted docs (Decision 4: humans only) -> 403 VFS_UNAUTHORIZED.
    const agentRestore = await rt.handleRpcRequest(
      { type: 'vfs-mutation', id: randomUUID().toLowerCase(), op: 'vfs-delete', nodeIdOrPath: 'agent-draft.md', restore: true },
      agentCtx,
    );
    expect(agentRestore.ok).toBe(false);
    if (!agentRestore.ok) {
      expect(agentRestore.status).toBe(403);
      expect(agentRestore.code).toBe('VFS_UNAUTHORIZED');
    }

    // Human CAN restore the soft-deleted draft!
    const humanRestore = await rt.handleRpcRequest(
      { type: 'vfs-mutation', id: randomUUID().toLowerCase(), op: 'vfs-delete', nodeIdOrPath: 'agent-draft.md', restore: true },
      humanCtx,
    );
    expect(humanRestore.ok).toBe(true);
    if (humanRestore.ok) {
      expect((humanRestore.data as VfsDeleteReplyData).deleted).toBe(false);
    }
  });

  test('end-to-end file-mailbox roundtrip leaves zero plaintext files in live/vfs-reply/', async () => {
    const roomId = randomUUID().toLowerCase();
    const roomDir = makeTempDir();
    const actor = await createTestActor('human');

    const rt = await openBridgeVfsRuntime({
      roomDir,
      roomId,
      selfMemberId: actor.memberId,
      selfDeviceId: actor.deviceId,
      selfRole: 'human',
      selfEncPrivateKey: actor.encPrivateJwk,
      sign: actor.sign,
      isHost: true,
    });
    openRuntimes.push(rt);
    const roster = await buildSignedRoster(roomId, actor, [actor]);
    await rt.engine.bootstrapEpoch1(roster);
    const { ctx } = makeRpcCtx();

    // 1. CLI queues a mutation into outbox/.
    const mut = writeVfsRpcMutation(roomDir, {
      id: randomUUID().toLowerCase(),
      op: 'vfs-write',
      nodeIdOrPath: 'secret-notes.md',
      content: 'CONFIDENTIAL-VFS-CONTENT-12345',
    });

    // Simulate runner processing outbox asynchronously while CLI awaits reply.
    const runnerTurn = (async () => {
      await Bun.sleep(15);
      const raw = JSON.parse(fs.readFileSync(mut.filePath, 'utf8'));
      const reply = await rt.handleRpcRequest(raw, ctx);
      writeVfsRpcReply(roomDir, mut.id, reply);
      fs.unlinkSync(mut.filePath);
    })();

    const mutReply = await awaitVfsRpcReply<VfsWriteReplyData>(roomDir, mut.id, { timeoutMs: 2_000, pollMs: 10 });
    await runnerTurn;
    expect(mutReply.ok).toBe(true);

    // 2. CLI queues a read query into outbox/q-<id>.json.
    const query = writeVfsRpcQuery(roomDir, { op: 'vfs-read', nodeIdOrPath: 'secret-notes.md' });
    const runnerRead = (async () => {
      await Bun.sleep(15);
      const raw = JSON.parse(fs.readFileSync(query.filePath, 'utf8'));
      const reply = await rt.handleRpcRequest(raw, ctx);
      writeVfsRpcReply(roomDir, query.id, reply);
      fs.unlinkSync(query.filePath);
    })();

    const readReply = await awaitVfsRpcReply<VfsReadReplyData>(roomDir, query.id, { timeoutMs: 2_000, pollMs: 10 });
    await runnerRead;
    expect(readReply.ok).toBe(true);
    if (readReply.ok) {
      expect(readReply.data.text).toBe('CONFIDENTIAL-VFS-CONTENT-12345');
    }

    // Verify ZERO plaintext files remain in live/vfs-reply/ or outbox/ AND plaintext never appears in <roomDir>/vfs/.
    expect(fs.readdirSync(path.join(roomDir, 'live', 'vfs-reply'))).toEqual([]);
    expect(fs.readdirSync(path.join(roomDir, 'outbox'))).toEqual([]);

    const walkFiles = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walkFiles(full));
        else if (entry.isFile()) out.push(full);
      }
      return out;
    };
    const vfsFiles = walkFiles(path.join(roomDir, 'vfs'));
    expect(vfsFiles.length).toBeGreaterThan(0);
    for (const file of vfsFiles) {
      const raw = fs.readFileSync(file);
      expect(raw.includes(Buffer.from('CONFIDENTIAL-VFS-CONTENT-12345'))).toBe(false);
      expect(raw.includes(Buffer.from('secret-notes.md'))).toBe(false);
    }
  });
});
