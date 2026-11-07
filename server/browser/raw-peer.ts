import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import type { BrowserAgent } from '../browser-agent';

/**
 * Test support: a device on a real data channel to one runner, with no runner of its own, so a test decides exactly
 * which packets arrive and when. It signals the way a runner does: the lower device id offers, nothing is trickled.
 */
export async function rawPeer(agent: BrowserAgent, target: string) {
  const { id } = await agent.ensureIdentity(), session = crypto.randomUUID(), pc = new RTCPeerConnection({ iceServers: [] });
  const heard: any[] = [];
  let channel: RTCDataChannel | undefined, memberId: string | undefined, epoch = '', cursor = 0, started = false, stopped = false;
  const attach = (opened: RTCDataChannel) => { channel = opened; opened.onMessage.subscribe(raw => heard.push(JSON.parse(raw.toString()))); };
  pc.onDataChannel.subscribe(attach);
  const describe = async (offer: boolean, targetSession: string) => {
    await pc.setLocalDescription(offer ? await pc.createOffer() : await pc.createAnswer());
    await Bun.sleep(1000);
    await agent.command('signal', { to: target, session, targetSession, description: { type: pc.localDescription!.type, sdp: pc.localDescription!.sdp } });
  };
  const polling = (async () => {
    while (!stopped) {
      const status = await agent.command('status', { session, epoch, cursor }).catch(() => undefined);
      if (status?.memberId) {
        epoch = status.epoch; memberId = status.memberId;
        for (const signal of status.signals ?? []) {
          cursor = Math.max(cursor, signal.seq);
          if (signal.from !== target) continue;
          await pc.setRemoteDescription(signal.description);
          if (signal.description.type === 'offer' && !started) { started = true; await describe(false, signal.session); }
        }
        const device = status.devices?.find((d: { id: string; session?: string }) => d.id === target && d.session);
        if (device && id < target && !started) { started = true; attach(pc.createDataChannel('meshrooms-browser-v1')); await describe(true, device.session); }
      }
      await Bun.sleep(300);
    }
  })();
  return {
    id, heard,
    get memberId() { return memberId; },
    get open() { return channel?.readyState === 'open'; },
    send(packet: unknown) { channel!.send(JSON.stringify(packet)); },
    async stop() { stopped = true; await polling; await pc.close(); },
  };
}
