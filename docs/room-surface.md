# Multiple rooms in the selected layout

Mode: Operate. On 2026-09-20 the user selected A and specified one persistent
daemon per machine managing independent rooms across long-running projects.

## Direction

Preserve A's cool paper, slate text, blue actions, navy navigation rail, open
transcript rows, and explicit share previews. Retire B/C and the comparison
switcher. This refines the chosen layout rather than choosing a new visual world.

The main task path is: find a project and room, read that room's conversation
and participants, prepare a message or excerpt, and explicitly publish it to
that room. The room list stays available while the conversation leads the page.
Project groups are organizational labels only.

The selected room's roster, history, reply target, and share preview belong
together. Unpublished work and new activity in other rooms remain separate.
Switching changes the view; it does not join/leave a room or start a process.
Joining or creating a room is an explicit action.

Narrow screens retain accessible room navigation and connection feedback.
Keep the composer and selected room label clear. Node connectivity and room
membership are different concepts; show only states the mock can substantiate.

## Evidence boundary

The local demo server models one node's registered rooms independently of its
browser subscriptions. Sample rosters/history are labeled. Data resets when
the server restarts; no persistent daemon or transport bridge is claimed.
See `architecture/0001-one-daemon-many-rooms.md` for the architecture decision.

## Verification

Check desktop/mobile room navigation, isolated histories and rosters, per-room
draft/reply/share restoration, background activity, new-room visibility across
views, and one local server. An asynchronous send must update its originating
room even if the user navigates elsewhere. Run build/type checks and bounded
browser verification without another concept or polish cycle. No shipping
raster assets are introduced.
