/**
 * The harness scan: which agent harnesses this machine has, and the sessions each could bind, for the person's own
 * page (local-agents.ts). Read-only and bounded everywhere:
 *
 * - A program is found on PATH without a shell (resolveProgram: on Windows an npm .cmd shim runs its script through
 *   node), and asked only `--version`, with a fixed argv, no stdin, a timeout and an output cap; its stderr is dropped.
 * - A version this file doesn't know reports "detected, sessions unavailable", never a guess at its storage.
 * - Sessions come from the harness's own storage, read a bounded head of each file at most: at most SESSION_LIMIT,
 *   newest first, each as plain capped text: a title (the first thing the person typed, or the harness's own thread
 *   name), the working folder's last segment, and when it was last active. Never a full path, never contents.
 *   Titles are anyone's text (a prompt can carry text from elsewhere): control, format and bidi characters are
 *   replaced, and the page shows them as plain text only.
 *
 * Hermes: hermes.ts, which already holds its own version gate and parser; this file only finds the program first.
 * exec ("custom command") needs no program and has no sessions.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { recentClaudeSessions, claudeConfigDir, claudeProjectDir } from '../agent-live';
import { resolveProgram, type Program } from '../agent-watch';
import { detectHermes, runHermesCommand, type HermesRunner } from './hermes';

export type HarnessId = 'claude' | 'codex' | 'hermes' | 'exec';
export const HARNESS_IDS: HarnessId[] = ['claude', 'codex', 'hermes', 'exec'];
export const HARNESS_LABELS: Record<HarnessId, string> = { claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes', exec: 'Custom command' };
/** Why sessions are unavailable (or the harness not detected). Never a raw error, path or output. */
export type ScanReason = 'not-found' | 'version-command-failed' | 'unsupported-version' | 'listing-command-failed' | 'unsupported-schema' | 'custom-command';
export type HarnessScan = { harness: HarnessId; label: string; detected: boolean; version?: string; sessionsAvailable: boolean; reason?: ScanReason };
/**
 * A session as the page lists it. `lastActiveAt`: an ISO time (Claude Code and Codex: the file's last write);
 * `lastActiveLabel`: what the harness itself says when it gives no time (Hermes: "2h ago").
 */
export type HarnessSession = { id: string; title: string | null; folder: string | null; lastActiveAt: string | null; lastActiveLabel?: string | null };
export type SessionListing = { harness: HarnessId; sessionsAvailable: boolean; reason?: ScanReason; sessions: HarnessSession[]; truncated: boolean };

export const SESSION_LIMIT = 20, TITLE_CODE_POINTS = 60, FOLDER_CODE_POINTS = 40;
/** A prompt is read for its title only this far, and what is kept of it before the title is cut is this long. */
export const PROMPT_SCAN_CHARS = 64 * 1024, TITLE_SOURCE_CHARS = 2 * 1024;
export const VERSION_TIMEOUT_MS = 10_000, VERSION_MAX_BYTES = 4 * 1024;
/** The most of a transcript's start read for its title and folder; a first prompt after that leaves the title unknown. */
export const HEAD_BYTES = 256 * 1024;
/** The most Codex rollout files whose first line is read to find SESSION_LIMIT threads that aren't subagents'. */
export const CODEX_INSPECT_LIMIT = 200;
/** The most of Codex's thread-name index read. */
export const CODEX_INDEX_BYTES = 2 * 1024 * 1024;
/**
 * Versions whose storage was measured. Claude Code: major 2 (projects/<folder>/<session>.jsonl, a `user` line with the
 * prompt and `cwd`). Codex CLI: 0.159.x (sessions/YYYY/MM/DD/rollout-*-<id>.jsonl with a session_meta first line, and
 * session_index.jsonl with thread names). Anything else fails closed.
 */
export const CLAUDE_VERIFIED = /^2\.\d+\.\d+$/, CODEX_VERIFIED = /^0\.159\.\d+$/;

/** The output of a command, or why there is none. Never stderr, never an exception's text. */
export type CommandResult = { ok: true; stdout: string } | { ok: false; reason: 'not-found' | 'failed' | 'timeout' | 'output-limit' };
/**
 * Runs `program` with a fixed argv: no shell, stdin ignored, stdout capped at `maxBytes` (stderr counted toward it and
 * dropped), killed after `timeoutMs`.
 */
export function runBounded(program: Program, args: readonly string[], timeoutMs = VERSION_TIMEOUT_MS, maxBytes = VERSION_MAX_BYTES): Promise<CommandResult> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(program.file, [...program.prefix, ...args], { stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } }); }
    catch { resolve({ ok: false, reason: 'failed' }); return; }
    let settled = false, bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (result: CommandResult) => { if (settled) return; settled = true; clearTimeout(timer); chunks.length = 0; resolve(result); };
    const stop = (reason: 'timeout' | 'output-limit') => { try { child.kill('SIGKILL'); } catch { /* Gone. */ } finish({ ok: false, reason }); };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const collect = (chunk: Buffer, keep: boolean) => { if (settled) return; bytes += chunk.length; if (bytes > maxBytes) { stop('output-limit'); return; } if (keep) chunks.push(chunk); };
    child.stdout!.on('data', (chunk: Buffer) => collect(chunk, true));
    child.stderr!.on('data', (chunk: Buffer) => collect(chunk, false));
    child.on('error', (error: NodeJS.ErrnoException) => finish({ ok: false, reason: error.code === 'ENOENT' ? 'not-found' : 'failed' }));
    child.on('close', code => finish(code === 0 ? { ok: true, stdout: Buffer.concat(chunks).toString('utf8') } : { ok: false, reason: 'failed' }));
  });
}

/** `claude --version` prints `2.1.289 (Claude Code)`; only the version is kept. */
export function parseClaudeVersion(output: string): string | null {
  return /^(\d+\.\d+\.\d+) \(Claude Code\)\s*$/.exec(output.split(/\r?\n/)[0] ?? '')?.[1] ?? null;
}
/** `codex --version` prints `codex-cli 0.159.2`. */
export function parseCodexVersion(output: string): string | null {
  return /^codex-cli (\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)\s*$/.exec(output.split(/\r?\n/)[0] ?? '')?.[1] ?? null;
}

/** Text from a harness's storage as the page may show it: one line, no control, format or bidi characters, capped. */
/**
 * Characters that render as nothing (or as a blank) and so can hide in text a person reads: every
 * Default_Ignorable_Code_Point (zero-width and bidi controls, the combining grapheme joiner, the Hangul and Khmer
 * fillers, variation selectors, tags), and the blank Braille pattern.
 */
export const RENDERS_BLANK = /[\p{Default_Ignorable_Code_Point}⠀]/u;
export function plainText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\p{Default_Ignorable_Code_Point}⠀]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const points = Array.from(text);
  return points.length <= limit ? text : `${points.slice(0, limit - 1).join('').trimEnd()}…`;
}
/** A working folder's last segment, whichever separators it was written with; never the rest of the path. */
export function folderLabel(cwd: unknown): string | null {
  if (typeof cwd !== 'string') return null;
  const last = cwd.split(/[\\/]+/).filter(Boolean).at(-1);
  return last === undefined ? null : plainText(last, FOLDER_CODE_POINTS);
}
/**
 * A prompt as a title: harness markup (<command-name>, <system-reminder>, <environment_context>, ...) and its contents
 * dropped, then the first line of what is left. Undefined when nothing is left (the line was all markup).
 */
export function promptTitle(prompt: unknown): string | undefined {
  if (typeof prompt !== 'string') return undefined;
  // One pass, never a backtracking regex over the prompt: harness wrappers are named with a - or _ (command-name,
  // system-reminder, environment_context) and are skipped whole, in one jump to their end; one left open drops the rest.
  const text = prompt.slice(0, PROMPT_SCAN_CHARS), tag = /<(\/?)([A-Za-z][\w-]{0,63})[^<>]{0,256}?(\/?)>/y;
  let out = '', at = 0;
  while (at < text.length && out.length < TITLE_SOURCE_CHARS) {
    const open = text.indexOf('<', at);
    if (open < 0) { out += text.slice(at); break; }
    out += text.slice(at, open);
    tag.lastIndex = open;
    const m = tag.exec(text);
    if (!m) { out += '<'; at = open + 1; continue; }
    at = tag.lastIndex; out += ' ';
    if (!m[1] && !m[3] && /[-_]/.test(m[2])) {
      const close = text.indexOf(`</${m[2]}>`, at);
      if (close < 0) break;
      at = close + m[2].length + 3;
    }
  }
  const line = out.slice(0, TITLE_SOURCE_CHARS).split(/\r?\n/).map(l => l.trim()).find(Boolean);
  return plainText(line, TITLE_CODE_POINTS) ?? undefined;
}

/** At most `limit` bytes from the start of a file, as whole lines (a line cut at the limit is dropped). */
export function headLines(path: string, limit = HEAD_BYTES): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(limit), read = readSync(fd, buffer, 0, limit, 0);
    const text = buffer.subarray(0, read).toString('utf8'), lines = text.split('\n');
    if (read === limit) lines.pop();
    return lines.filter(line => line.trim());
  } catch { return []; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* Closed. */ } }
}
const parse = (line: string): any => { try { return JSON.parse(line); } catch { return undefined; } };
const mtime = (path: string) => { try { return statSync(path).mtimeMs; } catch { return undefined; } };

/** The text of a user message: a string, or the text parts of a content list (never a tool result). */
function messageText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.filter(p => p && typeof p === 'object' && (p.type === 'text' || p.type === 'input_text') && typeof p.text === 'string').map(p => p.text as string);
  return parts.length ? parts.join('\n') : undefined;
}

/**
 * Claude Code sessions across every project folder, newest first (by the transcript's last write), at most `limit`.
 * The project folders' names encode a path lossily, so the folder label comes from the `cwd` the transcript records.
 */
export function listClaudeSessions(configDir = claudeConfigDir(), limit = SESSION_LIMIT): { sessions: HarnessSession[]; truncated: boolean } {
  const projects = join(configDir, 'projects');
  let folders: string[]; try { folders = readdirSync(projects); } catch { return { sessions: [], truncated: false }; }
  const found: { id: string; file: string; at: number }[] = [];
  for (const folder of folders) {
    // A project folder's name is already encoded (letters, digits and -), so it encodes to itself.
    if (!/^[A-Za-z0-9-]+$/.test(folder)) continue;
    const dir = claudeProjectDir(folder, configDir);
    for (const id of recentClaudeSessions(folder, { configDir, withinMs: Number.MAX_SAFE_INTEGER })) {
      const file = join(dir, `${id}.jsonl`), at = mtime(file);
      if (at !== undefined) found.push({ id, file, at });
    }
  }
  found.sort((a, b) => b.at - a.at);
  const sessions = found.slice(0, limit).map(({ id, file, at }) => {
    let title: string | undefined, cwd: unknown;
    for (const line of headLines(file)) {
      const entry = parse(line);
      if (!entry || typeof entry !== 'object') continue;
      if (cwd === undefined && typeof entry.cwd === 'string') cwd = entry.cwd;
      if (entry.type !== 'user' || entry.isMeta === true || entry.isSidechain === true) continue;
      title = promptTitle(messageText(entry.message?.content));
      if (title) break;
    }
    return { id, title: title ?? null, folder: folderLabel(cwd), lastActiveAt: new Date(at).toISOString() };
  });
  return { sessions, truncated: found.length > limit };
}

/** Codex's own thread names (session_index.jsonl: id, thread_name, updated_at), the newest entry for each id winning. */
function codexThreadNames(codexHome: string) {
  const names = new Map<string, string>();
  for (const line of headLines(join(codexHome, 'session_index.jsonl'), CODEX_INDEX_BYTES)) {
    const entry = parse(line);
    if (typeof entry?.id === 'string' && typeof entry.thread_name === 'string') names.set(entry.id, entry.thread_name);
  }
  return names;
}
/**
 * Codex threads (the CLI's and the Codex app's: one store), newest first by the rollout's last write, at most `limit`.
 * Threads a subagent ran (session_meta.source.subagent) are left out: they belong to another thread. Title: Codex's own
 * thread name, else the first user message that isn't Codex's own context.
 */
export function listCodexThreads(codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), limit = SESSION_LIMIT): { sessions: HarnessSession[]; truncated: boolean } {
  const files: { id: string; file: string; at: number }[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: Dirent[]; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (depth < 3) walk(path, depth + 1); continue; }
      const id = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(entry.name)?.[1];
      const at = entry.isFile() && id ? mtime(path) : undefined;
      if (id && at !== undefined) files.push({ id, file: path, at });
    }
  };
  walk(join(codexHome, 'sessions'), 0);
  files.sort((a, b) => b.at - a.at);
  const names = codexThreadNames(codexHome), sessions: HarnessSession[] = [], seen = new Set<string>();
  let more = false;
  for (const { id, file, at } of files.slice(0, CODEX_INSPECT_LIMIT)) {
    if (seen.has(id)) continue;
    const lines = headLines(file), meta = parse(lines[0] ?? '');
    if (meta?.type !== 'session_meta' || !meta.payload || typeof meta.payload !== 'object') continue;
    const source = meta.payload.source;
    if (source && typeof source === 'object' && 'subagent' in source) continue;
    if (sessions.length >= limit) { more = true; break; }
    seen.add(id);
    let title = plainText(names.get(id), TITLE_CODE_POINTS) ?? undefined;
    for (const line of title ? [] : lines.slice(1)) {
      const entry = parse(line);
      const user = entry?.type === 'response_item' && entry.payload?.type === 'message' && entry.payload.role === 'user' ? messageText(entry.payload.content)
        : entry?.type === 'event_msg' && entry.payload?.type === 'user_message' ? entry.payload.message : undefined;
      title = promptTitle(user);
      if (title) break;
    }
    sessions.push({ id, title: title ?? null, folder: folderLabel(meta.payload.cwd), lastActiveAt: new Date(at).toISOString() });
  }
  return { sessions, truncated: more || (files.length > CODEX_INSPECT_LIMIT && sessions.length >= limit) };
}

/** What the scan needs from the machine; tests give fakes. */
export type ScanDeps = {
  /** resolveProgram: throws when the program isn't on PATH (or is a batch file only a shell could run). */
  resolve(name: string): Program;
  run(program: Program, args: readonly string[]): Promise<CommandResult>;
  hermes: HermesRunner;
  claudeDir: string;
  codexHome: string;
};
export const machineScanDeps = (): ScanDeps => ({
  resolve: name => resolveProgram(name),
  run: (program, args) => runBounded(program, args),
  hermes: args => runHermesCommand(args, () => resolveProgram('hermes')),
  claudeDir: claudeConfigDir(),
  codexHome: process.env.CODEX_HOME || join(homedir(), '.codex'),
});

async function versionOf(deps: ScanDeps, name: string, parseVersion: (output: string) => string | null) {
  let program: Program;
  try { program = deps.resolve(name); } catch { return { found: false as const }; }
  let result: CommandResult;
  try { result = await deps.run(program, ['--version']); } catch { result = { ok: false, reason: 'failed' }; }
  if (!result.ok) return { found: result.reason !== 'not-found', failed: true as const };
  return { found: true as const, version: parseVersion(result.stdout) };
}
async function scanVersioned(deps: ScanDeps, harness: 'claude' | 'codex'): Promise<HarnessScan> {
  const base = { harness, label: HARNESS_LABELS[harness] };
  const probe = await versionOf(deps, harness, harness === 'claude' ? parseClaudeVersion : parseCodexVersion);
  if (!probe.found) return { ...base, detected: false, sessionsAvailable: false, reason: 'not-found' };
  if ('failed' in probe) return { ...base, detected: true, sessionsAvailable: false, reason: 'version-command-failed' };
  const verified = probe.version !== null && (harness === 'claude' ? CLAUDE_VERIFIED : CODEX_VERIFIED).test(probe.version);
  return { ...base, detected: true, ...(probe.version ? { version: probe.version } : {}), sessionsAvailable: verified, ...(verified ? {} : { reason: 'unsupported-version' as const }) };
}
async function scanHermes(deps: ScanDeps) {
  const found = await detectHermes(deps.hermes);
  const scan: HarnessScan = { harness: 'hermes', label: HARNESS_LABELS.hermes, detected: found.detected, ...(found.detected && found.version ? { version: found.version } : {}),
    sessionsAvailable: found.sessionsAvailable, ...(!found.sessionsAvailable ? { reason: found.reason } : {}) };
  return { scan, found };
}

/** Every harness, scanned at once: what is installed, its version, and whether its sessions can be listed. */
export async function scanHarnesses(deps: ScanDeps = machineScanDeps()): Promise<HarnessScan[]> {
  const [claude, codex, hermes] = await Promise.all([scanVersioned(deps, 'claude'), scanVersioned(deps, 'codex'), scanHermes(deps)]);
  return [claude, codex, hermes.scan, { harness: 'exec', label: HARNESS_LABELS.exec, detected: true, sessionsAvailable: false, reason: 'custom-command' }];
}

/** The sessions of one harness, or why there are none to list (its scan's reason). */
export async function listSessions(harness: HarnessId, deps: ScanDeps = machineScanDeps(), scanned?: HarnessScan): Promise<SessionListing> {
  if (harness === 'exec') return { harness, sessionsAvailable: false, reason: 'custom-command', sessions: [], truncated: false };
  if (harness === 'hermes') {
    const { scan, found } = await scanHermes(deps);
    if (!found.sessionsAvailable) return { harness, sessionsAvailable: false, ...(scan.reason ? { reason: scan.reason } : {}), sessions: [], truncated: false };
    return { harness, sessionsAvailable: true, truncated: found.truncated,
      sessions: found.sessions.map(s => ({ id: s.id, title: plainText(s.title, TITLE_CODE_POINTS), folder: plainText(s.workspaceLabel, FOLDER_CODE_POINTS), lastActiveAt: null, lastActiveLabel: s.lastActiveLabel })) };
  }
  const scan = scanned ?? await scanVersioned(deps, harness);
  if (!scan.sessionsAvailable) return { harness, sessionsAvailable: false, ...(scan.reason ? { reason: scan.reason } : {}), sessions: [], truncated: false };
  const listed = harness === 'claude' ? listClaudeSessions(deps.claudeDir) : listCodexThreads(deps.codexHome);
  return { harness, sessionsAvailable: true, ...listed };
}

/**
 * Where an existing session works, for binding it after the person approved: Claude Code resumes a session only from its
 * own folder, which its transcript records. Server-side only; never handed to the page.
 */
export function claudeSessionFolder(id: string, configDir = claudeConfigDir()): string | undefined {
  const projects = join(configDir, 'projects');
  let folders: string[]; try { folders = readdirSync(projects); } catch { return undefined; }
  for (const folder of folders) {
    const file = join(projects, folder, `${id}.jsonl`);
    if (!existsSync(file)) continue;
    for (const line of headLines(file)) { const cwd = parse(line)?.cwd; if (typeof cwd === 'string') return cwd; }
    return undefined;
  }
  return undefined;
}

/** When a file was made: its birth time where the system keeps one, else its last write (never later than its birth). */
const madeAt = (path: string) => { try { const s = statSync(path); return s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs; } catch { return undefined; } };
/** Slack for clocks and file systems when telling whether something was made by a run that started at `since`. */
export const FRESH_SLACK_MS = 2_000;
const sameFolder = (a: string, b: string) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
/**
 * The Codex thread a run made: the newest rollout made since `since` whose session_meta says it works in `cwd` (the
 * room's wake folder) and that no subagent ran. Never the id a run printed: a model can print any id.
 */
export function freshCodexThread(cwd: string, since: number, codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')): string | undefined {
  let best: { id: string; at: number } | undefined;
  const walk = (dir: string, depth: number) => {
    let entries: Dirent[]; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (depth < 3) walk(path, depth + 1); continue; }
      const id = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(entry.name)?.[1], at = id && entry.isFile() ? madeAt(path) : undefined;
      if (!id || at === undefined || at < since - FRESH_SLACK_MS || (best && at <= best.at)) continue;
      const meta = parse(headLines(path)[0] ?? '');
      const source = meta?.payload?.source;
      if (meta?.type === 'session_meta' && meta.payload?.id === id && typeof meta.payload.cwd === 'string' && sameFolder(meta.payload.cwd, cwd)
        && !(source && typeof source === 'object' && 'subagent' in source)) best = { id, at };
    }
  };
  walk(join(codexHome, 'sessions'), 0);
  return best?.id;
}
/** Whether Claude Code made session `id` in `cwd` since `since`: its transcript is in that folder's project and new. */
export function freshClaudeSession(id: string, cwd: string, since: number, configDir = claudeConfigDir()) {
  const at = madeAt(join(claudeProjectDir(resolve(cwd), configDir), `${id}.jsonl`));
  return at !== undefined && at >= since - FRESH_SLACK_MS;
}
/**
 * Whether a Hermes session id was made between `since` and `until`: its id starts with the local time it was made
 * (<YYYYMMDD>_<HHMMSS>_<hex>), so a run that resumed an older session reports an older id.
 */
export function hermesIdFresh(id: string, since: number, until: number) {
  const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_[0-9a-f]+$/.exec(id);
  if (!m) return false;
  const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return at >= Math.floor(since / 1000) * 1000 - FRESH_SLACK_MS && at <= until + FRESH_SLACK_MS;
}

/**
 * The scan as the daemon serves it: one scan (or listing) at a time per harness, and a result kept for `ttlMs`, so a page
 * that asks often never starts more than a few `--version` processes a minute.
 */
export function harnessScanner(deps: () => ScanDeps = machineScanDeps, ttlMs = 30_000, now: () => number = Date.now) {
  let scan: { at: number; value: Promise<HarnessScan[]> } | undefined;
  const listings = new Map<HarnessId, { at: number; value: Promise<SessionListing> }>();
  const fresh = (entry: { at: number } | undefined) => !!entry && now() - entry.at < ttlMs;
  const scanAll = () => {
    if (!fresh(scan)) {
      const value = scanHarnesses(deps());
      scan = { at: now(), value };
      // A failure isn't kept: the next ask scans again.
      value.catch(() => { if (scan?.value === value) scan = undefined; });
    }
    return scan!.value;
  };
  return {
    scan: scanAll,
    async sessions(harness: HarnessId) {
      const known = listings.get(harness);
      if (fresh(known)) return known!.value;
      const value = (async () => listSessions(harness, deps(), harness === 'claude' || harness === 'codex' ? (await scanAll()).find(s => s.harness === harness) : undefined))();
      listings.set(harness, { at: now(), value });
      value.catch(() => { if (listings.get(harness)?.value === value) listings.delete(harness); });
      return value;
    },
  };
}
