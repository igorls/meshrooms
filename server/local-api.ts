/**
 * The local API: how the person's own browser reaches the person device, on this machine only. Served by the daemon
 * (`meshrooms daemon run`) with the hardened pattern of the old local node (access.ts, http.ts), and no ambient
 * credential at all, since nothing on localhost is kept apart by port except an origin:
 *
 * - 127.0.0.1 only, on port 4310 (MESHROOMS_LOCAL_PORT overrides it), or a free port when that one is taken (logged,
 *   and recorded). The endpoint file local-api.json in the daemon's folder (0600) holds the port, the daemon's pid and
 *   start time, and a random secret made at every start; it is removed when the daemon stops.
 * - Every request must name this server in its Host header (no DNS rebinding). The page's origin is
 *   http://127.0.0.1:<port>, never localhost: browsers try localhost on ::1 first, where another program may listen.
 *   A browser write must carry that exact Origin. A browser read may carry it, or (browsers send no Origin on a
 *   same-origin GET) none, as long as Sec-Fetch-Site is absent or same-origin. Any other site, same-site ones included,
 *   is refused. No CORS headers, ever; a strict CSP.
 * - Before anything hands this server a credential, it proves the server is the daemon the endpoint file names
 *   (requestBrowserLink): its pid is alive and is the daemon, and GET /api/local/hello?nonce=N answers
 *   HMAC(secret, port and N). A program squatting on the port, or an old endpoint file whose port another program
 *   now holds, gets nothing.
 * - Local programs of this OS user authenticate with the control token (an HMAC of the secret, so it changes with every
 *   start) as a bearer, and never send an Origin: that is how `person open` gets a one-time ticket.
 * - A browser opens http://127.0.0.1:<port>/#access=<ticket>; the page posts the ticket (120 s, single use, at most 32
 *   pending) to /api/local/session and gets a session token in the JSON answer. The page keeps it in sessionStorage,
 *   which belongs to this origin, port included, and sends it as a bearer token. Session tokens are random, live 12 h
 *   from their last use, are kept only in this daemon's memory (a restart ends them all) and DELETE
 *   /api/local/session ends one. No cookie is ever set, so no other localhost server is sent anything.
 *
 * Endpoints (JSON):
 *   GET    /api/local/hello?nonce=N                       the proof above; no credential
 *   GET    /api/local/health
 *   GET    /api/local/rooms                               rooms with title, state, members and presence, unread counts
 *   POST   /api/local/rooms {title, name, invite?, roomId?}  a new room on the default room service, hosted by the person device
 *   GET    /api/local/service                             where a new room is made, and whether it needs an invite code
 *   GET    /api/local/rooms/:id/messages?after=&limit=    oldest first; reading moves the room's read cursor
 *   GET    /api/local/rooms/:id/view?before=&limit=       the room as the page shows it (person.ts roomView)
 *   POST   /api/local/rooms/:id/send {text, replyTo?, requestId?, attachments?: [{sha256, name}]}
 *   POST   /api/local/rooms/:id/read {messageId}          the read position moves there
 *   POST   /api/local/rooms/:id/task {requestId?, taskId?, change, removed?}
 *   POST   /api/local/rooms/:id/react {requestId?, messageId, emoji}
 *   POST   /api/local/rooms/:id/decision {requestId?, action: open|vote|option|close|withdraw, ...}
 *   POST   /api/local/rooms/:id/command {action, payload} a room service action the person device signs (PAGE_COMMANDS)
 *   POST   /api/local/rooms/:id/files?name=               (application/octet-stream, 10 MB) a file for the next message
 *   GET    /api/local/rooms/:id/files/:sha256             a file of the room this device holds
 *   POST   /api/local/rooms/:id/files/:sha256/want        asks the runner to fetch a file of the room
 *   GET    /api/local/rooms/:id/avatars/:member?h=        a member's picture, from the room service
 *   GET    /api/local/events?after=<cursor>&wait=<s>      long poll, see EventFeed
 *   GET    /api/local/rooms/:id/notify                    the person's notification level for the room (notifications.ts)
 *   POST   /api/local/rooms/:id/notify {level}            mentions (the default), all or off; kept in the person folder
 *   GET    /api/local/notifications?after=<cursor>        (control token only) the app's notification feed, see Notifier
 *   GET    /api/local/app/review                          (control token only) the bound agents, for the app's start notice
 *   POST   /api/local/app/rooms/:id/agents/:member/pause|resume   (control token only) the app's Review window
 *   POST   /api/local/session {ticket}                    (browser) a session token for the ticket
 *   DELETE /api/local/session                             (browser) ends the session token it is sent with
 *   POST   /api/local/ticket                              (control token) a one-time ticket for a browser
 * Agents, harnesses, sessions and approvals: local-agents.ts (`agents`, and `approvals` for the app-only routes).
 * The page itself (src/, LocalSource) is index.html for /, /rooms and /r/<id>, marked as the local page, and Vite's
 * built assets under /assets/: a release's verified files from memory (`uiFiles`, see local-ui.ts), or a checkout's
 * dist/ (`distDir`). Nothing else is served, and without a UI it answers 404.
 * The changes a page asks for are the person device's: the runner signs them from its outbox, as for an agent.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { PERSON_STATUS_FILE, replaceFile } from './browser-agent';
import { IMAGE_TYPES, MAX_ATTACHMENT_BYTES, isSha256 } from '../src/browser/files';
import { sniff } from '../src/attachments';
import {
  VIEW_LIMIT, listedAgents, localMessages, markReadUpTo, messagePage, queueDecision, queueMessage, queueReaction, queueTask, roomMembers, roomState, roomSummary, roomView,
  personHome, storeUpload, uploadAllowed, wantFile, createRoom, defaultRoomService, type LocalMessage,
} from './person';
import { agentRoute, type AgentServices } from './local-agents';
import { agentReview, pauseIdentity, resumeIdentity } from './agents';
import { NotificationWatch, notifyLevel, setNotifyLevel } from './notifications';

export const LOCAL_API_PORT = 4310;
/** The endpoint file, in the daemon's folder. */
export const LOCAL_API_FILE = 'local-api.json';
export const TICKET_TTL_MS = 120_000, MAX_PENDING_TICKETS = 32, SESSION_TTL_MS = 12 * 3_600_000, MAX_SESSIONS = 64;
/** A session unused for this long may make room for a new one when the table is full; one in use never does. */
export const SESSION_IDLE_MS = 30 * 60_000;
/** Long polls waiting at once: per session token, and in all. Past either, the request is answered 429, never queued. */
export const MAX_WAITERS_PER_TOKEN = 4, MAX_WAITERS = 32;

export class LocalApiError extends Error { constructor(public status: number, message: string) { super(message); } }
const fail = (status: number, message: string): never => { throw new LocalApiError(status, message); };
const equal = (a: string, b: string) => { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); };
const hmac = (secret: string, what: string) => createHmac('sha256', secret).update(what).digest('base64url');
/** What a daemon whose endpoint file holds `secret` answers to /api/local/hello on `port`: bound to the port, so a relay can't pass. */
export const helloProof = (secret: string, port: number, nonce: string) => hmac(secret, `meshrooms-local-hello:${port}:${nonce}`);
/** The bearer token of local programs, from the endpoint file's secret; it changes with every daemon start. */
export const localControlToken = (secret: string) => hmac(secret, 'meshrooms-local-control');
const tokenKey = (token: string) => createHash('sha256').update(token).digest('hex');

/** Tickets, session tokens and the control token of one daemon start. `now` is for tests. */
export class LocalAccess {
  private tickets = new Map<string, number>();
  /** Session tokens by their hash, with when each expires; only in memory, so a restart ends them. */
  private sessions = new Map<string, number>();
  constructor(readonly secret: string = randomBytes(32).toString('base64url'), private readonly now: () => number = Date.now) {
    if (secret.length < 32) throw new Error('The local API secret is too short.');
  }
  isControl(token: string) { return equal(token, localControlToken(this.secret)); }
  private expireTickets() { for (const [ticket, expiry] of this.tickets) if (expiry < this.now()) this.tickets.delete(ticket); }
  issueTicket(): string {
    this.expireTickets();
    if (this.tickets.size >= MAX_PENDING_TICKETS) fail(429, 'Too many browser links are waiting to be opened. Wait two minutes and try again.');
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, this.now() + TICKET_TTL_MS);
    return ticket;
  }
  /**
   * Spends a ticket for a new session token. With MAX_SESSIONS live, only a session idle for SESSION_IDLE_MS makes room
   * (the longest idle); otherwise the new one is refused (429) and the ticket kept for a retry, so no burst of sign-ins
   * can push out a page in use.
   */
  exchange(ticket: unknown) {
    this.expireTickets();
    const expiry = typeof ticket === 'string' ? this.tickets.get(ticket) : undefined;
    if (expiry === undefined) fail(401, 'This link was already used or has expired. Open Meshrooms again from the app.');
    for (const [key, until] of this.sessions) if (until < this.now()) this.sessions.delete(key);
    if (this.sessions.size >= MAX_SESSIONS) {
      // A session's expiry is its last use plus SESSION_TTL_MS, so the smallest expiry is the longest idle.
      const [key, until] = [...this.sessions].reduce((a, b) => b[1] < a[1] ? b : a);
      if (this.now() - (until - SESSION_TTL_MS) < SESSION_IDLE_MS) fail(429, 'Too many browsers are signed in to Meshrooms. Sign out of one, then open the link again.');
      this.sessions.delete(key);
    }
    this.tickets.delete(ticket as string);
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(tokenKey(token), this.now() + SESSION_TTL_MS);
    return { token, expiresInSeconds: SESSION_TTL_MS / 1000 };
  }
  /** Whether `token` is a live session; one in use lives another SESSION_TTL_MS. Looked up by its hash, never compared as is. */
  session(token: string) {
    const key = tokenKey(token), until = this.sessions.get(key);
    if (until === undefined) return false;
    if (until < this.now()) { this.sessions.delete(key); return false; }
    this.sessions.set(key, this.now() + SESSION_TTL_MS);
    return true;
  }
  revoke(token: string) { return this.sessions.delete(tokenKey(token)); }
}

/** One change the local API reports: a new message in a room, a room's members or state changing, the room list changing. */
type EventBody =
  | { type: 'message'; roomId: string; message: LocalMessage }
  | { type: 'members'; roomId: string; state: string; members: ReturnType<typeof roomMembers> }
  | { type: 'rooms'; roomIds: string[] }
  /** Anything else of the room the page shows changed: its board, decisions, reactions, files, status or read position. */
  | { type: 'room'; roomId: string };
export type LocalEvent = { seq: number; at: string } & EventBody;
const KEPT_EVENTS = 1_000;
/** A room's files besides its history and roster whose changes the page hears of as one `room` event. */
const ROOM_FILES = ['tasks.json', 'decisions.json', 'reactions.json', PERSON_STATUS_FILE, 'transfers.json', 'read.json'];
/**
 * The events behind GET /api/local/events, a long poll. The person's rooms are written by their runners, which are
 * other processes, so the feed looks at each room's files once a second (`poll`, by size and mtime first) and turns
 * what changed into events, numbered in order. A cursor is `<epoch>.<seq>`: the epoch changes with every daemon, and
 * a cursor from another one, or older than the last 1,000 events, gets `reset: true`, meaning read the rooms again.
 * The first poll of a room sets its baseline: messages it already holds are not events.
 */
export class EventFeed {
  readonly epoch = randomUUID().slice(0, 8);
  private seq = 0;
  private events: LocalEvent[] = [];
  private rooms = new Map<string, { messages: string; ids: Set<string>; members: string; shown: string; rest: string }>();
  private roomList = '';
  /** Waiting long polls, each with whose they are (a hash of its session token), so one token can't take every slot. */
  private waiters = new Map<() => void, string>();
  /** Who else hears of each event as it is made (the notifications, notifications.ts). */
  private listeners: ((event: LocalEvent) => void)[] = [];
  constructor(private readonly home = personHome(), private readonly now: () => number = Date.now) {}
  get cursor() { return `${this.epoch}.${this.seq}`; }
  onEvent(listener: (event: LocalEvent) => void) { this.listeners.push(listener); }
  private push(event: EventBody) {
    const made = { ...event, seq: ++this.seq, at: new Date(this.now()).toISOString() } as LocalEvent;
    this.events.push(made);
    if (this.events.length > KEPT_EVENTS) this.events.splice(0, this.events.length - KEPT_EVENTS);
    for (const listener of this.listeners) try { listener(made); } catch { /* A listener never stops the feed. */ }
  }
  poll() {
    const stamp = (path: string) => { try { const s = statSync(path); return `${s.mtimeMs}:${s.size}`; } catch { return ''; } };
    const listed = listedAgents(this.home), before = this.seq;
    const ids = listed.map(({ room }) => room.roomId).join(',');
    if (ids !== this.roomList) { this.roomList = ids; this.push({ type: 'rooms', roomIds: listed.map(({ room }) => room.roomId) }); }
    for (const key of this.rooms.keys()) if (!listed.some(({ room }) => room.roomId === key)) this.rooms.delete(key);
    for (const { room, agent } of listed) {
      const known = this.rooms.get(room.roomId);
      const messages = stamp(join(agent.dir, 'messages.json'));
      const members = ['members.json', 'admission.json', 'room-closed.json', 'runner-alive.json'].map(f => stamp(join(agent.dir, f))).join('|');
      const rest = ROOM_FILES.map(f => stamp(join(agent.dir, f))).join('|');
      if (known && known.messages === messages && known.members === members && known.rest === rest) continue;
      const entry = known ?? { messages: '', ids: new Set<string>(), members: '', shown: '', rest: '' };
      if (known && known.rest !== rest) this.push({ type: 'room', roomId: room.roomId });
      entry.rest = rest;
      if (!known || known.messages !== messages) {
        const all = localMessages(agent);
        if (known) for (const message of all) if (!entry.ids.has(message.id)) this.push({ type: 'message', roomId: room.roomId, message });
        entry.ids = new Set(all.map(m => m.id)); entry.messages = messages;
      }
      if (!known || known.members !== members) {
        // The proof of life is rewritten every second; only what it changes about the room counts.
        const state = roomState(agent).state, list = roomMembers(agent), shown = JSON.stringify([state, list]);
        if (known && shown !== entry.shown) this.push({ type: 'members', roomId: room.roomId, state, members: list });
        entry.shown = shown; entry.members = members;
      }
      this.rooms.set(room.roomId, entry);
    }
    if (this.seq !== before) for (const wake of [...this.waiters.keys()]) wake();
  }
  /** Events after `after`, waiting up to `waitMs` for one when there are none yet. `holder` names who waits (see waiters). */
  async since(after: string | null, waitMs: number, signal?: AbortSignal, holder = '') {
    if (after === null || after === '') return { cursor: this.cursor, events: [] as LocalEvent[] };
    const match = /^([a-f0-9]{8})\.(\d{1,15})$/.exec(after);
    if (!match) fail(400, 'Use after with the cursor from an earlier answer.');
    const seq = Number(match![2]);
    if (match![1] !== this.epoch || seq > this.seq || (this.events.length && seq < this.events[0].seq - 1) || (!this.events.length && seq < this.seq))
      return { cursor: this.cursor, events: [] as LocalEvent[], reset: true };
    const take = () => this.events.filter(e => e.seq > seq).slice(0, 200);
    if (!take().length && waitMs > 0) {
      if (signal?.aborted) return { cursor: after, events: [] as LocalEvent[] };
      let held = 0; for (const who of this.waiters.values()) if (who === holder) held++;
      if (held >= MAX_WAITERS_PER_TOKEN || this.waiters.size >= MAX_WAITERS) fail(429, 'Too many open event requests. Close an unused tab and try again.');
      await new Promise<void>(done => {
        const finish = () => { clearTimeout(timer); this.waiters.delete(finish); signal?.removeEventListener('abort', finish); done(); };
        const timer = setTimeout(finish, waitMs);
        this.waiters.set(finish, holder);
        signal?.addEventListener('abort', finish, { once: true });
      });
    }
    const events = take();
    return { cursor: events.length ? `${this.epoch}.${events.at(-1)!.seq}` : after, events };
  }
  /** How many long polls wait now (for tests and status). */
  get waiting() { return this.waiters.size; }
}

const SECURITY = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { ...SECURITY, 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" } });
/** The page's policy, as the old local node's: its own scripts, styles and images only, never framed. */
export const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const MAX_BODY = 32_768, MAX_WAIT_SECONDS = 30;
/** Marks the page as served by the local API, so it talks to the person device (LocalSource) instead of the room service. */
export const LOCAL_PAGE_FLAG = '<meta name="meshrooms-source" content="local" />';
/** The page's routes, all answered with the built index.html: the room list and one room. */
const PAGE_ROUTES = /^\/(?:|rooms|r\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
/** Built assets: Vite's hashed files, by name only. Nothing else in the folder is ever served. */
const ASSET = /^\/assets\/[\w.-]{1,200}$/;
/** Room service actions the page may ask the person device to sign. Never create, status or signal (the runner's). */
export const PAGE_COMMANDS = ['request', 'cancel', 'decide', 'link', 'remove', 'agent-invite', 'settings', 'profile', 'repositories', 'close'] as const;
/** Avatars are 16 KB at most in the room service; a proxied one is kept in memory, at most this many. */
const AVATAR_BYTES = 16 * 1024, AVATAR_CACHE = 256, AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/**
 * A request's body, bounded before and while reading: a declared length past `limit` isn't read at all, and a body
 * without one stops at it.
 */
async function bounded(request: Request, limit: number, tooLarge: string) {
  const bytes = await capped(request.headers.get('content-length'), request.body, limit);
  return bytes ?? fail(413, tooLarge);
}
/**
 * A body of at most `limit` bytes, or undefined past it: a declared length past it is not read at all, and the reading
 * stops (and cancels the stream) as soon as the running count passes it, whether or not a length was declared.
 */
async function capped(declaredLength: string | null, stream: ReadableStream<Uint8Array> | null, limit: number) {
  const declared = Number(declaredLength ?? 0);
  if (!Number.isFinite(declared) || declared > limit) { await stream?.cancel().catch(() => {}); return undefined; }
  const chunks: Uint8Array[] = []; let length = 0;
  if (stream) {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > limit) { await reader.cancel().catch(() => {}); return undefined; }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  return new Uint8Array(Buffer.concat(chunks));
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') fail(415, 'Send application/json.');
  const text = Buffer.from(await bounded(request, MAX_BODY, 'This request is too large.')).toString('utf8');
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch { return fail(400, 'Send a JSON object.'); }
}
/** A file the page attaches: raw bytes, 10 MB at most, read only once the request proved it may send one. */
async function upload(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/octet-stream') fail(415, 'Send the file as application/octet-stream.');
  return bounded(request, MAX_ATTACHMENT_BYTES, 'Attach files of 10 MB or less.');
}

/**
 * `uiFiles`: the UI's files by path (index.html, assets/<name>), verified when loaded and served from memory only (a
 * release). `distDir`: a checkout's built UI, read from disk (development). Neither: no page.
 */
export type LocalApiOptions = { access: LocalAccess; port: number; feed: EventFeed; home?: string; distDir?: string; uiFiles?: Map<string, Uint8Array>;
  /** The agent routes' deps (local-agents.ts); without them those routes answer 503. `approvals`: the app-only approval routes exist. */
  agents?: AgentServices; approvals?: boolean;
  /** The app's notification feed (notifications.ts); without it /api/local/notifications answers 503. */
  notifications?: NotificationWatch;
  /** When the daemon started, so the app's start notice counts an agent whose runner is still starting as starting. */
  startedAt?: number };
export function localApiHandler({ access, port, feed, home = personHome(), distDir, uiFiles, agents, approvals = false, notifications, startedAt = Date.now() }: LocalApiOptions) {
  // localhost still names this server (a page load), but only the 127.0.0.1 origin may use the API.
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]), pageOrigin = `http://127.0.0.1:${port}`;
  const room = (id: string) => listedAgents(home).find(r => r.room.roomId === id) ?? fail(404, 'This person is not in that room. Join it from its link, in the Meshrooms app.');
  const avatars = new Map<string, { type: string; bytes: Uint8Array }>();
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (!hosts.has(request.headers.get('host') ?? '')) fail(403, 'Use the local address of Meshrooms.');
      const origin = request.headers.get('origin'), site = request.headers.get('sec-fetch-site');
      // Another localhost port is the same site, so same-site is refused like cross-site.
      if ((origin !== null && origin !== pageOrigin) || site === 'cross-site' || site === 'same-site') fail(403, 'Meshrooms does not accept requests from other sites.');
      if (!url.pathname.startsWith('/api/')) return await page(url, request);
      if (url.pathname === '/api/local/hello' && request.method === 'GET') {
        const nonce = url.searchParams.get('nonce') ?? '';
        if (!/^[\w-]{16,128}$/.test(nonce)) fail(400, 'Give a nonce of 16 to 128 letters, digits, - or _.');
        return json({ proof: helloProof(access.secret, port, nonce), pid: process.pid });
      }
      const header = request.headers.get('authorization');
      const token = header === null ? undefined : /^Bearer ([\w-]{20,128})$/.exec(header)?.[1] ?? fail(401, 'Send a bearer token.');
      const control = token !== undefined && access.isControl(token);
      // The control token is for local programs, which send no Origin and no Sec-Fetch-Site; a browser sends one of
      // them with every API request, so one it got hold of is useless there. Everything else comes from the Meshrooms
      // page: writes with its exact Origin; reads with it, or with none from the same origin (see the top of this file).
      const read = request.method === 'GET' || request.method === 'HEAD';
      if (control && (origin !== null || site !== null)) fail(403, 'Use the control token from local programs only.');
      if (!control && origin === null && !(read && (site === null || site === 'same-origin'))) fail(403, 'Send this from the Meshrooms page.');
      if (url.pathname === '/api/local/session' && request.method === 'POST') {
        const { ticket } = await body(request);
        return json(access.exchange(ticket));
      }
      if (url.pathname === '/api/local/ticket' && request.method === 'POST') {
        if (!control) fail(401, 'Ask for a browser link with the control token.');
        const ticket = access.issueTicket();
        return json({ ticket, url: `${pageOrigin}/#access=${ticket}`, expiresInSeconds: TICKET_TTL_MS / 1000 });
      }
      if (!control && !(token !== undefined && access.session(token))) fail(401, 'Open Meshrooms from the app to sign in on this browser.');
      if (url.pathname === '/api/local/session' && request.method === 'DELETE') return json({ ended: !control && access.revoke(token!) });
      if (url.pathname === '/api/local/health' && request.method === 'GET') return json({ ok: true, rooms: listedAgents(home).length, cursor: feed.cursor });
      if (url.pathname === '/api/local/rooms' && request.method === 'GET') return json({ rooms: listedAgents(home).map(({ room, agent }) => roomSummary(room, agent)) });
      if (url.pathname === '/api/local/service' && request.method === 'GET') return json(await service());
      if (url.pathname === '/api/local/rooms' && request.method === 'POST') {
        const input = await body(request);
        // Always on the default room service (defaultRoomService): never one the page names. The daemon then starts its runner.
        return json(await createRoom({ origin: defaultRoomService(home), title: input.title, name: input.name, invite: input.invite, roomId: input.roomId },
          async () => ({ outcome: 'daemon' }), home)
          .catch((error: Error & { status?: number; code?: string }) => {
            throw Object.assign(new LocalApiError(error.status && error.status < 500 ? error.status : 400, error.message), error.code ? { code: error.code } : {});
          }));
      }
      if (url.pathname === '/api/local/events' && request.method === 'GET') {
        const wait = Number(url.searchParams.get('wait') ?? 25);
        if (!Number.isFinite(wait) || wait < 0 || wait > MAX_WAIT_SECONDS) fail(400, `Use wait between 0 and ${MAX_WAIT_SECONDS} seconds.`);
        return json(await feed.since(url.searchParams.get('after'), wait * 1000, request.signal, control ? 'control' : createHash('sha256').update(token!).digest('hex')));
      }
      // The app's own: its notification feed, the bound agents for its start notice, and its Review window's Pause and
      // Resume. A local program's control token only, never the page's session token (local-agents.ts says why).
      if (url.pathname === '/api/local/notifications' || url.pathname === '/api/local/app/review' || url.pathname.startsWith('/api/local/app/rooms/')) {
        if (!control) fail(403, 'This is for the Meshrooms app only.');
        if (url.pathname === '/api/local/notifications' && request.method === 'GET') {
          if (!notifications) fail(503, 'Notifications are not available in this version of Meshrooms.');
          const wait = Number(url.searchParams.get('wait') ?? 0);
          if (!Number.isFinite(wait) || wait < 0 || wait > MAX_WAIT_SECONDS) fail(400, `Use wait between 0 and ${MAX_WAIT_SECONDS} seconds.`);
          return json(await notifications!.notifier.wait(url.searchParams.get('after'), wait * 1000, request.signal));
        }
        if (url.pathname === '/api/local/app/review' && request.method === 'GET') return json(agentReview(home, Date.now(), startedAt));
        const app = /^\/api\/local\/app\/rooms\/([a-f0-9-]{36})\/agents\/([a-f0-9-]{36})\/(pause|resume)$/.exec(url.pathname);
        if (app && request.method === 'POST') {
          if (!agents) fail(503, 'Agents are not available in this version of Meshrooms.');
          if (app[3] === 'pause') return json(await pauseIdentity(app[1], app[2], agents!.deps, home));
          // Resuming a binding its watcher holds needs the hold the app showed and the person confirmed ({ confirmHold }).
          const input = request.headers.get('content-type') ? await body(request) : {};
          return json(await resumeIdentity(app[1], app[2], agents!.deps, home, input.confirmHold));
        }
        return fail(404, 'Unknown local endpoint.');
      }
      const routed = await agentRoute(url, request.method, { home, control, approvals, body: () => body(request), ...(agents ? { services: agents } : {}) });
      if (routed) return json(routed.value, routed.status);
      const path = /^\/api\/local\/rooms\/([a-f0-9-]{36})\/([a-z-]+)(?:\/([a-f0-9-]{36,64}))?(?:\/(want))?$/.exec(url.pathname);
      if (!path) return fail(404, 'Unknown local endpoint.');
      const [, roomId, part, key, want] = path, method = request.method;
      const at = (): ReturnType<typeof room> => room(roomId);
      if (part === 'messages' && !key && method === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? 50), after = url.searchParams.get('after') ?? undefined;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail(400, 'Use limit between 1 and 200.');
        return json(messagePage(at().agent, after, limit));
      }
      if (part === 'view' && !key && method === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? VIEW_LIMIT), before = url.searchParams.get('before') ?? undefined;
        if (!Number.isInteger(limit) || limit < 1 || limit > VIEW_LIMIT) fail(400, `Use limit between 1 and ${VIEW_LIMIT}.`);
        const { room: listed, agent } = at();
        return json(roomView(listed, agent, { limit, before }));
      }
      if (part === 'send' && !key && method === 'POST') {
        const input = await body(request);
        return json(await queueMessage(at().agent, { text: input.text, replyTo: input.replyTo, requestId: input.requestId, attachments: input.attachments }), 202);
      }
      if (part === 'read' && !key && method === 'POST') return json(markReadUpTo(at().agent, (await body(request)).messageId));
      if (part === 'notify' && !key && method === 'GET') { at(); return json({ roomId, level: notifyLevel(home, roomId) }); }
      if (part === 'notify' && !key && method === 'POST') { at(); return json(setNotifyLevel(home, roomId, (await body(request)).level)); }
      if (part === 'task' && !key && method === 'POST') return json(await queueTask(at().agent, await body(request)));
      if (part === 'react' && !key && method === 'POST') return json(await queueReaction(at().agent, await body(request)));
      if (part === 'decision' && !key && method === 'POST') return json(await queueDecision(at().agent, await body(request)));
      if (part === 'command' && !key && method === 'POST') return json(await command(at(), await body(request)));
      if (part === 'files' && !key && method === 'POST') {
        const name = url.searchParams.get('name') ?? '', { agent } = at();
        if (!name || name.length > 255) fail(400, 'Give the file a name of up to 255 characters.');
        // Admitted, and within the pending files' share, before a byte of the body is read.
        uploadAllowed(agent, Number(request.headers.get('content-length') ?? 0) || 0);
        return json(await storeUpload(agent, await upload(request), name));
      }
      if (part === 'files' && key && want && method === 'POST') return json(wantFile(at().agent, key));
      if (part === 'files' && key && !want && method === 'GET') return await file(at().agent, key);
      if (part === 'avatars' && key && !want && method === 'GET') return await avatar(at().room, key, url.searchParams.get('h') ?? '');
      return fail(404, 'Unknown local endpoint.');
    } catch (error) {
      const status = error instanceof LocalApiError ? error.status : typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : 500;
      if (status === 500) console.error('local API:', error);
      // A room service's reason code (an invite problem) passes on, so the page can ask for a code.
      const code = status !== 500 && typeof (error as { code?: unknown }).code === 'string' && /^[a-z-]{1,32}$/.test((error as { code: string }).code) ? (error as { code: string }).code : undefined;
      return json({ error: status === 500 ? 'Meshrooms could not complete this request.' : (error as Error).message, ...(code ? { code } : {}) }, status);
    }
  };
  /**
   * Where a room made from this page is made (defaultRoomService), and whether that service asks for an invite code to
   * create one, as its health says (unknown when it doesn't answer: the create's own answer says so then).
   */
  async function service() {
    const origin = defaultRoomService(home);
    try {
      const response = await fetch(`${origin}/api/lobby/health`, { redirect: 'error', signal: AbortSignal.timeout(5_000) });
      const bytes = await capped(response.headers.get('content-length'), response.body, 4_096);
      const health = bytes ? JSON.parse(Buffer.from(bytes).toString('utf8')) as { inviteRequired?: unknown } : undefined;
      return { origin, ...(health?.inviteRequired === true ? { inviteRequired: true } : {}) };
    } catch { return { origin }; }
  }
  /**
   * A room service action the page asks the person device to sign (PAGE_COMMANDS): the host's admissions, settings and
   * removals, the person's own profile, agent links, and leaving. The room service checks who may do what, as for any
   * device. Only an agent link's token comes back (shown once); the room's status reaches the page through the runner.
   */
  async function command({ agent }: ReturnType<typeof room>, input: Record<string, unknown>) {
    const action = input.action as typeof PAGE_COMMANDS[number];
    if (!PAGE_COMMANDS.includes(action)) fail(400, 'The page cannot ask for that action.');
    const payload = input.payload ?? {};
    if (typeof payload !== 'object' || Array.isArray(payload) || payload === null) fail(400, 'Send the action\'s payload as an object.');
    // A request from this device says it comes from the app, whatever the page calls itself.
    const signedPayload = action === 'request' ? { ...payload as Record<string, unknown>, label: 'Meshrooms app' } : payload as Record<string, unknown>;
    const result = await agent.command(action, signedPayload).catch((error: Error & { status?: number }) => {
      throw new LocalApiError(error.status && error.status < 500 ? error.status : 502, error.message);
    });
    return action === 'agent-invite' && typeof result?.token === 'string' ? { token: result.token } : { ok: true };
  }
  /** A file of the room this device holds, re-hashed as it is read. Only verified raster images are served as images. */
  async function file(agent: ReturnType<typeof room>['agent'], sha: string) {
    if (!isSha256(sha) || !agent.attachment(sha)) fail(404, 'No message in this room has that file.');
    const bytes = await agent.files.get(sha);
    if (!bytes) fail(404, 'This device does not hold that file yet.');
    const type = sniff(bytes!).type, image = IMAGE_TYPES.includes(type);
    // Never rendered here: a raster image is shown by the page from a blob, anything else only saved.
    return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { ...SECURITY, 'Content-Type': image ? type : 'application/octet-stream',
      ...(image ? {} : { 'Content-Disposition': 'attachment' }), 'Content-Security-Policy': "default-src 'none'; sandbox" } });
  }
  /**
   * A member's picture, from the room service (its avatars are public by hash): the page's policy loads images from
   * this origin only. Fetched once per hash, 16 KB at most, image types only.
   */
  async function avatar(listed: ReturnType<typeof room>['room'], memberId: string, hash: string) {
    if (!/^[a-f0-9-]{36}$/.test(memberId) || !/^[a-f0-9]{8,64}$/.test(hash)) fail(400, 'Use a member and picture hash from the room.');
    const key = `${listed.roomId}:${memberId}:${hash}`;
    let picture = avatars.get(key);
    if (!picture) {
      let response: Response;
      try { response = await fetch(`${listed.origin}/api/lobby/rooms/${listed.roomId}/avatars/${memberId}?h=${hash}`, { redirect: 'error', signal: AbortSignal.timeout(5_000) }); }
      catch { return fail(502, 'The room service did not answer.'); }
      // The type first, then at most AVATAR_BYTES of the body, counted as it arrives (a room service may not say its length).
      const type = response.headers.get('content-type')?.split(';')[0].trim() ?? '';
      if (!response.ok || !AVATAR_TYPES.includes(type)) { await response.body?.cancel().catch(() => {}); fail(404, 'No such picture.'); }
      const bytes = await capped(response.headers.get('content-length'), response.body, AVATAR_BYTES).catch(() => fail(502, 'The room service did not answer.'));
      if (!bytes) fail(502, 'The picture is larger than the room service allows.');
      if (avatars.size >= AVATAR_CACHE) avatars.delete(avatars.keys().next().value!);
      avatars.set(key, picture = { type, bytes: bytes! });
    }
    return new Response(picture.bytes as Uint8Array<ArrayBuffer>, { headers: { ...SECURITY, 'Content-Type': picture.type, 'Content-Security-Policy': "default-src 'none'; sandbox" } });
  }
  /**
   * The static UI, when this version has one: index.html (marked as the local page) for the page's routes, and Vite's
   * built assets by name, under the page CSP. Nothing else in the folder is served, and a path stays inside it, by its
   * real location too.
   */
  async function page(url: URL, request: Request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') fail(405, 'Use GET for pages.');
    if (uiFiles) return fromMemory(url, request, uiFiles);
    if (!distDir || !existsSync(join(distDir, 'index.html'))) fail(404, 'This version of Meshrooms serves no local page yet.');
    const headers = { ...SECURITY, 'Cache-Control': 'no-cache', 'Content-Security-Policy': PAGE_CSP };
    if (PAGE_ROUTES.test(url.pathname)) {
      const built = readFileSync(join(distDir!, 'index.html'), 'utf8');
      const html = built.includes('<head>') ? built.replace('<head>', `<head>\n    ${LOCAL_PAGE_FLAG}`) : `${LOCAL_PAGE_FLAG}${built}`;
      return new Response(request.method === 'HEAD' ? null : html, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (!ASSET.test(url.pathname)) fail(404, 'Page not found.');
    const file = resolve(distDir!, `.${url.pathname}`);
    const inside = (from: string, to: string) => { const rel = relative(from, to); return !!rel && !rel.startsWith('..') && !isAbsolute(rel); };
    if (!inside(resolve(distDir!), file) || !existsSync(file) || !statSync(file).isFile() || !inside(realpathSync(distDir!), realpathSync(file))) fail(404, 'Page not found.');
    const content = Bun.file(file);
    return new Response(request.method === 'HEAD' ? null : content, { headers: { ...headers, 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Type': content.type } });
  }
  /** A release's UI: only the verified files held in memory, by the same routes and asset names, never the disk. */
  function fromMemory(url: URL, request: Request, files: Map<string, Uint8Array>) {
    const headers = { ...SECURITY, 'Cache-Control': 'no-cache', 'Content-Security-Policy': PAGE_CSP };
    if (PAGE_ROUTES.test(url.pathname)) {
      const built = new TextDecoder().decode(files.get('index.html'));
      const html = built.includes('<head>') ? built.replace('<head>', `<head>\n    ${LOCAL_PAGE_FLAG}`) : `${LOCAL_PAGE_FLAG}${built}`;
      return new Response(request.method === 'HEAD' ? null : html, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
    }
    const bytes = ASSET.test(url.pathname) ? files.get(url.pathname.slice(1)) : undefined;
    if (!bytes) fail(404, 'Page not found.');
    const type = ASSET_TYPES[url.pathname.slice(url.pathname.lastIndexOf('.') + 1)] ?? 'application/octet-stream';
    return new Response(request.method === 'HEAD' ? null : bytes as Uint8Array<ArrayBuffer>, { headers: { ...headers, 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Type': type } });
  }
}
/** Content types of the built UI's assets, by extension. */
const ASSET_TYPES: Record<string, string> = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', woff2: 'font/woff2', woff: 'font/woff',
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon', json: 'application/json' };

/**
 * The endpoint file: where this daemon's local API listens, which process serves it and since when, and the secret it
 * proves itself with. `preferred`: the port it wanted, when it had to take another.
 */
export type LocalApiRecord = { url: string; port: number; pid: number; startedAt: number; secret: string; preferred?: number };
export function readLocalApi(dir: string): LocalApiRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(join(dir, LOCAL_API_FILE), 'utf8'));
    return Number.isSafeInteger(record?.port) && Number.isSafeInteger(record?.pid) && typeof record.secret === 'string' && record.secret.length >= 32 ? record : undefined;
  } catch { return undefined; }
}
/** The port to try first: MESHROOMS_LOCAL_PORT (0 for any free one), else 4310. */
export function preferredPort(env: Record<string, string | undefined> = process.env) {
  const given = env.MESHROOMS_LOCAL_PORT;
  if (given === undefined || given === '') return LOCAL_API_PORT;
  const port = Number(given);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('MESHROOMS_LOCAL_PORT must be a port number.');
  return port;
}

/**
 * Starts the local API for the daemon in `dir`: on 127.0.0.1:`port`, or on a free port when that one is taken (logged,
 * and recorded as `preferred`), and writes the endpoint file. `stop` closes it and removes the file. The event feed
 * looks at the rooms once a second meanwhile.
 */
export function startLocalApi(options: { dir: string; home?: string; port?: number; log: (line: string) => void; distDir?: string; uiFiles?: Map<string, Uint8Array>; agents?: AgentServices; approvals?: boolean }) {
  const { dir, home = personHome(), log } = options, preferred = options.port ?? preferredPort();
  const access = new LocalAccess(), feed = new EventFeed(home), notifications = new NotificationWatch(home), startedAt = Date.now();
  // Messages already held when the daemon starts are the feed's baseline: they are not news, and don't notify.
  feed.onEvent(event => notifications.event(event));
  feed.poll();
  let handler: (request: Request) => Promise<Response> = async () => json({ error: 'Starting.' }, 503);
  // idleTimeout above the longest long poll, so Bun doesn't close a waiting request.
  const serve = (port: number) => Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: MAX_WAIT_SECONDS + 15, maxRequestBodySize: MAX_ATTACHMENT_BYTES + 64 * 1024, fetch: request => handler(request) });
  let server: ReturnType<typeof serve>;
  try { server = serve(preferred); }
  catch (error) {
    if (preferred === 0) throw error;
    // Whatever holds it is not this daemon (only one runs per user): it is never told anything, since openers check
    // the endpoint file's port and secret, not the preferred port.
    log(`local API: port ${preferred} is taken by another program (${error instanceof Error ? error.message : String(error)}); using a free one`);
    server = serve(0);
  }
  const port = server.port!;
  handler = localApiHandler({ access, port, feed, home, ...(options.distDir ? { distDir: options.distDir } : {}), ...(options.uiFiles ? { uiFiles: options.uiFiles } : {}),
    ...(options.agents ? { agents: options.agents } : {}), ...(options.approvals ? { approvals: true } : {}), notifications, startedAt });
  const ticker = setInterval(() => {
    try { feed.poll(); } catch (error) { log(`local API: ${error instanceof Error ? error.message : String(error)}`); }
    try { notifications.poll(); } catch (error) { log(`notifications: ${error instanceof Error ? error.message : String(error)}`); }
  }, 1_000);
  const record: LocalApiRecord = { url: `http://127.0.0.1:${port}`, port, pid: process.pid, startedAt: Date.now(), secret: access.secret, ...(port !== preferred && preferred !== 0 ? { preferred } : {}) };
  // A server nobody can find (the endpoint file couldn't be written) is closed again, never left listening.
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); replaceFile(join(dir, LOCAL_API_FILE), JSON.stringify(record)); }
  catch (error) { clearInterval(ticker); server.stop(true); throw error; }
  log(`local API listening on 127.0.0.1:${port}`);
  return { url: record.url, port, pid: record.pid, access, feed, notifications, stop() {
    clearInterval(ticker); server.stop(true);
    // Only our own file: a newer daemon may have written its own meanwhile.
    if (readLocalApi(dir)?.secret === access.secret) rmSync(join(dir, LOCAL_API_FILE), { force: true });
  } };
}

/**
 * `person open`: a one-time browser link from the running daemon's local API. Nothing is sent to the port until it
 * proved to be that daemon: the endpoint file's pid is alive and is the daemon (`isOurDaemon`), and the server answers
 * the hello challenge with the endpoint file's secret, for its own port, as that same pid. Only then is the control
 * token sent.
 */
export async function requestBrowserLink(dir: string, isOurDaemon: (pid: number) => boolean) {
  const { base, record } = await provenDaemon(dir, isOurDaemon, 'it was not given a sign-in link');
  const response = await fetch(`${base}/api/local/ticket`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${localControlToken(record.secret)}` } });
  const result = await response.json().catch(() => ({})) as { url?: string; error?: string; expiresInSeconds?: number };
  if (!response.ok || typeof result.url !== 'string') throw new Error(result.error || `The local API answered ${response.status}.`);
  return { url: result.url, expiresInSeconds: result.expiresInSeconds ?? TICKET_TTL_MS / 1000 };
}
/** The daemon the endpoint file names, once its pid checks out and its server answered the hello challenge for its port. */
async function provenDaemon(dir: string, isOurDaemon: (pid: number) => boolean, withheld: string) {
  const record = readLocalApi(dir);
  if (!record || !isOurDaemon(record.pid)) throw new Error('Meshrooms is not running on this machine. Start it with daemon start, then try again.');
  const base = `http://127.0.0.1:${record.port}`, nonce = randomBytes(24).toString('base64url');
  let hello: { proof?: unknown; pid?: unknown } = {};
  try {
    const response = await fetch(`${base}/api/local/hello?nonce=${nonce}`, { redirect: 'error', signal: AbortSignal.timeout(5_000) });
    if (response.ok) hello = await response.json() as typeof hello;
  } catch { /* Reported below, as not ours. */ }
  if (typeof hello.proof !== 'string' || !equal(hello.proof, helloProof(record.secret, record.port, nonce)) || hello.pid !== record.pid)
    throw new Error(`Something other than Meshrooms answers on port ${record.port}, so ${withheld}. Restart Meshrooms (daemon stop, then daemon start).`);
  return { base, record };
}
/**
 * One of the app's own requests (the notification feed, the start notice's agents, Review's Pause and Resume), made by the
 * bridge's CLI for the app: only to the daemon proven as `requestBrowserLink` proves it, with the control token. Answers
 * the JSON, or throws the local API's error with its status.
 */
export async function appRequest(dir: string, isOurDaemon: (pid: number) => boolean, method: 'GET' | 'POST', path: string, options: { body?: unknown; waitSeconds?: number } = {}) {
  const { base, record } = await provenDaemon(dir, isOurDaemon, 'nothing was asked of it');
  const response = await fetch(`${base}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(20_000 + (options.waitSeconds ?? 0) * 1000),
    headers: { Authorization: `Bearer ${localControlToken(record.secret)}`, ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw Object.assign(new Error(typeof result.error === 'string' ? result.error : `The local API answered ${response.status}.`), { status: response.status });
  return result;
}
