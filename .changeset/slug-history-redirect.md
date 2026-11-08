---
"@neta-art/cohub": patch
---

`spaces.getBySlug()`, `apps.getBySlug()`, `apps.listPublicVersions()` and `users.getByUsername()` responses now carry an optional `redirectTo` (typed as `PublicSlugRedirect`) when the request used a retired username or Space slug. The payload is still the resolved resource, so existing callers keep working; `redirectTo` is the canonical public path for hosts that want to update the URL.
