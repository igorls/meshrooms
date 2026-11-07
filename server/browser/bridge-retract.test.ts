import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserAgent, listenSnapshot, outboxProblem, reactBrowser, retractionLog, runBridge, type Stored } from '../browser-agent';
import { queueRetract } from '../person';
import { attachmentRef, type AttachmentRef } from '../../src/browser/files';
import { retractedStub, type RetractPacket } from '../../src/browser/retractions';
import { testDirectory } from '../test-directory';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const roomId = crypto.randomUUID(), alex = crypto.randomUUID(), robin = crypto.randomUUID(), wren = crypto.randomUUID();
const people = [{ id: alex, name: 'Alex', role: 'human' }, { id: robin, name: 'Robin', role: 'human' }, { id: wren, name: 'Wren', role: 'agent' }];

function folder(memberId: string = robin) {
  const dir = testDirectory('bridge-retract');
  cleanups.push(dir.cleanup);
  const agent = new BrowserAgent(dir.path, 'https://example.test', roomId);
  writeFileSync(join(agent.dir, 'members.json'), JSON.stringify({ memberId, members: people, devices: [] }));
  return agent;
}
/** Another device, with a real key, for signing retractions the agent under test receives. */
async function device(memberId: string) {
  const agent = folder(memberId), { id, publicKey } = await agent.ensureIdentity();
  const sign = async (target: string, as = memberId): Promise<RetractPacket> => {
    const body = { kind: 'retract' as const, roomId, id: crypto.randomUUID(), deviceId: id, memberId: as, at: Date.now(), target };
    return { body, signature: await agent.sign(body) };
  };
  return { sign, entry: { id, publicKey, memberId } };
}
const note = (memberId: string, text: string, more: { attachments?: AttachmentRef[]; replyTo?: string } = {}, deviceId = 'a'.repeat(64)): Stored => ({
  packet: { body: { kind: 'message', roomId, id: crypto.randomUUID(), deviceId, memberId, text, at: Date.now(), ...more }, signature: 'sig' }, targets: ['b'.repeat(64)], receipts: [] });
const write = (agent: BrowserAgent, messages: Stored[]) => writeFileSync(join(agent.dir, 'messages.json'), JSON.stringify(messages));
const onDisk = (agent: BrowserAgent) => readFileSync(join(agent.dir, 'messages.json'), 'utf8');

/** The log with `status` as the room service gave it, saving like the runner and remembering what it let go. */
function log(agent: BrowserAgent, devices: unknown[], former: unknown[] = []) {
  const released: string[] = [];
  const retractions = retractionLog(agent, () => ({ devices, formerDevices: former }) as never, messages => write(agent, messages), shas => released.push(...shas));
  return { retractions, released };
}

test('a retraction its author signed replaces the message in place and lets go of its files', async () => {
  const agent = folder(), author = await device(alex), sha = 'f'.repeat(64);
  const ref = { id: 'x', name: 'x.png', type: 'image/png', size: 1, sha256: sha } as AttachmentRef;
  const kept = note(wren, 'stays'), gone = note(alex, 'the secret', { attachments: [ref] }), after = note(wren, 'also stays');
  write(agent, [kept, gone, after]);
  const { retractions, released } = log(agent, [author.entry]);
  await retractions.accept([await author.sign(gone.packet.body.id)]);
  expect(agent.messages().map(m => m.packet.body.id)).toEqual([kept, gone, after].map(m => m.packet.body.id));
  expect(agent.messages()[1]).toMatchObject({ retracted: true, targets: [], receipts: [], packet: { signature: '', body: { text: '', memberId: alex } } });
  expect(onDisk(agent)).not.toContain('the secret');
  expect(onDisk(agent)).not.toContain(sha);
  expect(released).toEqual([sha]);
  expect(agent.attachment(sha)).toBeUndefined();
  expect(agent.retractOps()).toHaveLength(1);
});

test('only a real signature from a device of the message’s author counts', async () => {
  const agent = folder(), author = await device(alex), other = await device(wren), target = note(alex, 'the secret');
  write(agent, [target]);
  const { retractions } = log(agent, [author.entry, other.entry]), id = target.packet.body.id;
  // Someone else's own retraction, one claiming to be the author from the wrong device, and an altered one.
  await retractions.accept([await other.sign(id)]);
  await retractions.accept([await other.sign(id, alex)]);
  const real = await author.sign(id);
  await retractions.accept([{ ...real, body: { ...real.body, target: crypto.randomUUID() } }]);
  await retractions.accept([{ ...real, signature: 'nope' }, { body: { kind: 'retract' }, signature: 'x' }, null]);
  // From a device the room doesn't know.
  await log(agent, []).retractions.accept([real]);
  expect(onDisk(agent)).toContain('the secret');
  expect(agent.retractOps()).toEqual([]);
});

test('a device its author has since removed can still have signed one', async () => {
  const agent = folder(), author = await device(alex), target = note(alex, 'the secret');
  write(agent, [target]);
  await log(agent, [], [author.entry]).retractions.accept([await author.sign(target.packet.body.id)]);
  expect(onDisk(agent)).not.toContain('the secret');
});

test('a message that arrives after its retraction never reaches the disk with its content', async () => {
  const agent = folder(), author = await device(alex), late = note(alex, 'the secret'), unrelated = note(alex, 'keep me');
  const { retractions } = log(agent, [author.entry]);
  await retractions.accept([await author.sign(late.packet.body.id)]);
  expect(agent.retractOps()).toHaveLength(1);
  expect(retractions.arriving(late)).toMatchObject({ retracted: true, packet: { body: { text: '' } } });
  expect(retractions.arriving(unrelated)).toBe(unrelated);
  // Parked by someone who isn't its author, the message arrives whole.
  const other = await device(wren), target = note(alex, 'keep me too');
  const second = log(agent, [author.entry, other.entry]).retractions;
  await second.accept([await other.sign(target.packet.body.id)]);
  expect(second.arriving(target)).toBe(target);
});

test('a log saved by a pass that couldn’t save the messages takes effect the next time', async () => {
  const agent = folder(), author = await device(alex), target = note(alex, 'the secret');
  write(agent, [target]);
  let full = true;
  const retractions = retractionLog(agent, () => ({ devices: [author.entry] }) as never, messages => {
    if (full) throw new Error('ENOSPC: no space left on device');
    write(agent, messages);
  }, () => {});
  const op = await author.sign(target.packet.body.id);
  await expect(retractions.accept([op])).rejects.toThrow('ENOSPC');
  expect(agent.retractOps()).toHaveLength(1);
  full = false;
  // The same retraction again, already in the log: nothing is added, and the messages still change.
  await retractions.accept([op]);
  expect(onDisk(agent)).not.toContain('the secret');
});

test('the runner signs a person’s deletion, removes the file, and only their own', async () => {
  const agent = folder() as BrowserAgent & { command: unknown }, { id: self, publicKey } = await agent.ensureIdentity();
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]), sha = agent.files.add(bytes), ref = await attachmentRef(bytes, 'secret.png');
  const mine = note(robin, 'the secret', { attachments: [ref] }, self), theirs = note(alex, 'not yours');
  write(agent, [mine, theirs]);
  writeFileSync(join(agent.dir, 'wants', sha), '');
  let stop = false;
  agent.command = async (action: string) => {
    if (action !== 'status') return {};
    if (stop) throw Object.assign(new Error('This room was closed by its host.'), { status: 410 });
    return { memberId: robin, ownerId: alex, epoch: 'one', members: people, devices: [], settings: { floor: 'humans-first' } };
  };
  const bridge = runBridge(agent, () => {}, { pause: () => Bun.sleep(20) }).catch(error => error);
  const requestId = crypto.randomUUID();
  expect(await queueRetract(agent, { requestId, messageId: mine.packet.body.id })).toEqual({ messageId: mine.packet.body.id, status: 'shared' });
  expect(onDisk(agent)).not.toContain('the secret');
  expect(onDisk(agent)).not.toContain(sha);
  expect(existsSync(agent.files.path(sha))).toBe(false);
  expect(existsSync(join(agent.dir, 'wants', sha))).toBe(false);
  const [op] = agent.retractOps();
  expect(op!.body).toMatchObject({ kind: 'retract', id: requestId, deviceId: self, memberId: robin, target: mine.packet.body.id });
  expect(await agent.verify(publicKey, op!.body, op!.signature)).toBe(true);
  // Asked again, nothing more is signed.
  expect((await queueRetract(agent, { messageId: mine.packet.body.id })).status).toBe('shared');
  expect(agent.retractOps()).toHaveLength(1);
  // The page is refused; something that wrote the outbox directly is dropped by the runner too.
  await expect(queueRetract(agent, { messageId: theirs.packet.body.id })).rejects.toMatchObject({ status: 403 });
  await expect(queueRetract(agent, { messageId: crypto.randomUUID() })).rejects.toMatchObject({ status: 404 });
  const planted = crypto.randomUUID();
  writeFileSync(join(agent.dir, 'outbox', `${Date.now()}-${planted}.json`), JSON.stringify({ type: 'retract', id: planted, messageId: theirs.packet.body.id }));
  for (let i = 0; i < 100 && readdirSync(join(agent.dir, 'outbox')).length; i++) await Bun.sleep(20);
  expect(readdirSync(join(agent.dir, 'outbox'))).toEqual([]);
  expect(onDisk(agent)).toContain('not yours');
  stop = true;
  expect(String(await bridge)).toContain('closed by its host');
}, 30_000);

test('a runner finishes a deletion the last one saved but didn’t apply', async () => {
  const agent = folder() as BrowserAgent & { command: unknown }, author = await device(alex), target = note(alex, 'the secret');
  write(agent, [target]);
  writeFileSync(join(agent.dir, 'retractions.json'), JSON.stringify([await author.sign(target.packet.body.id)]));
  agent.command = async () => { throw Object.assign(new Error('This room was closed by its host.'), { status: 410 }); };
  await runBridge(agent, () => {}).catch(error => error);
  expect(onDisk(agent)).not.toContain('the secret');
});

test('an outbox item is checked before it is signed', () => {
  const agent = folder(), mine = note(robin, 'mine'), theirs = note(alex, 'theirs');
  write(agent, [mine, theirs]);
  const item = (messageId: string) => ({ type: 'retract', id: crypto.randomUUID(), messageId });
  expect(outboxProblem(agent, robin, item(mine.packet.body.id))).toBeUndefined();
  expect(outboxProblem(agent, robin, item(theirs.packet.body.id))).toContain('only its author');
  expect(outboxProblem(agent, robin, item('x'))).toContain('message id');
});

test('agents read a deleted message as deleted, it wakes nobody, and their cursor on it still holds', () => {
  const agent = folder(wren);
  writeFileSync(join(agent.dir, 'settings.json'), JSON.stringify({ floor: 'open' }));
  const first = note(alex, 'hello @Wren'), own = note(wren, 'from the agent'), plain = note(alex, 'a plain message'), reply = note(alex, 'a reply', { replyTo: own.packet.body.id }), mention = note(alex, '@Wren look');
  const stubbed = [first, own, ...[plain, reply, mention].map(m => retractedStub(m))];
  write(agent, stubbed);
  const snapshot = listenSnapshot(agent, { after: first.packet.body.id, history: false }, false)!;
  expect(snapshot.result).toMatchObject({ state: 'waiting', addressed: [] });
  expect(snapshot.view.messages.at(-1)).toMatchObject({ text: 'Message deleted', deleted: true });
  expect(snapshot.view.messages.at(-1)).not.toHaveProperty('mentions');
  expect(JSON.stringify(snapshot.view.messages)).not.toContain('look');
  // The saved cursor was the message that was then deleted.
  expect(listenSnapshot(agent, { after: mention.packet.body.id, history: false }, false)!.result.state).toBe('waiting');
});

test('a deleted message takes no reactions, and those it had stop counting', async () => {
  const agent = folder(), gone = retractedStub(note(alex, 'the secret'));
  write(agent, [gone]);
  await expect(reactBrowser(agent, { requestId: crypto.randomUUID(), messageId: gone.packet.body.id, emoji: '👍' })).rejects.toThrow('not in this browser room');
  const reaction = (messageId: string) => ({ body: { kind: 'reaction', roomId, id: crypto.randomUUID(), deviceId: 'a'.repeat(64), memberId: robin, messageId, emoji: '👍', revision: 1, at: 1 }, signature: 'x' });
  const held = note(alex, 'still here');
  write(agent, [gone, held]);
  writeFileSync(join(agent.dir, 'reactions.json'), JSON.stringify([reaction(gone.packet.body.id), reaction(held.packet.body.id)]));
  expect(agent.countedReactions().map(op => op.messageId)).toEqual([held.packet.body.id]);
});
