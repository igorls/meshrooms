/**
 * One daemon per machine looks after every agent folder: a second agent's folder (a new MESHROOMS_AGENT_HOME) is added
 * to the registry the running daemon reads, never given a daemon of its own and never left unsupervised.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptAgentHome, daemonSupervises, writeDaemonRecord } from './agent-daemon';
import { knownAgentHomes } from './agent-watch';

const folders: string[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'meshrooms-adopt-')); folders.push(dir); return dir; };
afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const alive = () => true;
const connected = (home: string) => mkdirSync(join(home, 'browser-agents'), { recursive: true });
const runningDaemonAt = (dir: string, registry: string, homes: string[]) =>
  writeDaemonRecord(dir, { pid: 4242, startedAt: Date.now() - 1000, at: Date.now(), version: 'test', registry, homes, rooms: [] });

test('a running daemon takes a new agent folder on through its registry, without a restart or a second daemon', () => {
  const root = scratch(), dir = join(root, 'daemon'), registry = join(root, 'agent-homes.json');
  const first = join(root, 'agents-first'), second = join(root, 'agents-second');
  runningDaemonAt(dir, registry, [first]);
  connected(first); connected(second);
  expect(daemonSupervises(second, alive, dir)).toBe(false);
  expect(adoptAgentHome(second, alive, dir)).toEqual({ supervised: true, registered: true });
  expect(knownAgentHomes(registry)).toEqual([second]);
  expect(daemonSupervises(second, alive, dir)).toBe(true);
  // A folder the daemon already looks after is left alone, and asking again changes nothing.
  expect(adoptAgentHome(first, alive, dir)).toEqual({ supervised: true, registered: false });
  expect(adoptAgentHome(second, alive, dir)).toEqual({ supervised: true, registered: false });
  expect(knownAgentHomes(registry)).toEqual([second]);
});

test('with no running daemon, or a registry that cannot be written, the folder is reported unsupervised', () => {
  const root = scratch(), dir = join(root, 'daemon'), home = join(root, 'agents-x');
  connected(home);
  expect(adoptAgentHome(home, alive, dir)).toEqual({ supervised: false, registered: false });
  runningDaemonAt(dir, join(root, 'agent-homes.json'), []);
  expect(adoptAgentHome(home, () => false, dir)).toEqual({ supervised: false, registered: false });
  // A registry path that is not a JSON file is never written.
  runningDaemonAt(dir, join(root, 'not-a-registry'), []);
  expect(adoptAgentHome(home, alive, dir)).toEqual({ supervised: false, registered: false });
});

test('the tray app\'s own daemon start, with no agent folder connected, registers nothing and warns of nothing', () => {
  // The tray runs `daemon start --approvals` with no MESHROOMS_* variables: its agent folder is the default one, which
  // holds nothing until an agent connects. The daemon and its registry are the same ones the CLI uses.
  const root = scratch(), dir = join(root, 'daemon'), registry = join(root, 'agent-homes.json'), empty = join(root, 'agents');
  runningDaemonAt(dir, registry, []);
  expect(adoptAgentHome(empty, alive, dir)).toEqual({ supervised: false, registered: false, nothingToSupervise: true });
  expect(knownAgentHomes(registry)).toEqual([]);
});

test('a folder adopted from the command line is in the registry the tray\'s daemon reads, so it shows in daemon status', () => {
  const root = scratch(), dir = join(root, 'daemon'), registry = join(root, 'agent-homes.json'), home = join(root, 'agents-grok');
  runningDaemonAt(dir, registry, []);
  connected(home);
  adoptAgentHome(home, alive, dir);
  // `daemon status` (what the tray polls) and the supervisor both read this one file.
  expect(knownAgentHomes(registry)).toEqual([home]);
});
