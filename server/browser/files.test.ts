import { expect, test } from 'bun:test';
import {
  CHUNK_BYTES, FileTransfers, attachmentRef, attachmentText, displayKind, retainedFiles, sha256Hex, shownText, validAttachments,
  type AttachmentRef, type FileChannel, type FileStore,
} from '../../src/browser/files';

const roomId = crypto.randomUUID();
const png = (extra = 0) => {
  const bytes = new Uint8Array(33 + extra);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 64, 0, 0, 0, 32]);
  for (let i = 33; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
  return bytes;
};

test('attachment metadata comes from the bytes, and invalid metadata is refused', async () => {
  const ref = await attachmentRef(png(), '../../etc/sneaky\u0000.png');
  expect(ref).toMatchObject({ name: 'sneaky.png', type: 'image/png', size: 33, width: 64, height: 32 });
  expect(ref.sha256).toBe(await sha256Hex(png()));
  const svg = await attachmentRef(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'x.svg');
  expect(svg.type).toBe('text/plain');
  expect(displayKind(svg, 'text/plain')).toBe('file');
  expect(displayKind(ref, 'image/png')).toBe('image');
  expect(displayKind(ref, 'application/octet-stream')).toBe('file');
  expect(validAttachments([ref])).toBe(true);
  expect(validAttachments([])).toBe(false);
  expect(validAttachments(Array.from({ length: 5 }, () => ({ ...ref, id: crypto.randomUUID() })))).toBe(false);
  expect(validAttachments([ref, ref])).toBe(false);
  expect(validAttachments([{ ...ref, size: 10 * 1024 * 1024 + 1 }])).toBe(false);
  expect(validAttachments([{ ...ref, type: 'image/svg+xml' }])).toBe(false);
  expect(validAttachments([{ ...ref, name: 'a/b.png' }])).toBe(false);
  expect(validAttachments([{ ...ref, sha256: 'x' }])).toBe(false);
  expect(validAttachments([{ ...ref, extra: 1 }])).toBe(false);
  await expect(attachmentRef(new Uint8Array(10 * 1024 * 1024 + 1), 'big.bin')).rejects.toThrow('10 MB');
  await expect(attachmentRef(new Uint8Array(), 'empty')).rejects.toThrow('empty');
});

test('a message of only files carries text that older devices accept, and current devices hide', async () => {
  const ref = await attachmentRef(png(), 'shot.png');
  const text = attachmentText([ref]);
  expect(text).toBe('Attached shot.png');
  expect(shownText({ text, attachments: [ref] })).toBe('');
  expect(shownText({ text: 'Look at this', attachments: [ref] })).toBe('Look at this');
  expect(shownText({ text })).toBe(text);
});

test('devices keep the files of the newest messages up to the room cap', () => {
  const ref = (n: number, size: number): AttachmentRef => ({ id: crypto.randomUUID(), name: `${n}.png`, type: 'image/png', size, sha256: String(n).padStart(64, '0') });
  const lists = [[ref(1, 50)], undefined, [ref(2, 30), ref(3, 30)], [ref(4, 30)]];
  expect([...retainedFiles(lists, 100).keys()].map(Number)).toEqual([4, 2, 3]);
  expect([...retainedFiles(lists, 1000, 2).keys()].map(Number)).toEqual([4, 2]);
  // A file sent again later counts once, at its newest use.
  expect([...retainedFiles([[ref(1, 60)], [ref(1, 60)]], 100).keys()].map(Number)).toEqual([1]);
});

type Device = { id: string; files: Map<string, Uint8Array>; transfers: FileTransfers; channels: Map<string, Pipe>; refs: Map<string, AttachmentRef>; puts: number };
type Pipe = FileChannel & { readyState: string; bufferedAmount: number; sent: number };
/** A channel that delivers asynchronously and in order, and can be tampered with or cut. */
function connect(a: Device, b: Device, tamper?: (packet: any) => any) {
  const pipe = (from: Device, to: Device): Pipe => {
    const channel: Pipe = { readyState: 'open', bufferedAmount: 0, sent: 0, send(data: string) {
      if (channel.readyState !== 'open') throw new Error('closed');
      expect(data.length).toBeLessThan(20_000);
      channel.sent++; channel.bufferedAmount += data.length;
      setTimeout(() => {
        channel.bufferedAmount -= data.length; if (channel.readyState !== 'open') return;
        const packet = tamper ? tamper(JSON.parse(data)) : JSON.parse(data);
        if (packet) to.transfers.handle(from.id, packet);
      }, 0);
    } };
    return channel;
  };
  a.channels.set(b.id, pipe(a, b)); b.channels.set(a.id, pipe(b, a));
  a.transfers.opened(b.id); b.transfers.opened(a.id);
}
function cut(a: Device, b: Device) {
  a.channels.get(b.id)!.readyState = 'closed'; b.channels.get(a.id)!.readyState = 'closed';
  a.channels.delete(b.id); b.channels.delete(a.id); a.transfers.closed(b.id); b.transfers.closed(a.id);
}
function device(id: string): Device {
  const d = { id, files: new Map(), channels: new Map(), refs: new Map(), puts: 0 } as unknown as Device;
  const store: FileStore = { has: sha => d.files.has(sha), get: async sha => d.files.get(sha), put: async (sha, bytes) => { d.puts++; d.files.set(sha, bytes.slice()); } };
  d.transfers = new FileTransfers({ roomId, store, referenced: sha => d.refs.get(sha), channel: peer => d.channels.get(peer), peers: () => [...d.channels.keys()] });
  return d;
}
const until = async (check: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await Bun.sleep(5); return check(); };

test('a file is pulled in chunks below the channel limit and reassembled exactly', async () => {
  const author = device('a'), reader = device('b');
  const bytes = png(CHUNK_BYTES * 5 + 123); const ref = await attachmentRef(bytes, 'shot.png');
  author.files.set(ref.sha256, bytes); author.refs.set(ref.sha256, ref); reader.refs.set(ref.sha256, ref);
  connect(author, reader);
  reader.transfers.want(ref);
  expect(await until(() => reader.files.has(ref.sha256))).toBe(true);
  expect(reader.files.get(ref.sha256)).toEqual(bytes);
  expect(author.channels.get('b')!.sent).toBe(1 + 6 + 1); // announcement, chunks, done
});

test('only files named by a verified message are served', async () => {
  const author = device('a'), reader = device('b');
  const bytes = png(); const ref = await attachmentRef(bytes, 'private.png');
  author.files.set(ref.sha256, bytes); // held, but no message in this room references it
  connect(author, reader); reader.transfers.want(ref);
  await until(() => reader.transfers.state(ref.sha256)?.state === 'waiting');
  await Bun.sleep(20);
  expect(reader.files.has(ref.sha256)).toBe(false);
  expect(reader.transfers.state(ref.sha256)).toEqual({ state: 'waiting' });
});

test('a late joiner resumes from a different peer after the first one disconnects', async () => {
  const author = device('a'), holder = device('h'), late = device('l');
  const bytes = png(CHUNK_BYTES * 40); const ref = await attachmentRef(bytes, 'big.png');
  for (const d of [author, holder]) { d.files.set(ref.sha256, bytes); d.refs.set(ref.sha256, ref); }
  late.refs.set(ref.sha256, ref);
  let progress: unknown;
  connect(author, late, packet => {
    if (packet.kind !== 'file-chunk' || packet.offset !== CHUNK_BYTES * 10) return packet;
    progress = late.transfers.state(ref.sha256); cut(author, late); return null;
  });
  late.transfers.want(ref);
  expect(await until(() => !!progress)).toBe(true);
  expect(progress).toEqual({ state: 'fetching', received: CHUNK_BYTES * 10, size: ref.size });
  expect(late.transfers.state(ref.sha256)).toEqual({ state: 'waiting' });
  let firstOffset = -1;
  connect(holder, late, packet => { if (packet.kind === 'file-chunk' && firstOffset < 0) firstOffset = packet.offset; return packet; });
  expect(await until(() => late.files.has(ref.sha256))).toBe(true);
  expect(late.files.get(ref.sha256)).toEqual(bytes);
  expect(firstOffset).toBe(CHUNK_BYTES * 10);
});

test('a tampered chunk fails verification: nothing is stored, and another peer supplies the real file', async () => {
  const liar = device('l'), honest = device('o'), reader = device('r');
  const bytes = png(CHUNK_BYTES * 3); const ref = await attachmentRef(bytes, 'shot.png');
  for (const d of [liar, honest]) { d.files.set(ref.sha256, bytes); d.refs.set(ref.sha256, ref); }
  reader.refs.set(ref.sha256, ref);
  connect(liar, reader, packet => {
    if (packet.kind !== 'file-chunk' || packet.offset !== CHUNK_BYTES) return packet;
    const data = Uint8Array.from(atob(packet.data), c => c.charCodeAt(0)); data[7] ^= 1;
    return { ...packet, data: btoa(String.fromCharCode(...data)) };
  });
  reader.transfers.want(ref);
  expect(await until(() => reader.transfers.state(ref.sha256)?.state === 'damaged')).toBe(true);
  expect(reader.files.has(ref.sha256)).toBe(false);
  expect(reader.puts).toBe(0);
  connect(honest, reader);
  expect(await until(() => reader.files.has(ref.sha256))).toBe(true);
  expect(reader.files.get(ref.sha256)).toEqual(bytes);
});

test('chunks at the wrong offset, oversized, or unrequested are ignored', async () => {
  const author = device('a'), reader = device('b');
  const bytes = png(CHUNK_BYTES * 2); const ref = await attachmentRef(bytes, 'shot.png');
  author.files.set(ref.sha256, bytes); author.refs.set(ref.sha256, ref); reader.refs.set(ref.sha256, ref);
  connect(author, reader);
  // Unrequested: nothing is assembled from packets nobody asked for.
  reader.transfers.handle('a', { kind: 'file-chunk', roomId, sha256: ref.sha256, offset: 0, data: btoa('x') });
  reader.transfers.handle('a', { kind: 'file-done', roomId, sha256: ref.sha256, size: ref.size });
  expect(reader.transfers.state(ref.sha256)).toBeUndefined();
  let skipped = false;
  connect(author, reader, packet => { if (packet.kind === 'file-chunk' && packet.offset === 0 && !skipped) { skipped = true; return { ...packet, offset: 5 }; } return packet; });
  reader.transfers.want(ref);
  await until(() => reader.transfers.state(ref.sha256)?.state === 'waiting');
  expect(reader.files.has(ref.sha256)).toBe(false);
  // Another room's packets are consumed but never acted on.
  expect(reader.transfers.handle('a', { kind: 'file-want', roomId: crypto.randomUUID(), sha256: ref.sha256, offset: 0 })).toBe(true);
  expect(reader.transfers.handle('a', { body: { kind: 'message' } })).toBe(false);
});

test('senders wait for the channel buffer to drain', async () => {
  const author = device('a'), reader = device('b');
  const bytes = png(CHUNK_BYTES * 200); const ref = await attachmentRef(bytes, 'big.png');
  author.files.set(ref.sha256, bytes); author.refs.set(ref.sha256, ref); reader.refs.set(ref.sha256, ref);
  connect(author, reader);
  const channel = author.channels.get('b')!; let peak = 0;
  const send = channel.send.bind(channel); channel.send = data => { send(data); peak = Math.max(peak, channel.bufferedAmount); };
  reader.transfers.want(ref);
  expect(await until(() => reader.files.has(ref.sha256), 10_000)).toBe(true);
  expect(peak).toBeLessThan(1_000_000 + 20_000);
  expect(peak).toBeGreaterThan(900_000);
});

test("requests beyond the upload limits never read files", async () => {
  const refs = new Map<string, AttachmentRef>(), bytes = new Map<string, Uint8Array>(), sent: any[] = [];
  for (let i = 0; i < 5; i++) { const b = png(i); const ref = await attachmentRef(b, `${i}.png`); refs.set(ref.sha256, ref); bytes.set(ref.sha256, b); }
  let reads = 0, release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const store: FileStore = { has: sha => bytes.has(sha), get: async sha => { reads++; await gate; return bytes.get(sha); }, put: async () => {} };
  const channel = { readyState: 'open', bufferedAmount: 0, send: (data: string) => { sent.push(JSON.parse(data)); } };
  const transfers = new FileTransfers({ roomId, store, referenced: sha => refs.get(sha), channel: () => channel, peers: () => ['peer'] });
  const [first, ...others] = [...refs.keys()];
  // Twenty requests for one file read it once; of the other files only one more fits the per-peer limit.
  for (let i = 0; i < 20; i++) transfers.handle('peer', { kind: 'file-want', roomId, sha256: first, offset: 0 });
  for (const sha of others) transfers.handle('peer', { kind: 'file-want', roomId, sha256: sha, offset: 0 });
  expect(reads).toBe(2);
  expect(sent.filter(p => p.kind === 'file-missing')).toHaveLength(3);
  release(); await Bun.sleep(20);
  expect(sent.filter(p => p.kind === 'file-done')).toHaveLength(2);
});

test("a stalled source is not asked again before the retry delay", async () => {
  let now = 1_000_000; const asked: string[] = [];
  const ref = await attachmentRef(png(), 'wanted.png');
  const channel = (peer: string) => ({ readyState: 'open', bufferedAmount: 0, send: (data: string) => { if (JSON.parse(data).kind === 'file-want') asked.push(peer); } });
  const transfers = new FileTransfers({ roomId, store: { has: () => false, get: async () => undefined, put: async () => {} },
    referenced: () => ref, channel, peers: () => ['a', 'b'], now: () => now });
  for (const peer of ['a', 'b']) transfers.handle(peer, { kind: 'files', roomId });
  transfers.want(ref);
  expect(asked).toEqual(['a']);
  now += 16_000; transfers.tick();
  expect(asked).toEqual(['a', 'b']); // a stalled: the other holder is asked, not a again
  now += 16_000; transfers.tick();
  expect(asked).toEqual(['a', 'b']); // both stalled: nobody is asked until the retry delay passes
  now += 20_000; transfers.tick();
  expect(asked).toHaveLength(3);
});

