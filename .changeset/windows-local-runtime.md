---
"@neta-art/cohub-cli": minor
---

Support `cohub runtime up` on Windows. The CLI downloads the Windows `cohub-sandboxd.exe`, runs npm-installed Pi/Codex through their Node entry instead of `.cmd` shims, uses named pipes for the sandboxd control channel and the Pi extension, and refuses to start from an elevated terminal. `--display` shares the primary monitor by default, as on macOS. Git for Windows is required (or set `COHUB_BASH`). Codex's shared app-server is unavailable on Windows, so terminal Codex chats sync read-only there. Linux and macOS behavior is unchanged. Bilingual summary: 支持在 Windows 上运行 `cohub runtime up`：下载 Windows 版 `cohub-sandboxd.exe`，通过 Node 入口直接启动 npm 安装的 Pi/Codex（不再经过 `.cmd` shim），sandboxd 控制通道与 Pi 扩展改用 named pipe，并拒绝在管理员终端中启动；`--display` 与 macOS 一样默认共享主显示器。需要安装 Git for Windows（或设置 `COHUB_BASH`）。Windows 上无法连接 Codex 共享 app-server，终端 Codex 会话为只读同步。Linux 与 macOS 行为不变。
