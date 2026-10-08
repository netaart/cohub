---
"@neta-art/cohub": minor
---

`SessionRecord` adds `lastTurnIssue`: when a Session's latest settled Turn failed or was interrupted and no Turn is active, it carries `turnId`, `sequence`, `status` (`failed | interrupted`), `reason` (e.g. `abort`) and `errorMessage` (up to 240 characters); otherwise it is `null`. Session lists, Session reads and `session.updated` snapshots include it.

`SessionRecord` 新增 `lastTurnIssue`：Session 最近一次结束的回合失败或被中断、且当前没有进行中的回合时，包含 `turnId`、`sequence`、`status`（`failed | interrupted`）、`reason`（如 `abort`）和 `errorMessage`（最多 240 个字符），否则为 `null`。Session 列表、Session 详情和 `session.updated` 快照都会带上该字段。
