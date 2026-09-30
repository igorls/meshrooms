import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { LocalNode, NodeError, type Principal } from './node';
import { NodeAccess } from './access';
import type { StartupManager } from './startup';
import type { PeerBridge } from './peer-bridge';
import { MAX_ATTACHMENT_BYTES } from './attachments';

type HttpOptions = { node: LocalNode; origins: string[]; distDir: string; dataDir: string; access: NodeAccess;
  startup: StartupManager; runtime: { apiVersion: number; instanceId: string; pid: number }; proof: (challenge: string) => string;
  bridge?: PeerBridge; localPeerKey?: string };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const MAX_VIEWS = 16, OWNER_RESERVED_VIEWS = 4, MAX_AGENT_VIEWS = 2, MAX_ROOM_VIEWS = 4;

export function createHandler({ node, origins, distDir, dataDir, access, startup, runtime, proof, bridge, localPeerKey }: HttpOptions) {
  const allowedOrigins = new Set(origins);
  const allowedHosts = new Set(origins.map(origin => new URL(origin).host));
  const views = new Map<string, Principal>();
  function events(request: Request, principal: Principal): Response {
    const view = new URL(request.url).searchParams.get('view') || '';
    if (!/^[\w-]{1,64}$/.test(view)) throw new NodeError(400, 'A valid view ID is required.');
    const key = `${principal.kind}:${principal.participantId}:${view}`;
    if (views.has(key)) throw new NodeError(429, 'This view is already connected. Close it before reconnecting.');
    if (views.size >= MAX_VIEWS) throw new NodeError(429, 'Too many active local views. Close an unused view and retry.');
    if (principal.kind === 'agent') {
      const agents = [...views.values()].filter(p => p.kind === 'agent');
      if (agents.length >= MAX_VIEWS - OWNER_RESERVED_VIEWS
        || agents.filter(p => p.participantId === principal.participantId).length >= MAX_AGENT_VIEWS
        || agents.filter(p => p.roomId === principal.roomId).length >= MAX_ROOM_VIEWS) {
        throw new NodeError(429, 'Too many active agent views. Close an unused view and retry.');
      }
    }
    let cleanup = () => {};
    let publish = () => {};
    let dirty = true;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        views.set(key, principal);
        let closed = false;
        let disconnect = () => {}, unsubscribe = () => {};
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        cleanup = () => {
          if (closed) return;
          closed = true; views.delete(key); unsubscribe(); disconnect(); clearInterval(heartbeat);
          request.signal.removeEventListener('abort', cleanup);
          try { controller.close(); } catch { /* Already cancelled by the client. */ }
        };
        const encoder = new TextEncoder();
        const push = () => {
          if (closed || !dirty || (controller.desiredSize ?? 0) <= 0) return;
          dirty = false;
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(node.snapshot(principal))}\n\n`)); }
          catch { cleanup(); }
        };
        try {
          disconnect = node.connect(principal);
          unsubscribe = node.subscribe(() => { dirty = true; push(); });
          heartbeat = setInterval(() => {
            if (closed || (controller.desiredSize ?? 0) <= 0) return;
            try { controller.enqueue(encoder.encode(': local daemon heartbeat\n\n')); } catch { cleanup(); }
          }, 15000);
          request.signal.addEventListener('abort', cleanup, { once: true });
          publish = push;
          if (request.signal.aborted) cleanup(); else push();
        } catch (error) { cleanup(); throw error; }
      },
      pull() { publish(); },
      cancel() { cleanup(); },
    }, { highWaterMark: 1 });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
  async function input(request: Request): Promise<Record<string, unknown>> {
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new NodeError(415, 'Use application/json for room commands.');
    if (!request.body) throw new NodeError(400, 'A JSON command is required.');
    const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const result = await reader.read(); if (result.done) break;
        length += result.value.byteLength;
        if (length > 32768) { await reader.cancel(); throw new NodeError(413, 'This command exceeds the local message size limit.'); }
        chunks.push(result.value);
      }
    } finally { reader.releaseLock(); }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Object required');
      return value;
    } catch { throw new NodeError(400, 'A JSON command object is required.'); }
  }
  async function bytes(request: Request): Promise<Uint8Array> {
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > MAX_ATTACHMENT_BYTES) throw new NodeError(413, `Attach files up to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
    if (!request.body) throw new NodeError(400, 'The file is empty.');
    const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const result = await reader.read(); if (result.done) break;
        length += result.value.byteLength;
        if (length > MAX_ATTACHMENT_BYTES) { await reader.cancel(); throw new NodeError(413, `Attach files up to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`); }
        chunks.push(result.value);
      }
    } finally { reader.releaseLock(); }
    return new Uint8Array(Buffer.concat(chunks));
  }
  /** Only sniffed raster images render inline; everything else downloads, sandboxed, under a generic type. */
  function download(attachment: { name: string; type: string; kind: string }, data: Uint8Array, method: string) {
    const inline = attachment.kind === 'image';
    const ascii = attachment.name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    return new Response(method === 'HEAD' ? null : new Blob([data.slice()]), { headers: {
      'Content-Type': inline ? attachment.type : 'application/octet-stream', 'Content-Length': String(data.byteLength),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
      'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin',
    } });
  }
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (!allowedHosts.has(request.headers.get('host') || url.host)) throw new NodeError(403, 'Use the local daemon address.');
      if (url.pathname.startsWith('/api/')) {
        const origin = request.headers.get('origin');
        if ((origin && !allowedOrigins.has(origin)) || request.headers.get('sec-fetch-site') === 'cross-site') throw new NodeError(403, 'This local API does not accept cross-site requests.');
        if (request.method === 'GET' && url.pathname === '/api/node/health') {
          const challenge = url.searchParams.get('challenge');
          if (challenge !== null && !/^[\w-]{16,128}$/.test(challenge)) throw new NodeError(400, 'Invalid health challenge.');
          return json({ ready: node.ready, nodeId: node.nodeId, storage: 'wormdb', ...runtime,
            ...(challenge ? { proof: proof(challenge) } : {}) }, node.ready ? 200 : 503);
        }
        if (request.method === 'POST' && url.pathname === '/api/node/session') {
          const body = await input(request); const response = json({});
          response.headers.set('Set-Cookie', access.exchangeBrowserTicket(body.ticket)); return response;
        }
        const principal = access.principal(request);
        if (url.pathname === '/api/node/transport' || url.pathname === '/api/node/rooms/descriptor' || url.pathname === '/api/node/rooms/pair') {
          node.requireOwner(principal);
          if (request.method === 'GET' && url.pathname === '/api/node/transport') return json({ enabled: !!bridge, ...bridge?.status() });
          if (!bridge || !localPeerKey) throw new NodeError(409, 'Configure an explicit MeshGuard attachment before pairing rooms.');
          if (request.method === 'GET' && url.pathname === '/api/node/rooms/descriptor') return json(node.descriptor(url.searchParams.get('roomId'), localPeerKey));
          if (request.method === 'POST' && url.pathname === '/api/node/rooms/pair') return json(node.pairRoom(await input(request), localPeerKey));
          throw new NodeError(405, 'Unsupported transport command.');
        }
        if (request.method === 'GET' && url.pathname === '/api/node/snapshot') { node.touch(principal); return json(node.snapshot(principal)); }
        const file = /^\/api\/node\/attachments\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/i.exec(url.pathname);
        if (file && (request.method === 'GET' || request.method === 'HEAD')) {
          const { attachment, bytes: data } = node.attachment(file[1], file[2], principal); return download(attachment, data, request.method);
        }
        if (request.method === 'POST' && url.pathname === '/api/node/attachments') {
          const data = await bytes(request);
          return json(node.upload({ roomId: url.searchParams.get('roomId'), requestId: url.searchParams.get('requestId'), name: url.searchParams.get('name') ?? undefined, bytes: data }, principal), 201);
        }
        if (request.method === 'GET' && url.pathname === '/api/node/events') return events(request, principal);
        if (request.method === 'GET' && url.pathname === '/api/node/setup') {
          node.requireOwner(principal);
          const settings = node.settings;
          return json({ completed: settings.completed, humanName: settings.humanName, machineName: settings.machineName, dataDir,
            startup: { preference: settings.startAtLogin ? 'login' : 'manual', ...startup.status() }, pending: node.pending(url.searchParams.get('intent') || undefined) });
        }
        if (request.method === 'POST') {
          if (!['/api/node/rooms', '/api/node/rooms/join', '/api/node/rooms/floor', '/api/node/rooms/agent-wake', '/api/node/messages', '/api/node/tasks', '/api/node/tasks/update', '/api/node/tasks/remove',
            '/api/node/setup', '/api/node/control/prepare', '/api/node/control/browser'].includes(url.pathname)) throw new NodeError(404, 'Unknown local command.');
          const body = await input(request);
          if (url.pathname === '/api/node/control/prepare') { node.requireOwner(principal); return json(node.prepareRoom(body), 201); }
          if (url.pathname === '/api/node/control/browser') { node.requireOwner(principal); return json({ ticket: access.issueBrowserTicket() }); }
          if (url.pathname === '/api/node/setup') {
            node.requireOwner(principal); const command = node.validateSetup(body);
            const priorResult = node.setupResult(command); if (priorResult) return json(priorResult);
            const previous = startup.status();
            try { startup.apply(command.startAtLogin); }
            catch (error) { throw new NodeError(503, error instanceof Error ? error.message : 'The startup preference could not be applied.'); }
            try { return json(node.completeSetup({ ...command })); }
            catch (error) { try { startup.apply(previous.installed); } catch { /* Actual startup status remains independently observable. */ } throw error; }
          }
          if (url.pathname === '/api/node/rooms') return json(node.createRoom(body, principal), 201);
          if (url.pathname === '/api/node/rooms/join') return json(node.joinRoom(body, principal));
          if (url.pathname === '/api/node/rooms/floor') return json(node.setFloor(body, principal));
          if (url.pathname === '/api/node/rooms/agent-wake') return json(node.setAgentWake(body, principal));
          if (url.pathname === '/api/node/tasks') return json(node.createTask(body, principal), 201);
          if (url.pathname === '/api/node/tasks/update') return json(node.updateTask(body, principal));
          if (url.pathname === '/api/node/tasks/remove') return json(node.removeTask(body, principal));
          return json(node.send(body, principal), 201);
        }
        throw new NodeError(404, 'Unknown local endpoint.');
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new NodeError(405, 'Use GET for the web UI.');
      let filePath: string;
      if (url.pathname === '/' || url.pathname === '/prototype/room') filePath = resolve(distDir, 'index.html');
      else if (url.pathname.startsWith('/assets/')) {
        filePath = resolve(distDir, `.${decodeURIComponent(url.pathname)}`);
        const rel = relative(resolve(distDir, 'assets'), filePath);
        if (rel.startsWith('..') || isAbsolute(rel)) throw new NodeError(404, 'Asset not found.');
      } else throw new NodeError(404, 'Page not found.');
      const file = Bun.file(filePath);
      if (!await file.exists()) throw new NodeError(503, 'Build the local web UI with bun run build, then reload.');
      const relativeReal = relative(realpathSync(distDir), realpathSync(filePath));
      if (relativeReal.startsWith('..') || isAbsolute(relativeReal)) throw new NodeError(404, 'Asset not found.');
      return new Response(request.method === 'HEAD' ? null : file, { headers: {
        'Content-Type': file.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      } });
    } catch (error) {
      if (error instanceof NodeError) return json({ message: error.message }, error.status);
      console.error('Local request failed:', error);
      return json({ message: 'The local daemon could not complete this request.' }, 500);
    }
  };
}
