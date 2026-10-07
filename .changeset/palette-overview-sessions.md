---
"@neta-art/cohub": major
---

Remove `PaletteOverviewResponse.recentSessions`, the `PaletteOverviewSession` type, and the `sessionLimit` option of `search.overview()`. The overview only carries recent Spaces now; use `user.listSessions()` for the viewer's recent Sessions.

移除 `PaletteOverviewResponse.recentSessions`、`PaletteOverviewSession` 类型和 `search.overview()` 的 `sessionLimit` 参数。概览现在只返回最近的 Space；获取用户最近的 Session 请改用 `user.listSessions()`。
