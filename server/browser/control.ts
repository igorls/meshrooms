/**
 * Remote control, the service's side (docs/flows/remote-control.md, build step 2): `/api/control/v1`, a WebSocket that
 * carries end-to-end encrypted frames between a person's machines (their desktop apps) and the browsers and phones they
 * enrolled there as controllers. It isn't a room: a socket authenticates with its device key alone, and nothing here
 * decides who may control what. Each machine does that with its own controller list.
 *
 * - **Auth:** a single-use challenge signed with the device key (`control-open`, roomId CONTROL_ROOM_ID). The device id
 *   is the key's hash, and it must take part in Meshrooms here (admitted in a room, or to the beta: participantDevice,
 *   asked again at every heartbeat),
 *   so a key made a moment ago gets nothing. One socket per device: a newer one replaces it. At most
 *   CONTROL_MAX_SOCKETS_PER_ADDRESS sockets from one address, and CONTROL_MAX_SOCKETS in all.
 * - **Links:** each device says which devices it talks to (at most CONTROL_MAX_LINKS). Only two devices that link each
 *   other can exchange frames or see each other's presence. A machine links its controllers, a browser its machines.
 *   Both send their links again on every connect, so the service keeps nothing on disk. A device that went away while
 *   it had a peer is remembered a while (CONTROL_DEPARTED_TTL_MS), so its peers see when it was last seen.
 * - **Presence:** `peers` lists the devices this one links that link it back, online or when last seen, and is pushed
 *   again when it changes (never the same list twice in a row). Devices online that link this one without being linked
 *   back are listed as `offers`, ids only and newest first. An offer is a hint, never proof: enrolment trusts a machine
 *   only once its words check matches.
 * - **Frames:** the relay's envelope (encryptRelayEnvelope) with room `control:<machine device id>` and one recipient,
 *   delivered live or refused (`offline`): there is no inbox. The service sees sizes and timing, never content. Every
 *   message counts against its device's rate limit, and a socket that keeps going past it is closed.
 *
 * Logs are operational only: never a device id, a link or an envelope.
 */
import type { ServerWebSocket, WebSocketHandler } from 'bun';
import { timingSafeEqual } from 'node:crypto';
import type { BrowserLobby } from './lobby';
import { LobbyError } from './lobby';
import { CONTROL_ROOM_ID, controlRoom, type SignedCommand } from '../../src/browser/protocol';
import { RELAY_MAX_FRAME_BYTES, isValidRelayEnvelopeShape } from '../../src/browser/relay-crypto';

export const CONTROL_AUTH_TIMEOUT_MS = 15_000;
export const CONTROL_HEARTBEAT_MS = 25_000;
/** How many devices one device may link: a machine's controllers (32 at most there) or a person's machines. */
export const CONTROL_MAX_LINKS = 64;
/** At most this many devices listed as offers, and remembered as linking any one device. */
export const CONTROL_MAX_OFFERS = 16;
export const CONTROL_MAX_LINKED_BY = 256;
export const CONTROL_RATE_MESSAGES_PER_MIN = 240;
export const CONTROL_RATE_BYTES_PER_MIN = 4 * 1024 * 1024;
/** Refusals for the rate in a row before the socket is closed. */
export const CONTROL_MAX_REFUSALS = 20;
export const CONTROL_MAX_SOCKETS_PER_ADDRESS = 32;
export const CONTROL_MAX_SOCKETS = 20_000;
/** How long a device that went away is still shown, by when it was last seen. */
export const CONTROL_DEPARTED_TTL_MS = 7 * 24 * 3_600_000;
export const CONTROL_MAX_DEPARTED = 10_000;
/** A recipient further behind than this is sent nothing more until it catches up: a sender hears `recipient-busy`. */
export const CONTROL_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** Envelope ids remembered for CONTROL_DEDUP_WINDOW_MS, at most this many. */
export const CONTROL_MAX_SEEN = 200_000;
const CONTROL_DEDUP_WINDOW_MS = 10 * 60_000;
const DEVICE_ID = /^[a-f0-9]{64}$/;

export type ControlSocketData = {
  kind: 'control';
  /** The rate-limit key of the address the socket came from (as the relay keys it). */
  remoteKey: string;
  /** The service address the socket came through: the signed challenge must name it. */
  origin: string;
  nonce: string;
  nonceUsed: boolean;
  authenticated: boolean;
  deviceId?: string;
  /** Rate refusals in a row. */
  refusals: number;
  /** The last `peers` pushed, so the same list isn't pushed again. */
  lastPeers?: string;
  authTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
};
type ControlSocket = ServerWebSocket<ControlSocketData>;
export type ControlPeer = { device: string; online: boolean; lastSeen?: number };
export type ControlServiceOptions = {
  /** Verifies the signed challenge (its origins, clock window and signature), as for every room command, and who takes part. */
  lobby: Pick<BrowserLobby, 'verifySignedCommand' | 'participantDevice'>;
  now?: () => number;
  authTimeoutMs?: number;
  heartbeatMs?: number;
  rateMessagesPerMin?: number;
  rateBytesPerMin?: number;
  maxSocketsPerAddress?: number;
  departedTtlMs?: number;
  maxDeparted?: number;
  log?: (line: string) => void;
};

const utf8Bytes = (text: string) => Buffer.byteLength(text, 'utf8');
function sameString(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
/** A link list as sent: device ids, at most CONTROL_MAX_LINKS, never the sender itself. Undefined when malformed. */
function cleanLinks(value: unknown, self: string): Set<string> | undefined {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || value.length > CONTROL_MAX_LINKS || !value.every(id => typeof id === 'string' && DEVICE_ID.test(id) && id !== self)) return undefined;
  return new Set(value as string[]);
}
const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(id => b.has(id));

export class ControlService {
  private readonly lobby: ControlServiceOptions['lobby'];
  private readonly now: () => number;
  private readonly authTimeoutMs: number;
  private readonly heartbeatMs: number;
  private readonly rateMessages: number;
  private readonly rateBytes: number;
  private readonly maxPerAddress: number;
  private readonly departedTtlMs: number;
  private readonly maxDeparted: number;
  private readonly writeLog: (line: string) => void;
  private readonly open = new Set<ControlSocket>();
  /** Open sockets, authenticated or not, by the address they came from. */
  private readonly perAddress = new Map<string, number>();
  /** The authenticated socket of each device. */
  private readonly sockets = new Map<string, ControlSocket>();
  /** What each online device links. */
  private readonly links = new Map<string, Set<string>>();
  /** Who links each device, among online devices, newest last (at most CONTROL_MAX_LINKED_BY): for offers. */
  private readonly linkedBy = new Map<string, Set<string>>();
  /** Devices that went away: their last links and when (insertion order is age order). */
  private readonly departed = new Map<string, { links: Set<string>; at: number }>();
  private readonly seen = new Map<string, number>();
  private readonly rates = new Map<string, { at: number; count: number; bytes: number }>();
  private charges = 0;

  constructor(options: ControlServiceOptions) {
    this.lobby = options.lobby;
    this.now = options.now ?? Date.now;
    this.authTimeoutMs = options.authTimeoutMs ?? CONTROL_AUTH_TIMEOUT_MS;
    this.heartbeatMs = options.heartbeatMs ?? CONTROL_HEARTBEAT_MS;
    this.rateMessages = options.rateMessagesPerMin ?? CONTROL_RATE_MESSAGES_PER_MIN;
    this.rateBytes = options.rateBytesPerMin ?? CONTROL_RATE_BYTES_PER_MIN;
    this.maxPerAddress = options.maxSocketsPerAddress ?? CONTROL_MAX_SOCKETS_PER_ADDRESS;
    this.departedTtlMs = options.departedTtlMs ?? CONTROL_DEPARTED_TTL_MS;
    this.maxDeparted = options.maxDeparted ?? CONTROL_MAX_DEPARTED;
    this.writeLog = options.log ?? (() => {});
  }

  /** The upgrade's initial state: which address and which service origin it came through. */
  createSocketData(remoteKey: string, origin: string): ControlSocketData {
    return { kind: 'control', remoteKey, origin, nonce: crypto.randomUUID(), nonceUsed: false, authenticated: false, refusals: 0 };
  }

  get websocket(): WebSocketHandler<ControlSocketData> {
    return {
      maxPayloadLength: RELAY_MAX_FRAME_BYTES + 4096,
      idleTimeout: 75,
      open: ws => this.onOpen(ws),
      message: (ws, message) => { void this.onMessage(ws, message); },
      close: ws => this.onClose(ws),
    };
  }

  /** How many devices are connected, and how many that went away are remembered (for health and tests). */
  get online() { return this.sockets.size; }
  get remembered() { return this.departed.size; }

  close() {
    for (const ws of [...this.open]) { try { ws.close(1001, 'Service stopping'); } catch { /* Closed. */ } }
  }

  private log(op: string, status: number | string) {
    this.writeLog(JSON.stringify({ time: new Date(this.now()).toISOString(), event: 'control', op, status }));
  }
  private send(ws: ControlSocket, value: unknown) { try { ws.send(typeof value === 'string' ? value : JSON.stringify(value)); } catch { /* Closed. */ } }
  private fail(ws: ControlSocket, code: string, message: string, close?: number) {
    this.send(ws, { t: 'error', code, message });
    if (close) { try { ws.close(close, code); } catch { /* Closed. */ } }
  }

  private onOpen(ws: ControlSocket) {
    this.open.add(ws);
    const count = (this.perAddress.get(ws.data.remoteKey) ?? 0) + 1;
    this.perAddress.set(ws.data.remoteKey, count);
    if (count > this.maxPerAddress || this.open.size > CONTROL_MAX_SOCKETS) return this.fail(ws, 'too-many-sockets', 'Too many control sockets from here. Close some first.', 4029);
    ws.data.authTimer = setTimeout(() => { if (!ws.data.authenticated) this.fail(ws, 'auth-timeout', 'Authentication timed out.', 4001); }, this.authTimeoutMs);
    this.send(ws, { t: 'challenge', nonce: ws.data.nonce });
  }

  private onClose(ws: ControlSocket) {
    if (!this.open.delete(ws)) return;
    const left = (this.perAddress.get(ws.data.remoteKey) ?? 1) - 1;
    if (left > 0) this.perAddress.set(ws.data.remoteKey, left); else this.perAddress.delete(ws.data.remoteKey);
    clearTimeout(ws.data.authTimer); clearInterval(ws.data.heartbeatTimer);
    const id = ws.data.deviceId;
    if (!id || this.sockets.get(id) !== ws) return;
    const links = this.links.get(id) ?? new Set<string>();
    // Remembered only with a peer to show it to: keys that link no one back can't push out the devices people look for.
    const hadPeer = [...links].some(peer => this.linksOf(peer)?.has(id));
    this.sockets.delete(id);
    this.setLinks(id, undefined);
    if (hadPeer) {
      this.departed.delete(id);
      this.departed.set(id, { links, at: this.now() });
      this.pruneDeparted();
    }
    this.tell(links);
  }

  private async onMessage(ws: ControlSocket, raw: string | Buffer) {
    if (!this.open.has(ws)) return;
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      msg = parsed;
    } catch { return this.fail(ws, 'invalid-json', 'Invalid JSON frame.'); }
    if (!ws.data.authenticated) {
      if (msg.t === 'auth') return this.auth(ws, msg.signed as SignedCommand, msg.links);
      // Sent while the answer is being checked: told to wait for `ready`, not closed.
      if (ws.data.nonceUsed) return this.fail(ws, 'not-ready', 'Wait for ready before sending anything else.');
      return this.fail(ws, 'unauthenticated', 'Authenticate with the challenge first.', 4001);
    }
    const me = ws.data.deviceId!;
    // A socket a newer one replaced acts for nobody, whatever reaches it before it closes.
    if (this.sockets.get(me) !== ws) return;
    if (!this.charge(me, utf8Bytes(text))) {
      if (++ws.data.refusals > CONTROL_MAX_REFUSALS) return this.fail(ws, 'rate-limit', 'Too many messages. Reconnect later.', 4008);
      if (msg.t === 'frame') return this.send(ws, { t: 'rejected', id: typeof (msg.envelope as { id?: unknown })?.id === 'string' ? (msg.envelope as { id: string }).id : '', reason: 'rate-limit' });
      return this.fail(ws, 'rate-limit', 'Too many messages. Slow down.');
    }
    ws.data.refusals = 0;
    switch (msg.t) {
      case 'ping': return this.send(ws, { t: 'pong', at: this.now() });
      case 'pong': return;
      case 'peers': return this.pushPeers(ws, me, true);
      case 'links': {
        const links = cleanLinks(msg.links, me);
        if (!links) return this.fail(ws, 'invalid-links', `Send links as at most ${CONTROL_MAX_LINKS} device ids, not your own.`);
        const before = this.links.get(me) ?? new Set<string>();
        if (sameSet(before, links)) return this.pushPeers(ws, me, true);
        this.setLinks(me, links);
        this.pushPeers(ws, me, true);
        return this.tell(new Set([...before, ...links]));
      }
      case 'frame': {
        const result = this.frame(me, msg.envelope);
        return this.send(ws, result.ok ? { t: 'accepted', id: result.id } : { t: 'rejected', id: result.id, reason: result.reason });
      }
      default: return this.fail(ws, 'unknown-type', 'Unsupported message type.');
    }
  }

  private async auth(ws: ControlSocket, signed: SignedCommand, rawLinks: unknown) {
    if (ws.data.nonceUsed) return this.fail(ws, 'nonce-reused', 'Challenge nonce already used.', 4001);
    // Single use, marked before any await so two auth frames can't race it.
    ws.data.nonceUsed = true;
    clearTimeout(ws.data.authTimer);
    try {
      const { command, deviceId } = await this.lobby.verifySignedCommand(signed, 'control-open');
      if (command.roomId !== CONTROL_ROOM_ID) throw new LobbyError(400, 'A control socket opens without a room.');
      // Signed for this service, by the address the socket came through: a challenge answered for another can't be used here.
      if (command.origin !== ws.data.origin) throw new LobbyError(400, 'This request has expired or is invalid. Try again.');
      if (typeof command.payload.nonce !== 'string' || !sameString(command.payload.nonce, ws.data.nonce)) throw new LobbyError(401, 'Challenge nonce mismatch.');
      const links = cleanLinks(rawLinks, deviceId);
      if (!links) throw new LobbyError(400, `Send links as at most ${CONTROL_MAX_LINKS} device ids, not your own.`);
      if (!this.lobby.participantDevice(deviceId)) throw new LobbyError(403, 'Remote control is for devices that take part in Meshrooms here: join or create a room first.');
      if (!this.open.has(ws)) return;
      const earlier = this.sockets.get(deviceId);
      ws.data.authenticated = true;
      ws.data.deviceId = deviceId;
      // Set before the older socket closes, so its close leaves this device's state alone.
      this.sockets.set(deviceId, ws);
      if (earlier && earlier !== ws) {
        earlier.data.authenticated = false;
        this.fail(earlier, 'session-replaced', 'Replaced by a newer connection of this device.', 4009);
      }
      const before = this.links.get(deviceId) ?? this.departed.get(deviceId)?.links ?? new Set<string>();
      this.departed.delete(deviceId);
      this.setLinks(deviceId, links);
      ws.data.heartbeatTimer = setInterval(() => {
        if (!this.open.has(ws)) return;
        // Asked again at every heartbeat: a device retired from its rooms, or from the beta, keeps no socket open.
        let still = false;
        try { still = this.lobby.participantDevice(deviceId); } catch { /* Can't tell now: the next heartbeat asks again. */ still = true; }
        if (!still) { this.log('participant', 403); return this.fail(ws, 'not-a-participant', 'This device no longer takes part in Meshrooms here.', 4003); }
        this.send(ws, { t: 'ping', at: this.now() });
        try { ws.ping(); } catch { /* Closed. */ }
      }, this.heartbeatMs);
      const ready = this.peersOf(deviceId);
      ws.data.lastPeers = JSON.stringify({ t: 'peers', ...ready });
      this.send(ws, { t: 'ready', deviceId, ...ready });
      this.tell(new Set([...before, ...links]));
      this.log('auth', 200);
    } catch (error) {
      const status = error instanceof LobbyError ? error.status : 401;
      this.log('auth', status);
      this.fail(ws, status === 400 ? 'invalid' : status === 403 ? 'not-a-participant' : 'auth-failed', error instanceof Error ? error.message : 'Authentication failed.', status === 403 ? 4003 : 4001);
    }
  }

  /** Replaces what `id` links (undefined: it went away), keeping the reverse index in step. */
  private setLinks(id: string, links: Set<string> | undefined) {
    for (const peer of this.links.get(id) ?? []) {
      const by = this.linkedBy.get(peer);
      by?.delete(id);
      if (by && !by.size) this.linkedBy.delete(peer);
    }
    if (!links) { this.links.delete(id); return; }
    this.links.set(id, links);
    for (const peer of links) {
      let by = this.linkedBy.get(peer);
      if (!by) this.linkedBy.set(peer, by = new Set());
      by.add(id);
      // Only the newest are kept: they are the ones an enrolment in progress looks for.
      if (by.size > CONTROL_MAX_LINKED_BY) by.delete(by.values().next().value!);
    }
  }

  private linksOf(id: string): Set<string> | undefined {
    if (this.sockets.has(id)) return this.links.get(id);
    const gone = this.departed.get(id);
    if (gone && this.now() - gone.at > this.departedTtlMs) { this.departed.delete(id); return undefined; }
    return gone?.links;
  }
  private mutual(a: string, b: string) { return !!this.linksOf(a)?.has(b) && !!this.linksOf(b)?.has(a); }

  /** What `me` may know: the peers it links that link it back, and the online devices that offer to, newest first. */
  private peersOf(me: string): { peers: ControlPeer[]; offers: string[] } {
    const mine = this.links.get(me) ?? new Set<string>();
    const peers: ControlPeer[] = [];
    for (const device of mine) {
      if (!this.linksOf(device)?.has(me)) continue;
      if (this.sockets.has(device)) peers.push({ device, online: true });
      else peers.push({ device, online: false, lastSeen: this.departed.get(device)!.at });
    }
    const offers: string[] = [];
    for (const device of [...this.linkedBy.get(me) ?? []].reverse()) {
      if (offers.length >= CONTROL_MAX_OFFERS) break;
      if (!mine.has(device) && this.sockets.has(device)) offers.push(device);
    }
    return { peers, offers };
  }

  /** Sends `device` its peers: always when it asked, else only when they changed and it isn't behind. */
  private pushPeers(ws: ControlSocket, device: string, asked = false) {
    const text = JSON.stringify({ t: 'peers', ...this.peersOf(device) });
    if (!asked && (text === ws.data.lastPeers || ws.getBufferedAmount() > CONTROL_MAX_BUFFERED_BYTES)) return;
    ws.data.lastPeers = text;
    this.send(ws, text);
  }
  /** Sends each online device among `devices` its peers again: one of them came, went or changed its links. */
  private tell(devices: Iterable<string>) {
    for (const device of devices) {
      const ws = this.sockets.get(device);
      if (ws) this.pushPeers(ws, device);
    }
  }

  private pruneDeparted() {
    const now = this.now();
    for (const [id, gone] of this.departed) {
      if (this.departed.size <= this.maxDeparted && now - gone.at <= this.departedTtlMs) break;
      this.departed.delete(id);
    }
  }

  private charge(device: string, bytes: number) {
    const now = this.now();
    if (++this.charges % 1024 === 0) for (const [key, entry] of this.rates) if (now - entry.at >= 60_000) this.rates.delete(key);
    let rate = this.rates.get(device);
    if (!rate || now - rate.at >= 60_000) this.rates.set(device, rate = { at: now, count: 0, bytes: 0 });
    if (rate.count + 1 > this.rateMessages || rate.bytes + bytes > this.rateBytes) return false;
    rate.count++; rate.bytes += bytes;
    return true;
  }

  /** One envelope from `me`: to one device that links it back and is online now, in a control domain one of them names. */
  private frame(me: string, raw: unknown): { ok: true; id: string } | { ok: false; id: string; reason: string } {
    const id = raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string' ? (raw as { id: string }).id : '';
    if (!isValidRelayEnvelopeShape(raw)) return { ok: false, id, reason: 'invalid-envelope' };
    const envelope = raw;
    if (envelope.from !== me) return { ok: false, id, reason: 'sender-mismatch' };
    // Nothing waits here for a device that isn't online: no wake, no hold.
    if (envelope.wake !== undefined || envelope.hold !== undefined) return { ok: false, id, reason: 'no-inbox' };
    const recipients = Object.keys(envelope.to);
    if (recipients.length !== 1) return { ok: false, id, reason: 'one-recipient' };
    const to = recipients[0];
    if (to === me) return { ok: false, id, reason: 'reflected' };
    if (envelope.room !== controlRoom(me) && envelope.room !== controlRoom(to)) return { ok: false, id, reason: 'wrong-room' };
    const json = JSON.stringify(envelope);
    if (utf8Bytes(json) > RELAY_MAX_FRAME_BYTES) return { ok: false, id, reason: 'frame-too-large' };
    // Everything after this tells the sender something about the recipient, so it comes after the link check.
    if (!this.mutual(me, to)) return { ok: false, id, reason: 'not-linked' };
    const target = this.sockets.get(to);
    if (!target) return { ok: false, id, reason: 'offline' };
    const now = this.now(), key = `${me}:${envelope.id}`;
    for (const [seenKey, at] of this.seen) { if (now - at < CONTROL_DEDUP_WINDOW_MS && this.seen.size < CONTROL_MAX_SEEN) break; this.seen.delete(seenKey); }
    if (this.seen.has(key)) return { ok: false, id, reason: 'duplicate' };
    if (target.getBufferedAmount() > CONTROL_MAX_BUFFERED_BYTES) return { ok: false, id, reason: 'recipient-busy' };
    this.seen.set(key, now);
    this.send(target, `{"t":"frame","envelope":${json}}`);
    return { ok: true, id };
  }
}
