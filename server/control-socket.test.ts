import { afterEach, expect, test } from 'bun:test';
import type { WebSocketHandler } from 'bun';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserLobby } from './browser/lobby';
import { browserHandler } from './browser/http';
import { ControlService } from './browser/control';
import { serviceWebsocket, type ServiceSocketData } from './browser/sockets';
import { MachineControl } from './control-socket';
import { CONTROLLERS_FILE, POLICY_FILE, readControllers, readPolicy, removeController, type TurnResult } from './remote-control';
import { PERSON_IDENTITY } from './person';
import { testDirectory } from './test-directory';
import {
  CONTROL_SINGLE_BYTES, ControlClient, ControlSendError, controlLink, controlWords, enrolMac, openEnrolled, type ControlKeys, type ControlSelf, type EnrolledMachine,
} from '../src/browser/control-client';
import { base64, controlRoom, deviceId, encode } from '../src/browser/protocol';
import { encodeSecret, newSecret } from '../src/browser/pairing';
import { encryptRelayEnvelope, exportRawPublicKey, generateEncKeyPair, signEncBinding, type RelayEnvelope, type RosterEntry } from '../src/browser/relay-crypto';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const until = async (check: () => boolean, ms = 5_000) => { for (const end = Date.now() + ms; !check() && Date.now() < end;) await Bun.sleep(10); return check(); };
const fast = { minMs: 20, maxMs: 100, refusedMs: 100 };

/** A device's keys: signing, and encryption bound to it for every room. `jwk` for the machine's identity.json. */
async function keys() {
  const sign = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const enc = await generateEncKeyPair(true);
  const publicKey = base64(await crypto.subtle.exportKey('raw', sign.publicKey)), id = await deviceId(publicKey);
  const signWith = async (value: unknown) => base64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, sign.privateKey, encode(value)));
  const encPublicKey = await exportRawPublicKey(enc.publicKey);
  const encSig = await signEncBinding(signWith, { room: '*', deviceId: id, enc: encPublicKey, encVersion: 1 });
  const self: ControlSelf = { id, publicKey, sign: signWith, encPrivateKey: enc.privateKey, encVersion: 1 };
  return { id, publicKey, encPublicKey, encSig, self, entry: { device: id, sign: publicKey, enc: encPublicKey, encVersion: 1 } satisfies ControlKeys,
    identityJson: async () => JSON.stringify({ id, publicKey, privateJwk: await crypto.subtle.exportKey('jwk', sign.privateKey), encPublicKey,
      encPrivateJwk: await crypto.subtle.exportKey('jwk', enc.privateKey), encVersion: 1, encSig }) };
}
type Keys = Awaited<ReturnType<typeof keys>>;

/** The control service on a real server, with `admitted` standing in for room admission. */
async function service() {
  let handle!: ReturnType<typeof browserHandler>, hub!: WebSocketHandler<ServiceSocketData>;
  const server = Bun.serve<ServiceSocketData>({
    hostname: '127.0.0.1', port: 0,
    fetch: (req, srv) => handle(req, '127.0.0.1', (r, data) => srv.upgrade(r, { data })),
    websocket: { open: ws => hub.open!(ws), message: (ws, m) => hub.message!(ws, m), close: (ws, code, reason) => hub.close?.(ws, code, reason) },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const lobby = new BrowserLobby(':memory:', { origin });
  const admitted = new Set<string>();
  const control = new ControlService({ lobby: { verifySignedCommand: (s, a) => lobby.verifySignedCommand(s, a), participantDevice: id => admitted.has(id) }, heartbeatMs: 60_000 });
  hub = serviceWebsocket(undefined, control);
  handle = browserHandler(lobby, origin, '.', { control });
  cleanups.push(() => { control.close(); server.stop(true); lobby.close(); });
  return { origin, url: `ws://127.0.0.1:${server.port}/api/control/v1`, admitted, control };
}

/** A machine: its person folder with an identity, and its control socket with a fake turn runner and listing. */
async function machine(origin: string, admitted: Set<string>, options: { runTurn?: (input: any, deps: any) => Promise<TurnResult>; turns?: any; pollMs?: number } = {}) {
  const dir = testDirectory('control-socket'); cleanups.push(dir.cleanup);
  const home = join(dir.path, 'person'); mkdirSync(home, { recursive: true });
  const me = await keys();
  writeFileSync(join(home, PERSON_IDENTITY), await me.identityJson());
  admitted.add(me.id);
  const logs: string[] = [], turns: unknown[] = [];
  const runTurn = options.runTurn ?? (async (input: any, deps: any): Promise<TurnResult> => {
    turns.push(input);
    deps.onRunning?.('11111111-1111-4111-8111-111111111111');
    return { state: 'done', turnId: '11111111-1111-4111-8111-111111111111', sessionId: input.sessionId, reply: `Echo: ${input.text}`, truncated: false };
  });
  const make = () => new MachineControl({
    home, log: line => logs.push(line), backoff: fast, pollMs: options.pollMs ?? 50, machine: { name: 'Synthetic machine', platform: 'test' },
    scan: async () => [{ harness: 'claude', label: 'Claude Code', detected: true, sessionsAvailable: true }],
    remote: { home, locks: join(dir.path, 'locks'), machine: {} as never, scanner: { sessions: async harness => ({ harness, sessionsAvailable: true, sessions: [{ id: 's1', title: 'Synthetic session', folder: 'project', lastActiveAt: null }], truncated: false }) } },
    runTurn, ...(options.turns ? { turns: options.turns } : {}),
  });
  const m = { home, me, control: make(), logs, turns,
    /** The daemon starting again: a new socket on the same person folder. */
    restart: async () => { m.control.stop(); m.control = make(); cleanups.push(() => m.control.stop()); await m.control.start(); } };
  cleanups.push(() => m.control.stop());
  await m.control.start();
  return m;
}

/**
 * A browser as the web app will be: its control client, linking the machines it knows and, while it enrols, every
 * machine offered to it; a frame from an unknown machine is opened as an enrolment answer.
 */
async function browser(origin: string, url: string, admitted: Set<string>) {
  const me = await keys();
  admitted.add(me.id);
  const machines = new Map<string, EnrolledMachine>(), replies: any[] = [];
  let enrolling: Uint8Array | undefined, offered: string[] = [];
  const client = new ControlClient({
    url, origin, self: me.self, backoff: fast,
    links: () => [...new Set([...machines.keys(), ...(enrolling ? offered : [])])],
    keysOf: device => { const m = machines.get(device); return m && { device: m.device, sign: m.sign, enc: m.enc, encVersion: m.encVersion }; },
    domain: peer => controlRoom(peer),
    onPacket: (_from, packet) => replies.push(packet),
    onPeers: (_peers, offers) => { if (enrolling && offers.some(o => !offered.includes(o))) { offered = [...new Set([...offered, ...offers])]; client.relink(); } },
    onUnknown: envelope => { if (enrolling) void openEnrolled(envelope, me.self, enrolling).then(m => { machines.set(m.device, m); enrolling = undefined; offered = []; client.relink(); }).catch(() => {}); },
  });
  cleanups.push(() => client.stop());
  client.start();
  await until(() => client.state === 'ready');
  /** The fields of this browser's enrolment link, its secret, and the words it shows. */
  const startEnrolment = async () => {
    enrolling = newSecret();
    const fields = { origin, name: 'Laptop browser', device: me.id, sign: me.publicKey, enc: me.encPublicKey, encVersion: 1, encSig: me.encSig, secret: enrolling };
    return { fields, link: controlLink(fields), words: await controlWords(enrolling, fields), secret: encodeSecret(enrolling) };
  };
  const request = async (to: string, body: Record<string, unknown>, at = Date.now(), expiresAt = at + 60_000, id: string = crypto.randomUUID()) => {
    await client.send(to, { v: 1, t: 'request', id, at, expiresAt, ...body });
    return id;
  };
  const replyTo = async (id: string, done = (r: any) => true) => { expect(await until(() => replies.some(r => r.id === id && done(r)))).toBe(true); return replies.filter(r => r.id === id); };
  return { me, client, machines, replies, startEnrolment, request, replyTo };
}

async function enrolled(trusted = true, options: Parameters<typeof machine>[2] = {}) {
  const s = await service();
  const m = await machine(s.origin, s.admitted, options);
  const b = await browser(s.origin, s.url, s.admitted);
  const { fields, words, secret } = await b.startEnrolment();
  await m.control.enrol({ ...fields, secret, words, trusted });
  expect(await until(() => b.machines.has(m.me.id))).toBe(true);
  return { s, m, b };
}

test('enrolment: the person types the browser\'s words, the machine answers with its keys under the link\'s secret, and the two then talk', async () => {
  const s = await service();
  const m = await machine(s.origin, s.admitted);
  // No controller yet: the machine isn't on the service.
  expect(m.control.status()).toMatchObject({ device: m.me.id, connections: [], enrolling: 0 });
  const b = await browser(s.origin, s.url, s.admitted);
  const { fields, link, words, secret } = await b.startEnrolment();
  expect(link).toStartWith('meshrooms://control?v=1&');
  expect(words.split(' ')).toHaveLength(5);
  // Other words, or none, add nothing.
  await expect(m.control.enrol({ ...fields, secret, words: 'not the words' })).rejects.toMatchObject({ status: 400 });
  await expect(m.control.enrol({ ...fields, secret: 'short', words })).rejects.toMatchObject({ status: 400 });
  expect(readControllers(m.home)).toEqual([]);
  // Typed with other case and spacing, as a person might.
  const answer = await m.control.enrol({ ...fields, secret, words: `  ${words.toUpperCase().replace(/ /g, ',  ')} `, trusted: true }) as any;
  expect(answer).toMatchObject({ controller: { device: b.me.id, name: 'Laptop browser', origin: s.origin }, machine: { device: m.me.id } });
  expect(readPolicy(m.home).trusted).toEqual([b.me.id]);
  expect(await until(() => b.machines.has(m.me.id))).toBe(true);
  expect(b.machines.get(m.me.id)).toMatchObject({ device: m.me.id, sign: m.me.publicKey, enc: m.me.encPublicKey, name: 'Synthetic machine', platform: 'test' });
  // The first request ends the enrolment, and its answer comes back.
  const id = await b.request(m.me.id, { op: 'hello' });
  const [hello] = await b.replyTo(id);
  expect(hello).toMatchObject({ t: 'reply', ok: true, machine: { name: 'Synthetic machine' }, harnesses: [{ harness: 'claude', detected: true }], capabilities: ['sessions', 'prompt', 'cancel'],
    policy: { enabled: false, harnesses: [] }, trusted: true });
  expect(m.control.status()).toMatchObject({ connections: [{ origin: s.origin, state: 'ready', peers: [{ device: b.me.id, online: true }] }], enrolling: 0 });
});

test('a browser trusts an enrolment answer only from the machine whose key signed it and that holds the link\'s secret', async () => {
  const b = await keys(), machineKeys = await keys(), stranger = await keys();
  const secret = newSecret();
  const machineInfo = { device: machineKeys.id, sign: machineKeys.publicKey, enc: machineKeys.encPublicKey, encVersion: 1, encSig: machineKeys.encSig, name: 'Machine', platform: 'test' };
  const seal = (from: Keys, packet: unknown) => encryptRelayEnvelope(packet, { room: controlRoom(from.id), from: from.id, id: crypto.randomUUID(), seq: 1, rosterVersion: 1, lane: 'primary',
    recipients: [{ id: b.id, enc: b.encPublicKey, encVersion: 1 } as RosterEntry], sign: from.self.sign });
  const good = await seal(machineKeys, { v: 1, t: 'enrolled', machine: machineInfo, mac: await enrolMac(secret, b.id, machineInfo) });
  expect(await openEnrolled(good, b.self, secret)).toMatchObject({ device: machineKeys.id, name: 'Machine' });
  // Another secret, a MAC for another browser, a stranger claiming the machine's keys, keys that aren't its own.
  await expect(openEnrolled(good, b.self, newSecret())).rejects.toThrow(/secret/);
  await expect(openEnrolled(await seal(machineKeys, { v: 1, t: 'enrolled', machine: machineInfo, mac: await enrolMac(secret, stranger.id, machineInfo) }), b.self, secret)).rejects.toThrow(/secret/);
  await expect(openEnrolled(await seal(stranger, { v: 1, t: 'enrolled', machine: machineInfo, mac: await enrolMac(secret, b.id, machineInfo) }), b.self, secret)).rejects.toThrow(/signature/);
  const theirs = { ...machineInfo, device: stranger.id, sign: stranger.publicKey };
  await expect(openEnrolled(await seal(stranger, { v: 1, t: 'enrolled', machine: theirs, mac: await enrolMac(secret, b.id, theirs) }), b.self, secret)).rejects.toThrow(/bound/);
  // A tampered envelope.
  await expect(openEnrolled({ ...good, ct: good.ct.slice(0, -4) + 'AAAA' } as RelayEnvelope, b.self, secret)).rejects.toThrow(/authentication or decryption failed/);
});

test('requests: sessions and prompts only while remote control is on, running then the result, and a cancel only of the browser\'s own turns', async () => {
  const { m, b } = await enrolled();
  const sessions = async () => (await b.replyTo(await b.request(m.me.id, { op: 'sessions', harness: 'claude' })))[0];
  expect(await sessions()).toMatchObject({ ok: false, code: 'disabled' });
  writeFileSync(join(m.home, POLICY_FILE), JSON.stringify({ enabled: true, harnesses: ['claude'], trusted: [b.me.id] }));
  expect(await sessions()).toMatchObject({ ok: true, harness: 'claude', sessions: [{ id: 's1', title: 'Synthetic session' }], truncated: false });
  expect((await b.replyTo(await b.request(m.me.id, { op: 'sessions', harness: 'codex' })))[0]).toMatchObject({ ok: false, code: 'not-allowed' });
  const prompt = await b.request(m.me.id, { op: 'prompt', harness: 'claude', sessionId: 's1', text: 'Synthetic prompt' });
  const answers = await b.replyTo(prompt, r => r.state === 'done');
  expect(answers.map(r => r.state)).toEqual(['running', 'done']);
  expect(answers[1]).toMatchObject({ reply: 'Echo: Synthetic prompt', sessionId: 's1' });
  expect(m.turns).toEqual([{ requestId: prompt, controller: b.me.id, harness: 'claude', sessionId: 's1', text: 'Synthetic prompt' }]);
  expect((await b.replyTo(await b.request(m.me.id, { op: 'cancel', turnId: '22222222-2222-4222-8222-222222222222' })))[0]).toMatchObject({ ok: true, cancelled: false });
  expect((await b.replyTo(await b.request(m.me.id, { op: 'launch-missiles' })))[0]).toMatchObject({ ok: false, code: 'unsupported' });
});

test('a request runs once, only within its time, and a browser the person didn\'t trust is told so before any prompt runs', async () => {
  const { m, b } = await enrolled(false);
  writeFileSync(join(m.home, POLICY_FILE), JSON.stringify({ enabled: true, harnesses: ['claude'], trusted: [] }));
  const untrusted = (await b.replyTo(await b.request(m.me.id, { op: 'prompt', harness: 'claude', sessionId: 's1', text: 'x' })))[0];
  expect(untrusted).toMatchObject({ state: 'failed', code: 'not-allowed', message: expect.stringMatching(/trusted/) });
  expect(m.turns).toEqual([]);
  writeFileSync(join(m.home, POLICY_FILE), JSON.stringify({ enabled: true, harnesses: ['claude'], trusted: [b.me.id] }));
  const now = Date.now();
  expect((await b.replyTo(await b.request(m.me.id, { op: 'hello' }, now - 10_000, now - 5_000)))[0]).toMatchObject({ ok: false, code: 'expired' });
  expect((await b.replyTo(await b.request(m.me.id, { op: 'hello' }, now + 5 * 60_000, now + 5 * 60_000 + 1_000)))[0]).toMatchObject({ ok: false, code: 'invalid' });
  expect((await b.replyTo(await b.request(m.me.id, { op: 'hello' }, now, now + 10 * 60_000)))[0]).toMatchObject({ ok: false, code: 'invalid' });
  // The same request id twice (in two envelopes): it runs once, and is answered once.
  const id = crypto.randomUUID();
  await b.request(m.me.id, { op: 'prompt', harness: 'claude', sessionId: 's1', text: 'once' }, now, now + 60_000, id);
  await b.request(m.me.id, { op: 'prompt', harness: 'claude', sessionId: 's1', text: 'once' }, now, now + 60_000, id);
  await b.replyTo(id, r => r.state === 'done');
  await Bun.sleep(150);
  expect(m.turns).toHaveLength(1);
  expect(b.replies.filter(r => r.id === id && r.state === 'done')).toHaveLength(1);
});

test('a long reply travels in parts and arrives whole; malformed parts are dropped', async () => {
  const long = 'Lorem ipsum dolor sit amet, "quoted" and\nnew lines. '.repeat(4_000);
  const s = await service();
  const m = await machine(s.origin, s.admitted, { runTurn: async (input: any) => ({ state: 'done', turnId: crypto.randomUUID(), sessionId: input.sessionId, reply: long, truncated: false }) });
  const b = await browser(s.origin, s.url, s.admitted);
  const { fields, words, secret } = await b.startEnrolment();
  await m.control.enrol({ ...fields, secret, words, trusted: true });
  expect(await until(() => b.machines.has(m.me.id))).toBe(true);
  writeFileSync(join(m.home, POLICY_FILE), JSON.stringify({ enabled: true, harnesses: ['claude'], trusted: [b.me.id] }));
  expect(JSON.stringify({ reply: long }).length).toBeGreaterThan(10 * CONTROL_SINGLE_BYTES);
  const [answer] = await b.replyTo(await b.request(m.me.id, { op: 'prompt', harness: 'claude', sessionId: 's1', text: 'long' }), r => r.state === 'done');
  expect(answer.reply).toBe(long);

  // Two plain clients: parts that don't add up are dropped, never delivered.
  const x = await keys(), y = await keys();
  s.admitted.add(x.id); s.admitted.add(y.id);
  const drops: string[] = [], got: unknown[] = [];
  const make = (me: Keys, other: Keys, sink?: { drops: string[]; got: unknown[] }) => {
    const c = new ControlClient({ url: s.url, origin: s.origin, self: me.self, backoff: fast, links: () => [other.id], keysOf: d => d === other.id ? other.entry : undefined,
      domain: () => controlRoom(y.id), onPacket: (_f, p) => sink?.got.push(p), onDrop: why => sink?.drops.push(why) });
    cleanups.push(() => c.stop()); c.start(); return c;
  };
  const sender = make(x, y), receiver = make(y, x, { drops, got });
  await until(() => sender.state === 'ready' && receiver.state === 'ready' && sender.peers.peers.some(p => p.online));
  const msg = crypto.randomUUID();
  await sender.send(y.id, { v: 1, t: 'part', msg, i: 0, n: 1, data: 'AAAA' });
  await sender.send(y.id, { v: 1, t: 'part', msg, i: 5, n: 2, data: 'AAAA' });
  await sender.send(y.id, { v: 1, t: 'part', msg, i: 0, n: 500, data: 'AAAA' });
  await sender.send(y.id, { v: 1, t: 'part', msg: 'not-a-uuid', i: 0, n: 2, data: 'AAAA' });
  await sender.send(y.id, { v: 1, t: 'part', msg, i: 0, n: 2, data: btoa('{"t":"pa') });
  await sender.send(y.id, { v: 1, t: 'part', msg, i: 1, n: 2, data: btoa('rt"}') });
  expect(await until(() => drops.length >= 5)).toBe(true);
  expect(drops.every(d => d === 'bad-part')).toBe(true);
  // At most four packets half sent at once from one sender.
  for (let k = 0; k < 5; k++) await sender.send(y.id, { v: 1, t: 'part', msg: crypto.randomUUID(), i: 0, n: 2, data: 'AAAA' });
  expect(await until(() => drops.includes('too-many-partial'))).toBe(true);
  expect(got).toEqual([]);
  // Too large for anyone to send.
  await expect(sender.send(y.id, { text: 'x'.repeat(800 * 1024) })).rejects.toBeInstanceOf(ControlSendError);
});

test('a controller removed on the machine is unlinked, and with none left the machine leaves the service', async () => {
  const { s, m, b } = await enrolled();
  expect((await b.replyTo(await b.request(m.me.id, { op: 'hello' })))[0]).toMatchObject({ ok: true });
  removeController(m.home, b.me.id);
  // The browser no longer reaches it.
  expect(await until(() => m.control.status().connections.length === 0)).toBe(true);
  await expect(b.request(m.me.id, { op: 'hello' })).rejects.toMatchObject({ reason: expect.stringMatching(/not-linked|offline/) });
  expect(readControllers(m.home)).toEqual([]);
  // A machine that isn't a participant is refused by the service, and keeps trying later.
  const lone = await machine(s.origin, s.admitted);
  s.admitted.delete(lone.me.id);
  const other = await keys();
  writeFileSync(join(lone.home, CONTROLLERS_FILE), JSON.stringify({ version: 1, controllers: [{ device: other.id, sign: other.publicKey, enc: other.encPublicKey, encVersion: 1, encSig: other.encSig, name: 'Browser', origin: s.origin, addedAt: 1 }] }));
  expect(await until(() => lone.logs.some(line => /closed \(4003\)/.test(line)))).toBe(true);
  expect(lone.control.status().connections).toMatchObject([{ origin: s.origin }]);
});

test('the words bind the link: another service, name, device or key gives other words, and the machine refuses them', async () => {
  const secret = newSecret(), a = await keys(), b = await keys();
  const fields = { origin: 'https://rooms.example', name: 'Laptop browser', device: a.id, sign: a.publicKey };
  const words = await controlWords(secret, fields);
  for (const changed of [{ origin: 'https://elsewhere.example' }, { name: 'Laptop browser ' }, { device: b.id }, { sign: b.publicKey }])
    expect(await controlWords(secret, { ...fields, ...changed })).not.toBe(words);
  expect(await controlWords(newSecret(), fields)).not.toBe(words);
  // The machine checks the words against the fields it is given: a link changed on its way is refused.
  const s = await service();
  const m = await machine(s.origin, s.admitted);
  const br = await browser(s.origin, s.url, s.admitted);
  const start = await br.startEnrolment();
  await expect(m.control.enrol({ ...start.fields, name: 'Someone else', secret: start.secret, words: start.words })).rejects.toMatchObject({ status: 400 });
  await expect(m.control.enrol({ ...start.fields, origin: 'https://elsewhere.example', secret: start.secret, words: start.words })).rejects.toMatchObject({ status: 400 });
  expect(readControllers(m.home)).toEqual([]);
});

test("enrolment refuses bad input, never replaces a policy it can't read, and a second enrolment can take trust back", async () => {
  const s = await service();
  const m = await machine(s.origin, s.admitted);
  const br = await browser(s.origin, s.url, s.admitted);
  const start = await br.startEnrolment();
  const enrol = (extra: Record<string, unknown>) => m.control.enrol({ ...start.fields, secret: start.secret, words: start.words, ...extra });
  await expect(enrol({ sign: 'not a key' })).rejects.toMatchObject({ status: 400 });
  await expect(enrol({ trusted: 'yes' })).rejects.toMatchObject({ status: 400 });
  writeFileSync(join(m.home, POLICY_FILE), 'not json');
  await expect(enrol({ trusted: true })).rejects.toMatchObject({ status: 409 });
  expect(readControllers(m.home)).toEqual([]);
  expect(readFileSync(join(m.home, POLICY_FILE), 'utf8')).toBe('not json');
  writeFileSync(join(m.home, POLICY_FILE), JSON.stringify({ enabled: true, harnesses: ['claude'], trusted: [] }));
  await enrol({ trusted: true });
  expect(readPolicy(m.home)).toEqual({ enabled: true, harnesses: ['claude'], trusted: [br.me.id] });
  await enrol({ trusted: false });
  expect(readPolicy(m.home)).toEqual({ enabled: true, harnesses: ['claude'], trusted: [] });
  // Without trusted, trust is left as it is.
  await enrol({ trusted: true });
  await enrol({});
  expect(readPolicy(m.home).trusted).toEqual([br.me.id]);
});

test("a cancel stops only the browser's own turn, and cancel and hello are answered while eight prompts run", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const started: string[] = [], cancelled: string[] = [];
  const list = [{ turnId: 'turn-mine', controller: '', requestId: '', harness: 'claude', sessionId: 's1', state: 'running', startedAt: '' },
    { turnId: 'turn-theirs', controller: 'f'.repeat(64), requestId: '', harness: 'claude', sessionId: 's1', state: 'running', startedAt: '' }];
  const turns = { running: () => list, cancel: (id: string) => { cancelled.push(id); return true; } };
  const { m, b } = await enrolled(true, { turns, runTurn: async (input: any) => { started.push(input.requestId); await gate; return { state: 'done', turnId: crypto.randomUUID(), sessionId: 's1', reply: 'ok', truncated: false }; } });
  list[0].controller = b.me.id;
  writeFileSync(join(m.home, POLICY_FILE), JSON.stringify({ enabled: true, harnesses: ['claude'], trusted: [b.me.id] }));
  for (let i = 0; i < 8; i++) await b.request(m.me.id, { op: 'prompt', harness: 'claude', sessionId: 's1', text: `p${i}` });
  expect(await until(() => started.length === 8)).toBe(true);
  expect((await b.replyTo(await b.request(m.me.id, { op: 'prompt', harness: 'claude', sessionId: 's1', text: 'ninth' })))[0]).toMatchObject({ ok: false, code: 'busy' });
  expect((await b.replyTo(await b.request(m.me.id, { op: 'hello' })))[0]).toMatchObject({ ok: true });
  expect((await b.replyTo(await b.request(m.me.id, { op: 'cancel', turnId: 'turn-theirs' })))[0]).toMatchObject({ ok: true, cancelled: false });
  expect((await b.replyTo(await b.request(m.me.id, { op: 'cancel', turnId: 'turn-mine' })))[0]).toMatchObject({ ok: true, cancelled: true });
  expect(cancelled).toEqual(['turn-mine']);
  release();
});

test('a controller removed on the machine is answered nothing at once, before the machine unlinks it', async () => {
  const { m, b } = await enrolled(true, { pollMs: 60_000 });
  expect((await b.replyTo(await b.request(m.me.id, { op: 'hello' })))[0]).toMatchObject({ ok: true });
  removeController(m.home, b.me.id);
  // The service still passes the frame (the machine hasn't relinked): the machine itself answers nothing.
  const id = await b.request(m.me.id, { op: 'hello' });
  await Bun.sleep(400);
  expect(b.replies.some(r => r.id === id)).toBe(false);
});

test("a request made before the machine's app started again is not run", async () => {
  const { m, b } = await enrolled();
  const before = Date.now();
  await Bun.sleep(20);
  await m.restart();
  expect(await until(() => b.client.peers.peers.some(p => p.device === m.me.id && p.online))).toBe(true);
  expect((await b.replyTo(await b.request(m.me.id, { op: 'hello' }, before, before + 60_000)))[0]).toMatchObject({ ok: false, code: 'expired', message: expect.stringMatching(/started again/) });
  expect((await b.replyTo(await b.request(m.me.id, { op: 'hello' })))[0]).toMatchObject({ ok: true });
});

test('a broken identity never breaks the control loop: it is reported, and nothing connects', async () => {
  const s = await service();
  const m = await machine(s.origin, s.admitted);
  const other = await keys();
  const id = JSON.parse(await m.me.identityJson());
  writeFileSync(join(m.home, PERSON_IDENTITY), JSON.stringify({ ...id, privateJwk: { kty: 'EC', crv: 'P-256', x: 'bad', y: 'bad', d: 'bad' } }));
  writeFileSync(join(m.home, CONTROLLERS_FILE), JSON.stringify({ version: 1, controllers: [{ device: other.id, sign: other.publicKey, enc: other.encPublicKey, encVersion: 1, encSig: other.encSig, name: 'Browser', origin: s.origin, addedAt: 1 }] }));
  await m.restart();
  await Bun.sleep(200);
  expect(m.control.status()).toMatchObject({ device: null, problem: expect.stringMatching(/can't be read/), connections: [] });
  expect(m.logs.some(line => /can't be read/.test(line))).toBe(true);
});

test('the enrolment window\'s choice of harnesses turns remote control on with them, or off with none; a bad one leaves nothing', async () => {
  const s = await service();
  const m = await machine(s.origin, s.admitted);
  const br = await browser(s.origin, s.url, s.admitted);
  const start = await br.startEnrolment();
  const enrol = (extra: Record<string, unknown>) => m.control.enrol({ ...start.fields, secret: start.secret, words: start.words, ...extra });
  await expect(enrol({ harnesses: 'claude' })).rejects.toMatchObject({ status: 400 });
  await expect(enrol({ harnesses: ['exec'] })).rejects.toMatchObject({ status: 400 });
  // Refused after the controller was added: it is taken back out.
  expect(readControllers(m.home)).toEqual([]);
  await enrol({ trusted: true, harnesses: ['codex', 'claude'] });
  expect(readPolicy(m.home)).toEqual({ enabled: true, harnesses: ['claude', 'codex'], trusted: [br.me.id] });
  await enrol({ harnesses: [] });
  expect(readPolicy(m.home)).toEqual({ enabled: false, harnesses: [], trusted: [br.me.id] });
  // Trust left behind for a browser no longer enrolled doesn't fail an enrolment: it is dropped on the way.
  writeFileSync(join(m.home, POLICY_FILE), JSON.stringify({ enabled: false, harnesses: [], trusted: [br.me.id, 'e'.repeat(64)] }));
  await enrol({ trusted: true });
  expect(readPolicy(m.home)).toEqual({ enabled: false, harnesses: [], trusted: [br.me.id] });
  // A bad list for a browser already enrolled changes nothing: not its record, not the policy.
  const before = readFileSync(join(m.home, CONTROLLERS_FILE), 'utf8');
  await expect(enrol({ harnesses: ['exec'], trusted: false })).rejects.toMatchObject({ status: 400 });
  expect(readFileSync(join(m.home, CONTROLLERS_FILE), 'utf8')).toBe(before);
  expect(readPolicy(m.home)).toEqual({ enabled: false, harnesses: [], trusted: [br.me.id] });
});
