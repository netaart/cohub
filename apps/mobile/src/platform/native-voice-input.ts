import { fromUint8Array } from "js-base64";
import { requestRecordingPermissionsAsync, useAudioStream } from "expo-audio";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { config } from "@/src/config";

type VoiceCallbacks = {
  getAccessToken: () => Promise<string | null>;
  onFinal: (text: string) => void;
};

type VoiceMessage = {
  type?: string;
  payload?: { text?: unknown; message?: unknown };
};

function voiceUrl() {
  return config.gatewayOrigin.replace(/\/ws$/, "/asr/ws");
}

function asText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function voiceErrorMessage(error: unknown, fallback = "Voice input failed") {
  const message = error instanceof Error ? error.message.trim() : "";
  if (/AudioStream|shared object|already released|cannot be cast/i.test(message)) {
    return "Voice input became unavailable. Try again.";
  }
  return message || fallback;
}

export function useNativeVoiceInput({ getAccessToken, onFinal }: VoiceCallbacks) {
  const socketRef = useRef<WebSocket | null>(null);
  const onFinalRef = useRef(onFinal);
  const waitingRef = useRef<((message: VoiceMessage) => void) | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamStopRequestedRef = useRef(false);
  const streamStartedRef = useRef(false);
  const streamOwnerRef = useRef<number | null>(null);
  const operationRef = useRef(0);
  const startInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const [isStarting, setIsStarting] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { stream } = useAudioStream({
    sampleRate: 16_000,
    channels: 1,
    encoding: "int16",
    onBuffer: (buffer) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({
        type: "asr.audio",
        payload: { audio: fromUint8Array(new Uint8Array(buffer.data)) },
      }));
    },
  });

  useEffect(() => {
    onFinalRef.current = onFinal;
  }, [onFinal]);

  const closeSocket = useCallback(() => {
    waitingRef.current = null;
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    stopTimerRef.current = null;
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close(1000, "voice stopped");
  }, []);

  const stopOwnedStream = useCallback(
    (owner: number) => {
      if (!streamStartedRef.current || streamOwnerRef.current !== owner) return;
      streamStartedRef.current = false;
      streamOwnerRef.current = null;
      streamStopRequestedRef.current = true;
      try {
        stream.stop();
      } catch (caught) {
        if (mountedRef.current) setError(voiceErrorMessage(caught, "Voice input stopped unexpectedly. Try again."));
      }
    },
    [stream],
  );

  const stopStream = useCallback(() => {
    if (streamStopRequestedRef.current) return;
    streamStopRequestedRef.current = true;
    const owner = streamOwnerRef.current;
    if (owner !== null) stopOwnedStream(owner);
  }, [stopOwnedStream]);

  const start = useCallback(async () => {
    if (Platform.OS === "web" || startInFlightRef.current || isStarting || isRecording) return;
    if (streamStartedRef.current) return;

    const operation = operationRef.current + 1;
    operationRef.current = operation;
    startInFlightRef.current = true;
    // A prior stop may still have a delayed server close callback. Clear both
    // the timer and socket before assigning this operation's connection.
    closeSocket();
    streamStopRequestedRef.current = false;
    streamOwnerRef.current = null;
    const isCurrent = () => mountedRef.current && operationRef.current === operation;
    setError(null);
    setIsStarting(true);

    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error("Microphone permission is required for voice input");
      const token = await getAccessToken();
      if (!isCurrent()) return;
      if (!token) throw new Error("Sign in to use voice input");

      const socket = new WebSocket(voiceUrl());
      socketRef.current = socket;
      const waitFor = (expected: string) => new Promise<VoiceMessage>((resolve, reject) => {
        waitingRef.current = (message) => {
          if (!isCurrent() || socketRef.current !== socket) return;
          if (message.type === expected) {
            waitingRef.current = null;
            resolve(message);
          } else if (message.type === "asr.error") {
            waitingRef.current = null;
            reject(new Error(asText(message.payload?.message) || "Voice input failed"));
          }
        };
        socket.onerror = () => {
          waitingRef.current = null;
          reject(new Error("Voice service unavailable"));
        };
        socket.onclose = () => {
          waitingRef.current = null;
          reject(new Error("Voice connection closed"));
          if (isCurrent()) {
            stopStream();
            setIsRecording(false);
          }
        };
      });

      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error("Voice service unavailable"));
        socket.onclose = () => reject(new Error("Voice connection closed"));
      });
      if (!isCurrent()) return;

      socket.onmessage = (event) => {
        if (!isCurrent() || socketRef.current !== socket) return;
        let message: VoiceMessage;
        try {
          message = JSON.parse(String(event.data)) as VoiceMessage;
        } catch {
          setError("Voice service returned invalid data");
          return;
        }
        if (waitingRef.current) {
          waitingRef.current(message);
          return;
        }
        const text = asText(message.payload?.text);
        if (message.type === "asr.partial") setPartial(text);
        if (message.type === "asr.final") {
          setPartial("");
          if (text.trim()) onFinalRef.current(text.trim());
        }
        if (message.type === "asr.done") {
          setPartial("");
          stopStream();
          setIsRecording(false);
          closeSocket();
        }
        if (message.type === "asr.error") {
          setError(asText(message.payload?.message) || "Voice input failed");
          stopStream();
          setIsRecording(false);
          closeSocket();
        }
      };

      const authReady = waitFor("system.auth.ok");
      socket.send(JSON.stringify({ type: "auth", payload: { token } }));
      await authReady;
      if (!isCurrent()) return;
      const asrReady = waitFor("asr.started");
      socket.send(JSON.stringify({ type: "asr.start" }));
      await asrReady;
      if (!isCurrent()) return;
      await stream.start();
      streamStartedRef.current = true;
      streamOwnerRef.current = operation;
      if (!isCurrent() || streamStopRequestedRef.current) {
        stopOwnedStream(operation);
        return;
      }
      setIsRecording(true);
    } catch (caught) {
      if (!isCurrent()) {
        stopOwnedStream(operation);
        return;
      }
      stopOwnedStream(operation);
      closeSocket();
      setError(voiceErrorMessage(caught));
      setIsRecording(false);
    } finally {
      startInFlightRef.current = false;
      if (mountedRef.current) setIsStarting(false);
    }
  }, [closeSocket, getAccessToken, isRecording, isStarting, stopOwnedStream, stopStream, stream]);

  const stop = useCallback(() => {
    operationRef.current += 1;
    stopStream();
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "asr.stop" }));
      stopTimerRef.current = setTimeout(closeSocket, 5_000);
    } else {
      closeSocket();
    }
    if (mountedRef.current) {
      setPartial("");
      setIsRecording(false);
      if (!startInFlightRef.current) setIsStarting(false);
    }
  }, [closeSocket, stopStream]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationRef.current += 1;
      streamStopRequestedRef.current = true;
      streamOwnerRef.current = null;
      closeSocket();
      // useAudioStream's shared-object lifecycle releases the native stream on
      // unmount. Calling stream.stop() here would race that release and throw.
    };
  }, [closeSocket, stream]);

  return {
    start,
    stop,
    isStarting,
    isRecording,
    partial,
    error,
  };
}
