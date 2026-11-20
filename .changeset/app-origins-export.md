---
"@neta-art/cohub": minor
---

`COHUB_APP_ORIGINS` is exported: the Cohub origins an App page trusts by default. An App that passes its own `allowHostOrigins` replaces that list, so it can now spread `COHUB_APP_ORIGINS` and add its other hosts instead of copying Cohub's.
