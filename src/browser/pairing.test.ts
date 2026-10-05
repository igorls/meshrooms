import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { PAIR_WORDS, decodeSecret, encodeSecret, newSecret, normalPhrase, pairLink, pairingName, pairingPhrase, pairingProof } from './pairing';

// The phrase vectors are also in desktop/src-tauri/src/pair.rs: the browser and the app must show the same phrase.
const ZERO = new Uint8Array(32), COUNT = Uint8Array.from({ length: 32 }, (_, i) => i);
const ROOM = '00000000-0000-4000-8000-000000000001', KEY = `B${'A'.repeat(86)}=`, BROWSER = 'b'.repeat(64);
describe('pairing convention', () => {
  test('known answers', async () => {
    expect(encodeSecret(ZERO)).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(await pairingPhrase(ZERO)).toBe('coach clock cider lake');
    expect(encodeSecret(COUNT)).toBe('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8');
    expect(await pairingPhrase(COUNT)).toBe('smoke raven whale hotel');
    expect(await pairingProof(ZERO, ROOM, KEY, BROWSER)).toBe('10e5d93c268f05a6443b34daff0ea8f3b307a3d60381cb7b6f1884e602a6bf72');
  });
  test('the proof is an HMAC keyed by the secret over the room, the app\'s key and the browser device, as the room service computes it', async () => {
    const secret = newSecret(), other = `C${KEY.slice(1)}`;
    const expected = createHmac('sha256', secret).update(`meshrooms-pair-v2:${ROOM}:${KEY}:${BROWSER}`).digest('hex');
    expect(await pairingProof(secret, ROOM, KEY, BROWSER)).toBe(expected);
    // Bound to all three: another key, room or browser device gives another proof.
    expect(await pairingProof(secret, ROOM, other, BROWSER)).not.toBe(expected);
    expect(await pairingProof(secret, '00000000-0000-4000-8000-000000000002', KEY, BROWSER)).not.toBe(expected);
    expect(await pairingProof(secret, ROOM, KEY, 'c'.repeat(64))).not.toBe(expected);
    expect(decodeSecret(encodeSecret(secret))).toEqual(secret);
  });
  test('the word list is 256 distinct plain words', () => {
    expect(PAIR_WORDS.length).toBe(256);
    expect(new Set(PAIR_WORDS).size).toBe(256);
    for (const word of PAIR_WORDS) expect(word).toMatch(/^[a-z]{3,6}$/);
  });
  test('only the canonical spelling of 32 bytes is a secret', () => {
    for (const bad of ['', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}B`, `${'A'.repeat(42)}+`, 42, null]) expect(decodeSecret(bad)).toBeUndefined();
    expect(decodeSecret(`${'A'.repeat(42)}E`)).toBeDefined();
  });
  test('typed phrases compare without case or extra spacing', () => {
    expect(normalPhrase('  Coach  CLOCK\tcider-lake ')).toBe('coach clock cider lake');
  });
  test('names lose controls and bidi overrides and are capped', () => {
    expect(pairingName('Ro\u202Ebin\u0007 \n Lee')).toBe('Robin Lee');
    expect([...pairingName('é'.repeat(100))].length).toBe(64);
  });
  test('the link carries the agreed fields only', () => {
    const rooms = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
    const link = new URL(pairLink({ origin: 'https://rooms.example', name: 'Robin Lee', device: BROWSER, rooms: [...rooms, rooms[0]], secret: ZERO }));
    expect(link.protocol).toBe('meshrooms:');
    expect([...link.searchParams.keys()]).toEqual(['v', 'origin', 'name', 'device', 'rooms', 'secret']);
    expect(link.searchParams.get('v')).toBe('2');
    expect(link.searchParams.get('device')).toBe(BROWSER);
    expect(link.searchParams.get('origin')).toBe('https://rooms.example');
    expect(link.searchParams.get('name')).toBe('Robin Lee');
    expect(link.searchParams.get('rooms')).toBe(rooms.join(','));
    expect(link.searchParams.get('secret')).toBe(encodeSecret(ZERO));
  });
});
