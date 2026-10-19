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

自部署或通过代理访问时，可指定 API 地址：

```bash
cohub --base-url https://api.example.com spaces ls
COHUB_BASE_URL=https://api.example.com cohub spaces ls
```

`--base-url` 优先于 `COHUB_BASE_URL`。两者都未设置时，使用当前环境的默认 API 地址。其他服务地址独立配置：

| 变量 | 地址 |
| --- | --- |
| `COHUB_BASE_URL` | API base URL |
| `COHUB_WS_URL` | 实时连接的 gateway 地址，支持 `http(s)` 和 `ws(s)` |
| `COHUB_WEB_URL` | CLI 输出链接使用的 Web base URL |

修改 API 地址不会修改 gateway 或鉴权服务。自部署鉴权可通过 `COHUB_AUTH_ISSUER`、`COHUB_AUTH_CLIENT_ID` 配置，必要时再设置 `COHUB_AUTH_RESOURCE` 和 `COHUB_AUTH_SCOPE`。登录会话、Home Space 缓存和 Runtime 目录绑定按 API 地址隔离；每台自定义服务器需要分别登录，也可使用 `COHUB_EXECUTION_TOKEN`。

## 全局 flags

| Flag | 作用 |
| --- | --- |
| `-s, --space <space>` | 指定 space-scoped 命令的目标 Space |
| `--base-url <url>` | 覆盖 API base URL |
| `--json` | 机器可读输出 |
| `-h, --help` | 命令帮助 |

很多工作流需要 Space。CLI 依次使用 `-s`、`COHUB_SPACE_ID`，以及 `cohub runtime up` 为当前目录记住的 Space。`<space>` 可以是 Space ID、自己 Space 的 slug（比如 `home`），或 `username/slug`：

```bash
cohub -s <spaceId> spaces get
cohub -s home spaces files ls
COHUB_SPACE_ID=<spaceId> cohub spaces get
```

`prompt`、`completion`、`decision`、`generate`、`apps` 和 `public` 这类开启新工作的命令，在没有任何目标时会回退到你的 Home Space。其余 Space 命令会读取或修改 Space 里已有的内容，没有目标时直接报错，不会替你猜。

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

### 决策

针对文本或图片回答肯定否定、单选和打分问题。问题可以写成内联 JSON，也可以放在 JSON 文件里；本地图片会先转成 WebP 并上传。

命令行文本和 `--image` 会追加到 `--input` 中的文本或数组 state，不会替换原始内容。JSON 对象 state 不支持追加文本或图片；需要组合时，请在文件中把完整 state 写成文本和图片组成的数组。

```bash
cohub decision "I was charged twice" -q questions.json
cat ticket.txt | cohub decision -q questions.json --json
cohub decision "Duplicate charge?" --image receipt.png -q questions.json
cohub decision --input request.json
```

### 在 Space 工作区运行命令

```bash
cohub -s <spaceId> run -- git status
```

### Files

```bash
cohub -s <spaceId> spaces files ls
cohub -s <spaceId> spaces files cat README.md
cohub -s <spaceId> spaces files cat logo.png > logo.png
cohub -s <spaceId> spaces files write notes.md --stdin < notes.md
cohub -s <spaceId> spaces files upload ./src
cohub -s <spaceId> spaces files cp -r <otherSpaceId>:assets assets
cohub -s <spaceId> spaces files diff
```

`cp` 的用法和 `scp` 一致：最后一个路径是目标，`<space>:<path>` 指向某个 Space，`<space>` 可以是
ID、`username/slug`，或你名下 Space 的 slug。用 `-s` 或 `COHUB_SPACE_ID` 声明了当前 Space 时，
不带前缀的路径指当前 Space，否则指本地文件，所以同一个命令就能上传、下载或在 Space 之间拷贝。
Space 之间的拷贝在服务端完成，文件内容不经过 CLI。

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

### 房间

像其他成员一样参与已发布 App 的实时房间：读取和发布事件，设置别人看到的你的状态。用 App 给的邀请（`room.invite()`）加入，或者为你管理的 App 开一个房间。

```bash
cohub rooms create --app <app>                      # 打印邀请和打开房间的链接
cohub rooms join <invite> --presence '{"name":"向导"}'
cohub rooms get <room>                              # 成员、成员类型和 presence、最新 sequence
cohub rooms events <room> --after 42 --type 'chat.*'
cohub rooms events <room> --wait 10m                # 有其他人发布事件时返回
cohub rooms events <room> --follow
cohub rooms publish <room> chat.message '{"text":"你好"}'
cohub rooms presence <room> '{"status":"away"}'
cohub rooms invite <room>
cohub rooms leave <room>
```

座位不需要保持连接：每次调用都会续期，超过 `--idle`（默认 30 分钟）没有调用就会释放。Agent 每个对话占一个座位，显示为 `agent` 并带上模型；人显示为 `cli`。事件保存在房间历史里（最近发布的 1,000 条，不超过 512 KB），用 `--after` 可以从上次读到的位置继续。

持续收发实时事件、成员状态和轨道发布信息时，可以保持连接：

```bash
cohub rooms connect <room> --json
cohub rooms connect <room> --after 42 --input --json
```

`--input` 每行接收一条 JSON 指令：`{"op":"publish","type":"chat.message","data":{"text":"你好"}}`、`{"op":"send","type":"cursor","data":{"x":12}}` 或 `{"op":"presence","presence":{"status":"ready"}}`。`publish` 返回包含 sequence 的 `ack`；`send` 是不确认、不保留历史的临时事件。输入结束后继续接收，直到中断。输出为 NDJSON，通过 `kind` 区分 `connected`、`state`、`members`、`event`、`ack`、`gap` 和 `input_error` 等消息。单行输入上限为 20 KB；输出消费过慢时会报错并断开，避免无限积压。

连接会续期已有席位。Ctrl-C 只断开连接；`rooms leave` 释放席位并关闭附着连接。重连恢复成员快照，并补回仍在历史保留范围内的发布事件；收到 `gap` 时需要重新同步状态。该命令暂不包含音视频传输。

Node 程序使用 `CohubClient.rooms.connect(roomId, { after, onRoom })`，在 `onRoom` 中注册监听以接收初始快照和历史补偿。返回的 room 支持 `publish`、`send`、`setPresence`、`subscribeAll` 和 `onMembersChanged`。`room.disconnect()` 断开附着，`room.leave()` 释放席位，`client.disconnect()` 关闭传输连接。`CohubHttpClient` 保持轻量的 HTTP API。

### RTC 媒体与数据流

`rooms rtc` 通过独立的 Go/Pion 助手程序（`cohub-rtc`）运行 WebRTC。CLI 首次使用时会下载并校验当前平台的助手程序；如需使用本地构建，传入 `--helper <path>`。只有需要格式转换时才需要 FFmpeg：

```bash
cohub rooms rtc <room> --audio ./voice.pcm --rate 48000 --channels 1 --output ./received
cohub rooms rtc <room> --video ./clip.i420 --size 640x360 --fps 30 --output ./received
cohub rooms rtc <room> --channel chat --data-input -
```

音频格式为 s16le PCM，视频为原始 I420 帧。编码后的 Ogg Opus（`--audio-format opus`）和 VP8 IVF（`--video-format vp8`）输入会直接透传，无需重新编码。可以通过 FFmpeg 或模型适配程序提供文件、管道输入；只有一路输入可以使用 stdin。输入结束后停止发布对应轨道，但继续接收直到 Ctrl-C。`--participant` 筛选接收成员，`--delivery latest` 选择尽力而为的 DataChannel 传输。输出为 NDJSON。接收轨道保存为唯一命名的原始帧文件和逐帧时间、格式元数据；这些是解码后的接收帧，不是发送方原始媒体的无损副本。不指定 `--output` 就不会录制。`--output -` 将媒体以二进制分帧输出到 stdout（4 字节大端 JSON 头长度、包含 `bytes` 的 UTF-8 JSON 头、媒体数据），状态消息改走 stderr，方便实时模型直接消费，不经过 Base64 或中间文件。缓冲区有界，输出过慢会明确失败；轨道替换时创建新分片。

原生适配器运行在隔离子进程中。正常退出会先释放 RTC，再断开连接，保留 Room 席位。同一 Agent 席位只允许一个 RTC 会话。Node 程序可以通过 `room.rtc({ createPeerConnection })` 注入自定义 PeerConnection。本地构建、格式和限制详见 `apps/sandbox/cmd/cohub-rtc/README.md`。服务端需要配置 SFU。

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

# 可选：共享这台电脑的屏幕（会先询问，默认否），或在无界面的 Linux 上启动一块虚拟屏
cohub runtime up --display
cohub runtime up --display xvfb:1920x1080
```

绑定按本地目录、账号和环境隔离，保存在 `~/.config/cohub/runtime-spaces.json`。
省略 `--space` 时会自动读取；显式传入 `--space` 或设置 `COHUB_SPACE_ID` 会覆盖并更新当前目录绑定。
`-d` 返回 Space 链接、进程 ID 和日志位置后在后台运行；30 秒内尚未就绪时返回退出码 2，进程继续连接。
`--yes` 用于非交互执行授权。`down` 保留所有数据，存在未确认执行时需加 `--yes`。
断网会自动重连，但不会自动重跑模型或工具；断连不代表任务已经停止。
本地 Harness 包括 Pi、Codex、Claude Code（`claude`）和 WorkBuddy（`codebuddy`）。未指定 `--harness` 时
会尝试所有已安装的 Harness，无法启动的会告警并跳过。

### Displays

Space 所在机器共享的屏幕：Android 应用共享的手机、`cohub runtime up --display` 共享的电脑，或沙箱的虚拟屏幕。坐标是最近一次 `capture` 截图上的像素（或 `--size` 指定的尺寸）；屏幕支持控件树时，用 `tree` 给出的引用更精确：

```bash
cohub spaces displays ls
cohub spaces displays start                   # 可用时启动虚拟屏幕；stop 停止
cohub spaces displays capture -o screen.jpg   # 默认最长边 1280
cohub spaces displays tree                    # e3.12 button "Send" (980,2210 120x80)
cohub spaces displays tree --actionable       # 只列出可操作的控件
cohub spaces displays tap e3.12 --screenshot  # 操作后保存截图
cohub spaces displays type "hello" --into e3.4
cohub spaces displays tap 540 1200
cohub spaces displays swipe 288 1000 288 300
cohub spaces displays tap 300 200 --count 2   # 双击；--button secondary 为右键
cohub spaces displays type "hello"
cohub spaces displays key Control+a
cohub spaces displays press back              # 手机会列出它支持的系统按键
```

在 macOS 上，运行 Runtime 的终端需要「屏幕录制」权限，操作屏幕还需要「辅助功能」权限（系统设置 → 隐私与安全性）。Linux 需要 X11 会话，暂不支持 Wayland。

`act` 从 `--actions` 或 stdin 读取 JSON 动作数组，按同一时间线执行。有人在操作屏幕时，动作会以 `display_preempted` 停止，先重新看一眼屏幕再继续。查看画面、`capture` 和 `tree` 需要沙箱的查看权限；操作屏幕和 `start` / `stop` 需要执行命令的权限。

### Boards

Board 是一个 JSON 文档，包含三部分——`board` 设置、以 id 为键的 `items` map 和 `animations` map——所有命令都支持 Board ID 或 `.board` 路径。`get` 按资源范围读取，查询单个 item 不会加载整个 Board：

```bash
cohub -s <spaceId> boards get boards/plan.board --json
cohub -s <spaceId> boards get <boardId> --only board
cohub -s <spaceId> boards get <boardId> --only items
cohub -s <spaceId> boards get <boardId> --items title,note
cohub -s <spaceId> boards get <boardId> --within s1
```

`apply` 是唯一的写入方式：对文档应用 JSON Merge Patch，字段合并、`null` 删除、未提及的字段保持不变。`--replace` 让文档等于 patch 而非合并。`--dry-run` 校验但不写入，`--base-version` / `--mutation-id` 用于控制重试。

```bash
cohub -s <spaceId> boards apply <boardId> '{"items":{"title":{"props":{"text":"New title"}}}}'
cohub -s <spaceId> boards apply <boardId> -i patch.json --dry-run
cohub -s <spaceId> boards apply <boardId> -i - < changes.json
```

`boards schema` 会说明每个字段的含义；`boards preset` 会把预设动效输出为轨迹——带 `--animation` 时是一份可直接 `apply` 的 patch，不带时是纯 `tracks`：

```bash
cohub -s <spaceId> boards schema                 # 单位、item 类型、颜色、可动画属性
cohub -s <spaceId> boards schema arrow           # 指定一个 target
cohub -s <spaceId> boards examples lesson > lesson.json
cohub -s <spaceId> boards preset rise --targets a,b --animation intro | cohub boards apply <boardId> -i -
cohub -s <spaceId> boards preset float --targets ship   # 纯 tracks，可自行折进动画
```

`boards history` 列出历史版本或恢复到某个版本。播放对所有观看者同步（`play`、`pause`、`resume`、`seek`、`next`、`stop`），`boards export` 渲染图片和视频，`boards watch` 会流式输出变更与播放状态。

`video` 和 `audio` item 支持以毫秒为单位的 `props.time`，可以直接用动画轨迹驱动：

```json
{
  "target": "music",
  "property": "props.time",
  "keyframes": [{ "at": 0, "value": 0 }, { "at": 6000, "value": 6000 }]
}
```

`task` item 是一次生成任务的实时卡片：只需写 `props.taskRunId`，服务端会持续更新它的状态和结果。任何 item 都可以挂载 `script: { src, params }`，即一个在 worker 中运行、负责绘制或添加行为的 JavaScript 模块；`custom` item 是一个空盒子，内容由模块绘制。`cohub boards schema script` 列出模块 API，`cohub boards examples custom --module` 输出一个起步模块。

### Search 与 models

```bash
cohub search "release notes"
cohub models ls
cohub models ls --model-type multimodal
cohub generate "A calm lake at sunrise" --model <model> --output lake.png
```

`search` 可搜索 Space、对话（按标题或对话中发送的消息）和标签条目。`--types chat,space,label` 用于限定结果类型，`--space-id` 可搜索某个 Space 中你有权查看的全部对话；对话行会显示命中的消息。

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
