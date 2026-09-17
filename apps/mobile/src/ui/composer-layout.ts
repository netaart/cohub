export const COMPOSER_TEXT_PADDING = 8;
/** Empty collapsed composer chrome in `src/ui.tsx` (`composerWrap` + `composer` + input + toolbar), excluding the home-indicator inset. */
export const COMPOSER_CHROME_HEIGHT = 132;

export function collapsedComposerHeight(bottomInset: number) {
  return COMPOSER_CHROME_HEIGHT + Math.max(0, bottomInset);
}

export type ComposerLayoutInput = {
  text: string;
  contentHeight: number;
  lineHeight: number;
  availableHeight: number;
  expanded: boolean;
};

export type ComposerLayout = {
  expanded: boolean;
  showExpandButton: boolean;
  height: number;
  scrollEnabled: boolean;
};

export function shouldAutoExpandComposer(input: {
  value: string;
  expanded: boolean;
  scrollEnabled: boolean;
  lastUserText: string;
  autoExpandedFor: string | null;
}): boolean {
  if (!input.value || input.expanded || !input.scrollEnabled) return false;
  // Voice finals update `value` from JS without an onChangeText, and the overflowing final
  // regularly lands after the mic stopped, so the append itself (not active recording)
  // identifies dictation text.
  if (input.value === input.lastUserText) return false;
  return input.autoExpandedFor !== input.value;
}

export function getComposerLayout(input: ComposerLayoutInput): ComposerLayout {
  const hasText = input.text.length > 0;
  const expanded = hasText && input.expanded;
  const minHeight = Math.max(44, input.lineHeight + COMPOSER_TEXT_PADDING);
  const expandedHeight = Math.max(minHeight, Math.min(320, Math.floor(input.availableHeight * 0.45)));
  const maxHeight = expanded ? expandedHeight : Math.max(minHeight, Math.min(120, expandedHeight));
  const contentHeight = hasText ? input.contentHeight : 0;
  const height = expanded ? maxHeight : Math.min(maxHeight, Math.max(minHeight, Math.ceil(contentHeight)));
  // Native measurements include soft wraps; the threshold tolerates platform rounding.
  const multiline = hasText && (input.text.includes("\n") || contentHeight > input.lineHeight * 1.5 + COMPOSER_TEXT_PADDING);

  return {
    expanded,
    showExpandButton: expanded || multiline,
    height,
    scrollEnabled: contentHeight > height,
  };
}
