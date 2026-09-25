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

已发布的 App 由 Cohub shell 提供短期运行时鉴权 —— App 代码里无需 API key。`client.context()`、`client.auth.authorize()`、realtime 房间、可调用 surface、composer 上下文、商业化和 App Actions 都只在运行时可用。

完整模型 —— 权限、API → scope 对照表、能力配方与陷阱 —— 见 [App 开发](/zh/docs/developers/apps)。

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
| Cohub 界面命令 | `client.desktop` |

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
