export type TraceValue = string | number | boolean | null | undefined | TraceValue[] | { [key: string]: TraceValue };
export type TraceFields = { [key: string]: TraceValue };
export type ScrollTraceEntry = { sequence: number; elapsedMs: number; event: string; source: string; fields: TraceFields };
const CAPACITY = 4000;

/** In-memory, opt-in diagnostics. Callers must pass geometry/state, never message content. */
export class ChatScrollTrace {
  private entries: ScrollTraceEntry[] = [];
  private next = 0;
  private total = 0;
  private startedAt: string | null = null;
  private startedClock = 0;
  private recording = false;
  private metadata: TraceFields = {};
  private aliases = new Map<string, string>();
  private counters = new Map<string, number>();
  private listeners = new Set<() => void>();

  isRecording = (): boolean => this.recording;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private notify() { this.listeners.forEach((listener) => listener()); }

  start(metadata: TraceFields): void {
    this.reset();
    this.startedAt = new Date().toISOString();
    this.startedClock = performance.now();
    this.metadata = metadata;
    this.recording = true;
    this.record("recording.start", "recorder");
    this.notify();
  }
  pause(): void {
    this.record("recording.pause", "recorder");
    this.recording = false;
    this.notify();
  }
  resume(): void {
    if (!this.startedAt) throw new Error("Start a recording before resuming it.");
    this.recording = true;
    this.record("recording.resume", "recorder");
    this.notify();
  }
  reset(): void {
    this.entries = [];
    this.next = 0;
    this.total = 0;
    this.startedAt = null;
    this.startedClock = 0;
    this.recording = false;
    this.metadata = {};
    this.aliases.clear();
    this.counters.clear();
    this.notify();
  }
  alias(kind: "session" | "message" | "turn", id: string): string {
    const key = `${kind}:${id}`;
    const existing = this.aliases.get(key);
    if (existing) return existing;
    const count = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, count);
    const alias = `${kind}-${count}`;
    this.aliases.set(key, alias);
    return alias;
  }
  record(event: string, source: string, fields: TraceFields = {}): void {
    if (!this.recording) return;
    const entry = { sequence: ++this.total, elapsedMs: Math.round((performance.now() - this.startedClock) * 10) / 10, event, source, fields };
    if (this.entries.length < CAPACITY) this.entries.push(entry);
    else this.entries[this.next] = entry;
    this.next = (this.next + 1) % CAPACITY;
    // Readers poll; recording must not re-render the chat on every scroll event.
  }
  snapshot(): { startedAt: string | null; recording: boolean; dropped: number; entries: ScrollTraceEntry[] } {
    const entries = this.total > CAPACITY ? [...this.entries.slice(this.next), ...this.entries.slice(0, this.next)] : [...this.entries];
    return { startedAt: this.startedAt, recording: this.recording, dropped: this.total - entries.length, entries };
  }
  export(): string {
    const snapshot = this.snapshot();
    return [
      JSON.stringify({ format: "cohub-chat-scroll-v1", startedAt: this.startedAt, exportedAt: new Date().toISOString(), recording: this.recording, capacity: CAPACITY, dropped: snapshot.dropped, metadata: this.metadata, privacy: "No message content, tokens, titles or raw session/message/turn IDs. IDs are recording-local aliases.", limits: "JS events only. Native focus/selection callbacks may not reach JS. Absence of focus events is not proof of absence of native focus. Scroll events use the screen's existing throttle. Window measurements are asynchronous. No native call stacks." }),
      ...snapshot.entries.map((entry) => JSON.stringify(entry)),
    ].join("\n");
  }
}

export const chatScrollTrace = new ChatScrollTrace();
