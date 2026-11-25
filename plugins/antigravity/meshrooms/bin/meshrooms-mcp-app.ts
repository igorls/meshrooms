#!/usr/bin/env bun
/**
 * Meshrooms MCP App server for Google Antigravity.
 *
 * Read-only stdio JSON-RPC 2.0 MCP server (protocol 2024-11-05) serving:
 * - Tools: `meshrooms_overview`, `meshrooms_room_detail`, `meshrooms_app_state` (app-only),
 *   and `meshrooms_delivery_status`.
 * - Resource: `ui://meshrooms/rooms.html` (`text/html;profile=mcp-app`) for the interactive
 *   Meshrooms dashboard in Antigravity's side pane (`aux_pane`) and full-page (`global`) views.
 *
 * Security invariants:
 * - Strictly read-only: never modifies room state, never reads signing keys (`identity.json`) or
 *   connect tokens, and never returns local filesystem paths.
 * - All room text (titles, names, tasks, decisions) is sanitized and length-capped plain text.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RESOURCE_URI = 'ui://meshrooms/rooms.html';
export const RESOURCE_MIME = 'text/html;profile=mcp-app';

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const BLANK_OR_CTRL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\p{Default_Ignorable_Code_Point}\u2800]/gu;

export function cleanText(value: unknown, limit = 140): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(BLANK_OR_CTRL, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  const chars = Array.from(cleaned);
  return chars.length <= limit ? cleaned : `${chars.slice(0, limit - 1).join('').trimEnd()}…`;
}

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return fallback; }
}

export type ScanOptions = {
  home?: string;
  env?: Record<string, string | undefined>;
  now?: number;
};

/** Discovers local Meshrooms agent/person root folders without ever exposing their paths. */
function discoverRoots(options: ScanOptions = {}): { label: string; dir: string }[] {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const seen = new Set<string>();
  const roots: { label: string; dir: string }[] = [];
  const add = (label: string, dir: string | undefined) => {
    if (!dir) return;
    const full = resolve(dir);
    if (seen.has(full) || !existsSync(join(full, 'browser-agents'))) return;
    seen.add(full);
    roots.push({ label, dir: full });
  };
  if (env.MESHROOMS_AGENT_HOME) add('agent', env.MESHROOMS_AGENT_HOME);
  const registryPath = env.MESHROOMS_AGENT_REGISTRY ? resolve(env.MESHROOMS_AGENT_REGISTRY) : join(home, '.meshrooms', 'agent-homes.json');
  const registered = readJson<unknown>(registryPath, []);
  if (Array.isArray(registered)) {
    for (const item of registered) if (typeof item === 'string') add('agent', item);
  }
  add('default', join(home, '.meshrooms', 'agents'));
  add('person', env.MESHROOMS_PERSON_HOME ? resolve(env.MESHROOMS_PERSON_HOME) : join(home, '.meshrooms', 'person'));
  return roots;
}

export type RoomOverview = {
  roomId: string;
  title: string;
  agentName: string | null;
  role: 'person' | 'agent';
  runnerAlive: boolean;
  harness: string | null;
  wakesEnabled: boolean;
  memberCount: number;
  openTasks: number;
  openDecisions: number;
  lastActivityAt: string | null;
};

export type RoomDetail = RoomOverview & {
  members: { id: string; name: string; role: string; harness: string | null; model: string | null }[];
  tasks: { id: string; title: string; status: string; assignee: string | null; notes: string | null }[];
  decisions: { id: string; question: string; state: string; options: { id: string; label: string; votes: number }[] }[];
};

function readRoomSummary(roomDir: string, roomId: string, rootLabel: string, now: number): RoomDetail | undefined {
  const membersDoc = readJson<{
    memberId?: string;
    title?: string;
    members?: { id?: string; name?: string; role?: string; harness?: string; model?: string }[];
  }>(join(roomDir, 'members.json'), {});

  const rawMembers = Array.isArray(membersDoc.members) ? membersDoc.members : [];
  const memberById = new Map<string, string>();
  const members = rawMembers.slice(0, 64).flatMap(m => {
    if (typeof m?.id !== 'string') return [];
    const name = cleanText(m.name, 64) ?? 'Member';
    memberById.set(m.id, name);
    return [{
      id: m.id,
      name,
      role: m.role === 'agent' ? 'agent' : 'human',
      harness: cleanText(m.harness, 40),
      model: cleanText(m.model, 60),
    }];
  });

  const me = typeof membersDoc.memberId === 'string' ? members.find(m => m.id === membersDoc.memberId) : undefined;
  const proof = readJson<{ at?: number }>(join(roomDir, 'runner-alive.json'), {});
  const runnerAlive = typeof proof.at === 'number' && now - proof.at < 20_000;
  const watch = readJson<{ harness?: string; enabled?: boolean }>(join(roomDir, 'watch.json'), {});
  const activity = readJson<{ at?: number }>(join(roomDir, 'live', 'activity.json'), {});

  const rawTasks = readJson<unknown>(join(roomDir, 'tasks.json'), []);
  const taskList = Array.isArray(rawTasks) ? rawTasks : Array.isArray((rawTasks as { tasks?: unknown[] })?.tasks) ? (rawTasks as { tasks: unknown[] }).tasks : [];
  const tasks = taskList.slice(0, 80).flatMap(t => {
    const item = t as { id?: string; title?: string; status?: string; assigneeId?: string | null; notes?: string; removed?: boolean };
    if (typeof item?.id !== 'string' || item.removed) return [];
    return [{
      id: item.id,
      title: cleanText(item.title, 120) ?? 'Untitled task',
      status: item.status === 'doing' || item.status === 'done' ? item.status : 'todo',
      assignee: item.assigneeId ? memberById.get(item.assigneeId) ?? null : null,
      notes: cleanText(item.notes, 200),
    }];
  });

  const rawDecisions = readJson<unknown>(join(roomDir, 'decisions.json'), []);
  const decisionList = Array.isArray(rawDecisions) ? rawDecisions : Array.isArray((rawDecisions as { decisions?: unknown[] })?.decisions) ? (rawDecisions as { decisions: unknown[] }).decisions : [];
  const decisions = decisionList.slice(0, 40).flatMap(d => {
    const item = d as {
      id?: string;
      question?: string;
      state?: string;
      options?: { id?: string; label?: string }[];
      votes?: Record<string, { optionId?: string | null }>;
    };
    if (typeof item?.id !== 'string') return [];
    const voteCounts = new Map<string, number>();
    if (item.votes && typeof item.votes === 'object') {
      for (const vote of Object.values(item.votes)) {
        if (typeof vote?.optionId === 'string') voteCounts.set(vote.optionId, (voteCounts.get(vote.optionId) ?? 0) + 1);
      }
    }
    const options = Array.isArray(item.options)
      ? item.options.slice(0, 12).flatMap(o => typeof o?.id === 'string'
        ? [{ id: o.id, label: cleanText(o.label, 80) ?? 'Option', votes: voteCounts.get(o.id) ?? 0 }]
        : [])
      : [];
    return [{
      id: item.id,
      question: cleanText(item.question, 160) ?? 'Untitled decision',
      state: item.state === 'closed' || item.state === 'withdrawn' ? item.state : 'open',
      options,
    }];
  });

  return {
    roomId,
    title: cleanText(membersDoc.title, 100) ?? `Room ${roomId.slice(0, 8)}`,
    agentName: me?.name ?? null,
    role: rootLabel === 'person' ? 'person' : 'agent',
    runnerAlive,
    harness: cleanText(watch.harness, 32),
    wakesEnabled: watch.enabled === true,
    memberCount: members.length,
    openTasks: tasks.filter(t => t.status !== 'done').length,
    openDecisions: decisions.filter(d => d.state === 'open').length,
    lastActivityAt: typeof activity.at === 'number' ? new Date(activity.at).toISOString() : typeof proof.at === 'number' ? new Date(proof.at).toISOString() : null,
    members,
    tasks,
    decisions,
  };
}

export function readDeliveryStatus(options: ScanOptions = {}) {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const dataDir = env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || env.PLUGIN_DATA;
  const candidates = [
    env.MESHROOMS_AGY_DELIVERY_STATUS,
    dataDir ? join(dataDir, 'delivery-status.json') : undefined,
    join(home, '.meshrooms', 'antigravity-delivery-status.json'),
  ].filter((p): p is string => !!p);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const raw = readJson<{ updatedAt?: string; bindings?: unknown[] }>(path, {});
    const bindings = Array.isArray(raw.bindings) ? raw.bindings.slice(0, 32).flatMap(b => {
      const item = b as { roomId?: unknown; conversationId?: unknown; state?: unknown; lastDeliveredAt?: unknown; lastError?: unknown; enabled?: unknown };
      if (typeof item?.roomId !== 'string' || !UUID_RE.test(item.roomId)) return [];
      return [{
        roomId: item.roomId,
        conversationId: typeof item.conversationId === 'string' && UUID_RE.test(item.conversationId) ? item.conversationId : null,
        enabled: item.enabled !== false,
        state: cleanText(item.state, 40) ?? 'idle',
        lastDeliveredAt: typeof item.lastDeliveredAt === 'string' ? item.lastDeliveredAt : null,
        lastError: cleanText(item.lastError, 160),
      }];
    }) : [];
    return { sidecarActive: true, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null, bindings };
  }
  return { sidecarActive: false, updatedAt: null, bindings: [] };
}

export function readOverviewState(roomIdFilter?: string, options: ScanOptions = {}) {
  const now = options.now ?? Date.now();
  const byRoom = new Map<string, RoomDetail>();
  for (const root of discoverRoots(options)) {
    const base = join(root.dir, 'browser-agents');
    let ids: string[];
    try { ids = readdirSync(base).filter(id => UUID_RE.test(id)); } catch { continue; }
    for (const id of ids) {
      if (byRoom.has(id) && byRoom.get(id)!.runnerAlive) continue;
      const summary = readRoomSummary(join(base, id), id, root.label, now);
      if (summary) byRoom.set(id, summary);
    }
  }
  const all = [...byRoom.values()].sort((a, b) => Number(b.runnerAlive) - Number(a.runnerAlive) || a.title.localeCompare(b.title));
  const selectedId = roomIdFilter && UUID_RE.test(roomIdFilter) && byRoom.has(roomIdFilter) ? roomIdFilter : all[0]?.roomId ?? null;
  const selected = selectedId ? byRoom.get(selectedId) ?? null : null;
  const rooms: RoomOverview[] = all.map(({ members: _m, tasks: _t, decisions: _d, ...overview }) => overview);
  return {
    generatedAt: new Date(now).toISOString(),
    rooms,
    selectedRoomId: selectedId,
    selected,
    delivery: readDeliveryStatus(options),
  };
}

export function readUiHtml(pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')): string {
  return readFileSync(join(pluginRoot, 'ui', 'rooms.html'), 'utf8');
}

export const MCP_APP_TOOLS = [
  {
    name: 'meshrooms_overview',
    description: 'Open the interactive Meshrooms dashboard showing connected rooms, task boards, open decisions, and Antigravity delivery status (read-only).',
    inputSchema: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'Optional Meshrooms room UUID to focus initially.' },
      },
      additionalProperties: false,
    },
    _meta: {
      ui: { resourceUri: RESOURCE_URI },
      'com.google.antigravity/ui': {
        entrypoints: [
          { type: 'aux_pane', title: 'Meshrooms' },
          { type: 'global', title: 'Meshrooms' },
        ],
      },
    },
  },
  {
    name: 'meshrooms_room_detail',
    description: 'Read participants, tasks, and open decisions for one connected Meshrooms room (read-only).',
    inputSchema: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'Meshrooms room UUID.' },
      },
      required: ['roomId'],
      additionalProperties: false,
    },
    _meta: {
      ui: { resourceUri: RESOURCE_URI },
    },
  },
  {
    name: 'meshrooms_app_state',
    description: 'App-only refresh endpoint for the Meshrooms interactive dashboard.',
    inputSchema: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'Optional room UUID to focus.' },
      },
      additionalProperties: false,
    },
    _meta: {
      ui: { visibility: ['app'] },
    },
  },
  {
    name: 'meshrooms_delivery_status',
    description: 'Read Antigravity live delivery sidecar status and room bindings (read-only, no local paths).',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

export function handleMcpRequest(req: JsonRpcRequest, options: ScanOptions & { pluginRoot?: string } = {}): Record<string, unknown> | undefined {
  if (!req || typeof req !== 'object' || typeof req.method !== 'string') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const hasId = req.id !== undefined;
  const ok = (result: unknown) => (hasId ? { jsonrpc: '2.0', id: req.id, result } : undefined);
  const err = (code: number, message: string) => (hasId ? { jsonrpc: '2.0', id: req.id, error: { code, message } } : undefined);

  if (req.method === 'notifications/initialized' || req.method === 'notifications/cancelled') return undefined;
  if (req.method === 'ping') return ok({});
  if (req.method === 'initialize') {
    return ok({
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
      },
      serverInfo: { name: 'meshrooms-mcp-app', version: '0.2.0' },
    });
  }
  if (req.method === 'tools/list') return ok({ tools: MCP_APP_TOOLS });
  if (req.method === 'resources/list') {
    return ok({
      resources: [
        {
          uri: RESOURCE_URI,
          name: 'Meshrooms Dashboard',
          description: 'Interactive Meshrooms room overview, tasks, decisions, and delivery status.',
          mimeType: RESOURCE_MIME,
        },
      ],
    });
  }
  if (req.method === 'resources/read') {
    const uri = typeof req.params?.uri === 'string' ? req.params.uri : '';
    if (uri !== RESOURCE_URI) return err(-32002, `Unknown resource URI: ${uri}`);
    return ok({
      contents: [
        {
          uri: RESOURCE_URI,
          mimeType: RESOURCE_MIME,
          text: readUiHtml(options.pluginRoot),
          _meta: {
            ui: {
              prefersBorder: false,
              csp: { connectDomains: [], resourceDomains: [] },
            },
          },
        },
      ],
    });
  }
  if (req.method === 'tools/call') {
    const name = typeof req.params?.name === 'string' ? req.params.name : '';
    const args = (req.params?.arguments && typeof req.params.arguments === 'object' ? req.params.arguments : {}) as Record<string, unknown>;
    if (name === 'meshrooms_overview' || name === 'meshrooms_app_state') {
      const roomId = typeof args.roomId === 'string' ? args.roomId : undefined;
      const state = readOverviewState(roomId, options);
      const summary = state.rooms.length
        ? `Connected to ${state.rooms.length} Meshrooms room${state.rooms.length === 1 ? '' : 's'}: ${state.rooms.map(r => `${r.title} (${r.openTasks} open tasks, ${r.openDecisions} open decisions)`).join('; ')}.`
        : 'No connected Meshrooms rooms found on this machine yet. Connect with a Meshrooms invite link to get started.';
      return ok({
        content: [{ type: 'text', text: summary }],
        structuredContent: state,
      });
    }
    if (name === 'meshrooms_room_detail') {
      const roomId = typeof args.roomId === 'string' ? args.roomId : '';
      if (!UUID_RE.test(roomId)) return ok({ isError: true, content: [{ type: 'text', text: 'Provide a valid Meshrooms room UUID in roomId.' }] });
      const state = readOverviewState(roomId, options);
      if (!state.selected || state.selected.roomId.toLowerCase() !== roomId.toLowerCase()) {
        return ok({ isError: true, content: [{ type: 'text', text: `Room ${roomId} was not found among local Meshrooms rooms.` }] });
      }
      return ok({
        content: [{ type: 'text', text: `${state.selected.title}: ${state.selected.members.length} participants, ${state.selected.openTasks} open tasks, ${state.selected.openDecisions} open decisions.` }],
        structuredContent: state,
      });
    }
    if (name === 'meshrooms_delivery_status') {
      const delivery = readDeliveryStatus(options);
      return ok({
        content: [{ type: 'text', text: delivery.sidecarActive ? `Delivery sidecar active with ${delivery.bindings.length} binding(s).` : 'Delivery sidecar has not written a status snapshot yet.' }],
        structuredContent: delivery,
      });
    }
    return err(-32601, `Unknown tool: ${name}`);
  }
  return err(-32601, `Method not found: ${req.method}`);
}

/** Runs the stdio line-delimited JSON-RPC loop when executed directly. */
async function serveStdio() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl < 0) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let response: Record<string, unknown> | undefined;
      try {
        response = handleMcpRequest(JSON.parse(line));
      } catch {
        response = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
      }
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
  await new Promise<void>(resolveDone => {
    process.stdin.on('end', () => resolveDone());
    process.stdin.on('close', () => resolveDone());
  });
}

if (import.meta.main) {
  await serveStdio();
}
