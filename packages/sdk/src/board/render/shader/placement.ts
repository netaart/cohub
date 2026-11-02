import type { BoardMatrix } from "@cohub/protocol/board-layout";
import type { Rect } from "../../model/geometry.js";

export function boardItemLocalToWorld(frame: { x: number; y: number; width: number; height: number; rotation: number; mirrored?: boolean }): BoardMatrix {
  const angle = (frame.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const flip = frame.mirrored ? -1 : 1;
  const cx = frame.x + frame.width / 2;
  const cy = frame.y + frame.height / 2;
  const a = cos * flip;
  const b = sin * flip;
  return [a, b, -sin, cos, cx - a * (frame.width / 2) + sin * (frame.height / 2), cy - b * (frame.width / 2) - cos * (frame.height / 2)];
}

export function boardLocalView(view: Rect, localToWorld: BoardMatrix): Rect {
  const [a, b, c, d, e, f] = localToWorld;
  const det = a * d - b * c || 1;
  const corners = [
    [view.x, view.y],
    [view.x + view.width, view.y],
    [view.x, view.y + view.height],
    [view.x + view.width, view.y + view.height],
  ].map(([x, y]) => {
    const dx = (x as number) - e;
    const dy = (y as number) - f;
    return [(d * dx - c * dy) / det, (a * dy - b * dx) / det] as const;
  });
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}
