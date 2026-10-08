---
"@neta-art/cohub": patch
---

Board strokes render where they were drawn. The draw renderer placed a stroke's points at its frame corner instead of its position, shifting every new stroke up and left by its radius and clipping its first cap in exports. Bends no longer show hairline seams: neighbouring segments meet on a shared mitre. Strokes are now opaque, so caps and folds no longer show as darker patches. `style.trim` now reveals strokes, as the `draw` preset intends. New `createStrokeRibbonBuilder()` re-tessellates only the newest samples of a growing stroke instead of all of it, and `trimDrawPoints()` cuts a stroke to a share of its length.

Board 笔迹现在显示在实际绘制的位置。此前 draw 渲染器把笔迹的点以 frame 左上角而不是 `position` 为原点放置，新画的笔迹都会向左上偏移一个笔触半径，导出时起笔端帽还会被裁掉。转弯处不再出现细缝：相邻线段在共享的斜接点相接。笔迹改为不透明，端帽和折叠处不再显出深色斑块。`style.trim` 现在会按 `draw` 预设的设计逐步显出笔迹。新增 `createStrokeRibbonBuilder()`：正在延长的笔迹只重新三角化最新的采样点，无需整条重建；新增 `trimDrawPoints()`：按长度比例截取笔迹。
