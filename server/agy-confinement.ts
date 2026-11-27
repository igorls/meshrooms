/**
 * Confinement for headless Antigravity CLI (`agy -p`) wakes via workspace PreToolUse hooks.
 *
 * Antigravity CLI does not offer a CLI-flag per-command allowlist like Claude Code's `--allowedTools`,
 * so Meshrooms writes `<wakeDir>/.agents/hooks.json` before every wake pointing back to this bridge's
 * `agy-hook` subcommand. Under default `permission_mode: "request-review"`, the hook:
 * - returns `{ "decision": "auto_approve" }` ONLY for:
 *   1. `run_command` executing `bun "<launcher>" <wake-subcommand> ... --room <roomId>` (with no shell
 *      chaining, pipes, redirections, variable expansion or substitutions; optional exact per-wake
 *      single-quoted heredoc `<<'<delimiter>'` for stdin text), and
 *   2. `view_file` reading a file strictly inside `wakeDir` (excluding `.agents/`).
 * - returns `{ "decision": "deny", "reason": "..." }` for EVERY other tool or argument shape.
 *
 * Fail-closed everywhere: malformed stdin, missing policy flags, symlink escapes or unknown tools all deny.
 */
import { mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { AGY_ALLOWED_TOOLS, WAKE_COMMANDS, launcherPath, nonAgyRoomTools, writeFresh } from './agent-watch';

export { AGY_ALLOWED_TOOLS, nonAgyRoomTools };

export type AgyHookPolicy = {
  roomId: string;
  launcher: string;
  wakeDir: string;
  delimiter?: string;
};

export type AgyHookDecision =
  | { decision: 'auto_approve' }
  | { decision: 'deny'; reason: string };

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DELIMITER_RE = /^[A-Za-z0-9_-]{8,128}$/;
const WAKE_SUBCOMMANDS = new Set<string>(WAKE_COMMANDS);
const STDIN_FLAGS = new Set(['--text', '--notes', '--comment', '--question', '--context', '--patch']);
const PATH_FLAGS = new Set(['--attach', '--out', '--text-file', '--notes-file', '--comment-file', '--question-file', '--context-file', '--plan-file', '--patch-file']);
const isPathFlag = (flag: string) => PATH_FLAGS.has(flag) || (flag.startsWith('--') && flag.endsWith('-file'));

const deny = (reason: string): AgyHookDecision => ({ decision: 'deny', reason });

/** Canonical path resolution that follows symlinks when the target (or its parent) exists. */
function canonical(path: string, platform = process.platform): string {
  const full = resolve(path);
  let resolved = full;
  try {
    resolved = realpathSync.native(full);
  } catch {
    // Target may not exist yet (e.g. `--out` destination): resolve its nearest existing ancestor so symlinks can't escape.
    const parts: string[] = [];
    let cursor = full;
    for (;;) {
      const parent = resolve(cursor, '..');
      if (parent === cursor) break;
      parts.unshift(cursor.slice(parent.endsWith(sep) ? parent.length : parent.length + 1));
      cursor = parent;
      try {
        resolved = join(realpathSync.native(cursor), ...parts);
        break;
      } catch { /* Keep walking up. */ }
    }
  }
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Whether `target` resolves strictly inside `wakeDir` (and NOT inside `.agents`). */
export function insideAgyWakeDir(target: string, wakeDir: string, allowRoot = false, platform = process.platform): boolean {
  if (!target || target.includes('\0')) return false;
  const base = canonical(wakeDir, platform);
  const full = canonical(isAbsolute(target) ? target : resolve(wakeDir, target), platform);
  const basePrefix = base.endsWith(sep) ? base : base + sep;
  if (full === base) return allowRoot;
  if (!full.startsWith(basePrefix)) return false;
  const agentsDir = canonical(join(wakeDir, '.agents'), platform);
  const agentsPrefix = agentsDir.endsWith(sep) ? agentsDir : agentsDir + sep;
  return full !== agentsDir && !full.startsWith(agentsPrefix);
}

/**
 * Splits a single shell command line into words while forbidding every shell metacharacter,
 * operator, expansion, substitution, glob or redirection.
 */
function tokenizeSafeCommand(line: string, platform = process.platform): string[] | { error: string } {
  const words: string[] = [];
  let word = '', quote: "'" | '"' | null = null, started = false;
  const forbiddenUnquoted = /[;&|<>`$(){}*?[\]~\\#\r\n\0]/;
  const forbiddenDouble = /[`$\\\r\n\0]/;
  const forbiddenSingle = /[\r\n\0]/;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === "'") {
      if (ch === "'") { quote = null; continue; }
      if (forbiddenSingle.test(ch)) return { error: 'Control characters are not allowed in wake commands.' };
      word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') { quote = null; continue; }
      // A Windows path is full of backslashes (the prompt names the wake folder in its native spelling), and none of
      // Windows' shells treats one as an escape inside double quotes. A Bourne-style shell would, before a quote or
      // another backslash, so those two stay refused: no quote can then end early in one reading and not in the other.
      if (ch === '\\' && platform === 'win32' && i + 1 < line.length && line[i + 1] !== '"' && line[i + 1] !== '\\') { word += ch; continue; }
      if (forbiddenDouble.test(ch)) return { error: 'Shell expansion and escape characters are not allowed in wake commands.' };
      word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (ch === ' ' || ch === '\t') {
      if (started) { words.push(word); word = ''; started = false; }
      continue;
    }
    if (forbiddenUnquoted.test(ch)) return { error: `Shell operator or metacharacter '${ch}' is not allowed in wake commands.` };
    word += ch;
    started = true;
  }
  if (quote !== null) return { error: 'Unclosed quote in wake command.' };
  if (started) words.push(word);
  return words;
}

/** Validates a `run_command` invocation against the wake policy. */
export function checkAgyCommand(commandLine: string, policy: AgyHookPolicy, cwd?: string, platform = process.platform): { ok: true } | { ok: false; reason: string } {
  if (typeof commandLine !== 'string' || !commandLine.trim()) return { ok: false, reason: 'Empty command.' };
  if (commandLine.includes('\0') || commandLine.includes('\r')) return { ok: false, reason: 'Control characters are not allowed in wake commands.' };
  if (cwd !== undefined && cwd !== '') {
    if (!insideAgyWakeDir(cwd, policy.wakeDir, true)) return { ok: false, reason: 'Wake commands must run inside the room wake folder.' };
  }

  let header = commandLine.trim();
  let usedHeredoc = false;

  if (commandLine.includes('\n')) {
    if (!policy.delimiter || !DELIMITER_RE.test(policy.delimiter)) {
      return { ok: false, reason: 'Multi-line commands are only allowed with the wake heredoc delimiter.' };
    }
    const lines = commandLine.split('\n');
    const firstLine = lines[0].trim();
    const heredocSuffix = `<<'${policy.delimiter}'`;
    if (!firstLine.endsWith(heredocSuffix)) {
      return { ok: false, reason: `Multi-line wake commands must end line 1 with ${heredocSuffix}.` };
    }
    // Drop optional single trailing empty line after the closing delimiter.
    const trimmedLines = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
    if (trimmedLines.length < 2 || trimmedLines[trimmedLines.length - 1] !== policy.delimiter) {
      return { ok: false, reason: 'Multi-line wake command must end with the exact wake heredoc delimiter on its own line.' };
    }
    const bodyLines = trimmedLines.slice(1, -1);
    if (bodyLines.some(line => line === policy.delimiter)) {
      return { ok: false, reason: 'Heredoc body may not contain the wake delimiter on its own line.' };
    }
    header = firstLine.slice(0, firstLine.length - heredocSuffix.length).trim();
    usedHeredoc = true;
  }

  const tokens = tokenizeSafeCommand(header, platform);
  if (!Array.isArray(tokens)) return { ok: false, reason: tokens.error };
  if (tokens.length < 3) return { ok: false, reason: 'Only Meshrooms bridge wake subcommands are allowed.' };

  const [prog, script, subcommand, ...rest] = tokens;
  if (prog !== 'bun' && prog !== 'bun.exe') return { ok: false, reason: 'Only bun running the Meshrooms launcher is allowed.' };
  if (launcherPath(script) !== launcherPath(policy.launcher)) return { ok: false, reason: 'Only the configured Meshrooms launcher path is allowed.' };
  if (!WAKE_SUBCOMMANDS.has(subcommand)) return { ok: false, reason: `Subcommand '${subcommand}' is not allowed during a wake.` };

  if (subcommand === 'help' || subcommand === 'version') {
    if (usedHeredoc || rest.length > 0) return { ok: false, reason: `'${subcommand}' takes no extra arguments during a wake.` };
    return { ok: true };
  }

  let seenRoom = false;
  let readsStdin = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--room') {
      const value = rest[++i];
      if (!value || value.toLowerCase() !== policy.roomId.toLowerCase()) {
        return { ok: false, reason: 'Wake commands may only act on this room.' };
      }
      seenRoom = true;
      continue;
    }
    if (arg.startsWith('--room=')) {
      const value = arg.slice('--room='.length);
      if (value.toLowerCase() !== policy.roomId.toLowerCase()) {
        return { ok: false, reason: 'Wake commands may only act on this room.' };
      }
      seenRoom = true;
      continue;
    }
    if (STDIN_FLAGS.has(arg) && rest[i + 1] === '-') {
      readsStdin = true;
      i++;
      continue;
    }
    if (isPathFlag(arg)) {
      const value = rest[++i];
      if (!value || !insideAgyWakeDir(value, policy.wakeDir, false)) {
        return { ok: false, reason: `Paths passed to ${arg} must stay inside the room wake folder.` };
      }
      continue;
    }
    const eqIdx = arg.indexOf('=');
    if (eqIdx > 2 && arg.startsWith('--')) {
      const flag = arg.slice(0, eqIdx);
      const value = arg.slice(eqIdx + 1);
      if (STDIN_FLAGS.has(flag) && value === '-') {
        readsStdin = true;
        continue;
      }
      if (isPathFlag(flag)) {
        if (!value || !insideAgyWakeDir(value, policy.wakeDir, false)) {
          return { ok: false, reason: `Paths passed to ${flag} must stay inside the room wake folder.` };
        }
        continue;
      }
    }
  }

  if (!seenRoom) return { ok: false, reason: 'Wake commands must specify --room for this room.' };
  if (usedHeredoc && !readsStdin) return { ok: false, reason: 'Heredoc input is only allowed with a stdin option such as --text -.' };
  return { ok: true };
}

/** Validates a `view_file` call against the wake policy. */
export function checkAgyViewFile(args: Record<string, unknown>, policy: AgyHookPolicy): { ok: true } | { ok: false; reason: string } {
  const raw = args.AbsolutePath ?? args.Path ?? args.path ?? args.file_path;
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'view_file requires a file path inside the room wake folder.' };
  if (!insideAgyWakeDir(raw, policy.wakeDir, false)) {
    return { ok: false, reason: 'Meshrooms wake confinement: view_file may only read files inside the room wake folder.' };
  }
  return { ok: true };
}

/** Evaluates a PreToolUse hook payload from `agy` against `policy`, failing closed on everything unrecognized. */
export function evaluateAgyHook(input: unknown, policy: AgyHookPolicy): AgyHookDecision {
  if (!policy.roomId || !UUID_RE.test(policy.roomId) || !policy.launcher || !policy.wakeDir) {
    return deny('Invalid Meshrooms wake hook policy.');
  }
  if (!input || typeof input !== 'object') return deny('Malformed PreToolUse hook payload.');
  const payload = input as Record<string, unknown>;
  const toolCall = (payload.toolCall && typeof payload.toolCall === 'object' ? payload.toolCall : undefined) as Record<string, unknown> | undefined;
  const toolName = typeof toolCall?.name === 'string'
    ? toolCall.name
    : typeof payload.tool_name === 'string'
      ? payload.tool_name
      : typeof payload.toolName === 'string'
        ? payload.toolName
        : undefined;
  const rawArgs = toolCall?.args ?? toolCall?.parameters ?? payload.tool_input ?? payload.parameters ?? payload.args;
  const toolArgs = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs as Record<string, unknown> : {};

  if (toolName === 'run_command') {
    const commandLine = typeof toolArgs.CommandLine === 'string'
      ? toolArgs.CommandLine
      : typeof toolArgs.commandLine === 'string'
        ? toolArgs.commandLine
        : typeof toolArgs.command === 'string'
          ? toolArgs.command
          : '';
    const cwd = typeof toolArgs.Cwd === 'string'
      ? toolArgs.Cwd
      : typeof toolArgs.cwd === 'string'
        ? toolArgs.cwd
        : undefined;
    const verdict = checkAgyCommand(commandLine, policy, cwd);
    return verdict.ok ? { decision: 'auto_approve' } : deny(verdict.reason);
  }

  if (toolName === 'view_file') {
    const verdict = checkAgyViewFile(toolArgs, policy);
    return verdict.ok ? { decision: 'auto_approve' } : deny(verdict.reason);
  }

  return deny(`Meshrooms wake confinement: tool '${toolName ?? 'unknown'}' is not allowed during a wake.`);
}

/** Quotes one argument safely for the shell Antigravity uses to run command hooks. */
function hookShellArg(value: string, platform = process.platform): string {
  if (platform === 'win32') return `"${value.replace(/"/g, '\\"')}"`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Writes `<wakeDir>/.agents/hooks.json` so `agy -p` evaluates every tool call through this bridge's
 * `agy-hook` policy before executing it.
 */
export function writeAgyWakeHooks(
  wakeDirPath: string,
  options: { bun?: string; launcher: string; roomId: string; delimiter?: string; platform?: NodeJS.Platform },
): string {
  const platform = options.platform ?? process.platform;
  const bun = options.bun ?? process.execPath;
  const args = [
    bun, '--no-env-file', launcherPath(options.launcher), 'agy-hook',
    '--room', options.roomId,
    '--launcher', launcherPath(options.launcher),
    '--wake-dir', resolve(wakeDirPath),
    ...(options.delimiter ? ['--delimiter', options.delimiter] : []),
  ];
  const command = args.map(part => hookShellArg(part, platform)).join(' ');
  const dir = join(wakeDirPath, '.agents');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'hooks.json');
  writeFresh(file, JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command,
              timeout: 15,
            },
          ],
        },
      ],
    },
  }, null, 2));
  return file;
}

/** CLI entry for `meshrooms agy-hook`: reads PreToolUse JSON on stdin, returns the hook decision object. */
export async function runAgyHookCli(values: Record<string, string>, stdin: () => Promise<string> = () => Bun.stdin.text()): Promise<AgyHookDecision> {
  try {
    const policy: AgyHookPolicy = {
      roomId: values['--room'] ?? '',
      launcher: values['--launcher'] ?? '',
      wakeDir: values['--wake-dir'] ?? '',
      ...(values['--delimiter'] ? { delimiter: values['--delimiter'] } : {}),
    };
    const raw = await stdin();
    const parsed = JSON.parse(raw);
    return evaluateAgyHook(parsed, policy);
  } catch {
    return deny('Meshrooms wake confinement: failed to parse hook input.');
  }
}
