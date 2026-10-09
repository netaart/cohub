---
"@neta-art/cohub-cli": minor
---

`cohub runtime up` offers screen sharing by default on macOS and Linux X11: press Enter to accept, `--no-display` opts out, and `--yes` authorizes it along with local execution and native sync. Headless and Wayland-only sessions skip the offer, and reusing a running Runtime keeps its current screen configuration unless you override it. The pinned sandboxd binary moves to `v2.61.1`.

The Board commands are refined for the v3 document model. `boards get` replaces `boards inspect`, `--only` now accepts `board` alongside `items` and `animations` and always keeps the version metadata, and `boards preset` emits bare `tracks` by default, wrapping them in an animation only when `--animation` is passed. `boards export` renames `--background` to `--paper`. The Board authoring guide moves to `skills/cohub-board/SKILL.md`, and the CLI README and developer docs are rewritten around the document-as-JSON model.

`cohub runtime up` 在 macOS 和 Linux X11 上默认提供屏幕共享：回车接受，`--no-display` 关闭，`--yes` 连同本地执行与原生同步一并授权。无桌面和仅 Wayland 的会话会跳过该询问；复用运行中的 Runtime 时，除非显式覆盖，否则保留当前屏幕配置。内置的 sandboxd 版本升级到 `v2.61.1`。

Board 命令围绕 v3 文档模型做了打磨。`boards inspect` 由 `boards get` 取代；`--only` 现支持 `board`，与 `items`、`animations` 并列，且始终保留版本元数据；`boards preset` 默认输出裸 `tracks`，仅在传入 `--animation` 时才包成动画。`boards export` 将 `--background` 重命名为 `--paper`。Board 编写指南迁移到 `skills/cohub-board/SKILL.md`，CLI README 与开发者文档围绕「文档即 JSON」的模型重写。
