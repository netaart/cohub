import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { useEffect, useState } from "react";
import { AppState, Platform } from "react-native";
import { config } from "@/src/config";
import { clearAllDebugSessions, loadDebugEvents, loadDebugSessions, pruneDebugSessions, saveDebugEvent, upsertDebugSession, type DebugEventRow } from "@/src/data/local-db";
import { chatScrollTrace, setDebugTraceSink } from "@/src/data/chat-scroll-trace";

const ENABLED_KEY = "cohub.debug.diagnostics.enabled";
const EVENT_CAPACITY = 4000;
/** Sessions kept on disk; older ones are pruned when a new one starts. */
const SESSION_RETENTION = 5;
/** Sessions always write these on start, so alone they are not evidence of activity. */
const STARTUP_EVENTS = new Set(["diagnostics.session.started", "chat.scroll.recording.start"]);

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

function stopChatTrace() {
  if (!chatScrollTrace.isRecording()) return;
  chatScrollTrace.pause();
  chatScrollTrace.reset();
}

async function ensureLoaded() {
  if (loadPromise) return loadPromise;
  loadPromise = AsyncStorage.getItem(ENABLED_KEY).then((value) => {
    // Recording is on by default so a freeze can be captured without enabling anything first;
    // only an explicit `false` (the switch turned off) disables it.
    enabled = value !== "false";
    setDebugTraceSink(enabled ? (name, fields) => record(name, fields) : null);
    if (enabled) void startSession();
    return enabled;
  }).finally(() => { loadPromise = null; });
  return loadPromise;
}

async function startSession() {
  if (activeSession) return activeSession;
  const session: ActiveSession = { id: newId("debug"), startedAt: new Date().toISOString(), sequence: 0, dropped: 0, events: [], writes: Promise.resolve() };
  activeSession = session;
  await upsertDebugSession({ sessionId: session.id, startedAt: session.startedAt, updatedAt: Date.now(), closedAt: null, uploadedAt: null });
  // A freeze leaves its session open in SQLite; prune only after the new session exists so
  // later launches cannot push the crashed one out of the retention window.
  void pruneDebugSessions(SESSION_RETENTION).catch(() => undefined);
  record("diagnostics.session.started", { platform: Platform.OS, appVersion: Constants.expoConfig?.version ?? null, ...updateMetadata() });
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
  // Turning recording off is an opt-out: drop every retained session, not just the live one.
  enabled = false;
  setDebugTraceSink(null);
  const session = activeSession;
  activeSession = null;
  stopChatTrace();
  await AsyncStorage.setItem(ENABLED_KEY, "false");
  if (session) await session.writes;
  await clearAllDebugSessions();
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

function hasCapturedActivity(snapshot: DebugSnapshot) {
  return snapshot.events.some((event) => !STARTUP_EVENTS.has(event.name));
}

async function loadActiveSnapshot(): Promise<DebugSnapshot | null> {
  if (!activeSession) return null;
  const session = activeSession;
  await session.writes;
  // Copy: the live session keeps appending after the snapshot is handed out.
  return { sessionId: session.id, startedAt: session.startedAt, dropped: session.dropped, events: [...session.events] };
}

async function loadStoredSnapshots(): Promise<DebugSnapshot[]> {
  const sessions = await loadDebugSessions();
  const snapshots: DebugSnapshot[] = [];
  for (const session of sessions) {
    if (activeSession?.id === session.sessionId) continue;
    const events = await loadDebugEvents(session.sessionId);
    if (events.length === 0) continue;
    if (session.closedAt === null) await upsertDebugSession({ ...session, closedAt: new Date().toISOString() });
    snapshots.push({ sessionId: session.sessionId, startedAt: session.startedAt, dropped: Math.max(0, events.at(-1)!.sequence - events.length), events });
  }
  return snapshots;
}

/** The one session feedback attaches: the live session when it captured activity, otherwise the
most recent stored one. A relaunch writes only startup markers, so without this the frozen
session it replaced would always be shadowed. */
export async function snapshot(): Promise<DebugSnapshot | null> {
  await ensureLoaded();
  const active = await loadActiveSnapshot();
  const stored = await loadStoredSnapshots();
  if (active && hasCapturedActivity(active)) return active;
  return stored.find(hasCapturedActivity) ?? active ?? stored[0] ?? null;
}

/** Every retained session, newest first: the live one followed by the stored ones. */
export async function listSnapshots(): Promise<DebugSnapshot[]> {
  await ensureLoaded();
  const active = await loadActiveSnapshot();
  return [...(active && active.events.length > 0 ? [active] : []), ...await loadStoredSnapshots()];
}

/** JSON Lines, one `cohub-diagnostics-v1` header per session followed by its events, so a long
export can be inspected line by line or grepped for a phase. */
export function formatDiagnostics(snapshots: DebugSnapshot[]): string {
  return snapshots.flatMap((snapshot) => [
    JSON.stringify({ format: "cohub-diagnostics-v1", sessionId: snapshot.sessionId, startedAt: snapshot.startedAt, dropped: snapshot.dropped, events: snapshot.events.length, privacy: "Diagnostic events only. Fields whose names look like message text, titles, tokens or bodies are stripped before they are stored." }),
    ...snapshot.events.map((event) => JSON.stringify({ at: event.timestamp, seq: event.sequence, name: event.name, payload: event.payload })),
  ]).join("\n");
}

/** Local export of every retained session for sharing or copying; no server round trip. */
export async function exportDiagnostics(): Promise<string> {
  const snapshots = await listSnapshots();
  if (snapshots.length === 0) throw new Error("No diagnostic sessions recorded yet. Reproduce the issue, then export again.");
  return formatDiagnostics(snapshots);
}

export async function submitFeedback(input: FeedbackInput): Promise<FeedbackReceipt> {
  const description = input.description.trim();
  if (!description) throw new Error("Feedback description is required.");
  const current = await snapshot();
  if (!current) throw new Error("No diagnostic session recorded yet. Reproduce the issue before submitting feedback.");
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
