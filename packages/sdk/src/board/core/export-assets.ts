import type { BoardSceneItem as BoardItem } from "./scene.js";

export const BOARD_EXPORT_MAX_TEXTURES = 64;

export type BoardExportAssetSelection = {
  items: BoardItem[];
  keys: string[];
  omittedKeys: string[];
};

export function selectBoardExportAssets(
  items: BoardItem[],
  assetKey: (item: BoardItem) => string | null,
  maxTextures = BOARD_EXPORT_MAX_TEXTURES,
): BoardExportAssetSelection {
  const limit = Number.isSafeInteger(maxTextures)
    ? Math.max(0, maxTextures)
    : BOARD_EXPORT_MAX_TEXTURES;
  const selected = new Map<string, BoardItem>();
  const omitted = new Set<string>();

  for (const item of items) {
    const key = assetKey(item);
    if (!key || selected.has(key) || omitted.has(key)) continue;
    if (selected.size < limit) selected.set(key, item);
    else omitted.add(key);
  }

  return {
    items: [...selected.values()],
    keys: [...selected.keys()],
    omittedKeys: [...omitted],
  };
}
