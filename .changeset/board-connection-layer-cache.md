---
"@neta-art/cohub": minor
---

Make large Boards with thousands of relations cheap to render. The connection layer now caches its tessellated geometry per layer and only redraws relations touching nodes being manipulated, culls relations to a new `cullRect` input (exports pass their region), clips dashes to it, and draws dashes, arrowheads and labels too small to read as plain strokes or not at all. Past a fixed dash budget a frame draws all dashed relations solid, including exports. The document is never changed. Visible differences: dashes use butt caps, and relations are stroked in style groups rather than strict document order. New exports: `createConnectionGeometryCache` (memoised relation geometry), `connectionHitRadius`, and `stableCullRect` (a viewport cull rect that stays constant across small pans).

让包含数千条连线的大型 Board 也能流畅渲染。连线图层现在按图层缓存细分后的几何，只重绘与正在操作的节点相连的连线；新增 `cullRect` 输入用于按区域裁剪连线（导出时传入导出区域），虚线也按该区域裁剪；缩放到看不清时，虚线、箭头和标签会降级为实线或不绘制。单帧虚线段数超过固定预算时，所有虚线统一改画实线，导出同样适用。绝不修改文档数据。可见变化：虚线端点改为平头，连线按样式分组描边、不再严格按文档顺序叠放。新增导出：`createConnectionGeometryCache`（连线几何缓存）、`connectionHitRadius`，以及 `stableCullRect`（在小幅平移时保持不变的视口裁剪区域）。
