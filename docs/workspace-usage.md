# Workspace Storage Usage

Cloud workspace usage snapshots are cached in Redis. This feature adds no database
migration or billing ledger. Local sandboxes return `workspaceUsage: null`.

## Execution

`workspace.usage.dispatch` and `workspace.usage.scan` are ordinary jobs on
`cohub-system`, consumed by the existing system worker. A scan receives a
`spaceId` and reads `/space-storage/{spaceId}/workspace`, including dependency,
build, and hidden folders. It does not wake the sandbox. The index a sandbox keeps
under `/space-system/{spaceId}/index` and the checkpoint cache are not part of the
workspace and are not counted.

`/api/queues` and `/api/queues/metrics` include these jobs in system queue counts;
`registeredJobs` lists their names. Counts are queue-wide, not per job name. Jobs
waiting for a NAS scan slot use BullMQ delayed state and do not occupy worker
concurrency. External autoscaling should focus on executable `waiting` and
`active` work rather than treating future `delayed` jobs as immediate demand.

`workspaceUsage` is part of the space detail response and the SDK `SpaceRecord`,
so `GET /api/spaces/:id`, Space settings, and `cohub spaces get [id]` show it.
Space list responses omit it: the list stays a bounded index read.

## Incremental Behavior

The system tracks whether a workspace may have changed; it does not incrementally
calculate byte deltas. These direct writers mark a workspace dirty before and after
their batch:

- API file writes, deletes, moves, exclusive creates, and multipart uploads that
  land on the volume while no sandbox is dialable (`apps/api/src/space-fs-backend.ts`).
- The worker's `create_space` task, which restores a checkpoint, imports a git
  repo, and materializes the latest snapshot during bootstrap.

Writes through a running sandbox need no marker: a running workspace is never
clean. Sandbox provision, resume, and stop transitions also mark usage dirty.
Inventory and scan jobs reconcile lifecycle state as a recovery mechanism.

An atomic revision and writer count coalesce each batch without recording per-file
events. A stopped workspace becomes clean after a successful scan with an unchanged
revision and no active writers. Running or uncertain sandboxes remain dirty and are
recalibrated at most once every 48 hours. Initial scans are not subject to this
cooldown. Writes during a scan remain dirty and wait for the same cooldown.

Clean workspaces are measured again after 30 days. That bound only matters when a
write marker was lost, because both markers of a write would have to fail while
Redis was unavailable; lost state otherwise means **unknown**, and unknown is never
clean.

Each calibration still runs a full `pdu` traversal of that workspace. There is no
reliable general-purpose incremental byte counter for arbitrary processes writing
to an NFS-mounted workspace: clients can bypass API markers, and root directory
mtime or client-side filesystem events cannot prove that the tree is unchanged.
Operations that modify NAS contents outside tracked write paths must mark the
workspace dirty. A true delta counter would require every writer to report exact
allocated-byte additions, replacements, and deletions, or a reliable server-side
filesystem change journal.

Stopped-workspace writes are coalesced for five minutes, and a scan starts no
sooner than `max(five minutes, last measurement + 48 hours)`. Pdu scan failures and
path preflight failures retain the last successful bytes and measurement time, keep
the workspace dirty, and record `error` so retries back off instead of retrying
every dispatch. A successful scan while files are changing is still an estimate,
not a point-in-time filesystem snapshot. A workspace larger than the five-minute
pdu budget never receives a value; it stays `pending` and consumes one scan slot per
attempt.

## Scheduling Policy

- Dispatch runs every minute. It reconciles 200 database space/sandbox records
  using a UUID cursor, then reserves due scans through a bounded pending window
  (four per batch, one scan slot). Inventory reads metadata only; it does not
  enumerate NAS files. A full inventory rotation takes approximately
  `ceil(space count / 200)` minutes.
- The minimum interval between pdu scan attempts is 48 hours per workspace. The
  same limit applies to writes, lifecycle changes, changes during a scan, and
  retries.
- One global scan slot per environment and one pdu thread per scan, so
  environments sharing a NAS must budget their combined scan load.
- No read path starts pdu. API summary reads degrade to unknown on Redis errors.

## Redis and Recovery

State lives under `cohub:{workspace-usage-<env>}` in `REDIS_URL`, separate from
BullMQ's `BULLMQ_REDIS_URL` when configured. Each space uses one hash, with shared
sorted sets for due times, scan leases, and pending jobs. No per-file index is
stored, and clean snapshots have no TTL. Lua scripts update revisions and due
times atomically. UUID revisions and expiring scan tokens reject stale results.

Missing or evicted state means **unknown**, never zero or clean. Bounded inventory
recreates missing state and gradually scans it. Enable Redis persistence to retain
the 48-hour cooldown and avoid recalibration after Redis loss. Without persistence,
lost state is unknown and scans resume in bounded order.

Usage is an estimate, so a Redis failure never blocks a write: the marker is best
effort, and a write whose markers both fail stays unmeasured until the workspace's
next lifecycle change or clean recalibration. A failed marker is logged, not
retried, because the retry would delay the user's write.

The scanner measures allocated blocks, deduplicates hardlinks within a workspace,
stays on one filesystem, and never follows symlinks. It does not account for
provider-side replication, snapshots, or cross-workspace sharing. The worker image
pins pdu 0.24.0 for Linux amd64 with SHA-256 verification. JSON output contains
only the workspace root summary. Read errors, nonzero exit, malformed output,
overflow, timeout, or a lost lease prevent publishing a new value. This is not a
billing ledger.

## Fixed Policy

The NAS protection policy is fixed in worker code rather than deployment settings:
one global scan slot per environment, one pdu thread, a five-minute timeout, a
48-hour minimum interval per workspace, a 30-day clean recalibration, an inventory
page of 200, and a dispatch batch of four. A local `WORKSPACE_USAGE_PDU_PATH`
override is available for tests and development only.

## Validation

```bash
COHUB_TEST_PDU_PATH=/path/to/pdu node scripts/test/run.mjs apps/worker/tests/workspace-usage.test.ts
# Use a dedicated disposable Redis instance for this integration test.
COHUB_TEST_ALLOW_NETWORK=1 COHUB_TEST_USAGE_REDIS_URL=redis://127.0.0.1:16389 \
  node scripts/test/run.mjs apps/worker/tests/workspace-usage-redis.test.ts
```
