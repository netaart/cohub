import type { Redis } from "ioredis";
import type { NotificationEmailEntry } from "@cohub/protocol";

const OUTBOX_TTL_SECONDS = 7 * 86_400;
const OUTBOX_MAX_ENTRIES = 200;
const outboxKey = (userId: string) => `notifications:email:${userId}`;

export type EmailOutbox = {
  add(entries: readonly { userId: string; entry: NotificationEmailEntry }[]): Promise<void>;
  take(userId: string, limit: number): Promise<{ entries: NotificationEmailEntry[]; more: boolean }>;
  restore(userId: string, entries: readonly NotificationEmailEntry[]): Promise<void>;
};

function parseEntry(value: string): NotificationEmailEntry[] {
  try {
    const entry = JSON.parse(value) as Partial<NotificationEmailEntry> | null;
    return typeof entry?.id === "string" && typeof entry.inbox === "boolean" && typeof entry.notice?.id === "string"
      ? [entry as NotificationEmailEntry]
      : [];
  } catch {
    return [];
  }
}

export function createRedisEmailOutbox(redis: Redis): EmailOutbox {
  return {
    async add(entries) {
      if (entries.length === 0) return;
      const pipeline = redis.multi();
      for (const { userId, entry } of entries) {
        const key = outboxKey(userId);
        pipeline.rpush(key, JSON.stringify(entry)).ltrim(key, -OUTBOX_MAX_ENTRIES, -1).expire(key, OUTBOX_TTL_SECONDS);
      }
      await pipeline.exec();
    },
    async take(userId, limit) {
      const key = outboxKey(userId);
      const results = await redis.multi().lpop(key, limit).llen(key).exec();
      const raw = (results?.[0]?.[1] as string[] | null) ?? [];
      return { entries: raw.flatMap(parseEntry), more: Number(results?.[1]?.[1] ?? 0) > 0 };
    },
    async restore(userId, entries) {
      if (entries.length === 0) return;
      const key = outboxKey(userId);
      await redis.multi().lpush(key, ...entries.map((entry) => JSON.stringify(entry)).reverse()).expire(key, OUTBOX_TTL_SECONDS).exec();
    },
  };
}
