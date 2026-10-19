---
"@neta-art/cohub-cli": minor
"@neta-art/cohub": minor
---

Local Runtime harnesses are self-contained adapters driven by one protocol registry (`LOCAL_HARNESSES` / `LOCAL_HARNESS_SPECS`), and `cohub runtime up` adds Claude Code (`--harness claude`) and WorkBuddy (`--harness workbuddy`, via the `codebuddy` CLI). Both run Cohub Turns over stream-json, carry Cohub history in their native transcripts, resume natively and restore from archives; full access maps to `acceptEdits`, read-only to `plan` with only Read/Glob/Grep and no MCP servers, and permission requests are never granted. Without `--harness`, an installed harness that cannot start is skipped with a warning. Deploy API, Gateway and Agent before updating the CLI. Bilingual summary: 本地 Runtime 的 Harness 改为由协议注册表驱动的独立适配器，并新增 Claude Code（`--harness claude`）与 WorkBuddy（`--harness workbuddy`，使用 `codebuddy` CLI）。二者通过 stream-json 执行 Cohub Turn，云端历史写入原生会话文件，可原生续接并从归档恢复；完整权限映射为 `acceptEdits`，只读映射为仅开放 Read/Glob/Grep 且不加载 MCP 的 `plan`，权限请求不会被批准。未指定 `--harness` 时，无法启动的已安装 Harness 会告警并跳过。请先部署 API、Gateway 与 Agent，再更新 CLI。
