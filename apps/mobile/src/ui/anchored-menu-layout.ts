type MenuRect = { x: number; y: number; width: number; height: number };

export function getAnchoredMenuLayout({ anchor, viewport, bottomInset }: {
  anchor: MenuRect;
  viewport: MenuRect;
  bottomInset: number;
}): { left: number; top: number; width: number; maxHeight: number } {
  const margin = 8;
  const width = Math.min(280, Math.max(0, viewport.width - margin * 2));
  const bottom = Math.max(margin, viewport.height - bottomInset - margin);
  const top = Math.min(bottom, Math.max(margin, anchor.y - viewport.y + anchor.height + 4));
  return {
    left: Math.max(margin, Math.min(anchor.x - viewport.x + anchor.width - width, viewport.width - margin - width)),
    top,
    width,
    maxHeight: Math.max(0, bottom - top),
  };
}
