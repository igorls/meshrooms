import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { LocalNode, NodeError, type Principal } from './node';

const COOKIE = 'meshrooms_session';
function equal(a: string, b: string) { const aa = Buffer.from(a); const bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }

/** Local OS account owns control.key; delegated agents receive room credentials only. */
export class NodeAccess {
  private tickets = new Map<string, number>();
  constructor(private readonly token: string, private readonly node: LocalNode) {}
  private signature(payload: string) { return createHmac('sha256', this.token).update(`${this.node.nodeId}:${payload}`).digest('base64url'); }
  issueBrowserTicket(): string {
    for (const [ticket, expiry] of this.tickets) if (expiry < Date.now()) this.tickets.delete(ticket);
    if (this.tickets.size >= 32) throw new NodeError(429, 'Too many pending browser links. Wait a moment and retry.');
    const ticket = randomBytes(32).toString('base64url'); this.tickets.set(ticket, Date.now() + 120000); return ticket;
  }
  exchangeBrowserTicket(value: unknown): string {
    if (typeof value !== 'string' || !this.tickets.has(value)) throw new NodeError(401, 'This browser link has expired. Open a fresh link through your agent.');
    const expiry = this.tickets.get(value)!; this.tickets.delete(value);
    if (expiry < Date.now()) throw new NodeError(401, 'This browser link has expired. Open a fresh link through your agent.');
    const payload = `${Date.now() + 30 * 86400000}.${randomBytes(24).toString('base64url')}`;
    return `${COOKIE}=${payload}.${this.signature(payload)}; HttpOnly; SameSite=Strict; Path=/api/node; Max-Age=2592000`;
  }
  principal(request: Request): Principal {
    const authorization = request.headers.get('authorization');
    if (authorization !== null) {
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (equal(token, this.token)) return this.node.owner;
      const agent = this.node.authenticateAgent(token); if (agent) return agent;
      throw new NodeError(401, 'This credential is not admitted to a room. Complete the local room review first.');
    }
    const cookie = request.headers.get('cookie')?.split(';').map(p => p.trim()).find(p => p.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (cookie && cookie.length < 256) {
      const [expires, nonce, signature, extra] = cookie.split('.'); const expiry = Number(expires);
      if (!extra && /^\d+$/.test(expires) && /^[\w-]{32}$/.test(nonce || '') && Number.isSafeInteger(expiry) && expiry > Date.now()
        && expiry <= Date.now() + 30 * 86400000 && equal(signature || '', this.signature(`${expires}.${nonce}`))) return this.node.owner;
    }
    throw new NodeError(401, 'Open Meshrooms through your agent to connect this browser.');
  }
}
