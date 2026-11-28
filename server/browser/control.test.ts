import { afterEach, expect, test } from 'bun:test';
import type { WebSocketHandler } from 'bun';
import { BrowserLobby } from './lobby';
import { browserHandler } from './http';
import { CONTROL_MAX_REFUSALS, ControlService, type ControlServiceOptions, type ControlSocketData } from './control';
import { RelayService } from './relay';
import { serviceWebsocket, type ServiceSocketData } from './sockets';
import { CONTROL_ROOM_ID, base64, browserProtocol, controlRoom, deviceId, encode, type Command, type SignedCommand } from '../../src/browser/protocol';
import { decryptRelayEnvelope, encryptRelayEnvelope, exportRawPublicKey, generateEncKeyPair, type RelayEnvelope, type RosterEntry } from '../../src/browser/relay-crypto';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

type Message = Record<string, any>;
/** A device's keys, as a browser or a desktop app has them. */
async function device(origin: string) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = base64(await crypto.subtle.exportKey('raw', keys.publicKey));
  const enc = await generateEncKeyPair(false);
  const sign = async (value: unknown) => base64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, encode(value)));
  const id = await deviceId(publicKey);
  const signed = async (payload: Record<string, unknown>, overrides: Partial<Command> = {}): Promise<SignedCommand> => {
    const command: Command = { protocol: browserProtocol, origin, action: 'control-open', roomId: CONTROL_ROOM_ID, id: crypto.randomUUID(), at: Date.now(), payload, ...overrides };
    return { command, publicKey, signature: await sign(command) };
  };
  return { id, publicKey, sign, signed, encPrivateKey: enc.privateKey, entry: { id, enc: await exportRawPublicKey(enc.publicKey), encVersion: 1 } as RosterEntry };
}
type Device = Awaited<ReturnType<typeof device>>;

async function socket(url: string) {
  const ws = new WebSocket(url);
  const queue: Message[] = [], waiters: ((m: Message) => void)[] = [];
  const closed = new Promise<{ code: number }>(done => ws.addEventListener('close', event => done({ code: event.code })));
  ws.addEventListener('message', event => { const m = JSON.parse(String(event.data)); const w = waiters.shift(); if (w) w(m); else queue.push(m); });
  await new Promise<void>((done, fail) => { ws.addEventListener('open', () => done(), { once: true }); ws.addEventListener('error', () => fail(new Error('open failed')), { once: true }); });
  const next = (ms = 3_000) => new Promise<Message>((done, fail) => {
    if (queue.length) return done(queue.shift()!);
    const timer = setTimeout(() => fail(new Error('Timed out waiting for a message')), ms);
    waiters.push(m => { clearTimeout(timer); done(m); });
  });
  /** The next message of type `t`, skipping others (pings, presence pushes). */
  const until = async (t: string, ms = 3_000) => { for (;;) { const m = await next(ms); if (m.t === t) return m; } };
  /** The next message of type `t` that `match` accepts, skipping the rest. */
  const untilMatch = async (t: string, match: (m: Message) => boolean, ms = 3_000) => { for (;;) { const m = await until(t, ms); if (match(m)) return m; } };
  return { ws, next, until, untilMatch, closed, queue, send: (value: unknown) => ws.send(JSON.stringify(value)) };
}

/**
 * The service as main.ts serves it: the relay and remote control on one server, one handler. Devices are taken as
 * participants when `admit`ted (open does that), besides the lobby's own answer.
 */
async function service(options: { control?: Partial<ControlServiceOptions>; withControl?: boolean } = {}) {
  // The lobby needs the port in its origin, so the server starts first and its handlers are filled in after.
  let handle!: ReturnType<typeof browserHandler>, hub!: WebSocketHandler<ServiceSocketData>;
  const server = Bun.serve<ServiceSocketData>({
    hostname: '127.0.0.1', port: 0,
    fetch: (req, srv) => handle(req, '127.0.0.1', (r, data) => srv.upgrade(r, { data })),
    websocket: { open: ws => hub.open!(ws), message: (ws, m) => hub.message!(ws, m), drain: ws => hub.drain?.(ws), close: (ws, code, reason) => hub.close?.(ws, code, reason) },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const lobby = new BrowserLobby(':memory:', { origin, relayUrl: `ws://127.0.0.1:${server.port}/api/relay/v1`, relayEnabled: true });
  const admitted = new Set<string>();
  const relay = new RelayService({ lobby, heartbeatMs: 60_000 });
  const control = options.withControl === false ? undefined : new ControlService({
    lobby: { verifySignedCommand: (signed, action) => lobby.verifySignedCommand(signed, action), participantDevice: id => admitted.has(id) || lobby.participantDevice(id) },
    heartbeatMs: 60_000, ...options.control,
  });
  hub = serviceWebsocket(relay, control);
  handle = browserHandler(lobby, origin, '.', { relay, control });
  cleanups.push(() => { control?.close(); relay.close(); server.stop(true); lobby.close(); });
  const url = `ws://127.0.0.1:${server.port}/api/control/v1`;
  /** A device's control socket, authenticated, with its links. */
  const open = async (who: Device, links: string[] = []) => {
    admitted.add(who.id);
    const s = await socket(url);
    const challenge = await s.next();
    expect(challenge.t).toBe('challenge');
    s.send({ t: 'auth', signed: await who.signed({ nonce: challenge.nonce }), links });
    const ready = await s.until('ready');
    expect(ready.deviceId).toBe(who.id);
    return { ...s, ready };
  };
  return { server, origin, url, lobby, control, open, admitted };
}

/** An envelope from one device to another in a machine's control domain, as encryptRelayEnvelope makes it. */
const envelope = (from: Device, to: Device, machine: string, packet: unknown = { hello: true }, overrides: Partial<Parameters<typeof encryptRelayEnvelope>[1]> = {}) =>
  encryptRelayEnvelope(packet, { room: controlRoom(machine), from: from.id, id: crypto.randomUUID(), seq: 1, rosterVersion: 1, lane: 'primary', recipients: [to.entry], sign: from.sign, ...overrides });

/** A socket the service can be handed directly: what it sent, how it was closed, and how far behind it is. */
function fakeSocket(control: ControlService, origin: string) {
  const sent: Message[] = [];
  const state = { closedWith: undefined as number | undefined, buffered: 0 };
  const data: ControlSocketData = control.createSocketData('fake', origin);
  // Closing records the code only: Bun tells the handler later, which is what lets a late message reach it first.
  const ws = { data, send: (text: string) => { sent.push(JSON.parse(text)); return 1; }, close: (code: number) => { state.closedWith ??= code; }, ping: () => {}, getBufferedAmount: () => state.buffered } as never;
  const deliver = (value: unknown) => control.websocket.message!(ws, JSON.stringify(value));
  const waitFor = async (t: string) => { for (const end = Date.now() + 3_000; !sent.some(m => m.t === t) && Date.now() < end;) await Bun.sleep(5); return sent.find(m => m.t === t); };
  control.websocket.open!(ws);
  return { ws, data, sent, state, deliver, waitFor };
}

test('a control socket opens with a signed challenge and no room, once per nonce, and never with a room command', async () => {
  const s = await service({ control: { authTimeoutMs: 150 } });
  const machine = await device(s.origin);
  const opened = await s.open(machine);
  expect(opened.ready).toMatchObject({ peers: [], offers: [] });

  const refused = async (signed: (challenge: Message) => Promise<SignedCommand>, links?: unknown) => {
    const t = await socket(s.url);
    const challenge = await t.next();
    t.send({ t: 'auth', signed: await signed(challenge), ...(links === undefined ? {} : { links }) });
    const error = await t.until('error');
    return { ...error, closed: (await t.closed).code };
  };
  // A room's id, a room action, another nonce, an expired clock, someone else's signature: each is refused.
  expect(await refused(c => machine.signed({ nonce: c.nonce }, { roomId: crypto.randomUUID() }))).toMatchObject({ message: expect.stringMatching(/without a room/), closed: 4001 });
  expect(await refused(c => machine.signed({ nonce: c.nonce }, { action: 'relay-open' }))).toMatchObject({ message: expect.stringMatching(/Unexpected command action/), closed: 4001 });
  expect(await refused(() => machine.signed({ nonce: crypto.randomUUID() }))).toMatchObject({ message: expect.stringMatching(/nonce/), closed: 4001 });
  expect(await refused(c => machine.signed({ nonce: c.nonce }, { at: Date.now() - 5 * 60_000 }))).toMatchObject({ code: 'invalid' });
  const other = await device(s.origin);
  expect(await refused(async c => ({ ...await machine.signed({ nonce: c.nonce }), publicKey: other.publicKey }))).toMatchObject({ code: 'auth-failed' });
  // Links that aren't device ids, or more than the cap, or itself.
  expect(await refused(c => machine.signed({ nonce: c.nonce }), ['not a device'])).toMatchObject({ code: 'invalid', message: expect.stringMatching(/at most 64/) });
  expect(await refused(c => machine.signed({ nonce: c.nonce }), [machine.id])).toMatchObject({ code: 'invalid' });
  expect(await refused(c => machine.signed({ nonce: c.nonce }), Array.from({ length: 65 }, (_, i) => i.toString(16).padStart(64, '0')))).toMatchObject({ code: 'invalid' });

  // Two answers to one challenge: the second is refused and the socket closed.
  const twice = await socket(s.url);
  const challenge = await twice.next();
  const answer = await machine.signed({ nonce: challenge.nonce });
  twice.send({ t: 'auth', signed: answer });
  twice.send({ t: 'auth', signed: answer });
  expect(await twice.until('error')).toMatchObject({ code: 'nonce-reused' });
  expect((await twice.closed).code).toBe(4001);
  // Sent while the answer is checked: told to wait, not closed, and then ready.
  const eager = await socket(s.url);
  const nonce = (await eager.next()).nonce;
  eager.send({ t: 'auth', signed: await machine.signed({ nonce }) });
  eager.send({ t: 'peers' });
  expect(await eager.until('error')).toMatchObject({ code: 'not-ready' });
  expect(await eager.until('ready')).toMatchObject({ deviceId: machine.id });
  // Before any answer, nothing else is taken; silent sockets are closed.
  const early = await socket(s.url);
  await early.next();
  early.send({ t: 'peers' });
  expect(await early.until('error')).toMatchObject({ code: 'unauthenticated' });
  expect((await early.closed).code).toBe(4001);
  const silent = await socket(s.url);
  await silent.next();
  expect(await silent.until('error')).toMatchObject({ code: 'auth-timeout' });
  expect((await silent.closed).code).toBe(4001);
});

test('only devices that take part in Meshrooms here may open one, and no room can take the control id', async () => {
  const s = await service();
  const stranger = await device(s.origin);
  const t = await socket(s.url);
  t.send({ t: 'auth', signed: await stranger.signed({ nonce: (await t.next()).nonce }) });
  expect(await t.until('error')).toMatchObject({ code: 'not-a-participant' });
  expect((await t.closed).code).toBe(4003);
  // Once it is admitted in a room (here: the host of one), it may.
  const room = crypto.randomUUID();
  await s.lobby.execute(await stranger.signed({ title: 'Room', name: 'Alex', label: 'Browser' }, { action: 'create', roomId: room }));
  expect(s.lobby.participantDevice(stranger.id)).toBe(true);
  const u = await socket(s.url);
  u.send({ t: 'auth', signed: await stranger.signed({ nonce: (await u.next()).nonce }) });
  expect(await u.until('ready')).toMatchObject({ deviceId: stranger.id });
  // The control id is no room's.
  await expect(s.lobby.execute(await stranger.signed({ title: 'Room', name: 'Alex', label: 'Browser' }, { action: 'create', roomId: CONTROL_ROOM_ID }))).rejects.toMatchObject({ status: 400 });
  await expect(s.lobby.execute(await stranger.signed({ nonce: 'x' }))).rejects.toMatchObject({ status: 400 });
});

test('only two devices that link each other see each other and exchange frames; the service carries them sealed', async () => {
  const s = await service();
  const machine = await device(s.origin), browser = await device(s.origin), stranger = await device(s.origin);
  const m = await s.open(machine, [browser.id]);
  expect(m.ready).toMatchObject({ peers: [], offers: [] });
  const b = await s.open(browser, [machine.id]);
  expect(b.ready).toMatchObject({ peers: [{ device: machine.id, online: true }], offers: [] });
  expect(await m.until('peers')).toMatchObject({ peers: [{ device: browser.id, online: true }], offers: [] });

  // A request from the browser, in the machine's domain, and the reply back in the same domain.
  const request = await envelope(browser, machine, machine.id, { type: 'hello', id: 'r1' });
  b.send({ t: 'frame', envelope: request });
  expect(await b.until('accepted')).toEqual({ t: 'accepted', id: request.id });
  const got = await m.until('frame');
  expect(got.envelope).toEqual(request);
  const opened = await decryptRelayEnvelope(got.envelope as RelayEnvelope, { room: controlRoom(machine.id), selfDeviceId: machine.id, selfEncPrivateKey: machine.encPrivateKey, selfEncVersion: 1, senderSignKey: browser.publicKey, expectedFrom: browser.id });
  expect(opened.packet).toEqual({ type: 'hello', id: 'r1' });
  const reply = await envelope(machine, browser, machine.id, { type: 'hello-reply', id: 'r1' });
  m.send({ t: 'frame', envelope: reply });
  expect(await m.until('accepted')).toEqual({ t: 'accepted', id: reply.id });
  expect((await b.until('frame')).envelope).toEqual(reply);

  // The same links again change nothing, and nobody is told anything.
  b.send({ t: 'links', links: [machine.id] });
  expect(await b.until('peers')).toMatchObject({ peers: [{ device: machine.id, online: true }] });
  m.send({ t: 'ping' });
  expect((await m.next()).t).toBe('pong');

  // A stranger that links the machine is an offer to it, ids only, and learns nothing; its frames don't pass.
  const x = await s.open(stranger, [machine.id]);
  expect(x.ready).toMatchObject({ peers: [], offers: [] });
  expect(await m.until('peers')).toMatchObject({ peers: [{ device: browser.id, online: true }], offers: [stranger.id] });
  x.send({ t: 'frame', envelope: await envelope(stranger, machine, machine.id) });
  expect(await x.until('rejected')).toMatchObject({ reason: 'not-linked' });
  // It stops offering: the machine is told.
  x.send({ t: 'links', links: [] });
  await x.until('peers');
  expect(await m.until('peers')).toMatchObject({ offers: [] });
  // Nor the other way: the machine can't reach a device that doesn't link it back.
  m.send({ t: 'links', links: [browser.id, stranger.id] });
  expect(await m.until('peers')).toMatchObject({ peers: [{ device: browser.id, online: true }], offers: [] });
  m.send({ t: 'frame', envelope: await envelope(machine, stranger, machine.id) });
  expect(await m.until('rejected')).toMatchObject({ reason: 'not-linked' });
});

test('offers come newest first, at most 16', async () => {
  const s = await service();
  const browser = await device(s.origin);
  const b = await s.open(browser);
  const machines: Device[] = [];
  for (let i = 0; i < 18; i++) { const d = await device(s.origin); machines.push(d); await s.open(d, [browser.id]); }
  // The answer to a request comes after every push before it: the last list before the pong is the answer.
  b.send({ t: 'peers' });
  b.send({ t: 'ping' });
  let latest: Message | undefined;
  for (let m = await b.next(); m.t !== 'pong'; m = await b.next()) if (m.t === 'peers') latest = m;
  expect(latest!.offers).toEqual(machines.slice(2).reverse().map(d => d.id));
});

test('a device that goes away is shown offline with when it was last seen, for a while, and frames to it are refused at once', async () => {
  let clock = Date.now();
  const s = await service({ control: { now: () => clock } });
  const machine = await device(s.origin), browser = await device(s.origin), loner = await device(s.origin);
  const m = await s.open(machine, [browser.id]);
  const b = await s.open(browser, [machine.id]);
  await m.until('peers');
  b.ws.close();
  const gone = await m.until('peers');
  expect(gone.peers).toEqual([{ device: browser.id, online: false, lastSeen: clock }]);
  expect(s.control!.remembered).toBe(1);
  m.send({ t: 'frame', envelope: await envelope(machine, browser, machine.id) });
  expect(await m.until('rejected')).toMatchObject({ reason: 'offline' });
  // A device with no peer leaves nothing behind when it goes.
  const l = await s.open(loner, [machine.id]);
  l.ws.close();
  await l.closed;
  await Bun.sleep(50);
  expect(s.control!.remembered).toBe(1);
  // Back again: online, and frames pass.
  const again = await s.open(browser, [machine.id]);
  expect(await m.untilMatch('peers', x => x.peers[0]?.online)).toMatchObject({ peers: [{ device: browser.id, online: true }], offers: [] });
  expect(s.control!.remembered).toBe(0);
  const frame = await envelope(machine, browser, machine.id);
  m.send({ t: 'frame', envelope: frame });
  expect(await m.until('accepted')).toMatchObject({ id: frame.id });
  expect((await again.until('frame')).envelope).toEqual(frame);
  // Gone for longer than a week: no longer shown.
  again.ws.close();
  await m.until('peers');
  clock += 8 * 24 * 3_600_000;
  m.send({ t: 'peers' });
  expect(await m.until('peers')).toMatchObject({ peers: [] });
});

test('a frame names one recipient and a domain of one of the two, carries no wake or hold, is the sender\'s, and passes once', async () => {
  const s = await service();
  const machine = await device(s.origin), browser = await device(s.origin), third = await device(s.origin);
  const m = await s.open(machine, [browser.id, third.id]);
  const b = await s.open(browser, [machine.id]);
  await s.open(third, [machine.id]);
  const reason = async (env: unknown) => { b.send({ t: 'frame', envelope: env }); return (await b.until('rejected')).reason; };
  expect(await reason(await envelope(browser, machine, third.id))).toBe('wrong-room');
  const both = await encryptRelayEnvelope({}, { room: controlRoom(machine.id), from: browser.id, id: crypto.randomUUID(), seq: 1, rosterVersion: 1, lane: 'primary', recipients: [machine.entry, third.entry], sign: browser.sign });
  expect(await reason(both)).toBe('one-recipient');
  expect(await reason(await envelope(browser, machine, machine.id, {}, { wake: [machine.id] }))).toBe('no-inbox');
  expect(await reason(await envelope(browser, machine, machine.id, {}, { hold: true }))).toBe('no-inbox');
  expect(await reason(await envelope(third, machine, machine.id))).toBe('sender-mismatch');
  expect(await reason({ v: 1, id: 'x' })).toBe('invalid-envelope');
  const once = await envelope(browser, machine, machine.id);
  b.send({ t: 'frame', envelope: once });
  await b.until('accepted');
  expect(await reason(once)).toBe('duplicate');
  // Only the accepted one reached the machine.
  expect((await m.until('frame')).envelope.id).toBe(once.id);
  // Links are device ids, at most 64, never the device itself.
  b.send({ t: 'links', links: [browser.id] });
  expect(await b.until('error')).toMatchObject({ code: 'invalid-links' });
  b.send({ t: 'links', links: Array.from({ length: 65 }, (_, i) => i.toString(16).padStart(64, '0')) });
  expect(await b.until('error')).toMatchObject({ code: 'invalid-links' });
  b.send({ t: 'links', links: ['not a device'] });
  expect(await b.until('error')).toMatchObject({ code: 'invalid-links' });
});

test('every message counts against its device\'s rate, a socket that keeps going is closed, and a newer socket replaces the older', async () => {
  const s = await service({ control: { rateMessagesPerMin: 4 } });
  const machine = await device(s.origin), browser = await device(s.origin);
  const m = await s.open(machine, [browser.id]);
  const b = await s.open(browser, [machine.id]);
  for (let i = 0; i < 4; i++) { b.send({ t: 'ping' }); expect((await b.until('pong')).t).toBe('pong'); }
  b.send({ t: 'ping' });
  expect(await b.until('error')).toMatchObject({ code: 'rate-limit' });
  const frame = await envelope(browser, machine, machine.id);
  b.send({ t: 'frame', envelope: frame });
  expect(await b.until('rejected')).toEqual({ t: 'rejected', id: frame.id, reason: 'rate-limit' });

  // The same device again: the old socket is told and closed, the machine still sees it online, and frames reach the new one.
  const b2 = await s.open(browser, [machine.id]);
  expect(await b.until('error')).toMatchObject({ code: 'session-replaced' });
  expect((await b.closed).code).toBe(4009);
  const reply = await envelope(machine, browser, machine.id);
  m.send({ t: 'frame', envelope: reply });
  expect(await m.until('accepted')).toMatchObject({ id: reply.id });
  expect((await b2.until('frame')).envelope).toEqual(reply);
  m.send({ t: 'peers' });
  expect(await m.until('peers')).toMatchObject({ peers: [{ device: browser.id, online: true }] });
  // Past its rate, refusal after refusal: closed.
  for (let i = 0; i <= CONTROL_MAX_REFUSALS + 1; i++) b2.send({ t: 'ping' });
  expect((await b2.closed).code).toBe(4008);
});

test('bytes count too, and one address may hold only so many sockets', async () => {
  const sample = await envelope(await device('http://x'), await device('http://x'), 'a'.repeat(64));
  const frameBytes = Buffer.byteLength(JSON.stringify({ t: 'frame', envelope: sample }));
  const s = await service({ control: { rateBytesPerMin: frameBytes + 200, maxSocketsPerAddress: 3 } });
  const machine = await device(s.origin), browser = await device(s.origin);
  await s.open(machine, [browser.id]);
  const b = await s.open(browser, [machine.id]);
  const first = await envelope(browser, machine, machine.id);
  b.send({ t: 'frame', envelope: first });
  expect(await b.until('accepted')).toMatchObject({ id: first.id });
  const second = await envelope(browser, machine, machine.id);
  b.send({ t: 'frame', envelope: second });
  expect(await b.until('rejected')).toMatchObject({ id: second.id, reason: 'rate-limit' });
  // Two open, the third may still come; the fourth from this address is refused.
  const third = await socket(s.url);
  expect((await third.next()).t).toBe('challenge');
  const fourth = await socket(s.url);
  expect(await fourth.until('error')).toMatchObject({ code: 'too-many-sockets' });
  expect((await fourth.closed).code).toBe(4029);
  // One closes: there is room again.
  third.ws.close();
  await third.closed;
  await Bun.sleep(50);
  const fifth = await socket(s.url);
  expect((await fifth.next()).t).toBe('challenge');
});

test('a replaced socket acts for nobody, and a recipient far behind is sent nothing more', async () => {
  const lobby = new BrowserLobby(':memory:', { origin: 'https://rooms.example', aliases: ['https://alias.example'] });
  cleanups.push(() => lobby.close());
  const control = new ControlService({ lobby: { verifySignedCommand: (signed, action) => lobby.verifySignedCommand(signed, action), participantDevice: () => true }, heartbeatMs: 60_000 });
  const machine = await device('https://rooms.example'), browser = await device('https://rooms.example');
  const authed = async (who: Device, links: string[]) => {
    const f = fakeSocket(control, 'https://rooms.example');
    const challenge = f.sent.find(m => m.t === 'challenge')!;
    f.deliver({ t: 'auth', signed: await who.signed({ nonce: challenge.nonce }), links });
    expect(await f.waitFor('ready')).toMatchObject({ deviceId: who.id });
    return f;
  };
  const m = await authed(machine, [browser.id]);
  const old = await authed(browser, [machine.id]);
  const fresh = await authed(browser, [machine.id]);
  expect(old.state.closedWith).toBe(4009);
  // Its close hasn't arrived yet, and a message reaches it first: nothing changes.
  old.deliver({ t: 'links', links: [] });
  await Bun.sleep(20);
  m.deliver({ t: 'peers' });
  expect(m.sent.filter(x => x.t === 'peers').at(-1)).toMatchObject({ peers: [{ device: browser.id, online: true }] });
  old.deliver({ t: 'frame', envelope: await envelope(browser, machine, machine.id) });
  await Bun.sleep(20);
  expect(old.sent.some(x => x.t === 'accepted')).toBe(false);
  expect(m.sent.some(x => x.t === 'frame')).toBe(false);
  // The fresh one far behind: the machine is told, and nothing is queued for it.
  fresh.state.buffered = 5 * 1024 * 1024;
  const busy = await envelope(machine, browser, machine.id);
  m.deliver({ t: 'frame', envelope: busy });
  await m.waitFor('rejected');
  expect(m.sent.find(x => x.t === 'rejected')).toMatchObject({ id: busy.id, reason: 'recipient-busy' });
  expect(fresh.sent.some(x => x.t === 'frame')).toBe(false);

  // A challenge signed for another of the service's addresses is refused on this one.
  const elsewhere = fakeSocket(control, 'https://rooms.example');
  const other = await device('https://alias.example');
  elsewhere.deliver({ t: 'auth', signed: await other.signed({ nonce: elsewhere.data.nonce }) });
  expect(await elsewhere.waitFor('error')).toMatchObject({ code: 'invalid' });
  expect(elsewhere.state.closedWith).toBe(4001);
});

test('the endpoint is a WebSocket only, health says it is there, and the relay still shares the server', async () => {
  const s = await service();
  const base = s.url.replace('ws://', 'http://');
  expect((await fetch(base)).status).toBe(426);
  expect(await (await fetch(`${s.origin}/api/lobby/health`)).json()).toMatchObject({ relayEnabled: true, controlEnabled: true });
  // A relay socket on the same server still gets its own challenge.
  const relaySocket = await socket(s.url.replace('/api/control/v1', '/api/relay/v1'));
  expect((await relaySocket.next()).t).toBe('challenge');
  relaySocket.ws.close();
  const without = await service({ withControl: false });
  expect((await fetch(without.url.replace('ws://', 'http://'))).status).toBe(404);
  expect(await (await fetch(`${without.origin}/api/lobby/health`)).json()).not.toHaveProperty('controlEnabled');
});

test('a device that stops taking part is closed at the next heartbeat, and its peers see it go', async () => {
  const s = await service({ control: { heartbeatMs: 60 } });
  const machine = await device(s.origin), browser = await device(s.origin);
  const m = await s.open(machine, [browser.id]);
  const b = await s.open(browser, [machine.id]);
  await m.untilMatch('peers', x => x.peers[0]?.online);
  // Still a participant: heartbeats only.
  expect((await b.until('ping')).t).toBe('ping');
  // Retired from its rooms (here: no longer admitted): closed, and the machine is told.
  s.admitted.delete(browser.id);
  expect(await b.until('error')).toMatchObject({ code: 'not-a-participant' });
  expect((await b.closed).code).toBe(4003);
  expect(await m.untilMatch('peers', x => x.peers[0]?.online === false)).toMatchObject({ peers: [{ device: browser.id, online: false }] });
});
