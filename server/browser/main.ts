import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { BrowserLobby } from './lobby';
import { browserHandler } from './http';
import { browserConfig } from './config';
import { admissionPath, relayPath } from './store';
import { backupFreshness } from './backup-status';
import { acquireInstance } from '../instance';
import { WakeConnector } from './wake-connector';
import { RELAY_STATE_MAX_BODY_BYTES, RelayService, type RelaySocketData } from './relay';

const config = browserConfig();
mkdirSync(config.dataDir, { recursive: true });
const release = acquireInstance(config.dataDir);
const lobby = new BrowserLobby(admissionPath(config.dataDir), {
  origin: config.origin,
  stunUrls: config.stunUrls,
  turnUrls: config.turnUrls,
  turnSecret: config.turnSecret,
  relayUrl: config.relayUrl,
  relayEnabled: config.relayEnabled,
  maxRooms: config.maxRooms,
  invites: config.invites,
  idleDays: config.idleDays,
});
// The relay is opt-in (MESHROOMS_RELAY_ENABLED=1). Disabled, none of it is built: no relay database is opened, no wake
// registrations exist, and the relay routes answer 404 exactly as they did before it was added.
let relay: RelayService | undefined;
let wakeConnector: WakeConnector | undefined;
if (config.relayEnabled) {
  const relayDbPath = relayPath(config.dataDir);
  wakeConnector = new WakeConnector({
    dbPath: relayDbPath,
    secret: config.relaySecret,
    hostAllowlist: config.wakeAllowlist,
    allowLoopbackHttp: false,
    log: line => console.log(line),
  });
  relay = new RelayService({
    lobby,
    wakeConnector,
    dbPath: relayDbPath,
    log: line => console.log(line),
  });
}
const handle = browserHandler(lobby, config.origin, resolve('dist'), {
  trustLoopbackProxy: config.trustLoopbackProxy,
  apiLimit: config.trustLoopbackProxy ? 1200 : 240,
  revision: config.revision,
  backupFresh: config.backupMaxAgeHours ? backupFreshness(config.dataDir, config.backupMaxAgeHours) : undefined,
  relay,
});
/** Idle rooms are removed at start and then hourly. */
const sweep = () => {
  try { const removed = lobby.sweep(); if (removed) console.log(JSON.stringify({ time: new Date().toISOString(), event: 'sweep', removed })); }
  catch (error) { console.log(JSON.stringify({ time: new Date().toISOString(), event: 'error', status: 500, route: 'sweep', message: (error as Error).message, stack: (error as Error).stack })); }
};
sweep();
const sweeping = setInterval(sweep, 3_600_000);
const serve = {
  hostname: '127.0.0.1',
  port: config.port,
  fetch: (request: Request, srv: Bun.Server<RelaySocketData>) => handle(
    request,
    srv.requestIP(request)?.address || 'unknown',
    (req, data) => srv.upgrade(req, { data }),
  ),
};
// Disabled, the listener keeps its original 24 KB body cap and has no WebSocket handler; the relay's larger caps apply only when it is on.
const server = relay
  ? Bun.serve<RelaySocketData>({ ...serve, maxRequestBodySize: RELAY_STATE_MAX_BODY_BYTES, websocket: relay.websocket })
  : Bun.serve<RelaySocketData>({ ...serve, maxRequestBodySize: 24_000, websocket: { message() {} } });
console.log(`Browser rooms: ${config.origin}/rooms (listening on loopback port ${server.port}; relay ${config.relayEnabled ? config.relayUrl : 'disabled'}; room creation ${config.invites === 'required' ? 'needs an invite code' : 'is open'}; up to ${config.maxRooms} rooms, removed after ${config.idleDays} idle days)`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(sweeping);
    server.stop(true);
    relay?.close();
    wakeConnector?.close();
    lobby.close();
    release();
    process.exit(0);
  });
}
