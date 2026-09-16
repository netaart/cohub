---
title: App 开发
description: Cohub App 能力全景 — runtime 上下文、权限、prompt、生成、文件、实时、Surface 与商业化。
---

Cohub App 是运行在 Cohub runtime 中的已发布网页。在 App 代码里，你可以与
Agent 对话、生成媒体、读写 Space 文件、在多个 viewer 之间共享实时状态、向
Agent 暴露方法，以及销售商品。

本页是一张能力地图：每个场景能做什么、调用哪个 SDK 表面、需要什么授权。
完整运行时参考见
[App Runtime Guide](https://github.com/talesofai/cohub/blob/main/packages/sdk/docs/app-runtime-guide.md)。

## Runtime 一分钟

在 App 内，`createCohubClient()` 无需 token — 宿主提供短时鉴权。Runtime API
只在**已发布**的 App 中可用。

- **Bridge 模式** — App 运行在 Cohub iframe 中（默认）。
- **Broker 模式** — App 作为独立页面打开；SDK 回退到 popup broker。给
  `createCohubClient` 传入 `app: { brokerOrigin, appId }`（或 slug 三元组）即可启用。

```ts
import { createCohubClient } from "@neta-art/cohub";

const client = createCohubClient({ env: isDevApp ? "dev" : "prod" });
const ctx = await client.context();
if (!ctx?.app?.id) throw new Error("Not inside a published app");
```

浏览器中 `env` 很重要：dev 域名上的 App 必须显式传 `env: "dev"`，否则会静默
调用生产环境。

## 授权

新 App 使用 `client.auth.authorize({ target, scopes })`：`target` 可为账户、指定 Space 或选取 Space。成功结果包含实际目标、回退方式及服务端 grant；后续操作使用返回的 Space ID。默认保留不可访问 Space 的友好回退，`fallback: "none"` 可禁止回退。

未登录时先进入登录流程，再展示授权；整页跳转后需重新初始化 context。旧 `auth.request()`、`requestSpace()` 和 `requestCreateSpace()` 继续兼容。完整约定见 [授权规范](https://github.com/talesofai/cohub/blob/main/docs/app-authorization.md)。

## Context

```ts
const ctx = await client.context();

ctx.app.id;                        // App id
ctx.app.slug;                      // 公开 slug
ctx.app.homeSpace;                 // 拥有该 App 的 Space
ctx.viewer;                        // 当前 viewer，可能为 null
ctx.invocation;                    // App 从哪里被打开
ctx.shell;                         // 当前 Cohub workspace 位置
ctx.permissions;                   // appScopes + viewerGrants，用于渲染状态
```

`invocation` 在可用时携带 `surface`、`source`、`spaceId`、`sessionId`、
`turnId`、`toolCallId`。它描述的是打开来源 — 是上下文，不是授权。

`ctx.shell` 描述当前壳中的 `space`、`session` 和 `turn`。其中 `turn` 是当前
正在查看的 Turn，不一定是正在生成的 Turn。它们可能与 `app.homeSpace` 和
`invocation` 不同；没有对应位置时返回 `null`。workspace App 的
`shell.surface` 为 `"workspace"`；新对话背景为 `"background"`，
`shell.space` 是当前宿主 Space。

`client.app.onContextChanged(cb)` 会在壳位置、登录或授权变化时推送新 context。
高频读取时请在 App 内缓存最近一次 context，不要轮询 `client.context()`。
context 仅用于提供信息，不能作为授权依据。

## 能力场景

以下场景假设 `client` 已初始化、`spaceId` 已知（`ctx.shell.space.id`、
`ctx.app.homeSpace.id` 或 `ctx.invocation.spaceId`）。权限行给出最小授权；
app scopes 只覆盖 App 自己的 Space，其他 Space 需通过 `client.auth.request()`
获取 viewer grant。

### Agent 对话

向 Space Chat 发送 prompt，并流式读取回复。

```ts
// session.prompt.fullaccess + session.view
const result = await space.prompt({
  accessMode: "full_access",
  content: [{ type: "text", text: "Describe a shiba inu on Mars." }],
  sessionId: null, // null 创建 session；传入 id 则继续对话
});

const stop = space.session(result.session.id).subscribeGeneration({
  state: (e) => renderPartial(e.state),
  finalized: (e) => render(e.turn.assistantText),
  error: (e) => showError(e),
});
```

要点：

- `space.prompt()` 立即返回一个 turn，回复通过 `subscribeGeneration` 流式
  到达（或轮询 `turns.get()`）。
- `accessMode` 必须与持有的 scope 匹配：`full_access` 需要
  `session.prompt.fullaccess`，`read_only` 需要 `session.prompt.readonly`。
  这是目前最常见的 403 原因。

### LLM completion（只读）

一次性补全，不落 session、不存 turn — 适合内联建议、摘要、分类。

```ts
// session.prompt.readonly + session.view
const result = await space.prompt({
  accessMode: "read_only", // 必须显式传入；省略 → full_access → 403
  sessionId: null, // 只读 prompt 使用临时 session
  content: [{ type: "text", text: prompt }],
});
```

### Generation（图片 / 视频 / 音频）

创建多模态生成任务并等待输出。

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

const imageUrl = result.output?.find((b) => b.type === "image")?.source?.url;
```

要点：

- `generation.create` 只能来自 **viewer grant**，必须在用户手势中请求：

  ```ts
  await client.auth.request({
    scopes: ["generation.create"],
    reason: "Generate images in this app",
  });
  ```

- 读取结果需要 `taskrun.view`。只有 `generation.create` 而没有
  `taskrun.view`，就是经典的「任务创建成功但永远等不到结果」。

### Space 文件

读取文件树与文件内容，并把结果写回。

```ts
const space = client.space(spaceId);

// file.view
const tree = await space.files.tree();
const file = await space.files.read("data.json");

// file.edit
await space.files.write("output/result.json", JSON.stringify(data));
```

### Sandbox 命令

在 Space sandbox 中执行 shell 命令。

```ts
// command.execute
const run = await space.runCommand({ command: ["node", "scripts/build.mjs"] });
```

### Session 实时事件

Agent 工作时订阅 Chat 事件。

```ts
// session.view
const stop = session.subscribe({
  progress: (e) => renderProgress(e.payload),
  finalized: (e) => render(e.payload),
});
```

### Realtime 房间

同一 App 的多个 viewer 之间的多人状态、presence 与通用 JSON 事件。运行时
原生提供 — 无需 scope 或授权弹窗。

```ts
const room = await client.app.realtime.createRoom({ code: "TEAM-ALPHA" });

const stop = room.subscribe("shared.state.updated", ({ data }) => {
  render(data);
});

await room.publish("shared.state.updated", { value: 42 });
```

要点：

- 事件在连接期间有序，但**不会重放**。重连后应重新拉取权威状态。
- 高频数据用 `room.send()`，有意义的更新用 `publish()`。

### 向 Agent 暴露方法（App Surface）

注册具名方法，Cohub 宿主 — 包括通过
`cohub desktop open <app> --call <method>` 调用的 Agent — 可以调用运行中的 App。

```ts
client.app.surface.handle("image.open", async (input, { commandId }) => {
  const result = await openImageStudio(input);
  await client.ui.reportResult(commandId, {
    status: "applied",
    result,
    error: null,
  });
});
```

要点：

- 只有注册过的方法可达。不提供 DOM 访问，也不执行脚本。
- 调用语义是 at-least-once，处理函数应可安全重复执行。
- Surface 响应只确认送达；最终结果通过 `client.ui.reportResult()` 上报。

### Composer 上下文

App 激活期间，向 Cohub composer 附加一个紧凑的上下文 chip。

```ts
client.app.composer.setChip({
  key: "selection",
  label: "3 selected",
  content: "Selected records:\n- customer_123\n- customer_456",
});

client.app.composer.clearChip("selection");
```

### 商业化

销售一次性商品并消耗积分，绑定 App 的 runtime 身份。需要 Space 启用
commerce。

```ts
const { entitlements, credits } = await client.app.commerce.getEntitlements();

// 功能解锁
const unlocked = entitlements.some((e) => e.benefitKey === "pro" && e.enabled);
if (!unlocked) await client.app.commerce.purchase({ productKey: "pro_unlock" });

// 按量动作
const result = await client.app.commerce.consumeCredits({
  amount: 10,
  operationId: crypto.randomUUID(), // 每个逻辑动作一个稳定 id
  reason: "Export high-resolution image",
});
if (result.status === "insufficient") {
  await client.app.commerce.purchase({ productKey: "credit_pack" });
}

// checkout 返回后，重新查询权威订单状态
const state = await client.app.commerce.getCheckoutState();
if (state.orderId) {
  const { order } = await client.app.commerce.getOrder(state.orderId);
}
```

要点：

- 每个逻辑动作使用稳定、唯一的 `operationId`，重试保持幂等。
- checkout 返回不等于支付成功。跳转回来后应重新查询
  `getCheckoutState()` / `getOrder()`。
- 商品配置见
  [App Commerce Guide](https://github.com/talesofai/cohub/blob/main/docs/app-commerce-guide.md)。

### Models

列出模型无需 scope，仅需鉴权。

```ts
const models = await client.models.list();
const multimodal = await client.models.listMultimodal();
```

### 账户级数据

超出 App 自己 Space 的范围时，viewer grant 可以解锁 viewer 的账户数据。

```ts
// user.space.list
await client.auth.request({ scopes: ["user.space.list"], reason: "Show your spaces" });
const { spaces } = await client.spaces.list();

// user.session.list
const { sessions } = await client.user.listSessions({ limit: 20 });

// user.usage.read
const activity = await client.user.getActivity({ days: 30 });
```

### 为访客创建 Space

一次同意会以访客身份新建 Space，并在这个新 Space 上授予所请求的 scopes。
`space` 与 `client.spaces.create()` 的 `CreateSpaceInput` 相同。不会静默复用
——每次确认都新建。宿主用访客的账号 token 调用创建接口。持有 `space.create`
viewer grant 的 App 也可以直接调用 `client.spaces.create()`。

```ts
const { granted, space } = await client.auth.requestCreateSpace({
  scopes: ["file.view", "session.view", "session.prompt.fullaccess"],
  space: {
    name: "Whale Shrine",
    bootstrapSource: { type: "checkpoint", checkpointId },
  },
  reason: "Create a workspace from this template.",
});
if (granted && space) {
  const created = client.space(space.id);
}
```

从 checkpoint 创建仍走源 Space 的 `checkpoint.view`。模板 Space 对登录用户开放 guest 即可被克隆。

## 权限一页纸

App 的授权是两个来源的并集 — 任一满足即可：

| 来源 | 由谁授予 | 覆盖范围 | 有效期 |
| --- | --- | --- | --- |
| **App scopes** | 发布者在发布时授予 | 仅 App 自己的 Space；八个有界 scope | 发布期间有效 |
| **Viewer grants** | viewer 通过授权对话框授予 | viewer 自身持有的任意权限，作用于其选择的 Space | 14 天，可撤销 |

黄金法则：

```text
读 App 自己的 Space → app scopes
写操作、其他 Space、generation、账户数据 → viewer grants
```

在用户手势（按钮点击）中调用 `auth.request`，写清楚 reason；已授权时静默
复用 — 只有需要新权限时才会弹窗。

## 发布与验证

发布目标、版本与管理细节见 [Apps](/zh/docs/create/apps)。

开发期只有一条关键规则：runtime API（`context()`、`auth.request`、realtime、
commerce）只在**已发布**的 App 中可用。本地 `file://` 页面和裸静态 URL 无法
验证它们 — 发布后在真实 runtime 中测试，改动后通过
`cohub apps publish-version` 发布新版本。

## Best practices

- 最小权限：只申请能工作的最小 scope 集合
- 在用户手势中调用 `auth.request`，并写清理由
- 把 invocation 当作路由信息，而不是授权
- 服务端数据是权威；realtime 只是传输层，重连后重新同步
- Surface 处理函数与积分消耗保持幂等
- 永远不要把 token 或密钥放进 URL 或随包资源

## 相关

- [Apps](/zh/docs/create/apps) — 发布与管理
- [SDK](/zh/docs/developers/sdk) — 完整 client 表面
- [CLI](/zh/docs/developers/cli) — 终端工作流
