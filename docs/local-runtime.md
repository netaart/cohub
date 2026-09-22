# Local Runtime

## Execution

A Space has one local Runtime connection. Users select a Harness, not a machine.

```bash
cohub auth login
cd ./project
cohub runtime up --harness pi --harness codex
cohub runtime up --harness codex # reuses the same Space
cohub spaces prompt "Continue" --harness codex
cohub runtime status
cohub runtime up -d                 # background; returns a startup summary
cohub runtime logs --level warn -f  # warnings/errors only
cohub runtime down                  # retains Space, bindings and native files
cohub runtime up -n --name project-next # explicitly request another Space

# To bind this directory to another local Runtime explicitly:
cohub runtime up --space <space-id> --harness codex
```

`runtime up` replaces `sandbox up`. When `--space` is omitted, the CLI remembers
the Space for the canonical directory, account, and environment in
`~/.config/cohub/runtime-spaces.json`. The first start creates and records a local
Space after prompting for a name; later starts offer reuse as the default. `-n` is
now the boolean shorthand for `--new`, not `--name`. Naming uses `--name <name>`.
Even with `-n`, interactive startup shows an existing binding and recommends reuse.
An explicit `--space` or `COHUB_SPACE_ID` overrides and updates the directory binding.

普通使用只需 `cohub runtime up`：首次提示创建及命名，后续优先复用。
`-n` 是 `--new` 的简写，`--name` 单独指定名称。已有绑定时仍提示优先复用。
`--yes` accepts defaults and local execution consent; with explicit `--new`, it creates
another Space. Stop the old instance before rebinding its directory.

A durable local creation receipt prevents replay after an ambiguous remote response.
If creation succeeded but its ID was not received, inspect your Spaces and use `--space <id>`;
do not automatically create a replacement. 原始创建回执会保留，结果未知时不会自动重建。

It supervises the workspace bridge and the Harness connection. Node.js 24+ is required.
Pi and Codex must already be installed and authenticated locally. Without `--harness`,
startup discovers installed Pi/Codex executables on PATH (or explicit executable overrides).
Capability/authentication failures remain explicit; it never silently switches executors.
`--pi` and `--codex` override executable paths. Repeated `--harness` options and comma-separated values are
accepted. `--yes` accepts the explicit local execution consent for non-interactive startup.

## Native clients / 原生客户端

```bash
cohub runtime up -d --harness pi --harness codex
cohub runtime attach --harness pi --harness codex
# Reload Pi or restart Codex; review native extension / hook trust prompts.
# 重载 Pi 或重启 Codex，并审核原生扩展 / Hook 信任提示。
pi
codex
cohub runtime status --json
cohub runtime detach --harness pi --harness codex
```

`attach` installs a user-level Pi extension / Codex hook block, but enables collection only
for the explicitly bound directory, account and environment. It confirms uploading opened
conversations (including existing history), tool output and original session archives to the
Space. These may contain sensitive data and follow the Space's access policy. Credentials,
configuration files and Codex's private SQLite database are never collected. Existing native
configuration is backed up; conflicting managed blocks and symlinks are not overwritten.
`--yes` accepts this upload consent; it never bypasses native hook trust.

`attach` 安装用户级集成，但仅采集明确绑定的目录、账号和环境。上传范围包含打开的对话、
已有历史、工具输出和原始会话归档，可能含敏感数据，遵循 Space 权限。不会采集认证文件、
配置或 Codex 私有 SQLite 数据库。原有配置会备份，冲突配置及符号链接不会被覆盖。
`--yes` 仅确认上传授权，不绕过原生 Hook 信任检查。

The local Runtime Supervisor is the single per-binding Daemon. Pi Extensions and Codex Hooks
connect only to its private local socket; they do not hold Cohub tokens or open API connections.
The Daemon owns one authenticated Runtime WebSocket, native receipts, archive outbox and native
Turn routing. Native start / progress / completion events use that WebSocket; presigned HTTP is
used only for archive bytes. A Plugin process can disappear without losing the local receipt.

原生客户端由每个绑定对应的 Local Runtime Daemon 统一管理。Pi Extension 和 Codex Hook 只连接
本机私有 IPC，不持有 Cohub Token，也不直接连接 API。Daemon 统一持有认证后的 Runtime WS、
Turn 回执、归档 outbox 和原生 Turn 路由。原生 Turn 的开始、进度和完成走 WS，HTTP 只上传归档
字节。插件进程退出不会丢失本地回执。

Native executions use ordinary Cohub Chats and Turns, including existing stream snapshots,
intermediate history, usage, native archives and continuation. Native work never waits for the
cloud queue or network. Per-Turn local receipts precede delivery; reconnect replays receipts,
never models or tools. An atomic Session-row operation appends at the supplied settled Turn
or creates a standard Turn fork if the cloud has advanced, is executing or has queued work.
An empty local history starts a separate root when there is no Turn to fork. Forked archives
start a new baseline rather than referring to another Session's archive chain.

原生执行进入普通 Chat / Turn，复用现有进度展示、历史、用量、归档和继续执行能力。
本地执行不等待云端队列或网络；逐 Turn 回执持久化后补传，重连不重跑模型或工具。
云端已前进、正在执行或存在排队任务时，从本地已确认的完整 Turn 自动分支；没有父 Turn
的空历史则创建独立会话。分支归档使用新基线，不跨 Session 串接增量归档链。

Existing Runtime Session / Turn sidecars and raw projection metadata seed the native binding.
The native client's file remains its own: subsequent Runtime execution rebuilds or restores a
separate projection, never writes into the interactive client's file. Turn forks do **not**
isolate workspace files; parallel branches may still edit the same project directory.

复用现有 Runtime 的 Session / Turn 关联与历史投影元数据。Runtime 继续执行时使用独立
原生文件，不覆盖交互式客户端的记录。Turn 分支不隔离工作目录，并行分支仍可能修改相同文件。

Boundaries:
- Pi requires 0.85.1+ with `agent_settled`; Codex requires enabled stable Hooks. Startup capability
  checks fail explicitly. Pi 0.86.1 and Codex 0.155.1 smoke tests use a deterministic loopback model fixture.
- Progress follows durable native messages, not every token. Codex hooks only register local watches;
  the existing Runtime supervisor reads flushed Turn boundaries and retries uploads every five seconds.
- Ephemeral sessions without a durable transcript are not collected. A native file belonging to an
  unconfirmed managed Runtime execution cannot be adopted; finish or reconcile that execution first.
- Only whole-Turn anchors are supported. Pi intra-Turn rewinds and Codex rollouts referencing missing
  parent history fail explicitly with originals retained; they are never silently rounded to another anchor.
- Native-only UI / direct-shell records do not become separate Agent Turns. Their original bytes remain
  local and are included in subsequent Turn archives; the bridge does not invent message-level anchors.
  原生 UI / 直接 Shell 记录不另建 Agent Turn，原件保留在本地并随后续 Turn 归档，不虚构 message 级锚点。
- Capture currently reads at most 128 MiB per transcript; API receipts are limited to 32 MiB. Limits
  retain originals and surface diagnostics instead of truncating data.
- Pi can honor a remote abort while its extension is connected. Codex hooks are not a remote control
  channel; stop an active native Codex run in its terminal. Unknown outcomes retain the existing explicit
  stop-confirmation boundary. Completed Chats can continue through the regular Runtime.
- `detach` pauses collection and future uploads, preserving receipts, files and cloud history. In-flight
  requests may finish. `down` stops the Runtime supervisor, not independently launched native clients.

边界：只支持完整 Turn 分支，不新增 message 级锚点。消息随原生持久记录更新，不保证逐 token。
无法识别的中途分支、缺失父历史和超限记录会明确报错并保留原件。Pi 扩展在线时可接收停止请求；
Codex Hooks 不提供远程控制，运行中的原生任务需在终端停止，结果未知时仍须明确确认。
`detach` 暂停后续采集和上传，不删除数据；`down` 不终止用户独立启动的原生客户端。

Deploy API before the updated CLI and restart an older Runtime before `attach`. No DB migration is needed.
先部署 API，再更新 CLI；接入前重启旧 Runtime。无需数据库迁移。

## Lifecycle / 生命周期

Foreground and detached startup share one supervisor. Readiness requires both the
Harness registration and the file bridge. Network failures retry indefinitely with
bounded, jittered backoff; transient credential refresh errors do not terminate the Runtime.
The supervisor restarts a failed bridge without restarting model/tool work. A new login
must match the original account. Protocol, permission and persistent lease conflicts
fail explicitly rather than stealing another Runtime.

Sandbox status reports serialize on the existing database row. Ready checks the current
file-bridge lease while holding that lock; stopped checks the recorded connection identity.
No additional persistent counter or clock ordering is needed. A lease lookup failure leaves
the stored state untouched, while live availability continues to follow the expiring lease.

Sandbox 状态上报按数据库行串行处理：就绪状态核验当前文件桥接租约，停止状态核验连接身份。
不增加永久计数器，也不依赖机器时钟排序；租约查询失败时不覆盖已有记录，实时可用性仍由租约决定。

`up -d` detaches from the terminal, not from supervision. It returns the Space link,
directory, PID and log directory. After 30 seconds without readiness, it returns the
actual starting/reconnecting state with exit code 2; the background process keeps trying.
A compatible existing instance is reused. `down` uses private authenticated local IPC,
not an unchecked PID signal. It refuses unconfirmed work unless `--yes` is supplied;
this only stops the process, never resolves an uncertain server-side turn.

前台与后台共用监督器；两条连接均成功才显示就绪。后台启动未就绪时如实返回状态，
进程继续重试。`down --yes` 允许停止包含未确认执行的进程，但不代替服务端的停止确认。
`status` and `logs` use the directory binding, never silently fall back to Home.
Local status and diagnostics remain available when the server cannot be reached.

The new sandboxd accepts refreshed credentials on an inherited private pipe and emits
structured lifecycle events on a separate pipe. **Release Gateway/API first, then publish
sandboxd and update the CLI binary pin only after its CDN artifacts exist.** The current
published binary remains supported: readiness is checked through the API and an exited
bridge is restarted with fresh credentials. It cannot use the new managed-pipe behavior
until the updated binary is published (or selected with `COHUB_SANDBOXD_BIN`).

新 sandboxd 发布前保留兼容路径，不修改为尚未发布的版本号。后台运行不承诺开机自启；
OS 级托管与断网继续执行任务属于后续阶段，当前仍保留断连中止及结果对账的安全边界。

Web reuses the shared model selector for local catalogs, with a Harness default option.
The header distinguishes ready, limited, offline and stale/unknown status. Runtime lifecycle
changes invalidate the existing status cache over the shared realtime room; old snapshots
may populate labels/models, never authorize a local turn.

## Diagnostics

The Runtime writes redacted, ordered JSONL diagnostics under
`~/.local/state/cohub/runtime/<space-id>/diagnostics/`. Network, WebSocket,
Harness, archive and sandboxd lifecycle failures include `runtimeId`,
`connectionId`, `requestId`, `sessionId` / `turnId`, and when available the
server `traceparent` / `traceId`.

```bash
cohub runtime logs --space <space-id>
cohub runtime logs --space <space-id> --follow
cohub runtime logs --space <space-id> --level debug --json
```

Foreground output shows lifecycle changes and redacted warnings/errors, coalescing repeated
failures without suppressing file diagnostics. `--verbose` includes detailed terminal events.
JSON results go to stdout; progress and warnings go to stderr. 前台直接提示断连、恢复及错误，
完整诊断保留在本地；后台退出终端后请使用 `logs --follow` 查看。

Diagnostics stay on the local machine and are never uploaded automatically. Use
`runtime logs` or `runtime logs --json` to inspect or export them. Prompts, tool
arguments, file contents and credentials are not recorded.

## Shared Pipeline

```text
API prompt -> BullMQ -> Session lock -> Harness dispatch
                                      |-- Cohub runtime
                                      `-- Gateway WS -> local Pi RPC / Codex app-server

Harness events -> Agent sendOutput -> existing snapshot / patch -> Web / SDK
Harness messages -> existing persistence / finalize -> DB / realtime
Local native session -> durable segments -> CLI presigned PUT -> object storage
Archive metadata -> API confirmation -> turn.harnessIndex
Object storage -> CLI presigned GET -> verified native restore
Cloud native session <- DB context (no harness archive)
```

Managed execution has no HTTP polling/claim/result endpoints. Native-client receipts use
`/api/spaces/:id/runtime/native-turns` for ingestion only; they never dispatch or replay model/tool work.
The outbound managed connection uses `/runtime/relay`; internal Agent peers use `/internal/runtime-relay/:spaceId`.
The existing workspace relay remains responsible for files and processes.

The same Session lock and queue serialize Cloud and Local execution. At claim time,
all runnable queued follow-ups form one ordered batch, regardless of author or requested Harness.
The final turn owns execution: its Harness, model, thinking and supported configuration are selected.
Execution uses the owner's authorization; author permissions are never combined. A read-only request
anywhere in the batch makes the entire batch read-only (Pi rejects this before dispatch).

Each source turn/message and its author, requested Harness and original content remain intact.
Earlier turns point to the owner through `mergedIntoTurnId`. Local adapters receive the batch content verbatim:
no prefixes, ordinals, separators, explanations or internal user/turn/message IDs are added to prompt text.
Representable blocks and tool pairing are preserved; URL images, system notes and unknown blocks are dropped from
the model input, never described in text, and their durable copy stays in the platform. Only the existing system
prompt builder may author platform instructions. Streaming, results, usage and native archive references
belong to the owner. Local tools still run as the Runtime host's OS user; local usage is not charged as a Cloud turn.

Steer/direct shell commands remain single-turn; direct-generation barriers remain unchanged.
New follow-ups arriving after a claim wait for the next batch. An unavailable owner Harness fails explicitly,
never silently switches executor. Recovery reconstructs the persisted claim and only re-delivers saved results;
it does not collect new queued inputs or replay models/tools.

## Resume

- The first head response includes a ready archive reference when available, avoiding an extra cold-resume round trip.
- A missing or outdated projection requests history over the same WS connection.
- Same-Harness native files are validated and reused. A matching archive can
  restore a missing native file. Pi handoff writes durable messages into its native session file, while
  Codex handoff has no native history channel yet and starts without history (durable history stays in the platform).
- Codex paginated threads depend on a private SQLite index. Archive import creates
  a separate legacy-history projection and uses native `thread/fork(path)`;
  the original archive and thread are preserved. The private database is never uploaded.
- Cloud uses the same history reader, including fork segments and compaction
  boundaries. History reconstruction never executes old tools.

Local bookkeeping is under `~/.local/state/cohub/runtime/<space-id>`; native
credentials and configuration remain in the original Harness locations. Existing
files are not overwritten when they contain unconfirmed or externally modified
history. Native segments reuse the existing turn storage bucket and signing path, without setting object ACLs.
Access control follows the bucket policy; only short-lived, authorized PUT/GET URLs are issued by the API.
API, Gateway and Agent never proxy archive bytes.

## Runtime Recovery

Recovery is event-driven and Session-scoped. The local Runtime streams every pending
`sessionId` / `turnId` identity in bounded batches after it connects; Gateway peer disconnects and Agent
transport uncertainty also enqueue reconciliation for that Session. Recovery takes the
Session lock, validates the active owner and reconstructs its persisted batch before
reading a saved result. There is no periodic database scan. `turn.recover` is internal
and reads saved results only, without starting Harnesses or replaying tools. Recovery
does not depend on the original WebSocket request ID.

```bash
cohub runtime status --space <space-id>
```

There is no public recovery command. Space headers show connection status; an affected
Chat exposes explicit stop confirmation only when its active local execution is uncertain,
requiring `sandbox.manage`. Confirmation is bound to that Session, active turn and recovery
revision; newer executions are never included. Original turn input, committed
messages, native files and result receipts are retained. A durable resolution note
records that prior effects remain unknown; late results cannot replace this terminal
state. Local projections are retired before rebuilding from server context. If an ACK
was lost before switching Harnesses, the Runtime asks only about its current pending
projection and rebuilds from the latest durable context when switching back.

An orphaned local projection never blocks a Harness permanently: once the server
reports that turn as terminal, the projection is archived under `retired/` and rebuilt,
whether or not a local result receipt survived. Only turns the server still considers
active require explicit local confirmation. Native files are never deleted.

Transport uncertainty is surfaced immediately on the active Session. Reconnect and
bounded queue retries can still recover a saved result; an explicit missing-result response
keeps the Session in attention until Runtime reconnects or a manager confirms it stopped.
Never infer that a disconnected execution has stopped.

## Boundaries

- Adapters currently start an RPC process per turn. Native conversation history
  resumes, but in-process PTY handles, background terminals and interactive
  extension state are not guaranteed to survive between turns. This is not full
  interactive-native parity; persistent Harness processes require a separate lifecycle design.
- Use Pi versions exposing RPC session events and Codex versions supporting
  app-server thread resume/fork. Verified with Pi 0.85.1 and Codex 0.154.0.
  Codex rollout-path recovery is an upstream experimental API; incompatible versions fail explicitly.
- Native approval escalation is never automatically granted. Requests requiring
  an interactive local approval are rejected by the unattended adapter. Pi
  read-only execution is rejected because it cannot enforce the requested limit.
- Unknown execution outcomes remain active and block automatic takeover. Local
  unconfirmed state requires reconciliation; it is not silently discarded or replayed.
- Completed results are durably checkpointed locally before delivery. A lost
  acknowledgement can replay that result, never the model or its tools. Only the
  latest result per Session/Harness is retained, avoiding an unbounded local outbox.
- Cloud turns do not write `harnessIndex` or upload native files. Missing Cloud files
  rebuild from DB messages and compaction boundaries; cached handles use lightweight revisions.
- Local turns capture immutable raw-byte segments (up to 4 MiB each) into a durable outbox.
  A verified unchanged prefix extends the prior version; truncation or any prefix rewrite starts
  a new baseline. Each turn stores only its parent reference and new segments, not the whole list.
- Uploads retry every 10 seconds while Runtime is running, including after restart with no new turn.
  Model-result ACK and archive confirmation are independent. `runtime status` reports `pendingLocalArchives`;
  Web shows pending/ready/unavailable archive state. Failed capture is retried before another turn can mutate the file.
- Missing/changed native files and malformed capture receipts are quarantined under `archives/failed/captures/`.
  The exact receipt and failure reason are retained; native files stay untouched. These failures stop retrying and
  are reported by `runtime status.failedLocalArchives`. Transient I/O errors keep retrying.
- Confirmation validates authorization, parent identity, contiguous offsets, object lengths and storage-verified MD5.
  Restoration verifies every SHA-256 and every version digest before atomically publishing a new file.
  Only ready, valid indexes are offered for native recovery. Pending, failed or invalid indexes use DB history.
  If download or import fails, CLI logs a warning and requests DB history once before starting a new Harness projection;
  this is reported as a handoff, never a successful native restore. Cancellation and unconfirmed local execution still block continuation.
- One claim is bounded by message count and estimated input bytes, and the protocol enforces the same
  message cap. A larger queue splits into consecutive batches instead of failing after turns were merged.
- Metadata requests are bounded to 256 new segments per version (at most 1 GiB of newly captured bytes).
  Limits fail explicitly and preserve original files. No object GC or lifecycle changes are made by the code.
  Lifecycle policies must retain old segments for as long as any supported recovery version references them.
- Final local messages and terminal Turn state commit atomically. Realtime,
  postprocessing and bound external channels are best effort; durable Session data remains
  authoritative and reloadable when a notification fails.

## Verification

```bash
pnpm --filter @cohub/protocol test
pnpm --filter @cohub/agent test
pnpm --filter @cohub/agent test:runtime
pnpm --filter @neta-art/cohub-cli test
pnpm --filter @neta-art/cohub-cli test:runtime
RUNTIME_TEST_DB_HOME=/path/to/isolated-db pnpm --filter @cohub/api test:runtime:archives
RUNTIME_TEST_DB_HOME=/path/to/isolated-db pnpm --filter @cohub/api test:runtime:native-sync
```

`test:runtime` uses loopback WebSockets and fixture RPC processes, never real
accounts or model requests. The optional `test:runtime:db` uses an isolated PostgreSQL
engine and requires `RUNTIME_TEST_DB_HOME`; it never connects to production. Apply `0065_runtime_harness_index` before deploying
services that read `harness_index`. Native object prefixes must remain private, including through any CDN origin authorization;
verify signed PUT/GET, create-only writes and single-PUT MD5/ETag behavior against the configured storage before release.
No production-bucket writes are performed by the automated tests.
Deploy Worker, API, Gateway and every Agent instance
before enabling the updated Web/CLI. Worker must understand local usage before local
results arrive, so they cannot be charged as cloud executions.

Native plugin smoke tests use isolated homes, the published JS layout, and a deterministic
loopback model fixture. They do not read real credentials or contact a Cohub server.
原生插件冒烟测试使用隔离目录与本地模型桩，不读取真实凭证、不连接 Cohub 服务端。

```bash
# Build protocol, SDK and CLI first / 先构建 protocol、SDK 和 CLI
COHUB_NATIVE_PI_BIN=/path/to/pi \
COHUB_NATIVE_CODEX_BIN=/path/to/codex \
pnpm --filter @neta-art/cohub-cli test:runtime:plugins
```

For opt-in real-model testing, prepare an isolated directory containing `home/`,
`pi/` and `codex/`, with native authentication/configuration. This test makes model
requests and writes temporary files; archive storage is injected in-memory and it never connects to a Cohub server. Set
`COHUB_NATIVE_TEST_PI_BIN` / `COHUB_NATIVE_TEST_CODEX_BIN` to override executables.

```bash
COHUB_NATIVE_TEST_HOME=/path/to/isolated-config \
COHUB_NATIVE_TEST_PROVIDER=your-provider \
COHUB_NATIVE_TEST_MODEL=your-model \
pnpm --filter @neta-art/cohub-cli test:runtime:native
```

The native matrix checks streaming, real file-writing tools, native resume,
archive import, Pi/Codex handoff and abort with partial-output retention. Provider
features and sandbox permissions come from the test configuration, not Cohub overrides.
