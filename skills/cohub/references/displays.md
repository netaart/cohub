# Displays

A Space's machine can share a screen: the user's phone or computer, or a virtual screen. A phone gives agents an **agent screen** of their own (kind `agent`): apps run there in the background while the user keeps using the phone. Work in plans: one `act` runs several steps on the device, finds each target on the screen as it is, waits for the screen to settle (or for `until`), stops at the first surprise and prints the screen after. Targets by `--name` (what the element says) beat refs, which beat coordinates; coordinates are pixels of your latest image. Never `sleep`: every step already waits for the screen to settle, and `--until-text`, `--until-gone`, `--until-app` or `--until-stable` wait for a slow load (`look --until-text "Done"` waits without acting).

```bash
cohub spaces displays ls                             # kinds, abilities; "Virtual screen: available" means `start` works
cohub spaces displays start                          # the phone's agent screen, or a sandbox's virtual screen
cohub spaces displays apps                           # launchable app ids
cohub spaces displays launch com.android.settings    # starts the agent screen if needed; waits until it is in front
cohub spaces displays tap --name "Wi-Fi" --label "Opening Wi-Fi settings"
cohub spaces displays type "Ada" --name Search --role textField --until-text "Ada Lovelace"
cohub spaces displays tap --name "Ada" --scroll      # pages the list until it shows
cohub spaces displays look                           # the screen now, without acting
cohub spaces displays look --screenshot              # with an image: `read` the path it prints to see the screen
echo '[{"type":"tap","name":"Search"},{"type":"type","text":"Ada"},{"type":"key","key":"Enter","until":{"gone":"Loading"}},{"type":"tap","name":"Ada","nth":1}]' | cohub spaces displays act --label "Finding Ada"
cohub spaces displays tap 540 1200                   # a point of the latest image, when nothing names it
cohub spaces displays press back
cohub spaces displays handover --reason "Sign in to WeChat"   # waits until the person hands back, then prints the screen
```

Each result lists what every step acted on and what it did (`none`, `changed`, `navigated`); a step that changed nothing is flagged, as it may not have landed: look before repeating it. It says why a plan stopped (`not_found`, `ambiguous` with candidates, `moved`: the point now lands on something other than you last saw, so look again, `timeout`, `dialog`, `app_changed`, `failed`, `preempted`, `interrupted`), the app in front and the screen as what can be acted on or read (`--tree full` for everything), or that it is as you last saw it (refs from before are gone then: use names, or `look`); it saves an image when the tree misses much of the screen (`--screenshot` always), so `read` that file before acting by coordinates. Plan up to where you must judge what you see, then look and plan again. Give each plan a short `--label` in the user's language: the phone shows it while you work.

A person always comes first: when someone takes over (on the phone or in the web), plans stop with `preempted`; ask them before going on. `interrupted` means they stopped you: end the Turn. Do not pay, sign in or type secrets for the user: run `handover` with a reason in their language. It exits 0 once they hand back, with the screen to check before going on; if it times out, tell them what is needed and to say so in the chat when done. If nothing is shared, ask the user to set up phone control in the Cohub app, or to run `cohub runtime up --display` on a computer, or start a virtual screen yourself when one is available. If a display `needs` something, tell the user what to grant.

## Look, act, verify

1. `look` (add `--screenshot` when the tree is poor) and decide the next few steps.
2. Run them as one `act` plan, or one command, with `--until-*` for what must show next.
3. Read the result: each step's `effect` (`navigated`: another app or screen came forward), and `read back` when a field holds what you typed. A step with `none` may not have landed: look before repeating it.
4. When a plan stops, follow the hint it prints. `Next:` is a command that only reads, safe to run as is; anything that needs the person (bringing a window forward, signing in) is theirs to do.

Batch what you have decided: one `act` with several steps costs one model turn. When the next step depends on what shows, loop in the shell around single commands and check their `--json` output (`stopped.reason`, `steps[].effect`) instead of guessing.

| Stop | Do |
| --- | --- |
| `not_found` | `look`, then target a name it shows, a ref, or add `--scroll` |
| `ambiguous` | pick a candidate's ref, or narrow with `--role` / `--nth` |
| `moved`, `dialog`, `app_changed`, `timeout` | `look` and plan again from what is there |
| `failed` | `ls`: the display may need a permission; tell the user |
| `preempted` | a person is using it: wait, then `look` |
| `interrupted` | the person stopped you: end the Turn and ask |

## Windows

On a computer, `windows` lists its windows front first. `--window <id>` on `look`, `capture`, `tree` or `act` reads that window alone: the image and every coordinate are the window's own, so small targets are easier to hit. Input still lands on the screen; bring the window forward first if another covers it.

```bash
cohub spaces displays windows
cohub spaces displays look --window x1a00003 --screenshot
cohub spaces displays tap 120 44 --window x1a00003
```

## Recording

Recordings are for people: start one when the user asks, or when they will want to watch what you did later. Tell them it runs; it shows as a red dot everywhere the display does. Recording pauses while a password field has focus and during a handover; still, never type a secret yourself.

```bash
cohub spaces displays record start          # now, until stopped
cohub spaces displays record start --auto   # every plan from now on, each from its start until shortly after
cohub spaces displays record stop          # --auto stops recording plans
cohub spaces displays record ls             # files under .cache/cohub/displays/recordings/
```

Your plans are always logged with your Turn (no screenshots beyond what a plan returned, never typed text), so the user can replay them from the chat.
