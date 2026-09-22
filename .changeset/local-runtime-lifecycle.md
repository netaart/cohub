---
"@neta-art/cohub-cli": major
"@neta-art/cohub": minor
---

Local Runtime now supports supervised foreground/background execution, private local status/stop controls, persistent network recovery, redacted terminal warnings, and explicit Space reuse/new prompts. `-n` is now the boolean alias for `--new`; use `--name <name>` to name a new Space. Runtime status includes file-bridge availability and accepts an AbortSignal in the SDK.

Local Runtime 支持前后台监督运行、本地状态与停止控制、持续网络恢复、脱敏终端告警，以及明确的 Space 复用／创建交互。`-n` 改为 `--new` 的布尔简写，命名请使用 `--name <name>`。Runtime 状态新增文件桥接可用性，SDK 状态请求支持 AbortSignal。

Deploy the compatible Gateway/API before the CLI. Publish the updated sandboxd artifacts before updating the binary pin; older binaries use the compatibility readiness/restart path.

先部署兼容的 Gateway/API，再发布 CLI。更新 sandboxd 二进制固定版本前必须先发布对应产物；旧版二进制使用兼容的就绪检查及重启路径。
