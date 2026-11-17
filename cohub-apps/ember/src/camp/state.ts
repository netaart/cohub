import { decodeInk, encodeInk } from "./ink.ts";
import {
  type Author,
  type CampEvent,
  EVENTS,
  LIMITS,
  readAuthor,
  readBurn,
  readCard,
  readColor,
  readId,
  readInk,
  readMove,
  readName,
  readNumber,
  readText,
  readWood,
} from "./protocol.ts";
import { clampCard } from "./scene.ts";
import { type Ember, type Point, placeStar, pruneEmbers } from "./world.ts";

export type Card = { id: string; text: string; x: number; y: number; by: Author; sources: readonly string[]; z: number };
export type Star = { id: string; x: number; y: number; by: Author; text: string; name?: string; prev?: string };
export type Ink = { id: string; color: string; size: number; points: readonly Point[] };

export type CampState = {
  sequence: number;
  z: number;
  cards: ReadonlyMap<string, Card>;
  stars: ReadonlyMap<string, Star>;
  inks: ReadonlyMap<string, Ink>;
  embers: readonly Ember[];
};

export type Outcome =
  | { kind: "card"; card: Card }
  | { kind: "move"; card: Card; from: Point }
  | { kind: "burn"; card: Card; star: Star }
  | { kind: "ink"; ink: Ink }
  | { kind: "wood"; name: string; from: Point }
  | { kind: "name"; star: Star }
  | null;

export const emptyCamp = (): CampState => ({
  sequence: 0,
  z: 0,
  cards: new Map(),
  stars: new Map(),
  inks: new Map(),
  embers: [],
});

const authorKey = (author: Author) => (author.spirit ? "spirit" : `${author.name}|${author.color}`);

const BURN_WEIGHT = 0.7;
const WOOD_WEIGHT = 1.6;

const withEntry = <T>(map: ReadonlyMap<string, T>, id: string, value: T) => {
  const next = new Map(map);
  next.delete(id);
  next.set(id, value);
  return next;
};

const without = <T>(map: ReadonlyMap<string, T>, id: string) => {
  const next = new Map(map);
  next.delete(id);
  return next;
};

const trim = <T>(map: Map<string, T>, limit: number) => {
  while (map.size > limit) {
    const oldest = map.keys().next().value as string;
    map.delete(oldest);
  }
  return map;
};

export const reduce = (state: CampState, event: CampEvent): { state: CampState; outcome: Outcome } => {
  if (event.sequence <= state.sequence) return { state, outcome: null };
  const advanced = { ...state, sequence: event.sequence };
  const unchanged = { state: advanced, outcome: null };
  switch (event.type) {
    case EVENTS.card: {
      const data = readCard(event.data);
      if (!data || state.cards.has(data.id) || state.stars.has(data.id) || state.cards.size >= LIMITS.cards) return unchanged;
      const at = clampCard(data.x, data.y, data.text);
      const z = state.z + 1;
      const card: Card = { id: data.id, text: data.text, x: at.x, y: at.y, by: data.by, sources: data.sources ?? [], z };
      return { state: { ...advanced, z, cards: withEntry(state.cards, card.id, card) }, outcome: { kind: "card", card } };
    }
    case EVENTS.move: {
      const data = readMove(event.data);
      const before = data && state.cards.get(data.id);
      if (!data || !before) return unchanged;
      const at = clampCard(data.x, data.y, before.text);
      const z = state.z + 1;
      const card: Card = { ...before, x: at.x, y: at.y, z };
      return {
        state: { ...advanced, z, cards: withEntry(state.cards, card.id, card) },
        outcome: { kind: "move", card, from: { x: before.x, y: before.y } },
      };
    }
    case EVENTS.burn: {
      const data = readBurn(event.data);
      const card = data && state.cards.get(data.id);
      if (!card) return unchanged;
      const key = authorKey(card.by);
      let prev: string | undefined;
      for (const star of state.stars.values()) if (authorKey(star.by) === key) prev = star.id;
      const spot = placeStar(card.id, state.stars.values());
      const star: Star = { id: card.id, x: spot.x, y: spot.y, by: card.by, text: card.text, ...(prev ? { prev } : {}) };
      const stars = trim(withEntry(state.stars, star.id, star), LIMITS.stars);
      const embers = pruneEmbers([...state.embers, { at: event.at, w: BURN_WEIGHT }], event.at);
      return {
        state: { ...advanced, cards: without(state.cards, card.id), stars, embers },
        outcome: { kind: "burn", card, star },
      };
    }
    case EVENTS.ink: {
      const data = readInk(event.data);
      const points = data && decodeInk(data.points);
      if (!data || !points || state.inks.has(data.id)) return unchanged;
      const ink: Ink = { id: data.id, color: data.color, size: data.size, points };
      return { state: { ...advanced, inks: trim(withEntry(state.inks, ink.id, ink), LIMITS.inks) }, outcome: { kind: "ink", ink } };
    }
    case EVENTS.wood: {
      const data = readWood(event.data);
      const embers = pruneEmbers([...state.embers, { at: event.at, w: WOOD_WEIGHT }], event.at);
      return { state: { ...advanced, embers }, outcome: { kind: "wood", name: data.name, from: { x: data.x, y: data.y } } };
    }
    case EVENTS.name: {
      const data = readName(event.data);
      const before = data && state.stars.get(data.id);
      if (!data || !before || before.name) return unchanged;
      const star: Star = { ...before, name: data.name };
      const stars = new Map(state.stars);
      stars.set(star.id, star);
      return { state: { ...advanced, stars }, outcome: { kind: "name", star } };
    }
    default:
      return unchanged;
  }
};

export const foldCamp = (state: CampState, events: Iterable<CampEvent>) => {
  let next = state;
  for (const event of events) next = reduce(next, event).state;
  return next;
};

type SnapshotBody = {
  v: 1;
  sequence: number;
  z: number;
  cards: Array<Omit<Card, "sources"> & { sources?: readonly string[] }>;
  stars: Star[];
  inks: Array<{ id: string; color: string; size: number; points: string }>;
  embers: Ember[];
};

const SNAPSHOT_PART_CHARS = 12_000;
export const SNAPSHOT_EVERY = { events: 320, bytes: 160_000 } as const;

const toBody = (state: CampState): SnapshotBody => ({
  v: 1,
  sequence: state.sequence,
  z: state.z,
  cards: [...state.cards.values()].map(({ sources, ...card }) => (sources.length ? { ...card, sources } : card)),
  stars: [...state.stars.values()],
  inks: [...state.inks.values()].map((ink) => ({ id: ink.id, color: ink.color, size: ink.size, points: encodeInk(ink.points) })),
  embers: [...state.embers],
});

const fromBody = (value: unknown): CampState | null => {
  const body = value as Partial<SnapshotBody> | null;
  if (body?.v !== 1 || !Array.isArray(body.cards) || !Array.isArray(body.stars) || !Array.isArray(body.inks)) return null;
  const sequence = typeof body.sequence === "number" && Number.isInteger(body.sequence) ? body.sequence : null;
  if (sequence === null) return null;
  const cards = new Map<string, Card>();
  let z = typeof body.z === "number" && Number.isFinite(body.z) ? body.z : 0;
  for (const raw of body.cards.slice(0, LIMITS.cards)) {
    const card = readCard(raw);
    if (!card) continue;
    const cardZ = readNumber((raw as { z?: unknown }).z) ?? 0;
    z = Math.max(z, cardZ);
    cards.set(card.id, { id: card.id, text: card.text, x: card.x, y: card.y, by: card.by, sources: card.sources ?? [], z: cardZ });
  }
  const stars = new Map<string, Star>();
  for (const raw of body.stars.slice(-LIMITS.stars)) {
    const value = raw as Record<string, unknown>;
    const id = readId(value?.id);
    const by = readAuthor(value?.by);
    const x = readNumber(value?.x);
    const y = readNumber(value?.y);
    if (!id || !by || x === null || y === null) continue;
    const name = readText(value.name, LIMITS.starName);
    const prev = readId(value.prev);
    stars.set(id, { id, x, y, by, text: readText(value.text, LIMITS.cardText), ...(name ? { name } : {}), ...(prev ? { prev } : {}) });
  }
  const inks = new Map<string, Ink>();
  for (const raw of body.inks.slice(-LIMITS.inks)) {
    const ink = readInk(raw);
    const points = ink && decodeInk(ink.points);
    if (ink && points) inks.set(ink.id, { id: ink.id, color: readColor(ink.color), size: ink.size, points });
  }
  const embers = Array.isArray(body.embers)
    ? body.embers
        .filter((e): e is Ember => typeof e?.at === "number" && Number.isFinite(e.at) && typeof e?.w === "number" && e.w > 0 && e.w < 10)
        .slice(-200)
    : [];
  return { sequence, z, cards, stars, inks, embers };
};

const base64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

const unbase64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

const pipe = async (bytes: Uint8Array, stream: CompressionStream | DecompressionStream) =>
  new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream)).arrayBuffer());

export const rebase = (state: CampState): CampState => ({ ...state, sequence: 0 });

export const encodeSnapshot = async (state: CampState): Promise<string[]> => {
  const json = new TextEncoder().encode(JSON.stringify(toBody(state)));
  const text = base64(await pipe(json, new CompressionStream("gzip")));
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += SNAPSHOT_PART_CHARS) parts.push(text.slice(index, index + SNAPSHOT_PART_CHARS));
  return parts.length ? parts : [""];
};

const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

export const decodeSnapshot = async (parts: readonly string[]): Promise<CampState | null> => {
  try {
    if (parts.length > 64 || parts.some((part) => typeof part !== "string" || part.length > SNAPSHOT_PART_CHARS)) return null;
    const compressed = unbase64(parts.join(""));
    const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > SNAPSHOT_MAX_BYTES) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return fromBody(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
};
