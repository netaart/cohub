# Agent / Sandbox Runtime

This document covers the workspace bridge, environment variables and local development.
Harness execution and resume use the [Local Runtime](local-runtime.md) pipeline.

## Current Architecture

- `apps/agent`
  - Control plane
  - Runs Cohub Harness and dispatches local Pi / Codex Harness
  - Manages session / Redis / persistence
  - Connects to sandbox as an outbound WebSocket client
  - Forwards tool calls to sandbox over WebSocket RPC
- `apps/sandbox`
  - Execution plane
  - Exposes a WebSocket server and waits for agent connections
  - Executes generic sandbox filesystem / process primitives

## Local sandbox (dial-out) mode

Besides the cloud listen mode, the sandbox binary supports a `--local` dial-out mode that
turns a user's local folder into the sandbox of a Space:

- `apps/sandbox --local --space <id> --root <dir> --relay wss://gateway/sandbox/relay`
  - Reuses the same dispatcher / process / filewatch / ws session code
  - **Path fence**: fs RPC (read/write/stat/ls/find/grep) and process cwd are confined to `--root` (realpath + symlink escape prevention)
  - **No OS-level isolation for process execution**: `bash` / argv run as the current user and can reach host resources outside `--root`. This matches the "run an AI coding agent on your own machine" trust model and is intentional; `runtime up` shows an explicit informed-consent prompt before starting. For strong isolation, run the runner inside a container / VM
  - The relay data channel is currently bound only through a one-time random channelId (issued over the authenticated control channel, 15s expiry, single pairing); per-channel HMAC can be added later
  - Authenticates to the gateway with `COHUB_RELAY_TOKEN` (user access token)
- `apps/gateway` provides the relay:
  - `/sandbox/relay` (control, local runner connects, authorized by `sandbox.manage`)
  - `/sandbox/relay/data?channel=<id>` (data channel dialed back on demand by the local machine)
  - `/internal/sandbox-relay/:spaceId` (in-cluster agent/worker access, authorized by `x-worker-secret`)
  - Once control is established, the gateway is the single status reporter: ready + `wsEndpoint`; disconnect -> stopped(disconnected)
  - The data channel pipes frames transparently; the gateway does not parse RPC
- When `space_sandboxes.provider = "local"`, the controller short-circuits provision / idle-destroy / recover
- CLI: `cohub runtime up <dir>` creates and remembers the directory's Space on first use, then reuses it on later starts, while supervising the Workspace bridge and local Harness

### Binary distribution

`cohub-sandboxd` is the same code as the cloud sandbox, run only as a `--local` dial-out.
CI (`.github/workflows/sandbox-binaries-build.yml`) cross-compiles common platforms when a `v*` tag is pushed:

- `linux/amd64`, `linux/arm64`, `darwin/amd64`, `darwin/arm64`, `windows/amd64`, `windows/arm64`
- Each platform produces `cohub-sandboxd_<version>_<os>_<arch>.tar.gz` + `.sha256`, plus an aggregated `SHA256SUMS.txt`
- The version is injected via `-ldflags -X main.buildVersion=<tag>`; inside containers the `COHUB_SANDBOX_VERSION` env var takes precedence and the legacy `IMAGE_VERSION` is accepted
- Windows archives contain `cohub-sandboxd.exe`; `verify:sandboxd` requires all six platforms before the CLI can publish
- Android is built by the app's Gradle build, not this workflow: `:app:buildSandboxd` cross-compiles
  `apps/sandbox` with Go and the NDK (cgo, for bionic's resolver) into the APK's native library
  directory, the one place an app may execute its own binaries. See [Local Runtime](local-runtime.md#android-device--android-设备)
- Artifacts are attached to the GitHub Release (private repo, internal downloads only) and uploaded to the public CDN `https://public.cohub.live/sandboxd/<version>/` (the CLI download source)

### Windows

Windows-only behavior lives in `*_windows.go` files and `win32` CLI branches; Unix paths are unchanged.

- Shell commands run through Git Bash (`COHUB_BASH`, then the Git installation next to `git.exe`, then the standard
  install locations). `bash` is never looked up on PATH because it commonly resolves to WSL. `LANG=C.UTF-8` is set
  when no locale is configured; native Windows programs may still write their own code page.
- Each command runs in a Job Object: abort/timeout terminates the whole tree, a normal exit leaves background
  descendants running (matching the Unix process group).
- Pi/Codex tool processes are not in a Job Object: cancelling a turn stops them with `taskkill /T`, which follows
  parent links, so a descendant whose parent already exited (a detached background job) can outlive the turn.
  On Unix the process group covers it.
- Rooted paths such as `/workspace/...` are sandbox paths. The fence compares case-insensitively and rejects
  UNC/device paths, drive-relative paths and alternate data streams.
- The managed control channel uses a per-launch named pipe (`COHUB_RUNTIME_CONTROL_PIPE`) instead of fd 3.
- `fs.delete` / `fs.move` (capabilities `fsDelete` / `fsMove`) replace the `rm` / `mv` argv fallback.

### Managed download (CLI)

On the first `cohub runtime up`, the CLI pulls the matching single-platform binary from the
public CDN for the current `os/arch`, verifies `.sha256`, and caches it under
`~/.cache/cohub/sandboxd/<version>/`; later runs hit the cache:

- The version is pinned by the `SANDBOXD_VERSION` constant in the CLI (independent of the CLI package version; protocol version `"1"` guarantees backward compatibility) and bumped manually as the runner evolves
- `COHUB_SANDBOXD_BIN` overrides the binary path (local `go build` / offline / self-built)
- `COHUB_SANDBOXD_CDN_BASE_URL` overrides the download source (staging / self-hosted)
- Concurrent `up` runs use an atomic mkdir lock to avoid duplicate downloads; a checksum mismatch is rejected outright

### Managed control pipe

Under a supervisor (`COHUB_RUNTIME_MANAGED=1`) refreshed tokens arrive as JSON lines on stdin and
lifecycle events (`hello`, `connected`, `disconnected`) leave on fd 3; `COHUB_RUNTIME_CONTROL_FD`
selects another descriptor (the Android app uses 2, stderr). Logs always stay on stdout.

### Optional executables

The sandbox needs nothing beyond a POSIX system. String commands run with `bash` where it is installed
and `sh` otherwise. `fd` and `rg` only accelerate `fs.find` / `fs.grep`: without them the sandbox walks
the tree itself with the same defaults (`.gitignore` / `.ignore` files including nested and ancestor ones,
hidden files, `.git` skipped, symlinks not followed, unreadable directories skipped, binary files skipped,
fd's smart case, ripgrep's `--glob`, context and `--json` events). Parity tests run both against the real
tools when they are installed. The heartbeat reports `processRg` / `processFd`, and the agent runs them
through `process.start` only when present; older sandboxes omit the flags and ship both.

## Current transport mode

The system keeps a single mode:

- `apps/sandbox` exposes a WebSocket server (listens on `0.0.0.0:8788` by default)
- `apps/agent` connects to the sandbox as a client
- On authenticated connect, the sandbox sends a first `sandbox.heartbeat` frame with capabilities / filesystem / metadata snapshots
- Cloud listeners require `Authorization: Bearer <SANDBOX_RPC_TOKEN>` before Upgrade; health probes remain unauthenticated.
- Clients derive per-instance credentials using the platform key and metadata nonce. Legacy cloud instances without a nonce remain anonymous until recreated; Pod-IP-only metadata is still supported.
- See [RPC auth rollout](sandbox-rpc-auth-rollout.md) for deployment, rollback and key rotation.
- All tools are forwarded to the sandbox over WebSocket RPC

## Current sandbox filesystem semantics

- `/workspace`
  - Project working directory
  - Read/write
  - Default `cwd`
- `/configs/platform/.agents`
  - Platform skills and referenced assets directory
  - Read-only
- Other sandbox-local paths
  - Such as `/tmp`
  - Accessible with real-machine semantics
- `filesystem.roots` returned in the first heartbeat
  - Describes known mounts and recommended directories only
  - Not an access allowlist

`path` / `cwd` semantics in RPC stay consistent with pi tools:

- Absolute and relative paths are supported
- Relative paths resolve against the current `cwd`
- When `cwd` is not provided explicitly, `/workspace` is the default
- The sandbox applies no allowlist roots; paths follow real-machine semantics
- Only `/configs/platform/.agents` is protected read-only

## Key environment variables

### Agent

- `LOCAL_SANDBOX_SPACE_ID` — Space ID of the sandbox during local debugging
- `LOCAL_SANDBOX_WS_URL` — WebSocket address of the sandbox during local debugging (e.g. `ws://127.0.0.1:8788/sandbox`)
- `SANDBOX_RPC_TOKEN` — The same token configured on the listen-mode development sandbox
- `SPACE_ID`
- `REDIS_URL`
- `SPACE_DIR`
- `SESSIONS_DIR`
- `ENV`
- `WORKER_SECRET`

### Sandbox

- `COHUB_SPACE_ID`
- `SANDBOX_RPC_TOKEN` — Required for cloud/listen mode; retained in Config, removed from inherited environments
- `SANDBOX_REPORT_TOKEN` — Separate report credential; retained in Config, removed from inherited environments
- `WORKSPACE_DIR`
- `PLATFORM_AGENTS_DIR=/configs/platform/.agents`
- `COHUB_SANDBOX_VERSION` (accepts legacy `IMAGE_VERSION`)

## Local development

### Start the sandbox (server)

```bash
cd apps/sandbox
export SANDBOX_RPC_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
COHUB_SPACE_ID=00000000-0000-0000-0000-000000000001 \
WORKSPACE_DIR=/tmp/cohub-sandbox-workspace \
PLATFORM_AGENTS_DIR=/configs/platform/.agents \
go run .
```

Default listen address: `ws://0.0.0.0:8788/sandbox`

### Start the agent (client)

Set the same `SANDBOX_RPC_TOKEN` in this terminal; do not generate a second token.

```bash
cd apps/agent
LOCAL_SANDBOX_SPACE_ID=00000000-0000-0000-0000-000000000001 \
LOCAL_SANDBOX_WS_URL=ws://127.0.0.1:8788/sandbox \
pnpm dev
```

## Current remote tools coverage

- `read` -> `fs.read`
- `write` -> `fs.write`
- `edit` -> agent-side diff + remote read/write
- `bash` -> `process.start` / `process.abort`
- `ls` -> `fs.stat` + `fs.ls`
- `find` -> `process.start` (`fd`) when `processFd`, otherwise `fs.find`
- `grep` -> `process.start` (`rg`) when `processRg`, otherwise `fs.grep`

## Web/API filesystem (local sandbox, M4)

Cloud-space fs tree/read/write reads and writes the shared PVC directly (unchanged).
Local spaces go through the relay to sandbox RPC to read and write the user's local
directory dynamically; `apps/api/src/space-fs-backend.ts` forks on `space_sandboxes.provider`:

- fs tree -> `fs.tree` (structured recursion, gitignore-aware, depth/limit)
- Read file/batch read -> `fs.stat` (size guard) + `fs.read` (binary base64)
- Download -> RPC reads into memory and streams directly (≤10MB; local does not use the CDN)
- Write/create file, upload -> `fs.write` (supports base64 encoding)
- Create directory/delete/move -> `process.start` argv (`mkdir -p` / `rm`·`rmdir` / `mv`), with an `fs.stat` precheck before the operation
- Local machine offline -> the API returns `503 sandbox_offline`; web shows the offline state

Protocol additions: the `fs.tree` method (capability `fsTree`), `size`/`mtimeMs` added to
`fs.read`/`fs.stat` results, and `encoding` added to `fs.write` parameters. Cloud sandboxes
implement them in sync, so both sides expose identical capabilities.

In local mode, `fs.changed` / `ports.changed` are reported only over the control channel
(not through a data session, avoiding duplication with agent forwarding). The gateway
republishes them to Space subscribers, so the web file tree stays realtime even without
an agent connection.

## Current state semantics

1. The API reports `provisioning` first
2. A sandbox Pod is created and the sandbox starts a WS server
3. The agent connects to the sandbox as a client
4. The sandbox sends the first `sandbox.heartbeat` frame with capabilities and a filesystem snapshot
5. Later heartbeats keep reporting sandbox runtime state; workspace content initialization is handled independently by the worker
6. Sandbox ready and workspace bootstrap ready are modeled separately and are no longer coupled

## Current limitations

- The active sandbox connection is still a single-connection model
