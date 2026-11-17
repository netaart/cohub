import { type AppRuntimeContext, type CohubClient, createCohubClient } from "@neta-art/cohub";
import { CampDocument } from "../camp/document.ts";
import { decodeInk, encodeInk } from "../camp/ink.ts";
import {
  type CampEvent,
  createId,
  EVENTS,
  LIMITS,
  readChat,
  readSnapshot,
  readText,
  WOOD_COOLDOWN_MS,
} from "../camp/protocol.ts";
import { hasCampHistory, restoreCamp } from "../camp/restore.ts";
import { clampCard, cardSize } from "../camp/scene.ts";
import { type CampState, emptyCamp, encodeSnapshot, type Outcome, rebase, reduce, SNAPSHOT_EVERY } from "../camp/state.ts";
import { FIRE, hash, heatAt, type Point } from "../camp/world.ts";
import { localeFor, type Locale, type Messages, messagesFor } from "../i18n.ts";
import { CampSession, type Member, type Transport } from "../net/session.ts";
import { CampBoard } from "./board.ts";
import { normalizeCode, randomCode, spaceCode } from "./code.ts";
import { CampMedia, type DeviceNotice } from "./media.svelte.ts";
import { SpiritControl } from "./spirit.svelte.ts";
import {
  clearCachedCamp,
  flushCachedCamp,
  type Profile,
  readCachedCamp,
  readIntent,
  readProfile,
  writeCachedCamp,
  writeIntent,
  writeProfile,
} from "./storage.ts";
import { World } from "./world.ts";

export type Phase = "boot" | "lobby" | "joining" | "camp" | "broken";

export type LogLine = { id: string; kind: "chat" | "spirit" | "camp"; name: string; text: string; color: string; at: number };

export type StarTip = { id: string; text: string; name: string; by: string; color: string; x: number; y: number };

type Pending = { clientEventId: string; type: string; data: unknown; at: number };

export const CAMPER_COLORS = ["#f4a261", "#8ecae6", "#b8e0a0", "#e9c46a", "#c9b6f5", "#f2a0a0", "#7fd1c1", "#e8b4d8"] as const;

const LOG_LIMIT = 120;
const NOTICE_MS = 5000;
const PRESENCE_MS = 2500;
const PENDING_TTL_MS = 20_000;
const NEAR_SPIRIT = 300;

export class Camp {
  readonly client: CohubClient;
  readonly world: World;
  readonly media: CampMedia;
  readonly spirit: SpiritControl;

  phase = $state<Phase>("boot");
  context = $state.raw<AppRuntimeContext | null>(null);
  locale = $state<Locale>("en");
  t = $state.raw<Messages>(messagesFor("en"));
  code = $state("");
  linked = $state(false);
  profile = $state.raw<Profile>({ name: "", color: CAMPER_COLORS[0] });
  joinError = $state<string | null>(null);
  members = $state.raw<Member[]>([]);
  transport = $state<Transport>("connecting");
  notice = $state.raw<{ text: string; tone: "info" | "error" } | null>(null);
  log = $state.raw<LogLine[]>([]);
  unread = $state(0);
  inkMode = $state(false);
  following = $state(true);
  lookingUp = $state(false);
  star = $state.raw<StarTip | null>(null);
  writeAt = $state.raw<Point | null>(null);
  composer = $state(0);
  counts = $state.raw({ cards: 0, stars: 0 });
  woodReadyAt = $state(0);
  clock = $state(Date.now());
  restoring = $state(false);

  session: CampSession | null = null;
  board: CampBoard | null = null;

  private confirmed: CampState = emptyCamp();
  private shown: CampState = emptyCamp();
  private pending: Pending[] = [];
  private document: CampDocument | null = null;
  private sinceSnapshot = { upTo: 0, events: 0, bytes: 0 };
  private snapshotting = false;
  private replaying = false;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private frameId = 0;
  private last = 0;
  private presenceAt = 0;
  private presenceKey = "";
  private clockAt = 0;
  private keys = new Set<string>();
  private visible = true;
  private offs: Array<() => void> = [];

  constructor(client?: CohubClient) {
    this.client = client ?? createCohubClient();
    this.profile = readProfile() ?? { name: "", color: CAMPER_COLORS[Math.floor(Math.random() * CAMPER_COLORS.length)] as string };
    this.world = new World(this.profile, { feed: () => void this.addWood(), poke: () => this.wave() });
    this.media = new CampMedia(this.client, this.world, {
      session: () => this.session,
      notice: (notice) => this.deviceNotice(notice),
      beforeGrant: (device) => writeIntent({ code: this.code, ...this.profile,
        mic: device === "microphone" || this.media.mic,
        cam: device === "camera" || this.media.localCamera !== null, at: Date.now() }),
      afterGrant: () => writeIntent(null),
      cameraVisible: (point) => this.visible && (this.board?.cameraVisible(point) ?? false),
    });
    this.spirit = new SpiritControl(this.client, {
      session: () => this.session,
      members: () => this.members,
      locale: () => this.locale,
      name: () => this.profile.name,
      fail: (reason, detail) =>
        this.say(
          reason === "busy" ? this.t.spiritBusy : reason === "awake" ? this.t.spiritAlreadyAwake : detail ? `${this.t.spiritFailed} · ${detail}` : this.t.spiritFailed,
          "error",
        ),
      gone: () => this.say(this.t.spiritGone(this.spiritName)),
      voice: (url, participantId) => this.media.playSpirit(url, participantId),
    });
  }

  get spiritName() {
    return this.spirit.member?.name || this.t.spiritName;
  }

  get people() {
    return this.members.filter((member) => !member.spirit).length;
  }

  get keeper() {
    const users = this.members.filter((member) => member.kind === "user").sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
    return users[0]?.self === true;
  }

  get woodWait() {
    return Math.max(0, Math.ceil((this.woodReadyAt - this.clock) / 1000));
  }

  async boot() {
    const context = await this.client.context().catch(() => null);
    this.applyContext(context);
    const off = this.client.app?.onContextChanged?.((next) => this.applyContext(next));
    if (typeof off === "function") this.offs.push(off);
    const params = new URLSearchParams(location.search);
    const linked = normalizeCode(params.get("room"));
    const space = context?.shell?.space?.id ?? context?.invocation?.spaceId ?? null;
    this.code = linked ?? (space ? spaceCode(space) : randomCode());
    this.linked = linked !== null;
    this.phase = "lobby";
    await this.preview();
    const intent = readIntent();
    if (intent && (!linked || intent.code === this.code) && context?.viewer) {
      await this.sit({ name: intent.name, color: intent.color, code: intent.code }, intent.mic, intent.cam === true);
    }
  }

  private applyContext(context: AppRuntimeContext | null) {
    this.context = context;
    const locale = localeFor(context?.locale ?? navigator.language);
    this.world.reduced = context?.appearance?.reducedMotion ?? matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.setVisible(context?.window?.visible !== false && document.visibilityState !== "hidden");
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    if (locale === this.locale && this.document) return;
    this.locale = locale;
    this.t = messagesFor(locale);
    if (this.board) {
      this.document = this.createDocument();
      this.rebuild(true);
    }
  }

  private createDocument() {
    return new CampDocument({ sign: this.t.sign, spirit: this.t.spiritName, fire: this.t.wood, wave: this.t.wave });
  }

  attach(host: HTMLElement) {
    this.document = this.createDocument();
    this.board = new CampBoard(host, this.document.build(this.shown), this.world, {
      walk: (point) => this.walk(point),
      write: (point) => this.openComposer(point),
      move: (card, at) => void this.publish(EVENTS.move, { id: card, x: Math.round(at.x), y: Math.round(at.y) }),
      burn: (card) => void this.publish(EVENTS.burn, { id: card }),
      ink: (points) => this.ink(points),
      drag: (card, at, end) => this.session?.sendDrag({ id: card, x: Math.round(at.x), y: Math.round(at.y), ...(end ? { end: true } : {}) }),
      stroke: (id, points, end) =>
        this.session?.sendStroke({ id, color: this.profile.color, size: 5, points: encodeInk(points), ...(end ? { end: true } : {}) }),
      star: (id, screen) => this.showStar(id, screen),
      freeCamera: () => {
        this.following = false;
        this.lookingUp = false;
      },
    }, () => this.profile, () => this.writeAt);
    const resize = new ResizeObserver(() => this.board?.resize());
    resize.observe(host);
    this.offs.push(() => resize.disconnect());
    const keydown = (event: KeyboardEvent) => this.key(event, true);
    const keyup = (event: KeyboardEvent) => this.key(event, false);
    const hide = () => void flushCachedCamp();
    const visibility = () => this.setVisible(document.visibilityState !== "hidden" && this.context?.window?.visible !== false);
    addEventListener("keydown", keydown);
    addEventListener("keyup", keyup);
    addEventListener("pagehide", hide);
    document.addEventListener("visibilitychange", visibility);
    this.offs.push(() => {
      removeEventListener("keydown", keydown);
      removeEventListener("keyup", keyup);
      removeEventListener("pagehide", hide);
      document.removeEventListener("visibilitychange", visibility);
    });
    this.last = performance.now();
    this.frameId = requestAnimationFrame(this.frame);
  }

  private async preview() {
    if (!this.code) return;
    const cached = await readCachedCamp(this.code);
    if (cached && this.phase !== "camp" && this.confirmed.sequence === 0) {
      this.confirmed = cached;
      this.rebuild(true);
    }
  }

  async sit(input: { name: string; color: string; code: string }, withMic = false, withCamera = false) {
    if (this.phase === "joining" || this.phase === "camp") return;
    const code = normalizeCode(input.code);
    if (!code) {
      this.joinError = this.t.codeInvalid;
      return;
    }
    const name = readText(input.name, LIMITS.name) || this.t.traveler;
    this.profile = { name, color: input.color };
    writeProfile(this.profile);
    this.world.self.name = name;
    this.world.self.color = input.color;
    this.joinError = null;
    this.phase = "joining";
    this.media.wake();
    if (code !== this.code) {
      this.code = code;
      this.confirmed = (await readCachedCamp(code)) ?? emptyCamp();
      this.rebuild(true);
    }
    const session = new CampSession(this.client, code, { name, color: input.color, mic: false, x: 0, y: 240 }, {
      onEvent: (event) => this.receive(event),
      onResync: (events) => this.restore(events),
      onMembers: (members) => this.absorb(members),
      onPose: (participantId, pose) => this.world.pose(participantId, pose, performance.now()),
      onDrag: (participantId, drag) => this.board?.remoteDrag(participantId, drag.id, drag, drag.end === true),
      onStroke: (participantId, stroke) => {
        const points = decodeInk(stroke.points);
        if (points) this.board?.remoteStroke(participantId, stroke.id, points, stroke.color, stroke.size, stroke.end === true);
      },
      onWave: (participantId, wave) => this.waved(participantId, wave.kind),
      onTracks: (tracks) => this.media.onTracks(tracks),
      onTransport: (transport) => {
        this.transport = transport;
        if (transport === "peer") void this.media.flush();
      },
      onNotice: (notice) => this.say(notice === "reconnecting" ? this.t.reconnecting : this.t.noRtc),
    });
    this.session = session;
    try {
      this.restoring = true;
      const history = await session.join();
      if (this.session !== session) return;
      if (await this.carryOver(history)) await session.refresh();
      else await this.restore(history);
      this.restoring = false;
      session.resume();
      session.selectMedia(this.media.plan);
      this.phase = "camp";
      this.world.place({ x: FIRE.x + (Math.random() - 0.5) * 360, y: FIRE.y + 200 + Math.random() * 120 });
      this.board?.follow(true, this.world.reduced);
      this.following = true;
      void this.pushPresence(true);
      if (withMic) await this.media.toggleMic();
      if (withCamera && this.session === session) await this.media.toggleCamera();
    } catch (error) {
      this.restoring = false;
      await session.leave();
      if (this.session !== session) return;
      this.media.stop();
      this.session = null;
      this.phase = "lobby";
      this.joinError = this.context?.viewer ? (error instanceof Error ? error.message : String(error)) : this.t.signIn;
    }
  }

  async leave() {
    const session = this.session;
    this.session = null;
    this.media.stop();
    await flushCachedCamp();
    await session?.leave();
    this.spirit.reset();
    this.members = [];
    this.world.sync([]);
    this.pending = [];
    this.inkMode = false;
    this.board?.setInk(false);
    this.board?.overview();
    this.phase = "lobby";
  }

  private async restore(events: CampEvent[]) {
    this.replaying = true;
    try {
      const { state, upTo } = await restoreCamp(events);
      this.confirmed = state;
      this.sinceSnapshot = { upTo, events: 0, bytes: 0 };
      const lines: LogLine[] = [];
      for (const event of events) {
        if (event.sequence > upTo) this.count(event);
        const line = event.type === EVENTS.snapshot ? null : this.lineFor(event, null);
        if (line) lines.push(line);
      }
      this.log = lines.slice(-LOG_LIMIT);
      this.rebuild(true);
      writeCachedCamp(this.code, this.confirmed);
    } finally {
      this.replaying = false;
    }
  }

  private async carryOver(history: CampEvent[]) {
    if (!this.keeper || !this.session || (history as { truncated?: boolean }).truncated) return false;
    try {
      if ((await restoreCamp(history)).from === "snapshot" || hasCampHistory(history)) return false;
    } catch {
    }
    const cached = await readCachedCamp(this.code);
    if (!cached || (cached.cards.size === 0 && cached.stars.size === 0 && cached.inks.size === 0)) return false;
    await this.writeSnapshot(rebase(cached), 0);
    return true;
  }

  private receive(event: CampEvent & { participantId: string; self: boolean; clientEventId: string | null }) {
    const mine = event.clientEventId ? this.pending.findIndex((pending) => pending.clientEventId === event.clientEventId) : -1;
    if (mine >= 0) this.pending.splice(mine, 1);
    const before = this.confirmed;
    const { state, outcome } = reduce(before, event);
    if (state === before) return;
    this.confirmed = state;
    if (mine < 0) this.react(outcome, event.participantId);

    this.count(event);
    if (event.type === EVENTS.snapshot) {
      const part = readSnapshot(event.data);
      if (part?.upTo === 0 && part.part === part.parts - 1) {
        void this.session?.refresh().catch(() => this.say(this.t.sendFailed, "error"));
      }
    } else if (event.type === EVENTS.chat && !event.self) {
      const chat = readChat(event.data);
      if (chat) this.world.say(event.participantId, chat.text, chat.name, false, performance.now());
    } else if (event.type === EVENTS.speak) {
      const text = readText((event.data as { text?: unknown } | null)?.text, 240);
      if (text) this.world.say(event.participantId, text, this.spiritName, true, performance.now());
    }
    const line = this.lineFor(event, event.participantId);
    if (line) this.append(line);
    this.spirit.handle({ ...event, participantId: event.participantId, self: event.self }, false);

    this.rebuild();
    writeCachedCamp(this.code, this.confirmed);
    void this.compact();
  }

  private react(outcome: Outcome, participantId: string | null) {
    if (!outcome || this.replaying) return;
    const now = performance.now();
    switch (outcome.kind) {
      case "burn": {
        const size = cardSize(outcome.card.text);
        this.world.burn({ x: outcome.card.x + size.width / 2, y: outcome.card.y + size.height / 2 }, size, outcome.star, now);
        if (participantId) this.board?.remoteDrag(participantId, outcome.card.id, outcome.card, true);
        this.watchStar(outcome.star, !participantId);
        return;
      }
      case "card": {
        const size = cardSize(outcome.card.text);
        this.world.effect("puff", { from: { x: outcome.card.x + size.width / 2, y: outcome.card.y + size.height / 2 }, life: 600 }, now);
        return;
      }
      case "move":
        if (participantId) this.board?.remoteDrag(participantId, outcome.card.id, outcome.card, true);
        return;
      case "ink":
        this.board?.settleStroke(outcome.ink.id);
        return;
      case "wood": {
        const from = participantId ? (this.world.body(participantId) ?? outcome.from) : outcome.from;
        this.world.effect("wood", { from: { x: from.x, y: from.y - 30 }, to: { x: FIRE.x, y: FIRE.y - 20 }, life: 900 }, now);
        return;
      }
      case "name":
        this.world.effect("arrive", { from: outcome.star, to: outcome.star, life: 900 }, now);
        return;
    }
  }

  private watchStar(star: Point & { by: { name: string } }, mine: boolean) {
    if (!mine) this.say(this.t.burned(star.by.name));
    else if (!this.world.walking && !this.lookingUp) this.board?.glance(star, 3200);
  }

  private lineFor(event: CampEvent, participantId: string | null): LogLine | null {
    const member = participantId ? this.members.find((m) => m.participantId === participantId) : null;
    const id = `${event.sequence}`;
    switch (event.type) {
      case EVENTS.chat: {
        const chat = readChat(event.data);
        return chat ? { id, kind: "chat", name: chat.name || this.t.traveler, text: chat.text, color: member?.color ?? "#cdd6f4", at: event.at } : null;
      }
      case EVENTS.speak: {
        const text = readText((event.data as { text?: unknown } | null)?.text, 420);
        const name = readText((event.data as { name?: unknown } | null)?.name, 24) || this.t.spiritName;
        return text ? { id, kind: "spirit", name, text, color: "#8fe7ff", at: event.at } : null;
      }
      case EVENTS.burn: {
        const star = this.confirmed.stars.get((event.data as { id?: string } | null)?.id ?? "");
        return star ? { id, kind: "camp", name: star.by.name, text: `✦ ${star.text}`, color: star.by.color, at: event.at } : null;
      }
      case EVENTS.name: {
        const data = event.data as { id?: string; name?: string } | null;
        const star = this.confirmed.stars.get(data?.id ?? "");
        return star?.name ? { id, kind: "spirit", name: this.t.spiritName, text: this.t.spiritNamed(this.t.spiritName, star.name), color: "#8fe7ff", at: event.at } : null;
      }
      default:
        return null;
    }
  }

  private append(line: LogLine) {
    this.log = [...this.log, line].slice(-LOG_LIMIT);
    this.unread += 1;
  }

  private rebuild(fresh = false) {
    const now = Date.now();
    this.pending = this.pending.filter((pending) => now - pending.at < PENDING_TTL_MS);
    let state = this.confirmed;
    for (const pending of this.pending) {
      state = reduce(state, { type: pending.type, data: pending.data, sequence: state.sequence + 1, at: pending.at }).state;
    }
    this.shown = state;
    this.world.heat = heatAt(state.embers, now);
    this.counts = { cards: state.cards.size, stars: state.stars.size };
    if (this.document && this.board) this.board.load(this.document.build(state), fresh);
  }

  private async publish(type: string, data: unknown) {
    const session = this.session;
    if (!session) return false;
    const pending: Pending = { clientEventId: createId(), type, data, at: Date.now() };
    const { outcome } = reduce(this.shown, { type, data, sequence: this.shown.sequence + 1, at: pending.at });
    this.pending.push(pending);
    this.react(outcome, null);
    this.rebuild();
    try {
      await session.publish(type, data, pending.clientEventId);
      return true;
    } catch {
      this.pending = this.pending.filter((entry) => entry !== pending);
      this.rebuild();
      this.say(this.t.sendFailed, "error");
      return false;
    }
  }

  private count(event: CampEvent) {
    if (event.type === EVENTS.snapshot) {
      const part = readSnapshot(event.data);
      if (part && part.part === part.parts - 1 && part.upTo >= this.sinceSnapshot.upTo) this.sinceSnapshot = { upTo: part.upTo, events: 0, bytes: 0 };
      return;
    }
    this.sinceSnapshot.events += 1;
    this.sinceSnapshot.bytes += JSON.stringify(event.data ?? null).length + 96;
  }

  private async compact() {
    if (!this.keeper || this.snapshotting || !this.session) return;
    const since = this.sinceSnapshot;
    if (since.events < SNAPSHOT_EVERY.events && since.bytes < SNAPSHOT_EVERY.bytes) return;
    await this.writeSnapshot(this.confirmed, this.confirmed.sequence);
  }

  private async writeSnapshot(state: CampState, upTo: number) {
    const session = this.session;
    if (!session || this.snapshotting) return;
    this.snapshotting = true;
    try {
      const parts = await encodeSnapshot(state);
      const key = createId();
      for (const [part, data] of parts.entries()) {
        await session.publish(EVENTS.snapshot, { v: 1, key, upTo, part, parts: parts.length, data });
      }
    } catch (error) {
      if (upTo === 0) throw error;
    } finally {
      this.snapshotting = false;
    }
  }

  async chat(text: string) {
    const clean = readText(text, LIMITS.chat);
    if (!clean || !this.session) return false;
    const spirit = this.spirit.member;
    const near = spirit ? this.world.body(spirit.participantId) : null;
    const toSpirit =
      spirit !== null &&
      ((near !== null && Math.hypot(near.x - this.world.self.x, near.y - this.world.self.y) < NEAR_SPIRIT) ||
        clean.toLowerCase().includes(this.spiritName.toLowerCase()));
    this.world.say(this.world.self.id, clean, this.profile.name, false, performance.now());
    try {
      await this.session.publish(EVENTS.chat, { text: clean, name: this.profile.name, ...(toSpirit ? { toSpirit: true } : {}) });
      return true;
    } catch {
      this.say(this.t.sendFailed, "error");
      return false;
    }
  }

  async pin(text: string) {
    const clean = readText(text, LIMITS.cardText);
    if (!clean) return false;
    if (this.shown.cards.size >= LIMITS.cards) {
      this.say(this.t.meadowFull, "error");
      return false;
    }
    const size = cardSize(clean);
    const corner = this.writeAt ? { x: this.writeAt.x - size.width / 2, y: this.writeAt.y - size.height / 2 } : this.findSpace(size);
    const at = clampCard(corner.x, corner.y, clean);
    this.writeAt = null;
    return this.publish(EVENTS.card, { id: createId(), text: clean, x: at.x, y: at.y, by: { name: this.profile.name, color: this.profile.color } });
  }

  private findSpace(size: { width: number; height: number }): Point {
    const self = this.world.self;
    const taken = [...this.shown.cards.values()];
    const clear = (x: number, y: number) =>
      Math.hypot(x + size.width / 2 - FIRE.x, y + size.height / 2 - FIRE.y) > 230 &&
      taken.every((card) => {
        const other = cardSize(card.text);
        return (
          x + size.width + 28 < card.x ||
          x > card.x + other.width + 28 ||
          y + size.height + 28 < card.y ||
          y > card.y + other.height + 28
        );
      });
    const away = Math.atan2(self.y - FIRE.y, self.x - FIRE.x) || Math.PI / 2;
    for (let ring = 0; ring < 10; ring += 1) {
      const radius = 210 + ring * 130;
      for (const spread of [1.1, -1.1, 0.6, -0.6, 1.7, -1.7, 0, 2.4, -2.4]) {
        const angle = away + spread + (hash(`${self.x},${self.y},${ring},${spread}`) % 20) / 100;
        const x = Math.round(self.x + Math.cos(angle) * radius - size.width / 2);
        const y = Math.round(self.y + Math.sin(angle) * radius * 0.72 - size.height / 2);
        if (clear(x, y)) return { x, y };
      }
    }
    return { x: self.x - size.width / 2, y: self.y + 200 };
  }

  openComposer(point: Point | null) {
    this.writeAt = point;
    this.composer += 1;
  }

  async addWood() {
    if (!this.session || Date.now() < this.woodReadyAt) return;
    this.woodReadyAt = Date.now() + WOOD_COOLDOWN_MS;
    const self = this.world.self;
    await this.publish(EVENTS.wood, { name: this.profile.name, x: Math.round(self.x), y: Math.round(self.y) });
  }

  private ink(points: Point[]) {
    const encoded = encodeInk(points);
    void this.publish(EVENTS.ink, { id: createId(), color: this.profile.color, size: 5, points: encoded });
  }

  wave() {
    this.session?.sendWave({ kind: "wave" });
    this.waved(null, "wave");
  }

  private waved(participantId: string | null, kind: "wave" | "spark" | "heart") {
    const body = participantId ? this.world.body(participantId) : this.world.self;
    if (!body) return;
    const glyph = kind === "heart" ? "♥" : kind === "spark" ? "✧" : "✦";
    this.world.effect("wave", { from: { x: body.x, y: body.y - 70 }, life: 1100, glyph }, performance.now());
  }

  toggleInk() {
    this.inkMode = !this.inkMode;
    this.board?.setInk(this.inkMode);
  }

  walk(point: Point) {
    if (this.phase !== "camp") return;
    if (this.world.walkTo(point)) {
      this.following = true;
      this.lookingUp = false;
    }
  }

  lookUp() {
    if (this.lookingUp) return this.recenter();
    this.board?.lookUp();
    this.lookingUp = true;
    this.following = false;
  }

  recenter() {
    this.board?.follow(true);
    this.following = true;
    this.lookingUp = false;
  }

  showStar(id: string | null, screen: Point | null) {
    const star = id ? this.shown.stars.get(id) : null;
    if (!star || !screen) {
      this.star = null;
      return;
    }
    this.star = { id: star.id, text: star.text, name: star.name ?? "", by: star.by.name, color: star.by.color, x: screen.x, y: screen.y };
  }

  async copyLink() {
    const base = this.context?.app?.url ?? location.href;
    const url = new URL(base);
    url.searchParams.set("room", this.code);
    await navigator.clipboard.writeText(url.toString()).then(
      () => this.say(this.t.linkCopied),
      () => this.say(url.toString()),
    );
  }

  async copyInvite() {
    try {
      const invite = await this.session?.invite(900);
      if (!invite) throw new Error("no room");
      await navigator.clipboard.writeText(`cohub rooms join ${invite.invite}`);
      this.say(this.t.inviteCopied);
    } catch {
      this.say(this.t.inviteFailed, "error");
    }
  }

  newCamp() {
    this.code = randomCode();
    this.linked = false;
  }

  forget() {
    clearCachedCamp(this.code);
  }

  private readonly frame = (now: number) => {
    const dt = Math.min(64, now - this.last);
    this.last = now;
    this.steer();
    this.world.step(dt);
    this.media.frame(now);
    this.board?.frame(now, dt);
    if (this.board && this.following !== this.board.followingSelf && !this.lookingUp) this.following = this.board.followingSelf;
    if (this.session && this.phase === "camp") {
      const self = this.world.self;
      this.session.sendPose({ x: self.x, y: self.y, level: self.level, walking: self.walking, left: self.left, mic: self.mic });
      if (now - this.presenceAt > PRESENCE_MS) void this.pushPresence(false);
    }
    if (now - this.clockAt > 500) {
      this.clockAt = now;
      this.clock = Date.now();
      this.spirit.tick();
      const heat = heatAt(this.shown.embers, Date.now());
      if (Math.abs(heat - this.world.heat) > 0.01) this.world.heat = heat;
    }
    this.frameId = requestAnimationFrame(this.frame);
  };

  private async pushPresence(force: boolean) {
    this.presenceAt = performance.now();
    const self = this.world.self;
    const presence = { name: this.profile.name, color: this.profile.color, mic: this.media.mic, x: Math.round(self.x / 10) * 10, y: Math.round(self.y / 10) * 10 };
    const key = JSON.stringify(presence);
    if (!force && key === this.presenceKey) return;
    this.presenceKey = key;
    await this.session?.setPresence(presence);
  }

  private steer() {
    if (this.phase !== "camp" || this.keys.size === 0) return;
    let dx = 0;
    let dy = 0;
    if (this.keys.has("left")) dx -= 1;
    if (this.keys.has("right")) dx += 1;
    if (this.keys.has("up")) dy -= 1;
    if (this.keys.has("down")) dy += 1;
    if (dx || dy) {
      this.world.nudge(dx, dy);
      if (!this.following) this.recenter();
    }
  }

  private key(event: KeyboardEvent, down: boolean) {
    const target = event.target as HTMLElement | null;
    if (target?.closest("input,textarea,select,[contenteditable]")) return;
    const direction = DIRECTIONS[event.key] ?? DIRECTIONS[event.code];
    if (direction) {
      if (down) this.keys.add(direction);
      else this.keys.delete(direction);
      event.preventDefault();
      return;
    }
    if (!down || this.phase !== "camp" || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") {
      if (this.inkMode) this.toggleInk();
      this.star = null;
      this.writeAt = null;
    } else if (event.key === "Enter") {
      this.openComposer(null);
      event.preventDefault();
    } else if (event.key.toLowerCase() === "f") this.recenter();
  }

  private absorb(members: Member[]) {
    this.members = members;
    this.world.sync(members);
    this.session?.selectMedia(this.media.plan);
  }

  private setVisible(visible: boolean) {
    if (visible === this.visible) return;
    this.visible = visible;
    this.world.setVisible(visible);
    this.media.setVisible(visible);
    this.board?.stage.setActive(visible);
    if (visible) return;
    this.keys.clear();
    void flushCachedCamp();
  }

  say(text: string, tone: "info" | "error" = "info") {
    this.notice = { text, tone };
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => (this.notice = null), NOTICE_MS);
  }

  private deviceNotice(notice: DeviceNotice) {
    this.say(this.t[notice], notice === "deviceDenied" ? "error" : "info");
  }

  destroy() {
    cancelAnimationFrame(this.frameId);
    for (const off of this.offs.splice(0)) off();
    void this.leave();
    this.board?.destroy();
    this.board = null;
  }
}

const DIRECTIONS: Record<string, "left" | "right" | "up" | "down"> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  KeyA: "left",
  KeyD: "right",
  KeyW: "up",
  KeyS: "down",
};
