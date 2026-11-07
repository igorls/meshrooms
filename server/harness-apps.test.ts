import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentApps, HARNESS_APPS_FILE, harnessPreferences, saveHarnessPreference } from './harness-apps';
import { readDesktopDelivery, resolveDesktopDelivery, saveDesktopDelivery, type DesktopDelivery } from './desktop-delivery';
import { agentRoute, type AgentRouteContext, type AgentServices } from './local-agents';

const clean: string[] = [];
afterEach(() => { for (const dir of clean.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function home() { const dir = mkdtempSync(join(tmpdir(), 'mr-apps-')); clean.push(dir); return dir; }
const scans = [{ harness: 'codex' as const, label: 'Codex', detected: true, version: '0.163.0-alpha.10.2', sessionsAvailable: true }];

test('new Codex bindings default to desktop delivery; preferences persist without changing binding records', async () => {
  const dir = home();
  expect(harnessPreferences(dir).codex).toEqual({ enabled: true, codexDelivery: 'desktop' });
  const binding = join(dir, 'watch.json'); writeFileSync(binding, '{"harness":"codex","session":"legacy"}');
  saveHarnessPreference(dir, 'codex', { enabled: false, codexDelivery: 'headless' });
  expect(harnessPreferences(dir).codex).toEqual({ enabled: false, codexDelivery: 'headless' });
  expect(readFileSync(binding, 'utf8')).toBe('{"harness":"codex","session":"legacy"}');
  expect(harnessPreferences(dir).claude.enabled).toBe(true);
  expect((await agentApps(dir, scans)).apps.find(a => a.id === 'codex')).toMatchObject({ enabled: false, codexDelivery: 'headless', scan: scans[0] });
});

test('app settings reject executable paths, commands, unsupported delivery modes and unreadable saved settings', () => {
  const dir = home();
  expect(() => saveHarnessPreference(dir, 'codex', { enabled: true, codexDelivery: 'desktop', command: 'shell' })).toThrow('valid');
  expect(() => saveHarnessPreference(dir, 'claude', { enabled: true, codexDelivery: 'desktop' })).toThrow('valid');
  expect(() => saveHarnessPreference(dir, 'codex', { enabled: true, codexDelivery: 'automatic-fallback' })).toThrow('valid');
  writeFileSync(join(dir, HARNESS_APPS_FILE), 'broken');
  expect(() => harnessPreferences(dir)).toThrow('cannot be read');
});

test('the local management routes save typed preferences and reject unknown apps or arbitrary extra options', async () => {
  const dir = home(), ctx: AgentRouteContext = { home: dir, control: false, approvals: false, body: async () => ({ enabled: false, codexDelivery: 'desktop' }),
    services: { scanner: { scan: async () => scans } } as unknown as AgentServices };
  const url = (path: string) => new URL(`http://127.0.0.1:4310/api/local/${path}`);
  expect(await agentRoute(url('agent-apps/codex'), 'POST', ctx)).toMatchObject({ status: 200, value: { enabled: false } });
  expect((await agentRoute(url('harnesses'), 'GET', ctx))?.value).toMatchObject({ harnesses: [{ harness: 'codex', enabled: false }] });
  expect((await agentRoute(url('agent-apps'), 'GET', ctx))?.value).toMatchObject({ apps: expect.any(Array), deliveries: expect.any(Array) });
  await expect(agentRoute(url('agent-apps/unknown'), 'POST', ctx)).rejects.toMatchObject({ status: 404 });
  ctx.body = async () => ({ enabled: true, codexDelivery: 'desktop', program: '/bin/sh' });
  await expect(agentRoute(url('agent-apps/codex'), 'POST', ctx)).rejects.toMatchObject({ status: 400 });
});

test('uncertain deliveries require their exact id and an explicit operator decision; corrupt records are retained', () => {
  const dir = home(), delivery: DesktopDelivery = { version: 1, id: 'delivery', threadId: 'chat', roomId: 'room', generation: 'one', cwd: '/project', createdAt: 1,
    before: 'null', cursor: { boardAfter: 0, decisionsAfter: 0 }, output: '{}', state: 'uncertain' };
  saveDesktopDelivery(dir, delivery);
  expect(() => resolveDesktopDelivery(dir, 'another', 'retry')).toThrow('no longer');
  resolveDesktopDelivery(dir, 'delivery', 'received');
  expect(readDesktopDelivery(dir)).toMatchObject({ state: 'accepted', resolvedBy: 'operator' });
  saveDesktopDelivery(dir, delivery); resolveDesktopDelivery(dir, 'delivery', 'retry');
  expect(readDesktopDelivery(dir)?.state).toBe('pending');
  writeFileSync(join(dir, 'desktop-delivery.json'), '{');
  expect(() => readDesktopDelivery(dir)).toThrow('safely');
  expect(readFileSync(join(dir, 'desktop-delivery.json'), 'utf8')).toBe('{');
});
