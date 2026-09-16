import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { useEffect, useState } from "react";
import { AppState, Platform } from "react-native";
import { config } from "@/src/config";
import { clearDebugSession, loadDebugEvents, loadDebugSessions, saveDebugEvent, upsertDebugSession, type DebugEventRow } from "@/src/data/local-db";
import { chatScrollTrace, setDebugTraceSink } from "@/src/data/chat-scroll-trace";

const ENABLED_KEY = "cohub.debug.diagnostics.enabled";
const EVENT_CAPACITY = 4000;

type DebugFields = Record<string, unknown>;
type ActiveSession = { id: string; startedAt: string; sequence: number; dropped: number; events: DebugEventRow[]; writes: Promise<void> };
export type FeedbackInput = { description: string; includeSession: boolean; includeConversation: boolean };
export type FeedbackReceipt = { id: string };
export type DebugSnapshot = { sessionId: string; startedAt: string; dropped: number; events: DebugEventRow[] };

let enabled = false;
let activeSession: ActiveSession | null = null;
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

function updateMetadata() {
  try {
    return { runtimeVersion: Updates.runtimeVersion ?? null, updateId: Updates.updateId ?? null };
  } catch {
    return { runtimeVersion: null, updateId: null };
  }
}

function startChatTrace() {
  if (!chatScrollTrace.isRecording()) chatScrollTrace.start({ diagnostics: true, platform: Platform.OS });
}

function stopChatTrace() {
  if (!chatScrollTrace.isRecording()) return;
  chatScrollTrace.pause();
  chatScrollTrace.reset();
}

async function ensureLoaded() {
  if (loadPromise) return loadPromise;
  loadPromise = AsyncStorage.getItem(ENABLED_KEY).then((value) => {
    enabled = value === "true";
    setDebugTraceSink(enabled ? (name, fields) => record(name, fields) : null);
    if (enabled) void startSession();
    return enabled;
  }).finally(() => { loadPromise = null; });
  return loadPromise;
}

async function startSession() {
  if (activeSession) {
    startChatTrace();
    return activeSession;
  }
  const session: ActiveSession = { id: newId("debug"), startedAt: new Date().toISOString(), sequence: 0, dropped: 0, events: [], writes: Promise.resolve() };
  activeSession = session;
  await upsertDebugSession({ sessionId: session.id, startedAt: session.startedAt, updatedAt: Date.now(), closedAt: null, uploadedAt: null });
  record("diagnostics.session.started", { platform: Platform.OS, appVersion: Constants.expoConfig?.version ?? null, ...updateMetadata() });
  startChatTrace();
  return session;
}

export async function setDebugDiagnosticsEnabled(value: boolean) {
  if (value) {
    enabled = true;
    setDebugTraceSink((name, fields) => record(name, fields));
    await AsyncStorage.setItem(ENABLED_KEY, "true");
    await startSession();
    return;
  }
  if (activeSession) {
    record("diagnostics.session.stopping");
    stopChatTrace();
    const session = activeSession;
    await session.writes;
    await clearDebugSession(session.id);
    activeSession = null;
  }
  enabled = false;
  setDebugTraceSink(null);
  await AsyncStorage.setItem(ENABLED_KEY, "false");
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
  if (session.events.length === EVENT_CAPACITY) {
    session.events.shift();
    session.dropped += 1;
  }
  session.events.push(event);
  session.writes = session.writes.then(() => saveDebugEvent(event)).catch(() => undefined);
}

export async function snapshot(): Promise<DebugSnapshot | null> {
  await ensureLoaded();
  // A frozen screen kills the JS thread before anything can run, so the crashed
  // session stays open in SQLite. Prefer the most recent session that actually
  // has events: usually the crash itself, since the restarted app opens a new one.
  if (activeSession && activeSession.events.length > 0) {
    await activeSession.writes;
    return { sessionId: activeSession.id, startedAt: activeSession.startedAt, dropped: activeSession.dropped, events: [...activeSession.events] };
  }
  const sessions = await loadDebugSessions();
  for (const session of sessions) {
    if (activeSession?.id === session.sessionId) continue;
    const events = await loadDebugEvents(session.sessionId);
    if (events.length === 0) continue;
    if (session.closedAt === null) await upsertDebugSession({ ...session, closedAt: new Date().toISOString() });
    return { sessionId: session.sessionId, startedAt: session.startedAt, dropped: Math.max(0, events.at(-1)!.sequence - events.length), events };
  }
  return null;
}

/** JSON Lines so a long session can be inspected line by line or grepped for a phase. */
export function formatDiagnostics(snapshot: DebugSnapshot): string {
  return [
    JSON.stringify({ format: "cohub-diagnostics-v1", sessionId: snapshot.sessionId, startedAt: snapshot.startedAt, dropped: snapshot.dropped, events: snapshot.events.length, privacy: "Diagnostic events only. Fields whose names look like message text, titles, tokens or bodies are stripped before they are stored." }),
    ...snapshot.events.map((event) => JSON.stringify({ at: event.timestamp, seq: event.sequence, name: event.name, payload: event.payload })),
  ].join("\n");
}

/** Local export for sharing or copying; no server round trip. */
export async function exportDiagnostics(): Promise<string> {
  const current = await snapshot();
  if (!current) throw new Error("Enable debug diagnostics and reproduce the issue first.");
  return formatDiagnostics(current);
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
      session: { id: current.sessionId, startedAt: current.startedAt, dropped: current.dropped, events: current.events },
      app: { version: Constants.expoConfig?.version ?? null, platform: Platform.OS, osVersion: String(Platform.Version), ...updateMetadata() },
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
