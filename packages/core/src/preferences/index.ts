import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { cronJobs, userPreferences } from "@cohub/db";
import {
  MAX_CRON_JOB_NOTIFICATION_OVERRIDES,
  parseUserPreferences,
  patchStoredUserPreferences,
  type UserPreferences,
  type UserPreferencesPatch,
} from "@cohub/protocol/notifications";

type Database = PostgresJsDatabase<Record<string, unknown>>;

/** A patch the caller can fix; maps to a 400. */
export class UserPreferencesInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserPreferencesInputError";
  }
}

export async function loadUserPreferences(db: Database, userUuid: string): Promise<UserPreferences> {
  const [row] = await db
    .select({ data: userPreferences.data })
    .from(userPreferences)
    .where(eq(userPreferences.userUuid, userUuid))
    .limit(1);
  return parseUserPreferences(row?.data);
}

/** Read-modify-write under a row lock, so concurrent clients never drop each other's changes. */
export async function updateUserPreferences(
  db: Database,
  userUuid: string,
  patch: UserPreferencesPatch,
): Promise<UserPreferences> {
  return db.transaction(async (tx) => {
    const setIds = Object.entries(patch.notifications?.cronJobs ?? {})
      .filter(([, enabled]) => enabled !== null)
      .map(([id]) => id);
    if (setIds.length > 0) {
      // Jobs before preferences, the order deletion uses: a concurrent delete
      // either waits for this write and then removes the override, or wins and
      // the job is no longer found here.
      const owned = await tx
        .select({ id: cronJobs.id })
        .from(cronJobs)
        .where(and(inArray(cronJobs.id, setIds), eq(cronJobs.userUuid, userUuid), isNull(cronJobs.deletedAt)))
        .for("share");
      const found = new Set(owned.map((job) => job.id));
      const missing = setIds.find((id) => !found.has(id));
      if (missing) throw new UserPreferencesInputError(`scheduled prompt ${missing} not found among your scheduled prompts`);
    }
    await tx.insert(userPreferences).values({ userUuid }).onConflictDoNothing();
    const [row] = await tx
      .select({ data: userPreferences.data })
      .from(userPreferences)
      .where(eq(userPreferences.userUuid, userUuid))
      .for("update");
    const data = patchStoredUserPreferences(row?.data, patch);
    const next = parseUserPreferences(data);
    if (Object.keys(next.notifications.cronJobs).length > MAX_CRON_JOB_NOTIFICATION_OVERRIDES) {
      throw new UserPreferencesInputError(
        `at most ${MAX_CRON_JOB_NOTIFICATION_OVERRIDES} scheduled tasks can have their own notification setting; reset some to follow the global setting`,
      );
    }
    await tx
      .update(userPreferences)
      .set({ data, updatedAt: new Date() })
      .where(eq(userPreferences.userUuid, userUuid));
    return next;
  });
}

/** Accepts a transaction so the override disappears together with the job. Returns whether one existed. */
export async function deleteCronJobNotificationOverride(db: Pick<Database, "update">, userUuid: string, cronJobId: string) {
  const removed = await db
    .update(userPreferences)
    .set({
      data: sql`${userPreferences.data} #- ${`{notifications,cronJobs,${cronJobId}}`}::text[]`,
      updatedAt: new Date(),
    })
    .where(sql`${userPreferences.userUuid} = ${userUuid} and ${userPreferences.data} -> 'notifications' -> 'cronJobs' ? ${cronJobId}`)
    .returning({ userUuid: userPreferences.userUuid });
  return removed.length > 0;
}
