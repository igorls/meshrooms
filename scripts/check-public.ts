#!/usr/bin/env bun
/**
 * Privacy gate for the public snapshot.
 *
 *   bun scripts/check-public.ts [--tree DIR] [--terms FILE] [--require-terms] [--allow FILE]
 *                               [--no-gitleaks | --require-gitleaks] [--list-binaries]
 *
 * Scans every file and fails (exit 1) with file:line for each hit. Without --tree it scans the
 * repository's tracked files, minus the paths in internal/export-exclude.txt: a preview of what
 * scripts/export-public.sh would publish. With --tree it scans every file and symbolic link under
 * DIR (an exported tree), skipping .git/. A link is never followed; its target path is scanned.
 *
 * Layers:
 *   (a) private terms from internal/private-terms.txt (--terms points at another list). The public
 *       repo has no such list and runs without this layer; the development repo passes
 *       --require-terms, which fails when the list is missing or holds fewer than 20 terms.
 *   (b) built-in patterns, always on: user-profile paths with a real user name, RFC 1918 and
 *       CGNAT (100.64/10, which Tailscale uses) IPv4 addresses, unique-local IPv6 (the fd prefix),
 *       tailnet (*.ts.net) and LAN (.local, .lan, .internal, .home.arpa) host names, email
 *       addresses other than placeholders, and room links (/r/<uuid>) outside tests.
 *       scripts/check-public.allow (in the scanned tree) lists the few deliberate exceptions, each
 *       with its reason; an entry that no longer matches anything is an error. Private terms can
 *       never be allowed.
 *   (c) secrets: gitleaks, when it is on PATH (or GITLEAKS names the binary). --require-gitleaks
 *       makes a missing gitleaks an error (CI); --no-gitleaks skips it. Anything that would
 *       silence gitleaks (a .gitleaks.toml, a .gitleaksignore, an inline allow comment) is a hit
 *       unless the allow list names it.
 *
 * UTF-16 text (with a byte-order mark, or recognisable by its alternating zero bytes) is decoded
 * before scanning. Other binary files are not read as text: their printable strings are still
 * checked against (a) and (b), and every binary is listed at the end so a person looks at it: an
 * image can show what no scanner reads. --list-binaries prints just that list and exits 0.
 *
 * Exit: 0 clean, 1 hits, 2 usage or configuration error.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

export type HitKind = 'private-term' | 'user-path' | 'private-ip' | 'private-ipv6' | 'tailnet-host' | 'lan-host' | 'email'
  | 'room-link' | 'gitleaks-suppression' | 'secret' | 'stale-allow';
export interface Hit { file: string; line: number; kind: HitKind; match: string }
export interface Term { term: string; re: RegExp }
export interface Allow { path: string; literal: string; reason: string; line: number }
export interface Scan { hits: Hit[]; files: string[]; binaries: string[]; gitleaks: 'ran' | 'missing' | 'skipped'; terms: number; warnings: string[] }

export const REPO = resolve(import.meta.dir, '..');
export const ALLOW_FILE = 'scripts/check-public.allow';
export const MIN_TERMS = 20;
const ALNUM = /[A-Za-z0-9]/;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Built from parts so this file does not itself contain the marker it looks for.
const GITLEAKS_ALLOW = 'gitleaks' + ':allow';

/** Parse a private-terms list: `#` comments, optional double quotes, trailing `*` for a prefix. */
export function parseTerms(source: string): Term[] {
  const terms: Term[] = [];
  for (const raw of source.split(/\r?\n/)) {
    let term = raw.trim();
    if (!term || term.startsWith('#')) continue;
    if (term.length > 1 && term.startsWith('"') && term.endsWith('"')) term = term.slice(1, -1).trim();
    const prefix = term.endsWith('*');
    if (prefix) term = term.slice(0, -1);
    if (!term) continue;
    const body = term.split(/\s+/).map(escape).join('\\s+');
    const lead = ALNUM.test(term[0]) ? '(?<![A-Za-z0-9])' : '';
    const tail = !prefix && ALNUM.test(term.at(-1)!) ? '(?![A-Za-z0-9])' : '';
    terms.push({ term, re: new RegExp(lead + body + tail, 'gi') });
  }
  return terms;
}

/** Lines that look like a term followed by an inline comment: the comment would become part of the term. */
export function termWarnings(source: string): string[] {
  const warnings: string[] = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || (line.startsWith('"') && line.endsWith('"'))) return;
    if (/\s#/.test(line)) warnings.push(`private-terms line ${index + 1}: "#" after a term is part of the term, not a comment; put comments on their own line`);
  });
  return warnings;
}

/** Parse the allow list: `<path> <literal>  # <reason>`; a missing reason is an error. */
export function parseAllow(source: string): Allow[] {
  const entries: Allow[] = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const match = /^(\S+)\s+(\S+)\s+#\s*(\S.*)$/.exec(line);
    if (!match) throw new Error(`${ALLOW_FILE}:${index + 1}: expected "<path> <literal>  # <reason>"`);
    entries.push({ path: match[1], literal: match[2], reason: match[3].trim(), line: index + 1 });
  });
  return entries;
}

/**
 * Stand-in user names that document a path shape rather than name a machine. Anything starting
 * with $, %, <, {, :, . or ~ is a variable or template and is allowed too.
 */
export const PLACEHOLDER_USERS = new Set(['me', 'you', 'user', 'username', 'runner', 'jane', 'john', 'alice', 'bob',
  'example', 'someone', 'name', 'your-name', 'yourname', 'public', 'default', 'shared']);

const USER_PATH = /[\\/]{1,4}(Users|home)[\\/]{1,4}([^\\/\s"'`<>()[\]{},;|*?]*)/gi;
const IPV4 = /(?<![0-9.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![0-9]|\.\d)/g;
const ULA_IPV6 = /(?<![0-9A-Za-z:])fd[0-9a-f]{2}(?::[0-9a-f]{0,4}){2,7}(?![0-9A-Za-z:])/gi;
const TAILNET = /(?<![A-Za-z0-9-])(?:[a-z0-9-]+\.)+ts\.net(?![A-Za-z0-9-])/gi;
const LAN_HOST = /(?<![A-Za-z0-9_$.-])(?:[a-z0-9-]+\.)+(?:local|lan|internal|home\.arpa)(?![A-Za-z0-9_-])/gi;
const EMAIL = /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+)@((?:[A-Za-z0-9-]+\.)+([A-Za-z]{2,}))(?![A-Za-z0-9-])/g;
const ROOM_LINK = /\/r\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
// "name@2x.png" is an image, not an address.
const FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'icns', 'js', 'mjs', 'cjs', 'ts', 'tsx',
  'json', 'md', 'css', 'html', 'txt', 'zip', 'tgz', 'gz', 'wasm', 'woff', 'woff2', 'lock', 'sh', 'ps1', 'exe', 'dll']);
const TEST_FILE = /(\.test\.[cm]?[jt]sx?$|(^|\/)tests?\/|(^|\/)fixtures\/)/;

function placeholderUser(name: string): boolean {
  return name === '' || /^[$%<{:.~]/.test(name) || PLACEHOLDER_USERS.has(name.toLowerCase());
}

/** Documentation, test and no-reply addresses; everything else must be allowed with a reason. */
function placeholderEmail(local: string, domain: string): boolean {
  const host = domain.toLowerCase();
  return host === 'users.noreply.github.com' || /^no-?reply$/i.test(local) || (local === 'git' && host === 'github.com')
    || /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/.test(host);
}

/** A match inside an http(s) URL is a web path (e.g. /users/<login> on an API), not a file system path. */
function insideWebUrl(line: string, index: number): boolean {
  const start = Math.max(line.lastIndexOf(' ', index), line.lastIndexOf('"', index), line.lastIndexOf("'", index),
    line.lastIndexOf('`', index), line.lastIndexOf('(', index));
  return /^https?:\/\//i.test(line.slice(start + 1, index).replace(/^[<[]/, ''));
}

export function privateIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (octets.some(o => o > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Built-in pattern hits in one line of text. `file` decides whether room links are fixtures. */
export function patternHits(line: string, file = ''): { kind: HitKind; match: string }[] {
  const hits: { kind: HitKind; match: string }[] = [];
  for (const m of line.matchAll(USER_PATH)) {
    if (placeholderUser(m[2]) || insideWebUrl(line, m.index!)) continue;
    hits.push({ kind: 'user-path', match: m[0] });
  }
  for (const m of line.matchAll(IPV4)) {
    if (privateIpv4([m[1], m[2], m[3], m[4]].map(Number))) hits.push({ kind: 'private-ip', match: m[0] });
  }
  for (const m of line.matchAll(ULA_IPV6)) hits.push({ kind: 'private-ipv6', match: m[0] });
  for (const m of line.matchAll(TAILNET)) hits.push({ kind: 'tailnet-host', match: m[0] });
  for (const m of line.matchAll(LAN_HOST)) hits.push({ kind: 'lan-host', match: m[0] });
  for (const m of line.matchAll(EMAIL)) {
    if (FILE_EXTENSIONS.has(m[3].toLowerCase()) || placeholderEmail(m[1], m[2])) continue;
    hits.push({ kind: 'email', match: m[0] });
  }
  if (!TEST_FILE.test(file)) {
    for (const m of line.matchAll(ROOM_LINK)) if (!/^0{8}-0{4}-/.test(m[1])) hits.push({ kind: 'room-link', match: m[0] });
  }
  if (line.includes(GITLEAKS_ALLOW)) hits.push({ kind: 'gitleaks-suppression', match: GITLEAKS_ALLOW });
  return hits;
}

export function termHits(line: string, terms: Term[]): string[] {
  const found: string[] = [];
  for (const { re } of terms) for (const m of line.matchAll(re)) found.push(m[0]);
  return found;
}

export function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

/**
 * Decode a file for scanning: UTF-16 with a byte-order mark, or without one when every other byte
 * of the start is zero, becomes text; anything else with a zero byte is binary.
 */
export function decode(bytes: Buffer): { text: string; binary: boolean } {
  const utf16 = (body: Buffer, bigEndian: boolean) => {
    const copy = Buffer.from(body.subarray(0, body.length & ~1));
    if (bigEndian) copy.swap16();
    return { text: copy.toString('utf16le'), binary: false };
  };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return utf16(bytes.subarray(2), false);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return utf16(bytes.subarray(2), true);
  const sample = Math.min(bytes.length, 512) & ~1;
  if (sample >= 4) {
    let evenZero = 0, oddZero = 0;
    for (let i = 0; i < sample; i += 2) { if (bytes[i] === 0) evenZero++; if (bytes[i + 1] === 0) oddZero++; }
    const pairs = sample / 2;
    if (oddZero >= pairs * 0.9 && evenZero <= pairs * 0.1) return utf16(bytes, false);
    if (evenZero >= pairs * 0.9 && oddZero <= pairs * 0.1) return utf16(bytes, true);
  }
  if (isBinary(bytes)) return { text: new TextDecoder('latin1').decode(bytes), binary: true };
  return { text: bytes.toString('utf8'), binary: false };
}

/** Printable ASCII runs of at least six characters, like strings(1). */
export function printableStrings(text: string): string[] {
  return text.match(/[\x20-\x7e]{6,}/g) ?? [];
}

/** The allow entry that covers a pattern hit on this line of this file, if any. */
function allowFor(allow: Allow[], file: string, line: string, match: string): Allow | undefined {
  return allow.find(e => e.path === file && line.includes(e.literal) && (e.literal.includes(match) || match.includes(e.literal)));
}

/**
 * Scan one file's text. `allow` entries apply to built-in patterns only, never to private terms.
 * Every allow entry that suppresses something is recorded in `used`.
 */
export function scanText(file: string, text: string, terms: Term[], allow: Allow[] = [], used = new Set<Allow>(), binary = false): Hit[] {
  const hits: Hit[] = [];
  const lines = binary ? printableStrings(text) : text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const at = binary ? 0 : index + 1;
    for (const match of termHits(line, terms)) hits.push({ file, line: at, kind: 'private-term', match });
    if (file === ALLOW_FILE) return; // the allow list quotes the literals it allows
    for (const hit of patternHits(line, file)) {
      const entry = allowFor(allow, file, line, hit.match);
      if (entry) { used.add(entry); continue; }
      hits.push({ file, line: at, ...hit });
    }
  });
  return hits;
}

/** Hits for the file itself: its path, and a gitleaks config or ignore file by its presence. */
export function pathHits(file: string, terms: Term[], allow: Allow[] = [], used = new Set<Allow>()): Hit[] {
  const hits: Hit[] = termHits(file, terms).map(match => ({ file, line: 0, kind: 'private-term' as const, match }));
  if (['.gitleaks.toml', '.gitleaksignore'].includes(basename(file))) {
    const entry = allowFor(allow, file, file, basename(file));
    if (entry) used.add(entry);
    else hits.push({ file, line: 0, kind: 'gitleaks-suppression', match: basename(file) });
  }
  return hits;
}

/** Paths listed in internal/export-exclude.txt: `dir/` drops a directory, anything else one file. */
export function readExcludes(root: string): string[] {
  const file = join(root, 'internal/export-exclude.txt');
  if (!existsSync(file)) return [];
  const paths = readFileSync(file, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (!paths.includes('internal/')) throw new Error('internal/export-exclude.txt must list internal/');
  return paths;
}

export function excluded(file: string, excludes: string[]): boolean {
  return excludes.some(path => path.endsWith('/') ? file.startsWith(path) : file === path);
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== '.git') out.push(...walk(full, base)); }
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(relative(base, full).split('\\').join('/'));
  }
  return out;
}

export function trackedFiles(root: string): string[] {
  const listed = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  return listed.stdout.split('\0').filter(Boolean).filter(file => existsSync(join(root, file)) || isLink(join(root, file)));
}

const isLink = (path: string) => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;

function gitleaksBinary(): string | undefined {
  const candidate = process.env.GITLEAKS || 'gitleaks';
  return spawnSync(candidate, ['version'], { encoding: 'utf8' }).status === 0 ? candidate : undefined;
}

/** Run gitleaks over a staged copy of exactly the scanned regular files (links are not followed). */
function runGitleaks(binary: string, root: string, files: string[]): Hit[] {
  const stage = mkdtempSync(join(tmpdir(), 'meshrooms-gitleaks-'));
  try {
    for (const file of files) {
      if (isLink(join(root, file))) continue;
      mkdirSync(dirname(join(stage, 'tree', file)), { recursive: true });
      copyFileSync(join(root, file), join(stage, 'tree', file));
    }
    const report = join(stage, 'report.json');
    const args = ['dir', join(stage, 'tree'), '--no-banner', '--redact', '--log-level', 'error', '--exit-code', '0',
      '--report-format', 'json', '--report-path', report];
    const ignore = join(stage, 'tree', '.gitleaksignore');
    if (existsSync(ignore)) args.push('--gitleaks-ignore-path', ignore);
    const run = spawnSync(binary, args, { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`gitleaks failed (${run.status}): ${run.stderr || run.stdout}`);
    const findings = JSON.parse(readFileSync(report, 'utf8') || '[]') as { File: string; StartLine: number; RuleID: string }[];
    return findings.map(f => ({ file: relative(join(stage, 'tree'), f.File).split('\\').join('/'), line: f.StartLine, kind: 'secret' as const, match: f.RuleID }));
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

export interface Options { tree?: string; terms?: string; requireTerms?: boolean; allow?: string; gitleaks?: 'auto' | 'require' | 'skip' }

export function scan(options: Options = {}): Scan {
  const root = resolve(options.tree ?? REPO);
  const excludes = options.tree ? [] : readExcludes(root);
  const files = options.tree ? walk(root) : trackedFiles(root).filter(file => !excluded(file, excludes));
  const termsFile = options.terms ?? join(REPO, 'internal/private-terms.txt');
  if ((options.terms || options.requireTerms) && !existsSync(termsFile)) throw new Error(`no private-terms list at ${termsFile}`);
  const termsSource = existsSync(termsFile) ? readFileSync(termsFile, 'utf8') : '';
  const terms = parseTerms(termsSource);
  if (options.requireTerms && terms.length < MIN_TERMS) {
    throw new Error(`the private-terms list holds ${terms.length} terms; --require-terms needs at least ${MIN_TERMS}`);
  }
  const allowFile = options.allow ?? join(root, ALLOW_FILE);
  const allow = existsSync(allowFile) ? parseAllow(readFileSync(allowFile, 'utf8')) : [];
  const used = new Set<Allow>();
  const hits: Hit[] = [];
  const binaries: string[] = [];
  for (const file of files.sort()) {
    hits.push(...pathHits(file, terms, allow, used));
    const full = join(root, file);
    if (isLink(full)) { hits.push(...scanText(file, readlinkSync(full), terms, allow, used)); continue; }
    const { text, binary } = decode(readFileSync(full));
    if (binary) binaries.push(file);
    hits.push(...scanText(file, text, terms, allow, used, binary));
  }
  for (const entry of allow) {
    if (!used.has(entry)) hits.push({ file: ALLOW_FILE, line: entry.line, kind: 'stale-allow', match: `${entry.path} ${entry.literal}` });
  }
  let gitleaks: Scan['gitleaks'] = 'skipped';
  if (options.gitleaks !== 'skip') {
    const binary = gitleaksBinary();
    if (binary) { hits.push(...runGitleaks(binary, root, files)); gitleaks = 'ran'; }
    else if (options.gitleaks === 'require') throw new Error('gitleaks is required but was not found (set GITLEAKS or put it on PATH)');
    else gitleaks = 'missing';
  }
  return { hits, files, binaries, gitleaks, terms: terms.length, warnings: termWarnings(termsSource) };
}

function main(argv: string[]): number {
  const options: Options = { gitleaks: 'auto' };
  let listBinaries = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => { const next = argv[++i]; if (!next) throw new Error(`${arg} needs a value`); return next; };
    if (arg === '--tree') options.tree = value();
    else if (arg === '--terms') options.terms = value();
    else if (arg === '--require-terms') options.requireTerms = true;
    else if (arg === '--allow') options.allow = value();
    else if (arg === '--no-gitleaks') options.gitleaks = 'skip';
    else if (arg === '--require-gitleaks') options.gitleaks = 'require';
    else if (arg === '--list-binaries') { listBinaries = true; options.gitleaks = 'skip'; }
    else if (arg === '-h' || arg === '--help') { console.log(readFileSync(import.meta.path, 'utf8').split('*/')[0]); return 0; }
    else throw new Error(`unknown argument ${arg}`);
  }
  if (options.tree && !statSync(options.tree, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`--tree ${options.tree} is not a directory`);
  const result = scan(options);
  const root = resolve(options.tree ?? REPO);
  if (listBinaries) {
    for (const file of result.binaries) console.log(`${String(statSync(join(root, file)).size).padStart(9)}  ${file}`);
    return 0;
  }
  for (const warning of result.warnings) console.error(`check-public: WARNING ${warning}`);
  for (const hit of result.hits) console.log(`${hit.file}:${hit.line}: ${hit.kind}: ${hit.match}`);
  const termsNote = result.terms ? `with ${result.terms} private terms` : 'WITHOUT private terms (no internal/private-terms.txt)';
  console.error(`check-public: ${result.files.length} files scanned ${termsNote}; gitleaks ${result.gitleaks}; ${result.hits.length} hit(s)`);
  if (result.gitleaks === 'missing') console.error('check-public: WARNING gitleaks not found; secrets were not scanned');
  if (result.binaries.length) {
    console.error(`check-public: ${result.binaries.length} binary file(s) were only string-scanned; a person must look at them:`);
    for (const file of result.binaries) console.error(`  ${file}`);
  }
  return result.hits.length ? 1 : 0;
}

if (import.meta.main) {
  try { process.exit(main(process.argv.slice(2))); }
  catch (error) { console.error(`check-public: ${(error as Error).message}`); process.exit(2); }
}
