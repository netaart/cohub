# Dev-only harness

Renders the App frame for every state on one fake cohub client, so the states can be looked at
without a published App. It is not part of `dist/`: `pnpm build` builds the App's `index.html` only.

```bash
pnpm --filter @cohub/score-editor harness   # http://localhost:5181
```

Every state takes `?state=`, `?lang=en|zh` and `?theme=light|dark`:

- `?state=loading`
- `?state=editable` (the default)
- `?state=readonly`
- `?state=readonly-retry` — read-only; **Ask for edit access** grants it and reopens editable
- `?state=no-permission`
- `?state=no-permission-retry` — open declined; **Ask for access** grants it and opens the file
- `?state=no-permission-declined` — both consents declined; the frame says access was not given
- `?state=revoked` — revoked before the first read
- `?state=revoked-save` — open, edit, then Save; the write answers 403, **Ask for access** grants it and
  **Save again** writes the kept edits
- `?state=revoked-viewonly` — as above, but the viewer now holds only `file.view`; the kept-edits line keeps
  asking for edit access
- `?state=file-gone`
- `?state=gone-save` — open, edit, then Save; the file is gone, the frame names it and **Save again** in
  the package's toolbar puts it back at the same path, with an "is back" line
- `?state=gone-returned` — as `gone-save`, but the file comes back meanwhile; the second Save shows the
  package's conflict banner and **Choose** dialog instead of writing
- `?state=conflict-deleted` — edit, Save → conflict banner; the file is deleted behind it; **Choose → use my
  version** puts the file back with those edits, **Choose → load the other version** keeps the edits and the
  deleted line, with no failed save and no empty editor
- `?state=failed`
- `?state=conflict` — edit, then Save; the fake client answers 409, which opens the package's conflict banner
  and its **Choose** dialog
- `?state=save-failed` — edit, then Save; the fake client answers 500
- `?state=generated` — a generation opened from `?taskRun=task-1` (fresh, no draft); edit a note and the
  draft is written one second after the last change
- `?state=generated-draft` — the same generation opens its saved draft (the score already differs from the
  original)
- `?state=generated-conflict` — the draft was changed by another window after this one read it; edit a note
  and the conflict strip appears with **Overwrite with my version** and **Load the other version**
- `?state=generated-readonly` — the viewer holds `file.view` and `taskrun.view` only: the original shows,
  with no draft read, no editing controls and no Save as
- `?state=generated-instrumental` — a `?taskRun=` whose lyrics block is `[Instrumental]`: the handoff is
  available and its chip carries the original lyrics text
- `?state=generated-saved` — presses **Save as** once the editor is ready; the copy lands in `scores/` and
  the window reopens it as a score file (the frame tag changes)
- `?state=handoff` — the clean score file handed off; the frame says to stay and send, and the fake client's chip
  is in the readout at the bottom right
- `?state=handoff-refused` — a file that is not a song2 score; the handoff is refused, the frame names the line,
  and no chip is set
- `?state=handoff-twice` — handed off twice; the readout counts the chip sets and shows the last chip, so the
  replacement is visible
- `?state=handoff-file` — a host without a composer; the handoff writes `scores/intro.handoff.md` and the frame
  names that file, with no chip
- `?state=handoff-file-elsewhere` — picks **My Space**, opens `scores/intro.abc` there, and hands off without a
  composer; the frame names My Space and `scores/intro.handoff.md`
- `?state=home` — the home: songs, score files and a generated copy
- `?state=home-empty` — an empty Space
- `?state=home-loading` — both lists never settle
- `?state=home-refresh` — a snapshot with rows and the 2px refresh progress bar (state 2)
- `?state=home-refresh-failed` — the same snapshot with the muted refresh-failed line and Try again (state 12)
- `?state=home-revoked` — the access state shown after a grant is revoked (state 26)
- `?state=home-songs-error` — songs failed, files fine
- `?state=home-files-error` — files failed, songs fine
- `?state=home-error` — both failed
- `?state=home-songs-denied` — `taskrun.view` missing
- `?state=home-no-view` — `file.view` missing
- `?state=home-readonly` — reads only; view-only home
- `?state=home-copy` — the copy-pending state on a full home
- `?state=home-copy-check` / `?state=home-copy-failed` — the copy-check line and a row-level copy failure with Try again, on the full home fixture
- `?state=home-working-space` — opens the home, then picks a working Space
- `?state=home-working-view` — picks a working Space that grants only `file.view`
- `?state=home-guard` — opens a score file, edits its text and presses the back control
- `?state=home-guard-conflict` — the same, with a save conflict
- `?state=handoff-not-handled` — picks a working Space, opens a song, and hands it off while the fake host answers `handled: false`
- `?state=no-file` — used by older links; the home replaces it
- `?state=no-host` — not inside a Space
- `?state=startup-failed` — `context()` rejected; **Try again** re-boots

Paths: `?path=root` (no folder line), `?path=deep` (middle-truncated folder), `?path=long` (80-character
name); the default is `scores/intro.abc`. `?composer=1` or `?composer=0` overrides the fake host's composer
flag for any state; the two `handoff-file` states default to `0`, everything else to `1`.

The fake client is `tests/fake-client.ts`, the same one the seam-8 tests drive. The handoff states press the
package's **Hand to agent…** trigger and its **Hand to agent** confirm button; the fake composer chip is the box
at the bottom right (it is the harness's own readout, not host UI). The host tokens in `harness/main.ts` use
cohub's brand `#FF3E00` so the shots match the host.
