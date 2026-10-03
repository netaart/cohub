---
"@neta-art/cohub": minor
---

Add `spaces.getOwnedBySlug(slug)` to resolve a Space owned by the current account by its slug, backed by `GET /api/me/spaces/by-slug/:slug`. It returns the `SpaceRecord` and rejects with a 404 `HttpError` when no owned Space has that slug.

新增 `spaces.getOwnedBySlug(slug)`，按 slug 查询当前账号名下的 Space，对应接口为 `GET /api/me/spaces/by-slug/:slug`。查到时返回 `SpaceRecord`，查不到时抛出 404 `HttpError`。
