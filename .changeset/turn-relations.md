---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Turns record which Turn prompted them, and callers record whom they prompted. A Turn created by a prompt from another Turn — including across Spaces, and including scheduled prompts, background task notifications, and hooks — keeps its immediate caller in `meta.origin`; read it with `readSessionTurnOrigin(meta)` (`SessionTurnOrigin`: `kind`, `spaceId`, `sessionId`, `turnId`, optional `toolCallId` and `depth`). A caller Turn lists the Turns it prompted in `meta.messagesSent`, read with `readSentTurns(meta)`; each `SentTurnRef` carries the child's `spaceId`, `sessionId`, `turnId`, and the `toolCallId` that sent it, and the caller's watchers receive a `session.turn.updated` as each child is created. `cohub references query turn:<id> --kinds turn_trigger` follows these edges in either direction, and `cohub spaces sessions turns get` prints the Turn's origin and the Turns it sent.

Turn 现在会记录是哪个 Turn 触发了自己，发起方也会记录自己触发了谁。由其他 Turn 发起的 Turn（包括跨 Space 的调用，以及定时任务、后台任务通知和 hook）会在 `meta.origin` 中保存直接发起方，可用 `readSessionTurnOrigin(meta)` 读取（`SessionTurnOrigin`：`kind`、`spaceId`、`sessionId`、`turnId`，以及可选的 `toolCallId` 和 `depth`）。发起方 Turn 在 `meta.messagesSent` 中列出它触发的 Turn，可用 `readSentTurns(meta)` 读取；每条 `SentTurnRef` 带有被触发方的 `spaceId`、`sessionId`、`turnId`，以及发出它的 `toolCallId`。每创建一个被触发的 Turn，正在查看发起方的客户端都会收到 `session.turn.updated`。`cohub references query turn:<id> --kinds turn_trigger` 可双向查询这些关系，`cohub spaces sessions turns get` 会输出 Turn 的发起方和它触发的 Turn。
