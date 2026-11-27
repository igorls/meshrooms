import {
  browserProtocol,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  type Command,
  type RoomStatus,
  type SignedCommand,
} from './protocol';
import {
  encryptRelayEnvelope,
  isValidRelayEnvelopeShape,
  RELAY_MAX_FRAME_BYTES,
  SEALED_STATE_MAX_BYTES,
  type EncryptEnvelopeOptions,
  type RelayEnvelope,
  type RelayLane,
} from './relay-crypto';

export type RelayTransportState = 'disconnected' | 'connecting' | 'wss' | 'https';

export type RelayStatusError = Error & { status?: number; code?: string };

export type RelayReceivedMeta = {
  cursor?: number;
  carrier: 'wss' | 'https';
};

export type RelayClientOptions = {
  /** Base HTTP(S) origin of the Meshrooms room service, e.g. `https://meshrooms.wormdb.dev`. */
  origin: string;
  /** Optional explicit WSS relay endpoint URL; defaults to `${origin.replace(/^http/, 'ws')}/api/relay/v1`. */
  relayUrl?: string;
  roomId: string;
  deviceId: string;
  publicKey: string;
  /** Session identifier bound to this relay connection; defaults to a fresh UUID. */
  session?: string;
  /** Signs a Command object with this device's ECDSA P-256 private key. */
  sign: (value: unknown) => Promise<string>;
  /** Returns the current verified roster version for `relay-open`. */
  rosterVersion?: () => number;
  /** Called for every valid `RelayEnvelope` received over WSS or HTTPS long-poll. */
  onEnvelope?: (envelope: RelayEnvelope, meta: RelayReceivedMeta) => void | Promise<void>;
  /**
   * Called with each room status the service pushes to a socket that watches it (`watchStatus`): on every change in
   * the room and every 10 s. While pushes arrive (`statusLive`), the device doesn't poll `status`.
   */
  onStatus?: (status: RoomStatus) => void;
  /** Called when pushed status stops (socket closed, a push failed): a caller waiting for the next push polls instead. */
  onStatusLost?: () => void;
  /** Called whenever transport mode changes (`disconnected`, `connecting`, `wss`, `https`). */
  onStateChange?: (state: RelayTransportState) => void;
  /** Called when the relay acknowledges accepting a frame (NEVER a peer delivery receipt). */
  onAccepted?: (id: string) => void;
  /** Called when the relay rejects a frame. */
  onRejected?: (id: string, reason: string, status?: number) => void;
  /** Called on terminal auth/room errors (403 removed/unauthorized, 410 room closed). */
  onAuthError?: (status: number, message: string) => void;
  /** Called on transient transport errors. */
  onError?: (error: Error) => void;
  /** Fallback to HTTPS if WSS upgrade does not complete within this window (default 10s). */
  wssUpgradeTimeoutMs?: number;
  /** How often to retry WSS while operating in HTTPS fallback mode (default 10 min). */
  wssRetryIntervalMs?: number;
  /** Heartbeat ping interval on WSS (default 25s). */
  heartbeatIntervalMs?: number;
  /** Long-poll duration in seconds for HTTPS fallback (default 25s). */
  pollWaitSeconds?: number;
  /** Base reconnect backoff in milliseconds (default 1s). */
  reconnectBaseMs?: number;
  /** Maximum reconnect backoff in milliseconds (default 30s). */
  reconnectMaxMs?: number;
  /** Maximum bytes of `file`-lane frames in flight awaiting relay acceptance (default 1 MB). */
  fileInFlightCapBytes?: number;
  /** Maximum queued primary frames (default 512). */
  maxQueuedPrimary?: number;
  /** Maximum queued file frames (default 1024). */
  maxQueuedFile?: number;
  /** A delivered inbox frame never committed or acknowledged after this long is given up on so it can't pin the inbox (default 10 min). */
  pendingAckMaxAgeMs?: number;
  /** Injectable fetch implementation for tests. */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Injectable WebSocket constructor for tests. */
  WebSocket?: new (url: string) => WebSocket;
  /** Injectable clock for deterministic timing in tests. */
  now?: () => number;
};

export type SendPacketOptions = Omit<EncryptEnvelopeOptions, 'room' | 'from' | 'seq' | 'id' | 'sign'> & {
  id?: string;
};

type QueuedItem =
  | {
      kind: 'envelope';
      id: string;
      lane: RelayLane;
      envelope: RelayEnvelope;
      wireBytes: number;
    }
  | {
      kind: 'packet';
      id: string;
      lane: RelayLane;
      /** Whether the sender named a recipient to wake (it addresses someone): such a packet is never dropped for room chatter. */
      addressed: boolean;
      build: (seq: number) => Promise<RelayEnvelope>;
      envelope?: RelayEnvelope;
      wireBytes?: number;
    };

type InFlightEntry = {
  item: QueuedItem;
  lane: RelayLane;
  wireBytes: number;
  sentAt: number;
};

export const DEFAULT_WSS_UPGRADE_TIMEOUT_MS = 10_000;
export const DEFAULT_WSS_RETRY_INTERVAL_MS = 600_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;
export const DEFAULT_POLL_WAIT_SECONDS = 25;
/**
 * How long pushed status counts as live after the last push: the service pushes at least every 10 s, so two missed
 * refreshes mean the push stopped, and the device polls `status` again, still inside the 25 s presence window.
 */
export const STATUS_LIVE_MS = 22_000;
export const DEFAULT_FILE_IN_FLIGHT_CAP_BYTES = 1024 * 1024;
export const DEFAULT_PENDING_ACK_MAX_AGE_MS = 600_000;
/** Target batch byte ceiling for `POST /api/relay/v1/send` so JSON + SignedCommand stays <= 64 KB. */
const HTTPS_SEND_BATCH_MAX_BYTES = 56 * 1024;
const WSS_BUFFERED_HIGH_WATER = 256 * 1024;
const textEncoder = new TextEncoder();

function utf8Length(text: string): number {
  return textEncoder.encode(text).byteLength;
}

function defaultWsUrl(origin: string): string {
  const normalized = origin.replace(/\/+$/, '');
  if (normalized.startsWith('https://')) return `wss://${normalized.slice('https://'.length)}/api/relay/v1`;
  if (normalized.startsWith('http://')) return `ws://${normalized.slice('http://'.length)}/api/relay/v1`;
  return `${normalized}/api/relay/v1`;
}

function httpBaseUrl(origin: string, relayUrl?: string): string {
  if (relayUrl) {
    try {
      const parsed = new URL(relayUrl);
      const proto = parsed.protocol === 'wss:' ? 'https:' : parsed.protocol === 'ws:' ? 'http:' : parsed.protocol;
      const path = parsed.pathname.replace(/\/+$/, '') || '/api/relay/v1';
      return `${proto}//${parsed.host}${path}`;
    } catch {
      // Fall through to origin-based URL.
    }
  }
  return `${origin.replace(/\/+$/, '')}/api/relay/v1`;
}

function makeStatusError(message: string, status?: number, code?: string): RelayStatusError {
  const err = new Error(message) as RelayStatusError;
  if (status !== undefined) err.status = status;
  if (code !== undefined) err.code = code;
  return err;
}

function mapWssCloseStatus(code: number | undefined): 403 | 410 | undefined {
  if (code === 4003 || code === 4403) return 403;
  if (code === 4010 || code === 4410) return 410;
  return undefined;
}

function mapWssErrorStatus(msg: Record<string, unknown>): number | undefined {
  if (typeof msg.status === 'number') return msg.status;
  if (msg.code === 'removed' || msg.code === 'forbidden') return 403;
  if (msg.code === 'room-closed') return 410;
  return undefined;
}

function wssErrorMessage(msg: Record<string, unknown>, fallback = 'Relay error'): string {
  if (typeof msg.message === 'string' && msg.message) return msg.message;
  if (typeof msg.error === 'string' && msg.error) return msg.error;
  if (typeof msg.reason === 'string' && msg.reason) return msg.reason;
  return fallback;
}

/**
 * Dual-carrier E2E relay client supporting WebSocket (WSS) with automatic HTTPS send + long-poll
 * fallback, strict `primary`-before-`file` two-lane priority pacing, monotonic session sequencing,
 * and one-shot cloud-agent inbox draining + sealed state persistence.
 *
 * Works identically in browsers and Bun (uses only standard `WebSocket`, `fetch`, and `crypto`).
 */
export class RelayClient {
  readonly origin: string;
  readonly relayUrl: string;
  readonly httpRelayBase: string;
  readonly roomId: string;
  readonly deviceId: string;
  private readonly publicKey: string;
  private readonly signFn: (value: unknown) => Promise<string>;
  private readonly rosterVersionFn: () => number;
  private readonly fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  private readonly WebSocketImpl: (new (url: string) => WebSocket) | undefined;
  private readonly now: () => number;
  private readonly wssUpgradeTimeoutMs: number;
  private readonly wssRetryIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly pollWaitSeconds: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly fileInFlightCapBytes: number;
  private readonly maxQueuedPrimary: number;
  private readonly maxQueuedFile: number;
  private readonly pendingAckMaxAgeMs: number;

  private session: string;
  private seq = 0;
  /** Highest cursor fetched from the server in this session (used as `after` on polls so in-flight frames aren't re-fetched). */
  private cursor = 0;
  /** Highest contiguous durably-committed cursor acknowledged to the server for inbox deletion. */
  private ackedCursor = 0;
  /** Ordered ascending list of delivered inbox cursors awaiting durable commit (`ackCursor`). */
  private pendingCursors: number[] = [];
  private pendingCursorSet = new Set<number>();
  /** Out-of-order committed cursors waiting for earlier `pendingCursors` entries to commit. */
  private committedCursors = new Set<number>();
  private state: RelayTransportState = 'disconnected';
  private stopped = true;
  private terminalAuthFailed = false;

  private ws?: WebSocket;
  private wsAuthed = false;
  private wsUpgradeTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private wssRetryTimer?: ReturnType<typeof setTimeout>;
  private lastPongAt = 0;
  /** The room status this device watches over the socket, re-sent on every reconnect. */
  private statusWatch?: { session: string; epoch?: string; cursor: number };
  /** Whether the service said, in `ready`, that it pushes status. Older services don't. */
  private pushesStatus = false;
  private lastStatusAt = 0;
  private reconnectAttempt = 0;
  private nextWssRetryAt = 0;

  private httpsAbort?: AbortController;
  private httpsLoopRunning = false;
  private httpsSendRunning = false;
  private drainScheduled = false;
  private wssDrainRunning = false;

  private primaryQueue: QueuedItem[] = [];
  private fileQueue: QueuedItem[] = [];
  private inFlight = new Map<string, InFlightEntry>();
  private fileInFlightBytes = 0;

  constructor(private readonly options: RelayClientOptions) {
    this.origin = options.origin.replace(/\/+$/, '');
    this.relayUrl = options.relayUrl || defaultWsUrl(this.origin);
    this.httpRelayBase = httpBaseUrl(this.origin, options.relayUrl);
    this.roomId = options.roomId;
    this.deviceId = options.deviceId;
    this.publicKey = options.publicKey;
    this.session = options.session || crypto.randomUUID();
    this.signFn = options.sign;
    this.rosterVersionFn = options.rosterVersion ?? (() => 1);
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.WebSocketImpl = options.WebSocket ?? (typeof WebSocket !== 'undefined' ? WebSocket : undefined);
    this.now = options.now ?? (() => Date.now());
    this.wssUpgradeTimeoutMs = options.wssUpgradeTimeoutMs ?? DEFAULT_WSS_UPGRADE_TIMEOUT_MS;
    this.wssRetryIntervalMs = options.wssRetryIntervalMs ?? DEFAULT_WSS_RETRY_INTERVAL_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.pollWaitSeconds = options.pollWaitSeconds ?? DEFAULT_POLL_WAIT_SECONDS;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 1_000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 30_000;
    this.fileInFlightCapBytes = options.fileInFlightCapBytes ?? DEFAULT_FILE_IN_FLIGHT_CAP_BYTES;
    this.pendingAckMaxAgeMs = options.pendingAckMaxAgeMs ?? DEFAULT_PENDING_ACK_MAX_AGE_MS;
    this.maxQueuedPrimary = options.maxQueuedPrimary ?? 512;
    this.maxQueuedFile = options.maxQueuedFile ?? 1024;
  }

  get transportState(): RelayTransportState {
    return this.state;
  }

  get currentSession(): string {
    return this.session;
  }

  get currentCursor(): number {
    return this.cursor;
  }

  /** Highest contiguous durably-committed cursor sent to the relay as `ackCursor`. */
  get committedAckCursor(): number {
    return this.ackedCursor;
  }

  /** Number of delivered inbox cursors still awaiting durable commit. */
  get pendingAckCount(): number {
    return this.pendingCursors.length;
  }

  get pendingPrimaryCount(): number {
    return this.primaryQueue.length;
  }

  get pendingFileCount(): number {
    return this.fileQueue.length;
  }

  get currentFileInFlightBytes(): number {
    return this.fileInFlightBytes;
  }

  /**
   * Asks the service to push this room's status over the socket, as the lobby session `session` (the one this device
   * polls status as), from signal cursor `cursor` in `epoch`. Kept across reconnects; sent once the socket is ready.
   */
  watchStatus(watch: { session: string; epoch?: string; cursor: number }) {
    this.statusWatch = { session: watch.session, cursor: watch.cursor, ...(watch.epoch ? { epoch: watch.epoch } : {}) };
    this.sendWatch();
  }

  /** Signals up to `cursor` (in `epoch`) were handled: later pushes leave them out. */
  ackStatus(cursor: number, epoch?: string) {
    const watch = this.statusWatch;
    if (!watch || (watch.cursor === cursor && watch.epoch === epoch)) return;
    watch.cursor = cursor;
    if (epoch) watch.epoch = epoch;
    if (!this.wsAuthed || !this.pushesStatus || !this.ws) return;
    try { this.ws.send(JSON.stringify({ t: 'status-ack', cursor, ...(epoch ? { epoch } : {}) })); } catch { /* the close handler reconnects */ }
  }

  /** Whether the service pushes this room's status right now: the device needs no status polls while it does. */
  get statusLive(): boolean {
    return this.wsAuthed && this.pushesStatus && !!this.statusWatch && this.now() - this.lastStatusAt < STATUS_LIVE_MS;
  }

  /** How long pushed status stays live without another push: a caller waits this long at most, then polls. */
  get statusLiveRemainingMs(): number {
    return this.statusLive ? Math.max(0, STATUS_LIVE_MS - (this.now() - this.lastStatusAt)) : 0;
  }

  private statusLost() {
    const was = this.lastStatusAt !== 0;
    this.lastStatusAt = 0;
    if (was && this.statusWatch) this.options.onStatusLost?.();
  }

  private sendWatch() {
    if (!this.statusWatch || !this.wsAuthed || !this.pushesStatus || !this.ws) return;
    try { this.ws.send(JSON.stringify({ t: 'status-watch', ...this.statusWatch })); } catch { /* the close handler reconnects */ }
  }

  isConnected(): boolean {
    return this.state === 'wss' || this.state === 'https';
  }

  /** Allocates the next strictly increasing sequence number for the current relay session. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private setState(next: RelayTransportState) {
    if (this.state === next) return;
    this.state = next;
    this.options.onStateChange?.(next);
  }

  private async signCommand(action: Command['action'], payload: Record<string, unknown>): Promise<SignedCommand> {
    const command: Command = {
      protocol: browserProtocol,
      origin: this.origin,
      id: crypto.randomUUID(),
      at: this.now(),
      action,
      roomId: this.roomId,
      payload,
    };
    return {
      command,
      publicKey: this.publicKey,
      signature: await this.signFn(command),
    };
  }

  private async postRelayJson<T>(
    path: string,
    action: Command['action'],
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 35_000,
  ): Promise<T> {
    const signed = await this.signCommand(action, payload);
    const timeout = AbortSignal.timeout(timeoutMs);
    let combined: AbortSignal = timeout;
    if (signal) {
      if (typeof AbortSignal.any === 'function') {
        combined = AbortSignal.any([signal, timeout]);
      } else {
        const controller = new AbortController();
        const abort = (src: AbortSignal) => { if (!controller.signal.aborted) controller.abort(src.reason); };
        if (signal.aborted) abort(signal);
        else {
          signal.addEventListener('abort', () => abort(signal), { once: true });
          timeout.addEventListener('abort', () => abort(timeout), { once: true });
        }
        combined = controller.signal;
      }
    }
    const response = await this.fetchImpl(`${this.httpRelayBase}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: this.origin,
        [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      },
      body: JSON.stringify(signed),
      signal: combined,
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const message = typeof data.error === 'string' && data.error
        ? data.error
        : `Relay ${action} failed (${response.status}).`;
      const code = typeof data.code === 'string' ? data.code : undefined;
      if (response.status === 403 || response.status === 410) {
        this.handleTerminalAuthError(response.status, message);
      }
      throw makeStatusError(message, response.status, code);
    }
    return data as T;
  }

  private handleTerminalAuthError(status: number, message: string) {
    this.terminalAuthFailed = true;
    this.options.onAuthError?.(status, message);
    this.stop();
  }

  /** Start maintaining the relay connection (WSS first, automatic HTTPS fallback on failure/timeout). */
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.terminalAuthFailed = false;
    this.reconnectAttempt = 0;
    if (this.WebSocketImpl && this.now() >= this.nextWssRetryAt) {
      this.connectWss();
    } else {
      this.startHttpsFallback();
    }
  }

  /** Stop the relay connection cleanly and cancel timers/long-polls. */
  stop() {
    this.stopped = true;
    this.clearTimers();
    this.closeSocket();
    if (this.httpsAbort) {
      this.httpsAbort.abort();
      this.httpsAbort = undefined;
    }
    this.httpsLoopRunning = false;
    this.requeueInFlight();
    this.resetUncommittedFetchCursor();
    this.setState('disconnected');
  }

  private clearTimers() {
    if (this.wsUpgradeTimer) { clearTimeout(this.wsUpgradeTimer); this.wsUpgradeTimer = undefined; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    if (this.wssRetryTimer) { clearTimeout(this.wssRetryTimer); this.wssRetryTimer = undefined; }
  }

  private closeSocket() {
    const ws = this.ws;
    this.ws = undefined;
    this.wsAuthed = false;
    this.statusLost();
    if (!ws) return;
    try {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
    } catch {
      // Already closed.
    }
  }

  /** Re-queues any unaccepted in-flight items at the front of their lanes so zero frames are lost across switches. */
  private requeueInFlight() {
    if (!this.inFlight.size) return;
    const primaryBack: QueuedItem[] = [];
    const fileBack: QueuedItem[] = [];
    for (const entry of this.inFlight.values()) {
      if (entry.item.kind === 'packet') {
        entry.item.envelope = undefined;
        entry.item.wireBytes = undefined;
      }
      if (entry.lane === 'primary') primaryBack.push(entry.item);
      else fileBack.push(entry.item);
    }
    this.inFlight.clear();
    this.fileInFlightBytes = 0;
    if (primaryBack.length) this.primaryQueue.unshift(...primaryBack);
    if (fileBack.length) this.fileQueue.unshift(...fileBack);
  }

  /** Frames dropped from a full queue to make room (always unaddressed ones), and what waits now. */
  queueStats(): { primaryQueued: number; fileQueued: number; droppedUnaddressed: number } {
    return { primaryQueued: this.primaryQueue.length, fileQueued: this.fileQueue.length, droppedUnaddressed: this.droppedUnaddressed };
  }
  private droppedUnaddressed = 0;
  /** Inbox cursors given up on after `pendingAckMaxAgeMs` without a commit (see ackCursor). */
  abandonedCursors = 0;
  private pendingSince = new Map<number, number>();
  private static addressed(item: QueuedItem): boolean {
    return item.kind === 'packet' ? item.addressed : (item.envelope.wake?.length ?? 0) > 0;
  }
  /**
   * Makes room in a full lane without ever blocking it: the oldest frame that addresses nobody goes first (the room
   * resends its state on request). Returns false when every queued frame is addressed to someone, so the caller decides.
   */
  private makeRoom(queue: QueuedItem[], limit: number): boolean {
    if (queue.length < limit) return true;
    const victim = queue.findIndex(item => !RelayClient.addressed(item));
    if (victim < 0) return false;
    queue.splice(victim, 1);
    this.droppedUnaddressed++;
    return true;
  }

  /** Enqueues a pre-encrypted `RelayEnvelope` onto its lane (`primary` or `file`). */
  enqueue(envelope: RelayEnvelope): boolean {
    const serialized = JSON.stringify(envelope);
    const wireBytes = utf8Length(serialized);
    if (wireBytes > RELAY_MAX_FRAME_BYTES) {
      throw new Error(`Relay envelope size ${wireBytes} exceeds ${RELAY_MAX_FRAME_BYTES} bytes`);
    }
    const queue = envelope.lane === 'primary' ? this.primaryQueue : this.fileQueue;
    const limit = envelope.lane === 'primary' ? this.maxQueuedPrimary : this.maxQueuedFile;
    if (!this.makeRoom(queue, limit)) return false;
    queue.push({ kind: 'envelope', id: envelope.id, lane: envelope.lane, envelope, wireBytes });
    this.scheduleDrain();
    return true;
  }

  /**
   * Queues a plaintext packet to be encrypted with a fresh session `seq` when transmitted.
   * If a fallback or reconnect occurs before the relay accepts the frame, it is automatically
   * re-encrypted with the new session's monotonic `seq` so zero frames are lost.
   */
  enqueuePacket(plaintextPacket: unknown, options: SendPacketOptions): string {
    const id = options.id ?? crypto.randomUUID();
    const queue = options.lane === 'primary' ? this.primaryQueue : this.fileQueue;
    const limit = options.lane === 'primary' ? this.maxQueuedPrimary : this.maxQueuedFile;
    const addressed = (options.wake?.length ?? 0) > 0;
    if (!this.makeRoom(queue, limit)) {
      // Full of frames that each address someone: room chatter is dropped instead, and only a frame that addresses someone is refused.
      if (!addressed) { this.droppedUnaddressed++; return id; }
      throw new Error(`Relay ${options.lane} queue is full`);
    }
    const build = (seq: number) => encryptRelayEnvelope(plaintextPacket, {
      ...options,
      room: this.roomId,
      from: this.deviceId,
      id,
      seq,
      sign: this.signFn,
    });
    queue.push({ kind: 'packet', id, lane: options.lane, addressed, build });
    this.scheduleDrain();
    return id;
  }

  /** Records a delivered inbox cursor for ordered contiguous commit tracking and advances the fetch cursor. */
  private trackDeliveredCursor(cursor: number | undefined) {
    if (cursor === undefined || !Number.isInteger(cursor) || cursor <= 0) return;
    if (cursor > this.cursor) this.cursor = cursor;
    if (cursor <= this.ackedCursor || this.pendingCursorSet.has(cursor) || this.committedCursors.has(cursor)) return;
    this.pendingCursorSet.add(cursor);
    this.pendingSince.set(cursor, this.now());
    if (this.pendingCursors.length === 0 || cursor > this.pendingCursors[this.pendingCursors.length - 1]) {
      this.pendingCursors.push(cursor);
    } else {
      let idx = this.pendingCursors.findIndex(c => c > cursor);
      if (idx < 0) idx = this.pendingCursors.length;
      this.pendingCursors.splice(idx, 0, cursor);
    }
  }

  /** Resets fetch cursor back to the last durably-committed cursor so uncommitted frames are re-fetched on reconnect. */
  private resetUncommittedFetchCursor() {
    this.cursor = this.ackedCursor;
    this.pendingCursors = [];
    this.pendingCursorSet.clear();
    this.pendingSince.clear();
    this.committedCursors.clear();
  }

  /**
   * Marks inbox cursor `cursor` as durably persisted.
   * Advances `committedAckCursor` strictly across the contiguous committed prefix so out-of-order
   * completion never deletes an uncommitted earlier frame from the server inbox.
   */
  ackCursor(cursor: number) {
    if (!Number.isInteger(cursor) || cursor <= this.ackedCursor) return;
    const prevAcked = this.ackedCursor;
    if (this.pendingCursors.length === 0) {
      this.ackedCursor = cursor;
    } else {
      this.committedCursors.add(cursor);
      const advance = () => {
        const next = this.pendingCursors.shift()!;
        this.pendingCursorSet.delete(next);
        this.pendingSince.delete(next);
        this.committedCursors.delete(next);
        if (next > this.ackedCursor) this.ackedCursor = next;
      };
      while (this.pendingCursors.length > 0 && this.committedCursors.has(this.pendingCursors[0])) advance();
      // A frame that never got committed (a handler that failed for good) must not hold every later acknowledgement back
      // and let the relay's inbox fill to its cap: once it is older than the limit and later frames are committed, it is
      // given up on, and the relay may delete it. The sender resends anything it never got a receipt for.
      const limit = this.pendingAckMaxAgeMs, at = this.now();
      while (this.pendingCursors.length > 0 && !this.committedCursors.has(this.pendingCursors[0])
        && at - (this.pendingSince.get(this.pendingCursors[0]) ?? at) > limit
        && this.pendingCursors.some(c => this.committedCursors.has(c))) {
        this.abandonedCursors++;
        advance();
        while (this.pendingCursors.length > 0 && this.committedCursors.has(this.pendingCursors[0])) advance();
      }
    }
    if (this.ackedCursor > prevAcked && this.state === 'wss' && this.ws && this.wsAuthed && this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify({ t: 'ack', cursor: this.ackedCursor }));
      } catch {
        // Will be retried on reconnect / next poll.
      }
    }
  }

  private scheduleDrain() {
    if (this.stopped || this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      if (this.stopped) return;
      if (this.state === 'wss' && this.wsAuthed) {
        void this.drainWss();
      } else if (this.state === 'https') {
        void this.drainHttps();
      }
    });
  }

  private async resolveEnvelope(item: QueuedItem): Promise<{ envelope: RelayEnvelope; wireBytes: number }> {
    if (item.kind === 'envelope') {
      if (item.envelope.seq > this.seq) this.seq = item.envelope.seq;
      return { envelope: item.envelope, wireBytes: item.wireBytes };
    }
    if (item.envelope && item.wireBytes !== undefined) {
      return { envelope: item.envelope, wireBytes: item.wireBytes };
    }
    const envelope = await item.build(this.nextSeq());
    const wireBytes = utf8Length(JSON.stringify(envelope));
    item.envelope = envelope;
    item.wireBytes = wireBytes;
    return { envelope, wireBytes };
  }

  /**
   * Two-lane WSS drain: ALWAYS drains every queued `primary` frame before sending a single `file` frame,
   * enforces the 1 MB `file` in-flight cap, and yields after each file frame so newly enqueued primary
   * messages or receipts preempt bulk file transfers immediately.
   */
  private async drainWss() {
    if (this.wssDrainRunning) return;
    this.wssDrainRunning = true;
    try {
      while (!this.stopped && this.state === 'wss' && this.ws && this.wsAuthed && this.ws.readyState === 1) {
        if ((this.ws.bufferedAmount ?? 0) > WSS_BUFFERED_HIGH_WATER) {
          setTimeout(() => this.scheduleDrain(), 10);
          return;
        }
        let item: QueuedItem | undefined;
        if (this.primaryQueue.length > 0) {
          item = this.primaryQueue.shift();
        } else if (this.fileQueue.length > 0 && this.fileInFlightBytes < this.fileInFlightCapBytes) {
          item = this.fileQueue.shift();
        } else {
          return;
        }
        if (!item) return;

        let resolved: { envelope: RelayEnvelope; wireBytes: number };
        try {
          resolved = await this.resolveEnvelope(item);
        } catch (error) {
          this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
          continue;
        }

        if (this.stopped || this.state !== 'wss' || !this.ws || !this.wsAuthed || this.ws.readyState !== 1) {
          if (item.kind === 'packet') { item.envelope = undefined; item.wireBytes = undefined; }
          if (item.lane === 'primary') this.primaryQueue.unshift(item);
          else this.fileQueue.unshift(item);
          return;
        }

        try {
          this.ws.send(JSON.stringify({ t: 'frame', envelope: resolved.envelope }));
        } catch {
          if (item.kind === 'packet') { item.envelope = undefined; item.wireBytes = undefined; }
          if (item.lane === 'primary') this.primaryQueue.unshift(item);
          else this.fileQueue.unshift(item);
          return;
        }

        this.inFlight.set(resolved.envelope.id, {
          item,
          lane: item.lane,
          wireBytes: resolved.wireBytes,
          sentAt: this.now(),
        });
        if (item.lane === 'file') {
          this.fileInFlightBytes += resolved.wireBytes;
          // Yield after each file frame so any primary frame queued concurrently jumps ahead immediately.
          if (this.fileQueue.length > 0 || this.primaryQueue.length > 0) {
            setTimeout(() => this.scheduleDrain(), 0);
            return;
          }
        }
      }
    } finally {
      this.wssDrainRunning = false;
    }
  }

  private connectWss() {
    if (this.stopped || this.terminalAuthFailed) return;
    if (!this.WebSocketImpl) {
      this.startHttpsFallback();
      return;
    }
    this.clearTimers();
    this.closeSocket();
    if (this.httpsAbort) {
      this.httpsAbort.abort();
      this.httpsAbort = undefined;
      this.httpsLoopRunning = false;
    }
    this.setState('connecting');

    let ws: WebSocket;
    try {
      ws = new this.WebSocketImpl(this.relayUrl);
    } catch {
      this.triggerHttpsFallback();
      return;
    }
    this.ws = ws;
    this.wsAuthed = false;
    let opened = false;
    let fellBack = false;

    const failUpgrade = () => {
      if (fellBack || this.stopped || this.ws !== ws) return;
      fellBack = true;
      this.closeSocket();
      this.triggerHttpsFallback();
    };

    this.wsUpgradeTimer = setTimeout(() => {
      if (!this.wsAuthed) failUpgrade();
    }, this.wssUpgradeTimeoutMs);

    ws.onopen = () => {
      if (this.ws !== ws || this.stopped) return;
      opened = true;
      this.lastPongAt = this.now();
    };

    ws.onmessage = event => {
      if (this.ws !== ws || this.stopped) return;
      void this.handleWssMessage(ws, event.data);
    };

    ws.onerror = () => {
      if (this.ws !== ws || this.stopped) return;
      if (!opened || !this.wsAuthed) {
        failUpgrade();
      }
    };

    ws.onclose = event => {
      if (this.ws !== ws) return;
      this.clearTimers();
      this.ws = undefined;
      const wasAuthed = this.wsAuthed;
      this.wsAuthed = false;
      this.statusLost();
      this.requeueInFlight();
      if (this.stopped || this.terminalAuthFailed) return;
      const terminalClose = mapWssCloseStatus(event?.code);
      if (terminalClose !== undefined) {
        this.handleTerminalAuthError(terminalClose, event?.reason || (terminalClose === 403 ? 'Removed from room.' : 'Room closed.'));
        return;
      }
      if (!wasAuthed) {
        failUpgrade();
        return;
      }
      // Established WSS dropped: reset session seq and uncommitted fetch cursor, then reconnect with backoff.
      this.resetUncommittedFetchCursor();
      this.session = crypto.randomUUID();
      this.seq = 0;
      this.setState('connecting');
      const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * (2 ** Math.min(this.reconnectAttempt, 6)));
      this.reconnectAttempt += 1;
      this.reconnectTimer = setTimeout(() => {
        if (!this.stopped) this.connectWss();
      }, delay);
    };
  }

  private async handleWssMessage(ws: WebSocket, raw: unknown) {
    let text: string;
    if (typeof raw === 'string') text = raw;
    else if (raw instanceof ArrayBuffer) text = new TextDecoder().decode(raw);
    else if (ArrayBuffer.isView(raw)) text = new TextDecoder().decode(raw);
    else return;

    let msg: Record<string, unknown>;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    const t = msg.t;
    if (t === 'challenge' && typeof msg.nonce === 'string') {
      try {
        this.session = crypto.randomUUID();
        this.seq = 0;
        const signed = await this.signCommand('relay-open', {
          nonce: msg.nonce,
          session: this.session,
          rosterVersion: this.rosterVersionFn(),
          ...(this.cursor > 0 ? { after: this.cursor } : {}),
        });
        if (this.ws !== ws || this.stopped) return;
        ws.send(JSON.stringify({ t: 'auth', signed }));
      } catch (error) {
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
        if (this.ws === ws && !this.wsAuthed) {
          this.closeSocket();
          this.triggerHttpsFallback();
        }
      }
      return;
    }

    if (t === 'ready' || t === 'authed' || t === 'open' || t === 'ok') {
      if (this.wsUpgradeTimer) { clearTimeout(this.wsUpgradeTimer); this.wsUpgradeTimer = undefined; }
      this.wsAuthed = true;
      this.reconnectAttempt = 0;
      this.lastPongAt = this.now();
      // Do NOT advance `this.cursor` from `ready.cursor`: it is the server's max unread inbox cursor.
      // Only advance `this.cursor` as `{ t: 'frame', cursor }` entries are actually received.
      this.setState('wss');
      this.startHeartbeat(ws);
      this.scheduleDrain();
      this.pushesStatus = msg.status === true;
      this.lastStatusAt = 0;
      this.sendWatch();
      return;
    }

    if (t === 'status' && msg.status && typeof msg.status === 'object') {
      if (this.ws !== ws || !this.statusWatch) return;
      this.lastStatusAt = this.now();
      try { this.options.onStatus?.(msg.status as RoomStatus); }
      catch (error) { this.options.onError?.(error instanceof Error ? error : new Error(String(error))); }
      return;
    }

    if (t === 'status-error') {
      // The push couldn't read the room this time; the device polls as before until a push arrives again.
      this.statusLost();
      this.options.onError?.(makeStatusError(wssErrorMessage(msg, 'Status unavailable'), typeof msg.status === 'number' ? msg.status : undefined, typeof msg.code === 'string' ? msg.code : undefined));
      return;
    }

    if (t === 'ping') {
      this.lastPongAt = this.now();
      try { ws.send(JSON.stringify({ t: 'pong', at: this.now() })); } catch { /* ignore */ }
      return;
    }

    if (t === 'pong') {
      this.lastPongAt = this.now();
      return;
    }

    if (t === 'accepted' && typeof msg.id === 'string') {
      this.markAccepted(msg.id);
      return;
    }

    if (t === 'rejected' && typeof msg.id === 'string') {
      const reason = typeof msg.reason === 'string' ? msg.reason : 'rejected';
      this.markSettled(msg.id);
      this.options.onRejected?.(msg.id, reason);
      this.scheduleDrain();
      return;
    }

    if (t === 'error') {
      const status = mapWssErrorStatus(msg);
      const reason = wssErrorMessage(msg);
      if (typeof msg.id === 'string') {
        this.markSettled(msg.id);
        this.options.onRejected?.(msg.id, reason, status);
      }
      if (status === 403 || status === 410) {
        this.handleTerminalAuthError(status, reason);
        return;
      }
      if (!this.wsAuthed) {
        this.closeSocket();
        this.triggerHttpsFallback();
      } else {
        this.options.onError?.(makeStatusError(reason, status));
      }
      return;
    }

    if (t === 'frame' && isValidRelayEnvelopeShape(msg.envelope)) {
      const cursor = typeof msg.cursor === 'number' && Number.isInteger(msg.cursor) ? msg.cursor : undefined;
      this.trackDeliveredCursor(cursor);
      try {
        await this.options.onEnvelope?.(msg.envelope, { cursor, carrier: 'wss' });
      } catch (error) {
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private markSettled(id: string) {
    const entry = this.inFlight.get(id);
    if (!entry) return;
    this.inFlight.delete(id);
    if (entry.lane === 'file') {
      this.fileInFlightBytes = Math.max(0, this.fileInFlightBytes - entry.wireBytes);
    }
  }

  private markAccepted(id: string) {
    this.markSettled(id);
    this.options.onAccepted?.(id);
    this.scheduleDrain();
  }

  private startHeartbeat(ws: WebSocket) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.stopped || this.ws !== ws || ws.readyState !== 1) return;
      try {
        ws.send(JSON.stringify({ t: 'ping', at: this.now() }));
      } catch {
        // Close handler will reconnect.
      }
    }, this.heartbeatIntervalMs);
  }

  private triggerHttpsFallback() {
    if (this.stopped || this.terminalAuthFailed) return;
    this.nextWssRetryAt = this.now() + this.wssRetryIntervalMs;
    this.startHttpsFallback();
  }

  private startHttpsFallback() {
    if (this.stopped || this.terminalAuthFailed) return;
    this.clearTimers();
    this.closeSocket();
    this.requeueInFlight();
    this.resetUncommittedFetchCursor();
    this.session = crypto.randomUUID();
    this.seq = 0;

    if (this.WebSocketImpl) {
      const retryDelay = Math.max(100, this.nextWssRetryAt - this.now());
      this.wssRetryTimer = setTimeout(() => {
        if (!this.stopped && this.state === 'https') {
          this.connectWss();
        }
      }, retryDelay);
    }

    const abort = new AbortController();
    this.httpsAbort = abort;
    void this.runHttpsLoop(abort);
  }

  private async runHttpsLoop(abort: AbortController) {
    if (this.httpsLoopRunning) return;
    this.httpsLoopRunning = true;
    try {
      const opened = await this.postRelayJson<{ session?: string; cursor?: number }>(
        '/open',
        'relay-open',
        { session: this.session, rosterVersion: this.rosterVersionFn() },
        abort.signal,
      );
      if (this.stopped || abort.signal.aborted) return;
      if (typeof opened.session === 'string' && opened.session) this.session = opened.session;
      // Do NOT advance `this.cursor` from `opened.cursor`: `/open` returns the server's max unread inbox cursor,
      // so advancing here would cause the first `/poll` (`after: this.cursor`) to skip pre-existing unread frames.
      this.setState('https');
      this.scheduleDrain();

      while (!this.stopped && !abort.signal.aborted && this.state === 'https') {
        try {
          const payload: Record<string, unknown> = {
            session: this.session,
            after: this.cursor,
            waitSeconds: this.pollWaitSeconds,
          };
          if (this.ackedCursor > 0) payload.ackCursor = this.ackedCursor;
          const res = await this.postRelayJson<{
            frames?: { cursor: number; envelope: RelayEnvelope }[];
            cursor?: number;
          }>(
            '/poll',
            'relay-poll',
            payload,
            abort.signal,
            (this.pollWaitSeconds + 10) * 1000,
          );
          if (this.stopped || abort.signal.aborted) return;
          const frames = Array.isArray(res.frames) ? res.frames : [];
          for (const entry of frames) {
            const entryCursor = typeof entry?.cursor === 'number' && Number.isInteger(entry.cursor) ? entry.cursor : undefined;
            if (isValidRelayEnvelopeShape(entry?.envelope)) {
              this.trackDeliveredCursor(entryCursor);
              try {
                await this.options.onEnvelope?.(entry.envelope, { cursor: entryCursor, carrier: 'https' });
              } catch (error) {
                this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
              }
            } else if (entryCursor !== undefined && entryCursor > this.cursor) {
              this.cursor = entryCursor;
            }
          }
          if (this.primaryQueue.length > 0 || this.fileQueue.length > 0) {
            this.scheduleDrain();
          }
        } catch (error) {
          if (this.stopped || abort.signal.aborted || this.terminalAuthFailed) return;
          this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
          await new Promise(resolve => setTimeout(resolve, 1_000));
        }
      }
    } catch (error) {
      if (this.stopped || abort.signal.aborted || this.terminalAuthFailed) return;
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * (2 ** Math.min(this.reconnectAttempt, 6)));
      this.reconnectAttempt += 1;
      this.reconnectTimer = setTimeout(() => {
        if (!this.stopped) this.startHttpsFallback();
      }, delay);
    } finally {
      this.httpsLoopRunning = false;
    }
  }

  /** Drains queued frames over `POST /api/relay/v1/send` with strict `primary`-before-`file` ordering and <= 64 KB batching. */
  private async drainHttps() {
    if (this.httpsSendRunning) return;
    this.httpsSendRunning = true;
    try {
      while (!this.stopped && this.state === 'https' && (this.primaryQueue.length > 0 || this.fileQueue.length > 0)) {
        const batchItems: { item: QueuedItem; envelope: RelayEnvelope; wireBytes: number }[] = [];
        let batchBytes = 0;

        // Always fill from primary queue first.
        while (this.primaryQueue.length > 0) {
          const item = this.primaryQueue[0];
          let resolved: { envelope: RelayEnvelope; wireBytes: number };
          try {
            resolved = await this.resolveEnvelope(item);
          } catch (error) {
            this.primaryQueue.shift();
            this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
            continue;
          }
          if (batchItems.length > 0 && batchBytes + resolved.wireBytes > HTTPS_SEND_BATCH_MAX_BYTES) break;
          this.primaryQueue.shift();
          batchItems.push({ item, ...resolved });
          batchBytes += resolved.wireBytes;
        }

        // Only pull from file queue when primary queue is completely drained.
        while (this.primaryQueue.length === 0 && this.fileQueue.length > 0 && this.fileInFlightBytes < this.fileInFlightCapBytes) {
          const item = this.fileQueue[0];
          let resolved: { envelope: RelayEnvelope; wireBytes: number };
          try {
            resolved = await this.resolveEnvelope(item);
          } catch (error) {
            this.fileQueue.shift();
            this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
            continue;
          }
          if (batchItems.length > 0 && batchBytes + resolved.wireBytes > HTTPS_SEND_BATCH_MAX_BYTES) break;
          this.fileQueue.shift();
          batchItems.push({ item, ...resolved });
          batchBytes += resolved.wireBytes;
          this.fileInFlightBytes += resolved.wireBytes;
          // Send one file batch step so newly arriving primary messages jump ahead immediately.
          break;
        }

        if (!batchItems.length) return;

        try {
          const res = await this.postRelayJson<{
            accepted?: string[];
            rejected?: { id: string; reason: string }[];
          }>(
            '/send',
            'relay-send',
            { session: this.session, envelopes: batchItems.map(b => b.envelope) },
            this.httpsAbort?.signal,
          );
          for (const b of batchItems) {
            if (b.item.lane === 'file') {
              this.fileInFlightBytes = Math.max(0, this.fileInFlightBytes - b.wireBytes);
            }
          }
          for (const id of res.accepted || []) this.options.onAccepted?.(id);
          for (const r of res.rejected || []) this.options.onRejected?.(r.id, r.reason);
        } catch (error) {
          // Put unsent batch back at the front of their lanes so zero frames are lost.
          for (let i = batchItems.length - 1; i >= 0; i--) {
            const b = batchItems[i];
            if (b.item.lane === 'file') {
              this.fileInFlightBytes = Math.max(0, this.fileInFlightBytes - b.wireBytes);
              this.fileQueue.unshift(b.item);
            } else {
              this.primaryQueue.unshift(b.item);
            }
          }
          if (this.terminalAuthFailed || this.stopped) return;
          this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
          await new Promise(resolve => setTimeout(resolve, 1_000));
          return;
        }
      }
    } finally {
      this.httpsSendRunning = false;
    }
  }

  /**
   * One-shot inbox drain for ephemeral cloud agents (`listen --relay-once`).
   * Tries WSS first (with automatic fallback to HTTPS `/open` + `/poll` if upgrade fails or times out),
   * drains all queued inbox frames without keeping a persistent connection open, and returns them with the final cursor.
   * Throws with `.status = 403 | 410` if the device was removed or the room closed.
   */
  async drainOnce(options: { waitSeconds?: number; maxPolls?: number; ack?: boolean; preferHttps?: boolean } = {}): Promise<{
    frames: { cursor: number; envelope: RelayEnvelope }[];
    cursor: number;
    carrier: 'wss' | 'https';
  }> {
    const waitSeconds = options.waitSeconds ?? 0;
    if (!options.preferHttps && this.WebSocketImpl) {
      const wssResult = await this.tryDrainOnceWss(waitSeconds, options.ack === true);
      if (wssResult) return wssResult;
    }
    return this.drainOnceHttps(options);
  }

  private tryDrainOnceWss(waitSeconds: number, ack: boolean): Promise<{
    frames: { cursor: number; envelope: RelayEnvelope }[];
    cursor: number;
    carrier: 'wss';
  } | null> {
    const WsCtor = this.WebSocketImpl;
    if (!WsCtor) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WsCtor(this.relayUrl);
      } catch {
        resolve(null);
        return;
      }
      let settled = false;
      let authed = false;
      let targetCursor = 0;
      let maxCursor = this.cursor;
      const frames: { cursor: number; envelope: RelayEnvelope }[] = [];
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let upgradeTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
        if (upgradeTimer) { clearTimeout(upgradeTimer); upgradeTimer = undefined; }
        try {
          ws.onopen = null;
          ws.onmessage = null;
          ws.onerror = null;
          ws.onclose = null;
          ws.close();
        } catch { /* ignore */ }
      };

      const finishSuccess = () => {
        if (settled) return;
        settled = true;
        if (ack && maxCursor > 0 && ws.readyState === 1) {
          try { ws.send(JSON.stringify({ t: 'ack', cursor: maxCursor })); } catch { /* ignore */ }
          this.ackedCursor = Math.max(this.ackedCursor, maxCursor);
        }
        this.cursor = Math.max(this.cursor, maxCursor);
        cleanup();
        resolve({ frames, cursor: maxCursor, carrier: 'wss' });
      };

      const fallbackToHttps = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(null);
      };

      const failTerminal = (status: number, message: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(makeStatusError(message, status));
      };

      const armIdle = (ms: number) => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(finishSuccess, ms);
      };

      upgradeTimer = setTimeout(() => {
        if (!authed) fallbackToHttps();
      }, this.wssUpgradeTimeoutMs);

      ws.onerror = () => {
        if (!authed) fallbackToHttps();
      };

      ws.onclose = event => {
        if (settled) return;
        const terminalClose = mapWssCloseStatus(event?.code);
        if (terminalClose !== undefined) {
          failTerminal(terminalClose, event?.reason || (terminalClose === 403 ? 'Removed from room.' : 'Room closed.'));
          return;
        }
        if (!authed) fallbackToHttps();
        else finishSuccess();
      };

      ws.onmessage = async event => {
        if (settled) return;
        const raw = typeof event.data === 'string'
          ? event.data
          : event.data instanceof ArrayBuffer
            ? new TextDecoder().decode(event.data)
            : ArrayBuffer.isView(event.data)
              ? new TextDecoder().decode(event.data)
              : '';
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.t === 'challenge' && typeof msg.nonce === 'string') {
          try {
            this.session = crypto.randomUUID();
            this.seq = 0;
            const signed = await this.signCommand('relay-open', {
              nonce: msg.nonce,
              session: this.session,
              rosterVersion: this.rosterVersionFn(),
              ...(this.cursor > 0 ? { after: this.cursor } : {}),
            });
            if (!settled && ws.readyState === 1) ws.send(JSON.stringify({ t: 'auth', signed }));
          } catch {
            fallbackToHttps();
          }
          return;
        }
        if (msg.t === 'error') {
          const status = mapWssErrorStatus(msg);
          const reason = wssErrorMessage(msg);
          if (status === 403 || status === 410) { failTerminal(status, reason); return; }
          if (!authed) fallbackToHttps();
          return;
        }
        if (msg.t === 'ready' || msg.t === 'authed' || msg.t === 'open' || msg.t === 'ok') {
          if (upgradeTimer) { clearTimeout(upgradeTimer); upgradeTimer = undefined; }
          authed = true;
          if (typeof msg.cursor === 'number' && Number.isInteger(msg.cursor)) {
            targetCursor = Math.max(targetCursor, msg.cursor);
          }
          armIdle(waitSeconds > 0 ? waitSeconds * 1000 : 120);
          return;
        }
        if (msg.t === 'frame' && isValidRelayEnvelopeShape(msg.envelope)) {
          const c = typeof msg.cursor === 'number' && Number.isInteger(msg.cursor) ? msg.cursor : maxCursor;
          if (c > maxCursor) maxCursor = c;
          frames.push({ cursor: c, envelope: msg.envelope });
          if (authed) {
            armIdle(waitSeconds > 0 ? Math.min(waitSeconds * 1000, 150) : 80);
          }
        }
      };
    });
  }

  private async drainOnceHttps(options: { waitSeconds?: number; maxPolls?: number; ack?: boolean } = {}): Promise<{
    frames: { cursor: number; envelope: RelayEnvelope }[];
    cursor: number;
    carrier: 'https';
  }> {
    const maxPolls = options.maxPolls ?? 10;
    const waitSeconds = options.waitSeconds ?? 0;
    this.session = crypto.randomUUID();
    this.seq = 0;

    const opened = await this.postRelayJson<{ session?: string; cursor?: number }>(
      '/open',
      'relay-open',
      { session: this.session, rosterVersion: this.rosterVersionFn() },
    );
    if (typeof opened.session === 'string' && opened.session) this.session = opened.session;

    let cursor = this.cursor;
    const frames: { cursor: number; envelope: RelayEnvelope }[] = [];
    for (let i = 0; i < maxPolls; i++) {
      const res = await this.postRelayJson<{
        frames?: { cursor: number; envelope: RelayEnvelope }[];
        cursor?: number;
      }>('/poll', 'relay-poll', {
        session: this.session,
        after: cursor,
        waitSeconds: i === 0 ? waitSeconds : 0,
        ...(options.ack && cursor > 0 ? { ackCursor: cursor } : {}),
      });
      const batch = Array.isArray(res.frames) ? res.frames : [];
      if (!batch.length) {
        if (typeof res.cursor === 'number' && res.cursor > cursor) cursor = res.cursor;
        break;
      }
      for (const item of batch) {
        if (typeof item?.cursor === 'number' && item.cursor > cursor) cursor = item.cursor;
        if (isValidRelayEnvelopeShape(item?.envelope)) {
          frames.push({ cursor: item.cursor, envelope: item.envelope });
        }
      }
      if (typeof res.cursor === 'number' && res.cursor > cursor) cursor = res.cursor;
      // If fewer than a full page arrived and we aren't waiting, we drained the inbox.
      if (batch.length < 50) break;
    }
    if (options.ack && cursor > 0) {
      await this.ackInboxCursor(cursor);
    }
    this.cursor = Math.max(this.cursor, cursor);
    return { frames, cursor, carrier: 'https' };
  }

  /** Explicitly acknowledges and deletes inbox frames up to `cursor` via `POST /api/relay/v1/poll`. */
  async ackInboxCursor(cursor: number): Promise<void> {
    if (!Number.isInteger(cursor) || cursor <= 0) return;
    await this.postRelayJson('/poll', 'relay-poll', {
      session: this.session,
      after: cursor,
      waitSeconds: 0,
      ackCursor: cursor,
    });
    this.ackedCursor = Math.max(this.ackedCursor, cursor);
  }

  /** Sends a batch of envelopes over HTTPS `POST /api/relay/v1/send` in a one-shot session. */
  async sendOnce(envelopes: RelayEnvelope[]): Promise<{
    accepted: string[];
    rejected: { id: string; reason: string }[];
  }> {
    if (!envelopes.length) return { accepted: [], rejected: [] };
    if (!this.isConnected()) {
      const opened = await this.postRelayJson<{ session?: string }>(
        '/open',
        'relay-open',
        { session: this.session, rosterVersion: this.rosterVersionFn() },
      );
      if (typeof opened.session === 'string' && opened.session) this.session = opened.session;
    }
    const accepted: string[] = [];
    const rejected: { id: string; reason: string }[] = [];
    let batch: RelayEnvelope[] = [];
    let batchBytes = 0;

    const flushBatch = async () => {
      if (!batch.length) return;
      const res = await this.postRelayJson<{
        accepted?: string[];
        rejected?: { id: string; reason: string }[];
      }>('/send', 'relay-send', { session: this.session, envelopes: batch });
      if (Array.isArray(res.accepted)) accepted.push(...res.accepted);
      if (Array.isArray(res.rejected)) rejected.push(...res.rejected);
      batch = [];
      batchBytes = 0;
    };

    for (const env of envelopes) {
      const bytes = utf8Length(JSON.stringify(env));
      if (bytes > RELAY_MAX_FRAME_BYTES) {
        rejected.push({ id: env.id, reason: 'oversized' });
        continue;
      }
      if (batch.length > 0 && batchBytes + bytes > HTTPS_SEND_BATCH_MAX_BYTES) {
        await flushBatch();
      }
      batch.push(env);
      batchBytes += bytes;
    }
    await flushBatch();
    return { accepted, rejected };
  }

  /** Reads this device's opaque sealed state blob from the relay (`POST /api/relay/v1/state`). */
  async getSealedState(): Promise<{ state: string | null; updatedAt: number | null }> {
    const res = await this.postRelayJson<{ state?: unknown; updatedAt?: unknown }>(
      '/state',
      'relay-state-get',
      {},
    );
    return {
      state: typeof res.state === 'string' ? res.state : null,
      updatedAt: typeof res.updatedAt === 'number' ? res.updatedAt : null,
    };
  }

  /** Stores an opaque sealed state blob (<= 256 KB) on the relay (`POST /api/relay/v1/state`). */
  async putSealedState(state: string): Promise<{ state: string | null; updatedAt: number | null }> {
    if (utf8Length(state) > SEALED_STATE_MAX_BYTES) {
      throw new Error(`Sealed state exceeds ${SEALED_STATE_MAX_BYTES} bytes`);
    }
    const res = await this.postRelayJson<{ state?: unknown; updatedAt?: unknown }>(
      '/state',
      'relay-state-put',
      { state },
    );
    return {
      state: typeof res.state === 'string' ? res.state : null,
      updatedAt: typeof res.updatedAt === 'number' ? res.updatedAt : null,
    };
  }

  /** Registers (or clears when `url === null`) this device's wake webhook endpoint, signed by its room device key. */
  async registerWake(url: string | null, key?: string): Promise<{ inboxId: string; wakeable: boolean }> {
    const res = await this.postRelayJson<{ inboxId?: unknown; wakeable?: unknown }>(
      '/wake-register',
      'relay-wake-register',
      { url, ...(key !== undefined ? { key } : {}) },
    );
    return {
      inboxId: typeof res.inboxId === 'string' ? res.inboxId : '',
      wakeable: res.wakeable === true,
    };
  }
}
