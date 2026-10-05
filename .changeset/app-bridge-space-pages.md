---
"@neta-art/cohub": patch
---

App consent dialogs load the viewer's Spaces again. The host bridge still expected `GET /api/spaces` to return an array after the list became paginated, so every Space-bound authorize showed "Couldn't load your Spaces". It now reads `items` and follows `pageInfo.nextCursor` (100 per page, up to 10 pages), so an explicit or last-picked Space beyond the first page is still recognized. When the viewer has no Space, the Home it creates records the App as its source.

App 授权弹窗重新可以加载用户的 Space 列表。Space 列表改为分页后，宿主桥接层仍按数组解析 `GET /api/spaces`，导致所有需要选择 Space 的授权都显示 "Couldn't load your Spaces"。现在改为读取 `items`，并按 `pageInfo.nextCursor` 继续翻页（每页 100 个，最多 10 页），排在第一页之后的指定 Space 或上次选择的 Space 也能被正确识别。用户没有任何 Space 时，为其新建的 Home 会记录是由哪个 App 触发的。
