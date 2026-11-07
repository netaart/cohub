---
"@neta-art/cohub": patch
"@neta-art/cohub-cli": patch
---

The SDK is much smaller in bundled apps. Zod is now imported as a namespace, so bundlers drop the parts that go unused, such as locales and JSON Schema. Gzipped through esm.sh-style bundling, the root entry drops from 206 KB to 142 KB, `/host-bridge` from 95 KB to 33 KB and `/board` from 166 KB to 104 KB. Every entry now comes from a single build that emits each module once. Before, the root entry carried its own copy of the Board model and layout, so text measurement installed by `/board/render` never reached `BoardClient`.

`cohub --help` now prints from the command list captured at build time and loads no command code: about 70 ms instead of about 220 ms. `cohub --version` skips the command parser. `boards` and `runtime` commands load export rendering and the Runtime supervisor only when they need them, and the GPU export page ships minified. Together these make the package 1.4 MB smaller.

Hosts: no action
