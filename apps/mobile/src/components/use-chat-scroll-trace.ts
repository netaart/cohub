import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { AppState, Keyboard, type GestureResponderEvent, type ViewProps } from "react-native";
import { chatScrollTrace, type TraceFields } from "@/src/data/chat-scroll-trace";

export function useChatScrollTrace(source: string, getState: () => TraceFields) {
  const recording = useSyncExternalStore(chatScrollTrace.subscribe, chatScrollTrace.isRecording, chatScrollTrace.isRecording);
  const log = useCallback((event: string, fields: TraceFields = {}) => {
    if (chatScrollTrace.isRecording()) chatScrollTrace.record(event, source, { ...getState(), ...fields });
  }, [getState, source]);
  useEffect(() => {
    if (!recording) return;
    log("screen.observe", { keyboardVisible: Keyboard.isVisible(), appState: AppState.currentState });
    const show = Keyboard.addListener("keyboardDidShow", (event) => log("keyboard.show", { height: event.endCoordinates.height, screenY: event.endCoordinates.screenY }));
    const hide = Keyboard.addListener("keyboardDidHide", () => log("keyboard.hide"));
    const app = AppState.addEventListener("change", (state) => log("app.state", { state }));
    return () => { show.remove(); hide.remove(); app.remove(); log("screen.unobserve"); };
  }, [log, recording]);
  return { recording, log };
}

/** Observe touches without installing press/responder handlers that compete with native selection. */
export function useTraceTouches(source: string, identity: () => TraceFields, recording: boolean): ViewProps {
  const touch = useRef<{ started: number; x: number; y: number } | null>(null);
  const moveTime = useRef(0);
  const record = (event: GestureResponderEvent, phase: string) => {
    if (!chatScrollTrace.isRecording()) return;
    const native = event.nativeEvent;
    const now = performance.now();
    if (phase === "start") touch.current = { started: now, x: native.pageX, y: native.pageY };
    if (phase === "move" && now - moveTime.current < 50) return;
    if (phase === "move") moveTime.current = now;
    const fields = identity();
    chatScrollTrace.record(`touch.${phase}`, source, {
      ...fields, target: native.target, nativeTimestamp: native.timestamp,
      pageX: native.pageX, pageY: native.pageY, locationX: native.locationX, locationY: native.locationY,
      touches: native.touches.length, durationMs: touch.current ? Math.round(now - touch.current.started) : null,
      dx: touch.current ? native.pageX - touch.current.x : null, dy: touch.current ? native.pageY - touch.current.y : null,
    });
    if (phase === "start" || phase === "end") {
      event.currentTarget.measureInWindow((x, y, width, height) => {
        chatScrollTrace.record("touch.windowMeasurement", source, { ...fields, phase, x, y, width, height });
      });
    }
  };
  return recording ? {
    onTouchStart: (event) => record(event, "start"),
    onTouchMove: (event) => record(event, "move"),
    onTouchEnd: (event) => record(event, "end"),
    onTouchCancel: (event) => record(event, "cancel"),
    onFocus: (event) => chatScrollTrace.record("focus.observed", source, { ...identity(), target: event.nativeEvent.target }),
    onBlur: (event) => chatScrollTrace.record("blur.observed", source, { ...identity(), target: event.nativeEvent.target }),
  } : {};
}
