---
"@neta-art/cohub": patch
---

An authorization request that names the Space the App was invoked in now reuses a cached grant before loading the viewer's Space list, as a request without a Space already did. A returning viewer on a slow network no longer gets a consent dialog stuck on "Couldn't load your Spaces".
