export const CHAT_TAIL_THRESHOLD = 60;
export const CHAT_PAGE_THRESHOLD = 180;
/**
 * Legend only keeps pinning while the viewport is within this many screen-heights of the
 * tail (its default is 0.1). Following is our decision; once it is on, a streamed burst
 * that outruns the animated pin must not drop it.
 */
export const CHAT_FOLLOW_TAIL_MAINTAIN_THRESHOLD = 8;

type ChatTailStateInput = {
  currentlyFollowing: boolean;
  distanceToBottom: number;
  userInteracting: boolean;
  pendingTarget: boolean;
};

/**
 * Whether a scroll event counts as the user leaving the tail. Growth adds distance to the tail
 * without the user going anywhere, and an animated programmatic pin reports momentum while it
 * catches up, so neither may drop following.
 */
export function chatTailScrolledAway(input: { dragging: boolean; momentum: boolean; contentGrew: boolean }) {
  return (input.dragging || input.momentum) && !input.contentGrew;
}

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

/** Sending keeps the animated pin: its overlay tracks the moving destination on the UI thread.
 *  Initial row measurements still use an immediate pin. */
export function chatMaintainScrollAtEnd(followingTail: boolean, animate = true) {
  return followingTail ? { animated: animate } as const : false;
}
