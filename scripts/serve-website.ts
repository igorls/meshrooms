import { serve, file } from 'bun';
import { join, resolve, sep } from 'path';

const PORT = 4322;
const ROOT = resolve(import.meta.dir, '..', 'website');

serve({
  port: PORT,
  // Loopback only: this preview server is for the local machine, not the network.
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); } catch { return new Response('Bad Request', { status: 400 }); }
    if (pathname === '/' || pathname === '') {
      pathname = '/index.html';
    }

    // Resolve under ROOT and refuse anything that escapes it (e.g. an encoded "../").
    const filePath = resolve(ROOT, '.' + pathname);
    if (!filePath.startsWith(ROOT + sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    const targetFile = file(filePath);
    const exists = await targetFile.exists();

    if (!exists) {
      const notFoundFile = file(join(ROOT, '404.html'));
      if (await notFoundFile.exists()) {
        return new Response(notFoundFile, { status: 404 });
      }
      return new Response('Not Found', { status: 404 });
    }

    return new Response(targetFile);
  }
});

console.log(`Meshrooms landing page running at http://127.0.0.1:${PORT}/`);
