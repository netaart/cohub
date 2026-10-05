---
"@neta-art/cohub": patch
---

App consent dialogs load the viewer's Spaces again. The host bridge still expected `GET /api/spaces` to return an array after the list became paginated, so every Space-bound authorize showed "Couldn't load your Spaces". It now preloads the first 100 Spaces for the picker and looks up each Space the request names — the requested, invoked, shell, or last-picked Space — with `GET /api/spaces/:id`, which now reports the viewer's `relation` (`owner`, `member`, or `public`); only Spaces the viewer owns or belongs to qualify, so access no longer depends on how many Spaces the viewer has, and archived Spaces are recognized. `setSelectedSpace()` also accepts a Space option, so a host can let the viewer pick a Space found by searching beyond the preloaded page. When the viewer has no Space, the Home it creates records the App as its source.

App 授权弹窗重新可以加载用户的 Space 列表。Space 列表改为分页后，宿主桥接层仍按数组解析 `GET /api/spaces`，导致所有需要选择 Space 的授权都显示 "Couldn't load your Spaces"。现在桥接层只预加载前 100 个 Space 供选择器使用；请求里指名的 Space（App 指定的、当前调用所在的、宿主界面当前的、上次选择的）逐个通过 `GET /api/spaces/:id` 确认。该接口现在会返回当前用户与 Space 的关系 `relation`（`owner`、`member` 或 `public`），只有用户拥有或加入的 Space 才算可用，能否访问不再取决于用户有多少 Space，已归档的 Space 也能正确识别。`setSelectedSpace()` 现在也接受 Space 选项对象，宿主可以让用户选择在预加载范围之外搜索到的 Space。用户没有任何 Space 时，为其新建的 Home 会记录是由哪个 App 触发的。
