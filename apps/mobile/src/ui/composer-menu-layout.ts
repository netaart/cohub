export type ComposerMenuAnchor = { x: number; y: number; width: number; height: number };

export function getComposerMenuLayout(input: {
  anchor: ComposerMenuAnchor;
  windowWidth: number;
  windowHeight: number;
  topInset: number;
  bottomInset: number;
  keyboardTop: number | null;
  preferredWidth: number;
}): { left: number; bottom: number; width: number; maxHeight: number } {
  const margin = 12;
  const top = input.topInset + margin;
  const anchorTop = Math.min(input.anchor.y, input.keyboardTop ?? input.windowHeight);
  const bottom = Math.max(input.bottomInset + margin, input.windowHeight - anchorTop + 8);
  const width = Math.min(input.preferredWidth, Math.max(0, input.windowWidth - margin * 2));
  return {
    left: Math.max(margin, Math.min(input.anchor.x, input.windowWidth - margin - width)),
    bottom,
    width,
    maxHeight: Math.max(0, Math.min(480, input.windowHeight - bottom - top)),
  };
}
