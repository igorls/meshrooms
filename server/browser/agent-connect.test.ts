import { expect, test } from 'bun:test';
import { connectConflict } from '../agent-cli';

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
