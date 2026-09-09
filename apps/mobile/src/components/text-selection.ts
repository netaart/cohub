import { createContext, useContext } from "react";

/**
 * Native text selection is opt-in per message. Always-on selection competes with
 * the Chats/Files panel swipe (the native text view grabs the gesture and the
 * panel pan loses), so the timeline only enables it after an explicit long press.
 */
export type TextSelection = {
  selectable: boolean;
  onRequestSelect?: () => void;
};

const TextSelectionContext = createContext<TextSelection>({ selectable: false });

export const TextSelectionProvider = TextSelectionContext.Provider;

export function useTextSelection() {
  return useContext(TextSelectionContext);
}
