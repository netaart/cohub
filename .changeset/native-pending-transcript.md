---
"@neta-art/cohub-cli": patch
---

Stop warning about `Cohub sync pending: ENOENT … realpath` before a native transcript exists. Pi and Codex create their session files lazily, so a capture request for a not-yet-written transcript (or for a workspace that was removed) is now treated as nothing-to-capture instead of a sync failure, and the daemon reports it as a skip rather than an error. Runtime import records that race as skipped instead of failed. Remove the fixed-interval native sync scans: Pi now relies on lifecycle events, while Runtime reconciliation is event-driven with bounded retries after failures or reconnects. Bilingual summary: 修复原生会话文件尚未写入时误报 `Cohub sync pending: ENOENT … realpath` 的问题——Pi 与 Codex 都是延迟创建会话文件，因此对尚未生成的 transcript（或已被删除的工作区）的采集请求现在视为「暂无可同步内容」而非同步失败，daemon 也会以 skip 而非 error 返回；Runtime import 遇到该竞态时会记录为 skipped 而不是 failed。同时移除固定间隔的 native sync 扫描：Pi 改用生命周期事件触发，Runtime reconciliation 改为事件驱动，仅在失败或重连后进行有上限的重试。
