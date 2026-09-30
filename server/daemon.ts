import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { acquireInstance, InstanceOwnedError } from './instance';
import { LocalNode } from './node';
import { createHandler } from './http';
import { openWormDBStore } from './persistence/wormdb';
import type { DurableStore } from './persistence/store';
import { randomUUID } from 'node:crypto';
import { NodeAccess } from './access';
import { loadControlToken, registerRuntime, runtimeProof, type RuntimeRecord } from './runtime';
import { startupManager, type StartupManager } from './startup';
import { MeshGuardTransport } from './meshguard';
import { PeerBridge } from './peer-bridge';
import { fileBlobs } from './blobs';
import { MAX_ATTACHMENT_BYTES } from './attachments';

export type DaemonOptions = { dataDir: string; libraryPath: string; port: number; distDir: string; devOrigin?: string; startup?: StartupManager;
  meshguard?: { socketPath: string; publicKey: string } };

export function defaultOptions(): DaemonOptions {
  const root = resolve(import.meta.dir, '..');
  const dataRoot = process.platform === 'win32' ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  const binary = process.platform === 'win32' ? ['bin', 'wormdb_ffi.dll'] : ['lib', `libwormdb_ffi.${process.platform === 'darwin' ? 'dylib' : 'so'}`];
  const localLibrary = join(root, '.local', 'native', binary[1]);
  return {
    // AppData writes launched by a packaged harness can be private to that app.
    // A profile-root directory stays addressable by other local harnesses.
    dataDir: resolve(process.env.MESHROOMS_DATA_DIR || (process.platform === 'win32' ? join(homedir(), '.meshrooms', 'data') : join(dataRoot, 'Meshrooms', 'data'))),
    libraryPath: resolve(process.env.WORMDB_LIBRARY_PATH || (existsSync(localLibrary) ? localLibrary : join(root, '..', 'wormdb', 'zig-out', ...binary))),
    port: Number(process.env.MESHROOMS_PORT || 4318), distDir: join(root, 'dist'),
    ...(process.env.MESHROOMS_MESHGUARD_SOCKET || process.env.MESHROOMS_MESHGUARD_KEY ? { meshguard: {
      socketPath: process.env.MESHROOMS_MESHGUARD_SOCKET || '', publicKey: process.env.MESHROOMS_MESHGUARD_KEY || '',
    } } : {}),
  };
}

export function startDaemon(options: DaemonOptions) {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('Use a valid local port.');
  if (options.devOrigin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(options.devOrigin)) throw new Error('The development origin must be an explicit loopback HTTP address.');
  if (!existsSync(options.libraryPath)) throw new Error(`WormDB library not found: ${options.libraryPath}. Build WormDB FFI or set WORMDB_LIBRARY_PATH.`);
  const release = acquireInstance(options.dataDir);
  let node: LocalNode | undefined;
  let store: DurableStore | undefined;
  let handler: ((request: Request) => Promise<Response>) | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let unregister: (() => void) | undefined;
  let access: NodeAccess | undefined;
  let runtime: RuntimeRecord | undefined;
  let bridge: PeerBridge | undefined;
  try {
    server = Bun.serve({
      hostname: '127.0.0.1', port: options.port, idleTimeout: 0, maxRequestBodySize: MAX_ATTACHMENT_BYTES + 65536,
      fetch(request) { return handler ? handler(request) : Response.json({ message: 'The local daemon is starting.' }, { status: 503 }); },
    });
    store = openWormDBStore({ dataDir: realpathSync(options.dataDir), libraryPath: realpathSync(options.libraryPath) });
    // Attachment bytes live beside the WormDB store; room access and names stay in the catalog.
    node = new LocalNode(store!, fileBlobs(join(realpathSync(options.dataDir), 'attachments')));
    if (options.meshguard) bridge = new PeerBridge(node, new MeshGuardTransport(options.meshguard.socketPath, options.meshguard.publicKey));
    const control = loadControlToken(options.dataDir);
    access = new NodeAccess(control, node);
    runtime = { version: 1, apiVersion: 2, pid: process.pid, nodeId: node.nodeId, instanceId: randomUUID(), url: `http://127.0.0.1:${server.port}/prototype/room` };
    const origins = [`http://127.0.0.1:${server.port}`, `http://localhost:${server.port}`];
    if (options.devOrigin) origins.push(options.devOrigin);
    const activeRuntime = runtime;
    handler = createHandler({ node, origins, distDir: options.distDir, dataDir: realpathSync(options.dataDir), access,
      runtime, proof: challenge => runtimeProof(control, challenge, activeRuntime), bridge, localPeerKey: options.meshguard?.publicKey,
      startup: options.startup || startupManager({ ...options, port: server.port!, cliPath: join(import.meta.dir, 'cli.ts') }) });
    unregister = registerRuntime(options.dataDir, runtime);
    bridge?.start();
  } catch (error) {
    bridge?.close(); server?.stop(true);
    try { node ? node.close() : store?.close(); } finally { unregister?.(); release(); }
    throw error;
  }
  const activeNode = node;
  const activeServer = server;
  let closed = false;
  return {
    node: activeNode, server: activeServer, access: access!, runtime: runtime!, bridge,
    close() {
      if (closed) return;
      closed = true; bridge?.close(); activeServer.stop(true);
      try { activeNode.close(); } finally { unregister?.(); release(); }
    },
  };
}

if (import.meta.main) {
  const options = defaultOptions();
  const args = process.argv.slice(2);
  let supervised = false;
  try {
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (flag === '--supervised') { supervised = true; continue; }
      const value = args[++i];
      if (flag === '--help') { console.log('meshrooms: --data-dir PATH --library PATH --port 4318 [--dev-origin http://127.0.0.1:4317] [--supervised]'); process.exit(0); }
      if (!value) throw new Error(`Missing value for ${flag}.`);
      if (flag === '--data-dir') options.dataDir = resolve(value);
      else if (flag === '--library') options.libraryPath = resolve(value);
      else if (flag === '--port') options.port = Number(value);
      else if (flag === '--dev-origin') options.devOrigin = value;
      else throw new Error(`Unknown option: ${flag}`);
    }
    const daemon = startDaemon(options);
    console.log(JSON.stringify({ event: 'meshrooms.ready', nodeId: daemon.node.snapshot().nodeId, pid: process.pid,
      url: `http://127.0.0.1:${daemon.server.port}/prototype/room`, dataDir: options.dataDir, storage: 'wormdb' }));
    const stop = () => { daemon.close(); process.exit(0); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    // A service manager restarts failed exits. A node already served by another process needs no retry loop.
    process.exitCode = supervised && error instanceof InstanceOwnedError ? 0 : 1;
  }
}
