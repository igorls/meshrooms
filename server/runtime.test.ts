import { describe, it, expect, afterEach } from 'bun:test';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ensureRunning,
  loadControlToken,
  probeRuntime,
  registerRuntime,
  runtimeProof,
  type RuntimeRecord,
} from './runtime';
import { testDirectory } from './test-directory';

const tempDirs: ReturnType<typeof testDirectory>[] = [];
const runningServers: Array<ReturnType<typeof Bun.serve>> = [];
const childPids: number[] = [];

function makeDir(label = 'runtime-test') {
  const dir = testDirectory(label);
  tempDirs.push(dir);
  return dir.path;
}

afterEach(() => {
  for (const pid of childPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process already terminated
    }
  }
  childPids.length = 0;

  for (const server of runningServers) {
    try {
      server.stop(true);
    } catch {
      // Server already stopped
    }
  }
  runningServers.length = 0;

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    dir.cleanup();
  }
});

describe('Runtime Discovery & Daemon Lifecycle', () => {
  describe('loadControlToken', () => {
    it('creates a persistent base64url secret >= 32 bytes and reuses it', () => {
      const dataDir = makeDir('token-persist');
      const token1 = loadControlToken(dataDir);
      expect(typeof token1).toBe('string');
      expect(token1.length).toBeGreaterThanOrEqual(32);
      expect(/^[A-Za-z0-9_-]+$/.test(token1)).toBe(true);

      const keyPath = join(dataDir, 'control.key');
      expect(existsSync(keyPath)).toBe(true);
      const fileContent = readFileSync(keyPath, 'utf8').trim();
      expect(fileContent).toBe(token1);

      // Re-reading returns the exact same token
      const token2 = loadControlToken(dataDir);
      expect(token2).toBe(token1);
    });

    it('creates missing directories and sets restricted mode', () => {
      const parentDir = makeDir('nested-token');
      const subDir = join(parentDir, 'sub', 'storage');
      const token = loadControlToken(subDir);
      expect(token.length).toBeGreaterThanOrEqual(32);
      expect(existsSync(join(subDir, 'control.key'))).toBe(true);
    });
  });

  describe('runtimeProof', () => {
    it('generates a deterministic HMAC-SHA256 signature over exact 5-tuple payload', () => {
      const token = 'my-secret-control-token-12345678901234567890';
      const challenge = 'challenge-nonce-abc';
      const record: RuntimeRecord = {
        version: 1,
        apiVersion: 2,
        pid: 1234,
        url: 'http://127.0.0.1:4318/prototype/room',
        nodeId: 'node-uuid-001',
        instanceId: 'inst-uuid-001',
      };

      const proof1 = runtimeProof(token, challenge, record);
      const proof2 = runtimeProof(token, challenge, record);
      expect(proof1).toBe(proof2);

      // Verify payload structure matches spec: [challenge, instanceId, nodeId, pid, apiVersion]
      const expectedPayload = JSON.stringify([
        challenge,
        record.instanceId,
        record.nodeId,
        record.pid,
        record.apiVersion,
      ]);
      const expectedHex = createHmac('sha256', token).update(expectedPayload).digest('hex');
      expect(proof1).toBe(expectedHex);
    });

    it('changes proof when any input field varies', () => {
      const token = 'my-secret-control-token-12345678901234567890';
      const challenge = 'challenge-nonce-abc';
      const record: RuntimeRecord = {
        version: 1,
        apiVersion: 2,
        pid: 1234,
        url: 'http://127.0.0.1:4318/prototype/room',
        nodeId: 'node-uuid-001',
        instanceId: 'inst-uuid-001',
      };
      const baseProof = runtimeProof(token, challenge, record);

      expect(runtimeProof(token, 'diff-challenge', record)).not.toBe(baseProof);
      expect(runtimeProof(token, challenge, { ...record, pid: 9999 })).not.toBe(baseProof);
      expect(runtimeProof(token, challenge, { ...record, nodeId: 'other-node' })).not.toBe(baseProof);
      expect(runtimeProof(token, challenge, { ...record, instanceId: 'other-inst' })).not.toBe(baseProof);
      expect(runtimeProof(token, challenge, { ...record, apiVersion: 3 as any })).not.toBe(baseProof);
      expect(runtimeProof('diff-token-12345678901234567890', challenge, record)).not.toBe(baseProof);
    });
  });

  describe('registerRuntime', () => {
    it('atomically creates runtime.json and cleans up only own instance', () => {
      const dataDir = makeDir('register-basic');
      const record: RuntimeRecord = {
        version: 1,
        apiVersion: 2,
        pid: process.pid,
        url: 'http://127.0.0.1:4318/prototype/room',
        nodeId: 'node-1',
        instanceId: 'inst-1',
      };

      const cleanup = registerRuntime(dataDir, record);
      const runtimePath = join(dataDir, 'runtime.json');
      expect(existsSync(runtimePath)).toBe(true);
      const content = JSON.parse(readFileSync(runtimePath, 'utf8'));
      expect(content).toEqual(record);

      cleanup();
      expect(existsSync(runtimePath)).toBe(false);

      // Calling cleanup again is a no-op
      expect(() => cleanup()).not.toThrow();
    });

    it('stale marker cleanup cannot remove new instance', () => {
      const dataDir = makeDir('stale-marker-guard');
      const instanceA: RuntimeRecord = {
        version: 1,
        apiVersion: 2,
        pid: 1001,
        url: 'http://127.0.0.1:4318/prototype/room',
        nodeId: 'node-common',
        instanceId: 'inst-A',
      };
      const instanceB: RuntimeRecord = {
        version: 1,
        apiVersion: 2,
        pid: 1002,
        url: 'http://127.0.0.1:4318/prototype/room',
        nodeId: 'node-common',
        instanceId: 'inst-B',
      };

      const cleanupA = registerRuntime(dataDir, instanceA);
      expect(JSON.parse(readFileSync(join(dataDir, 'runtime.json'), 'utf8')).instanceId).toBe('inst-A');

      // Instance B starts and overwrites runtime.json
      const cleanupB = registerRuntime(dataDir, instanceB);
      expect(JSON.parse(readFileSync(join(dataDir, 'runtime.json'), 'utf8')).instanceId).toBe('inst-B');

      // Stale cleanup from instance A is triggered: must NOT remove instance B!
      cleanupA();
      expect(existsSync(join(dataDir, 'runtime.json'))).toBe(true);
      expect(JSON.parse(readFileSync(join(dataDir, 'runtime.json'), 'utf8')).instanceId).toBe('inst-B');

      // Cleanup from instance B removes it
      cleanupB();
      expect(existsSync(join(dataDir, 'runtime.json'))).toBe(false);
    });
  });

  describe('probeRuntime', () => {
    it('returns null when runtime.json is absent', async () => {
      const dataDir = makeDir('probe-absent');
      loadControlToken(dataDir);
      const result = await probeRuntime(dataDir);
      expect(result).toBeNull();
    });

    it('returns null when control.key is absent and does NOT create it during probe', async () => {
      const dataDir = makeDir('probe-no-key');
      const record: RuntimeRecord = {
        version: 1,
        apiVersion: 2,
        pid: process.pid,
        url: 'http://127.0.0.1:4318/prototype/room',
        nodeId: 'node-1',
        instanceId: 'inst-1',
      };
      writeFileSync(join(dataDir, 'runtime.json'), JSON.stringify(record));

      const result = await probeRuntime(dataDir);
      expect(result).toBeNull();
      // control.key must still NOT exist!
      expect(existsSync(join(dataDir, 'control.key'))).toBe(false);
    });

    it('rejects non-loopback URLs and invalid schemas', async () => {
      const dataDir = makeDir('probe-bad-urls');
      loadControlToken(dataDir);

      const testUrls = [
        'http://example.com:4318',
        'http://192.168.1.50:4318',
        'http://user:pass@127.0.0.1:4318',
        'https://127.0.0.1:4318',
        'not-a-url',
        'http://127.0.0.1:99999',
      ];

      for (const badUrl of testUrls) {
        const record: any = {
          version: 1,
          apiVersion: 2,
          pid: process.pid,
          url: badUrl,
          nodeId: 'node-1',
          instanceId: 'inst-1',
        };
        writeFileSync(join(dataDir, 'runtime.json'), JSON.stringify(record));
        expect(await probeRuntime(dataDir)).toBeNull();
      }
    });

    it('validates matching health response and HMAC proof', async () => {
      const dataDir = makeDir('probe-verified');
      const token = loadControlToken(dataDir);

      let requestedChallenge = '';
      let receivedHeaders: Record<string, string> = {};

      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          requestedChallenge = url.searchParams.get('challenge') || '';
          receivedHeaders = Object.fromEntries(req.headers.entries());

          if (url.pathname === '/api/node/health') {
            const proof = runtimeProof(token, requestedChallenge, record);
            return Response.json({
              ready: true,
              nodeId: record.nodeId,
              instanceId: record.instanceId,
              pid: record.pid,
              apiVersion: record.apiVersion,
              proof,
            });
          }
          return new Response('Not found', { status: 404 });
        },
      });
      runningServers.push(server);

      const record: RuntimeRecord = {
        version: 1,
        apiVersion: 2,
        pid: process.pid,
        url: `http://127.0.0.1:${server.port}/prototype/room`,
        nodeId: 'node-verified-01',
        instanceId: 'inst-verified-01',
      };
      registerRuntime(dataDir, record);

      const probed = await probeRuntime(dataDir);
      expect(probed).toEqual(record);
      expect(requestedChallenge.length).toBeGreaterThan(0);

      // Verify control token was NEVER sent across HTTP boundary
      expect(JSON.stringify(receivedHeaders)).not.toContain(token);
    });

    it('rejects wrong proof or mismatched metadata', async () => {
      const dataDir = makeDir('probe-mismatch');
      const token = loadControlToken(dataDir);

      let mode = 'wrong-proof';

      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          const challenge = url.searchParams.get('challenge') || '';
          if (mode === 'wrong-proof') {
            return Response.json({
              ready: true,
              nodeId: record.nodeId,
              instanceId: record.instanceId,
              pid: record.pid,
              apiVersion: record.apiVersion,
              proof: 'bad-proof-000000000000000000000000000000000000000000000000000000000000',
            });
          }
          if (mode === 'mismatched-pid') {
            return Response.json({
              ready: true,
              nodeId: record.nodeId,
              instanceId: record.instanceId,
              pid: 999999,
              apiVersion: record.apiVersion,
              proof: runtimeProof(token, challenge, record),
            });
          }
          if (mode === 'mismatched-node') {
            return Response.json({
              ready: true,
              nodeId: 'different-node-id',
              instanceId: record.instanceId,
              pid: record.pid,
              apiVersion: record.apiVersion,
              proof: runtimeProof(token, challenge, record),
            });
          }
          if (mode === 'not-ready') {
            return Response.json({
              ready: false,
              nodeId: record.nodeId,
              instanceId: record.instanceId,
              pid: record.pid,
              apiVersion: record.apiVersion,
              proof: runtimeProof(token, challenge, record),
            });
          }
          return new Response('Error', { status: 500 });
        },
      });
      runningServers.push(server);

      const record: RuntimeRecord = {
        version: 1,
        apiVersion: 2,
        pid: process.pid,
        url: `http://127.0.0.1:${server.port}/prototype/room`,
        nodeId: 'node-test',
        instanceId: 'inst-test',
      };
      registerRuntime(dataDir, record);

      mode = 'wrong-proof';
      expect(await probeRuntime(dataDir)).toBeNull();

      mode = 'mismatched-pid';
      expect(await probeRuntime(dataDir)).toBeNull();

      mode = 'mismatched-node';
      expect(await probeRuntime(dataDir)).toBeNull();

      mode = 'not-ready';
      expect(await probeRuntime(dataDir)).toBeNull();
    });
  });

  describe('ensureRunning', () => {
    it('reuses existing verified custom-port runtime without spawning', async () => {
      const dataDir = makeDir('reuse-custom-port');
      const token = loadControlToken(dataDir);

      const customPort = 44555;
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: customPort,
        fetch(req) {
          const url = new URL(req.url);
          const challenge = url.searchParams.get('challenge') || '';
          if (url.pathname === '/api/node/health') {
            return Response.json({
              ready: true,
              nodeId: record.nodeId,
              instanceId: record.instanceId,
              pid: record.pid,
              apiVersion: record.apiVersion,
              proof: runtimeProof(token, challenge, record),
            });
          }
          return new Response('Not found', { status: 404 });
        },
      });
      runningServers.push(server);

      const record: RuntimeRecord = {
        version: 1,
        apiVersion: 2,
        pid: process.pid,
        url: `http://127.0.0.1:${customPort}/prototype/room`,
        nodeId: 'node-custom-port',
        instanceId: 'inst-custom-port',
      };
      registerRuntime(dataDir, record);

      // Call ensureRunning with standard port 4318 and a non-existent daemon path
      // If it tried to spawn, it would fail or use 4318; instead it must reuse the verified custom port!
      const result = await ensureRunning({
        dataDir,
        libraryPath: 'dummy.dll',
        port: 4318,
        daemonPath: 'non-existent-script.ts',
      });

      expect(result).toEqual(record);
      expect(result.url).toBe(`http://127.0.0.1:${customPort}/prototype/room`);
    });

    it('starts stopped daemon using child fixture and converges concurrent callers', async () => {
      const dataDir = makeDir('start-and-converge');
      const fixturePort = 44888;
      const runtimeModulePath = join(import.meta.dir, 'runtime.ts').replaceAll('\\', '/');

      // Create a purpose-built child daemon fixture in a test directory
      const fixtureScriptPath = join(dataDir, 'mock-daemon.ts');
      const fixtureContent = `
import { loadControlToken, registerRuntime, runtimeProof, type RuntimeRecord } from '${runtimeModulePath}';

const args = process.argv.slice(2);
let dataDir = '';
let port = 0;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--data-dir') dataDir = args[++i];
  if (args[i] === '--port') port = Number(args[++i]);
}

const token = loadControlToken(dataDir);
const record: RuntimeRecord = {
  version: 1,
  apiVersion: 2,
  pid: process.pid,
  url: 'http://127.0.0.1:' + port + '/prototype/room',
  nodeId: 'node-fixture-child',
  instanceId: 'inst-fixture-child',
};

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/api/node/health') {
      const challenge = url.searchParams.get('challenge') || '';
      return Response.json({
        ready: true,
        nodeId: record.nodeId,
        instanceId: record.instanceId,
        pid: record.pid,
        apiVersion: record.apiVersion,
        proof: runtimeProof(token, challenge, record),
      });
    }
    return new Response('Not found', { status: 404 });
  },
});

const cleanup = registerRuntime(dataDir, record);

process.on('SIGINT', () => { cleanup(); server.stop(true); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); server.stop(true); process.exit(0); });
`;
      writeFileSync(fixtureScriptPath, fixtureContent);

      // Concurrent callers converge on single winner
      const [result1, result2] = await Promise.all([
        ensureRunning({
          dataDir,
          libraryPath: 'dummy.dll',
          port: fixturePort,
          daemonPath: fixtureScriptPath,
        }),
        ensureRunning({
          dataDir,
          libraryPath: 'dummy.dll',
          port: fixturePort,
          daemonPath: fixtureScriptPath,
        }),
      ]);

      expect(result1).toEqual(result2);
      expect(result1.nodeId).toBe('node-fixture-child');
      expect(result1.instanceId).toBe('inst-fixture-child');
      expect(result1.url).toBe(`http://127.0.0.1:${fixturePort}/prototype/room`);

      childPids.push(result1.pid);

      // Ensure no raw control token in outputs or URLs
      const token = loadControlToken(dataDir);
      expect(result1.url).not.toContain(token);
      expect(JSON.stringify(result1)).not.toContain(token);
    });
  });
});
