import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import {
  base64,
  browserProtocol,
  deviceId as computeDeviceId,
  encode,
  type Command,
  type RoomStatus,
  type SignedCommand,
} from '../../src/browser/protocol';
import {
  decryptRelayEnvelope,
  encryptRelayEnvelope,
  exportRawPublicKey,
  generateEncKeyPair,
  hashRosterBody,
  RELAY_MAX_FRAME_BYTES,
  sealAgentState,
  SEALED_STATE_MAX_BYTES,
  signEncBinding,
  signRoster,
  unsealAgentState,
  type RelayEnvelope,
  type RosterBody,
  type RosterEntry,
  type SignedRoster,
} from '../../src/browser/relay-crypto';
import { BrowserLobby } from './lobby';
import { browserHandler } from './http';
import {
  INBOX_TTL_MS,
  RELAY_RATE_FRAMES_PER_MIN,
  RelayService,
  type RelaySocketData,
} from './relay';
import {
  CLAUDE_CODE_ANTHROPIC_BETA,
  CLAUDE_CODE_ANTHROPIC_VERSION,
  isBlockedIp,
  parseRetryAfterMs,
  pinnedHttpRequest,
  validateWebhookUrl,
  WAKE_AGENT_HOURLY_CAP,
  WAKE_MAX_RETRY_AFTER_MS,
  WAKE_RETRY_DELAY_MS,
  WAKE_ROOM_HOURLY_CAP,
  WAKE_SENDER_HOURLY_CAP,
  WakeConnector,
  type PinnedTransportRequest,
} from './wake-connector';
import { browserConfig } from './config';
import { testDirectory } from '../test-directory';

type RelayTestDevice = {
  id: string;
  publicKey: string;
  encPublicKey: string;
  encPrivateKey: CryptoKey;
  encVersion: number;
  session: string;
  sign: (value: unknown) => Promise<string>;
  signEnc: (roomId: string, version?: number) => Promise<{ enc: string; encVersion: number; encSig: string }>;
  signed: (action: Command['action'], roomId: string, payload?: Record<string, unknown>) => Promise<SignedCommand>;
  send: (lobby: BrowserLobby, action: Command['action'], roomId: string, payload?: Record<string, unknown>) => Promise<unknown>;
  status: (lobby: BrowserLobby, roomId: string) => Promise<RoomStatus>;
  rosterEntry: (roomId: string, memberId: string, role: 'human' | 'agent', extra?: Partial<RosterEntry>) => Promise<RosterEntry>;
};

async function makeDevice(origin: string, clock: () => number = Date.now): Promise<RelayTestDevice> {
  const signKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = base64(await crypto.subtle.exportKey('raw', signKeys.publicKey));
  const id = await computeDeviceId(publicKey);
  const encKeys = await generateEncKeyPair(false);
  const encPublicKey = await exportRawPublicKey(encKeys.publicKey);
  const encVersion = 1;
  const session = crypto.randomUUID();
  const sign = async (value: unknown) =>
    base64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKeys.privateKey, encode(value)));
  const signEnc = async (roomId: string, version = encVersion) => ({
    enc: encPublicKey,
    encVersion: version,
    encSig: await signEncBinding(sign, { room: roomId, deviceId: id, enc: encPublicKey, encVersion: version }),
  });
  const signed = async (action: Command['action'], roomId: string, payload: Record<string, unknown> = {}): Promise<SignedCommand> => {
    const command: Command = { protocol: browserProtocol, origin, action, roomId, payload, id: crypto.randomUUID(), at: clock() };
    return { command, publicKey, signature: await sign(command) };
  };
  const send = (lobby: BrowserLobby, action: Command['action'], roomId: string, payload: Record<string, unknown> = {}) =>
    signed(action, roomId, payload).then(cmd => lobby.execute(cmd));
  const status = async (lobby: BrowserLobby, roomId: string) => (await send(lobby, 'status', roomId, { session })) as RoomStatus;
  const rosterEntry = async (roomId: string, memberId: string, role: 'human' | 'agent', extra: Partial<RosterEntry> = {}): Promise<RosterEntry> => {
    const encMeta = await signEnc(roomId, extra.encVersion ?? encVersion);
    return {
      id,
      sign: publicKey,
      enc: encMeta.enc,
      encVersion: encMeta.encVersion,
      encSig: encMeta.encSig,
      memberId,
      role,
      ...extra,
    };
  };
  return { id, publicKey, encPublicKey, encPrivateKey: encKeys.privateKey, encVersion, session, sign, signEnc, signed, send, status, rosterEntry };
}

async function setupRoom(lobby: BrowserLobby, origin: string, clock: () => number = Date.now) {
  const room = crypto.randomUUID();
  const host = await makeDevice(origin, clock);
  const guest = await makeDevice(origin, clock);
  const agent = await makeDevice(origin, clock);

  await host.send(lobby, 'create', room, { title: 'Relay QA', name: 'Alex', label: 'Browser', ...(await host.signEnc(room)) });
  await guest.send(lobby, 'request', room, { name: 'Sam', label: 'Laptop', kind: 'person', ...(await guest.signEnc(room)) });
  const reqId = (await host.status(lobby, room)).requests![0].id;
  await host.send(lobby, 'decide', room, { requestId: reqId, admit: true });

  const invite = (await host.send(lobby, 'agent-invite', room, { name: 'Helper' })) as { token: string };
  await agent.send(lobby, 'agent-redeem', room, { token: invite.token, label: 'Cloud Agent', ...(await agent.signEnc(room)) });

  const hostStatus = await host.status(lobby, room);
  const hostMemberId = hostStatus.memberId!;
  const guestMemberId = hostStatus.members!.find(m => m.name === 'Sam')!.id;
  const agentMemberId = hostStatus.members!.find(m => m.name === 'Helper')!.id;

  const hostEntry = await host.rosterEntry(room, hostMemberId, 'human');
  const guestEntry = await guest.rosterEntry(room, guestMemberId, 'human');
  const agentEntry = await agent.rosterEntry(room, agentMemberId, 'agent', { operatorId: hostMemberId });

  const body: RosterBody = {
    v: 1,
    room,
    version: 1,
    prev: '',
    at: clock(),
    host: host.id,
    devices: [hostEntry, guestEntry, agentEntry],
    removed: [],
  };
  const roster = await signRoster(body, host.sign);
  await host.send(lobby, 'roster-publish', room, { roster });

  return { room, host, guest, agent, hostEntry, guestEntry, agentEntry, roster };
}

async function connectWs(url: string) {
  const ws = new WebSocket(url);
  const queue: Record<string, unknown>[] = [];
  const waiters: ((msg: Record<string, unknown>) => void)[] = [];
  let closed = new Promise<{ code: number; reason: string }>(resolve => {
    ws.addEventListener('close', ev => resolve({ code: ev.code, reason: ev.reason }));
  });
  ws.addEventListener('message', ev => {
    const parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString('utf8')) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else queue.push(parsed);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('ws open failed')), { once: true });
  });
  const next = (timeoutMs = 3000) => new Promise<Record<string, unknown>>((resolve, reject) => {
    if (queue.length > 0) return resolve(queue.shift()!);
    const timer = setTimeout(() => reject(new Error('Timed out waiting for WS message')), timeoutMs);
    waiters.push(msg => { clearTimeout(timer); resolve(msg); });
  });
  const sendJson = (obj: unknown) => ws.send(JSON.stringify(obj));
  return { ws, next, sendJson, closed };
}

test('Lobby & Store persist enc keys, wakeable, host-signed roster, relayUrl, relayEnabled, and WSS CSP', async () => {
  const dir = testDirectory('relay-lobby');
  const dbPath = join(dir.path, 'admission.sqlite');
  const origin = 'http://127.0.0.1:4320';
  let lobby = new BrowserLobby(dbPath, { origin, relayUrl: 'ws://127.0.0.1:4320/api/relay/v1' });
  const relay = new RelayService({ lobby });
  try {
    const { room, host, guest, agent, hostEntry, guestEntry, agentEntry, roster } = await setupRoom(lobby, origin);
    const st = await host.status(lobby, room);
    expect(st.relayUrl).toBe('ws://127.0.0.1:4320/api/relay/v1');
    expect(st.roster).toEqual(roster);
    expect(st.devices!.find(d => d.id === host.id)).toMatchObject({ enc: host.encPublicKey, encVersion: 1 });
    expect(st.devices!.find(d => d.id === guest.id)).toMatchObject({ enc: guest.encPublicKey, encVersion: 1 });
    expect(st.devices!.find(d => d.id === agent.id)).toMatchObject({ enc: agent.encPublicKey, encVersion: 1 });

    // Non-host cannot publish an initial roster for another room.
    const room2 = crypto.randomUUID();
    await host.send(lobby, 'create', room2, { title: 'R2', name: 'Alex', label: 'B', ...(await host.signEnc(room2)) });
    await guest.send(lobby, 'request', room2, { name: 'Sam', label: 'L', kind: 'person', ...(await guest.signEnc(room2)) });
    await host.send(lobby, 'decide', room2, { requestId: (await host.status(lobby, room2)).requests![0].id, admit: true });
    const fakeBody: RosterBody = { v: 1, room: room2, version: 1, prev: '', at: Date.now(), host: guest.id, devices: [await guest.rosterEntry(room2, (await guest.status(lobby, room2)).memberId!, 'human')], removed: [] };
    await expect(guest.send(lobby, 'roster-publish', room2, { roster: await signRoster(fakeBody, guest.sign) })).rejects.toThrow('Only the host');

    // Unadmitted stranger gets 403 immediately before verifyRoster runs (even with malformed roster).
    const stranger = await makeDevice(origin);
    await expect(stranger.send(lobby, 'roster-publish', room, { roster: { bogus: true } })).rejects.toMatchObject({ status: 403 });

    // Rollback roster rejected.
    await expect(host.send(lobby, 'roster-publish', room, { roster })).rejects.toThrow(/rollback/i);

    // Monotonic v2 roster accepted.
    const v2Body: RosterBody = {
      v: 1,
      room,
      version: 2,
      prev: await hashRosterBody(roster.body),
      at: Date.now(),
      host: host.id,
      devices: [hostEntry, guestEntry, { ...agentEntry, wakeable: true }],
      removed: [],
    };
    const v2 = await signRoster(v2Body, host.sign);
    await host.send(lobby, 'roster-publish', room, { roster: v2 });
    expect((await guest.status(lobby, room)).roster).toEqual(v2);

    // Key rotation via `profile` works monotonically and rejects bad sig or version downgrade.
    const rotated = await guest.signEnc(room, 2);
    await guest.send(lobby, 'profile', room, rotated);
    expect((await host.status(lobby, room)).devices!.find(d => d.id === guest.id)?.encVersion).toBe(2);
    await expect(guest.send(lobby, 'profile', room, await guest.signEnc(room, 1))).rejects.toThrow(/backwards/i);
    await expect(guest.send(lobby, 'profile', room, { ...rotated, encVersion: 3, encSig: 'A'.repeat(88) })).rejects.toThrow(/signature/i);

    // Health advertises relayEnabled: true and CSP connect-src explicitly allows ws origin.
    const handler = browserHandler(lobby, origin, '.', { relay });
    const healthRes = await handler(new Request(`${origin}/api/lobby/health`));
    expect(await healthRes.json()).toMatchObject({ ok: true, relayEnabled: true });
    expect(healthRes.headers.get('content-security-policy')).toContain(`connect-src 'self' ws://127.0.0.1:4320`);

    // Roster and enc keys survive restart.
    relay.close();
    lobby.close();
    lobby = new BrowserLobby(dbPath, { origin });
    const afterRestart = await host.status(lobby, room);
    expect(afterRestart.roster).toEqual(v2);
    expect(afterRestart.devices!.find(d => d.id === guest.id)?.encVersion).toBe(2);
  } finally {
    lobby.close();
    dir.cleanup();
  }
});

test('WSS challenge-response auth, live E2E delivery, session replacement, and auth timeout', async () => {
  const lobby = new BrowserLobby(':memory:', { origin: 'http://127.0.0.1:0' });
  let origin = '';
  let relay!: RelayService;
  let server!: ReturnType<typeof Bun.serve<RelaySocketData>>;

  // Spin up on ephemeral loopback port first, then construct lobby with exact origin.
  lobby.close();
  server = Bun.serve<RelaySocketData>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req, srv) => handler(req, srv.requestIP(req)?.address || '127.0.0.1', (r, d) => srv.upgrade(r, { data: d })),
    websocket: {
      open: ws => relay.websocket.open!(ws),
      message: (ws, m) => relay.websocket.message!(ws, m),
      drain: ws => relay.websocket.drain!(ws),
      close: (ws, c, r) => relay.websocket.close!(ws, c, r),
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  const wsUrl = `ws://127.0.0.1:${server.port}/api/relay/v1`;
  const realLobby = new BrowserLobby(':memory:', { origin });
  relay = new RelayService({ lobby: realLobby, authTimeoutMs: 120, heartbeatMs: 60_000 });
  const handler = browserHandler(realLobby, origin, '.', { relay });

  try {
    const { room, host, guest, guestEntry } = await setupRoom(realLobby, origin);

    // 1. Auth timeout closes unauthenticated socket with 4001.
    const timedOut = await connectWs(wsUrl);
    const chTimeout = await timedOut.next();
    expect(chTimeout.t).toBe('challenge');
    const errTimeout = await timedOut.next();
    expect(errTimeout).toMatchObject({ t: 'error', code: 'auth-timeout' });
    expect((await timedOut.closed).code).toBe(4001);

    // 2. Unadmitted stranger rejected with 4003.
    const stranger = await makeDevice(origin);
    const strangerWs = await connectWs(wsUrl);
    const strangerCh = await strangerWs.next();
    strangerWs.sendJson({ t: 'auth', signed: await stranger.signed('relay-open', room, { nonce: strangerCh.nonce, session: stranger.session }) });
    expect(await strangerWs.next()).toMatchObject({ t: 'error', code: 'forbidden' });
    expect((await strangerWs.closed).code).toBe(4003);

    // 3. Wrong nonce rejected and single-use nonce cannot be retried on same socket.
    const badNonceWs = await connectWs(wsUrl);
    await badNonceWs.next();
    badNonceWs.sendJson({ t: 'auth', signed: await host.signed('relay-open', room, { nonce: '0'.repeat(64), session: host.session }) });
    expect(await badNonceWs.next()).toMatchObject({ t: 'error' });
    expect((await badNonceWs.closed).code).toBe(4001);

    // 4. Authenticated host & guest exchange an E2E encrypted envelope.
    const hostWs = await connectWs(wsUrl);
    const hostCh = await hostWs.next();
    hostWs.sendJson({ t: 'auth', signed: await host.signed('relay-open', room, { nonce: hostCh.nonce, session: host.session, rosterVersion: 1 }) });
    expect(await hostWs.next()).toMatchObject({ t: 'ready', roomId: room, deviceId: host.id, rosterVersion: 1 });

    const guestWs = await connectWs(wsUrl);
    const guestCh = await guestWs.next();
    guestWs.sendJson({ t: 'auth', signed: await guest.signed('relay-open', room, { nonce: guestCh.nonce, session: guest.session, rosterVersion: 1 }) });
    expect(await guestWs.next()).toMatchObject({ t: 'ready', roomId: room, deviceId: guest.id });

    const env = await encryptRelayEnvelope({ kind: 'message', text: 'secret hello over wss' }, {
      room,
      from: host.id,
      sign: host.sign,
      id: crypto.randomUUID(),
      seq: 1,
      rosterVersion: 1,
      lane: 'primary',
      recipients: [guestEntry],
    });
    hostWs.sendJson({ t: 'frame', envelope: env });
    expect(await hostWs.next()).toEqual({ t: 'accepted', id: env.id });

    const delivered = await guestWs.next();
    expect(delivered.t).toBe('frame');
    const decrypted = await decryptRelayEnvelope<{ kind: string; text: string }>(delivered.envelope, {
      room,
      senderSignKey: host.publicKey,
      selfDeviceId: guest.id,
      selfEncPrivateKey: guest.encPrivateKey,
      selfEncVersion: guest.encVersion,
    });
    expect(decrypted.packet).toEqual({ kind: 'message', text: 'secret hello over wss' });

    // 5. Second auth for same (room, device) cleanly replaces old socket (4009).
    const hostWs2 = await connectWs(wsUrl);
    const hostCh2 = await hostWs2.next();
    hostWs2.sendJson({ t: 'auth', signed: await host.signed('relay-open', room, { nonce: hostCh2.nonce, session: crypto.randomUUID() }) });
    expect(await hostWs2.next()).toMatchObject({ t: 'ready', deviceId: host.id });
    expect(await hostWs.next()).toMatchObject({ t: 'error', code: 'session-replaced' });
    expect((await hostWs.closed).code).toBe(4009);

    hostWs2.ws.close();
    guestWs.ws.close();
  } finally {
    relay.close();
    server.stop(true);
    realLobby.close();
  }
});

test('a socket that watches its room gets status pushed: at once, on changes, a signal to its recipient, without it once acked, on refresh; it stays online without polling, and drops out once quiet', async () => {
  let relay!: RelayService;
  let handler!: ReturnType<typeof browserHandler>;
  const server = Bun.serve<RelaySocketData>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req, srv) => handler(req, srv.requestIP(req)?.address || '127.0.0.1', (r, d) => srv.upgrade(r, { data: d })),
    websocket: {
      open: ws => relay.websocket.open!(ws),
      message: (ws, m) => relay.websocket.message!(ws, m),
      drain: ws => relay.websocket.drain!(ws),
      close: (ws, c, r) => relay.websocket.close!(ws, c, r),
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const wsUrl = `ws://127.0.0.1:${server.port}/api/relay/v1`;
  // The room service's and the relay's clock: moved by the test, so presence windows pass in an instant.
  let now = Date.now();
  const clock = () => now;
  const lobby = new BrowserLobby(':memory:', { origin, now: clock });
  relay = new RelayService({ lobby, heartbeatMs: 60_000, statusRefreshMs: 300, now: clock });
  handler = browserHandler(lobby, origin, '.', { relay });
  const open = async (device: RelayTestDevice, room: string) => {
    const socket = await connectWs(wsUrl);
    const challenge = await socket.next();
    socket.sendJson({ t: 'auth', signed: await device.signed('relay-open', room, { nonce: challenge.nonce, session: crypto.randomUUID(), rosterVersion: 1 }) });
    const ready = await socket.next();
    // The service says it pushes status, so a client knows to watch instead of polling.
    expect(ready).toMatchObject({ t: 'ready', status: true });
    /** The next pushed status that passes `test`, skipping others (refreshes, pongs). */
    const status = async (test: (status: RoomStatus) => boolean = () => true, timeoutMs = 3000) => {
      for (const by = Date.now() + timeoutMs; ;) {
        const message = await socket.next(Math.max(1, by - Date.now()));
        if (message.t === 'status' && test(message.status as RoomStatus)) return message.status as RoomStatus;
      }
    };
    return { ...socket, status };
  };
  try {
    const { room, host, guest } = await setupRoom(lobby, origin, clock);
    const hostWs = await open(host, room), guestWs = await open(guest, room);

    // Watching answers at once, as a status poll would, with the device's own session.
    guestWs.sendJson({ t: 'status-watch', session: guest.session, cursor: 0 });
    const first = await guestWs.status();
    expect(first.memberId).toBeTruthy();
    expect(first.devices!.find(d => d.id === guest.id)!.session).toBe(guest.session);
    hostWs.sendJson({ t: 'status-watch', session: host.session, cursor: 0 });
    await hostWs.status();

    // A change in the room reaches the watcher it concerns without a poll.
    await host.send(lobby, 'agent-invite', room, { name: 'Scout' });
    expect((await hostWs.status(s => !!s.agentInvites?.some(i => i.name === 'Scout'))).agentInvites).toBeTruthy();

    // A signal is pushed to its recipient. The guest is online for the host through its pushes alone.
    const offer = { type: 'offer' as const, sdp: 'v=0 offer for the guest' };
    await host.send(lobby, 'signal', room, { to: guest.id, session: host.session, targetSession: guest.session, description: offer });
    const signalled = await guestWs.status(s => (s.signals ?? []).length > 0);
    expect(signalled.signals!.map(s => s.description)).toEqual([offer]);
    const seq = signalled.signals![0].seq;

    // Once acknowledged, pushes leave it out (the refresh brings one without any change).
    guestWs.sendJson({ t: 'status-ack', cursor: seq, epoch: signalled.epoch });
    await guestWs.status(s => !(s.signals ?? []).length, 3000);

    // 45 s of the room's time with no status poll from the guest: it stays online for the host from the pushes alone,
    // while it still talks (a heartbeat ping each time).
    for (let i = 0; i < 3; i++) {
      now += 15_000;
      guestWs.sendJson({ t: 'ping' });
      await guestWs.status();
    }
    const guestSession = async () => (await host.status(lobby, room)).devices!.find(d => d.id === guest.id)!.session;
    expect(await guestSession()).toBe(guest.session);
    // A client silent for over a minute gets no refresh, so it drops out of the room as it would without pushes.
    now += 61_000;
    await Bun.sleep(700);
    expect(await guestSession()).toBeUndefined();

    // A watch that isn't one is refused, and so is a second watch on the same socket.
    guestWs.sendJson({ t: 'status-watch', session: 'not-a-uuid' });
    for (;;) { const m = await guestWs.next(); if (m.t === 'error') { expect(m.code).toBe('invalid-watch'); break; } }
    guestWs.sendJson({ t: 'status-watch', session: crypto.randomUUID(), cursor: 0 });
    for (;;) { const m = await guestWs.next(); if (m.t === 'error') { expect(m.code).toBe('already-watching'); break; } }
    guestWs.sendJson({ t: 'status-unwatch' });
    await Bun.sleep(100);
    const after: Record<string, unknown>[] = [];
    const drain = (async () => { try { for (;;) after.push(await guestWs.next(1000)); } catch { /* quiet */ } })();
    await drain;
    expect(after.filter(m => m.t === 'status').length).toBeLessThanOrEqual(1);

    hostWs.ws.close();
    guestWs.ws.close();
  } finally {
    relay.close();
    server.stop(true);
    lobby.close();
  }
});

test('Relay rejects replay, cross-room, spoofed from, reflection, non-increasing seq, oversize, unadmitted recipient, and rate limits', async () => {
  const origin = 'http://127.0.0.1:4320';
  let now = Date.now();
  const lobby = new BrowserLobby(':memory:', { origin, now: () => now });
  const relay = new RelayService({ lobby, now: () => now });
  try {
    const { room, host, guest, guestEntry } = await setupRoom(lobby, origin, () => now);
    const stranger = await makeDevice(origin, () => now);

    const open = (await relay.handleHttp('/api/relay/v1/open', await host.signed('relay-open', room, { session: host.session }))) as { session: string };

    const env1 = await encryptRelayEnvelope({ n: 1 }, {
      room, from: host.id, id: crypto.randomUUID(), seq: 1, rosterVersion: 1, lane: 'primary', recipients: [guestEntry],
      sign: host.sign,
    });
    // Cross-room
    const crossRoom: RelayEnvelope = { ...env1, id: crypto.randomUUID(), room: crypto.randomUUID() };
    // Sender mismatch
    const spoofedFrom: RelayEnvelope = { ...env1, id: crypto.randomUUID(), from: guest.id };
    // Reflected
    const reflected: RelayEnvelope = { ...env1, id: crypto.randomUUID(), to: { [host.id]: env1.to[guest.id] } };
    // Unadmitted recipient
    const badRecipient: RelayEnvelope = { ...env1, id: crypto.randomUUID(), to: { [stranger.id]: env1.to[guest.id] } };
    // Oversize > 32 KB
    const oversize: RelayEnvelope = { ...env1, id: crypto.randomUUID(), ct: 'A'.repeat(RELAY_MAX_FRAME_BYTES + 100) };

    const res = (await relay.handleHttp('/api/relay/v1/send', await host.signed('relay-send', room, {
      session: open.session,
      envelopes: [crossRoom, spoofedFrom, reflected, badRecipient, oversize, env1],
    }))) as { accepted: string[]; rejected: { id: string; reason: string }[] };

    expect(res.accepted).toEqual([env1.id]);
    expect(res.rejected).toEqual([
      { id: crossRoom.id, reason: 'cross-room' },
      { id: spoofedFrom.id, reason: 'sender-mismatch' },
      { id: reflected.id, reason: 'reflected' },
      { id: badRecipient.id, reason: 'recipient-not-admitted' },
      { id: oversize.id, reason: 'frame-too-large' },
    ]);

    // Same seq rejected (seq-out-of-order)
    const sameSeq = await encryptRelayEnvelope({ n: 2 }, {
      room, from: host.id, id: crypto.randomUUID(), seq: 1, rosterVersion: 1, lane: 'primary', recipients: [guestEntry],
      sign: host.sign,
    });
    // Replay same id with higher seq rejected (duplicate)
    const dupId: RelayEnvelope = { ...env1, seq: 2 };
    const res2 = (await relay.handleHttp('/api/relay/v1/send', await host.signed('relay-send', room, {
      session: open.session,
      envelopes: [sameSeq, dupId, env1],
    }))) as { accepted: string[]; rejected: { id: string; reason: string }[] };
    expect(res2.accepted).toEqual([]);
    expect(res2.rejected).toEqual([
      { id: sameSeq.id, reason: 'seq-out-of-order' },
      { id: dupId.id, reason: 'duplicate' },
      // An exact replay (same id AND same stale seq) is a duplicate, never reported as an ordering problem.
      { id: env1.id, reason: 'duplicate' },
    ]);

    // An envelope without the sender's signature is not a valid envelope at all.
    const { sig: _sig, ...unsignedEnvelope } = { ...env1, id: crypto.randomUUID(), seq: 50 };
    const unsignedRes = (await relay.handleHttp('/api/relay/v1/send', await host.signed('relay-send', room, {
      session: open.session,
      envelopes: [unsignedEnvelope],
    }))) as { accepted: string[]; rejected: { id: string; reason: string }[] };
    expect(unsignedRes.accepted).toEqual([]);
    expect(unsignedRes.rejected).toEqual([{ id: unsignedEnvelope.id, reason: 'invalid-envelope' }]);

    // Rate limit: 120 frames/min (already used 1 -> next 119 succeed, 121st rejected).
    let seq = 2;
    for (let i = 0; i < RELAY_RATE_FRAMES_PER_MIN - 1; i++) {
      const e = await encryptRelayEnvelope({ i }, {
        room, from: host.id, id: crypto.randomUUID(), seq: seq++, rosterVersion: 1, lane: 'primary', recipients: [guestEntry],
        sign: host.sign,
      });
      const r = (await relay.handleHttp('/api/relay/v1/send', await host.signed('relay-send', room, { session: open.session, envelopes: [e] }))) as { accepted: string[] };
      expect(r.accepted).toEqual([e.id]);
    }
    const overLimit = await encryptRelayEnvelope({ over: true }, {
      room, from: host.id, id: crypto.randomUUID(), seq: seq++, rosterVersion: 1, lane: 'primary', recipients: [guestEntry],
      sign: host.sign,
    });
    const overRes = (await relay.handleHttp('/api/relay/v1/send', await host.signed('relay-send', room, { session: open.session, envelopes: [overLimit] }))) as { rejected: { id: string; reason: string }[] };
    expect(overRes.rejected).toEqual([{ id: overLimit.id, reason: 'rate-limit' }]);

    // After 60s window expires, frames succeed again; byte rate limit (2 MB/min) also enforced.
    now += 61_000;
    const byteRelay = new RelayService({ lobby, now: () => now, rateBytesPerMin: 8_000 });
    try {
      const s = crypto.randomUUID();
      await byteRelay.handleHttp('/api/relay/v1/open', await host.signed('relay-open', room, { session: s }));
      const big1 = await encryptRelayEnvelope({ data: 'x'.repeat(2000) }, {
        room, from: host.id, id: crypto.randomUUID(), seq: 1, rosterVersion: 1, lane: 'primary', recipients: [guestEntry],
        sign: host.sign,
      });
      const big2 = await encryptRelayEnvelope({ data: 'y'.repeat(2000) }, {
        room, from: host.id, id: crypto.randomUUID(), seq: 2, rosterVersion: 1, lane: 'primary', recipients: [guestEntry],
        sign: host.sign,
      });
      const br = (await byteRelay.handleHttp('/api/relay/v1/send', await host.signed('relay-send', room, { session: s, envelopes: [big1, big2] }))) as { accepted: string[]; rejected: { id: string; reason: string }[] };
      expect(br.accepted).toEqual([big1.id]);
      expect(br.rejected).toEqual([{ id: big2.id, reason: 'rate-limit' }]);
    } finally {
      byteRelay.close();
    }
  } finally {
    relay.close();
    lobby.close();
  }
});

test('HTTPS fallback open/send/poll/state/wake-register, body limits, long-poll wakeup, and between-poll delivery', async () => {
  const origin = 'http://127.0.0.1:4320';
  const lobby = new BrowserLobby(':memory:', { origin });
  const wakeConnector = new WakeConnector({ allowLoopbackHttp: true });
  const relay = new RelayService({ lobby, wakeConnector });
  const handler = browserHandler(lobby, origin, '.', { relay });

  const post = (path: string, body: unknown) => handler(new Request(`${origin}${path}`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));

  try {
    const { room, host, guest, agent, guestEntry } = await setupRoom(lobby, origin);

    // Body limits: /send rejects > 64 KB with 413; /state rejects > 300 KB with 413.
    expect((await post('/api/relay/v1/send', ' '.repeat(65 * 1024))).status).toBe(413);
    expect((await post('/api/relay/v1/state', ' '.repeat(301 * 1024))).status).toBe(413);
    // Wrong origin rejected with 403.
    expect((await handler(new Request(`${origin}/api/relay/v1/open`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' }))).status).toBe(403);

    // Open HTTPS sessions for host and non-wakeable guest.
    const hostOpen = await (await post('/api/relay/v1/open', await host.signed('relay-open', room, { session: host.session }))).json() as { session: string; rosterVersion: number };
    expect(hostOpen.rosterVersion).toBe(1);
    const guestOpen = await (await post('/api/relay/v1/open', await guest.signed('relay-open', room, { session: guest.session }))).json() as { session: string };

    // 1. Live long-poll wakes immediately when a frame arrives.
    const pollPromise = post('/api/relay/v1/poll', await guest.signed('relay-poll', room, { session: guestOpen.session, waitSeconds: 5 }));
    await new Promise(r => setTimeout(r, 15));
    const env1 = await encryptRelayEnvelope({ msg: 'live-long-poll' }, {
      room, from: host.id, id: crypto.randomUUID(), seq: 1, rosterVersion: 1, lane: 'primary', recipients: [guestEntry],
      sign: host.sign,
    });
    const sendRes = await (await post('/api/relay/v1/send', await host.signed('relay-send', room, { session: hostOpen.session, envelopes: [env1] }))).json() as { accepted: string[] };
    expect(sendRes.accepted).toEqual([env1.id]);

    const polled = await (await pollPromise).json() as { frames: { cursor: number; envelope: RelayEnvelope }[] };
    expect(polled.frames).toHaveLength(1);
    expect((await decryptRelayEnvelope(polled.frames[0].envelope, { room, senderSignKey: host.publicKey, selfDeviceId: guest.id, selfEncPrivateKey: guest.encPrivateKey, selfEncVersion: 1 })).packet).toEqual({ msg: 'live-long-poll' });

    // 2. Frame sent between two consecutive polls is queued ephemerally (primary before file) with zero loss!
    const fileEnv = await encryptRelayEnvelope({ chunk: 'file-data' }, {
      room, from: host.id, id: crypto.randomUUID(), seq: 2, rosterVersion: 1, lane: 'file', recipients: [guestEntry],
      sign: host.sign,
    });
    const chatEnv = await encryptRelayEnvelope({ chat: 'priority-first' }, {
      room, from: host.id, id: crypto.randomUUID(), seq: 3, rosterVersion: 1, lane: 'primary', recipients: [guestEntry],
      sign: host.sign,
    });
    await post('/api/relay/v1/send', await host.signed('relay-send', room, { session: hostOpen.session, envelopes: [fileEnv, chatEnv] }));
    const betweenPolled = await (await post('/api/relay/v1/poll', await guest.signed('relay-poll', room, { session: guestOpen.session, waitSeconds: 0 }))).json() as { frames: { envelope: RelayEnvelope }[] };
    expect(betweenPolled.frames.map(f => f.envelope.id)).toEqual([chatEnv.id, fileEnv.id]);

    // 3. Sealed state put / get / oversize / delete.
    const emptyState = await (await post('/api/relay/v1/state', await agent.signed('relay-state-get', room, {}))).json() as { state: string | null; updatedAt: number | null };
    expect(emptyState).toEqual({ state: null, updatedAt: null });

    const sealed = await sealAgentState({ cursor: 42, rosterVersion: 1 }, agent.encPrivateKey, { room, deviceId: agent.id });
    const putRes = await (await post('/api/relay/v1/state', await agent.signed('relay-state-put', room, { state: sealed }))).json() as { state: string; updatedAt: number };
    expect(putRes.state).toBe(sealed);
    expect(typeof putRes.updatedAt).toBe('number');

    const getRes = await (await post('/api/relay/v1/state', await agent.signed('relay-state-get', room, {}))).json() as { state: string };
    expect(await unsealAgentState(getRes.state, agent.encPrivateKey, { room, deviceId: agent.id })).toEqual({ cursor: 42, rosterVersion: 1 });

    // Oversized state (> 256 KB) rejected with 413.
    const tooBig = 'A'.repeat(SEALED_STATE_MAX_BYTES + 4);
    expect((await post('/api/relay/v1/state', await agent.signed('relay-state-put', room, { state: tooBig }))).status).toBe(413);

    // Clear state with null.
    expect(await (await post('/api/relay/v1/state', await agent.signed('relay-state-put', room, { state: null }))).json()).toEqual({ state: null, updatedAt: null });

    // 4. Wake register & unregister via HTTPS + 60s SignedCommand replay rejection (409).
    const regCmd = await agent.signed('relay-wake-register', room, { url: 'http://127.0.0.1:9999/wake', key: 'secret-token' });
    const reg = await (await post('/api/relay/v1/wake-register', regCmd)).json() as { inboxId: string; wakeable: boolean };
    expect(reg.wakeable).toBe(true);
    expect(reg.inboxId).toMatch(/^[a-f0-9]{32}$/);
    expect(lobby.isWakeableDevice(room, agent.id)).toBe(true);
    // Replaying the exact same signed command within ±60s is rejected with 409.
    expect((await post('/api/relay/v1/wake-register', regCmd)).status).toBe(409);

    const stateCmd = await agent.signed('relay-state-put', room, { state: sealed });
    expect((await post('/api/relay/v1/state', stateCmd)).status).toBe(200);
    expect((await post('/api/relay/v1/state', stateCmd)).status).toBe(409);

    const unreg = await (await post('/api/relay/v1/wake-register', await agent.signed('relay-wake-register', room, { url: null }))).json() as { inboxId: null; wakeable: boolean };
    expect(unreg).toEqual({ inboxId: null, wakeable: false });
    expect(lobby.isWakeableDevice(room, agent.id)).toBe(false);

    // 5. Per-address rate limit gates /api/relay/v1 and /api/relay/v1/* (429 when exceeded).
    const tightHandler = browserHandler(lobby, origin, '.', { relay, apiLimit: 2 });
    const rlAddr = '198.51.100.77';
    expect((await tightHandler(new Request(`${origin}/api/relay/v1`), rlAddr)).status).toBe(426);
    expect((await tightHandler(new Request(`${origin}/api/relay/v1/open`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' }), rlAddr)).status).toBe(400);
    const refused = await tightHandler(new Request(`${origin}/api/relay/v1`), rlAddr);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('5');
    expect((await tightHandler(new Request(`${origin}/api/relay/v1/state`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' }), rlAddr)).status).toBe(429);
  } finally {
    relay.close();
    wakeConnector.close();
    lobby.close();
  }
});

test('Bounded ciphertext inbox: non-wakeable gets no inbox, wakeable 500-frame / byte / room eviction, 72h TTL, and agent->offline-human hold', async () => {
  const origin = 'http://127.0.0.1:4320';
  let now = Date.now();
  const lobby = new BrowserLobby(':memory:', { origin, now: () => now });
  const wakeConnector = new WakeConnector({ allowLoopbackHttp: true, now: () => now, fetch: async () => new Response('ok', { status: 200 }) });
  const relay = new RelayService({
    lobby,
    wakeConnector,
    now: () => now,
    rateFramesPerMin: 2000,
    rateBytesPerMin: 64 * 1024 * 1024,
  });

  try {
    const { room, host, guest, agent, hostEntry, guestEntry, agentEntry } = await setupRoom(lobby, origin, () => now);
    const hostSess = crypto.randomUUID();
    await relay.handleHttp('/api/relay/v1/open', await host.signed('relay-open', room, { session: hostSess }));

    // 1. Non-wakeable offline guest with non-wakeable host gets NO inbox even with hold: true.
    const toNonWakeable = await encryptRelayEnvelope({ n: 'dropped' }, {
      room, from: host.id, id: crypto.randomUUID(), seq: 1, rosterVersion: 1, lane: 'primary', recipients: [guestEntry], hold: true,
      sign: host.sign,
    });
    await relay.handleHttp('/api/relay/v1/send', await host.signed('relay-send', room, { session: hostSess, envelopes: [toNonWakeable] }));
    expect(relay.inboxStats(room, guest.id)).toEqual({ count: 0, bytes: 0 });

    // 2. Register agent as wakeable.
    await relay.handleHttp('/api/relay/v1/wake-register', await agent.signed('relay-wake-register', room, { url: 'http://127.0.0.1:9999/wake', key: 'tok' }));

    // 2b. Frame with wake: [agent.id] WITHOUT hold: true must NOT fire a wake for an empty inbox.
    const wakeFires: number[] = [];
    const emptyWakeConn = new WakeConnector({ allowLoopbackHttp: true, now: () => now, fetch: async () => { wakeFires.push(1); return new Response('ok', { status: 200 }); } });
    const emptyWakeRelay = new RelayService({ lobby, wakeConnector: emptyWakeConn, now: () => now });
    try {
      emptyWakeConn.register(room, agent.id, 'http://127.0.0.1:9999/wake', 'tok');
      const noHoldEnv = await encryptRelayEnvelope({ noHold: true }, {
        room, from: host.id, id: crypto.randomUUID(), seq: 1, rosterVersion: 1, lane: 'primary', recipients: [agentEntry], wake: [agent.id],
        sign: host.sign,
      });
      await emptyWakeRelay.handleHttp('/api/relay/v1/send', await host.signed('relay-send', room, { session: crypto.randomUUID(), envelopes: [noHoldEnv] }));
      await new Promise(r => setTimeout(r, 15));
      expect(emptyWakeRelay.inboxStats(room, agent.id).count).toBe(0);
      expect(wakeFires).toHaveLength(0);
    } finally {
      emptyWakeRelay.close();
      emptyWakeConn.close();
    }

    // 3. Wakeable agent sending hold: true to offline non-wakeable host IS held in host's inbox (Section 6.2).
    const agentSess = crypto.randomUUID();
    const fromAgent = await encryptRelayEnvelope({ reply: 'while human offline' }, {
      room, from: agent.id, id: crypto.randomUUID(), seq: 1, rosterVersion: 1, lane: 'primary', recipients: [guestEntry], hold: true,
      sign: agent.sign,
    });
    await relay.handleHttp('/api/relay/v1/send', await agent.signed('relay-send', room, { session: agentSess, envelopes: [fromAgent] }));
    expect(relay.inboxStats(room, guest.id).count).toBe(1);
    const guestDrain = (await relay.handleHttp('/api/relay/v1/poll', await guest.signed('relay-poll', room, { session: guest.session }))) as { frames: { cursor: number; envelope: RelayEnvelope }[]; cursor: number };
    expect(guestDrain.frames).toHaveLength(1);
    expect(guestDrain.frames[0].envelope.id).toBe(fromAgent.id);
    // ackCursor deletes inbox entries <= cursor.
    await relay.handleHttp('/api/relay/v1/poll', await guest.signed('relay-poll', room, { session: guest.session, ackCursor: guestDrain.cursor }));
    expect(relay.inboxStats(room, guest.id).count).toBe(0);

    // 4. 500-frame cap on wakeable agent: send 505 frames -> oldest 5 evicted, newest 500 retained.
    const sentIds: string[] = [];
    for (let i = 0; i < 505; i++) {
      const e = await encryptRelayEnvelope({ idx: i }, {
        room, from: host.id, id: crypto.randomUUID(), seq: 2 + i, rosterVersion: 1, lane: 'primary', recipients: [agentEntry], hold: true,
        sign: host.sign,
      });
      sentIds.push(e.id);
      await relay.handleHttp('/api/relay/v1/send', await host.signed('relay-send', room, { session: hostSess, envelopes: [e] }));
    }
    expect(relay.inboxStats(room, agent.id).count).toBe(500);
    const drained500 = (await relay.handleHttp('/api/relay/v1/poll', await agent.signed('relay-poll', room, { session: agent.session }))) as { frames: { envelope: RelayEnvelope }[]; cursor: number };
    expect(drained500.frames).toHaveLength(500);
    expect(drained500.frames[0].envelope.id).toBe(sentIds[5]);
    expect(drained500.frames[499].envelope.id).toBe(sentIds[504]);
    await relay.handleHttp('/api/relay/v1/poll', await agent.signed('relay-poll', room, { session: agent.session, ackCursor: drained500.cursor }));

    // 5. 72h TTL expiry.
    const ttlEnv = await encryptRelayEnvelope({ ttl: true }, {
      room, from: host.id, id: crypto.randomUUID(), seq: 600, rosterVersion: 1, lane: 'primary', recipients: [agentEntry], hold: true,
      sign: host.sign,
    });
    await relay.handleHttp('/api/relay/v1/send', await host.signed('relay-send', room, { session: hostSess, envelopes: [ttlEnv] }));
    expect(relay.inboxStats(room, agent.id).count).toBe(1);
    now += INBOX_TTL_MS + 1;
    expect(relay.inboxStats(room, agent.id).count).toBe(0);

    // 6. Byte cap eviction (per-device 8 MB and per-room 32 MB verified with exact small caps on a dedicated RelayService).
    const smallRelay = new RelayService({
      lobby,
      wakeConnector,
      now: () => now,
      inboxMaxBytes: 4_500,
      inboxMaxRoomBytes: 6_000,
    });
    try {
      const s2 = crypto.randomUUID();
      const ids: string[] = [];
      for (let i = 1; i <= 4; i++) {
        const e = await encryptRelayEnvelope({ n: i }, {
          room, from: host.id, id: crypto.randomUUID(), seq: i, rosterVersion: 1, lane: 'primary', recipients: [agentEntry], hold: true,
          sign: host.sign,
        });
        ids.push(e.id);
        await smallRelay.handleHttp('/api/relay/v1/send', await host.signed('relay-send', room, { session: s2, envelopes: [e] }));
      }
      // Each ~1.9 KB frame: max 2 fit in 4500 bytes -> oldest 2 evicted, newest 2 kept.
      const polled = (await smallRelay.handleHttp('/api/relay/v1/poll', await agent.signed('relay-poll', room, { session: agent.session }))) as { frames: { envelope: RelayEnvelope }[] };
      expect(polled.frames.map(f => f.envelope.id)).toEqual(ids.slice(-2));
      expect(smallRelay.inboxStats(room, agent.id).bytes).toBeLessThanOrEqual(4_500);
    } finally {
      smallRelay.close();
    }
    void hostEntry;
  } finally {
    relay.close();
    wakeConnector.close();
    lobby.close();
  }
});

test('Wake noise: unaddressed chatter never wakes and is evicted first, addressed frames survive a full inbox, and the wake counts only addressed frames and names the room', async () => {
  const origin = 'http://127.0.0.1:4321';
  const now = Date.now();
  const lobby = new BrowserLobby(':memory:', { origin, now: () => now });
  const hooks: { body: { room: string; count: number } }[] = [];
  const wakeConnector = new WakeConnector({
    allowLoopbackHttp: true, now: () => now,
    fetch: async (_url, init) => { hooks.push({ body: JSON.parse(String(init?.body)) }); return new Response('ok', { status: 200 }); },
  });
  const relay = new RelayService({ lobby, wakeConnector, now: () => now, rateFramesPerMin: 5000, rateBytesPerMin: 64 * 1024 * 1024, inboxMaxFrames: 20 });
  try {
    const { room, host, agent, agentEntry } = await setupRoom(lobby, origin, () => now);
    const hostSess = crypto.randomUUID();
    await relay.handleHttp('/api/relay/v1/open', await host.signed('relay-open', room, { session: hostSess }));
    await relay.handleHttp('/api/relay/v1/wake-register', await agent.signed('relay-wake-register', room, { url: 'http://127.0.0.1:9999/wake', key: 'tok' }));
    let seq = 1;
    const send = async (addressed: boolean) => {
      const e = await encryptRelayEnvelope({ n: seq }, {
        room, from: host.id, id: crypto.randomUUID(), seq: seq++, rosterVersion: 1, lane: 'primary', recipients: [agentEntry], hold: true,
        ...(addressed ? { wake: [agent.id] } : {}), sign: host.sign,
      });
      await relay.handleHttp('/api/relay/v1/send', await host.signed('relay-send', room, { session: hostSess, envelopes: [e] }));
      return e.id;
    };
    // Room chatter that addresses nobody is held for the agent but wakes nothing.
    for (let i = 0; i < 12; i++) await send(false);
    await new Promise(r => setTimeout(r, 15));
    expect(hooks).toHaveLength(0);
    expect(relay.inboxStats(room, agent.id).count).toBe(12);

    // The first addressed frame wakes once; the count is the addressed frames waiting (1), not the inbox size (13).
    const firstAddressed = await send(true);
    await new Promise(r => setTimeout(r, 15));
    expect(hooks).toHaveLength(1);
    expect(hooks[0].body).toMatchObject({ source: 'meshrooms', event: 'room-has-work', room, count: 1 });

    // More addressed frames inside the coalescing window do not wake again.
    const addressed = [firstAddressed, await send(true), await send(true)];
    await new Promise(r => setTimeout(r, 15));
    expect(hooks).toHaveLength(1);

    // A flood of chatter fills the 20-frame inbox many times over: it never crowds the addressed frames out.
    for (let i = 0; i < 60; i++) await send(false);
    expect(relay.inboxStats(room, agent.id).count).toBe(20);
    const polled = (await relay.handleHttp('/api/relay/v1/poll', await agent.signed('relay-poll', room, { session: agent.session }))) as { frames: { envelope: RelayEnvelope }[]; cursor: number };
    const kept = polled.frames.map(f => f.envelope.id);
    for (const id of addressed) expect(kept).toContain(id);
    expect(polled.frames).toHaveLength(20);

    // Acknowledging the read drains the inbox: the next frame starts again from one, not from a stuck full inbox.
    await relay.handleHttp('/api/relay/v1/poll', await agent.signed('relay-poll', room, { session: agent.session, ackCursor: polled.cursor }));
    expect(relay.inboxStats(room, agent.id).count).toBe(0);
  } finally {
    relay.close();
    wakeConnector.close();
    lobby.close();
  }
});

test('WakeConnector: AES-GCM encryption at rest, SSRF guard, content-free body, coalescing, retries, and room/agent/sender hourly caps', async () => {
  const dir = testDirectory('wake-connector');
  const dbPath = join(dir.path, 'wake.sqlite');
  let now = Date.now();
  const sleeps: number[] = [];
  const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  let nextStatuses: number[] = [];

  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get('authorization'), body: JSON.parse(String(init?.body)) });
    const status = nextStatuses.shift() ?? 200;
    return new Response('ok', { status });
  }) as unknown as typeof globalThis.fetch;

  const connector = new WakeConnector({
    dbPath,
    secret: 'test-server-master-secret',
    now: () => now,
    fetch: mockFetch,
    sleep: async ms => { sleeps.push(ms); },
    lookup: async host => host === 'rebind.example' ? ['169.254.169.254'] : ['93.184.216.34'],
    allowLoopbackHttp: false,
    hostAllowlist: ['hooks.example.com', 'rebind.example'],
  });

  try {
    // 1. SSRF validation & fail-closed default allowlist in production mode.
    expect(() => validateWebhookUrl('https://hooks.example.com/wake')).toThrow(/MESHROOMS_WAKE_ALLOWLIST/);
    expect(() => validateWebhookUrl('http://hooks.example/wake', { hostAllowlist: ['hooks.example'] })).toThrow(/HTTPS/);
    expect(() => validateWebhookUrl('http://127.0.0.1:4320/wake', { hostAllowlist: ['127.0.0.1'] })).toThrow(/HTTPS/);
    expect(() => validateWebhookUrl('https://127.0.0.1/wake', { hostAllowlist: ['127.0.0.1'] })).toThrow(/private|link-local|local/i);
    expect(() => validateWebhookUrl('https://169.254.169.254/latest/meta-data', { hostAllowlist: ['169.254.169.254'] })).toThrow(/private|link-local/i);
    const rfc1918A = [10, 0, 0, 5].join('.');
    const rfc1918C = [192, 168, 1, 1].join('.');
    const mdnsHost = ['foo', 'local'].join('.');
    const corpHost = ['bar', 'internal'].join('.');
    expect(() => validateWebhookUrl(`https://${rfc1918A}/hook`, { hostAllowlist: [rfc1918A] })).toThrow(/private|link-local/i);
    expect(() => validateWebhookUrl(`https://${rfc1918C}/hook`, { hostAllowlist: [rfc1918C] })).toThrow(/private|link-local/i);
    expect(() => validateWebhookUrl('https://[::1]/hook', { hostAllowlist: ['::1'] })).toThrow(/private|link-local/i);
    expect(() => validateWebhookUrl('https://[fe80::1]/hook', { hostAllowlist: ['fe80::1'] })).toThrow(/private|link-local/i);
    expect(() => validateWebhookUrl('https://user:pass@hooks.example/wake', { hostAllowlist: ['hooks.example'] })).toThrow(/credentials/i);
    expect(() => validateWebhookUrl('https://localhost/wake', { hostAllowlist: ['localhost'] })).toThrow(/local/i);
    expect(() => validateWebhookUrl('https://localhost./wake', { hostAllowlist: ['localhost'] })).toThrow(/local/i);
    expect(() => validateWebhookUrl(`https://${mdnsHost}./wake`, { hostAllowlist: [`.${'local'}`] })).toThrow(/local/i);
    expect(() => validateWebhookUrl(`https://${corpHost}./wake`, { hostAllowlist: [`.${'internal'}`] })).toThrow(/local/i);
    expect(() => validateWebhookUrl('https://[fec0::1]/wake', { hostAllowlist: ['fec0::1'] })).toThrow(/private|link-local/i);
    expect(() => validateWebhookUrl('https://[2002:7f00:0001::]/wake', { hostAllowlist: ['2002:7f00:0001::'] })).toThrow(/private|link-local/i);
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedIp('fec0::1')).toBe(true);
    expect(isBlockedIp('2002:a9fe:a9fe::1')).toBe(true);
    expect(isBlockedIp('93.184.216.34')).toBe(false);

    // 2. Registration stores encrypted ciphertext at rest; raw DB contains zero plaintext URL or key.
    const roomId = crypto.randomUUID();
    const deviceId = 'a'.repeat(64);
    const secretUrl = 'https://hooks.example.com/routine/trigger-secret-path';
    const secretKey = 'super-secret-bearer-token-xyz';
    const { inboxId } = connector.register(roomId, deviceId, secretUrl, secretKey);
    expect(inboxId).toMatch(/^[a-f0-9]{32}$/);

    const inspectDb = new Database(dbPath, { readonly: true });
    try {
      const rawRows = JSON.stringify(inspectDb.query('SELECT * FROM wake_registrations').all());
      expect(rawRows).not.toContain(secretUrl);
      expect(rawRows).not.toContain(secretKey);
      expect(rawRows).not.toContain('trigger-secret-path');
    } finally { inspectDb.close(); }

    // 3. DNS rebinding to metadata IP is blocked before fetch.
    const rebindRoom = crypto.randomUUID();
    const rebindDev = 'b'.repeat(64);
    connector.register(rebindRoom, rebindDev, 'https://rebind.example/wake', 'k');
    expect(await connector.notify(rebindRoom, rebindDev, 'sender1', 1)).toBe('failed');
    expect(calls).toHaveLength(0);

    // 4. Content-free webhook body & coalescing across 5-mention burst.
    const results = await Promise.all([
      connector.notify(roomId, deviceId, 'senderA', 1),
      connector.notify(roomId, deviceId, 'senderA', 2),
      connector.notify(roomId, deviceId, 'senderA', 3),
      connector.notify(roomId, deviceId, 'senderA', 4),
      connector.notify(roomId, deviceId, 'senderA', 5),
    ]);
    expect(results[0]).toBe('dispatched');
    expect(results.slice(1)).toEqual(['coalesced', 'coalesced', 'coalesced', 'coalesced']);
    expect(calls).toHaveLength(1);
    expect(calls[0].auth).toBe(`Bearer ${secretKey}`);
    expect(calls[0].body).toEqual({ source: 'meshrooms', event: 'room-has-work', inbox: inboxId, room: roomId, count: 1 });
    expect(Object.keys(calls[0].body).sort()).toEqual(['count', 'event', 'inbox', 'room', 'source']);
    expect(JSON.stringify(calls[0].body)).not.toContain(deviceId);

    // Sequential follow-up before agent connects is also coalesced; once cleared, next wake fires.
    expect(await connector.notify(roomId, deviceId, 'senderA', 5)).toBe('coalesced');
    connector.clearPending(roomId, deviceId);

    // 5. Retries on 429 and 5xx twice, 5s apart; no retry on 400.
    nextStatuses = [429, 503, 200];
    expect(await connector.notify(roomId, deviceId, 'senderA', 2)).toBe('dispatched');
    expect(sleeps).toEqual([WAKE_RETRY_DELAY_MS, WAKE_RETRY_DELAY_MS]);
    connector.clearPending(roomId, deviceId);

    sleeps.length = 0;
    nextStatuses = [400];
    expect(await connector.notify(roomId, deviceId, 'senderA', 1)).toBe('failed');
    expect(sleeps).toEqual([]);

    // 6. Per-sender cap (10/sender/room/hour) and per-room cap (20/room/hour).
    // senderA already used 3 slots (initial + retry-succeeded + 400-attempt). Finish senderA up to WAKE_SENDER_HOURLY_CAP.
    for (let i = 3; i < WAKE_SENDER_HOURLY_CAP; i++) {
      expect(await connector.notify(roomId, deviceId, 'senderA', 1)).toBe('dispatched');
      connector.clearPending(roomId, deviceId);
    }
    expect(await connector.notify(roomId, deviceId, 'senderA', 1)).toBe('capped');

    // A second sender in the same room can still wake up to WAKE_ROOM_HOURLY_CAP (20 total for the room).
    for (let i = WAKE_SENDER_HOURLY_CAP; i < WAKE_ROOM_HOURLY_CAP; i++) {
      expect(await connector.notify(roomId, deviceId, 'senderB', 1)).toBe('dispatched');
      connector.clearPending(roomId, deviceId);
    }
    // Third sender hits the 20/room/hour cap!
    expect(await connector.notify(roomId, deviceId, 'senderC', 1)).toBe('capped');

    // Per-agent cap (30/agent/hour) verified independently with higher room/sender caps.
    const agentCapConnector = new WakeConnector({
      now: () => now,
      fetch: mockFetch,
      lookup: async () => ['93.184.216.34'],
      hostAllowlist: ['hooks.example.com'],
      roomCapPerHour: 100,
      senderCapPerHour: 100,
    });
    try {
      agentCapConnector.register(roomId, deviceId, secretUrl, secretKey);
      for (let i = 0; i < WAKE_AGENT_HOURLY_CAP; i++) {
        expect(await agentCapConnector.notify(roomId, deviceId, 'senderX', 1)).toBe('dispatched');
        agentCapConnector.clearPending(roomId, deviceId);
      }
      expect(await agentCapConnector.notify(roomId, deviceId, 'senderX', 1)).toBe('capped');
    } finally {
      agentCapConnector.close();
    }
  } finally {
    connector.close();
    dir.cleanup();
  }
});

test('Device removal immediately closes WSS socket, aborts long-poll, deletes inbox/state/wake, and blocks future frames', async () => {
  let relay!: RelayService;
  let wakeConnector!: WakeConnector;
  const server = Bun.serve<RelaySocketData>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req, srv) => handler(req, srv.requestIP(req)?.address || '127.0.0.1', (r, d) => srv.upgrade(r, { data: d })),
    websocket: {
      open: ws => relay.websocket.open!(ws),
      message: (ws, m) => relay.websocket.message!(ws, m),
      drain: ws => relay.websocket.drain!(ws),
      close: (ws, c, r) => relay.websocket.close!(ws, c, r),
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const wsUrl = `ws://127.0.0.1:${server.port}/api/relay/v1`;
  const lobby = new BrowserLobby(':memory:', { origin });
  wakeConnector = new WakeConnector({ allowLoopbackHttp: true, fetch: async () => new Response('ok', { status: 200 }) });
  relay = new RelayService({ lobby, wakeConnector });
  const handler = browserHandler(lobby, origin, '.', { relay });

  try {
    const { room, host, guest, agent, agentEntry } = await setupRoom(lobby, origin);

    // Register wake + store sealed state + store an inbox frame for offline agent.
    await relay.handleHttp('/api/relay/v1/wake-register', await agent.signed('relay-wake-register', room, { url: 'http://127.0.0.1:9999/wake', key: 'k' }));
    const sealed = await sealAgentState({ hello: 'state' }, agent.encPrivateKey, { room, deviceId: agent.id });
    await relay.handleHttp('/api/relay/v1/state', await agent.signed('relay-state-put', room, { state: sealed }));

    const hostSess = crypto.randomUUID();
    await relay.handleHttp('/api/relay/v1/open', await host.signed('relay-open', room, { session: hostSess }));
    const heldEnv = await encryptRelayEnvelope({ note: 'held-before-remove' }, {
      room, from: host.id, id: crypto.randomUUID(), seq: 1, rosterVersion: 1, lane: 'primary', recipients: [agentEntry], hold: true,
      sign: host.sign,
    });
    await relay.handleHttp('/api/relay/v1/send', await host.signed('relay-send', room, { session: hostSess, envelopes: [heldEnv] }));
    expect(relay.inboxStats(room, agent.id).count).toBe(1);
    expect(wakeConnector.hasRegistration(room, agent.id)).toBe(true);

    // Connect agent over WSS AND park a guest long-poll.
    const agentWs = await connectWs(wsUrl);
    const ch = await agentWs.next();
    agentWs.sendJson({ t: 'auth', signed: await agent.signed('relay-open', room, { nonce: ch.nonce, session: agent.session }) });
    expect(await agentWs.next()).toMatchObject({ t: 'ready', deviceId: agent.id });
    // Pending inbox frame is pushed on WSS connect.
    expect((await agentWs.next()).t).toBe('frame');

    const guestPoll = relay.handleHttp('/api/relay/v1/poll', await guest.signed('relay-poll', room, { session: guest.session, waitSeconds: 5 }));
    await new Promise(r => setTimeout(r, 15));

    // Remove agent -> WSS closes immediately with 4003, inbox & wake deleted, future frames rejected!
    await host.send(lobby, 'remove', room, { deviceId: agent.id });
    expect(await agentWs.next()).toMatchObject({ t: 'error', code: 'removed' });
    expect((await agentWs.closed).code).toBe(4003);
    expect(relay.inboxStats(room, agent.id)).toEqual({ count: 0, bytes: 0 });
    expect(wakeConnector.hasRegistration(room, agent.id)).toBe(false);

    // Future frame addressed to removed agent is rejected immediately.
    const afterRemove = await encryptRelayEnvelope({ note: 'after-remove' }, {
      room, from: host.id, id: crypto.randomUUID(), seq: 2, rosterVersion: 1, lane: 'primary', recipients: [agentEntry], hold: true,
      sign: host.sign,
    });
    const sendAfter = (await relay.handleHttp('/api/relay/v1/send', await host.signed('relay-send', room, { session: hostSess, envelopes: [afterRemove] }))) as { rejected: { id: string; reason: string }[] };
    expect(sendAfter.rejected).toEqual([{ id: afterRemove.id, reason: 'recipient-not-admitted' }]);

    // Removed agent gets 403 on state/open.
    await expect(relay.handleHttp('/api/relay/v1/state', await agent.signed('relay-state-get', room, {}))).rejects.toMatchObject({ status: 403 });

    // Remove guest -> waiting HTTPS long-poll rejects with 403 immediately.
    await host.send(lobby, 'remove', room, { deviceId: guest.id });
    await expect(guestPoll).rejects.toMatchObject({ status: 403 });

    // Host opens WSS, then closes room -> WSS closes with 4010 and room relay data is wiped.
    const hostWs = await connectWs(wsUrl);
    const hostCh = await hostWs.next();
    hostWs.sendJson({ t: 'auth', signed: await host.signed('relay-open', room, { nonce: hostCh.nonce, session: host.session }) });
    expect(await hostWs.next()).toMatchObject({ t: 'ready', deviceId: host.id });
    await host.send(lobby, 'close', room);
    expect(await hostWs.next()).toMatchObject({ t: 'error', code: 'room-closed' });
    expect((await hostWs.closed).code).toBe(4010);
  } finally {
    relay.close();
    wakeConnector.close();
    server.stop(true);
    lobby.close();
  }
});

test('Zero plaintext, keys, or OAuth/account linkage in relay logs and relay SQLite storage', async () => {
  const dir = testDirectory('relay-privacy');
  const relayDbPath = join(dir.path, 'relay.sqlite');
  const origin = 'http://127.0.0.1:4320';
  const logs: string[] = [];
  const lobby = new BrowserLobby(':memory:', { origin });
  const wakeConnector = new WakeConnector({
    dbPath: relayDbPath,
    secret: 'privacy-test-secret',
    allowLoopbackHttp: true,
    fetch: async () => new Response('ok', { status: 200 }),
    log: line => logs.push(line),
  });
  const relay = new RelayService({
    lobby,
    wakeConnector,
    dbPath: relayDbPath,
    log: line => logs.push(line),
  });
  const handler = browserHandler(lobby, origin, '.', { relay, log: line => logs.push(line) });

  try {
    const { room, host, agent, agentEntry } = await setupRoom(lobby, origin);
    const secretMessage = 'TOP-SECRET-PLAINTEXT-DO-NOT-LEAK-9911';
    const secretState = 'SEALED-AGENT-MEMORY-DO-NOT-LEAK-8822';
    const webhookSecret = 'WEBHOOK-BEARER-DO-NOT-LEAK-7733';
    const webhookUrl = 'http://127.0.0.1:9999/private-trigger-6644';

    await handler(new Request(`${origin}/api/relay/v1/wake-register`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(await agent.signed('relay-wake-register', room, { url: webhookUrl, key: webhookSecret })),
    }));
    const sealed = await sealAgentState({ secret: secretState }, agent.encPrivateKey, { room, deviceId: agent.id });
    await handler(new Request(`${origin}/api/relay/v1/state`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(await agent.signed('relay-state-put', room, { state: sealed })),
    }));
    const env = await encryptRelayEnvelope({ kind: 'message', text: secretMessage }, {
      room,
      from: host.id,
      sign: host.sign,
      id: crypto.randomUUID(),
      seq: 1,
      rosterVersion: 1,
      lane: 'primary',
      recipients: [agentEntry],
      wake: [agent.id],
      hold: true,
    });
    await handler(new Request(`${origin}/api/relay/v1/send`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(await host.signed('relay-send', room, { session: host.session, envelopes: [env] })),
    }));

    // Wait a tick for async wake notify log.
    await new Promise(r => setTimeout(r, 20));

    const allLogs = logs.join('\n');
    for (const forbidden of [secretMessage, secretState, webhookSecret, webhookUrl, room, host.id, agent.id, env.ct, env.epk, 'betaPerson', 'oauth']) {
      expect(allLogs).not.toContain(forbidden);
    }

    const db = new Database(relayDbPath, { readonly: true });
    try {
      const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(t => t.name);
      expect(tables).not.toContain('beta_admissions');
      expect(tables).not.toContain('beta_revocations');
      const inboxDump = JSON.stringify(db.query('SELECT * FROM relay_inbox').all());
      const stateDump = JSON.stringify(db.query('SELECT * FROM relay_sealed_state').all());
      const wakeDump = JSON.stringify(db.query('SELECT * FROM wake_registrations').all());
      for (const dump of [inboxDump, stateDump, wakeDump]) {
        expect(dump).not.toContain(secretMessage);
        expect(dump).not.toContain(secretState);
        expect(dump).not.toContain(webhookSecret);
        expect(dump).not.toContain(webhookUrl);
      }
    } finally {
      db.close();
    }
  } finally {
    relay.close();
    wakeConnector.close();
    lobby.close();
    dir.cleanup();
  }
});

test('WakeConnector P1: fail-closed default allowlist, pinned-IP socket egress, DNS rebinding mid-retry, and 3xx redirect block', async () => {
  const dir = testDirectory('wake-egress');
  const dbPath = join(dir.path, 'wake.sqlite');
  const roomId = crypto.randomUUID();
  const deviceId = 'c'.repeat(64);

  // 1. Config rejects wildcard MESHROOMS_WAKE_ALLOWLIST entries.
  expect(() => browserConfig({ MESHROOMS_WAKE_ALLOWLIST: '*' })).toThrow(/MESHROOMS_WAKE_ALLOWLIST/);
  expect(() => browserConfig({ MESHROOMS_WAKE_ALLOWLIST: '*.example.com' })).toThrow(/MESHROOMS_WAKE_ALLOWLIST/);
  expect(browserConfig({ MESHROOMS_WAKE_ALLOWLIST: 'api.anthropic.com.' }).wakeAllowlist).toEqual(['api.anthropic.com']);

  // 2. Empty hostAllowlist fails closed on BOTH registration AND delivery of pre-existing DB rows.
  const seeded = new WakeConnector({
    dbPath,
    secret: 'egress-secret',
    hostAllowlist: ['hooks.example.com'],
    lookup: async () => ['93.184.216.34'],
  });
  seeded.register(roomId, deviceId, 'https://hooks.example.com/wake', 'tok');
  seeded.close();

  const lockedDown = new WakeConnector({
    dbPath,
    secret: 'egress-secret',
    lookup: async () => ['93.184.216.34'],
  });
  try {
    expect(() => lockedDown.register(roomId, 'd'.repeat(64), 'https://hooks.example.com/wake', 'tok')).toThrow(/MESHROOMS_WAKE_ALLOWLIST/);
    expect(await lockedDown.notify(roomId, deviceId, 'sender1', 1)).toBe('failed');
  } finally {
    lockedDown.close();
  }

  // 3. Pinned-IP transport receives pre-validated IP & blocks DNS rebinding between retry attempts.
  let lookupAttempt = 0;
  const pinnedCalls: PinnedTransportRequest[] = [];
  const rebindConnector = new WakeConnector({
    hostAllowlist: ['rebind-mid.example'],
    lookup: async () => (++lookupAttempt === 1 ? ['93.184.216.34'] : ['169.254.169.254']),
    sleep: async () => {},
    transport: async req => {
      pinnedCalls.push(req);
      return { status: 503, headers: new Headers() };
    },
  });
  try {
    rebindConnector.register(roomId, deviceId, 'https://rebind-mid.example/wake', 'tok');
    expect(await rebindConnector.notify(roomId, deviceId, 'sender1', 1)).toBe('failed');
    // Attempt 1 connected strictly to 93.184.216.34; attempt 2 re-resolved to 169.254.169.254 and aborted BEFORE calling transport!
    expect(pinnedCalls).toHaveLength(1);
    expect(pinnedCalls[0].ip).toBe('93.184.216.34');
    expect(pinnedCalls[0].family).toBe(4);
    expect(pinnedCalls[0].hostname).toBe('rebind-mid.example');
  } finally {
    rebindConnector.close();
  }

  // 4. Real pinned-IP node:http socket against a real loopback HTTP server: verifies Host header, body, and 3xx redirect refusal.
  const received: { path: string; host: string | null; auth: string | null; body: string }[] = [];
  const webhookServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async req => {
      const url = new URL(req.url);
      received.push({
        path: url.pathname,
        host: req.headers.get('host'),
        auth: req.headers.get('authorization'),
        body: await req.text(),
      });
      if (url.pathname === '/redirect') {
        return new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data' } });
      }
      return Response.json({ ok: true }, { status: 200 });
    },
  });
  const realConnector = new WakeConnector({ allowLoopbackForTest: true, sleep: async () => {} });
  try {
    // 4a. Direct pinnedHttpRequest connects TCP socket to 127.0.0.1 for an unresolvable virtual hostname while sending Host header.
    const directRes = await pinnedHttpRequest({
      url: new URL(`http://pinned.invalid:${webhookServer.port}/wake`),
      ip: '127.0.0.1',
      family: 4,
      hostname: 'pinned.invalid',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer pin-key' },
      body: '{"source":"meshrooms","event":"room-has-work","inbox":"abc","room":"r","count":1}',
      timeoutMs: 3000,
    });
    expect(directRes.status).toBe(200);
    expect(received[0]).toMatchObject({ path: '/wake', host: `pinned.invalid:${webhookServer.port}`, auth: 'Bearer pin-key' });

    // 4b. WakeConnector real HTTP path dispatches cleanly over pinnedHttpRequest.
    const { inboxId } = realConnector.register(roomId, deviceId, `http://127.0.0.1:${webhookServer.port}/wake`, 'real-key');
    expect(await realConnector.notify(roomId, deviceId, 'sender1', 3)).toBe('dispatched');
    expect(JSON.parse(received[1].body)).toEqual({ source: 'meshrooms', event: 'room-has-work', inbox: inboxId, room: roomId, count: 3 });

    // 4c. 3xx redirect is refused immediately without following or retrying.
    realConnector.clearPending(roomId, deviceId);
    realConnector.register(roomId, deviceId, `http://127.0.0.1:${webhookServer.port}/redirect`, 'real-key');
    const beforeCount = received.length;
    expect(await realConnector.notify(roomId, deviceId, 'sender1', 1)).toBe('failed');
    expect(received.length).toBe(beforeCount + 1);
  } finally {
    realConnector.close();
    webhookServer.stop(true);
    dir.cleanup();
  }
});

test('WakeConnector P2: Claude Code routine wake adapter and Retry-After header handling on 429/503', async () => {
  let now = Date.parse('2026-11-26T00:00:00Z');
  const sleeps: number[] = [];
  const dispatched: PinnedTransportRequest[] = [];
  const responses: { status: number; headers?: Record<string, string> }[] = [];

  const connector = new WakeConnector({
    now: () => now,
    hostAllowlist: ['api.anthropic.com', 'hooks.example.com'],
    lookup: async () => ['93.184.216.34'],
    sleep: async ms => { sleeps.push(ms); },
    transport: async req => {
      dispatched.push(req);
      const next = responses.shift() ?? { status: 200 };
      return { status: next.status, headers: new Headers(next.headers) };
    },
  });

  const origin = 'http://127.0.0.1:4320';
  const lobby = new BrowserLobby(':memory:', { origin, now: () => now });
  const relay = new RelayService({ lobby, wakeConnector: connector, now: () => now });

  try {
    const { room, agent } = await setupRoom(lobby, origin, () => now);
    const claudeUrl = 'https://api.anthropic.com/v1/claude_code/routines/trig_01TESTROUTINE/fire';
    const token = 'sk-ant-oat01-test-routine-secret';

    // 1. Auto-detects `claude-code` provider via relay-wake-register on api.anthropic.com routine fire URL.
    const reg = (await relay.handleHttp('/api/relay/v1/wake-register', await agent.signed('relay-wake-register', room, {
      url: claudeUrl,
      key: token,
    }))) as { inboxId: string; wakeable: boolean; provider: string };
    expect(reg.wakeable).toBe(true);
    expect(reg.provider).toBe('claude-code');

    // Invalid provider rejected with 400.
    await expect(relay.handleHttp('/api/relay/v1/wake-register', await agent.signed('relay-wake-register', room, {
      url: claudeUrl,
      key: token,
      provider: 'bogus',
    }))).rejects.toMatchObject({ status: 400 });

    // 2. Claude Code adapter sends required anthropic-version + anthropic-beta + Bearer auth + strictly content-free text body.
    expect(await connector.notify(room, agent.id, 'sender1', 4)).toBe('dispatched');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].headers['anthropic-version']).toBe(CLAUDE_CODE_ANTHROPIC_VERSION);
    expect(dispatched[0].headers['anthropic-beta']).toBe(CLAUDE_CODE_ANTHROPIC_BETA);
    expect(dispatched[0].headers.Authorization).toBe(`Bearer ${token}`);
    expect(dispatched[0].headers['Content-Type']).toBe('application/json');
    const parsedBody = JSON.parse(dispatched[0].body) as { text: string };
    expect(Object.keys(parsedBody)).toEqual(['text']);
    expect(parsedBody.text).toContain(reg.inboxId);
    expect(parsedBody.text).toContain('4');
    expect(parsedBody.text).toContain(room);
    expect(dispatched[0].body).not.toContain(agent.id);

    // Explicit provider: 'claude-code' also works on a custom allowlisted host.
    connector.clearPending(room, agent.id);
    const explicitReg = (await relay.handleHttp('/api/relay/v1/wake-register', await agent.signed('relay-wake-register', room, {
      url: 'https://hooks.example.com/claude-proxy',
      key: token,
      provider: 'claude-code',
    }))) as { provider: string };
    expect(explicitReg.provider).toBe('claude-code');

    // 3. Retry-After parsing & honoring on 429 (delta-seconds, HTTP-date, clamping, and fallback).
    expect(parseRetryAfterMs('2', now)).toBe(2_000);
    expect(parseRetryAfterMs(new Date(now + 7_000).toUTCString(), now)).toBe(7_000);
    expect(parseRetryAfterMs('999999', now)).toBe(WAKE_MAX_RETRY_AFTER_MS);
    expect(parseRetryAfterMs('not-a-date', now)).toBeUndefined();

    responses.push(
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 429, headers: { 'retry-after': new Date(now + 7_000).toUTCString() } },
      { status: 200 },
    );
    expect(await connector.notify(room, agent.id, 'sender1', 2)).toBe('dispatched');
    expect(sleeps).toEqual([2_000, 7_000]);

    // Huge Retry-After clamped to WAKE_MAX_RETRY_AFTER_MS; 503 without Retry-After uses WAKE_RETRY_DELAY_MS.
    sleeps.length = 0;
    connector.clearPending(room, agent.id);
    responses.push(
      { status: 429, headers: { 'retry-after': '3600' } },
      { status: 503 },
      { status: 200 },
    );
    expect(await connector.notify(room, agent.id, 'sender1', 1)).toBe('dispatched');
    expect(sleeps).toEqual([WAKE_MAX_RETRY_AFTER_MS, WAKE_RETRY_DELAY_MS]);
  } finally {
    relay.close();
    connector.close();
    lobby.close();
  }
});
