---
"@neta-art/cohub-cli": patch
---

Fix `cohub runtime up` failing with `Cannot find module …/native-pi-extension.js` after upgrading from CLI 8.0–8.2: before any harness starts, the legacy Pi extension is replaced and legacy Codex hooks are removed. 修复从 CLI 8.0–8.2 升级后 `cohub runtime up` 因旧版 Pi 扩展启动失败的问题：启动任何 Harness 前自动替换旧 Pi 扩展并移除旧 Codex Hooks。
