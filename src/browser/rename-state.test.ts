import { expect, test } from 'bun:test';
import type { BrowserMember } from './protocol';
import { MAX_AGENT_NAME, canRenameAgent, renameLine, renameProblem } from './rename-state';

const alex: BrowserMember = { id: 'alex', name: 'Alex', role: 'human' };
const sam: BrowserMember = { id: 'sam', name: 'Sam', role: 'human' };
const codex: BrowserMember = { id: 'codex', name: 'Codex', role: 'agent', operatorId: 'sam' };
const wren: BrowserMember = { id: 'wren', name: 'Wren', role: 'agent', operatorId: 'alex' };
const members = [alex, sam, codex, wren];

test('the host renames any agent, a person only the agents they operate, and nobody renames people or themselves', () => {
  expect(canRenameAgent(codex, alex, 'alex')).toBe(true);
  expect(canRenameAgent(wren, alex, 'alex')).toBe(true);
  expect(canRenameAgent(codex, sam, 'alex')).toBe(true);
  expect(canRenameAgent(wren, sam, 'alex')).toBe(false);
  expect(canRenameAgent(sam, alex, 'alex')).toBe(false);
  expect(canRenameAgent(alex, alex, 'alex')).toBe(false);
  expect(canRenameAgent(codex, codex, 'alex')).toBe(false);
  expect(canRenameAgent(wren, wren, 'alex')).toBe(false);
  expect(canRenameAgent(codex, undefined, 'alex')).toBe(false);
  // A member from before agents existed has no role and is a person.
  expect(canRenameAgent(codex, { id: 'sam', name: 'Sam' }, 'alex')).toBe(true);
});

test('a name is checked as the room service will check it', () => {
  expect(renameProblem('Scout', codex, members)).toBeUndefined();
  expect(renameProblem('  Scout   Two ', codex, members)).toBeUndefined();
  expect(renameProblem('x'.repeat(MAX_AGENT_NAME), codex, members)).toBeUndefined();
  expect(renameProblem('', codex, members)).toBe('Enter a name.');
  expect(renameProblem(' \u200b ', codex, members)).toBe('Enter a name.');
  expect(renameProblem('x'.repeat(MAX_AGENT_NAME + 1), codex, members)).toContain('64 characters');
  expect(renameProblem('Agents', codex, members)).toContain('reserved');
  expect(renameProblem(' ＡＧＥＮＴＳ ', codex, members)).toContain('reserved');
  expect(renameProblem('Codex', codex, members)).toBe('That is already its name.');
  for (const taken of ['wren', ' WREN ', 'ＷＲＥＮ', 'sam', 'Alex']) expect(renameProblem(taken, codex, members)).toContain('already uses that name');
  // Its own name in another case is a change; a link waiting for someone else's agent holds its name.
  expect(renameProblem('CODEX', codex, members)).toBeUndefined();
  expect(renameProblem('Later', codex, members, ['Later'])).toContain('already uses that name');
  expect(renameProblem('later', codex, members, ['Later'])).toContain('already uses that name');
});

test('the timeline says who renamed which agent, by name, and “You” for this person', () => {
  const notice = { id: 'r1', at: 1, memberId: 'codex', by: 'sam', from: 'Codex', to: 'Scout' };
  const nameOf = (id: string) => members.find(m => m.id === id)?.name;
  expect(renameLine(notice, 'alex', nameOf)).toBe('Sam renamed agent “Codex” to “Scout”');
  expect(renameLine(notice, 'sam', nameOf)).toBe('You renamed agent “Codex” to “Scout”');
  expect(renameLine({ ...notice, by: 'gone' }, 'alex', nameOf)).toBe('A former member renamed agent “Codex” to “Scout”');
});
