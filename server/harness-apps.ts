/** Operator preferences for new bindings. Existing bindings always keep their recorded delivery mode. */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFile } from './browser-agent';
import { DesktopClient, DesktopError } from './codex-desktop';
import { knownAgentHomes, WATCH_STATE, type WatchState } from './agent-watch';
import { readBinding } from './agent-daemon';
import { readDesktopDelivery, resolveDesktopDelivery, type DesktopDelivery } from './desktop-delivery';
import { HARNESS_IDS, HARNESS_LABELS, plainText, type HarnessId, type HarnessScan } from './detectors/harnesses';

export type CodexDelivery = 'desktop' | 'headless';
export type HarnessPreference = { enabled: boolean; codexDelivery?: CodexDelivery };
export const HARNESS_APPS_FILE = 'harness-apps.json';
export function harnessPreferences(home: string): Record<HarnessId, HarnessPreference> {
  const defaults = Object.fromEntries(HARNESS_IDS.map(id => [id, { enabled: true, ...(id === 'codex' ? { codexDelivery: 'desktop' } : {}) }])) as Record<HarnessId, HarnessPreference>;
  const file = join(home, HARNESS_APPS_FILE);
  if (!existsSync(file)) return defaults;
  let saved: any; try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('Agent app settings cannot be read. Restore them before making new bindings.'); }
  if (saved?.version !== 1 || !saved.apps || typeof saved.apps !== 'object') throw new Error('Agent app settings are incompatible.');
  for (const id of HARNESS_IDS) if (saved.apps[id] !== undefined) {
    const value = saved.apps[id];
    if (!value || typeof value.enabled !== 'boolean' || (id === 'codex' && !['desktop', 'headless'].includes(value.codexDelivery))) throw new Error('Agent app settings are invalid.');
    defaults[id] = { enabled: value.enabled, ...(id === 'codex' ? { codexDelivery: value.codexDelivery } : {}) };
  }
  return defaults;
}
export function saveHarnessPreference(home: string, id: HarnessId, input: Record<string, unknown>) {
  if (!HARNESS_IDS.includes(id) || Object.keys(input).some(k => !['enabled', 'codexDelivery'].includes(k)) || typeof input.enabled !== 'boolean' ||
    (id === 'codex' ? !['desktop', 'headless'].includes(input.codexDelivery as string) : input.codexDelivery !== undefined)) throw new Error('Choose a valid agent app and delivery mode.');
  const apps = harnessPreferences(home);
  apps[id] = { enabled: input.enabled, ...(id === 'codex' ? { codexDelivery: input.codexDelivery as CodexDelivery } : {}) };
  mkdirSync(home, { recursive: true, mode: 0o700 });
  replaceFile(join(home, HARNESS_APPS_FILE), JSON.stringify({ version: 1, apps }));
  return apps[id];
}
export const HARNESS_DESCRIPTIONS: Record<HarnessId, { description: string; delivery: string; setup: string }> = {
  codex: { description: 'Keep working in your existing Codex desktop chat while room messages arrive.', delivery: 'Existing desktop chat', setup: 'Open Codex, then choose an existing chat when binding an agent in a room.' },
  claude: { description: 'Connect a Claude Code session to your rooms.', delivery: 'Bound session wake', setup: 'Install Claude Code and sign in, then choose a session in a room.' },
  hermes: { description: 'Connect a Hermes session through its room toolset.', delivery: 'Bound session wake', setup: 'Install Hermes and register the Meshrooms toolset for each room.' },
  exec: { description: 'Use another agent through an operator-configured command.', delivery: 'Custom command', setup: 'Create a custom-command agent in the Meshrooms app or from your terminal.' },
};
export async function desktopAvailability() {
  let client: DesktopClient | undefined;
  try { client = new DesktopClient(undefined, 2000); await client.initialize(); return { available: true, protocol: 1 }; }
  catch (error) { return { available: false, protocol: 1, reason: error instanceof DesktopError ? error.message : 'Desktop connection unavailable.' }; }
  finally { client?.close(); }
}
export async function agentApps(home: string, scans: HarnessScan[]) {
  const preferences = harnessPreferences(home), desktop = await desktopAvailability();
  return { apps: HARNESS_IDS.map(id => ({ ...HARNESS_DESCRIPTIONS[id], id, label: HARNESS_LABELS[id], ...preferences[id],
    scan: scans.find(s => s.harness === id), ...(id === 'codex' ? { desktop } : {}) })), deliveries: desktopDeliveries() };
}
export type AgentAppListing = Awaited<ReturnType<typeof agentApps>>;
/** Local paths never leave this module. A resolution must match a currently recorded desktop binding and delivery id. */
function desktopRecords() {
  return knownAgentHomes().flatMap(home => {
    const base = join(home, 'browser-agents');
    let rooms: string[]; try { rooms = readdirSync(base); } catch { return []; }
    return rooms.filter(id => /^[a-f0-9-]{36}$/.test(id)).flatMap(roomId => {
      const dir = join(base, roomId), binding = readBinding(dir);
      if (binding?.config.codexDelivery !== 'desktop') return [];
      let delivery: DesktopDelivery | undefined, broken = false, watch: Partial<WatchState> = {}, title: string | null = null, roomUrl: string | null = null;
      try { delivery = readDesktopDelivery(dir); } catch { broken = true; }
      try { watch = JSON.parse(readFileSync(join(dir, WATCH_STATE), 'utf8')); } catch { /* Not started. */ }
      try { title = plainText(JSON.parse(readFileSync(join(dir, 'members.json'), 'utf8')).title, 120); } catch { /* No roster yet. */ }
      try { const origin = new URL(JSON.parse(readFileSync(join(dir, 'room.json'), 'utf8')).origin); if (['http:', 'https:'].includes(origin.protocol) && !origin.username && !origin.password) roomUrl = `${origin.origin}/r/${roomId}`; } catch { /* No saved origin. */ }
      return [{ dir, roomId, title, roomUrl, delivery, broken, status: watch.desktop, threadId: binding.config.session ?? '', enabled: binding.enabled }];
    });
  });
}
export function desktopDeliveries() {
  return desktopRecords().map(({ roomId, title, roomUrl, delivery: d, enabled, status, threadId, broken }) => ({ roomId, title, roomUrl, id: d?.id ?? roomId, threadId: d?.threadId ?? threadId,
    state: broken ? 'blocked' as const : status?.state === 'blocked' ? 'blocked' as const : d?.state ?? 'waiting' as const,
    reason: broken ? 'The delivery record cannot be read safely. Pending work is retained.' : plainText(status?.reason, 300),
    createdAt: d?.createdAt ?? status?.at ?? null, acceptedAt: d?.acceptedAt ?? null, turnId: d?.turnId ?? null, enabled, resolvedBy: d?.resolvedBy ?? null }));
}
export function resolveAppDelivery(id: string, action: unknown) {
  if (!['received', 'retry'].includes(action as string)) throw new Error('Choose received or retry.');
  const found = desktopRecords().find(r => r.delivery?.id === id);
  if (!found) throw new Error('That delivery is no longer listed. Refresh Agent apps.');
  resolveDesktopDelivery(found.dir, id, action as 'received' | 'retry');
}
