import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentCli, connectConflict } from '../agent-cli';

const opus = crypto.randomUUID();
const admitted = { memberId: opus, members: [{ id: opus, name: 'Opus' }] };
const folder = '/home/me/.meshrooms/agents';

test('connect never reuses another agent that already lives in this folder', () => {
  // A fresh folder, or a retry of the link that created the agent here, connects as usual.
  expect(connectConflict('link-a', undefined, {}, folder)).toBeUndefined();
  expect(connectConflict('link-a', 'link-a', admitted, folder)).toBeUndefined();
  // A different link must not quietly become the agent already here (the Claude-Designer / Opus mix-up).
  const other = connectConflict('link-b', 'link-a', admitted, folder);
  expect(other).toContain('"Opus"');
  expect(other).toContain('MESHROOMS_AGENT_HOME');
  // Folders from before the link was recorded are treated as someone else's.
  expect(connectConflict('link-b', undefined, admitted, folder)).toContain('"Opus"');
  // An agent still waiting for the host is protected too: a new link would replace its request.
  expect(connectConflict('link-b', 'link-a', { request: { state: 'pending' } }, folder)).toContain('waiting for the host');
  expect(connectConflict('link-b', 'link-a', { request: { state: 'declined' } }, folder)).toBeUndefined();
});

test('connect fails closed when the room cannot be checked: the link is not used and nothing is recorded', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'agent-connect-')), before = process.env.MESHROOMS_AGENT_HOME;
  process.env.MESHROOMS_AGENT_HOME = folder;
  try {
    const room = crypto.randomUUID();
    await expect(agentCli(['connect', `http://127.0.0.1:9/agent/${room}#${'z'.repeat(43)}`])).rejects.toThrow('this link was not used');
    expect(existsSync(join(folder, 'browser-agents', room, 'room.json'))).toBe(false);
    expect(existsSync(join(folder, 'browser-agents', room, 'connect.lock'))).toBe(false);
  } finally {
    if (before === undefined) delete process.env.MESHROOMS_AGENT_HOME; else process.env.MESHROOMS_AGENT_HOME = before;
    rmSync(folder, { recursive: true, force: true });
  }
});
