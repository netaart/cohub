---
"@neta-art/cohub": minor
---

`user.listSessions()` accepts `includeForks`. `GET /api/me/sessions?includeForks=1` returns `forks` for the page sessions, so cross-space chat lists can render the same fork tree as a Space sidebar. Parents the viewer cannot see are redacted to `null`. The shared fork edge type is exported as `SessionListFork`.

`user.listSessions()` 新增 `includeForks` 参数。`GET /api/me/sessions?includeForks=1` 会返回当前页会话的 `forks`，跨 Space 的会话列表因此可以渲染与 Space 侧栏一致的 fork 树。查看者无权访问的父会话会被置为 `null`。共享的 fork 边类型导出为 `SessionListFork`。
