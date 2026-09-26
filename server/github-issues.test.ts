import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { claimIssueTask, createIssue, issueDraft, issueRepository, openIssueOnce, releaseIssueTask, sameIssue, UncertainGh, type Gh } from './github-issues';

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

test('one request opens at most one issue, however it is retried', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'mr-issues-')), 'issues-opened'), [a, b, c, d] = [0, 1, 2, 3].map(() => crypto.randomUUID());
  let opened = 0;
  const open = () => `https://github.com/a/b/issues/${++opened}`;
  expect(openIssueOnce(dir, a, open)).toBe('https://github.com/a/b/issues/1');
  expect(openIssueOnce(dir, a, open)).toBe('https://github.com/a/b/issues/1'); // a retry reuses it
  expect(openIssueOnce(dir, b, open)).toBe('https://github.com/a/b/issues/2'); // another request keeps its own record
  expect(openIssueOnce(dir, a, open)).toBe('https://github.com/a/b/issues/1');
  // A run of the same request still opening its issue (this process) holds it; one that died may have opened it.
  writeFileSync(join(dir, `${c}.txt`), `opening ${process.pid}`);
  expect(() => openIssueOnce(dir, c, open)).toThrow('already opening');
  writeFileSync(join(dir, `${c}.txt`), `opening ${spawnSync(process.execPath, ['-e', '0']).pid}`);
  expect(() => openIssueOnce(dir, c, open)).toThrow('may exist');
  // gh refused: nothing was opened, so the request can be retried. gh timed out: it may have been, so it can't.
  expect(() => openIssueOnce(dir, d, () => { throw new Error('gh issue create failed: HTTP 403'); })).toThrow('403');
  expect(existsSync(join(dir, `${d}.txt`))).toBe(false);
  expect(() => openIssueOnce(dir, d, () => { throw new UncertainGh('timed out'); })).toThrow('timed out');
  expect(() => openIssueOnce(dir, d, open)).toThrow('may exist');
  expect(opened).toBe(2);
});

test('two runs adding the same issue: the second finds the first, and a stopped run is finished by retrying it', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'mr-issue-tasks-')), 'issue-tasks'), [a, b, c] = [0, 1, 2].map(() => crypto.randomUUID());
  const link = 'https://github.com/igorls/meshrooms/issues/7';
  expect(claimIssueTask(dir, link, a)).toBeUndefined();
  expect(claimIssueTask(dir, 'https://github.com/IGORLS/Meshrooms/pull/7', b)).toEqual({ requestId: a, running: true }); // same issue, still running
  expect(claimIssueTask(dir, link, a)).toBeUndefined(); // a retry of the same request
  // The first run stopped: nobody takes its claim over; retrying its own request id finishes it.
  writeFileSync(join(dir, 'igorls_meshrooms_7.txt'), `${a} ${spawnSync(process.execPath, ['-e', '0']).pid}`);
  expect(claimIssueTask(dir, link, b)).toEqual({ requestId: a, running: false });
  expect(claimIssueTask(dir, link, a)).toBeUndefined();
  // Released once the task is on the board (or nothing was queued), the issue can be claimed again.
  // The bridge also releases when it finishes an outbox item that linked an issue (queued-for-bridge path).
  releaseIssueTask(dir, link);
  expect(claimIssueTask(dir, link, c)).toBeUndefined();
});
