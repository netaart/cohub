import type { BoardPatch } from "@neta-art/cohub/board";
import type { Author } from "./protocol.ts";
import { BURN_RADIUS, CARD_WIDTH, cardHeight, hash, MEADOW, type Point, seeded } from "./world.ts";

type Items = NonNullable<BoardPatch["items"]>;
type Item = Record<string, unknown>;

export const COLORS = {
  night: "#0b0e17",
  ground: "#10181b",
  groundInner: "#131e1f",
  pine: ["#0d2225", "#10282a", "#0b1d21"],
  pineFar: "#09161a",
  log: "#4a2f20",
  logEnd: "#7a5136",
  stone: "#272c33",
  flame: "#ff8a2a",
  core: "#ffd27a",
  spark: "#ffcf8a",
  light: "#ff9a3c",
  paper: "#efe5cf",
  paperInk: "#2a241c",
  paperMuted: "#8b7d66",
  woven: "#16223a",
  wovenInk: "#dce8ff",
  wovenEdge: "#8fcdf5",
  star: "#fff3d1",
  starGlow: "#ffe2a6",
  starName: "#b9c4ea",
  dust: "#c9d3ff",
  moon: "#f1ead6",
  firefly: "#d9f99d",
  sign: "#33251c",
  signInk: "#ead9b8",
} as const;

const FONTS = { body: "Geist", pixel: "Silkscreen" } as const;

const IDS = { fire: "fire", campers: "campers", fx: "fx" } as const;

const SCRIPTS = {
  fire: "scripts/fire.js",
  campers: "scripts/campers.js",
  fx: "scripts/fx.js",
} as const;

export type SignLabels = { sign: [string, string, string]; fire: string; wave: string };

const locked = (item: Item): Item => ({ ...item, locked: true });

const PINE_PATH = "M24 0 L35 17 L29 17 L41 34 L33 34 L48 54 L28 54 L28 66 L20 66 L20 54 L0 54 L15 34 L7 34 L19 17 L13 17 Z";
const SPARKLE_PATH = "M11 0 L13.4 8.6 L22 11 L13.4 13.4 L11 22 L8.6 13.4 L0 11 L8.6 8.6 Z";

const trees = (): Items => {
  const random = seeded("ember:trees");
  const items: Items = {};
  const ring = (prefix: string, count: number, rx: number, ry: number, z: number, fill: (i: number) => string, scale: number) => {
    for (let index = 0; index < count; index += 1) {
      const angle = (index / count) * Math.PI * 2 + (random() - 0.5) * 0.12;
      const s = scale * (0.85 + random() * 0.5);
      const width = 48 * s;
      const height = 66 * s;
      const x = MEADOW.cx + Math.cos(angle) * (rx + (random() - 0.5) * 70);
      const y = MEADOW.cy + Math.sin(angle) * (ry + (random() - 0.5) * 50);
      items[`${prefix}${index}`] = locked({
        type: "shape",
        z: z + (y + 2000) / 10000,
        position: { x: Math.round(x - width / 2), y: Math.round(y - height) },
        size: { width: Math.round(width), height: Math.round(height) },
        props: { geometry: "path", path: PINE_PATH },
        style: { fill: fill(index), strokeWidth: 0 },
      });
    }
  };
  ring("x-far", 40, MEADOW.rx + 250, MEADOW.ry + 190, 4, () => COLORS.pineFar, 2.1);
  ring("x-pine", 46, MEADOW.rx + 90, MEADOW.ry + 70, 5, (i) => COLORS.pine[i % COLORS.pine.length] as string, 1.6);
  return items;
};

const fire = (labels: SignLabels): Items => {
  const base = { x: 110, y: 150 };
  const items: Items = {
    [IDS.fire]: locked({
      type: "frame",
      z: 8,
      position: { x: -base.x, y: -base.y },
      size: { width: 220, height: 190 },
      origin: { x: 0.5, y: base.y / 190 },
      props: { decoration: "none", clip: false, label: "" },
      script: { src: SCRIPTS.fire, seed: "ember-fire", params: { label: labels.fire } },
    }),
    "fire-light": locked({
      type: "effect",
      parent: IDS.fire,
      z: 0,
      position: { x: base.x - 520, y: base.y - 300 },
      size: { width: 1040, height: 600 },
      props: { kind: "glow", life: 2800, intensity: 0.34 },
      style: { fill: COLORS.light },
    }),
  };
  for (let index = 0; index < 8; index += 1) {
    const angle = (index / 8) * Math.PI * 2 + 0.2;
    items[`fire-stone${index}`] = locked({
      type: "shape",
      parent: IDS.fire,
      z: 1 + (Math.sin(angle) > 0 ? 4 : 0),
      position: { x: Math.round(base.x + Math.cos(angle) * 64 - 12), y: Math.round(base.y + Math.sin(angle) * 24 - 8) },
      size: { width: 24, height: 15 },
      props: { geometry: "ellipse" },
      style: { fill: COLORS.stone, strokeWidth: 0 },
    });
  }
  items["fire-log-a"] = locked({
    type: "shape",
    parent: IDS.fire,
    z: 2,
    position: { x: base.x - 60, y: base.y - 10 },
    size: { width: 120, height: 18 },
    rotation: 16,
    props: { geometry: "rounded" },
    style: { fill: COLORS.log, strokeWidth: 0, radius: 8 },
  });
  items["fire-log-b"] = locked({
    type: "shape",
    parent: IDS.fire,
    z: 3,
    position: { x: base.x - 60, y: base.y - 10 },
    size: { width: 120, height: 18 },
    rotation: -16,
    props: { geometry: "rounded" },
    style: { fill: COLORS.logEnd, strokeWidth: 0, radius: 8 },
  });
  items["fire-flames"] = locked({
    type: "effect",
    parent: IDS.fire,
    z: 6,
    position: { x: base.x - 36, y: base.y - 34 },
    size: { width: 72, height: 30 },
    props: { kind: "particles", rate: 64, life: 820, particleSize: 26, speed: 74, direction: -90, spread: 26, gravity: -40, intensity: 0.92, seed: "flames" },
    style: { fill: COLORS.flame },
  });
  items["fire-core"] = locked({
    type: "effect",
    parent: IDS.fire,
    z: 7,
    position: { x: base.x - 20, y: base.y - 28 },
    size: { width: 40, height: 22 },
    props: { kind: "particles", rate: 46, life: 520, particleSize: 17, speed: 52, direction: -90, spread: 22, gravity: -20, intensity: 1, seed: "core" },
    style: { fill: COLORS.core },
  });
  items["fire-sparks"] = locked({
    type: "effect",
    parent: IDS.fire,
    z: 8,
    position: { x: base.x - 16, y: base.y - 50 },
    size: { width: 32, height: 24 },
    props: { kind: "particles", rate: 5, life: 1900, particleSize: 4, speed: 120, direction: -90, spread: 70, gravity: -12, intensity: 1, seed: "sparks" },
    style: { fill: COLORS.spark },
  });
  return items;
};

const seats = (): Items => {
  const items: Items = {};
  const place: Array<[number, number, number]> = [
    [-290, 110, 22],
    [280, 96, -18],
    [-40, 330, 3],
  ];
  place.forEach(([x, y, rotation], index) => {
    items[`x-seat${index}`] = locked({
      type: "shape",
      z: 7,
      position: { x: x - 60, y: y - 14 },
      size: { width: 120, height: 28 },
      rotation,
      props: { geometry: "rounded" },
      style: { fill: COLORS.log, strokeWidth: 0, radius: 12 },
    });
  });
  return items;
};

const sign = (labels: SignLabels): Items => {
  const items: Items = {
    "x-sign": locked({
      type: "frame",
      z: 6,
      position: { x: -560, y: 120 },
      size: { width: 210, height: 190 },
      props: { decoration: "none", clip: false, label: "" },
    }),
    "x-sign-post": locked({
      type: "shape",
      parent: "x-sign",
      z: 0,
      position: { x: 98, y: 70 },
      size: { width: 14, height: 118 },
      props: { geometry: "rectangle" },
      style: { fill: COLORS.log, strokeWidth: 0 },
    }),
    "x-sign-board": locked({
      type: "shape",
      parent: "x-sign",
      z: 1,
      position: { x: 0, y: 0 },
      size: { width: 210, height: 104 },
      props: { geometry: "rounded" },
      style: { fill: COLORS.sign, stroke: COLORS.logEnd, strokeWidth: 2, radius: 6 },
    }),
  };
  labels.sign.forEach((line, index) => {
    items[`x-sign-line${index}`] = locked({
      type: "text",
      parent: "x-sign",
      z: 2,
      position: { x: 16, y: 16 + index * 26 },
      props: { text: line, fontSize: 12, font: FONTS.pixel, width: 178, fontWeight: 400 },
      style: { fill: COLORS.signInk },
    });
  });
  return items;
};

const sky = (): Items => ({
  "x-sky": locked({
    type: "effect",
    z: 1,
    position: { x: -2200, y: -2500 },
    size: { width: 4400, height: 1800 },
    props: { kind: "particles", rate: 44, life: 5200, particleSize: 3.5, speed: 3, spread: 360, intensity: 0.85, seed: "sky" },
    style: { fill: COLORS.dust },
  }),
  "x-moon-glow": locked({
    type: "effect",
    z: 2,
    position: { x: 340, y: -1780 },
    size: { width: 420, height: 420 },
    props: { kind: "glow", life: 9000, intensity: 0.26 },
    style: { fill: COLORS.moon },
  }),
  "x-moon": locked({
    type: "shape",
    z: 3,
    position: { x: 500, y: -1620 },
    size: { width: 96, height: 96 },
    props: { geometry: "ellipse" },
    style: { fill: COLORS.moon, strokeWidth: 0 },
  }),
  "x-moon-shade": locked({
    type: "shape",
    z: 4,
    position: { x: 524, y: -1632 },
    size: { width: 88, height: 88 },
    props: { geometry: "ellipse" },
    style: { fill: COLORS.night, strokeWidth: 0 },
  }),
});

const ground = (): Items => ({
  "x-ground": locked({
    type: "shape",
    z: 0,
    position: { x: MEADOW.cx - MEADOW.rx - 120, y: MEADOW.cy - MEADOW.ry - 80 },
    size: { width: (MEADOW.rx + 120) * 2, height: (MEADOW.ry + 80) * 2 },
    props: { geometry: "ellipse" },
    style: { fill: COLORS.ground, strokeWidth: 0 },
  }),
  "x-ground-inner": locked({
    type: "shape",
    z: 0.5,
    position: { x: MEADOW.cx - 620, y: MEADOW.cy - 400 },
    size: { width: 1240, height: 800 },
    props: { geometry: "ellipse" },
    style: { fill: COLORS.groundInner, strokeWidth: 0 },
  }),
  "x-burn-ring": locked({
    type: "shape",
    z: 0.7,
    position: { x: -BURN_RADIUS, y: -BURN_RADIUS * 0.5 },
    size: { width: BURN_RADIUS * 2, height: BURN_RADIUS },
    props: { geometry: "ellipse" },
    style: { fill: "#1a1716", strokeWidth: 0 },
  }),
  "x-fireflies": locked({
    type: "effect",
    z: 9,
    position: { x: -1000, y: -480 },
    size: { width: 2000, height: 1100 },
    props: { kind: "particles", rate: 2.4, life: 5600, particleSize: 5, speed: 12, spread: 360, intensity: 0.75, seed: "fireflies" },
    style: { fill: COLORS.firefly },
  }),
});

export const scenery = (labels: SignLabels): BoardPatch => ({
  board: {
    title: "Ember",
    background: { kind: "solid", color: COLORS.night },
  },
  items: {
    ...ground(),
    ...sky(),
    ...trees(),
    ...seats(),
    ...sign(labels),
    ...fire(labels),
    [IDS.campers]: locked({
      type: "custom",
      z: 1000,
      position: { x: 0, y: 0 },
      size: { width: 8, height: 8 },
      script: { src: SCRIPTS.campers, seed: "ember-campers", params: { wave: labels.wave } },
    }),
    [IDS.fx]: locked({
      type: "custom",
      z: 1100,
      position: { x: 0, y: 0 },
      size: { width: 8, height: 8 },
      script: { src: SCRIPTS.fx, seed: "ember-fx" },
    }),
  },
});

export type CardView = { id: string; text: string; x: number; y: number; by: Author; z: number };

export const cardRoot = (id: string) => `c-${id}`;
export const wovenLinkId = (source: string, card: string) => `l-${source}-${card}`;

export const cardSize = (text: string) => ({ width: CARD_WIDTH, height: cardHeight(text) });
export const cardCenter = (card: Pick<CardView, "x" | "y" | "text">): Point => {
  const size = cardSize(card.text);
  return { x: card.x + size.width / 2, y: card.y + size.height / 2 };
};

export const cardItems = (card: CardView, by: { spiritLabel: string }): Items => {
  const root = cardRoot(card.id);
  const { width, height } = cardSize(card.text);
  const woven = card.by.spirit === true;
  const tilt = ((hash(card.id) % 70) - 35) / 10;
  const items: Items = {
    [root]: {
      type: "frame",
      z: 20 + card.z,
      position: { x: Math.round(card.x), y: Math.round(card.y) },
      size: { width, height },
      rotation: tilt,
      props: { decoration: "none", clip: false, label: "" },
      metadata: { ember: { card: card.id } },
    },
    [`${root}-shadow`]: {
      type: "shape",
      parent: root,
      z: 0,
      position: { x: 3, y: 6 },
      size: { width, height },
      opacity: 0.45,
      props: { geometry: "rounded" },
      style: { fill: "#05070c", strokeWidth: 0, radius: 6 },
    },
    [`${root}-paper`]: {
      type: "shape",
      parent: root,
      z: 1,
      size: { width, height },
      props: { geometry: "rounded" },
      style: woven
        ? { fill: COLORS.woven, stroke: COLORS.wovenEdge, strokeWidth: 1.5, dash: "dashed", radius: 6 }
        : { fill: COLORS.paper, strokeWidth: 0, radius: 4 },
    },
    [`${root}-tape`]: {
      type: "shape",
      parent: root,
      z: 2,
      position: { x: width / 2 - 28, y: -8 },
      size: { width: 56, height: 16 },
      rotation: -3,
      opacity: 0.88,
      props: { geometry: woven ? "diamond" : "rectangle" },
      style: { fill: woven ? COLORS.wovenEdge : card.by.color, strokeWidth: 0 },
    },
    [`${root}-text`]: {
      type: "text",
      parent: root,
      z: 3,
      position: { x: 16, y: 22 },
      props: { text: card.text, fontSize: 15, lineHeight: 1.4, width: width - 32, font: FONTS.body, fontWeight: 500 },
      style: { fill: woven ? COLORS.wovenInk : COLORS.paperInk },
    },
    [`${root}-by`]: {
      type: "text",
      parent: root,
      z: 3,
      position: { x: 16, y: height - 24 },
      props: { text: woven ? `✦ ${by.spiritLabel}` : `— ${card.by.name}`, fontSize: 9, font: FONTS.pixel, fontWeight: 400, width: width - 32 },
      style: { fill: woven ? COLORS.wovenEdge : COLORS.paperMuted },
    },
  };
  return items;
};

export const wovenLink = (source: string, card: string): Item => ({
  type: "arrow",
  z: 19,
  opacity: 0.75,
  props: { start: { item: cardRoot(source) }, end: { item: cardRoot(card) }, bend: 0.18, arrowEnd: true, relation: "woven" },
  style: { stroke: COLORS.wovenEdge, strokeWidth: 1.6, dash: "dashed" },
});

export type StarView = { id: string; x: number; y: number; by: Author; name?: string; text: string };

export const starRoot = (id: string) => `s-${id}`;
export const starLinkId = (id: string) => `k-${id}`;
export const starGlowId = (id: string) => `s-${id}-glow`;
export const starNameId = (id: string) => `s-${id}-name`;

export const starDot = (star: StarView): Item =>
  locked({
    type: "shape",
    z: 16,
    position: { x: star.x - 11, y: star.y - 11 },
    size: { width: 22, height: 22 },
    props: { geometry: "path", path: SPARKLE_PATH },
    style: { fill: COLORS.star, strokeWidth: 0 },
    metadata: { ember: { star: star.id, text: star.text, by: star.by.name } },
  });

export const starGlow = (star: Pick<StarView, "id" | "x" | "y">): Item =>
  locked({
    type: "effect",
    z: 15,
    position: { x: star.x - 48, y: star.y - 48 },
    size: { width: 96, height: 96 },
    props: { kind: "glow", life: 2400 + (hash(star.id) % 1800), intensity: 0.6 },
    style: { fill: COLORS.starGlow },
  });

export const starName = (star: Pick<StarView, "x" | "y" | "name">): Item =>
  locked({
    type: "text",
    z: 16,
    position: { x: star.x - 120, y: star.y + 22 },
    props: { text: star.name ?? "", fontSize: 18, font: FONTS.pixel, fontWeight: 400, width: 240, align: "center" },
    style: { fill: COLORS.starName },
  });

export const starLink = (from: string, to: string, color: string): Item =>
  locked({
    type: "arrow",
    z: 14,
    opacity: 0.55,
    props: { start: { item: starRoot(from) }, end: { item: starRoot(to) }, arrowEnd: false, relation: "constellation" },
    style: { stroke: color, strokeWidth: 2, dash: "dotted" },
  });

export type InkView = { id: string; color: string; size: number; points: readonly Point[] };

export const inkId = (id: string) => `i-${id}`;

export const inkItem = (ink: InkView): Item =>
  locked({
    type: "draw",
    z: 3,
    opacity: 0.82,
    props: { points: ink.points.map((point) => ({ x: point.x, y: point.y, p: 0.5 })) },
    style: { stroke: ink.color, strokeWidth: ink.size },
  });

export const clampCard = (x: number, y: number, text: string): Point => {
  const { width, height } = cardSize(text);
  return {
    x: Math.round(Math.min(MEADOW.cx + MEADOW.rx - width, Math.max(MEADOW.cx - MEADOW.rx, x))),
    y: Math.round(Math.min(MEADOW.cy + MEADOW.ry - height, Math.max(MEADOW.cy - MEADOW.ry, y))),
  };
};
