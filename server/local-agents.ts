/**
 * The local API's agent routes (desktop-first M4): harnesses, sessions, agent identities, putting them into rooms and
 * binding them. Served by local-api.ts behind its usual checks (Host, exact Origin, bearer, body caps); this file only
 * adds what these routes need on top.
 *
 * For the page (its session token) and local programs (the control token):
 *   GET  /api/local/harnesses                              [{harness, label, detected, version?, sessionsAvailable, reason?}]
 *   GET  /api/local/harnesses/:h/sessions                  {harness, sessionsAvailable, reason?, sessions: [...], truncated}
 *   GET  /api/local/agents                                 {agents: [identity with its rooms and binding state], approvalsWaiting}
 *   POST /api/local/agents {name, harness, model?}          a new identity (not exec: its command is set at the terminal)
 *   POST /api/local/rooms/:id/agents {identity}            puts an identity into a room the person is in
 *   POST /api/local/rooms/:id/agents/:member/bind {session} 'new': binds a new session, logged, no approval needed.
 *                                                            A session id: an existing session, never bound here: it is
 *                                                            filed for the app to approve, and answered 403.
 *   POST /api/local/rooms/:id/agents/:member/unbind        wakes off; the agent stays in the room
 *   DELETE /api/local/agents/:id                           an identity in no room (from the app: also one in rooms)
 *
 * Approval-gated, for the native app only, and only when the daemon runs with approvals on (`approvals`):
 *   GET  /api/local/approvals                              each with its digest; a bind-existing one also carries its
 *                                                            identity's name and model and its room's title as they are
 *                                                            now, which its digest covers too (agents.ts approvalsView)
 *   POST /api/local/approvals/:id/approve {digest}         the digest the list gave with what the app showed
 *   POST /api/local/approvals/:id/reject
 *   POST /api/local/app/agents {name, harness, model?, command?}   an identity the person makes in the app's window, the
 *                                                            only place a custom command (exec) can come from
 * Their credential is the control token, which only a local program can use: it is an HMAC of the endpoint file's
 * secret (local-api.json, 0600 in the daemon's folder, new at every start), and local-api.ts refuses it on any request
 * that carries an Origin or Sec-Fetch-Site, which a browser always sends. The page's session token is refused here even
 * though it is a valid credential elsewhere: the localhost tab can be scripted by another local program or an
 * extension, the app's own window can't. With approvals off these routes don't exist (404).
 */
import { HARNESS_IDS, harnessScanner, type HarnessId } from './detectors/harnesses';
import {
  approvalsView, bindNewSession, createIdentity, decideApproval, deleteIdentity, httpError, identityInRoom, listIdentities, pathFree, putIntoRoom, readApprovals, requestExistingBinding,
  unbindIdentity, type AgentDeps,
} from './agents';

/** What the agent routes are served with: the daemon's real deps and scanner; tests give their own. */
export type AgentServices = { deps: AgentDeps; scanner: ReturnType<typeof harnessScanner> };
export type AgentRouteContext = {
  home: string;
  /** The request carries the control token (a local program), not the page's session token. */
  control: boolean;
  /** The approval routes exist (the daemon was started with approvals on). */
  approvals: boolean;
  body(): Promise<Record<string, unknown>>;
  services?: AgentServices;
};
export type RouteAnswer = { status: number; value: unknown };

const ROOM_AGENTS = /^\/api\/local\/rooms\/([a-f0-9-]{36})\/agents(?:\/([a-f0-9-]{36})\/(bind|unbind))?$/;
const APPROVAL = /^\/api\/local\/approvals(?:\/([a-f0-9-]{36})\/(approve|reject))?$/, APP_AGENTS = '/api/local/app/agents';
const SESSIONS = /^\/api\/local\/harnesses\/([a-z]{1,16})\/sessions$/, ONE_AGENT = /^\/api\/local\/agents\/([a-f0-9-]{36})$/;

/**
 * The answer to an agent route, or undefined when the path is none of them (local-api.ts goes on with its own). An
 * error going to the page never carries a local path (pathFree); the app, a trusted surface, gets it as it is.
 */
export async function agentRoute(url: URL, method: string, ctx: AgentRouteContext): Promise<RouteAnswer | undefined> {
  try { return await route(url, method, ctx); }
  catch (error) {
    if (ctx.control || !(error instanceof Error)) throw error;
    throw Object.assign(new Error(pathFree(error.message)), { status: (error as { status?: number }).status ?? 500 });
  }
}
async function route(url: URL, method: string, ctx: AgentRouteContext): Promise<RouteAnswer | undefined> {
  const path = url.pathname;
  const approval = APPROVAL.exec(path);
  if (path === APP_AGENTS) {
    if (!ctx.approvals) return undefined;
    if (!ctx.control) throw httpError(403, 'Make a custom-command agent in the Meshrooms app.');
    if (method !== 'POST') throw httpError(405, 'Use POST.');
    const services = need(ctx), input = await ctx.body();
    const identity = await createIdentity({ name: input.name, harness: input.harness, model: input.model, ...(input.command !== undefined ? { command: input.command } : {}) }, ctx.home,
      { command: 'allowed', check: services.deps.checkCommand });
    return { status: 201, value: { agent: listIdentities(ctx.home).find(i => i.id === identity.id) } };
  }
  if (approval) {
    if (!ctx.approvals) return undefined;
    if (!ctx.control) throw httpError(403, 'Approve this in the Meshrooms app.');
    const services = need(ctx);
    if (!approval[1] && method === 'GET') return { status: 200, value: { approvals: approvalsView(ctx.home) } };
    // Approving sends back the digest of what the app showed (approvalsView); rejecting needs nothing.
    if (approval[1] && method === 'POST') {
      const approve = approval[2] === 'approve';
      const detected = async (harness: HarnessId) => (await services.scanner.scan()).some(s => s.harness === harness && s.detected);
      return { status: 200, value: await decideApproval(approval[1], approve, services.deps, ctx.home, approve ? (await ctx.body()).digest : undefined, detected) };
    }
    throw httpError(405, 'Use GET for the list, POST to approve or reject.');
  }
  if (path === '/api/local/harnesses' && method === 'GET') return { status: 200, value: { harnesses: await need(ctx).scanner.scan() } };
  const sessions = SESSIONS.exec(path);
  if (sessions && method === 'GET') {
    if (!HARNESS_IDS.includes(sessions[1] as HarnessId)) throw httpError(404, 'There is no such harness.');
    return { status: 200, value: await need(ctx).scanner.sessions(sessions[1] as HarnessId) };
  }
  if (path === '/api/local/agents' && method === 'GET') return { status: 200, value: { agents: listIdentities(ctx.home), approvalsWaiting: readApprovals(ctx.home).length } };
  if (path === '/api/local/agents' && method === 'POST') {
    const input = await ctx.body();
    const identity = await createIdentity({ name: input.name, harness: input.harness, model: input.model, ...(input.command !== undefined ? { command: input.command } : {}) }, ctx.home, { command: 'refused' });
    return { status: 201, value: { agent: listIdentities(ctx.home).find(i => i.id === identity.id) } };
  }
  const one = ONE_AGENT.exec(path);
  if (one) {
    if (method !== 'DELETE') throw httpError(405, 'Use DELETE.');
    return { status: 200, value: await deleteIdentity(one[1], need(ctx).deps, ctx.home, { app: ctx.control && ctx.approvals }) };
  }
  const room = ROOM_AGENTS.exec(path);
  if (!room) return undefined;
  if (method !== 'POST') throw httpError(405, 'Use POST.');
  const [, roomId, member, action] = room, services = need(ctx);
  if (!member) {
    const { identity } = await ctx.body();
    return { status: 201, value: await putIntoRoom(identity, roomId, services.deps, ctx.home) };
  }
  if (action === 'unbind') return { status: 200, value: await unbindIdentity(roomId, member, services.deps, ctx.home) };
  const input = await ctx.body();
  // { session } and nothing else: no folder, command or second session id rides along (a new session works in the room's
  // own folder, and an existing one is only ever bound with the app's approval).
  if (Object.keys(input).some(key => key !== 'session')) throw httpError(400, 'Send { session: "new" } or { session: "<id of a listed session>" }, and nothing else.');
  if (input.session === 'new') {
    const bound = await bindNewSession(roomId, member, services.deps, ctx.home);
    return { status: bound.state === 'starting' ? 202 : 200, value: bound };
  }
  if (typeof input.session !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.session)) throw httpError(400, 'Use session: "new", or the id of a session the harness lists.');
  // An existing session: only one the harness lists now, and only filed for the app.
  const { identity } = identityInRoom(ctx.home, roomId, member);
  if (identity.harness === 'exec') throw httpError(400, 'A custom-command agent has no sessions to bind.');
  const listed = (await services.scanner.sessions(identity.harness)).sessions.find(s => s.id === input.session);
  if (!listed) throw httpError(404, `That session is not one ${identity.name}'s harness lists now.`);
  const filed = await requestExistingBinding(roomId, member, { id: listed.id, title: listed.title, folder: listed.folder }, services.deps, ctx.home);
  return { status: 403, value: { error: 'Binding an existing session needs your approval in the Meshrooms app.', approval: 'pending', approvalId: filed.id } };
}
function need(ctx: AgentRouteContext) {
  if (!ctx.services) throw httpError(503, 'Agents are not available in this version of Meshrooms.');
  return ctx.services;
}
