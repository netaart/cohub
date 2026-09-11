export type BubbleTextLine = { x: number; y: number; width: number; height: number };
export type BubbleTextMetrics = { width: number; height: number; lines: BubbleTextLine[] };

export const BUBBLE_PADDING_X = 12;
export const BUBBLE_META_GAP = 8;
export const BUBBLE_META_DROP = 2;

export function getBubbleMaxWidth(availableWidth: number): number {
  return Math.max(0, Math.min(availableWidth - 24, Math.round(availableWidth * 0.86) - 24));
}

/** Only a single-line body may grow for its clock; never narrow/reflow a paragraph for metadata. */
export function getBubbleMetaLayout(text: BubbleTextMetrics | null, meta: { width: number; height: number } | null, maxWidth: number): { minWidth: number; marginTop: number; inline: boolean } {
  const separate = { minWidth: 0, marginTop: 2, inline: false };
  if (!text || !meta || text.lines.length === 0 || meta.width === 0 || meta.height === 0) return separate;
  const last = text.lines.at(-1)!;
  const minWidth = text.lines.length === 1 ? Math.min(maxWidth, Math.ceil(last.width + BUBBLE_META_GAP + meta.width)) : 0;
  // Use the measured text width, not the requested minWidth: the parent may constrain it further.
  if (last.x + last.width + BUBBLE_META_GAP + meta.width > text.width) return { ...separate, minWidth };
  const top = Math.max(last.y, last.y + last.height - meta.height + BUBBLE_META_DROP);
  return { minWidth, marginTop: top - text.height, inline: true };
}
