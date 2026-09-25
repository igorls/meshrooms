import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIssue, issueDraft, issueRepository, openedIssues, sameIssue, type Gh } from './github-issues';

test("an agent opens an issue for a task with its own gh, in the room's pinned repository", () => {
  expect(issueRepository(['igorls/meshrooms'])).toBe('igorls/meshrooms');
  expect(() => issueRepository(['a/b', 'c/d'])).toThrow('--repo: a/b, c/d');
  expect(() => issueRepository([])).toThrow('no pinned repository');
  expect(issueRepository(['a/b', 'c/d'], 'c/d')).toBe('c/d');
  expect(() => issueRepository([], 'c/..')).toThrow('owner/name');
  const calls: [string[], string | undefined][] = [];
  const gh: Gh = (args, input) => { calls.push([args, input]); return 'Creating issue in igorls/meshrooms\n\nhttps://github.com/igorls/meshrooms/issues/77\n'; };
  // Room text goes to gh as arguments and standard input, never through a shell.
  expect(createIssue(gh, 'igorls/meshrooms', 'Fix `header`; rm -rf ~', 'Notes $(whoami)')).toBe('https://github.com/igorls/meshrooms/issues/77');
  expect(calls).toEqual([[['issue', 'create', '--repo', 'igorls/meshrooms', '--title', 'Fix `header`; rm -rf ~', '--body-file', '-'], 'Notes $(whoami)']]);
  expect(() => createIssue(() => 'something went sideways', 'a/b', 't', '')).toThrow('did not print');
});

test('a task drafted from an issue or pull request takes its title and the start of its description', () => {
  const gh: Gh = args => {
    expect(args).toEqual(['api', 'repos/igorls/meshrooms/issues/7']);
    return JSON.stringify({ title: 'T'.repeat(200), body: 'B'.repeat(3000), html_url: 'https://github.com/igorls/meshrooms/pull/7' });
  };
  const draft = issueDraft(gh, 'https://github.com/igorls/meshrooms/issues/7');
  expect(draft.issue).toBe('https://github.com/igorls/meshrooms/pull/7'); // GitHub says it's a pull request
  expect([draft.title.length, draft.title.endsWith('…'), draft.notes.length]).toEqual([120, true, 2000]);
  expect(issueDraft(() => JSON.stringify({ title: '', body: null, html_url: 'https://evil.dev/x' }), 'https://github.com/a/b/issues/1'))
    .toEqual({ title: 'a/b#1', notes: '', issue: 'https://github.com/a/b/issues/1' });
  expect(sameIssue('https://github.com/A/b/issues/7', 'https://github.com/a/b/pull/7')).toBe(true);
  expect(sameIssue('https://github.com/a/b/issues/7', 'https://github.com/a/b/issues/8')).toBe(false);
});

test('a retried request links the issue it already opened', () => {
  const opened = openedIssues(join(mkdtempSync(join(tmpdir(), 'mr-issues-')), 'issues-opened.json')), id = crypto.randomUUID();
  expect(opened.get(id)).toBeUndefined();
  opened.set(id, 'https://github.com/a/b/issues/1');
  expect(opened.get(id)).toBe('https://github.com/a/b/issues/1');
});
