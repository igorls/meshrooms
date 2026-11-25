import { afterEach, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { INTERFACES_UNAVAILABLE, guardNetworkInterfaces, interfacesUnavailable, withoutMdnsCandidates } from './interfaces';

const eperm = () => { throw Object.assign(new Error('A system error occurred: uv_interface_addresses returned EPERM'), { code: 'EPERM' }); };
const listing = { lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }] };

test('listing interfaces that fails returns none, says relay-only once, and stays guarded', () => {
  const target = { networkInterfaces: eperm as any };
  const logs: string[] = [];
  expect(guardNetworkInterfaces(line => logs.push(line), target)).toBe(false);
  expect(logs).toEqual([`${INTERFACES_UNAVAILABLE} (listing network interfaces failed: EPERM)`]);
  expect(target.networkInterfaces()).toEqual({});
  expect(target.networkInterfaces()).toEqual({});
  expect(logs).toHaveLength(1);
  expect(interfacesUnavailable(target)).toBe(true);
  // A second runner in the same process wraps nothing again and is told too.
  const wrapper = target.networkInterfaces;
  expect(guardNetworkInterfaces(line => logs.push(line), target)).toBe(false);
  expect(target.networkInterfaces).toBe(wrapper);
  expect(logs).toHaveLength(2);
});

test('listing interfaces that works is left alone, and a later failure is reported once', () => {
  let fail = false;
  const target = { networkInterfaces: (() => { if (fail) eperm(); return listing; }) as any };
  const logs: string[] = [];
  expect(guardNetworkInterfaces(line => logs.push(line), target)).toBe(true);
  expect(target.networkInterfaces()).toEqual(listing);
  expect(interfacesUnavailable(target)).toBe(false);
  expect(logs).toEqual([]);
  fail = true;
  expect(target.networkInterfaces()).toEqual({});
  expect(target.networkInterfaces()).toEqual({});
  expect(logs).toEqual([`${INTERFACES_UNAVAILABLE} (listing network interfaces failed: EPERM)`]);
  expect(interfacesUnavailable(target)).toBe(true);
  expect(interfacesUnavailable({ networkInterfaces: (() => listing) as any })).toBe(false);
});

test('mDNS candidates are dropped from a description and every other line is kept as it was', () => {
  const sdp = ['v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=mid:0',
    'a=candidate:1 1 udp 2122260223 0b1c2d3e-0000-4000-8000-1234567890ab.local 50000 typ host generation 0',
    'a=candidate:2 1 udp 2 203.0.113.9 49200 typ relay raddr 0.0.0.0 rport 0',
    'a=candidate:3 1 tcp 1518280447 ABCDEF.LOCAL 9 typ host tcptype active',
    'a=candidate:4 1 udp 1686052607 198.51.100.7 61000 typ srflx raddr 0.0.0.0 rport 0', ''].join('\r\n');
  const { sdp: out, dropped } = withoutMdnsCandidates(sdp);
  expect(dropped).toBe(2);
  expect(out).toBe(['v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=mid:0',
    'a=candidate:2 1 udp 2 203.0.113.9 49200 typ relay raddr 0.0.0.0 rport 0',
    'a=candidate:4 1 udp 1686052607 198.51.100.7 61000 typ srflx raddr 0.0.0.0 rport 0', ''].join('\r\n'));
  expect(withoutMdnsCandidates('v=0\na=mid:0\n')).toEqual({ sdp: 'v=0\na=mid:0\n', dropped: 0 });
});

const fixture = join(import.meta.dir, 'interfaces-eperm.fixture.ts');
const run = (...args: string[]) => spawnSync(process.execPath, [fixture, ...args], { encoding: 'utf8', timeout: 40_000 });

// The crash a cloud sandbox hit: a browser's `.local` candidate starts an mDNS lookup, and multicast-dns lists the
// interfaces in a socket callback, where EPERM escapes and ends the process.
test('without the guard, EPERM from listing interfaces ends the process once a .local candidate arrives', () => {
  const out = run('raw');
  expect(out.status).not.toBe(0);
  expect(out.stderr).toContain('EPERM');
  expect(out.stderr).toContain('allInterfaces');
}, 45_000);

test('with the guard, the same connection opens and the process says it is relay-only', () => {
  const out = run('guard');
  expect(out.stdout).toContain(INTERFACES_UNAVAILABLE);
  expect(out.stdout).toMatch(/^open \d+$/m);
  expect(out.status).toBe(0);
}, 45_000);

// End to end through a TURN server over TCP, where one is installed (coturn's turnserver); CI may not have one.
const turnserver = Bun.which('turnserver');
let turn: ChildProcess | undefined;
afterEach(() => { turn?.kill(); turn = undefined; });
test.skipIf(!turnserver)('with the guard and no interfaces, a relay-only connection opens through TURN over TCP', async () => {
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  turn = spawn(turnserver!, ['-n', '--listening-ip=127.0.0.1', `--listening-port=${port}`, '--relay-ip=127.0.0.1', '--no-udp', '--no-tls',
    '--no-dtls', '--lt-cred-mech', '--user=meshrooms:test', '--realm=meshrooms.test', '--allow-loopback-peers', '--no-cli'], { stdio: 'ignore' });
  await Bun.sleep(500);
  const out = run('guard', `turn:127.0.0.1:${port}?transport=tcp`, 'meshrooms', 'test');
  expect(out.stdout).toContain(INTERFACES_UNAVAILABLE);
  const offered = out.stdout.split('\n').filter(line => line.startsWith('offered '));
  expect(offered.filter(line => line.includes('typ relay')).length).toBeGreaterThan(0);
  expect(offered.filter(line => line.includes('typ host') && !line.includes('.local'))).toEqual([]);
  expect(out.stdout).toMatch(/^open \d+$/m);
  expect(out.status).toBe(0);
}, 45_000);
