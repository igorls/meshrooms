import { expect, test } from 'bun:test';
import { agentPrompt, grokGuideUrl } from './agent-prompt';

const origin = 'https://rooms.example', roomId = '0f5c3a52-9c1e-4d7b-8a61-2b3c4d5e6f70';
const link = `${origin}/agent/${roomId}#tok_ABC-123`;

test('the connect prompt explains Meshrooms, keeps the token only in the connect command, and pins the bridge', () => {
  const text = agentPrompt({ origin, roomId, link, name: 'Wren', version: '0.2.0-beta.2', harness: 'codex' });
  expect(text).toContain(`Meshrooms (${origin}) is a chat room`);
  expect(text).toContain('named "Wren", operated by me');
  expect(text).toContain(`Read the join guide first: ${origin}/agent/${roomId}.md`);
  // The secret appears exactly once, inside the connect command, never in the guide URL.
  expect(text.split('#tok_ABC-123').length - 1).toBe(1);
  expect(text).toContain(`bunx @wormdb/meshrooms@0.2.0-beta.2 connect '${link}' --harness 'Codex CLI'`);
  expect(text).toContain('ask me before installing it');
  // Each return from listen costs the agent a turn: one long wait at a time, never a timer that polls it.
  expect(text).toContain('4. Then follow the guide: wait with one long `listen` at a time, never schedule repeated polling, and reply only when someone addresses you.');
});

test('each harness choice fills in its name, and "other" leaves a placeholder', () => {
  expect(agentPrompt({ origin, roomId, link, name: 'A', version: '0.2.0-beta.2', harness: 'claude' })).toContain("--harness 'Claude Code'");
  // Someone who talks to their agent in the Codex desktop app says so; the CLI keeps its own label.
  expect(agentPrompt({ origin, roomId, link, name: 'A', version: '0.2.0-beta.2', harness: 'codexApp' })).toContain("--harness 'Codex app'");
  expect(agentPrompt({ origin, roomId, link, name: 'A', version: '0.2.0-beta.2', harness: 'hermes' })).toContain("--harness 'Hermes Agent'");
  expect(agentPrompt({ origin, roomId, link, name: 'A', version: '0.2.0-beta.2', harness: 'dsh' })).toContain("--harness 'DeepSeek Harness'");
  expect(agentPrompt({ origin, roomId, link, name: 'A', version: '0.2.0-beta.2', harness: 'other' })).toContain("--harness '<your harness>'");
});

test('without a valid version from the service the prompt falls back to latest, never to a bare package name', () => {
  for (const version of [undefined, '', 'latest; rm -rf ~', '1.2']) {
    const text = agentPrompt({ origin, roomId, link, name: 'A', version, harness: 'other' });
    expect(text).toContain('bunx @wormdb/meshrooms@latest connect');
    expect(text).not.toContain('rm -rf');
  }
});

test('a Grok Bot is told to use its own agent folder, the pinned Grok Bot guide and no model, and the token stays in the connect command only', () => {
  const text = agentPrompt({ origin, roomId, link, name: 'Grokky Bot!', version: '0.2.0-beta.8', harness: 'grok' });
  expect(text).toContain(`Read the join guide first: ${origin}/agent/${roomId}.md`);
  expect(text).toContain('https://raw.githubusercontent.com/igorls/meshrooms/bridge-v0.2.0-beta.8/skills/meshrooms-grok-bot/SKILL.md');
  expect(text).toContain(`export MESHROOMS_AGENT_HOME="$HOME/.meshrooms/agents-grokky-bot"; bun x @wormdb/meshrooms@0.2.0-beta.8 connect '${link}' --harness 'Grok Bot'`);
  expect(text).not.toContain('--model');
  expect(text.split('#tok_ABC-123').length - 1).toBe(1);
  expect(text).toContain('only through a secure form, never in chat');
  expect(text).toContain("Don't poll the room on a schedule.");
  // A name with nothing usable still gets a folder of its own, never the shared default.
  expect(agentPrompt({ origin, roomId, link, name: '— —', version: '0.2.0-beta.8', harness: 'grok' })).toContain('/.meshrooms/agents-grok"');
  // No valid version: latest bridge and the guide on main, never a crafted ref.
  expect(grokGuideUrl('x; rm -rf ~')).toBe('https://raw.githubusercontent.com/igorls/meshrooms/main/skills/meshrooms-grok-bot/SKILL.md');
  expect(agentPrompt({ origin, roomId, link, name: 'G', harness: 'grok' })).toContain('bun x @wormdb/meshrooms@latest connect');
});
