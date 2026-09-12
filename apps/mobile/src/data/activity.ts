import type { SpaceUsageHourlyStat } from "@neta-art/cohub";

export type TokenDay = { date: string; tokens: number; level: number };

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function activityRange(now: Date): { from: Date; to: Date } {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - from.getDay() - 84);
  return { from, to: now };
}

export function tokenDays(hourly: Pick<SpaceUsageHourlyStat, "bucketStartAt" | "totalTokens">[], from: Date, to: Date): TokenDay[] {
  const totals = new Map<string, number>();
  for (const bucket of hourly) {
    const date = new Date(bucket.bucketStartAt);
    if (!Number.isFinite(date.getTime()) || !Number.isFinite(bucket.totalTokens) || bucket.totalTokens < 0) throw new Error("Invalid token usage data. Refresh activity to try again.");
    if (date < from || date > to) continue;
    const key = localDateKey(date);
    totals.set(key, (totals.get(key) ?? 0) + bucket.totalTokens);
  }
  const max = Math.max(0, ...totals.values());
  const days: TokenDay[] = [];
  for (const day = new Date(from); day <= to; day.setDate(day.getDate() + 1)) {
    const date = localDateKey(day);
    const tokens = totals.get(date) ?? 0;
    days.push({ date, tokens, level: tokens === 0 ? 0 : Math.max(1, Math.ceil(tokens / max * 4)) });
  }
  return days;
}
