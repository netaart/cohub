---
"@neta-art/cohub": major
"@neta-art/cohub-cli": patch
---

`spaces.list()` now returns a paginated page. `GET /api/spaces` returns `{ items, pageInfo }` instead of a bare array, and `spaces.list()` accepts `{ limit, cursor, filter, query, name, recentSpaces }` with `filter` one of `recent`, `all`, `mine`, `pinned`, or `archived`. The previous `list(fetch)` call shape still works, but the resolved value is now `SpaceListPage`, so callers that expected `SpaceRecord[]` must read `page.items`. Listing a very large account no longer ships every Space in one response.

`spaces.list()` 现在返回分页结果。`GET /api/spaces` 返回 `{ items, pageInfo }`，不再是数组；`spaces.list()` 接受 `{ limit, cursor, filter, query, name, recentSpaces }`，`filter` 可取 `recent`、`all`、`mine`、`pinned`、`archived`。旧的 `list(fetch)` 调用形式仍可用，但返回值变为 `SpaceListPage`，原先期望 `SpaceRecord[]` 的调用方需要读取 `page.items`。Space 数量很大的账号不再在一次响应里返回全部数据。
