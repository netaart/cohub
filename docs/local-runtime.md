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
# One consent for this folder (default yes); Codex asks once more before sharing its app-server.
# 首次授权一次（默认 yes）；Codex 共享 app-server 另确认一次。
pi                                   # run /reload in Pi sessions that were already open
codex
cohub runtime status
cohub runtime import                 # earlier conversations, newest first; Ctrl-C pauses
cohub runtime attach --harness pi    # install the Pi extension by hand
cohub runtime detach --harness codex
```

**Data plane.** A harness's own session file is the durable record and the outbox. The Runtime
watches Pi's and Codex's session trees (the bound folder and its subdirectories, except a subdirectory
bound to a Space of its own) and sends Turns over
its Runtime WebSocket. Persistence is event-driven and separate from realtime: a transcript is parsed
only when a Turn begins or ends in it — reported by the control plane (Pi's prompt and settle, Codex's
`turn/completed`) or found as a boundary record in the bytes the harness just appended. Between those
moments the Runtime only searches new bytes for boundaries; it never re-parses, re-sends a running
Turn, or polls. A Pi without the extension settles after one quiet-period timer. A send that fails is
retried with backoff; while offline, changes wait and are sent on reconnect.

The server is the only ledger: after a restart or disconnect the Runtime asks which Turns the server
already has and reads forward from there, so there are no local delivery receipts and a replay never
duplicates. Turn identity is derived from the Space and the file (Codex turn id; Pi session id + entry
id), so a folder bound to a new Space syncs there afresh. Only a rebuildable cache lives locally
(`~/.local/state/cohub/runtime/<space-id>/native/ledger.jsonl`, an append-only journal compacted when
it outgrows its content). Codex's own threads (reviews, compaction, memory) and
spawned sub-agents are skipped. Raw bytes of the latest settled Turn are
archived so a conversation can be restored natively on another machine.

**数据面。** 原生会话文件就是唯一的持久记录和发件箱。Runtime 监听 Pi / Codex 的会话目录（绑定目录及其子目录），
只在 Turn 开始或结束时解析并经 Runtime WS 上报（由控制面事件或新追加字节中的边界记录触发），其间只扫描新字节、不重解析、不轮询。服务端是唯一账本：重启或断线后先询问服务端已有哪些 Turn 再继续读，
本地不再保存投递回执，重放不会重复。本地只有可重建的缓存。Codex 自身的内部线程与子 Agent 不同步。

**Control plane.** Each harness is driven through the interface its own terminal client uses:

- **Pi**: a self-contained extension (`~/.pi/agent/extensions/cohub.js`, installed on consent)
  connects each Pi process to the Runtime's local socket. Through it the web streams a terminal Turn
  live, stops it, and sends prompts into the terminal's own session. A Pi that Cohub starts
  (`pi --mode rpc`) loads the same extension, so both paths are one. Without the extension a Pi
  session syncs read-only; `runtime status` says so, and `/reload` connects it after installing.
- **Codex** (0.156+): on consent, the Runtime uses Codex's shared app-server
  (`codex app-server daemon start` if none is running). A terminal `codex` attaches to that server
  by default, so web and terminal drive the same live thread. Cohub never restarts or stops it:
  `detach` and `down` print `codex app-server daemon stop` instead. The server is started with the
  login environment minus Cohub credentials; each thread only gets its cwd, an explicitly chosen
  model, a read-only sandbox when requested, and `COHUB_SPACE_ID` / `COHUB_SESSION_ID`. Cohub
  refuses approvals of the Turns it started and never answers a terminal user's approvals.
  Declining, an older Codex or a failed start degrade the same way: Cohub Turns use a private
  `codex app-server --listen stdio://`, and terminal Codex sessions sync read-only.

**Realtime.** Previews of a Turn someone runs in a terminal stream from the control plane — Pi's
extension events, and for Codex the shared server's events (the Runtime joins every busy thread of
this project it hears about) — at most every 250 ms, sending only the messages that changed. A client
Cohub cannot reach is previewed from its file every 2 s, less often for a long file. A web stop is
pushed to the Runtime through the Gateway (the same stop channel the Agent uses); the Runtime asks for
running Turns' state once after reconnecting. A native Turn stays alive while its owner's Runtime holds
the Space's lease; there is no per-Turn heartbeat. Whether Cohub can stop a running Turn is updated as
its native client connects or leaves; one it cannot stop says to stop it in the terminal. A Turn no
client is linked to reports signs of life (its file growing) every few minutes; after 30 minutes of
silence it asks for attention, since a killed client writes no end record, and the user confirms the
stop. It is never guessed finished.

**Tool environment.** Tools find their Space, Session and Turn in `COHUB_SPACE_ID`,
`COHUB_SESSION_ID` and `COHUB_TURN_ID`. A process Cohub starts gets all three. A connected Pi runs
many Turns, so the extension updates its process environment per Turn, for web and terminal Turns
alike. A shared Codex thread carries Space and Session in its thread config; per-Turn ids are not
possible there. When a request names a Session but no Turn, the API fills in the Session's running
local Turn if it belongs to the caller's Runtime.

**实时面** 与持久化分开：Pi 通过扩展、共享 Codex 通过服务端事件逐 token 推送预览（每 250ms 至多一次，只发生变化的消息）；
无法连接的客户端按文件每 2 秒预览一次。停止请求由服务端经 Gateway 推送到 Runtime，不靠轮询；Runtime 只在重连后查询一次运行中 Turn 的状态。
Turn 的存活由 Runtime 连接租约判断，不再逐 Turn 心跳；未接入控制面的 Turn 静默 30 分钟后请用户确认停止，绝不猜测已结束。

**控制面。** Pi 通过自带扩展接入本机 socket，Web 可实时查看、停止终端 Turn，并向终端会话发送消息；
Cohub 启动的 Pi 加载同一扩展。未安装扩展时只读同步。Codex 0.156+ 经同意后使用官方共享 app-server，
终端 `codex` 默认连接同一服务，Web 与终端共同驱动同一线程；Cohub 从不重启或停止它。拒绝、版本过低或启动失败
统一降级：Cohub 的 Turn 使用私有 stdio app-server，终端会话只读同步。

A Turn Cohub starts writes its cloud Turn id into the native file (Pi `custom: cohub.turn` entry;
Codex `clientUserMessageId`), so the file proves which Turns are Cohub's and they are never ingested
twice. A Session is continued in its native file only when that file ends at the Session head and a
live client (or Cohub itself) owns it; otherwise Cohub restores the archive or projects the Session
into a new file and never writes into a file a terminal holds.

**Import.** `runtime import` backfills conversations from before consent. The Runtime does the work;
the command plans, confirms and shows progress (conversations, Turns, bytes, estimate). Newest first,
four conversations at a time (`--concurrency` up to 8); live Turns are never starved. Ctrl-C pauses and
running it again continues; progress survives restarts because the server recognizes what it has.
`--dry-run`, `--harness`, `--session`, `--yes` and `--json` are supported. `up` offers the import on
first consent. Imported Turns carry `meta.nativeSync.origin = "local_import"` and their original times;
they appear as ordinary Chats.

**导入。** `runtime import` 在 Runtime 内执行，命令只负责规划、确认和显示进度；按最近优先、默认并发 4，
不挤占实时同步；Ctrl-C 暂停，再次运行继续，重启后也可继续且不重复。

Boundaries:
- Terminal Codex clients started with `-c`, `--search` or `--enable` run an embedded server and are
  not attached; their Turns still sync, read-only.
- Pi 0.85.1+ is driven through the extension. An older Pi, or a control socket that cannot listen,
  leaves Pi sessions read-only; `runtime status` and a Cohub Pi Turn say why.
- Pi without the extension cannot be stopped from the web; Pi's last Turn counts as ended when its
  extension reports it settled, or after 10 s of quiet following a reply that ended. One left mid-tool
  waits for its next record, or asks for attention after 30 minutes.
- A Codex Turn followed by another without its own end record (its client died) is recorded as interrupted.
- A Cohub Turn sent to a terminal Pi that is busy waits for the terminal's Turn to settle, then runs.
- A model or thinking level chosen on the web for a Turn in a live terminal session stays selected
  there, as if chosen in the terminal; a shared Codex thread keeps it the same way.
- Turn forks do **not** isolate workspace files; parallel branches may edit the same directory.
- `detach` pauses sync and live previews at once, for transcripts already tracked too; a Turn running
  then asks for attention if its end never arrives. A paused terminal file is not continued from the
  web. Nothing is deleted. `down` stops the Runtime, never a user's own clients.

Deploy the API before the updated CLI. No DB migration is needed. Earlier CLIs keep running Cohub Turns,
but their native sync is refused with "upgrade the Cohub CLI". Native sync state from those releases is
not carried over; sync starts afresh.
先部署 API，再更新 CLI；无需数据库迁移。旧版 CLI 仍可执行 Cohub Turn，但原生同步会被拒绝并提示升级；旧版原生同步状态不迁移，重新开始同步。

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
                                      `-- Gateway WS -> Pi extension / Codex app-server (shared or private)

Harness events -> Agent sendOutput -> existing snapshot / patch -> Web / SDK
Harness messages -> existing persistence / finalize -> DB / realtime
Local native file -> ingest over Runtime WS -> ordinary Chats / Turns
Local native session -> durable segments -> CLI presigned PUT -> object storage
Archive metadata -> API confirmation -> turn.harnessIndex
Object storage -> CLI presigned GET -> verified native restore
Cloud native session <- DB context (no harness archive)
```

Managed execution has no HTTP polling/claim/result endpoints. Native ingest travels on the Runtime
WebSocket (`runtime.native`: `ingest`, `known`, `progress`, `status`); stops arrive as `runtime.native.stop`
pushes. It never dispatches or replays model/tool work.
The outbound managed connection uses `/runtime/relay`; internal Agent peers use `/internal/runtime-relay/:spaceId`.
The existing workspace relay remains responsible for files and processes.

The same Session lock and queue serialize Cloud and Local execution. At claim time,
all runnable queued follow-ups form one ordered batch, regardless of author or requested Harness.
The final turn owns execution: its Harness, model, thinking and supported configuration are selected.
Execution uses the owner's authorization; author permissions are never combined. A read-only request
anywhere in the batch makes the entire batch read-only (Pi rejects this before dispatch).

Each source turn/message and its author, requested Harness and original content remain intact.
Earlier turns point to the owner through `mergedIntoTurnId`. Local adapters receive the batch content
verbatim: no prefixes, ordinals, separators, explanations or internal user/turn/message IDs are added
to prompt text. Platform-side one-shot expansion still applies at submission — prompt templates
(`/name args`) expand everywhere; project-scoped skills expand with workspace-relative locations,
while skills the platform does not know pass through verbatim so a Harness' local skill files can
serve them. Direct `!` shell commands execute on the Cohub sandbox only and pass through verbatim
to Local Harnesses.
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
state. The native file of a confirmed-stopped Turn is not continued; the next Turn restores or
projects the Session instead.

A receipt never blocks a Harness permanently: once the server reports its Turn as terminal, the
receipt is released. A receipt whose result was lost is rebuilt from the native file, found by the
Turn's Cohub marker; an unfinished or interrupted Turn is never guessed complete. Only Turns the
server still considers active require explicit confirmation. Native files are never deleted.

Transport uncertainty is surfaced immediately on the active Session. Reconnect and
bounded queue retries can still recover a saved result; an explicit missing-result response
keeps the Session in attention until Runtime reconnects or a manager confirms it stopped.
Never infer that a disconnected execution has stopped.

## Boundaries

- A Turn sent to a live terminal client runs in that process. Otherwise Cohub starts a Pi (or a
  private Codex app-server) for the Turn; in-process PTY handles and background terminals do not
  survive between such Turns. A shared Codex app-server keeps its threads loaded across Turns.
- Verified with Pi 0.86.1 and Codex 0.156.1. Codex rollout-path recovery is an upstream
  experimental API; incompatible versions fail explicitly.
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
  Web shows pending/ready/unavailable archive state. A failed capture costs only cross-machine native
  resume; the next settled Turn captures the file again, since every version is a prefix of the next.
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

The native smoke test drives real Pi and Codex binaries with isolated homes and a deterministic
loopback model: a Cohub Turn in a Pi Cohub starts; a terminal Pi syncing with live preview; a web
prompt and a web stop reaching that terminal Pi; the same through Codex's shared app-server with a
second client as the terminal; and the private app-server fallback. It reads no credentials and
contacts no Cohub server. 原生冒烟测试使用真实 Pi / Codex、隔离目录与本地模型桩，不读取凭证、不连接服务端。

```bash
COHUB_NATIVE_PI_BIN=$(which pi) \
COHUB_NATIVE_CODEX_BIN=/path/to/codex \
pnpm --filter @neta-art/cohub-cli test:runtime:native
```
