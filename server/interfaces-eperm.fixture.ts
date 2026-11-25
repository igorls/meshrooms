/**
 * Run by interfaces.test.ts in its own process (it replaces os.networkInterfaces for the whole process): two werift
 * connections in a process where listing network interfaces fails with EPERM, as in a sandbox that denies getifaddrs.
 * The answering side gets the offer with an extra `.local` host candidate, as a browser sends, which makes werift start
 * an mDNS lookup. Usage: bun interfaces-eperm.fixture.ts guard|raw [TURN_URL USER PASSWORD]
 * Exits 0 once a message crossed the data channel; prints `open <ms>` then.
 */
import os from 'node:os';
import { guardNetworkInterfaces, interfacesUnavailable, withoutMdnsCandidates } from './interfaces';

const [mode, turn, username, credential] = process.argv.slice(2);
os.networkInterfaces = (() => {
  throw Object.assign(new Error('A system error occurred: uv_interface_addresses returned EPERM'), { code: 'EPERM' });
}) as typeof os.networkInterfaces;
if (mode === 'guard') guardNetworkInterfaces(line => console.log(line));
const { RTCPeerConnection } = await import('werift');
const relayOnly = interfacesUnavailable();
const config = { iceServers: turn ? [{ urls: turn, username, credential }] : [], ...(relayOnly && turn ? { iceTransportPolicy: 'relay' as const } : {}) };
const a = new RTCPeerConnection(config), b = new RTCPeerConnection(config);
const started = Date.now();
const channel = a.createDataChannel('meshrooms');
channel.stateChanged.subscribe(state => { if (state === 'open') channel.send('hello'); });
b.onDataChannel.subscribe(c => c.onMessage.subscribe(() => { console.log(`open ${Date.now() - started}`); process.exit(0); }));
await a.setLocalDescription(await a.createOffer());
const offer = a.localDescription!.sdp.replace(/(a=candidate:[^\r\n]*\r\n)/,
  '$1a=candidate:9 1 udp 2122260223 0b1c2d3e-0000-4000-8000-1234567890ab.local 50000 typ host generation 0\r\n');
for (const line of offer.match(/a=candidate:[^\r\n]*/g) ?? []) console.log(`offered ${line.split(' ').slice(4, 8).join(' ')}`);
await b.setRemoteDescription({ type: 'offer', sdp: relayOnly ? withoutMdnsCandidates(offer).sdp : offer } as any);
await b.setLocalDescription(await b.createAnswer());
await a.setRemoteDescription(b.localDescription as any);
setTimeout(() => { console.log(`no channel: ${a.connectionState}`); process.exit(3); }, 25_000);
