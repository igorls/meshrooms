import { Database } from 'bun:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';

/** Hourly wake caps per Section 6.1 and adversarial review (#139). */
export const WAKE_ROOM_HOURLY_CAP = 20;
export const WAKE_AGENT_HOURLY_CAP = 30;
export const WAKE_SENDER_HOURLY_CAP = 10;
export const WAKE_RETRY_DELAY_MS = 5_000;
export const WAKE_MAX_RETRY_AFTER_MS = 60_000;
export const WAKE_MAX_RETRIES = 2;
export const WAKE_COALESCE_WINDOW_MS = 60_000;
export const WAKE_TIMEOUT_MS = 10_000;
/** Claude Code routine trigger API headers (https://platform.claude.com/docs/en/api/claude-code/routines-fire). */
export const CLAUDE_CODE_ANTHROPIC_VERSION = '2026-10-21';
export const CLAUDE_CODE_ANTHROPIC_BETA = 'experimental-cc-routine-2026-04-01';
const HOUR_MS = 3_600_000;
const MAX_URL_LENGTH = 2048;
const MAX_KEY_LENGTH = 512;

export type WakeProvider = 'generic' | 'claude-code';

export type WakePayload = {
  source: 'meshrooms';
  event: 'room-has-work';
  inbox: string;
  /** The room the work is in, so a webhook receiver with several rooms knows which one to listen to. */
  room: string;
  /** How many frames addressed to this device wait (a mention, a reply, an assignment, a decision asking it). */
  count: number;
};

export type ClaudeCodeWakePayload = {
  text: string;
};

export type WakeResult = 'dispatched' | 'coalesced' | 'capped' | 'unregistered' | 'failed';

export class WakeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WakeValidationError';
  }
}

export type WakeFetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type PinnedTransportRequest = {
  url: URL;
  ip: string;
  family: 4 | 6;
  hostname: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
};

export type PinnedTransportResponse = {
  status: number;
  headers: Headers;
};

export type WakeTransportFn = (request: PinnedTransportRequest) => Promise<PinnedTransportResponse>;

export type WakeConnectorOptions = {
  /** SQLite path for encrypted-at-rest wake registrations (default `:memory:`). Completely separate from admission/OAuth. */
  dbPath?: string;
  /** Server secret used to derive the AES-256-GCM key for encrypting wake URLs and keys at rest (required whenever registrations are stored on disk; an in-memory database may run without one). */
  secret?: string;
  now?: () => number;
  /** Optional low-level pinned transport override (receives the pre-validated IP & family). Defaults to pinned `node:http`/`node:https`. */
  transport?: WakeTransportFn;
  /** Optional fetch override for unit tests; ignored when `transport` is provided. */
  fetch?: WakeFetchFn;
  sleep?: (ms: number) => Promise<void>;
  /** Custom DNS resolver for tests; defaults to `dns.promises.lookup(..., { all: true })`. */
  lookup?: (hostname: string) => Promise<string[]>;
  /** Explicit test mode allowing `http://127.0.0.1`, `http://localhost`, and `http://[::1]` webhooks. Always false in production. */
  allowLoopbackHttp?: boolean;
  /** Alias for `allowLoopbackHttp` for explicit test clarity. */
  allowLoopbackForTest?: boolean;
  /** Allowlist of approved webhook hostnames (exact host or `.domain` suffix). Empty/unset fails closed for all non-loopback destinations. */
  hostAllowlist?: string[];
  roomCapPerHour?: number;
  agentCapPerHour?: number;
  senderCapPerHour?: number;
  retryDelayMs?: number;
  maxRetryAfterMs?: number;
  maxRetries?: number;
  coalesceWindowMs?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
};

function parseIpv4Octets(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map(p => (/^\d+$/.test(p) ? Number(p) : -1));
  if (nums.some(n => n < 0 || n > 255)) return null;
  return nums;
}

function isBlockedIpv4(ip: string): boolean {
  const o = parseIpv4Octets(ip);
  if (!o) return true;
  const [a, b, c] = o;
  if (a === 0) return true; // RFC 1122 "this network" (0/8)
  if (a === 10) return true; // RFC 1918 private (10/8)
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC 6598 CGNAT (100.64/10)
  if (a === 127) return true; // loopback (127/8)
  if (a === 169 && b === 254) return true; // link-local / cloud metadata (169.254/16)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918 private (172.16/12)
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments (192.0.0/24)
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 168) return true; // RFC 1918 private (192.168/16)
  if (a === 198 && (b === 18 || b === 19)) return true; // RFC 2544 benchmark (198.18/15)
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast & reserved (>= 224/4)
  return false;
}

function expandIpv6(ip: string): number[] | null {
  const clean = ip.split('%')[0].toLowerCase();
  const mappedV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(clean);
  if (mappedV4) {
    const o = parseIpv4Octets(mappedV4[1]);
    if (!o) return null;
    return [0, 0, 0, 0, 0, 0xffff, (o[0] << 8) | o[1], (o[2] << 8) | o[3]];
  }
  const halves = clean.split('::');
  if (halves.length > 2) return null;
  const parsePart = (part: string): number[] | null => {
    if (!part) return [];
    const tokens = part.split(':');
    const out: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.includes('.')) {
        if (i !== tokens.length - 1) return null;
        const o = parseIpv4Octets(tok);
        if (!o) return null;
        out.push((o[0] << 8) | o[1], (o[2] << 8) | o[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(tok)) return null;
        out.push(parseInt(tok, 16));
      }
    }
    return out;
  };
  const left = parsePart(halves[0]);
  const right = halves.length === 2 ? parsePart(halves[1]) : [];
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array(missing).fill(0), ...right];
}

/** Returns true when `ip` is loopback, private, link-local, metadata, multicast, or otherwise non-public. */
export function isBlockedIp(raw: string): boolean {
  const ip = raw.replace(/^\[|\]$/g, '').split('%')[0];
  const version = isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) {
    const g = expandIpv6(ip);
    if (!g) return true;
    const allZero = g.every(n => n === 0);
    if (allZero) return true; // ::
    if (g.slice(0, 7).every(n => n === 0) && g[7] === 1) return true; // ::1 loopback
    // IPv4-mapped ::ffff:0:0/96 or IPv4-compatible ::/96
    if (g.slice(0, 5).every(n => n === 0) && (g[5] === 0xffff || g[5] === 0)) {
      const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
      return isBlockedIpv4(v4);
    }
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
    if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 documentation
    if (g[0] === 0x2002) {
      // 2002::/16 6to4 embeds IPv4 in g[1]..g[2]; block if embedded IPv4 is non-public.
      const v4 = `${g[1] >> 8}.${g[1] & 0xff}.${g[2] >> 8}.${g[2] & 0xff}`;
      if (isBlockedIpv4(v4)) return true;
    }
    if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
      // 64:ff9b::/96 NAT64 well-known prefix
      const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
      return isBlockedIpv4(v4);
    }
    return false;
  }
  return true;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
}

function isLoopbackHost(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

function matchesAllowlist(hostname: string, allowlist: string[]): boolean {
  const h = normalizeHostname(hostname);
  return allowlist.some(entry => {
    const clean = normalizeHostname(entry.trim());
    if (!clean || clean === '*' || clean.includes('*')) return false;
    if (clean.startsWith('.')) return h.endsWith(clean) && h.length > clean.length;
    return h === clean;
  });
}

/** Detects or validates the wake provider (`'generic'` vs `'claude-code'`). */
export function resolveWakeProvider(parsedUrl: URL, explicit?: unknown): WakeProvider {
  if (explicit !== undefined) {
    if (explicit === 'generic' || explicit === 'claude-code') return explicit;
    throw new WakeValidationError('Unsupported wake provider. Use "generic" or "claude-code".');
  }
  const hostname = normalizeHostname(parsedUrl.hostname);
  if (hostname === 'api.anthropic.com' && /^\/v1\/claude_code\/routines\/[^/]+\/fire\/?$/.test(parsedUrl.pathname)) {
    return 'claude-code';
  }
  return 'generic';
}

/**
 * Parses an HTTP `Retry-After` header (RFC 9110 delta-seconds or HTTP-date), clamped to `[0, maxMs]`.
 * Returns `undefined` when missing or unparseable.
 */
export function parseRetryAfterMs(
  headerValue: string | null | undefined,
  nowMs: number,
  maxMs = WAKE_MAX_RETRY_AFTER_MS,
): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.min(seconds * 1000, maxMs);
  }
  const parsedDate = Date.parse(trimmed);
  if (Number.isNaN(parsedDate)) return undefined;
  return Math.min(Math.max(0, parsedDate - nowMs), maxMs);
}

/**
 * Builds the strictly content-free HTTP headers and JSON body for a wake dispatch. It names the room (the receiver is the
 * device's own operator, who already holds the room id) and counts addressed frames; it never includes `deviceId`,
 * member text, or ciphertext.
 */
export function buildWakeRequest(
  provider: WakeProvider,
  inboxId: string,
  count: number,
  bearerKey: string,
  roomId: string,
): { headers: Record<string, string>; body: string } {
  const safeCount = Math.max(1, Math.floor(count));
  if (provider === 'claude-code') {
    const payload: ClaudeCodeWakePayload = {
      text: `Meshrooms room ${roomId} has work addressed to you waiting in inbox ${inboxId} (count: ${safeCount}).`,
    };
    return {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearerKey}`,
        'anthropic-version': CLAUDE_CODE_ANTHROPIC_VERSION,
        'anthropic-beta': CLAUDE_CODE_ANTHROPIC_BETA,
      },
      body: JSON.stringify(payload),
    };
  }
  const payload: WakePayload = {
    source: 'meshrooms',
    event: 'room-has-work',
    inbox: inboxId,
    room: roomId,
    count: safeCount,
  };
  return {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearerKey}`,
    },
    body: JSON.stringify(payload),
  };
}

/**
 * Validates a webhook URL strictly:
 * - HTTPS only in production (or http://127.0.0.1 / localhost / [::1] when `allowLoopbackHttp` / `allowLoopbackForTest` is set for tests).
 * - Fail-closed by default: arbitrary non-loopback destinations are refused unless `hostAllowlist` is configured and matches.
 * - Blocks embedded credentials, trailing-dot local hostnames, and private/link-local/metadata IP literals.
 */
export function validateWebhookUrl(
  rawUrl: string,
  options: { allowLoopbackHttp?: boolean; allowLoopbackForTest?: boolean; hostAllowlist?: string[] } = {},
): URL {
  if (typeof rawUrl !== 'string' || !rawUrl.trim() || rawUrl.length > MAX_URL_LENGTH) {
    throw new WakeValidationError('Enter a valid webhook URL.');
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new WakeValidationError('Enter a valid webhook URL.');
  }
  if (parsed.username || parsed.password) {
    throw new WakeValidationError('Webhook URL must not contain embedded credentials.');
  }
  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname) throw new WakeValidationError('Enter a valid webhook URL.');
  const allowLoopback = !!(options.allowLoopbackHttp || options.allowLoopbackForTest);
  const loopback = isLoopbackHost(hostname);
  if (parsed.protocol === 'http:') {
    if (!allowLoopback || !loopback) {
      throw new WakeValidationError('Webhook URL must use HTTPS.');
    }
  } else if (parsed.protocol !== 'https:') {
    throw new WakeValidationError('Webhook URL must use HTTPS.');
  }
  // Even with HTTPS, block loopback/private/link-local targets unless explicitly allowed in test mode.
  if (!loopback || !allowLoopback) {
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
      throw new WakeValidationError('Webhook URL cannot target a local or internal host.');
    }
    if (isIP(hostname) && isBlockedIp(hostname)) {
      throw new WakeValidationError('Webhook URL cannot target a private or link-local address.');
    }
    // Fail-closed destination policy: arbitrary destinations are disabled until MESHROOMS_WAKE_ALLOWLIST is configured.
    if (!options.hostAllowlist || options.hostAllowlist.length === 0) {
      throw new WakeValidationError('Webhook destinations are disabled until MESHROOMS_WAKE_ALLOWLIST is configured.');
    }
    if (!matchesAllowlist(hostname, options.hostAllowlist)) {
      throw new WakeValidationError('Webhook host is not in the allowed list.');
    }
  }
  return parsed;
}

/**
 * Performs an outbound POST pinned strictly to a pre-validated IP address & family using `node:http`/`node:https`,
 * preventing DNS rebinding TOCTOU. Never follows redirects, disables connection pooling (`agent: false`), and
 * preserves TLS SNI + certificate hostname verification for HTTPS.
 */
export function pinnedHttpRequest(req: PinnedTransportRequest): Promise<PinnedTransportResponse> {
  return new Promise<PinnedTransportResponse>((resolve, reject) => {
    const isHttps = req.url.protocol === 'https:';
    const port = req.url.port ? Number(req.url.port) : (isHttps ? 443 : 80);
    const bodyBuf = Buffer.from(req.body, 'utf8');
    const headers: Record<string, string | number> = {
      ...req.headers,
      Host: req.url.host,
      'Content-Length': bodyBuf.byteLength,
      Connection: 'close',
    };
    const pinnedLookup: http.RequestOptions['lookup'] = (_host, opts, cb) => {
      if (typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all) {
        (cb as (err: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void)(
          null,
          [{ address: req.ip, family: req.family }],
        );
      } else {
        (cb as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(null, req.ip, req.family);
      }
    };

    const baseOpts: http.RequestOptions = {
      method: 'POST',
      host: req.ip,
      family: req.family,
      port,
      path: `${req.url.pathname}${req.url.search}`,
      headers,
      agent: false,
      timeout: req.timeoutMs,
      lookup: pinnedLookup,
    };

    const onResponse = (res: http.IncomingMessage) => {
      const responseHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) {
          for (const item of v) responseHeaders.append(k, item);
        } else {
          responseHeaders.set(k, v);
        }
      }
      // Drain and discard response body so the socket closes cleanly without buffering arbitrary remote payloads.
      res.resume();
      const status = res.statusCode ?? 0;
      resolve({ status, headers: responseHeaders });
    };

    const clientReq = isHttps
      ? https.request(
        {
          ...baseOpts,
          servername: isIP(req.hostname) ? undefined : req.hostname,
          rejectUnauthorized: true,
          checkServerIdentity: (_host, cert) => checkServerIdentity(req.hostname, cert),
        },
        onResponse,
      )
      : http.request(baseOpts, onResponse);

    clientReq.on('timeout', () => {
      clientReq.destroy(new Error('Wake request timed out'));
    });
    clientReq.on('error', err => reject(err));
    clientReq.end(bodyBuf);
  });
}

type StoredRegistration = {
  inbox_id: string;
  room_id: string;
  device_id: string;
  iv: Uint8Array;
  ct: Uint8Array;
  tag: Uint8Array;
  updated_at: number;
};

type DecryptedRegistration = {
  url: string;
  key: string;
  provider?: WakeProvider;
};

/**
 * Separate wake dispatch service decoupled from WSS socket handling.
 * Stores `{ url, key, provider }` encrypted at rest under a server key, keyed strictly by opaque `inboxId` mapped to
 * `(roomId, deviceId)` with zero OAuth or account linkage. Dispatches strictly content-free webhooks over a pinned-IP
 * connection enforcing the egress allowlist and SSRF blocks.
 */
export class WakeConnector {
  private db: Database;
  private encKey: Buffer;
  private now: () => number;
  private transportFn: WakeTransportFn;
  private sleepFn: (ms: number) => Promise<void>;
  private lookupFn: (hostname: string) => Promise<string[]>;
  private allowLoopbackHttp: boolean;
  private hostAllowlist?: string[];
  private roomCap: number;
  private agentCap: number;
  private senderCap: number;
  private retryDelayMs: number;
  private maxRetryAfterMs: number;
  private maxRetries: number;
  private coalesceWindowMs: number;
  private timeoutMs: number;
  private writeLog: (line: string) => void;

  /** Devices currently mid-HTTP-dispatch (`roomId:deviceId`). */
  private inFlight = new Set<string>();
  /** Devices woken and awaiting agent connect/drain (`roomId:deviceId` -> timestamp). */
  private pendingSince = new Map<string, number>();
  /** Sliding 1-hour wake timestamps for room, agent device, and sender caps. */
  private roomWakes = new Map<string, number[]>();
  private agentWakes = new Map<string, number[]>();
  private senderWakes = new Map<string, number[]>();

  constructor(options: WakeConnectorOptions = {}) {
    this.now = options.now ?? Date.now;
    if (options.transport) {
      this.transportFn = options.transport;
    } else if (options.fetch) {
      const fetchFn = options.fetch;
      this.transportFn = async req => {
        const res = await fetchFn(req.url.toString(), {
          method: 'POST',
          headers: req.headers,
          body: req.body,
          redirect: 'error',
          signal: AbortSignal.timeout(req.timeoutMs),
        });
        return { status: res.status, headers: res.headers };
      };
    } else {
      this.transportFn = pinnedHttpRequest;
    }
    this.sleepFn = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.lookupFn = options.lookup ?? (async (hostname: string) => {
      const results = await dnsLookup(hostname, { all: true });
      return results.map(r => r.address);
    });
    this.allowLoopbackHttp = !!(options.allowLoopbackHttp || options.allowLoopbackForTest);
    this.hostAllowlist = options.hostAllowlist?.length ? options.hostAllowlist : undefined;
    this.roomCap = options.roomCapPerHour ?? WAKE_ROOM_HOURLY_CAP;
    this.agentCap = options.agentCapPerHour ?? WAKE_AGENT_HOURLY_CAP;
    this.senderCap = options.senderCapPerHour ?? WAKE_SENDER_HOURLY_CAP;
    this.retryDelayMs = options.retryDelayMs ?? WAKE_RETRY_DELAY_MS;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? WAKE_MAX_RETRY_AFTER_MS;
    this.maxRetries = options.maxRetries ?? WAKE_MAX_RETRIES;
    this.coalesceWindowMs = options.coalesceWindowMs ?? WAKE_COALESCE_WINDOW_MS;
    this.timeoutMs = options.timeoutMs ?? WAKE_TIMEOUT_MS;
    this.writeLog = options.log ?? (() => {});

    // Registrations are encrypted under a key derived from the server secret. A random per-process key would silently
    // orphan every stored registration at the next restart (devices still listed as wakeable, webhooks never fired), so a
    // persistent database REQUIRES an explicit secret and the connector refuses to start without one. Only a throwaway
    // in-memory database, which cannot outlive the process, may use an ephemeral key.
    const persistent = !!options.dbPath && options.dbPath !== ':memory:';
    if (persistent && !options.secret) {
      throw new Error('WakeConnector needs an explicit secret (MESHROOMS_RELAY_SECRET) to encrypt stored wake registrations; refusing to start with a random per-process key.');
    }
    this.encKey = options.secret
      ? createHash('sha256').update('meshrooms-wake-v1|').update(options.secret).digest()
      : randomBytes(32);

    this.db = new Database(options.dbPath ?? ':memory:', { create: true });
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wake_registrations (
        inbox_id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        iv BLOB NOT NULL,
        ct BLOB NOT NULL,
        tag BLOB NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(room_id, device_id)
      );
      CREATE INDEX IF NOT EXISTS wake_registrations_room ON wake_registrations(room_id);
    `);
  }

  close() {
    this.db.close();
  }

  private aad(roomId: string, deviceId: string, inboxId: string): Buffer {
    return Buffer.from(`meshrooms-wake-v1|${roomId}|${deviceId}|${inboxId}`, 'utf8');
  }

  private encryptSecret(roomId: string, deviceId: string, inboxId: string, secret: DecryptedRegistration) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    cipher.setAAD(this.aad(roomId, deviceId, inboxId));
    const ct = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { iv, ct, tag };
  }

  private decryptSecret(row: StoredRegistration): DecryptedRegistration {
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, Buffer.from(row.iv));
    decipher.setAAD(this.aad(row.room_id, row.device_id, row.inbox_id));
    decipher.setAuthTag(Buffer.from(row.tag));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(row.ct)), decipher.final()]).toString('utf8');
    return JSON.parse(plaintext) as DecryptedRegistration;
  }

  /** Registers or updates a device's wake webhook, encrypting `{ url, key, provider }` at rest under the server key. */
  register(
    roomId: string,
    deviceId: string,
    url: string,
    key: string,
    provider?: WakeProvider,
  ): { inboxId: string; provider: WakeProvider } {
    const parsed = validateWebhookUrl(url, {
      allowLoopbackHttp: this.allowLoopbackHttp,
      hostAllowlist: this.hostAllowlist,
    });
    const resolvedProvider = resolveWakeProvider(parsed, provider);
    if (typeof key !== 'string' || key.length < 1 || key.length > MAX_KEY_LENGTH || /[\r\n\0]/.test(key)) {
      throw new WakeValidationError('Enter a valid wake bearer key.');
    }
    const existing = this.db.query(
      'SELECT inbox_id FROM wake_registrations WHERE room_id = ? AND device_id = ?',
    ).get(roomId, deviceId) as { inbox_id: string } | null;
    const inboxId = existing?.inbox_id ?? randomBytes(16).toString('hex');
    const { iv, ct, tag } = this.encryptSecret(roomId, deviceId, inboxId, {
      url: parsed.toString(),
      key,
      provider: resolvedProvider,
    });
    this.db.query(
      'INSERT OR REPLACE INTO wake_registrations (inbox_id, room_id, device_id, iv, ct, tag, updated_at) VALUES (?,?,?,?,?,?,?)',
    ).run(inboxId, roomId, deviceId, iv, ct, tag, this.now());
    return { inboxId, provider: resolvedProvider };
  }

  /** Deletes a device's wake registration and clears its coalescing state. */
  unregister(roomId: string, deviceId: string): boolean {
    const key = `${roomId}:${deviceId}`;
    this.inFlight.delete(key);
    this.pendingSince.delete(key);
    const info = this.db.query('DELETE FROM wake_registrations WHERE room_id = ? AND device_id = ?').run(roomId, deviceId);
    return info.changes > 0;
  }

  /** Deletes all wake registrations for a closed or expired room. */
  deleteRoom(roomId: string): void {
    const prefix = `${roomId}:`;
    for (const k of this.inFlight) if (k.startsWith(prefix)) this.inFlight.delete(k);
    for (const k of this.pendingSince.keys()) if (k.startsWith(prefix)) this.pendingSince.delete(k);
    this.roomWakes.delete(roomId);
    for (const k of this.agentWakes.keys()) if (k.startsWith(prefix)) this.agentWakes.delete(k);
    for (const k of this.senderWakes.keys()) if (k.startsWith(prefix)) this.senderWakes.delete(k);
    this.db.query('DELETE FROM wake_registrations WHERE room_id = ?').run(roomId);
  }

  hasRegistration(roomId: string, deviceId: string): boolean {
    return !!this.db.query('SELECT 1 FROM wake_registrations WHERE room_id = ? AND device_id = ?').get(roomId, deviceId);
  }

  getInboxId(roomId: string, deviceId: string): string | null {
    const row = this.db.query('SELECT inbox_id FROM wake_registrations WHERE room_id = ? AND device_id = ?').get(roomId, deviceId) as { inbox_id: string } | null;
    return row ? row.inbox_id : null;
  }

  /** Clears pending coalesced state once the device opens a relay session or polls its inbox. */
  clearPending(roomId: string, deviceId: string): void {
    this.pendingSince.delete(`${roomId}:${deviceId}`);
  }

  private pruneWindow(map: Map<string, number[]>, key: string, now: number): number[] {
    const list = map.get(key);
    if (!list) return [];
    const cutoff = now - HOUR_MS;
    const active = list.filter(t => t > cutoff);
    if (active.length) map.set(key, active);
    else map.delete(key);
    return active;
  }

  private recordWake(map: Map<string, number[]>, key: string, now: number): void {
    const active = this.pruneWindow(map, key, now);
    active.push(now);
    map.set(key, active);
  }

  private logEvent(event: Record<string, string | number>) {
    // Strictly operational fields only: never roomId, deviceId, inboxId, URL, key, or content.
    this.writeLog(JSON.stringify({ time: new Date(this.now()).toISOString(), event: 'wake', ...event }));
  }

  private async resolvePinnedAddress(hostname: string): Promise<{ ip: string; family: 4 | 6 } | null> {
    const allowLoopback = this.allowLoopbackHttp && isLoopbackHost(hostname);
    const literalFamily = isIP(hostname);
    if (literalFamily === 4 || literalFamily === 6) {
      if (!allowLoopback && isBlockedIp(hostname)) return null;
      return { ip: hostname, family: literalFamily };
    }
    let ips: string[];
    try {
      ips = await this.lookupFn(hostname);
    } catch {
      return null;
    }
    if (!ips.length) return null;
    if (!allowLoopback && ips.some(ip => isBlockedIp(ip))) return null;
    const chosen = ips[0].replace(/^\[|\]$/g, '').split('%')[0];
    const family = isIP(chosen);
    if (family !== 4 && family !== 6) return null;
    if (!allowLoopback && isBlockedIp(chosen)) return null;
    return { ip: chosen, family };
  }

  /**
   * Dispatches a content-free webhook wake for `(roomId, deviceId)` triggered by `senderId`, enforcing coalescing,
   * room/agent/sender hourly caps, fail-closed allowlist policy, pinned-IP socket egress (anti-DNS-rebinding),
   * provider-specific adapters (`generic` / `claude-code`), and `Retry-After`-aware retries (429 / 5xx).
   */
  async notify(roomId: string, deviceId: string, senderId: string, addressedCount: number): Promise<WakeResult> {
    const row = this.db.query(
      'SELECT inbox_id, room_id, device_id, iv, ct, tag, updated_at FROM wake_registrations WHERE room_id = ? AND device_id = ?',
    ).get(roomId, deviceId) as StoredRegistration | null;
    if (!row) return 'unregistered';

    const deviceKey = `${roomId}:${deviceId}`;
    const senderKey = `${roomId}:${senderId}`;
    const now = this.now();

    if (this.inFlight.has(deviceKey)) return 'coalesced';
    const pendingAt = this.pendingSince.get(deviceKey);
    if (pendingAt !== undefined && now - pendingAt < this.coalesceWindowMs) return 'coalesced';

    // Check all three hourly caps before taking a slot.
    if (this.pruneWindow(this.roomWakes, roomId, now).length >= this.roomCap) {
      this.logEvent({ result: 'capped', reason: 'room' });
      return 'capped';
    }
    if (this.pruneWindow(this.agentWakes, deviceKey, now).length >= this.agentCap) {
      this.logEvent({ result: 'capped', reason: 'agent' });
      return 'capped';
    }
    if (this.pruneWindow(this.senderWakes, senderKey, now).length >= this.senderCap) {
      this.logEvent({ result: 'capped', reason: 'sender' });
      return 'capped';
    }

    let decrypted: DecryptedRegistration;
    try {
      decrypted = this.decryptSecret(row);
    } catch {
      this.logEvent({ result: 'failed', reason: 'decrypt' });
      return 'failed';
    }

    let parsed: URL;
    let provider: WakeProvider;
    try {
      // Re-enforce fail-closed allowlist and SSRF checks on every delivery (not only at registration).
      parsed = validateWebhookUrl(decrypted.url, {
        allowLoopbackHttp: this.allowLoopbackHttp,
        hostAllowlist: this.hostAllowlist,
      });
      provider = resolveWakeProvider(parsed, decrypted.provider);
    } catch {
      this.logEvent({ result: 'failed', reason: 'egress-denied' });
      return 'failed';
    }

    // Reserve coalescing + hourly cap slots before awaiting DNS/network.
    this.inFlight.add(deviceKey);
    this.pendingSince.set(deviceKey, now);
    this.recordWake(this.roomWakes, roomId, now);
    this.recordWake(this.agentWakes, deviceKey, now);
    this.recordWake(this.senderWakes, senderKey, now);

    let succeeded = false;
    try {
      const hostname = normalizeHostname(parsed.hostname);
      const { headers, body } = buildWakeRequest(provider, row.inbox_id, addressedCount, decrypted.key, roomId);
      let lastStatus = 0;

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        // Abort if the registration was deleted (e.g. device removed) between retries.
        if (attempt > 0 && !this.hasRegistration(roomId, deviceId)) {
          this.logEvent({ result: 'unregistered', attempts: attempt });
          return 'unregistered';
        }
        // Resolve and pin the socket IP immediately before each connection attempt (anti-DNS-rebinding TOCTOU).
        const pinned = await this.resolvePinnedAddress(hostname);
        if (!pinned) {
          this.logEvent({ result: 'failed', reason: 'ssrf-dns' });
          return 'failed';
        }

        let delayMs = this.retryDelayMs;
        try {
          const response = await this.transportFn({
            url: parsed,
            ip: pinned.ip,
            family: pinned.family,
            hostname,
            headers,
            body,
            timeoutMs: this.timeoutMs,
          });
          lastStatus = response.status;
          if (response.status >= 200 && response.status < 300) {
            succeeded = true;
            this.logEvent({ result: 'dispatched', status: response.status, attempts: attempt + 1 });
            return 'dispatched';
          }
          // Refuse 3xx redirects explicitly (never follow redirects to internal/unapproved hosts).
          if (response.status >= 300 && response.status < 400) {
            this.logEvent({ result: 'failed', reason: 'redirect-blocked', status: response.status, attempts: attempt + 1 });
            return 'failed';
          }
          const retryable = response.status === 429 || (response.status >= 500 && response.status <= 599);
          if (!retryable || attempt >= this.maxRetries) {
            this.logEvent({ result: 'failed', status: response.status, attempts: attempt + 1 });
            return 'failed';
          }
          const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'), this.now(), this.maxRetryAfterMs);
          if (retryAfter !== undefined) delayMs = retryAfter;
        } catch {
          if (attempt >= this.maxRetries) {
            this.logEvent({ result: 'failed', status: lastStatus, attempts: attempt + 1 });
            return 'failed';
          }
        }
        await this.sleepFn(delayMs);
      }
      return 'failed';
    } finally {
      this.inFlight.delete(deviceKey);
      if (!succeeded) this.pendingSince.delete(deviceKey);
    }
  }
}
