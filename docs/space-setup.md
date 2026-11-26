# Space startup scripts

Cloud sandboxes discover `.cohub/setup.sh` by convention. No Space configuration is required. Legacy `.agents/setup.sh` files are not executed; there is no fallback or automatic migration.

After the workspace bootstrap (blank workspace, Git import, or checkpoint restore) completes, each new sandbox process runs:

1. `/configs/user/.cohub/setup.sh`
2. `/mods/<slug>/.cohub/setup.sh`, in the enabled mods' existing sort order
3. `/workspace/.cohub/setup.sh`

Missing files are skipped. User config publishing projects only `.cohub/setup.sh` into a dedicated `.sandbox-setup` directory, mounted read-only at `/configs/user/.cohub`. Other user `.cohub` files, including model credentials, are never mounted. Publish the user config after adding or updating its setup script; no existing user files are migrated.

Scripts run serially with Bash, without requiring an executable bit. The working directory is the host Space workspace for every script. Each script runs in a separate process; `export` does not change later scripts or the sandbox environment. `COHUB_SETUP_DIR` identifies the current script's directory, and `WORKSPACE_DIR` identifies the host workspace.

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$WORKSPACE_DIR"
pnpm install --frozen-lockfile
```

## Execution semantics

- Automatic setup runs once per sandbox process. Browser refresh, multiple clients, and WebSocket reconnects do not rerun it.
- A sandbox restart/recreation runs setup again. Scripts must be idempotent and must not overwrite user data.
- Script edits take effect on the next sandbox start. Use the existing sandbox recovery/recreate action to retry a failed run; it restarts the sandbox and may interrupt other work.
- Each script has a five-minute timeout. Failure stops subsequent scripts and marks the sandbox degraded, without automatically recreating it. Files and repair tools remain accessible after failure; Agent work waits while setup is pending. Failed setup remains visible through the degraded runtime status and setup report, without locking users out of repair commands.
- Scripts must exit. This is not a service supervisor; backgrounding a server is not a supported service lifecycle.
- **Local Spaces never run setup automatically**, including user and mod scripts. The local runtime also rejects the cloud coordination/execution entry points.

## Trust and mods

Startup scripts execute as the sandbox user and can modify the host Space. A read-only mod mount protects the mod files, not the host workspace. Only import trusted projects and mount trusted mods. Mods currently use their checkpoint cache's `latest` materialization; a later mod update can therefore change the code run on a future sandbox start. There is no additional approval/configuration layer.

Sandbox RPC/report credentials are not inherited by scripts. Scripts receive ordinary sandbox environment variables, not Agent execution grants.

## Status and logs

- Web: Space settings → Sandbox → Startup scripts.
- CLI: `cohub spaces setup <space-id> [--json]`.
- SDK: `(await client.space(spaceId).sandbox.get()).sandbox?.meta?.setup`.

Each step records its path, status, exit code, duration, and bounded stdout/stderr previews. `runId` is a random UUID identifying an execution, not an ordering key. The current snapshot uses report arrival order: replacement-Pod credentials are fenced, but delayed reports across container restarts within the same Pod are not yet fenced by process generation or revision.

Full output and a final `result.json` are stored in:

```text
.cohub/system/setup/<run-id>/<step-number>/
  stdout.log
  stderr.log
  result.json
```

Logs are written as streams, not accumulated in memory. They persist in the workspace volume across sandbox recreation and are excluded from checkpoints by the existing `.cohub/system/` hard exclusion. No automatic log deletion is introduced; logs consume workspace storage. Historical logs can be inspected through the existing file APIs/CLI. If logging fails, the step fails rather than silently discarding output.

## Bootstrap coordination

The cloud runtime uses its existing instance-authenticated sandbox report channel. The API returns a gate derived from durable `space.meta.bootstrap`:

- `ready`, or legacy Spaces with no bootstrap metadata: ready.
- `pending`, `running`, missing/invalid status: wait.
- `failed`: remain waiting with an explicit bootstrap failure message; execute nothing.

The sandbox retries the gate every second for the first minute, then every five seconds, while waiting, including after transient API failures. Only an explicit `ready` response unlocks setup. An older API response without a gate fails closed. This requires deploying the API before the new sandbox image. The final setup report is retried until acknowledged; successful idle sandboxes do not keep polling.

The same loop handles either bootstrap/sandbox startup ordering and import retries without relying on PubSub delivery or a checkpointable ready-marker file. Setup deduplication is process-local, never stored as a workspace marker.
