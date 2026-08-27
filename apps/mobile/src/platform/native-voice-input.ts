import { fromUint8Array } from "js-base64";
import { useAudioStream, requestRecordingPermissionsAsync } from "expo-audio";
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

export function useNativeVoiceInput({ getAccessToken, onFinal }: VoiceCallbacks) {
  const socketRef = useRef<WebSocket | null>(null);
  const onFinalRef = useRef(onFinal);
  const waitingRef = useRef<((message: VoiceMessage) => void) | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const start = useCallback(async () => {
    if (Platform.OS === "web" || isStarting || isRecording) return;
    setError(null);
    setIsStarting(true);
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error("Microphone permission is required for voice input");
      const token = await getAccessToken();
      if (!token) throw new Error("Sign in to use voice input");

      const socket = new WebSocket(voiceUrl());
      socketRef.current = socket;
      const waitFor = (expected: string) => new Promise<VoiceMessage>((resolve, reject) => {
        waitingRef.current = (message) => {
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
          setIsRecording(false);
          setIsStarting(false);
        };
      });

      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error("Voice service unavailable"));
        socket.onclose = () => reject(new Error("Voice connection closed"));
      });
      socket.onmessage = (event) => {
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
          setIsRecording(false);
          closeSocket();
        }
        if (message.type === "asr.error") {
          setError(asText(message.payload?.message) || "Voice input failed");
          setIsRecording(false);
          closeSocket();
        }
      };
      const authReady = waitFor("system.auth.ok");
      socket.send(JSON.stringify({ type: "auth", payload: { token } }));
      await authReady;
      const asrReady = waitFor("asr.started");
      socket.send(JSON.stringify({ type: "asr.start" }));
      await asrReady;
      await stream.start();
      setIsRecording(true);
    } catch (caught) {
      closeSocket();
      setError(caught instanceof Error ? caught.message : "Voice input failed");
      setIsRecording(false);
    } finally {
      setIsStarting(false);
    }
  }, [closeSocket, getAccessToken, isRecording, isStarting, stream]);

  const stop = useCallback(() => {
    stream.stop();
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "asr.stop" }));
      stopTimerRef.current = setTimeout(closeSocket, 5_000);
    } else {
      closeSocket();
    }
    setIsRecording(false);
  }, [closeSocket, stream]);

  useEffect(() => () => {
    stream.stop();
    closeSocket();
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
