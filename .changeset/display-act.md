---
"@neta-art/cohub": major
"@neta-art/cohub-cli": minor
---

Act on displays in plans: `displays.act()` and `cohub spaces displays act` run several steps on the machine, find each target by what it says, wait for the screen to settle or for `until`, stop at the first surprise and report the screen after. New `launch`, `open`, `look`, `wait` and `apps` commands, `--name`/`--role`/`--nth` targets and `--until-*` on every action; `handover` asks a person to do what an agent must not and waits until they hand back; `--scroll` pages a list to its target; phones give agents a screen of their own. Breaking: `compileDisplayActions` is replaced by `compileDisplayPlan`, which compiles actions into `act` steps; `tree --actionable` is now `--compact`, which also keeps text to read.
