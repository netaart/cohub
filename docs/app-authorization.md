# App authorization / App 授权

## Contract / 契约

New Apps use `client.auth.authorize()`. Existing `auth.request()`, `requestSpace()` and `requestCreateSpace()` remain supported with their original return shapes. No database migration is required.

新 App 使用 `client.auth.authorize()`；旧 `auth.request()`、`requestSpace()` 和 `requestCreateSpace()` 继续兼容原返回类型。本次不需要数据库迁移。

```ts
const context = await client.context();
const result = await client.auth.authorize({
  target: { kind: "space", spaceId },
  scopes: ["file.view"],
  fallback: "allow", // default
});
if (result.status === "granted" && result.target.kind === "space") {
  const authorizedSpace = client.space(result.target.spaceId);
}
```

- Targets: `{ kind: "account" }`, `{ kind: "space", spaceId }`, or `{ kind: "pick-space" }`. Account targets accept only account-level scopes. Context identifiers are not authorization.
- 目标为账户、指定 Space 或选取 Space。账户目标只接受账户级权限；上下文中的 ID 不代表授权。
- Success returns `requestedTarget`, the actual `target`, `resolution` (`requested`, `selected`, `fallback`), and the server's `grant` (`id`, `spaceId`, `scopes`, `expiresAt`). The grant's `spaceId` remains a storage association for account grants, not a Space permission.
- 成功返回请求目标、实际目标、解析方式和服务端 grant。账户授权中 grant 的 Space ID 仅是当前存储关联，不意味着拥有该 Space 的权限。
- An unavailable requested Space may fall back to a viewer-controlled Space shown in the consent dialog. `fallback: "none"` disables this. Always use the returned target for subsequent operations; API requests are never silently redirected to another Space.
- 不可访问的指定 Space 可以回退到授权对话框展示的用户可用 Space；`fallback: "none"` 禁止回退。后续操作使用返回的实际目标，业务 API 不会暗中替换 Space。
- Cancellation returns `{ status: "cancelled" }`; a terminal permission refusal returns `{ status: "denied", code }`. Transport/protocol failures throw `AppRuntimeError` with `code` and an optional `requestId`. Older hosts return `unsupported` through capability negotiation; the SDK never fabricates a grant from a legacy boolean.
- 取消返回 `cancelled`，明确的权限拒绝返回 `denied` 和原因码；传输或协议失败抛出带 `code` 和可选 `requestId` 的 `AppRuntimeError`。旧 Host 不支持新契约时明确报错，不根据旧 bool 伪造授权信息。

## Login / 登录

Call interactive authorization from a user action. The Host resolves the viewer before loading Spaces. A logged-out viewer starts login, not an empty Space picker or an error. The complete local return path includes query and hash and is sanitized by the existing auth helper.

从用户操作触发交互式授权。Host 在加载 Space 前确认登录状态；未登录进入登录，不展示空列表或授权错误。回跳保留 query 和 hash，并复用已有安全路径校验。

A short-lived, per-App, tab-local intent can restore consent after full-page login when the App asks for context. It stores no tokens or bootstrap credentials. A full-page redirect destroys the original Promise: reload the App context and request again to consume the resulting grant. Create-Space flows require a fresh action after login and are not automatically replayed.

整页登录后，App 读取 context 时可以恢复短期、按 App 和标签页隔离的授权意图。记录不包含 token 或初始化凭据。页面跳转会销毁原 Promise，App 需重新读取上下文并请求授权以复用结果。创建 Space 需要登录后重新操作，不会自动重放。

The broker starts login automatically once per attempt, retains an explicit sign-in action if recovery fails, and gives login a separate bounded wait. Passive session-token requests never initiate a login redirect. Initialize context before using APIs so the SDK discovers server-resolved grants and refreshes tokens without requesting consent; older hosts retain the legacy renewal adapter.

Broker 每次尝试自动登录一次，恢复失败仍保留登录按钮，并为登录单独设置有限等待时间。被动 token 请求不启动登录跳转。调用 API 前初始化 context，使 SDK 识别服务端授权能力，刷新 token 不再触发授权；旧 Host 保留兼容续期逻辑。

Broker tokens are reused in memory within the same SDK instance after authorization or a token exchange. They are never restored from or written to localStorage. A reload or a new client instance requires a new broker exchange; an explicit refresh may open a popup and must account for browser popup restrictions. The one-shot broker does not observe account switches in another Cohub tab: the current App session remains bound to its authorized identity until a new exchange, expiry or server-side revocation. This is not cross-tab login synchronization.

Broker 授权或 token 交换成功后，在同一个 SDK 实例内复用内存 token，不从 localStorage 恢复，也不写入。刷新页面或创建新客户端需要重新交换；强制刷新可能打开弹窗，需考虑浏览器限制。一次性 Broker 无法感知另一个 Cohub 标签页中的账号切换：当前 App 会话在重新交换、过期或服务端撤权前仍绑定原授权身份。这不代表已实现跨标签页登录同步。

## Incremental consent / 增量授权

Structured consent sends `scopeMode: "extend"` to the existing authorize endpoint. It preserves scopes only from an active, unrevoked grant under a database row lock. Expired or revoked scopes are never revived. REST callers and the CLI may opt in with `scopeMode: "extend"` / `cohub apps authorize --extend`. Omission retains replacement semantics. Existing grant expiry behavior is unchanged.

新授权使用 `scopeMode: "extend"`，在数据库行锁内仅保留仍有效且未撤销的权限，不复活过期或已撤销的权限。REST / CLI 可通过同名参数或 `--extend` 启用；省略时继续保持旧替换语义。现有有效期策略不变。

## Compatibility / 兼容

`allowedViewerScopes` is deprecated but readable/writable for compatibility; it does not restrict viewer consent. Legacy Work routes, message names, SDK aliases, public URLs, and historical artifact formats are retained. Ship the updated API and Web Host before migrating standalone Apps to structured authorization.

`allowedViewerScopes` 标记废弃但保留读写兼容，不参与访客授权限制。旧 Work 路由、消息名、SDK 别名、公共链接及历史文件格式全部保留。先上线 API 和 Web Host，再迁移独立 App。

Creation, bootstrap and authorization are not one database transaction. If a Space was created but authorization later failed or was cancelled, the legacy create result retains its Space ID. Never delete that Space automatically or retry creation blindly.

创建、初始化与授权不是一个数据库事务。Space 已创建但授权失败或取消时，旧创建接口仍保留 Space ID。不得自动删除该 Space，也不得盲目重新创建。
