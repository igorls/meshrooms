import { existsSync } from 'node:fs';
import { adminHandler } from './admin';
import { admissionPath, dataDirectory, openAdmission } from './store';

const path = admissionPath(dataDirectory());
if (!existsSync(path)) throw new Error('No admission database. Start the coordinator first.');
const port = Number(process.env.MESHROOMS_ADMIN_PORT || 4330);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use an admin port between 1024 and 65535.');
const db = openAdmission(path);
const handle = adminHandler(db, { origin: process.env.MESHROOMS_ADMIN_ORIGIN || '', passwordHash: process.env.MESHROOMS_ADMIN_PASSWORD_HASH || '', log: event => console.log(JSON.stringify(event)) });
const server = Bun.serve({ hostname: '127.0.0.1', port, maxRequestBodySize: 4096,
  fetch: (request, server) => handle(request, server.requestIP(request)?.address || 'unknown') });
console.log(`Meshrooms admin listening on loopback port ${server.port}; publish only with Tailscale Serve.`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.stop(true); db.close(); process.exit(0); });
