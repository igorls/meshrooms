---
name: Meshrooms prototype
description: Selected layout A, refined for one local node managing multiple rooms.
colors:
  blue: "#285de5"
  ink: "#202b3b"
  muted: "#626d7d"
  line: "#e2e7ee"
  paper: "#fff"
  soft: "#f5f7fa"
  canvas: "#eef1f5"
  rail: "#182634"
  rail-active: "#304458"
  rail-text: "#f2f6f9"
  focus: "#5b85f2"
  local: "#358573"
  sample-idle: "#aa8b4c"
  success-bg: "#e9f3ee"
  success-text: "#294f40"
  error-bg: "#fcefeb"
  error-text: "#8d352b"
typography:
  headline:
    fontFamily: "Manrope Variable, Segoe UI, sans-serif"
    fontSize: "22px"
    fontWeight: 750
    lineHeight: 1.25
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Manrope Variable, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 750
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Manrope Variable, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.85
  label:
    fontFamily: "Manrope Variable, Segoe UI, sans-serif"
    fontSize: "10px"
    fontWeight: 500
    lineHeight: 1.2
  excerpt:
    fontFamily: "Cascadia Code, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.7
rounded:
  label: "4px"
  control: "8px"
  excerpt: "10px"
  surface: "12px"
  round: "50%"
spacing:
  compact: "8px"
  control: "12px"
  medium: "16px"
  panel: "20px"
  conversation: "40px"
components:
  button-primary:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    padding: "10px 15px"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 15px"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  role-label:
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.label}"
    padding: "1px 4px"
  composer:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.surface}"
---

# Design System: Meshrooms prototype

## Overview

The user selected layout A on 2026-09-20. Cool paper, slate text, blue actions and a navy room rail support a conversation surface with multiple independent rooms grouped by project. The approved public brand is **Meshrooms by WormDB**. The current refinement brief is `docs/room-surface.md`; B/C and the comparison switcher are retired.

The shared vocabulary is open transcript rows, compact state labels, restrained borders and explicit share previews. There are no shipping raster assets; the wordmark and interface icons are inline SVG.

## Colors

### Primary

Blue marks send, join and share actions, text actions and text carets. Focus uses its own lighter blue outline.

### Neutral

Paper holds the transcript and fields; soft and canvas distinguish context from conversation. Ink and muted separate content from metadata. Line provides quiet surface boundaries. Rail, rail-active and rail-text form A's dark navigation treatment.

### Status

Local green and sample-idle amber accompany explicit labels. An offline example uses an outlined dot. Success and error feedback pair their background and text tokens; a colored dot is never the sole available state description.

## Typography

Manrope Variable with Segoe UI and sans-serif fallbacks serves the interface. Cascadia Code with Consolas and monospace fallbacks serves excerpts. The root size is 14px; transcript body uses the body role and a maximum measure of 72ch.

Headlines use the headline role. On narrow screens room headings resolve to 21px and transcript text to 13px. Participant and author names are compact, with stronger weights than adjacent role labels. Desktop timestamps and message state are 10px; mobile uses 9px. Excerpts reduce to 10px on narrow screens. These small metadata sizes describe the prototype, not a completed accessibility qualification.

## Layout

A's left rail now holds a project-grouped room list and the selected room's roster. The remaining width belongs to the room header, transcript, composer, join/create form and excerpt preview. Room selection changes these room-scoped contents while retaining each room's unpublished work.

Desktop uses a persistent rail and scrollable conversation. Narrow screens retain an accessible Rooms control and navigation, readable transcript flow, visible reply actions, and connection feedback. Node connectivity is distinct from room membership. The removed variant switcher no longer needs reserved bottom space.

## Elevation & Depth

Borders and surface tone provide most depth. Shadows are limited to feedback and the focused composer. The only authored transitions are short opacity and composer border/shadow changes; reduced-motion preference disables transitions. The generated design sidecar predates this refinement and retains historical variant descriptions; it is not the current layout authority.

## Shapes

Small rounded labels, gently rounded controls and larger rounded containers establish the hierarchy. Human avatars are circular; agent avatars have rounded square silhouettes. Interface icons use simple outlined SVG strokes, normally 18px. The room symbol has its own 13px corner treatment.

## Components

- **Buttons:** primary controls use blue and paper; secondary controls use paper with a thin gray border. Standard primary/secondary controls have a 40px minimum height; the send control is denser at 34px. Enabled buttons darken through a brightness filter on hover; disabled controls use 45% opacity and a disabled cursor.
- **Inputs and composer:** fields have thin gray borders. The composer groups a borderless textarea with share and send controls inside a rounded border; focus strengthens the parent border and adds a faint shadow. Standard interactive elements use a 3px focus outline with a 3px offset. The composer textarea instead exposes focus through its parent.
- **Transcript:** messages are open rows with avatars and metadata, not speech bubbles. Reply references truncate; message text and excerpt content wrap. Reply actions appear on hover or focus within a message and remain visible on mobile.
- **Selective share:** a tinted panel collects a source label and excerpt, then shows the complete excerpt in a preview before the explicit share action. Received excerpts use a bordered, rounded container with a separated title row and monospace content.
- **Roster and navigation:** project groups contain distinct room entries with a clear active state. The roster is scoped to the selected room; shared participants do not merge memberships. Names, roles, detail text and presence markers remain compact.
- **Feedback:** status uses live regions; errors include a dismiss action. Async send results stay with their originating room. A skip link appears when focused.

## Do's and Don'ts

- **Do** preserve explicit local-demo and example state labels.
- **Do** keep typography, action colors and message components consistent across rooms.
- **Do** retain keyboard focus visibility and reduced-motion behavior.
- **Don't** present future cross-machine invitations, recipient bootstrap, agent wakeup, or native room replication as released capabilities.
- **Don't** add marketing claims, dashboard metrics or decorative feature cards; these are excluded by the current product brief.

## Public entry page

`website/index.html` extends the selected room language into a reading and
installation surface; its direction contract is `docs/public-site.md`. It uses
self-hosted Manrope Variable, cool paper, the navy room rail, blue actions, and
an explicitly illustrative local transcript. Human avatars remain round and
agent avatars remain rounded squares. There are no shipping raster assets.

The page uses a 16px body base, 15px supporting prose, a 38–60px responsive hero
(42px on phones), 29–40px section headings, 18px subheadings, and 11–14px
metadata/actions. The larger reading scale belongs to this public surface;
the local room's denser type roles remain unchanged. The installation command
uses Cascadia Code/Consolas/monospace and wraps on phones. All functional and
illustrative metadata has an 11px minimum.

The installation section extends navy with secondary text `#c4d1de`, link
text `#a8c2ff`, command background `#253849`, and copy feedback `#d7e6ff`.
These tints preserve contrast on the existing dark ground. White and
`#f2f6f9` remain its primary text colors. Authored outline SVGs use a 1.7px
stroke for navigation and action arrows.

Desktop uses a two-column introduction; at 860px it stacks in reading order.
The primary action leads to the exact skill command, paired with a copy button
and a live success/failure message. The Windows local-preview boundary stays
visible beside the action. Reduced motion disables smooth scrolling and
transitions; keyboard focus exposes the skip link and control outlines.
