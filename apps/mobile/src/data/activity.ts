import type { AppRecord, CohubClient, SpaceUsageHourlyStat, TaskRunRecord } from "@neta-art/cohub";

export type TokenDay = { date: string; tokens: number; level: number };
export type TaskOutput = { type: "text"; text: string } | { type: "image" | "video" | "audio"; url: string };

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

export async function loadRecentWorks(client: CohubClient, userUuid: string): Promise<AppRecord[]> {
  const spaces = await client.spaces.list();
  const works: AppRecord[] = [];
  // Bound concurrency across spaces; do not silently present a partial list as complete.
  for (let index = 0; index < spaces.length; index += 4) {
    const results = await Promise.all(spaces.slice(index, index + 4).map((space) => client.apps.listBySpace(space.id)));
    works.push(...results.flatMap((result) => result.apps).filter((work) => work.userUuid === userUuid));
  }
  return works.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || b.id.localeCompare(a.id)).slice(0, 20);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function taskOutputs(task: Pick<TaskRunRecord, "result">): TaskOutput[] {
  if (!record(task.result) || !Array.isArray(task.result.output)) return [];
  return task.result.output.flatMap((block: unknown): TaskOutput[] => {
    if (!record(block)) return [];
    if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
    if ((block.type !== "image" && block.type !== "video" && block.type !== "audio") || !record(block.source)) return [];
    if (block.source.type !== "url" || typeof block.source.url !== "string") return [];
    let url: URL;
    try { url = new URL(block.source.url); } catch { return []; }
    if (url.protocol !== "https:") return [];
    return [{ type: block.type, url: url.href }];
  });
}

export function taskTitle(task: TaskRunRecord): string {
  return record(task.result) && typeof task.result.model === "string" ? task.result.model : task.taskType.replaceAll("_", " ");
}
