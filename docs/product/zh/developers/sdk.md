---
title: SDK
description: 使用 Cohub TypeScript SDK 处理 Spaces、Chats、Apps、实时更新与 App runtime API。
---

Cohub SDK 是面向产品 API 与实时协作的 TypeScript 客户端。

包名：`@neta-art/cohub`

## 安装

```bash
npm install @neta-art/cohub
```

## 创建 client

```ts
import { createCohubClient } from "@neta-art/cohub";

const client = createCohubClient({
  getAccessToken: async () => localStorage.getItem("token"),
});
```

默认端点：

| Env | API | WebSocket |
| --- | --- | --- |
| production | `https://api.cohub.live` | `wss://gateway.cohub.live/ws` |
| development | `https://api-dev.cohub.live` | `wss://gateway-dev.cohub.live/ws` |

选择 development：

```ts
const client = createCohubClient({
  env: "dev",
  getAccessToken: async () => token,
});
```

或在 Node.js 中设置 `ENV=dev`。

自托管或代理时也支持自定义端点。

## Spaces 与 Chats

```ts
const created = await client.spaces.create({ name: "Demo" });
const space = client.space(created.space.id);

const sessionResult = await space.sessions.create({ title: "Planning" });
const session = space.session(sessionResult.session.id);

await session.messages.send({
  content: [{ type: "text", text: "Help me plan the next steps" }],
});
```

产品映射：

- Space → `client.spaces` / `client.space(id)`
- Chat → Space 下的 session API
- Save → Space 下的 checkpoint API
- App → `client.apps`

## Session 实时更新

在 Agent 工作时订阅 session 事件：

```ts
const stop = session.subscribe({
  progress(event) {
    console.log("progress", event.payload);
  },
  finalized(event) {
    console.log("done", event.payload);
  },
});

stop();
```

## Apps

通过 `client.apps` 创建与管理 Apps，包括发布、更新、版本，以及按 slug 查找。

普通服务端 / 自动化代码使用常规用户鉴权。**已发布 App 内部**的代码使用下面的 App runtime API。

## App runtime

已发布 Apps 可使用 Cohub shell 提供的短时 runtime 鉴权运行。

```ts
const client = createCohubClient(); // token 来自 App runtime

const context = await client.context();
// App 身份、Space 身份、viewer 状态

await client.auth.authorize({
  target: { kind: "space", spaceId },
  scopes: ["session.prompt.readonly"],
  reason: "Continue the demo chat",
});
```

重要：

- Runtime API 在已发布 App 内工作
- 它们不会在任意静态托管或本地直接打开文件时工作
- App scopes 与按 Space 的访客授权（viewer grants）会被强制执行

启用 commerce 且 App 已发布时，commerce helpers 在 `client.app.commerce.*`。

### Realtime rooms

在已发布 App 内，`client.app.realtime` 提供临时房间，用于多人状态、
presence 与通用 JSON 事件。它使用 App runtime 身份，无需额外 scope 或
授权弹窗。

```ts
const room = await client.app.realtime.createRoom({
  code: "TEAM-ALPHA", // 可选
  expiresInSeconds: 2 * 60 * 60,
});

const stop = room.subscribe("shared.state.updated", ({ data }) => {
  console.log(data);
});

await room.publish("shared.state.updated", { value: 42 });
stop();
await room.leave();
```

事件在连接期间保持有序，但不会重放。高频数据使用 `room.send()`，重连后
应重新同步权威状态。Realtime rooms 仅适用于 App runtime；普通服务端鉴权
与 CLI 无法创建或加入房间。

生命周期、presence、成员、席位与限制详见
[App Runtime Guide](https://github.com/talesofai/cohub/blob/main/packages/sdk/docs/app-runtime-guide.md#realtime-rooms-apprealtime)。

### 可调用方法

App 可以向嵌入它的 Cohub 宿主暴露具名方法，Agent 便能通过
`cohub desktop open <app> --call <method>` 调用正在运行的 App。

```ts
client.app.surface.handle("image.open", async (input, { commandId }) => {
  openImageStudio(input, commandId);
});

await client.ui.reportResult(commandId, {
  status: "applied",
  result: selectedImage,
  error: null,
});
```

只有注册过的方法可以被调用。不提供 DOM 访问，也不提供脚本执行。Surface 响应只确认指令已送达；
App 通过同一个 UI command 调用 `client.ui.reportResult()` 上报最终结果。

调用语义是 at-least-once，因此建议让可调用方法可重复执行。

由于已发布的 App 可以被任意站点嵌入，调用只接受来自明确列出的 Cohub 应用 origin（或 App
自身 origin）的请求，回复也只发往该 origin，不做广播。被其他站点嵌入时，App 仍会注册方法，
但不会作出任何响应。该列表刻意不采用 `*.cohub.live` 后缀匹配——App 本身就托管在 Cohub 子域
上。自建部署与本地开发需显式放开：

```ts
client.app.surface.allowHostOrigins(["https://cohub.internal"]);
```

## 主要 client 表面

Client 按产品区域分组：

| 区域 | Client 表面 |
| --- | --- |
| Spaces / sessions / files | `client.spaces`、`client.space(id)` |
| Apps | `client.apps` |
| Generations | `client.generations` |
| Models | `client.models` |
| Search | `client.search` |
| Tasks / cron | `client.tasks`、`client.cronJobs` |
| Channels | `client.channels` |
| Billing / commerce | `client.billing`、`client.appCommerce` |
| App runtime | `client.context()`、`client.auth`、`client.app` |
| Cohub 界面命令 | `client.ui` |

只使用你需要的表面。从 Spaces、sessions 和 Apps 开始。

## 鉴权模型

在 App runtime 之外：

- 提供 `getAccessToken`
- 若自行集成登录，可选用 token storage helpers

在 App runtime 之内：

- host 可提供短时 tokens
- 仅在需要时请求额外的访客授权（viewer grants）

任何在他人浏览器中运行的 App，都优先最小权限。

## 实用建议

- 每个 app shell 复用一个 client 实例
- 优先使用 Space-scoped helpers（`client.space(id)`）提升可读性
- 流式 UX 用 realtime 订阅，而不是紧密轮询
- UI 文案保持产品术语一致：Chat / Save，而不是 session / checkpoint

## 相关

- [App 开发](/zh/docs/developers/apps) — 运行时能力与权限
- [CLI](/zh/docs/developers/cli)
- [Apps](/zh/docs/create/apps)
- [核心概念](/zh/docs/learn/core-concepts)
