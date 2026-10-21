---
"@neta-art/cohub-cli": patch
---

The shared Codex app-server no longer holds a conversation after its Turn ends, so Codex Desktop can continue a conversation that Cohub ran or watched (immediately with Codex 0.164+, after Codex's idle timeout before that). A Cohub Turn on a conversation open in another app now says so instead of failing with a writer-lock error. 共享 Codex app-server 在 Turn 结束后不再占用会话，Codex 桌面端可以继续 Cohub 运行或观察过的会话（Codex 0.164+ 立即释放，更早版本在 Codex 空闲超时后释放）。会话在其他应用中打开时，Cohub Turn 会明确提示，而不是报写锁错误。
