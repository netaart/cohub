---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Displays report who watches them: `DisplayInfo.viewers` lists each viewer's `userId` and whether they `control` the screen, live on the Runtime status and on an open `DisplayConnection`. Watching, stills and element trees now take `sandbox.view`; steering a screen, scripted input and virtual screens take `command.execute`, so builders and their agents can use them. `space.displays.connect(id, { control: false })` opens a watch-only view. A person's live input comes first: scripted input in flight is cancelled and new input waits two seconds, failing with `display_preempted`. `space.displays.tree(id, { actionable: true })` returns only the elements that take an action. The CLI adds `cohub spaces displays tree --actionable`, a Watching column in `ls`, and prints the display's web link after `start`.

Displays 会报告谁在查看：`DisplayInfo.viewers` 列出每位查看者的 `userId` 以及是否可以 `control` 这块屏幕，Runtime 状态和已打开的 `DisplayConnection` 都会实时更新。查看画面、截图和读取控件树改为需要 `sandbox.view`；操作屏幕、脚本输入和虚拟屏改为需要 `command.execute`，Builder 和他们的 Agent 也能使用。`space.displays.connect(id, { control: false })` 打开只读画面。人的实时操作优先：正在执行的脚本输入会被取消，之后两秒内的新输入以 `display_preempted` 失败。`space.displays.tree(id, { actionable: true })` 只返回可操作的控件。CLI 新增 `cohub spaces displays tree --actionable`，`ls` 增加「Watching」一列，`start` 后会输出这块屏幕的 Web 链接。
