---
"@neta-art/cohub": patch
---

`session.updated` now carries the complete current Session record. Each Session update, including the one sent after a Turn settles, includes `activeTurn` and `activeTurnSequence` alongside the activity fields, title and `stats`, and reaches the Space and the Session's audience. Lists therefore no longer keep a finished Turn shown as active or a stale latest message, and need no refetch to catch up. A Turn the Agent picks up is also announced as running, not left queued.

`session.updated` 现在携带完整的当前会话记录。每次会话更新（包括回合结束后发出的那一条）都会在活动字段、标题和 `stats` 之外附带 `activeTurn` 与 `activeTurnSequence`，并推送到 Space 和该会话的相关用户。列表因此不会再把已结束的回合显示为进行中，也不会停留在过期的最新消息上，无需重新拉取。Agent 开始执行的回合也会及时更新为运行中，不再停留在排队中。
