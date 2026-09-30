/** Isolated integration fixture, never an installer or substitute for user onboarding. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { defaultOptions, startDaemon } from '../server/daemon';
import { isHash, isUuid, tokenHash } from '../server/model';
import { testStartupManager } from '../server/startup';

const args = process.argv.slice(2), flags: Record<string, string> = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--data-dir', '--room', '--agent', '--peer-key', '--socket', '--port', '--resume'].includes(args[i]) || !args[i + 1]) throw new Error('Use explicit fixture arguments; --resume takes true.');
  flags[args[i]] = args[i + 1];
}
if (!flags['--data-dir'] || !flags['--socket'] || !isUuid(flags['--room']) || !isHash(flags['--peer-key']) || !flags['--agent']) throw new Error('Required: --data-dir PATH --room UUID --agent NAME --peer-key HEX --socket PATH --port PORT');
const dataDir = resolve(flags['--data-dir']), marker = join(dataDir, 'peer-qualification.json'), credentialFile = join(dataDir, 'qualification-agent.json');
const identity = { fixture: 'meshrooms-peer-qualification-v1', roomId: flags['--room'], agent: flags['--agent'], peerKey: flags['--peer-key'] };
const resume = flags['--resume'] === 'true';
if (resume) {
  if (!existsSync(marker) || JSON.stringify(JSON.parse(readFileSync(marker, 'utf8'))) !== JSON.stringify(identity) || !existsSync(credentialFile)) throw new Error('Resume requires this exact existing qualification fixture.');
} else {
  if (existsSync(dataDir) && readdirSync(dataDir).length) throw new Error('A fresh fixture requires an empty directory. Never use real node data.');
  mkdirSync(dataDir, { recursive: true }); writeFileSync(marker, JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
}
const daemon = startDaemon({ ...defaultOptions(), dataDir, port: Number(flags['--port']), startup: testStartupManager(),
  meshguard: { socketPath: flags['--socket'], publicKey: flags['--peer-key'] } });
try {
  if (!resume) {
    const token = randomBytes(32).toString('base64url');
    daemon.node.prepareRoom({ requestId: identity.roomId, title: 'Cross-machine qualification', project: 'Meshrooms QA', agentName: identity.agent, credentialHash: tokenHash(token) });
    daemon.node.completeSetup({ requestId: randomUUID(), intentId: identity.roomId, humanName: 'QA fixture owner', machineName: 'Isolated test node', startAtLogin: false });
    daemon.node.createRoom({ requestId: randomUUID(), title: 'Private unpaired qualification room', project: 'Meshrooms QA' });
    writeFileSync(credentialFile, JSON.stringify({ version: 1, nodeId: daemon.node.nodeId, dataDir, intentId: identity.roomId, token,
      title: 'Cross-machine qualification', project: 'Meshrooms QA', agentName: identity.agent }), { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify({ event: 'meshrooms.qualification.ready', pid: process.pid, nodeId: daemon.node.nodeId,
    url: daemon.runtime.url, credentialFile, descriptor: daemon.node.descriptor(identity.roomId, identity.peerKey) }));
  const stop = () => { daemon.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} catch (error) { daemon.close(); throw error; }
