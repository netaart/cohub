import {
  applyBoardPatchToDocument,
  type BoardDocument,
  type BoardItem,
  emptyBoardDocument,
  parseBoardItem,
} from "@neta-art/cohub/board";
import { LIMITS } from "./protocol.ts";
import {
  cardItems,
  cardRoot,
  inkId,
  inkItem,
  type SignLabels,
  scenery,
  starDot,
  starGlow,
  starGlowId,
  starLink,
  starLinkId,
  starName,
  starNameId,
  starRoot,
  wovenLink,
  wovenLinkId,
} from "./scene.ts";
import type { CampState, Card, Ink, Star } from "./state.ts";

type Raw = Record<string, unknown>;

export class CampDocument {
  private readonly base: BoardDocument;
  private readonly parsed = new WeakMap<Raw, BoardItem>();
  private readonly cards = new WeakMap<Card, Array<[string, Raw]>>();
  private readonly dots = new WeakMap<Star, Raw>();
  private readonly glows = new WeakMap<Star, Raw>();
  private readonly names = new WeakMap<Star, Raw>();
  private readonly inks = new WeakMap<Ink, Raw>();
  private readonly links = new Map<string, Raw>();
  private readonly spiritLabel: string;

  constructor(labels: SignLabels & { spirit: string }) {
    const result = applyBoardPatchToDocument(emptyBoardDocument(), scenery(labels));
    if (!result.ok) throw new Error(result.diagnostics[0]?.message ?? "Invalid camp scenery");
    this.base = result.document;
    this.spiritLabel = labels.spirit;
  }

  build(state: CampState): BoardDocument {
    const items: Record<string, BoardItem> = { ...this.base.items };
    for (const ink of state.inks.values()) items[inkId(ink.id)] = this.item(cached(this.inks, ink, () => inkItem(ink)));
    for (const card of state.cards.values()) {
      const parts = cached(this.cards, card, () =>
        Object.entries(cardItems(card, { spiritLabel: this.spiritLabel }) as Record<string, Raw>),
      );
      for (const [id, raw] of parts) items[id] = this.item(raw);
      for (const source of card.sources) {
        if (!state.cards.has(source)) continue;
        const id = wovenLinkId(source, card.id);
        items[id] = this.item(this.link(id, () => wovenLink(source, card.id)));
      }
    }
    let rank = state.stars.size;
    for (const star of state.stars.values()) {
      rank -= 1;
      items[starRoot(star.id)] = this.item(cached(this.dots, star, () => starDot(star)));
      if (rank < LIMITS.glowingStars) items[starGlowId(star.id)] = this.item(cached(this.glows, star, () => starGlow(star)));
      if (star.name) items[starNameId(star.id)] = this.item(cached(this.names, star, () => starName(star)));
      const prev = star.prev;
      if (prev && state.stars.has(prev)) {
        items[starLinkId(star.id)] = this.item(this.link(`${star.id}<${prev}`, () => starLink(prev, star.id, star.by.color)));
      }
    }
    return { board: this.base.board, items, animations: this.base.animations };
  }

  private item(raw: Raw): BoardItem {
    let item = this.parsed.get(raw);
    if (!item) {
      const result = parseBoardItem(raw);
      if (!result.ok) throw new Error(result.diagnostics[0]?.message ?? "Invalid camp item");
      item = result.item;
      this.parsed.set(raw, item);
    }
    return item;
  }

  private link(key: string, make: () => Raw) {
    let raw = this.links.get(key);
    if (!raw) {
      raw = make();
      this.links.set(key, raw);
      if (this.links.size > 2000) this.links.delete(this.links.keys().next().value as string);
    }
    return raw;
  }
}

const cached = <K extends object, V>(map: WeakMap<K, V>, key: K, make: () => V) => {
  let value = map.get(key);
  if (value === undefined) {
    value = make();
    map.set(key, value);
  }
  return value;
};

const CARD_ROOT_RE = /^c-([A-Za-z0-9_]{4,32})$/;
export const cardIdOf = (itemId: string) => CARD_ROOT_RE.exec(itemId.replace(/-(shadow|paper|tape|text|by)$/, ""))?.[1] ?? null;
export { cardRoot };
