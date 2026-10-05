# File Monitoring / 文件监听

The watcher produces invalidation hints, not a durable filesystem journal. Filesystem RPC remains authoritative. Monitoring never edits user files.

监听事件用于缓存失效，不是持久化文件操作日志。文件 RPC 始终是权威来源；监听器不会修改用户文件。

## Backends / 后端

- macOS releases use `github.com/fsnotify/fsevents` with CGO and CoreServices, watching one recursive workspace root.
- Linux keeps fsnotify/inotify and its recursive directory registration.
- `COHUB_FILEWATCH_BACKEND=auto|fsevents|fsnotify|scan` selects a backend. `auto` falls back to scanning when FSEvents cannot start, including Darwin builds without CGO. Explicit `fsevents` fails visibly instead of silently switching.
- Scanning runs every five seconds after the previous pass completes. Continuous failures report once and exponentially back off to five minutes. It retains at most 250,000 entries, compares nanosecond modification times, size, type and mode, and preserves the previous baseline on incomplete scans. It does not follow directory symlinks intentionally. Short-lived changes between scans are not guaranteed to be observed.
- Sockets, FIFOs and device nodes are never reported as changes: macOS rejects watching them with `EOPNOTSUPP`, and they carry no file-tree meaning. The authoritative `fs.tree` / `fs.stat` RPC remains the source for what exists.
- Entries named `.cohub-upload.*` are staging for uploads and copies. They are never watched or reported; the atomic rename that installs them is reported at the destination path, including every entry of an installed directory.
- macOS uses no per-file kqueue watches by default. Explicit `fsnotify` on macOS is a diagnostic escape hatch and can still exhaust file descriptors.

macOS 发布包使用 FSEvents 原生递归监听，Linux 保留 inotify。上述环境变量可切换后端；自动模式在 FSEvents 启动失败时降级扫描，显式选择 FSEvents 则报告错误。扫描间隔为上一轮完成后的 5 秒；连续失败只报告一次，并指数退避至 5 分钟。最多保留 250,000 个条目，不完整扫描不会覆盖旧基线；扫描无法保证观察到两轮之间的短暂变化。macOS 显式使用 fsnotify 仍有 FD 耗尽风险。`.cohub-upload.*` 是上传和拷贝的暂存条目，不监听也不上报；安装时的原子 rename 按目标路径上报，安装的目录会上报其中每个条目。

## Recovery / 恢复

Overflow, ambiguous renames and coalesced create/remove flags request a resync. Ignored subtree renames do not invalidate the whole workspace. Consumers reload authoritative state, without synthesizing deletes from incomplete scans. Special nodes are ignored while present; when a delete event arrives after the node is gone and its type is unknowable, the watcher keeps the conservative delete invalidation rather than risking a stale file cache. Native backends also request a low-frequency refresh every five minutes. A moved/replaced workspace root marks monitoring degraded and requests a refresh; it is never auto-cleared by a same-path scan because fsnotify may still reference the old inode. Restart Runtime to bind its new root. Runtime does not silently follow a moved root outside the selected workspace.

事件溢出、无法确定的重命名和合并的创建/删除会请求重新同步；忽略目录的重命名不会触发全量刷新。不完整扫描不会伪造删除。原生后端另有每 5 分钟一次的校准刷新。根目录移动或替换后标记监听降级；同路径扫描不会自动清除该状态，因为 fsnotify 可能仍指向旧 inode。需要重启 Runtime 重新绑定，不会静默追踪到用户选择范围外。

`RuntimeStatus.fileWatcher` is always present, with null meaning no current report. It reports backend/state/reason/observedAt via the authenticated sandbox control channel. Gateway validates fields, stamps receipt time, and stores a 60-second Redis TTL. Reports arrive on registration and every control pong (20 seconds). Missing/expired telemetry means unknown, not healthy. This is monitoring status, not proof that the file data channel is reachable. No filenames, absolute paths, credentials or file content are included. CLI status returns the SDK field; desktop/mobile Web reuse the Runtime sheet.

监听状态通过已认证的控制连接上报，注册时及每 20 秒保活时发送；Gateway 校验字段并记录接收时间，Redis 保留 60 秒。缺失或过期表示未知，不表示正常，也不证明文件数据通道可用。不上报路径、文件名、凭证或文件内容。CLI 与桌面/移动端共用该状态。

## Release Gate / 发布门槛

1. Run Go tests/vet and watcher race tests; run macOS native tests on both architectures. Linux cannot execute native Darwin tests.
2. Validate FD stability with a large flat directory, atomic saves, rename/move, symlink boundaries, shutdown during event bursts and sleep/wake on macOS.
3. Deploy Gateway, Agent/sandbox-client and Web together with the single `sandbox-watch` event source.
4. Publish Darwin CGO artifacts from macOS runners and Linux artifacts from Linux. Verify archive/checksum/download on a clean CLI cache.
5. Only after CDN publication succeeds, bump CLI `SANDBOXD_VERSION` with a changeset. Every published pin must now be a notice-bearing archive (`cohub-sandboxd`, `LICENSE`, `NOTICE`); the retired binary-only `v1.82.4` shape is rejected.

发布前必须完成 Go/race、macOS 双架构原生运行和大目录 FD 测试；Gateway、Agent/sandbox-client 和 Web 统一使用 `sandbox-watch`，同步发布。CDN 制品和全新缓存下载验证成功后，才能更新 CLI 版本 pin；现行所有版本都必须使用带 `LICENSE`/`NOTICE` 的归档，旧的单二进制形状一律拒绝。
