
const UNITS: Record<string, number> = { "": 1, ms: 1, s: 1000, m: 60_000 };

export function parseBoardTime(value: string, name = "time"): number {
  const match = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(ms|s|m)?\s*$/i.exec(value);
  if (!match?.[1]) throw new Error(`${name}: expected a time such as 1500, 500ms, 12.5s or 2m`);
  return Math.round(Number(match[1]) * (UNITS[(match[2] ?? "").toLowerCase()] ?? 1) * 1000) / 1000;
}

export function parseBoardTimes(value: string, name = "--at", limit = 10_000, fps?: number): number[] {
  if (value.includes(",")) {
    const entries = value.split(",");
    if (entries.length > limit) throw new Error(`${name}: frame count exceeds the limit of ${limit}`);
    return entries.map((entry) => parseBoardTime(entry, name));
  }
  const parts = value.split(":");
  if (parts.length === 1) return [parseBoardTime(value, name)];
  if (parts.length === 2 && !fps) throw new Error(`${name}: start:end needs --fps, or write start:end:step`);
  if (parts.length !== 2 && parts.length !== 3) throw new Error(`${name}: expected a time or start:end:step`);
  const [start, end, written] = parts.map((part) => parseBoardTime(part, name)) as [number, number, number | undefined];
  const step = written ?? 1000 / (fps as number);
  if (!(step > 0)) throw new Error(`${name}: step must be greater than zero`);
  if (end < start) throw new Error(`${name}: end must not be before start`);
  // Rounded steps (41.667ms) still reach the end.
  const count = Math.floor((end - start + Math.min(0.5, step / 2)) / step) + 1;
  if (count > limit) throw new Error(`${name}: ${count} frames exceed the limit of ${limit}`);
  return Array.from({ length: count }, (_, index) => Math.round((start + index * step) * 1000) / 1000);
}

export function formatBoardTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${Number((ms / 1000).toFixed(3))}s`;
}
