---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

`cohub version` shows this CLI, the `cohub` on PATH, and the version each running Runtime serves. Runtimes report their CLI version when they connect, so a Space's Runtime panel can show it, and desktop shells read the same answer for their About panels through `cli.about`.

Hosts: deploy the Gateway before this CLI reaches clients. An older Gateway closes connections that report a client.
