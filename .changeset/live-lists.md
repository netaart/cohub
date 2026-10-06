---
"@neta-art/cohub": minor
---

Account-wide realtime is enough to keep Chat and Space lists current. `session.created` and `session.updated` now also reach the user room of every creator and participant who still belongs to the Space, and their session records carry `participantUserUuids`. `spaces.list()` items include `personalActivityAt`, the viewer's own latest activity that the list sorts by first. `client.connectionState` reports the current realtime transport state, so callers can tell when a reconnect may have missed events.

账号级实时事件现在足以让 Chat 和 Space 列表保持最新。`session.created` 和 `session.updated` 也会发送到仍在该 Space 内的创建者与参与者的用户房间，session 记录附带 `participantUserUuids`。`spaces.list()` 的条目新增 `personalActivityAt`，即查看者自己的最近活动时间，列表首先按它排序。新增 `client.connectionState` 返回当前实时连接状态，调用方可据此判断重连期间是否可能漏掉事件。
