---
"@neta-art/cohub": minor
---

Space listings are now fast however many Spaces or turns an account has. `recent` is a bounded shortlist (up to 50, no further pages) ranked by the viewer's own latest moment in each Space: the newest message in a session they created or joined, a device visit, or creating or joining the Space. Every other filter pages through all of the viewer's Spaces, newest membership first, so pages never shift while you scroll. Listings include only Spaces the viewer is a member of, and each item carries the new `joinedAt`. `search.overview()` accepts `recentSpaces` with visit times; `recentSpaceIds` is deprecated.

Space 列表现在无论账号有多少 Space 或对话都很快。`recent` 改为有上限的短列表（最多 50 个，不再翻页），按用户自己在每个 Space 里最近一次的动作排序：自己创建或参与的 session 的最新消息、本设备的访问，或创建、加入这个 Space。其余筛选按加入时间从新到旧翻页列出用户的全部 Space，滚动时顺序不会变化。列表只包含用户是成员的 Space，每一项新增 `joinedAt` 字段。`search.overview()` 支持带访问时间的 `recentSpaces`，`recentSpaceIds` 已弃用。
