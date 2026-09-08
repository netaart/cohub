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

export function invertedListDistances(offsetY: number, contentHeight: number, layoutHeight: number) {
  return {
    distanceToLatest: Math.max(0, offsetY),
    distanceToOldest: Math.max(0, contentHeight - layoutHeight - offsetY),
  };
}
