---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": patch
---

`files.read()` on a cloud Space can now return a `SpaceFsSymlink` (`kind: "symlink"`) instead of failing with `symlink_not_supported`. It carries the link text as `target` and, when that resolves inside the workspace, a workspace-relative `targetPath`. The target itself is never read. Use `isSpaceFsSymlink()` to tell it apart; `symlinkReadError()` builds the old error for readers that need file content. Local Spaces still follow symlinks. `cohub spaces files cat --json` prints this description for a cloud symlink.

Hosts: callers of `files.read()` that branch on `"content" in file` to detect a preparing file must check `isSpaceFsSymlink()` first.
