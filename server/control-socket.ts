/**
 * Remote control, the daemon's socket (docs/flows/remote-control.md, build step 3): the machine's connection to the
 * service's `/api/control/v1`, and what it does with the requests its controllers send. The machine is the person's
 * device (identity.json in the person folder): its signing key, and its encryption key bound to every room.
 *
 * - **Connections:** one per service its controllers enrolled from (controllers.json), linking exactly them. None while
 *   it has no controller, so a machine nobody enrolled isn't on the service at all. The list is read again every
 *   CONTROLLERS_POLL_MS, and at once after an enrolment.
 * - **Requests:** only from a controller on the list (the client drops every other sender before decrypting), each with
 *   a uuid, `at` and `expiresAt` at most CONTROL_REQUEST_TTL_MS apart. An expired one, one from the future, or one seen
 *   before is not run. At most MAX_IN_FLIGHT at once per controller.
 *   - `hello`: the machine, its harnesses, the policy and whether this controller is trusted. Answered even while remote
 *     control is off, so the web app can say so.
 *   - `sessions {harness}`: the harness's listing, while remote control is on and allows the harness.
 *   - `prompt {harness, sessionId, text}`: runRemoteTurn, which checks everything again; answered `running` once the
 *     harness starts, then with the result. A controller the person didn't trust needs the first-use question, which
 *     this machine can't ask yet: it is told so.
 *   - `cancel {turnId}`: its own turns only.
 * - **Enrolment:** the app calls enrol() once the person typed the words the browser shows (controlWords). The
 *   controller is added, and the machine answers the browser with `enrolled` (its keys, an HMAC under the link's
 *   secret) as soon as the browser is online and links it back, for ENROL_WAIT_MS at most. The secret lives only in memory
 *   until then.
 */
import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTROL_REQUEST_TTL_MS, ControlClient, controlWords, enrolMac, type ControlKeys, type ControlPeer, type ControlSelf, type ControlState,
} from '../src/browser/control-client';
import { controlRoom, encode } from '../src/browser/protocol';
import { decodeSecret, normalPhrase } from '../src/browser/pairing';
import { importEncPrivateJwk, verifyEncBinding } from '../src/browser/relay-crypto';
import type { HarnessScan } from './detectors/harnesses';
import { PERSON_IDENTITY } from './person';
import {
  CONTROLLERS_FILE, addController, cancelTurn, checkPolicy, readControllers, readPolicy, readPolicyStrict, removeController, runRemoteTurn, runningTurns, savePolicy,
  type Controller, type RemoteDeps, type RemotePolicy,
} from './remote-control';
import { plainText } from './detectors/harnesses';

export const CONTROLLERS_POLL_MS = 2_000;
export const ENROL_WAIT_MS = 15 * 60_000;
/** How often the `enrolled` answer is sent again while the browser hasn't spoken yet. */
export const ENROL_RESEND_MS = 30_000;
export const MAX_IN_FLIGHT = 8;
/** Request ids remembered (for 2 × CONTROL_REQUEST_TTL_MS), at most this many per controller. */
const MAX_SEEN = 2_000;
/** Requests that answer at once and never wait: not counted against MAX_IN_FLIGHT, so a browser can always stop its turns. */
const UNCOUNTED = new Set(['hello', 'cancel']);
const BASE64_KEY = /^[A-Za-z0-9+/]{86}[A-Za-z0-9+/=]{2}$/;
/** An error as one short line for the daemon log: what the service said is never written as it came. */
const oneLine = (error: unknown) => plainText(error instanceof Error ? error.message : String(error), 200) ?? 'unknown error';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type MachineControlDeps = {
  /** The person folder: identity, controllers, policy. */
  home: string;
  remote: RemoteDeps;
  /** The harness scan the hello shows (harnessScanner().scan). */
  scan: () => Promise<HarnessScan[]>;
  log: (line: string) => void;
  /** Asks the person at the machine before a controller's first prompt to a harness; without it, untrusted controllers are told to be trusted first. */
  ask?: RemoteDeps['askFirstUse'];
  /** The turn runner, and the turns it has going (default runRemoteTurn, runningTurns and cancelTurn); tests give fakes. */
  runTurn?: typeof runRemoteTurn;
  turns?: { running: typeof runningTurns; cancel: typeof cancelTurn };
  WebSocket?: typeof WebSocket;
  now?: () => number;
  machine?: { name: string; platform: string };
  backoff?: { minMs: number; maxMs: number; refusedMs: number };
  pollMs?: number;
};
type Identity = { self: ControlSelf; enc: string; encSig: string };
type Enrolling = { secret: Uint8Array; until: number; sentAt: number };

/** The person's keys for remote control, or why there are none. */
async function machineIdentity(home: string): Promise<Identity | string> {
  let raw: any;
  try { raw = JSON.parse(readFileSync(join(home, PERSON_IDENTITY), 'utf8')); } catch { return 'This machine has no person yet.'; }
  if (typeof raw?.id !== 'string' || typeof raw.publicKey !== 'string' || !raw.privateJwk || !raw.encPrivateJwk || typeof raw.encPublicKey !== 'string'
    || !Number.isSafeInteger(raw.encVersion) || typeof raw.encSig !== 'string') return 'The person on this machine has no encryption key yet: join a room first.';
  // Bound to its signing key for every room, as the browser will check.
  if (!await verifyEncBinding(raw.publicKey, { room: '*', deviceId: raw.id, enc: raw.encPublicKey, encVersion: raw.encVersion }, raw.encSig))
    return "The person's encryption key isn't bound to every room: join a room from this version first.";
  try {
    const signKey = await crypto.subtle.importKey('jwk', raw.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const sign = async (value: unknown) => Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKey, encode(value))).toString('base64');
    return { self: { id: raw.id, publicKey: raw.publicKey, sign, encPrivateKey: await importEncPrivateJwk(raw.encPrivateJwk, false), encVersion: raw.encVersion }, enc: raw.encPublicKey, encSig: raw.encSig };
  } catch { return "The person's keys on this machine can't be read."; }
}

const keysOf = (c: Controller): ControlKeys => ({ device: c.device, sign: c.sign, enc: c.enc, encVersion: c.encVersion });
const failure = (code: string, message: string) => ({ ok: false as const, code, message });

export class MachineControl {
  private readonly deps: MachineControlDeps;
  private readonly now: () => number;
  private identity?: Identity;
  private problem?: string;
  private controllers: Controller[] = [];
  private controllersText = '';
  private readonly clients = new Map<string, { client: ControlClient; state: ControlState; peers: ControlPeer[] }>();
  private readonly enrolling = new Map<string, Enrolling>();
  /** Request ids seen, per controller, until when they could still come again. */
  private readonly seen = new Map<string, Map<string, number>>();
  private readonly inFlight = new Map<string, number>();
  /** When this socket started: a request made before it can't be told from one a service kept back, and isn't run. */
  private startedAt = 0;
  /** What is being sent to each controller: its replies go out one after another, in the order they were made. */
  private readonly outbox = new Map<string, Promise<unknown>>();
  private poll?: ReturnType<typeof setInterval>;
  private started = false;

  constructor(deps: MachineControlDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.startedAt = this.now();
    this.poll = setInterval(() => { void this.refresh(); }, this.deps.pollMs ?? CONTROLLERS_POLL_MS);
    await this.refresh();
  }
  stop() {
    this.started = false;
    clearInterval(this.poll);
    for (const { client } of this.clients.values()) client.stop();
    this.clients.clear();
    for (const pending of this.enrolling.values()) pending.secret.fill(0);
    this.enrolling.clear();
  }

  /** What the app shows: the machine's id, each connection's state and peers, and how many enrolments wait. */
  status() {
    return {
      device: this.identity?.self.id ?? null, ...(this.problem ? { problem: this.problem } : {}),
      connections: [...this.clients].map(([origin, entry]) => ({ origin, state: entry.state, peers: entry.peers })),
      enrolling: this.enrolling.size,
    };
  }

  /** Reads the controllers (and the identity, if it isn't loaded) and opens, relinks or closes connections to match. Never throws. */
  async refresh() {
    if (!this.started) return;
    try { await this.reconcile(); } catch (error) { this.deps.log(`control: ${oneLine(error)}`); }
  }
  private async reconcile() {
    let text = '';
    try { text = readFileSync(join(this.deps.home, CONTROLLERS_FILE), 'utf8'); } catch { /* None yet. */ }
    const changed = text !== this.controllersText;
    this.controllersText = text;
    this.controllers = readControllers(this.deps.home);
    for (const [device, pending] of this.enrolling) if (pending.until <= this.now() || !this.controllers.some(c => c.device === device)) { pending.secret.fill(0); this.enrolling.delete(device); }
    // Loaded even with no controller, so the app can show which device this machine is.
    if (!this.identity) {
      const loaded = await machineIdentity(this.deps.home);
      if (typeof loaded === 'string') {
        if (this.controllers.length && loaded !== this.problem) this.deps.log(`control: not connecting: ${loaded}`);
        this.problem = loaded;
      } else { this.identity = loaded; this.problem = undefined; }
    }
    if (!this.controllers.length || !this.identity) { for (const { client } of this.clients.values()) client.stop(); this.clients.clear(); return; }
    const origins = new Set(this.controllers.map(c => c.origin));
    for (const [origin, { client }] of this.clients) if (!origins.has(origin)) { client.stop(); this.clients.delete(origin); }
    for (const origin of origins) {
      const known = this.clients.get(origin);
      if (known) { if (changed) known.client.relink(); continue; }
      this.connect(origin);
    }
  }

  private connect(origin: string) {
    const identity = this.identity!;
    const entry = { client: undefined as unknown as ControlClient, state: 'connecting' as ControlState, peers: [] as ControlPeer[] };
    entry.client = new ControlClient({
      url: `${origin.replace(/^http/, 'ws')}/api/control/v1`, origin, self: identity.self,
      links: () => this.controllers.filter(c => c.origin === origin).map(c => c.device),
      keysOf: device => { const c = this.controllers.find(x => x.device === device && x.origin === origin); return c && keysOf(c); },
      // A machine's traffic, both ways, is in its own domain.
      domain: () => controlRoom(identity.self.id),
      onPacket: (from, packet) => { void this.request(origin, from, packet); },
      onPeers: peers => { entry.peers = peers; this.answerEnrolments(origin, peers); },
      onState: (state, detail) => {
        if (state !== entry.state) this.deps.log(`control: ${origin} ${state}${detail?.code ? ` (${detail.code})` : ''}`);
        entry.state = state;
      },
      ...(this.deps.WebSocket ? { WebSocket: this.deps.WebSocket } : {}), ...(this.deps.backoff ? { backoff: this.deps.backoff } : {}), now: this.now,
    });
    this.clients.set(origin, entry);
    entry.client.start();
  }

  /**
   * The app's half of enrolment, once the person typed the browser's words: checks them, adds the browser as a
   * controller (trusted, if the person said so) and waits to tell it this machine's keys.
   */
  async enrol(input: Record<string, unknown>) {
    const bad = (message: string, status = 400) => Object.assign(new Error(message), { status });
    if (!this.started) throw bad("Remote control isn't running in this daemon yet. Try again in a moment.", 503);
    const secret = decodeSecret(input.secret);
    if (!secret) throw bad('Give the secret from the link (32 bytes, base64url).');
    try {
      const { device, sign, enc, encVersion, encSig, name, origin } = input;
      if (typeof sign !== 'string' || !BASE64_KEY.test(sign) || typeof device !== 'string' || typeof name !== 'string' || typeof origin !== 'string')
        throw bad('Give the link as it is: its origin, name, device and keys.');
      if (input.trusted !== undefined && typeof input.trusted !== 'boolean') throw bad('Set trusted to true or false.');
      if (input.harnesses !== undefined && !(Array.isArray(input.harnesses) && input.harnesses.every(h => typeof h === 'string'))) throw bad('List the harnesses remote prompts may reach.');
      // The words bind the service, the name, the device and the key the link carries: none of them changed on the way.
      if (typeof input.words !== 'string' || normalPhrase(input.words) !== await controlWords(secret, { origin, name, device, sign }))
        throw bad("Those words don't match the link: check the words your browser shows.");
      const loaded = this.identity ?? await machineIdentity(this.deps.home);
      if (typeof loaded === 'string') throw bad(loaded, 409);
      this.identity = loaded;
      // Read strictly: a policy file that can't be read is the person's to fix, never replaced with the default.
      // The window's choices, saved with the controller: whether this browser may prompt without the first-use question,
      // and which harnesses remote prompts may reach on this machine (none turns remote control off, which is the kill switch).
      const choose = input.trusted !== undefined || input.harnesses !== undefined;
      // The choices made on a policy: trust for this browser, and the harnesses (which turn remote control on or off).
      const choices = (policy: RemotePolicy): RemotePolicy => {
        // Trust for a browser no longer enrolled is dropped on the way (as changePolicy does): it must not fail this one.
        const enrolled = new Set([...readControllers(this.deps.home).map(c => c.device), device]);
        const kept = policy.trusted.filter(d => enrolled.has(d));
        const trusted = input.trusted === undefined ? kept
          : input.trusted ? [...new Set([...kept, device])] : kept.filter(d => d !== device);
        const harnesses = input.harnesses === undefined ? policy.harnesses : input.harnesses as RemotePolicy['harnesses'];
        return checkPolicy({ enabled: input.harnesses === undefined ? policy.enabled : harnesses.length > 0, harnesses, trusted });
      };
      // Checked before anything is written: a bad harness list, or a policy that can't be read, changes nothing at all.
      if (choose) choices(readPolicyStrict(this.deps.home));
      const existed = readControllers(this.deps.home).some(c => c.device === device);
      const controller = await addController(this.deps.home, { device, sign, enc, encVersion, encSig, name, origin }, this.now());
      // Made on the policy as it is now, not as it was before the await: a change the person made meanwhile stays.
      if (choose) {
        try { savePolicy(this.deps.home, choices(readPolicyStrict(this.deps.home))); }
        catch (error) { if (!existed) removeController(this.deps.home, controller.device); throw error; }
      }
      this.enrolling.get(controller.device)?.secret.fill(0);
      this.enrolling.set(controller.device, { secret: Uint8Array.from(secret), until: this.now() + ENROL_WAIT_MS, sentAt: 0 });
      await this.refresh();
      const entry = this.clients.get(controller.origin);
      if (entry) this.answerEnrolments(controller.origin, entry.peers);
      return { controller, machine: { device: loaded.self.id } };
    } finally { secret.fill(0); }
  }

  /** Tells each browser that waits for it, once it is online and links this machine back, the machine's keys. */
  private answerEnrolments(origin: string, peers: ControlPeer[]) {
    const identity = this.identity, entry = this.clients.get(origin);
    if (!identity || !entry || entry.state !== 'ready') return;
    for (const [device, pending] of this.enrolling) {
      const controller = this.controllers.find(c => c.device === device && c.origin === origin);
      if (!controller || !peers.some(p => p.device === device && p.online) || this.now() - pending.sentAt < ENROL_RESEND_MS) continue;
      pending.sentAt = this.now();
      const machine = { device: identity.self.id, sign: identity.self.publicKey, enc: identity.enc, encVersion: identity.self.encVersion, encSig: identity.encSig,
        ...this.deps.machine ?? { name: hostname(), platform: process.platform } };
      // Its own copy: the pending one is wiped as soon as the enrolment ends, which may be before this send runs.
      const secret = Uint8Array.from(pending.secret);
      void this.queue(device, async () => {
        try { await entry.client.send(device, { v: 1, t: 'enrolled', machine, mac: await enrolMac(secret, device, machine) }, keysOf(controller)); }
        finally { secret.fill(0); }
      });
    }
  }

  /** Sends to `device` after everything sent to it before (a turn's `running` must not arrive after its result). */
  private queue(device: string, send: () => Promise<void>) {
    const next = (this.outbox.get(device) ?? Promise.resolve()).then(send)
      .catch(error => this.deps.log(`control: a reply could not be sent: ${oneLine(error)}`));
    this.outbox.set(device, next);
    void next.then(() => { if (this.outbox.get(device) === next) this.outbox.delete(device); });
    return next;
  }

  /** The controller as the file says now: one removed a moment ago is answered nothing, whatever the last poll saw. */
  private current(device: string, origin: string) {
    return readControllers(this.deps.home).find(c => c.device === device && c.origin === origin);
  }

  private async request(origin: string, from: string, packet: any) {
    const controller = this.current(from, origin);
    if (!controller || packet?.v !== 1 || packet.t !== 'request' || typeof packet.id !== 'string' || !UUID.test(packet.id)) return;
    const entry = this.clients.get(origin);
    if (!entry) return;
    const id = packet.id;
    // Sealed for the controller only while it still is one, checked again as each reply goes out.
    const reply = (body: Record<string, unknown>) => this.queue(from, async () => {
      const still = this.current(from, origin);
      if (still) await entry.client.send(from, { v: 1, t: 'reply', id, ...body }, keysOf(still));
    });
    const now = this.now();
    if (!Number.isSafeInteger(packet.at) || !Number.isSafeInteger(packet.expiresAt) || packet.expiresAt < packet.at || packet.expiresAt - packet.at > CONTROL_REQUEST_TTL_MS
      || packet.at > now + 60_000) return reply(failure('invalid', `A request needs at and expiresAt, at most ${CONTROL_REQUEST_TTL_MS / 1000} seconds apart, and not from the future.`));
    // Seen before: never run twice, and not answered again either.
    let seen = this.seen.get(from);
    if (!seen) this.seen.set(from, seen = new Map());
    for (const [key, until] of seen) { if (until > now && seen.size < MAX_SEEN) break; seen.delete(key); }
    if (seen.has(id)) return;
    seen.set(id, now + 2 * CONTROL_REQUEST_TTL_MS);
    if (packet.expiresAt < now) return reply(failure('expired', 'This request expired before it arrived.'));
    // Made before this socket started: one a service held back across a restart looks just like it, so neither runs.
    if (packet.at < this.startedAt) return reply(failure('expired', "This request was made before this machine's app started again. Send it again."));
    // It talks to this machine, so it has its keys: the enrolment is done.
    const pending = this.enrolling.get(from);
    if (pending) { pending.secret.fill(0); this.enrolling.delete(from); }
    const counted = !UNCOUNTED.has(packet.op), busy = this.inFlight.get(from) ?? 0;
    if (counted && busy >= MAX_IN_FLIGHT) return reply(failure('busy', `At most ${MAX_IN_FLIGHT} requests from one browser at a time.`));
    if (counted) this.inFlight.set(from, busy + 1);
    try { await reply(await this.answer(from, controller, packet, reply)); }
    catch (error) { await reply(failure('failed', oneLine(error))); }
    finally {
      if (counted) { const left = (this.inFlight.get(from) ?? 1) - 1; if (left > 0) this.inFlight.set(from, left); else this.inFlight.delete(from); }
    }
  }

  private async answer(from: string, controller: Controller, packet: any, reply: (body: Record<string, unknown>) => Promise<unknown>): Promise<Record<string, unknown>> {
    const policy = readPolicy(this.deps.home);
    switch (packet.op) {
      case 'hello': {
        const harnesses = (await this.deps.scan()).map(({ harness, label, detected, sessionsAvailable }) => ({ harness, label, detected, sessionsAvailable }));
        return { ok: true, machine: this.deps.machine ?? { name: hostname(), platform: process.platform }, harnesses, capabilities: ['sessions', 'prompt', 'cancel'],
          policy: { enabled: policy.enabled, harnesses: policy.harnesses }, trusted: policy.trusted.includes(from) };
      }
      case 'sessions': {
        if (!policy.enabled) return failure('disabled', 'Remote control is off on this machine. Turn it on in the Meshrooms app there.');
        if (typeof packet.harness !== 'string' || !policy.harnesses.includes(packet.harness as never)) return failure('not-allowed', 'That harness is not allowed on this machine.');
        const listing = await this.deps.remote.scanner.sessions(packet.harness as never);
        return { ok: true, harness: listing.harness, sessionsAvailable: listing.sessionsAvailable, ...(listing.reason ? { reason: listing.reason } : {}), sessions: listing.sessions, truncated: listing.truncated };
      }
      case 'prompt': {
        if (policy.enabled && !policy.trusted.includes(from) && !this.deps.ask)
          return { state: 'failed', code: 'not-allowed', message: `This machine asks before the first prompt from a browser, and its app can't ask yet. Mark ${controller.name} as trusted in the Meshrooms app on this machine.` };
        const result = await (this.deps.runTurn ?? runRemoteTurn)({ requestId: packet.id, controller: from, harness: packet.harness, sessionId: packet.sessionId, text: packet.text }, {
          ...this.deps.remote, ...(this.deps.ask ? { askFirstUse: this.deps.ask } : {}),
          onRunning: turnId => { void reply({ state: 'running', turnId }); },
        });
        return { ...result };
      }
      case 'cancel': {
        const turns = this.deps.turns ?? { running: runningTurns, cancel: cancelTurn };
        const turn = turns.running(this.deps.home).find(t => t.turnId === packet.turnId && t.controller === from);
        return { ok: true, cancelled: !!turn && turns.cancel(turn.turnId, `Cancelled from ${controller.name}.`) };
      }
      default: return failure('unsupported', 'This machine does not know that request.');
    }
  }
}
