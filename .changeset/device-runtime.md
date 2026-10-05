---
"@neta-art/cohub": minor
---

The host bridge adds the `runtime` capability: a native host that serves device folders as local Runtimes, one per Space like `cohub runtime up`, answers `runtime.list`, `runtime.browse({ path })`, `runtime.start({ spaceId, root })` (with a `refused` code from `DEVICE_RUNTIME_REFUSALS`) and `runtime.stop({ spaceId })`, and pushes `runtime.changed` with every `DeviceRuntimeInstance` (`stopped`, `connecting`, `ready` or `error`, with an error code from `DEVICE_RUNTIME_ERRORS`). `HOST_BRIDGE_INTERACTIVE_TIMEOUT_MS` covers calls that wait for the user in system settings. Runtime capabilities may now declare no local Harness; such a Runtime only bridges its workspace and its Turns run on the Cohub Harness.

宿主桥新增 `runtime` 能力：原生宿主像 `cohub runtime up` 一样把设备上的文件夹作为本地 Runtime 提供给 Space（每个 Space 一个文件夹），响应 `runtime.list`、`runtime.browse({ path })`、`runtime.start({ spaceId, root })`（拒绝时返回 `DEVICE_RUNTIME_REFUSALS` 中的 `refused` 码）和 `runtime.stop({ spaceId })`，并以 `runtime.changed` 推送全部 `DeviceRuntimeInstance`（`stopped`、`connecting`、`ready` 或 `error`，错误码见 `DEVICE_RUNTIME_ERRORS`）。需要等待用户在系统设置中操作的调用可使用 `HOST_BRIDGE_INTERACTIVE_TIMEOUT_MS`。Runtime 能力现在可以不声明本地 Harness，这类 Runtime 只桥接工作区，其 Turn 由 Cohub Harness 执行。
