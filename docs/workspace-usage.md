# Workspace Storage Usage

Cloud workspace usage snapshots are cached in Redis. This feature adds no database
migration or billing ledger. Local sandboxes return `workspaceUsage: null`.

## Execution

`workspace.usage.dispatch` and `workspace.usage.scan` are ordinary jobs on
`cohub-system`, consumed by the existing system worker. A scan receives a
`spaceId` and reads `/space-storage/{spaceId}/workspace`, including dependency,
build, and hidden folders. It does not wake the sandbox.

`/api/queues` and `/api/queues/metrics` include these jobs in system queue counts;
`registeredJobs` lists their names. Counts are queue-wide, not per job name. Jobs
waiting for a NAS scan slot use BullMQ delayed state and do not occupy worker
concurrency. External autoscaling should focus on executable `waiting` and
`active` work rather than treating future `delayed` jobs as immediate demand.

## Incremental Behavior

The system tracks whether a workspace may have changed; it does not incrementally
calculate byte deltas. Cloud API write batches and worker create/import/restore
operations mark a workspace dirty before and after writing. An atomic revision
and writer count coalesce each batch without recording per-file events. Sandbox
provision, resume, and stop transitions also mark usage dirty. Inventory and scan
jobs reconcile lifecycle state as a recovery mechanism.

A stopped workspace becomes clean after a successful scan with an unchanged
revision and no active writers. Clean stopped workspaces have no scan scheduled,
so they are skipped until a tracked write or lifecycle change marks them dirty.
Running or uncertain sandboxes remain dirty and are recalibrated at most once
every 48 hours. Initial scans are not subject to this cooldown. Changes during a
scan remain dirty and wait for the same cooldown before another scan.

Each calibration still runs a full `pdu` traversal of that workspace. There is no
reliable general-purpose incremental byte counter for arbitrary processes writing
to an NFS-mounted workspace: clients can bypass API markers, and root directory
mtime or client-side filesystem events cannot prove that the tree is unchanged.
Operations that modify NAS contents outside tracked write paths must mark the
workspace dirty. A true delta counter would require every writer to report exact
allocated-byte additions, replacements, and deletions, or a reliable server-side
filesystem change journal.

Stopped-workspace writes are coalesced for five minutes. Pdu scan failures retain
the last successful bytes and measurement time, and retry no sooner than the
configured minimum interval. Path preflight failures before pdu starts do not
consume the scan cooldown. A successful scan while files are changing is still an
estimate, not a point-in-time filesystem snapshot.

## Scheduling Policy

- Dispatch runs every minute. It reconciles 200 database space/sandbox records
  using a UUID cursor, then enqueues due scans through a bounded pending window
  (default 50). Inventory reads metadata only; it does not enumerate NAS files.
  A full inventory rotation takes approximately `ceil(space count / 200)` minutes.
- The default minimum interval between pdu scan attempts is 48 hours. The same
  limit applies to writes, lifecycle changes, changes during a scan, and retries.
- The global scan concurrency defaults to one per environment, and each pdu
  process defaults to one thread. Environments sharing a NAS must budget their
  combined scan load.
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
lost state is unknown and scans resume in bounded order. A Redis outage before a
write marker is recorded fails the write before touching NAS; a failed completion
marker leaves the workspace dirty.

The scanner measures allocated blocks, deduplicates hardlinks within a workspace,
stays on one filesystem, and never follows symlinks. It does not account for
provider-side replication, snapshots, or cross-workspace sharing. The worker image
pins pdu 0.24.0 for Linux amd64 with SHA-256 verification. JSON output contains
only the workspace root summary. Read errors, nonzero exit, malformed output,
overflow, timeout, or a lost lease prevent publishing a new value. This is not a
billing ledger.

## Fixed Policy

The initial NAS protection policy is intentionally fixed in worker code: one
global scan slot per environment, one pdu thread, a five-minute timeout, a
48-hour minimum interval per workspace, and a dispatch batch size of 50. The
dispatcher runs every minute. These values are not deployment settings. A local
`WORKSPACE_USAGE_PDU_PATH` override is available for tests and development only.

`workspaceUsage` is included in normal space detail/list responses and SDK
`SpaceRecord`. `cohub spaces get [id] --json` exposes it unchanged; normal CLI
output includes bytes, measurement time, and status. Web Space settings display
bytes and measurement time, reuse cached space data, refresh on the usage event or
focus, and hide the row for local sandboxes.

## Validation

```bash
COHUB_TEST_PDU_PATH=/path/to/pdu node scripts/test/run.mjs apps/worker/tests/workspace-usage.test.ts
# Use a dedicated disposable Redis instance for this integration test.
COHUB_TEST_ALLOW_NETWORK=1 COHUB_TEST_USAGE_REDIS_URL=redis://127.0.0.1:16389 \
  node scripts/test/run.mjs apps/worker/tests/workspace-usage-redis.test.ts
```
