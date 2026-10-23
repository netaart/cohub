import { boardTextureEdge, boardTexturePixels } from "./asset-key.js";
import type { BoardSceneItem as BoardItem } from "./scene.js";

export const BOARD_EXPORT_TEXTURE_BYTES = 256 * 1024 ** 2;

export type BoardExportAssetSelection = {
  items: BoardItem[];
  keys: string[];
  omittedKeys: string[];
};

export function boardTextureBytes(item: BoardItem, scale: number): number {
  const crop = item.type === "image" ? item.props.crop : undefined;
  const pixels = boardTexturePixels(item, scale);
  const edge = boardTextureEdge(item, scale);
  const grow = Number.isFinite(edge) && pixels > 0 ? edge / pixels : 1;
  const width = Math.ceil((item.frame.width / (crop?.w || 1)) * scale * grow);
  const height = Math.ceil((item.frame.height / (crop?.h || 1)) * scale * grow);
  return width * height * 4;
}

export function selectBoardExportAssets(
  items: BoardItem[],
  assetKey: (item: BoardItem) => string | null,
  options: { scale: number; maxBytes?: number },
): BoardExportAssetSelection {
  const budget = options.maxBytes ?? BOARD_EXPORT_TEXTURE_BYTES;
  const largest = new Map<string, { item: BoardItem; need: number }>();
  for (const item of items) {
    const key = assetKey(item);
    if (!key) continue;
    const need = boardTextureBytes(item, options.scale);
    if (need > (largest.get(key)?.need ?? -1)) largest.set(key, { item, need });
  }
  const selection: BoardExportAssetSelection = { items: [], keys: [], omittedKeys: [] };
  let used = 0;
  for (const [key, { item, need }] of largest) {
    if (used + need > budget) {
      selection.omittedKeys.push(key);
      continue;
    }
    used += need;
    selection.keys.push(key);
    selection.items.push(item);
  }
  return selection;
}
