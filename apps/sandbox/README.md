# Cohub Sandbox (Go)

内部 sandbox 执行器，对外提供单一 WebSocket server，由 agent 主动连接。

## 当前已实现

- `sandbox.heartbeat`（首帧包含 capabilities / filesystem / metadata 快照）
- workspace mount readiness check
- `fs.read`
- `fs.write`
- `fs.stat`
- `fs.ls`
- `fs.find`
- `fs.grep`
- `fs.search` / `fs.pathSearch`（可选的工作区索引：返回与 rg/fd 遍历等价的精确搜索计划，无法保证时返回 fallback；请求必须带 `writeToken`）
- `process.start`
- `process.abort`
- `display.list` / `display.capture` / `display.input`（显示，见 `docs/displays.md`；`COHUB_DISPLAY` 选择来源：
  `auto` 本机屏幕、`xvfb[:WxH]` 虚拟屏、`unix:<path>` Android 应用、`test` 测试图案）
- `rtc.open` / `rtc.close`（WebRTC 观看会话，仅 API 身份可调用）

sandbox 只保证工作目录挂载可用，不再负责 clone repo 或初始化 workspace 内容。
这些内容初始化流程统一由 worker 完成，再通过共享 PVC 暴露给 sandbox。

## 目录语义

- `/workspace`
  - 项目工作目录
  - 可读写
  - 默认 `cwd`
- `/configs/platform/.agents`
  - 只读技能目录
  - 用于暴露 SKILL.md、references、scripts、assets
- 其他 sandbox 本地路径
  - 如 `/tmp`
  - 按真实机器语义访问
- 首帧 heartbeat 中返回的 `filesystem.roots`
  - 仅用于说明已知挂载与推荐目录
  - 不是访问白名单

RPC 中的 `path` / `cwd` 语义与 pi tools 保持一致：

- 支持相对路径与绝对路径
- 相对路径相对当前 `cwd` 解析
- 未显式提供 `cwd` 时，默认使用 `/workspace`
- sandbox 不做白名单 roots 限制
- 仅对 `/configs/platform/.agents` 施加只读保护

## 目录结构

```txt
apps/sandbox/
  main.go
  go.mod
  env/
  process/
  protocol/
  rpc/
  search/
  workspace/
  ws/
```

## 本地开发与验证

### 本地检查

```bash
cd apps/sandbox
gofmt -w .
go vet ./...
go test ./...
go build ./...
```

### 1. 启动 sandbox

```bash
cd apps/sandbox
SPACE_ID=00000000-0000-0000-0000-000000000001 \
WORKSPACE_DIR=/tmp/cohub-sandbox-workspace \
PLATFORM_AGENTS_DIR=/configs/platform/.agents \
go run .
```

默认监听：`ws://0.0.0.0:8788/sandbox`

### 2. 启动 agent

```bash
cd apps/agent
LOCAL_SANDBOX_SPACE_ID=00000000-0000-0000-0000-000000000001 \
LOCAL_SANDBOX_WS_URL=ws://127.0.0.1:8788/sandbox \
pnpm dev
```

## Docker 构建

在项目根目录执行：

```bash
docker build -f apps/sandbox/Dockerfile -t cohub-sandbox:latest apps/sandbox
```

Workspace search is optional. New cloud sandboxes enable it by default: at startup the Go runtime first honors `COHUB_SEARCH_BIN` or a preinstalled binary, otherwise resolves `https://public.cohub.live/search/latest.json`, downloads the immutable linux/amd64 release, verifies its SHA-256 checksum, and starts it. Download or process failures, an incompatible binary API version, or a file watcher that is not settled make `fs.search` and `fs.pathSearch` answer with a fallback, so the agent runs rg and fd directly; the supervisor retries later. Set `COHUB_SEARCH_ENABLED=false` to disable the feature, pin `COHUB_SEARCH_VERSION=vX.Y.Z`, or override `COHUB_SEARCH_CDN_BASE_URL` for staging.

The API writes to the workspace volume directly while a sandbox is not dialable, and for every multipart upload; the worker restores or clones a new Space's workspace while its sandbox is still being provisioned. The watcher sees none of these writes. Each such writer bumps `space_sandboxes.workspace_write_gen` before and after the write (`runDirectWorkspaceWrite` in `@cohub/sandbox-controller`), and every agent search sends `writeToken` = `<sandbox row id>:<generation>`. The sandbox answers from the index only once a reconcile accepted after it first saw that token has run (fallback `writes` until then), and reconciles once more 65 s after the newest token, after another NFS client's write can no longer hide in this pod's directory cache (default `acdirmax`). The index activates once the workspace is prepared, whether or not the ready report succeeds.

The watcher reports ignored entries whose parent is watched, such as a created or deleted `build` directory, in `Batch.Boundaries`. Only the index consumes them; realtime file changes are unchanged.

The single built-in index remains `workspace.candidates` at `/index/workspace-candidates`, with the Unix socket at `/tmp/cohub-search/search.sock`. Override storage and socket paths with `COHUB_SEARCH_INDEX_DIR` and `COHUB_SEARCH_SOCKET`. Cloud sandboxes mount `/index` from the system PVC at `{SPACE_SYSTEM_SUBPATH}/{SPACE_ID}/index`.

当前运行时基础环境参考现有 agent 镜像，保留了较完整的工具链，包括：

- node
- pnpm
- typescript / tsx
- git / curl / jq
- ripgrep / fd / file
- python / pip / venv
- ffmpeg / imagemagick / exiftool
- vim / tmux / htop / tree
- build-essential / strace / lsof
- fonts-noto-cjk
- bun

## CI

已新增 GitHub Actions：

- `.github/workflows/sandbox-docker-build-push.yml`

包含：

- `gofmt`
- `go vet`
- `go test`
- `go build`
- Docker build & push
