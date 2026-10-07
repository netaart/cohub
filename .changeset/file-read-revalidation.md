---
"@neta-art/cohub": patch
---

`files.read()` revalidates inline file responses by ETag in server runtimes such as Node and Bun, so repeated reads of an unchanged file receive an empty `304` instead of the full body. Browsers keep relying on their native HTTP cache.

`files.read()` 在 Node、Bun 等服务端运行时会按 ETag 重新校验内联文件响应，文件未变化时重复读取只收到空的 `304`，不再传输完整内容。浏览器继续使用自身的 HTTP 缓存。
