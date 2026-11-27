import { expect, test } from 'bun:test';
import { PROMPT_HARNESSES, PROMPT_HARNESS_META, defaultAgentName, harnessFromName, isLinkOnlyHarness, isPromptHarness } from './agent-prompt';
import { AGENT_LINK_TTL, agentLinkState, formatCountdown, inviteSteps } from './invite-state';

test('the dialog lists every prompt harness once, with the prompt\'s own label, and a placeholder for "something else"', () => {
  expect((PROMPT_HARNESS_META.map(h => h.id) as string[]).sort()).toEqual((Object.keys(PROMPT_HARNESSES) as string[]).sort());
  for (const h of PROMPT_HARNESS_META) { expect(h.badge.length).toBeGreaterThan(0); if (h.id !== 'other') expect(h.label).toBe(PROMPT_HARNESSES[h.id]); }
  expect(PROMPT_HARNESS_META.find(h => h.id === 'other')!.label).toBe('Something else');
  expect(defaultAgentName('bentokit')).toBe('BentoKit');
  expect(defaultAgentName('grok')).toBe('Grok Bot');
  expect(defaultAgentName('other')).toBe('');
  expect(isLinkOnlyHarness('bentokit')).toBe(true);
  expect(isLinkOnlyHarness('claude')).toBe(false);
  expect(isLinkOnlyHarness('grok')).toBe(false);
  expect(isPromptHarness('claude')).toBe(true);
  expect(isPromptHarness('bentokit')).toBe(true);
  expect(isPromptHarness('toString')).toBe(false);
  expect(isPromptHarness(undefined)).toBe(false);
});

test('a name that says which harness it is picks it, as before', () => {
  expect(harnessFromName('My Codex')).toBe('codex');
  expect(harnessFromName('claude-2')).toBe('claude');
  expect(harnessFromName('Antigravity')).toBe('agy');
  expect(harnessFromName('BentoKit Integrator')).toBe('bentokit');
  expect(harnessFromName('Bento desktop')).toBe('bentokit');
  expect(harnessFromName('Hermes')).toBe('hermes');
  expect(harnessFromName('DeepSeek helper')).toBe('dsh');
  expect(harnessFromName('Grok Bot')).toBe('grok');
  expect(harnessFromName('Wren')).toBeUndefined();
});

test('an agent link is open until the room stops listing it, then used or joined; time runs it out', () => {
  const createdAt = 1_000_000, expiresAt = createdAt + AGENT_LINK_TTL, base = { createdAt, listed: true, joined: false };
  // Status hasn't listed it yet: still open, and it expires on its own clock if it never shows up.
  expect(agentLinkState({ ...base, listed: false, now: createdAt + 5_000 })).toBe('open');
  expect(agentLinkState({ ...base, listed: false, now: expiresAt })).toBe('expired');
  expect(agentLinkState({ ...base, expiresAt, now: createdAt + 1 })).toBe('open');
  expect(agentLinkState({ ...base, expiresAt, now: expiresAt })).toBe('expired');
  // Not listed any more, before its time: it was used and the agent isn't in the room yet (a guest's agent waits for the host).
  expect(agentLinkState({ ...base, expiresAt, listed: false, now: expiresAt - 1 })).toBe('used');
  expect(agentLinkState({ ...base, expiresAt, listed: false, now: expiresAt + 1 })).toBe('expired');
  // ...unless it was seen used: waiting for the host longer than 15 minutes is not an expired link.
  expect(agentLinkState({ ...base, expiresAt, listed: false, wasUsed: true, now: expiresAt + 60_000 })).toBe('used');
  // Joined wins over everything.
  expect(agentLinkState({ ...base, expiresAt, listed: false, joined: true, now: expiresAt + 1 })).toBe('joined');
  expect(agentLinkState({ ...base, expiresAt, joined: true, now: createdAt })).toBe('joined');
});

test('the steps follow the link state and whether it was copied', () => {
  expect(inviteSteps('open', false)).toEqual(['now', 'todo', 'todo']);
  expect(inviteSteps('open', true)).toEqual(['done', 'now', 'todo']);
  expect(inviteSteps('used', true)).toEqual(['done', 'done', 'now']);
  expect(inviteSteps('joined', false)).toEqual(['done', 'done', 'done']);
  expect(inviteSteps('expired', true)).toEqual(['done', 'bad', 'todo']);
  expect(inviteSteps('expired', false)).toEqual(['todo', 'bad', 'todo']);
});

test('the countdown reads minutes and seconds and never goes negative', () => {
  expect(formatCountdown(AGENT_LINK_TTL)).toBe('15:00');
  expect(formatCountdown(14 * 60_000 + 32_000)).toBe('14:32');
  expect(formatCountdown(999)).toBe('0:01');
  expect(formatCountdown(-5_000)).toBe('0:00');
});
