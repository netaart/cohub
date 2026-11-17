import {
  type BoardDocument,
  type BoardItem,
  type BoardPatch,
  buildFallbackShapeColors,
  createBoardRegistry,
  type Rect,
  type WorldPoint,
} from "@neta-art/cohub/board";
import { type BoardEditor, createBoardEditor } from "@neta-art/cohub/board/editor";
import { defaultBoardPalette, ensureBoardTextMeasurement } from "@neta-art/cohub/board/render";
import { type BoardLiveStroke, type BoardStage, createBoardAssetManager, mountBoardStage } from "@neta-art/cohub/board/stage";
import { cardIdOf } from "../camp/document.ts";
import { createId } from "../camp/protocol.ts";
import { cardRoot, cardSize } from "../camp/scene.ts";
import { BURN_RADIUS, FIRE, MEADOW, type Point, SKY } from "../camp/world.ts";
import type { World } from "./world.ts";

export type BoardIntents = {
  walk(point: Point): void;
  write(point: Point): void;
  move(cardId: string, at: Point): void;
  burn(cardId: string, from: Point): void;
  ink(points: Point[]): void;
  drag(cardId: string, at: Point, end: boolean): void;
  stroke(id: string, points: Point[], end: boolean): void;
  star(id: string | null, screen: Point | null): void;
  freeCamera(): void;
};

const ZOOM = { min: 0.2, max: 2.2 } as const;
const SEAT_VIEW = { width: 1150, height: 760, min: 0.6, max: 1.1 } as const;
const FIRE_WEIGHT = 0.34;
const CENTER_Y = 0.56;
const FOLLOW_EASE = 0.009;
const DRAG_SEND_MS = 60;
const STROKE_SEND_MS = 90;
const TAP_SLOP = 8;
const SCRIPT_FILES = /^scripts\/(campers|fire|fx)\.js$/;

const STAR_RE = /^s-([A-Za-z0-9_]{4,32})$/;
const BIRTH_RE = /^[cs]-[A-Za-z0-9_]{4,32}$/;
const BIRTH_MS = 520;

const popScale = (t: number) => {
  const k = 1.70158 * 1.4;
  const u = t - 1;
  return 1 + (k + 1) * u * u * u + k * u * u;
};

export class CampBoard {
  readonly editor: BoardEditor;
  readonly stage: BoardStage;
  private readonly assets;
  private readonly stops: Array<() => void> = [];
  private readonly frameListeners = new Set<() => void>();
  private following = false;
  private zoomGoal: number | null = null;
  private glancing: { at: Point; until: number; zoom: number; back: number } | null = null;
  private sky = false;
  private ink: { id: string; color: string; size: number; points: Point[]; sentAt: number } | null = null;
  private inkMode = false;
  private press: { x: number; y: number; at: number; pointerType: string } | null = null;
  private dragging: { id: string; sentAt: number } | null = null;
  private readonly remoteDrags = new Map<string, { at: Point; seen: number }>();
  private readonly remoteStrokes = new Map<string, { stroke: BoardLiveStroke; seen: number }>();
  private previews = new Map<string, BoardItem>();
  private previewsKey = "";
  private epoch = 0;
  private readonly births = new Map<string, number>();
  private strokes: BoardLiveStroke[] = [];
  private marker: { at: Point; born: number } | null = null;
  private hoveredStar: string | null = null;
  private destroyed = false;

  constructor(
    private readonly host: HTMLElement,
    document: BoardDocument,
    private readonly world: World,
    private readonly intents: BoardIntents,
    private readonly profile: () => { color: string },
    private readonly draft: () => Point | null,
  ) {
    ensureBoardTextMeasurement();
    const registry = createBoardRegistry();
    const fixed = { canMove: false, canResize: false, aspectLocked: true, canRotate: false, canEdit: false, canConnect: false, canSnap: false, canLock: false };
    this.editor = createBoardEditor({
      key: "camp",
      document,
      initialTool: "select",
      registry: {
        ...registry,
        hitTest: (item, point) => {
          const card = cardIdOf(item.id);
          if (card) return item.id === cardRoot(card) && registry.hitTest(item, point);
          return STAR_RE.test(item.id) && registry.hitTest(item, point);
        },
        capabilities: (item) => (item.type === "frame" ? { ...fixed, canMove: true } : fixed),
      },
      onCommit: (patch) => this.commit(patch),
    });

    const resolveFileUrl = async (path: string) => (SCRIPT_FILES.test(path) ? new URL(path, documentBase()).href : null);
    this.assets = createBoardAssetManager({ resolveFileUrl });
    this.stage = mountBoardStage(host, {
      editor: this.editor,
      assets: this.assets,
      source: { resolveFileUrl },
      theme: () => ({ key: "ember", colorScheme: "dark", palette: defaultBoardPalette("dark"), colors: buildFallbackShapeColors("dark") }),
      reducedMotion: () => this.world.reduced,
      previews: () => this.previews,
      strokes: () => this.strokes,
      scriptCapabilities: this.world.capabilities,
      drawOverlay: (g, { zoom }) => this.overlay(g, zoom),
      onPointer: (phase, event, input) => this.pointer(phase, event, input.world),
      onDoubleClick: (item, point) => {
        if (!item && !this.inkMode) this.intents.write(point);
        return true;
      },
    });
    this.stage.setScriptMode("interact");

    this.stops.push(
      this.editor.subscribe("camera", () => this.clampZoom()),
      this.editor.subscribe("hover", () => this.hover()),
      this.editor.subscribeTransforms((event) => {
        if (this.dragging) {
          const id = this.dragging.id;
          this.dragging = null;
          this.world.hot = false;
          if (event.cancelled) this.intents.drag(id, this.cardPosition(id) ?? FIRE, true);
        }
      }),
    );
    const wheel = () => this.release();
    host.addEventListener("wheel", wheel, { passive: true });
    this.stops.push(() => host.removeEventListener("wheel", wheel));

    void this.stage.ready.then((ok) => {
      if (this.destroyed || !ok) return;
      this.resize();
      if (this.following) this.follow(true, true);
      else this.overview(false);
    });
  }

  load(document: BoardDocument, fresh = false) {
    const before = this.editor.document.items;
    if (fresh) {
      this.epoch += 1;
      this.births.clear();
    } else if (!this.world.reduced) {
      const now = performance.now();
      for (const id of Object.keys(document.items)) {
        if (before[id] || !BIRTH_RE.test(id)) continue;
        this.births.set(id, now);
      }
    }
    this.editor.loadDocument(document, `camp:${this.epoch}`);
    if (this.births.size) this.syncPreviews();
  }

  get followingSelf() {
    return this.following && !this.sky;
  }

  get lookingUp() {
    return this.sky;
  }

  follow(on = true, instant = false) {
    this.following = on;
    if (!on) return;
    this.sky = false;
    const zoom = this.editor.camera.zoom;
    const seat = this.seatZoom();
    if (zoom < seat * 0.6 || zoom > seat * 1.7) this.zoomGoal = seat;
    if (instant) this.centerOn(this.world.self, 1);
  }

  release() {
    this.zoomGoal = null;
    this.glancing = null;
    if (!this.following && !this.sky) return;
    this.following = false;
    this.sky = false;
    this.intents.freeCamera();
  }

  glance(star: Point, holdMs: number) {
    if (this.world.reduced) return;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (!width || !height) return;
    const span = { x: Math.abs(star.x - FIRE.x) + 360, y: Math.abs(star.y - FIRE.y) + 420 };
    const zoom = Math.max(ZOOM.min, Math.min(this.editor.camera.zoom, (width * 0.9) / span.x, (height * 0.82) / span.y));
    this.glancing = {
      at: { x: (star.x + FIRE.x) / 2, y: (star.y + FIRE.y) / 2 - 40 },
      until: performance.now() + holdMs,
      zoom,
      back: this.editor.camera.zoom,
    };
  }

  lookUp() {
    this.sky = true;
    this.following = false;
    this.editor.focusRect({ x: SKY.x, y: SKY.y, width: SKY.width, height: SKY.height + 300 }, { padding: 40, animate: !this.world.reduced, maxZoom: 0.8 });
  }

  private seatZoom() {
    const width = this.host.clientWidth || SEAT_VIEW.width;
    const height = this.host.clientHeight || SEAT_VIEW.height;
    return Math.min(SEAT_VIEW.max, Math.max(SEAT_VIEW.min, Math.min(width / SEAT_VIEW.width, height / SEAT_VIEW.height)));
  }

  overview(animate = !this.world.reduced) {
    this.sky = false;
    this.following = false;
    this.editor.focusRect({ x: MEADOW.cx - MEADOW.rx * 0.8, y: SKY.y + 200, width: MEADOW.rx * 1.6, height: MEADOW.cy + MEADOW.ry * 0.7 - SKY.y - 200 }, { padding: 0, animate });
  }

  resize() {
    this.editor.surfaceSize = { width: this.host.clientWidth, height: this.host.clientHeight };
    this.stage.invalidate();
  }

  private centerOn(point: Point, ease: number, fireWeight = FIRE_WEIGHT, anchorY = CENTER_Y) {
    const camera = this.editor.camera;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (!width || !height) return;
    let zoom = camera.zoom;
    if (this.zoomGoal !== null) {
      zoom = ease >= 1 ? this.zoomGoal : zoom + (this.zoomGoal - zoom) * Math.min(1, ease * 0.9);
      if (Math.abs(zoom - this.zoomGoal) < 0.004) {
        zoom = this.zoomGoal;
        this.zoomGoal = null;
      }
    }
    const focus = { x: point.x + (FIRE.x - point.x) * fireWeight, y: point.y + (FIRE.y - point.y) * fireWeight };
    const tx = width / 2 - focus.x * zoom;
    const ty = height * anchorY - focus.y * zoom;
    const x = camera.x + (tx - camera.x) * ease;
    const y = camera.y + (ty - camera.y) * ease;
    if (Math.abs(x - camera.x) < 0.2 && Math.abs(y - camera.y) < 0.2 && zoom === camera.zoom) return;
    this.editor.setCamera({ x, y, zoom });
  }

  private clampZoom() {
    const camera = this.editor.camera;
    this.world.zoom = camera.zoom;
    if (camera.zoom >= ZOOM.min && camera.zoom <= ZOOM.max) return;
    const zoom = Math.min(ZOOM.max, Math.max(ZOOM.min, camera.zoom));
    const cx = this.host.clientWidth / 2;
    const cy = this.host.clientHeight / 2;
    this.editor.setCamera({ x: cx - ((cx - camera.x) / camera.zoom) * zoom, y: cy - ((cy - camera.y) / camera.zoom) * zoom, zoom });
  }

  frame(now: number, dt: number) {
    const glance = this.glancing;
    if (glance && (now > glance.until || this.editor.gestureActive || this.world.walking)) {
      this.glancing = null;
      this.following = true;
      this.zoomGoal = glance.back;
    }
    if (this.glancing) {
      this.zoomGoal = this.glancing.zoom;
      this.centerOn(this.glancing.at, 1 - (1 - FOLLOW_EASE * 0.55) ** dt, 0, 0.5);
    } else if (this.following && !this.sky && !this.editor.gestureActive) {
      this.centerOn(this.world.self, 1 - (1 - FOLLOW_EASE) ** dt);
    }
    this.trackDrag(now);
    this.trackInk(now);
    this.expireRemote(performance.now());
    if (this.births.size) this.syncPreviews();
    if (this.marker && now - this.marker.born > 700) this.marker = null;
    if (this.marker || this.world.hot || this.world.walking || this.draft()) this.stage.invalidate();
    for (const listener of this.frameListeners) listener();
  }

  onFrame(listener: () => void) {
    this.frameListeners.add(listener);
    listener();
    return () => { this.frameListeners.delete(listener); };
  }

  cameraVisible(point: Point) {
    const at = this.toScreen(point);
    return at.x > -80 && at.x < this.host.clientWidth + 80 && at.y > 0 && at.y < this.host.clientHeight + 100;
  }

  private trackDrag(now: number) {
    const interaction = this.editor.interaction;
    if (interaction.type !== "translating" || !interaction.moved) {
      if (this.world.hot && !this.dragging) this.world.hot = false;
      return;
    }
    const root = [...interaction.origin.keys()].find((id) => {
      const card = cardIdOf(id);
      return card !== null && id === cardRoot(card);
    });
    const card = root ? cardIdOf(root) : null;
    if (!card || !root) return;
    const frame = this.editor.scene.get(root)?.frame;
    if (!frame) return;
    const centre = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
    this.world.hot = Math.hypot(centre.x - FIRE.x, centre.y - FIRE.y) < BURN_RADIUS * 1.15;
    if (!this.dragging || this.dragging.id !== card) this.dragging = { id: card, sentAt: 0 };
    if (now - this.dragging.sentAt >= DRAG_SEND_MS) {
      this.dragging.sentAt = now;
      this.intents.drag(card, { x: frame.x, y: frame.y }, false);
    }
  }

  private trackInk(now: number) {
    const ink = this.ink;
    if (!ink || now - ink.sentAt < STROKE_SEND_MS || ink.points.length < 2) return;
    ink.sentAt = now;
    this.intents.stroke(ink.id, ink.points, false);
  }

  setInk(on: boolean) {
    this.inkMode = on;
    this.ink = null;
    this.syncStrokes();
  }

  private pointer(phase: "down" | "move" | "up" | "leave", event: PointerEvent, world: WorldPoint): boolean | undefined {
    if (this.inkMode) return this.inkPointer(phase, event, world);
    if (phase === "down") {
      if (!event.isPrimary) return undefined;
      const hit = this.editor.itemAt(world);
      const card = hit && cardIdOf(hit.id);
      this.editor.tool = card ? "select" : "hand";
      this.press = card ? null : { x: event.clientX, y: event.clientY, at: performance.now(), pointerType: event.pointerType };
      return undefined;
    }
    if (phase === "move" && this.press && this.editor.interaction.type === "panning" && this.editor.interaction.moved) {
      this.press = null;
      this.release();
      return undefined;
    }
    if (phase === "up") {
      queueMicrotask(() => {
        if (!this.editor.gestureActive && this.editor.selection.length) this.editor.clearSelection();
      });
    }
    if (phase === "up" && this.press) {
      const press = this.press;
      this.press = null;
      const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y) > TAP_SLOP;
      if (!moved && event.type !== "pointercancel") this.tap(world, event);
    }
    return undefined;
  }

  private tap(world: WorldPoint, event: PointerEvent) {
    const hit = this.editor.itemAt(world);
    const star = hit && STAR_RE.exec(hit.id)?.[1];
    if (star) {
      this.intents.star(star, this.screenOf(event));
      return;
    }
    this.intents.star(null, null);
    this.marker = { at: world, born: performance.now() };
    this.following = true;
    this.sky = false;
    this.intents.walk(world);
  }

  private inkPointer(phase: "down" | "move" | "up" | "leave", event: PointerEvent, world: WorldPoint): boolean | undefined {
    if (phase === "down") {
      if (!event.isPrimary || event.button > 0) return false;
      this.ink = { id: createId(), color: this.profile().color, size: 5, points: [world], sentAt: 0 };
      this.host.setPointerCapture?.(event.pointerId);
      this.syncStrokes();
      return false;
    }
    const ink = this.ink;
    if (!ink) return phase === "leave" ? undefined : false;
    if (phase === "move") {
      const last = ink.points.at(-1);
      if (!last || Math.hypot(last.x - world.x, last.y - world.y) * this.editor.camera.zoom >= 2) {
        ink.points.push(world);
        if (ink.points.length > 1500) ink.points.splice(1, 1);
        this.syncStrokes();
      }
      return false;
    }
    if (phase === "up") {
      this.ink = null;
      this.syncStrokes();
      if (event.type !== "pointercancel" && ink.points.length > 1) {
        this.intents.stroke(ink.id, ink.points, true);
        this.intents.ink(ink.points);
      }
      return false;
    }
    return undefined;
  }

  private hover() {
    const id = this.editor.hoverId;
    const star = id ? (STAR_RE.exec(id)?.[1] ?? null) : null;
    if (star === this.hoveredStar) return;
    this.hoveredStar = star;
    if (this.editor.pointerType !== "mouse") return;
    const item = star ? this.editor.scene.get(`s-${star}`) : null;
    this.intents.star(star, item ? this.screenRectCenter(item.frame) : null);
  }

  private screenOf(event: PointerEvent): Point {
    const rect = this.host.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private screenRectCenter(frame: Rect): Point {
    const camera = this.editor.camera;
    return { x: (frame.x + frame.width / 2) * camera.zoom + camera.x, y: (frame.y + frame.height / 2) * camera.zoom + camera.y };
  }

  toScreen(point: Point): Point {
    const camera = this.editor.camera;
    return { x: point.x * camera.zoom + camera.x, y: point.y * camera.zoom + camera.y };
  }

  private commit(patch: BoardPatch) {
    for (const [id, value] of Object.entries(patch.items ?? {})) {
      const card = cardIdOf(id);
      const position = (value as { position?: Point } | null)?.position;
      if (!card || id !== cardRoot(card) || !position) continue;
      const item = this.editor.document.items[id];
      const text = item ? textOf(this.editor.document, card) : "";
      const size = cardSize(text);
      const centre = { x: position.x + size.width / 2, y: position.y + size.height / 2 };
      queueMicrotask(() => {
        if (Math.hypot(centre.x - FIRE.x, centre.y - FIRE.y) <= BURN_RADIUS) this.intents.burn(card, centre);
        else this.intents.move(card, position);
        this.intents.drag(card, position, true);
      });
    }
  }

  private cardPosition(card: string): Point | null {
    const item = this.editor.document.items[cardRoot(card)];
    return item ? item.position : null;
  }

  remoteDrag(participantId: string, card: string, at: Point, end: boolean) {
    const key = `${participantId}:${card}`;
    if (end) this.remoteDrags.delete(key);
    else this.remoteDrags.set(key, { at, seen: performance.now() });
    this.syncPreviews();
  }

  remoteStroke(participantId: string, id: string, points: Point[], color: string, size: number, end: boolean) {
    const key = `${participantId}:${id}`;
    if (end || points.length < 2) this.remoteStrokes.delete(key);
    else
      this.remoteStrokes.set(key, {
        stroke: { id: `live-${key}`, points: points.map((point) => ({ ...point, p: 0.5 })), color, size },
        seen: performance.now(),
      });
    this.syncStrokes();
  }

  settleStroke(id: string) {
    let changed = false;
    for (const key of this.remoteStrokes.keys()) {
      if (key.endsWith(`:${id}`)) {
        this.remoteStrokes.delete(key);
        changed = true;
      }
    }
    if (changed) this.syncStrokes();
  }

  private expireRemote(now: number) {
    let drags = false;
    for (const [key, drag] of this.remoteDrags) {
      if (now - drag.seen > 1500) {
        this.remoteDrags.delete(key);
        drags = true;
      }
    }
    if (drags) this.syncPreviews();
    let strokes = false;
    for (const [key, stroke] of this.remoteStrokes) {
      if (now - stroke.seen > 4000) {
        this.remoteStrokes.delete(key);
        strokes = true;
      }
    }
    if (strokes) this.syncStrokes();
  }

  private syncPreviews() {
    const next = new Map<string, BoardItem>();
    const keys: string[] = [];
    const now = performance.now();
    for (const [id, born] of this.births) {
      const t = (now - born) / BIRTH_MS;
      const item = this.editor.document.items[id];
      if (t >= 1 || !item) {
        this.births.delete(id);
        continue;
      }
      const scale = Math.max(0.01, popScale(Math.max(0, t)) * (typeof item.scale === "number" ? item.scale : 1));
      next.set(id, { ...item, scale, opacity: Math.min(1, t * 3) * item.opacity } as BoardItem);
      keys.push(`${id}~${t.toFixed(3)}`);
    }
    for (const [key, drag] of this.remoteDrags) {
      const card = key.slice(key.indexOf(":") + 1);
      const root = cardRoot(card);
      const item = this.editor.document.items[root];
      if (!item) continue;
      next.set(root, { ...item, position: { x: drag.at.x, y: drag.at.y }, z: (item.z ?? 0) + 500 } as BoardItem);
      keys.push(`${root}@${drag.at.x},${drag.at.y}`);
    }
    const key = keys.join("|");
    if (key === this.previewsKey) return;
    this.previewsKey = key;
    this.previews = next;
    this.stage.invalidate();
  }

  private syncStrokes() {
    const strokes = [...this.remoteStrokes.values()].map((entry) => entry.stroke);
    const own = this.ink;
    if (own && own.points.length > 1)
      strokes.push({ id: `live-own-${own.id}`, points: own.points.map((point) => ({ ...point, p: 0.5 })), color: own.color, size: own.size });
    this.strokes = strokes;
    this.stage.invalidate();
  }

  private overlay(g: import("pixi.js").Graphics, zoom: number) {
    const now = performance.now();
    if (this.world.hot) {
      const pulse = 0.5 + Math.sin(now / 140) * 0.5;
      g.ellipse(FIRE.x, FIRE.y, BURN_RADIUS, BURN_RADIUS * 0.5).stroke({ color: 0xffb36b, width: (2 + pulse * 2) / zoom, alpha: 0.5 + pulse * 0.4 });
    }
    const draft = this.draft();
    if (draft) {
      const { width, height } = cardSize("");
      const breathe = 0.45 + Math.sin(now / 420) * 0.2;
      const x = draft.x - width / 2;
      const y = draft.y - height / 2;
      const dash = 10 / zoom;
      const line = { color: 0xffb36b, width: 1.5 / zoom, alpha: breathe };
      for (let offset = 0; offset < width; offset += dash * 2) {
        const end = Math.min(width, offset + dash);
        g.moveTo(x + offset, y).lineTo(x + end, y).stroke(line);
        g.moveTo(x + offset, y + height).lineTo(x + end, y + height).stroke(line);
      }
      for (let offset = 0; offset < height; offset += dash * 2) {
        const end = Math.min(height, offset + dash);
        g.moveTo(x, y + offset).lineTo(x, y + end).stroke(line);
        g.moveTo(x + width, y + offset).lineTo(x + width, y + end).stroke(line);
      }
    }
    const target = this.world.walkTarget;
    if (target) {
      g.ellipse(target.x, target.y, 14, 6).stroke({ color: 0xffe2a6, width: 1.5 / zoom, alpha: 0.6 });
    }
    if (this.marker) {
      const t = Math.min(1, (now - this.marker.born) / 700);
      g.ellipse(this.marker.at.x, this.marker.at.y, 8 + t * 22, (8 + t * 22) * 0.45).stroke({
        color: 0xffe2a6,
        width: 2 / zoom,
        alpha: 1 - t,
      });
    }
  }

  destroy() {
    this.destroyed = true;
    this.frameListeners.clear();
    for (const stop of this.stops.splice(0)) stop();
    this.stage.destroy();
    this.assets.destroy();
    this.editor.destroy();
  }
}

const textOf = (document: BoardDocument, card: string) => {
  const item = document.items[`${cardRoot(card)}-text`];
  return item?.type === "text" ? item.props.text : "";
};

const documentBase = () => new URL(import.meta.env.BASE_URL, location.href);
