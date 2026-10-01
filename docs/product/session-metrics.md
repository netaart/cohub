# Session statistics

Session statistics are an observational, rebuildable projection, not a billing ledger.
No database columns or migrations are required.

## Storage and accounting

- `turn.meta.metrics` contains versioned execution timestamps, tool timing summaries,
  retry waits and small provider-attempt receipts keyed by unique attempt ID. Receipts
  contain timing and usage, not prompts, tool arguments or response text. Finalizing
  the same receipt replaces it; it does not increment consumption again.
- Existing `totalUsage`, `durationMs`, `intermediateSummary.compaction` and
  image-description summaries remain the sources of existing facts. New statistics
  do not alter billing, the transcript or historical usage.
- Discarded retry attempts supplement transcript usage exactly once. Known image
  description usage on a discarded attempt is retained too. An interrupted request
  with no provider usage is **unknown**, not free.
- Compaction usage is already included in its owning Turn, or in its own compact
  Turn. It is shown as a subset, never added again. Compact and merged Turns do not
  increment the conversation count.
- Generation tasks invoked through tools/CLI are read from task receipts. A task
  already represented by a direct-generation Turn is not counted twice. Completed
  billing-retry receipts reconcile known charges without changing billing data.
- Estimated LLM cost, official generation cost and confirmed generation charges are
  separate fields. They are not combined into a misleading monetary total.

`session.meta.stats` stores the server projection with a monotonically increasing
revision, separate `own` and `inherited` statistics, and separate title-task usage.
Fork ranges use the existing timeline segments; copying the parent's full total is
incorrect. Inherited work is not new consumption by the child Session.

## Refresh and clients

Refresh runs after settled Turn events, completed generation/billing tasks and title
updates. Updates to source Sessions also refresh dependent timeline segments. The
Session row serializes rebuilds; a JSONB namespace update preserves unrelated meta
and does not bump activity timestamps. Failures are best effort and do not roll back
completed work.

`GET /api/sessions/:id/stats` uses `session.view` authorization and rebuilds the
projection. This also provides on-demand historical repair without traversing all
Turns in the browser or fetching transcripts/object storage. Reads aggregate bounded
fields from indexed Session/segment ranges. Very long histories may eventually need
an incremental projection; there is deliberately no second ledger in this version.

SDK: `client.space(spaceId).session(sessionId).stats({ signal })`.
CLI: `cohub spaces sessions stats <id> [--json]`.

Realtime `session.updated` carries a safe `stats` projection, not arbitrary Session
meta. Web merges it into cached Session metadata using its revision. The statistics
panel displays cached data immediately and refreshes silently. A failed refresh keeps
available data and offers Retry. Footer details use the same card on hover, click and
keyboard; Session details live in the Header menu. No permanent statistics bar is added.

## Timing semantics and limitations

- New cloud Turns distinguish pre-execution waiting from execution time. Historical
  `durationMs` is retained as recorded; its start boundary was not uniform.
- Model request duration excludes image preparation and tool execution. TTFT starts
  at request dispatch and ends at the first nonempty text/thinking/tool-argument
  delta, not at an empty start or completion event. Monotonic clocks measure duration.
- TPS uses the sum of reported output tokens over matching post-first-token request
  durations. Reasoning tokens may be included by the provider. Missing timing samples
  are excluded; averages are not averaged across Turns.
- Tool active time is the union of available intervals, including parallel/nested
  execution. Image-description duration is cumulative workflow time. Categories may
  overlap and must not be blindly added to obtain wall-clock time.
- Native/imported transcripts, missing historical timing, failed compaction attempts,
  discarded title results and provider-internal retries are not reconstructed by
  guessing. Sandbox infrastructure costs and arbitrary external services invoked by
  tools are outside the observed usage boundary.
- Collection is best effort, not a crash-proof external billing journal. A running
  receipt left by a crash or a missing usage report stays partial. Legacy zero-filled
  usage cannot be retroactively distinguished from an actual reported zero.

## Validation

Pure accounting tests: `packages/protocol/session-metrics.test.ts`.
Client merge tests: `apps/web/src/tests/session-stats-merge.test.ts`.
SDK endpoint test: `packages/sdk/tests/session-stats.test.ts`.

For isolated SQL/concurrency tests, use the existing runtime-test convention. Install
`@electric-sql/pglite` and `drizzle-orm` in a disposable directory, then run:

```sh
RUNTIME_TEST_DB_HOME=/path/to/test-engine node --import tsx --test \
  packages/core/src/sessions/stats.integration.mjs
RUNTIME_TEST_DB_HOME=/path/to/test-engine node --experimental-test-module-mocks \
  --disable-warning=ExperimentalWarning --import tsx --test \
  apps/agent/src/tests/metrics.integration.mjs
```

These tests use an in-memory PostgreSQL engine. They never connect to the application
DB or run migrations against user data.
