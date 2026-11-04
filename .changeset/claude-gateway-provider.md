---
"@neta-art/cohub-cli": patch
---

Claude Code: when `ANTHROPIC_BASE_URL` points at a gateway, the built-in Opus, Sonnet, and Haiku models show the gateway as their provider instead of `anthropic`, since Claude Code sends them there too.
