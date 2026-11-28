---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": patch
---

The host bridge accepts what it can: unknown fields are dropped instead of rejected, so newer pages and older hosts (including `cohub host serve`) keep working together. `writeHostFile` streams a Blob to a host with `files.stream` as binary frames, within the host's window, and `HostBridgeClient.postFrame` sends one frame.
