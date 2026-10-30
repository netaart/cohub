---
title: App 开发
description: 构建 Cohub App —— 运行时上下文、权限、提示词、生成、文件、Action、形态与商业化。
---

Cohub App 是运行在 Cohub 运行时里的已发布网页。在 App 代码里可以与 Agent 对话、生成媒体、读写 Space 文件、运行服务端 Action、在访客间共享实时状态，以及售卖商品。

本页是 App 开发的唯一深度参考。发布见 [Apps](/zh/docs/create/apps)。

## Runtime 一分钟

`createCohubClient()` 在 App 内无需 token —— host 提供短期凭证。运行时 API 只在**已发布**的 App 里可用；本地 `file://` 页面和裸静态 URL 的 `context()` 返回 `null`。

- **Bridge 模式** —— App 运行在 Cohub iframe 里，常规形态。
- **Broker 模式** —— App 从独立 origin（`<app-id>.apps.example.com`，按部署可选开启）打开，使用弹窗 broker。

SDK 用同一份初始化代码自动识别两种模式：

```ts
import { createCohubClient } from "@neta-art/cohub";

// 浏览器不注入 ENV —— 必须显式传入，否则 dev 环境的 App
// 会悄悄调用生产 API。
const isDev = location.pathname.startsWith("/dev/") || location.hostname.includes("dev");
const client = createCohubClient({ env: isDev ? "dev" : "prod" });

const ctx = await client.context();
if (!ctx?.app?.id) throw new Error("Not inside a published app");
```

无构建工具时从 ESM CDN 导入：

```ts
import { createCohubClient } from "https://esm.sh/@neta-art/cohub?bundle&target=es2022";
```

## 先做三个决定

**1. 到底需不需要 Cohub 能力？**

只是呈现一个东西 —— 页面、报告、游戏？用空 scope 发布，不写运行时代码。无需授权，无需付费。

**2. AI 费用谁出？**

| 答案 | 做法 | 访客看到 |
| --- | --- | --- |
| **访客** | 在 App 浏览器代码里调用 prompt、completion、generation。用量计费到访客。 | 首次使用时一个授权对话框（`auth.authorize`） |
| **Owner（你）** | 把工作放进 [App Action](#app-actions)（`.cohub/actions/`），用 `app.actions.run()` 触发。Action 以 App owner 身份在 home Space sandbox 里运行；用量计费给你。 | 无 —— 不需要访客授权 |
| 混合 | 浏览器里做免费读取；昂贵的生成放到 Action 里用商业化积分计量回收。 | 两者各一次 |

**3. 数据存在哪？**

| 答案 | 做法 | 访客看到 |
| --- | --- | --- |
| **访客自己的 Space** | `auth.authorize({ target: { kind: "space" \| "pick-space" } })`，然后写文件 | 一次授权，可撤销，14 天有效 |
| **你的 home Space** | Action 用 owner 权限写文件 | 无 |
| **临时的、多访客的** | `app.realtime` 房间 | 无 |

## 环境感知

context 告诉 App 我是谁、从哪被打开、host 当前在展示什么。它是路由信息，永远不是授权。

```ts
const ctx = await client.context();

ctx.app.homeSpace;        // 拥有这个 App 的 Space（静态）
ctx.viewer;               // 当前访客，未登录为 null
ctx.invocation;           // 这次打开来自哪（快照）：
                          //   surface、source、spaceId、sessionId、turnId、
                          //   toolCallId、embedder、file、id
ctx.shell;                // host 当前在展示什么（实时）：
                          //   space、session、turn
ctx.locale;               // 访客使用的语言，如 "zh-CN"
ctx.appearance;           // colorScheme、theme、tokens、reducedMotion
ctx.window;               // { visible } —— 标签页隐藏时为 false
ctx.permissions;          // appScopes + viewerGrants，用于渲染状态

// shell / 登录态 / 授权 / 主题 / 可见性变化时推送新 context ——
// 留在内存里，不要轮询
client.app.onContextChanged((next) => render(next));
```

三个身份字段的设计差异：

| 字段 | 含义 | 变化 |
| --- | --- | --- |
| `ctx.app.homeSpace` | 拥有 App 的 Space | 不变 |
| `ctx.invocation` | 这次打开来自哪 | 每次打开 |
| `ctx.shell` | host 当前在展示什么 | 随访客导航 |

### 跟随 host 外观

只有访客跟随系统设置时，`navigator.language` 和 `prefers-color-scheme` 才与 Cohub 一致。请改读 `ctx.locale` 和 `ctx.appearance`：tokens 是访客当前所见主题的解析值，已包含 Space 的自定义主题。一行代码即可让 `<html>` 保持同步：

```ts
client.app.appearance.sync(); // 写入 --cohub-* 变量、color-scheme 和 lang
```

```css
body {
  background: var(--cohub-bg-primary, #fff);
  color: var(--cohub-text-primary, #111);
  font-family: var(--cohub-font-sans, system-ui);
}
```

公开的 token 有 `bg-primary`、`bg-content`、`bg-surface`、`bg-elevated`、`bg-input`、`bg-hover`、`bg-active`、`text-primary`、`text-secondary`、`text-tertiary`、`text-placeholder`、`text-disabled`、`border-primary`、`border-subtle`、`brand`、`brand-hover`、`brand-soft`、`brand-muted`、`brand-border`、`brand-ring`、`brand-contrast-fg`、`error-fg`、`success`、`warning`、`error`、`info`、`status-running`、`selection-bg`、`overlay-scrim`、`shadow-subtle`、`shadow-medium`、`shadow-strong`、`font-sans` 和 `font-mono`。务必保留回退值：在 Cohub host 之外它们不存在。

`ctx.window.visible` 为 false 时暂停高开销的渲染；后台标签页保持挂载，切回时可立即恢复。

## 调用自己的后端

取得所需的 viewer grant 后，使用 `client.auth.getAccessToken()`，以 SDK 调用 Cohub API 时使用的同一凭证请求可信后端。已发布 App 默认取得的是 App session，不是宿主的账户凭证。该方法复用现有 runtime，兼容 iframe 和独立页面 broker 模式；无需另建 runtime 或读取存储键。

```ts
const token = await client.auth.getAccessToken();
if (!token) return; // 当前没有可用凭证。
const response = await fetch("https://your-backend.example/api/reply", {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ input: "Hello" }),
});
```

传入 `{ forceRefresh: true }` 可向同一凭证来源请求刷新。client 配置的自定义 `getAccessToken` 或沙箱执行凭证仍遵循原有优先级。返回值为 `Promise<string | null>`，凭证来源的错误会继续抛出，不会申请额外权限。后端必须验证凭证并保留授权边界。不要把 token 放进 URL 或日志，也不要在生成流已经开始后自动重放请求。

## 权限

App 在一个 Space 上的有效权限是**两个来源的并集** —— 任一即可：

| 来源 | 授予者 | 覆盖 | 有效期 |
| --- | --- | --- | --- |
| **App scopes** | 发布者在发布时 | 仅 App 自己的 Space；八个受限 scope | 随发布存在 |
| **Viewer grants** | 访客通过授权对话框 | 访客持有的任意权限，任意 Space | 14 天，可撤销 |

八个 app scope：`space.view`、`session.view`、`file.view`、`file.edit`、`taskrun.view`、`session.prompt.readonly`、`session.prompt.fullaccess`、`command.execute`。

黄金法则：

```text
App 自己 Space 上的读取 → app scopes
动作、其他 Space、生成、账户数据 → viewer grants
```

从用户手势请求 viewer grant，说明清楚理由，静默复用覆盖回访 —— `auth.authorize()` 只在需要新内容时弹对话框。永远使用返回的 `target`，它可能解析到与你请求不同的 Space。

```ts
const result = await client.auth.authorize({
  target: { kind: "space", spaceId },
  scopes: ["file.view"],
  reason: "Read the Space you opened this App from.",
});
if (result.status !== "granted" || result.target.kind !== "space") return;
const space = client.space(result.target.spaceId);
```

- 目标：`{ kind: "account" }`、`{ kind: "space", spaceId }` 或 `{ kind: "pick-space" }`。账户目标只接受账户级 scope。
- 成功返回 `status`、`requestedTarget`、实际 `target`、`resolution` 和 `grant`。取消（`cancelled`）不是错误。
- 目标正好是 `ctx.shell.space.id`（即访客正在看的那个 Space），且该 Space 发布或安装了这个 App 时，只读 scope（`space.view`、`file.view`、`file.view.filtered`、`session.view`、`taskrun.view`、`checkpoint.view`）和 `file.edit` 都静默完成。其他 App 首次会询问一次，之后只读授权静默续期。访客撤销过的授权总会重新询问。
- 不可用的 Space 可回退到访客可用的 Space；`fallback: "none"` 禁止回退。
- `alwaysAsk: true` 跳过静默复用 —— 用于重新确认或切换 Space。
- grant 只读取，不延长有效期；增量授权（`scopeMode: "extend"`）向仍有效的 grant 追加 scope。
- 访客经 `cohub apps grants <app>` / `revoke` 管理授权；App 会话不能管理自己的授权。
- `auth.requestCreateSpace({ scopes, space })` 一次授权创建访客自己的 Space。`granted: false` 但带 `space` 表示 Space 已创建而初始化未完成 —— 对它继续恢复；绝不自动创建第二个，也不自动删除第一个。

### 通过邀请加入 Space

可以自己做邀请页：匿名读取邀请信息，再让访客通过 host 加入。

```ts
const invite = await client.invite.get(token);
// { spaceName, spaceDescription, spaceAvatarUrl, role, inviter, expiresAt, ... }

const result = await client.auth.joinSpace({
  invite: token,
  scopes: ["file.view"], // 可选：同一步里授权访问加入的 Space
  reason: "加入工作室，查看共享的 Board",
});
if (result.status === "joined") {
  // result.space、result.role、result.granted
}
```

- 需要时 host 会先让访客登录，然后弹出一次加入确认，并用访客自己的账号接受邀请。App 会话不能直接接受邀请。
- 访客已拥有该角色或更高角色时也返回 `joined`；未请求 scope 时不会弹窗。`unavailable` 表示链接已过期、被撤销或用完次数。`cancelled` 不是错误。
- 在用户手势中调用。Host 可以在 Space 设置或用 `cohub spaces invites create` 创建链接，有效期 1–30 天或长期有效（host 链接除外）。持有访客 `member.manage` 授权的 App 也可以用 `space(id).invitations.create()` 创建。

### API → scope 对照表

| 操作 | Scope | 来源 |
| --- | --- | --- |
| 读 Space 配置 | `space.view` | app 或 viewer |
| 列出模型 | *（无 —— 仅需认证）* | — |
| 发送 prompt（完全访问） | `session.prompt.fullaccess` | app 或 viewer |
| 发送 prompt（只读） | `session.prompt.readonly` | app 或 viewer |
| LLM completion | `session.prompt.readonly` | app 或 viewer |
| Decision | `session.prompt.readonly` | app 或 viewer |
| 读 / 流式读回复、文件树、文件内容 | `session.view`、`file.view` | app 或 viewer |
| 写文件 | `file.edit` | app 或 viewer |
| 运行 sandbox 命令 | `command.execute` | app 或 viewer |
| 创建生成任务 | `generation.create` | **仅 viewer** |
| 轮询任务、读 task run | `taskrun.view` | app 或 viewer |
| 列访客的 spaces / sessions / 活动 / 全部任务 | `user.space.list` / `user.session.list` / `user.usage.read` / `user.taskrun.list` | **仅 viewer** |
| 为访客创建 Space | 新 Space 上的请求 scope | **访客授权** |
| 通过邀请加入 Space | 加入的 Space 上的请求 scope | **访客授权** |
| 创建、列出、撤销邀请链接 | `member.manage` | **仅 viewer** |
| 商业化、realtime、surface、composer、actions、navigation | *（仅运行时，无 scope）* | — |

“app 或 viewer” 指任一来源即可；app scope 只覆盖 App 自己的 Space，其他 Space 需要该 Space 上的 viewer grant。

## AI

### 与 Agent 对话

向 Space Chat 发送 prompt 并流式接收回复。

```ts
// session.prompt.fullaccess + session.view
const result = await space.prompt({
  accessMode: "full_access", // 必须与你持有的 scope 匹配
  content: [{ type: "text", text: "Describe a shiba inu on Mars." }],
  sessionId: null, // null 创建 session；传 id 则继续
});

space.session(result.session.id).subscribeGeneration({
  state: (e) => renderPartial(e.state),
  finalized: (e) => render(e.turn.assistantText),
});
```

- `space.prompt()` 立即返回；回复经 `subscribeGeneration`（或轮询 `turns.get()`）到达。
- `accessMode` 必须与持有的 scope 匹配。缺省是 `full_access`，所以只持有 `session.prompt.readonly` 却省略 `accessMode` 是最常见的 403。
- `session.prompt.fullaccess` **不包含** `session.view` —— 发送成功但读回复 403。

### LLM completion

无持久 session / turn 的一次性补全 —— 适合行内建议、摘要、分类。接受完整对话历史和可选的 Space 相对 `systemPromptPath`。只需要 `session.prompt.readonly`。

```ts
const result = await space.completion({
  messages: [{ role: "user", content: [{ type: "text", text: "Summarize in one line." }] }],
});
result.message.content; // assistant ContentBlock[]

for await (const event of space.streamCompletion({ messages, maxTokens: 160 })) {
  if (event.type === "delta") render(event.text); // SSE 增量 + 最终聚合结果
}
```

`content` 也可以直接是字符串。图片支持 Cohub / Anthropic 格式，以及 OpenAI Chat（`image_url`）和 Responses（`input_image`）格式；URL 会原样交给模型，需要公网可访问，`data:` URL 则以内联方式发送。

```ts
await space.completion({
  messages: [{ role: "user", content: [
    { type: "text", text: "图里有什么？" },
    { type: "image_url", image_url: { url: "https://example.com/cat.webp" } },
  ] }],
});
```

### Decision

针对文本、JSON 对象或图片回答结构化问题，并给出校准过的概率，适合路由、审核、分诊和打分。只需要 `session.prompt.readonly`。

```ts
const result = await space.decision({
  state: { ticket: "I was charged twice. Please refund it." },
  questions: {
    refund: { type: "noul", instructions: "Is the customer asking for a refund?" },
    team: { type: "choice", instructions: "Which team?", criteria: { billing: "Charges", technical: "Bugs" } },
    urgency: { type: "score", instructions: "How urgent?", criteria: ["Can wait", "Needs attention"] },
  },
});
result.answers.refund.noul;   // 0 到 1
result.answers.team.choice;   // "billing"，另有 confidence 和 probabilities
result.answers.urgency.score; // 0 到 1，另有 confidence、legend 和 probabilities
```

- `noul` 是肯定或否定；`choice` 从 `criteria` 的键里选一个；`score` 按至少两项、有先后顺序的 `criteria` 打分。最多 200 个问题，键名会原样出现在 `answers` 里。
- 不传 `model` 时，与 LLM completion 一样按配置顺序选择，优先可见模型，不按图片能力重新排序。
- 带图片时，`state` 写成由文本和 `{ type: "image_url", image_url: { url } }` 组成的数组。URL 需要公网可访问；`data:` URL（PNG、JPEG 或 WebP）会以内联方式发送。
- 用量按模型服务商在 `usage.cost` 里报告的费用计费给调用方。

### Generation（图片 / 视频 / 音频）

```ts
// viewer grant generation.create + taskrun.view
const result = await client.generations.createAndWait(
  {
    spaceId,
    model: "gpt-image-2", // 来自 client.models.listMultimodal()
    content: [{ type: "text", text: "A cat on the moon, cartoon style" }],
    parameters: { size: "1024x1024" },
  },
  { onPoll: (d) => updateProgress(d.run.status) },
);
const url = result.output?.find((b) => b.type === "image")?.source?.url;
```

`generation.create` 只能来自 **viewer grant** —— 从用户手势请求。轮询需要 `taskrun.view`；缺了它就是经典的“任务创建后永远不完成” bug。

## 文件与 sandbox

```ts
const space = client.space(spaceId);

// file.view
const tree = await space.files.tree();
const file = await space.files.read("data.json");

// file.edit
await space.files.write("output/result.json", JSON.stringify(data));

// command.execute —— 在 Space sandbox 里运行 shell 命令
const run = await space.runCommand({ command: ["node", "scripts/build.mjs"] });
```

往访客自己的 Space 写数据：经 `auth.authorize` 请求 `file.edit`。owner 承担的持久化：改用 Action —— 它以你的权限在 home Space 里运行。

## 打开文件

App 可以作为某类文件的编辑器或查看器 —— 比如 Board 编辑器、Markdown 工作室。在页面 head 中声明它能打开的扩展名：

```html
<meta name="cohub:file-handlers" content=".board" />
```

安装 App 时，它会在 `.cohub/apps.json` 中注册这些扩展名；如果已有其他已安装的 App 打开这类文件，则不注册 —— 安装永远不会替换默认设置。访客可以在文件菜单的**打开方式…**中勾选**始终以这种方式打开 .board 文件**来更改默认 App，Space 也是这样把自己发布的 App 设为默认。一个扩展名只由一个 App 打开，并且该 App 仍须声明这个扩展名。

点击这类文件、打开指向它的链接，或执行 `cohub desktop open file://plans/roadmap.board`，都会用该 App 在单独的窗口中打开文件。只读视图（比如存档）始终使用内置查看器。

```ts
client.app.onLaunch(async ({ file }) => {
  await openDocument(file.spaceId, file.path);
});
```

每个窗口承载一个文件。`onLaunch` 会在窗口打开时触发，在访客再次打开同一个文件时触发（把它切到前台即可），也会在文件改名或移动时触发 —— 此后保存到新路径。

Space 发布或安装的 App 在该 Space 上无需对话框即可获得 `file.view` 和 `file.edit`，打开文件开箱即用。其他 App 会先征得访客同意。因此安装是整个 Space 的信任决定：能编辑 `.cohub/apps.json` 的人都能安装 App，装好后，任何成员打开它，它都能编辑这个 Space 的文件。

## App Actions

目录型 App 在 `.cohub/actions/` 下暴露服务端入口。host 下载不可变的 App 版本，**以 App owner 身份**在 home Space sandbox 里运行 —— 执行成本由你承担 —— 而权益和积分计量作用于已登录的访客。

```ts
const task = await client.app.actions.run({
  action: "summarize",
  input: { text: "Long document..." }, // stdin 上的 JSON，≤ 16 KB
});
const detail = await client.tasks.get(task.taskRunId); // 轮询到完成
```

`.ts` / `.js` 入口在 Node 原生 type stripping 下运行（不支持 enum、namespace、参数属性）；其他文件按可执行位或 shebang 运行。Action 内 SDK 从执行 token 解析身份 —— 无需管理任何凭证：

```ts
import { getCohubContext } from "@neta-art/cohub";

const { execution } = getCohubContext();
execution.viewerUserId; // 谁点击的 —— 对他计量积分
execution.spaceId;      // home Space
```

- Action key 是 `[a-z0-9-_]+`；最多只能存在一个同名入口。
- 输入与 Task Run 一起存储，App owner 和 Space 成员可见 —— 永远不是秘密通道。
- Action 不能递归调用 `app.actions.run()`。
- Space Hooks 可用 `uses: user/space/app/action` 运行 Action —— 见
  [Space Hooks](https://github.com/talesofai/cohub/blob/main/docs/space-hooks.md)。

## 形态

### 预览标签 / 窗口

默认形态：App 作为 workspace 预览标签打开，深链为 `?window=app:<appId>`。

### Overlay

覆盖在 workspace 之上、Cohub 自身 UI 之下的透明无框层。

```html
<meta name="cohub:surface" content="overlay" />   <!-- 发布时声明 -->
```

```bash
cohub desktop open <app> --as overlay   # 或 --as window，按次指定
```

overlay 初始完全点击穿透。认领可交互区域，可选自定义几何：

```ts
cohub.app.requestConfigure({
  inputRegion: [{ x: rect.left, y: rect.top, width: rect.width, height: rect.height }],
});
```

- `inputRegion` —— `"none"`（默认）、`"all"` 或矩形列表。只路由指针事件，不裁剪绘制。
- `geometry`（`anchor`、`x`、`y`、`width`、`height`）收缩 overlay，限制在屏幕内；省略的轴填满窗口。
- 自己画透明（`html, body { background: transparent }`）并设置 `<meta name="color-scheme" content="light dark">`，否则 Chromium 会画一层不透明底色。
- 用 `cohub.app.requestClose()` 自行关闭；访客永远可以按 `Escape`。

### Background（新聊天）

workspace App 可作为新聊天背景：`shell.surface` 为 `"background"`、`shell.space` 为承载 Space。可挂 composer chip，但不能被 UI 命令调用。

### 访客页

Space 可以把自己一个已发布的公开 App 设为访客页（Space 设置 → 访问权限，或 `cohub spaces config <space> --guest-app <app>`）。无权限的访客会看到它而不是默认页面，邀请链接也会打开它：`shell.surface` 为 `"guest"`，`shell.space` 为该 Space，有邀请时 `shell.invite.token` 带着邀请码。把它传给 `auth.joinSpace`；加入后 host 会为访客打开这个 Space。

### 内嵌其他 App

已发布的 App 可以在 iframe 里承载其他 App。被内嵌运行时保留自己的 bridge、授权对话框、商业化和 Cohub bar —— 内嵌方永远看不到它的 token。

```html
<iframe src="https://cohub.live/alice/studio/w/notes"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
  allow="clipboard-read; clipboard-write; fullscreen; web-share"></iframe>
```

```ts
const embed = cohub.app.embed.attach(frame, {
  appId: context.app.id,
  shell: context.shell ?? null,
  onCloseRequest: () => frame.remove(),
});
cohub.app.onContextChanged((next) => embed.setShell(next.shell ?? null));
embed.dispose();
```

被内嵌的 App 把转发来的位置视为 `surface: "embed"` 的 `shell`，宿主在 `invocation.embedder` —— 导航提示，永远不是授权。

### App Surface（可调用方法）

注册命名方法，供 Cohub host —— 包括 Agent 通过 `cohub desktop open <app> --call <method>` —— 调用运行中的 App。

```ts
client.app.surface.handle("image.open", async (input, { commandId }) => {
  const result = await openImageStudio(input);
  await client.desktop.reportResult(commandId, { status: "applied", result, error: null });
});
```

- 只有注册过的方法可达；没有 DOM 访问，没有脚本执行。
- 调用至少投递一次 —— handler 应当幂等。
- 响应只确认投递；最终结果经 `reportResult()` 上报，持久化 `commandId` 以便重载后恢复。
- 只接受显式 Cohub app origin：`client.app.surface.allowHostOrigins(["https://cohub.internal"])`。

### 窗口状态与关闭

告诉 host 标签页该显示什么，以及是否还有未保存的工作：

```ts
client.app.window.setState({ title: "Roadmap.board", status: "saving", dirty: true });
client.app.window.onBeforeClose(async () => {
  await flushPendingWrites(); // 返回 false 或抛错则保持窗口打开
});
```

`dirty` 为 true 时，host 不会为了节省内存卸载这个 App。关闭标签页、重新加载或离开工作区之前，会先调用 `onBeforeClose`，只有它失败或超过 10 秒时才询问访客。新的 App 版本会等到下次重新加载，而不会替换一个未保存的文档。草稿仍需自行持久化：关闭浏览器标签页时无法等待。

### 快捷键

App 获得焦点时，命令面板等 Cohub 快捷键照常可用。App 调用过 `context()` 之后，SDK 会转发 App 没有处理的 Ctrl / Cmd 组合键；普通输入和编辑组合键（复制、粘贴、剪切、全选、撤销、重做）始终留在 App 内。调用 `event.preventDefault()` 即可自己保留某个组合键。

### 拖放

访客可以把 Cohub 中的文件、Task 和 App 拖到 App 上：

```ts
client.app.onDrop({
  accept: ["file", "task"],
  over: ({ x, y }) => showDropMarker(x, y),
  leave: () => hideDropMarker(),
  drop: ({ x, y, resources }) => placeResources(resources, x, y),
});
```

坐标是 frame 内的 CSS 像素。悬停期间 App 只知道被拖动的是哪几类资源；资源本身在 `drop` 时、访客决定交给 App 时才送达。每个资源都有 `type` 和 `ref`（文件为路径），以及 `title`、`mimeType`、`size` 等可选元数据。像对待粘贴内容一样把拖放视为不可信输入：校验每个 `ref`，并通过自己已授权的 API 读取资源，而不是直接相信这些元数据。

### Composer 上下文

App 激活期间向 Cohub composer 挂一个紧凑的上下文 chip。label ≤ 120 字符，content ≤ 32 KB，纯文本。

```ts
client.app.composer.setChip({ key: "selection", label: "3 selected", content: "..." });
client.app.composer.clearChip("selection");
```

### 导航

在 host workspace 内打开任意 Cohub 资源 —— App、文件、session、task、checkpoint、cronjob。

```ts
await client.navigation.open({ kind: "session", spaceId, sessionId });
await client.navigation.open({ kind: "app", ref: "username/space/app" }, { method: "focus", input: {} });
```

返回 `{ handled }` —— host 不支持时（如 broker 模式）为 `false`，需优雅降级。

直接链接到其他 App 的公开地址也可以，无需 SDK：在工作区里，目标 App 会在自己的窗口中打开（已打开则切到前台），当前 App 保持不变；在公开 App 页面上，链接和 `navigation.open` 都会让整个页面跳转到目标 App。

### 诊断

`client.app.onDiagnostic(cb)` 转发 host 诊断（code + message），用于调试运行时集成。

## Realtime 房间

房间里所有成员之间的共享状态、presence 和 JSON 事件：成员可以是 App 的访客，也可以是从外部邀请进来的人或 Agent（通过 CLI）。运行时原生 —— 无需 scope 或授权。

```ts
const room = await client.app.realtime.createRoom({ code: "TEAM-ALPHA" });
const stop = room.subscribe("shared.state.updated", ({ data }) => render(data));
await room.publish("shared.state.updated", { value: 42 });
```

- 每个事件都有一个全房间统一的 sequence。`publish()` 的事件会保存在房间历史里（最近 1,000 条、不超过 512 KB，随房间过期）；`room.send()` 用于无 ACK 的高频流量，不会保存。
- 重连时会自动补回期间 `publish()` 的事件。只有漏掉的超出历史保留范围时才触发 `onOutOfSync`，这时请重新同步自己的状态。
- `room.history({ after })` 读取加入之前发生的事。
- `seatPerUser: true` 让每个访客跨标签页只占一个席位。
- 房间存活 1 分钟到 24 小时，属于单个 App。在 App 内用房间码创建和加入；用 `ctx.app.url + "?room=" + code` 生成打开房间的链接。

### 成员

`room.members` 列出每个成员的 `participantId`、`presence` 和 `kind`：App 里的访客是 `user`，通过 CLI 进房的是 `agent` 或 `cli`。`agent` 带有它所用的 `model`。代表同一个人的成员共享同一个 `userKey`，App 可以据此显示「Alice 的 Agent」，而看不到账号 ID。名字由 App 自己决定：放进 `presence`。

### Agent 与 CLI

`room.invite()` 返回一个邀请，在过期前（默认 10 分钟）持有它的人都能进房。把它交给 Agent —— 比如写进 prompt —— Agent 就会作为成员加入：

```ts
const { invite } = await room.invite();
await space.prompt({ content: [{ type: "text", text: `Join our room: cohub rooms join ${invite}` }] });
```

```bash
cohub rooms join <invite> --presence '{"name":"向导"}'
cohub rooms events <room> --type 'chat.*' --wait 10m   # Agent 在后台运行，有新事件时被唤醒
cohub rooms publish <room> chat.message '{"text":"你好"}'
```

CLI 的座位不依赖连接：每次调用都会续期，超过 `--idle`（默认 30 分钟）没有调用就会释放。能管理这个 App 的人也可以用 `cohub rooms create --app <app>` 从 CLI 开房，命令会打印邀请和打开房间的链接。Node 脚本通过 `client.rooms` 使用同样的座位。

### 点对点通道（WebRTC）

`room.rtc()` 在房间访客之间建立 WebRTC 连接，适合房间事件太慢、太小或强依赖顺序的场景：

| | `room.publish()` | `room.rtc()` |
| --- | --- | --- |
| 顺序 | 整个房间一个 sequence | 按发送方和通道各自有序 |
| 投递 | 连接期间可靠 | `reliable`，或 `latest`（丢弃过期消息） |
| 载荷 | JSON，≤ 16 KB | JSON 或二进制，≤ 64 KB |
| 路径 | 经过 Cohub 服务器 | 经中转转发，不落库 |
| 保存 | 最近 1,000 条（≤ 512 KB），重连时补回 | 不保存 |
| 可用环境 | 浏览器、Node、CLI | 浏览器 |

```ts
const rtc = await room.rtc();

// 打开 cursor 的访客都会收到其他人发送的内容。
const cursor = rtc.channel("cursor", { delivery: "latest" });
cursor.send({ x, y });
cursor.onMessage(({ from, data }) => moveCursor(from, data));

// 音视频：一次发布多条轨道；每条轨道送达接收它的每个访客。
const { mic, cam } = await rtc.publish({ mic: audioTrack, cam: { track: videoTrack, simulcast: true } });
rtc.onTracksChanged((tracks) => render(tracks));
await cam.replace(otherCamera);   // 换设备，无需重新协商
await mic.stop();
```

- 打开通道即发布，因此对方会立即订阅。消息只送达**当刻已订阅**的成员，**不回放**。`channel.onPeer(({ participantId, open }) => …)` 表示当前客户端开始或停止接收对方的通道，不代表对方已经能接收你的消息。初始状态同步请使用房间事件。
- `reliable`（默认）保证每条消息按序送达；`latest` 不重传，也不会在收到新消息后再收到旧消息 —— 适用于光标、位置、输入快照。两者都支持 JSON 和二进制，二进制以 `ArrayBuffer` 送达。
- 源头结束的轨道（比如拔掉摄像头）会自动停止发布，`onEnded()` 会通知你。静音请改用 `track.enabled = false`。
- 连接会自动重连，状态通过 `rtc.onStateChange()` 报告。关闭连接或离开房间会一并结束它的通道和轨道。
- 所有失败都是带 `code` 的 `AppRtcError`。`RTC_UNSUPPORTED` 表示当前环境没有 WebRTC（Node、CLI、旧版 Gateway），`RTC_UNAVAILABLE` 表示服务端没有配置中转：这两种情况请改用房间事件。

#### 选择接收谁的音视频

每个访客同时最多接收 16 条音视频轨道。`rtc.candidates` 列出房间里所有轨道以及你是否在接收；用 `rtc.select()` 选择：

```ts
rtc.select((candidate) => nearby.has(candidate.participantId)); // null 表示接收所有人
```

条件变化时（有人走近、换了发言人）再调用一次 `select()`。同类轨道之间切换会复用接收器，速度快，也不需要重新协商。以 `simulcast: true` 发布的视频会以三档画质发送，每个访客可以用 `remote.setQuality("low" | "medium" | "high")` 选择，比如缩略图用 low。

[篝火（Campfire）](https://cohub.live/tzwm/cohub-example-apps/w/campfire) 把这些能力放在了一起：位置走 `latest` 通道，语音按距离只 `select()` 听得见的人，摄像头用 simulcast 随距离变清晰，房间历史就是游戏的状态。

### 摄像头、麦克风与屏幕

需要设备的 App 在页面 head 中声明：

```html
<meta name="cohub:devices" content="camera microphone screen" />
```

```ts
const status = await client.app.devices.request(["camera", "microphone"]);
if (status !== "granted") return showNotice(status);
const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
```

对摄像头和麦克风，Cohub 会比浏览器先问，因为同一页面源下的 frame 无法区分不同 App：只靠浏览器弹窗，任何 App 都能复用别的 App 拿到的授权。首次允许后，Cohub 会重新加载 App 一次，让它的 frame 能使用设备 —— 加载后再次调用 `request()`，会立刻返回允许。访客可以在 Cohub 顶栏上单独关闭每个设备，App 会重新加载并不再使用它。

`screen` 不需要这一步：每次调用 `getDisplayMedia()` 浏览器都会让访客自己选择共享什么，所以声明后立即可用，不会重新加载。声明了设备的 App 也可以不经点击直接播放声音。

返回 `unavailable` 表示 App 没有声明该设备，或当前形态、宿主无法使用 —— 屏幕共享需要桌面浏览器。浮层和后台形态不会获得设备权限。

## 商业化

售卖绑定 App 运行时身份的一次性商品。商品携带 **feature benefit**（访问门槛）和 **credit benefit**（消耗型、作用于 Space 的积分）。需要 Space 开启商业化。

```ts
const { entitlements, credits } = await client.app.commerce.getEntitlements();

// 功能解锁
const unlocked = entitlements.some((e) => e.benefitKey === "pro" && e.enabled);
if (!unlocked) await client.app.commerce.purchase({ productKey: "pro_unlock" });

// 计量动作 —— operationId 是每个逻辑动作的幂等键
const result = await client.app.commerce.consumeCredits({
  amount: 10,
  operationId: crypto.randomUUID(),
  reason: "Export high-resolution image",
});
if (result.status === "insufficient") {
  await client.app.commerce.purchase({ productKey: "credit_pack" });
}

// checkout 返回后重新查询权威订单状态
const state = await client.app.commerce.getCheckoutState();
if (state.orderId) await client.app.commerce.getOrder(state.orderId);
```

关键规则：

- `purchase()` 重定向到 checkout；从用户的购买动作调用，绝不在初始化时调用。checkout 返回不是支付凭证 —— 重新查询 `getCheckoutState()` / `getOrder()`。
- Space 积分计量 Space 内 App 的动作；Cohub Balance 是独立的全局平台托管商品组件（`cohubBalanceUsd`，整数美元，不可变）。
- 商品价格不可变。变更价格的做法是新建版本化 product key（`image_credit_pack_050`），重绑 benefit，归档旧商品。
- 商业化与 Action 搭配：Action 由你出钱运行并报告访客权益；`consumeCredits` 回收成本。这是 owner 出钱生成的标准模式 —— 见
  [whale-shrine](https://github.com/talesofai/cohub/blob/main/cohub-apps/whale-shrine/README.md)。
- 配置在 CLI 侧：`cohub spaces commerce setup`、`benefits create`、`products create`。最小闭环见
  [示例 App 索引](https://github.com/talesofai/cohub/blob/main/cohub-apps/README.md)。

## 发布与验证

发布与管理见 [Apps](/zh/docs/create/apps)。开发期间唯一规则：运行时 API 只在**已发布**的 App 里可用 —— 对着真实运行时测试，改动后发布新版本。

## 陷阱清单

- [ ] 显式传了 `env: "dev"` / `"prod"` —— SDK 默认 prod。
- [ ] App scope 覆盖自己 Space 上的全部读取：`session.view`、`taskrun.view`、`file.view`；此外最小权限。
- [ ] `generation.create` 和 `user.*` 只能来自 viewer grant —— 运行时从手势请求，不在发布时配置。
- [ ] `accessMode` 与持有的 scope 匹配；省略即完全访问。
- [ ] `session.prompt.fullaccess` ⊅ `session.view`；`generation.create` ⊅ `taskrun.view`。成对申请。
- [ ] `auth.authorize()` 来自用户手势，带理由；可安全重复调用。
- [ ] 使用返回的 `target`，不是请求的；invocation context 是路由信息，不是授权。
- [ ] Broker 模式：先 `authorize()` 再调其他 API —— 弹窗 token 交换消耗 user-activation 预算。
- [ ] 发布前 Space 有 slug、owner 有 username。
- [ ] 模型 id 从 `models.listMultimodal()` 拉取，不硬编码。
- [ ] Surface handler 和 `consumeCredits` 幂等（稳定的 `operationId`）；服务端数据为权威，realtime 重连后重新同步。
- [ ] 编辑器通过 `window.setState()` 上报 `dirty`，并在 `onBeforeClose()` 中写完数据；关闭浏览器标签页后草稿也不能丢。
- [ ] 不把 token 或密钥放进 URL 或随包资产。

## 相关

- [Apps](/zh/docs/create/apps) —— 发布与管理
- [SDK](/zh/docs/developers/sdk) —— 客户端全貌
- [CLI](/zh/docs/developers/cli) —— 终端工作流
- [示例 App](https://github.com/talesofai/cohub/blob/main/cohub-apps/README.md) —— 按场景的可运行示例
