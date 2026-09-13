import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { useEffect, useState } from "react";
import { AppState, Platform } from "react-native";
import { config } from "@/src/config";
import { clearDebugSession, loadDebugEvents, saveDebugEvent, upsertDebugSession, type DebugEventRow } from "@/src/data/local-db";
import { setDebugTraceSink } from "@/src/data/chat-scroll-trace";

const ENABLED_KEY = "cohub.debug.diagnostics.enabled";

type DebugFields = Record<string, unknown>;
export type FeedbackInput = { description: string; includeSession: boolean; includeConversation: boolean };
export type FeedbackReceipt = { id: string };
export type DebugSnapshot = { sessionId: string; startedAt: string; events: DebugEventRow[] };

let enabled = false;
let activeSession: { id: string; startedAt: string; sequence: number } | null = null;
let loadPromise: Promise<boolean> | null = null;

function newId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth-limited]";
  if (typeof value === "string") return value.length > 600 ? `${value.slice(0, 600)}…` : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (/^(token|secret|password|cookie|authorization|body|content|data|base64|text|title|url)$/i.test(key) || /(?:access|refresh)[_-]?token|message[_-]?text|assistant[_-]?text|user[_-]?text/i.test(key)) continue;
      output[key] = sanitize(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

async function ensureLoaded() {
  if (loadPromise) return loadPromise;
  loadPromise = AsyncStorage.getItem(ENABLED_KEY).then((value) => {
    enabled = value === "true";
    setDebugTraceSink(enabled ? (name, fields) => record(name, fields) : null);
    return enabled;
  }).finally(() => { loadPromise = null; });
  return loadPromise;
}

async function startSession() {
  if (activeSession) return activeSession;
  const session = { id: newId("debug"), startedAt: new Date().toISOString(), sequence: 0 };
  activeSession = session;
  await upsertDebugSession({ sessionId: session.id, startedAt: session.startedAt, updatedAt: Date.now(), closedAt: null, uploadedAt: null });
  record("diagnostics.session.started", { platform: Platform.OS, appVersion: Constants.expoConfig?.version ?? null, updateId: Constants.expoConfig?.extra?.updateId ?? null });
  return session;
}

export async function setDebugDiagnosticsEnabled(value: boolean) {
  enabled = value;
  setDebugTraceSink(value ? (name, fields) => record(name, fields) : null);
  await AsyncStorage.setItem(ENABLED_KEY, String(value));
  if (value) await startSession();
  else if (activeSession) {
    await clearDebugSession(activeSession.id);
    activeSession = null;
  }
}

export async function isDebugDiagnosticsEnabled() {
  return ensureLoaded();
}

export function record(name: string, fields: DebugFields = {}) {
  if (!enabled || !activeSession) return;
  const session = activeSession;
  const event: DebugEventRow = {
    sessionId: session.id,
    sequence: ++session.sequence,
    timestamp: new Date().toISOString(),
    name,
    payload: JSON.stringify(sanitize(fields)),
  };
  void saveDebugEvent(event).catch(() => undefined);
}

export async function snapshot(): Promise<DebugSnapshot | null> {
  await ensureLoaded();
  if (!activeSession) return null;
  return { sessionId: activeSession.id, startedAt: activeSession.startedAt, events: await loadDebugEvents(activeSession.id) };
}

export async function submitFeedback(input: FeedbackInput): Promise<FeedbackReceipt> {
  const description = input.description.trim();
  if (!description) throw new Error("Feedback description is required.");
  const current = await snapshot();
  if (!current) throw new Error("Enable debug diagnostics before submitting feedback.");
  const response = await fetch(`${config.diagnosticsOrigin}/v1/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      feedbackId: newId("feedback"),
      description: description.slice(0, 4000),
      includeSession: input.includeSession,
      includeConversation: false,
      session: { id: current.sessionId, startedAt: current.startedAt, events: current.events },
      app: { version: Constants.expoConfig?.version ?? null, platform: Platform.OS, osVersion: String(Platform.Version), updateId: Constants.expoConfig?.extra?.updateId ?? null },
    }),
  });
  if (!response.ok) throw new Error(`Feedback upload failed (${response.status}).`);
  const payload = await response.json() as { id?: unknown };
  if (typeof payload.id !== "string" || !payload.id) throw new Error("Feedback upload returned no id.");
  record("diagnostics.feedback.submitted", { feedbackId: payload.id });
  return { id: payload.id };
}

export function useDebugDiagnostics() {
  const [value, setValue] = useState(enabled);
  useEffect(() => {
    let active = true;
    void ensureLoaded().then((loaded) => { if (active) { setValue(loaded); if (loaded) void startSession(); } });
    return () => { active = false; };
  }, []);
  return { enabled: value, setEnabled: async (next: boolean) => { await setDebugDiagnosticsEnabled(next); setValue(next); }, record, submitFeedback };
}

export function useDebugDiagnosticsLifecycle() {
  useDebugDiagnostics();
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => record(`app.${state === "active" ? "foregrounded" : "backgrounded"}`));
    return () => subscription.remove();
  }, []);
}
