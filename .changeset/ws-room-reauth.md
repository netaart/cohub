---
"@neta-art/cohub": patch
---

Reconnect the WebSocket with a refreshed access token when the gateway rejects room subscriptions as `UNAUTHORIZED`, so long-lived tabs recover live session output after their token expires instead of retrying with the stale token.
