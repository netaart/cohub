---
"@neta-art/cohub-cli": minor
"@neta-art/cohub": minor
---

Add `cohub spaces files cp`, an scp-style copy with `cp` semantics (`-r`, `-n`, `-p`): `<space>:<path>` names a Space by id, `username/slug`, or own slug; bare paths are the current Space when `-s` or `COHUB_SPACE_ID` declares one and local files otherwise. Copies between Spaces run server-side without passing content through the CLI; local files are uploaded or downloaded. `spaces files upload` now uploads in parallel and splits large uploads into batches. `cohub spaces files cat` now streams raw bytes, so `cat <path> > file` saves binary files intact. The SDK adds `files.copy()`, `files.getCopy()`, `files.waitForCopy()`, `files.open()`, `parseSpaceRef()` and the upload limit constants.

新增 `cohub spaces files cp`，用法和 `scp` 一致、语义和 `cp` 一致（支持 `-r`、`-n`、`-p`）：`<space>:<path>` 可以用 ID、`username/slug` 或自己 Space 的 slug 指向某个 Space；用 `-s` 或 `COHUB_SPACE_ID` 声明了当前 Space 时，不带前缀的路径指当前 Space，否则指本地文件。Space 之间的拷贝在服务端完成，文件内容不经过 CLI；本地文件走上传或下载。`spaces files upload` 改为并发上传，并会把大批量上传自动分批。`cohub spaces files cat` 改为直接输出原始字节，`cat <path> > file` 可以完整保存二进制文件。SDK 新增 `files.copy()`、`files.getCopy()`、`files.waitForCopy()`、`files.open()`、`parseSpaceRef()` 和上传限额常量。
