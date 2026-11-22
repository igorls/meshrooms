import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The per-address map in deploy/nginx/meshrooms-limits.conf, run the way nginx runs it: the first matching regex wins
// (`~*` ignores case), and its replacement is the key. Nginx writes $remote_addr for IPv6 in RFC 5952 form (lower
// case, no leading zeros, the longest run of two or more zero groups shortened to `::`), the same form the WHATWG URL
// parser gives, so the addresses below are written that way.
const conf = readFileSync(new URL('../deploy/nginx/meshrooms-limits.conf', import.meta.url), 'utf8');
const block = /map \$remote_addr \$meshrooms_addr_key \{([\s\S]*?)\n\}/.exec(conf)![1];
const rules = block.split('\n').map(line => line.trim()).filter(line => line.startsWith('~')).map(line => {
  const [pattern, replacement] = line.replace(/;$/, '').split(/\s+/);
  const insensitive = pattern.startsWith('~*');
  return { regex: new RegExp(pattern.slice(insensitive ? 2 : 1), insensitive ? 'i' : ''), replacement };
});
const key = (address: string) => {
  for (const { regex, replacement } of rules) {
    const match = regex.exec(address);
    if (match) return replacement.replace(/\$(\d)/g, (_, n) => match[Number(n)]);
  }
  return undefined; // the map's default, $binary_remote_addr
};
const canonical = (groups: number[]) => new URL(`http://[${groups.map(g => g.toString(16)).join(':')}]`).hostname.slice(1, -1);
const prefix = (groups: number[]) => `${groups.slice(0, 4).map(g => g.toString(16)).join(':')}::/64`;

describe('nginx per-address key', () => {
  test('IPv4, and IPv4-mapped IPv6, key by address', () => {
    expect(key('203.0.113.7')).toBe('203.0.113.7');
    expect(key('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  test('every IPv6 address keys by its /64, wherever its zero groups are', () => {
    // Each group is zero or not, in all 256 patterns, with several values: every place `::` can fall in RFC 5952 form.
    let random = 7;
    const next = () => (random = (random * 1103515245 + 12345) % 2 ** 31) % 0xffff + 1;
    for (let pattern = 0; pattern < 256; pattern++) for (let round = 0; round < 4; round++) {
      const groups = Array.from({ length: 8 }, (_, i) => pattern & (1 << i) ? next() : 0);
      const address = canonical(groups);
      expect({ address, key: key(address) }).toEqual({ address, key: prefix(groups) });
    }
  });

  test('addresses in one /64 share a key, and a neighbouring /64 does not', () => {
    const a = [0x2001, 0xdb8, 0, 0], b = [0x2001, 0xdb8, 0, 1];
    expect(key(canonical([...a, 1, 2, 3, 4]))).toBe(key(canonical([...a, 0, 0, 0, 9])));
    expect(key(canonical([...a, 1, 2, 3, 4]))).not.toBe(key(canonical([...b, 1, 2, 3, 4])));
  });
});
