---
"@neta-art/cohub-cli": minor
---

Follow Codex paginated rollout lineage during native sync and import

Codex keeps one logical conversation across several rollout files: each rollover or fork writes a fresh rollout that references an immutable prefix of its parent through `session_meta.history_base`. Cohub previously rejected those files and bound sync to a single file, so imported history stopped following the conversation once Codex rolled over.

- Native Codex transcripts now resolve the full `history_base` chain (active or archived, plain or `.zst`) and parse it as one conversation with exact `end_ordinal_exclusive` / `end_byte_offset` boundaries.
- Turn receipts record their source rollout file and merged order, so archives are captured from the file that actually holds each Turn's bytes; the leaf binding follows the newest rollout while the ancestor stays untouched.
- `cohub runtime import` skips ancestor rollouts and imports each stitched conversation once from its leaf file.

Managed Runtime sessions that rolled over keep their settled cloud Turns as a continuation boundary, and a leaf archive whose ancestor it does not carry refuses to restore (rebuilding from durable Session history instead). Missing ancestors, cyclic references, cross-project lineages, and boundaries that are not at a completed Turn fail explicitly without touching original files.
