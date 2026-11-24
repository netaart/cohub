---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Add offline access for Apps: `auth.authorize({ ..., offline: true })` lets an App's Actions use consented Space scopes while nobody is present, until revoked. List and revoke it with `space(id).appAccess` and `cohub spaces app-access`.
