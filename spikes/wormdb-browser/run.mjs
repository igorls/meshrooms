// Automated gate run: serves this folder on localhost (a secure context, so OPFS works), runs the gates in each
// available browser, and kills a page mid-write for the crash test. Usage: node run.mjs [js|wasm] [playwright path]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const engine = process.argv[2] || 'js';
const require = createRequire(import.meta.url);
const { chromium, firefox, webkit } = require(process.argv[3] || 'playwright');
const dir = fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  try {
    // The URL parser resolves dot segments, so the path stays inside this folder.
    const path = new URL(req.url, 'http://x').pathname.replace(/^\/$/, '/index.html');
    const body = await readFile(join(dir, path));
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' }).end(body);
  }
  catch { res.writeHead(404).end(); }
}).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const url = `http://127.0.0.1:${server.address().port}/`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = {};
for (const [name, type, options] of [['chrome', chromium, { channel: 'chrome' }], ['firefox', firefox, {}], ['webkit', webkit, {}]]) {
  let browser;
  try { browser = await type.launch({ headless: true, ...options }); } catch (e) { results[name] = { skipped: e.message.split('\n')[0] }; continue; }
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url);
    const gates = await page.evaluate(e => window.spike.run(e), engine);
    // Crash test: write and flush until killed; the page is closed without warning after enough flushed records.
    const writer = await context.newPage(); await writer.goto(url);
    await writer.evaluate(e => { window.spikeProgress = -1; window.spike.crashWrite(e); }, engine);
    let flushed = -1; for (let i = 0; i < 100 && flushed < 500; i++) { await sleep(100); flushed = await writer.evaluate(() => window.spikeProgress); }
    await writer.close({ runBeforeUnload: false });
    const crash = await page.evaluate(([e, f]) => window.spike.crashVerify(e, f), [engine, flushed]);
    const pass = Object.fromEntries(await Promise.all(Object.entries({ ...gates, crash }).map(async ([g, r]) => [g, !r?.error && await page.evaluate(([g, r]) => window.spike.pass(g, r), [g, r])])));
    results[name] = { ...gates, crash, pass };
  } catch (e) { results[name] = { error: e.message.split('\n')[0] }; }
  finally { await browser.close(); }
}
server.close();
console.log(JSON.stringify({ engine, results }, null, 2));
