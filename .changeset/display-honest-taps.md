---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Displays: on a touch screen a tap on a named element is a real touch where it shows, each step reports what it acted on, a step that changed nothing is flagged, and a tap at a point that now lands on something other than you last saw stops with `moved`. Images are saved under `.cache/cohub/displays/` in the working directory, where agents' file tools reach them; `tree` is compact by default (`--full` for everything) and `look --until-*` waits.
