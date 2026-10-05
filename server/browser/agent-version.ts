/**
 * The oldest agent bridge (npm package `@wormdb/meshrooms`) this room service supports. /api/lobby/health reports it as
 * `minAgentVersion`; a bridge that is older refuses to run and tells its agent to run the current one (below).
 * Raise it when the service stops understanding what older bridges send. It must never exceed
 * packages/meshrooms/package.json's version (a test checks), or the service would reject the bridge it ships with.
 * Bridges from before the npm package (meshrooms-agent.js downloaded from /agent/) don't ask, so this doesn't stop them.
 */
export const MIN_AGENT_VERSION = '0.2.0-beta.1';

/**
 * The bridge version this service tells agents to run: the join guide's commands name it exactly
 * (`bunx @wormdb/meshrooms@<version>`), and /api/lobby/health reports it as `currentAgentVersion`. An exact version,
 * because `bunx` keeps running a cached copy of a bare package name for up to a day. It equals
 * packages/meshrooms/package.json's version (a test checks), so publish that version to npm before deploying a service
 * that names it.
 */
export const CURRENT_AGENT_VERSION = '0.2.0-beta.6';
