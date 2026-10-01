import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';

export type RuntimeRecord = {
  version: 1;
  apiVersion: 2;
  pid: number;
  url: string;
  nodeId: string;
  instanceId: string;
};

export function loadControlToken(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const keyPath = join(dataDir, 'control.key');
  const read = () => { try { const t = readFileSync(keyPath, 'utf8').trim(); return t.length >= 32 ? t : undefined; } catch { return undefined; } };
  const existing = read();
  if (existing) return existing;
  // The key appears whole or not at all: it's written to a private temporary file and then hard-linked into place, which
  // fails if another process got there first. Creating it in place ('wx' then write) left a moment where a second
  // process starting at the same time read an empty key, failed to create its own and gave up.
  const token = randomBytes(32).toString('base64url');
  const temporary = `${keyPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, token + '\n', { mode: 0o600, flag: 'wx' });
  try {
    linkSync(temporary, keyPath);
    return token;
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    const raced = read();
    if (raced) return raced;
    throw new Error(`The control key at ${keyPath} is empty or damaged; remove it and start again.`);
  } finally {
    try { unlinkSync(temporary); } catch { /* Already gone. */ }
  }
}

export function runtimeProof(token: string, challenge: string, record: RuntimeRecord): string {
  const payload = JSON.stringify([
    challenge,
    record.instanceId,
    record.nodeId,
    record.pid,
    record.apiVersion,
  ]);
  return createHmac('sha256', token).update(payload).digest('hex');
}

export function registerRuntime(dataDir: string, record: RuntimeRecord): () => void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const runtimePath = join(dataDir, 'runtime.json');
  const tempPath = join(dataDir, `.runtime.json.tmp.${record.pid}.${randomUUID()}`);
  const payload = JSON.stringify(record, null, 2);
  writeFileSync(tempPath, payload, { mode: 0o600 });
  renameSync(tempPath, runtimePath);

  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    try {
      if (existsSync(runtimePath)) {
        const content = readFileSync(runtimePath, 'utf8');
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === 'object' && parsed.instanceId === record.instanceId && parsed.pid === record.pid) {
          unlinkSync(runtimePath);
        }
      }
    } catch {
      // Stale or already removed
    }
  };
}

function parseLoopbackUrl(urlString: string): URL | null {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'http:') return null;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname !== '127.0.0.1' && hostname !== 'localhost') return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.pathname !== '/prototype/room' || parsed.search || parsed.hash) return null;
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return parsed;
  } catch {
    return null;
  }
}

function safeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function probeRuntime(dataDir: string): Promise<RuntimeRecord | null> {
  const runtimePath = join(dataDir, 'runtime.json');
  const keyPath = join(dataDir, 'control.key');

  if (!existsSync(runtimePath) || !existsSync(keyPath)) {
    return null;
  }

  let record: RuntimeRecord;
  try {
    const raw = readFileSync(runtimePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.version !== 1 || parsed.apiVersion !== 2) return null;
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    if (typeof parsed.nodeId !== 'string' || !parsed.nodeId.trim()) return null;
    if (typeof parsed.instanceId !== 'string' || !parsed.instanceId.trim()) return null;
    if (typeof parsed.url !== 'string') return null;
    record = {
      version: 1,
      apiVersion: 2,
      pid: parsed.pid,
      url: parsed.url,
      nodeId: parsed.nodeId,
      instanceId: parsed.instanceId,
    };
  } catch {
    return null;
  }

  const loopbackUrl = parseLoopbackUrl(record.url);
  if (!loopbackUrl) return null;

  let token: string;
  try {
    token = readFileSync(keyPath, 'utf8').trim();
    if (token.length < 32) return null;
  } catch {
    return null;
  }

  const challenge = randomBytes(16).toString('hex');
  const healthUrl = new URL('/api/node/health', loopbackUrl.origin);
  healthUrl.searchParams.set('challenge', challenge);

  try {
    const response = await fetch(healthUrl.toString(), {
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });

    if (response.status !== 200) return null;

    const data = (await response.json()) as any;
    if (!data || typeof data !== 'object') return null;
    if (data.ready !== true) return null;
    if (data.nodeId !== record.nodeId) return null;
    if (data.instanceId !== record.instanceId) return null;
    if (data.pid !== record.pid) return null;
    if (data.apiVersion !== record.apiVersion) return null;
    if (typeof data.proof !== 'string') return null;

    const expectedProof = runtimeProof(token, challenge, record);
    if (!safeCompare(data.proof, expectedProof)) {
      return null;
    }

    return record;
  } catch {
    return null;
  }
}

export async function ensureRunning(options: {
  dataDir: string;
  libraryPath: string;
  port: number;
  daemonPath?: string;
  devOrigin?: string;
  /** How long to wait for the started daemon to answer; a cold start on a busy machine can take seconds. */
  readyTimeoutMs?: number;
  /** Where the started process's output goes; by default it is discarded. Tests keep it to explain a start that failed. */
  logFile?: string;
}): Promise<RuntimeRecord> {
  const existing = await probeRuntime(options.dataDir);
  if (existing) {
    return existing;
  }

  const defaultDaemon = resolve(import.meta.dir, 'daemon.ts');
  const scriptPath = options.daemonPath ? resolve(options.daemonPath) : defaultDaemon;

  const args: string[] = [
    scriptPath,
    '--data-dir', resolve(options.dataDir),
    '--library', resolve(options.libraryPath),
    '--port', String(options.port),
  ];
  if (options.devOrigin) {
    args.push('--dev-origin', options.devOrigin);
  }

  const log = options.logFile ? openSync(options.logFile, 'a') : undefined;
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: log === undefined ? 'ignore' : ['ignore', log, log],
    windowsHide: true,
  });
  if (log !== undefined) closeSync(log);
  let spawnError: Error | undefined;
  child.on('error', error => { spawnError = error; });
  child.unref();

  const startTime = Date.now();
  const timeoutMs = options.readyTimeoutMs ?? 10_000;
  const pollIntervalMs = 100;

  while (Date.now() - startTime < timeoutMs) {
    await new Promise(r => setTimeout(r, pollIntervalMs));
    const record = await probeRuntime(options.dataDir);
    if (record) {
      return record;
    }
    if (spawnError) throw new Error(`Could not start the Meshrooms runtime: ${spawnError.message}`);
  }

  const said = options.logFile ? (() => { try { return readFileSync(options.logFile!, 'utf8').trim().slice(-2_000); } catch { return ''; } })() : '';
  throw new Error(`Timed out waiting for Meshrooms daemon to become ready in ${options.dataDir} after ${Math.round(timeoutMs / 1000)} seconds.${said ? `\nIts output:\n${said}` : ''}`);
}
