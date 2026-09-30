import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalNode } from './node';
import { createHandler } from './http';
import { NodeAccess } from './access';
import { testStartupManager } from './startup';
import { attachmentsKey, tokenHash } from './model';
import { cleanName, sniff } from './attachments';
import { fileBlobs, memoryBlobs } from './blobs';
import { testDirectory } from './test-directory';

function png(width = 1280, height = 720, seed = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(40); bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width); new DataView(bytes.buffer).setUint32(20, height); bytes[39] = seed; return bytes;
}

test('types come from the bytes; only raster images are inline, and names are cleaned', () => {
  expect(sniff(png(1440, 900))).toEqual({ type: 'image/png', kind: 'image', width: 1440, height: 900 });
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x02, 0x58, 0x03, 0x20, 1, 0, 0, 0, 0, 0]);
  expect(sniff(jpeg)).toEqual({ type: 'image/jpeg', kind: 'image', width: 800, height: 600 });
  expect(sniff(new Uint8Array([...Buffer.from('GIF89a'), 64, 0, 32, 0]))).toMatchObject({ type: 'image/gif', width: 64, height: 32 });
  const webp = new Uint8Array(30); webp.set(Buffer.from('RIFF'), 0); webp.set(Buffer.from('WEBPVP8X'), 8); webp.set([99, 0, 0, 49, 0, 0], 24);
  expect(sniff(webp)).toMatchObject({ type: 'image/webp', width: 100, height: 50 });
  expect(sniff(Buffer.from('%PDF-1.7 ...'))).toEqual({ type: 'application/pdf', kind: 'file' });
  expect(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toEqual({ type: 'text/plain', kind: 'file' });
  expect(sniff(new Uint8Array([0, 1, 2, 255]))).toEqual({ type: 'application/octet-stream', kind: 'file' });
  expect(cleanName('C:\\Users\\me\\..\\bug<1>.png', 'x')).toBe('bug1.png');
  expect(cleanName('../../.env', 'x')).toBe('env');
  expect(cleanName('\u0000', 'fallback.bin')).toBe('fallback.bin');
});

test('file blobs are content addressed, verified on read, and swept when unreferenced', () => {
  const directory = testDirectory('blobs');
  try {
    const blobs = fileBlobs(directory.path); const a = blobs.put(png()), b = blobs.put(png(1, 1));
    expect(blobs.put(png())).toBe(a); expect(blobs.get(a)).toEqual(png());
    writeFileSync(join(directory.path, b.slice(0, 2), b), 'tampered');
    expect(blobs.get(b)).toBeNull(); expect(blobs.get('../../etc/passwd')).toBeNull();
    expect(blobs.sweep(new Set([a]))).toBe(1); expect(blobs.get(a)).not.toBeNull();
    expect(readdirSync(join(directory.path, a.slice(0, 2)))).toEqual([a]);
  } finally { directory.cleanup(); }
});

function room() {
  const records = new Map<string, string>(), blobs = memoryBlobs();
  const store = () => ({ read: (key: string) => records.get(key) ?? null, write: (key: string, value: string) => { records.set(key, value); }, close() {} });
  const node = new LocalNode(store(), blobs); const secret = randomBytes(32).toString('base64url'), roomId = randomUUID();
  node.prepareRoom({ requestId: roomId, title: 'Screens', agentName: 'Codex', credentialHash: tokenHash(secret) });
  node.completeSetup({ requestId: randomUUID(), humanName: 'Igor', machineName: 'Test', startAtLogin: false, intentId: roomId });
  return { node, records, blobs, store, roomId, agent: node.authenticateAgent(secret)! };
}

test('people and agents share screenshots: upload, send, read back, with scope and reuse rules', () => {
  const { node, roomId, agent } = room();
  try {
    const request = randomUUID();
    const shot = node.upload({ roomId, requestId: request, name: 'image.png', bytes: png(1440, 900) });
    expect(shot).toMatchObject({ name: 'image.png', type: 'image/png', kind: 'image', size: 40, width: 1440, height: 900 });
    expect(node.upload({ roomId, requestId: request, name: 'image.png', bytes: png(1440, 900) })).toEqual(shot);
    expect(() => node.upload({ roomId, requestId: request, name: 'other.png', bytes: png(1440, 900) })).toThrow('different content');
    // Unsent uploads are private to the uploader.
    expect(() => node.attachment(roomId, shot.id, agent)).toThrow('not in this room');
    expect(() => node.send({ roomId, requestId: randomUUID(), text: 'Mine', attachments: [shot.id] }, agent)).toThrow('Upload each attachment');
    const sent = node.send({ roomId, requestId: randomUUID(), text: '@Codex the header overlaps on mobile', attachments: [shot.id] });
    expect(node.snapshot(agent).rooms[0].messages[0].attachments).toEqual([shot]);
    expect(node.attachment(roomId, shot.id, agent).bytes).toEqual(png(1440, 900));
    expect(() => node.send({ roomId, requestId: randomUUID(), attachments: [shot.id] })).toThrow('already sent');
    // Agents attach too, still bound by the floor rules; attachment-only messages need no text.
    const log = node.upload({ roomId, requestId: randomUUID(), name: 'console.log', bytes: Buffer.from('TypeError: x is undefined') }, agent);
    expect(log).toMatchObject({ kind: 'file', type: 'text/plain' });
    expect(() => node.send({ roomId, requestId: randomUUID(), attachments: [log.id] }, agent)).toThrow('humans-first');
    node.send({ roomId, requestId: randomUUID(), attachments: [log.id], replyTo: sent.messageId }, agent);
    expect(() => node.send({ roomId, requestId: randomUUID(), attachments: [] })).toThrow('Enter a message');
    expect(() => node.upload({ roomId, requestId: randomUUID(), bytes: new Uint8Array(10 * 1024 * 1024 + 1) })).toThrow('10 MB');
    for (let i = 0; i < 8; i++) node.upload({ roomId, requestId: randomUUID(), bytes: png(10, 10, i) });
    expect(() => node.upload({ roomId, requestId: randomUUID(), bytes: png(10, 10, 9) })).toThrow('pending attachments');
  } finally { node.close(); }
});

test('restart keeps sent attachments and drops day-old unsent uploads and their bytes', () => {
  const { node, records, blobs, store, roomId } = room();
  const kept = node.upload({ roomId, requestId: randomUUID(), bytes: png(1, 1, 1) });
  node.send({ roomId, requestId: randomUUID(), attachments: [kept.id] });
  const stale = node.upload({ roomId, requestId: randomUUID(), bytes: png(1, 1, 2) });
  const fresh = node.upload({ roomId, requestId: randomUUID(), bytes: png(1, 1, 3) });
  node.close();
  const index = JSON.parse(records.get(attachmentsKey(roomId))!);
  index.files.find((f: any) => f.id === stale.id).uploadedAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  records.set(attachmentsKey(roomId), JSON.stringify(index));
  const restored = new LocalNode(store(), blobs);
  try {
    expect(restored.snapshot().rooms[0].messages[0].attachments).toEqual([kept]);
    expect(restored.attachment(roomId, kept.id).bytes).toEqual(png(1, 1, 1));
    expect(() => restored.attachment(roomId, stale.id)).toThrow('not in this room');
    expect(restored.attachment(roomId, fresh.id).bytes).toEqual(png(1, 1, 3));
    expect(blobs.data.size).toBe(2);
  } finally { restored.close(); }
});

test('HTTP uploads raw bytes and serves images inline but other files only as sandboxed downloads', async () => {
  const { node, roomId } = room();
  const token = 'test-control-token-32-bytes-minimum-length';
  const handle = createHandler({ node, origins: ['http://127.0.0.1:4318'], distDir: 'dist', dataDir: 'test-store', access: new NodeAccess(token, node),
    startup: testStartupManager(), runtime: { apiVersion: 2, instanceId: 'test-instance', pid: process.pid }, proof: () => 'test-proof' });
  const auth = { Authorization: `Bearer ${token}` };
  const upload = (name: string, body: Uint8Array<ArrayBuffer>, extra: Record<string, string> = {}) => handle(new Request(
    `http://127.0.0.1:4318/api/node/attachments?${new URLSearchParams({ roomId, requestId: randomUUID(), name })}`,
    { method: 'POST', headers: { ...auth, 'Content-Type': 'image/png', ...extra }, body }));
  const get = (id: string) => handle(new Request(`http://127.0.0.1:4318/api/node/attachments/${roomId}/${id}`, { headers: auth }));
  try {
    expect((await upload('x.png', png(), { Origin: 'https://evil.example' })).status).toBe(403);
    const image = await (await upload('bug.png', png(800, 600))).json();
    const svg = await (await upload('logo.svg', new TextEncoder().encode('<svg onload="alert(1)"/>'))).json();
    expect(svg).toMatchObject({ kind: 'file', type: 'text/plain' });
    const shown = await get(image.id);
    expect(shown.status).toBe(200); expect(shown.headers.get('content-type')).toBe('image/png');
    expect(shown.headers.get('content-disposition')).toStartWith('inline;');
    expect(shown.headers.get('content-security-policy')).toContain('sandbox');
    expect(new Uint8Array(await shown.arrayBuffer())).toEqual(png(800, 600));
    const downloaded = await get(svg.id);
    expect(downloaded.headers.get('content-type')).toBe('application/octet-stream');
    expect(downloaded.headers.get('content-disposition')).toStartWith('attachment;');
    expect((await get(randomUUID())).status).toBe(404);
  } finally { node.close(); }
});
