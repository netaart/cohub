---
"@neta-art/cohub": patch
---

Remove the standalone App URL field from App responses. `AppDetailResponse` no longer carries `standaloneUrl`, and `create`, `update`, and `publishVersion` return only the App record.
