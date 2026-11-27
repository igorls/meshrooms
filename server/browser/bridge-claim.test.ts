import { afterEach, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserAgent, claimBrowser, runBridge, sendBrowser } from '../browser-agent';
import type { Claim } from '../../src/collab';
import { testDirectory } from '../test-directory';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const roomId = crypto.randomUUID(), alex = crypto.randomUUID(), wren = crypto.randomUUID(), otto = crypto.randomUUID();
const members = [{ id: alex, name: 'Alex', role: 'human' }, { id: wren, name: 'Wren', role: 'agent', operatorId: alex }, { id: otto, name: 'Otto', role: 'agent', operatorId: alex }];

/** The room service as Wren's runner sees it: status, and claims settled first come, first served. */
function service(me = wren) {
  const claims = new Map<string, Claim>(), calls: Record<string, unknown>[] = [];
  const state = { mode: 'ok' as 'ok' | 'old' | 'down' | 'full', stop: false, heard: [] as Claim[] };
  const command = async (action: string, payload: Record<string, unknown> = {}) => {
    if (action === 'status') {
      if (state.stop) throw Object.assign(new Error('This room was closed by its host.'), { status: 410 });
      return { memberId: me, ownerId: alex, epoch: 'one', members, devices: [], settings: { floor: 'open' }, ...(state.heard.length ? { claims: state.heard } : {}) };
    }
    if (action !== 'claim') return {};
    calls.push(payload);
    if (state.mode === 'old') throw Object.assign(new Error('Unknown room action.'), { status: 400 });
    if (state.mode === 'down') throw Object.assign(new Error('Unavailable'), { status: 503 });
    if (state.mode === 'full') throw Object.assign(new Error('An agent holds up to 4 unanswered messages at once. Answer or release one first.'), { status: 429 });
    const id = payload.messageId as string, held = claims.get(id);
    if (held && held.memberId !== wren) return { roomId, claim: held };
    if (payload.release) { claims.delete(id); return { roomId, claim: null }; }
    const next: Claim = { messageId: id, memberId: wren, at: 1, until: Date.now() + 600_000, ...(payload.answered || held?.answered ? { answered: true as const } : {}) };
    claims.set(id, next);
    return { roomId, claim: next };
  };
  return { claims, calls, state, command };
}

function setup(texts: string[], me = wren, replies: { from: string; to: number }[] = []) {
  const dir = testDirectory('bridge-claim');
  cleanups.push(dir.cleanup);
  const agent = me === wren ? new BrowserAgent(dir.path, 'https://example.test', roomId)
    : new BrowserAgent(dir.path, 'https://example.test', roomId, { person: { identityFile: join(dir.path, 'person-identity.json') } });
  writeFileSync(join(agent.dir, 'members.json'), JSON.stringify({ memberId: me, ownerId: alex, members, devices: [] }));
  writeFileSync(join(agent.dir, 'settings.json'), JSON.stringify({ floor: 'open' }));
  const ids = texts.map(() => crypto.randomUUID());
  writeFileSync(join(agent.dir, 'messages.json'), JSON.stringify([...texts.map((text, i) => ({
    packet: { body: { kind: 'message', roomId, id: ids[i], deviceId: 'a'.repeat(64), memberId: alex, text, at: Date.now() + i }, signature: 'sig' }, targets: [], receipts: [] })),
    ...replies.map(({ from, to }) => ({ packet: { body: { kind: 'message', roomId, id: crypto.randomUUID(), deviceId: 'c'.repeat(64), memberId: from, text: 'Me!', at: Date.now() + 10, replyTo: ids[to] }, signature: 'sig' }, targets: [], receipts: [] }))]));
  const room = service(me);
  agent.command = room.command as BrowserAgent['command'];
  const logs: string[] = [];
  const bridge = runBridge(agent, line => logs.push(line), { pause: () => Bun.sleep(20) }).catch(error => error);
  const signed = () => agent.messages().filter(m => m.packet.body.memberId === me).map(m => m.packet.body.id);
  const stop = async () => { room.state.stop = true; expect(String(await bridge)).toContain('closed by its host'); };
  return { agent, ids, room, signed, stop, logs };
}

const waitFor = async (done: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!done()) { if (Date.now() > end) throw new Error('timed out'); await Bun.sleep(25); }
};

test('the runner claims a reply to a message that went to every agent before signing it, and drops it when another agent got there first', async () => {
  const { agent, ids: [ask, favicon, named], room, signed, stop } = setup(['Who has the latest logo?', 'And the favicon?', '@Wren the icon']);
  room.claims.set(ask, { messageId: ask, memberId: otto, at: 1, until: Date.now() + 600_000 });
  // This device hasn't heard Otto's claim yet: send queues the reply, and the runner, told by the room service, drops it.
  // Not a failure: exit 0, with who answers, so a channel records it as answered elsewhere.
  const dropped = crypto.randomUUID();
  expect(await sendBrowser(agent, 'Here it is', ask, dropped)).toEqual({ messageId: dropped, status: 'not-sent', reason: 'answered-by-another', answeredBy: 'Otto',
    note: expect.stringContaining('Otto is answering this message') });
  expect(signed()).toEqual([]);
  // Wren gets the next one: claimed, signed, and then marked answered.
  const reply = crypto.randomUUID();
  void sendBrowser(agent, 'Here', favicon, reply).catch(() => undefined);
  await waitFor(() => room.claims.get(favicon)?.answered === true);
  expect(signed()).toEqual([reply]);
  expect(room.calls.filter(c => c.messageId === favicon)).toEqual([{ messageId: favicon }, { messageId: favicon, answered: true }]);
  // A reply to a message that names Wren claims nothing.
  const onIt = crypto.randomUUID();
  void sendBrowser(agent, 'On it', named, onIt).catch(() => undefined);
  await waitFor(() => signed().includes(onIt));
  expect(room.calls.some(c => c.messageId === named)).toBe(false);
  // claim goes through the runner too, so it works where the wake can't reach the room service.
  expect(await claimBrowser(agent, ask)).toMatchObject({ messageId: ask, claimed: false, claimedBy: 'Otto' });
  room.claims.delete(ask);
  expect(await claimBrowser(agent, ask)).toMatchObject({ messageId: ask, claimed: true });
  expect(await claimBrowser(agent, ask, true)).toEqual({ messageId: ask, released: true });
  await stop();
}, 60_000);

test('with a room service from before claims every agent answers as before; with one out of reach the claims last heard decide', async () => {
  const { agent, ids: [ask, other], room, signed, stop } = setup(['Anyone around?', 'Anyone else?']);
  room.state.mode = 'old';
  expect(await claimBrowser(agent, ask)).toMatchObject({ claimed: false, note: expect.stringContaining('does not settle claims yet') });
  const reply = crypto.randomUUID();
  void sendBrowser(agent, 'Here', ask, reply).catch(() => undefined);
  await waitFor(() => signed().includes(reply));
  // Out of reach: a reply a harness queued itself (its sandbox can write the outbox) to a message this device last heard
  // Otto claim is dropped, and one to a message nobody claimed goes.
  room.state.mode = 'down';
  room.state.heard = [{ messageId: other, memberId: otto, at: 1, until: Date.now() + 600_000 }];
  await waitFor(() => JSON.parse(readFileSync(join(agent.dir, 'settings.json'), 'utf8')).claims?.length === 1);
  const blocked = crypto.randomUUID(), free = crypto.randomUUID();
  writeFileSync(join(agent.dir, 'outbox', `${Date.now()}-${blocked}.json`), JSON.stringify({ id: blocked, text: 'Me too', replyTo: other }));
  await waitFor(() => { try { return readFileSync(join(agent.dir, 'outbox', `${blocked}.dropped`), 'utf8').includes('Otto is answering'); } catch { return false; } });
  writeFileSync(join(agent.dir, 'outbox', `${Date.now()}-${free}.json`), JSON.stringify({ id: free, text: 'Again', replyTo: ask }));
  await waitFor(() => signed().includes(free));
  expect(signed()).not.toContain(blocked);
  await stop();
}, 60_000);

test('the runner trusts an answered claim past its time only with the answer in hand, and a full claim list is a refusal', async () => {
  const { agent, ids: [ask, other], room, signed, stop } = setup(['Anyone around?', 'Anyone else?']);
  // Otto marked it answered long ago, but this device holds no reply from Otto: the claim no longer holds, so Wren answers.
  room.claims.set(ask, { messageId: ask, memberId: otto, at: 1, until: Date.now() - 1, answered: true });
  const reply = crypto.randomUUID();
  void sendBrowser(agent, 'Here', ask, reply).catch(() => undefined);
  await waitFor(() => signed().includes(reply));
  // Wren holds as many unanswered messages as it may: its reply to another one waits for it to answer or release one.
  room.state.mode = 'full';
  await expect(sendBrowser(agent, 'Me', other, crypto.randomUUID())).rejects.toThrow('up to 4 unanswered');
  await stop();
}, 60_000);

test('a person answers on an open floor without any claim, and an agent holding a claim answers past another agent\u2019s unclaimed reply', async () => {
  // Alex's own device: people never claim, and their replies don't wait for one.
  const person = setup(['Who has the latest logo?'], alex);
  const mine = crypto.randomUUID();
  writeFileSync(join(person.agent.dir, 'outbox', `${Date.now()}-${mine}.json`), JSON.stringify({ id: mine, text: 'I do', replyTo: person.ids[0] }));
  await waitFor(() => person.signed().includes(mine));
  expect(person.room.calls).toEqual([]);
  await person.stop();

  // Wren holds the claim; Otto (an older bridge) replied anyway. Wren's answer still goes.
  const { agent, ids: [ask], room, signed, stop } = setup(['Anyone around?'], wren, [{ from: otto, to: 0 }]);
  room.claims.set(ask, { messageId: ask, memberId: wren, at: 1, until: Date.now() + 600_000 });
  room.state.heard = [...room.claims.values()];
  await waitFor(() => (JSON.parse(readFileSync(join(agent.dir, 'settings.json'), 'utf8')).claims ?? []).length === 1);
  const reply = crypto.randomUUID();
  void sendBrowser(agent, 'Here', ask, reply).catch(() => undefined);
  await waitFor(() => signed().includes(reply));
  await stop();
}, 60_000);
