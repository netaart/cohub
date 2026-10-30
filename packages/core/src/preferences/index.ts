import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { userPreferences } from "@cohub/db";
import {
  applyUserPreferencesPatch,
  MAX_CRON_JOB_NOTIFICATION_OVERRIDES,
  parseUserPreferences,
  type UserPreferences,
  type UserPreferencesPatch,
} from "@cohub/protocol/notifications";

type Database = PostgresJsDatabase<Record<string, unknown>>;

export class UserPreferencesLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserPreferencesLimitError";
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
    await tx.insert(userPreferences).values({ userUuid }).onConflictDoNothing();
    const [row] = await tx
      .select({ data: userPreferences.data })
      .from(userPreferences)
      .where(eq(userPreferences.userUuid, userUuid))
      .for("update");
    const next = applyUserPreferencesPatch(parseUserPreferences(row?.data), patch);
    if (Object.keys(next.notifications.cronJobs).length > MAX_CRON_JOB_NOTIFICATION_OVERRIDES) {
      throw new UserPreferencesLimitError(
        `at most ${MAX_CRON_JOB_NOTIFICATION_OVERRIDES} scheduled tasks can have their own notification setting; reset some to follow the global setting`,
      );
    }
    // Keep keys this version does not understand.
    await tx
      .update(userPreferences)
      .set({ data: { ...row?.data, ...next }, updatedAt: new Date() })
      .where(eq(userPreferences.userUuid, userUuid));
    return next;
  });
}

export async function deleteCronJobNotificationOverride(db: Database, userUuid: string, cronJobId: string) {
  await db
    .update(userPreferences)
    .set({
      data: sql`${userPreferences.data} #- ${`{notifications,cronJobs,${cronJobId}}`}::text[]`,
      updatedAt: new Date(),
    })
    .where(sql`${userPreferences.userUuid} = ${userUuid} and ${userPreferences.data} -> 'notifications' -> 'cronJobs' ? ${cronJobId}`);
}
