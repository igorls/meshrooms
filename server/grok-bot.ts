/**
 * `grok setup|check|wake`: what a Grok Bot needs to take part in a room as an agent.
 *
 * A Grok Bot runs on a box it keeps, with a shell, a browser and routines (saved prompts a schedule or a webhook starts),
 * but no session a watcher can resume. So a binding wakes it the one way it can be woken from outside: its webhook
 * routine. The watcher runs `grok wake` as an `exec` harness (`bind --harness exec --command 'bun "<launcher>" grok wake
 * --room {room} --prompt-file {prompt_file}'`); `grok wake` posts to the routine's webhook, then waits until the run the
 * webhook started has read the room, because the watcher counts a wake as handled only when the room was read during it.
 *
 * Three properties it must hold, and how:
 *
 * 1. The key never leaves its file. `grok setup` writes the URL and key from a page on 127.0.0.1, filled by the person
 *    (in Grok Bot, through its secure form), so neither ever passes through a chat or a command line. `grok wake` reads
 *    them from that 0600 file, sends the key only in the Authorization header, and never prints, logs or returns it; what
 *    it reports names only the webhook's host. The file sits in ~/.meshrooms/grok, which every other harness's wake is
 *    denied (HOME_SECRETS).
 * 2. Room text never reaches the webhook. The body names the room and how much work waits (counts), nothing a member
 *    wrote: the routine reads the room itself, with `listen`, under the room rules.
 * 3. The watcher's own rules decide. `grok wake` succeeds (exit 0) when the agent's listen cursor moved, the signal the
 *    watcher itself uses, and fails (exit 2) when nothing read the room in time, so the watcher's backoff, its pause after
 *    three wakes that didn't read, and its hourly caps apply to a Grok Bot exactly as to any harness.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { replaceFile } from './browser-agent';

/** The webhook a Grok Bot routine gave: where to POST and the key it checks. */
export type GrokWebhook = { url: string; key: string };
/** What `grok wake` tells the watcher (on stdout, as JSON) and the exit code that goes with it. Never the key. */
export type GrokWakeResult = {
  state: 'handled' | 'cleared' | 'no-work' | 'timeout' | 'not-admitted' | 'rejected' | 'unreachable';
  room: string; webhookHost?: string; status?: number; waitedSeconds?: number; message?: string; exitCode: number;
};
/** Exit codes: 0 the room was read (or there was nothing to read), 1 the webhook or the agent can't be used, 2 nothing read the room in time. */
export const GROK_EXIT = { ok: 0, failed: 1, timeout: 2 } as const;
export const GROK_DEFAULTS = { timeoutMinutes: 10, pollSeconds: 5, setupMinutes: 15 } as const;
/** The folder `grok setup` writes into, relative to the home folder. Listed in HOME_SECRETS, so no other wake reads it. */
export const GROK_DIR = join('.meshrooms', 'grok');
export const grokWebhookFile = (home = homedir(), env: Record<string, string | undefined> = process.env) => {
  // Bots share the box, not an identity or a webhook. One file per agent home (the same across that agent's rooms).
  const agentHome = resolve(env.MESHROOMS_AGENT_HOME || join(home, '.meshrooms', 'agents'));
  return join(home, GROK_DIR, createHash('sha256').update(agentHome).digest('hex').slice(0, 24), 'webhook.json');
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** The URL a webhook may have: https, or http to this machine (a local relay, or a test). Nothing else carries the key. */
export function webhookUrlProblem(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_048) return 'Give the webhook URL the routine shows (POST to).';
  let url: URL; try { url = new URL(value.trim()); } catch { return 'The webhook URL is not a URL.'; }
  if (url.hash) return 'The webhook URL must not have a fragment.';
  if (url.username || url.password) return 'The webhook URL must not carry a user name or password.';
  if (url.protocol === 'https:') return undefined;
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return undefined;
  return 'The webhook URL must use https.';
}
/**
 * The key as the routine panel shows it: the key itself, or its header line (`Authorization: Bearer KEY` or `Bearer KEY`),
 * since the panel offers both to copy. Undefined when what was given can't be a key.
 */
export function normalizeKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const key = value.trim().replace(/^authorization:\s*/i, '').replace(/^bearer\s+/i, '').trim();
  return key && key.length <= 4_096 && /^[\x21-\x7e]+$/.test(key) ? key : undefined;
}

/**
 * Reads the webhook file, refusing one anyone else could have written or read: not a regular file (a link included), not
 * this user's, or readable or writable by group or others. Windows has no such mode bits, so there only the shape is checked.
 */
export function readGrokWebhook(file: string, platform: NodeJS.Platform = process.platform, uid = process.getuid?.()): GrokWebhook {
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(file); } catch { throw new Error(`No Grok Bot webhook is set up (${file}). Run grok setup and fill in the routine's webhook there.`); }
  if (!stat.isFile()) throw new Error(`${file} is not a regular file. Remove it and run grok setup again.`);
  if (platform !== 'win32') {
    if (uid !== undefined && stat.uid !== uid) throw new Error(`${file} belongs to another user. Remove it and run grok setup again.`);
    if ((stat.mode & 0o077) !== 0) throw new Error(`${file} can be read by other users (mode ${(stat.mode & 0o777).toString(8)}). Run chmod 600 on it, or run grok setup again.`);
  }
  let saved: any; try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`${file} can't be read as a webhook. Run grok setup again.`); }
  const urlProblem = webhookUrlProblem(saved?.url), key = normalizeKey(saved?.key);
  if (saved?.version !== 1 || urlProblem || !key) throw new Error(`${file} doesn't hold a usable webhook${urlProblem ? `: ${urlProblem}` : ''}. Run grok setup again.`);
  return { url: saved.url.trim(), key };
}
/** Writes the webhook file (0600, in a 0700 folder), replacing it whole so a reader never sees half of it. */
export function writeGrokWebhook(file: string, webhook: GrokWebhook) {
  const urlProblem = webhookUrlProblem(webhook.url), key = normalizeKey(webhook.key);
  if (urlProblem) throw new Error(urlProblem);
  if (!key) throw new Error('Give the webhook key the routine shows (key, or its Authorization header).');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  replaceFile(file, JSON.stringify({ version: 1, url: webhook.url.trim(), key }));
}
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return undefined; } };
// Fetch errors may contain the entire request URL (whose path may be a secret), so never forward their text.

export type PeekLike = { admitted: boolean; work: boolean; addressed: unknown[]; tasks: unknown[]; decisions: unknown[] };
export type GrokWakeDeps = {
  room: string; webhook: GrokWebhook;
  /** Whether a listen would return work now, without consuming it (peekWork). */
  peek: () => PeekLike;
  /** The agent's saved listen cursor, as the watcher compares it. */
  cursor: () => string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number; pollMs?: number;
  /** Tries for the POST (network errors, 429 and 5xx), and the pause between them. */
  attempts?: number; retryMs?: number;
  log?: (line: string) => void;
};

/**
 * One wake: if there is work, ask the routine to run, then wait until it has read the room. The routine reads with a
 * plain `listen`, which saves the agent's cursor; that moving is what this waits for, as the watcher does.
 */
export async function grokWake(deps: GrokWakeDeps): Promise<GrokWakeResult> {
  const { room, webhook } = deps, post = deps.fetch ?? ((url, init) => fetch(url, init)), sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = deps.now ?? Date.now, log = deps.log ?? (() => {}), webhookHost = hostOf(webhook.url);
  const timeoutMs = deps.timeoutMs ?? GROK_DEFAULTS.timeoutMinutes * 60_000, pollMs = deps.pollMs ?? GROK_DEFAULTS.pollSeconds * 1000;
  const attempts = deps.attempts ?? 3, retryMs = deps.retryMs ?? 5_000;
  const before = deps.cursor(), first = deps.peek();
  if (!first.admitted) return { state: 'not-admitted', room, message: 'This agent is not admitted to the room yet.', exitCode: GROK_EXIT.failed };
  if (!first.work) return { state: 'no-work', room, exitCode: GROK_EXIT.ok };
  // Counts only: what members wrote stays in the room, where the routine reads it under the room rules.
  const body = JSON.stringify({ source: 'meshrooms', event: 'room-has-work', room, wakeId: randomUUID(),
    work: { messages: first.addressed.length, tasks: first.tasks.length, decisions: first.decisions.length }, at: new Date(now()).toISOString() });
  let status: number | undefined, failure: string | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await post(webhook.url, { method: 'POST', headers: { authorization: `Bearer ${webhook.key}`, 'content-type': 'application/json' }, body, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      status = response.status; failure = undefined;
      try { await response.body?.cancel(); } catch { /* Nothing to drain. */ }
      if (response.ok) break;
      // A wrong key or a deleted routine won't change on a retry; a busy service might.
      if (status !== 429 && status < 500) break;
    } catch { status = undefined; failure = 'network error, timeout, or redirect refused'; }
    if (attempt < attempts) { log(`webhook ${webhookHost}: ${status ?? failure}; trying again`); await sleep(retryMs); }
  }
  if (status === undefined) return { state: 'unreachable', room, webhookHost, message: `The webhook at ${webhookHost} could not be reached: ${failure}`, exitCode: GROK_EXIT.failed };
  if (status < 200 || status >= 300) {
    const why = status === 401 || status === 403 ? 'the key was refused (copy the current key from the routine, then run grok setup again)'
      : status === 404 ? 'no routine has this URL (it was deleted, or the URL is incomplete)'
      : status === 429 ? 'it is rate limiting' : `it answered ${status}`;
    return { state: 'rejected', room, webhookHost, status, message: `The routine did not start: ${why}.`, exitCode: GROK_EXIT.failed };
  }
  log(`webhook ${webhookHost}: ${status}; waiting for the run to read the room`);
  const started = now(), waited = () => Math.round((now() - started) / 1000);
  while (now() - started < timeoutMs) {
    await sleep(pollMs);
    if (deps.cursor() !== before) return { state: 'handled', room, webhookHost, status, waitedSeconds: waited(), exitCode: GROK_EXIT.ok };
    // The work went away without a read (a message deleted, a task unassigned): nothing is left to wake for.
    if (!deps.peek().work) return { state: 'cleared', room, webhookHost, status, waitedSeconds: waited(), exitCode: GROK_EXIT.ok };
  }
  return { state: 'timeout', room, webhookHost, status, waitedSeconds: waited(),
    message: `The routine started but did not read the room within ${Math.round(timeoutMs / 60_000)} min. Check its run history.`, exitCode: GROK_EXIT.timeout };
}

/** A test POST, so the person sees the routine start once before relying on it. The routine's prompt ignores it. */
export async function grokPing(webhook: GrokWebhook, post: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init)) {
  const webhookHost = hostOf(webhook.url);
  try {
    const response = await post(webhook.url, { method: 'POST', headers: { authorization: `Bearer ${webhook.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'meshrooms', event: 'test', at: new Date().toISOString() }), redirect: 'error', signal: AbortSignal.timeout(30_000) });
    try { await response.body?.cancel(); } catch { /* Nothing to drain. */ }
    return { pinged: response.ok, webhookHost, status: response.status };
  } catch { return { pinged: false, webhookHost, error: 'network error, timeout, or redirect refused' }; }
}

const PAGE_STYLE = 'body{font:16px system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1d2433}label{display:block;margin:1.2rem 0 .3rem;font-weight:600}'
  + 'input{width:100%;box-sizing:border-box;padding:.55rem;font:inherit;border:1px solid #9aa3b5;border-radius:6px}button{margin-top:1.5rem;padding:.6rem 1.2rem;font:inherit;border-radius:6px;border:0;background:#2456d3;color:#fff}p.note{color:#4a5468}';
const page = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">`
  + `<title>Meshrooms · Grok Bot webhook</title><style>${PAGE_STYLE}</style></head><body><main>${body}</main></body></html>`;
export const SETUP_FORM = page('<h1>Wake your Grok Bot from Meshrooms</h1><p class="note">Paste the webhook of the routine that should run when a room has work for your bot. '
  + 'It is saved on this computer only, readable by you alone, and never shown again.</p><form method="post">'
  + '<label for="url">Webhook URL (POST to)</label><input id="url" name="url" type="url" required autocomplete="off" spellcheck="false">'
  + '<label for="key">Webhook key (or its Authorization header)</label><input id="key" name="key" type="password" required autocomplete="off" spellcheck="false">'
  + '<button type="submit">Save</button></form>');
const SAVED = page('<h1>Saved</h1><p>Your bot can now be woken from its rooms. You can close this tab.</p>');

/**
 * `grok setup`: a one-time page on 127.0.0.1 at an unguessable path, where the person fills in the webhook. Prints the
 * page's address first (one JSON line), then waits for one valid submission, writes the file and returns. Only a POST from
 * the page itself is taken (its Origin), so another site open in the same browser can't write a webhook of its choosing.
 */
export async function grokSetup(options: { file: string; port?: number; timeoutMs?: number; announce: (line: object) => void }) {
  const token = randomBytes(24).toString('base64url'), path = `/setup/${token}`;
  let submitted = false;
  let done: (result: { saved: boolean; file: string; webhookHost?: string; message?: string }) => void = () => {};
  const finished = new Promise<{ saved: boolean; file: string; webhookHost?: string; message?: string }>(r => { done = r; });
  const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const html = (text: string, status = 200) => new Response(text, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" } });
  const server = Bun.serve({ hostname: '127.0.0.1', port: options.port ?? 0, maxRequestBodySize: 16_384, async fetch(request) {
    const url = new URL(request.url);
    if (submitted) return new Response('Setup has finished.', { status: 410 });
    if (!same(url.pathname, path)) return new Response('Not found', { status: 404 });
    if (request.method === 'GET') return html(SETUP_FORM);
    if (request.method !== 'POST') return new Response('Use the form.', { status: 405 });
    // A browser names the page a form came from (Origin), and says whether it is this one (Sec-Fetch-Site). Either must say so.
    const from = request.headers.get('origin'), site = request.headers.get('sec-fetch-site');
    if (from !== `http://127.0.0.1:${server.port}` && !(site === 'same-origin' && (from === null || from === 'null'))) return new Response('Submit from the setup page.', { status: 403 });
    if (site !== null && site !== 'same-origin') return new Response('Submit from the setup page.', { status: 403 });
    if (Number(request.headers.get('content-length') ?? 0) > 16_384) return new Response('Too large.', { status: 413 });
    let form: FormData; try { form = await request.formData(); } catch { return html(page('<h1>That did not work</h1><p>Go back and submit the form again.</p>'), 400); }
    const webhookUrl = String(form.get('url') ?? ''), key = String(form.get('key') ?? '');
    const problem = webhookUrlProblem(webhookUrl) ?? (normalizeKey(key) ? undefined : 'Give the webhook key the routine shows (key, or its Authorization header).');
    if (problem) return html(page(`<h1>Not saved</h1><p>${problem.replace(/[<>&]/g, '')}</p><p><a href="${path}">Try again</a></p>`), 400);
    if (submitted) return new Response('Setup has finished.', { status: 410 });
    writeGrokWebhook(options.file, { url: webhookUrl, key });
    submitted = true;
    queueMicrotask(() => done({ saved: true, file: options.file, webhookHost: hostOf(webhookUrl.trim()) }));
    return html(SAVED);
  } });
  options.announce({ state: 'open', setupUrl: `http://127.0.0.1:${server.port}${path}`, file: options.file,
    next: 'Open setupUrl in the browser on this computer and have the person fill in both fields (in Grok Bot, with its secure form). Never ask for the key in chat.' });
  const timeoutMs = options.timeoutMs ?? GROK_DEFAULTS.setupMinutes * 60_000;
  const timer = setTimeout(() => done({ saved: false, file: options.file, message: `Nothing was submitted within ${Math.round(timeoutMs / 60_000)} min; run grok setup again.` }), timeoutMs);
  try { return await finished; } finally { clearTimeout(timer); server.stop(true); }
}

/**
 * The wake rules for `grok`: during a wake only `grok wake`, for the wake's own room, may run (it is the program the
 * watcher started). setup, check and anything else are the operator's. Returns the wake folder, like wakeGuard.
 */
export function grokWakeGuard(sub: string | undefined, values: Record<string, string>, env: Record<string, string | undefined> = process.env) {
  const room = env.MESHROOMS_WAKE_ROOM;
  if (room === undefined) return undefined;
  if (sub !== 'wake') throw new Error(`grok ${sub ?? 'help'} isn't available to an agent the room watcher woke. Only its operator can run it, outside a wake.`);
  if (values['--room'] !== room) throw new Error(`This wake is for room ${room}; use --room ${room}.`);
  return env.MESHROOMS_WAKE_DIR ?? '';
}

/** One of this agent's rooms as `grok keepalive` reports it (from `bindings`): no message text, only state. */
export type GrokRoomHealth = {
  roomId: string; title: string | null; wakes: string; reason?: string; runner: boolean; closed?: boolean; stopped?: boolean;
};
export type GrokKeepaliveDeps = {
  agentHome: string;
  startDaemon: () => Promise<{ running: boolean; started: boolean; supervisesAgentHome?: boolean }>;
  /** This agent folder's rooms, read again each time it is called (the daemon brings runners and watchers up). */
  rooms: () => GrokRoomHealth[];
  /** Whether the wake routine's webhook is saved and usable: undefined if so, else why not (never the URL or key). */
  webhookProblem: () => string | undefined;
  bunVersion: string;
  now: () => number; sleep: (ms: number) => Promise<void>;
  /** How long a daemon that has just started gets to bring this agent's rooms up before they're reported. */
  settleMs?: number;
};
export type GrokKeepaliveResult = {
  ok: boolean; daemon: { running: boolean; started: boolean }; agentHome: string; webhook: 'ok' | 'problem';
  rooms: GrokRoomHealth[]; attention: string[]; exitCode: number;
};

/**
 * Folder names whose contents tools and hosts treat as rebuildable and may clear (a box that is replaced keeps the home
 * folder but not these), or that are temporary by name. An agent folder in one of them can lose the agent's signing key.
 */
const VOLATILE = new Set(['dist', 'build', 'out', 'coverage', 'target', '.cache', '.next', 'tmp', 'temp', 'node_modules']);
export function volatileAgentHome(agentHome: string, tmp: string) {
  const full = resolve(agentHome), inTemp = relative(resolve(tmp), full);
  if (!inTemp || (!inTemp.startsWith('..') && !isAbsolute(inTemp))) return true;
  return full.split(/[\\/]+/).some(part => VOLATILE.has(part.toLowerCase()));
}
const MIN_BUN = [1, 4, 2];
const bunTooOld = (version: string) => {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number);
  if (!parts) return false;
  for (let i = 0; i < 3; i++) if (parts[i] !== MIN_BUN[i]) return parts[i] < MIN_BUN[i];
  return false;
};
/** A room that needs nothing: wakes on, its runner up, still open. */
const roomOk = (room: GrokRoomHealth) => room.wakes === 'on' && room.runner && !room.closed && !room.stopped;

/**
 * `grok keepalive`: what a Grok Bot's hourly keepalive routine runs, since a box has no systemd or login session to start
 * the daemon and the box can be replaced (its home folder kept, its processes not). Starts the daemon if none runs
 * (idempotent), gives a daemon it just started a moment to bring this agent's runners and watchers back, then reports
 * what needs the person: the daemon, the webhook, each room's wakes and runner, an agent folder in a place that gets
 * cleared, a Bun too old. `ok` (exit 0) means the routine can end without a word; otherwise `attention` says what, in
 * words a person can be told (room titles, never ids or paths), and it exits 1.
 */
export async function grokKeepalive(deps: GrokKeepaliveDeps, tmp: string): Promise<GrokKeepaliveResult> {
  const attention: string[] = [];
  let daemon = { running: false, started: false };
  try {
    const d = await deps.startDaemon(); daemon = { running: d.running, started: d.started };
    if (d.running && d.supervisesAgentHome === false) attention.push("The machine's Meshrooms daemon does not look after this agent folder; run connect for it again so the daemon takes it on.");
  }
  catch (error) { attention.push(`The Meshrooms daemon would not start: ${error instanceof Error ? error.message.split('\n')[0].slice(0, 200) : String(error)}`); }
  let rooms = deps.rooms();
  if (daemon.started) {
    for (const until = deps.now() + (deps.settleMs ?? 20_000); deps.now() < until && !rooms.every(roomOk); rooms = deps.rooms()) await deps.sleep(1_000);
  }
  const webhook = deps.webhookProblem();
  if (webhook) attention.push(`The wake routine's webhook can't be used (${webhook}); run grok setup again.`);
  if (!rooms.length) attention.push('This agent is in no room yet.');
  const named = (room: GrokRoomHealth) => room.title ? `"${room.title}"` : 'one room';
  for (const room of rooms) {
    if (room.closed) attention.push(`The room ${named(room)} was closed; leave it (unbind, stop) and take it out of the wake routine.`);
    else if (room.stopped) attention.push(`The connection to ${named(room)} was stopped; connect again with a new link to rejoin.`);
    else if (room.wakes !== 'on') attention.push(`Wakes in ${named(room)} are ${room.wakes}${room.reason ? `: ${room.reason.replace(/[.\s]+$/, '')}` : ''}.`);
    else if (!room.runner) attention.push(`The connection to ${named(room)} isn't up yet.`);
  }
  if (volatileAgentHome(deps.agentHome, tmp)) attention.push('The agent folder is in a temporary or build folder that can be cleared, which would lose this agent; move it under ~/.meshrooms.');
  if (bunTooOld(deps.bunVersion)) attention.push(`Bun ${deps.bunVersion} is older than 1.4.2; run bun upgrade.`);
  const ok = attention.length === 0 && daemon.running;
  return { ok, daemon, agentHome: deps.agentHome, webhook: webhook ? 'problem' : 'ok', rooms, attention, exitCode: ok ? GROK_EXIT.ok : GROK_EXIT.failed };
}
