import type { CohubClient, RealtimeRoomMember } from "@neta-art/cohub";
import { cardSize } from "../src/camp/scene.ts";
import { type CampEvent, createId, EVENTS, SPIRIT_ROLE } from "../src/camp/protocol.ts";
import { emptyCamp, foldCamp } from "../src/camp/state.ts";
import { FIRE } from "../src/camp/world.ts";

type Stored = {
  id: string;
  type: string;
  data: unknown;
  timestamp: number;
  sequence: number;
  sender: { participantId: string };
  clientEventId: string | null;
};

type Wire =
  | { kind: "hello"; member: RealtimeRoomMember }
  | { kind: "member"; member: RealtimeRoomMember }
  | { kind: "bye"; participantId: string }
  | { kind: "event"; event: Stored };

const historyKey = (code: string) => `ember.preview.history.${code}`;
const zh = new URLSearchParams(location.search).get("lang") === "zh";

class PreviewRoom {
  readonly id: string;
  readonly code: string;
  readonly participantId = crypto.randomUUID();
  readonly createdAt = new Date().toISOString();
  readonly expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  private readonly channel: BroadcastChannel;
  private readonly roster = new Map<string, RealtimeRoomMember>();
  private readonly listeners = new Set<(event: Stored & { self: boolean; roomId: string }) => void>();
  private readonly memberListeners = new Set<(members: RealtimeRoomMember[]) => void>();
  private spirit: PreviewSpirit | null = null;
  private closed = false;
  private readonly onPageHide = () => void this.leave();

  constructor(code: string) {
    this.code = code;
    this.id = `preview-${code}`;
    this.channel = new BroadcastChannel(`ember.preview.${code}`);
    this.channel.onmessage = ({ data }: MessageEvent<Wire>) => this.receive(data);
    this.roster.set(this.participantId, this.self(null));
    this.channel.postMessage({ kind: "hello", member: this.self(null) } satisfies Wire);
    addEventListener("pagehide", this.onPageHide);
  }

  private self(presence: Record<string, unknown> | null): RealtimeRoomMember {
    const existing = this.roster.get(this.participantId);
    return { participantId: this.participantId, joinedAt: existing?.joinedAt ?? new Date().toISOString(), presence, kind: "user" };
  }

  private receive(wire: Wire) {
    if (wire.kind === "hello") {
      this.roster.set(wire.member.participantId, wire.member);
      const self = this.roster.get(this.participantId);
      if (self) this.channel.postMessage({ kind: "member", member: self } satisfies Wire);
      if (this.spirit) this.channel.postMessage({ kind: "member", member: this.spirit.member } satisfies Wire);
    } else if (wire.kind === "member") {
      this.roster.set(wire.member.participantId, wire.member);
    } else if (wire.kind === "bye") {
      this.roster.delete(wire.participantId);
    } else {
      this.deliver(wire.event, false);
      return;
    }
    this.announce();
  }

  announce() {
    const list = this.members;
    for (const listener of this.memberListeners) listener(list);
  }

  get members() {
    return [...this.roster.values()];
  }

  get isClosed() {
    return this.closed;
  }

  setMember(member: RealtimeRoomMember | null, participantId: string) {
    if (member) {
      this.roster.set(participantId, member);
      this.channel.postMessage({ kind: "member", member } satisfies Wire);
    } else {
      this.roster.delete(participantId);
      this.channel.postMessage({ kind: "bye", participantId } satisfies Wire);
    }
    this.announce();
  }

  readHistory(): Stored[] {
    try {
      return JSON.parse(localStorage.getItem(historyKey(this.code)) ?? "[]") as Stored[];
    } catch {
      return [];
    }
  }

  emit(type: string, data: unknown, options: { kept: boolean; sender?: string; clientEventId?: string }) {
    const sender = options.sender ?? this.participantId;
    let sequence = 0;
    const event: Stored = {
      id: crypto.randomUUID(),
      type,
      data,
      timestamp: Date.now(),
      sequence,
      sender: { participantId: sender },
      clientEventId: options.clientEventId ?? null,
    };
    if (options.kept) {
      const history = this.readHistory();
      sequence = (history.at(-1)?.sequence ?? 0) + 1;
      event.sequence = sequence;
      localStorage.setItem(historyKey(this.code), JSON.stringify([...history, event].slice(-1000)));
    }
    this.channel.postMessage({ kind: "event", event } satisfies Wire);
    this.deliver(event, sender === this.participantId);
    if (type === EVENTS.summon && sender === this.participantId && !this.spirit) this.spirit = new PreviewSpirit(this);
    if (type === EVENTS.dismiss) this.spirit?.leave("dismissed");
    if (this.spirit && sender !== this.spirit.id) this.spirit.hear(event);
    return { eventId: event.id, sequence, clientEventId: event.clientEventId };
  }

  private deliver(event: Stored, self: boolean) {
    for (const listener of this.listeners) listener({ ...event, self, roomId: this.id });
    if (!self && this.spirit) this.spirit.hear(event);
  }

  spiritGone() {
    this.spirit = null;
  }

  subscribeAll(listener: (event: Stored & { self: boolean; roomId: string }) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onMembersChanged(listener: (members: RealtimeRoomMember[]) => void) {
    this.memberListeners.add(listener);
    return () => this.memberListeners.delete(listener);
  }

  onStateChange() {
    return () => true;
  }

  onOutOfSync() {
    return () => true;
  }

  async setPresence(presence: Record<string, unknown> | null) {
    this.setMember(this.self(presence), this.participantId);
  }

  async publish(type: string, data: unknown, options?: { clientEventId?: string }) {
    await new Promise((resolve) => setTimeout(resolve, 40 + Math.random() * 60));
    return this.emit(type, data, { kept: true, clientEventId: options?.clientEventId });
  }

  send(type: string, data: unknown) {
    this.emit(type, data, { kept: false });
  }

  async history({ after = 0, limit = 200 }: { after?: number; limit?: number } = {}) {
    const events = this.readHistory()
      .filter((event) => event.sequence > after)
      .slice(0, limit)
      .map((event) => ({ ...event, self: event.sender.participantId === this.participantId, roomId: this.id }));
    return { events, cursor: events.at(-1)?.sequence ?? after, truncated: false };
  }

  async invite() {
    return { invite: `preview-invite-${this.code}`, expiresAt: new Date(Date.now() + 900_000).toISOString() };
  }

  async rtc(): Promise<never> {
    throw Object.assign(new Error("No WebRTC relay in the preview"), { code: "RTC_UNAVAILABLE" });
  }

  async leave() {
    if (this.closed) return;
    this.closed = true;
    removeEventListener("pagehide", this.onPageHide);
    this.spirit?.leave("ended");
    this.channel.postMessage({ kind: "bye", participantId: this.participantId } satisfies Wire);
    this.channel.close();
  }
}

class PreviewSpirit {
  readonly id = crypto.randomUUID();
  member: RealtimeRoomMember;
  private timer: ReturnType<typeof setInterval>;
  private turn = 0;
  private gone = false;
  private readonly name = zh ? "火灵" : "Wisp";

  constructor(private readonly room: PreviewRoom) {
    this.member = this.presence(true, null);
    this.room.setMember(this.member, this.id);
    this.room.emit(EVENTS.awake, { run: this.id }, { kept: true, sender: this.id });
    setTimeout(() => this.speak(zh ? "终于有人唤我了。把想忘掉的写下来，扔进火里，我会把它挂上天。" : "Someone finally called. Write down what you want to let go, toss it in the fire, and I will hang it in the sky."), 1600);
    this.timer = setInterval(() => this.act(), 9000);
  }

  private presence(thinking: boolean, at: { x: number; y: number } | null): RealtimeRoomMember {
    return {
      participantId: this.id,
      joinedAt: new Date().toISOString(),
      kind: "cli",
      presence: { role: SPIRIT_ROLE, name: this.name, color: "#8fe7ff", thinking, ...(at ?? {}) },
    };
  }

  private camp() {
    return foldCamp(
      emptyCamp(),
      this.room.readHistory().map((event): CampEvent => ({ type: event.type, data: event.data, sequence: event.sequence, at: event.timestamp })),
    );
  }

  private think(at: { x: number; y: number } | null, thinking = true) {
    this.member = this.presence(thinking, at);
    this.room.setMember(this.member, this.id);
  }

  private speak(text: string) {
    if (this.gone) return;
    this.think(null, false);
    this.room.emit(EVENTS.speak, { id: createId(), text, name: this.name }, { kept: true, sender: this.id });
  }

  hear(event: Stored) {
    if (this.gone || event.type !== EVENTS.chat) return;
    const data = event.data as { text?: string; toSpirit?: boolean; name?: string } | null;
    if (!data?.toSpirit) return;
    this.think(null);
    setTimeout(
      () => this.speak(zh ? `${data.name ?? "旅人"}，火听见了。再靠近一点。` : `${data.name ?? "Traveller"}, the fire heard you. Come closer.`),
      1400,
    );
  }

  private act() {
    if (this.gone) return;
    const camp = this.camp();
    const unnamed = [...camp.stars.values()].find((star) => !star.name);
    this.turn += 1;
    if (unnamed) {
      this.think({ x: unnamed.x, y: unnamed.y + 60 });
      const names = zh ? ["灯笼守夜人", "迟到的狐狸", "没说出口的话", "北边的歌"] : ["Lantern Keeper", "The Late Fox", "Unsaid Thing", "North Song"];
      setTimeout(() => {
        this.room.emit(EVENTS.name, { id: unnamed.id, name: names[this.turn % names.length] }, { kept: true, sender: this.id });
        this.think(null, false);
      }, 1800);
      return;
    }
    const cards = [...camp.cards.values()].filter((card) => !card.by.spirit);
    if (cards.length >= 2 && camp.cards.size < 30) {
      const [a, b] = [cards[(this.turn * 7) % cards.length], cards[(this.turn * 7 + 1) % cards.length]];
      if (!a || !b || a === b) return;
      const sa = cardSize(a.text);
      const sb = cardSize(b.text);
      const mid = { x: (a.x + sa.width / 2 + b.x + sb.width / 2) / 2, y: (a.y + sa.height / 2 + b.y + sb.height / 2) / 2 + 140 };
      const at = Math.hypot(mid.x - FIRE.x, mid.y - FIRE.y) < 260 ? { x: mid.x, y: mid.y + 220 } : mid;
      this.think(at);
      setTimeout(() => {
        const text = zh ? `「${a.text.slice(0, 12)}」和「${b.text.slice(0, 12)}」，原来是同一件事。` : `“${a.text.slice(0, 18)}” and “${b.text.slice(0, 18)}” were the same story all along.`;
        this.room.emit(
          EVENTS.card,
          { id: createId(), text, x: at.x - 108, y: at.y - 50, by: { name: this.name, color: "#8fe7ff", spirit: true }, sources: [a.id, b.id] },
          { kept: true, sender: this.id },
        );
        this.speak(zh ? "我把两张卡织在一起了。" : "I wove two of your cards together.");
      }, 2200);
      return;
    }
    if (this.turn % 3 === 0) this.speak(zh ? "火很安静。写点什么给我吧。" : "The fire is quiet. Write me something.");
  }

  leave(reason: "dismissed" | "ended") {
    if (this.gone) return;
    this.gone = true;
    clearInterval(this.timer);
    this.room.emit(EVENTS.gone, { reason }, { kept: true, sender: this.id });
    this.room.setMember(null, this.id);
    this.room.spiritGone();
  }
}

export const createPreviewClient = (): CohubClient => {
  const rooms = new Map<string, PreviewRoom>();
  const room = async ({ code }: { code: string }) => {
    const previous = rooms.get(code);
    const current = previous && !previous.isClosed ? previous : new PreviewRoom(code);
    rooms.set(code, current);
    return current;
  };
  const client = {
    context: async () => ({
      app: { id: "preview", slug: "ember", url: `${location.origin}/preview.html`, homeSpace: { id: "preview-space" } },
      viewer: { userUuid: "preview" },
      invocation: { spaceId: "preview-space" },
      shell: { surface: "workspace", space: { id: "preview-space" }, session: null, turn: null },
      locale: zh ? "zh-CN" : "en",
      appearance: { colorScheme: "dark", theme: "dark", tokens: {}, reducedMotion: false },
      window: { visible: true },
    }),
    app: {
      onContextChanged: () => () => undefined,
      devices: { request: async () => "granted" as const },
      actions: { run: async () => ({ taskRunId: "preview", action: "spirit", status: "pending" as const }) },
      realtime: { joinRoom: room, createRoom: room },
    },
    tasks: { get: async () => ({ run: { status: "running" } }) },
  };
  return client as unknown as CohubClient;
};
