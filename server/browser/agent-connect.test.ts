import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentCli, connectConflict } from '../agent-cli';
import { deviceId } from '../../src/browser/protocol';

const opus = crypto.randomUUID();
const admitted = { memberId: opus, members: [{ id: opus, name: 'Opus' }] };
const folder = '/home/me/.meshrooms/agents';

test('connect never reuses another agent that already lives in this folder', () => {
  // A fresh folder, or a retry of the link that created the agent here, connects as usual.
  expect(connectConflict('link-a', undefined, {}, folder)).toBeUndefined();
  expect(connectConflict('link-a', 'link-a', admitted, folder)).toBeUndefined();
  // A different link must not quietly become the agent already here (the Claude-Designer / Opus mix-up).
  const other = connectConflict('link-b', 'link-a', admitted, folder);
  expect(other).toContain('"Opus"');
  expect(other).toContain('MESHROOMS_AGENT_HOME');
  // Folders from before the link was recorded are treated as someone else's.
  expect(connectConflict('link-b', undefined, admitted, folder)).toContain('"Opus"');
  // An agent still waiting for the host is protected too: a new link would replace its request.
  expect(connectConflict('link-b', 'link-a', { request: { state: 'pending' } }, folder)).toContain('waiting for the host');
  expect(connectConflict('link-b', 'link-a', { request: { state: 'declined' } }, folder)).toBeUndefined();
});

test('connect fails closed when the room cannot be checked: the link is not used and nothing is recorded', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'agent-connect-')), before = process.env.MESHROOMS_AGENT_HOME;
  process.env.MESHROOMS_AGENT_HOME = folder;
  try {
    const room = crypto.randomUUID();
    await expect(agentCli(['connect', `http://127.0.0.1:9/agent/${room}#${'z'.repeat(43)}`])).rejects.toThrow('this link was not used');
    expect(existsSync(join(folder, 'browser-agents', room, 'room.json'))).toBe(false);
    expect(existsSync(join(folder, 'browser-agents', room, 'connect.lock'))).toBe(false);
  } finally {
    if (before === undefined) delete process.env.MESHROOMS_AGENT_HOME; else process.env.MESHROOMS_AGENT_HOME = before;
    rmSync(folder, { recursive: true, force: true });
  }
});

/** A room service stand-in: `status` answers as the room would (or as a maintenance page), `agent-redeem` fails with `redeem`. */
function fakeRoom(mode: { status: 'room' | 'maintenance'; redeem: number }) {
  return Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const { command, publicKey } = await request.json() as any;
    if (command.action === 'status') return mode.status === 'maintenance' ? new Response('<h1>Back soon</h1>')
      : Response.json({ roomId: command.roomId, deviceId: await deviceId(publicKey), title: 'Room', epoch: 'e', hostOnline: true });
    return Response.json({ error: `redeem failed (${mode.redeem})` }, { status: mode.redeem });
  } });
}
async function inFreshHome(work: (folder: string) => Promise<void>) {
  const folder = mkdtempSync(join(tmpdir(), 'agent-connect-')), before = process.env.MESHROOMS_AGENT_HOME;
  process.env.MESHROOMS_AGENT_HOME = folder;
  try { await work(folder); } finally {
    if (before === undefined) delete process.env.MESHROOMS_AGENT_HOME; else process.env.MESHROOMS_AGENT_HOME = before;
    rmSync(folder, { recursive: true, force: true });
  }
}
const token = 'y'.repeat(43);

test("a 200 that is not the room's answer (a proxy or maintenance page) fails closed too", () => inFreshHome(async folder => {
  const server = fakeRoom({ status: 'maintenance', redeem: 500 }), room = crypto.randomUUID();
  try {
    await expect(agentCli(['connect', `http://127.0.0.1:${server.port}/agent/${room}#${token}`])).rejects.toThrow('this link was not used');
    expect(existsSync(join(folder, 'browser-agents', room, 'room.json'))).toBe(false);
  } finally { server.stop(true); }
}));

test('a refused link rolls the record back; a redeem that may have gone through keeps it so the same link can retry', () => inFreshHome(async folder => {
  const mode = { status: 'room' as const, redeem: 403 }, server = fakeRoom(mode);
  try {
    const refused = crypto.randomUUID();
    await expect(agentCli(['connect', `http://127.0.0.1:${server.port}/agent/${refused}#${token}`])).rejects.toThrow('redeem failed (403)');
    expect(existsSync(join(folder, 'browser-agents', refused, 'room.json'))).toBe(false);
    mode.redeem = 503;
    const unsure = crypto.randomUUID();
    await expect(agentCli(['connect', `http://127.0.0.1:${server.port}/agent/${unsure}#${token}`])).rejects.toThrow('redeem failed (503)');
    const kept = JSON.parse(readFileSync(join(folder, 'browser-agents', unsure, 'room.json'), 'utf8'));
    expect(kept.link).toBe(createHash('sha256').update(token).digest('hex'));
  } finally { server.stop(true); }
}));

test("a connect's lock is taken over only once its process is gone, and only by one connect", () => inFreshHome(async folder => {
  const server = fakeRoom({ status: 'maintenance', redeem: 500 }), room = crypto.randomUUID(), dir = join(folder, 'browser-agents', room);
  const link = `http://127.0.0.1:${server.port}/agent/${room}#${token}`, lock = join(dir, 'connect.lock'), old = new Date(Date.now() - 3_600_000);
  // A process that has already exited.
  const gone = String(spawnSync(process.execPath, ['-e', '0']).pid);
  try {
    mkdirSync(dir, { recursive: true });
    // A live owner keeps its lock however old it is (a laptop asleep mid-connect).
    writeFileSync(lock, String(process.pid)); utimesSync(lock, old, old);
    await expect(agentCli(['connect', link])).rejects.toThrow('Another connect is running');
    // A lock with no owner written yet is fresh for a minute.
    writeFileSync(lock, '');
    await expect(agentCli(['connect', link])).rejects.toThrow('Another connect is running');
    // The owner is gone, but another connect is taking the lock over right now.
    writeFileSync(lock, gone); writeFileSync(`${lock}.reclaim`, String(process.pid));
    await expect(agentCli(['connect', link])).rejects.toThrow('Another connect is running');
    // A takeover that crashed says which file to delete.
    writeFileSync(`${lock}.reclaim`, gone);
    await expect(agentCli(['connect', link])).rejects.toThrow('Delete that file');
    // A lock whose owner is gone is taken over: this connect gets as far as checking the room, and leaves no lock behind.
    rmSync(`${lock}.reclaim`);
    await expect(agentCli(['connect', link])).rejects.toThrow('this link was not used');
    expect(existsSync(lock) || existsSync(`${lock}.reclaim`)).toBe(false);
    // So is an old lock that never got an owner written.
    writeFileSync(lock, ''); utimesSync(lock, old, old);
    await expect(agentCli(['connect', link])).rejects.toThrow('this link was not used');
    expect(existsSync(lock)).toBe(false);
  } finally { server.stop(true); }
}));
