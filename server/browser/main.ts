import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { BrowserLobby } from './lobby';
import { browserHandler } from './http';
import { browserConfig } from './config';
import { admissionPath } from './store';
import { backupFreshness } from './backup-status';
import { acquireInstance } from '../instance';

const config = browserConfig();
mkdirSync(config.dataDir, { recursive: true });
const release = acquireInstance(config.dataDir);
const lobby = new BrowserLobby(admissionPath(config.dataDir), { origin: config.origin,
  stunUrls: config.stunUrls, turnUrls: config.turnUrls, turnSecret: config.turnSecret,
  maxRooms: config.maxRooms, invites: config.invites, idleDays: config.idleDays });
const handle = browserHandler(lobby, config.origin, resolve('dist'), {
  trustLoopbackProxy: config.trustLoopbackProxy,
  apiLimit: config.trustLoopbackProxy ? 1200 : 240,
  revision: config.revision,
  backupFresh: config.backupMaxAgeHours ? backupFreshness(config.dataDir, config.backupMaxAgeHours) : undefined,
});
/** Idle rooms are removed at start and then hourly. */
const sweep = () => {
  try { const removed = lobby.sweep(); if (removed) console.log(JSON.stringify({ time: new Date().toISOString(), event: 'sweep', removed })); }
  catch (error) { console.log(JSON.stringify({ time: new Date().toISOString(), event: 'error', status: 500, route: 'sweep', message: (error as Error).message, stack: (error as Error).stack })); }
};
sweep();
const sweeping = setInterval(sweep, 3_600_000);
const server = Bun.serve({ hostname: '127.0.0.1', port: config.port, maxRequestBodySize: 24_000,
  fetch: (request, server) => handle(request, server.requestIP(request)?.address || 'unknown') });
console.log(`Browser rooms: ${config.origin}/rooms (listening on loopback port ${server.port}; room creation ${config.invites === 'required' ? 'needs an invite code' : 'is open'}; up to ${config.maxRooms} rooms, removed after ${config.idleDays} idle days)`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { clearInterval(sweeping); server.stop(true); lobby.close(); release(); process.exit(0); });
