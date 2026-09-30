import { base64, browserProtocol, encode, type Command, type RoomStatus } from '../../src/browser/protocol';
import type { BrowserLobby } from './lobby';

/** Test support: a device with its own signing key, talking to a lobby directly. */
export const testOrigin = 'http://127.0.0.1:4320';

export async function client(lobby: BrowserLobby, clock = () => Date.now(), origin = testOrigin) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = base64(await crypto.subtle.exportKey('raw', keys.publicKey));
  const session = crypto.randomUUID();
  const signed = async (action: Command['action'], roomId: string, payload: Record<string, unknown> = {}) => {
    const command: Command = { protocol: browserProtocol, origin, action, roomId, payload, id: crypto.randomUUID(), at: clock() };
    return { command, publicKey, signature: base64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, encode(command))) };
  };
  const send = async (action: Command['action'], roomId: string, payload = {}) => lobby.execute(await signed(action, roomId, payload));
  return { signed, send, status: async (roomId: string) => await send('status', roomId, { session }) as RoomStatus, session };
}
export type TestClient = Awaited<ReturnType<typeof client>>;

export async function admitPerson(lobby: BrowserLobby, host: TestClient, room: string, name: string, clock = () => Date.now()) {
  const person = await client(lobby, clock);
  await person.send('request', room, { name, label: 'Laptop', kind: 'person' });
  await host.send('decide', room, { requestId: (await host.status(room)).requests!.find(r => r.name === name)!.id, admit: true });
  return person;
}
