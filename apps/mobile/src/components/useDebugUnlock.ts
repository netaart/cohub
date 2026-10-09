import { useCallback, useEffect, useRef } from "react";

const REQUIRED_TAPS = 5;
const RESET_AFTER_MS = 1_200;

/** Fires `onUnlock` after five consecutive taps within the reset window. */
export function useDebugUnlock(onUnlock: () => void) {
  const tapsRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  return useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    tapsRef.current += 1;
    if (tapsRef.current >= REQUIRED_TAPS) {
      tapsRef.current = 0;
      timerRef.current = null;
      onUnlock();
      return;
    }
    timerRef.current = setTimeout(() => {
      tapsRef.current = 0;
      timerRef.current = null;
    }, RESET_AFTER_MS);
  }, [onUnlock]);
}
