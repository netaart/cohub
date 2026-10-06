---
"@neta-art/cohub": minor
---

The host bridge adds five capabilities for native shells: `launch` (`app.ready` reports the first screen so the host can lift its launch screen), `haptics` (`haptics.perform({ kind })` with a kind from `HOST_HAPTICS`), `files` (`files.save` saves an https `url` the host downloads itself, or base64 `data` up to `HOST_FILE_DATA_MAX_LENGTH`), `navigation.back` (`navigation.interceptBack({ enabled })` routes system back to the page as `navigation.back` events) and `shortcuts` (`shortcuts.push({ id, label, path })` offers a launcher shortcut). The handshake now drops capabilities it does not recognize instead of rejecting the host, so a newer host never pushes an older surface off the bridge.

宿主桥为原生壳新增五项能力：`launch`（`app.ready` 上报首屏已绘制，宿主据此收起启动画面）、`haptics`（`haptics.perform({ kind })`，类型见 `HOST_HAPTICS`）、`files`（`files.save` 保存文件：宿主自行下载的 https `url`，或不超过 `HOST_FILE_DATA_MAX_LENGTH` 的 base64 `data`）、`navigation.back`（`navigation.interceptBack({ enabled })` 将系统返回以 `navigation.back` 事件交给页面处理）和 `shortcuts`（`shortcuts.push({ id, label, path })` 提供桌面快捷方式）。握手时遇到无法识别的能力会将其忽略，而不再拒绝整个宿主，因此较新的宿主不会让较旧的页面失去宿主桥。
