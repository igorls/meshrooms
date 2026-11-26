import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFakeIndexedDB, fakeStorage } from '../../src/browser/test-indexeddb';
import { BrowserPeers } from '../../src/browser/peers';
import { Resync } from '../../src/browser/pacer';
import { claimFence, identity as browserIdentity } from '../../src/browser/storage';
import {
  decryptRelayEnvelope,
  encryptRelayEnvelope,
  hashRosterBody,
  signRoster,
  verifyRoster,
  type RelayEnvelope,
  type RosterBody,
  type SignedRoster,
} from '../../src/browser/relay-crypto';
import { RelayClient } from '../../src/browser/relay-client';
import { RelayReplayGuard } from '../../src/browser/relay-replay';
import type { RoomStatus } from '../../src/browser/protocol';
import { BrowserLobby } from './lobby';
import { browserHandler } from './http';
import { RELAY_STATE_MAX_BODY_BYTES, RelayService, type RelaySocketData } from './relay';
import { WakeConnector } from './wake-connector';
import {
  BrowserAgent,
  ROSTER_FRESHNESS_MS,
  ROSTER_MAX_FUTURE_SKEW_MS,
  ROSTER_REFRESH_MS,
  buildNextHostRoster,
  computeRelayWakeMeta,
  relayListenOnce,
  relaySendOnce,
  relayWakeRegister,
} from '../browser-agent';
import { agentCli } from '../agent-cli';

const tempDirs: string[] = [];
const cleanups: (() => void | Promise<void>)[] = [];

function makeTempDir(prefix = 'mr-relay-e2e-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    try { await fn(); } catch { /* ignore */ }
  }
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 8_000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(stepMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

type TestStack = {
  origin: string;
  relayUrl: string;
  lobby: BrowserLobby;
  relay: RelayService;
  wakeConnector: WakeConnector;
  relayDbPath: string;
  logs: string[];
  setBlockWsUpgrade: (block: boolean) => void;
  stop: () => void;
};

function startTestStack(options: { blockWsUpgrade?: boolean; relayDisabled?: boolean } = {}): TestStack {
  const dir = makeTempDir('mr-stack-');
  const lobbyDbPath = join(dir, 'lobby.sqlite');
  const relayDbPath = join(dir, 'relay.sqlite');
  const logs: string[] = [];
  let blockWsUpgrade = !!options.blockWsUpgrade;

  // Bind an ephemeral loopback port first so origin/relayUrl match the live server port.
  let handler!: ReturnType<typeof browserHandler>;
  let relay!: RelayService;
  const server = Bun.serve<RelaySocketData>({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: RELAY_STATE_MAX_BODY_BYTES,
    fetch(request, srv) {
      if (blockWsUpgrade && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        return new Response('WebSocket upgrades blocked by edge proxy', { status: 403 });
      }
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
    ...(options.relayDisabled ? { relayEnabled: false } : {}),
    invites: 'off',
    maxRooms: 64,
  });
  const wakeConnector = new WakeConnector({
    dbPath: relayDbPath,
    secret: 'e2e-test-relay-secret-32-bytes-minimum!!',
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
    ...(options.relayDisabled ? {} : { relay }),
  });

  const stop = () => {
    try { server.stop(true); } catch { /* ignore */ }
    try { relay.close(); } catch { /* ignore */ }
    try { wakeConnector.close(); } catch { /* ignore */ }
    try { lobby.close(); } catch { /* ignore */ }
  };
  cleanups.push(stop);

  return {
    origin,
    relayUrl,
    lobby,
    relay,
    wakeConnector,
    relayDbPath,
    logs,
    setBlockWsUpgrade: b => { blockWsUpgrade = b; },
    stop,
  };
}

/** Creates a room with a host BrowserAgent (person) and an admitted cloud agent BrowserAgent, plus host-signed roster. */
async function setupRoomWithAgents(stack: TestStack, agentName = 'CloudBot') {
  const roomId = crypto.randomUUID();
  const hostHome = makeTempDir('mr-host-');
  const agentHome = makeTempDir('mr-agent-');
  const hostIdentityFile = join(hostHome, 'person-identity.json');

  const host = new BrowserAgent(hostHome, stack.origin, roomId, { person: { identityFile: hostIdentityFile } });
  const agent = new BrowserAgent(agentHome, stack.origin, roomId);
  const hostId = await host.ensureIdentity();
  const agentId = await agent.ensureIdentity();

  await host.command('create', { title: 'E2E Relay Room', name: 'Eve', label: 'Host Browser', ...(await host.encBinding()) });
  const invite = await host.command('agent-invite', { name: agentName }) as { token: string };
  await agent.command('agent-redeem', { token: invite.token, label: 'Cloud Runner', ...(await agent.encBinding()) });

  // Persist room.json for CLI tests (`export-identity`, `relay-wake-register`, etc.)
  writeFileSync(join(agent.dir, 'room.json'), JSON.stringify({
    origin: stack.origin,
    roomId,
    hostPin: hostId.id.slice(0, 16),
  }), { mode: 0o600 });

  const publishRoster = async (prev?: SignedRoster): Promise<SignedRoster> => {
    const status = await host.command('status', { session: crypto.randomUUID() }) as RoomStatus;
    const next = await buildNextHostRoster(status, hostId.id, prev ?? status.roster, v => host.sign(v));
    if (!next) return status.roster!;
    await host.command('roster-publish', { roster: next });
    return next;
  };

  const roster = await publishRoster();
  return { roomId, hostHome, agentHome, host, agent, hostId, agentId, roster, publishRoster };
}

describe('E2E WSS + HTTPS Relay & Cloud Agent Acceptance Tests (Issue #139 Section 8)', () => {
  test('renaming an agent changes no roster: entries carry ids, never names, so the host-signed roster stays valid and no new version is needed', async () => {
    const stack = startTestStack();
    const { roomId, host, agent, hostId, roster } = await setupRoomWithAgents(stack, 'CloudBot');
    const before = await host.command('status', { session: crypto.randomUUID() }) as RoomStatus;
    const agentMember = before.members!.find(m => m.name === 'CloudBot')!;
    expect(JSON.stringify(roster)).not.toContain('CloudBot');

    await host.command('rename', { memberId: agentMember.id, name: 'Finch' });
    const after = await host.command('status', { session: crypto.randomUUID() }) as RoomStatus;
    // The room's people see the new name and the notice; the signed roster is the very one the host published.
    expect(after.members!.find(m => m.id === agentMember.id)!.name).toBe('Finch');
    expect(after.renames).toMatchObject([{ memberId: agentMember.id, by: before.memberId, from: 'CloudBot', to: 'Finch' }]);
    expect(after.roster!.body.version).toBe(roster.body.version);
    expect(await hashRosterBody(after.roster!.body)).toBe(await hashRosterBody(roster.body));
    expect(await verifyRoster(after.roster, { roomId })).toMatchObject({ ok: true, hostDeviceId: hostId.id });
    // Nothing for the host to publish: the same devices, roles and operators, fresh enough to need no refresh.
    expect(await buildNextHostRoster(after, hostId.id, after.roster, v => host.sign(v), roster.body.at + 1)).toBeUndefined();
    // And the agent's own device still verifies against that roster and is still listed with its role.
    expect(after.roster!.body.devices.find(d => d.memberId === agentMember.id)).toMatchObject({ role: 'agent' });
    const seen = await agent.command('status', { session: crypto.randomUUID() }) as RoomStatus;
    expect(seen.members!.find(m => m.id === agentMember.id)!.name).toBe('Finch');
  });

  test('Tests #1 & #2: Authenticated WSS 101 + synthetic message & reply with peer-level signed receipts (no relay-only fake receipt)', async () => {
    const stack = startTestStack();
    const { roomId, host, agent, hostId, agentId, roster } = await setupRoomWithAgents(stack, 'CloudAgent');
    const hostStatus = await host.command('status', { session: crypto.randomUUID() }) as RoomStatus;
    const hostMemberId = hostStatus.memberId!;
    const agentMemberId = hostStatus.members!.find(m => m.name === 'CloudAgent')!.id;

    const hostReceived: { kind: string; id: string; text?: string; from: string }[] = [];
    const agentReceived: { kind: string; id: string; text?: string; from: string }[] = [];
    const hostRelayAccepted: string[] = [];

    const hostEntry = roster.body.devices.find(d => d.id === hostId.id)!;
    const agentEntry = roster.body.devices.find(d => d.id === agentId.id)!;

    let agentRelay!: RelayClient;
    let hostRelay!: RelayClient;

    hostRelay = await host.createRelayClient({
      relayUrl: stack.relayUrl,
      rosterVersion: () => roster.body.version,
      onAccepted: id => hostRelayAccepted.push(id),
      onEnvelope: async env => {
        const { packet } = await host.decryptRelay<{ body: any; signature: string }>(env, { senderSignKey: agentId.publicKey });
        const ok = await host.verify(agentEntry.sign, packet.body, packet.signature);
        expect(ok).toBe(true);
        hostReceived.push({ kind: packet.body.kind, id: packet.body.id, text: packet.body.text, from: env.from });
        if (packet.body.kind === 'message') {
          const receiptBody = { kind: 'receipt', roomId, id: packet.body.id, deviceId: hostId.id };
          hostRelay.enqueuePacket(
            { body: receiptBody, signature: await host.sign(receiptBody) },
            { rosterVersion: roster.body.version, lane: 'primary', recipients: [agentEntry] },
          );
        }
      },
    });

    agentRelay = await agent.createRelayClient({
      relayUrl: stack.relayUrl,
      rosterVersion: () => roster.body.version,
      onEnvelope: async env => {
        const { packet } = await agent.decryptRelay<{ body: any; signature: string }>(env, { senderSignKey: hostId.publicKey });
        const ok = await agent.verify(hostEntry.sign, packet.body, packet.signature);
        expect(ok).toBe(true);
        agentReceived.push({ kind: packet.body.kind, id: packet.body.id, text: packet.body.text, from: env.from });
        if (packet.body.kind === 'message') {
          // Send peer-level signed receipt first.
          const receiptBody = { kind: 'receipt', roomId, id: packet.body.id, deviceId: agentId.id };
          agentRelay.enqueuePacket(
            { body: receiptBody, signature: await agent.sign(receiptBody) },
            { rosterVersion: roster.body.version, lane: 'primary', recipients: [hostEntry] },
          );
          // Send signed synthetic reply.
          const replyBody = {
            kind: 'message', roomId, id: crypto.randomUUID(), deviceId: agentId.id, memberId: agentMemberId,
            text: 'Synthetic reply from CloudAgent over WSS', replyTo: packet.body.id, at: Date.now(),
          };
          agentRelay.enqueuePacket(
            { body: replyBody, signature: await agent.sign(replyBody) },
            { rosterVersion: roster.body.version, lane: 'primary', recipients: [hostEntry] },
          );
        }
      },
    });
    cleanups.push(() => { hostRelay.stop(); agentRelay.stop(); });

    hostRelay.start();
    agentRelay.start();
    await waitFor(() => hostRelay.transportState === 'wss' && agentRelay.transportState === 'wss');

    // Host sends synthetic message over WSS.
    const msgId = crypto.randomUUID();
    const msgBody = {
      kind: 'message', roomId, id: msgId, deviceId: hostId.id, memberId: hostMemberId,
      text: '@CloudAgent synthetic ping over WSS', at: Date.now(),
    };
    const envId = hostRelay.enqueuePacket(
      { body: msgBody, signature: await host.sign(msgBody) },
      { rosterVersion: roster.body.version, lane: 'primary', recipients: [agentEntry] },
    );

    // Wait for full round-trip: relay accept + peer receipt + reply + host receipt to agent.
    await waitFor(() =>
      hostRelayAccepted.includes(envId)
      && hostReceived.some(r => r.kind === 'receipt' && r.id === msgId)
      && hostReceived.some(r => r.kind === 'message' && r.text === 'Synthetic reply from CloudAgent over WSS')
      && agentReceived.some(r => r.kind === 'receipt'),
    );

    // Relay acceptance is tracked strictly separately from signed peer receipts.
    expect(hostRelayAccepted).toContain(envId);
    expect(hostReceived.filter(r => r.kind === 'receipt' && r.id === msgId && r.from === agentId.id)).toHaveLength(1);
    expect(agentReceived.filter(r => r.kind === 'message' && r.id === msgId)).toHaveLength(1);
    expect(agentReceived.filter(r => r.kind === 'receipt' && r.from === hostId.id)).toHaveLength(1);
  });

  test('Test #3: Reconnect, dedup across WebRTC + WSS, member removal, zero plaintext/keys in relay logs & storage', async () => {
    const stack = startTestStack();
    const { roomId, host, agent, hostId, agentId, roster } = await setupRoomWithAgents(stack, 'DedupBot');
    const hostStatus = await host.command('status', { session: crypto.randomUUID() }) as RoomStatus;
    const hostMemberId = hostStatus.memberId!;
    const agentMemberId = hostStatus.members!.find(m => m.name === 'DedupBot')!.id;
    const secretText = 'TOP_SECRET_E2E_PLAINTEXT_9f2a8c';

    // 1. Dedup across WebRTC + WSS on BrowserPeers!
    installFakeIndexedDB();
    fakeStorage.records.clear();
    const localBrowser = await browserIdentity();
    const browserEngine = new BrowserPeers(
      {} as never,
      roomId,
      localBrowser.id,
      'browser-sess',
      () => {},
      () => {},
    ) as any;
    browserEngine.fenced(await claimFence(`owner:${localBrowser.id}:${roomId}`));
    await browserEngine.load();

    // Build a verified roster containing host, agent, and this local browser device.
    const browserEncSig = await (async () => {
      const { signDeviceEncKey } = await import('../../src/browser/storage');
      return signDeviceEncKey(roomId);
    })();
    const browserMemberId = crypto.randomUUID();
    const dedupRosterBody: RosterBody = {
      v: 1,
      room: roomId,
      version: 1,
      prev: '',
      at: Date.now(),
      host: hostId.id,
      devices: [
        ...roster.body.devices,
        {
          id: localBrowser.id,
          sign: localBrowser.publicKey,
          enc: browserEncSig.enc,
          encVersion: browserEncSig.encVersion,
          encSig: browserEncSig.encSig,
          memberId: browserMemberId,
          role: 'human',
        },
      ],
      removed: [],
    };
    const dedupRoster = await signRoster(dedupRosterBody, v => host.sign(v));
    browserEngine.status = {
      roomId,
      title: 'Dedup Room',
      epoch: 'e1',
      hostOnline: true,
      deviceId: localBrowser.id,
      memberId: browserMemberId,
      ownerId: hostMemberId,
      members: [
        { id: hostMemberId, name: 'Eve', role: 'human' },
        { id: agentMemberId, name: 'DedupBot', role: 'agent', operatorId: hostMemberId },
        { id: browserMemberId, name: 'Browser', role: 'human' },
      ],
      devices: [
        { id: hostId.id, publicKey: hostId.publicKey, label: 'host', memberId: hostMemberId, admittedAt: 1 },
        { id: agentId.id, publicKey: agentId.publicKey, label: 'agent', memberId: agentMemberId, admittedAt: 1 },
        { id: localBrowser.id, publicKey: localBrowser.publicKey, label: 'browser', memberId: browserMemberId, admittedAt: 1 },
      ],
      roster: dedupRoster,
    };
    await browserEngine.verifyIncomingRoster(browserEngine.status);

    // Attach fake WebRTC channel for host.
    const webrtcSent: string[] = [];
    const fakeChan = {
      readyState: 'open', bufferedAmount: 0, bufferedAmountLowThreshold: 0,
      send(t: string) { webrtcSent.push(t); }, addEventListener() {},
      onmessage: undefined as ((e: { data: string }) => void) | undefined,
    };
    const peer = { pc: { close() {} }, session: 's', started: Date.now(), sent: new Map(), resync: new Resync() };
    browserEngine.peers.set(hostId.id, peer);
    browserEngine.connectChannel(peer, hostId.id, fakeChan);

    // Deliver the SAME signed message via WebRTC AND via encrypted WSS RelayEnvelope -> stored ONCE!
    const dupBody = { kind: 'message', roomId, id: crypto.randomUUID(), deviceId: hostId.id, memberId: hostMemberId, text: secretText, at: Date.now() };
    const dupPacket = { body: dupBody, signature: await host.sign(dupBody) };
    const browserEntry = dedupRoster.body.devices.find(d => d.id === localBrowser.id)!;
    const dupEnv = await encryptRelayEnvelope(dupPacket, {
      room: roomId,
      from: hostId.id,
      sign: v => host.sign(v),
      id: crypto.randomUUID(),
      seq: 1,
      rosterVersion: dedupRoster.body.version,
      lane: 'primary',
      recipients: [browserEntry],
    });
    fakeChan.onmessage!({ data: JSON.stringify(dupPacket) });
    await browserEngine.handleRelayEnvelope(dupEnv);
    while (browserEngine.incoming.size) await Bun.sleep(1);
    await browserEngine.serial;
    expect(browserEngine.messages.filter((m: any) => m.packet.body.id === dupBody.id)).toHaveLength(1);
    await browserEngine.close();

    // 2. Real WSS send + reconnect + member removal + zero plaintext/keys in relay storage & logs.
    const hostEntry = roster.body.devices.find(d => d.id === hostId.id)!;
    const agentEntry = roster.body.devices.find(d => d.id === agentId.id)!;
    const receivedByAgent: string[] = [];
    let authErrorStatus = 0;

    const hostRelay = await host.createRelayClient({ relayUrl: stack.relayUrl, rosterVersion: () => roster.body.version });
    const agentRelay = await agent.createRelayClient({
      relayUrl: stack.relayUrl,
      rosterVersion: () => roster.body.version,
      reconnectBaseMs: 50,
      onAuthError: status => { authErrorStatus = status; },
      onEnvelope: async env => {
        const { packet } = await agent.decryptRelay<{ body: { text: string } }>(env, { senderSignKey: hostId.publicKey });
        receivedByAgent.push(packet.body.text);
      },
    });
    cleanups.push(() => { hostRelay.stop(); agentRelay.stop(); });

    hostRelay.start();
    agentRelay.start();
    await waitFor(() => hostRelay.transportState === 'wss' && agentRelay.transportState === 'wss');

    // Send secret message over WSS.
    const msg1 = { kind: 'message', roomId, id: crypto.randomUUID(), deviceId: hostId.id, memberId: hostMemberId, text: secretText, at: Date.now() };
    hostRelay.enqueuePacket(
      { body: msg1, signature: await host.sign(msg1) },
      { rosterVersion: roster.body.version, lane: 'primary', recipients: [agentEntry] },
    );
    await waitFor(() => receivedByAgent.includes(secretText));

    // Reconnect agent cleanly and verify second message still arrives.
    agentRelay.stop();
    agentRelay.start();
    await waitFor(() => agentRelay.transportState === 'wss');
    const msg2 = { kind: 'message', roomId, id: crypto.randomUUID(), deviceId: hostId.id, memberId: hostMemberId, text: 'after-reconnect', at: Date.now() };
    hostRelay.enqueuePacket(
      { body: msg2, signature: await host.sign(msg2) },
      { rosterVersion: roster.body.version, lane: 'primary', recipients: [agentEntry] },
    );
    await waitFor(() => receivedByAgent.includes('after-reconnect'));

    // Host removes agent -> relay closes its socket & refuses future connections with 403!
    await host.command('remove', { deviceId: agentId.id });
    await waitFor(() => authErrorStatus === 403 || agentRelay.transportState === 'disconnected');
    await expect(agentRelay.drainOnce({ preferHttps: true })).rejects.toThrow();

    // Verify ZERO plaintext and ZERO private keys in relay logs and relay.sqlite!
    const allLogs = stack.logs.join('\n');
    expect(allLogs).not.toContain(secretText);
    expect(allLogs).not.toContain(agentId.privateJwk.d!);
    expect(allLogs).not.toContain(agentId.encPrivateJwk.d!);
    expect(allLogs).not.toContain(hostId.encPrivateJwk.d!);

    const db = new Database(stack.relayDbPath, { readonly: true });
    try {
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      for (const { name } of tables) {
        const dump = JSON.stringify(db.query(`SELECT * FROM ${name}`).all());
        expect(dump).not.toContain(secretText);
        expect(dump).not.toContain(agentId.privateJwk.d!);
        expect(dump).not.toContain(agentId.encPrivateJwk.d!);
        expect(dump).not.toContain('betaPerson');
      }
    } finally {
      db.close();
    }
  });

  test('Tests #4 & #5: WSS upgrade blocked -> automatic HTTPS fallback within timeout with zero message loss', async () => {
    // Block WebSocket upgrades at the server (simulating a proxy/nginx blocking 101).
    const stack = startTestStack({ blockWsUpgrade: true });
    const { roomId, host, agent, hostId, agentId, roster } = await setupRoomWithAgents(stack, 'FallbackBot');
    const hostStatus = await host.command('status', { session: crypto.randomUUID() }) as RoomStatus;
    const hostMemberId = hostStatus.memberId!;
    const agentMemberId = hostStatus.members!.find(m => m.name === 'FallbackBot')!.id;
    const hostEntry = roster.body.devices.find(d => d.id === hostId.id)!;
    const agentEntry = roster.body.devices.find(d => d.id === agentId.id)!;

    // Health endpoint stays 200 even when WS upgrade is blocked.
    const health = await fetch(`${stack.origin}/api/lobby/health`).then(r => r.json()) as { ok?: boolean; relayEnabled?: boolean };
    expect(health.relayEnabled).toBe(true);

    const agentReceived: string[] = [];
    const hostReceived: string[] = [];

    const hostRelay = await host.createRelayClient({
      relayUrl: stack.relayUrl,
      rosterVersion: () => roster.body.version,
      wssUpgradeTimeoutMs: 300,
      pollWaitSeconds: 2,
      onEnvelope: async env => {
        const { packet } = await host.decryptRelay<{ body: { kind: string; text?: string } }>(env, { senderSignKey: agentId.publicKey });
        if (packet.body.kind === 'message' && packet.body.text) hostReceived.push(packet.body.text);
      },
    });
    const agentRelay = await agent.createRelayClient({
      relayUrl: stack.relayUrl,
      rosterVersion: () => roster.body.version,
      wssUpgradeTimeoutMs: 300,
      pollWaitSeconds: 2,
      onEnvelope: async env => {
        const { packet } = await agent.decryptRelay<{ body: { kind: string; id: string; text?: string } }>(env, { senderSignKey: hostId.publicKey });
        if (packet.body.kind === 'message' && packet.body.text) {
          agentReceived.push(packet.body.text);
        }
      },
    });
    cleanups.push(() => { hostRelay.stop(); agentRelay.stop(); });

    // Queue 3 messages BEFORE starting / before fallback completes to verify ZERO frame loss across fallback switch!
    const expectedTexts = ['queued-before-fallback-1', 'queued-before-fallback-2', 'queued-before-fallback-3'];
    for (const text of expectedTexts) {
      const body = { kind: 'message', roomId, id: crypto.randomUUID(), deviceId: hostId.id, memberId: hostMemberId, text, at: Date.now() };
      hostRelay.enqueuePacket(
        { body, signature: await host.sign(body) },
        { rosterVersion: roster.body.version, lane: 'primary', recipients: [agentEntry] },
      );
    }

    const startedAt = Date.now();
    agentRelay.start();
    await waitFor(() => agentRelay.transportState === 'https', 4_000);
    hostRelay.start();
    await waitFor(() => hostRelay.transportState === 'https', 4_000);
    expect(Date.now() - startedAt).toBeLessThan(4_000);

    // Every single pre-queued message arrives over HTTPS fallback with zero loss!
    await waitFor(() => expectedTexts.every(t => agentReceived.includes(t)), 6_000);
    expect(agentReceived).toEqual(expectedTexts);

    // Agent replies over HTTPS fallback and host receives it via long-poll.
    const replyBody = {
      kind: 'message', roomId, id: crypto.randomUUID(), deviceId: agentId.id, memberId: agentMemberId,
      text: 'reply-over-https-fallback', at: Date.now(),
    };
    agentRelay.enqueuePacket(
      { body: replyBody, signature: await agent.sign(replyBody) },
      { rosterVersion: roster.body.version, lane: 'primary', recipients: [hostEntry] },
    );
    await waitFor(() => hostReceived.includes('reply-over-https-fallback'), 6_000);
  });

  test('Tests #6 & #7: Content-free webhook wake on @mention + 5-mention burst -> 1 coalesced wake & 5 delivered messages', async () => {
    const stack = startTestStack();
    const { roomId, host, agent, hostId, agentId, publishRoster } = await setupRoomWithAgents(stack, 'WakeBot');

    // Local webhook collector verifying Bearer auth and strictly content-free body.
    const webhooks: { auth: string | null; body: Record<string, unknown>; raw: string }[] = [];
    const webhookSecret = 'super-secret-routine-token-xyz';
    const webhookServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const raw = await request.text();
        webhooks.push({
          auth: request.headers.get('authorization'),
          body: JSON.parse(raw) as Record<string, unknown>,
          raw,
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    cleanups.push(() => webhookServer.stop(true));

    // Register wake endpoint signed by the room device key (NEVER an account).
    const reg = await relayWakeRegister(agent, `http://127.0.0.1:${webhookServer.port}/trigger`, webhookSecret);
    expect(reg.wakeable).toBe(true);
    expect(reg.inboxId).toMatch(/^[a-f0-9]{32}$/);

    // Host publishes updated roster reflecting agent's `wakeable: true`.
    const roster = await publishRoster();
    const agentEntry = roster.body.devices.find(d => d.id === agentId.id)!;
    expect(agentEntry.wakeable).toBe(true);

    const hostStatus = await host.command('status', { session: crypto.randomUUID() }) as RoomStatus;
    const hostMemberId = hostStatus.memberId!;

    const hostReceipts: string[] = [];
    const hostReplies: string[] = [];
    const hostRelay = await host.createRelayClient({
      relayUrl: stack.relayUrl,
      rosterVersion: () => roster.body.version,
      onEnvelope: async env => {
        const { packet } = await host.decryptRelay<{ body: any; signature: string }>(env, { senderSignKey: agentId.publicKey });
        if (packet.body.kind === 'receipt') hostReceipts.push(packet.body.id);
        if (packet.body.kind === 'message') {
          hostReplies.push(packet.body.text);
          const rec = { kind: 'receipt', roomId, id: packet.body.id, deviceId: hostId.id };
          hostRelay.enqueuePacket(
            { body: rec, signature: await host.sign(rec) },
            { rosterVersion: roster.body.version, lane: 'primary', recipients: [agentEntry], hold: true },
          );
        }
      },
    });
    cleanups.push(() => hostRelay.stop());
    hostRelay.start();
    await waitFor(() => hostRelay.transportState === 'wss');

    // Burst of 5 @mentions while WakeBot is offline -> must produce 1 coalesced content-free wake + 5 inbox messages!
    const sentIds: string[] = [];
    const burstTexts = Array.from({ length: 5 }, (_, i) => `@WakeBot burst-item-${i + 1} confidential-payload-${i + 1}`);
    for (const text of burstTexts) {
      const id = crypto.randomUUID();
      sentIds.push(id);
      const body = { kind: 'message', roomId, id, deviceId: hostId.id, memberId: hostMemberId, text, at: Date.now() };
      const packet = { body, signature: await host.sign(body) };
      const meta = computeRelayWakeMeta(packet, [agentEntry], roster, hostStatus, []);
      expect(meta.hold).toBe(true);
      expect(meta.wake).toEqual([agentId.id]);
      hostRelay.enqueuePacket(packet, {
        rosterVersion: roster.body.version,
        lane: 'primary',
        recipients: [agentEntry],
        ...meta,
      });
    }

    await waitFor(() => webhooks.length >= 1, 4_000);
    await Bun.sleep(250);
    // Coalescing: 5 mentions while offline -> exactly 1 wake fired!
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0].auth).toBe(`Bearer ${webhookSecret}`);
    expect(Object.keys(webhooks[0].body).sort()).toEqual(['count', 'event', 'inbox', 'source']);
    expect(webhooks[0].body.source).toBe('meshrooms');
    expect(webhooks[0].body.event).toBe('room-has-work');
    expect(webhooks[0].body.inbox).toBe(reg.inboxId);
    // Zero roomId, zero plaintext, zero ciphertext in webhook body!
    expect(webhooks[0].raw).not.toContain(roomId);
    expect(webhooks[0].raw).not.toContain('confidential-payload');

    // Woken ephemeral cloud agent runs `relayListenOnce` using persistent MESHROOMS_AGENT_KEY (stateless).
    const secretB64 = await agent.exportKeySecret(hostId.id.slice(0, 16));
    const statelessAgent = BrowserAgent.fromEnvSecret(secretB64, roomId);
    const listened = await relayListenOnce(statelessAgent) as unknown as {
      state: string;
      messages: { id: string; text: string }[];
      addressed: string[];
    };
    expect(listened.messages).toHaveLength(5);
    expect(listened.messages.map(m => m.text)).toEqual(burstTexts);
    expect(listened.addressed).toEqual(sentIds);

    // Host receives signed peer receipts for all 5 messages!
    await waitFor(() => sentIds.every(id => hostReceipts.includes(id)), 4_000);

    // Cloud agent replies via `relaySendOnce` and receives a peer receipt from the online host!
    const sendRes = await relaySendOnce(statelessAgent, {
      text: 'Handled all 5 burst mentions!',
      replyTo: sentIds[4],
      requestId: crypto.randomUUID(),
      waitReceiptMs: 5_000,
    });
    expect(sendRes.status).toBe('stored-remotely');
    expect(sendRes.devices).toBe(1);
    expect(hostReplies).toContain('Handled all 5 burst mentions!');
  });

  test('Test #11: Persistent MESHROOMS_AGENT_KEY across 10 consecutive runs leaves roster unchanged, writes nothing to disk; after removal gets 403 and stops', async () => {
    const stack = startTestStack();
    const { roomId, agentHome, host, agent, hostId, agentId, roster } = await setupRoomWithAgents(stack, 'StatelessBot');

    // Test CLI `export-identity --out <file>` writes 0600 file and NEVER prints secret; refused during wake!
    const prevHome = process.env.MESHROOMS_AGENT_HOME;
    const prevKey = process.env.MESHROOMS_AGENT_KEY;
    const prevWake = process.env.MESHROOMS_WAKE_ROOM;
    const exportDir = makeTempDir('mr-export-');
    const outFile = join(exportDir, 'agent-key.secret');
    try {
      process.env.MESHROOMS_AGENT_HOME = agentHome;
      delete process.env.MESHROOMS_AGENT_KEY;

      // Refused during a wake!
      process.env.MESHROOMS_WAKE_ROOM = roomId;
      await expect(agentCli(['export-identity', '--room', roomId, '--out', outFile])).rejects.toThrow();
      delete process.env.MESHROOMS_WAKE_ROOM;

      // Outside a wake: writes 0600 file, result JSON never contains the secret.
      const exported = await agentCli(['export-identity', '--room', roomId, '--out', outFile]) as Record<string, unknown>;
      expect(exported.exported).toBe(true);
      expect(exported.mode).toBe('0600');
      const secret = readFileSync(outFile, 'utf8').trim();
      expect(JSON.stringify(exported)).not.toContain(secret);
      if (process.platform !== 'win32') expect(lstatSync(outFile).mode & 0o777).toBe(0o600);

      // Run 10 consecutive stateless runs with MESHROOMS_AGENT_KEY in an isolated empty MESHROOMS_AGENT_HOME -> ZERO files written!
      const cleanDiskDir = makeTempDir('mr-nodisk-');
      process.env.MESHROOMS_AGENT_HOME = cleanDiskDir;
      process.env.MESHROOMS_AGENT_KEY = secret;

      for (let run = 1; run <= 10; run++) {
        const res = await agentCli(['listen', '--room', roomId, '--relay-once']) as { state: string; rosterVersion: number };
        expect(res.rosterVersion).toBe(roster.body.version);
      }

      // Zero files or directories created on disk!
      expect(readdirSync(cleanDiskDir)).toEqual([]);

      // Roster and device list remain completely unchanged across all 10 runs (zero churn).
      const after10 = await host.command('status', { session: crypto.randomUUID() }) as RoomStatus;
      expect(after10.roster?.body.version).toBe(roster.body.version);
      expect(after10.devices?.map(d => d.id).sort()).toEqual([hostId.id, agentId.id].sort());

      // Host removes the agent -> run #11 immediately gets 403 and stops!
      await host.command('remove', { deviceId: agentId.id });
      let err: (Error & { status?: number }) | undefined;
      try {
        await agentCli(['listen', '--room', roomId, '--relay-once']);
      } catch (caught) {
        err = caught as Error & { status?: number };
      }
      expect(err).toBeDefined();
      expect(err?.status).toBe(403);
      expect(readdirSync(cleanDiskDir)).toEqual([]);
    } finally {
      if (prevHome === undefined) delete process.env.MESHROOMS_AGENT_HOME; else process.env.MESHROOMS_AGENT_HOME = prevHome;
      if (prevKey === undefined) delete process.env.MESHROOMS_AGENT_KEY; else process.env.MESHROOMS_AGENT_KEY = prevKey;
      if (prevWake === undefined) delete process.env.MESHROOMS_WAKE_ROOM; else process.env.MESHROOMS_WAKE_ROOM = prevWake;
    }
  });

  test('Test #12: Priority — large bulk file chunks on `file` lane never delay a `primary` chat message or receipt by > 1s', async () => {
    const stack = startTestStack();
    const { roomId, host, agent, hostId, agentId, roster } = await setupRoomWithAgents(stack, 'FileBot');
    const hostStatus = await host.command('status', { session: crypto.randomUUID() }) as RoomStatus;
    const hostMemberId = hostStatus.memberId!;
    const agentEntry = roster.body.devices.find(d => d.id === agentId.id)!;
    const hostEntry = roster.body.devices.find(d => d.id === hostId.id)!;

    const receivedOrder: { lane: string; kind: string; at: number }[] = [];
    let primaryReceivedAt = 0;
    let receiptReceivedAt = 0;

    let agentRelay!: RelayClient;
    const hostRelay = await host.createRelayClient({
      relayUrl: stack.relayUrl,
      rosterVersion: () => roster.body.version,
      onEnvelope: async env => {
        const { packet } = await host.decryptRelay<{ body: { kind: string; id: string } }>(env, { senderSignKey: agentId.publicKey });
        if (packet.body.kind === 'receipt') receiptReceivedAt = Date.now();
      },
    });
    agentRelay = await agent.createRelayClient({
      relayUrl: stack.relayUrl,
      rosterVersion: () => roster.body.version,
      onEnvelope: async env => {
        const { packet } = await agent.decryptRelay<{ kind?: string; body?: { kind: string; id: string } }>(env, { senderSignKey: hostId.publicKey });
        const kind = packet.body?.kind ?? packet.kind ?? 'unknown';
        receivedOrder.push({ lane: env.lane, kind, at: Date.now() });
        if (env.lane === 'primary' && packet.body?.kind === 'message') {
          primaryReceivedAt = Date.now();
          const rec = { kind: 'receipt', roomId, id: packet.body.id, deviceId: agentId.id };
          agentRelay.enqueuePacket(
            { body: rec, signature: await agent.sign(rec) },
            { rosterVersion: roster.body.version, lane: 'primary', recipients: [hostEntry] },
          );
        }
      },
    });
    cleanups.push(() => { hostRelay.stop(); agentRelay.stop(); });

    hostRelay.start();
    agentRelay.start();
    await waitFor(() => hostRelay.transportState === 'wss' && agentRelay.transportState === 'wss');

    // Queue a large backlog of bulk file chunks (40 x 12 KB chunks = ~480 KB raw / ~640 KB base64) on the `file` lane.
    const chunkPayload = 'A'.repeat(12_000);
    for (let i = 0; i < 40; i++) {
      hostRelay.enqueuePacket(
        { kind: 'file-chunk', roomId, sha256: 'a'.repeat(64), offset: i * 12_000, data: chunkPayload },
        { rosterVersion: roster.body.version, lane: 'file', recipients: [agentEntry] },
      );
    }

    // Immediately enqueue a `primary` chat message behind the file backlog!
    const primarySentAt = Date.now();
    const chatBody = {
      kind: 'message', roomId, id: crypto.randomUUID(), deviceId: hostId.id, memberId: hostMemberId,
      text: 'Urgent primary message during file upload', at: primarySentAt,
    };
    hostRelay.enqueuePacket(
      { body: chatBody, signature: await host.sign(chatBody) },
      { rosterVersion: roster.body.version, lane: 'primary', recipients: [agentEntry] },
    );

    await waitFor(() => primaryReceivedAt > 0 && receiptReceivedAt > 0, 4_000);
    // Primary message AND its signed peer receipt must complete in well under 1s AND jump ahead of the file backlog!
    expect(primaryReceivedAt - primarySentAt).toBeLessThan(1_000);
    expect(receiptReceivedAt - primarySentAt).toBeLessThan(1_000);
    const primaryIdx = receivedOrder.findIndex(e => e.lane === 'primary' && e.kind === 'message');
    expect(primaryIdx).toBeGreaterThanOrEqual(0);
    expect(primaryIdx).toBeLessThan(5);
  });

  test('Mixed-mesh WebRTC-first routing + roster rollback/key-substitution refusal in BrowserPeers', async () => {
    installFakeIndexedDB();
    fakeStorage.records.clear();
    const localBrowser = await browserIdentity();
    const { signDeviceEncKey } = await import('../../src/browser/storage');
    const roomId = crypto.randomUUID();
    const meMember = crypto.randomUUID(), webrtcMember = crypto.randomUUID(), relayMember = crypto.randomUUID();

    // Two remote peers: one with a live open WebRTC channel, one reachable ONLY via relay.
    const tmpDir = makeTempDir('mr-mesh-');
    const webrtcPeerAgent = new BrowserAgent(join(tmpDir, 'w'), 'http://127.0.0.1:1', roomId);
    const relayPeerAgent = new BrowserAgent(join(tmpDir, 'r'), 'http://127.0.0.1:1', roomId);
    const webrtcId = await webrtcPeerAgent.ensureIdentity();
    const relayId = await relayPeerAgent.ensureIdentity();
    const browserEnc = await signDeviceEncKey(roomId);
    const webrtcEnc = await webrtcPeerAgent.encBinding(roomId);
    const relayEnc = await relayPeerAgent.encBinding(roomId);

    const rosterV1Body: RosterBody = {
      v: 1,
      room: roomId,
      version: 1,
      prev: '',
      at: Date.now(),
      host: webrtcId.id,
      devices: [
        { id: localBrowser.id, sign: localBrowser.publicKey, enc: browserEnc.enc, encVersion: browserEnc.encVersion, encSig: browserEnc.encSig, memberId: meMember, role: 'human' },
        { id: webrtcId.id, sign: webrtcId.publicKey, enc: webrtcEnc.enc, encVersion: webrtcEnc.encVersion, encSig: webrtcEnc.encSig, memberId: webrtcMember, role: 'human' },
        { id: relayId.id, sign: relayId.publicKey, enc: relayEnc.enc, encVersion: relayEnc.encVersion, encSig: relayEnc.encSig, memberId: relayMember, role: 'agent', operatorId: meMember },
      ],
      removed: [],
    };
    const rosterV1 = await signRoster(rosterV1Body, v => webrtcPeerAgent.sign(v));
    const rosterV2Body: RosterBody = { ...rosterV1Body, version: 2, prev: await hashRosterBody(rosterV1Body), at: Date.now() + 100 };
    const rosterV2 = await signRoster(rosterV2Body, v => webrtcPeerAgent.sign(v));

    const relayEnqueued: { lane: string; recipients: string[] }[] = [];
    const fakeRelay = {
      isConnected: () => true,
      currentFileInFlightBytes: 0,
      start() {},
      stop() {},
      ackCursor() {},
      enqueuePacket(_pkt: unknown, opts: { lane: string; recipients: { id: string }[] }) {
        relayEnqueued.push({ lane: opts.lane, recipients: opts.recipients.map(r => r.id) });
        return crypto.randomUUID();
      },
    } as unknown as RelayClient;

    const engine = new BrowserPeers(
      {} as never,
      roomId,
      localBrowser.id,
      's1',
      () => {},
      () => {},
      () => {},
      () => {},
      () => {},
      () => {},
      () => {},
      () => Date.now(),
      { hostPin: webrtcId.id.slice(0, 16), createRelayClient: () => fakeRelay },
    ) as any;
    engine.fenced(await claimFence(`owner:${localBrowser.id}:${roomId}`));
    await engine.load();

    const baseStatus: RoomStatus = {
      roomId,
      title: 'Mesh Room',
      epoch: 'e1',
      hostOnline: true,
      deviceId: localBrowser.id,
      memberId: meMember,
      ownerId: webrtcMember,
      members: [
        { id: meMember, name: 'Me', role: 'human' },
        { id: webrtcMember, name: 'WebRTCFriend', role: 'human' },
        { id: relayMember, name: 'RelayBot', role: 'agent', operatorId: meMember },
      ],
      devices: [
        { id: localBrowser.id, publicKey: localBrowser.publicKey, label: 'b', memberId: meMember, admittedAt: 1 },
        { id: webrtcId.id, publicKey: webrtcId.publicKey, label: 'w', memberId: webrtcMember, admittedAt: 1 },
        { id: relayId.id, publicKey: relayId.publicKey, label: 'r', memberId: relayMember, admittedAt: 1 },
      ],
      roster: rosterV2,
      relayUrl: 'ws://127.0.0.1:1/api/relay/v1',
    };
    engine.status = baseStatus;
    await engine.verifyIncomingRoster(baseStatus);
    engine.relayClient = fakeRelay;

    // Verify rollback to v1 is rejected!
    await engine.verifyIncomingRoster({ ...baseStatus, roster: rosterV1 });
    expect(engine.roster()?.body.version).toBe(2);

    // Attach a live open WebRTC channel ONLY to webrtcId.
    const webrtcSent: string[] = [];
    const webrtcChannel = {
      readyState: 'open', bufferedAmount: 0, bufferedAmountLowThreshold: 0,
      send(t: string) { webrtcSent.push(t); }, addEventListener() {},
    };
    const peer = { pc: { connectionState: 'connected', iceConnectionState: 'connected', close() {} }, session: 's', started: Date.now(), sent: new Map(), resync: new Resync() };
    engine.peers.set(webrtcId.id, peer);
    engine.connectChannel(peer, webrtcId.id, webrtcChannel);
    webrtcSent.length = 0;

    // Send a message: webrtcId gets it ONLY over WebRTC; relayId gets it ONLY over Relay!
    await engine.send('Hello mixed mesh!');
    expect(webrtcSent.some(t => JSON.parse(t).body?.text === 'Hello mixed mesh!')).toBe(true);
    expect(relayEnqueued).toHaveLength(1);
    expect(relayEnqueued[0].lane).toBe('primary');
    expect(relayEnqueued[0].recipients).toEqual([relayId.id]);
    expect(relayEnqueued[0].recipients).not.toContain(webrtcId.id);

    // Skipped roster version (v1 -> v3) succeeds under pinned host; rollback (v3 -> v2) is still refused!
    const rosterV3Body: RosterBody = { ...rosterV2Body, version: 3, prev: await hashRosterBody(rosterV2Body), at: Date.now() + 200 };
    const rosterV3 = await signRoster(rosterV3Body, v => webrtcPeerAgent.sign(v));
    const engineSkip = new BrowserPeers(
      {} as never,
      roomId,
      localBrowser.id,
      's2',
      () => {},
      () => {},
      () => {},
      () => {},
      () => {},
      () => {},
      () => {},
      () => Date.now(),
      { hostPin: webrtcId.id.slice(0, 16) },
    ) as any;
    engineSkip.fenced(await claimFence(`owner:${localBrowser.id}:${roomId}`));
    await engineSkip.load();
    await engineSkip.verifyIncomingRoster({ ...baseStatus, roster: rosterV1 });
    expect(engineSkip.roster()?.body.version).toBe(1);
    // Jump directly from v1 to v3 without having seen v2:
    await engineSkip.verifyIncomingRoster({ ...baseStatus, roster: rosterV3 });
    expect(engineSkip.roster()?.body.version).toBe(3);
    // Rollback from v3 to v2 is refused:
    await engineSkip.verifyIncomingRoster({ ...baseStatus, roster: rosterV2 });
    expect(engineSkip.roster()?.body.version).toBe(3);

    await engineSkip.close();
    await engine.close();
  });

  test('Verifier regressions: WSS 4003 removal fires onAuthError(403), HTTPS fallback drains pre-existing inbox, v1 inbox frame survives v2 roster advance', async () => {
    const stack = startTestStack();
    const { roomId, host, agent, hostId, agentId, publishRoster } = await setupRoomWithAgents(stack, 'RegressBot');

    // Make agent wakeable so offline inbox holds frames.
    const webhookServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() { return new Response(JSON.stringify({ ok: true }), { status: 200 }); },
    });
    cleanups.push(() => webhookServer.stop(true));
    await relayWakeRegister(agent, `http://127.0.0.1:${webhookServer.port}/hook`, 'regress-key');
    const rosterV2 = await publishRoster(); // v2 has wakeable: true
    expect(rosterV2.body.version).toBe(2);

    const hostStatus = await host.command('status', { session: crypto.randomUUID() }) as RoomStatus;
    const hostMemberId = hostStatus.memberId!;
    const agentEntry = rosterV2.body.devices.find(d => d.id === agentId.id)!;

    // 1. Host sends a frame encrypted under roster v2 while agent is offline (stored in inbox).
    const hostRelay = await host.createRelayClient({ relayUrl: stack.relayUrl, rosterVersion: () => rosterV2.body.version });
    cleanups.push(() => hostRelay.stop());
    hostRelay.start();
    await waitFor(() => hostRelay.transportState === 'wss');

    const preExistingText = '@RegressBot pre-existing-unread-v2-frame';
    const msgId = crypto.randomUUID();
    const msgBody = { kind: 'message', roomId, id: msgId, deviceId: hostId.id, memberId: hostMemberId, text: preExistingText, at: Date.now() };
    const accepted: string[] = [];
    const env = await encryptRelayEnvelope(
      { body: msgBody, signature: await host.sign(msgBody) },
      {
        room: roomId,
        from: hostId.id,
        sign: v => host.sign(v),
        id: crypto.randomUUID(),
        seq: hostRelay.nextSeq(),
        rosterVersion: rosterV2.body.version,
        lane: 'primary',
        recipients: [agentEntry],
        wake: [agentId.id],
        hold: true,
      },
    );
    const sendRes = await hostRelay.sendOnce([env]);
    accepted.push(...sendRes.accepted);
    expect(accepted).toHaveLength(1);

    // 2. Advance room roster from v2 -> v3 BEFORE the agent wakes up!
    const rosterV3Body: RosterBody = {
      ...rosterV2.body,
      version: 3,
      prev: await hashRosterBody(rosterV2.body),
      at: Date.now() + 50,
    };
    const rosterV3 = await signRoster(rosterV3Body, v => host.sign(v));
    await host.command('roster-publish', { roster: rosterV3 });

    // 3. Block WS upgrades so agent MUST use HTTPS fallback AND drain the pre-existing unread v2 frame while roster is at v3!
    stack.setBlockWsUpgrade(true);
    const receivedViaHttps: string[] = [];
    const httpsAgentRelay = await agent.createRelayClient({
      relayUrl: stack.relayUrl,
      rosterVersion: () => rosterV3.body.version,
      wssUpgradeTimeoutMs: 250,
      pollWaitSeconds: 2,
      onEnvelope: async incoming => {
        const { packet } = await agent.decryptRelay<{ body: { text: string } }>(incoming, { senderSignKey: hostId.publicKey });
        receivedViaHttps.push(packet.body.text);
      },
    });
    cleanups.push(() => httpsAgentRelay.stop());
    httpsAgentRelay.start();
    await waitFor(() => httpsAgentRelay.transportState === 'https', 4_000);
    await waitFor(() => receivedViaHttps.includes(preExistingText), 4_000);
    httpsAgentRelay.stop();

    // Also verify `relayListenOnce` (stateless) decrypts a v2-encrypted inbox frame even when status.roster is v3!
    const msg2Body = { kind: 'message', roomId, id: crypto.randomUUID(), deviceId: hostId.id, memberId: hostMemberId, text: '@RegressBot second-v2-under-v3', at: Date.now() };
    const env2 = await encryptRelayEnvelope(
      { body: msg2Body, signature: await host.sign(msg2Body) },
      {
        room: roomId,
        from: hostId.id,
        sign: v => host.sign(v),
        id: crypto.randomUUID(),
        seq: hostRelay.nextSeq(),
        rosterVersion: rosterV2.body.version,
        lane: 'primary',
        recipients: [agentEntry],
        wake: [agentId.id],
        hold: true,
      },
    );
    await hostRelay.sendOnce([env2]);
    const secretB64 = await agent.exportKeySecret(hostId.id.slice(0, 16));
    const statelessAgent = BrowserAgent.fromEnvSecret(secretB64, roomId);
    const listened = await relayListenOnce(statelessAgent, { preferHttps: true }) as unknown as { messages: { text: string }[]; rosterVersion: number };
    expect(listened.rosterVersion).toBe(3);
    expect(listened.messages.some(m => m.text === '@RegressBot second-v2-under-v3')).toBe(true);

    // 4. Re-enable WS upgrades, connect over WSS, then remove agent -> WSS close 4003 fires onAuthError(403) immediately without fallback!
    stack.setBlockWsUpgrade(false);
    const states: string[] = [];
    let authStatus = 0;
    const wssAgentRelay = await agent.createRelayClient({
      relayUrl: stack.relayUrl,
      rosterVersion: () => rosterV3.body.version,
      onStateChange: s => states.push(s),
      onAuthError: status => { authStatus = status; },
    });
    cleanups.push(() => wssAgentRelay.stop());
    wssAgentRelay.start();
    await waitFor(() => wssAgentRelay.transportState === 'wss', 4_000);

    await host.command('remove', { deviceId: agentId.id });
    await waitFor(() => authStatus === 403 && wssAgentRelay.transportState === 'disconnected', 4_000);
    expect(authStatus).toBe(403);
    expect(states).not.toContain('https');
  });

  test('PR #140 P1: Failed putSealedState in relayListenOnce sends 0 receipts and leaves inbox frames recoverable on retry', async () => {
    const stack = startTestStack();
    const { roomId, host, agent, hostId, agentId, publishRoster } = await setupRoomWithAgents(stack, 'CommitOrderBot');

    const webhookServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() { return new Response(JSON.stringify({ ok: true }), { status: 200 }); },
    });
    cleanups.push(() => webhookServer.stop(true));
    await relayWakeRegister(agent, `http://127.0.0.1:${webhookServer.port}/hook`, 'commit-key');
    const roster = await publishRoster();
    const hostStatus = await host.command('status', { session: crypto.randomUUID() }) as RoomStatus;
    const hostMemberId = hostStatus.memberId!;
    const agentEntry = roster.body.devices.find(d => d.id === agentId.id)!;

    const hostReceipts: string[] = [];
    const hostRelay = await host.createRelayClient({
      relayUrl: stack.relayUrl,
      rosterVersion: () => roster.body.version,
      onEnvelope: async env => {
        const { packet } = await host.decryptRelay<{ body: { kind: string; id: string } }>(env, { senderSignKey: agentId.publicKey });
        if (packet.body.kind === 'receipt') hostReceipts.push(packet.body.id);
      },
    });
    cleanups.push(() => hostRelay.stop());
    hostRelay.start();
    await waitFor(() => hostRelay.transportState === 'wss');

    const msgId = crypto.randomUUID();
    const msgBody = {
      kind: 'message', roomId, id: msgId, deviceId: hostId.id, memberId: hostMemberId,
      text: '@CommitOrderBot must-not-lose-on-state-failure', at: Date.now(),
    };
    hostRelay.enqueuePacket(
      { body: msgBody, signature: await host.sign(msgBody) },
      { rosterVersion: roster.body.version, lane: 'primary', recipients: [agentEntry], wake: [agentId.id], hold: true },
    );

    // Wait until the frame is stored in relay inbox.
    const countInbox = () => {
      const db = new Database(stack.relayDbPath, { readonly: true });
      try {
        return (db.query('SELECT COUNT(*) AS n FROM relay_inbox WHERE room_id = ? AND recipient_id = ?').get(roomId, agentId.id) as { n: number }).n;
      } finally { db.close(); }
    };
    await waitFor(() => countInbox() === 1, 4_000);

    const secretB64 = await agent.exportKeySecret(hostId.id.slice(0, 16));
    const failingAgent = BrowserAgent.fromEnvSecret(secretB64, roomId);

    // Inject a 500 failure strictly on `relay-state-put`.
    const failPutStateFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/state') && typeof init?.body === 'string' && init.body.includes('"relay-state-put"')) {
        return new Response(JSON.stringify({ error: 'simulated state store outage' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return fetch(input, init);
    };

    await expect(relayListenOnce(failingAgent, {
      preferHttps: true,
      relayOptions: { fetch: failPutStateFetch },
    })).rejects.toThrow('simulated state store outage');

    // Allow any stray network traffic to settle: ZERO receipts must have been sent and inbox frame must remain!
    await Bun.sleep(150);
    expect(hostReceipts).toHaveLength(0);
    expect(countInbox()).toBe(1);

    // Retry cleanly without fault injection: recovers the exact message, sends peer receipt, and acks inbox!
    const retryAgent = BrowserAgent.fromEnvSecret(secretB64, roomId);
    const recovered = await relayListenOnce(retryAgent, { preferHttps: true }) as unknown as {
      messages: { id: string; text: string }[];
      addressed: string[];
    };
    expect(recovered.messages.map(m => m.id)).toContain(msgId);
    expect(recovered.addressed).toContain(msgId);
    await waitFor(() => hostReceipts.includes(msgId), 4_000);
    expect(countInbox()).toBe(0);
  });

  test('PR #140 P1: HTTPS poll loop separates fetchCursor from committedAckCursor and advances server ack strictly on contiguous prefix', async () => {
    const stack = startTestStack({ blockWsUpgrade: true });
    const { roomId, host, agent, hostId, agentId, publishRoster } = await setupRoomWithAgents(stack, 'ContiguousBot');

    const webhookServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() { return new Response(JSON.stringify({ ok: true }), { status: 200 }); },
    });
    cleanups.push(() => webhookServer.stop(true));
    await relayWakeRegister(agent, `http://127.0.0.1:${webhookServer.port}/hook`, 'contiguous-key');
    const roster = await publishRoster();
    const hostStatus = await host.command('status', { session: crypto.randomUUID() }) as RoomStatus;
    const hostMemberId = hostStatus.memberId!;
    const agentEntry = roster.body.devices.find(d => d.id === agentId.id)!;

    const hostRelay = await host.createRelayClient({ relayUrl: stack.relayUrl, rosterVersion: () => roster.body.version });
    cleanups.push(() => hostRelay.stop());

    // Enqueue 3 messages into agent's inbox while agent is offline.
    const envs: RelayEnvelope[] = [];
    for (let i = 1; i <= 3; i++) {
      const body = { kind: 'message', roomId, id: crypto.randomUUID(), deviceId: hostId.id, memberId: hostMemberId, text: `frame-${i}`, at: Date.now() + i };
      envs.push(await encryptRelayEnvelope(
        { body, signature: await host.sign(body) },
        {
          room: roomId,
          from: hostId.id,
          sign: v => host.sign(v),
          id: crypto.randomUUID(),
          seq: hostRelay.nextSeq(),
          rosterVersion: roster.body.version,
          lane: 'primary',
          recipients: [agentEntry],
          hold: true,
        },
      ));
    }
    const sent = await hostRelay.sendOnce(envs);
    expect(sent.accepted).toHaveLength(3);

    const inboxCursors = () => {
      const db = new Database(stack.relayDbPath, { readonly: true });
      try {
        return (db.query('SELECT cursor FROM relay_inbox WHERE room_id = ? AND recipient_id = ? ORDER BY cursor ASC').all(roomId, agentId.id) as { cursor: number }[])
          .map(r => r.cursor);
      } finally { db.close(); }
    };
    const initialCursors = inboxCursors();
    expect(initialCursors).toHaveLength(3);
    const [c1, c2, c3] = initialCursors;

    const delivered: number[] = [];
    const pollAckCursorsSeen: (number | undefined)[] = [];
    const trackingFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/poll') && typeof init?.body === 'string') {
        const parsed = JSON.parse(init.body) as { command?: { payload?: { ackCursor?: number } } };
        pollAckCursorsSeen.push(parsed.command?.payload?.ackCursor);
      }
      return fetch(input, init);
    };

    const agentRelay = await agent.createRelayClient({
      relayUrl: stack.relayUrl,
      rosterVersion: () => roster.body.version,
      wssUpgradeTimeoutMs: 150,
      pollWaitSeconds: 1,
      fetch: trackingFetch,
      onEnvelope: async (_env, meta) => {
        if (meta.cursor !== undefined) delivered.push(meta.cursor);
        // Intentionally do NOT call ackCursor here yet!
      },
    });
    cleanups.push(() => agentRelay.stop());
    agentRelay.start();

    await waitFor(() => delivered.length === 3, 4_000);
    expect(delivered).toEqual([c1, c2, c3]);
    expect(agentRelay.currentCursor).toBe(c3);
    expect(agentRelay.committedAckCursor).toBe(0);
    expect(agentRelay.pendingAckCount).toBe(3);

    // Wait for a subsequent poll while frames remain uncommitted: server MUST NOT delete any of the 3 frames!
    const pollsBefore = pollAckCursorsSeen.length;
    await waitFor(() => pollAckCursorsSeen.length > pollsBefore, 3_000);
    expect(inboxCursors()).toEqual([c1, c2, c3]);

    // Out-of-order ack of c3 before c1/c2: committedAckCursor MUST stay 0!
    agentRelay.ackCursor(c3);
    expect(agentRelay.committedAckCursor).toBe(0);
    const pollsAfterC3 = pollAckCursorsSeen.length;
    await waitFor(() => pollAckCursorsSeen.length > pollsAfterC3, 3_000);
    expect(inboxCursors()).toEqual([c1, c2, c3]);

    // Ack c1: contiguous prefix advances strictly to c1 (c2 still uncommitted, so c2 & c3 stay on server!).
    agentRelay.ackCursor(c1);
    expect(agentRelay.committedAckCursor).toBe(c1);
    await waitFor(() => inboxCursors().length === 2, 3_000);
    expect(inboxCursors()).toEqual([c2, c3]);

    // Ack c2: contiguous prefix jumps through c2 AND already-committed c3!
    agentRelay.ackCursor(c2);
    expect(agentRelay.committedAckCursor).toBe(c3);
    await waitFor(() => inboxCursors().length === 0, 3_000);
  });

  test('PR #140 P1: Cold relaySendOnce fails closed on stale roster or external minRosterVersion, and succeeds after host refresh', async () => {
    const stack = startTestStack();
    const { roomId, host, agent, hostId, agentId, roster: rosterV1 } = await setupRoomWithAgents(stack, 'FreshBot');

    // Make room open-floor so agent can send freely without a prior mention.
    await host.command('settings', { floor: 'open' });

    // Publish a v2 roster whose host-signed `at` is older than ROSTER_FRESHNESS_MS (16 minutes stale).
    const nowMs = Date.now();
    const staleAt = nowMs - ROSTER_FRESHNESS_MS - 60_000;
    const staleV2Body: RosterBody = {
      ...rosterV1.body,
      version: 2,
      prev: await hashRosterBody(rosterV1.body),
      at: staleAt,
    };
    const staleV2 = await signRoster(staleV2Body, v => host.sign(v));
    await host.command('roster-publish', { roster: staleV2 });

    const secretB64 = await agent.exportKeySecret(hostId.id.slice(0, 16));
    const statelessAgent = BrowserAgent.fromEnvSecret(secretB64, roomId);

    // 1. Cold send MUST fail closed on stale roster (`STALE_ROSTER`)!
    let staleErr: (Error & { code?: string }) | undefined;
    try {
      await relaySendOnce(statelessAgent, {
        text: 'Should not encrypt under stale roster',
        requestId: crypto.randomUUID(),
        waitReceiptMs: 2_000,
        now: () => nowMs,
      });
    } catch (err) {
      staleErr = err as Error & { code?: string };
    }
    expect(staleErr).toBeDefined();
    expect(staleErr?.code).toBe('STALE_ROSTER');

    // 2. Cold send also rejects far-future host timestamp skew (`at > now + 60s`).
    const futureV3Body: RosterBody = {
      ...staleV2Body,
      version: 3,
      prev: await hashRosterBody(staleV2Body),
      at: nowMs + ROSTER_MAX_FUTURE_SKEW_MS + 60_000,
    };
    const futureV3 = await signRoster(futureV3Body, v => host.sign(v));
    await host.command('roster-publish', { roster: futureV3 });

    let futureErr: (Error & { code?: string }) | undefined;
    try {
      await relaySendOnce(statelessAgent, {
        text: 'Should not encrypt under future-skewed roster',
        requestId: crypto.randomUUID(),
        waitReceiptMs: 2_000,
        now: () => nowMs,
      });
    } catch (err) {
      futureErr = err as Error & { code?: string };
    }
    expect(futureErr).toBeDefined();
    expect(futureErr?.code).toBe('STALE_ROSTER');

    // 3. Host periodic refresh (`buildNextHostRoster`) refreshes an unchanged roster once `ROSTER_REFRESH_MS` elapses.
    const hostStatus = await host.command('status', { session: crypto.randomUUID() }) as RoomStatus;
    const refreshCheckEarly = await buildNextHostRoster(hostStatus, hostId.id, staleV2, v => host.sign(v), staleAt + ROSTER_REFRESH_MS - 1_000);
    expect(refreshCheckEarly).toBeUndefined();
    const refreshedV4 = await buildNextHostRoster(hostStatus, hostId.id, futureV3, v => host.sign(v), nowMs + ROSTER_REFRESH_MS + 120_000);
    expect(refreshedV4).toBeDefined();
    // Publish a genuinely fresh v4 roster at `nowMs`.
    const freshV4Body: RosterBody = {
      ...futureV3Body,
      version: 4,
      prev: await hashRosterBody(futureV3Body),
      at: nowMs,
    };
    const freshV4 = await signRoster(freshV4Body, v => host.sign(v));
    await host.command('roster-publish', { roster: freshV4 });

    // 4. Cold send fails closed if external `minRosterVersion` checkpoint is above the served roster (`INVALID_ROSTER`).
    let floorErr: (Error & { code?: string }) | undefined;
    try {
      await relaySendOnce(statelessAgent, {
        text: 'Blocked by external checkpoint',
        requestId: crypto.randomUUID(),
        waitReceiptMs: 2_000,
        minRosterVersion: 5,
        now: () => nowMs,
      });
    } catch (err) {
      floorErr = err as Error & { code?: string };
    }
    expect(floorErr).toBeDefined();
    expect(floorErr?.code).toBe('INVALID_ROSTER');

    // 5. With fresh v4 roster and external checkpoint `minRosterVersion: 4`, cold send succeeds and gets host peer receipt!
    const hostReceived: string[] = [];
    const agentEntry = freshV4.body.devices.find(d => d.id === agentId.id)!;
    const hostRelay = await host.createRelayClient({
      relayUrl: stack.relayUrl,
      rosterVersion: () => freshV4.body.version,
      onEnvelope: async env => {
        const { packet } = await host.decryptRelay<{ body: { kind: string; id: string; text?: string } }>(env, { senderSignKey: agentId.publicKey });
        if (packet.body.kind === 'message' && packet.body.text) {
          hostReceived.push(packet.body.text);
          const rec = { kind: 'receipt', roomId, id: packet.body.id, deviceId: hostId.id };
          hostRelay.enqueuePacket(
            { body: rec, signature: await host.sign(rec) },
            { rosterVersion: freshV4.body.version, lane: 'primary', recipients: [agentEntry] },
          );
        }
      },
    });
    cleanups.push(() => hostRelay.stop());
    hostRelay.start();
    await waitFor(() => hostRelay.transportState === 'wss');

    const okRes = await relaySendOnce(statelessAgent, {
      text: 'Fresh host-signed roster verified!',
      requestId: crypto.randomUUID(),
      waitReceiptMs: 5_000,
      minRosterVersion: 4,
      now: () => nowMs,
    });
    expect(okRes.status).toBe('stored-remotely');
    expect(okRes.devices).toBe(1);
    expect(hostReceived).toContain('Fresh host-signed roster verified!');
  });
});

/** Admits one more cloud agent (a plain member that can send relay frames) to the room. */
async function addAgent(stack: TestStack, host: BrowserAgent, roomId: string, name: string) {
  const home = makeTempDir('mr-member-');
  const member = new BrowserAgent(home, stack.origin, roomId);
  const id = await member.ensureIdentity();
  const invite = await host.command('agent-invite', { name }) as { token: string };
  await member.command('agent-redeem', { token: invite.token, label: name, ...(await member.encBinding()) });
  return { agent: member, id };
}

/** Publishes the next host-signed roster with an identical device set (a legitimate refresh) and returns it. */
async function refreshRoster(host: BrowserAgent, prev: SignedRoster): Promise<SignedRoster> {
  const body: RosterBody = { ...prev.body, version: prev.body.version + 1, prev: await hashRosterBody(prev.body), at: Date.now() };
  const next = await signRoster(body, v => host.sign(v));
  await host.command('roster-publish', { roster: next });
  return next;
}

const countInboxFor = (dbPath: string, roomId: string, recipientId: string) => {
  const db = new Database(dbPath, { readonly: true });
  try { return (db.query('SELECT COUNT(*) AS n FROM relay_inbox WHERE room_id = ? AND recipient_id = ?').get(roomId, recipientId) as { n: number }).n; }
  finally { db.close(); }
};

describe('PR #140 follow-up hardening (sender auth, roster floor, replay, relay-once send, flag)', () => {
  test('a member cannot freeze a victim agent\'s roster floor with inflated envelope metadata, and a legitimately refreshed roster is still accepted', async () => {
    const stack = startTestStack();
    const { roomId, host, agent, hostId, agentId, publishRoster } = await setupRoomWithAgents(stack, 'VictimBot');
    const attacker = await addAgent(stack, host, roomId, 'MemberBot');
    const webhook = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') });
    cleanups.push(() => webhook.stop(true));
    await relayWakeRegister(agent, `http://127.0.0.1:${webhook.port}/hook`, 'victim-key');
    const roster = await publishRoster();
    const victimEntry = roster.body.devices.find(d => d.id === agentId.id)!;
    const secret = await agent.exportKeySecret(hostId.id.slice(0, 16));
    const listen = () => relayListenOnce(BrowserAgent.fromEnvSecret(secret, roomId), { preferHttps: true });

    expect((await listen()).rosterVersion).toBe(roster.body.version);

    // A valid, admitted member sends the victim a correctly signed packet whose envelope claims roster version 9e12.
    const memberRelay = await attacker.agent.createRelayClient({ relayUrl: stack.relayUrl, rosterVersion: () => roster.body.version });
    cleanups.push(() => memberRelay.stop());
    memberRelay.start();
    await waitFor(() => memberRelay.transportState === 'wss');
    const receipt = { kind: 'receipt', roomId, id: crypto.randomUUID(), deviceId: attacker.id.id };
    memberRelay.enqueuePacket(
      { body: receipt, signature: await attacker.agent.sign(receipt) },
      { rosterVersion: 9_000_000_000_000, lane: 'primary', recipients: [victimEntry], hold: true, wake: [agentId.id] },
    );
    await waitFor(() => countInboxFor(stack.relayDbPath, roomId, agentId.id) === 1, 4_000);
    await listen(); // the victim processes the poisoned frame

    // The host's next, genuine roster must still be accepted (it was refused as a "rollback" before the fix).
    const refreshed = await refreshRoster(host, roster);
    const after = await listen();
    expect(after.rosterVersion).toBe(refreshed.body.version);

    // What the victim sealed carries only the host-signed version.
    const probe = BrowserAgent.fromEnvSecret(secret, roomId);
    const client = await probe.createRelayClient({ relayUrl: stack.relayUrl });
    try {
      const sealed = await probe.unsealState<{ verifiedRosterVersion?: number; highestRosterVersion: number }>((await client.getSealedState()).state!);
      expect(sealed.verifiedRosterVersion).toBe(refreshed.body.version);
      expect(sealed.highestRosterVersion).toBeLessThan(1_000);
    } finally { client.stop(); }
  });

  test('a sealed state poisoned by the old behaviour recovers, while a genuine host-signed floor still blocks a roster rollback', async () => {
    const stack = startTestStack();
    const { roomId, host, agent, hostId, publishRoster } = await setupRoomWithAgents(stack, 'RecoverBot');
    const roster = await publishRoster();
    const secret = await agent.exportKeySecret(hostId.id.slice(0, 16));
    const putState = async (state: Record<string, unknown>) => {
      const owner = BrowserAgent.fromEnvSecret(secret, roomId);
      const client = await owner.createRelayClient({ relayUrl: stack.relayUrl });
      try { await client.putSealedState(await owner.sealState({ v: 1, messages: [], taskOps: [], decisionOps: [], reactionOps: [], retractOps: [], ...state })); }
      finally { client.stop(); }
    };
    const readState = async () => {
      const owner = BrowserAgent.fromEnvSecret(secret, roomId);
      const client = await owner.createRelayClient({ relayUrl: stack.relayUrl });
      try { return await owner.unsealState<{ verifiedRosterVersion?: number; highestRosterVersion: number }>((await client.getSealedState()).state!); }
      finally { client.stop(); }
    };

    // State as written by 6cc0b30: only `highestRosterVersion`, raised from sender-controlled envelope metadata.
    await putState({ highestRosterVersion: 9_000_000_000_000 });
    const recovered = await relayListenOnce(BrowserAgent.fromEnvSecret(secret, roomId), { preferHttps: true });
    expect(recovered.rosterVersion).toBe(roster.body.version);
    const healed = await readState();
    expect(healed.verifiedRosterVersion).toBe(roster.body.version);
    expect(healed.highestRosterVersion).toBeLessThan(1_000);

    // A floor that did come from a verified host-signed roster is still honoured (rollback protection is intact).
    await putState({ verifiedRosterVersion: roster.body.version + 5, highestRosterVersion: roster.body.version + 5 });
    await expect(relayListenOnce(BrowserAgent.fromEnvSecret(secret, roomId), { preferHttps: true })).rejects.toThrow(/Roster verification failed: .*(rollback|minVersion)/i);
    void host;
  });

  test('a replayed envelope is dropped by the receiving agent: no second receipt, state unchanged, and the stale inbox copy is still acknowledged', async () => {
    const stack = startTestStack();
    const { roomId, host, agent, hostId, agentId, publishRoster } = await setupRoomWithAgents(stack, 'ReplayBot');
    const webhook = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') });
    cleanups.push(() => webhook.stop(true));
    await relayWakeRegister(agent, `http://127.0.0.1:${webhook.port}/hook`, 'replay-key');
    const roster = await publishRoster();
    const agentEntry = roster.body.devices.find(d => d.id === agentId.id)!;
    const hostStatus = await host.command('status', { session: crypto.randomUUID() }) as RoomStatus;

    const hostReceipts: string[] = [];
    const hostRelay = await host.createRelayClient({
      relayUrl: stack.relayUrl,
      rosterVersion: () => roster.body.version,
      onEnvelope: async env => {
        const { packet } = await host.decryptRelay<{ body: { kind: string; id: string } }>(env, { senderSignKey: agentId.publicKey });
        if (packet.body.kind === 'receipt') hostReceipts.push(packet.body.id);
      },
    });
    cleanups.push(() => hostRelay.stop());
    hostRelay.start();
    await waitFor(() => hostRelay.transportState === 'wss');

    const msgId = crypto.randomUUID();
    const body = { kind: 'message', roomId, id: msgId, deviceId: hostId.id, memberId: hostStatus.memberId!, text: '@ReplayBot once only', at: Date.now() };
    hostRelay.enqueuePacket({ body, signature: await host.sign(body) }, { rosterVersion: roster.body.version, lane: 'primary', recipients: [agentEntry], wake: [agentId.id], hold: true });
    await waitFor(() => countInboxFor(stack.relayDbPath, roomId, agentId.id) === 1, 4_000);

    // A hostile relay keeps a copy of the stored ciphertext.
    const db = new Database(stack.relayDbPath);
    const stored = db.query('SELECT room_id, recipient_id, sender_id, frame_id, envelope_json, bytes, created_at, expires_at FROM relay_inbox WHERE room_id = ? AND recipient_id = ?').all(roomId, agentId.id) as Record<string, unknown>[];
    expect(stored).toHaveLength(1);

    const secret = await agent.exportKeySecret(hostId.id.slice(0, 16));
    const first = await relayListenOnce(BrowserAgent.fromEnvSecret(secret, roomId), { preferHttps: true }) as unknown as { messages: { id: string }[] };
    expect(first.messages.map(m => m.id)).toContain(msgId);
    await waitFor(() => hostReceipts.length === 1, 4_000);
    expect(countInboxFor(stack.relayDbPath, roomId, agentId.id)).toBe(0);

    // ...and replays it later, as a new inbox row.
    db.query('INSERT INTO relay_inbox (room_id, recipient_id, sender_id, frame_id, envelope_json, bytes, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(...(Object.values(stored[0]) as [string, string, string, string, string, number, number, number]));
    db.close();
    expect(countInboxFor(stack.relayDbPath, roomId, agentId.id)).toBe(1);

    const replayed = BrowserAgent.fromEnvSecret(secret, roomId);
    await relayListenOnce(replayed, { preferHttps: true });
    await Bun.sleep(300);
    expect(hostReceipts).toHaveLength(1); // no second receipt was produced for the replay
    expect(countInboxFor(stack.relayDbPath, roomId, agentId.id)).toBe(0); // and the replayed row did not linger

    const probe = BrowserAgent.fromEnvSecret(secret, roomId);
    const client = await probe.createRelayClient({ relayUrl: stack.relayUrl });
    try {
      const sealed = await probe.unsealState<{ relaySeen?: unknown; messages: { packet: { body: { id: string } } }[] }>((await client.getSealedState()).state!);
      expect(RelayReplayGuard.from(sealed.relaySeen).seen(hostId.id, stored[0].frame_id as string)).toBe(true);
      expect(sealed.messages.filter(m => m.packet.body.id === msgId)).toHaveLength(1);
    } finally { client.stop(); }
  });

  test('N1: relay-once send with --wait-seconds 0 still delivers to the relay and says so (it used to drop the frame while reporting it queued)', async () => {
    const stack = startTestStack();
    const { roomId, host, agent, hostId, agentId, publishRoster } = await setupRoomWithAgents(stack, 'NoWaitBot');
    await host.command('settings', { floor: 'open' });
    const webhook = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') });
    cleanups.push(() => webhook.stop(true));
    await relayWakeRegister(agent, `http://127.0.0.1:${webhook.port}/hook`, 'nowait-key'); // wakeable sender: held frames are stored for an offline host
    await publishRoster();
    const secret = await agent.exportKeySecret(hostId.id.slice(0, 16));

    const result = await relaySendOnce(BrowserAgent.fromEnvSecret(secret, roomId), { text: 'sent without waiting for receipts', requestId: crypto.randomUUID(), waitReceiptMs: 0 });
    expect(result).toMatchObject({ status: 'queued-for-peers', accepted: true, held: true });
    expect(countInboxFor(stack.relayDbPath, roomId, hostId.id)).toBe(1);
    void agentId;
  });

  test('flag off at the lobby: no relay URL, no roster, no encryption keys are advertised or stored, and roster publication is refused', async () => {
    const stack = startTestStack({ relayDisabled: true });
    const roomId = crypto.randomUUID();
    const home = makeTempDir('mr-off-');
    const host = new BrowserAgent(home, stack.origin, roomId, { person: { identityFile: join(home, 'person-identity.json') } });
    const hostId = await host.ensureIdentity();
    await host.command('create', { title: 'Relay off', name: 'Eve', label: 'Browser', ...(await host.encBinding()) });
    const status = await host.command('status', { session: crypto.randomUUID() }) as RoomStatus;
    expect(status.relayUrl).toBeUndefined();
    expect(status.roster).toBeUndefined();
    expect(status.devices?.find(d => d.id === hostId.id)).toBeDefined();
    expect(status.devices?.every(d => d.enc === undefined && d.encSig === undefined)).toBe(true);

    const body: RosterBody = { v: 1, room: roomId, version: 1, prev: '', at: Date.now(), host: hostId.id, devices: [], removed: [] };
    await expect(host.command('roster-publish', { roster: await signRoster(body, v => host.sign(v)) })).rejects.toThrow(/not enabled/i);
    const res = await fetch(`${stack.origin}/api/relay/v1/open`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(404);
    expect(((await (await fetch(`${stack.origin}/api/lobby/health`)).json()) as Record<string, unknown>).relayEnabled).toBeUndefined();
  });

  test('browser engine: a forged sender is dropped, replays are dropped (and survive a reload), and envelope metadata never moves the roster floor', async () => {
    installFakeIndexedDB();
    fakeStorage.records.clear();
    const local = await browserIdentity();
    const { signDeviceEncKey } = await import('../../src/browser/storage');
    const roomId = crypto.randomUUID();
    const meMember = crypto.randomUUID(), hostMember = crypto.randomUUID(), peerMember = crypto.randomUUID(), badMember = crypto.randomUUID();
    const tmp = makeTempDir('mr-engine-');
    const hostAgent = new BrowserAgent(join(tmp, 'h'), 'http://127.0.0.1:1', roomId);
    const peerAgent = new BrowserAgent(join(tmp, 'p'), 'http://127.0.0.1:1', roomId);
    const badAgent = new BrowserAgent(join(tmp, 'b'), 'http://127.0.0.1:1', roomId);
    const hostId = await hostAgent.ensureIdentity(), peerId = await peerAgent.ensureIdentity(), badId = await badAgent.ensureIdentity();
    const browserEnc = await signDeviceEncKey(roomId);
    const entry = async (agent: BrowserAgent, id: { id: string; publicKey: string }, memberId: string, role: 'human' | 'agent') => {
      const enc = await agent.encBinding(roomId);
      return { id: id.id, sign: id.publicKey, enc: enc.enc, encVersion: enc.encVersion, encSig: enc.encSig, memberId, role, ...(role === 'agent' ? { operatorId: meMember } : {}) } as RosterBody['devices'][number];
    };
    const browserEntry = { id: local.id, sign: local.publicKey, enc: browserEnc.enc, encVersion: browserEnc.encVersion, encSig: browserEnc.encSig, memberId: meMember, role: 'human' } as RosterBody['devices'][number];
    const devices = [browserEntry, await entry(hostAgent, hostId, hostMember, 'human'), await entry(peerAgent, peerId, peerMember, 'agent'), await entry(badAgent, badId, badMember, 'agent')];
    const rosterV1 = await signRoster({ v: 1, room: roomId, version: 1, prev: '', at: Date.now(), host: hostId.id, devices, removed: [] }, v => hostAgent.sign(v));
    const rosterV2 = await signRoster({ ...rosterV1.body, version: 2, prev: await hashRosterBody(rosterV1.body), at: Date.now() + 10 }, v => hostAgent.sign(v));

    const sent: string[] = [];
    const acked: number[] = [];
    const fakeRelay = { isConnected: () => true, currentFileInFlightBytes: 0, start() {}, stop() {}, ackCursor: (c: number) => { acked.push(c); }, enqueuePacket: () => { sent.push('frame'); return crypto.randomUUID(); } } as unknown as RelayClient;
    const status: RoomStatus = {
      roomId, title: 'Engine', epoch: 'e1', hostOnline: true, deviceId: local.id, memberId: meMember, ownerId: hostMember,
      members: [{ id: meMember, name: 'Me', role: 'human' }, { id: hostMember, name: 'Host', role: 'human' }, { id: peerMember, name: 'Peer', role: 'agent', operatorId: meMember }, { id: badMember, name: 'Bad', role: 'agent', operatorId: meMember }],
      devices: devices.map(d => ({ id: d.id, publicKey: d.sign, label: d.id.slice(0, 4), memberId: d.memberId, admittedAt: 1 })),
      roster: rosterV1, relayUrl: 'ws://127.0.0.1:1/api/relay/v1',
    };
    const newEngine = async (session: string) => {
      const engine = new BrowserPeers({} as never, roomId, local.id, session, () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => Date.now(),
        { hostPin: hostId.id.slice(0, 16), createRelayClient: () => fakeRelay }) as any;
      engine.fenced(await claimFence(`owner:${local.id}:${roomId}`));
      await engine.load();
      engine.status = status;
      await engine.verifyIncomingRoster(status);
      engine.relayClient = fakeRelay;
      return engine;
    };
    const seal = (from: BrowserAgent, fromId: string, signer: BrowserAgent, packet: unknown, rosterVersion = 1, id = crypto.randomUUID()) => encryptRelayEnvelope(packet, {
      room: roomId, from: fromId, sign: v => signer.sign(v), id, seq: 1, rosterVersion, lane: 'primary', recipients: [browserEntry],
    });
    void seal;
    const engine = await newEngine('s1');
    const activity = { kind: 'activity', roomId, at: Date.now(), state: 'idle', since: Date.now(), heartbeat: Date.now() };
    let accepted = 0;
    engine.acceptActivity = () => { accepted++; };

    // 1. Forgery: the bad member signs an envelope that claims to come from the peer, so it is dropped.
    await engine.handleRelayEnvelope(await seal(peerAgent, peerId.id, badAgent, activity), 1);
    expect(accepted).toBe(0);
    // The peer's own genuinely signed activity is accepted once, and its replay is dropped.
    const real = await seal(peerAgent, peerId.id, peerAgent, activity);
    await engine.handleRelayEnvelope(real, 2);
    await engine.handleRelayEnvelope(real, 3);
    expect(accepted).toBe(1);
    expect(acked).toContain(3); // a repeat of something already handled can be acknowledged

    // 2. A message with an inflated envelope roster version is stored, but the floor stays host-signed only.
    const msgId = crypto.randomUUID();
    const body = { kind: 'message', roomId, id: msgId, deviceId: peerId.id, memberId: peerMember, text: 'hello once', at: Date.now() };
    const message = await seal(peerAgent, peerId.id, peerAgent, { body, signature: await peerAgent.sign(body) }, 9_000_000_000_000);
    await engine.handleRelayEnvelope(message, 10);
    await waitFor(() => engine.messages.length === 1);
    await waitFor(() => acked.includes(10));
    expect(sent).toHaveLength(1); // exactly one receipt back
    await engine.handleRelayEnvelope(message, 11); // replay
    await Bun.sleep(30);
    expect(engine.messages).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(acked).toContain(11);
    await engine.verifyIncomingRoster({ ...status, roster: rosterV2 });
    expect(engine.roster()?.body.version).toBe(2); // refused before the fix: "version 2 < 9000000000000"
    await waitFor(() => !!fakeStorage.records.get(`relay-seen:${local.id}:${roomId}`));
    await engine.close();

    // 3. The replay record is persisted: a reloaded engine still drops the stored envelope.
    const reloaded = await newEngine('s2');
    const before = sent.length;
    await reloaded.handleRelayEnvelope(message, 12);
    await Bun.sleep(30);
    expect(sent.length).toBe(before);
    expect(acked).toContain(12);
    await reloaded.close();
  });
});
