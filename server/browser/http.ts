import { resolve, sep } from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { BrowserLobby, LobbyError } from './lobby';
import { CURRENT_AGENT_VERSION, MIN_AGENT_VERSION } from './agent-version';
import { MIN_PROTOCOL_VERSION, PROTOCOL_HEADER, PROTOCOL_VERSION, UPGRADE_REQUIRED, type SignedCommand } from '../../src/browser/protocol';
import { RELAY_SEND_MAX_BODY_BYTES, RELAY_STATE_MAX_BODY_BYTES, type RelayService } from './relay';
import type { ControlService } from './control';
import type { ServiceSocketData } from './sockets';

const explainer = fileURLToPath(new URL('./agent-join.md', import.meta.url));
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** The page for people shows the same Markdown agents read, escaped, so nothing can render differently. */
const explainerHtml = (markdown: string, roomId: string) => '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + `<meta name="robots" content="noindex"><title>Connect an agent · Meshrooms</title></head><body><main><p><a href="/agent/${roomId}.md">Plain Markdown</a></p><pre>${escape(markdown)}</pre></main></body></html>`;

/**
 * Addresses a rate map tracks at once. Sized above one IPv6 /48's per-minute budget behind Nginx (18,000 /64s at the
 * default 3,600 a minute), so rotating /64s within a /48 cannot evict unrelated clients' counters; Nginx's 60 r/s per
 * /64 and 400 r/s overall keep the keys a minute brings in (24,000 at most) under it too. When full, the oldest entry makes room.
 */
export const RATE_KEYS = 32_768;
/**
 * The quota key for a client address: IPv4 as is (also when IPv4-mapped), IPv6 by its /64, because one host or home
 * network is routinely given a whole /64 and could otherwise take a fresh quota per address.
 */
export function addressKey(address: string): string {
  const plain = address.split('%')[0];
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(plain);
  if (mapped) return mapped[1];
  if (isIP(plain) !== 6) return plain;
  const [head, tail] = plain.includes('::') ? plain.split('::') : [plain, undefined];
  const parts = (text?: string) => text ? text.split(':') : [];
  const width = (groups: string[]) => groups.reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0);
  const groups = tail === undefined ? parts(head) : [...parts(head), ...Array(8 - width(parts(head)) - width(parts(tail))).fill('0'), ...parts(tail)];
  return `${groups.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(':')}::/64`;
}
/**
 * The wider quota key of an IPv6 address: its /48, the block a site or a hosting customer is commonly given, which
 * holds 65,536 separate /64 quotas. IPv4 has none. Takes a key from addressKey.
 */
export function wideKey(key: string): string | undefined {
  const groups = /^([0-9a-f]+):([0-9a-f]+):([0-9a-f]+):[0-9a-f]+::\/64$/.exec(key);
  return groups ? `${groups[1]}:${groups[2]}:${groups[3]}::/48` : undefined;
}
/**
 * How many times one /64's quota a whole /48 gets: people of one network share a /48, so it is above one, while
 * staying under the site-wide Nginx ceiling (behind the proxy, 3,600/min * 5 = 18,000/min = 300 r/s vs 400 r/s).
 */
const WIDE_API = 5, WIDE_CREATE = 4;
const ACTIONS = new Set(['creation-status', 'create', 'request', 'cancel', 'status', 'decide', 'link', 'pair-offer', 'pair-redeem', 'pair-cancel', 'remove', 'signal', 'agent-invite', 'agent-redeem', 'settings', 'profile', 'rename', 'repositories', 'claim', 'transfer-host', 'roster-publish', 'close']);
/** Route shape for logs: room and member ids are replaced, so a log line never names a room. */
const route = (path: string) => path.replace(/[a-f0-9-]{36}/g, ':id').slice(0, 120);

/** `log` receives one JSON line per lobby command (status polls answered 200 or 410 excepted) and per 5xx. */
export type BrowserHttpOptions = { trustLoopbackProxy?: boolean; apiLimit?: number; createLimit?: number; rateKeys?: number; revision?: string; backupFresh?: () => boolean; now?: () => number; log?: (line: string) => void; relay?: RelayService;
  /** Remote control's endpoint (`/api/control/v1`, control.ts); without it the path answers 404. */
  control?: ControlService };
/**
 * `origins`: the service's origin, then any other addresses of it (MESHROOMS_BROWSER_ALIASES). Each request is
 * answered as the origin its Host names, and a browser or bridge there must send that same Origin.
 */
export function browserHandler(lobby: BrowserLobby, origins: string | string[], distDir: string, options: BrowserHttpOptions = {}) {
  const served = new Map((Array.isArray(origins) ? origins : [origins]).map(origin => [new URL(origin).host, origin] as const));
  const root = resolve(distDir);
  const rates = new Map<string, { at: number; count: number }>();
  const creates = new Map<string, { at: number; count: number }>();
  // The /48 counters have tables of their own: in a shared one, the many /64 keys of one /48 would push its own
  // counter out before it filled.
  const wideRates = new Map<string, { at: number; count: number }>(), wideCreates = new Map<string, { at: number; count: number }>();
  const now = options.now || Date.now;
  const rateKeys = options.rateKeys || RATE_KEYS;
  const write = options.log || ((line: string) => console.log(line));
  /** Never payloads, SDP, keys, invite codes or addresses: only what is named here. */
  const log = (event: Record<string, string | number | undefined>) => write(JSON.stringify({ time: new Date(now()).toISOString(), ...event }));
  /** The live counter of `key` in `map`, started afresh when its window has passed. */
  function counter(map: typeof rates, key: string, window: number) {
    const at = now();
    // Entries are never re-inserted, so the map is ordered oldest first: expired ones are all at the front.
    for (const [key, rate] of map) { if (at - rate.at < window) break; map.delete(key); }
    let rate = map.get(key);
    if (!rate) {
      if (map.size >= rateKeys) map.delete(map.keys().next().value!);
      rate = { at, count: 0 };
      map.set(key, rate);
    }
    return rate;
  }
  const charge = (map: typeof rates, key: string, window: number, limit: number) => ++counter(map, key, window).count <= limit;
  const apiLimit = options.apiLimit || 240, createLimit = options.createLimit || 6;
  /**
   * Counts a request against its address and, for IPv6, against the /48 around it. Requests already refused by their
   * own /64 do not charge the /48, so one noisy /64 cannot spend the /48 quota of its neighbours.
   */
  function chargeApi(key: string) {
    if (!charge(rates, key, 60_000, apiLimit)) return false;
    const wide = wideKey(key);
    return wide === undefined || charge(wideRates, wide, 60_000, apiLimit * WIDE_API);
  }
  /**
   * Reserves one room creation for `key` and, for IPv6, its /48, or returns undefined when either has none left. The
   * check and the count happen together, right before the create runs (the lobby's `admit` step, after its device is
   * authenticated): creates sent at the same time each take their own slot, so they can't all pass a check made while
   * none of them had been counted yet, and an unsigned one never holds a slot.
   */
  function reserveCreate(key: string): { count: number }[] | undefined {
    if (createsSpent(key)) return undefined;
    const wide = wideKey(key);
    const own = counter(creates, key, 3_600_000), wider = wide === undefined ? undefined : counter(wideCreates, wide, 3_600_000);
    if (own.count >= createLimit || (wider && wider.count >= createLimit * WIDE_CREATE)) return undefined;
    own.count++; if (wider) wider.count++;
    return wider ? [own, wider] : [own];
  }
  /** Whether `key` or its /48 has no creation left, without counting this request or starting a counter. */
  const createsSpent = (key: string) => {
    const full = (map: typeof rates, key: string, limit: number) => { const rate = map.get(key); return !!rate && now() - rate.at < 3_600_000 && rate.count >= limit; };
    const wide = wideKey(key);
    return full(creates, key, createLimit) || (wide !== undefined && full(wideCreates, wide, createLimit * WIDE_CREATE));
  };
  /** Gives a reserved creation back. A counter whose window has since restarted is no longer in the map, so this is a no-op for it. */
  const releaseCreate = (held: { count: number }[]) => { for (const rate of held) rate.count = Math.max(0, rate.count - 1); };
  const wsOrigins = new Set<string>([...served.values()].map(origin => origin.replace(/^http/, 'ws')));
  try {
    if (lobby.relayEnabled && lobby.relayUrl) wsOrigins.add(new URL(lobby.relayUrl).origin);
  } catch { /* ignore invalid test stub */ }
  const headers = {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self' ${[...wsOrigins].join(' ')}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
  /** An address over its request quota: told when to come back, so bridges and pages wait instead of retrying at once. */
  const busy = () => Response.json({ error: 'Too many requests. Try again shortly.' }, { status: 429, headers: { ...headers, 'Retry-After': '5' } });
  const failure = (error: unknown, status: number, request: string, path: string) =>
    log({ event: 'error', request, status, route: route(path), message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  /** Streams and parses a JSON request body under a strict byte ceiling, independent of Content-Length. */
  async function readJsonBody(request: Request, maxBytes: number): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
    const reader = request.body?.getReader();
    if (!reader) return { ok: false, response: json({ error: 'Request body required.' }, 400) };
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > maxBytes) { await reader.cancel(); return { ok: false, response: json({ error: 'Request too large.' }, 413) }; }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    try { return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; }
    catch { return { ok: false, response: json({ error: 'Invalid request.' }, 400) }; }
  }
  /** A signed room command. Logged with its action and outcome; the body is never logged. */
  async function command(request: Request, address: string, requestId: string, origin: string): Promise<Response> {
    if (request.headers.get('origin') !== origin || request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json({ error: 'Use the room application to submit requests.' }, 403);
    const minProtocolVersion = lobby.minProtocolVersion ?? MIN_PROTOCOL_VERSION;
    const declaredProtocol = request.headers.get(PROTOCOL_HEADER);
    if (declaredProtocol !== null) {
      const trimmed = declaredProtocol.trim();
      const version = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
      if (!Number.isSafeInteger(version) || version < minProtocolVersion) {
        return json({
          error: 'This page or bridge is outdated. Reload the page or update the agent bridge to continue.',
          code: UPGRADE_REQUIRED,
          minProtocolVersion,
          protocolVersion: PROTOCOL_VERSION,
          revision: options.revision || 'development',
        }, 426);
      }
    }
    const parsed = await readJsonBody(request, 24_000);
    if (!parsed.ok) return parsed.response;
    const input = parsed.value;
    const named = (input as { command?: { action?: unknown } })?.command?.action;
    const action = typeof named === 'string' && ACTIONS.has(named) ? named : 'unknown';
    const started = performance.now();
    let status = 500;
    // A retry of a create that already succeeded is answered from its receipt and isn't charged again.
    const creating = action === 'create' && !await lobby.answered(input);
    let held: { count: number }[] | undefined;
    try {
      // Signed for the address it is sent to, so a page or bridge at one address never speaks as another.
      if ((input as { command?: { origin?: unknown } })?.command?.origin !== origin) { status = 400; return json({ error: 'This request has expired or is invalid. Try again.' }, 400); }
      // Refused at once when nothing is left, before the signature is checked; the slot itself is taken in `admit`.
      if (creating && createsSpent(addressKey(address))) { status = 429; return json({ error: 'Room creation limit reached. Try again in an hour.' }, 429); }
      const admit = creating ? () => { if (!(held = reserveCreate(addressKey(address)))) throw new LobbyError(429, 'Room creation limit reached. Try again in an hour.'); } : undefined;
      const response = json(await lobby.execute(input as Parameters<BrowserLobby['execute']>[0], addressKey(address), admit));
      status = 200;
      return response;
    } catch (error) {
      if (!(error instanceof LobbyError)) throw error;
      status = error.status;
      return json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
    } finally {
      // A create is counted once its device is authenticated, before it runs (reserveCreate), and keeps its count
      // whatever the outcome, so a refused invite counts and invite codes can't be guessed in parallel. A malformed or
      // unsigned one (400, 401) never reaches the count, so anyone at a shared address can't use up the others' creates
      // with requests that cost nothing to make; those are bounded by the request quota alone. One refused later as
      // invalid (400), turned away by a full service (429) or failed on (5xx) gets its count back.
      if (held && (status === 400 || status === 401 || status === 429 || status >= 500)) releaseCreate(held);
      // Status polls arrive every 1.5 s per device; only their failures are worth a line. A closed room (410) isn't a
      // failure: tabs and bridges from before its closing keep polling it until they are reloaded.
      if (action !== 'status' || (status !== 200 && status !== 410)) log({ event: 'lobby', request: requestId, action, status, ms: Math.round((performance.now() - started) * 10) / 10 });
    }
  }
  return async (
    request: Request,
    remoteAddress = 'local',
    upgrade?: (request: Request, data: ServiceSocketData) => boolean,
  ): Promise<Response> => {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID().slice(0, 8);
    const origin = served.get(request.headers.get('host') || url.host);
    if (!origin) return json({ error: 'Unexpected host.' }, 403);
    if (request.headers.get('origin') && request.headers.get('origin') !== origin) return json({ error: 'Unexpected origin.' }, 403);
    // Nginx must overwrite this header. Direct clients can never choose their quota key.
    let address = remoteAddress;
    if (options.trustLoopbackProxy && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
      const forwarded = request.headers.get('x-real-ip');
      if (forwarded && isIP(forwarded)) address = forwarded;
    }
    // Health answers before quotas, so a probe is never told to slow down. It stays cheap: one small read.
    if (url.pathname === '/api/lobby/health' && request.method === 'GET') {
      const body = { revision: options.revision || 'development', inviteRequired: lobby.inviteRequired, minAgentVersion: MIN_AGENT_VERSION,
        currentAgentVersion: CURRENT_AGENT_VERSION, protocolVersion: PROTOCOL_VERSION, minProtocolVersion: lobby.minProtocolVersion ?? MIN_PROTOCOL_VERSION,
        ...(options.relay && { relayEnabled: true }),
        ...(options.control && { controlEnabled: true }),
        ...(options.backupFresh && { backupFresh: options.backupFresh() }) };
      try { return json({ ok: lobby.healthy(), ...body }); }
      catch (error) { failure(error, 503, requestId, url.pathname); return json({ ok: false, ...body }, 503); }
    }
    try {
      if (url.pathname === '/api/relay/v1') {
        if (!options.relay) return json({ error: 'Relay not enabled.' }, 404);
        if (!chargeApi(addressKey(address))) return busy();
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket' || !upgrade) {
          return json({ error: 'WebSocket upgrade required.' }, 426);
        }
        const upgraded = upgrade(request, options.relay.createSocketData(addressKey(address)));
        if (!upgraded) return json({ error: 'WebSocket upgrade failed.' }, 400);
        return undefined as unknown as Response;
      }
      // Remote control (control.ts): a WebSocket only, with no room. The signed challenge must name this socket's origin.
      if (url.pathname === '/api/control/v1') {
        if (!options.control) return json({ error: 'Not found.' }, 404);
        if (!chargeApi(addressKey(address))) return busy();
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket' || !upgrade) return json({ error: 'WebSocket upgrade required.' }, 426);
        if (!upgrade(request, options.control.createSocketData(addressKey(address), origin))) return json({ error: 'WebSocket upgrade failed.' }, 400);
        return undefined as unknown as Response;
      }
      if (url.pathname.startsWith('/api/relay/v1/')) {
        if (!options.relay) return json({ error: 'Not found.' }, 404);
        if (!chargeApi(addressKey(address))) return busy();
        if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
        if (request.headers.get('origin') !== origin || request.headers.get('content-type')?.split(';')[0] !== 'application/json') {
          return json({ error: 'Use the room application to submit requests.' }, 403);
        }
        const maxBytes = url.pathname === '/api/relay/v1/state' ? RELAY_STATE_MAX_BODY_BYTES : RELAY_SEND_MAX_BODY_BYTES;
        const parsed = await readJsonBody(request, maxBytes);
        if (!parsed.ok) return parsed.response;
        if ((parsed.value as { command?: { origin?: unknown } })?.command?.origin !== origin) return json({ error: 'This request has expired or is invalid. Try again.' }, 400);
        const result = await options.relay.handleHttp(url.pathname, parsed.value as SignedCommand, request.signal);
        return json(result);
      }
      if (url.pathname.startsWith('/api/lobby')) {
        if (!chargeApi(addressKey(address))) return busy();
        if (request.method === 'GET' && /^\/api\/lobby\/rooms\/[a-f0-9-]{36}$/.test(url.pathname)) return json(lobby.publicRoom(url.pathname.split('/').at(-1)!));
        // Member ids are only shown to admitted members, and the hash pins one picture, so the response can be cached forever.
        const avatar = /^\/api\/lobby\/rooms\/([a-f0-9-]{36})\/avatars\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (avatar && request.method === 'GET') {
          const hash = url.searchParams.get('h') || '';
          const picture = /^[a-f0-9]{16}$/.test(hash) ? lobby.avatar(avatar[1], avatar[2], hash) : null;
          if (!picture) return json({ error: 'Not found.' }, 404);
          return new Response(new Uint8Array(picture.bytes), { headers: { ...headers, 'Content-Type': picture.type, 'Cache-Control': 'private, max-age=31536000, immutable',
            'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin' } });
        }
        if (url.pathname !== '/api/lobby' || request.method !== 'POST') return json({ error: 'Not found.' }, 404);
        return await command(request, address, requestId, origin);
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Method not allowed.' }, 405);
      // The agent bridge is built from the same commit at deploy, next to the browser assets.
      const bundle = /^\/agent\/meshrooms-agent\.js(\.sha256)?$/.exec(url.pathname);
      if (bundle) {
        const file = Bun.file(resolve(root, 'agent', `meshrooms-agent.js${bundle[1] || ''}`));
        if (!await file.exists()) return json({ error: 'The agent bridge is not built on this server.' }, 404);
        return new Response(request.method === 'HEAD' ? null : file, { headers: { ...headers, 'Content-Type': bundle[1] ? 'text/plain; charset=utf-8' : 'text/javascript; charset=utf-8' } });
      }
      // The agent link's token lives in the URL fragment, so it never reaches this server or its logs.
      const agentPage = /^\/agent\/([a-f0-9-]{36})(\.md)?$/.exec(url.pathname);
      if (agentPage) {
        // This page reads the room from the database, so it shares the request quota of the room commands.
        if (!chargeApi(addressKey(address))) return busy();
        const room = lobby.publicRoom(agentPage[1]);
        const digest = Bun.file(resolve(root, 'agent', 'meshrooms-agent.js.sha256'));
        const sha256 = await digest.exists() ? (await digest.text()).split(/\s/)[0] : 'unavailable: the agent bridge is not built on this server';
        // Commands name the exact bridge version: a bare package name can run an older copy bunx cached.
        const text = (await Bun.file(explainer).text()).replaceAll('{{ORIGIN}}', origin).replaceAll('{{ROOM_ID}}', room.roomId).replaceAll('{{AGENT_VERSION}}', CURRENT_AGENT_VERSION)
          // The host chooses the title, and an agent follows this text: name the room by its id, never by host-written text.
          .replaceAll('{{ROOM_TITLE}}', `\`${room.roomId}\``).replaceAll('{{BUNDLE_SHA256}}', sha256);
        const body = agentPage[2] ? text : explainerHtml(text, room.roomId);
        return new Response(request.method === 'HEAD' ? null : body, { headers: { ...headers, 'Content-Type': agentPage[2] ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8' } });
      }
      const route = url.pathname === '/rooms' || /^\/r\/[a-f0-9-]{36}$/.test(url.pathname);
      const relative = route ? 'index.html' : url.pathname.replace(/^\//, '');
      if (!route && !/^assets\/[a-zA-Z0-9_.-]+$/.test(relative)) return json({ error: 'Not found.' }, 404);
      const path = resolve(root, relative);
      if (!path.startsWith(root + sep)) return json({ error: 'Not found.' }, 404);
      const file = Bun.file(path);
      if (!await file.exists()) return json({ error: 'Build the browser application first.' }, 404);
      return new Response(request.method === 'HEAD' ? null : file, { headers });
    } catch (error) {
      if (error instanceof LobbyError) return json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
      failure(error, 500, requestId, url.pathname);
      return json({ error: 'The room service could not finish this request. Try again.', requestId }, 500);
    }
  };
}
