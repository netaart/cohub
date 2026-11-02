---
"@neta-art/cohub-cli": minor
"@neta-art/cohub": minor
---

Local Codex Turns take an approval mode (`inherit`, `auto`, `full_access`, `read_only`) and the Fast service tier. Runtimes with Codex app-server 0.162.1+ advertise the modes in `capabilities.approvalModes`; each maps to Codex's own sandbox and approval settings, sent with the thread and every Turn, and local settings restore the machine's defaults on an existing thread. Codex approval requests during Cohub Turns become cards on the web (`getSessionApprovals`, `decideApproval`), relayed back to the Runtime and declined after 30 minutes. The Fast switch shows the model's default tier (Codex `service_tier` first) and is sent for its Turn only. `cohub spaces prompt` gains `--approval-mode` and `--service-tier`; prompt inputs gain `approvalMode` and `serviceTier`.
