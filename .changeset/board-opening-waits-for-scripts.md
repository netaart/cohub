---
"@neta-art/cohub": patch
---

Play and read-only Board views that just opened also wait, up to the same 1.5 s, for the scripts in view to draw their first frame, so `auto` animations and the script clock no longer start under an empty item; `ctx.env.ready` turns true once they have.
