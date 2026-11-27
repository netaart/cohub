---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Board script imports take their type from the extension, so `with { type: "json" }` and `with { type: "bytes" }` are optional and bundles whose bundler drops import attributes load as written; a wrong type still fails.
