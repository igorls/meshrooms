import { describe, expect, test } from 'bun:test';
import { VfsError } from './constants';
import {
  conflictPath,
  foldVfsPath,
  normalizeVfsPath,
  utf8ByteLength,
  validateVfsPath,
  VFS_MAX_PATH_BYTES,
  VFS_MAX_PATH_SEGMENTS,
  VFS_MAX_SEGMENT_CODEPOINTS,
  VfsPathError,
} from './path';

describe('VFS path validation & normalization (path.ts)', () => {
  test('accepts canonical relative POSIX paths up to exact boundary limits', () => {
    const valid = [
      'spec.md',
      'README',
      'docs/architecture/room-vfs.md',
      '.gitignore',
      '.env.example',
      'a/b/c/d/e/f/g/h', // exact 8 segments
      'CONSOLE.md', // not Windows reserved CON
      'COM10.txt', // only COM1-COM9 reserved
      'LPT0.md', // only LPT1-LPT9 reserved
      'my.con', // extension only, not base name
      'notes (draft) [v2] #1.md',
      'docs/日本語/🚀-launch.md',
      'a'.repeat(VFS_MAX_SEGMENT_CODEPOINTS), // exact 80 code points
      '😀'.repeat(60), // 60 code points, exact 240 UTF-8 bytes
      `${'a'.repeat(80)}/${'b'.repeat(80)}/${'c'.repeat(78)}`, // 80+1+80+1+78 = 240 UTF-8 bytes
    ];

    for (const p of valid) {
      const res = validateVfsPath(p);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.normalized).toBe(p.normalize('NFC'));
        expect(res.byteLength).toBeLessThanOrEqual(VFS_MAX_PATH_BYTES);
        expect(res.segments.length).toBeLessThanOrEqual(VFS_MAX_PATH_SEGMENTS);
      }
      expect(normalizeVfsPath(p)).toBe(p.normalize('NFC'));
    }
  });

  test('normalizes NFD to NFC and folds case consistently', () => {
    const nfd = 'docs/cafe\u0301.md';
    const nfc = 'docs/caf\u00e9.md';
    expect(nfd).not.toBe(nfc);
    expect(normalizeVfsPath(nfd)).toBe(nfc);
    expect(foldVfsPath(normalizeVfsPath('Docs/CAFE\u0301.MD'))).toBe(foldVfsPath(nfc));

    // NFD string exceeding 240 bytes that shrinks <= 240 bytes after NFC should pass
    // Each `e\u0301` is 3 UTF-8 bytes in NFD, 2 UTF-8 bytes in NFC.
    // 79 * 3 = 237 + 1 + 2 = 240... try 2 segments of 60 `e\u0301` -> NFD 361 B, NFC 241 B (fails)
    // vs 59 + 60 `e\u0301` -> NFD 358 B, NFC 239 B (passes!)
    const nfdFitsInNfc = `${'e\u0301'.repeat(59)}/${'e\u0301'.repeat(60)}`;
    expect(utf8ByteLength(nfdFitsInNfc)).toBeGreaterThan(VFS_MAX_PATH_BYTES);
    const res = validateVfsPath(nfdFitsInNfc);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.byteLength).toBe(239);
    }
  });

  test('rejects empty paths, leading/trailing slashes, empty segments, and dot segments', () => {
    const bad = [
      '',
      '/',
      '/spec.md',
      'spec.md/',
      'docs//spec.md',
      'docs///spec.md',
      '.',
      '..',
      './spec.md',
      '../spec.md',
      'docs/./spec.md',
      'docs/../spec.md',
      'docs/..',
    ];

    for (const p of bad) {
      const res = validateVfsPath(p);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('VFS_INVALID_PATH');
      let caught: unknown;
      try {
        normalizeVfsPath(p);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(VfsPathError);
      expect(caught).toBeInstanceOf(VfsError);
      expect((caught as VfsPathError).code).toBe('VFS_INVALID_PATH');
    }
  });

  test('rejects NUL, Cc/Cf controls, zero-width chars, bidi overrides, line separators, and lone surrogates', () => {
    const bad = [
      'a\0b.md',
      'a\tb.md',
      'a\nb.md',
      'a\rb.md',
      'a\x1fb.md',
      'a\x7fb.md',
      'a\u0085b.md', // NEL (Cc)
      'a\u200Bb.md', // ZWSP (Cf)
      'a\u200Db.md', // ZWJ (Cf)
      'a\uFEFFb.md', // BOM (Cf)
      'a\u00ADb.md', // soft hyphen (Cf)
      'a\u202Ab.md', // LRE
      'a\u202Bb.md', // RLE
      'a\u202Cb.md', // PDF
      'a\u202Db.md', // LRO
      'invoice-\u202Egpj.exe', // RLO spoofing
      'a\u2066b.md', // LRI
      'a\u2067b.md', // RLI
      'a\u2068b.md', // FSI
      'a\u2069b.md', // PDI
      'a\u200Eb.md', // LRM
      'a\u200Fb.md', // RLM
      'a\u061Cb.md', // ALM
      'a\u2028b.md', // Line Separator
      'a\u2029b.md', // Paragraph Separator
      'bad\uD800.md', // lone high surrogate
      'bad\uDFFF.md', // lone low surrogate
      'a\u3164b.md', // Hangul Filler
      'a\u034Fb.md', // Combining Grapheme Joiner
      'a\uFE00b.md', // Variation Selector-1
      'a\uFE0Fb.md', // Variation Selector-16
      'a\u{E0100}b.md', // Variation Selector Supplement start
      'a\u{E01EF}b.md', // Variation Selector Supplement end
      'a\u00A0b.md', // NBSP
      'a\u2800b.md', // Braille Pattern Blank
      'a\uFFA0b.md', // Halfwidth Hangul Filler
      'a\u115Fb.md', // Hangul Choseong Filler
      'a\u1160b.md', // Hangul Jungseong Filler
    ];

    for (const p of bad) {
      const res = validateVfsPath(p);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('VFS_INVALID_PATH');
    }
  });

  test('rejects forbidden chars and leading/trailing spaces or trailing dots on any segment', () => {
    const bad = [
      'a\\b.md',
      'a:b.md',
      'a*b.md',
      'a?b.md',
      'a"b.md',
      'a<b.md',
      'a>b.md',
      'a|b.md',
      'spec.md.',
      'docs./spec.md',
      'spec.md ',
      'docs /spec.md',
      ' spec.md',
      'docs/ spec.md',
      '...',
    ];

    for (const p of bad) {
      const res = validateVfsPath(p);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('VFS_INVALID_PATH');
    }
  });

  test('rejects Windows reserved device names with or without extensions (case-insensitive)', () => {
    const names = [
      'CON', 'CONIN$', 'CONOUT$', 'PRN', 'AUX', 'NUL',
      'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
      'COM\u00B9', 'COM\u00B2', 'COM\u00B3',
      'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
      'LPT\u00B9', 'LPT\u00B2', 'LPT\u00B3',
    ];
    for (const n of names) {
      for (const variant of [n, n.toLowerCase(), `${n}.txt`, `${n.toLowerCase()}.tar.gz`, `docs/${n}.md`]) {
        const res = validateVfsPath(variant);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.code).toBe('VFS_INVALID_PATH');
          expect(res.reason).toBe('windows-reserved-name');
        }
      }
    }
  });

  test('rejects reserved .meshrooms and .git prefixes (case-insensitive)', () => {
    const bad = [
      '.meshrooms',
      '.meshrooms/a',
      '.MESHROOMS/config.json',
      '.git',
      '.git/HEAD',
      '.Git/config',
      'nested/.git/hooks',
      'nested/.meshrooms/state',
    ];
    for (const p of bad) {
      const res = validateVfsPath(p);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe('VFS_INVALID_PATH');
        expect(res.reason).toBe('reserved-prefix');
      }
    }
  });

  test('enforces 240 UTF-8 byte cap, 8-segment cap, and 80 code-point segment cap', () => {
    // 241 UTF-8 bytes (ASCII)
    const over240Ascii = `${'a'.repeat(80)}/${'b'.repeat(80)}/${'c'.repeat(79)}`;
    expect(utf8ByteLength(over240Ascii)).toBe(241);
    expect(validateVfsPath(over240Ascii).ok).toBe(false);

    // 244 UTF-8 bytes (61 4-byte emoji = 61 code points, <= 80 cp, but > 240 bytes)
    const over240Emoji = '😀'.repeat(61);
    expect(utf8ByteLength(over240Emoji)).toBe(244);
    expect(validateVfsPath(over240Emoji).ok).toBe(false);

    // 9 segments
    expect(validateVfsPath('a/b/c/d/e/f/g/h/i').ok).toBe(false);

    // 81 code points in a segment
    expect(validateVfsPath('x'.repeat(81)).ok).toBe(false);
    expect(validateVfsPath('é'.repeat(81)).ok).toBe(false);
  });

  test('conflictPath produces deterministic collision paths preserving extensions and clamping limits', () => {
    const nodeId = 'a1b2c3d4-e5f6-4789-abcd-0123456789ab';
    const nodeIdSamePrefix4 = 'a1b2ffff-e5f6-4789-abcd-0123456789ab';

    expect(conflictPath('spec.md', nodeId)).toBe('spec (conflict-a1b2c3d4).md');
    expect(conflictPath('spec.md', nodeIdSamePrefix4)).toBe('spec (conflict-a1b2ffff).md');
    expect(conflictPath('spec.md', nodeId)).not.toBe(conflictPath('spec.md', nodeIdSamePrefix4));
    expect(conflictPath('README', nodeId)).toBe('README (conflict-a1b2c3d4)');
    expect(conflictPath('docs/notes.md', nodeId)).toBe('docs/notes (conflict-a1b2c3d4).md');
    expect(conflictPath('archive.tar.gz', nodeId)).toBe('archive.tar (conflict-a1b2c3d4).gz');
    expect(conflictPath('.gitignore', nodeId)).toBe('.gitignore (conflict-a1b2c3d4)');
    expect(conflictPath('docs/cafe\u0301.md', nodeId)).toBe('docs/caf\u00e9 (conflict-a1b2c3d4).md');

    // Exact 80-code-point segment -> clamps stem while preserving extension
    const maxSeg = `${'a'.repeat(77)}.md`;
    const maxSegConflict = conflictPath(maxSeg, nodeId);
    expect(maxSegConflict.endsWith(' (conflict-a1b2c3d4).md')).toBe(true);
    expect(Array.from(maxSegConflict).length).toBe(80);
    expect(validateVfsPath(maxSegConflict).ok).toBe(true);

    // Exact 240-byte emoji leaf -> clamps whole emoji without breaking surrogates
    const emoji240 = '😀'.repeat(60);
    const emojiConflict = conflictPath(emoji240, nodeId);
    expect(emojiConflict.endsWith(' (conflict-a1b2c3d4)')).toBe(true);
    expect(utf8ByteLength(emojiConflict)).toBeLessThanOrEqual(VFS_MAX_PATH_BYTES);
    expect(validateVfsPath(emojiConflict).ok).toBe(true);

    // Extreme 240-byte nested path where parent dirs consume 236 bytes
    const deep240 = `${'a'.repeat(79)}/${'b'.repeat(79)}/${'c'.repeat(75)}/x.md`;
    expect(utf8ByteLength(deep240)).toBe(240);
    const deepConflict = conflictPath(deep240, nodeId);
    expect(utf8ByteLength(deepConflict)).toBeLessThanOrEqual(VFS_MAX_PATH_BYTES);
    expect(validateVfsPath(deepConflict).ok).toBe(true);
    expect(deepConflict).toContain('conflict-a1b2c3d4');

    // Pathological nodeId with unsafe chars stays valid
    const weirdConflict = conflictPath('spec.md', '../!@#');
    expect(validateVfsPath(weirdConflict).ok).toBe(true);
    expect(weirdConflict).toBe('spec (conflict-00000000).md');
  });
});
