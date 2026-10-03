/**
 * The per-room Hermes binding check. These are the properties that keep a wake confined to ITS room, so
 * they are asserted rather than assumed: a wrong binding is exactly the failure where the wake looks
 * correct and acts somewhere else.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { duplicateMcpServerKey, hermesBindingProblem, hermesBindingSnippet, hermesConfigPath, readMcpServerArgs, roomToolsetName } from './hermes-binding';

const ROOM_A = '11111111-2222-4333-8444-555555555555';
const ROOM_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
// A synthetic agent home. NOT a real one: the repo feeds a public mirror, and the gate flags a
// machine-local user path and any real agent name, so both are avoided deliberately here.
const HOME = 'AGENT_HOME';
// A stand-in for a user's home. Not a real path: the privacy gate flags the SHAPE of a machine-local
// user path, so a literal one here would be a hit in the gate even inside a test.
const FAKE_HOME = '/x/h';
const CUSTOM_HERMES_HOME = '/y/hermes';   // a placeholder, never a real machine path

/** A config with two rooms bound correctly, indented the way a real config is. */
const twoRoomConfig = `
agent:
  max_turns: 200
mcp_servers:
  ${roomToolsetName(ROOM_A)}:
    command: /usr/local/bin/bun
    args:
      - /repo/server/agent-cli.ts
      - mcp
      - --room
      - ${ROOM_A}
      - --agent-home
      - ${HOME}
      - --wake-dir
      - /tmp/wake-a
    enabled: true
  ${roomToolsetName(ROOM_B)}:
    command: /usr/local/bin/bun
    args: [/repo/server/agent-cli.ts, mcp, --room, ${ROOM_B}, --agent-home, ${HOME}, --wake-dir, /tmp/wake-b]
    enabled: true
memory:
  memory_enabled: true
`;

describe('the room toolset name', () => {
  test('is per room, derived from the room id', () => {
    expect(roomToolsetName(ROOM_A)).toBe('meshrooms-11111111');
    expect(roomToolsetName(ROOM_B)).toBe('meshrooms-aaaaaaaa');
    expect(roomToolsetName(ROOM_A)).not.toBe(roomToolsetName(ROOM_B));
  });

  test('passes the reserved-prefix rule that refuses mcp- and hermes-', () => {
    // The server name must be usable as a toolset name, so it cannot start with either reserved prefix.
    for (const room of [ROOM_A, ROOM_B]) {
      const name = roomToolsetName(room);
      expect(name.startsWith('mcp-')).toBe(false);
      expect(name.startsWith('hermes-')).toBe(false);
      expect(name).toBe(name.toLowerCase());
    }
  });
});

describe('two rooms, two entries: each binds to its own room', () => {
  test('room A reads room A args, and room B reads room B args', () => {
    const a = readMcpServerArgs(twoRoomConfig, roomToolsetName(ROOM_A));
    const b = readMcpServerArgs(twoRoomConfig, roomToolsetName(ROOM_B));
    expect(a.problem).toBeUndefined();
    expect(b.problem).toBeUndefined();
    expect(a.args).toContain(ROOM_A);
    expect(a.args).not.toContain(ROOM_B);
    expect(b.args).toContain(ROOM_B);
    expect(b.args).not.toContain(ROOM_A);
  });

  test('BLOCK-style args parse (the - list form)', () => {
    // The two styles are separate cases on purpose: a hand-rolled reader can easily handle one and
    // silently mishandle the other, which is exactly what an earlier version of this did.
    const a = readMcpServerArgs(twoRoomConfig, roomToolsetName(ROOM_A))!.args!;
    expect(a[0]).toBe('/repo/server/agent-cli.ts');
    expect(a.slice(2, 4)).toEqual(['--room', ROOM_A]);
    expect(a.at(-1)).toBe('/tmp/wake-a');
  });

  test('FLOW-style args parse (the [a, b] form)', () => {
    const b = readMcpServerArgs(twoRoomConfig, roomToolsetName(ROOM_B))!.args!;
    expect(b[0]).toBe('/repo/server/agent-cli.ts');
    expect(b.slice(2, 4)).toEqual(['--room', ROOM_B]);
    expect(b.at(-1)).toBe('/tmp/wake-b');
  });

  test('quoted block items keep their value and lose the quotes', () => {
    const config = `mcp_servers:\n  ${roomToolsetName(ROOM_A)}:\n    args:\n      - "/path with spaces/agent-cli.ts"\n      - mcp\n      - '--room'\n      - ${ROOM_A}\n      - --agent-home\n      - ${HOME}\n`;
    const r = readMcpServerArgs(config, roomToolsetName(ROOM_A));
    expect(r.problem).toBeUndefined();
    expect(r.args![0]).toBe('/path with spaces/agent-cli.ts');
    expect(r.args![2]).toBe('--room');
    expect(hermesBindingProblem(r.args, ROOM_A, HOME)).toBeUndefined();
  });

  test('both entries pass their own room check', () => {
    const a = readMcpServerArgs(twoRoomConfig, roomToolsetName(ROOM_A))!.args!;
    const b = readMcpServerArgs(twoRoomConfig, roomToolsetName(ROOM_B))!.args!;
    expect(hermesBindingProblem(a, ROOM_A, HOME)).toBeUndefined();
    expect(hermesBindingProblem(b, ROOM_B, HOME)).toBeUndefined();
  });
});

describe('a wake is refused when the binding is wrong', () => {
  test('a mismatched --room is refused, naming both rooms', () => {
    // The attack this closes: watcher A names room B's server, so room B's message wakes an agent whose
    // tools act in room B. The room text is untrusted, so this must fail closed.
    const b = readMcpServerArgs(twoRoomConfig, roomToolsetName(ROOM_B))!.args!;
    const problem = hermesBindingProblem(b, ROOM_A, HOME);
    expect(problem).toContain('--room');
    expect(problem).toContain(ROOM_B);
    expect(problem).toContain(ROOM_A);
  });

  test('a missing entry is refused', () => {
    const r = readMcpServerArgs(twoRoomConfig, 'meshrooms-deadbeef');
    expect(r.args).toBeUndefined();
    expect(r.problem).toContain('no `mcp_servers.meshrooms-deadbeef` entry');
    expect(hermesBindingProblem(undefined, ROOM_A, HOME)).toContain('could not be read');
  });

  test('a missing --agent-home is refused, because Hermes filters the env', () => {
    const args = ['--room', ROOM_A, '--wake-dir', '/tmp/w'];
    expect(hermesBindingProblem(args, ROOM_A, HOME)).toContain('--agent-home');
  });

  test('a wrong --agent-home is refused', () => {
    const args = ['--room', ROOM_A, '--agent-home', '/other/agents'];
    expect(hermesBindingProblem(args, ROOM_A, HOME)).toContain('/other/agents');
  });

  test('an entry with no args is refused', () => {
    const config = `mcp_servers:\n  ${roomToolsetName(ROOM_A)}:\n    command: bun\n    enabled: true\n`;
    const r = readMcpServerArgs(config, roomToolsetName(ROOM_A));
    expect(hermesBindingProblem(r.args, ROOM_A, HOME)).toContain('no args');
  });
});

describe('an unreadable config fails CLOSED, never open', () => {
  test('no mcp_servers section is a problem, not a pass', () => {
    const r = readMcpServerArgs('agent:\n  max_turns: 200\n', roomToolsetName(ROOM_A));
    expect(r.args).toBeUndefined();
    expect(r.problem).toContain('no top-level `mcp_servers:`');
  });

  test('truncated YAML yields a problem, never an accidental match', () => {
    // What a half-parser must never do is invent an entry. Anything unparsable is "missing".
    for (const bad of ['', 'mcp_servers:\n', 'mcp_servers:\n  other:\n    args: [a]', '  mcp_servers:\n    x: y\n']) {
      expect(readMcpServerArgs(bad, roomToolsetName(ROOM_A)).problem).toBeDefined();
    }
  });

  test('a nested key of the same name is not mistaken for the top-level section', () => {
    const config = `agent:\n  mcp_servers:\n    ${roomToolsetName(ROOM_A)}:\n      args: [--room, ${ROOM_A}]\n`;
    expect(readMcpServerArgs(config, roomToolsetName(ROOM_A)).problem).toContain('no top-level');
  });

  test('the section ends at the next top-level key, so a same-named server elsewhere is not picked up', () => {
    const config = `mcp_servers:\n  other:\n    args: [x]\nagent:\n  max_turns: 1\n${roomToolsetName(ROOM_A)}:\n  args: [--room, ${ROOM_A}]\n`;
    expect(readMcpServerArgs(config, roomToolsetName(ROOM_A)).problem).toBeDefined();
  });

  test('a name that is a prefix of another entry does not match it', () => {
    const config = `mcp_servers:\n  ${roomToolsetName(ROOM_A)}-extra:\n    args: [--room, ${ROOM_A}]\n`;
    expect(readMcpServerArgs(config, roomToolsetName(ROOM_A)).problem).toBeDefined();
  });
});

describe('the snippet the watcher prints', () => {
  test('carries the room, the agent home and the wake dir', () => {
    const s = hermesBindingSnippet('meshrooms-11111111', ROOM_A, HOME, '/repo/server/agent-cli.ts', '/tmp/w');
    expect(s).toContain('mcp_servers:');
    expect(s).toContain('meshrooms-11111111:');
    expect(s).toContain(ROOM_A);
    expect(s).toContain(HOME);
    expect(s).toContain('/tmp/w');
    // It must be pasteable as-is: one entry, correctly indented under the section.
    expect(s.split('\n')[1]).toBe('  meshrooms-11111111:');
  });
});

describe('I1: a repeated flag is refused, because two readers can disagree', () => {
  test('a duplicated --room is refused rather than interpreted', () => {
    // The bug this closes: the check read flags FIRST-wins (indexOf) while the server reads them
    // LAST-wins, so `--room A ... --room B` passed the check for A and was pinned to B by the server.
    const args = ['mcp', '--room', ROOM_A, '--agent-home', HOME, '--wake-dir', '/w', '--room', ROOM_B];
    const problem = hermesBindingProblem(args, ROOM_A, HOME);
    expect(problem).toContain('more than once');
    expect(problem).toContain('--room');
  });

  test('a duplicated --agent-home is refused too', () => {
    const args = ['mcp', '--room', ROOM_A, '--agent-home', HOME, '--agent-home', '/other'];
    expect(hermesBindingProblem(args, ROOM_A, HOME)).toContain('more than once');
  });

  test('a single occurrence of each flag still passes', () => {
    const args = ['mcp', '--room', ROOM_A, '--agent-home', HOME, '--wake-dir', '/w'];
    expect(hermesBindingProblem(args, ROOM_A, HOME)).toBeUndefined();
  });
});

describe('the wake folder is part of the binding', () => {
  test('a different --wake-dir is refused when the watcher knows its own', () => {
    const args = ['mcp', '--room', ROOM_A, '--agent-home', HOME, '--wake-dir', '/elsewhere'];
    expect(hermesBindingProblem(args, ROOM_A, HOME, '/w')).toContain('/elsewhere');
  });

  test('a matching --wake-dir passes, and omitting it is allowed (the server derives it)', () => {
    expect(hermesBindingProblem(['mcp', '--room', ROOM_A, '--agent-home', HOME, '--wake-dir', '/w'], ROOM_A, HOME, '/w')).toBeUndefined();
    expect(hermesBindingProblem(['mcp', '--room', ROOM_A, '--agent-home', HOME], ROOM_A, HOME, '/w')).toBeUndefined();
  });
});

describe('I2: the config path honours HERMES_HOME', () => {
  test('HERMES_HOME wins over the default home', () => {
    expect(hermesConfigPath({ HERMES_HOME: CUSTOM_HERMES_HOME }, FAKE_HOME)).toBe(join(CUSTOM_HERMES_HOME, 'config.yaml'));
  });
  test('an unset or blank HERMES_HOME falls back to the home folder', () => {
    expect(hermesConfigPath({}, FAKE_HOME)).toBe(join(FAKE_HOME, '.hermes', 'config.yaml'));
    expect(hermesConfigPath({ HERMES_HOME: '   ' }, FAKE_HOME)).toBe(join(FAKE_HOME, '.hermes', 'config.yaml'));
  });
});

describe('I6: a duplicated entry is refused, because the parser last-wins silently', () => {
  test('two entries for the same server name are refused', () => {
    // MEASURED: Bun.YAML.parse returns the SECOND silently, and Python's yaml does the same, so
    // neither can report the ambiguity. Two entries is ambiguous intent, not a value to pick.
    const config = `mcp_servers:\n  ${roomToolsetName(ROOM_A)}:\n    args: [a]\n  ${roomToolsetName(ROOM_A)}:\n    args: [b]\n`;
    expect(duplicateMcpServerKey(config, roomToolsetName(ROOM_A))).toBe(true);
    const r = readMcpServerArgs(config, roomToolsetName(ROOM_A));
    expect(r.problem).toContain('more than once');
  });

  test('a single entry is not flagged, and the same name NESTED deeper does not count', () => {
    const single = `mcp_servers:\n  ${roomToolsetName(ROOM_A)}:\n    args: [a]\n`;
    expect(duplicateMcpServerKey(single, roomToolsetName(ROOM_A))).toBe(false);
    const nested = `mcp_servers:\n  other:\n    ${roomToolsetName(ROOM_A)}:\n      args: [a]\n`;
    expect(duplicateMcpServerKey(nested, roomToolsetName(ROOM_A))).toBe(false);
  });
});

describe('I6: anchors, merges and mixed types behave predictably', () => {
  test('an alias is resolved, and its merged args are validated', () => {
    // MEASURED: Bun.YAML.parse resolves the anchor, so the args ARE checked — this documents that
    // rather than assuming it is a hole.
    const config = `mcp_servers:\n  ${roomToolsetName(ROOM_A)}: &a\n    args: [x]\n  ${roomToolsetName(ROOM_B)}: *a\n`;
    const b = readMcpServerArgs(config, roomToolsetName(ROOM_B));
    expect(b.problem).toBeUndefined();
    expect(b.args).toEqual(['x']);
    // ...and that shared, wrong args set is then refused for room B.
    expect(hermesBindingProblem(b.args, ROOM_B, HOME)).toContain('--room');
  });

  test('an args list containing a non-string is refused', () => {
    const config = `mcp_servers:\n  ${roomToolsetName(ROOM_A)}:\n    args: [x, 1, true]\n`;
    expect(readMcpServerArgs(config, roomToolsetName(ROOM_A)).problem).toContain('not a list of strings');
  });

  test('args that is not a list at all is refused', () => {
    const config = `mcp_servers:\n  ${roomToolsetName(ROOM_A)}:\n    args: hello\n`;
    expect(readMcpServerArgs(config, roomToolsetName(ROOM_A)).problem).toContain('not a list of strings');
  });
});
