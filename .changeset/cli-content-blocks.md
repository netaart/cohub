---
"@neta-art/cohub-cli": minor
---

Add `--content <json|path|->` to `cohub completion` and `cohub generate`: content blocks as a JSON array, inline, from a file, or `-` for stdin, sent as given. Completion puts them in the user message after any text, so audio or images can go to the model; generate adds them after the other inputs, so each block can carry its own `meta`, such as the transcript of a reference clip. Add `cohub upload <paths...>`, which uploads local files to unlisted public URLs and prints them, so one upload can be reused across generations.
