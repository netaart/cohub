---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Allow the SDK and CLI to override service endpoints through environment variables while retaining production and development defaults. Add the CLI `--base-url` flag and the SDK `webBaseUrl` option. Isolate CLI login sessions, Home Space caches, and Runtime directory bindings by API base URL.
