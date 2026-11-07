---
"@neta-art/cohub-cli": minor
---

The CLI starts several times faster and uses far less CPU. It ships as one bundle, loads only the command you run, and reuses V8's compile cache, so `cohub --version` takes about 50 ms instead of about 300 ms and API commands use about a third of the CPU. With `HTTPS_PROXY` set, the proxy now applies in the same process instead of a second Node process.

Self-updates no longer pile up: however many commands finish at once, one background worker checks for a release, at the lowest CPU priority and after a random delay of up to a minute. A failed check retries after 30 minutes. An install that runs too long is interrupted, never killed, so npm can roll it back. It also installs less: the SDK and other bundled or unused packages are no longer dependencies.
