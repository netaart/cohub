---
"@neta-art/cohub": major
"@neta-art/cohub-cli": minor
---

Search merges sessions and turns into chats. `GlobalSearchType` is now `chat | space | label`: a `chat` result is one session, titled like the chat lists, with `titleHighlights`, its best-matching user message as `hit` (`turnId`, `sequence`, `excerpt`, `highlights`), and `matchCount` for the title plus every matching message. `turnId`, `sequence`, and `sessionTitle` are gone from results, and `search.query()` drops `groupTurns`. Chats are searched in Spaces the viewer owns or belongs to plus chats they created or joined elsewhere; pass `spaceId` to search every chat they may view in one Space. Queries shorter than three characters match chat titles unless scoped to a Space. `cohub search --types` accepts `chat,space,label`, and chat rows show the matching message.

搜索把 session 和回合合并为对话。`GlobalSearchType` 改为 `chat | space | label`：一条 `chat` 结果对应一个 session，标题与对话列表一致，附带 `titleHighlights`、命中度最高的用户消息 `hit`（`turnId`、`sequence`、`excerpt`、`highlights`），以及包含标题在内的匹配数 `matchCount`。结果中移除了 `turnId`、`sequence` 和 `sessionTitle`，`search.query()` 不再支持 `groupTurns`。对话默认在用户拥有或所属的 Space 中搜索，并包含用户在其他 Space 创建或参与的对话；传入 `spaceId` 可搜索该 Space 中用户有权查看的全部对话。少于三个字符的查询只匹配对话标题，指定 Space 时除外。`cohub search --types` 接受 `chat,space,label`，对话行显示命中的消息。
