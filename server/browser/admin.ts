import type { Database } from 'bun:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mintInvite, listInvites, revokeInvite } from './invites';
import { listRooms } from './store';

const assets = {
  '/': new URL('./admin/index.html', import.meta.url),
  '/admin.js': new URL('./admin/admin.js', import.meta.url),
  '/admin.css': new URL('./admin/admin.css', import.meta.url),
};
const sha = (value: string) => createHash('sha256').update(value).digest();
const COOKIE = '__Host-meshrooms-admin';
const TTL = 8 * 3_600_000;
export function adminOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.ts.net') || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('MESHROOMS_ADMIN_ORIGIN must be an HTTPS Tailnet .ts.net origin.');
  return url.origin;
}

/** Separate loopback service; never mounted on the public coordinator or its Nginx routes. */
export function adminHandler(db: Database, options: { origin: string; passwordHash: string; now?: () => number; log?: (event: object) => void }) {
  const origin = adminOrigin(options.origin), host = new URL(origin).host;
  if (!/^[a-f0-9]{64}$/.test(options.passwordHash)) throw new Error('Set MESHROOMS_ADMIN_PASSWORD_HASH to the SHA-256 of a random 32-byte credential.');
  const expected = Buffer.from(options.passwordHash, 'hex'), now = options.now ?? Date.now;
  const sessions = new Map<string, { csrf: string; expires: number }>();
  let attempts = 0, windowAt = now();
  const headers = {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...headers, ...extra } });
  const audit = (event: string, id?: string) => options.log?.({ time: new Date(now()).toISOString(), event, ...(id ? { id } : {}) });
  async function body(request: Request): Promise<Record<string, unknown>> {
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new Error('Use JSON.');
    const reader = request.body?.getReader();
    if (!reader) throw new Error('Body required.');
    let size = 0; const chunks: Uint8Array[] = [];
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 4096) { await reader.cancel(); throw new Error('Request too large.'); } chunks.push(part.value); } }
    finally { reader.releaseLock(); }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Use a JSON object.');
    return parsed;
  }
  return async (request: Request, address: string): Promise<Response> => {
    // Tailscale Serve is the only network ingress. Even a Tailnet address cannot call this backend directly.
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address) || request.headers.get('host') !== host) return json({ error: 'Unavailable.' }, 403);
    const path = new URL(request.url).pathname;
    const mutation = request.method !== 'GET';
    if (mutation && (request.method !== 'POST' || request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site')) return json({ error: 'Use the admin panel.' }, 403);
    if (!mutation && path in assets && Object.hasOwn(assets, path)) {
      const file = Bun.file(assets[path as keyof typeof assets]);
      return new Response(file, { headers: { ...headers, 'Content-Type': path === '/' ? 'text/html; charset=utf-8' : path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' } });
    }
    for (const [id, session] of sessions) if (session.expires <= now()) sessions.delete(id);
    const cookie = request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    const session = cookie ? sessions.get(cookie) : undefined;
    try {
      if (path === '/api/login' && mutation) {
        if (now() - windowAt >= 60_000) { attempts = 0; windowAt = now(); }
        if (++attempts > 10) return json({ error: 'Too many sign-in attempts. Try again in a minute.' }, 429);
        const input = await body(request);
        if (typeof input.password !== 'string' || input.password.length > 256 || !timingSafeEqual(sha(input.password), expected)) { audit('admin-login-refused'); return json({ error: 'Incorrect admin credential.' }, 401); }
        if (cookie) sessions.delete(cookie);
        if (sessions.size >= 128) sessions.delete(sessions.keys().next().value!);
        const id = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
        sessions.set(id, { csrf, expires: now() + TTL }); audit('admin-login');
        return json({ csrf }, 200, { 'Set-Cookie': `${COOKIE}=${id}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${TTL / 1000}` });
      }
      if (!session) return json({ error: 'Sign in to continue.' }, 401);
      if (mutation && request.headers.get('x-csrf-token') !== session.csrf) return json({ error: 'Refresh the admin panel and try again.' }, 403);
      if (path === '/api/state' && !mutation) return json({ csrf: session.csrf, invites: listInvites(db), rooms: listRooms(db),
        people: db.query('SELECT person AS id, COUNT(*) AS devices, MIN(admitted_at) AS admittedAt FROM beta_admissions GROUP BY person ORDER BY admittedAt DESC').all() });
      if (path === '/api/logout' && mutation) { sessions.delete(cookie!); return json({ signedOut: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` }); }
      if (path === '/api/invites' && mutation) {
        const input = await body(request);
        if (typeof input.uses !== 'number' || typeof input.days !== 'number' || (input.note !== undefined && typeof input.note !== 'string')) return json({ error: 'Enter valid invite details.' }, 400);
        const invite = mintInvite(db, { uses: input.uses, days: input.days, note: input.note as string | undefined, now: now() });
        audit('admin-invite-minted', invite.id); return json(invite, 201);
      }
      const revoke = /^\/api\/invites\/([a-f0-9]{8})\/revoke$/.exec(path);
      if (revoke && mutation) { const revoked = revokeInvite(db, revoke[1], now()); if (revoked) audit('admin-invite-revoked', revoke[1]); return json({ revoked }, revoked ? 200 : 404); }
      return json({ error: 'Not found.' }, 404);
    } catch (error) {
      // Validation errors carry no credential or code; unexpected database failures stay out of the browser.
      if (error instanceof SyntaxError) return json({ error: 'Invalid JSON.' }, 400);
      const message = error instanceof Error ? error.message : '';
      if (/^(Give |Keep |Use |Body required|Request too large)/.test(message)) return json({ error: message }, 400);
      audit('admin-error'); return json({ error: 'The operation failed. Check the service log.' }, 500);
    }
  };
}
