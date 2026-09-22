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
- `fs.search`（可选的 Tantivy 候选文件搜索）
- `process.start`
- `process.abort`

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

Workspace search is optional. New cloud sandboxes enable it by default: at startup the Go runtime first honors `COHUB_SEARCH_BIN` or a preinstalled binary, otherwise resolves `https://public.cohub.live/search/latest.json`, downloads the immutable linux/amd64 release, verifies its SHA-256 checksum, and starts it. Download or process failures leave `fs.search` temporarily unavailable without affecting the rest of the sandbox; the supervisor retries later. Set `COHUB_SEARCH_ENABLED=false` to disable the feature, pin `COHUB_SEARCH_VERSION=vX.Y.Z`, or override `COHUB_SEARCH_CDN_BASE_URL` for staging.

The Go workspace adapter sends string documents to the generic search engine. It owns file enumeration, UTF-8 reading, ignore rules and reconciliation; the binary owns durable indexing and queries. The active family is `workspace.candidates`, schema v1, stored under `/index/workspace-candidates/generations/<id>/index`, with its definition read from Platform Config at `/configs/platform/.cohub/search/workspace.candidates.json`. The Search config directory is mounted read-only; `COHUB_SEARCH_SCHEMA` can override the file path for development. If the file is absent, the built-in workspace schema is used. The runtime checks schema content every five seconds, rebuilds changes in a separate generation and switches after successful reconciliation. Invalid config or failed rebuilding keeps the current index. Effective schemas are snapshotted per generation; Platform Config is never overwritten. The stable socket link is `/tmp/cohub-search/search.sock`; override the parent storage and socket with `COHUB_SEARCH_INDEX_DIR` and `COHUB_SEARCH_SOCKET`. Cloud sandboxes mount `/index` from the system PVC at `{SPACE_SYSTEM_SUBPATH}/{SPACE_ID}/index`. Search releases are manual. See [Search](../search/README.md).

Go 文件 Adapter 负责枚举、UTF-8 读取、忽略规则和同步，向通用搜索引擎发送字符串文档；binary 负责持久化索引和查询。首版使用 `workspace.candidates` schema v1，索引位于 `/index/workspace-candidates/generations/<id>/index`，定义来自 Platform Config 的 `/configs/platform/.cohub/search/workspace.candidates.json`，目录只读挂载。文件不存在时使用内置配置；每五秒检查 schema 变化，独立重建成功后切换，失败保留当前索引。各代次保存有效 schema 快照，不写入平台配置；开发环境可用 `COHUB_SEARCH_SCHEMA` 指定文件。Search 按需手动发布，详见上述文档。

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
