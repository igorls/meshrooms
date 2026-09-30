import { createConnection } from 'node:net';
import { isHash } from './model';
import { MAX_ATTACHMENT_BYTES } from './attachments';

export type IncomingPacket = { sender: string; data: string };
export type FileState = { state: 'staging' | 'sending' | 'delivered' | 'failed'; error?: string };
export type IncomingFile = { id: string; sender: string; sha256: string; meta: Uint8Array; bytes: Uint8Array };
/** Verified bulk transfer: the receiving daemon holds the whole file and checked its SHA-256. */
export interface FileTransport {
  offerFile(peer: string, bytes: Uint8Array, sha256: string, meta: Uint8Array): Promise<string>;
  fileStatus(id: string): Promise<FileState | null>;
  nextFile(): Promise<IncomingFile | null>;
  releaseFile(id: string): Promise<void>;
}
export interface PeerTransport {
  check(): Promise<void>;
  send(peer: string, data: string): Promise<void>;
  receive(): Promise<IncomingPacket | null>;
  /** Absent when the attached MeshGuard has no transfer support. */
  files?: FileTransport;
}
const MAX_COMMAND = 4096, MAX_RESPONSE = 8192, TRANSFER_IO = 48 * 1024;
const TRANSFER_LIMIT = TRANSFER_IO * 4 / 3 + 1024;

/** One command per IPC connection. Never falls back to the shared legacy inbox. */
export async function controlCommand(path: string, command: string, limit = { command: MAX_COMMAND, response: MAX_RESPONSE }): Promise<any> {
  const deadline = Date.now() + 500;
  while (true) {
    try { return await controlAttempt(path, command, limit); }
    catch (error: any) {
      // The Windows server recreates its one-shot named pipe between commands.
      // Retry only failed connects, always against the exact configured endpoint.
      if (Date.now() >= deadline || !['ENOENT', 'EBUSY', 'ECONNREFUSED'].includes(error?.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  }
}
function controlAttempt(path: string, command: string, limit: { command: number; response: number }): Promise<any> {
  if (/[\r\n\0]/.test(command) || Buffer.byteLength(command) > limit.command) return Promise.reject(new Error('Invalid MeshGuard command.'));
  return new Promise((resolve, reject) => {
    const socket = createConnection(path); let data = Buffer.alloc(0); let finished = false;
    const finish = (error?: Error, result?: unknown) => {
      if (finished) return; finished = true; socket.destroy(); error ? reject(error) : resolve(result);
    };
    socket.setTimeout(2500, () => finish(new Error('MeshGuard control request timed out.')));
    socket.on('error', error => finish(error));
    socket.on('connect', () => socket.write(command + '\n'));
    socket.on('data', chunk => {
      data = Buffer.concat([data, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      if (data.length > limit.response) return finish(new Error('MeshGuard response exceeds the limit.'));
      const end = data.indexOf(10); if (end < 0) return;
      try {
        const result = JSON.parse(data.subarray(0, end).toString('utf8'));
        if (result?.error) return finish(new Error(`MeshGuard: ${result.error}`));
        finish(undefined, result);
      } catch { finish(new Error('Invalid MeshGuard control response.')); }
    });
    socket.on('end', () => finish(new Error('MeshGuard closed before a complete response.')));
  });
}

export class MeshGuardTransport implements PeerTransport {
  static channel = 'meshrooms-v1';
  static fileChannel = 'meshrooms-files';
  private maxPayload = 0;
  files?: FileTransport;
  constructor(private socketPath: string, private localKey: string) {
    if (!socketPath || !isHash(localKey)) throw new Error('An explicit MeshGuard control path and public key are required.');
  }
  async check() {
    const status = await controlCommand(this.socketPath, 'STATUS');
    if (status?.pubkey !== this.localKey || status?.running !== true) throw new Error('MeshGuard identity does not match this node attachment.');
    const info = await controlCommand(this.socketPath, 'APPINFO');
    if (info?.protocol !== 1 || !Number.isInteger(info.maxPayload) || info.maxPayload < 940) throw new Error('MeshGuard application channels v1 with at least 940-byte payloads are required.');
    this.maxPayload = Math.min(info.maxPayload, 1024);
    if (info.transfers === 1) {
      // Re-registering each cycle survives a MeshGuard restart; it only raises the per-file cap.
      await this.xfer(`XFERLISTEN ${MeshGuardTransport.fileChannel} ${MAX_ATTACHMENT_BYTES}`);
      this.files ??= this.fileTransport();
    } else this.files = undefined;
  }
  private async xfer(command: string) {
    const result = await controlCommand(this.socketPath, command, { command: TRANSFER_LIMIT, response: TRANSFER_LIMIT });
    if (result?.ok !== true && result?.empty !== true) throw new Error(`MeshGuard transfer failed: ${result?.error || 'unexpected response'}`);
    return result;
  }
  private fileTransport(): FileTransport {
    const id = (value: unknown) => { if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) throw new Error('Invalid MeshGuard transfer id.'); return value; };
    return {
      offerFile: async (peer, bytes, sha256, meta) => {
        if (!isHash(peer) || !isHash(sha256) || !bytes.length || meta.length > 768) throw new Error('Invalid file transfer.');
        const offer = await this.xfer(`XFEROFFER ${peer} ${MeshGuardTransport.fileChannel} ${bytes.length} ${sha256} ${Buffer.from(meta).toString('base64')}`);
        const transfer = id(offer.id);
        try {
          for (let offset = 0; offset < bytes.length; offset += TRANSFER_IO) {
            await this.xfer(`XFERPUT ${transfer} ${offset} ${Buffer.from(bytes.subarray(offset, offset + TRANSFER_IO)).toString('base64')}`);
          }
          await this.xfer(`XFERSTART ${transfer}`);
        } catch (error) { await this.xfer(`XFERCANCEL ${transfer}`).catch(() => {}); throw error; }
        return transfer;
      },
      fileStatus: async transfer => {
        const result = await controlCommand(this.socketPath, `XFERSTATUS ${id(transfer)}`);
        if (result?.ok !== true || !['staging', 'sending', 'delivered', 'failed'].includes(result.state)) return null;
        return { state: result.state, ...(typeof result.error === 'string' ? { error: result.error } : {}) };
      },
      nextFile: async () => {
        const info = await this.xfer(`XFERRECV ${MeshGuardTransport.fileChannel}`);
        if (info.empty === true) return null;
        const transfer = id(info.id);
        if (!isHash(info.sender) || !isHash(info.sha256) || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > MAX_ATTACHMENT_BYTES) {
          await this.xfer(`XFERDONE ${transfer}`); throw new Error('Invalid incoming MeshGuard transfer.');
        }
        const bytes = new Uint8Array(info.size);
        try {
          for (let offset = 0; offset < info.size;) {
            const chunk = Buffer.from((await this.xfer(`XFERGET ${transfer} ${offset} ${TRANSFER_IO}`)).data, 'base64');
            if (!chunk.length || offset + chunk.length > info.size) throw new Error('Invalid MeshGuard transfer read.');
            bytes.set(chunk, offset); offset += chunk.length;
          }
        } catch (error) {
          // Release the staged transfer, or it holds one of MeshGuard's few transfer slots until it expires.
          await this.xfer(`XFERDONE ${transfer}`).catch(() => {}); throw error;
        }
        return { id: transfer, sender: info.sender, sha256: info.sha256, meta: new Uint8Array(Buffer.from(info.meta || '', 'base64')), bytes };
      },
      releaseFile: async transfer => { await this.xfer(`XFERDONE ${id(transfer)}`).catch(() => {}); },
    };
  }
  async send(peer: string, data: string) {
    if (!isHash(peer) || !this.maxPayload || Buffer.byteLength(data) > this.maxPayload || /[\r\n\0]/.test(data)) throw new Error('Invalid application packet.');
    const result = await controlCommand(this.socketPath, `APPSEND ${peer} ${MeshGuardTransport.channel} ${data}`);
    if (result?.ok !== true) throw new Error('MeshGuard did not accept the datagram.');
  }
  async receive(): Promise<IncomingPacket | null> {
    const result = await controlCommand(this.socketPath, `APPRECV ${MeshGuardTransport.channel}`);
    if (result?.empty === true) return null;
    if (result?.ok !== true || !isHash(result.sender) || typeof result.data !== 'string' || Buffer.byteLength(result.data) > 1024) throw new Error('Invalid application inbox response.');
    return { sender: result.sender, data: result.data };
  }
}
