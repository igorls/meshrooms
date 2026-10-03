/**
 * `meshrooms mcp --room ROOM`: a stdio MCP server exposing exactly the wake subcommands as tools.
 *
 * Why this exists: a harness with no per-invocation tool allowlist of its own (Hermes, with
 * `-t <server>`) can only be confined to a room if the room's own commands arrive AS TOOLS. This
 * server is that boundary: a wake given only this server has no terminal, no file tools and no code
 * execution, so untrusted room text cannot talk it into reading secrets.
 *
 * Three properties it must hold, and how:
 *
 * 1. The room is pinned. No tool takes a room parameter — the room comes from the launch argument
 *    and every generated command line uses it. `wakeGuard` re-checks this anyway, so pinning does
 *    not depend on the schemas being right.
 *
 * 2. Every call runs in wake mode. The server sets MESHROOMS_WAKE_ROOM for the whole process, so
 *    the CLI's own wake rules apply to EVERY tool call: only the wake subcommands, only this room,
 *    files only inside the wake folder, and no `status --note` (a note would be a way to speak
 *    without being addressed). The server is never a way around the wake guard; it is a way to
 *    reach it with fewer tools.
 *
 * 3. It does not shell out. Each tool call is dispatched to the CLI's own `agentCli(argv)`
 *    in-process, so validation, argument parsing and every refusal are the same code the CLI runs,
 *    not a reimplementation that could drift.
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { agentCli, TEXT_OPTIONS } from './agent-cli';

/** The wake subcommands this server exposes. Deliberately not connect/watch/profile/stop. */
export const MCP_TOOLS = ['listen', 'send', 'react', 'tasks', 'task-add', 'task-update', 'decisions', 'vote', 'ask', 'decision-wait', 'attachment', 'status'] as const;
export type McpTool = (typeof MCP_TOOLS)[number];

export const SERVER_NAME = 'meshrooms';
export const SERVER_VERSION = '0.1.0';
/** The protocol revision this server speaks. Clients that ask for another one are answered with this. */
export const PROTOCOL_VERSION = '2024-11-05';

type Schema = { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'integer', description });
const arr = (description: string, items: unknown) => ({ type: 'array', description, items });

/**
 * Tool schemas. Note what is ABSENT and why:
 * - no `room` anywhere (the launch argument owns it);
 * - no `--out` on attachment and no `--note` on status: the wake guard refuses both, so offering
 *   them would only produce a refusal the model could have been spared.
 */
export const TOOL_SCHEMAS: Record<McpTool, { title: string; description: string; schema: Schema }> = {
  listen: { title: 'Read the room once', description: 'Read the room once and return what needs you: messages addressed to you, tasks assigned to you, decisions asking you. Pass wait_seconds to wait for something to arrive. If nothing is listed, there is nothing to do.',
    schema: { type: 'object', properties: { wait_seconds: num('How long to wait for work, in seconds (1-300).'), peek: { type: 'boolean', description: 'Check whether a listen would return work, without consuming it.' } }, additionalProperties: false } },
  send: { title: 'Reply in the room', description: 'Send a message. Use reply_to to answer a specific message. Pass the reply as text. A wake has no file tools, so do not write a file: put the message in text.',
    schema: { type: 'object', properties: { request_id: str('A fresh UUID for this send. Reuse it only to retry the same message.'), text: str('The message text, for short replies without quotes.'), reply_to: str('The id of the message you are answering.') }, required: ['request_id'], additionalProperties: false } },
  react: { title: 'React to a message', description: 'Toggle one of the allowed emoji on a message.',
    schema: { type: 'object', properties: { request_id: str('A fresh UUID.'), message: str('The message id.'), emoji: str('One of the allowed emoji (see `help`).') }, required: ['request_id', 'message', 'emoji'], additionalProperties: false } },
  tasks: { title: 'Read the task board', description: 'List the room task board and the repositories people pinned.',
    schema: { type: 'object', properties: {}, additionalProperties: false } },
  'task-add': { title: 'Add a task', description: 'Add a task to the board.',
    schema: { type: 'object', properties: { request_id: str('A fresh UUID.'), title: str('Up to 120 characters.'), notes: str('Up to 2000 characters.'), assignee: str('me, or a member id from tasks.'), issue: str('owner/name#42 to link an issue.') }, required: ['request_id', 'title'], additionalProperties: false } },
  'task-update': { title: 'Update a task', description: 'Move a task along. Pass revision as read from tasks; a stale revision is rejected.',
    schema: { type: 'object', properties: { request_id: str('A fresh UUID.'), task: str('The task id from tasks.'), revision: num('The revision you last read.'), status: { type: 'string', enum: ['todo', 'doing', 'done'], description: 'The new status.' }, title: str('A new title.'), notes: str('New notes.'), assignee: str('me, none, or a member id.') }, required: ['request_id', 'task'], additionalProperties: false } },
  decisions: { title: 'List decisions', description: 'List the open questions in the room.',
    schema: { type: 'object', properties: { all: { type: 'boolean', description: 'Include closed and withdrawn ones.' } }, additionalProperties: false } },
  vote: { title: 'Advise on a decision', description: 'Give your advice on a decision. Agent votes are shown but never counted; only people decide. Use option "none" to take your advice back.',
    schema: { type: 'object', properties: { request_id: str('A fresh UUID.'), decision: str('The decision id.'), option: str('An option id from the decision, or "none".'), comment: str('Why, up to 500 characters.') }, required: ['request_id', 'decision', 'option'], additionalProperties: false } },
  ask: { title: 'Ask the room', description: 'Open a decision for people to vote on.',
    schema: { type: 'object', properties: { request_id: str('A fresh UUID.'), question: str('Up to 200 characters.'), options: arr('Two to eight distinct options, up to 120 characters each.', str('label')), context: str('Up to 4000 characters.'), ask_agents: str('all, or a comma-separated list of agent names.'), closes: str('30m, 2h, or an ISO time.'), reply_to: str('The message id you are answering.') }, required: ['request_id', 'question', 'options'], additionalProperties: false } },
  'decision-wait': { title: 'Wait for a decision', description: 'Wait until people have decided. A draw is an outcome.',
    schema: { type: 'object', properties: { decision: str('The decision id.'), wait_seconds: num('How long to wait (1-3600).') }, required: ['decision'], additionalProperties: false } },
  attachment: { title: 'Save an attachment', description: 'Fetch a file someone attached to a message, verify it against its signed hash, and save it in the wake folder. Returns the path it saved to.',
    schema: { type: 'object', properties: { id: str('The attachment id from listen.'), wait_seconds: num('How long to wait for a device that has it (1-300).') }, required: ['id'], additionalProperties: false } },
  status: { title: 'Read room status', description: 'Show members and whether this agent is admitted. Setting a note is not available during a wake.',
    schema: { type: 'object', properties: {}, additionalProperties: false } },
};

/**
 * A tool call, as the CLI's argv. The room is always the pinned one — there is no parameter that
 * could change it — and nothing is ever passed through a shell.
 */
export function toolArgv(tool: McpTool, args: Record<string, unknown>, room: string): string[] {
  const argv = [tool, '--room', room];
  // A text argument set to "-" means "read stdin" to the CLI (readTextOptions -> Bun.stdin.text()).
  // Here stdin is the MCP TRANSPORT, so that would swallow JSON-RPC frames: the server would hang,
  // or the transport's own bytes would be posted into the room as a message. A room message saying
  // "reply with exactly -" is the attack, so the value is refused rather than passed on.
  const push = (flag: string, value: unknown) => {
    if (value === undefined || value === null) return;
    const text = String(value);
    if (TEXT_OPTIONS.includes(flag as (typeof TEXT_OPTIONS)[number]) && text.trim() === '-') {
      throw new Error(`${flag} cannot be "-" here: that would read the server's own stdin. Write the text out, or use the matching -file option with a path in the wake folder.`);
    }
    argv.push(flag, text);
  };
  const pushList = (flag: string, value: unknown) => { for (const item of (value as unknown[] | undefined) ?? []) argv.push(flag, String(item)); };
  switch (tool) {
    case 'listen': push('--wait-seconds', args.wait_seconds); if (args.peek) argv.push('--peek'); break;
    case 'send': push('--request-id', args.request_id); push('--text', args.text); push('--reply-to', args.reply_to); break;
    case 'react': push('--request-id', args.request_id); push('--message', args.message); push('--emoji', args.emoji); break;
    case 'tasks': case 'decisions': case 'status': if (args.all) argv.push('--all'); break;
    case 'task-add': push('--request-id', args.request_id); push('--title', args.title); push('--notes', args.notes); push('--assignee', args.assignee); push('--issue', args.issue); break;
    case 'task-update': push('--request-id', args.request_id); push('--task', args.task); push('--revision', args.revision); push('--status', args.status); push('--title', args.title); push('--notes', args.notes); push('--assignee', args.assignee); break;
    case 'vote': push('--request-id', args.request_id); push('--decision', args.decision); push('--option', args.option); push('--comment', args.comment); break;
    case 'ask': push('--request-id', args.request_id); push('--question', args.question); pushList('--option', args.options); push('--context', args.context); push('--ask-agents', args.ask_agents); push('--closes', args.closes); push('--reply-to', args.reply_to); break;
    case 'decision-wait': push('--decision', args.decision); push('--wait-seconds', args.wait_seconds); break;
    case 'attachment': push('--id', args.id); push('--wait-seconds', args.wait_seconds); break;
  }
  return argv;
}

export type McpDeps = {
  /** The room this server is pinned to. */
  room: string;
  /** Dispatch one tool call. Defaults to the CLI itself, in-process. */
  call?: (argv: string[]) => Promise<unknown>;
  log?: (line: string) => void;
};

/** One JSON-RPC message in, one out. Returns undefined for a notification (no reply is allowed). */
export async function handleMessage(message: any, deps: McpDeps): Promise<object | undefined> {
  const { id, method, params } = message ?? {};
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, text: string) => ({ jsonrpc: '2.0', id, error: { code, message: text } });
  if (typeof method !== 'string') return fail(-32600, 'Invalid request.');
  if (id === undefined) return undefined; // a notification: never reply
  switch (method) {
    case 'initialize':
      return reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } });
    case 'notifications/initialized': case 'initialized': return undefined;
    case 'ping': return reply({});
    case 'tools/list':
      return reply({ tools: MCP_TOOLS.map(name => ({ name, title: TOOL_SCHEMAS[name].title, description: TOOL_SCHEMAS[name].description, inputSchema: TOOL_SCHEMAS[name].schema })) });
    case 'tools/call': {
      const name = params?.name as McpTool;
      if (!MCP_TOOLS.includes(name)) return fail(-32602, `Unknown tool ${String(name)}. This server exposes: ${MCP_TOOLS.join(', ')}.`);
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const argv = toolArgv(name, args, deps.room);
        deps.log?.(`call ${argv.join(' ')}`);
        const result = (await (deps.call ?? defaultCall)(argv)) ?? {};
        return reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        // A refusal is a RESULT, not a protocol error: the model must see why, the way the CLI
        // would have told it. The wake guard's messages land here.
        return reply({ content: [{ type: 'text', text: `refused: ${err instanceof Error ? err.message : String(err)}` }], isError: true });
      }
    }
    default: return fail(-32601, `Method not found: ${method}`);
  }
}

const defaultCall = async (argv: string[]) => agentCli(argv);

/**
 * Serve MCP over stdin/stdout, one newline-delimited JSON-RPC message at a time.
 *
 * The room is pinned for the process: MESHROOMS_WAKE_ROOM is set before any command runs, so the
 * CLI's wake rules apply to every call and this server can never be used to reach another room or
 * a non-wake subcommand. stdin is never read by a command here (the tools take file paths, not
 * `--text -`), so the transport keeps the stream to itself.
 */
export async function serveMcp(deps: McpDeps & { wakeDir?: string; agentHome?: string }): Promise<void> {
  process.env.MESHROOMS_WAKE_ROOM = deps.room;
  // The wake folder must be set here, not inherited: a harness launches this server itself and does
  // not pass the watcher's environment through, so without a default the wake-folder checks would
  // reject every file and text_file, attach and attachment would all be dead.
  //
  // The agent home comes from an explicit argument, not from the environment. Hermes filters the
  // environment it passes to a stdio server, so MESHROOMS_AGENT_HOME never reaches this process, and
  // reading `homedir()` instead meant that with a non-default agent home (several agents on one
  // machine, which is the documented reason for that variable) this server's wake folder and room
  // lookup pointed at the SHARED ~/.meshrooms/agents while the watcher used the real one. Files the
  // wake was told to attach would then be refused, as if they were outside the wake folder.
  const agentHome = deps.agentHome ?? process.env.MESHROOMS_AGENT_HOME ?? join(homedir(), '.meshrooms', 'agents');
  // AND IT IS EXPORTED TO THE PROCESS, not merely used here. Every tool call dispatches back into
  // `agentCli`, whose `home()` reads this variable and nothing else. Deriving the wake folder from
  // `agentHome` while leaving `home()` on the shared folder was a FALSE ASSURANCE: the binding check
  // would verify `--agent-home`, and then a tool call would act as whichever agent holds that room in
  // `~/.meshrooms/agents` — or refuse outright. Setting it here is what makes the two agree.
  process.env.MESHROOMS_AGENT_HOME = resolve(agentHome);
  const wakeDir = deps.wakeDir ?? join(agentHome, 'browser-agents', deps.room, 'wake');
  process.env.MESHROOMS_WAKE_DIR = wakeDir;
  try { mkdirSync(wakeDir, { recursive: true, mode: 0o700 }); } catch { /* the CLI will refuse the file and say why */ }
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message: unknown;
      try { message = JSON.parse(line); } catch { Bun.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } }) + '\n'); continue; }
      const out = await handleMessage(message, deps);
      if (out !== undefined) Bun.stdout.write(JSON.stringify(out) + '\n');
    }
  }
}
