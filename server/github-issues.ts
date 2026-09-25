/**
 * Tasks and GitHub issues, for agents. Meshrooms holds no GitHub token: an agent uses its own GitHub CLI (`gh`),
 * signed in as whoever operates it, and the room only ever stores the issue's link.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { issueLabel, issueLinkFrom } from '../src/browser/board';
import { validRepository } from '../src/browser/protocol';

/** Runs `gh` with arguments (never through a shell) and optional standard input; returns its output. */
export type Gh = (args: string[], input?: string) => string;
/** A `gh` that ran out of time may have done what it was asked (the issue may exist). */
export class UncertainGh extends Error {}

export const runGh: Gh = (args, input) => {
  try { return execFileSync('gh', args, { input: input ?? '', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000, windowsHide: true }); }
  catch (error) {
    const e = error as { code?: string; stderr?: string; message?: string };
    if (e.code === 'ENOENT') throw new Error('The GitHub CLI (gh) is not installed here. Install it and run gh auth login, or open the issue on GitHub yourself and link it with task-update --issue <link>.');
    if (e.code === 'ETIMEDOUT' || (e as { signal?: string }).signal) throw new UncertainGh(`gh ${args.slice(0, 2).join(' ')} did not finish in time, so it may have gone through.`);
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${String(e.stderr || e.message || error).trim().split('\n')[0]}`);
  }
};

/** The repository a task opens its issue in: the one named, or the room's only pinned one. */
export function issueRepository(pinned: string[], named?: string): string {
  if (named !== undefined) {
    if (!validRepository(named)) throw new Error('Use --repo owner/name.');
    return named;
  }
  if (pinned.length === 1) return pinned[0];
  throw new Error(pinned.length ? `This room pins several repositories; choose one with --repo: ${pinned.join(', ')}.`
    : 'This room has no pinned repository. Use --repo owner/name, or ask a person to pin one in Room details.');
}

/** Opens an issue for a task with `gh`; returns its link. The task's notes become the issue's description. */
export function createIssue(gh: Gh, repository: string, title: string, notes: string): string {
  const out = gh(['issue', 'create', '--repo', repository, '--title', title, '--body-file', '-'], notes);
  const link = out.split(/\s+/).map(word => word.startsWith('https://') ? issueLinkFrom(word) : undefined).filter(Boolean).at(-1);
  if (!link) throw new Error(`gh did not print the new issue's link: ${out.trim().slice(0, 200)}`);
  return link;
}

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/**
 * A task drafted from an issue or pull request: its title, the start of its description as notes, and its link.
 * GitHub's issues API answers for pull requests too, and its `html_url` says which one it is.
 */
export function issueDraft(gh: Gh, link: string): { title: string; notes: string; issue: string } {
  const [, owner, name, , number] = new URL(link).pathname.split('/');
  const found = JSON.parse(gh(['api', `repos/${owner}/${name}/issues/${number}`])) as { title?: unknown; body?: unknown; html_url?: unknown };
  const issue = issueLinkFrom(String(found.html_url ?? '')) ?? link;
  return { title: clip(String(found.title ?? '').trim() || issueLabel(issue), 120), notes: clip(String(found.body ?? '').trim(), 2000), issue };
}

/** The same issue or pull request, whichever of the two link forms each uses. */
export function sameIssue(a: string, b: string) {
  const key = (link: string) => { const [, owner, name, , number] = new URL(link).pathname.split('/'); return `${owner}/${name}#${number}`.toLowerCase(); };
  return key(a) === key(b);
}

/**
 * Opens at most one issue per request id, so retrying a request whose task update failed links the issue it already
 * opened instead of opening a second one. Each request is claimed with its own file, created exclusively, so two runs
 * of one request can't both open an issue and no run overwrites another's record.
 */
export function openIssueOnce(dir: string, requestId: string, open: () => string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record = join(dir, `${requestId}.txt`);
  let claim: number;
  try { claim = openSync(record, 'wx', 0o600); }
  catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
    const held = readFileSync(record, 'utf8'), link = issueLinkFrom(held);
    if (link) return link;
    const pid = Number(/^opening (\d+)$/.exec(held)?.[1]);
    let running = false; try { process.kill(pid, 0); running = true; } catch (e) { running = (e as { code?: string }).code === 'EPERM'; }
    if (pid && running) throw new Error('This request is already opening an issue. Wait for it, then run tasks.');
    throw new Error('An earlier run of this request stopped while opening the issue, so it may exist. Check the repository on GitHub: link it with task-update --issue <link>, or open one with a new request id.');
  }
  try { writeSync(claim, `opening ${process.pid}`); } finally { closeSync(claim); }
  let link: string;
  try { link = open(); }
  catch (error) {
    // Nothing was opened, so the request can be retried; after a timeout it may have been, so the claim stays.
    if (error instanceof UncertainGh) writeFileSync(record, 'uncertain', { mode: 0o600 }); else rmSync(record, { force: true });
    throw error;
  }
  writeFileSync(record, link, { mode: 0o600 });
  return link;
}
