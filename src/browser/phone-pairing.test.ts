import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { encodeSecret, newOfferCode, newSecret, offerLookup, offerSecret, pairingProof, pairingSas, showOfferCode } from './pairing';
import { LINK_TRIES, OFFER_GONE, OFFER_TYPO, PHONE_MAX_ROOMS, askPhoneRooms, cancelOffer, fileOffer, previewPhone, redeemOffer, revokePhoneRooms, deviceLabel, linkPhoneRooms, parsePhoneFragment, phoneFinished, phoneFragment, phoneRoomFrom, phoneUrl, type LinkState, type PhoneRoomState } from './phone-pairing';
import { PAIRING_NOT_FOUND, PAIR_OFFER_NOT_FOUND } from './protocol';

const ROOMS = ['00000000-0000-4000-8000-000000000001', 'abcdef01-2345-4678-89ab-cdef01234567'];
const DEVICE = 'b'.repeat(64);
const link = (rooms = ROOMS) => ({ secret: Uint8Array.from({ length: 32 }, (_, i) => i + 1), device: DEVICE, name: 'Robin Lee', rooms });

describe('the code a phone scans', () => {
  test('round-trips the secret, the trusted device, the name and the rooms', () => {
    const parsed = parsePhoneFragment(`#${phoneFragment(link())}`)!;
    expect(parsed.secret).toEqual(link().secret);
    expect(parsed.device).toBe(DEVICE);
    expect(parsed.name).toBe('Robin Lee');
    expect(parsed.rooms).toEqual(ROOMS);
    expect(parsePhoneFragment(phoneFragment(link()))?.rooms).toEqual(ROOMS);
  });
  test('names with accents, emoji and nothing at all survive; controls and bidi overrides do not', () => {
    expect(parsePhoneFragment(phoneFragment({ ...link(), name: 'Zoë 🌸' }))?.name).toBe('Zoë 🌸');
    expect(parsePhoneFragment(phoneFragment({ ...link(), name: '' }))?.name).toBe('');
    expect(parsePhoneFragment(phoneFragment({ ...link(), name: 'Ro\u202Ebin\u0007' }))?.name).toBe('Robin');
  });
  test('lives in the fragment, is short enough to scan, and carries at most 8 distinct rooms', () => {
    const many = Array.from({ length: 12 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const url = phoneUrl('https://rooms.example', link([...many, many[0]]));
    expect(url.startsWith('https://rooms.example/rooms#pair=p1.')).toBe(true);
    expect(new URL(url).search).toBe('');
    expect(parsePhoneFragment(new URL(url).hash)!.rooms).toEqual(many.slice(0, PHONE_MAX_ROOMS));
    expect(url.length).toBeLessThan(400);
  });
  test('anything off is refused rather than guessed', () => {
    const good = phoneFragment(link());
    const [head, secret, device, name, rooms] = good.split('.');
    expect(parsePhoneFragment(good)).toBeDefined();
    for (const bad of ['', 'pair=p2.' + good.slice(8), `${head}.${secret.slice(1)}.${device}.${name}.${rooms}`, `${head}.${secret}.${device}.${name}.`, `${head}.${secret}.${device}.${name}.${rooms}x`,
      `${head}.${secret}.${device}.${name}.${rooms}${rooms}`, `${good}.extra`, `${head}.${secret}.${device}..${rooms}`.replace('..', '.!.'), `other=${good}`,
      `${head}.${secret}.${device}.${name}.${rooms.slice(0, 21)}A`.replace(/A$/, '+')]) {
      expect(parsePhoneFragment(bad)).toBeUndefined();
    }
    // The same room twice is not a list of rooms.
    expect(parsePhoneFragment(`${head}.${secret}.${device}.${name}.${rooms.slice(0, 22)}${rooms.slice(0, 22)}`)).toBeUndefined();
    // A non-canonical secret (spare bits set) is not the secret.
    expect(parsePhoneFragment(`${head}.${'A'.repeat(42)}F.${device}.${name}.${rooms}`)).toBeUndefined();
    expect(() => phoneFragment({ ...link(), device: 'nope' })).toThrow();
  });
});

describe('device labels', () => {
  test('an iPhone is an iPhone, not a Mac', () => {
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toBe('iPhone (Safari)');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1')).toBe('iPhone (Chrome)');
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', 5)).toBe('iPad (Safari)');
  });
  test('other phones and computers', () => {
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36')).toBe('Android phone (Chrome)');
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36')).toBe('Mac (Chrome)');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0')).toBe('Windows (Edge)');
    expect(deviceLabel('Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0')).toBe('Linux (Firefox)');
    expect(deviceLabel('')).toBe('Browser');
  });
});

describe('the phone asks, the trusted device links', () => {
  test('each room gets its own proof, bound to the phone key, the room and the trusted device', async () => {
    const secret = newSecret(), sent: [string, Record<string, unknown>][] = [], states: Record<string, string> = {};
    await askPhoneRooms({ rooms: ROOMS, secret, trustedDevice: DEVICE, publicKey: `B${'A'.repeat(86)}=`, label: 'iPhone (Safari)',
      request: async (id, payload) => { sent.push([id, payload]); return {}; }, report: (id, state) => { states[id] = state; } });
    expect(sent.map(([id]) => id)).toEqual(ROOMS);
    for (const [id, payload] of sent) {
      expect(payload).toMatchObject({ kind: 'companion', name: 'Companion device', label: 'iPhone (Safari)' });
      expect(payload.pairing).toBe(createHmac('sha256', secret).update(`meshrooms-pair-v2:${id}:B${'A'.repeat(86)}=:${DEVICE}`).digest('hex'));
      expect(payload.pairing).toBe(await pairingProof(secret, id, `B${'A'.repeat(86)}=`, DEVICE));
      expect(JSON.stringify(payload)).not.toContain(encodeSecret(secret));
    }
    expect(sent[0][1].pairing).not.toBe(sent[1][1].pairing);
    expect(states).toEqual({ [ROOMS[0]]: 'asked', [ROOMS[1]]: 'asked' });
  });
  test('a room that refuses is reported and the others still go', async () => {
    const got: Record<string, [PhoneRoomState, string?]> = {};
    await askPhoneRooms({ rooms: ROOMS, secret: newSecret(), trustedDevice: DEVICE, publicKey: 'k', label: 'x',
      request: async id => { if (id === ROOMS[0]) throw new Error('This room is closed.'); return {}; }, report: (id, state, problem) => { got[id] = [state, problem]; } });
    expect(got).toEqual({ [ROOMS[0]]: ['failed', 'This room is closed.'], [ROOMS[1]]: ['asked', undefined] });
  });

  const notFound = Object.assign(new Error('not yet'), { status: 404, code: PAIRING_NOT_FOUND });
  const run = (answers: Record<string, (attempt: number) => Record<string, unknown>>, stopped = () => false) => {
    const calls: string[] = [], slept: number[] = [], reported: [string, LinkState][] = [], attempts: Record<string, number> = {};
    return { calls, slept, reported, done: linkPhoneRooms({ rooms: ROOMS, secret: 'secret', stopped,
      link: async id => { calls.push(id); attempts[id] = (attempts[id] ?? 0) + 1; return answers[id](attempts[id]); },
      report: (id, state) => reported.push([id, state]), sleep: async ms => { slept.push(ms); } }) };
  };
  test('links every room once the phone has asked, and tells a room that waits for its host', async () => {
    const r = run({ [ROOMS[0]]: () => ({ admitted: true }), [ROOMS[1]]: () => ({ admitted: false }) });
    expect((await r.done).states).toEqual({ [ROOMS[0]]: 'joined', [ROOMS[1]]: 'host' });
    expect(r.calls).toEqual(ROOMS); expect(r.slept).toEqual([]);
  });
  test('retries rooms the phone has not asked in yet, a few times, then says so; never in a loop', async () => {
    const r = run({ [ROOMS[0]]: () => ({ admitted: true }), [ROOMS[1]]: () => { throw notFound; } });
    const out = await r.done;
    expect(out.states).toEqual({ [ROOMS[0]]: 'joined', [ROOMS[1]]: 'missing' });
    expect(r.calls.filter(id => id === ROOMS[1]).length).toBe(LINK_TRIES);
    expect(r.calls.filter(id => id === ROOMS[0]).length).toBe(1);
    expect(r.slept).toHaveLength(LINK_TRIES - 1);
  });
  test('a room that asks late is linked by a later try', async () => {
    const r = run({ [ROOMS[0]]: n => { if (n < 2) throw notFound; return { admitted: true }; }, [ROOMS[1]]: () => ({ admitted: true }) });
    expect((await r.done).states).toEqual({ [ROOMS[0]]: 'joined', [ROOMS[1]]: 'joined' });
  });
  test('too many tries stops at once; any other refusal fails that room only', async () => {
    const busy = run({ [ROOMS[0]]: () => { throw Object.assign(new Error('slow down'), { status: 429 }); }, [ROOMS[1]]: () => ({ admitted: true }) });
    const out = await busy.done;
    expect(out.rateLimited).toBe(true); expect(busy.calls).toEqual([ROOMS[0]]);
    const refused = run({ [ROOMS[0]]: () => { throw Object.assign(new Error('Only people can confirm devices.'), { status: 403 }); }, [ROOMS[1]]: () => ({ admitted: true }) });
    expect((await refused.done).states).toEqual({ [ROOMS[0]]: 'failed', [ROOMS[1]]: 'joined' });
  });
  test('stopping (cancel, expiry) ends it without another request', async () => {
    let stop = false;
    const r = run({ [ROOMS[0]]: () => { stop = true; return { admitted: true }; }, [ROOMS[1]]: () => ({ admitted: true }) }, () => stop);
    await r.done;
    expect(r.calls).toEqual([ROOMS[0]]);
  });
});

describe('what the phone sees while it waits', () => {
  test('reads the room status', () => {
    expect(phoneRoomFrom({ memberId: 'm' }, 'asked').state).toBe('joined');
    expect(phoneRoomFrom({ request: { state: 'pending' } }, 'asked').state).toBe('asked');
    expect(phoneRoomFrom({ request: { state: 'pending', linkedMemberId: 'm' } }, 'asked').state).toBe('host');
    expect(phoneRoomFrom({ request: { state: 'pending' } }, 'host').state).toBe('host');
    expect(phoneRoomFrom({ request: { state: 'admitted' } }, 'asked').state).toBe('joined');
    expect(phoneRoomFrom({ request: { state: 'declined' } }, 'asked')).toMatchObject({ state: 'failed' });
    expect(phoneRoomFrom({ request: { state: 'expired' } }, 'asked')).toMatchObject({ state: 'failed' });
    // Asked, then the request is gone: the trusted device withdrew it ("Not my phone"), so the phone says so instead of waiting.
    expect(phoneRoomFrom({}, 'asked')).toEqual({ state: 'failed', problem: 'Your computer withdrew this request.' });
    expect(phoneRoomFrom({}, 'host')).toMatchObject({ state: 'failed' });
    expect(phoneRoomFrom({}, 'asking').state).toBe('asking');
  });
  test('is finished when nothing waits for the trusted device, or shortly after the first room got in', () => {
    expect(phoneFinished([], 0)).toBe(false);
    expect(phoneFinished(['asking', 'joined'], 99_000)).toBe(false);
    expect(phoneFinished(['asked', 'asked'], 99_000)).toBe(false);
    expect(phoneFinished(['joined', 'host', 'failed'], 0)).toBe(true);
    expect(phoneFinished(['joined', 'asked'], 2_000)).toBe(false);
    expect(phoneFinished(['joined', 'asked'], 8_000)).toBe(true);
  });
});

const rawKey = (fill: number) => Buffer.from(Uint8Array.from({ length: 65 }, (_, i) => i === 0 ? 4 : (i * 7 + fill) % 256)).toString('base64');
describe('the trusted device looks for the phone before it links it', () => {
  const answer = (key: string) => ({ preview: { requestId: 'r', label: 'iPhone (Safari)', publicKey: key, deviceId: 'd'.repeat(64), expiresAt: 1 } });
  test('shows the key-bound words of the phone that answered, never the words of the code alone', async () => {
    const secret = newSecret(), phone = rawKey(1), other = rawKey(2), asked: unknown[] = [];
    const seen = await previewPhone({ rooms: ROOMS, secret, link: async (id, text, options) => { asked.push([id, text, options]); return answer(phone); } });
    expect(seen).toEqual({ label: 'iPhone (Safari)', deviceId: 'd'.repeat(64), publicKey: phone, words: await pairingSas(secret, phone) });
    expect(asked).toEqual([[ROOMS[0], encodeSecret(secret), { preview: true }]]);
    // Someone who photographed the code and asked from another key gets other words than the real phone shows.
    const stranger = await previewPhone({ rooms: ROOMS, secret, link: async () => answer(other) });
    expect(stranger!.words).not.toBe(seen!.words);
    expect(stranger!.words).toBe(await pairingSas(secret, other));
  });
  test('says nothing when the phone has not asked, asks only a couple of rooms, and lets real problems through', async () => {
    const notFound = Object.assign(new Error('not yet'), { status: 404, code: PAIRING_NOT_FOUND }), calls: string[] = [];
    const many = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(await previewPhone({ rooms: many, secret: newSecret(), link: async id => { calls.push(id); throw notFound; } })).toBeUndefined();
    expect(calls).toEqual(many.slice(0, 2));
    // The phone asked in the second room only: that room answers.
    const second = await previewPhone({ rooms: ROOMS, secret: newSecret(), link: async id => { if (id === ROOMS[0]) throw notFound; return answer(rawKey(3)); } });
    expect(second?.publicKey).toBe(rawKey(3));
    // Two devices answering one code (409) and a rate limit are not "not yet".
    await expect(previewPhone({ rooms: ROOMS, secret: newSecret(), link: async () => { throw Object.assign(new Error('More than one device'), { status: 409 }); } })).rejects.toMatchObject({ status: 409 });
    await expect(previewPhone({ rooms: ROOMS, secret: newSecret(), link: async () => { throw Object.assign(new Error('slow'), { status: 429 }); } })).rejects.toMatchObject({ status: 429 });
  });
  test('revoking a pairing asks every room, keeps going past a failure, and sends the secret only to link', async () => {
    const secret = encodeSecret(newSecret()), calls: unknown[] = [];
    await revokePhoneRooms({ rooms: ROOMS, secret, link: async (id, text, options) => { calls.push([id, text, options]); if (id === ROOMS[0]) throw new Error('offline'); return { revoked: 1 }; } });
    expect(calls).toEqual([[ROOMS[0], secret, { revoke: true }], [ROOMS[1], secret, { revoke: true }]]);
  });
});

describe('the typed code', () => {
  const commandLog = () => {
    const calls: [string, string, Record<string, unknown>][] = [];
    return { calls, command: async (action: string, roomId: string, payload: Record<string, unknown>) => { calls.push([action, roomId, payload]); return {} as Record<string, unknown>; } };
  };
  test('filing sends the lookup and the rooms, never the code or the secret', async () => {
    const code = newOfferCode(), log = commandLog();
    await fileOffer({ code, rooms: [ROOMS[1], ROOMS[0], ROOMS[1]], command: log.command as never });
    expect(log.calls).toEqual([['pair-offer', ROOMS[1], { lookup: await offerLookup(code), rooms: [ROOMS[1], ROOMS[0]] }]]);
    const wire = JSON.stringify(log.calls);
    expect(wire).not.toContain(code); expect(wire).not.toContain(encodeSecret(await offerSecret(code)));
    await expect(fileOffer({ code, rooms: [], command: log.command as never })).rejects.toThrow();
    const nine = Array.from({ length: 9 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    await fileOffer({ code, rooms: nine, command: log.command as never });
    expect((log.calls.at(-1)![2].rooms as string[]).length).toBe(8);
  });
  test('cancelling names the lookup in the room it was filed from, and a failure is ignored', async () => {
    const code = newOfferCode(), log = commandLog();
    await cancelOffer({ code, roomId: ROOMS[0], command: log.command as never });
    expect(log.calls).toEqual([['pair-cancel', ROOMS[0], { lookup: await offerLookup(code) }]]);
    await cancelOffer({ code, roomId: ROOMS[0], command: (async () => { throw new Error('offline'); }) as never });
  });
  test('redeeming turns a typed code (any case, with or without the dash) into the same link a scan makes', async () => {
    const code = 'K7M2P9XQ4D', calls: Record<string, unknown>[] = [];
    const command = async (action: string, _room: string, payload: Record<string, unknown>) => {
      calls.push({ action, ...payload });
      return { offer: { name: 'Robin Lee', device: DEVICE, rooms: ROOMS, expiresAt: 123 } } as Record<string, unknown>;
    };
    for (const typed of ['K7M2P-9XQ4D', 'k7m2p9xq4d', ' k7m2p 9xq4d ']) {
      const out = await redeemOffer(typed, command as never);
      expect(out).toEqual({ secret: await offerSecret(code), device: DEVICE, name: 'Robin Lee', rooms: ROOMS, expiresAt: 123 });
    }
    expect(calls.every(c => c.action === 'pair-redeem' && c.lookup === calls[0].lookup)).toBe(true);
    expect(calls[0].lookup).toBe(await offerLookup(code));
    expect(JSON.stringify(calls)).not.toContain(code);
    // Look-alike letters are read as Crockford does: O is 0, I and L are 1.
    expect(showOfferCode(code)).toBe('K7M2P-9XQ4D');
  });
  test('a code that cannot be one never reaches the room service; a code it does not know is said plainly', async () => {
    let sent = 0;
    const command = (async () => { sent++; throw Object.assign(new Error('x'), { status: 404, code: PAIR_OFFER_NOT_FOUND }); }) as never;
    await expect(redeemOffer('', command)).rejects.toThrow(OFFER_TYPO);
    await expect(redeemOffer('K7M2P', command)).rejects.toThrow(OFFER_TYPO);
    await expect(redeemOffer('K7M2P-9XQ4D-9', command)).rejects.toThrow(OFFER_TYPO);
    await expect(redeemOffer('U7M2P-9XQ4D', command)).rejects.toThrow(OFFER_TYPO);
    expect(sent).toBe(0);
    await expect(redeemOffer('K7M2P-9XQ4D', command)).rejects.toThrow(OFFER_GONE);
    // A rate limit keeps the service's own words.
    await expect(redeemOffer('K7M2P-9XQ4D', (async () => { throw Object.assign(new Error('Too many wrong pairing codes.'), { status: 429 }); }) as never)).rejects.toThrow('Too many wrong pairing codes.');
  });
  test('an answer that is not a pairing is refused, whatever the service says', async () => {
    const give = (offer: unknown) => redeemOffer('K7M2P-9XQ4D', (async () => ({ offer })) as never);
    const ok = { name: 'Robin', device: DEVICE, rooms: ROOMS, expiresAt: 1 };
    await expect(give(ok)).resolves.toBeDefined();
    for (const bad of [undefined, null, {}, { ...ok, device: 'nope' }, { ...ok, rooms: [] }, { ...ok, rooms: ['../x'] }, { ...ok, rooms: [ROOMS[0], ROOMS[0]] },
      { ...ok, rooms: Array.from({ length: 9 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }, { ...ok, name: 5 }]) {
      await expect(give(bad)).rejects.toThrow();
    }
    // The name loses controls and bidi overrides, as in a scanned code.
    expect((await give({ ...ok, name: 'Ro\u202Ebin\u0007' })).name).toBe('Robin');
  });
});
