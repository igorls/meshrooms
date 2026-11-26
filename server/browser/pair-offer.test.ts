// Pairing offers (`pair-offer`, `pair-redeem`, `pair-cancel`): a typed code stands in for the QR code. The room service
// holds only sha256 of a lookup derived from the code, names the offer's rooms only to the one device that redeems it,
// and the secret made from the code feeds the unchanged `request {pairing}` / `link {pairing}` convention.
import { expect, test } from 'bun:test';
import { PAIR_OFFER_NOT_FOUND, deviceId, type PairingOffer } from '../../src/browser/protocol';
import { OFFER_ALPHABET, OFFER_CODE_LENGTH, OFFER_TTL_MS, encodeSecret, newOfferCode, normalOfferCode, offerLookup, offerSecret, pairingProof, pairingSas, showOfferCode } from '../../src/browser/pairing';
import { browserHandler } from './http';
import { BrowserLobby, MAX_OFFERS, OFFER_FAILURES, LINK_FAILURE_WINDOW } from './lobby';
import { admitPerson, client, type TestClient } from './test-client';

const origin = 'http://127.0.0.1:4320';
const keyOf = async (device: TestClient) => (await device.signed('status', crypto.randomUUID())).publicKey;
const outcome = async (work: Promise<unknown>) => { try { await work; return 'ok'; } catch (error) { return (error as { code?: string }).code ?? (error as Error).message; } };
async function setup(now?: () => number) {
  const lobby = new BrowserLobby(':memory:', { origin, ...(now ? { now } : {}) });
  const host = await client(lobby, now), room = crypto.randomUUID(), second = crypto.randomUUID();
  await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });
  await host.send('create', second, { title: 'Home', name: 'Alex', label: 'Desktop' });
  const sam = await admitPerson(lobby, host, room, 'Sam', now);
  return { lobby, host, room, second, sam };
}
const offer = async (device: TestClient, room: string, rooms: string[], code = newOfferCode()) =>
  ({ code, answer: await device.send('pair-offer', room, { lookup: await offerLookup(code), rooms }) as { offer?: { expiresAt: number } } });
const redeem = async (device: TestClient, code: string) =>
  await device.send('pair-redeem', crypto.randomUUID(), { lookup: await offerLookup(code) }) as { offer?: PairingOffer };

test('codes are 50 bits of Crockford base32, typed forgivingly; the secret and the lookup are different and stable', async () => {
  const codes = new Set(Array.from({ length: 200 }, newOfferCode));
  expect(codes.size).toBe(200);
  for (const code of codes) { expect(code).toHaveLength(OFFER_CODE_LENGTH); expect([...code].every(c => OFFER_ALPHABET.includes(c))).toBe(true); }
  expect(showOfferCode('ABCDE12345')).toBe('ABCDE-12345');
  // Case, separators and the letters Crockford folds (I, L to 1, O to 0) don't matter; a wrong length or symbol is refused.
  expect(normalOfferCode(' abcde-1l0o5 ')).toBe('ABCDE11005');
  for (const bad of ['', 'ABCDE-1234', 'ABCDE-123456', 'ABCDE-1234U', 'ABCDE-1234!']) expect(normalOfferCode(bad)).toBeUndefined();
  const code = 'ABCDE12345';
  expect(encodeSecret(await offerSecret(code))).toBe(encodeSecret(await offerSecret(code)));
  expect((await offerSecret(code))).toHaveLength(32);
  expect(await offerLookup(code)).toMatch(/^[a-f0-9]{64}$/);
  expect(encodeSecret(await offerSecret(code))).not.toBe(Buffer.from(await offerLookup(code), 'hex').toString('base64url'));
  expect(await offerLookup(code)).not.toBe(await offerLookup('ABCDE12346'));
});

test('a person files an offer; another device reads it once with the code, and the rooms and name come only to it', async () => {
  const { lobby, room, second, sam, host } = await setup();
  try {
    const phone = await client(lobby), stranger = await client(lobby);
    const { code, answer } = await offer(host, room, [room, second]);
    expect(answer.offer!.expiresAt).toBeGreaterThan(Date.now());
    // Wrong code: nothing, and no hint whether any offer exists.
    expect(await outcome(redeem(phone, newOfferCode()))).toBe(PAIR_OFFER_NOT_FOUND);
    const got = (await redeem(phone, code)).offer!;
    expect(got).toEqual({ name: 'Alex', device: await deviceId(await keyOf(host)), rooms: [room, second], expiresAt: answer.offer!.expiresAt });
    // The same device may read it again (a lost answer); nobody else can, the filer included.
    expect((await redeem(phone, code)).offer).toEqual(got);
    expect(await outcome(redeem(stranger, code))).toBe(PAIR_OFFER_NOT_FOUND);
    expect(await outcome(redeem(host, code))).toBe(PAIR_OFFER_NOT_FOUND);
    // Nothing leaks into status for anyone.
    for (const viewer of [host, sam]) expect(JSON.stringify(await viewer.status(room))).not.toContain(code);
    // The whole flow with the unchanged pairing convention: N from the code, the proof from the phone's key.
    const n = await offerSecret(code), publicKey = await keyOf(phone);
    await phone.send('request', room, { name: 'Companion device', label: 'iPhone (Safari)', kind: 'companion', pairing: await pairingProof(n, room, publicKey, got.device) });
    const shown = await host.send('link', room, { pairing: encodeSecret(n), preview: true }) as { preview: { publicKey: string; label: string } };
    expect(shown.preview.label).toBe('iPhone (Safari)');
    expect(await pairingSas(n, shown.preview.publicKey)).toBe(await pairingSas(n, publicKey));
    expect(await host.send('link', room, { pairing: encodeSecret(n) })).toEqual({ roomId: room, admitted: true });
    expect((await phone.status(room)).memberId).toBe((await host.status(room)).memberId);
  } finally { lobby.close(); }
});

test('an offer names only rooms its filer is a person in, the room it is sent in included, up to eight', async () => {
  const { lobby, room, second, sam } = await setup();
  try {
    // Sam is in the first room only; the second is the host's alone.
    expect(await outcome(offer(sam, room, [room, second]).then(r => r.answer))).toBe('Only people can pair a new device, and only to rooms they are in.');
    expect(await outcome(offer(sam, second, [second]).then(r => r.answer))).toBe('Only people can pair a new device, and only to rooms they are in.');
    expect(await outcome(offer(sam, room, [second, room]).then(r => r.answer))).toBe('Only people can pair a new device, and only to rooms they are in.');
    expect(await outcome(offer(sam, room, []))).toBe('Name between one and 8 rooms.');
    expect(await outcome(offer(sam, room, [room, room]))).toBe('Name between one and 8 rooms.');
    expect(await outcome(offer(sam, room, Array.from({ length: 9 }, () => crypto.randomUUID())))).toBe('Name between one and 8 rooms.');
    expect(await outcome(offer(sam, room, ['not-a-room']))).toBe('Name between one and 8 rooms.');
    expect(await outcome(sam.send('pair-offer', room, { lookup: 'short', rooms: [room] }))).toBe('This pairing code is not valid.');
    expect((await offer(sam, room, [room])).answer.offer).toBeDefined();
    // A device that isn't in the room at all gets nothing, and an unknown room is a plain 404.
    const outsider = await client(lobby);
    expect(await outcome(offer(outsider, room, [room]).then(r => r.answer))).toBe('Only people can pair a new device, and only to rooms they are in.');
    expect(await outcome(offer(sam, crypto.randomUUID(), [crypto.randomUUID()]).then(r => r.answer))).not.toBe('ok');
  } finally { lobby.close(); }
});

test('an agent cannot file an offer', async () => {
  const { lobby, host, room } = await setup();
  try {
    const invite = await host.send('agent-invite', room, { name: 'Robo' }) as unknown as { token: string };
    const agent = await client(lobby);
    await agent.send('agent-redeem', room, { token: invite.token, label: 'Bridge' });
    expect((await agent.status(room)).memberId).toBeDefined();
    expect(await outcome(offer(agent, room, [room]).then(r => r.answer))).toBe('Only people can pair a new device, and only to rooms they are in.');
  } finally { lobby.close(); }
});

test('an offer lives five minutes, a new one replaces the device\'s last, and the filer can cancel it', async () => {
  let now = Date.now();
  const { lobby, host, room, second } = await setup(() => now);
  try {
    const phone = await client(lobby, () => now);
    const first = await offer(host, room, [room]);
    const next = await offer(host, room, [room, second]);
    // One open offer per device: the old code is dead, the new one reads.
    expect(await outcome(redeem(phone, first.code))).toBe(PAIR_OFFER_NOT_FOUND);
    expect((await redeem(phone, next.code)).offer!.rooms).toEqual([room, second]);
    // Cancel: only by the device that filed it; idempotent.
    const third = await offer(host, room, [room]);
    const other = await client(lobby, () => now);
    expect(await other.send('pair-cancel', crypto.randomUUID(), { lookup: await offerLookup(third.code) })).toMatchObject({ cancelled: false });
    expect((await redeem(phone, third.code)).offer).toBeDefined();
    expect(await host.send('pair-cancel', room, { lookup: await offerLookup(third.code) })).toMatchObject({ cancelled: true });
    expect(await host.send('pair-cancel', room, { lookup: await offerLookup(third.code) })).toMatchObject({ cancelled: false });
    expect(await outcome(redeem(phone, third.code))).toBe(PAIR_OFFER_NOT_FOUND);
    // Expiry.
    const last = await offer(host, room, [room]);
    now += OFFER_TTL_MS - 1;
    expect((await redeem(phone, last.code)).offer).toBeDefined();
    now += 2;
    expect(await outcome(redeem(phone, last.code))).toBe(PAIR_OFFER_NOT_FOUND);
  } finally { lobby.close(); }
});

test('wrong codes are limited per device and per address, and the budget comes back; the right code is refused while it is spent', async () => {
  let now = Date.now();
  const { lobby, host, room } = await setup(() => now);
  try {
    const { code } = await offer(host, room, [room]);
    const guess = async (device: TestClient, address?: string, wrong = true) =>
      outcome(lobby.execute(await device.signed('pair-redeem', crypto.randomUUID(), { lookup: await offerLookup(wrong ? newOfferCode() : code) }), address));
    // One device.
    const one = await client(lobby, () => now);
    for (let i = 0; i < OFFER_FAILURES; i++) expect(await guess(one)).toBe(PAIR_OFFER_NOT_FOUND);
    expect(await guess(one)).toContain('Too many wrong pairing codes');
    expect(await guess(one, undefined, false)).toContain('Too many wrong pairing codes');
    // Throwaway keys from one address share that address's budget.
    for (let i = 0; i < OFFER_FAILURES; i++) expect(await guess(await client(lobby, () => now), '192.0.2.9')).toBe(PAIR_OFFER_NOT_FOUND);
    expect(await guess(await client(lobby, () => now), '192.0.2.9', false)).toContain('Too many wrong pairing codes');
    // Another address is not affected, and the right code reads there.
    expect(await guess(await client(lobby, () => now), '192.0.2.10', false)).toBe('ok');
    // The window passes: the device's budget is whole again (a fresh offer, the first is spent by the other address).
    now += LINK_FAILURE_WINDOW + 1;
    expect(await guess(one, undefined, false)).toBe(PAIR_OFFER_NOT_FOUND);
    const fresh = await offer(host, room, [room]);
    expect((await redeem(one, fresh.code)).offer).toBeDefined();
  } finally { lobby.close(); }
});

test('the service keeps no code and no secret, only hashed lookups, in memory; it holds at most MAX_OFFERS', async () => {
  const { lobby, host, room } = await setup();
  try {
    const { code } = await offer(host, room, [room]);
    const lookup = await offerLookup(code);
    const held = (lobby as unknown as { offers: Map<string, unknown> }).offers;
    expect(held.size).toBe(1);
    const key = [...held.keys()][0];
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toBe(lookup);
    expect(JSON.stringify([...held])).not.toContain(lookup);
    expect(JSON.stringify([...held])).not.toContain(code);
    // Fill to the cap with other devices' offers.
    for (let i = 1; i < MAX_OFFERS; i++) held.set(`${i}`.padStart(64, '0'), { device: `d${i}`, name: 'x', rooms: [room], expiresAt: Date.now() + 60_000 });
    const second = await client(lobby);
    await second.send('request', room, { name: 'Pat', label: 'Laptop', kind: 'person' });
    await host.send('decide', room, { requestId: (await host.status(room)).requests!.find(r => r.name === 'Pat')!.id, admit: true });
    expect(await outcome(offer(second, room, [room]).then(r => r.answer))).toContain('Too many pairing codes');
    // The filer replacing its own offer is not "one more".
    expect((await offer(host, room, [room])).answer.offer).toBeDefined();
  } finally { lobby.close(); }
});

test('over HTTP: the three actions are served, a wrong code is a 404 with its code, and the address budget answers 429', async () => {
  const { lobby, host, room } = await setup();
  try {
    const handle = browserHandler(lobby, origin, '.', { log: () => {} });
    const post = async (device: TestClient, action: 'pair-offer' | 'pair-redeem' | 'pair-cancel', roomId: string, payload: Record<string, unknown>, address = '192.0.2.1') =>
      handle(new Request(`${origin}/api/lobby`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(await device.signed(action, roomId, payload)) }), address);
    const code = newOfferCode(), lookup = await offerLookup(code), phone = await client(lobby);
    expect((await post(host, 'pair-offer', room, { lookup, rooms: [room] })).status).toBe(200);
    const wrong = await post(phone, 'pair-redeem', crypto.randomUUID(), { lookup: await offerLookup(newOfferCode()) });
    expect(wrong.status).toBe(404);
    expect(await wrong.json()).toMatchObject({ code: PAIR_OFFER_NOT_FOUND });
    const right = await post(phone, 'pair-redeem', crypto.randomUUID(), { lookup });
    expect(right.status).toBe(200);
    expect(JSON.stringify(await right.json())).toContain(room);
    expect((await post(host, 'pair-cancel', room, { lookup })).status).toBe(200);
    for (let i = 0; i < OFFER_FAILURES; i++) await post(await client(lobby), 'pair-redeem', crypto.randomUUID(), { lookup: await offerLookup(newOfferCode()) }, '192.0.2.50');
    expect((await post(await client(lobby), 'pair-redeem', crypto.randomUUID(), { lookup: await offerLookup(newOfferCode()) }, '192.0.2.50')).status).toBe(429);
  } finally { lobby.close(); }
});
