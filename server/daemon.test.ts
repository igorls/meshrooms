import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { defaultOptions } from './daemon';
import { testDirectory } from './test-directory';
import { readFileSync } from 'node:fs';

const authorization = new Map<string, string>();

async function launch(dataDir: string, port = 0) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'daemon.ts'), '--data-dir', dataDir,
    '--library', defaultOptions().libraryPath, '--port', String(port)], { stdout: 'pipe', stderr: 'pipe' });
  const reader = child.stdout.getReader();
  let buffer = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const info = await Promise.race([
      (async () => {
        while (true) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`Daemon exited before ready: ${await new Response(child.stderr).text()}`);
          buffer += new TextDecoder().decode(value);
          for (const line of buffer.split('\n')) {
            try { const parsed = JSON.parse(line); if (parsed.event === 'meshrooms.ready') return parsed as { nodeId: string; pid: number; url: string }; } catch { /* Partial JSON line. */ }
          }
        }
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Daemon startup timed out')), 10000); }),
    ]);
    const base = new URL(info.url).origin;
    authorization.set(base, `Bearer ${readFileSync(join(dataDir, 'control.key'), 'utf8').trim()}`);
    return { child, base, info };
  } catch (error) { child.kill(); await child.exited; throw error; }
  finally { if (timer) clearTimeout(timer); reader.releaseLock(); }
}
async function terminate(child: ReturnType<typeof Bun.spawn>) { child.kill('SIGKILL'); await child.exited; }
const send = (base: string, path: string, body: unknown) => fetch(`${base}/api/node/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization.get(base)! }, body: JSON.stringify(body),
});
const snapshot = async (base: string) => (await fetch(`${base}/api/node/snapshot`, { headers: { Authorization: authorization.get(base)! } })).json();

test('one actual daemon recovers two rooms, local membership and idempotent sends after immediate forced exit', async () => {
  const directory = testDirectory('restart'); const dir = directory.path;
  let run: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    run = await launch(dir);
    const aCommand = { title: 'Room A', project: 'Alpha', requestId: randomUUID() };
    const aResponse = await send(run.base, 'rooms', aCommand); expect(aResponse.status).toBe(201);
    const a = await aResponse.json();
    const b = await (await send(run.base, 'rooms', { title: 'Room B', project: 'Beta', requestId: randomUUID() })).json();
    const message = { roomId: a.roomId, requestId: randomUUID(), text: 'Receipt survives immediate process exit — café 🚀' };
    const firstResponse = await send(run.base, 'messages', message); expect(firstResponse.status).toBe(201);
    const firstMessage = await firstResponse.json();
    const secondResponse = await send(run.base, 'messages', { roomId: b.roomId, requestId: randomUUID(), text: 'Only room B' });
    expect(secondResponse.status).toBe(201); await secondResponse.json();
    // No flush delay, close() or second snapshot read between the final receipt and kill.
    const originalIdentity = run.info.nodeId;
    await terminate(run.child);
    run = await launch(dir);
    expect(run.info.nodeId).toBe(originalIdentity);
    const restored = await snapshot(run.base);
    expect(restored.rooms.map((room: any) => room.messages.map((item: any) => item.text))).toEqual([[message.text], ['Only room B']]);
    expect(restored.rooms.every((room: any) => room.participants.length === 1 && room.participants[0].id === restored.localParticipantId)).toBe(true);
    expect(await (await send(run.base, 'rooms', aCommand)).json()).toEqual(a);
    expect(await (await send(run.base, 'messages', message)).json()).toEqual(firstMessage);
    expect((await snapshot(run.base)).rooms[0].messages).toHaveLength(1);
    // An explicit second HTTP port must not bypass data ownership.
    await expect(launch(dir)).rejects.toThrow('already owns');
    expect((await fetch(`${run.base}/api/node/health`)).status).toBe(200);
  } finally { if (run) await terminate(run.child); directory.cleanup(); }
}, 30000);
test.skipIf(process.platform === 'win32')('a supervised second daemon exits successfully instead of provoking restart loops', async () => {
  const directory = testDirectory('supervised'); const dir = directory.path;
  let run: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    run = await launch(dir);
    const second = (supervised: boolean) => Bun.spawn([process.execPath, join(import.meta.dir, 'daemon.ts'), ...(supervised ? ['--supervised'] : []),
      '--data-dir', dir, '--library', defaultOptions().libraryPath, '--port', '0'], { stdout: 'pipe', stderr: 'pipe' });
    const quiet = second(true);
    expect(await quiet.exited).toBe(0);
    expect(await new Response(quiet.stderr).text()).toContain('already owns');
    // Unsupervised launches keep reporting the collision as a failure.
    expect(await second(false).exited).toBe(1);
    expect((await fetch(`${run.base}/api/node/health`)).status).toBe(200);
  } finally { if (run) await terminate(run.child); directory.cleanup(); }
}, 30000);
