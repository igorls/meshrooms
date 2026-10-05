import { spawn } from 'node:child_process';
import type { Program } from '../agent-watch';

/** Read-only CLI adapter; no storage fallback, resume, config changes, logging or persistence.
 * Only this measured build is admitted: version 0.21.5 alone does not prove the CLI is read-only.
 * Its list command opens SessionDB(read_only=True). New builds require a fresh schema/RO probe.
 * Metadata is private: callers must send it only over the paired person's ephemeral channel,
 * never log it, and render title/workspaceLabel as plain text (not HTML/Markdown).
 */
export const HERMES_VERIFIED_BUILD = '0.21.5+6489.gf4d3e62';
export const HERMES_SESSION_LIMIT = 20;
export const HERMES_TIMEOUT_MS = 30_000;
export const HERMES_MAX_OUTPUT_BYTES = 128 * 1024;
const HEADER = 'Title                        Workspace          Last Active   ID';
const RULE = '─'.repeat(110);

export interface HermesSession {
  harness: 'hermes';
  id: string;
  /** CLI already truncates to 26 Unicode code points. Not a unique title. */
  title: string | null;
  /** CLI basename truncated to 16 code points; NEVER a cwd or canonical workspace key. */
  workspaceLabel: string | null;
  /** Display label only; CLI does not expose an exact timestamp. '?' becomes null. */
  lastActiveLabel: string | null;
}
export type HermesListing = { sessions: HermesSession[]; truncated: boolean };
export type HermesUnavailableReason = 'version-command-failed' | 'unsupported-version' | 'listing-command-failed' | 'unsupported-schema';
export type HermesDetection =
  | { harness: 'hermes'; detected: false; sessionsAvailable: false; reason: 'not-found' | 'version-command-failed' }
  | { harness: 'hermes'; detected: true; version: string | null; sessionsAvailable: false; reason: HermesUnavailableReason }
  | { harness: 'hermes'; detected: true; version: string; sessionsAvailable: true } & HermesListing;

/** Transport errors contain no raw stderr, command exception, session data or install path. */
export type HermesCommandResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: 'not-found' | 'failed' | 'timeout' | 'output-limit' };
export type HermesRunner = (args: readonly string[]) => Promise<HermesCommandResult>;

export function parseHermesVersion(output: string): string | null {
  if (Buffer.byteLength(output, 'utf8') > HERMES_MAX_OUTPUT_BYTES) return null;
  // Ignore diagnostic lines (which include an absolute install path), never return them.
  const match = /^Hermes Agent v(\d+\.\d+\.\d+(?:\+[A-Za-z0-9.-]+)?)(?: \([^\r\n]*\))?(?: · upstream [0-9a-f]+)?$/.exec(output.split(/\r?\n/)[0]);
  return match?.[1] ?? null;
}

/** Fixed Python code-point widths, NOT whitespace splitting (titles contain spaces/emoji).
 * Any bad row invalidates the whole response; no partially guessed sessions escape.
 * Preview-bearing/no-title layouts intentionally fail closed rather than returning prompt content.
 */
export function parseHermesSessions(output: string): HermesListing | null {
  if (Buffer.byteLength(output, 'utf8') > HERMES_MAX_OUTPUT_BYTES || /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/.test(output)) return null;
  const lines = output.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 1 && lines[0] === 'No sessions found.') return { sessions: [], truncated: false };
  if (lines[0] !== HEADER || lines[1] !== RULE) return null;
  let truncated = false;
  if (lines.at(-1) === '  … more not shown (use --limit 40 to see more)') {
    truncated = true;
    lines.pop();
  }
  const rows = lines.slice(2);
  if (!rows.length || rows.length > HERMES_SESSION_LIMIT || (truncated && rows.length !== HERMES_SESSION_LIMIT)) return null;
  const sessions: HermesSession[] = [];
  const ids = new Set<string>();
  for (const row of rows) {
    const chars = Array.from(row);
    if (chars.length !== 84 || chars[28] !== ' ' || chars[47] !== ' ' || chars[61] !== ' ') return null;
    const titleCell = chars.slice(0, 28).join('');
    const workspaceCell = chars.slice(29, 47).join('');
    const activeCell = chars.slice(48, 61).join('');
    const title = titleCell.trimEnd(), workspace = workspaceCell.trimEnd(), active = activeCell.trimEnd();
    const id = chars.slice(62).join('');
    // Retain identifiers literally; do not normalize or repair them.
    if (!/^\d{8}_\d{6}_[0-9a-f]{6}$/.test(id) || ids.has(id)) return null;
    if (!title || Array.from(title).length > 26 || !workspace || Array.from(workspace).length > 16) return null;
    if (/[\/\\:]/.test(workspace) || workspace === '.' || workspace === '..') return null;
    // Reject invisible/bidi formatting; strings remain untrusted plain text even after this gate.
    if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(title + workspace)) return null;
    if (!/^(?:\?|just now|yesterday|[0-9]{1,2}[mhd] ago|\d{4}-\d{2}-\d{2})$/.test(active)) return null;
    ids.add(id);
    sessions.push({ harness: 'hermes', id, title: title === '—' ? null : title,
      workspaceLabel: workspace === '—' ? null : workspace, lastActiveLabel: active === '?' ? null : active });
  }
  return { sessions, truncated };
}

/** Fixed executable + argv, no shell, ignored stdin; bounded stdout AND stderr and hard kill.
 * stderr is discarded, including corrupt-timestamp warnings that can contain real IDs.
 * The selected HERMES_HOME/profile environment is inherited; do not mix different profiles' IDs.
 * `program`: how to start hermes, found first with resolveProgram, so a Windows install (hermes.exe, or an npm .cmd
 * shim, which only a shell could run) is started without a shell too. One that isn't found is `not-found`.
 */
export const runHermesCommand = (args: readonly string[], program?: () => Program): Promise<HermesCommandResult> => new Promise(resolve => {
  if (JSON.stringify(args) !== JSON.stringify(['--version'])
    && JSON.stringify(args) !== JSON.stringify(['sessions', 'list', '--limit', String(HERMES_SESSION_LIMIT)])) {
    resolve({ ok: false, reason: 'failed' }); return;
  }
  let found: Program;
  try { found = program ? program() : { file: 'hermes', prefix: [] }; } catch { resolve({ ok: false, reason: 'not-found' }); return; }
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(found.file, [...found.prefix, ...args], { stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', LANG: 'C.UTF-8' } });
  } catch { resolve({ ok: false, reason: 'failed' }); return; }
  let settled = false, bytes = 0;
  const chunks: Buffer[] = [];
  const finish = (result: HermesCommandResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    chunks.length = 0;
    resolve(result);
  };
  const stop = (reason: 'timeout' | 'output-limit') => {
    child.kill('SIGKILL');
    finish({ ok: false, reason });
  };
  const timer = setTimeout(() => stop('timeout'), HERMES_TIMEOUT_MS);
  const collect = (chunk: Buffer, keep: boolean) => {
    if (settled) return;
    bytes += chunk.length;
    if (bytes > HERMES_MAX_OUTPUT_BYTES) { stop('output-limit'); return; }
    if (keep) chunks.push(chunk);
  };
  child.stdout!.on('data', (chunk: Buffer) => collect(chunk, true));
  child.stderr!.on('data', (chunk: Buffer) => collect(chunk, false));
  child.on('error', (error: NodeJS.ErrnoException) => finish({ ok: false, reason: error.code === 'ENOENT' ? 'not-found' : 'failed' }));
  child.on('close', code => finish(code === 0
    ? { ok: true, stdout: Buffer.concat(chunks).toString('utf8') }
    : { ok: false, reason: 'failed' }));
});

/** Explicit caller request only: never auto-resume or enumerate every profile. */
export async function detectHermes(runner: HermesRunner = args => runHermesCommand(args)): Promise<HermesDetection> {
  let probe: HermesCommandResult;
  try { probe = await runner(['--version']); }
  catch { return { harness: 'hermes', detected: false, sessionsAvailable: false, reason: 'version-command-failed' }; }
  if (!probe.ok) return { harness: 'hermes', detected: false, sessionsAvailable: false,
    reason: probe.reason === 'not-found' ? 'not-found' : 'version-command-failed' };
  const version = parseHermesVersion(probe.stdout);
  if (version !== HERMES_VERIFIED_BUILD) return { harness: 'hermes', detected: true, version, sessionsAvailable: false, reason: 'unsupported-version' };
  let list: HermesCommandResult;
  try { list = await runner(['sessions', 'list', '--limit', String(HERMES_SESSION_LIMIT)]); }
  catch { return { harness: 'hermes', detected: true, version, sessionsAvailable: false, reason: 'listing-command-failed' }; }
  if (!list.ok) return { harness: 'hermes', detected: true, version, sessionsAvailable: false, reason: 'listing-command-failed' };
  const parsed = parseHermesSessions(list.stdout);
  return parsed ? { harness: 'hermes', detected: true, version, sessionsAvailable: true, ...parsed }
    : { harness: 'hermes', detected: true, version, sessionsAvailable: false, reason: 'unsupported-schema' };
}
