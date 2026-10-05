/**
 * Build the npm package `@wormdb/meshrooms` in packages/meshrooms: the same single-file bridge the room service serves at
 * /agent/meshrooms-agent.js, with a shebang so `bunx @wormdb/meshrooms` runs it, plus the licenses of the code bundled into it.
 * Publish from that directory, with the maintainers' publish workflow; the repository root package is never published.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildAgent } from './build-agent';
import { uiManifestOf } from '../server/local-ui';

const root = resolve(import.meta.dir, '..');
export const packageDir = join(root, 'packages', 'meshrooms');
/** The built UI the daemon serves on 127.0.0.1 (server/local-ui.ts), shipped beside the bundle as ui/. */
export const uiDir = join(packageDir, 'ui');

/** Builds the UI (Vite) afresh into ui/ and returns its manifest: never a stale dist/. */
export async function buildUi(out = uiDir) {
  rmSync(out, { recursive: true, force: true });
  const { build } = await import('vite');
  await build({ root, logLevel: 'warn', build: { outDir: out, emptyOutDir: true, sourcemap: false } });
  return uiManifestOf(out);
}

/** The npm packages whose code the bundle contains, from the build's input paths. */
export function bundledPackages(inputs: string[]) {
  const roots = new Map<string, string>();
  for (const input of inputs) {
    const path = resolve(input).replaceAll('\\', '/');
    // The innermost node_modules folder that is a package: some packages keep plain source folders named node_modules.
    for (let at = path.lastIndexOf('/node_modules/'); at >= 0; at = path.lastIndexOf('/node_modules/', at - 1)) {
      const rest = path.slice(at + '/node_modules/'.length).split('/'), name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
      const dir = `${path.slice(0, at)}/node_modules/${name}`;
      if (existsSync(join(dir, 'package.json'))) { roots.set(name, dir); break; }
    }
  }
  return [...roots].sort(([a], [b]) => a.localeCompare(b)).map(([name, dir]) => ({ name, dir }));
}

function licenseText(dir: string) {
  const file = readdirSync(dir).find(f => /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i.test(f)) ?? readdirSync(dir).find(f => /^licen[cs]e/i.test(f));
  return file ? readFileSync(join(dir, file), 'utf8').trim() : undefined;
}

export async function buildBridgePackage(out = join(root, 'dist', 'agent')) {
  const ui = await buildUi();
  const built = await buildAgent(out, { ui });
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const bin = join(packageDir, 'bin', 'meshrooms.js');
  mkdirSync(join(packageDir, 'bin'), { recursive: true });
  writeFileSync(bin, `#!/usr/bin/env bun\n${readFileSync(built.file, 'utf8')}`);
  if (process.platform !== 'win32') chmodSync(bin, 0o755);

  const notices = [`Third-party software bundled into bin/meshrooms.js (meshrooms ${manifest.version}).`,
    'Meshrooms itself is MIT licensed (see LICENSE). Each component below keeps its own license.', ''];
  const packages = bundledPackages(built.inputs);
  for (const { name, dir } of packages) {
    const meta = existsSync(join(dir, 'package.json')) ? JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) : {};
    const license = typeof meta.license === 'string' ? meta.license : meta.license?.type ?? 'license text below';
    notices.push('-'.repeat(78), `${name}@${meta.version ?? 'unknown'} (${license})`, meta.homepage || meta.repository?.url || meta.repository || '', '',
      licenseText(dir) ?? `No license file ships with this package; its package.json declares ${license}.`, '');
  }
  writeFileSync(join(packageDir, 'THIRD_PARTY_LICENSES.txt'), notices.join('\n'));
  writeFileSync(join(packageDir, 'LICENSE'), readFileSync(join(root, 'LICENSE')));
  return { version: manifest.version as string, bin, bytes: readFileSync(bin).length,
    sha256: createHash('sha256').update(readFileSync(bin)).digest('hex'), bundled: packages.map(p => p.name), uiFiles: Object.keys(ui).length };
}

if (import.meta.main) {
  try { const { bundled, ...result } = await buildBridgePackage(process.argv[2] ? resolve(process.argv[2]) : undefined); console.log(JSON.stringify({ ...result, bundledPackages: bundled.length })); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}
