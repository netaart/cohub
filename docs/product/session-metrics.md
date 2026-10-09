# Session statistics

Statistics are a rebuildable projection, not a billing ledger. No schema migration
is required; original messages, task results and billing records remain intact.

## Data

- `turn.meta.metrics` adds request timing, retry waits and tool timing to existing
  usage fields. Attempt IDs make retries distinguishable without storing prompts.
- `session.meta.stats` separates new work (`own`) from Fork history (`inherited`).
  Inherited totals follow timeline segments, not the parent's entire Session.
- Compaction is included in usage and shown as a subset. Generation tasks already
  represented by a Turn are not counted twice. Title usage is separate.
- `modelCostUsd` and `generationCostUsd` use model/service cost records. Actual
  charges stay in authorized task billing views; shared `chargedCostUsd` is null.
  Old `estimatedCostUsd` / `providerCostUsd` names remain readable without migration.
- Session responses, caches and realtime fan-out redact old private charge fields.

## Refresh and access

Refreshes run outside completion publication, coalesce over 25 ms and use at most
two concurrent rebuilds per process. Updates arriving during a rebuild trigger a
follow-up pass. Forks ending before the affected range are skipped; task queries are
bounded by source Sessions and Turn intervals. Updates preserve unrelated metadata and activity time.

`GET /api/sessions/:id/stats` requires `session.view`, reuses projections for up to
30 seconds and rebuilds stale/missing data without reading transcript archives.
Very long histories may eventually need incremental aggregation.

- SDK: `client.space(spaceId).session(sessionId).stats({ signal })`
- CLI: `cohub spaces sessions stats <id> [--json]`
- Web: Footer details and Header statistics; cached first, silently refreshed.

## Interpretation

TTFT measures the first nonempty text/thinking/tool-argument delta after dispatch.
TPS uses matching output-token and post-first-token duration samples; provider
output may include reasoning tokens. Tool time unions overlapping intervals.
Timing categories can overlap and are not additive wall-clock phases.

Repeated aborts preserve settled receipts and timestamps. Late steer attribution
updates the Turn without emitting another finalized event. Excluded final/error
usage is included once. Missing or contradictory historical data remains partial;
external infrastructure costs and provider-internal retries are not inferred.

## Validation

Use workspace tests and typecheck. Existing SQL/runtime integration tests accept
`RUNTIME_TEST_DB_HOME` pointing to a disposable installation of `@electric-sql/pglite`
and `drizzle-orm`; they do not connect to the business database.
