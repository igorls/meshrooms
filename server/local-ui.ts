/**
 * The built UI the daemon's local API serves (local-api.ts), and how a release gets it there with its integrity intact.
 *
 * `bun run build:bridge` builds the UI into packages/meshrooms/ui and compiles a manifest of it (each file's SHA-256)
 * into the bridge bundle itself (`__MESHROOMS_UI__`). The UI ships beside the bundle (the npm package's ui/, the desktop
 * app's bridge folder), and installBridge copies it, file by file and verified, into ~/.meshrooms/bin/ui-<version>
 * beside the installed bundle the daemon runs from. The bundle's own hash is checked by the launcher before it runs, so
 * the hashes inside it are too: the daemon loads only the files its manifest lists, only with those hashes, and serves
 * them from memory. A file changed on disk afterwards is never served; a UI that doesn't verify serves no page at all.
 *
 * Run from a source checkout there is no manifest: the daemon serves the checkout's dist/ (bun run build), or
 * MESHROOMS_LOCAL_UI_DIR, as it is.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Set by the bridge build (scripts/build-bridge-package.ts): the UI's manifest as JSON. Absent from source runs. */
declare const __MESHROOMS_UI__: string | undefined;
/** The UI's files by path (`index.html`, `assets/<name>`), each with its SHA-256. */
export type UiManifest = Record<string, string>;
/** The paths a UI holds: Vite's index.html and its hashed assets, by name only. */
export const UI_FILE = /^(?:index\.html|assets\/[\w.-]{1,200})$/;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const validManifest = (value: unknown): value is UiManifest => !!value && typeof value === 'object' && !Array.isArray(value)
  && 'index.html' in value && Object.entries(value).every(([path, hash]) => UI_FILE.test(path) && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash));

/** The manifest compiled into this bridge bundle, if it was built with the UI. */
export function bundledUiManifest(): UiManifest | undefined {
  if (typeof __MESHROOMS_UI__ !== 'string') return undefined;
  try { const manifest = JSON.parse(__MESHROOMS_UI__); return validManifest(manifest) ? manifest : undefined; } catch { return undefined; }
}

/** At build time: the manifest of a built UI folder. Anything but index.html and assets/<name> as plain files is refused. */
export function uiManifestOf(dir: string): UiManifest {
  const manifest: UiManifest = {};
  const walk = (folder: string, prefix: string) => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name), rel = `${prefix}${name}`, info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`The built UI holds a link: ${rel}`);
      if (info.isDirectory()) { if (rel !== 'assets') throw new Error(`Unexpected folder in the built UI: ${rel}`); walk(path, `${rel}/`); continue; }
      if (!info.isFile() || !UI_FILE.test(rel)) throw new Error(`Unexpected file in the built UI: ${rel}`);
      if (rel.endsWith('.map')) throw new Error(`The built UI holds a source map: ${rel}`);
      manifest[rel] = sha256(readFileSync(path));
    }
  };
  walk(dir, '');
  if (!validManifest(manifest)) throw new Error(`No built UI in ${dir} (index.html is missing).`);
  return manifest;
}

/**
 * Every file the manifest lists, read from `dir` and checked against its hash; undefined unless all of them are there,
 * as plain files, with those hashes. Files the manifest doesn't list are never read.
 */
export function verifiedUi(dir: string, manifest: UiManifest): Map<string, Uint8Array> | undefined {
  const files = new Map<string, Uint8Array>();
  for (const [rel, hash] of Object.entries(manifest)) {
    const path = join(dir, ...rel.split('/'));
    try {
      if (!lstatSync(path).isFile()) return undefined;
      const bytes = new Uint8Array(readFileSync(path));
      if (sha256(bytes) !== hash) return undefined;
      files.set(rel, bytes);
    } catch { return undefined; }
  }
  return files;
}

/** Where a bridge bundle's UI may be: installed beside it (ui-<version>), the desktop bundle's ui/, or the npm package's. */
export const uiFolders = (bundle: string, version: string) => [join(dirname(bundle), `ui-${version}`), join(dirname(bundle), 'ui'), join(dirname(bundle), '..', 'ui')];

/**
 * The UI this daemon serves. A bridge bundle: the first of its UI folders whose files all verify against the bundled
 * manifest, loaded into memory (`files`); none verifies, no page. A source run: MESHROOMS_LOCAL_UI_DIR, or the
 * checkout's dist/, read as is.
 */
export function localUi(version: string, options: { manifest?: UiManifest; bundle?: string; env?: Record<string, string | undefined>; here?: string } = {}):
  { dir: string; files?: Map<string, Uint8Array> } | undefined {
  const { env = process.env, here = import.meta.dir } = options;
  const bundle = options.bundle ?? (/\.[cm]?js$/.test(import.meta.path) ? import.meta.path : undefined);
  const manifest = 'manifest' in options ? options.manifest : bundledUiManifest();
  if (bundle) {
    if (!manifest) return undefined;
    for (const dir of uiFolders(bundle, version)) { const files = verifiedUi(dir, manifest); if (files) return { dir, files }; }
    return undefined;
  }
  const checkout = existsSync(join(here, '..', 'package.json')) && existsSync(join(here, '..', 'src', 'main.tsx'));
  const dir = [env.MESHROOMS_LOCAL_UI_DIR, checkout ? join(here, '..', 'dist') : undefined].find((d): d is string => !!d && existsSync(join(d, 'index.html')));
  return dir ? { dir } : undefined;
}
