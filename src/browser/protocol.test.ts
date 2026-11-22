import { describe, expect, test } from 'bun:test';
import { cleanDisplayName, deviceFingerprint, foldDisplayName, MIN_PROTOCOL_VERSION, PROTOCOL_HEADER, PROTOCOL_VERSION, signerOf, UPGRADE_REQUIRED, type FormerDevice } from './protocol';

describe('who may still sign a relayed record', () => {
  const current = { id: 'now', publicKey: 'k-now', memberId: 'sam', label: 'Desktop', admittedAt: 1 };
  const left: FormerDevice = { id: 'left', publicKey: 'k-left', memberId: 'sam', retiredAt: 1000 };
  const revoked: FormerDevice = { id: 'lost', publicKey: 'k-lost', memberId: 'sam', retiredAt: 1000, revoked: true };
  const legacy: FormerDevice = { id: 'old', publicKey: 'k-old', memberId: 'sam' };
  const status = { devices: [current], formerDevices: [left, revoked, legacy] };

  test('a device in the room signs at any time', () => {
    expect(signerOf(status, 'now', 5000)?.publicKey).toBe('k-now');
  });
  test('a device that left from itself signs up to when it left', () => {
    expect(signerOf(status, 'left', 1000)?.publicKey).toBe('k-left');
    expect(signerOf(status, 'left', 1001)).toBeUndefined();
    expect(signerOf(status, 'left', 'soon')).toBeUndefined();
  });
  test('a revoked device signs nothing more, even dated before its removal', () => {
    expect(signerOf(status, 'lost', 1)).toBeUndefined();
  });
  test('a former device kept before removals were stamped verifies as before', () => {
    expect(signerOf(status, 'old', 9e15)?.publicKey).toBe('k-old');
  });
  test('an unknown device, or no status yet, signs nothing', () => {
    expect(signerOf(status, 'stranger', 1)).toBeUndefined();
    expect(signerOf(undefined, 'now', 1)).toBeUndefined();
  });
});

describe('SEC-8 display-name normalization and device fingerprints', () => {
  test('cleanDisplayName normalizes NFKC, strips control/format/bidi/zero-width chars, and collapses whitespace', () => {
    expect(cleanDisplayName('  Alex   Smith  ')).toBe('Alex Smith');
    expect(cleanDisplayName('Ａｌｅｘ')).toBe('Alex');
    expect(cleanDisplayName('A\u200blex\u200c\u200d\ufeff')).toBe('Alex');
    expect(cleanDisplayName('\u202eAlex\u202c')).toBe('Alex');
    expect(cleanDisplayName('A\u0000l\u001fe\u007fx')).toBe('Alex');
    expect(cleanDisplayName('cafe\u0301')).toBe('café');
    expect(cleanDisplayName(' \u200b\u202e\u2066\t\n ')).toBe('');
  });
  test('foldDisplayName produces matching keys for spoofing variants', () => {
    const base = foldDisplayName('Alex');
    expect(base).toBe('alex');
    expect(foldDisplayName('ALEX')).toBe(base);
    expect(foldDisplayName('  ＡＬＥＸ  ')).toBe(base);
    expect(foldDisplayName('A\u200ble\u202ex')).toBe(base);
    expect(foldDisplayName('Alex  Smith')).toBe(foldDisplayName('alex smith'));
  });
  test('deviceFingerprint formats deterministic XXXX-XXXX uppercase hex from deviceId', () => {
    expect(deviceFingerprint('a1b2c3d4e5f6070899aabbccddeeff00')).toBe('A1B2-C3D4');
    expect(deviceFingerprint('deadbeef12345678')).toBe('DEAD-BEEF');
    expect(deviceFingerprint('a1b2c3d4e5f6070899aabbccddeeff00')).toBe(deviceFingerprint('a1b2c3d4e5f6070899aabbccddeeff00'));
    expect(deviceFingerprint('abcd')).toBe('ABCD');
  });
  test('OPS-6 protocol compatibility constants are exported', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(MIN_PROTOCOL_VERSION).toBe(1);
    expect(PROTOCOL_HEADER).toBe('x-meshrooms-protocol');
    expect(UPGRADE_REQUIRED).toBe('upgrade-required');
  });
});
