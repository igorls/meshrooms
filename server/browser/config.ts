import { dataDirectory } from './store';
import { AGENTS_PER_OPERATOR } from './lobby';

type Env = Record<string, string | undefined>;
const urls = (value?: string) => value?.split(',').map(s => s.trim()).filter(Boolean);
function positive(env: Env, name: string, fallback: number, integer: boolean) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) throw new Error(`${name} must be a positive ${integer ? 'whole number' : 'number'}.`);
  return value;
}
/** Days without an admitted device before a room is removed (DEC-7). Fractions are allowed for tests. */
export const idleDays = (env: Env) => positive(env, 'MESHROOMS_ROOM_IDLE_DAYS', 30, false);

/** Shortest accepted `MESHROOMS_RELAY_SECRET` when the relay is enabled. */
export const RELAY_SECRET_MIN_LENGTH = 32;

/** The coordinator's settings from its environment; refuses combinations that are unsafe in production. */
export function browserConfig(env: Env = process.env) {
  const port = Number(env.MESHROOMS_BROWSER_PORT || 4320);
  const origin = env.MESHROOMS_BROWSER_ORIGIN || `http://127.0.0.1:${port}`;
  const url = new URL(origin);
  const https = url.protocol === 'https:';
  if (url.origin !== origin || (!https && !['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Use an HTTPS origin, or loopback for local development.');
  // Other addresses of the same service: the same rooms, reached through each (a former or a new domain). The main
  // origin is left out when listed too, since a deploy's candidate is started with whichever origin it checks.
  const aliases = [...new Set(urls(env.MESHROOMS_BROWSER_ALIASES) ?? [])].filter(alias => alias !== origin);
  for (const alias of aliases) {
    let parsed: URL | undefined;
    try { parsed = new URL(alias); } catch { parsed = undefined; }
    if (!parsed || parsed.origin !== alias || parsed.protocol !== url.protocol || (!https && !['127.0.0.1', 'localhost'].includes(parsed.hostname)))
      throw new Error('MESHROOMS_BROWSER_ALIASES must list other origins of this service, each like the main origin (https://host), separated by commas.');
  }
  const trustLoopbackProxy = env.MESHROOMS_TRUST_LOOPBACK_PROXY === '1';
  // Behind Nginx every request arrives from 127.0.0.1. Without the proxy's X-Real-IP, everyone shares one rate bucket.
  if (https && !trustLoopbackProxy) throw new Error('An HTTPS origin is served through the loopback reverse proxy. Set MESHROOMS_TRUST_LOOPBACK_PROXY=1 once Nginx overwrites X-Real-IP; otherwise every visitor would share one rate limit.');
  const invites = env.MESHROOMS_INVITES || (https ? 'required' : 'off');
  if (invites !== 'required' && invites !== 'off') throw new Error('MESHROOMS_INVITES must be "required" or "off".');
  const relayUrl = env.MESHROOMS_RELAY_URL?.trim() || `${origin.replace(/^http/, 'ws')}/api/relay/v1`;
  const parsedRelay = new URL(relayUrl);
  const wss = parsedRelay.protocol === 'wss:';
  if (!wss && !(parsedRelay.protocol === 'ws:' && ['127.0.0.1', 'localhost'].includes(parsedRelay.hostname))) {
    throw new Error('MESHROOMS_RELAY_URL must use wss://, or ws:// on loopback for local development.');
  }
  // The E2E relay ships dark: nothing is advertised, accepted or stored for it until an operator opts in.
  const relayFlag = env.MESHROOMS_RELAY_ENABLED?.trim();
  if (relayFlag !== undefined && relayFlag !== '' && relayFlag !== '0' && relayFlag !== '1') throw new Error('MESHROOMS_RELAY_ENABLED must be "1" or "0".');
  const relayEnabled = relayFlag === '1';
  if (relayEnabled && (!env.MESHROOMS_RELAY_SECRET || env.MESHROOMS_RELAY_SECRET.length < RELAY_SECRET_MIN_LENGTH)) {
    throw new Error(`MESHROOMS_RELAY_SECRET (at least ${RELAY_SECRET_MIN_LENGTH} characters) is required when MESHROOMS_RELAY_ENABLED=1; it encrypts stored wake registrations and must stay the same across restarts.`);
  }
  const wakeAllowlist = urls(env.MESHROOMS_WAKE_ALLOWLIST)?.map(entry => {
    const clean = entry.replace(/\.+$/, '').toLowerCase();
    if (!clean || clean === '*' || clean.includes('*') || clean.includes('/') || clean.includes(':')) {
      throw new Error('MESHROOMS_WAKE_ALLOWLIST entries must be hostnames (e.g. api.anthropic.com or .example.com) without wildcards or schemes.');
    }
    return clean;
  });
  return {
    port, origin, aliases, trustLoopbackProxy, dataDir: dataDirectory(env), invites: invites as 'required' | 'off',
    maxRooms: positive(env, 'MESHROOMS_MAX_ROOMS', 256, true), idleDays: idleDays(env),
    // Agents one person may operate in one room. The room's own device cap (16) still bounds the total.
    agentsPerOperator: positive(env, 'MESHROOMS_AGENTS_PER_OPERATOR', AGENTS_PER_OPERATOR, true),
    // Lobby requests a minute per address (IPv4, or IPv6 /64). Behind the proxy one address is often a whole network:
    // several people, and each person's agents, every one of them polling.
    apiLimit: positive(env, 'MESHROOMS_API_LIMIT', trustLoopbackProxy ? 3600 : 240, true),
    stunUrls: urls(env.MESHROOMS_STUN_URLS), turnUrls: urls(env.MESHROOMS_TURN_URLS), turnSecret: env.MESHROOMS_TURN_SECRET,
    relayEnabled, relayUrl,
    relaySecret: env.MESHROOMS_RELAY_SECRET,
    wakeAllowlist,
    revision: env.MESHROOMS_REVISION,
    // When set (production: 26), health reports whether the last verified admission backup is recent enough.
    backupMaxAgeHours: env.MESHROOMS_BACKUP_MAX_AGE_HOURS ? positive(env, 'MESHROOMS_BACKUP_MAX_AGE_HOURS', 26, false) : undefined,
  };
}
