---
"@neta-art/cohub-cli": minor
"@neta-art/cohub": minor
---

Direct local access: on the machine whose Runtime serves a Space, files and screens skip the API, gateway and relay. sandboxd serves a private loopback API whose token only its supervisor holds; `cohub spaces files` and `cohub spaces displays` use it automatically (uploads stream from disk without the API's size limit), and fall back to the API when it cannot be reached, never retrying a mutation it may have run. The SDK adds a `localWorkspace` client option, `files.workspace()` and `loopbackWorkspace()`, and the desktop and Android apps read and write their own folders through the host bridge (`workspace.call`) and stream media with ranges (`workspace.files`). `COHUB_NO_DIRECT=1` keeps every request on the API; scoped execution tokens always do.
