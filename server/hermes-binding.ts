import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The per-room Hermes binding: which MCP server a room's wake is confined to, and the check that the
 * operator's own config actually points at that room.
 *
 * WHY THIS EXISTS. A Hermes wake is confined by naming a toolset (`--toolsets <server>`), and the tools
 * it can then call are whatever that server exposes. If the server it names belongs to ANOTHER room — or
 * to a different agent's folder — the wake looks correct and acts in the wrong place: it can post into a
 * room the operator is not watching, and it consumes that room's cursor. Two watchers on one machine make
 * this reachable, not theoretical.
 *
 * So the server name is per room, and before every wake the watcher reads the operator's config and
 * refuses if the entry is missing or its `--room`/`--agent-home` disagree with the room being watched.
 *
 * The watcher never WRITES the operator's config. It prints the exact block to add and stops. Rewriting
 * someone's config from a background process is a bigger hazard than the problem it solves.
 *
 * PARSING IS DELIBERATELY NARROW. The config is parsed with Bun's built-in YAML parser (no dependency), and
 * only the top-level `mcp_servers.<name>.args` is read. Anything it can't parse, a missing entry, args that
 * aren't a list of strings, or a repeated --room/--agent-home/--wake-dir all fail CLOSED and refuse the wake.
 * That is the safe direction: a false refusal is possible, a false ALLOW is not.
 */

/** The toolset/server name a room's wake is confined to: `meshrooms-<first 8 hex of the room id>`. */
export function roomToolsetName(roomId: string): string {
  const hex = roomId.replace(/-/g, '').slice(0, 8).toLowerCase();
  return `meshrooms-${hex}`;
}

/**
 * The `args` of `mcp_servers.<serverName>`, read from the config's TEXT.
 *
 * Uses Bun's built-in YAML parser (`Bun.YAML.parse`, measured present on bun 1.4.2), so there is no
 * dependency to add and no hand-rolled YAML to get subtly wrong. An earlier version of this function
 * parsed the block by indentation; that handled the shapes I thought of and quietly failed closed on
 * the rest, whereas a real parser handles the whole language.
 *
 * STILL FAIL-CLOSED. Every one of these refuses the wake:
 *   - the text does not parse;
 *   - there is no top-level `mcp_servers` mapping, or no entry for this server under it;
 *   - the entry has no `args`, or `args` is not an array of strings.
 * A refusal is recoverable — the operator gets the exact block to paste. A false ALLOW is not: it
 * would spend a wake against the wrong room.
 */
export function readMcpServerArgs(configText: string, serverName: string): { args?: string[]; problem?: string } {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(configText);
  } catch (err) {
    return { problem: `the config could not be parsed as YAML (${err instanceof Error ? err.message : String(err)})` };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { problem: 'the config did not parse to a mapping' };
  // I6: a duplicate entry is refused, because the parser last-wins silently and Hermes' own
  // parser does the same — so neither can tell us which one was meant.
  if (duplicateMcpServerKey(configText, serverName)) return { problem: `the config declares \\\`mcp_servers.${serverName}\\\` more than once` };
  // Top-level `mcp_servers` ONLY. A nested `mcp_servers` elsewhere is not the one Hermes reads.
  const servers = (doc as Record<string, unknown>).mcp_servers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return { problem: 'the config has no top-level `mcp_servers:` section' };
  const entry = (servers as Record<string, unknown>)[serverName];
  if (entry === undefined) return { problem: `the config has no \`mcp_servers.${serverName}\` entry` };
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { problem: `\`mcp_servers.${serverName}\` is not a mapping` };
  const args = (entry as Record<string, unknown>).args;
  if (args === undefined) return { args: [], problem: undefined };   // no args key: the check below refuses an empty list
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) {
    return { problem: `\`mcp_servers.${serverName}.args\` is not a list of strings` };
  }
  return { args: args as string[] };
}

/**
 * Split an argv-style list into flags and their values, LAST-WINS, which is what the server does.
 *
 * I1: this must match `agent-cli.ts`'s `args()`, which overwrites `values[flag]`, so `--room A ...
 * --room B` means B to the server. The binding check used a first-wins `indexOf`, so an entry could
 * pass the check for room A while the server pinned room B. `hermesBindingProblem` now REFUSES a
 * repeated flag outright, so the two can never disagree about which value wins, and this parser
 * reports the repeats so it can.
 */
export function parseArgs(args: readonly string[]): { values: Map<string, string>; repeated: string[] } {
  const values = new Map<string, string>();
  const repeated: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('--')) continue;
    const next = args[i + 1];
    // A flag consumes the next token unless it is itself a flag (or there is none).
    const value = next === undefined || next.startsWith('--') ? 'true' : next;
    if (next !== undefined && !next.startsWith('--')) i++;
    if (values.has(token)) repeated.push(token);
    values.set(token, value);   // last-wins, like the server
  }
  return { values, repeated };
}

/**
 * Why this server entry cannot serve a wake for `roomId`, or undefined when it is correct.
 *
 * A MISSING entry, a wrong `--room`, a missing or wrong `--agent-home`, a repeated flag, or an entry
 * that is present but has no args are all refusals. The `--agent-home` half matters because Hermes
 * filters the environment it passes to a stdio server, so the home must travel in the args; without it
 * the server reads the shared agents folder and refuses every file the wake was told to attach.
 */
export function hermesBindingProblem(args: readonly string[] | undefined, roomId: string, agentHome: string, wakeDir?: string): string | undefined {
  if (!args) return 'its entry could not be read';
  if (!args.length) return 'its entry has no args';
  // I1: a repeated flag is refused rather than interpreted. The check and the server could otherwise
  // read different values out of the same list, which is a binding check that agrees with itself and
  // not with reality.
  const { values, repeated } = parseArgs(args);
  if (repeated.length) return `its args pass ${[...new Set(repeated)].join(', ')} more than once, so which value wins would depend on the reader`;
  const room = values.get('--room');
  if (room === undefined) return 'its args do not pass --room';
  if (room !== roomId) return `its args pass --room ${room}, but this watcher serves room ${roomId}`;
  const home = values.get('--agent-home');
  if (home === undefined) return 'its args do not pass --agent-home, so the server would read the shared agents folder instead of this agent\'s';
  if (home !== agentHome) return `its args pass --agent-home ${home}, but this agent\'s home is ${agentHome}`;
  // The wake folder is part of the binding too: a server pointed at another wake folder refuses every
  // file this wake's harness was told to write there.
  if (wakeDir !== undefined) {
    const dir = values.get('--wake-dir');
    if (dir !== undefined && dir !== wakeDir) return `its args pass --wake-dir ${dir}, but this watcher's wake folder is ${wakeDir}`;
  }
  return undefined;
}

/**
 * Hermes' config file, honouring `HERMES_HOME` the way Hermes itself does.
 *
 * I2: the check hardcoded `~/.hermes`, but the wake env deliberately KEEPS `HERMES_HOME` (it is where
 * the operator's config lives), so an operator who moves their Hermes home would have had the binding
 * check read a file the harness never sees — refusing every wake, or approving against a stale entry.
 * `homedir()` is only the fallback.
 */
export function hermesConfigPath(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  const base = env.HERMES_HOME && env.HERMES_HOME.trim() ? env.HERMES_HOME : join(home, '.hermes');
  return join(base, 'config.yaml');
}

/**
 * Whether `mcp_servers.<serverName>` is declared MORE THAN ONCE in the raw text.
 *
 * I6, and it is measured rather than assumed: `Bun.YAML.parse` silently LAST-WINS on a duplicate key
 * (verified — two `s:` entries under `mcp_servers` yield the second), as does Python's yaml. So the
 * parse cannot tell us there was an ambiguity, and the binding check would validate whichever entry
 * happened to be last. Two entries for one server name is ambiguous INTENT, so it is refused with a
 * message rather than resolved by guessing which one the operator meant.
 *
 * This is a best-effort scan of the raw text, deliberately narrow: it looks only inside the top-level
 * `mcp_servers:` block, at the indentation of its direct children. It never weakens the real check —
 * if it misses something, the parsed value is still validated — it only adds a refusal for a case the
 * parser cannot report. An unparsable config is caught earlier, so a miss here cannot become a bypass.
 */
export function duplicateMcpServerKey(configText: string, serverName: string): boolean {
  const lines = configText.split('\n');
  const top = lines.findIndex(l => /^mcp_servers:\s*(#.*)?$/.test(l));
  if (top < 0) return false;
  let childIndent = -1, seen = 0;
  for (let i = top + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break;                       // the section ended
    if (childIndent === -1) childIndent = indent;  // the first direct child sets the level
    if (indent !== childIndent) continue;          // a nested key, not a direct child
    const key = /^\s*([^\s:#][^:#]*):\s*(#.*)?$/.exec(line)?.[1]?.trim();
    if (key === undefined) continue;
    // Quote-stripped comparison, since YAML allows a quoted key.
    if (key.replace(/^["']|["']$/g, '') === serverName) seen++;
  }
  return seen > 1;
}

/** The exact config block to print when the entry is missing or wrong. Never written automatically. */
export function hermesBindingSnippet(serverName: string, roomId: string, agentHome: string, launcher: string, wakeDir: string): string {
  return [
    'mcp_servers:',
    `  ${serverName}:`,
    '    command: bun',
    `    args: [${launcher}, mcp, --room, ${roomId}, --agent-home, ${agentHome}, --wake-dir, ${wakeDir}]`,
    '    enabled: true',
  ].join('\n');
}
