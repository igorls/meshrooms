import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDesktopSocket, deliverToDesktop, DesktopClient, DesktopError } from './codex-desktop';
import { harnessInvocation, type WatchConfig } from './agent-watch';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.splice(0).reverse()) f(); });
const unixTest = process.platform === 'win32' ? test.skip : test;
const threadId = '00000000-0000-4000-8000-000000000001';
const event = { id: '00000000-0000-4000-8000-000000000002', threadId, cwd: '/project', createdAt: 1000, output: '{"deliveryId":"one","text":"external room data"}' };

async function desktop(options: { idle?: boolean; capabilities?: boolean; disconnect?: boolean; spoof?: boolean; silent?: boolean; fragment?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mr-desktop-')); chmodSync(dir, 0o700);
  const path = join(dir, 'ipc.sock'), seen: any[] = [], sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let bytes: Buffer = Buffer.alloc(0);
    socket.on('data', data => {
      bytes = Buffer.concat([bytes, typeof data === 'string' ? Buffer.from(data) : data]);
      while (bytes.length >= 4 && bytes.length >= bytes.readUInt32LE(0) + 4) {
        const size = bytes.readUInt32LE(0), request = JSON.parse(bytes.subarray(4, size + 4).toString()); bytes = bytes.subarray(size + 4); seen.push(request);
        if (request.type !== 'request') continue;
        let result: any = {}, error: string | undefined;
        if (request.method === 'initialize') result = { clientId: 'meshrooms-test-client' };
        else if (request.method === 'thread-owner-discovery') result = { supportsUntrustedAppInput: options.capabilities !== false };
        else {
          if (options.disconnect) { socket.destroy(); continue; }
          if (options.silent) continue;
          if (options.idle && request.method === 'thread-follower-steer-turn') error = `Cannot steer conversation ${threadId} because its active turn already ended`;
          else result = { result: { turn: { id: options.idle ? 'idle-turn' : 'active-turn' } } };
        }
        const body = Buffer.from(JSON.stringify({ type: 'response', requestId: request.requestId, method: request.method, resultType: error ? 'error' : 'success',
          handledByClientId: options.spoof && request.method.startsWith('thread-follower-') ? 'another-owner' : 'desktop-owner', result, ...(error ? { error } : {}) }));
        const h = Buffer.alloc(4); h.writeUInt32LE(body.length); const frame = Buffer.concat([h, body]);
        if (options.fragment) { socket.write(frame.subarray(0, 2)); setTimeout(() => socket.write(frame.subarray(2)), 1); }
        else socket.write(frame);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve)); chmodSync(path, 0o600);
  cleanup.push(() => { for (const s of sockets) s.destroy(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  return { path, dir, seen };
}

unixTest('active desktop delivery uses the discovered owner, handles fragmented frames, and preserves room text as tool output', async () => {
  const fake = await desktop({ fragment: true }); let persisted = 0;
  expect(await deliverToDesktop(event, () => { persisted++; }, { path: fake.path, timeoutMs: 2000 })).toEqual({ turnId: 'active-turn', owner: 'desktop-owner' });
  expect(persisted).toBe(1);
  const push = fake.seen.find(r => r.method === 'thread-follower-start-turn');
  expect(push.targetClientId).toBe('desktop-owner'); expect(push.version).toBe(2);
  expect(push.params.turnStart.request.input).toEqual([]); expect(push.params.turnStart.request.toolOutput.output).toBe(event.output);
  expect(push.params.turnStart.request.toolOutput).toMatchObject({ namespace: 'meshrooms', name: 'room_message' });
  expect(push.params.turnStart.context.restoreMessage.context.prompt).not.toContain('external room data');
});

unixTest('the same owner operation starts an idle chat, with no model or permission override', async () => {
  const fake = await desktop({ idle: true }); let persisted = 0;
  expect((await deliverToDesktop(event, () => { persisted++; }, { path: fake.path })).turnId).toBe('idle-turn');
  expect(persisted).toBe(1);
  const start = fake.seen.find(r => r.method === 'thread-follower-start-turn');
  expect(start.targetClientId).toBe('desktop-owner'); expect(start.version).toBe(2);
  expect(Object.keys(start.params.turnStart.request).sort()).toEqual(['clientUserMessageId', 'input', 'threadId', 'toolOutput']);
  expect(start.params.turnStart.context.inheritThreadSettings).toBe(true);
  expect(fake.seen.filter(r => r.method.startsWith('thread-follower-'))).toHaveLength(1);
});

unixTest('an incompatible owner fails before submission and is never replaced by a CLI process', async () => {
  const fake = await desktop({ capabilities: false }); let persisted = false;
  await expect(deliverToDesktop(event, () => { persisted = true; }, { path: fake.path })).rejects.toMatchObject({ kind: 'unsupported' });
  expect(persisted).toBe(false); expect(fake.seen.some(r => r.method.startsWith('thread-follower-'))).toBe(false);
  expect(() => harnessInvocation({ harness: 'codex', codexDelivery: 'desktop' } as WatchConfig, '', '')).toThrow('never launch');
});

for (const mode of ['disconnect', 'silent', 'spoof'] as const) unixTest(`${mode} after submission is uncertain and never triggers a second send`, async () => {
  const fake = await desktop({ [mode]: true });
  await expect(deliverToDesktop(event, () => {}, { path: fake.path, timeoutMs: 70 })).rejects.toMatchObject({ kind: 'uncertain' });
  expect(fake.seen.filter(r => r.method.startsWith('thread-follower-'))).toHaveLength(1);
});

unixTest('reconnections rediscover owners; paths readable by other users and symlinks are refused', async () => {
  const fake = await desktop();
  await deliverToDesktop(event, () => {}, { path: fake.path }); await deliverToDesktop({ ...event, id: 'next' }, () => {}, { path: fake.path });
  expect(fake.seen.filter(r => r.method === 'thread-owner-discovery')).toHaveLength(2);
  chmodSync(fake.path, 0o666); expect(() => checkDesktopSocket(fake.path)).toThrow('private'); chmodSync(fake.path, 0o600);
  const linked = join(fake.dir, 'linked.sock'); symlinkSync(fake.path, linked); expect(() => checkDesktopSocket(linked)).toThrow('private');
});

test('unsupported platforms fail closed without connecting', () => {
  expect(() => checkDesktopSocket('unused', 'win32')).toThrow('not yet supported on Windows');
  expect(new DesktopError('unavailable', 'missing').kind).toBe('unavailable');
});
