# Session and Turn origins

Prompt-created Turns record their immediate caller in `session_turns.meta.origin`:

```ts
{
  kind: "prompt", // scheduled_prompt | background_task | hook
  spaceId: "caller-space-id",
  sessionId: "caller-session-id",
  turnId: "caller-turn-id",
  toolCallId: "call_review", // optional opaque harness ID
  depth: 1                  // optional when historical ancestry is unknown
}
```

The target is the Turn owning this metadata. Same-Space calls, cross-Space calls,
and follow-ups sent to the caller's own Session use the same path. Sending five
prompts to one review Session from one parent Turn creates five edges from that
parent, not a chain between the review Turns. If a later parent Turn sends the
next prompt, that later Turn becomes the caller.

## Recording

- The CLI supplies caller headers from its `COHUB_*` environment. SDK callers can
  configure `requestSource`; changing the target Space or Session does not change it.
- The API resolves a caller Turn by primary key, checks supplied ancestry against
  its owning Session/Space, and requires `session.view` on that source before
  recording an HTTP origin. Unauthorized sources are not enriched or indexed.
  Internal events and scheduled snapshots use the trusted execution path. Ordinary
  prompts without a source Turn perform no extra lookup or permission check.
- `meta.requestSource` retains normalized request provenance, including partial
  identities that cannot be resolved. Unknown callers do not produce fabricated edges.
- Origin is saved with the Turn before execution is queued. Failure to dispatch the
  Turn does not erase its provenance. `meta.source` remains the channel string.
- Sessions created by the prompt or explicit Session-creation endpoint retain their
  own creation origin. Sending more prompts does not re-parent an existing Session.
  Forks use `session_forks` and do not inherit the parent's creation origin.
- Scheduled prompts snapshot origin at creation. Each execution retains that snapshot
  plus `meta.context.taskRunId` and `meta.context.cronJobId`. Editing the scheduled
  payload preserves creation provenance. Execution does not need to re-read the caller.
- Background bash completion uses its existing task origin. Prompt hooks triggered by
  `session.turn.finalized` use the event's Turn. Other hook events do not invent a Turn.

## Querying

`resource_references` contains a rebuildable `turn_trigger` index:

- Source: caller Turn, with `sourceSpaceId` and `sourceSessionId` for rollups.
- Target: created Turn, with `meta.targetSpaceId` and `meta.targetSessionId`.
- `meta.kind` distinguishes prompt, schedule, background task and hook origins.
- `meta.toolCallId` associates the child with a specific tool invocation when available.
- Each edge uses `count = 1` with set-on-conflict semantics, so queue retries and
  backfills converge. The existing cross-Space `tool_call` statistics are independent.

```sh
cohub references query turn:<id> --direction out --kinds turn_trigger --json
cohub references query session:<id> --direction out --kinds turn_trigger --json
cohub references query turn:<id> --direction in --kinds turn_trigger --json
cohub spaces sessions turns get <sessionId> <turnId>
```

The existing incoming reference query matches the exact target resource; a Session
incoming query does not roll up all of its Turns. Use the Turn query or Session's
creation metadata for that distinction.

The SDK exports `SessionTurnOrigin`, `readSessionTurnOrigin(meta, spaceId?)` and
`normalizeSessionTurnOrigin`. The reader also supports historical background-task
origins when supplied their owning Space. Existing Turn HTTP/realtime payloads and
Web caches retain origin inside `meta`, without new fetches, subscriptions or loading
states. Direct-generation executions are outside this prompt-origin path.

A local harness's subagent thread syncs as its own Session through native ingest, whose Turns carry
`caller: { sessionId, turnId, toolCallId? }`. The server resolves it like a prompt's caller (the
user needs `session.view` on it) when it creates the Turn, records `kind: "prompt"` in the Turn's and the new
Session's `meta.origin`, marks the Turn's `initiator` as `agent`, and appends `messagesSent` and the
`turn_trigger` edge as below. The caller Turn is the parent Turn running when the subagent's Turn
began; only the first Turn names the spawning tool call, and only when the harness records it (Claude
Code, Codex). A caller the server cannot resolve leaves the Turn unlinked; the caller is never part
of the Turn's identity.

## Caller side

When a direct prompt (`kind: "prompt"`) creates a Turn, the Session service appends
`{ spaceId, sessionId, turnId, kind, toolCallId? }` to the caller Turn's
`meta.messagesSent` and publishes `session.turn.updated` for the caller, so its
watchers see the fan-out while the caller is still running. The append is one jsonb
concatenation, so concurrent children never overwrite each other; writers that touch
a running Turn's `meta` merge with `||` instead of rewriting it. The list is the
caller's only copy and is not truncated. Scheduled runs, background tasks and hooks
are not mirrored. The SDK reads it with `readSentTurns(meta)`; entries recorded before
`spaceId` was added omit it.

Web projects both halves from loaded Turns: the child's user message links back to
the caller ("From …"), and the caller's process card and tool-call rows link to the
children, folding repeat prompts to one Session. Follow-ups a Turn sends to its own
Session are not shown, since they appear in the same timeline. Titles come from the
loaded Space list, then the Session cache, then a bounded fetch of only the links on
screen; a 403/404 renders the Session as unavailable rather than as a link.

## Replies

A child Turn with `meta.reply = { mode }` delivers its final result back to the Session
in its `meta.origin` once it settles (completed, failed, interrupted or cancelled):

- `note` records a note there; `prompt` also runs that Session's Agent with the caller
  Turn's Harness, model and access mode.
- The delivered Turn has `origin = { kind: "reply", …child Turn, depth: caller's depth }`,
  so depth counts nesting and sequential delegations stay at one level. The caller's
  `messagesSent` entry carries `reply` so clients show it as awaited.
- Content is a header block (`Reply from @[Space](cohub://spaces/…/sessions/…):`), the
  child's final text and images, and a status block when it did not complete. Both
  frame blocks carry `_meta.reply` so clients render them natively, while every Harness
  reads the reply as an ordinary user message. Neither frame block counts as a mention.
- A merged follow-up is answered with its owner's result. A child that failed before any
  Agent claimed it was already reported to its sender, so it is delivered as a note.
  Waking stops past `MAX_REPLY_WAKE_DEPTH` (4) nested delegations, apps' delegated
  authority is never reused, and a wake the Session cannot run (permission, billing,
  Harness) becomes a note instead; nothing is delivered when the sender can no longer
  write to the caller's Session.

Every path that moves a Turn to a terminal status calls the app's `onTurnSettled`
(`@cohub/infra/session-turn-settled`): Agent finalization and stale recovery, failures
before running, cancelled follow-ups, local Runtime results and direct generations.
Merged Turns settle with their batch owner, whose `executionBatch.replies` marks a batch
holding a reply. The check is in memory (`needsTurnReplyDelivery`); only matches queue a
`session.turn.reply` system job keyed by Turn. Delivery is idempotent through the
`reply:<childTurnId>` client message ID, so retries and duplicate settle events converge.
`turn_trigger` edges carry the reply mode.

The API accepts `reply` only on immediate agent prompts sent from a Cohub Turn and
rejects it otherwise. CLI callers delegate with
`cohub -s <spaceId> spaces prompt --reply "…"`, which needs the `COHUB_*` caller
headers of a running Turn.

## Recovery and validation

No DB schema migration is required. Index writes use the existing asynchronous queue;
origin in the Turn is authoritative, not the index. The existing
`scripts/backfill-resource-references.ts` now indexes stored origin and the legacy
background-task context as well. Start with `--dry-run --max-turns 100`; missing
historical caller data is left missing. Never infer it from shell commands or titles.

Tests cover caller headers, opaque tool IDs, same/cross-Space calls, self follow-ups,
review loops, scheduled execution snapshots, cron edits, background tasks, hook
provenance, dispatch failure, idempotent edge extraction and Web cache/timeline
preservation. No production prompts, cron jobs or backfills are needed for these tests.
