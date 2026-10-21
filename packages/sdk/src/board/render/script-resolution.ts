const RESOLUTIONS = [0.125, 0.25, 0.5, 1, 2, 4] as const;
const MAX_EDGE = 2048;
const MAX_PIXELS = 2_097_152;

export function scriptResolution(width: number, height: number, demand: number, current = 0): number {
  const target = Number.isFinite(demand) && demand > 0 ? demand : 1;
  const tier = current > 0 && target <= current * 1.15 && target >= current * 0.4
    ? current
    : RESOLUTIONS.find((value) => value >= target) ?? 4;
  return Math.min(tier, MAX_EDGE / Math.max(1, width, height), Math.sqrt(MAX_PIXELS / Math.max(1, width * height)));
}
