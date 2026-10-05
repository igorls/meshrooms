/**
 * Bundle the standalone agent bridge into one Bun script the browser runtime can serve and the npm package ships.
 * `ui`: the manifest of the built UI shipped beside it (see server/local-ui.ts), compiled in so the daemon serves only
 * those files with those hashes. Without it (the room service's copy) the bundle serves no local page.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export async function buildAgent(out: string, options: { ui?: Record<string, string> } = {}) {
  mkdirSync(out, { recursive: true });
  const result = await Bun.build({ entrypoints: [resolve(import.meta.dir, '../server/agent-cli.ts')], target: 'bun', minify: true, outdir: out, naming: 'meshrooms-agent.js', metafile: true,
    ...(options.ui ? { define: { __MESHROOMS_UI__: JSON.stringify(JSON.stringify(options.ui)) } } : {}) });
  if (!result.success) { for (const log of result.logs) console.error(log); throw new Error('The agent bridge did not build.'); }
  const file = join(out, 'meshrooms-agent.js');
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  writeFileSync(join(out, 'meshrooms-agent.js.sha256'), `${sha256}  meshrooms-agent.js\n`);
  return { file, bytes: readFileSync(file).length, sha256, inputs: Object.keys(result.metafile?.inputs ?? {}) };
}

if (import.meta.main) {
  try { const { inputs, ...built } = await buildAgent(resolve(process.argv[2] || 'dist-agent')); console.log(JSON.stringify(built)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}
