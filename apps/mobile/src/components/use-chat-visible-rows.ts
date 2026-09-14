import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { View, ViewToken } from "react-native";
import { isChatRowVisible } from "@/src/data/chat-scroll";

type VisibleRows = { viewableItems: ViewToken[] };

// FlatList viewability includes rows behind overlay chrome. Measure candidates before
// advancing read state or completing a turn jump, including while the keyboard resizes.
export function useChatVisibleRows({ viewportRef, topInset, bottomInset, onVisible }: {
  viewportRef: RefObject<View | null>;
  topInset: number;
  bottomInset: number;
  onVisible: (info: VisibleRows) => void;
}) {
  const rows = useRef(new Map<string, View>());
  const candidates = useRef<ViewToken[]>([]);
  const generation = useRef(0);
  const measureVisibleRows = useCallback(() => {
    const request = ++generation.current;
    const items = candidates.current;
    viewportRef.current?.measureInWindow((_x, y, _width, height) => {
      if (request !== generation.current) return;
      const visible: ViewToken[] = [];
      let remaining = items.length;
      if (!remaining) { onVisible({ viewableItems: visible }); return; }
      const complete = () => {
        remaining -= 1;
        if (remaining === 0 && request === generation.current) onVisible({ viewableItems: visible });
      };
      for (const item of items) {
        const row = rows.current.get(item.key);
        if (!row) { complete(); continue; }
        row.measureInWindow((_rowX, rowY, _rowWidth, rowHeight) => {
          if (isChatRowVisible(rowY, rowHeight, y + topInset, height - topInset - bottomInset)) visible.push(item);
          complete();
        });
      }
    });
  }, [bottomInset, onVisible, topInset, viewportRef]);
  useEffect(() => {
    measureVisibleRows();
    return () => { generation.current += 1; };
  }, [measureVisibleRows]);
  const onViewableItemsChanged = useCallback(({ viewableItems }: VisibleRows) => {
    candidates.current = viewableItems;
    measureVisibleRows();
  }, [measureVisibleRows]);
  const trackRow = useCallback((key: string, row: View | null) => {
    if (row) rows.current.set(key, row);
    else rows.current.delete(key);
  }, []);
  return { onViewableItemsChanged, measureVisibleRows, trackRow };
}
