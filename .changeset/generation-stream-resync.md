---
"@neta-art/cohub": patch
---

Generation streams no longer stall on out-of-order realtime events. A round committed after the next one has started, or a finalize from an earlier Turn, only joins history instead of ending the Turn streaming now. When a patch no longer applies, the subscription buffers live events and reseeds from the stream snapshot once per message, reporting `out_of_sync` only if that resync cannot recover.

生成流不再因为实时事件乱序而卡住。上一轮的提交晚于下一轮、或较早 Turn 的 finalize 晚到时，只会归入历史，不再结束当前正在输出的 Turn。补丁无法应用时，订阅会缓存实时事件并按消息从流快照重新同步一次，只有重新同步也无法恢复才上报 `out_of_sync`。
