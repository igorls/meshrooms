import { Database } from 'bun:sqlite';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ServerWebSocket, WebSocketHandler } from 'bun';
import { ROOM_CLOSED, type SignedCommand } from '../../src/browser/protocol';
import {
  isValidRelayEnvelopeShape,
  RELAY_MAX_FRAME_BYTES,
  SEALED_STATE_MAX_BYTES,
  type RelayEnvelope,
} from '../../src/browser/relay-crypto';
import { BrowserLobby, LobbyError } from './lobby';
import { WakeConnector, WakeValidationError, type WakeProvider } from './wake-connector';

/** WSS authentication timeout after socket open (15s). */
export const RELAY_AUTH_TIMEOUT_MS = 15_000;
/** WSS heartbeat ping interval (25s) to keep reverse proxies and NATs alive. */
export const RELAY_HEARTBEAT_MS = 25_000;
/** Frame id deduplication window (10 minutes). */
export const RELAY_DEDUP_WINDOW_MS = 10 * 60_000;
/** Per-device outer rate limits (120 frames/min and 2 MB/min). */
export const RELAY_RATE_FRAMES_PER_MIN = 120;
export const RELAY_RATE_BYTES_PER_MIN = 2 * 1024 * 1024;
/** Per-device in-flight cap for the `file` lane (1 MB). */
export const RELAY_FILE_LANE_INFLIGHT_BYTES = 1024 * 1024;
/** Maximum HTTPS long-poll wait duration (25s). */
export const RELAY_MAX_LONG_POLL_SECONDS = 25;
/** Maximum HTTP request body size for `/api/relay/v1/{open,send,poll,wake-register}` (64 KB). */
export const RELAY_SEND_MAX_BODY_BYTES = 64 * 1024;
/** Maximum HTTP request body size for `/api/relay/v1/state` (300 KB). */
export const RELAY_STATE_MAX_BODY_BYTES = 300 * 1024;
/** Bounded ciphertext inbox limits per Section 6.2. */
export const INBOX_MAX_FRAMES_PER_DEVICE = 500;
export const INBOX_MAX_BYTES_PER_DEVICE = 8 * 1024 * 1024;
export const INBOX_MAX_BYTES_PER_ROOM = 32 * 1024 * 1024;
export const INBOX_TTL_MS = 72 * 3_600_000;
/** Maximum envelopes accepted in a single HTTPS `/send` batch. */
export const RELAY_MAX_SEND_BATCH = 16;
/** Ephemeral in-memory live HTTPS session TTL between consecutive polls (35s). */
const DEFAULT_HTTPS_SESSION_TTL_MS = 35_000;
/** Backpressure threshold above which `file` lane pauses so `primary` frames jump ahead. */
const FILE_BACKPRESSURE_BYTES = 256 * 1024;
/** Replay-protection TTL for signed relay HTTPS commands (> 2x the ±60s clock skew window). */
const COMMAND_REPLAY_TTL_MS = 125_000;
const BASE64_STD = /^[A-Za-z0-9+/]*={0,2}$/;

type QueuedOutbound = { payload: string; bytes: number };

export type RelaySocketData = {
  remoteKey: string;
  nonce: string;
  nonceUsed: boolean;
  openedAt: number;
  authTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  authenticated: boolean;
  roomId?: string;
  deviceId?: string;
  session?: string;
  lastSeq: number;
  primaryQueue: QueuedOutbound[];
  fileQueue: QueuedOutbound[];
  fileQueuedBytes: number;
};

type PollWaiter = {
  resolve: (result: { frames: { cursor: number; envelope: RelayEnvelope }[]; cursor: number }) => void;
  reject: (error: LobbyError) => void;
  timer: ReturnType<typeof setTimeout>;
  after: number;
  cleanupAbort?: () => void;
};

type HttpsSessionState = {
  session: string;
  lastSeq: number;
  lastActivityAt: number;
  /** Ephemeral live delivery queues (in memory only, never persisted to disk) for non-wakeable HTTPS fallback clients between polls. */
  primaryQueue: { envelope: RelayEnvelope; bytes: number }[];
  fileQueue: { envelope: RelayEnvelope; bytes: number }[];
  fileQueuedBytes: number;
  waiter?: PollWaiter;
};

type RateEntry = { at: number; bytes: number };

export type RelayServiceOptions = {
  lobby: BrowserLobby;
  wakeConnector?: WakeConnector;
  /** SQLite path for ciphertext inbox & sealed state (default `:memory:`). Completely separate from admission/OAuth. */
  dbPath?: string;
  now?: () => number;
  authTimeoutMs?: number;
  heartbeatMs?: number;
  dedupWindowMs?: number;
  rateFramesPerMin?: number;
  rateBytesPerMin?: number;
  fileLaneBudgetBytes?: number;
  inboxMaxFrames?: number;
  inboxMaxBytes?: number;
  inboxMaxRoomBytes?: number;
  inboxTtlMs?: number;
  httpsSessionTtlMs?: number;
  log?: (line: string) => void;
};

function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && !/[\r\n\0]/.test(value);
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * E2E encrypted WSS + HTTPS fallback relay with bounded per-device ciphertext inbox and sealed agent state.
 * Forwards and stores opaque `RelayEnvelope` ciphertext only; never holds plaintext, DEKs, or OAuth/account links.
 */
export class RelayService {
  private lobby: BrowserLobby;
  private wakeConnector?: WakeConnector;
  private db: Database;
  private now: () => number;
  private authTimeoutMs: number;
  private heartbeatMs: number;
  private dedupWindowMs: number;
  private rateFramesPerMin: number;
  private rateBytesPerMin: number;
  private fileLaneBudgetBytes: number;
  private inboxMaxFrames: number;
  private inboxMaxBytes: number;
  private inboxMaxRoomBytes: number;
  private inboxTtlMs: number;
  private httpsSessionTtlMs: number;
  private writeLog: (line: string) => void;

  /** Active authenticated WSS sockets keyed by `${roomId}:${deviceId}` (one active socket per device per room). */
  private sockets = new Map<string, ServerWebSocket<RelaySocketData>>();
  /** All open WSS sockets (including pre-auth) for clean shutdown. */
  private openSockets = new Set<ServerWebSocket<RelaySocketData>>();
  /** Active HTTPS fallback sessions keyed by `${roomId}:${deviceId}`. */
  private httpsSessions = new Map<string, HttpsSessionState>();
  /** Room-scoped 10-minute frame id dedup cache (`${roomId}:${envelope.id}` -> timestamp). */
  private seenFrames = new Map<string, number>();
  /** Per-device sliding 1-minute outer rate limit windows (`${roomId}:${deviceId}` -> entries). */
  private rateWindows = new Map<string, RateEntry[]>();
  /** Short-lived command id replay cache for mutating signed relay HTTPS commands (`${deviceId}:${command.id}` -> timestamp). */
  private seenCommandIds = new Map<string, number>();

  private unsubRemoved: () => void;
  private unsubClosed: () => void;

  constructor(options: RelayServiceOptions) {
    this.lobby = options.lobby;
    this.wakeConnector = options.wakeConnector;
    this.now = options.now ?? Date.now;
    this.authTimeoutMs = options.authTimeoutMs ?? RELAY_AUTH_TIMEOUT_MS;
    this.heartbeatMs = options.heartbeatMs ?? RELAY_HEARTBEAT_MS;
    this.dedupWindowMs = options.dedupWindowMs ?? RELAY_DEDUP_WINDOW_MS;
    this.rateFramesPerMin = options.rateFramesPerMin ?? RELAY_RATE_FRAMES_PER_MIN;
    this.rateBytesPerMin = options.rateBytesPerMin ?? RELAY_RATE_BYTES_PER_MIN;
    this.fileLaneBudgetBytes = options.fileLaneBudgetBytes ?? RELAY_FILE_LANE_INFLIGHT_BYTES;
    this.inboxMaxFrames = options.inboxMaxFrames ?? INBOX_MAX_FRAMES_PER_DEVICE;
    this.inboxMaxBytes = options.inboxMaxBytes ?? INBOX_MAX_BYTES_PER_DEVICE;
    this.inboxMaxRoomBytes = options.inboxMaxRoomBytes ?? INBOX_MAX_BYTES_PER_ROOM;
    this.inboxTtlMs = options.inboxTtlMs ?? INBOX_TTL_MS;
    this.httpsSessionTtlMs = options.httpsSessionTtlMs ?? DEFAULT_HTTPS_SESSION_TTL_MS;
    this.writeLog = options.log ?? (() => {});

    this.db = new Database(options.dbPath ?? ':memory:', { create: true });
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_inbox (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        frame_id TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        UNIQUE(room_id, recipient_id, frame_id)
      );
      CREATE INDEX IF NOT EXISTS relay_inbox_recipient ON relay_inbox(room_id, recipient_id, cursor);
      CREATE INDEX IF NOT EXISTS relay_inbox_room ON relay_inbox(room_id, cursor);
      CREATE INDEX IF NOT EXISTS relay_inbox_expires ON relay_inbox(expires_at);

      CREATE TABLE IF NOT EXISTS relay_sealed_state (
        room_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        state TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (room_id, device_id)
      );
    `);

    this.unsubRemoved = this.lobby.onDeviceRemoved((roomId, deviceId) => this.handleDeviceRemoved(roomId, deviceId));
    this.unsubClosed = this.lobby.onRoomClosed(roomId => this.handleRoomClosed(roomId));
  }

  /** Creates initial per-connection state passed to `server.upgrade(request, { data })`. */
  createSocketData(remoteKey: string): RelaySocketData {
    return {
      remoteKey,
      nonce: randomBytes(32).toString('hex'),
      nonceUsed: false,
      openedAt: this.now(),
      authenticated: false,
      lastSeq: 0,
      primaryQueue: [],
      fileQueue: [],
      fileQueuedBytes: 0,
    };
  }

  private logOp(op: string, status: number | string, extra: Record<string, string | number> = {}) {
    // Strictly operational telemetry: NEVER log roomId, deviceId, ciphertext, keys, URLs, or account info.
    this.writeLog(JSON.stringify({ time: new Date(this.now()).toISOString(), event: 'relay', op, status, ...extra }));
  }

  /** Bun.serve WebSocketHandler wired at `/api/relay/v1`. */
  get websocket(): WebSocketHandler<RelaySocketData> {
    return {
      maxPayloadLength: RELAY_MAX_FRAME_BYTES + 4096,
      idleTimeout: 75,
      open: ws => this.onWsOpen(ws),
      message: (ws, message) => { void this.onWsMessage(ws, message); },
      drain: ws => this.flushSocket(ws),
      close: ws => this.onWsClose(ws),
    };
  }

  private onWsOpen(ws: ServerWebSocket<RelaySocketData>) {
    this.openSockets.add(ws);
    ws.data.authTimer = setTimeout(() => {
      if (!ws.data.authenticated) {
        this.sendImmediate(ws, { t: 'error', code: 'auth-timeout', message: 'Authentication timed out.' });
        try { ws.close(4001, 'Auth timeout'); } catch { /* ignore */ }
      }
    }, this.authTimeoutMs);
    this.sendImmediate(ws, { t: 'challenge', nonce: ws.data.nonce });
    this.logOp('ws-open', 'ok');
  }

  private onWsClose(ws: ServerWebSocket<RelaySocketData>) {
    this.openSockets.delete(ws);
    if (ws.data.authTimer) { clearTimeout(ws.data.authTimer); ws.data.authTimer = undefined; }
    if (ws.data.heartbeatTimer) { clearInterval(ws.data.heartbeatTimer); ws.data.heartbeatTimer = undefined; }
    if (ws.data.authenticated && ws.data.roomId && ws.data.deviceId) {
      const key = `${ws.data.roomId}:${ws.data.deviceId}`;
      if (this.sockets.get(key) === ws) this.sockets.delete(key);
    }
    ws.data.primaryQueue = [];
    ws.data.fileQueue = [];
    ws.data.fileQueuedBytes = 0;
  }

  private sendImmediate(ws: ServerWebSocket<RelaySocketData>, payload: unknown) {
    try { ws.send(JSON.stringify(payload)); } catch { /* ignore closed socket */ }
  }

  private enqueueSocket(ws: ServerWebSocket<RelaySocketData>, lane: 'primary' | 'file', messageObj: unknown): boolean {
    const payload = JSON.stringify(messageObj);
    const bytes = utf8Bytes(payload);
    if (lane === 'primary') {
      ws.data.primaryQueue.push({ payload, bytes });
      this.flushSocket(ws);
      return true;
    }
    if (ws.data.fileQueuedBytes + bytes > this.fileLaneBudgetBytes) {
      return false;
    }
    ws.data.fileQueue.push({ payload, bytes });
    ws.data.fileQueuedBytes += bytes;
    this.flushSocket(ws);
    return true;
  }

  /** Two-lane drain: always drains `primary` completely before sending any `file` frame. */
  private flushSocket(ws: ServerWebSocket<RelaySocketData>) {
    while (ws.data.primaryQueue.length > 0) {
      const next = ws.data.primaryQueue.shift()!;
      try {
        const res = ws.send(next.payload);
        if (res === 0) return;
      } catch {
        return;
      }
    }
    while (ws.data.primaryQueue.length === 0 && ws.data.fileQueue.length > 0) {
      if (ws.getBufferedAmount() > FILE_BACKPRESSURE_BYTES) return;
      const next = ws.data.fileQueue.shift()!;
      ws.data.fileQueuedBytes = Math.max(0, ws.data.fileQueuedBytes - next.bytes);
      try {
        const res = ws.send(next.payload);
        if (res === 0 || res === -1) return;
      } catch {
        return;
      }
    }
  }

  private async onWsMessage(ws: ServerWebSocket<RelaySocketData>, raw: string | Buffer) {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    if (utf8Bytes(text) > RELAY_MAX_FRAME_BYTES + 4096) {
      this.sendImmediate(ws, { t: 'error', code: 'frame-too-large', message: 'Frame exceeds maximum size.' });
      return;
    }
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad');
      msg = parsed as Record<string, unknown>;
    } catch {
      this.sendImmediate(ws, { t: 'error', code: 'invalid-json', message: 'Invalid JSON frame.' });
      return;
    }

    if (!ws.data.authenticated) {
      if (msg.t !== 'auth') {
        this.sendImmediate(ws, { t: 'error', code: 'unauthenticated', message: 'Authenticate with challenge first.' });
        try { ws.close(4001, 'Unauthenticated'); } catch { /* ignore */ }
        return;
      }
      await this.handleWsAuth(ws, msg.signed as SignedCommand);
      return;
    }

    const roomId = ws.data.roomId!;
    const deviceId = ws.data.deviceId!;

    switch (msg.t) {
      case 'ping': {
        this.enqueueSocket(ws, 'primary', { t: 'pong', at: this.now() });
        return;
      }
      case 'pong':
        return;
      case 'ack': {
        if (typeof msg.cursor === 'number' && Number.isInteger(msg.cursor) && msg.cursor > 0) {
          this.ackInbox(roomId, deviceId, msg.cursor);
        }
        return;
      }
      case 'frame': {
        const result = this.processFrame(roomId, deviceId, ws.data, msg.envelope);
        if (!result.ok) {
          this.enqueueSocket(ws, 'primary', { t: 'rejected', id: result.id, reason: result.reason });
          return;
        }
        this.enqueueSocket(ws, 'primary', { t: 'accepted', id: result.id });
        return;
      }
      default: {
        this.enqueueSocket(ws, 'primary', { t: 'error', code: 'unknown-type', message: 'Unsupported message type.' });
      }
    }
  }

  private async handleWsAuth(ws: ServerWebSocket<RelaySocketData>, signed: SignedCommand) {
    if (ws.data.nonceUsed) {
      this.sendImmediate(ws, { t: 'error', code: 'nonce-reused', message: 'Challenge nonce already used.' });
      try { ws.close(4001, 'Nonce reused'); } catch { /* ignore */ }
      return;
    }
    // Single-use nonce: mark consumed immediately before any await so concurrent auth frames cannot race it.
    ws.data.nonceUsed = true;
    if (ws.data.authTimer) { clearTimeout(ws.data.authTimer); ws.data.authTimer = undefined; }

    try {
      const verified = await this.lobby.verifySignedCommand(signed, 'relay-open');
      const { command, deviceId } = verified;
      const roomId = command.roomId;
      const nonce = command.payload.nonce;
      if (typeof nonce !== 'string' || !timingSafeStringEqual(nonce, ws.data.nonce)) {
        throw new LobbyError(401, 'Challenge nonce mismatch.');
      }
      const session = command.payload.session;
      if (!isValidSessionId(session)) {
        throw new LobbyError(400, 'Invalid relay session.');
      }
      const after = typeof command.payload.after === 'number' && Number.isInteger(command.payload.after) && command.payload.after > 0
        ? command.payload.after : 0;

      this.lobby.assertAdmittedDevice(roomId, deviceId);

      // Guard against socket closing while awaiting signature verification.
      if (!this.openSockets.has(ws)) return;

      const key = `${roomId}:${deviceId}`;
      const existing = this.sockets.get(key);
      if (existing && existing !== ws) {
        this.sendImmediate(existing, { t: 'error', code: 'session-replaced', message: 'Session replaced by a newer connection.' });
        try { existing.close(4009, 'Session replaced'); } catch { /* ignore */ }
        this.sockets.delete(key);
      }

      ws.data.authenticated = true;
      ws.data.roomId = roomId;
      ws.data.deviceId = deviceId;
      ws.data.session = session;
      ws.data.lastSeq = 0;
      this.sockets.set(key, ws);
      this.wakeConnector?.clearPending(roomId, deviceId);

      // Start heartbeat ping every 25s.
      ws.data.heartbeatTimer = setInterval(() => {
        if (!this.openSockets.has(ws)) return;
        this.enqueueSocket(ws, 'primary', { t: 'ping', at: this.now() });
        try { ws.ping(); } catch { /* ignore */ }
      }, this.heartbeatMs);

      const pending = this.readInbox(roomId, deviceId, after);
      const maxCursor = this.getMaxInboxCursor(roomId, deviceId);
      const rosterVersion = this.lobby.getRoomRoster(roomId)?.body.version ?? 0;

      this.enqueueSocket(ws, 'primary', {
        t: 'ready',
        roomId,
        deviceId,
        session,
        cursor: maxCursor,
        rosterVersion,
      });

      for (const item of pending) {
        this.enqueueSocket(ws, item.envelope.lane, { t: 'frame', envelope: item.envelope, cursor: item.cursor });
      }
      this.logOp('ws-auth', 200);
    } catch (error) {
      const status = error instanceof LobbyError ? error.status : 401;
      const code = error instanceof LobbyError && error.code ? error.code : status === 403 ? 'forbidden' : status === 410 ? ROOM_CLOSED : 'auth-failed';
      const message = error instanceof Error ? error.message : 'Authentication failed.';
      this.logOp('ws-auth', status);
      this.sendImmediate(ws, { t: 'error', code, message });
      try { ws.close(status === 403 ? 4003 : status === 410 ? 4010 : 4001, code); } catch { /* ignore */ }
    }
  }

  /**
   * Validates, rate-limits, deduplicates, and forwards a single `RelayEnvelope` (shared by WSS and HTTPS `/send`).
   */
  private processFrame(
    roomId: string,
    deviceId: string,
    sessionState: { lastSeq: number },
    rawEnvelope: unknown,
  ): { ok: true; id: string } | { ok: false; id: string; reason: string } {
    const rawId = rawEnvelope && typeof rawEnvelope === 'object' && typeof (rawEnvelope as { id?: unknown }).id === 'string'
      ? (rawEnvelope as { id: string }).id
      : '';

    if (!this.lobby.isAdmittedDevice(roomId, deviceId)) {
      return { ok: false, id: rawId, reason: 'not-admitted' };
    }
    if (!isValidRelayEnvelopeShape(rawEnvelope)) {
      return { ok: false, id: rawId, reason: 'invalid-envelope' };
    }
    const envelope: RelayEnvelope = rawEnvelope;
    if (envelope.room !== roomId) {
      return { ok: false, id: envelope.id, reason: 'cross-room' };
    }
    if (envelope.from !== deviceId) {
      return { ok: false, id: envelope.id, reason: 'sender-mismatch' };
    }

    const envelopeJson = JSON.stringify(envelope);
    const frameBytes = utf8Bytes(envelopeJson);
    if (frameBytes > RELAY_MAX_FRAME_BYTES) {
      return { ok: false, id: envelope.id, reason: 'frame-too-large' };
    }

    const recipients = Object.keys(envelope.to);
    if (recipients.length === 0) {
      return { ok: false, id: envelope.id, reason: 'no-recipients' };
    }
    if (recipients.includes(deviceId)) {
      return { ok: false, id: envelope.id, reason: 'reflected' };
    }

    const admitted = this.lobby.admittedDeviceIds(roomId);
    for (const r of recipients) {
      if (!admitted.has(r)) {
        return { ok: false, id: envelope.id, reason: 'recipient-not-admitted' };
      }
    }

    // A repeated envelope id is reported as a duplicate even though its seq is also stale: the sender should learn
    // "already accepted", not "out of order", and must not treat it as a sequencing bug.
    const now = this.now();
    this.pruneDedup(now);
    const dedupKey = `${roomId}:${envelope.id}`;
    const seenAt = this.seenFrames.get(dedupKey);
    if (seenAt !== undefined && now - seenAt < this.dedupWindowMs) {
      return { ok: false, id: envelope.id, reason: 'duplicate' };
    }

    if (envelope.seq <= sessionState.lastSeq) {
      return { ok: false, id: envelope.id, reason: 'seq-out-of-order' };
    }

    if (!this.chargeRateLimit(`${roomId}:${deviceId}`, frameBytes, now)) {
      return { ok: false, id: envelope.id, reason: 'rate-limit' };
    }

    sessionState.lastSeq = envelope.seq;
    this.seenFrames.set(dedupKey, now);

    const senderWakeable = this.lobby.isWakeableDevice(roomId, deviceId);
    const wakeTargets = envelope.wake ? new Set(envelope.wake) : undefined;

    for (const recipientId of recipients) {
      this.deliverToRecipient(roomId, recipientId, deviceId, senderWakeable, envelope, envelopeJson, frameBytes, wakeTargets?.has(recipientId) ?? false);
    }

    return { ok: true, id: envelope.id };
  }

  private deliverToRecipient(
    roomId: string,
    recipientId: string,
    senderId: string,
    senderWakeable: boolean,
    envelope: RelayEnvelope,
    envelopeJson: string,
    frameBytes: number,
    shouldWake: boolean,
  ) {
    const key = `${roomId}:${recipientId}`;

    // 1. Live WSS socket -> immediate two-lane delivery.
    const liveWs = this.sockets.get(key);
    if (liveWs && liveWs.data.authenticated) {
      this.enqueueSocket(liveWs, envelope.lane, { t: 'frame', envelope });
      return;
    }

    // 2. Waiting HTTPS long-poll -> immediate delivery.
    const httpsSession = this.httpsSessions.get(key);
    if (httpsSession?.waiter) {
      const waiter = httpsSession.waiter;
      this.clearWaiter(httpsSession);
      const cursor = Math.max(waiter.after, this.getMaxInboxCursor(roomId, recipientId));
      waiter.resolve({ frames: [{ cursor, envelope }], cursor });
      return;
    }

    const recipientWakeable = this.lobby.isWakeableDevice(roomId, recipientId);

    // 3. Non-wakeable client actively on HTTPS fallback (between two long-polls) -> ephemeral in-memory queue only.
    if (!recipientWakeable && httpsSession && this.now() - httpsSession.lastActivityAt <= this.httpsSessionTtlMs) {
      if (envelope.lane === 'primary') {
        if (httpsSession.primaryQueue.length < 256) httpsSession.primaryQueue.push({ envelope, bytes: frameBytes });
      } else if (httpsSession.fileQueuedBytes + frameBytes <= this.fileLaneBudgetBytes) {
        httpsSession.fileQueue.push({ envelope, bytes: frameBytes });
        httpsSession.fileQueuedBytes += frameBytes;
      }
      return;
    }

    // 4. Offline recipient: bounded ciphertext inbox ONLY when hold === true AND (recipient or sender is wakeable).
    let pendingCount = 0;
    if (envelope.hold === true && (recipientWakeable || senderWakeable)) {
      const stored = this.storeInInbox(roomId, recipientId, senderId, envelope.id, envelopeJson, frameBytes);
      pendingCount = stored.pendingCount;
    }

    // 5. Wake trigger ONLY when a frame was actually stored in the inbox (pendingCount > 0), wake lists R, R is wakeable, and R has no live session.
    if (shouldWake && recipientWakeable && pendingCount > 0 && this.wakeConnector) {
      void this.wakeConnector.notify(roomId, recipientId, senderId, pendingCount);
    }
  }

  private pruneDedup(now: number) {
    if (this.seenFrames.size < 256) return;
    const cutoff = now - this.dedupWindowMs;
    for (const [k, at] of this.seenFrames) {
      if (at <= cutoff) this.seenFrames.delete(k);
      else break; // Map preserves insertion order (oldest first).
    }
  }

  private chargeRateLimit(deviceKey: string, bytes: number, now: number): boolean {
    const cutoff = now - 60_000;
    const existing = this.rateWindows.get(deviceKey);
    const active = existing ? existing.filter(e => e.at > cutoff) : [];
    let totalBytes = 0;
    for (const e of active) totalBytes += e.bytes;
    if (active.length >= this.rateFramesPerMin || totalBytes + bytes > this.rateBytesPerMin) {
      if (active.length) this.rateWindows.set(deviceKey, active);
      else this.rateWindows.delete(deviceKey);
      return false;
    }
    active.push({ at: now, bytes });
    this.rateWindows.set(deviceKey, active);
    return true;
  }

  private storeInInbox(
    roomId: string,
    recipientId: string,
    senderId: string,
    frameId: string,
    envelopeJson: string,
    bytes: number,
  ): { cursor: number; pendingCount: number } {
    const now = this.now();
    return this.db.transaction(() => {
      this.db.query('DELETE FROM relay_inbox WHERE expires_at <= ?').run(now);
      const existing = this.db.query(
        'SELECT cursor FROM relay_inbox WHERE room_id = ? AND recipient_id = ? AND frame_id = ?',
      ).get(roomId, recipientId, frameId) as { cursor: number } | null;
      if (existing) {
        const count = (this.db.query('SELECT COUNT(*) AS n FROM relay_inbox WHERE room_id = ? AND recipient_id = ?').get(roomId, recipientId) as { n: number }).n;
        return { cursor: existing.cursor, pendingCount: count };
      }

      // Enforce per-device caps (max 500 frames, max 8 MB): oldest evicted first.
      let stats = this.db.query(
        'SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS total FROM relay_inbox WHERE room_id = ? AND recipient_id = ?',
      ).get(roomId, recipientId) as { n: number; total: number };
      while (stats.n >= this.inboxMaxFrames || stats.total + bytes > this.inboxMaxBytes) {
        const oldest = this.db.query(
          'SELECT cursor, bytes FROM relay_inbox WHERE room_id = ? AND recipient_id = ? ORDER BY cursor ASC LIMIT 1',
        ).get(roomId, recipientId) as { cursor: number; bytes: number } | null;
        if (!oldest) break;
        this.db.query('DELETE FROM relay_inbox WHERE cursor = ?').run(oldest.cursor);
        stats = { n: stats.n - 1, total: stats.total - oldest.bytes };
      }

      // Enforce per-room cap (max 32 MB): oldest evicted first.
      let roomTotal = (this.db.query(
        'SELECT COALESCE(SUM(bytes), 0) AS total FROM relay_inbox WHERE room_id = ?',
      ).get(roomId) as { total: number }).total;
      while (roomTotal + bytes > this.inboxMaxRoomBytes) {
        const oldest = this.db.query(
          'SELECT cursor, bytes FROM relay_inbox WHERE room_id = ? ORDER BY cursor ASC LIMIT 1',
        ).get(roomId) as { cursor: number; bytes: number } | null;
        if (!oldest) break;
        this.db.query('DELETE FROM relay_inbox WHERE cursor = ?').run(oldest.cursor);
        roomTotal -= oldest.bytes;
      }

      const info = this.db.query(
        'INSERT INTO relay_inbox (room_id, recipient_id, sender_id, frame_id, envelope_json, bytes, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run(roomId, recipientId, senderId, frameId, envelopeJson, bytes, now, now + this.inboxTtlMs);
      const pendingCount = (this.db.query(
        'SELECT COUNT(*) AS n FROM relay_inbox WHERE room_id = ? AND recipient_id = ?',
      ).get(roomId, recipientId) as { n: number }).n;
      return { cursor: Number(info.lastInsertRowid), pendingCount };
    }).immediate();
  }

  private readInbox(roomId: string, recipientId: string, after: number): { cursor: number; envelope: RelayEnvelope }[] {
    const now = this.now();
    this.db.query('DELETE FROM relay_inbox WHERE expires_at <= ?').run(now);
    const rows = this.db.query(
      'SELECT cursor, envelope_json FROM relay_inbox WHERE room_id = ? AND recipient_id = ? AND cursor > ? ORDER BY cursor ASC',
    ).all(roomId, recipientId, after) as { cursor: number; envelope_json: string }[];
    return rows.map(r => ({ cursor: r.cursor, envelope: JSON.parse(r.envelope_json) as RelayEnvelope }));
  }

  private ackInbox(roomId: string, recipientId: string, ackCursor: number) {
    this.db.query('DELETE FROM relay_inbox WHERE room_id = ? AND recipient_id = ? AND cursor <= ?').run(roomId, recipientId, ackCursor);
  }

  private getMaxInboxCursor(roomId: string, recipientId: string): number {
    const row = this.db.query(
      'SELECT COALESCE(MAX(cursor), 0) AS c FROM relay_inbox WHERE room_id = ? AND recipient_id = ?',
    ).get(roomId, recipientId) as { c: number };
    return row.c;
  }

  /** Returns current inbox count and byte total for a device (useful for diagnostics and tests). */
  inboxStats(roomId: string, recipientId: string): { count: number; bytes: number } {
    const now = this.now();
    this.db.query('DELETE FROM relay_inbox WHERE expires_at <= ?').run(now);
    const row = this.db.query(
      'SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM relay_inbox WHERE room_id = ? AND recipient_id = ?',
    ).get(roomId, recipientId) as { count: number; bytes: number };
    return row;
  }

  private getOrCreateHttpsSession(roomId: string, deviceId: string, sessionId: string): HttpsSessionState {
    const key = `${roomId}:${deviceId}`;
    const existing = this.httpsSessions.get(key);
    const now = this.now();
    if (existing && existing.session === sessionId) {
      existing.lastActivityAt = now;
      return existing;
    }
    if (existing?.waiter) {
      const waiter = existing.waiter;
      this.clearWaiter(existing);
      waiter.resolve({ frames: [], cursor: waiter.after });
    }
    const fresh: HttpsSessionState = {
      session: sessionId,
      lastSeq: 0,
      lastActivityAt: now,
      primaryQueue: [],
      fileQueue: [],
      fileQueuedBytes: 0,
    };
    this.httpsSessions.set(key, fresh);
    return fresh;
  }

  private clearWaiter(state: HttpsSessionState) {
    if (!state.waiter) return;
    clearTimeout(state.waiter.timer);
    state.waiter.cleanupAbort?.();
    state.waiter = undefined;
  }

  private drainHttpsLiveQueues(state: HttpsSessionState, fallbackCursor: number): { cursor: number; envelope: RelayEnvelope }[] {
    const out: { cursor: number; envelope: RelayEnvelope }[] = [];
    // Two-lane priority: drain primary before file.
    while (state.primaryQueue.length > 0) {
      out.push({ cursor: fallbackCursor, envelope: state.primaryQueue.shift()!.envelope });
    }
    while (state.fileQueue.length > 0) {
      const next = state.fileQueue.shift()!;
      state.fileQueuedBytes = Math.max(0, state.fileQueuedBytes - next.bytes);
      out.push({ cursor: fallbackCursor, envelope: next.envelope });
    }
    return out;
  }

  /**
   * Handles HTTPS fallback routes under `/api/relay/v1/{open,send,poll,wake-register,state}`.
   * All endpoints authenticate with a `SignedCommand` verified via `BrowserLobby.verifySignedCommand`.
   */
  async handleHttp(pathname: string, input: SignedCommand, signal?: AbortSignal): Promise<unknown> {
    switch (pathname) {
      case '/api/relay/v1/open':
        return this.handleHttpOpen(input);
      case '/api/relay/v1/send':
        return this.handleHttpSend(input);
      case '/api/relay/v1/poll':
        return this.handleHttpPoll(input, signal);
      case '/api/relay/v1/wake-register':
        return this.handleHttpWakeRegister(input);
      case '/api/relay/v1/state':
        return this.handleHttpState(input);
      default:
        throw new LobbyError(404, 'Not found.');
    }
  }

  private consumeCommandId(deviceId: string, commandId: string) {
    const now = this.now();
    const cutoff = now - COMMAND_REPLAY_TTL_MS;
    for (const [k, at] of this.seenCommandIds) {
      if (at <= cutoff) this.seenCommandIds.delete(k);
      else break;
    }
    const key = `${deviceId}:${commandId}`;
    const seenAt = this.seenCommandIds.get(key);
    if (seenAt !== undefined && now - seenAt <= COMMAND_REPLAY_TTL_MS) {
      throw new LobbyError(409, 'That request ID was already used.');
    }
    this.seenCommandIds.set(key, now);
  }

  private async handleHttpOpen(input: SignedCommand) {
    const { command, deviceId } = await this.lobby.verifySignedCommand(input, 'relay-open');
    const roomId = command.roomId;
    this.lobby.assertAdmittedDevice(roomId, deviceId);
    this.consumeCommandId(deviceId, command.id);
    const requestedSession = command.payload.session;
    const session = requestedSession === undefined
      ? crypto.randomUUID()
      : isValidSessionId(requestedSession)
        ? requestedSession
        : (() => { throw new LobbyError(400, 'Invalid relay session.'); })();

    this.getOrCreateHttpsSession(roomId, deviceId, session);
    this.wakeConnector?.clearPending(roomId, deviceId);
    const cursor = this.getMaxInboxCursor(roomId, deviceId);
    const rosterVersion = this.lobby.getRoomRoster(roomId)?.body.version ?? 0;
    this.logOp('http-open', 200);
    return { session, cursor, rosterVersion };
  }

  private async handleHttpSend(input: SignedCommand) {
    const { command, deviceId } = await this.lobby.verifySignedCommand(input, 'relay-send');
    const roomId = command.roomId;
    this.lobby.assertAdmittedDevice(roomId, deviceId);
    this.consumeCommandId(deviceId, command.id);
    const { session, envelopes } = command.payload;
    if (!isValidSessionId(session)) throw new LobbyError(400, 'Invalid relay session.');
    if (!Array.isArray(envelopes) || envelopes.length === 0 || envelopes.length > RELAY_MAX_SEND_BATCH) {
      throw new LobbyError(400, `Provide between 1 and ${RELAY_MAX_SEND_BATCH} envelopes.`);
    }
    const state = this.getOrCreateHttpsSession(roomId, deviceId, session);
    const accepted: string[] = [];
    const rejected: { id: string; reason: string }[] = [];
    for (const env of envelopes) {
      const verdict = this.processFrame(roomId, deviceId, state, env);
      if (verdict.ok) accepted.push(verdict.id);
      else rejected.push({ id: verdict.id, reason: verdict.reason });
    }
    this.logOp('http-send', 200, { accepted: accepted.length, rejected: rejected.length });
    return { accepted, rejected };
  }

  private async handleHttpPoll(input: SignedCommand, signal?: AbortSignal) {
    const { command, deviceId } = await this.lobby.verifySignedCommand(input, 'relay-poll');
    const roomId = command.roomId;
    this.lobby.assertAdmittedDevice(roomId, deviceId);
    const { session, after: rawAfter, waitSeconds: rawWait, ackCursor } = command.payload;
    if (!isValidSessionId(session)) throw new LobbyError(400, 'Invalid relay session.');
    if (ackCursor !== undefined) {
      if (typeof ackCursor !== 'number' || !Number.isInteger(ackCursor) || ackCursor < 0) {
        throw new LobbyError(400, 'Invalid ackCursor.');
      }
      if (ackCursor > 0) this.ackInbox(roomId, deviceId, ackCursor);
    }
    const after = rawAfter === undefined ? 0 : (typeof rawAfter === 'number' && Number.isInteger(rawAfter) && rawAfter >= 0 ? rawAfter : (() => { throw new LobbyError(400, 'Invalid after cursor.'); })());
    const waitSeconds = rawWait === undefined ? 0 : (typeof rawWait === 'number' && Number.isFinite(rawWait) && rawWait >= 0 ? Math.min(rawWait, RELAY_MAX_LONG_POLL_SECONDS) : (() => { throw new LobbyError(400, 'Invalid waitSeconds.'); })());

    const state = this.getOrCreateHttpsSession(roomId, deviceId, session);
    this.wakeConnector?.clearPending(roomId, deviceId);

    const inboxFrames = this.readInbox(roomId, deviceId, after);
    const maxInboxCursor = inboxFrames.length > 0 ? inboxFrames[inboxFrames.length - 1].cursor : Math.max(after, this.getMaxInboxCursor(roomId, deviceId));
    const liveFrames = this.drainHttpsLiveQueues(state, maxInboxCursor);
    const combined = [...inboxFrames, ...liveFrames];
    if (combined.length > 0 || waitSeconds <= 0) {
      this.logOp('http-poll', 200, { frames: combined.length });
      return { frames: combined, cursor: maxInboxCursor };
    }

    if (signal?.aborted) {
      return { frames: [], cursor: maxInboxCursor };
    }

    // Replace any stale waiter on this session before parking the new long-poll.
    if (state.waiter) {
      const prev = state.waiter;
      this.clearWaiter(state);
      prev.resolve({ frames: [], cursor: prev.after });
    }

    const result = await new Promise<{ frames: { cursor: number; envelope: RelayEnvelope }[]; cursor: number }>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (state.waiter?.resolve === resolve) {
          this.clearWaiter(state);
          resolve({ frames: [], cursor: Math.max(after, this.getMaxInboxCursor(roomId, deviceId)) });
        }
      }, Math.round(waitSeconds * 1000));

      let cleanupAbort: (() => void) | undefined;
      if (signal) {
        const onAbort = () => {
          if (state.waiter?.resolve === resolve) {
            this.clearWaiter(state);
            resolve({ frames: [], cursor: Math.max(after, this.getMaxInboxCursor(roomId, deviceId)) });
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        cleanupAbort = () => signal.removeEventListener('abort', onAbort);
      }

      state.waiter = { resolve, reject, timer, after: maxInboxCursor, cleanupAbort };
    });

    this.logOp('http-poll', 200, { frames: result.frames.length });
    return result;
  }

  private async handleHttpWakeRegister(input: SignedCommand) {
    const { command, deviceId } = await this.lobby.verifySignedCommand(input, 'relay-wake-register');
    const roomId = command.roomId;
    this.lobby.assertAdmittedDevice(roomId, deviceId);
    this.consumeCommandId(deviceId, command.id);
    if (!this.wakeConnector) throw new LobbyError(503, 'Wake connector is not enabled on this relay.');

    const { url, key, provider } = command.payload;
    if (url === null) {
      this.wakeConnector.unregister(roomId, deviceId);
      this.lobby.setDeviceWakeable(roomId, deviceId, false);
      this.logOp('http-wake-register', 200, { wakeable: 0 });
      return { inboxId: null, wakeable: false };
    }
    if (typeof url !== 'string' || typeof key !== 'string') {
      throw new LobbyError(400, 'Provide both webhook url and bearer key, or url: null to unregister.');
    }
    try {
      const registered = this.wakeConnector.register(roomId, deviceId, url, key, provider as WakeProvider | undefined);
      this.lobby.setDeviceWakeable(roomId, deviceId, true);
      this.logOp('http-wake-register', 200, { wakeable: 1 });
      return { inboxId: registered.inboxId, wakeable: true, provider: registered.provider };
    } catch (error) {
      if (error instanceof WakeValidationError) throw new LobbyError(400, error.message);
      throw error;
    }
  }

  private async handleHttpState(input: SignedCommand) {
    const { command, deviceId } = await this.lobby.verifySignedCommand(input, ['relay-state-get', 'relay-state-put']);
    const roomId = command.roomId;
    this.lobby.assertAdmittedDevice(roomId, deviceId);

    if (command.action === 'relay-state-get') {
      const row = this.db.query(
        'SELECT state, updated_at FROM relay_sealed_state WHERE room_id = ? AND device_id = ?',
      ).get(roomId, deviceId) as { state: string; updated_at: number } | null;
      this.logOp('http-state-get', 200);
      return { state: row?.state ?? null, updatedAt: row?.updated_at ?? null };
    }

    this.consumeCommandId(deviceId, command.id);
    const blob = command.payload.state;
    if (blob === null) {
      this.db.query('DELETE FROM relay_sealed_state WHERE room_id = ? AND device_id = ?').run(roomId, deviceId);
      this.logOp('http-state-put', 200);
      return { state: null, updatedAt: null };
    }
    if (typeof blob !== 'string' || blob.length === 0 || blob.length % 4 !== 0 || !BASE64_STD.test(blob)) {
      throw new LobbyError(400, 'Sealed state must be a valid base64 string or null.');
    }
    if (blob.length > SEALED_STATE_MAX_BYTES) {
      throw new LobbyError(413, `Sealed state exceeds maximum ${SEALED_STATE_MAX_BYTES} bytes.`);
    }
    const updatedAt = this.now();
    this.db.query(
      'INSERT OR REPLACE INTO relay_sealed_state (room_id, device_id, state, bytes, updated_at) VALUES (?,?,?,?,?)',
    ).run(roomId, deviceId, blob, blob.length, updatedAt);
    this.logOp('http-state-put', 200);
    return { state: blob, updatedAt };
  }

  /** Immediately closes removed device sockets/polls and deletes its inbox, sealed state, and wake registration. */
  private handleDeviceRemoved(roomId: string, deviceId: string) {
    const key = `${roomId}:${deviceId}`;
    const ws = this.sockets.get(key);
    if (ws) {
      this.sockets.delete(key);
      this.sendImmediate(ws, { t: 'error', code: 'removed', message: 'This device was removed from the room.' });
      try { ws.close(4003, 'Removed'); } catch { /* ignore */ }
    }
    const httpsSession = this.httpsSessions.get(key);
    if (httpsSession) {
      if (httpsSession.waiter) {
        const waiter = httpsSession.waiter;
        this.clearWaiter(httpsSession);
        waiter.reject(new LobbyError(403, 'This device was removed from the room.'));
      }
      this.httpsSessions.delete(key);
    }
    this.rateWindows.delete(key);
    this.db.query('DELETE FROM relay_inbox WHERE room_id = ? AND recipient_id = ?').run(roomId, deviceId);
    this.db.query('DELETE FROM relay_sealed_state WHERE room_id = ? AND device_id = ?').run(roomId, deviceId);
    this.wakeConnector?.unregister(roomId, deviceId);
    this.logOp('device-removed', 200);
  }

  /** Immediately closes all sockets/polls in a closed or expired room and deletes all relay data for it. */
  private handleRoomClosed(roomId: string) {
    const prefix = `${roomId}:`;
    for (const [key, ws] of this.sockets) {
      if (!key.startsWith(prefix)) continue;
      this.sockets.delete(key);
      this.sendImmediate(ws, { t: 'error', code: ROOM_CLOSED, message: 'This room was closed.' });
      try { ws.close(4010, ROOM_CLOSED); } catch { /* ignore */ }
    }
    for (const [key, session] of this.httpsSessions) {
      if (!key.startsWith(prefix)) continue;
      if (session.waiter) {
        const waiter = session.waiter;
        this.clearWaiter(session);
        waiter.reject(new LobbyError(410, 'This room was closed.', ROOM_CLOSED));
      }
      this.httpsSessions.delete(key);
    }
    for (const key of this.rateWindows.keys()) {
      if (key.startsWith(prefix)) this.rateWindows.delete(key);
    }
    for (const key of this.seenFrames.keys()) {
      if (key.startsWith(prefix)) this.seenFrames.delete(key);
    }
    this.db.query('DELETE FROM relay_inbox WHERE room_id = ?').run(roomId);
    this.db.query('DELETE FROM relay_sealed_state WHERE room_id = ?').run(roomId);
    this.wakeConnector?.deleteRoom(roomId);
    this.logOp('room-closed', 200);
  }

  /** Cleanly stops all timers, closes open sockets, resolves waiting long-polls, and closes the relay SQLite DB. */
  close() {
    this.unsubRemoved();
    this.unsubClosed();
    for (const ws of this.openSockets) {
      if (ws.data.authTimer) clearTimeout(ws.data.authTimer);
      if (ws.data.heartbeatTimer) clearInterval(ws.data.heartbeatTimer);
      try { ws.close(1001, 'Server shutting down'); } catch { /* ignore */ }
    }
    this.openSockets.clear();
    this.sockets.clear();
    for (const session of this.httpsSessions.values()) {
      if (session.waiter) {
        const waiter = session.waiter;
        this.clearWaiter(session);
        waiter.resolve({ frames: [], cursor: waiter.after });
      }
    }
    this.httpsSessions.clear();
    this.db.close();
  }
}
