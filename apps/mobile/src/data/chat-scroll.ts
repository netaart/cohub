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

export function reverseListIndex(index: number, length: number) {
  if (!Number.isInteger(index) || !Number.isInteger(length) || index < 0 || length <= 0 || index >= length) return -1;
  return length - 1 - index;
}

export function isChatRowVisible(rowTop: number, rowHeight: number, viewportTop: number, viewportHeight: number): boolean {
  if (rowHeight <= 0 || viewportHeight <= 0) return false;
  const visibleHeight = Math.max(0, Math.min(rowTop + rowHeight, viewportTop + viewportHeight) - Math.max(rowTop, viewportTop));
  return visibleHeight >= Math.min(rowHeight * 0.2, viewportHeight);
}

export function invertedListViewOffset(viewPosition: number, viewOffset: number, topInset: number, bottomInset: number): number {
  return viewOffset + bottomInset - viewPosition * (topInset + bottomInset);
}

export function invertedListDistances(offsetY: number, contentHeight: number, layoutHeight: number) {
  return {
    distanceToLatest: Math.max(0, offsetY),
    distanceToOldest: Math.max(0, contentHeight - layoutHeight - offsetY),
  };
}
