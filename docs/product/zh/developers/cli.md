---
title: CLI
description: 安装 Cohub CLI，登录，并在终端运行主要 Space 工作流。
---

Cohub CLI 把同一套产品表面带到终端：Spaces、Chats、files、Saves、Apps、generation 等。

包名：`@neta-art/cohub-cli`

## 安装

```bash
npm install -g @neta-art/cohub-cli
cohub --help
```

## 登录

```bash
cohub auth login
cohub auth whoami
```

CLI 会存储 session 并自动刷新。CLI 自更新会在后台执行，不会阻塞命令；更新成功后从下一次调用开始生效。可设置 `COHUB_CLI_AUTO_UPDATE=0` 关闭自更新。

在 Sandbox 或 CI 中，可用 `COHUB_EXECUTION_TOKEN` 覆盖已存储鉴权，用于临时运行。

## 环境

默认是 production。

```bash
ENV=dev cohub auth login
ENV=dev cohub spaces ls
```

## 全局 flags

| Flag | 作用 |
| --- | --- |
| `-s, --space <id>` | 指定 space-scoped 命令的目标 Space |
| `--json` | 机器可读输出 |
| `-h, --help` | 命令帮助 |

很多工作流需要 Space。未显式指定时，CLI 会先使用当前目录已记住的 Space，再回退到 Home Space：

```bash
cohub -s <spaceId> spaces get
COHUB_SPACE_ID=<spaceId> cohub spaces get
```

## 术语

| UI | CLI |
| --- | --- |
| Chat | Session |
| Save | Checkpoint |
| Tasks | Task runs |
| Scheduled prompt | `spaces prompt` schedule / cron jobs |

## 常见工作流

### Spaces

```bash
cohub spaces ls --json
cohub spaces create --name "Demo" --json
cohub spaces get <spaceId> --json
cohub -s <spaceId> spaces files ls
```

### 向 Chat 发送 prompt

```bash
cohub -s <spaceId> spaces prompt "Fix the failing tests" --json
cohub -s <spaceId> spaces prompt --title "Planning" "Draft a launch plan" --json
cohub -s <spaceId> spaces prompt --session <sessionId> "Continue from the diff" --json
```

调度：

```bash
cohub -s <spaceId> spaces prompt --at "2026-07-20T09:00:00+08:00" "Weekly review" --json
```

### 在 Space 工作区运行命令

```bash
cohub -s <spaceId> run -- git status
```

### Files

```bash
cohub -s <spaceId> spaces files ls
cohub -s <spaceId> spaces files cat README.md
cohub -s <spaceId> spaces files write notes.md --stdin < notes.md
cohub -s <spaceId> spaces files upload ./src
cohub -s <spaceId> spaces files diff
```

`upload` 把文件直接落在 `--dir` 下；目录入参的内容会直接展开（不多一层目录名），例如
`upload dist --dir apps/demo` 的结果是 `apps/demo/index.html`，而不是 `apps/demo/dist/index.html`。

### Apps

`apps publish` 默认根据 runtime 自动判断来源：本地 CLI 使用本地文件系统路径，Cohub
Sandbox 使用 Space 工作区路径。也可以用 `--source workspace` 或 `--source local`
显式覆盖。

```bash
cohub -s <spaceId> apps publish demo --file ./dist/index.html
cohub -s <spaceId> apps publish site --dir ./dist
cohub -s <spaceId> apps publish site --source workspace --dir dist
cohub -s <spaceId> apps ls --json
cohub apps stats <workId|url|username/space/work>
```

Realtime rooms 使用已发布 App 的 runtime 身份。请在 App 内使用
`client.app.realtime`；CLI 不提供房间命令。

### 操作 Cohub 界面

在 Space 中运行的 Agent 可以在发起该对话的 Cohub 标签页里打开 App 预览，并调用
App 自己暴露的方法。

```bash
cohub desktop open <appId|url|app://...|username/space/app|file://path>
cohub desktop open file://src/main.ts
cohub desktop open app://alice/studio/launch
cohub desktop open app://alice/studio/milk-frog --as overlay
cohub desktop open <app-or-file> --call selection.get
cohub desktop open <app> --call board.focus --data '{"nodeId":"n1"}'
```

打开预览是幂等的：重复执行只会重新激活同一个标签页。`--call` 会等待 App 声明就绪
后再调用方法。具体有哪些方法由 App 作者决定，通过
`client.app.surface.handle(name, handler)` 注册。

命令只会到达发起当前工作的那个前端实例，目标从请求 provenance 推导得出。它无法作用于
其他用户，也不提供 DOM 访问或脚本执行能力。

### 本地 Runtime

把本地目录暴露为 Space Runtime：

```bash
cd ./my-project

# 首次提示创建和命名，并记住该目录的 Space
cohub runtime up

# 再次运行优先复用；-d 在后台运行；原生对话同步默认开启（确认一次，默认 yes）
cohub runtime up -d
cohub runtime status
cohub runtime logs --level warn --follow
cohub runtime down

# 可选：请求新建 Space（-n 是 --new，不再是 --name）
cohub runtime up -n --name another-project
```

绑定按本地目录、账号和环境隔离，保存在 `~/.config/cohub/runtime-spaces.json`。
省略 `--space` 时会自动读取；显式传入 `--space` 或设置 `COHUB_SPACE_ID` 会覆盖并更新当前目录绑定。
`-d` 返回 Space 链接、进程 ID 和日志位置后在后台运行；30 秒内尚未就绪时返回退出码 2，进程继续连接。
`--yes` 用于非交互执行授权。`down` 保留所有数据，存在未确认执行时需加 `--yes`。
断网会自动重连，但不会自动重跑模型或工具；断连不代表任务已经停止。

### Boards

Board 命令支持 Board ID 或 `.board` 路径。读取按资源范围执行，查询单个 item 不会加载整个 Board。

```bash
cohub -s <spaceId> boards inspect boards/plan.board --json
cohub -s <spaceId> boards items list <boardId>
cohub -s <spaceId> boards items get <boardId> <itemId> --json
cohub -s <spaceId> boards connections list <boardId>
cohub -s <spaceId> boards effects get <boardId> <effectId> --json
cohub -s <spaceId> boards compositions get <boardId> <compositionId> --json
```

使用 `boards examples` 生成 JSON 模板，使用 `boards capabilities --json` 查看支持的 schema。多个变更可以通过 semantic command batch 原子提交：

```bash
cohub boards examples item text > item.json
cohub -s <spaceId> boards items create <boardId> --input item.json
cohub boards examples batch basic > changes.json
cohub -s <spaceId> boards batch <boardId> --input changes.json --dry-run
cohub -s <spaceId> boards batch <boardId> --input changes.json
```

batch 文件包含 `commands` 数组，可以组合 item、connection、effect、composition 和 Board patch，不需要包含完整 Board 快照。需要严格控制重试时使用 `--base-version` 和 `--mutation-id`。

播放命令统一位于 `boards playback` 下；图片渲染仍使用 `boards export`。

### Search 与 models

```bash
cohub search "release notes"
cohub models ls
cohub models ls --model-type multimodal
cohub generate "A calm lake at sunrise" --model <model> --output lake.png
```

`models ls` 会展示每个 LLM 的百万 token 成本（如 `$3 /M input · $15 /M output`），并隐藏标记为 `hidden` 的模型。`models ls --model-type multimodal` 会展示每个生成模型的单位价格（如 `$0.04 / image`、`$0.10–$0.50 / second`）；`--json` 返回原始 `pricing` 对象（`unit`、`amount` 或 `min`/`max`、可选 `note`）。

## 输出约定

脚本或 Agent 需要串联命令时，使用 `--json`。

```bash
cohub spaces ls --json
cohub -s <spaceId> spaces sessions ls --json
```

交互使用可读输出即可；自动化优先 JSON。

## 下一步

- UI 产品闭环：[快速开始](/zh/docs/learn/quick-start)
- App 能力与权限：[App 开发](/zh/docs/developers/apps)
- 程序化访问：[SDK](/zh/docs/developers/sdk)
- 发布细节：[Apps](/zh/docs/create/apps)
