export type PanelName = "chat" | "files";

/** Header touches belong to native navigation and must not start the horizontal pager. */
export function isPagerHeaderTouch(locationY: number, headerHeight: number) {
  return locationY >= 0 && locationY < headerHeight;
}

/**
 * Nearest-page resolution for the push-style panel pager: `null` means the chat page is
 * the closest snap point (i.e. no panel open).
 */
export function panelForScrollOffset(offset: number, centerOffset: number, filesOffset: number): PanelName | null {
  const toChat = Math.abs(offset);
  const toCenter = Math.abs(offset - centerOffset);
  const toFiles = Math.abs(offset - filesOffset);
  if (toCenter <= toChat && toCenter <= toFiles) return null;
  return toChat < toFiles ? "chat" : "files";
}
