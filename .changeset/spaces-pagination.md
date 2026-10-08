---
"@neta-art/cohub": major
"@neta-art/cohub-cli": patch
---

`spaces.list()` now returns a paginated page. `GET /api/spaces` with query parameters returns `{ items, pageInfo }`, and `spaces.list()` accepts `{ limit, cursor, filter, query, name, recentSpaces }` with `filter` one of `recent`, `all`, `mine`, `pinned`, or `archived`; it always sends `filter`, defaulting to `recent`. The previous `list(fetch)` call shape still works, but the resolved value is now `SpaceListPage`, so callers that expected `SpaceRecord[]` must read `page.items`. Listing a very large account no longer ships every Space in one response. For clients built before pagination, a bare `GET /api/spaces` with no query parameters still returns an array, now capped at the 100 most recently active Spaces, archived ones included, latest activity first, and marked with a `Deprecation` header; it will be removed in a later release.

`spaces.list()` 现在返回分页结果。带查询参数的 `GET /api/spaces` 返回 `{ items, pageInfo }`；`spaces.list()` 接受 `{ limit, cursor, filter, query, name, recentSpaces }`，`filter` 可取 `recent`、`all`、`mine`、`pinned`、`archived`，并且总会带上 `filter`，默认 `recent`。旧的 `list(fetch)` 调用形式仍可用，但返回值变为 `SpaceListPage`，原先期望 `SpaceRecord[]` 的调用方需要读取 `page.items`。Space 数量很大的账号不再在一次响应里返回全部数据。为兼容分页之前的客户端，不带任何查询参数的 `GET /api/spaces` 仍返回数组：最多包含最近活跃的 100 个 Space（含已归档），按最近活动排序，并带有 `Deprecation` 响应头，后续版本会移除。
