import { readText } from "../camp/protocol.ts";
import {
  EARSHOT,
  FIRE,
  fireScale,
  hash,
  hearingDistance,
  hearthRadius,
  type Point,
  SPAWN,
  WALK_SPEED,
  walkable,
} from "../camp/world.ts";
import { createTrack, type Pose, type PoseTrack, pushSample, RENDER_DELAY_MS, sampleTrack } from "../net/pose.ts";
import type { Member } from "../net/session.ts";

export type Body = {
  id: string;
  name: string;
  color: string;
  spirit: boolean;
  self: boolean;
  thinking: boolean;
  x: number;
  y: number;
  left: boolean;
  walking: boolean;
  level: number;
  mic: boolean;
};

export type FxKind = "burn" | "spark" | "arrive" | "wood" | "wave" | "puff";

export type FxInput = {
  from: Point;
  to?: Point;
  life: number;
  width?: number;
  height?: number;
  glyph?: string;
  delay?: number;
};

type Fx = FxInput & { id: string; kind: FxKind; cursor: number; born: number };
type Line = { cursor: number; id: string; text: string; name: string; spirit: boolean; born: number };

type Remote = {
  member: Member;
  track: PoseTrack;
  posed: boolean;
  drift: Point;
};

const ORBIT_RADIUS = 150;
const SPIRIT_EASE = 0.0026;
const FX_KEEP_MS = 6000;
const LINE_KEEP_MS = 4000;
const MAX_CAST = 24;

export class World {
  readonly self: Body;
  heat = 0;
  hot = false;
  reduced = false;
  zoom = 1;

  private target: Point | null = null;
  private readonly remotes = new Map<string, Remote>();
  private readonly fx: Fx[] = [];
  private readonly lines: Line[] = [];
  private fxCursor = 0;
  private lineCursor = 0;
  private sampled = 0;
  private readonly bodyCache = new Map<string, Body>();
  readonly cameras = new Set<string>();

  constructor(
    profile: { name: string; color: string },
    private readonly hooks: { feed(): void; poke(): void },
  ) {
    this.self = {
      id: "",
      name: profile.name,
      color: profile.color,
      spirit: false,
      self: true,
      thinking: false,
      x: SPAWN.x,
      y: SPAWN.y,
      left: false,
      walking: false,
      level: 0,
      mic: false,
    };
  }

  get walking() {
    return this.target !== null;
  }

  place(point: Point) {
    const at = walkable(point);
    this.self.x = at.x;
    this.self.y = at.y;
  }

  walkTo(point: Point) {
    const at = walkable(point);
    if (Math.hypot(at.x - this.self.x, at.y - this.self.y) < 6) return false;
    this.target = at;
    return true;
  }

  nudge(dx: number, dy: number) {
    if (dx === 0 && dy === 0) return;
    const length = Math.hypot(dx, dy);
    this.target = walkable({ x: this.self.x + (dx / length) * 48, y: this.self.y + (dy / length) * 48 });
  }

  step(dt: number) {
    const self = this.self;
    const target = this.target;
    if (!target) {
      self.walking = false;
      return false;
    }
    const dx = target.x - self.x;
    const dy = target.y - self.y;
    const distance = Math.hypot(dx, dy);
    const stride = (WALK_SPEED * Math.min(dt, 64)) / 1000;
    if (distance <= stride) {
      self.x = target.x;
      self.y = target.y;
      this.target = null;
      self.walking = false;
    } else {
      self.x += (dx / distance) * stride;
      self.y += (dy / distance) * stride;
      if (Math.abs(dx) > 2) self.left = dx < 0;
      self.walking = true;
    }
    return true;
  }

  get walkTarget() {
    return this.target;
  }

  sync(members: readonly Member[]) {
    const seen = new Set<string>();
    for (const member of members) {
      if (member.self) {
        this.self.id = member.participantId;
        continue;
      }
      seen.add(member.participantId);
      const current = this.remotes.get(member.participantId);
      if (current) current.member = member;
      else
        this.remotes.set(member.participantId, {
          member,
          track: createTrack(),
          posed: false,
          drift: member.spirit ? orbit(member.participantId, 0) : { x: member.x, y: member.y },
        });
    }
    for (const id of [...this.remotes.keys()]) {
      if (!seen.has(id)) {
        this.remotes.delete(id);
        this.bodyCache.delete(id);
      }
    }
  }

  pose(participantId: string, pose: Pose, now: number) {
    const remote = this.remotes.get(participantId);
    if (!remote) return;
    remote.posed = true;
    pushSample(remote.track, now, pose);
  }

  bodies(now: number): Body[] {
    const bodies: Body[] = [];
    const elapsed = this.sampled ? Math.min(100, now - this.sampled) : 16;
    this.sampled = now;
    for (const [id, remote] of this.remotes) {
      const member = remote.member;
      let body = this.bodyCache.get(id);
      if (!body) {
        body = {
          id,
          name: member.name,
          color: member.color,
          spirit: member.spirit,
          self: false,
          thinking: member.thinking,
          x: remote.drift.x,
          y: remote.drift.y,
          left: false,
          walking: false,
          level: 0,
          mic: member.mic,
        };
        this.bodyCache.set(id, body);
      }
      body.name = member.name;
      body.color = member.color;
      body.spirit = member.spirit;
      body.thinking = member.thinking;
      if (member.spirit) {
        const goal = member.placed ? { x: member.x, y: member.y } : orbit(id, now);
        const ease = 1 - (1 - SPIRIT_EASE) ** elapsed;
        const dx = goal.x - body.x;
        body.x += dx * ease;
        body.y += (goal.y - body.y) * ease;
        body.left = dx < -1;
        body.walking = Math.abs(dx) > 4;
      } else if (remote.posed) {
        const pose = sampleTrack(remote.track, now - RENDER_DELAY_MS);
        if (pose) {
          body.x = pose.x;
          body.y = pose.y;
          body.left = pose.left;
          body.walking = pose.walking;
          body.level = pose.level;
          body.mic = pose.mic;
        }
      } else {
        const ease = 1 - 0.994 ** elapsed;
        body.x += (member.x - body.x) * ease;
        body.y += (member.y - body.y) * ease;
        body.mic = member.mic;
      }
      bodies.push(body);
    }
    return bodies;
  }

  body(participantId: string) {
    return this.bodyCache.get(participantId) ?? null;
  }

  get hearth() {
    return hearthRadius(this.heat);
  }

  distanceTo(body: Point) {
    return hearingDistance(this.self, body, this.hearth);
  }

  canHear(participantId: string) {
    const body = this.bodyCache.get(participantId);
    return body ? this.distanceTo(body) < EARSHOT : false;
  }

  say(id: string, text: string, name: string, spirit: boolean, now: number) {
    this.lineCursor += 1;
    this.lines.push({ cursor: this.lineCursor, id, text: readText(text, 120), name, spirit, born: now });
    if (this.lines.length > 16) this.lines.shift();
  }

  effect(kind: FxKind, input: FxInput, now: number) {
    if (this.reduced && kind !== "arrive" && kind !== "puff") return;
    this.fxCursor += 1;
    this.fx.push({ ...input, id: `f${this.fxCursor}`, kind, cursor: this.fxCursor, born: now + (input.delay ?? 0) });
    if (this.fx.length > 24) this.fx.shift();
  }

  burn(from: Point, size: { width: number; height: number }, star: Point, now: number) {
    const mouth = { x: FIRE.x, y: FIRE.y - 24 };
    this.effect("burn", { from, to: mouth, life: 760, width: size.width, height: size.height }, now);
    this.effect("spark", { from: { x: FIRE.x, y: FIRE.y - 70 }, to: star, life: 1700, delay: 640 }, now);
    this.effect("arrive", { from: star, to: star, life: 900, delay: 640 + 1330 }, now);
  }

  private wake: (() => void) | null = null;
  private asleep: Promise<void> | null = null;

  setVisible(visible: boolean) {
    if (visible) {
      this.wake?.();
      this.wake = null;
      this.asleep = null;
    } else if (!this.asleep) {
      this.asleep = new Promise((resolve) => {
        this.wake = resolve;
      });
    }
  }

  readonly capabilities: Record<string, (owner: string, input: unknown) => Promise<unknown>> = {
    "camp.cast": async (_owner, input) => {
      await this.asleep;
      return this.cast(readSince(input), performance.now());
    },
    "camp.fire": async () => {
      await this.asleep;
      return { heat: Math.min(1, Math.max(0, (fireScale(this.heat) - 0.8) / 0.55)), hot: this.hot };
    },
    "camp.fx": async (_owner, input) => {
      await this.asleep;
      return this.drainFx(readSince(input), performance.now());
    },
    "camp.feed": async () => {
      this.hooks.feed();
      return true;
    },
    "camp.poke": async () => {
      this.hooks.poke();
      return true;
    },
  };

  private cast(since: number, now: number) {
    const self = this.self;
    const everyone = [self, ...this.bodies(now)]
      .sort((a, b) => Math.hypot(a.x - self.x, a.y - self.y) - Math.hypot(b.x - self.x, b.y - self.y))
      .slice(0, MAX_CAST);
    while (this.lines[0] && now - this.lines[0].born > LINE_KEEP_MS) this.lines.shift();
    return {
      z: this.zoom,
      reduced: this.reduced,
      c: everyone.map((body) => [
        body.self ? "me" : body.id,
        Math.round(body.x),
        Math.round(body.y),
        (hash(body.id || "me") % 628) / 100,
        (body.walking ? 1 : 0) | (body.self ? 2 : 0) | (body.left ? 4 : 0) | (body.level > 0.08 ? 8 : 0) | (body.thinking ? 16 : 0) | (this.cameras.has(body.id) ? 32 : 0),
        Math.round(body.level * 100) / 100,
        body.self ? "" : readText(body.name, 14),
        body.spirit ? "s" : body.color,
      ]),
      chat: this.lines
        .filter((line) => line.cursor > since)
        .map((line) => ({ cursor: line.cursor, id: line.id === self.id ? "me" : line.id, text: line.text, name: line.name, spirit: line.spirit })),
    };
  }

  private drainFx(since: number, now: number) {
    while (this.fx[0] && now - this.fx[0].born > FX_KEEP_MS) this.fx.shift();
    return {
      cursor: this.fxCursor,
      effects: this.fx
        .filter((effect) => effect.cursor > since)
        .map(({ id, kind, from, to, life, width, height, glyph, born }) => ({
          id,
          kind,
          from,
          to: to ?? from,
          life,
          width: width ?? 0,
          height: height ?? 0,
          glyph,
          age: now - born,
        })),
    };
  }
}

const readSince = (input: unknown) => {
  const since = (input as { since?: unknown } | null)?.since;
  return typeof since === "number" && Number.isFinite(since) ? since : 0;
};

const orbit = (id: string, now: number): Point => {
  const angle = now / 9000 + (hash(id) % 628) / 100;
  return { x: FIRE.x + Math.cos(angle) * ORBIT_RADIUS * 1.3, y: FIRE.y + 40 + Math.sin(angle) * ORBIT_RADIUS * 0.6 };
};
