---
"@neta-art/cohub-cli": patch
---

Local Runtime reconnects immediately after a dropped WebSocket instead of staying offline until in-flight Turns finish; detached Turns keep running and replay their result on the new connection. Native sync no longer re-reads or resends a transcript that hit a size limit until the file changes. Connection diagnostics record close and handshake context and the identity of oversized frames. 本地 Runtime 在 WebSocket 断开后立即重连，不再等进行中的 Turn 结束才恢复在线；断开期间的 Turn 继续执行，并在新连接上回放结果。原生同步遇到超出大小限制的会话时，在文件变化前不再反复读取和重发。连接诊断新增关闭/握手上下文与超限帧标识。
