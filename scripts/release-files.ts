/**
 * List the source files the hosted browser coordinator needs at runtime, derived from what
 * `server/browser/main.ts` and the operator commands actually import, so the deploy package cannot
 * drift from the code.
 *
 * Usage: bun run scripts/release-files.ts [repo root]
 * Prints one repository-relative path per line, sorted. Exits non-zero if the runtime imports a
 * package (the release ships without node_modules) or references a file that does not exist.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { builtinModules } from 'node:module';

export const RUNTIME_ENTRY = 'server/browser/main.ts';
/** The service plus the commands operators run on the host (invite codes, listing and retiring rooms). */
export const RELEASE_ENTRIES = [RUNTIME_ENTRY, 'server/browser/invites.ts', 'server/browser/rooms.ts'];
const builtins = new Set(builtinModules);
const isBuiltin = (specifier: string) => specifier.startsWith('bun:') || specifier.startsWith('node:') || builtins.has(specifier);
// Files the runtime opens by URL relative to the module, e.g. `new URL('./agent-join.md', import.meta.url)`.
const assetPattern = /new URL\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g;
const extensions = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts'];

export function releaseFiles(root: string, entries: string | string[] = RELEASE_ENTRIES): string[] {
  const transpiler = new Bun.Transpiler({ loader: 'tsx' });
  const seen = new Set<string>();
  const problems: string[] = [];
  const toRelative = (file: string) => relative(root, file).split(sep).join('/');
  const pending = (Array.isArray(entries) ? entries : [entries]).map(entry => resolve(root, entry));
  for (const entry of pending) if (!existsSync(entry)) problems.push(`entry ${toRelative(entry)} does not exist`);
  while (pending.length) {
    const file = pending.pop()!;
    if (!existsSync(file)) continue;
    const name = toRelative(file);
    if (seen.has(name)) continue;
    if (name.startsWith('..')) { problems.push(`${name} is outside the repository`); continue; }
    seen.add(name);
    if (!/\.(ts|tsx|js|mjs)$/.test(file)) continue;
    const code = readFileSync(file, 'utf8');
    // scanImports drops type-only imports, which the runtime never loads.
    for (const { path: specifier } of transpiler.scanImports(code)) {
      if (isBuiltin(specifier)) continue;
      if (!specifier.startsWith('.')) { problems.push(`${name} imports package "${specifier}"; the release has no node_modules`); continue; }
      const base = resolve(dirname(file), specifier);
      const found = extensions.map(ext => base + ext).find(candidate => existsSync(candidate) && !candidate.endsWith(sep));
      if (!found) problems.push(`${name} imports missing "${specifier}"`);
      else pending.push(found);
    }
    for (const match of code.matchAll(assetPattern)) {
      const asset = resolve(dirname(file), match[2]);
      if (!existsSync(asset)) problems.push(`${name} opens missing "${match[2]}"`);
      else pending.push(asset);
    }
  }
  if (problems.length) throw new Error(`Cannot derive the release file list:\n${problems.join('\n')}`);
  return [...seen].sort();
}

if (import.meta.main) {
  try {
    console.log(releaseFiles(resolve(process.argv[2] || '.')).join('\n'));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
