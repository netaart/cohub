---
"@neta-art/cohub": patch
---

`GET /api/me/sessions?source=…` now matches channel sources the way the label normalizer attributes them. Channel sessions are stored as `feishu:oc_…`, `qq:c2c:…` or `channel:feishu`, but the filter compared the raw column against the bare kind, so every Feishu/WeChat/Discord/QQ chat was missing from its own filter and leaked into `other` instead.
