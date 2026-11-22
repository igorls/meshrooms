import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { adminHandler, adminOrigin } from './admin';
import { admitBetaDevice } from './invites';
import { openAdmission } from './store';

const origin = 'https://meshrooms.example.ts.net:8443', password = 'test-only-32-byte-administrator-credential';
function setup() {
  const db = openAdmission(':memory:'), log: object[] = [];
  let now = Date.now();
  const handle = adminHandler(db, { origin, passwordHash: createHash('sha256').update(password).digest('hex'), now: () => now, log: e => log.push(e) });
  const request = (path: string, data?: unknown, headers: Record<string, string> = {}, address = '127.0.0.1') => handle(new Request(origin + path, {
    method: data === undefined ? 'GET' : 'POST', headers: { host: new URL(origin).host, ...(data === undefined ? {} : { origin, 'content-type': 'application/json' }), ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }), address);
  const login = async () => {
    const response = await request('/api/login', { password });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain('Secure; HttpOnly; SameSite=Strict');
    return { cookie: cookie.split(';')[0], 'x-csrf-token': (await response.json()).csrf as string };
  };
  return { db, request, login, log, advance: () => { now += 9 * 3_600_000; } };
}
test('admin ingress rejects public addresses, foreign hosts and missing authentication', async () => {
  const s = setup();
  try {
    expect(() => adminOrigin('https://meshrooms.wormdb.dev')).toThrow('Tailnet');
    expect(() => adminOrigin('http://machine.example.ts.net')).toThrow('Tailnet');
    expect((await s.request('/api/state')).status).toBe(401);
    expect((await s.request('/api/state', undefined, {}, '100.64.1.2')).status).toBe(403);
    expect((await s.request('/api/state', undefined, { host: 'meshrooms.wormdb.dev' })).status).toBe(403);
    expect((await s.request('/api/login', { password }, { origin: 'https://attacker.example' })).status).toBe(403);
    expect((await s.request('/api/login', { password: 'wrong' })).status).toBe(401);
    for (let i = 0; i < 9; i++) await s.request('/api/login', { password: 'wrong' });
    expect((await s.request('/api/login', { password })).status).toBe(429);
  } finally { s.db.close(); }
});
test('admin mints once, lists hashes only, enforces CSRF and revokes without leaking secrets', async () => {
  const s = setup();
  try {
    const headers = await s.login();
    expect((await s.request('/api/invites', { uses: 1, days: 30 }, { cookie: headers.cookie })).status).toBe(403);
    expect((await s.request('/api/invites', { uses: 1, days: 30 }, { ...headers, origin: 'https://attacker.example' })).status).toBe(403);
    expect((await s.request('/api/invites', { uses: 0, days: 30 }, headers)).status).toBe(400);
    const minted = await s.request('/api/invites', { uses: 1, days: 30, note: '<script>plain text</script>' }, headers);
    expect(minted.status).toBe(201); const invite = await minted.json();
    const stateResponse = await s.request('/api/state', undefined, headers), state = await stateResponse.json();
    expect(state.invites).toHaveLength(1); expect(state.invites[0].remaining).toBe(1);
    expect(JSON.stringify(state)).not.toContain(invite.code); expect(JSON.stringify(s.log)).not.toContain(invite.code); expect(JSON.stringify(s.log)).not.toContain(password);
    expect(stateResponse.headers.get('cache-control')).toBe('no-store');
    expect((await s.request(`/api/invites/${invite.id}/revoke`, {}, headers)).status).toBe(200);
    expect((await s.request('/api/state', undefined, headers)).status).toBe(200);
    s.advance(); expect((await s.request('/api/state', undefined, headers)).status).toBe(401);
  } finally { s.db.close(); }
});
test('signing out invalidates the session and the credential is never put in a cookie', async () => {
  const s = setup();
  try { const h = await s.login(); expect(h.cookie).not.toContain(password); await s.request('/api/logout', {}, h); expect((await s.request('/api/state', undefined, h)).status).toBe(401); }
  finally { s.db.close(); }
});

test('admin serves preloaded assets with HSTS, enforces constant-time CSRF lengths, and revokes beta people', async () => {
  const s = setup();
  try {
    const html = await s.request('/');
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(html.headers.get('strict-transport-security')).toBe('max-age=86400');
    expect(await html.text()).toContain('id="people"');
    const js = await s.request('/admin.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('strict-transport-security')).toBe('max-age=86400');
    const jsText = await js.text();
    expect(jsText).toContain('response.json().catch');
    expect(jsText).toContain('/api/people/revoke');
    // Serving the same preloaded asset repeatedly stays healthy.
    expect((await s.request('/admin.css')).status).toBe(200);
    expect((await s.request('/admin.css')).status).toBe(200);

    const personA = 'a'.repeat(64), devA2 = 'b'.repeat(64), personB = 'c'.repeat(64);
    admitBetaDevice(s.db, personA, personA, 1000);
    admitBetaDevice(s.db, devA2, personA, 2000);
    admitBetaDevice(s.db, personB, personB, 3000);

    const headers = await s.login();
    const stateRes = await s.request('/api/state', undefined, headers);
    expect(stateRes.headers.get('strict-transport-security')).toBe('max-age=86400');
    const state = await stateRes.json();
    expect(state.people).toEqual([
      { id: personB, devices: 1, admittedAt: 3000 },
      { id: personA, devices: 2, admittedAt: 1000 },
    ]);

    // Wrong-length and same-length wrong CSRF tokens are rejected cleanly without throwing.
    expect((await s.request('/api/people/revoke', { person: personA }, { cookie: headers.cookie, 'x-csrf-token': 'short' })).status).toBe(403);
    expect((await s.request('/api/people/revoke', { person: personA }, { cookie: headers.cookie, 'x-csrf-token': 'x'.repeat(headers['x-csrf-token'].length) })).status).toBe(403);

    // Invalid person ids are rejected with 400; unknown person returns 404.
    expect((await s.request('/api/people/revoke', { person: '' }, headers)).status).toBe(400);
    expect((await s.request('/api/people/revoke', { person: '../bad id' }, headers)).status).toBe(400);
    expect((await s.request('/api/people/revoke', { person: 'd'.repeat(64) }, headers)).status).toBe(404);

    // Valid revocation removes all devices for personA and writes a secret-free audit log.
    const revoked = await s.request('/api/people/revoke', { person: personA }, headers);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: true, removed: 2 });
    expect((await (await s.request('/api/state', undefined, headers)).json()).people).toEqual([
      { id: personB, devices: 1, admittedAt: 3000 },
    ]);
    expect(s.log).toContainEqual(expect.objectContaining({ event: 'admin', action: 'revoke-person', person: personA, removed: 2 }));
    expect(JSON.stringify(s.log)).not.toContain(password);
  } finally { s.db.close(); }
});
