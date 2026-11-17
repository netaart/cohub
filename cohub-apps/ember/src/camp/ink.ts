import { LIMITS } from "./protocol.ts";
import type { Point } from "./world.ts";

const TOLERANCE = 2.2;
const MAX_ABS = 4000;

const perpendicular = (point: Point, a: Point, b: Point) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  return Math.abs(dy * point.x - dx * point.y + b.x * a.y - b.y * a.x) / length;
};

const simplify = (points: readonly Point[], tolerance = TOLERANCE): Point[] => {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop() as [number, number];
    let farthest = -1;
    let distance = tolerance;
    for (let index = from + 1; index < to; index += 1) {
      const d = perpendicular(points[index] as Point, points[from] as Point, points[to] as Point);
      if (d > distance) {
        distance = d;
        farthest = index;
      }
    }
    if (farthest >= 0) {
      keep[farthest] = 1;
      stack.push([from, farthest], [farthest, to]);
    }
  }
  return points.filter((_, index) => keep[index] === 1);
};

const cap = (points: readonly Point[], max: number) => {
  if (points.length <= max) return [...points];
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, index) => points[Math.round(index * step)] as Point);
};

export const encodeInk = (points: readonly Point[]) => {
  const reduced = cap(simplify(points), LIMITS.inkPoints);
  const out: number[] = [];
  let px = 0;
  let py = 0;
  for (const point of reduced) {
    const x = Math.round(point.x);
    const y = Math.round(point.y);
    out.push(x - px, y - py);
    px = x;
    py = y;
  }
  return out.join(",");
};

export const decodeInk = (value: string): Point[] | null => {
  if (!/^-?\d+(,-?\d+)*$/.test(value)) return null;
  const numbers = value.split(",").map(Number);
  if (numbers.length % 2 !== 0 || numbers.length / 2 > LIMITS.inkPoints) return null;
  const points: Point[] = [];
  let x = 0;
  let y = 0;
  for (let index = 0; index < numbers.length; index += 2) {
    x += numbers[index] as number;
    y += numbers[index + 1] as number;
    if (Math.abs(x) > MAX_ABS || Math.abs(y) > MAX_ABS) return null;
    points.push({ x, y });
  }
  return points.length ? points : null;
};
