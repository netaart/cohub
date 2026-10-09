---
"@neta-art/cohub": major
"@neta-art/cohub-cli": major
---

Board v3 replaces the v2 node, connection, composition and clip APIs with one document containing `board`, `items` and `animations`. The SDK's Board exports now expose the v3 model, layout and patch types instead of the old document, connection and mutation helpers. Migrate Board writes to `apply()` with JSON Merge Patch (`null` deletes; unmentioned fields stay), and author animations as property tracks with keyframes. The CLI replaces the old Board domain commands with `cohub boards get`, `apply`, `history`, `schema` and `preset`, plus timeline playback commands; existing Board scripts must be updated. The server migration archives each Board's complete v2 state in a migration transaction before converting it and dropping the old tables. That data migration does not preserve compatibility with v2 SDK calls or CLI scripts.

Board v3 将 v2 的 node、connection、composition 和 clip API 替换为包含 `board`、`items` 和 `animations` 的统一文档。SDK 的 Board 导出改为 v3 的 model、layout 和 patch 类型，不再提供旧的 document、connection 和 mutation 辅助接口。Board 写入请迁移到 `apply()`，使用 JSON Merge Patch（`null` 删除字段，未提及的字段保持不变）；动画改为使用带关键帧的属性轨道。CLI 用 `cohub boards get`、`apply`、`history`、`schema`、`preset` 和时间线播放命令替换旧的 Board 领域命令，既有 Board 脚本需要同步升级。服务端迁移会先将每个 Board 的完整 v2 状态归档到迁移事务，再转换数据并删除旧表；数据迁移不意味着兼容 v2 SDK 调用或 CLI 脚本。
