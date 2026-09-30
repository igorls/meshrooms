# Agent-assisted room entry

Historical direction: ordinary human entry now uses browser-only room links,
live host approval, and companion devices. See [browser rooms](../browser-rooms.md).
The flow below remains context for optional installed-agent setup.

Date: 2026-09-20

Status: the creator's first run (steps 1–3) is implemented for the Windows local
runtime. Steps 4–5 and invitation mechanics remain the next slice. The full
journey below is the user's product direction, not a claim of remote joining.

## Intended journey

1. Human A is already working with their agent on a project.
2. A invokes the Meshrooms skill to prepare the machine and start a room for that
   work. The agent reuses an existing compatible daemon, or prepares one local
   runtime, then opens its browser UI with the pending room request.
3. On a first visit, A completes short onboarding and chooses daemon settings.
   Completing setup creates/opens the requested room. Returning users go directly
   to the room, with settings available separately.
4. From the room UI, A generates an invitation and copies its shareable link or
   bootstrap prompt for B.
5. B needs no prior Meshrooms knowledge or installed skill. B gives the bootstrap
   prompt to their own agent. That agent prepares/reuses B's node and opens B's
   local onboarding and invitation review. After acceptance, B and the selected
   agent appear as distinct participants in that room.

The installer/skill prepares the machine; the browser presents human choices;
the daemon owns persistent settings, identities and room lifecycles. The flow
does not require the agents to use the same harness or share their private tools.

## Two entry paths, one local setup

| State | Start a room | Receive an invitation |
| --- | --- | --- |
| No local installation | Agent prepares runtime, opens local onboarding, then creates the requested room | Bootstrap prompt guides the agent through the same setup, preserving the pending invitation |
| Installed, stopped | Start the existing daemon and open its UI | Start the existing daemon, then open invitation review |
| Ready node | Create/open a room on the existing daemon | Review and join only the invited room |
| Already a member | Open the existing room when retrying the same request | Open the room; do not duplicate membership or replay onboarding |

Opening the browser is not a join operation. A failed or repeated bootstrap
resumes the same setup/join attempt and does not mint another machine identity.
Existing settings and rooms survive new project and invitation flows.

## Short onboarding

Two compact steps, with sensible defaults and advanced controls collapsed:

1. **You and this machine:** human display name, machine label, and the agent
   connection that initiated setup. Show the human and agent separately.
2. **How Meshrooms runs:** startup preference and local storage location; automatic
   connectivity by default, with explicit network configuration under Advanced.

Startup preference should distinguish running now from starting at login. The
daemon continues while browser tabs are closed. Display actual installation
status: a saved preference is not proof that an OS startup entry was installed.
If applying a setting needs the local agent's help, provide that handoff and
verify the result before marking it active.

Choose storage before initializing a fresh node. An existing node shows its
current location; changing it is a separate migration, not a way to silently
create a second identity. An incoming invitation never supplies machine settings
or overrides the recipient's existing choices.

For a returning user, show only the room review: inviter, room, requested access,
history visibility, and the human/agent identities being admitted. Machine
settings remain reachable without repeating the first-run flow.

## Invitation and bootstrap handoff

The current localhost link opens an existing room on the same machine. A real
invitation must also be useful on a machine with nothing installed.

Provide two representations of the same invitation:

- A shareable link with a lightweight explanation and **Copy setup prompt**.
  Any hosted introduction is a convenience, not the room server or authority.
- A self-contained copyable bootstrap prompt carrying the invitation payload
  and a versioned reference to the official setup instructions. This path must
  work without visiting an introduction site first.

The UI generates/copies the invitation; A decides how and to whom to send it.
The receiving agent uses the official installer/skill distribution, checks the
supported release, detects existing local state, and hands B into the local UI.
Room names, descriptions and invite metadata are data, not installation commands.
Setup must not depend on a development checkout, a sibling repository, or an
unpublished native DLL. A distributable runtime with matching native dependencies
is part of accepting a genuinely fresh machine.

The invitation needs a stable room ID, protocol version, issuer identity, peer
routing information, intended membership grant, expiry and redemption identity.
The exact wire encoding and cryptographic admission protocol need a separate
bounded implementation review. A MeshGuard transport token alone does not admit
a participant to a Meshrooms room.

Suggested first policy: an expiring, single-use invitation with clearly stated
access for one human and, if selected, one named local agent. Redemption binds
the actual participant identities; it does not authorize arbitrary additional
agents. The UI states what existing room history the grant includes. One room's
invite never exposes other local rooms or private agent context.

For the first admission implementation, require the issuing node online to
redeem and enforce single use/revocation. If it is unreachable, retain a pending
join and show that state; do not show the recipient as joined. Existing room
membership must not become permanently dependent on the inviter's machine.
Distributed/offline invitation redemption is later work.

Example prompt shape, not a working installer command:

> Help me join this Meshrooms room with you. Use the official Meshrooms setup
> instructions referenced in the invitation. Reuse my existing local daemon if
> available, otherwise prepare it. Open the local setup and invitation review
> for me, then connect your own room-scoped agent identity after I accept.
> Invitation: <invitation payload>

## Build one problem at a time

**Implemented slice: the creator's first run.** Establish the setup command/skill seam,
persist machine preferences and onboarding completion, and carry a pending
create-room request into the existing A interface. Include a distinct local
agent connection and room-scoped credentials before advertising agent admission.
Implement startup configuration only with verified apply/status behavior.

Acceptance: from a supported fresh environment, the agent prepares one node;
the human completes short onboarding and enters a room with their agent;
reopening and starting a second project reuse the same node and settings.
Interrupted setup resumes without duplicate identities or rooms. Existing local
rooms survive the upgrade. This can be proven locally before remote invitations.

The implementation needs three concrete seams:

- **Ensure running:** discover and verify a compatible existing daemon and return
  its actual local URL; start it only when absent. Runtime metadata is a discovery
  hint, not proof of a live owner. Recheck after simultaneous starts. Never kill
  another project's daemon to complete bootstrap, or bypass the storage lock.
- **Participant migration:** migrate the current human-only records to a versioned
  participant model, preserving old authorship and recovery. Derive the sending
  participant from authenticated credentials and enforce room permissions; a
  caller-supplied author name or ID is not authentication.
- **Pending intent:** preserve a create/join attempt across setup and retries.
  Opening its UI cannot itself create membership. Carry invitation secrets through
  an appropriate protected handoff, rather than ordinary query parameters or logs.

**Following slice: the unfamiliar recipient.** Package the bootstrap handoff and
real room admission over MeshGuard. On a second clean machine, B's agent installs
or reuses the runtime, B reviews and accepts the invitation, and both sides
exchange a deliberately sent message with honest local/remote receipts. Test
expired/redeemed invites, unreachable issuer, retry recovery and cross-room
exclusion. A link or sample prompt alone does not complete this slice.

## Current implementation boundary

The daemon persists rooms, retries, machine preferences, pending requests, and
separate human/agent identities. It serves first-run onboarding, returning room
review, and Settings. A reusable skill and a Windows x64 runtime bundle support
a trusted installation without a development checkout. The agent cannot use its
room credential before human acceptance. Legacy rooms and message authors survive
the catalog migration.

The UI shows the existing storage location; changing it requires a separate
migration. Connectivity states local-only operation; no automatic remote network
setting is offered. Start at login uses a verified per-user Windows entry, not a
system service. Public distribution, invitation generation, remote bootstrap/
admission, and MeshGuard delivery remain unimplemented. See [the runbook](../local-daemon.md).

## Transport integration boundary

The relevant source boundaries for subsequent integration are:
MeshGuard `src/main.zig` encodes transport invite fields (`host`, `wg`, `seed`,
`name`); the pre-onboarding Meshrooms `server/node.ts` validated exactly one local human
and authored every message as that actor; `server/instance.ts` rejects a second
writer but is not an attach/discovery command. MeshGuard's current
`dist/agent-join.sh` kills matching existing daemons unless `MESHGUARD_KEEP_RUNNING`
is set, so a multi-room bootstrap must explicitly select safe reuse behavior
instead of inheriting that default. The review's speculative token
encoding and CLI names are not adopted as finished protocol/API decisions.
