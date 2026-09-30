/**
 * Off-site uptime probe for the hosted Meshrooms service, run by a systemd timer.
 *
 *   bun meshrooms-probe.ts [--no-send] [--test-alert] [--state-dir DIR] [--origin URL]
 *
 * Checks the public health endpoint, /rooms and /, the HTTPS certificate, and the TURN relay
 * without credentials: a STUN Binding request over UDP and TCP on 3478, and a TLS handshake
 * (plus certificate expiry) on 5349. When the health body carries `backupFresh`, a stale admission
 * backup is a failing check too. If the probe host cannot resolve names itself, the run is skipped. It messages Telegram when the set of failing checks changes,
 * every 3 hours while anything fails, and (for information) when the deployed revision changes.
 *
 * TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID come from the environment (the unit's EnvironmentFile).
 * The token is handed to curl on stdin, never in argv, and is never printed.
 * --no-send logs the messages instead of sending them. --test-alert sends one test message and exits.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { lookup } from 'node:dns/promises';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import tls from 'node:tls';

const DAY = 86_400_000;
const TIMEOUT = 10_000;
const MIN_CERT_DAYS = 14;
const REMIND_EVERY = 3 * 3_600_000;
// Overridable only so the curl hand-off can be tested against a local server.
const TELEGRAM_API = process.env.MESHROOMS_PROBE_TELEGRAM_API || 'https://api.telegram.org';

export type Result = { name: string; ok: boolean; detail: string };
export type State = {
  revision?: string;
  /** Consecutive failures per check, so one lost packet does not page anyone. */
  streaks: Record<string, number>;
  /** Checks that were failing when the last alert went out. */
  alerting: string[];
  lastAlertAt?: number;
};

function args(argv: string[]) {
  const options = { send: true, testAlert: false, stateDir: process.env.STATE_DIRECTORY || '/var/lib/meshrooms-probe',
    origin: process.env.MESHROOMS_PROBE_ORIGIN || 'https://meshrooms.wormdb.dev', confirm: Number(process.env.MESHROOMS_PROBE_CONFIRM || 2) };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--no-send') options.send = false;
    else if (flag === '--test-alert') options.testAlert = true;
    else if (flag === '--state-dir') options.stateDir = argv[++i];
    else if (flag === '--origin') options.origin = argv[++i];
    else throw new Error(`Unknown option ${flag}`);
  }
  if (!/^https:\/\/[a-z0-9.-]+$/.test(options.origin)) throw new Error('--origin must be https://host');
  if (!(options.confirm >= 1)) throw new Error('MESHROOMS_PROBE_CONFIRM must be at least 1');
  return options;
}

async function get(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), redirect: 'manual', headers: { 'User-Agent': 'meshrooms-probe' } });
  return { status: response.status, body: await response.text() };
}

async function check(name: string, run: () => Promise<string>): Promise<Result> {
  try { return { name, ok: true, detail: await run() }; } catch (error) { return { name, ok: false, detail: (error as Error).message || String(error) }; }
}

function withTimeout<T>(promise: Promise<T>, what: string, ms = TIMEOUT): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms / 1000} s`)), ms); })]).finally(() => clearTimeout(timer));
}

/** TLS handshake with normal certificate validation; returns days until the leaf certificate expires. */
function tlsDays(host: string, port: number): Promise<number> {
  return withTimeout(new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true, ALPNProtocols: port === 443 ? ['http/1.1'] : undefined }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert?.valid_to) return reject(new Error(`${host}:${port} sent no certificate`));
      resolve((new Date(cert.valid_to).getTime() - Date.now()) / DAY);
    });
    socket.on('error', error => { socket.destroy(); reject(new Error(`${host}:${port} TLS: ${error.message}`)); });
  }), `${host}:${port} TLS`);
}

async function certificate(host: string, port: number) {
  const days = await tlsDays(host, port);
  if (days < MIN_CERT_DAYS) throw new Error(`${host}:${port} certificate expires in ${days.toFixed(1)} days`);
  return `handshake ok, certificate valid for ${Math.floor(days)} more days`;
}

/** A STUN Binding request (RFC 8489): 20-byte header, no attributes, so it needs no credentials. */
export function bindingRequest() {
  const id = randomBytes(12);
  const message = Buffer.alloc(20);
  message.writeUInt16BE(0x0001, 0); message.writeUInt16BE(0, 2); message.writeUInt32BE(0x2112a442, 4); id.copy(message, 8);
  return { id, message };
}

export function isBindingSuccess(reply: Buffer, id: Buffer) {
  return reply.length >= 20 && reply.readUInt16BE(0) === 0x0101 && reply.readUInt32BE(4) === 0x2112a442 && reply.subarray(8, 20).equals(id);
}

function stunUdp(host: string, port: number): Promise<string> {
  return withTimeout(new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const { id, message } = bindingRequest();
    let tries = 0;
    const send = () => { if (tries++ < 3) socket.send(message, port, host, error => error && reject(error)); };
    const retry = setInterval(send, 2_000);
    socket.on('message', reply => { if (isBindingSuccess(reply, id)) { clearInterval(retry); socket.close(); resolve('binding success over UDP'); } });
    socket.on('error', error => { clearInterval(retry); socket.close(); reject(error); });
    send();
  }), `STUN UDP ${host}:${port}`);
}

function stunTcp(host: string, port: number): Promise<string> {
  return withTimeout(new Promise((resolve, reject) => {
    const { id, message } = bindingRequest();
    let buffer = Buffer.alloc(0);
    const socket = net.connect({ host, port }, () => socket.write(message));
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 20) return;
      socket.destroy();
      isBindingSuccess(buffer, id) ? resolve('binding success over TCP') : reject(new Error('unexpected STUN reply over TCP'));
    });
    socket.on('error', error => { socket.destroy(); reject(error); });
  }), `STUN TCP ${host}:${port}`);
}

/**
 * The health body's optional `backupFresh` (present only when the service sets MESHROOMS_BACKUP_MAX_AGE_HOURS)
 * becomes its own check. Absent means not monitored, so no result at all.
 */
export function backupResult(health: { backupFresh?: unknown } | undefined): Result | undefined {
  if (typeof health?.backupFresh !== 'boolean') return undefined;
  return health.backupFresh ? { name: 'backup', ok: true, detail: 'last verified backup is recent' }
    : { name: 'backup', ok: false, detail: 'no verified admission backup within MESHROOMS_BACKUP_MAX_AGE_HOURS; check meshrooms-backup.service on the host' };
}

export async function runChecks(origin: string): Promise<{ results: Result[]; revision?: string }> {
  const host = new URL(origin).hostname;
  let revision: string | undefined;
  let health: { backupFresh?: unknown } | undefined;
  const results = await Promise.all([
    check('health', async () => {
      const started = Date.now();
      const { status, body } = await get(`${origin}/api/lobby/health`);
      if (status !== 200) throw new Error(`/api/lobby/health returned ${status}`);
      let data: { ok?: boolean; revision?: string; backupFresh?: unknown };
      try { data = JSON.parse(body); } catch { throw new Error('/api/lobby/health did not return JSON'); }
      if (data.ok !== true) throw new Error(`/api/lobby/health reports ok=${data.ok}`);
      health = data;
      revision = typeof data.revision === 'string' ? data.revision.slice(0, 64) : undefined;
      return `ok in ${Date.now() - started} ms, revision ${revision}`;
    }),
    check('rooms', async () => { const { status } = await get(`${origin}/rooms`); if (status !== 200) throw new Error(`/rooms returned ${status}`); return '200'; }),
    check('site', async () => { const { status } = await get(`${origin}/`); if (status !== 200) throw new Error(`/ returned ${status}`); return '200'; }),
    check('https-certificate', () => certificate(host, 443)),
    check('turn-udp', () => stunUdp(host, 3478)),
    check('turn-tcp', () => stunTcp(host, 3478)),
    check('turn-tls', () => certificate(host, 5349)),
  ]);
  const backup = backupResult(health);
  if (backup) results.push(backup);
  return { results, revision };
}

/**
 * Control check: can the probe host itself resolve names? If not, every check fails for a reason that has nothing to
 * do with Meshrooms (and Telegram is unreachable anyway), so the run is logged but not evaluated.
 */
export async function controlOk(names = ['api.telegram.org', 'one.one.one.one']) {
  for (const name of names) {
    try { await withTimeout(lookup(name), `resolve ${name}`, 5_000); return true; } catch { /* try the next name */ }
  }
  return false;
}

/** Decide what to announce, given this run's results. Pure, so it is unit-tested. */
export function evaluate(previous: State, results: Result[], revision: string | undefined, now: number, confirm: number) {
  const streaks: Record<string, number> = {};
  for (const result of results) streaks[result.name] = result.ok ? 0 : (previous.streaks[result.name] || 0) + 1;
  // A check that could not run this time (the backup flag while health is down) keeps its last state
  // instead of looking recovered.
  for (const name of previous.alerting) if (!(name in streaks)) streaks[name] = previous.streaks[name] || confirm;
  const failing = Object.keys(streaks).filter(name => streaks[name] >= confirm).sort();
  const before = [...previous.alerting].sort();
  const changed = failing.join() !== before.join();
  const messages: string[] = [];
  const details = (names: string[]) => names.map(name => `• ${name}: ${results.find(result => result.name === name)?.detail ?? 'not checked this run'}`).join('\n');
  let lastAlertAt = previous.lastAlertAt;
  if (changed && failing.length) {
    const recovered = before.filter(name => !failing.includes(name));
    messages.push(`🔴 Meshrooms probe: ${failing.length} check(s) failing\n${details(failing)}${recovered.length ? `\nRecovered: ${recovered.join(', ')}` : ''}`);
    lastAlertAt = now;
  } else if (changed) {
    messages.push(`✅ Meshrooms probe: all checks pass again (recovered: ${before.join(', ')})`);
    lastAlertAt = now;
  } else if (failing.length && now - (previous.lastAlertAt || 0) >= REMIND_EVERY) {
    messages.push(`🔴 Meshrooms probe: still failing\n${details(failing)}`);
    lastAlertAt = now;
  }
  if (revision && previous.revision && revision !== previous.revision) messages.push(`ℹ️ Meshrooms deployed revision ${revision.slice(0, 12)} (was ${previous.revision.slice(0, 12)})`);
  const state: State = { revision: revision || previous.revision, streaks, alerting: failing, lastAlertAt };
  return { state, messages, failing };
}

function readState(dir: string): State {
  try { return { streaks: {}, alerting: [], ...JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) }; } catch { return { streaks: {}, alerting: [] }; }
}

function writeState(dir: string, state: State) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'state.json');
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${file}.tmp`, file);
}

/** Send through curl with the URL and form fields on stdin (-K -), so the token never appears in argv or logs. */
function telegram(text: string, send: boolean) {
  if (!send) { console.log(JSON.stringify({ at: new Date().toISOString(), wouldSend: text })); return true; }
  const token = process.env.TELEGRAM_BOT_TOKEN || '', chat = process.env.TELEGRAM_CHAT_ID || '';
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || !/^-?\d+$/.test(chat)) { console.error('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing or malformed'); return false; }
  const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  const config = [`url = ${quote(`${TELEGRAM_API}/bot${token}/sendMessage`)}`, `data-urlencode = ${quote(`chat_id=${chat}`)}`,
    `data-urlencode = ${quote(`text=${text}`)}`, 'data-urlencode = "disable_web_page_preview=true"'].join('\n');
  const result = spawnSync('curl', ['-sS', '--fail-with-body', '-m', '15', '-o', '/dev/null', '-w', '%{http_code}', '-K', '-'], { input: config, encoding: 'utf8' });
  const ok = result.status === 0 && result.stdout.trim() === '200';
  // curl's own error text can include the URL; strip anything that looks like the token.
  if (!ok) console.error(`Telegram send failed (HTTP ${result.stdout.trim() || 'none'}): ${(result.stderr || '').replaceAll(token, '<token>').trim()}`);
  return ok;
}

if (import.meta.main) {
  let options: ReturnType<typeof args>;
  try { options = args(process.argv.slice(2)); } catch (error) { console.error((error as Error).message); process.exit(2); }
  if (options.testAlert) process.exit(telegram(`🧪 Meshrooms probe test alert from ${(await import('node:os')).hostname()}`, options.send) ? 0 : 1);
  const now = Date.now();
  const { results, revision } = await runChecks(options.origin);
  if (!results.every(result => result.ok) && !await controlOk()) {
    // The probe host's own network or DNS is broken: say so in the journal, keep the state, alert nobody.
    console.log(JSON.stringify({ at: new Date(now).toISOString(), origin: options.origin, control: 'failed', skipped: 'evaluation', results }));
    process.exit(0);
  }
  const previous = readState(options.stateDir);
  const { state, messages, failing } = evaluate(previous, results, revision, now, options.confirm);
  let delivered = true;
  for (const message of messages) delivered = telegram(message, options.send) && delivered;
  // If an alert could not be delivered, keep the old alert state so the next run tries again.
  writeState(options.stateDir, delivered ? state : { ...state, alerting: previous.alerting, lastAlertAt: previous.lastAlertAt, revision: previous.revision });
  console.log(JSON.stringify({ at: new Date(now).toISOString(), origin: options.origin, revision, failing, results }));
  // A failing check is reported through Telegram; the unit only fails when alerting itself is broken.
  process.exit(delivered ? 0 : 1);
}
