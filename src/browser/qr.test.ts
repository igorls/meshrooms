import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { qrMatrix, qrPath } from './qr';

const digest = (text: string, level: 'L' | 'M', mask?: number) => createHash('sha256').update(qrMatrix(text, level, mask).map(row => row.map(b => b ? '1' : '0').join('')).join('\n')).digest('hex');

describe('QR encoder', () => {
  // These digests are the matrices another encoder (the `qrcode` package, checked with the jsQR decoder) makes for the same input and mask.
  test('matches known-good matrices byte for byte', () => {
    expect(digest('hello', 'L', 7)).toBe('8f290f882c94ccf82422dd7e34cf9deeb163534da8783af4b8f65ed0f52dc3a0');
    expect(digest('hello', 'M', 0)).toBe('52a7aa67e7296ede539d6be86579c7180e3b6d417445712ae8bd314c1818458a');
    expect(digest(`https://meshrooms.example/rooms#pair=p1.${'x'.repeat(40)}`, 'M', 0)).toBe('33850093e97b315add38033a1af31b7b55f02f748c27c703237827a8f05d2c63');
  });
  test('grows with the data: version 1 is 21 modules, and a long text a larger square', () => {
    expect(qrMatrix('hello', 'M').length).toBe(21);
    expect(qrMatrix('x'.repeat(300), 'M').length).toBe(69);
    expect(qrMatrix('x'.repeat(300), 'L').length).toBeLessThan(69);
    expect(() => qrMatrix('x'.repeat(3000), 'M')).toThrow();
  });
  test('has the fixed patterns: finders, timing, the dark module, and a valid format word', () => {
    const m = qrMatrix('https://meshrooms.example/rooms#pair=abc', 'M'), n = m.length;
    for (const [x, y] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
      for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) expect(m[y + j][x + i]).toBe(Math.max(Math.abs(i - 3), Math.abs(j - 3)) !== 2);
    }
    for (let i = 8; i < n - 8; i++) { expect(m[6][i]).toBe(i % 2 === 0); expect(m[i][6]).toBe(i % 2 === 0); }
    expect(m[n - 8][8]).toBe(true);
    // The 15 format bits (read from the first copy) are a codeword of the BCH(15,5) code, XOR the mask 0x5412.
    let bits = 0; const at: [number, number][] = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
    at.forEach(([x, y], i) => { if (m[y][x]) bits |= 1 << i; });
    const data = ((bits ^ 0x5412) >>> 10) & 31; let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    expect(((data << 10) | rem) ^ 0x5412).toBe(bits);
    expect(data >>> 3).toBe(0); // level M
  });
  test('is deterministic and the path draws exactly the dark modules', () => {
    const a = qrMatrix('same text', 'M'), b = qrMatrix('same text', 'M');
    expect(a).toEqual(b);
    const path = qrPath(a), runs = [...path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)];
    expect(runs.reduce((sum, r) => sum + Number(r[3]), 0)).toBe(a.reduce((n, row) => n + row.filter(Boolean).length, 0));
    expect(path.replace(/M\d+ \d+h\d+v1h-\d+z/g, '')).toBe('');
  });
  test('multi-byte text is encoded as UTF-8', () => {
    expect(qrMatrix('é'.repeat(10), 'M').length).toBe(qrMatrix('x'.repeat(20), 'M').length);
    expect(qrMatrix('é'.repeat(10), 'M').length).toBeGreaterThan(qrMatrix('x'.repeat(10), 'M').length);
  });
});
