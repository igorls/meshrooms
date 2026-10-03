/**
 * The Meshrooms MCP server: the tool list, the pinning, the wake-folder limit and the wake-mode
 * refusals. These are the properties a confined wake depends on, so they are asserted rather than
 * assumed.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MCP_TOOLS, PROTOCOL_VERSION, TOOL_SCHEMAS, handleMessage, toolArgv } from './mcp';
import { FORBIDDEN_TOOLSET_PREFIXES, HERMES_ROOM_TOOLS, HERMES_TOOLSET, harnessInvocation, hermesToolsProblem, nonRoomTools, readHarnessOutput, toolsetNameProblem } from './agent-watch';

/** A synthetic fixture. Never a real room id: room ids are not ours to publish. */
const ROOM = '00000000-0000-4000-8000-000000000001';
/** A dispatcher that only records; it never touches a room. */
const recorder = () => { const calls: string[][] = []; return { calls, call: async (argv: string[]) => { calls.push(argv); return { ok: true }; } }; };

describe('MCP server — the tool list', () => {
  test('exposes exactly the wake subcommands, and nothing else', async () => {
    const out: any = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { room: ROOM, call: recorder().call });
    const names = out.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(['listen', 'send', 'react', 'tasks', 'task-add', 'task-update', 'decisions', 'vote', 'ask', 'decision-wait', 'attachment', 'status']);
    // The commands that must never be reachable from a room: they are operator-only, and exposing
    // them would let room text reconfigure or stop the agent.
    for (const forbidden of ['connect', 'watch', 'watch-stop', 'stop', 'profile', 'avatar', 'rooms', 'run', 'mcp', 'listen-loop']) {
      expect(names).not.toContain(forbidden);
    }
  });

  test('every tool has a title, a description and a closed schema', async () => {
    const out: any = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { room: ROOM, call: recorder().call });
    for (const tool of out.result.tools) {
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe('object');
      // additionalProperties:false means a model cannot smuggle an unknown flag through.
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  test('initializes with the protocol version and a server name', async () => {
    const out: any = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION } }, { room: ROOM });
    expect(out.result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(out.result.serverInfo.name).toBe('meshrooms');
    expect(out.result.capabilities.tools).toBeDefined();
  });
});

describe('MCP server — the room is pinned', () => {
  test('no tool schema takes a room, so a call cannot reach another room', async () => {
    const out: any = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { room: ROOM, call: recorder().call });
    for (const tool of out.result.tools) {
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('room');
    }
  });

  test('every generated command line carries the pinned room', () => {
    for (const tool of MCP_TOOLS) expect(toolArgv(tool, {}, ROOM)).toContain(ROOM);
  });

  test('an argument named room is ignored, not passed through', () => {
    const argv = toolArgv('status', { room: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, ROOM);
    expect(argv).not.toContain('ffffffff-ffff-4fff-8fff-ffffffffffff');
    expect(argv.filter(a => a === ROOM)).toHaveLength(1);
  });

  test('the room argument is placed after --room, never as a bare value', () => {
    for (const tool of MCP_TOOLS) {
      const argv = toolArgv(tool, {}, ROOM);
      expect(argv[0]).toBe(tool);
      expect(argv[1]).toBe('--room');
      expect(argv[2]).toBe(ROOM);
    }
  });
});

describe('MCP server — the wake folder is the only place files may come from', () => {
  test('attachment offers no --out, so it cannot choose a destination', () => {
    const argv = toolArgv('attachment', { id: 'x' }, ROOM);
    expect(argv).not.toContain('--out');
  });

  test('status offers no --note, which would be a way to speak without being addressed', () => {
    expect(Object.keys(TOOL_SCHEMAS.status.schema.properties)).toHaveLength(0);
    // Even if a model invents the argument, the CLI's wake guard refuses it.
    expect(toolArgv('status', { note: 'hello room' } as Record<string, unknown>, ROOM)).not.toContain('--note');
  });

  test('a refusal from the guard is returned as a result the model can read, not a protocol error', async () => {
    // A wake's guard can refuse for many reasons; the server's job is to pass the message through as a
    // tool RESULT the model can read, never as a crash and never as a protocol error.
    const out: any = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send', arguments: { request_id: '3f2a9c1e-0000-4000-8000-000000000001', text: 'hello' } } },
      { room: ROOM, call: async () => { throw new Error('During a wake, files must be in the wake folder: write the file there first.'); } });
    expect(out.error).toBeUndefined();
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0].text).toContain('wake folder');
  });

  test('send advertises no file inputs, because a wake has no file tools', () => {
    // The decision: the MCP server exists for harnesses WITHOUT file tools, so advertising text_file or
    // attach only invites refusals. The CLI keeps them. If an MCP harness with file tools appears, they
    // come back behind a flag.
    const send = TOOL_SCHEMAS.send;
    const props = Object.keys(send.schema.properties ?? {});
    expect(props).toContain('text');
    expect(props).not.toContain('text_file');
    expect(props).not.toContain('attach');
    // And the command line must not carry them either, whoever sends them.
    const argv = toolArgv('send', { request_id: 'id', text: 'hi', text_file: '/x', attach: ['/y'] } as Record<string, unknown>, ROOM);
    expect(argv).not.toContain('--text-file');
    expect(argv).not.toContain('--attach');
  });

  test('attachment says it saves into the wake folder and returns the path', () => {
    const d = TOOL_SCHEMAS.attachment.description;
    expect(d).toContain('wake folder');
    expect(d).toContain('path');
  });
});

describe('MCP server — the transport', () => {
  test('an unknown tool is refused and the refusal names the available ones', async () => {
    const out: any = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run', arguments: {} } }, { room: ROOM, call: recorder().call });
    expect(out.error.code).toBe(-32602);
    expect(out.error.message).toContain('listen');
  });

  test('an unknown method is refused', async () => {
    const out: any = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'resources/list' }, { room: ROOM });
    expect(out.error.code).toBe(-32601);
  });

  test('a notification is never answered', async () => {
    expect(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, { room: ROOM })).toBeUndefined();
    expect(await handleMessage({ jsonrpc: '2.0', method: 'tools/list' }, { room: ROOM })).toBeUndefined();
  });
});

describe('MCP server — against the real process, not a fake call', () => {
  const ROOM_ID = '0d3f7a1b-5c22-4e88-9f10-2b6d4c8e1a77';
  // The real server entry, spawned as a subprocess over real stdin/stdout, because the in-process
  // tests inject a `call` and so never exercise the transport, the JSON-RPC framing, or the fact that
  // a tool result must come back as one JSON object per line. The review pointed out that the imports
  // for this were present and unused — the test they were written for had never been ported.
  const runServer = (lines: unknown[], timeoutMs = 20000, wakeDirOverride?: string | null, extraArgs: string[] = [], roomId = ROOM_ID) => {
    // The real entry: `agent-cli.ts` owns the `mcp` dispatch and `import.meta.main`, and it is what
    // the installed launcher imports. Running `server/mcp.ts` directly produces NO output, which is
    // how the first version of this test failed — the entry has to be the one the launcher uses.
    const server = resolve('server/agent-cli.ts');
    // A real wake folder, so the wake-folder checks have somewhere real to point at.
    const wakeDir = wakeDirOverride === undefined ? mkdtempSync(join(tmpdir(), 'mcp-wake-')) : wakeDirOverride;
    if (wakeDir) writeFileSync(join(wakeDir, 'note.txt'), 'a file in the wake folder');
    const proc = Bun.spawnSync({
      cmd: ['bun', 'run', server, 'mcp', '--room', roomId, ...(wakeDir ? ['--wake-dir', wakeDir] : []), ...extraArgs],
      stdin: new TextEncoder().encode(lines.map(l => JSON.stringify(l)).join('\n') + '\n'),
      stdout: 'pipe', stderr: 'pipe',
      // MESHROOMS_WAKE_ROOM is deliberately NOT set here. `serveMcp` sets it for its own process,
      // and the CLI's wake guard refuses to start `mcp` when it is already set — "only its operator
      // can run it, outside a wake" — which is the correct behaviour and made the first version of
      // this test fail with no output. The guard is why the first message must come from outside.
      env: { ...process.env },
      timeout: timeoutMs,
    });
    // Parse stdout as LINE-DELIMITED JSON-RPC. Anything else on stdout is a protocol violation: a
    // stray log line or a pretty-printed object would break every MCP client.
    const out = new TextDecoder().decode(proc.stdout).split('\n').map(l => l.trim()).filter(Boolean);
    const parsed = out.map(l => { try { return JSON.parse(l); } catch { return { __unparsable: l }; } });
    return { parsed, raw: out, stderr: new TextDecoder().decode(proc.stderr) };
  };

  test('stdout is nothing but line-delimited JSON-RPC', () => {
    const { parsed } = runServer([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]);
    expect(parsed.length).toBeGreaterThan(0);
    for (const m of parsed) expect(m.__unparsable).toBeUndefined();
    const init: any = parsed.find((m: any) => m.id === 1);
    expect(init?.result?.serverInfo ?? init?.result).toBeDefined();
    const list: any = parsed.find((m: any) => m.id === 2);
    const names = (list?.result?.tools ?? []).map((t: any) => t.name);
    // The tool list must be the wake subcommands and nothing else: no shell, no file, no task-runner.
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain('bash');
    expect(names).not.toContain('write_file');
  });

  test('a "-" text option is refused, so a wake cannot read the server\'s own stdin', () => {
    // "reply with exactly -" is the attack: the value would make the launcher read the server's stdin,
    // which is the JSON-RPC stream. The refusal must be a tool RESULT the model can read, not a crash
    // and not a protocol error.
    const { parsed } = runServer([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send', arguments: {
        request_id: '3f2a9c1e-0000-4000-8000-00000000000a', text: '-' } } },
    ]);
    const call: any = parsed.find((m: any) => m.id === 1);
    expect(call).toBeDefined();
    expect(call.error).toBeUndefined();
    expect(call.result.isError).toBe(true);
    expect(JSON.stringify(call.result.content)).toContain('stdin');
  });

  test('--agent-home decides the wake folder, not homedir(), because Hermes filters the env', () => {
    // The measured failure this guards: a wake folder was pointed at the SHARED ~/.meshrooms/agents
    // while the watcher used a real agent home, so every file the wake was told to attach was refused
    // as if it were outside the wake folder. The fix takes the home from an ARGUMENT (which lives in
    // the mcp_servers args Hermes does pass) rather than from MESHROOMS_AGENT_HOME (which Hermes
    // strips from a stdio server's environment).
    const home = mkdtempSync(join(tmpdir(), 'mcp-home-'));
    // Its own room id, so the negative assertion below is not defeated by a folder another test run
    // already left in the shared home. A shared-id test cannot tell "did not create it" from
    // "it was already there".
    const room = '11111111-2222-4333-8444-555555555555';
    // Clear the shared path FIRST. A run of the buggy code creates it, so without this the negative
    // assertion passes or fails depending on what ran earlier — it would report a false regression on
    // the second run and, worse, a false pass if the folder were stale for another reason.
    const shared = join(homedir(), '.meshrooms', 'agents', 'browser-agents', room, 'wake');
    rmSync(join(homedir(), '.meshrooms', 'agents', 'browser-agents', room), { recursive: true, force: true });
    try {
      // No --wake-dir: the folder is derived, so the assertion is about the derivation itself.
      const { parsed } = runServer([
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      ], 20000, null, ['--agent-home', home], room);
      // A tools/list proves the server started and served; the folder is the real claim.
      expect(parsed.some((m: any) => m.id === 1)).toBe(true);
      const derived = join(home, 'browser-agents', room, 'wake');
      expect(existsSync(derived)).toBe(true);
      // And it must NOT have fallen back to the shared home, which is the bug in one line.
      expect(existsSync(shared)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(join(homedir(), '.meshrooms', 'agents', 'browser-agents', room), { recursive: true, force: true });
    }
  });

  test('a REAL tool call acts as the --agent-home agent, not whichever agent owns the shared folder', () => {
    // Round-3 C1, and the reason it mattered: `serveMcp` derived the wake folder from `--agent-home`
    // but never exported it, while every tool call dispatches into `agentCli`, whose `home()` reads
    // ONLY `MESHROOMS_AGENT_HOME`. So the binding check verified the home and the server then ignored
    // it: with a non-default home, a call either refused ("has not connected to that room") or acted as
    // whichever agent held that room in the SHARED folder. This drives a real `listen` through the real
    // entry and asserts the room is found in the home we passed and NOT in the shared one.
    const home = mkdtempSync(join(tmpdir(), 'mcp-home-'));
    const room = '22222222-3333-4444-8555-666666666666';
    // The agent in OUR home knows this room; the shared folder deliberately does not.
    mkdirSync(join(home, 'browser-agents', room), { recursive: true });
    writeFileSync(join(home, 'browser-agents', room, 'room.json'), JSON.stringify({ origin: 'http://127.0.0.1:1', roomId: room }));
    const sharedDir = join(homedir(), '.meshrooms', 'agents', 'browser-agents', room);
    rmSync(sharedDir, { recursive: true, force: true });
    try {
      const { parsed, stderr } = runServer([
        // `status` is cheapest: it resolves the agent via knownRoom() -> home() before doing anything.
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: { request_id: '3f2a9c1e-0000-4000-8000-0000000000c1' } } },
      ], 20000, null, ['--agent-home', home], room);
      const call: any = parsed.find((m: any) => m.id === 1);
      expect(call).toBeDefined();
      // The assertion that matters: it must NOT be the "not connected" refusal. With the bug, home()
      // read the shared folder, found no room.json there, and refused. With the fix it finds ours.
      const text = JSON.stringify(call.result?.content ?? call.result ?? '');
      expect(text).not.toContain('has not connected to that room');
      // ...and it must not have needed the shared folder to exist.
      expect(existsSync(sharedDir)).toBe(false);
      // Sanity: no crash, no protocol error.
      expect(call.error).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(sharedDir, { recursive: true, force: true });
    }
  });
});

describe('Hermes confinement — the tools-present preflight', () => {
  // Real `hermes mcp test <server>` output shape: one tool per line under a "Tools discovered" header.
  // (`hermes mcp list` is NOT usable for this: it prints only "all".)
  const listing = (tools: string[]) => `  Testing 'meshrooms'...\n  Transport: stdio -> bun\n  ✓ Connected (396ms)\n  ✓ Tools discovered: ${tools.length}\n\n`
    + tools.map(t => `    ${t}${' '.repeat(Math.max(2, 36 - t.length))}Description`).join('\n');

  test('passes when the server offers the tools a wake needs', () => {
    expect(hermesToolsProblem(listing(['listen', 'send', 'tasks', 'decision-wait']))).toBeUndefined();
  });

  test('fails when the server did not register at all', () => {
    // The silent failure this exists to catch: the agent would answer confidently with zero tools.
    expect(hermesToolsProblem(listing([]))).toContain('no');
  });

  test('fails when the server is registered but missing a tool a wake needs', () => {
    expect(hermesToolsProblem(listing(['listen', 'tasks']))).toContain('send');
  });

  test('fails when the server is unreachable', () => {
    expect(hermesToolsProblem("  Testing 'meshrooms'...\n  ✗ Failed to connect: missing executable")).toContain('no');
  });

  test('a look-alike tool name from elsewhere does not count', () => {
    expect(hermesToolsProblem(listing(['listen', 'send', 'tasks-extra']))).toContain('tasks');
  });
});

describe('Hermes confinement — a session open elsewhere is BUSY, not a failure', () => {
  // Verbatim stderr from a real concurrent resume (Hermes 0.21.5). The marker on the first line is
  // what is matched; the prose below it can be reworded.
  const busyStderr = 'hermes-refusal-reason: SESSION_NOT_OWNED\n'
    + 'This chat is open in another Hermes window/terminal. Use it there, or start a new chat here.\n'
    + 'Details: session 20260101_000000_abcdef opened by cli 0m ago.';

  test('a busy session is classified busy, not as an error', () => {
    const out = readHarnessOutput('hermes', '', busyStderr, 1);
    expect(out.busy).toBe(true);
    expect(out.error).toBeUndefined();
  });

  test('the marker is matched, so reworded prose still classifies', () => {
    expect(readHarnessOutput('hermes', '', 'hermes-refusal-reason: SESSION_NOT_OWNED\nSomething else entirely.', 1).busy).toBe(true);
  });

  test('the marker is not busy in stdout (room text reaches stdout) or when the run succeeded', () => {
    expect(readHarnessOutput('hermes', 'hermes-refusal-reason: SESSION_NOT_OWNED\n', '', 1).busy).toBeUndefined();
    expect(readHarnessOutput('hermes', '', 'hermes-refusal-reason: SESSION_NOT_OWNED\n', 0).busy).toBeUndefined();
  });

  test('an ordinary failure is NOT treated as busy', () => {
    const out = readHarnessOutput('hermes', '{"type":"result","exit_code":1,"error":"credentials or agent init failed"}', '', 1);
    expect(out.busy).toBeUndefined();
    expect(out.error).toContain('credentials');
  });

  test('a busy session must not have read the room, or it is not the busy case', () => {
    // The watcher only treats it as busy when nothing was consumed; this pins the parser side of that.
    const withRead = readHarnessOutput('hermes', '{"type":"tool_use","name":"mcp__meshrooms__listen"}', busyStderr, 1);
    expect(withRead.busy).toBe(true);
    expect(withRead.tools).toEqual(['mcp__meshrooms__listen']);
  });
});

describe('Hermes confinement — a wake may only call the room\'s own tools', () => {
  test('the tool list here cannot drift from the server\'s real list', async () => {
    // The list is duplicated because importing it would cycle (mcp -> agent-cli -> agent-watch).
    // The duplication is safe only if it is ASSERTED: this is the assertion.
    const out: any = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { room: ROOM, call: recorder().call });
    const serverTools = out.result.tools.map((t: { name: string }) => t.name).sort();
    expect([...HERMES_ROOM_TOOLS].sort()).toEqual(serverTools);
  });

  test('the room\'s own tools pass, in both the bare and the SANITIZED mcp__ name forms', () => {
    // Measured on Hermes v0.21.5 AND confirmed in its source: tools are reported as
    // mcp__<server>__<tool> with BOTH components sanitized by `re.sub(r"[^A-Za-z0-9_]", "_", ...)`
    // (tools/mcp_tool_schema.py:147). So `meshrooms-<hex>` arrives as `meshrooms_<hex>` and
    // `task-update` arrives as `task_update`. The hyphenated form is what this test used to assert,
    // and passing it was the BUG: a real wake never matched, so every wake was reported as a
    // confinement breach. It now asserts the names that actually arrive.
    const roomServer = 'meshrooms-0a1b2c3d';
    expect(nonRoomTools([`mcp__meshrooms_0a1b2c3d__listen`, `mcp__meshrooms_0a1b2c3d__task_update`], roomServer)).toEqual([]);
    // The bare toolset names stay bare, and are sanitized the same way on both sides.
    // Bare room-tool names don't pass: only this room's qualified server, or the catalog.
    expect(nonRoomTools(['listen', 'send', 'task-update'], roomServer)).toEqual(['listen', 'send', 'task-update']);
    // A DIFFERENT room's server must not pass, even though only the hex differs.
    expect(nonRoomTools(['mcp__meshrooms_deadbeef__listen'], roomServer)).toEqual(['mcp__meshrooms_deadbeef__listen']);
  });

  test('the HYPHENATED spelling of a tool is accepted too, because it is the same name', () => {
    // Both sides are sanitized, so a wake reporting the unsanitized spelling cannot look like a leak.
    expect(nonRoomTools(['mcp__meshrooms-0a1b2c3d__task-update'], 'meshrooms-0a1b2c3d')).toEqual([]);
  });

  test('a tool outside the room is flagged, so the confinement cannot fail quietly', () => {
    // The case the preflight cannot see: a wake that was offered more than the room's server and used
    // it. A shell is the one that matters — room text is untrusted.
    const roomServer = 'meshrooms-0a1b2c3d';
    expect(nonRoomTools(['listen', 'terminal'])).toEqual(['listen', 'terminal']);
    expect(nonRoomTools(['mcp__meshrooms__listen', 'mcp__otherserver__send'])).toEqual(['mcp__otherserver__send']);
    // Another server whose name only differs by the sanitized character set is still another server.
    expect(nonRoomTools(['mcp__meshrooms_0a1b2c3d__listen'], 'meshrooms-0a1b2c3d')).toEqual([]);
    // MEASURED on hermes 0.21.5: a wake confined by --toolsets ALSO carries the harness's own
    // three-tool discovery catalog, and the room's own tools are DEFERRED, so the wake cannot call
    // `listen` at all without tool_call. Treating them as strays paused every real Hermes wake on its
    // first search, which means it never read the room. They reach nothing outside the toolset:
    // tool_call refuses `bash`/`terminal`, and a name matching no toolset yields no tools at all.
    expect(nonRoomTools(['tool_search', 'tool_describe', 'tool_call'], roomServer)).toEqual([]);
    // ...and the allowance is a closed list, not a prefix: a look-alike is still a stray.
    expect(nonRoomTools(['tool_search', 'tool_write', 'tools'], roomServer)).toEqual(['tool_write', 'tools']);
    // A harness tool smuggled through the MCP namespace is still judged by the server rule.
    expect(nonRoomTools(['mcp__otherserver__tool_call'], roomServer)).toEqual(['mcp__otherserver__tool_call']);
    expect(nonRoomTools(['write_file', 'read_file'])).toEqual(['write_file', 'read_file']);
  });

  test('a stray tool makes the wake an error, not a quiet success', () => {
    // The whole point: the run must be retried/paused on, never counted as "a turn with nothing to say".
    const out = readHarnessOutput('hermes', '{"type":"tool_use","name":"terminal"}\n{"type":"tool_use","name":"listen"}\n{"type":"result","exit_code":0}', '', 0);
    expect(out.error).toContain('terminal');
    expect(out.error).toContain('confinement did not hold');
  });

  test('a wake that only listens, or calls nothing, is NOT an error', () => {
    // A tool-less run produces no tool_use events, and a correct quiet wake calls only `listen`.
    // Neither is a failure — only calling something outside the room is.
    expect(readHarnessOutput('hermes', '{"type":"tool_use","name":"mcp__meshrooms__listen"}\n{"type":"result","exit_code":0}', '', 0).error).toBeUndefined();
    expect(readHarnessOutput('hermes', '{"type":"result","exit_code":0,"text":"nothing to do"}', '', 0).error).toBeUndefined();
  });
});

describe('Hermes confinement — the toolset name must not be one our own tooling owns', () => {
  // A room-adjacent name in the agent's own namespace could be satisfied by a server WE registered
  // rather than the room's, so the wake would be confined to the wrong thing while looking correct.
  test('the room name itself is allowed', () => {
    expect(toolsetNameProblem(HERMES_TOOLSET)).toBeUndefined();
  });
  test('the reserved prefixes are refused, case-insensitively', () => {
    for (const name of FORBIDDEN_TOOLSET_PREFIXES.flatMap(p => [`${p}meshrooms`, `${p.toUpperCase()}meshrooms`])) {
      expect(toolsetNameProblem(name)).toContain('own tooling');
    }
  });
  test('an underscore variant is NOT treated as the reserved prefix', () => {
    // `mcp_thing` is a different namespace from `mcp-thing`, so refusing it would be a false positive.
    expect(toolsetNameProblem('mcp_thing')).toBeUndefined();
  });
  test('ordinary names are allowed', () => {
    for (const name of ['meshrooms', 'room-tools', 'chat']) expect(toolsetNameProblem(name)).toBeUndefined();
  });
});

describe('Hermes confinement — the wake env and memory', () => {
  const config = () => ({ roomId: '00000000-0000-4000-8000-000000000001', harness: 'hermes' as const, cwd: '/tmp',
    session: '20260101_000000_abcdef', launcher: '/l.js', agentHome: '/a', binDir: '/b', roomDir: '/r',
    maxWakesPerHour: 20, runTimeoutMinutes: 20, allowTools: [], maxAgentWakesPerHour: 30 } as never);
  const args = () => harnessInvocation(config(), 'PROMPT', '/wake/p.txt', (n: string) => ({ file: n, prefix: [] })).args;

  test('--ignore-rules is passed, so operator notes stay out of a wake', () => {
    // Measured: without it a wake's context contains MEMORY.md and the user profile, and an agent
    // asked to quote its memory does so verbatim. Our notes carry machine names and fleet
    // identities, and a room message can ask for them.
    expect(args()).toContain('--ignore-rules');
  });

  test('the wake is confined to the room toolset, pinned to a named session', () => {
    const a = args();
    expect(a[a.indexOf('--toolsets') + 1]).toBe(HERMES_TOOLSET);
    expect(a).toContain('--resume');
    expect(a[a.indexOf('--resume') + 1]).toBe('20260101_000000_abcdef');
    // --no-restore-cwd keeps the wake in the pinned folder rather than the session's recorded one.
    expect(a).toContain('--no-restore-cwd');
    expect(a).not.toContain('--continue');
  });

  test('the prompt never reaches argv', () => {
    expect(args()).not.toContain('PROMPT');
    expect(args()).toContain('--query-file');
  });
});
