import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { StreamRevealController } from "@/src/data/stream-reveal";

/**
 * Advances streamed text by grapheme at a bounded, adaptive pace instead of
 * rendering every network chunk. Non-streaming text passes through untouched,
 * and a rewrite (correction, history reload) shows in full without replaying.
 *
 * The target is synced in a layout effect so the first painted frame already
 * carries the authoritative prefix instead of an empty bubble. Non-streaming
 * text never segments graphemes, so mounting a long history stays cheap.
 */
export function useRevealedStreamText(source: string, streaming: boolean) {
  const [controller] = useState(() => new StreamRevealController());
  const displayed = useSyncExternalStore(controller.subscribe, controller.getDisplayed);

  useLayoutEffect(() => {
    if (streaming) controller.setTarget(source);
    else controller.flush(source);
  }, [controller, source, streaming]);

  useLayoutEffect(() => () => controller.stop(), [controller]);

  if (!streaming) return source;
  return source.startsWith(displayed) ? displayed : source;
}
