# Milk Frog — Desktop Companion

A single example App that demonstrates the `overlay` surface role, merging the
two earlier desktop-surface demos (`mascot` + `hud`) into one character:

- **`mascot`** — a little character that walks across the workspace, owns a
  moving pointer hit region, writes a composer chip, answers `--call`, and
  shares presence through a realtime room.
- **`hud`** — an agent heads-up display that follows the current Chat: viewer
  consent for `space.view` / `session.view`, and the live generation stream.

The Milk Frog keeps both capabilities and adds a personality: it wanders, turns
to gaze at you, and occasionally muses about what is happening in the current
chat.

![Milk Frog](https://public.cohub.live/p/cf327f11-5065-4f3a-bfe5-cdb0a70f3377/cohub-apps/desktop-surfaces/milk-frog/milk-frog.webp)

## What it does

- **Walks** along a floor line just above the chat composer (clear of the input
  box) and **gazes** at you (the pupils stay centred — the whole head turns, as
  the character sheet defines), blinks, naps when idle, and hops when you poke
  it. The floor height is a preference: `milkfrog.configure` with `{"floor":120}`.
- **Comments** every so often: it reads the current session — the live
  generation stream first, recent turns second — then asks a chat completion
  for one or two lines in the Milk Frog's curator voice, streamed into its
  speech bubble. Language follows the conversation.
- **Reacts to you.** Poke it and it hops with a little sparkle and a remark;
  switch to another chat and it reads the new context and speaks up; finish a
  turn and it muses about what just happened. There is no status panel — the
  frog is the surface, and the only thing it shows is what it has to say.
- **Shows its work.** While it reads the chat and waits on the model, three
  pondering dots float by its head; if a read or the model fails, it pulls a
  downcast face, puffs a little cloud, and files the incident with a dry line.

## Two overlay shapes in one App

The frog teaches both overlay patterns, switchable from the control strip or
with `--call milkfrog.mode`:

| Mode | `geometry` | `inputRegion` | Why |
|---|---|---|---|
| **roam** (mouse default) | `{}` | a `Rect` that follows the frog | the frog can move anywhere; only its own box takes pointer events, everything else stays clickable |
| **dock** (touch default) | `bottom-right`, `360×340` | `"all"` | a fixed, fully-interactive corner panel — touch-safe, and it demonstrates the HUD's original pattern |

Rect regions activate on hover, so they answer to a mouse but not to the first
tap on a touch screen; `"all"` works everywhere. A coarse pointer therefore
opens straight into dock mode, so the frog is tappable without a hover; a mouse
starts in roam. The host releases a rect as soon as the pointer leaves it, so a
resting frog never traps the window. Neither shape affects what the overlay
paints: the speech bubble sits outside the hit region and stays visible.

## Use it

```bash
# Publish the folder as a directory App, then open it as an overlay.
cohub desktop open app://<username>/<space>/milk-frog --as overlay

# Make it speak (it animates the talking mouth; no model call).
cohub desktop open <app> --as overlay --call milkfrog.say --data '{"text":"Ship it."}'

# Ask for a comment right now.
cohub desktop open <app> --as overlay --call milkfrog.comment

# Switch shape, or mute the chatter, or move the floor line.
cohub desktop open <app> --as overlay --call milkfrog.mode --data '{"mode":"dock"}'
cohub desktop open <app> --as overlay --call milkfrog.configure --data '{"chatter":false}'
cohub desktop open <app> --as overlay --call milkfrog.configure --data '{"floor":120}'
```

`<meta name="cohub:surface" content="overlay">` is declared, so opening it from
the workspace — or `cohub desktop open <app>` without `--as` — already presents
it as an overlay.

## Permissions

The frog follows whatever Chat the viewer is looking at, which is rarely the
App's home Space, so it asks the viewer at runtime:

1. On open: `space.view` + `session.view` — enough to follow the stream and read
   recent turns.
2. Lazily, the first time it wants to speak: `session.prompt.readonly` — the
   scope the completion endpoint requires.

A denial is not fatal. Without step 1 it cannot follow the chat; without
step 2 it still comments, using a small built-in pool of curator lines instead
of a model call. No app-side scopes are needed to publish.

## Cost and noise

Every generated comment is a real completion that bills the viewer, so
unprompted musings are paced: at least 45 s apart, at most 4 per 10 minutes.
Things you do yourself — poking the frog, switching chats — always get an answer
(a model call when the pace allows, a curated line otherwise). Mute it from the
control strip or with `milkfrog.configure`. It never writes to the session —
reading only.

## Files

| File | What it is |
|---|---|
| `index.html` | The App surface; declares the overlay role |
| `styles.css` | Theme-aware styling, no `backdrop-filter` |
| `app.js` | SDK wiring, sprite renderer, behaviour, chatter |

The App ships no image binaries: the sprite sheets are referenced by CDN URL
(`ASSET_BASE` in `app.js`), and the repository stays text-only. No build step —
the SDK is loaded from an ESM CDN.

## Asset provenance

The sheets were generated with Cohub Models, cut out with `birefnet-general`,
then sliced and baseline-aligned locally. Every public URL is under
`https://public.cohub.live/p/cf327f11-5065-4f3a-bfe5-cdb0a70f3377/cohub-apps/desktop-surfaces/milk-frog/`.

| Sheet | Frames | Animation |
|---|---|---|
| `pet-idle.webp` | 6 | idle breathing (0–3) + blink (4–5) |
| `pet-walk.webp` | 6 | walk cycle, facing right (flipped at runtime) |
| `pet-talk.webp` | 3 | talking mouth |
| `pet-happy.webp` | 2 | celebrate |
| `pet-down.webp` | 2 | downcast / error |
| `pet-sleep.webp` | 2 | sleep |
| `milk-frog.webp` | 1 | character reference |

The character brief used for every strip: a warm butter-yellow, round,
pear-shaped frog with no neck, pale mint-green eye rings around centred black
pupils, a very short horizontal mouth line, a cream belly, and stubby
olive-brown hands and feet — flat cel-shaded, on a pure white background.
Milk Frog (奶蛙) is used here as a transformative fan mascot.

## Notes

- Fixed panels (like the old HUD) should shrink the overlay with `geometry` and
  use `inputRegion: "all"`. Rects suit things that move across the screen.
- Declare `<meta name="color-scheme" content="light dark">` so the App follows
  the host theme. A mismatch makes Chromium paint an opaque backdrop behind the
  frame and the overlay loses its transparency.
- Avoid `backdrop-filter` on an overlay: the content underneath changes every
  frame while the agent streams, so a blur never stops re-rendering.
- Overlays have no chrome; the frog closes itself with `cohub.app.requestClose()`,
  and the viewer can always press `Escape` to dismiss every overlay.
