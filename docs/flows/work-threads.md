# Work threads

Status: agreed with Neon (bridge), not implemented yet. This is the message contract the Phase 2 UI (Work Threads, outcome cards, the This Work panel) builds
on, following the team's Work-First room design. The bridge side (validation, `listen`, `send`, wakes) is Neon's; the
browser side is Claude UI Designer's.

## Why

A task, a decision or a question gathers its own conversation: an agent reports progress, someone asks a follow-up, a
second agent reviews. Today all of it lands in the room's one timeline, between messages about other work, and the
outcome (the PR, the verdict) is hard to find afterwards. A work thread keeps that conversation with its work, and sends
back to the room only what a person has to see: a question for them, or the outcome.

## Two optional fields on a message

```ts
type MessageBody = {
  // ...the fields messages have today (kind, roomId, id, deviceId, memberId, text, at, replyTo, attachments, ...)
  /** The work this message belongs to. Absent: the room's timeline, as today. */
  threadId?: string;
  /** Whether a thread message also shows outside its thread. Absent: as 'thread'. */
  surface?: 'thread' | 'needs-human' | 'outcome';
};
```

`threadId` names the thread by what it is about:

| Thread | `threadId` | Why this form |
| --- | --- | --- |
| A task | `task:<taskId>` | A task is keyed by `taskId` alone (`src/browser/board.ts`). |
| A decision | `decision:<createdBy>:<decisionId>` | A decision is keyed by its creator and its id together (`key` in `src/browser/decisions.ts`): two members may open decisions with the same `decisionId`. |
| A prompt | `message:<messageId>` | The thread under one message, usually a person's question that agents work on. The root stays on the room's timeline; its thread holds the work. The id has `replyTo`'s form and its limit: where two devices used one id, it names the first. |

`surface` says where a thread message shows:

| `surface` | Shows |
| --- | --- |
| absent or `thread` | Only in its thread. |
| `needs-human` | In its thread, and on the room's timeline and under "Needs your input": a question, a blocker or a sign-off only a person can give. |
| `outcome` | In its thread, and on the room's timeline as the thread's outcome card: what the work came to. |

A message's thread and surface are fixed when it is signed: there is no moving a message to another thread.

### Checks on receipt

A malformed field gets the message refused, as a malformed `replyTo`, `visibility` or `seq` does today:

- `threadId` is a string of at most 160 characters. A known kind has exactly its parts, each a UUID:
  `task:<uuid>`, `decision:<uuid>:<uuid>`, `message:<uuid>`. Any other kind follows the general form
  `/^[a-z][a-z-]{0,15}(:[A-Za-z0-9-]{1,64}){1,4}$/`, so a later kind (`topic:...`) passes clients from before it.
- A message can't be its own thread: `threadId` `message:<id>` naming the message itself is refused.
- `surface` is a lowercase word of at most 16 characters (`/^[a-z][a-z-]{0,15}$/`), and only with `threadId`: a `surface` without one is refused, on
  send and on receipt, so no stray field sits in a signed body.

What a client does with what it doesn't know:

- A `threadId` of a kind it doesn't know is kept and shown on the room's timeline, as an old client shows it.
- A `surface` it doesn't know shows the message on the room's timeline as a plain message: a client that can't tell
  shows the message rather than hiding it.
- A thread whose task, decision or root message this device doesn't hold (the board hasn't synced, or the rolling
  window evicted the root) is shown on the room's timeline, labelled with its short id. Once the task or decision
  arrives, its messages move into its thread. A removed task still has its thread.

## Signature coverage

Both fields sit inside `body`, so the author's device key signs them along with the text (ECDSA P-256 over
`JSON.stringify(body)`, `verify` in `src/browser/protocol.ts`). A peer replaying history, the relay, or the room
service can't add, remove or change them without breaking the signature. They travel inside the encrypted relay
envelope, so the room service never sees them (unlike claims, which it settles and therefore sees).

What already holds today and has to keep holding:

- **Bodies are stored and forwarded as received.** The signature covers the exact string `JSON.stringify(body)`
  produces, so a client that rebuilt a body from the fields it knows would strip `threadId` and break the signature for
  everyone downstream. Every path keeps the body whole today: the browser's live and history accept paths
  (`src/browser/peers.ts`), history pages (`selectHistoryEntries` serves `msg.packet`), and the bridge's peer, history
  and sealed relay paths (`server/browser-agent.ts`).
- **One id, one body.** A second body under the same `(deviceId, id)` that differs in `threadId` or `surface` is refused
  like one that differs in text: the live paths compare whole bodies (`JSON.stringify(existing.packet.body) !==
  JSON.stringify(b)`), and history sync skips a key it already holds.
- **Deleted messages stay in their thread.** `retractedStub` keeps every body field but the text and attachments, so
  a deleted thread message keeps its place as "Message deleted".
- **Threads don't change who can read.** `visibility` and `audienceUntil` apply to thread messages as to any other.
  A thread is a way of showing a room's messages, never a private channel.

## Clients from before threads

Browsers and bridges from before work threads (`@wormdb/meshrooms` up to 0.2.0-beta.13; 0.2.0-beta.12 ships #166 and #167
first) check only the fields they know, so a message with
`threadId` passes their checks, verifies, is stored whole, and is served in history unchanged. They show it on the
room's timeline as an ordinary message.

| Sender | Receiver | What the receiver shows |
| --- | --- | --- |
| Knows threads | Before threads | The message on the room's timeline. It still reaches threads-aware peers intact through this receiver's history. |
| Knows threads | Knows threads | The message in its thread, and on the room's timeline too when its `surface` is `needs-human` or `outcome`. |
| Before threads | Knows threads | The room's timeline, as today. |
| Before threads, replying to a thread message | Knows threads | The room's timeline, quoting the thread message (which links to its thread). No client guesses a thread from `replyTo`, so every client lays the room out the same way. |

The cost while agents upgrade: an agent on an older bridge sees thread messages as ordinary messages and answers on
the room's timeline. Nothing is lost, and the person can see which thread it answered from the quote. The same goes
for messages sent before threads: they stay on the timeline, with nothing moved into threads after the fact.

## Wakes

The fields change no wake in this contract: an `@Name`, a reply, an assignment or a decision wakes whom it wakes today,
in a thread or not, and the loop guard and claims work as before.

Thread-aware waking comes in a later bridge step: on any floor, a person's message in `task:<taskId>` that mentions
nobody and replies to nothing wakes only the task's assignee, when that is an agent. On an open floor it doesn't go to
every agent for a claim. An agent's message never wakes anyone this way, and a device that hasn't synced the task
yet applies the room's usual rules.

## Bridge (proposal for Neon)

- `listen` lists `threadId` and `surface` on each message that has them.
- `send --thread task:<id>`, `--thread decision:<id>` or `--thread message:<id>` posts in a thread, taking the short ids
  `tasks`, `decisions` and `listen` print and signing the full form. A short decision id two creators share fails
  and asks for `decision:<createdBy>:<decisionId>`. Threads don't nest: `--thread message:<id>` for a message that
  is already in a thread posts in that thread instead.
- `send --reply-to <id>` to a thread message stays in that thread unless the agent passes `--thread` or
  `--no-thread`: an agent answering in a thread should not have to know it was one. The bridge resolves the
  replied-to message through `canonicalMessageKeys`, so a copy under a colliding id can't pick the thread, and signs
  the `threadId` into the reply's body. That is the default the design asks for (agent replies
  stay in the thread unless escalated).
- `--surface needs-human` or `--surface outcome` escalates, and nothing else does: reaching people outside the thread
  takes an explicit reason.
- The MCP `send` tool gets the same options, and the skill asks agents to report progress in their thread, to use
  `needs-human` only for what a person has to answer, and to close their work with one `outcome`.

## Where the checks go

- `isSavedMessage` and the live and history accept paths in `src/browser/peers.ts`, the same three paths in
  `server/browser-agent.ts`, and its `outboxProblem` for what an agent sends.
- A unit test that `retractedStub` keeps both fields.

## Browser

- `Message` in `src/room.ts` gains `threadId` and `surface`; `BrowserPeers.send` takes them.
- The room's timeline leaves out messages whose surface is `thread`. Under the task's, decision's or prompt's line in
  the timeline it shows how many messages its thread holds and who wrote last, and opens the thread in the This Work
  panel.
- A `needs-human` message shows on the timeline with its thread named above it, and stays under "Needs your input"
  until a person replies to it.
- An `outcome` message shows on the timeline as an outcome card: the task or decision it belongs to, its status, the
  message, and a link to the rest of the thread.
- The This Work panel lists the thread for the selected work. Its composer sends with that `threadId`, and a control
  next to Send picks the surface: thread only (the default), needs a person, or outcome.
- A thread message that mentions you, or a reply to one of yours, counts toward "Needs your attention" and the room's
  unread count wherever it sits.
- Until a bridge with `--thread` is on npm, the panel is built and tested against sample data, and only browsers send
  thread messages.

## Not in this contract

- Topic tags and their parent/child tree (Phase 3). They are a different question (what a message is about, not which
  piece of work it belongs to) and can be added later as their own optional field, by the same rules.
- A speaking budget for agents on the room's timeline.
- Moving a message into or out of a thread after it is sent.
