import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RTCPeerConnection } from 'werift';
import { BrowserLobby } from './lobby';
import { browserHandler } from './http';
import { RELAY_STATE_MAX_BODY_BYTES, RelayService, type RelaySocketData } from './relay';
import { WakeConnector } from './wake-connector';
import {
  BrowserAgent,
  listenRemembering,
  outboxProblem,
  peekWork,
  runBridge,
  sendBrowser,
  vfsRpcCall,
} from '../browser-agent';
import { agentCli, formatCliError } from '../agent-cli';
import type {
  VfsDeleteReplyData,
  VfsDiffReplyData,
  VfsHistoryReplyData,
  VfsListReplyData,
  VfsPatchReplyData,
  VfsReadReplyData,
  VfsRevertReplyData,
  VfsWriteReplyData,
} from '../vfs-rpc';

const tempDirs: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

function makeTempDir(prefix = 'mr-bridge-vfs-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    try { await fn(); } catch { /* Best effort cleanup. */ }
  }
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Best effort cleanup. */ }
  }
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 12_000, stepMs = 30, debug?: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(stepMs);
  }
  const extra = debug ? `\n${debug()}` : '';
  throw new Error(`waitFor timed out after ${timeoutMs} ms${extra}`);
}

/**
 * Minimal non-connecting RTCPeerConnection stub so `runBridge` exercises the real loopback
 * E2E WSS relay (`RelayClient` <-> `RelayService`) deterministically without spawning ICE sockets.
 */
function makeRelayOnlyStubPc(): RTCPeerConnection {
  const stubChannel = () => ({
    readyState: 'connecting',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    bufferedAmountLow: { subscribe() {} },
    stateChanged: { subscribe() {} },
    onMessage: { subscribe() {} },
    send() {},
    close() {},
  });
  return {
    connectionState: 'connecting',
    iceConnectionState: 'checking',
    signalingState: 'stable',
    localDescription: undefined,
    remoteDescription: undefined,
    onDataChannel: { subscribe() {} },
    connectionStateChange: { subscribe() {} },
    iceConnectionStateChange: { subscribe() {} },
    onIceCandidate: { subscribe() { return { unSubscribe() {} }; } },
    createDataChannel: stubChannel,
    createOffer: async () => ({ type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=ice-ufrag:stub\r\n' }),
    createAnswer: async () => ({ type: 'answer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=ice-ufrag:stub\r\n' }),
    setLocalDescription: async () => {},
    setRemoteDescription: async () => {},
    setConfiguration: () => {},
    close: async () => {},
  } as unknown as RTCPeerConnection;
}

function startLoopbackStack() {
  const dir = makeTempDir('mr-vfs-stack-');
  const lobbyDbPath = join(dir, 'lobby.sqlite');
  const relayDbPath = join(dir, 'relay.sqlite');
  const logs: string[] = [];

  let handler!: ReturnType<typeof browserHandler>;
  let relay!: RelayService;
  const server = Bun.serve<RelaySocketData>({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: RELAY_STATE_MAX_BODY_BYTES,
    fetch(request, srv) {
      return handler(
        request,
        srv.requestIP(request)?.address || '127.0.0.1',
        (req, data) => srv.upgrade(req, { data }),
      );
    },
    websocket: {
      open(ws) { relay.websocket.open?.(ws); },
      message(ws, message) { relay.websocket.message?.(ws, message); },
      close(ws, code, reason) { relay.websocket.close?.(ws, code, reason); },
      drain(ws) { relay.websocket.drain?.(ws); },
    },
  });

  const origin = `http://127.0.0.1:${server.port}`;
  const relayUrl = `ws://127.0.0.1:${server.port}/api/relay/v1`;
  const lobby = new BrowserLobby(lobbyDbPath, {
    origin,
    relayUrl,
    invites: 'off',
    maxRooms: 32,
  });
  const wakeConnector = new WakeConnector({
    dbPath: relayDbPath,
    secret: 'vfs-e2e-test-relay-secret-32-bytes-min!!',
    allowLoopbackHttp: true,
    retryDelayMs: 50,
    log: line => logs.push(line),
  });
  relay = new RelayService({
    lobby,
    wakeConnector,
    dbPath: relayDbPath,
    log: line => logs.push(line),
  });
  handler = browserHandler(lobby, origin, dir, {
    apiLimit: 2000,
    relay,
  });

  const stop = () => {
    try { server.stop(true); } catch { /* ignore */ }
    try { relay.close(); } catch { /* ignore */ }
    try { wakeConnector.close(); } catch { /* ignore */ }
    try { lobby.close(); } catch { /* ignore */ }
  };
  cleanups.push(stop);

  return { origin, relayUrl, lobby, relay, relayDbPath, logs, stop };
}

/** Runs `agentCli` inside a confined wake environment scoped to `agentHome`, `roomId`, and `wakeDir`. */
async function runWakeCli<T = unknown>(
  argv: string[],
  env: { agentHome: string; roomId: string; wakeDir: string },
): Promise<T> {
  const prevHome = process.env.MESHROOMS_AGENT_HOME;
  const prevRoom = process.env.MESHROOMS_WAKE_ROOM;
  const prevDir = process.env.MESHROOMS_WAKE_DIR;
  process.env.MESHROOMS_AGENT_HOME = env.agentHome;
  process.env.MESHROOMS_WAKE_ROOM = env.roomId;
  process.env.MESHROOMS_WAKE_DIR = env.wakeDir;
  try {
    return (await agentCli(argv)) as T;
  } finally {
    if (prevHome === undefined) delete process.env.MESHROOMS_AGENT_HOME;
    else process.env.MESHROOMS_AGENT_HOME = prevHome;
    if (prevRoom === undefined) delete process.env.MESHROOMS_WAKE_ROOM;
    else process.env.MESHROOMS_WAKE_ROOM = prevRoom;
    if (prevDir === undefined) delete process.env.MESHROOMS_WAKE_DIR;
    else process.env.MESHROOMS_WAKE_DIR = prevDir;
  }
}

describe('Bridge Room VFS E2E (runners + CLI + floor + non-waking listen)', () => {
  test('Host and Agent runners sync docs, enforce floor & Decision 4, rebase/conflict patch, diff/history/revert, and keep listen non-waking', async () => {
    const stack = startLoopbackStack();
    const roomId = crypto.randomUUID();

    // 1. Provision Host (person) and Agent homes.
    const hostHome = makeTempDir('mr-host-');
    const hostIdFile = join(hostHome, 'person-identity.json');
    const hostAgent = new BrowserAgent(hostHome, stack.origin, roomId, { person: { identityFile: hostIdFile } });
    const hostId = await hostAgent.ensureIdentity();
    const hostEnc = await hostAgent.encBinding();

    await hostAgent.command('create', { title: 'VFS E2E Room', name: 'Alice', label: 'Host', ...hostEnc });
    writeFileSync(join(hostAgent.dir, 'room.json'), JSON.stringify({ origin: stack.origin, roomId, hostPin: hostId.id.slice(0, 16) }), { mode: 0o600 });

    const invite = await hostAgent.command('agent-invite', { name: 'Bot', label: 'Bot Bridge' });
    const botHome = makeTempDir('mr-bot-');
    const botAgent = new BrowserAgent(botHome, stack.origin, roomId, { hostPin: hostId.id.slice(0, 16) });
    await botAgent.ensureIdentity();
    const botEnc = await botAgent.encBinding();
    await botAgent.command('agent-redeem', { token: invite.token, label: 'Bot Bridge', ...botEnc });
    writeFileSync(join(botAgent.dir, 'room.json'), JSON.stringify({ origin: stack.origin, roomId, hostPin: hostId.id.slice(0, 16) }), { mode: 0o600 });
    const botWakeDir = join(botAgent.dir, 'wake');
    mkdirSync(botWakeDir, { recursive: true, mode: 0o700 });

    // 2. Start BOTH real `runBridge` loops over the real loopback coordinator + WSS relay.
    const abort = new AbortController();
    const bridgeLogs: string[] = [];
    const hostLoop = runBridge(hostAgent, line => bridgeLogs.push(`[host] ${line}`), {
      vfsEnabled: true,
      signal: abort.signal,
      pause: () => Bun.sleep(40),
      gatherMs: 0,
      gatherDeadlineMs: 100,
      createPeerConnection: () => makeRelayOnlyStubPc(),
    });
    const botLoop = runBridge(botAgent, line => bridgeLogs.push(`[bot] ${line}`), {
      vfsEnabled: true,
      signal: abort.signal,
      pause: () => Bun.sleep(40),
      gatherMs: 0,
      gatherDeadlineMs: 100,
      createPeerConnection: () => makeRelayOnlyStubPc(),
    });
    cleanups.push(async () => {
      abort.abort();
      await Promise.allSettled([hostLoop, botLoop]);
    });

    // Wait for Host to bootstrap Epoch 1 and grant Epoch 1 to Bot over the live relay.
    await waitFor(async () => {
      try {
        const list = await vfsRpcCall<VfsListReplyData>(hostAgent, { op: 'vfs-list' }, { timeoutMs: 2_000 });
        return list.activeEpoch >= 1;
      } catch {
        return false;
      }
    });
    await waitFor(async () => {
      try {
        const list = await runWakeCli<VfsListReplyData>(['vfs-list', '--room', roomId], {
          agentHome: botHome,
          roomId,
          wakeDir: botWakeDir,
        });
        return list.activeEpoch >= 1;
      } catch {
        return false;
      }
    });

    // 3. Host creates `design.md` via RPC; verify E2E replication to Bot's CLI (`vfs-list` + `vfs-read`).
    const initialText = [
      '# Architecture',
      'Section A: original alpha',
      'Section B: original beta',
      'Section C: original gamma',
    ].join('\n') + '\n';

    const created = await vfsRpcCall<VfsWriteReplyData>(hostAgent, {
      op: 'vfs-write',
      id: crypto.randomUUID(),
      nodeIdOrPath: 'design.md',
      targetKind: 'path',
      content: initialText,
      message: 'Initial design doc',
    });
    expect(created.created).toBe(true);
    expect(created.path).toBe('design.md');

    await waitFor(async () => {
      const list = await runWakeCli<VfsListReplyData>(['vfs-list', '--room', roomId], {
        agentHome: botHome,
        roomId,
        wakeDir: botWakeDir,
      });
      return list.docs.some(d => d.path === 'design.md');
    });

    const botRead1 = await runWakeCli<VfsReadReplyData>(['vfs-read', '--room', roomId, '--path', 'design.md'], {
      agentHome: botHome,
      roomId,
      wakeDir: botWakeDir,
    });
    expect(botRead1.text).toBe(initialText);
    expect(botRead1.nodeId).toBe(created.nodeId);

    // Verify `--offset` / `--limit` pagination through `agentCli`.
    const botSlice = await runWakeCli<VfsReadReplyData>(
      ['vfs-read', '--room', roomId, '--node-id', created.nodeId, '--offset', '0', '--limit', '14'],
      { agentHome: botHome, roomId, wakeDir: botWakeDir },
    );
    expect(botSlice.text).toBe('# Architecture');
    expect(botSlice.truncated).toBe(true);
    expect(botSlice.nextOffset).toBe(14);

    // 4. Floor gating in `humans-first`: unaddressed Agent CANNOT `vfs-write` or `vfs-patch` (`403 VFS_FLOOR_BLOCKED`).
    const botMemberId = botAgent.members().memberId!;
    expect(outboxProblem(botAgent, botMemberId, {
      type: 'vfs-mutation',
      id: crypto.randomUUID(),
      op: 'vfs-write',
      nodeIdOrPath: 'uninvited.md',
      content: 'should be blocked',
    })).toBe('nothing in this room addressed the agent');

    let floorBlockedWrite: (Error & { code?: string; status?: number }) | undefined;
    try {
      await runWakeCli(['vfs-write', '--room', roomId, '--request-id', crypto.randomUUID(), '--path', 'uninvited.md', '--text', 'nope'], {
        agentHome: botHome,
        roomId,
        wakeDir: botWakeDir,
      });
    } catch (err) {
      floorBlockedWrite = err as Error & { code?: string; status?: number };
    }
    expect(floorBlockedWrite?.code).toBe('VFS_FLOOR_BLOCKED');
    expect(floorBlockedWrite?.status).toBe(403);

    let floorBlockedPatch: (Error & { code?: string; status?: number }) | undefined;
    try {
      await runWakeCli([
        'vfs-patch', '--room', roomId, '--request-id', crypto.randomUUID(),
        '--path', 'design.md', '--base-rev', botRead1.rev,
        '--patch', JSON.stringify([{ op: 'replace', old: 'original beta', new: 'sneaky beta' }]),
      ], { agentHome: botHome, roomId, wakeDir: botWakeDir });
    } catch (err) {
      floorBlockedPatch = err as Error & { code?: string; status?: number };
    }
    expect(floorBlockedPatch?.code).toBe('VFS_FLOOR_BLOCKED');
    expect(floorBlockedPatch?.status).toBe(403);

    // 5. HARD NON-WAKING INVARIANT: establish Bot's listen cursor past a non-addressing chat message,
    //    then Host edits `design.md` with `@Bot` in prose!
    const introMsgId = crypto.randomUUID();
    await sendBrowser(hostAgent, 'Room opened for collaborative docs.', undefined, introMsgId);
    await waitFor(() => botAgent.messages().some(m => m.packet.body.id === introMsgId));

    const firstListen = await listenRemembering(botAgent, 1) as { state: string; vfsCursor?: number; vfsChanges?: unknown[] };
    expect(firstListen.state).toBe('history');

    // Host patches Section A and writes `@Bot wake up!` inside the document body.
    const hostPatch = await vfsRpcCall<VfsPatchReplyData>(hostAgent, {
      op: 'vfs-patch',
      id: crypto.randomUUID(),
      nodeIdOrPath: 'design.md',
      targetKind: 'path',
      baseRev: created.rev,
      hunks: [{ op: 'replace', old: 'Section A: original alpha', new: 'Section A: host updated (@Bot)' }],
      message: 'Host updated Section A',
    });
    expect(hostPatch.rev).not.toBe(created.rev);

    await waitFor(async () => {
      const r = await runWakeCli<VfsReadReplyData>(['vfs-read', '--room', roomId, '--path', 'design.md'], {
        agentHome: botHome,
        roomId,
        wakeDir: botWakeDir,
      });
      return r.text.includes('Section A: host updated (@Bot)');
    }, 12_000, 30, () => `bridgeLogs:\n${bridgeLogs.join('\n')}\nstackLogs:\n${stack.logs.join('\n')}`);

    // VFS edits (even mentioning `@Bot` in doc prose!) MUST NOT wake `peekWork` or `listen`!
    expect(peekWork(botAgent).work).toBe(false);
    const quietListen = await listenRemembering(botAgent, 1) as { state: string; vfsChanges?: unknown[] };
    expect(quietListen.state).toBe('timeout');
    expect(quietListen.vfsChanges).toBeUndefined();

    // 6. Now Host addresses `@Bot` in chat -> `listen` wakes AND attaches passive `vfsChanges` + `vfsCursor`!
    const msgId = crypto.randomUUID();
    const sent = await sendBrowser(hostAgent, '@Bot please update Section B in design.md', undefined, msgId);
    expect(sent.messageId).toBe(msgId);

    await waitFor(() => botAgent.messages().some(m => m.packet.body.id === msgId));
    const woke = await listenRemembering(botAgent, 2) as {
      state: string;
      addressed: string[];
      vfsCursor?: number;
      vfsChanges?: Array<{ kind: string; path?: string }>;
    };
    expect(woke.state).toBe('addressed');
    expect(woke.addressed).toContain(msgId);
    expect(woke.vfsCursor).toBeGreaterThan(0);
    expect(woke.vfsChanges?.some(c => c.kind === 'doc-updated' && c.path === 'design.md')).toBe(true);

    // Zero leftover ephemeral reply files in `live/vfs-reply/`!
    const botReplyDir = join(botAgent.dir, 'live', 'vfs-reply');
    expect(existsSync(botReplyDir) ? readdirSync(botReplyDir) : []).toEqual([]);

    // 7. Concurrent-safe `vfs-patch` via `agentCli`:
    //    (a) Disjoint auto-rebase: Bot patches Section B using the OLD `botRead1.rev` (from BEFORE Host edited Section A)!
    const patchFile = join(botWakeDir, 'section-b.json');
    writeFileSync(patchFile, JSON.stringify([{ op: 'replace', old: 'Section B: original beta', new: 'Section B: agent rebased beta' }]), { mode: 0o600 });

    const rebased = await runWakeCli<VfsPatchReplyData>([
      'vfs-patch', '--room', roomId, '--request-id', crypto.randomUUID(),
      '--path', 'design.md', '--base-rev', botRead1.rev,
      '--patch-file', patchFile, '--message', 'Agent updated Section B', '--reply-to', msgId,
    ], { agentHome: botHome, roomId, wakeDir: botWakeDir });
    expect(rebased.rebased).toBe(true);

    // Wait for Host to receive Bot's rebased patch and verify BOTH edits converged cleanly!
    await waitFor(async () => {
      const r = await vfsRpcCall<VfsReadReplyData>(hostAgent, { op: 'vfs-read', nodeIdOrPath: 'design.md', targetKind: 'path' });
      return r.text.includes('Section B: agent rebased beta');
    });
    const hostAfterRebase = await vfsRpcCall<VfsReadReplyData>(hostAgent, { op: 'vfs-read', nodeIdOrPath: 'design.md', targetKind: 'path' });
    expect(hostAfterRebase.text).toContain('Section A: host updated (@Bot)');
    expect(hostAfterRebase.text).toContain('Section B: agent rebased beta');

    //    (b) Mid-span conflict: Host edits INSIDE Section C -> Bot's stale patch on old Section C fails `409 VFS_CONFLICT`!
    const staleRevBeforeC = rebased.rev;
    await vfsRpcCall<VfsPatchReplyData>(hostAgent, {
      op: 'vfs-patch',
      id: crypto.randomUUID(),
      nodeIdOrPath: 'design.md',
      targetKind: 'path',
      baseRev: hostAfterRebase.rev,
      hunks: [{ op: 'replace', old: 'original gamma', new: 'original HOST-MID gamma' }],
      message: 'Host edited mid-span in Section C',
    });
    await waitFor(async () => {
      const r = await runWakeCli<VfsReadReplyData>(['vfs-read', '--room', roomId, '--path', 'design.md'], {
        agentHome: botHome,
        roomId,
        wakeDir: botWakeDir,
      });
      return r.text.includes('HOST-MID');
    });

    let conflictErr: (Error & { code?: string; status?: number; details?: Record<string, unknown> }) | undefined;
    try {
      await runWakeCli([
        'vfs-patch', '--room', roomId, '--request-id', crypto.randomUUID(),
        '--path', 'design.md', '--base-rev', staleRevBeforeC,
        '--patch', JSON.stringify([{ op: 'replace', old: 'Section C: original gamma', new: 'Section C: stale agent gamma' }]),
        '--reply-to', msgId,
      ], { agentHome: botHome, roomId, wakeDir: botWakeDir });
    } catch (err) {
      conflictErr = err as Error & { code?: string; status?: number; details?: Record<string, unknown> };
    }
    expect(conflictErr?.code).toBe('VFS_CONFLICT');
    expect(conflictErr?.status).toBe(409);
    expect(conflictErr?.details?.baseRev).toBe(staleRevBeforeC);
    // Verify `formatCliError` preserves structured `details` JSON for callers!
    const formatted = JSON.parse(formatCliError(conflictErr));
    expect(formatted.code).toBe('VFS_CONFLICT');
    expect(formatted.status).toBe(409);
    expect(formatted.details?.baseRev).toBe(staleRevBeforeC);

    // 8. `vfs-history`, `vfs-diff` (default `--to head`), and `vfs-revert` via `agentCli`.
    const hist = await runWakeCli<VfsHistoryReplyData>(['vfs-history', '--room', roomId, '--path', 'design.md'], {
      agentHome: botHome,
      roomId,
      wakeDir: botWakeDir,
    });
    expect(hist.entries.length).toBeGreaterThanOrEqual(4);

    const diff = await runWakeCli<VfsDiffReplyData>(
      ['vfs-diff', '--room', roomId, '--path', 'design.md', '--from', created.commitId],
      { agentHome: botHome, roomId, wakeDir: botWakeDir },
    );
    expect(diff.identical).toBe(false);
    expect(diff.unified).toContain('-Section A: original alpha');
    expect(diff.unified).toContain('+Section A: host updated (@Bot)');

    const reverted = await runWakeCli<VfsRevertReplyData>([
      'vfs-revert', '--room', roomId, '--request-id', crypto.randomUUID(),
      '--path', 'design.md', '--commit', created.commitId,
      '--message', 'Revert to initial architecture', '--reply-to', msgId,
    ], { agentHome: botHome, roomId, wakeDir: botWakeDir });
    expect(reverted.targetCommitId).toBe(created.commitId);

    await waitFor(async () => {
      const r = await vfsRpcCall<VfsReadReplyData>(hostAgent, { op: 'vfs-read', nodeIdOrPath: 'design.md', targetKind: 'path' });
      return r.text === initialText;
    });

    // 9. Decision 4 permissions (`vfs-delete` & `--restore`):
    //    (a) Agent CANNOT delete Host's document (`403 VFS_UNAUTHORIZED`).
    let unauthDel: (Error & { code?: string; status?: number }) | undefined;
    try {
      await runWakeCli([
        'vfs-delete', '--room', roomId, '--request-id', crypto.randomUUID(),
        '--path', 'design.md', '--reply-to', msgId,
      ], { agentHome: botHome, roomId, wakeDir: botWakeDir });
    } catch (err) {
      unauthDel = err as Error & { code?: string; status?: number };
    }
    expect(unauthDel?.code).toBe('VFS_UNAUTHORIZED');
    expect(unauthDel?.status).toBe(403);

    //    (b) Agent CAN create & soft-delete its OWN draft, but CANNOT `--restore` (humans only!).
    const draft = await runWakeCli<VfsWriteReplyData>([
      'vfs-write', '--room', roomId, '--request-id', crypto.randomUUID(),
      '--path', 'bot-draft.md', '--text', 'temporary scratch notes', '--reply-to', msgId,
    ], { agentHome: botHome, roomId, wakeDir: botWakeDir });
    expect(draft.created).toBe(true);

    const deletedDraft = await runWakeCli<VfsDeleteReplyData>([
      'vfs-delete', '--room', roomId, '--request-id', crypto.randomUUID(),
      '--path', 'bot-draft.md', '--reply-to', msgId,
    ], { agentHome: botHome, roomId, wakeDir: botWakeDir });
    expect(deletedDraft.deleted).toBe(true);

    let unauthRestore: (Error & { code?: string; status?: number }) | undefined;
    try {
      await runWakeCli([
        'vfs-delete', '--room', roomId, '--request-id', crypto.randomUUID(),
        '--path', 'bot-draft.md', '--restore', '--reply-to', msgId,
      ], { agentHome: botHome, roomId, wakeDir: botWakeDir });
    } catch (err) {
      unauthRestore = err as Error & { code?: string; status?: number };
    }
    expect(unauthRestore?.code).toBe('VFS_UNAUTHORIZED');
    expect(unauthRestore?.status).toBe(403);

    //    (c) Host CAN restore Agent's soft-deleted draft, and restoration replicates back to Agent!
    await waitFor(async () => {
      const list = await vfsRpcCall<VfsListReplyData>(hostAgent, { op: 'vfs-list', includeDeleted: true });
      return list.docs.some(d => d.path === 'bot-draft.md' && d.deleted);
    });
    const restored = await vfsRpcCall<VfsDeleteReplyData>(hostAgent, {
      op: 'vfs-delete',
      id: crypto.randomUUID(),
      nodeIdOrPath: 'bot-draft.md',
      targetKind: 'path',
      restore: true,
    });
    expect(restored.deleted).toBe(false);
    await waitFor(async () => {
      const list = await runWakeCli<VfsListReplyData>(['vfs-list', '--room', roomId], {
        agentHome: botHome,
        roomId,
        wakeDir: botWakeDir,
      });
      return list.docs.some(d => d.path === 'bot-draft.md' && !d.deleted);
    });

    // 10. Zero plaintext resting in `live/vfs-reply/` on BOTH Host and Agent, and zero VFS plaintext in relay DB!
    const hostReplyDir = join(hostAgent.dir, 'live', 'vfs-reply');
    expect(existsSync(hostReplyDir) ? readdirSync(hostReplyDir) : []).toEqual([]);
    expect(existsSync(botReplyDir) ? readdirSync(botReplyDir) : []).toEqual([]);

    const relayRaw = readFileSync(stack.relayDbPath, 'utf8');
    expect(relayRaw).not.toContain('Section A: host updated');
    expect(relayRaw).not.toContain('temporary scratch notes');
    expect(relayRaw).not.toContain('design.md');
  }, 20_000);

  test('inside a confined wake with a stopped runner, vfs-* CLI commands fail closed with runner-stopped and never touch <roomDir>/vfs', async () => {
    const roomId = crypto.randomUUID();
    const botHome = makeTempDir('mr-stopped-bot-');
    const botAgent = new BrowserAgent(botHome, 'http://127.0.0.1:1', roomId);
    writeFileSync(join(botAgent.dir, 'room.json'), JSON.stringify({ origin: 'http://127.0.0.1:1', roomId }), { mode: 0o600 });
    const wakeDir = join(botAgent.dir, 'wake');
    mkdirSync(wakeDir, { recursive: true, mode: 0o700 });

    const startedAt = Date.now();
    let caught: (Error & { code?: string; status?: number }) | undefined;
    try {
      await runWakeCli(['vfs-list', '--room', roomId], { agentHome: botHome, roomId, wakeDir });
    } catch (err) {
      caught = err as Error & { code?: string; status?: number };
    }
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(caught?.code).toBe('runner-stopped');
    expect(caught?.status).toBe(503);
    // Must NEVER open or create `<roomDir>/vfs` or `identity.json` directly from CLI!
    expect(existsSync(join(botAgent.dir, 'vfs'))).toBe(false);
    expect(existsSync(join(botAgent.dir, 'identity.json'))).toBe(false);
  });
});
