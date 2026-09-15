---
"@neta-art/cohub": patch
---

`GET /api/me/sessions?source=…` now filters by each session's source **system label** instead of the raw `space_sessions.source` string. Channel sessions are stored as `feishu:dm:…` or `channel:feishu`, so matching the raw column dropped every Feishu/WeChat/Discord/QQ chat from its own filter and leaked it into `other`; labels carry the attribution the normalizer already made at creation, so this fixes every provider at once and matches what a space sidebar shows.
