import { describe, expect, test } from 'bun:test';
import { typedOfferCode } from './PhoneCode';

describe('the code field on the phone', () => {
  test('shows what is typed as XXXXX-XXXXX, upper case, without anything that cannot be in a code', () => {
    expect(typedOfferCode('')).toBe('');
    expect(typedOfferCode('k7m2')).toBe('K7M2');
    expect(typedOfferCode('k7m2p')).toBe('K7M2P');
    expect(typedOfferCode('k7m2p9')).toBe('K7M2P-9');
    expect(typedOfferCode(' k7m2p-9xq4d ')).toBe('K7M2P-9XQ4D');
    expect(typedOfferCode('K7M2P-9XQ4D-EXTRA')).toBe('K7M2P-9XQ4D');
    expect(typedOfferCode('k7m2p9xq4d')).toBe('K7M2P-9XQ4D');
  });
  test('reads look-alikes as Crockford does and drops the letter U', () => {
    expect(typedOfferCode('oil-ooo')).toBe('01100-0');
    expect(typedOfferCode('u7u7')).toBe('77');
    expect(typedOfferCode('!!K7**')).toBe('K7');
  });
});
