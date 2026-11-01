---
"@neta-art/cohub-cli": minor
"@neta-art/cohub": minor
---

Local Codex Turns take an approval mode (`inherit`, `auto`, `full_access`, `read_only`) and the Fast service tier. Runtimes with Codex app-server 0.162.1+ advertise the modes in `capabilities.approvalModes`; read-only keeps commands that Codex rules pre-approve inside the sandbox, and a Turn starts only after Codex confirms the selected settings. Fast is sent for its Turn only. `cohub spaces prompt` gains `--approval-mode` and `--service-tier`; prompt inputs gain `approvalMode` and `serviceTier`.
