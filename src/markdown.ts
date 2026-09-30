/**
 * A small markdown subset for room messages. It yields a plain tree that the UI turns into React
 * elements, so peer text never becomes HTML: tags stay literal text, images are never produced, and
 * links survive only with http, https or mailto targets. Scanning is linear apart from bounded
 * lookups, and nesting is capped, so a hostile 4000-character message stays cheap.
 */
export type Inline =
  | { type: 'text'; text: string }
  | { type: 'strong' | 'em'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'br' };

export type Block =
  | { type: 'paragraph' | 'heading'; children: Inline[] }
  | { type: 'code'; lang?: string; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { type: 'quote'; children: Block[] }
  | { type: 'rule' }
  | { type: 'table'; align: TableAlign[]; header: Inline[][]; rows: Inline[][][] };

export type TableAlign = 'left' | 'center' | 'right' | undefined;

const MAX_DEPTH = 4;
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** The normalized href when the target is absolute and uses an allowed scheme, otherwise undefined. */
export function safeHref(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return SAFE_SCHEMES.has(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

export type RepoRef = { kind: 'pull' | 'issue' | 'commit'; label: string };

/**
 * A short name for a GitHub or GitLab pull request, merge request, issue, or commit link. Only the real hosts qualify:
 * the short label hides the domain, so a look-alike path on another site must keep its full URL.
 */
export function repoRef(href: string): RepoRef | undefined {
  let url: URL;
  try { url = new URL(href); } catch { return undefined; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const host = url.hostname.toLowerCase().replace(/^www\./, ''), parts = url.pathname.split('/').filter(Boolean);
  const number = (value = '') => /^\d{1,9}$/.test(value), sha = (value = '') => /^[0-9a-f]{7,40}$/i.test(value);
  if (host === 'github.com') {
    const [owner = '', repo = '', kind, ref] = parts;
    if (!/^[A-Za-z0-9-]{1,39}$/.test(owner) || !/^[\w.-]{1,100}$/.test(repo)) return undefined;
    if ((kind === 'pull' || kind === 'issues') && number(ref)) return { kind: kind === 'pull' ? 'pull' : 'issue', label: `${owner}/${repo}#${ref}` };
    if (kind === 'commit' && sha(ref)) return { kind: 'commit', label: `${repo}@${ref!.slice(0, 7).toLowerCase()}` };
  }
  if (host === 'gitlab.com') {
    const dash = parts.indexOf('-'), project = parts.slice(0, dash), [kind, ref] = parts.slice(dash + 1);
    if (dash < 2 || !project.every(part => /^[\w.-]{1,255}$/.test(part))) return undefined;
    if (kind === 'merge_requests' && number(ref)) return { kind: 'pull', label: `${project.join('/')}!${ref}` };
    if (kind === 'issues' && number(ref)) return { kind: 'issue', label: `${project.join('/')}#${ref}` };
    if (kind === 'commit' && sha(ref)) return { kind: 'commit', label: `${project.at(-1)}@${ref!.slice(0, 7).toLowerCase()}` };
  }
  return undefined;
}

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/^\t+/, tabs => '    '.repeat(tabs.length)));
  return parseBlocks(lines, 0);
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const blank = (line: string) => !line.trim();
const fenceOpen = (line: string) => /^ {0,3}(`{3,}|~{3,})([^`~]*)$/.exec(line);
const heading = (line: string) => /^ {0,3}#{1,6}(?:[ \t]|$)/.exec(line);
const listItem = (line: string) => /^( {0,3})([-*+]|(\d{1,9})[.)])(?:[ \t]|$)/.exec(line);
const quoteLine = (line: string) => /^ {0,3}>/.test(line);

function isRule(line: string) {
  const compact = line.replace(/[ \t]/g, '');
  return compact.length >= 3 && indentOf(line) < 4 && /^(?:-+|\*+|_+)$/.test(compact);
}

const startsBlock = (line: string) => !!fenceOpen(line) || !!heading(line) || quoteLine(line) || isRule(line) || !!listItem(line);

/** Columns a table may have; wider rows are cut, like GFM does with extra cells. */
const MAX_COLUMNS = 32;
/**
 * A GFM table row's cells: an optional leading and trailing pipe, `\|` for a literal pipe (also inside code), and
 * cells trimmed. Undefined for a line without an unescaped pipe, which can't be a row.
 */
function tableCells(line: string): string[] | undefined {
  let row = line.trim();
  if (indentOf(line) >= 4 || !row) return undefined;
  const cells: string[] = []; let cell = ''; let pipes = 0;
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '\\' && row[i + 1] === '|') { cell += '|'; i++; continue; }
    if (row[i] === '|') { pipes++; cells.push(cell); cell = ''; continue; }
    cell += row[i];
  }
  cells.push(cell);
  if (!pipes) return undefined;
  // `| a | b |`: the pipes at either end open and close the row rather than separating empty cells.
  if (row[0] === '|') cells.shift();
  if (row.endsWith('|') && !row.endsWith('\\|') && cells.length > 1) cells.pop();
  const trimmed = cells.map(c => c.trim());
  // A line of nothing but pipes and spaces isn't a row: otherwise a message of `|` lines becomes thousands of cells.
  return trimmed.some(Boolean) ? trimmed : undefined;
}
/** A table's body rows and cells are bounded: past either cap, the rest of the lines stay plain paragraphs. */
const MAX_TABLE_ROWS = 100, MAX_TABLE_CELLS = 1_000;
/** The alignments of a delimiter row (`| :--- | :---: | ---: |`), or undefined when the line isn't one. */
function tableDelimiter(line: string): TableAlign[] | undefined {
  const cells = tableCells(line);
  if (!cells?.length || !cells.every(c => /^:?-+:?$/.test(c))) return undefined;
  return cells.map(c => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : undefined);
}
/** A table starts at lines[i] when a header row is followed by a delimiter row with the same number of columns. */
function tableAt(lines: string[], i: number) {
  const header = tableCells(lines[i]), align = i + 1 < lines.length ? tableDelimiter(lines[i + 1]) : undefined;
  return header && align && header.length === align.length && header.length <= MAX_COLUMNS ? { header, align } : undefined;
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }
    const fence = fenceOpen(line);
    if (fence) {
      const marker = fence[1]; const body: string[] = []; const pad = indentOf(line);
      for (i++; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed[0] === marker[0] && trimmed.length >= marker.length && [...trimmed].every(c => c === marker[0])) { i++; break; }
        body.push(lines[i].slice(Math.min(pad, indentOf(lines[i]))));
      }
      const lang = fence[2].trim().split(/\s/)[0].slice(0, 32);
      blocks.push({ type: 'code', ...(lang ? { lang } : {}), text: body.join('\n') });
      continue;
    }
    if (heading(line)) {
      let content = line.trim().replace(/^#+/, '').trim();
      let end = content.length; while (end && content[end - 1] === '#') end--;
      if (!end || /[ \t]/.test(content[end - 1])) content = content.slice(0, end).trim();
      blocks.push({ type: 'heading', children: parseInline(content) });
      i++; continue;
    }
    if (depth < MAX_DEPTH && quoteLine(line)) {
      const inner: string[] = [];
      for (; i < lines.length && quoteLine(lines[i]); i++) inner.push(lines[i].replace(/^ {0,3}> ?/, ''));
      blocks.push({ type: 'quote', children: parseBlocks(inner, depth + 1) });
      continue;
    }
    if (isRule(line)) { blocks.push({ type: 'rule' }); i++; continue; }
    const item = depth < MAX_DEPTH ? listItem(line) : null;
    if (item) { i = parseList(lines, i, depth, blocks); continue; }
    const table = tableAt(lines, i);
    if (table) {
      // Body rows run to a blank line, another block, a line without a pipe, or the caps. Like GFM, a long row is cut to
      // the header's columns; a short row keeps only its cells (the renderer draws the missing ones empty).
      const width = table.header.length, rows: Inline[][][] = [];
      const maxRows = Math.min(MAX_TABLE_ROWS, Math.floor(MAX_TABLE_CELLS / width) - 1);
      let cells: string[] | undefined;
      for (i += 2; i < lines.length && rows.length < maxRows && !blank(lines[i]) && !startsBlock(lines[i]) && (cells = tableCells(lines[i])); i++)
        rows.push(cells!.slice(0, width).map(cell => parseInline(cell)));
      blocks.push({ type: 'table', align: table.align, header: table.header.map(cell => parseInline(cell)), rows });
      continue;
    }
    const paragraph = [line.trim()];
    for (i++; i < lines.length && !blank(lines[i]) && (depth >= MAX_DEPTH || !startsBlock(lines[i])) && !tableAt(lines, i); i++) paragraph.push(lines[i].trim());
    blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) });
  }
  return blocks;
}

/** Parses the list starting at lines[start] into blocks and returns the index after it. */
function parseList(lines: string[], start: number, depth: number, blocks: Block[]): number {
  const first = listItem(lines[start])!;
  const base = first[1].length; const ordered = first[3] !== undefined;
  const bullet = ordered ? first[2].slice(-1) : first[2];
  const sameKind = (m: RegExpExecArray | null): m is RegExpExecArray => !!m && Math.abs(m[1].length - base) < 2 && (ordered ? m[3] !== undefined && m[2].slice(-1) === bullet : m[2] === bullet);
  const items: Block[][] = [];
  let i = start;
  while (i < lines.length) {
    const marker = listItem(lines[i]);
    if (!sameKind(marker)) break;
    const offset = marker[0].length;
    const content = [lines[i].slice(offset)];
    let previousBlank = false;
    for (i++; i < lines.length; i++) {
      const line = lines[i];
      if (blank(line)) {
        let next = i + 1;
        while (next < lines.length && blank(lines[next])) next++;
        if (next >= lines.length || indentOf(lines[next]) < base + 2) break;
        content.push(''); previousBlank = true; continue;
      }
      if (indentOf(line) >= base + 2) content.push(line.slice(Math.min(offset, indentOf(line))));
      else if (!previousBlank && !startsBlock(line)) content.push(line);
      else break;
      previousBlank = false;
    }
    items.push(parseBlocks(content, depth + 1));
    let next = i;
    while (next < lines.length && blank(lines[next])) next++;
    if (next < lines.length && sameKind(listItem(lines[next]))) i = next; else break;
  }
  blocks.push({ type: 'list', ordered, start: ordered ? Number(first[3]) : 1, items });
  return i;
}

const whitespace = (c: string) => /\s/.test(c);
const punctuation = (c: string) => /[\p{P}\p{S}]/u.test(c);
const ESCAPABLE = '\\`*_{}[]()#+-.!>~|<"\'';

type Frame = { char: string; count: number; children: Inline[] };

function push(children: Inline[], node: Inline) {
  const last = children[children.length - 1];
  if (node.type === 'text' && last?.type === 'text') last.text += node.text;
  else if (node.type !== 'text' || node.text) children.push(node);
}

/** Emphasis frames on a stack; an unmatched opener falls back to literal text when it is popped. */
function parseInline(text: string, inLink = false): Inline[] {
  const root: Frame = { char: '', count: 0, children: [] };
  const stack = [root];
  const open: Record<string, number> = { '*': 0, _: 0 };
  const closers = matchPairs(text, '[', ']');
  let target: ReturnType<typeof linkTargets> | undefined;
  const noCloser = new Set<number>();
  const emit = (node: Inline) => push(stack[stack.length - 1].children, node);
  const collapse = () => {
    const frame = stack.pop()!; open[frame.char]--;
    const parent = stack[stack.length - 1].children;
    push(parent, { type: 'text', text: frame.char.repeat(frame.count) });
    for (const child of frame.children) push(parent, child);
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length && ESCAPABLE.includes(text[i + 1])) { emit({ type: 'text', text: text[i + 1] }); i += 2; continue; }
    if (c === '\n') { emit({ type: 'br' }); i++; continue; }
    if (c === '`') {
      let run = 1; while (text[i + run] === '`') run++;
      const close = noCloser.has(run) ? -1 : findRun(text, '`', run, i + run);
      if (close < 0) { noCloser.add(run); emit({ type: 'text', text: '`'.repeat(run) }); i += run; continue; }
      let code = text.slice(i + run, close).replace(/\n/g, ' ');
      if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim()) code = code.slice(1, -1);
      emit({ type: 'code', text: code }); i = close + run; continue;
    }
    const labelEnd = c === '[' && !inLink ? closers.get(i) : undefined;
    if (labelEnd !== undefined && text[labelEnd + 1] === '(') {
      const link = (target ??= linkTargets(text))(labelEnd + 1);
      if (link) {
        const href = safeHref(link.url);
        if (href) emit({ type: 'link', href, children: parseInline(text.slice(i + 1, labelEnd), true) });
        else emit({ type: 'text', text: text.slice(i, link.end) });
        i = link.end; continue;
      }
    }
    if (!inLink && (c === 'h' || c === 'H') && !/[\p{L}\p{N}]/u.test(text[i - 1] ?? '')) {
      const url = bareUrl(text, i);
      if (url) { const href = safeHref(url); if (href) { emit({ type: 'link', href, children: [{ type: 'text', text: url }] }); i += url.length; continue; } }
    }
    if (c === '*' || c === '_') {
      let run = 1; while (text[i + run] === c) run++;
      const before = text[i - 1] ?? ' '; const after = text[i + run] ?? ' ';
      const left = !whitespace(after) && (!punctuation(after) || whitespace(before) || punctuation(before));
      const right = !whitespace(before) && (!punctuation(before) || whitespace(after) || punctuation(after));
      const canOpen = c === '*' ? left : left && (!right || punctuation(before));
      const canClose = c === '*' ? right : right && (!left || punctuation(after));
      let remaining = run;
      while (canClose && remaining && open[c] > 0) {
        while (stack[stack.length - 1].char !== c) collapse();
        const frame = stack[stack.length - 1];
        const used = Math.min(remaining, frame.count, 2);
        const node: Inline = { type: used === 2 ? 'strong' : 'em', children: frame.children };
        frame.count -= used; remaining -= used;
        if (frame.count) frame.children = [node];
        else { stack.pop(); open[c]--; push(stack[stack.length - 1].children, node); }
      }
      if (remaining && canOpen) { stack.push({ char: c, count: remaining, children: [] }); open[c]++; }
      else if (remaining) emit({ type: 'text', text: c.repeat(remaining) });
      i += run; continue;
    }
    let end = i + 1;
    while (end < text.length && !'\\\n`[*_hH'.includes(text[end])) end++;
    emit({ type: 'text', text: text.slice(i, end) }); i = end;
  }
  while (stack.length > 1) collapse();
  return root.children;
}

function findRun(text: string, char: string, length: number, from: number): number {
  for (let at = text.indexOf(char, from); at >= 0; at = text.indexOf(char, at)) {
    let run = 1; while (text[at + run] === char) run++;
    if (run === length) return at;
    at += run;
  }
  return -1;
}

/** Pairs every unescaped opener with its balanced closer in one pass. */
function matchPairs(text: string, open: string, close: string): Map<number, number> {
  const pairs = new Map<number, number>(); const opens: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === open) opens.push(i);
    else if (text[i] === close && opens.length) pairs.set(opens.pop()!, i);
  }
  return pairs;
}

/** Link targets are precomputed so a message full of `](` stays linear: balanced parens, no whitespace. */
function linkTargets(text: string) {
  const parens = matchPairs(text, '(', ')');
  const nextSpace = new Int32Array(text.length + 1).fill(text.length);
  for (let i = text.length - 1; i >= 0; i--) nextSpace[i] = whitespace(text[i]) ? i : nextSpace[i + 1];
  return (open: number): { url: string; end: number } | undefined => {
    const close = parens.get(open);
    return close !== undefined && close > open + 1 && nextSpace[open] > close ? { url: text.slice(open + 1, close), end: close + 1 } : undefined;
  };
}

/** A bare http(s) URL, minus trailing punctuation and unbalanced closing parentheses. */
function bareUrl(text: string, from: number): string | undefined {
  const scheme = /^https?:\/\//i.exec(text.slice(from, from + 8));
  if (!scheme) return undefined;
  let end = from + scheme[0].length;
  while (end < text.length && end - from < 2048 && !whitespace(text[end]) && !'<>`'.includes(text[end])) end++;
  let unbalanced = 0;
  for (let i = from; i < end; i++) unbalanced += text[i] === ')' ? 1 : text[i] === '(' ? -1 : 0;
  for (;;) {
    const last = text[end - 1];
    if ('.,;:!?\'"*_'.includes(last)) end--;
    else if (last === ')' && unbalanced > 0) { end--; unbalanced--; }
    else break;
  }
  return end - from > scheme[0].length ? text.slice(from, end) : undefined;
}
