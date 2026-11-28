/**
 * Remote control's client (docs/flows/remote-control.md): one device's socket to the service's `/api/control/v1`, as the
 * desktop app's daemon holds it for its machine (server/control-socket.ts) and the web app will for its browser. Only
 * WebSocket and WebCrypto: it runs in Bun and in browsers alike.
 *
 * - **Connecting:** answers the service's challenge with a `control-open` command signed by the device key, with the
 *   device's links, and tries again after a while when the socket closes (longer when the service refuses the device).
 * - **Sending:** a packet is sealed to one device (encryptRelayEnvelope, in that device's control domain) and waits for
 *   the service's `accepted`. One larger than CONTROL_SINGLE_BYTES goes as base64 parts of CONTROL_CHUNK_BYTES, at most
 *   CONTROL_MAX_PARTS, and the other side puts them back together.
 * - **Receiving:** only from a device whose keys `keysOf` gives: its envelope's signature is checked under that key
 *   before anything is decrypted. A frame from a device it doesn't know goes to `onUnknown`, which enrolment uses
 *   (openEnrolled). Nothing a frame says is trusted beyond who sent it: what it may ask for is the receiver's business.
 *
 * Enrolment helpers: the `meshrooms://control` link a browser opens at its machine, the five words both show, and the
 * machine's `enrolled` packet, which the browser trusts only when it carries an HMAC under the link's secret.
 */
import { CONTROL_ROOM_ID, browserProtocol, controlRoom, type Command } from './protocol';
import { PAIR_WORDS, encodeSecret, pairingName } from './pairing';
import {
  decryptRelayEnvelope, decryptSelfCertifiedEnvelope, encryptRelayEnvelope, verifyEncBinding, type RelayEnvelope, type RosterEntry,
} from './relay-crypto';

/** A packet up to this many bytes of JSON goes in one frame; a larger one in parts. */
export const CONTROL_SINGLE_BYTES = 16 * 1024;
export const CONTROL_CHUNK_BYTES = 12 * 1024;
export const CONTROL_MAX_PARTS = 64;
/** The largest packet sent or put back together: a whole reply (256 KiB of text) with room for its JSON. */
export const CONTROL_MAX_MESSAGE_BYTES = 768 * 1024;
/** Parts of one packet are waited for this long, and at most this many packets at once per sender. */
export const CONTROL_PARTIAL_TTL_MS = 60_000;
export const CONTROL_MAX_PARTIAL = 4;
/** How long a send waits for the service's answer. */
export const CONTROL_SEND_TIMEOUT_MS = 15_000;
/** A request is valid this long at most (its `expiresAt` - `at`), and a machine remembers its id twice as long. */
export const CONTROL_REQUEST_TTL_MS = 120_000;
export const CONTROL_LINK_VERSION = '1';
/** Envelope ids remembered against repeats, at most this many. */
export const CONTROL_MAX_RECEIVED = 10_000;
/** A connection ready at least this long counts as working: the next failure starts the backoff over. */
const STEADY_MS = 30_000;

export type ControlSelf = {
  id: string;
  /** The raw ECDSA public key, base64: `id` is its sha256. */
  publicKey: string;
  sign: (value: unknown) => Promise<string>;
  encPrivateKey: CryptoKey;
  encVersion: number;
};
/** Another device's keys, as enrolment recorded them. */
export type ControlKeys = { device: string; sign: string; enc: string; encVersion: number };
export type ControlPeer = { device: string; online: boolean; lastSeen?: number };
export type ControlState = 'connecting' | 'ready' | 'closed';

/** A refusal from the service (`rejected`), or no answer in time. */
export class ControlSendError extends Error {
  constructor(readonly reason: string) { super(`The control service refused the frame: ${reason}`); }
}

export type ControlClientOptions = {
  /** `wss://<service>/api/control/v1`. */
  url: string;
  /** The service's origin, signed into `control-open`. */
  origin: string;
  self: ControlSelf;
  /** The devices this one talks to, sent at every connect and with relink(). */
  links: () => string[];
  keysOf: (device: string) => ControlKeys | undefined;
  /** The control domain of traffic with `peer`: a machine uses its own (controlRoom(self)), a browser the machine's. */
  domain: (peer: string) => string;
  onPacket: (from: string, packet: unknown) => void;
  onPeers?: (peers: ControlPeer[], offers: string[]) => void;
  /** A frame from a device `keysOf` doesn't know: enrolment opens it (openEnrolled), everyone else drops it. */
  onUnknown?: (envelope: RelayEnvelope) => void;
  onState?: (state: ControlState, detail?: { code?: number; reason?: string }) => void;
  /** Why a frame was dropped (for logs and tests): never its content. */
  onDrop?: (why: string) => void;
  WebSocket?: typeof WebSocket;
  backoff?: { minMs: number; maxMs: number; refusedMs: number };
  now?: () => number;
};

type Pending = { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Partial = { n: number; parts: (string | undefined)[]; have: number; bytes: number; until: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const textEncoder = new TextEncoder(), textDecoder = new TextDecoder('utf-8', { fatal: true });
const bytesToBase64 = (bytes: Uint8Array) => { let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(text); };
const base64ToBytes = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));

export class ControlClient {
  private readonly options: ControlClientOptions;
  private readonly Socket: typeof WebSocket;
  private readonly now: () => number;
  private ws?: WebSocket;
  private stopped = true;
  private ready = false;
  private seq = 0;
  private retries = 0;
  private readyAt = 0;
  /** The links sent with the last `auth`: different ones are sent once the socket is ready. */
  private sentLinks = '';
  /** Frames are opened one after another, in the order they came (a `running` before the result it precedes). */
  private receiving: Promise<void> = Promise.resolve();
  private retryTimer?: ReturnType<typeof setTimeout>;
  private readonly pending = new Map<string, Pending>();
  private readonly partial = new Map<string, Partial>();
  /** Envelopes received, by id, while they could still come again (CONTROL_REQUEST_TTL_MS). */
  private readonly received = new Map<string, number>();
  private peerList: { peers: ControlPeer[]; offers: string[] } = { peers: [], offers: [] };

  constructor(options: ControlClientOptions) {
    this.options = options;
    this.Socket = options.WebSocket ?? WebSocket;
    this.now = options.now ?? Date.now;
  }

  get state(): ControlState { return this.ready ? 'ready' : this.stopped ? 'closed' : 'connecting'; }
  get peers() { return this.peerList; }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.fail(new ControlSendError('stopped'));
    try { this.ws?.close(1000, 'stopped'); } catch { /* Closed. */ }
    this.ws = undefined;
    this.ready = false;
  }
  /** Sends the links again (they changed). Before the socket is ready, `ready` sends them if they differ from `auth`'s. */
  relink() { if (this.ready) { const links = this.options.links(); this.sentLinks = JSON.stringify(links); this.raw({ t: 'links', links }); } }
  /** Asks for the peers now; the answer comes to onPeers. */
  askPeers() { if (this.ready) this.raw({ t: 'peers' }); }

  /** Seals `packet` to `to` and sends it, in parts if it must; resolves when the service took every frame. */
  async send(to: string, packet: unknown, keys = this.options.keysOf(to)) {
    if (!keys || keys.device !== to) throw new ControlSendError('unknown-recipient');
    const bytes = textEncoder.encode(JSON.stringify(packet));
    if (bytes.length > CONTROL_MAX_MESSAGE_BYTES) throw new ControlSendError('too-large');
    if (bytes.length <= CONTROL_SINGLE_BYTES) return this.frame(to, keys, packet);
    const msg = crypto.randomUUID(), n = Math.ceil(bytes.length / CONTROL_CHUNK_BYTES);
    for (let i = 0; i < n; i++)
      await this.frame(to, keys, { v: 1, t: 'part', msg, i, n, data: bytesToBase64(bytes.subarray(i * CONTROL_CHUNK_BYTES, (i + 1) * CONTROL_CHUNK_BYTES)) });
  }

  private async frame(to: string, keys: ControlKeys, packet: unknown) {
    if (!this.ready || !this.ws) throw new ControlSendError('offline');
    const envelope = await encryptRelayEnvelope(packet, {
      room: this.options.domain(to), from: this.options.self.id, id: crypto.randomUUID(), seq: ++this.seq, rosterVersion: 1, lane: 'primary',
      recipients: [{ id: to, enc: keys.enc, encVersion: keys.encVersion } as RosterEntry], sign: this.options.self.sign,
    });
    const ws = this.ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(envelope.id); reject(new ControlSendError('no-answer')); }, CONTROL_SEND_TIMEOUT_MS);
      this.pending.set(envelope.id, { resolve, reject, timer });
      try { ws.send(JSON.stringify({ t: 'frame', envelope })); }
      catch { clearTimeout(timer); this.pending.delete(envelope.id); reject(new ControlSendError('offline')); }
    });
  }

  private raw(value: unknown) { try { this.ws?.send(JSON.stringify(value)); } catch { /* Closed: the close handler reconnects. */ } }
  private fail(error: Error) {
    for (const [id, waiting] of this.pending) { clearTimeout(waiting.timer); waiting.reject(error); this.pending.delete(id); }
  }

  private connect() {
    if (this.stopped) return;
    this.options.onState?.('connecting');
    let ws: WebSocket;
    try { ws = new this.Socket(this.options.url); } catch { return this.retry(); }
    this.ws = ws;
    ws.addEventListener('message', event => {
      if (this.ws !== ws) return;
      const text = String(event.data);
      this.receiving = this.receiving.then(() => this.message(ws, text)).catch(() => this.options.onDrop?.('failed'));
    });
    ws.addEventListener('close', event => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      // Only a connection that stayed up a while starts the backoff over: one closed at once keeps backing off.
      if (this.ready && this.now() - this.readyAt >= STEADY_MS) this.retries = 0;
      this.ready = false;
      this.fail(new ControlSendError('offline'));
      this.options.onState?.('closed', { code: event.code, reason: event.reason });
      // Refused as a device (not a participant, replaced by another socket of it, too many): try again much later.
      this.retry([4003, 4008, 4009, 4029].includes(event.code));
    });
  }

  private retry(refused = false) {
    if (this.stopped) return;
    const { minMs, maxMs, refusedMs } = this.options.backoff ?? { minMs: 1_000, maxMs: 60_000, refusedMs: 5 * 60_000 };
    const wait = refused ? refusedMs : Math.min(maxMs, minMs * 2 ** this.retries++) * (0.75 + Math.random() / 2);
    this.retryTimer = setTimeout(() => this.connect(), wait);
  }

  private async message(ws: WebSocket, text: string) {
    let msg: Record<string, any>;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'challenge': {
        if (typeof msg.nonce !== 'string') return;
        const { self } = this.options;
        const command: Command = { protocol: browserProtocol, origin: this.options.origin, action: 'control-open', roomId: CONTROL_ROOM_ID, id: crypto.randomUUID(), at: this.now(), payload: { nonce: msg.nonce } };
        const links = this.options.links();
        this.sentLinks = JSON.stringify(links);
        ws.send(JSON.stringify({ t: 'auth', signed: { command, publicKey: self.publicKey, signature: await self.sign(command) }, links }));
        return;
      }
      case 'ready':
        this.ready = true;
        this.readyAt = this.now();
        this.options.onState?.('ready');
        // Links that changed while `auth` was answered.
        if (JSON.stringify(this.options.links()) !== this.sentLinks) this.relink();
        return this.peersChanged(msg);
      case 'peers': return this.peersChanged(msg);
      case 'ping': return this.raw({ t: 'pong', at: this.now() });
      case 'accepted': case 'rejected': {
        const waiting = this.pending.get(msg.id);
        if (!waiting) return;
        clearTimeout(waiting.timer);
        this.pending.delete(msg.id);
        return msg.t === 'accepted' ? waiting.resolve() : waiting.reject(new ControlSendError(String(msg.reason ?? 'refused')));
      }
      case 'frame': return this.receive(msg.envelope);
      default: return;
    }
  }

  private peersChanged(msg: Record<string, any>) {
    const peers = Array.isArray(msg.peers) ? msg.peers.filter((p: any) => p && typeof p.device === 'string' && typeof p.online === 'boolean') : [];
    const offers = Array.isArray(msg.offers) ? msg.offers.filter((o: unknown) => typeof o === 'string') : [];
    this.peerList = { peers, offers };
    this.options.onPeers?.(peers, offers);
  }

  private async receive(envelope: RelayEnvelope) {
    const from = envelope?.from;
    if (typeof from !== 'string') return this.options.onDrop?.('no-sender');
    const keys = this.options.keysOf(from);
    if (!keys) { if (this.options.onUnknown) this.options.onUnknown(envelope); else this.options.onDrop?.('unknown-sender'); return; }
    let packet: any;
    try {
      ({ packet } = await decryptRelayEnvelope(envelope, { room: this.options.domain(from), selfDeviceId: this.options.self.id, selfEncPrivateKey: this.options.self.encPrivateKey,
        selfEncVersion: this.options.self.encVersion, senderSignKey: keys.sign, expectedFrom: from }));
    } catch { return this.options.onDrop?.('unreadable'); }
    // The same envelope twice (the service lets an id through once in 10 minutes; this side remembers it too).
    const now = this.now();
    for (const [id, until] of this.received) { if (until > now && this.received.size < CONTROL_MAX_RECEIVED) break; this.received.delete(id); }
    const key = `${from}:${envelope.id}`;
    if (this.received.has(key)) return this.options.onDrop?.('repeated');
    this.received.set(key, now + 2 * CONTROL_REQUEST_TTL_MS);
    if (packet?.t !== 'part') return this.options.onPacket(from, packet);
    const whole = this.assemble(from, packet);
    if (whole !== undefined) this.options.onPacket(from, whole);
  }

  /** Puts a packet's parts back together; the whole packet once its last part is in. */
  private assemble(from: string, part: any): unknown {
    const now = this.now();
    for (const [key, entry] of this.partial) if (entry.until <= now) this.partial.delete(key);
    const { msg, i, n, data } = part;
    if (typeof msg !== 'string' || !UUID.test(msg) || !Number.isInteger(n) || n < 2 || n > CONTROL_MAX_PARTS || !Number.isInteger(i) || i < 0 || i >= n
      || typeof data !== 'string' || data.length > Math.ceil(CONTROL_CHUNK_BYTES / 3) * 4 || !BASE64.test(data)) { this.options.onDrop?.('bad-part'); return undefined; }
    const key = `${from}:${msg}`;
    let entry = this.partial.get(key);
    if (!entry) {
      if ([...this.partial.keys()].filter(k => k.startsWith(`${from}:`)).length >= CONTROL_MAX_PARTIAL) { this.options.onDrop?.('too-many-partial'); return undefined; }
      this.partial.set(key, entry = { n, parts: new Array(n), have: 0, bytes: 0, until: now + CONTROL_PARTIAL_TTL_MS });
    }
    if (entry.n !== n || entry.parts[i] !== undefined) { this.options.onDrop?.('bad-part'); return undefined; }
    entry.bytes += data.length * 3 / 4;
    if (entry.bytes > CONTROL_MAX_MESSAGE_BYTES + 4) { this.partial.delete(key); this.options.onDrop?.('too-large'); return undefined; }
    entry.parts[i] = data;
    if (++entry.have < n) return undefined;
    this.partial.delete(key);
    try {
      const chunks = entry.parts.map(p => base64ToBytes(p!));
      const bytes = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
      let at = 0;
      for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
      const whole = JSON.parse(textDecoder.decode(bytes));
      // Parts are never nested.
      if (whole?.t === 'part') { this.options.onDrop?.('bad-part'); return undefined; }
      return whole;
    } catch { this.options.onDrop?.('bad-part'); return undefined; }
  }
}

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

/** A browser's half of enrolment: what its `meshrooms://control` link carries. */
export type ControlLinkFields = { origin: string; name: string; device: string; sign: string; enc: string; encVersion: number; encSig: string; secret: Uint8Array };
export function controlLink(fields: ControlLinkFields) {
  const query = new URLSearchParams({ v: CONTROL_LINK_VERSION, origin: fields.origin, name: fields.name, device: fields.device, sign: fields.sign, enc: fields.enc,
    encVersion: String(fields.encVersion), encSig: fields.encSig, secret: encodeSecret(fields.secret) });
  return `meshrooms://control?${query}`;
}

const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
/** A field as the words bind it: its UTF-8 length as 4 bytes, big-endian, then its bytes, so no two lists of fields run together. */
const field = (text: string) => { const bytes = textEncoder.encode(text); return [bytes.length >>> 24 & 255, bytes.length >>> 16 & 255, bytes.length >>> 8 & 255, bytes.length & 255, ...bytes]; };
/**
 * The five words the browser shows and the person types at the machine: word i is byte i of sha256 of
 * "meshrooms-control-v1:" ++ secret ++ field(origin) ++ field(name) ++ field(device) ++ the browser's raw signing key, with
 * each field length-prefixed (above), and the name as the link carries it, before any cleaning. A link made by anyone
 * else, or changed on its way (another service, another name, another key), gives other words than the person's
 * browser shows.
 */
export async function controlWords(secret: Uint8Array, fields: { origin: string; name: string; device: string; sign: string }) {
  const digest = await sha256(new Uint8Array([...textEncoder.encode('meshrooms-control-v1:'), ...secret, ...field(fields.origin), ...field(fields.name), ...field(fields.device),
    ...base64ToBytes(fields.sign)]));
  return [0, 1, 2, 3, 4].map(i => PAIR_WORDS[digest[i]]).join(' ');
}

/** The machine's keys and what it calls itself, as its `enrolled` packet gives them. */
export type EnrolledMachine = { device: string; sign: string; enc: string; encVersion: number; encSig: string; name: string; platform: string };
const enrolMessage = (browser: string, m: Pick<EnrolledMachine, 'device' | 'sign' | 'enc' | 'encVersion' | 'encSig'>) =>
  `meshrooms-control-enrolled-v1:${browser}:${m.device}:${m.sign}:${m.enc}:${m.encVersion}:${m.encSig}`;
/** The `enrolled` packet's proof: an HMAC under the link's secret over the browser's id and the machine's keys, hex. */
export async function enrolMac(secret: Uint8Array, browser: string, machine: Pick<EnrolledMachine, 'device' | 'sign' | 'enc' | 'encVersion' | 'encSig'>) {
  const key = await crypto.subtle.importKey('raw', secret as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, textEncoder.encode(enrolMessage(browser, machine)))), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The browser's check of a machine's first frame while it enrols: the packet is `enrolled`, its envelope is signed by the
 * key it carries (which hashes to the sender), that machine's encryption key is bound to its signing key for every room,
 * and the HMAC under the link's secret matches. Then, and only then, the browser keeps the machine's keys.
 */
export async function openEnrolled(envelope: RelayEnvelope, self: ControlSelf, secret: Uint8Array): Promise<EnrolledMachine> {
  const { packet } = await decryptSelfCertifiedEnvelope<any>(envelope, { room: controlRoom(envelope.from), selfDeviceId: self.id, selfEncPrivateKey: self.encPrivateKey,
    selfEncVersion: self.encVersion, expectedFrom: envelope.from, keyOf: p => p?.machine?.sign });
  const m = packet?.machine;
  if (packet?.t !== 'enrolled' || !m || m.device !== envelope.from || typeof m.enc !== 'string' || !Number.isSafeInteger(m.encVersion) || m.encVersion < 1 || typeof m.encSig !== 'string'
    || typeof packet.mac !== 'string') throw new Error('Not an enrolment answer.');
  if (!await verifyEncBinding(m.sign, { room: '*', deviceId: m.device, enc: m.enc, encVersion: m.encVersion }, m.encSig)) throw new Error("The machine's encryption key isn't bound to it.");
  const expected = await enrolMac(secret, self.id, m);
  if (expected.length !== packet.mac.length || [...expected].reduce((diff, c, i) => diff | (c.charCodeAt(0) ^ packet.mac.charCodeAt(i)), 0) !== 0)
    throw new Error("This machine doesn't hold the link's secret.");
  // Signed by the machine, but its own words: shown cleaned and short.
  const label = (value: unknown, max: number) => typeof value === 'string' ? [...pairingName(value)].slice(0, max).join('') : '';
  return { device: m.device, sign: m.sign, enc: m.enc, encVersion: m.encVersion, encSig: m.encSig, name: label(m.name, 60), platform: label(m.platform, 32) };
}
