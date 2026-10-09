type MenuRect = { x: number; y: number; width: number; height: number };

export function getAnchoredMenuLayout({ anchor, viewport, bottomInset, contentWidth = 0 }: {
  anchor: MenuRect;
  viewport: MenuRect;
  bottomInset: number;
  contentWidth?: number;
}): { left: number; top: number; width: number; maxHeight: number } {
  const margin = 8;
  const minWidth = 180;
  const maxWidth = 280;
  const availableWidth = Math.max(0, viewport.width - margin * 2);
  const width = Math.min(availableWidth, Math.max(minWidth, Math.min(maxWidth, contentWidth)));
  const bottom = Math.max(margin, viewport.height - bottomInset - margin);
  const top = Math.min(bottom, Math.max(margin, anchor.y - viewport.y + anchor.height + 4));
  return {
    left: Math.max(margin, Math.min(anchor.x - viewport.x + anchor.width - width, viewport.width - margin - width)),
    top,
    width,
    maxHeight: Math.max(0, bottom - top),
  };
}
