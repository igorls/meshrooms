import { describe, expect, test } from 'bun:test';
import { issueLinkFrom, taskBody, validIssueLink, validTaskBody } from './board';

describe('GitHub issue/PR link validation (COL-5)', () => {
  test('validIssueLink rejects issue/PR number #0 and leading zeros, accepts >= 1', () => {
    expect(validIssueLink('https://github.com/example/app/issues/0')).toBe(false);
    expect(validIssueLink('https://github.com/example/app/pull/0')).toBe(false);
    expect(validIssueLink('https://github.com/example/app/issues/00')).toBe(false);
    expect(validIssueLink('https://github.com/example/app/issues/01')).toBe(false);
    expect(validIssueLink('https://github.com/example/app/pull/042')).toBe(false);
    expect(validIssueLink('https://github.com/example/app/issues/1000000000')).toBe(false);

    expect(validIssueLink('https://github.com/example/app/issues/1')).toBe(true);
    expect(validIssueLink('https://github.com/example/app/pull/1')).toBe(true);
    expect(validIssueLink('https://github.com/example/app/issues/42')).toBe(true);
    expect(validIssueLink('https://github.com/example/app/pull/42')).toBe(true);
    expect(validIssueLink('https://github.com/example/app/issues/999999999')).toBe(true);
  });

  test('issueLinkFrom rejects #0 and leading zeros in shorthand and URLs, accepts #1 and #42', () => {
    for (const bad of [
      'example/app#0',
      'example/app#00',
      'example/app#01',
      'example/app#042',
      'https://github.com/example/app/issues/0',
      'https://github.com/example/app/pull/0',
      'https://github.com/example/app/issues/0#issuecomment-1',
      'https://www.github.com/example/app/pull/0/files',
      'https://github.com/example/app/issues/01',
      'example/app#1000000000',
    ]) {
      expect(issueLinkFrom(bad)).toBeUndefined();
    }

    expect(issueLinkFrom('example/app#1')).toBe('https://github.com/example/app/issues/1');
    expect(issueLinkFrom('example/app#42')).toBe('https://github.com/example/app/issues/42');
    expect(issueLinkFrom('https://github.com/example/app/issues/1#issuecomment-5')).toBe('https://github.com/example/app/issues/1');
    expect(issueLinkFrom('https://www.github.com/example/app/pull/42/files?w=1')).toBe('https://github.com/example/app/pull/42');
  });

  test('taskBody and validTaskBody reject #0 issue links and accept #1 / #42', () => {
    const roomId = crypto.randomUUID(), memberId = crypto.randomUUID(), deviceId = 'a'.repeat(64);
    expect(() => taskBody({ roomId, deviceId, memberId, change: { title: 'Zero', issue: 'https://github.com/example/app/issues/0' } })).toThrow('GitHub issue');
    const valid = taskBody({ roomId, deviceId, memberId, change: { title: 'One', issue: 'https://github.com/example/app/issues/1' } });
    expect(validTaskBody(valid, roomId)).toBe(true);
    expect(validTaskBody({ ...valid, issue: 'https://github.com/example/app/issues/0' }, roomId)).toBe(false);
    expect(validTaskBody({ ...valid, issue: 'https://github.com/example/app/pull/0' }, roomId)).toBe(false);
    expect(validTaskBody({ ...valid, issue: 'https://github.com/example/app/pull/42' }, roomId)).toBe(true);
  });
});
