export const CHAT_TAIL_THRESHOLD = 60;
export const CHAT_PAGE_THRESHOLD = 180;

type ChatTailStateInput = {
  currentlyFollowing: boolean;
  distanceToBottom: number;
  userInteracting: boolean;
  pendingTarget: boolean;
};

export function nextChatTailFollowing(input: ChatTailStateInput) {
  if (input.pendingTarget) return false;
  if (input.userInteracting) return input.distanceToBottom <= CHAT_TAIL_THRESHOLD;
  return input.currentlyFollowing || input.distanceToBottom <= CHAT_TAIL_THRESHOLD;
}

export function isChatRowVisible(rowTop: number, rowHeight: number, viewportTop: number, viewportHeight: number): boolean {
  if (rowHeight <= 0 || viewportHeight <= 0) return false;
  const visibleHeight = Math.max(0, Math.min(rowTop + rowHeight, viewportTop + viewportHeight) - Math.max(rowTop, viewportTop));
  return visibleHeight >= Math.min(rowHeight * 0.2, viewportHeight);
}

/**
 * The timeline is chronological with the newest message at the end, so `viewPosition` already
 * measures from the top and only the overlaid top bar has to be compensated: RN/Legend subtract
 * `viewOffset` from the target scroll offset, which pushes the jumped-to turn below the chrome.
 */
export function chatListViewOffset(viewPosition: number, viewOffset: number, topInset: number): number {
  return viewOffset + Math.max(0, Math.round(topInset * (1 - viewPosition)));
}

export function chatListDistances(offsetY: number, contentHeight: number, layoutHeight: number) {
  return {
    distanceToLatest: Math.max(0, contentHeight - layoutHeight - offsetY),
    distanceToOldest: Math.max(0, offsetY),
  };
}
