/**
 * A small QR Code encoder (ISO/IEC 18004, byte mode, levels L and M, versions 1-40) with no dependency: the pairing
 * dialog draws the code as one SVG path, so nothing is canvas-rendered, fetched or stored. The structure follows the
 * standard: data and error-correction codewords (Reed-Solomon over GF(256), polynomial 0x11D), interleaved, placed in
 * the zigzag, masked with the mask of lowest penalty, then format and version information.
 */
export type QrLevel = 'L' | 'M';
export type QrMatrix = boolean[][];

// Blocks and error-correction codewords in total per version, from the standard's tables (index = version - 1).
const BLOCKS = { L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49] };
const ECC = { L: [7, 10, 15, 20, 26, 36, 40, 48, 60, 72, 80, 96, 104, 120, 132, 144, 168, 180, 196, 224, 224, 252, 270, 300, 312, 336, 360, 390, 420, 450, 480, 510, 540, 570, 570, 600, 630, 660, 720, 750],
  M: [10, 16, 26, 36, 48, 64, 72, 88, 110, 130, 150, 176, 198, 216, 240, 280, 308, 338, 364, 416, 442, 476, 504, 560, 588, 644, 700, 728, 784, 812, 868, 924, 980, 1036, 1064, 1120, 1204, 1260, 1316, 1372] };
const FORMAT_BITS = { L: 1, M: 0 };

const sizeOf = (version: number) => 4 * version + 17;
function rawCodewords(version: number) {
  let modules = (16 * version + 128) * version + 64;
  if (version >= 2) { const n = Math.floor(version / 7) + 2; modules -= (25 * n - 10) * n - 55; if (version >= 7) modules -= 36; }
  return Math.floor(modules / 8);
}
const dataCodewords = (version: number, level: QrLevel) => rawCodewords(version) - ECC[level][version - 1];
function alignmentPositions(version: number) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2, size = sizeOf(version);
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let p = size - 7; positions.length < count; p -= step) positions.splice(1, 0, p);
  return positions;
}

function multiply(x: number, y: number) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z;
}
function divisor(degree: number) {
  const result = new Array<number>(degree).fill(0); result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) { result[j] = multiply(result[j], root); if (j + 1 < degree) result[j] ^= result[j + 1]; }
    root = multiply(root, 2);
  }
  return result;
}
function remainder(data: number[], poly: number[]) {
  const result = poly.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!; result.push(0);
    poly.forEach((coefficient, i) => { result[i] ^= multiply(coefficient, factor); });
  }
  return result;
}

/** Bytes of `text` as UTF-8 in byte mode, padded to the version's capacity. */
function dataBits(bytes: Uint8Array, version: number, level: QrLevel) {
  const bits: number[] = [], put = (value: number, length: number) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0100, 4); put(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) put(byte, 8);
  const capacity = dataCodewords(version, level) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - bits.length % 8) % 8);
  const words: number[] = [];
  for (let i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; words.length < capacity / 8; pad ^= 0xec ^ 0x11) words.push(pad);
  return words;
}
function interleave(data: number[], version: number, level: QrLevel) {
  const blocks = BLOCKS[level][version - 1], eccTotal = ECC[level][version - 1], raw = rawCodewords(version);
  const shortBlocks = blocks - raw % blocks, shortLength = Math.floor(raw / blocks), eccLength = eccTotal / blocks, poly = divisor(eccLength);
  const parts: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const block = data.slice(k, k + shortLength - eccLength + (i < shortBlocks ? 0 : 1)); k += block.length;
    const ecc = remainder(block, poly);
    if (i < shortBlocks) block.push(0);
    parts.push(block.concat(ecc));
  }
  const result: number[] = [];
  for (let i = 0; i < parts[0].length; i++) parts.forEach((block, j) => { if (i !== shortLength - eccLength || j >= shortBlocks) result.push(block[i]); });
  return result;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0, (_, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
  (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0,
];

function penalty(m: QrMatrix) {
  const size = m.length; let total = 0;
  const lineScore = (get: (i: number) => boolean) => {
    let score = 0, run = 1;
    for (let i = 1; i < size; i++) { if (get(i) === get(i - 1)) { run++; if (run === 5) score += 3; else if (run > 5) score++; } else run = 1; }
    // Patterns that look like a finder (1:1:3:1:1 with four light modules on a side).
    for (let i = 0; i + 11 <= size; i++) {
      const w = (k: number) => get(i + k);
      if (w(0) && !w(1) && w(2) && w(3) && w(4) && !w(5) && w(6) && !w(7) && !w(8) && !w(9) && !w(10)) score += 40;
      if (!w(0) && !w(1) && !w(2) && !w(3) && w(4) && !w(5) && w(6) && w(7) && w(8) && !w(9) && w(10)) score += 40;
    }
    return score;
  };
  for (let i = 0; i < size; i++) { total += lineScore(j => m[i][j]); total += lineScore(j => m[j][i]); }
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) total += 3;
  const dark = m.reduce((n, row) => n + row.filter(Boolean).length, 0);
  total += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return total;
}

/** The module matrix (true = dark) for `text`. `mask` forces one mask pattern (0-7); left out, the best one is picked. */
export function qrMatrix(text: string, level: QrLevel = 'M', mask?: number): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (version <= 40 && 4 + (version < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(version, level) * 8) version++;
  if (version > 40) throw new Error('Too much data for a QR code.');
  const size = sizeOf(version);
  const modules: QrMatrix = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => { modules[y][x] = dark; reserved[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  }
  const align = alignmentPositions(version);
  for (let i = 0; i < align.length; i++) for (let j = 0; j < align.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const format = (selected: number) => {
    const data = (FORMAT_BITS[level] << 3) | selected; let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412, bit = (i: number) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format(0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) { const dark = ((bits >>> i) & 1) !== 0, a = size - 11 + i % 3, b = Math.floor(i / 3); set(a, b, dark); set(b, a, dark); }
  }
  // The codewords, two columns at a time from the right, up and down in turn, skipping the timing column.
  const codewords = interleave(dataBits(bytes, version, level), version, level);
  let bit = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - v : v;
      if (!reserved[y][x] && bit < codewords.length * 8) { modules[y][x] = ((codewords[bit >>> 3] >>> (7 - (bit & 7))) & 1) !== 0; bit++; }
    }
  }
  const apply = (selected: number) => {
    const out = modules.map(row => row.slice());
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!reserved[y][x] && MASKS[selected](x, y)) out[y][x] = !out[y][x];
    return out;
  };
  let best = mask ?? 0, result = apply(best);
  if (mask === undefined) {
    let lowest = Infinity;
    for (let selected = 0; selected < 8; selected++) {
      // The score is taken with the format bits of that mask drawn in.
      format(selected); const candidate = apply(selected), score = penalty(candidate);
      if (score < lowest) { lowest = score; best = selected; result = candidate; }
    }
  }
  format(best);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (reserved[y][x]) result[y][x] = modules[y][x];
  return result;
}

/** One SVG path (modules as unit squares, row runs merged) for a matrix, with a viewBox of the matrix size. */
export function qrPath(matrix: QrMatrix) {
  const parts: string[] = [];
  matrix.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      if (!row[x]) { x++; continue; }
      let end = x; while (end < row.length && row[end]) end++;
      parts.push(`M${x} ${y}h${end - x}v1h${x - end}z`); x = end;
    }
  });
  return parts.join('');
}
