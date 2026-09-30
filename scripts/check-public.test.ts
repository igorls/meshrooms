import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIN_TERMS, REPO, decode, parseAllow, parseTerms, patternHits, readExcludes, scan, scanText, termWarnings, type Allow } from './check-public';

// This file ships in the public tree, so it must pass the gate itself: every user path, private
// address, host name, email and suppression marker below is assembled at runtime, and the term
// tests use made-up terms.
const winPath = (...parts: string[]) => ['C:', 'Users', ...parts].join('\\');
const kinds = (line: string, file = 'docs/x.md') => patternHits(line, file).map(hit => hit.kind);
const ip = (...octets: number[]) => octets.join('.');
const at = (local: string, domain: string) => [local, domain].join('@');
const dotted = (...labels: string[]) => labels.join('.');
const fillerTerms = (n: number) => Array.from({ length: n }, (_, i) => `filler${i}term`).join('\n');

function tempTree(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'meshrooms-check-public-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

test('terms match case-insensitively on word boundaries, with quoted and prefix forms', () => {
  const terms = parseTerms('# comment\n\nhamlet\n"Blue Room"\ntok_*\nwin:box\na.b\n');
  const hits = (line: string) => scanText('f', line, terms).map(hit => hit.match);
  expect(hits('Hamlet, then hamlet.')).toEqual(['Hamlet', 'hamlet']);
  expect(hits('hamlets and xhamlet and hamlet2')).toEqual([]); // the handle-next-to-the-username case
  expect(hits('hamlet-9 and /hamlet/')).toEqual(['hamlet', 'hamlet']);
  expect(hits('the blue   room is open')).toEqual(['blue   room']);
  expect(hits('tok_20260929 and tok_ and mytok_1')).toEqual(['tok_', 'tok_']);
  expect(hits('win:box:project')).toEqual(['win:box']);
  expect(hits('axb')).toEqual([]); // regex characters in a term are literal
});

test('a prefix term catches suffixed and camel-case variants of a name', () => {
  const terms = parseTerms('ophelia*\n');
  const hits = (line: string) => scanText('f', line, terms).map(hit => hit.match);
  expect(hits('Ophelia2 OpheliaDev ophelia-dev ophelia_bot ophelia')).toEqual(['Ophelia', 'Ophelia', 'ophelia', 'ophelia', 'ophelia']);
  expect(hits('xophelia myOphelia')).toEqual([]);
});

test('inline comments in the terms list are reported', () => {
  expect(termWarnings('hamlet\n"# not a comment"\nophelia  # a note\n# ok\n')).toEqual([
    'private-terms line 3: "#" after a term is part of the term, not a comment; put comments on their own line',
  ]);
});

test('--require-terms fails on a missing or short terms list', () => {
  const root = tempTree({ 'README.md': 'hello\n', 'short.txt': 'hamlet\nophelia\n', 'full.txt': fillerTerms(MIN_TERMS) });
  try {
    expect(() => scan({ tree: root, terms: join(root, 'missing.txt'), requireTerms: true, gitleaks: 'skip' })).toThrow('no private-terms list');
    expect(() => scan({ tree: root, terms: join(root, 'short.txt'), requireTerms: true, gitleaks: 'skip' })).toThrow(`at least ${MIN_TERMS}`);
    expect(scan({ tree: root, terms: join(root, 'full.txt'), requireTerms: true, gitleaks: 'skip' }).terms).toBe(MIN_TERMS);
    // Without --require-terms the scan uses whatever list exists; the public repo has none.
    expect(scan({ tree: root, gitleaks: 'skip' }).hits).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('user-profile paths with a real user name are flagged in every form and on any drive', () => {
  const name = 'kowalski';
  for (const line of [
    `Bun is ${winPath(name, '.bun', 'bin', 'bun.exe')}`,
    `"${['C:', 'Users', name].join('/')}/repo"`,
    `"${['D:', 'Users', name].join('\\')}\\repo"`,
    JSON.stringify({ path: winPath(name, 'repo') }), // JSON-escaped backslashes
    `cd /c/${'Users'}/${name}/repo`,
    `open /${'Users'}/${name}/Library`,
    `ssh box ls /${'home'}/${name}/.config`,
    `file:///${['C:', 'Users', name].join('/')}/x`,
  ]) expect(kinds(line)).toEqual(['user-path']);
});

test('placeholder user names and web paths are not flagged', () => {
  for (const line of [
    winPath('<user>', 'x'), winPath('you', 'x'), winPath('Jane Doe', 'x'), `/${'home'}/runner/work`,
    winPath('USERNAME', 'x'), winPath('$env:USERNAME'), `/${'Users'}/$USER/x`, winPath('%USERNAME%'),
    `$env:USERPROFILE\\.meshrooms`, `see https://api.github.com/${'users'}/kowalski/repos`,
  ]) expect(kinds(line)).toEqual([]);
});

test('private, shared and CGNAT addresses are flagged; public and malformed ones are not', () => {
  for (const address of [ip(10, 1, 2, 3), ip(172, 16, 0, 1), ip(172, 31, 255, 1), ip(192, 168, 1, 50), ip(100, 64, 0, 1), ip(100, 127, 9, 9)]) {
    expect(kinds(`connect ${address}:4318`)).toEqual(['private-ip']);
  }
  for (const address of [ip(172, 32, 0, 1), ip(100, 128, 0, 1), ip(8, 8, 8, 8), ip(203, 0, 113, 10), ip(10, 1, 2, 256), `${ip(10, 1, 2, 3)}.4`, `1${ip(10, 1, 2, 3)}`]) {
    expect(kinds(`connect ${address}`)).toEqual([]);
  }
});

test('unique-local IPv6 addresses are flagged, including the tailnet range', () => {
  for (const address of [['fd7a', '115c', 'a1e0', '', '1'].join(':'), ['fd00', '', '1'].join(':'), ['fdab', 'cd', '1', '2', '3', '4', '5', '6'].join(':')]) {
    expect(kinds(`peer ${address} up`)).toEqual(['private-ipv6']);
  }
  for (const text of [['2001', 'db8', '', '1'].join(':'), 'fd12 is not an address', `color: #fd1234`]) expect(kinds(text)).toEqual([]);
});

test('tailnet and LAN host names are flagged', () => {
  expect(kinds(`ssh root@${dotted('box', 'tail1234', 'ts', 'net')}`)).toEqual(['tailnet-host', 'email']); // user@host names a host too
  expect(kinds('see ts.network.example and posts.nets')).toEqual([]);
  for (const host of [dotted('nas', 'lan'), dotted('printer', 'home', 'arpa'), dotted('build-box', 'local'), dotted('metadata', 'corp', 'internal')]) {
    expect(kinds(`ping ${host}`)).toEqual(['lan-host']);
  }
  for (const text of ['http://localhost:4318', "join(dir, '.local', 'native')", 'the local node', dotted('app', 'localhost')]) expect(kinds(text)).toEqual([]);
});

test('email addresses are flagged unless they are placeholders', () => {
  expect(kinds(`mail ${at('ops', 'corp.dev')} today`)).toEqual(['email']);
  expect(kinds(`<${at('jane.doe+x', 'mail.co.uk')}>`)).toEqual(['email']);
  for (const text of [at('4753812+someone', 'users.noreply.github.com'), at('noreply', 'wormdb.dev'), at('me', 'example.com'),
    at('test', 'example.org'), at('a', 'b.test'), `${at('git', 'github.com')}:owner/repo.git`, `icon ${at('128x128', '2x.png')}`,
    'bunx @wormdb/meshrooms@0.2.0-beta.2 connect']) {
    expect(kinds(text)).toEqual([]);
  }
});

test('room links are flagged outside tests and fixtures', () => {
  const room = crypto.randomUUID();
  expect(kinds(`open https://rooms.example/r/${room}`, 'docs/guide.md')).toEqual(['room-link']);
  expect(kinds(`open /r/${room}`, 'server/browser/http.test.ts')).toEqual([]);
  expect(kinds('smoke /r/00000000-0000-4000-8000-000000000000', 'scripts/smoke.sh')).toEqual([]);
  expect(kinds('open /r/<room id>', 'docs/guide.md')).toEqual([]);
});

test('anything that would silence gitleaks is flagged unless the allow list names it', () => {
  const marker = ['gitleaks', 'allow'].join(':');
  const root = tempTree({
    '.gitleaksignore': 'abc:rule:1\n',
    'config/.gitleaks.toml': '[allowlist]\n',
    'src/key.ts': `const key = 'x'; // ${marker}\n`,
    'src/ok.ts': `const other = 'y'; // ${marker} fixture\n`,
    'scripts/check-public.allow': `src/ok.ts ${marker}  # a documented test fixture\nconfig/.gitleaks.toml .gitleaks.toml  # a vendored example config\n`,
  });
  try {
    const result = scan({ tree: root, gitleaks: 'skip' });
    expect(result.hits.map(hit => `${hit.file}:${hit.line}:${hit.kind}`).sort()).toEqual([
      '.gitleaksignore:0:gitleaks-suppression', 'src/key.ts:1:gitleaks-suppression',
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the allow list needs a reason, covers only its own literal, and never covers a private term', () => {
  expect(() => parseAllow('deploy/x.conf literal-without-reason\n')).toThrow('<reason>');
  const range = `denied-peer-ip=${ip(10, 0, 0, 0)}-${ip(10, 255, 255, 255)}`;
  const allow = parseAllow(`# comment\ndeploy/x.conf ${range}  # documented relay config\n`);
  expect(allow).toEqual([{ path: 'deploy/x.conf', literal: range, reason: 'documented relay config', line: 2 }]);
  const used = new Set<Allow>();
  const terms = parseTerms('hamlet\n');
  const hits = scanText('deploy/x.conf', `${range}\nhamlet ${range}\nrelay ${ip(10, 1, 1, 1)}\n`, terms, allow, used);
  expect(hits.map(hit => [hit.line, hit.kind])).toEqual([[2, 'private-term'], [3, 'private-ip']]);
  expect(used.size).toBe(1);
  expect(scanText('other/file', range, [], allow).map(hit => hit.kind)).toEqual(['private-ip', 'private-ip']);
});

test('UTF-16 text is decoded before scanning, with or without a byte-order mark', () => {
  const line = `run from ${winPath('kowalski', 'repo')}\r\n`;
  const le = Buffer.from(line, 'utf16le');
  const be = Buffer.from(le).swap16();
  for (const bytes of [Buffer.concat([Buffer.from([0xff, 0xfe]), le]), Buffer.concat([Buffer.from([0xfe, 0xff]), be]), le, be]) {
    const decoded = decode(bytes);
    expect(decoded.binary).toBe(false);
    expect(decoded.text).toBe(line);
  }
  const root = tempTree({ 'notes/utf16.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), le]) });
  try {
    const result = scan({ tree: root, gitleaks: 'skip' });
    expect(result.binaries).toEqual([]);
    expect(result.hits.map(hit => `${hit.file}:${hit.line}:${hit.kind}`)).toEqual(['notes/utf16.txt:1:user-path']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a tree scan checks paths, binaries, link targets and stale allow entries', () => {
  const root = tempTree({
    'notes/hamlet-plan.md': `run from ${winPath('kowalski', 'repo')}\n`,
    'notes/image.png': Buffer.concat([Buffer.from([0x89, 0, 1, 2]), Buffer.from('author=Hamlet tools'), Buffer.from([0, 0])]),
    '.git/config': 'hamlet\n', // never scanned
    '.git/terms.txt': 'hamlet\n',
    'scripts/check-public.allow': `notes/gone.md ${ip(10, 9, 9, 9)}  # no longer needed\n`,
  });
  let linked = false;
  try { symlinkSync(`../../${dotted('hamlet', 'lan')}/share`, join(root, 'notes/link')); linked = true; } catch { /* no symlink rights */ }
  try {
    const result = scan({ tree: root, terms: join(root, '.git', 'terms.txt'), gitleaks: 'skip' });
    expect(result.binaries).toEqual(['notes/image.png']);
    expect(result.hits.map(hit => `${hit.file}:${hit.line}:${hit.kind}`).sort()).toEqual([
      'notes/hamlet-plan.md:0:private-term', 'notes/hamlet-plan.md:1:user-path', 'notes/image.png:0:private-term',
      ...(linked ? ['notes/link:1:lan-host', 'notes/link:1:private-term'] : []),
      'scripts/check-public.allow:1:stale-allow',
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the export exclude list must drop internal/', () => {
  const root = tempTree({ 'internal/export-exclude.txt': '# nothing\ndocs/x.md\n' });
  try {
    expect(() => readExcludes(root)).toThrow('internal/');
    writeFileSync(join(root, 'internal/export-exclude.txt'), 'internal/\ndocs/x.md\n');
    expect(readExcludes(root)).toEqual(['internal/', 'docs/x.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The versions of files that leaked while the repository was public, listed in internal/ so no
// private revision is named in the public tree. Each is read from git history when the objects
// are present (the privacy CI job fetches full history), otherwise from minimal excerpts kept in
// internal/. The public repo has neither, so it skips these.
const termsFile = join(REPO, 'internal/private-terms.txt');
const leaksFile = join(REPO, 'internal/known-leaks.json');

function leakedVersion(commit: string, path: string): { text: string; from: string } | undefined {
  const shown = spawnSync('git', ['-C', REPO, 'show', `${commit}:${path}`], { encoding: 'utf8' });
  if (shown.status === 0) return { text: shown.stdout, from: 'git' };
  const fixture = join(REPO, 'internal/fixtures/known-leaks', commit, path);
  return existsSync(fixture) ? { text: readFileSync(fixture, 'utf8'), from: 'fixture' } : undefined;
}

test.skipIf(!existsSync(termsFile) || !existsSync(leaksFile))('the gate flags every file version that leaked while the repo was public', () => {
  const terms = parseTerms(readFileSync(termsFile, 'utf8'));
  const leaks = JSON.parse(readFileSync(leaksFile, 'utf8')) as { commit: string; path: string; kind: string }[];
  expect(leaks.length).toBeGreaterThan(0);
  for (const leak of leaks) {
    const version = leakedVersion(leak.commit, leak.path);
    expect(version, `${leak.commit}:${leak.path}`).toBeDefined();
    const hits = scanText(leak.path, version!.text, terms);
    expect(hits.some(hit => hit.kind === leak.kind), `${leak.commit}:${leak.path} (${version!.from})`).toBe(true);
    // The user-path leak is caught by the built-in patterns alone, as it would be in the public repo.
    if (leak.kind === 'user-path') expect(scanText(leak.path, version!.text, []).some(hit => hit.kind === 'user-path')).toBe(true);
  }
});

test.skipIf(!existsSync(termsFile))('names of people, agents and projects in the terms list are prefix terms', () => {
  let section = '';
  const missing: number[] = []; // line numbers only, so a failure never prints a term
  readFileSync(termsFile, 'utf8').split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line.startsWith('# ')) { section = line; return; }
    if (!line || line.startsWith('#') || line.startsWith('"')) return;
    if (/people|projects/i.test(section) && !line.endsWith('*')) missing.push(index + 1);
  });
  expect(missing).toEqual([]);
});

test('the tracked tree passes the gate', () => {
  const result = scan({ gitleaks: 'skip', requireTerms: existsSync(termsFile) });
  expect(result.hits.map(hit => `${hit.file}:${hit.line}: ${hit.kind}`)).toEqual([]);
  expect(result.files).not.toContain('internal/private-terms.txt');
  expect(result.warnings).toEqual([]);
});
