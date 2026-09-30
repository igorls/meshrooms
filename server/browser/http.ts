import { resolve, sep } from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { BrowserLobby, LobbyError } from './lobby';
import { CURRENT_AGENT_VERSION, MIN_AGENT_VERSION } from './agent-version';

const explainer = fileURLToPath(new URL('./agent-join.md', import.meta.url));
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** The page for people shows the same Markdown agents read, escaped, so nothing can render differently. */
const explainerHtml = (markdown: string, roomId: string) => '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + `<meta name="robots" content="noindex"><title>Connect an agent · Meshrooms</title></head><body><main><p><a href="/agent/${roomId}.md">Plain Markdown</a></p><pre>${escape(markdown)}</pre></main></body></html>`;

/** Addresses a rate map tracks at once. When full, the oldest entry makes room: a new address is never refused for it. */
const RATE_KEYS = 4096;
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
const ACTIONS = new Set(['create', 'request', 'cancel', 'status', 'decide', 'link', 'remove', 'signal', 'agent-invite', 'agent-redeem', 'settings', 'profile', 'repositories', 'close']);
/** Route shape for logs: room and member ids are replaced, so a log line never names a room. */
const route = (path: string) => path.replace(/[a-f0-9-]{36}/g, ':id').slice(0, 120);

/** `log` receives one JSON line per lobby command (status polls answered 200 or 410 excepted) and per 5xx. */
export type BrowserHttpOptions = { trustLoopbackProxy?: boolean; apiLimit?: number; createLimit?: number; revision?: string; backupFresh?: () => boolean; now?: () => number; log?: (line: string) => void };
export function browserHandler(lobby: BrowserLobby, origin: string, distDir: string, options: BrowserHttpOptions = {}) {
  const allowed = new URL(origin);
  const root = resolve(distDir);
  const rates = new Map<string, { at: number; count: number }>();
  const creates = new Map<string, { at: number; count: number }>();
  const now = options.now || Date.now;
  const write = options.log || ((line: string) => console.log(line));
  /** Never payloads, SDP, keys, invite codes or addresses: only what is named here. */
  const log = (event: Record<string, string | number | undefined>) => write(JSON.stringify({ time: new Date(now()).toISOString(), ...event }));
  function charge(map: typeof rates, key: string, window: number, limit: number) {
    const at = now();
    // Entries are never re-inserted, so the map is ordered oldest first: expired ones are all at the front.
    for (const [key, rate] of map) { if (at - rate.at < window) break; map.delete(key); }
    let rate = map.get(key);
    if (!rate) {
      if (map.size >= RATE_KEYS) map.delete(map.keys().next().value!);
      rate = { at, count: 0 };
      map.set(key, rate);
    }
    return ++rate.count <= limit;
  }
  const headers = {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
  const failure = (error: unknown, status: number, request: string, path: string) =>
    log({ event: 'error', request, status, route: route(path), message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  /** A signed room command. Logged with its action and outcome; the body is never logged. */
  async function command(request: Request, address: string, requestId: string): Promise<Response> {
    if (request.headers.get('origin') !== origin || request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json({ error: 'Use the room application to submit requests.' }, 403);
    // Enforce the streamed limit, not only a client-supplied Content-Length.
    const reader = request.body?.getReader();
    if (!reader) return json({ error: 'Request body required.' }, 400);
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 24_000) { await reader.cancel(); return json({ error: 'Request too large.' }, 413); } chunks.push(part.value); }
    } finally { reader.releaseLock(); }
    let input: unknown;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json({ error: 'Invalid request.' }, 400); }
    const named = (input as { command?: { action?: unknown } })?.command?.action;
    const action = typeof named === 'string' && ACTIONS.has(named) ? named : 'unknown';
    const started = performance.now();
    let status = 500;
    try {
      // A retry of a create that already succeeded is answered from its receipt and isn't charged again.
      if (action === 'create' && !await lobby.answered(input) && !charge(creates, addressKey(address), 3_600_000, options.createLimit || 6)) { status = 429; return json({ error: 'Room creation limit reached. Try again in an hour.' }, 429); }
      const response = json(await lobby.execute(input as Parameters<BrowserLobby['execute']>[0]));
      status = 200;
      return response;
    } catch (error) {
      if (!(error instanceof LobbyError)) throw error;
      status = error.status;
      return json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
    } finally {
      // Status polls arrive every 1.5 s per device; only their failures are worth a line. A closed room (410) isn't a
      // failure: tabs and bridges from before its closing keep polling it until they are reloaded.
      if (action !== 'status' || (status !== 200 && status !== 410)) log({ event: 'lobby', request: requestId, action, status, ms: Math.round((performance.now() - started) * 10) / 10 });
    }
  }
  return async (request: Request, remoteAddress = 'local'): Promise<Response> => {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID().slice(0, 8);
    if ((request.headers.get('host') || url.host) !== allowed.host) return json({ error: 'Unexpected host.' }, 403);
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
        currentAgentVersion: CURRENT_AGENT_VERSION, ...(options.backupFresh && { backupFresh: options.backupFresh() }) };
      try { return json({ ok: lobby.healthy(), ...body }); }
      catch (error) { failure(error, 503, requestId, url.pathname); return json({ ok: false, ...body }, 503); }
    }
    try {
      if (url.pathname.startsWith('/api/lobby')) {
        if (!charge(rates, addressKey(address), 60_000, options.apiLimit || 240)) return json({ error: 'Too many requests. Try again shortly.' }, 429);
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
        return await command(request, address, requestId);
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
