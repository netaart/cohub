---
"@neta-art/cohub": patch
---

Surface methods, composer chips, and the runtime handshake an App announces during startup no longer get lost. The host clears what a document announced when its frame loads, which can come after the App's scripts ran, so it now asks the App to announce again; the SDK repeats its runtime `ready`, surface methods, composer chip, reported window state, and drop types. This also covers pages an App navigates to inside its frame.

App 启动时宣告的 surface 方法、composer chip 和运行时握手不会再丢失。host 会在 frame 加载完成时清掉页面宣告过的状态，而这可能晚于 App 脚本的执行，所以 host 现在会请 App 再宣告一次；SDK 会重新发送运行时 `ready`、surface 方法、composer chip、已上报的窗口状态和可接受的拖放类型。App 在 frame 内跳转到其他页面时同样生效。
