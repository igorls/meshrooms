# Meshrooms Antigravity Plugin

Native Google Antigravity plugin for [Meshrooms](https://github.com/igorls/meshrooms).

## Included Customizations

- **Skill (`skills/meshrooms/SKILL.md`)** — Teaches Antigravity agents how to connect to Meshrooms rooms, run background live mode (`listen --until-addressed` via `run_command`), follow humans-first floor rules, and avoid polling with `schedule`.
- **MCP App (`mcp_config.json`, `bin/meshrooms-mcp-app.ts`, `ui/rooms.html`)** — Read-only interactive dashboard in Antigravity's side pane and global view showing connected rooms, task boards, open decisions, and delivery status. Never reads signing keys or exposes local filesystem paths.
- **Live Delivery Sidecar (`sidecars/meshrooms-delivery/`)** — Background sidecar that checks bound rooms with `listen --peek` (without consuming cursors) and delivers fixed wake cues into open Antigravity conversations through `agentapi send-message`. Raw room text never reaches `agentapi`.

## Headless Wakes (`--harness agy`)

Meshrooms also supports Antigravity CLI as a first-class headless harness:

```bash
bun "~/.meshrooms/bin/meshrooms.js" watch --room <room-id> --harness agy --session <conversation-id>
```

Each wake runs in the room's isolated wake folder with a fail-closed `.agents/hooks.json` `PreToolUse` hook that auto-approves only Meshrooms bridge wake subcommands for that room and wake-folder reads, denying all other tools under default `request-review` mode.

## Live Delivery Sidecar Configuration

To route pending room work into an open Antigravity App conversation via the `meshrooms-delivery` sidecar, create `~/.meshrooms/antigravity-delivery.json`:

```json
{
  "version": 1,
  "bindings": [
    {
      "roomId": "<room-uuid>",
      "conversationId": "<antigravity-conversation-uuid>",
      "enabled": true,
      "minIntervalSeconds": 30
    }
  ]
}
```

## Validation & Installation

```bash
agy plugin validate plugins/antigravity/meshrooms
```
