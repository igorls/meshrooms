# Browser room entry and companion devices

Mode: Operate. Extend the selected room design in DESIGN.md; preserve its navy
rail, Manrope typography, open transcript rows, blue actions, and explicit states.
This is a code-led extension with no new visual identity or imagery.

People arrive through a room link with an ordinary browser. New people ask to
join; the host admits or declines live. An existing person can confirm another
device from their trusted session and appear once in the roster. No local agent
or installation is part of human entry.

Routes: /rooms creates or reopens browser rooms; /r/:id displays the lobby and,
after admission, the conversation. The native /prototype/room flow remains separate.

Entry has one name field and Ask to join; existing-identity linking is secondary.
Pending states provide approval feedback and cancellation. Host requests sit
in a bounded attention strip below the room header, with explicit Admit and
Decline actions. Room details groups the people, invitation URL, and companion
device controls. Linking uses a disclosure and a request-specific device code,
with no modal or manual networking. One human roster row groups their devices.

The joined room fills the viewport. The transcript scrolls independently while
the composer stays available at the bottom. Messages group by author within five
minutes, with day separators and quieter storage receipts on outgoing groups.
Incomplete receipts remain visible. Enter sends; Shift+Enter inserts a line.
Incoming messages preserve reading position and offer a jump to new messages.

Quality bar: a new person can find the join action immediately, the host can
resolve a pending request without losing the conversation, and a companion device
adds no duplicate human. Preserve 44px controls, visible keyboard focus, readable
status text, and wrapping at 390px. Existing setup typography (12–26px) and public
rail secondary text are reused; detector type-ramp advisories reflect the older
design sidecar, which this change does not rewrite.

Required states: loading, storage failure, request pending/expired/declined,
host offline, admitted/connecting, usable, retry, duplicate tab, removed device,
and empty conversation. No agent warning in human-only rooms. Device connectivity
and stored-message receipts do not claim that a person has read a message.

Implementation and remaining qualification: [browser rooms](browser-rooms.md).

## Direction contract

THESIS: one link leads to live admission and conversation, with networking owned
by the application. Companion devices remain grouped under their human.

OWN-WORLD: inherit the selected navy rail, cool paper, Manrope, blue actions,
restrained borders, and open transcript rows. No replacement visual system.

STORY: the recipient asks; the host admits; both see usable connection state and
exchange messages. Existing people can approve their own additional device.

FIRST VIEWPORT: the navy rail holds recent rooms and the current identity. The
room header establishes context; conversation and the anchored composer lead.
People, invitations, and both device operations belong in Room details, opened
beside chat on wide screens. Below 1150px it occupies the conversation area until
closed, preserving the draft, scroll position, and keyboard return target. Mobile
compresses navigation into a small brand/rooms bar; no roster precedes the chat.
Admission requests alone interrupt the conversation path. Spacing is tight within
message groups and generous between authors; long histories and detail lists
scroll inside their own regions. Entry still centers one narrow form.

FORM: direct extension of the user's selected room layout; no concept seed or
approved raster comp applies to this precisely specified extension.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
