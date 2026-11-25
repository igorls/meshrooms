import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  MCP_APP_TOOLS, RESOURCE_MIME, RESOURCE_URI, handleMcpRequest,
} from '../plugins/antigravity/meshrooms/bin/meshrooms-mcp-app';
import {
  buildWakeCue, hasActiveLiveLease, readBindingsFile, runDeliveryTick, type BindingRuntimeState, type CommandExec,
} from '../plugins/antigravity/meshrooms/sidecars/meshrooms-delivery/worker';
import { testDirectory } from './test-directory';

const PLUGIN_ROOT = resolve(import.meta.dir, '..', 'plugins', 'antigravity', 'meshrooms');
const ROOM_ID = '0f5c3a52-9c1e-4d7b-8a61-2b3c4d5e6f70';
const CONV_ID = '5ec101c5-9db2-4dba-8aea-24ff3ff798e0';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const folder = () => { const dir = testDirectory('agy-plugin'); cleanups.push(dir.cleanup); return dir.path; };

test('Antigravity plugin manifest, skill, MCP config, UI HTML, and sidecar manifest are well-formed', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'plugin.json'), 'utf8'));
  expect(manifest.name).toBe('meshrooms');
  expect(manifest.displayName).toBe('Meshrooms');
  expect(manifest.logo).toBe('assets/logo.svg');
  // No unsupported extra keys in plugin.json (skills/mcp/sidecars use convention-based discovery).
  const allowedKeys = new Set([
    'name', 'version', 'displayName', 'description', 'author', 'keywords', 'license',
    'homepage', 'repository', 'logo', 'suggestedPrompts', 'skills', 'agents', 'rules', 'hooks',
    'mcpServers', 'sidecars', 'oauthProviders', 'scripts',
  ]);
  for (const key of Object.keys(manifest)) expect(allowedKeys.has(key)).toBe(true);

  for (const rel of [
    'README.md',
    'assets/logo.svg',
    'skills/meshrooms/SKILL.md',
    'mcp_config.json',
    'bin/meshrooms-mcp-app.ts',
    'ui/rooms.html',
    'sidecars/meshrooms-delivery/sidecar.json',
    'sidecars/meshrooms-delivery/worker.ts',
  ]) {
    expect(existsSync(join(PLUGIN_ROOT, rel)), `missing ${rel}`).toBe(true);
  }

  const mcpConfig = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'mcp_config.json'), 'utf8'));
  expect(mcpConfig.mcpServers.meshrooms.command).toBe('bun');
  expect(mcpConfig.mcpServers.meshrooms.args.join(' ')).toContain('${PLUGIN_ROOT}/bin/meshrooms-mcp-app.ts');

  const sidecar = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'sidecars', 'meshrooms-delivery', 'sidecar.json'), 'utf8'));
  expect(sidecar.command).toBe('bun');
  expect(sidecar.args).toContain('worker.ts');
  expect(sidecar.restart_policy).toBe('on-failure');
});

test('MCP App server implements MCP 2024-11-05 + SEP-1865 UI resources and never leaks local paths or keys', () => {
  const home = folder();
  const agentHome = join(home, '.meshrooms', 'agents');
  const roomDir = join(agentHome, 'browser-agents', ROOM_ID);
  mkdirSync(join(roomDir, 'live'), { recursive: true });
  // Plant a fake secret identity.json and confirm it never leaks.
  writeFileSync(join(roomDir, 'identity.json'), JSON.stringify({ id: 'dev-1', privateKey: 'SUPER_SECRET_PRIVATE_KEY_999' }));
  writeFileSync(join(roomDir, 'members.json'), JSON.stringify({
    memberId: 'm-1',
    title: 'Design \u202ereview',
    members: [
      { id: 'm-1', name: 'Nova', role: 'agent', harness: 'Antigravity', model: 'gemini-3.8-pro' },
      { id: 'm-2', name: 'Alex', role: 'human' },
    ],
  }));
  writeFileSync(join(roomDir, 'tasks.json'), JSON.stringify([
    { id: 't-1', title: 'Verify Linux tray', status: 'doing', assigneeId: 'm-1', notes: 'Check AppIndicator' },
    { id: 't-2', title: 'Old removed task', status: 'todo', removed: true },
  ]));
  writeFileSync(join(roomDir, 'decisions.json'), JSON.stringify([
    { id: 'd-1', question: 'Ship beta.11?', state: 'open', options: [{ id: 'o-1', label: 'Yes' }], votes: { 'm-2': { optionId: 'o-1' } } },
  ]));
  const now = Date.now();
  writeFileSync(join(roomDir, 'runner-alive.json'), JSON.stringify({ at: now - 2_000 }));
  writeFileSync(join(roomDir, 'watch.json'), JSON.stringify({ harness: 'agy', enabled: true }));

  const opts = { home, env: { MESHROOMS_AGENT_HOME: agentHome, MESHROOMS_AGENT_REGISTRY: join(home, 'reg.json') }, now, pluginRoot: PLUGIN_ROOT };

  const init = handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, opts) as any;
  expect(init.result.capabilities.resources).toBeDefined();
  expect(init.result.capabilities.tools).toBeDefined();

  const tools = handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, opts) as any;
  expect(tools.result.tools).toEqual(MCP_APP_TOOLS);
  const overviewTool = tools.result.tools.find((t: any) => t.name === 'meshrooms_overview');
  expect(overviewTool._meta.ui.resourceUri).toBe(RESOURCE_URI);
  expect(overviewTool._meta['com.google.antigravity/ui'].entrypoints).toHaveLength(2);

  const resList = handleMcpRequest({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, opts) as any;
  expect(resList.result.resources[0]).toMatchObject({ uri: RESOURCE_URI, mimeType: RESOURCE_MIME });

  const resRead = handleMcpRequest({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: RESOURCE_URI } }, opts) as any;
  expect(resRead.result.contents[0].mimeType).toBe(RESOURCE_MIME);
  expect(resRead.result.contents[0].text).toContain('ui/initialize');
  expect(resRead.result.contents[0].text).not.toContain('innerHTML');

  const call = handleMcpRequest({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'meshrooms_overview', arguments: {} } }, opts) as any;
  const serialized = JSON.stringify(call);
  expect(serialized).not.toContain('SUPER_SECRET_PRIVATE_KEY_999');
  expect(serialized).not.toContain(home);
  expect(call.result.structuredContent.rooms).toHaveLength(1);
  expect(call.result.structuredContent.rooms[0]).toMatchObject({
    roomId: ROOM_ID,
    title: 'Design review',
    runnerAlive: true,
    harness: 'agy',
    wakesEnabled: true,
    openTasks: 1,
    openDecisions: 1,
  });
  expect(call.result.structuredContent.selected.tasks).toHaveLength(1);
  expect(call.result.structuredContent.selected.tasks[0]).toMatchObject({ title: 'Verify Linux tray', assignee: 'Nova' });
});

test('Delivery sidecar sends fixed wake cues only, coalesces pending work, and defers to live leases', async () => {
  const dir = folder();
  const agentHome = join(dir, 'agents');
  const roomDir = join(agentHome, 'browser-agents', ROOM_ID);
  mkdirSync(roomDir, { recursive: true });
  const bindingsFile = join(dir, 'bindings.json');
  writeFileSync(bindingsFile, JSON.stringify({
    version: 1,
    bindings: [
      { roomId: ROOM_ID, conversationId: CONV_ID, agentHome, enabled: true, minIntervalSeconds: 30 },
      { roomId: 'bad-id', conversationId: CONV_ID, enabled: true },
    ],
  }));

  const bindings = readBindingsFile(bindingsFile);
  expect(bindings).toHaveLength(1);
  expect(bindings[0]).toMatchObject({ roomId: ROOM_ID, conversationId: CONV_ID, enabled: true, minIntervalSeconds: 30 });

  const launcher = '/home/op/.meshrooms/bin/meshrooms.js';
  const cue = buildWakeCue(ROOM_ID, launcher);
  expect(cue).toContain(ROOM_ID);
  expect(cue).toContain(`bun "${launcher}" listen --room ${ROOM_ID} --wait-seconds 5`);

  const calls: { file: string; args: readonly string[] }[] = [];
  let peekPayload: Record<string, unknown> = {
    work: true,
    items: [{ id: 'msg-1', kind: 'message' }],
    // Even if peek output somehow carried text, it must NEVER appear in agentapi args.
    secretPreview: 'UNTRUSTED_ROOM_TEXT_DO_NOT_PASS',
  };
  const exec: CommandExec = async (file, args) => {
    calls.push({ file, args });
    if (file === 'agentapi') return { ok: true, stdout: 'sent\n', stderr: '', code: 0 };
    return { ok: true, stdout: JSON.stringify(peekPayload), stderr: '', code: 0 };
  };

  let now = 1_000_000;
  const state = new Map<string, BindingRuntimeState>();
  const deps = { exec, launcher, bun: 'bun', defaultAgentHome: agentHome, env: {}, now: () => now };

  // 1. First tick sees pending work and delivers fixed wake cue via agentapi.
  await runDeliveryTick(bindings, state, deps);
  const agentCalls = () => calls.filter(c => c.file === 'agentapi');
  expect(agentCalls()).toHaveLength(1);
  expect(agentCalls()[0].args[0]).toBe('send-message');
  expect(agentCalls()[0].args[1]).toBe(CONV_ID);
  expect(agentCalls()[0].args[2]).toContain(ROOM_ID);
  expect(agentCalls()[0].args[2]).not.toContain('UNTRUSTED_ROOM_TEXT_DO_NOT_PASS');

  // 2. Next tick (40s later) with the SAME pending item coalesces (no duplicate delivery).
  now += 40_000;
  await runDeliveryTick(bindings, state, deps);
  expect(agentCalls()).toHaveLength(1);

  // 3. New item arrives (still past minIntervalSeconds): delivers once more.
  now += 40_000;
  peekPayload = { work: true, items: [{ id: 'msg-1', kind: 'message' }, { id: 'msg-2', kind: 'message' }] };
  await runDeliveryTick(bindings, state, deps);
  expect(agentCalls()).toHaveLength(2);

  // 4. Active live lease defers completely (doesn't even call peek or agentapi).
  now += 60_000;
  writeFileSync(join(roomDir, 'live.json'), JSON.stringify({ state: 'attached', pid: 999, heartbeat: now - 1_000 }));
  expect(hasActiveLiveLease(agentHome, ROOM_ID, now)).toBe(true);
  const countBeforeLive = calls.length;
  await runDeliveryTick(bindings, state, deps);
  expect(calls.length).toBe(countBeforeLive);
  expect(state.get(`${ROOM_ID}:${CONV_ID}`)?.state).toBe('deferred-live');
});
