
const UNITS: Record<string, number> = { "": 1, ms: 1, s: 1000, m: 60_000 };

export function parseBoardTime(value: string, name = "time"): number {
  const match = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(ms|s|m)?\s*$/i.exec(value);
  if (!match?.[1]) throw new Error(`${name}: expected a time such as 1500, 500ms, 12.5s or 2m`);
  return Math.round(Number(match[1]) * (UNITS[(match[2] ?? "").toLowerCase()] ?? 1) * 1000) / 1000;
}

export function parseBoardTimes(value: string, name = "--at", limit = 10_000): number[] {
  const parts = value.split(":");
  if (parts.length === 1) return [parseBoardTime(value, name)];
  if (parts.length !== 3) throw new Error(`${name}: expected a time or start:end:step`);
  const [start, end, step] = parts.map((part) => parseBoardTime(part, name)) as [number, number, number];
  if (step <= 0) throw new Error(`${name}: step must be greater than zero`);
  if (end < start) throw new Error(`${name}: end must not be before start`);
  const count = Math.floor((end - start) / step + 1e-9) + 1;
  if (count > limit) throw new Error(`${name}: ${count} frames exceed the limit of ${limit}`);
  return Array.from({ length: count }, (_, index) => Math.round((start + index * step) * 1000) / 1000);
}

export function formatBoardTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${Number((ms / 1000).toFixed(3))}s`;
}
