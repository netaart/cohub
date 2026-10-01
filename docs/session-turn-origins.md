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
states. Relationship cards and native harness subagent import are separate UI/runtime
work, not part of this recording layer. Native subthreads not imported as Cohub Turns
and direct-generation executions are outside this prompt-origin path.

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
