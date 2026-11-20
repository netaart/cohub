# Score editor

A first-party App that opens a score in a Space with
[`@neta-art/score-editor`](https://www.npmjs.com/package/@neta-art/score-editor). It opens two things: a
`.abc` score file, saved back to the same path; or one generation, read from its Task Run and edited into a
draft. Opened with neither, it shows the Space's home: its songs and score files, a new score, and a working
Space of the viewer's own. It is a static page: `mount()` fills the frame, and the only host API it uses is
the Cohub App SDK.

Sizes: 390px design target, no horizontal scroll down to 320px, 480px minimum height. Below 480px the
stage scrolls; the editor area scrolls sideways instead of clipping; nothing is disabled.

## What it does

- Opens a generation when the launch URL carries `?taskRun=<taskRunId>` and the invocation names the Space;
  a file alone opens as a score file (07), and both together open the generation, with the file only as the
  place Save as goes beside.
- Asks for `file.view`, `file.edit` and `taskrun.view` before reading a generation, calls `tasks.get`, and
  builds the song project: style from the `prompt` role, lyrics from `lyrics`, the score from the output's
  `abc` role (or the input's when the output has none), the seed and score mode from the request parameters.
  Missing fields stay empty for the Project panel to fill; `style` and `lyrics` are the required inputs.
- Keeps a generated score's edits in a draft at `.cohub/score-drafts/<taskRunId>.json` in the task's Space,
  through the package's `DraftStore`, with the `{mtimeMs, size}` file version; a `409 file_conflict` is the
  package's conflict strip. List and read feed the package's inheritance from a handed-off draft; Restore
  original comes from the package's keeper and never rewrites the generation.
- Opens read-only without `file.edit`: no draft is read, written or listed, no Save as exists, and the
  original shows with a line saying why.
- Saves a generated score as a new score file and reopens it: beside the source file as `<name>-copy.abc`,
  or in `scores/<song title>.abc` (the task id when the song has no title); a taken name gets `-2`, `-3`, ….
- Save as, a new draft and Restore original's draft removal look for a free name or check the version just
  before acting. cohub's fs write has no create-only form and its delete takes no version, so a file or draft
  another window creates in that instant can be replaced or removed; the gap is narrow but real.
- Passes `source: { kind: "generated" }` and the project's source key, so the package's source label and
  Restore original work.
- Declares `.abc` in the page head (`<meta name="cohub:file-handlers">`), so the Space can open score files
  with it and "Open with" can pick it.
- Takes the file from the launch context (`client.app.onLaunch`), names it before the read, follows a
  rename or move, and asks for `file.view` + `file.edit` on the Space before reading it.
- Reads the file the way the host delivers it: inline UTF-8, inline base64 and a `url` delivery both
  decoded as UTF-8 (fatal on invalid bytes), and a preparing file retried after its own
  `retryAfterMs` without a deadline of its own.
- Opens read-only (`editable: false`, no save source) when the grant carries only `file.view`, and says why
  with an **Ask for edit access** action.
- Saves a score file's text with the `{ mtimeMs, size }` version it opened; a `409 file_conflict` becomes
  the package's conflict strip with **Overwrite with my version** and **Load the other version**, never an
  automatic overwrite.
- Names the file in the frame in every state; while the editor is shown its own toolbar carries the source
  label, so the frame keeps only the file name and folder there.
- Keeps the editor mounted with its unsaved edits when a later failure (revoked grant, file gone) arrives;
  the edits stay dirty, the close guard holds, and the frame names the cause and what Save does. Permission
  failures offer **Ask for access**, which re-asks with the missing scopes; a grant says access is back, a
  view-only grant says who must grant edit access, and a declined one adds that access was not given. A
  deleted file is told from a changed one at the adapter: cohub answers a versioned write with
  `409 file_conflict` even when the path is gone, so the adapter reads the path — a `404 path_not_found`
  means deleted; the frame names it and the next **Save again** creates the same path with the kept text. No
  frame button is involved. The conflict dialog still works on a deleted file: use my version creates it,
  load the other version keeps the edits and the line. A returning file clears the line so only the conflict
  banner remains.
- A retry never reloads while edits are unsaved; the failed-read line asks for Save again instead.
- Read-only mounts get the kind too, so the package's source label says **Score file (read only)**; a file at
  the Space root shows "Space root" in the folder line.
- Follows the host's locale (`zh*` → Chinese, everything else English) and maps the host appearance tokens
  onto the editor's `--sce-*` variables. The frame uses only host tokens, so light and dark follow the host.
- Paints a neutral skeleton before `context()` answers, and turns a rejected `context()` into the failed
  state with **Try again**.
- Holds the window open only while the score has unsaved changes (`onBeforeClose` → `dirty`).
- Handles the editor's **Check before you hand to agent** review (opened by **Hand to agent…**): runs the
  dialect check, saves a score file first (a conflict stays the package's), and writes a generated score as a
  `.abc` beside its draft.
- Decides the handoff carrier from the embedder's origin: `location.ancestorOrigins[0]`, else the origin of
  `document.referrer`. Only origins in `COHUB_APP_ORIGINS` have a composer. Cohub gets the change summary and
  the `.abc`'s path on the composer chip without sending anything; Studio and any other or unreadable origin
  get the same text in `<score>.handoff.md` beside the score, written version-first like the draft, so the
  person can point their own agent at that file.
- Says after a cohub handoff to stay in this window and write the request; the chip is only on the composer
  while this App's window is active. On a host without a composer it names the handoff file to read and, for a
  working Space, the Space to open.

## Home and working Spaces

- With no file and no `?taskRun=`, the App shows the home. It lists the Space's completed generations that
  carry a score (the output's `abc` block, else the request's) and every `.abc` file outside `.cohub/`,
  `.git/` and `node_modules/`. The file walk streams rows as it finds them; the songs section never waits
  for it.
- A row shows a song's first lyric line (else its style, else `Untitled song`), its style and the time; a
  file row shows its name, folder and time. `Generated copy` marks a file whose text equals a song's output
  or request score, trailing whitespace ignored. Opening it opens the song in its draft; the file is only
  the Save as place, so Save never overwrites it. Opening a file not on the loaded song pages checks the
  remaining task pages first; a failed check opens neither kind.
- `New score` writes the smallest song2 score to `scores/new-score.abc` (`-2`, `-3`, …) with no overwrite
  and opens it as a score file. The same free-name rule applies to `Save a copy`.
- The home asks once for `file.view`, `taskrun.view` and `file.edit`, then falls back to the read set and
  then `file.view` alone. Opening a row reuses that grant and asks nothing more; without `file.edit` the
  score opens read-only with **Ask for edit access**. A host launch keeps its own scope flow.
- The home works in the Space the host granted; when the host grants a Space other than the one asked for,
  the home opens on that Space.
- When the host's Space is read-only, the home lists it read-only and offers **Work in one of your Spaces**.
  A pick-space grant switches the working Space for this window; **Pick another Space** and **Back to this
  Space** keep the way around visible. A read-only song or file offers **Save a copy to `<Space>`**: the Save
  as rule in the working Space, opened there as an editable score file. `New score` writes there too.
- Handoff follows the host. A host with a composer gets the chip, set with the `.abc` path relative to the
  working Space; a host without one gets `<score>.handoff.md` beside the score, a notice naming that file,
  and no chip. In a working Space that is not the context Space, either host calls
  `client.navigation.open({ kind: "file", spaceId, path })` for the score. With a composer, `handled: true`
  leaves nothing more to say and `handled: false` says where the score is saved, leaving the chip in place;
  without one, the notice naming the handoff file and the Space shows whatever navigation answers.

## Handoff

The package's **Hand to agent…** button opens its **Check before you hand to agent** review (the change log,
and the pre-handoff notices of newer package versions) and calls the App only when the score may go. The App
then:

- Runs the dialect check on that project. A score the dialect cannot read hands nothing off: no chip, no
  handoff file, and a line that names the problem and where it is. For a **score file** the package has already
  saved it before this call, so a refused check leaves that save in place; for a **generated score** it writes
  no `.abc`. The package's pre-handoff notices are notices, not refusals: it shows them in its own review above
  an enabled confirm, and the viewer who read them may hand off.
- For a **score file**, the package has already saved the file (a conflict shows its strip and nothing is handed
  off), and the handed-off file is that file. A host with a composer writes nothing more; a host without one
  writes the handoff file beside it.
- For a **generated score**, writes the score to `.cohub/score-drafts/<taskRunId>.abc` in the task's Space, beside
  `.cohub/score-drafts/<taskRunId>.json`; the draft keeper's `handoff()` has recorded its hash by then. A host
  without a composer also writes `<taskRunId>.handoff.md` there.
- With a composer, puts the composer chip on: the song's title or the file's name as the label, fitted to the
  protocol's 120-character limit with a middle ellipsis so a long name keeps its start and its end, and the
  package's instruction — final style and joined lyrics when they carry words. When the package's plain
  missing-lyrics line appears, the App replaces it with the task's original lyrics text (for example
  `[Instrumental]`); for the combined missing-style-and-lyrics line it keeps the package's no-style ask and puts
  the lyrics beside it. Then score mode, seed and the change log, under the `.abc` path. The score itself is not
  in the chip; content over the protocol's 32 KB limit is not truncated, the chip is not set, and the line says
  the score is too long to hand off as text. A second handoff replaces the chip; a refused handoff, a renamed or
  moved file, or another file in the window takes it back.
- Without a composer, writes the same text to `<score>.handoff.md` beside the score: read first, then written at
  the read version (a 404 creates it), the same conflict rule as the draft. It sets no chip, and the notice names
  the handoff file to read and, for a working Space, the Space to open.
- In a working Space that is not the context Space, calls `client.navigation.open({ kind: "file", spaceId,
  path })` for the score after either carrier is written. With a composer, `handled: true` leaves nothing more
  to say and `handled: false` leaves the notice naming where the score is saved; without one, the saved notice
  shows whatever navigation answers.
- Gives `mount` a `handoffScorePath` that answers the same path the carrier's first line names, so the package's
  instruction says the score is in that file (and still carries the attachment); one function computes it for
  the chip, the handoff file and the option.
- Writes the carrier's first line with the **backticked `.abc` path** the agent should read. In the context
  Space it is `Score file in this Space: \`<path>\`` / `Space 里的乐谱文件：\`<path>\``; in a working Space it
  names that Space (`Score file in <Space>: \`<path>\`` / `<Space> 里的乐谱文件：\`<path>\``). On a composer
  host the App surface takes the first backticked path ending in `.abc` as the attachment; without one the
  handoff file holds the same line above the instruction. The rest of the content is the package's instruction.
- With a composer, shows a line saying to stay in this window, write what the agent should do, and send. Switching
  windows drops the chip from the composer. A host without a composer shows the saved notice instead; navigation
  still opens the score's path, and a host that does not handle it still leaves the handoff file to read.

The generated-score launch uses the same handoff module with `target: { kind: "generated", taskRunId }` and the
song title, so a generated score writes its `.abc` beside the draft and, without a composer, its handoff file
too; a score file uses `target: { kind: "scoreFile", path }` and the package has already saved it.

## Known limits

- Text equality cannot tell a host's copy from a copy the viewer made with Save as. Both open as the
  generated song; edits go to the draft, and Save as is still there, so the file is not overwritten.
- The `.abc` walk covers the whole Space and has no depth bound. A large Space takes longer and rows arrive
  as the walk finds them; the songs section is independent.
- Opening a file whose song is not on the loaded pages scans the remaining task pages before opening it.
  A failed scan opens neither the song nor the file.
- New score and Save as list the target folder and then write with no version. A file another window creates
  in that instant can be replaced; the window between the two calls is narrow.
- Leaving a generated score starts its pending draft write through the package's `destroy()`, which returns
  no completion promise. A very fast reopen can read the pre-destroy draft.
- The home keeps its listing and scroll position in memory for the App session, paints them when it returns
  from a score, and refreshes silently. There is no persistent cache: a cold window starts on the skeletons.

## Develop

```bash
pnpm --filter @cohub/score-editor build
pnpm --filter @cohub/score-editor typecheck
pnpm --filter @cohub/score-editor lint
pnpm --filter @cohub/score-editor test
pnpm --filter @cohub/score-editor harness   # fake-client states on http://localhost:5181
```

The seam-8 tests drive the real editor session and keeper over a fake cohub client
(`tests/fake-client.ts`); they assert the path, text and version of every write, both conflict choices, the
read-only and revoked cases, the locale and theme mapping, the close guard, the handoff (the `.abc` written for
each score kind, the chip's label and content, a refused handoff that writes and chips nothing, a notice that
does not stop the handoff, a long name whose label is fitted, over-long content that sets no chip, and a second
handoff that replaces the chip), the handoff without a composer (a score file's text written to `.handoff.md`
with no chip, a generated score's `.abc` written and its handoff file carrying the task's `[Instrumental]` lyrics, both files
created after a 404 and replaced at their read versions, a failed handoff-file write reported without a chip,
and navigation to the score in a working Space), the embedder-origin composer flag (every Cohub origin yes,
Studio, unknown, empty and unreadable no, the nearest ancestor before the referrer, and the page's combined
flag), and the generated-score path (Task Run field mapping, the draft store's create,
update, conflict and list, inheritance from a handed-off draft, Restore original, and the Save as names and
locations), and the home (song pages, file walk, copy matching, new score, working Space, handoff
navigation). App start and the way back to the home's wiring are tested by mounting through `createApp`; scroll
restore is checked on the controller because the fake DOM keeps `scrollTop` on a hidden element. The chip limits
come from the SDK (`@neta-art/cohub`), and the fake client enforces them as the protocol parser does. The tests
run through `scripts/test/run.mjs`, like the other Apps that import the SDK at runtime. See `harness/README.md`
for the state URLs.

## Publish

```bash
cohub apps publish score-editor --dir cohub-apps/score-editor/dist --visibility public
```

No publisher scopes: the App needs viewer grants on the Space it opens, not permissions on its own Space.
The build output is `dist/` with `index.html` and its assets; the harness is not part of it.
