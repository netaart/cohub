import { useEffect, useRef, useState } from "react";
import { StreamRevealController } from "@/src/data/stream-reveal";

/**
 * Smooths streamed text: the incoming source updates at patch frequency while
 * the returned value advances word by word and re-renders at most every
 * `COMMIT_INTERVAL_MS`. Non-streaming sources pass through unchanged.
 */
export function useRevealedStreamText(source: string, streaming: boolean) {
  const [displayed, setDisplayed] = useState(source);
  const controllerRef = useRef<StreamRevealController | null>(null);

  useEffect(() => {
    if (!streaming) return;
    const controller = new StreamRevealController();
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(setDisplayed);
    return () => {
      unsubscribe();
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [streaming]);

  useEffect(() => {
    if (!streaming) return;
    controllerRef.current?.setTarget(source);
  }, [source, streaming]);

  return streaming ? displayed : source;
}
