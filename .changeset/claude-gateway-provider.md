---
"@neta-art/cohub-cli": patch
---

Claude Code: when `ANTHROPIC_BASE_URL` points at a gateway, the built-in Opus, Sonnet, and Haiku models show the gateway as their provider instead of `anthropic`, since Claude Code sends them there too. A Turn with no approval mode now follows Claude Code's own settings, as the picker's "Use local settings" shows, instead of forcing `acceptEdits`; a Claude Code without approval modes keeps `acceptEdits`.
