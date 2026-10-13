# Cohub Agent Control Service (@cohub/agent)

这是 Cohub 的 Agent 控制服务。它负责运行 `pi-coding-agent`、管理 session、处理 Redis I/O，并主动连接各个 sandbox 提供的 WebSocket server。

## 目录结构

- `src/index.ts`: Agent 主入口，负责 ownership 校验、sandbox 就绪协调、session 生命周期和 agent runtime
- `src/session.ts`: per-space session 管理与持久化适配
- `src/sandbox/ws-client.ts`: sandbox WebSocket client（per-space）
- `src/sandbox/tools.ts`: remote sandbox tools 适配层
- `Dockerfile`: Agent 镜像

## 运行方式

当前 `apps/agent` 的核心模型：

- sandbox 启动 ws server
- agent 根据 ownership 和 spaceId 动态发现并主动连接 sandbox
- agent 主动调用 sandbox 准备流程
- 所有 tools 都通过 ws rpc 转发给对应 space 的 sandbox

```bash
# 开发（本地单 sandbox 调试；设置与 sandbox 相同的 token，不要重新生成）
cd apps/agent
export SANDBOX_RPC_TOKEN="<same-token-as-sandbox>"
LOCAL_SANDBOX_SPACE_ID=<space-id> \
LOCAL_SANDBOX_WS_URL=ws://127.0.0.1:8788/sandbox \
pnpm dev

# 构建
pnpm build

# 类型检查
pnpm typecheck

# 运行构建产物
pnpm start
```

## Redis 流控机制

Agent 通过 Redis 与其他服务通信：
- ownership：`agent:space_owner:{spaceId}`
- runtime：`agent:space_runtime:{spaceId}`
- agent instance heartbeat：`agent:instance:{instanceId}`
- 输入队列：`agent:instance:{instanceId}:input_queue`
- 处理中队列：`agent:instance:{instanceId}:processing_queue`
- 死信队列：`agent:instance:{instanceId}:dead_letter_queue`
- 流式会话更新总线：`stream:agent:session_updates`

## 存储挂载约定

### 统一 PVC 路径规划

推荐将共享 workspace PVC 根挂到所有需要全量访问空间内容的服务的：

```txt
/space-storage
```

并约定 PVC 内目录布局为：

```txt
{SPACE_STORAGE_SUBPATH}/{spaceId}/workspace
```

### 各服务建议挂载方式

- sandbox
  - mountPath: `/workspace`
  - subPath: `{SPACE_STORAGE_SUBPATH}/{spaceId}/workspace`
  - 另挂只读技能目录：`/configs/platform/.agents`
- api
  - mountPath: `/space-storage`
  - `SPACE_STORAGE_ROOT=/space-storage/{SPACE_STORAGE_SUBPATH}`
- worker
  - mountPath: `/space-storage`
  - `SPACE_STORAGE_ROOT=/space-storage/{SPACE_STORAGE_SUBPATH}`
- agent
  - mountPath: `/space-storage`
  - `WORKSPACE_ROOT=/space-storage/{SPACE_STORAGE_SUBPATH}`
  - 只读挂载 `/checkpoint-cache`
  - `CHECKPOINT_CACHE_ROOT=/checkpoint-cache`
  - 另挂 session 持久化目录：`/sessions`

### Agent 运行时目录

- `WORKSPACE_ROOT=/space-storage/{SPACE_STORAGE_SUBPATH}`
- `CHECKPOINT_CACHE_ROOT=/checkpoint-cache`
- `SESSIONS_DIR=/sessions`

推荐目录布局：

```txt
/space-storage/{spaceId}/workspace
/checkpoint-cache/{modSpaceId}/latest
/sessions/spaces/{spaceId}/...
```

> `session` 持久化建议与 workspace PVC 分离，不要混在 workspace 树里。

## 镜像构建

在项目根目录执行：

```bash
docker build -f apps/agent/Dockerfile -t cohub-agent:latest .
```
