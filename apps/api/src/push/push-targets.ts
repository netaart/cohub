import { and, desc, eq, sql } from "drizzle-orm";
import { userPushTargets, type PushTargetEnvironment } from "@cohub/db";
import { db } from "../db/index.js";
import type { ApnsTarget } from "./apns.js";

/** Newest registrations win when a user has more devices than one push fans out to. */
export const MAX_PUSH_TARGETS_PER_USER = 20;

/** Upserts by token; a token registered for another user moves to this one. */
export const upsertPushTarget = async (input: {
  userUuid: string;
  token: string;
  environment: PushTargetEnvironment;
  topic: string;
}) => {
  await db
    .insert(userPushTargets)
    .values(input)
    .onConflictDoUpdate({
      target: userPushTargets.token,
      set: {
        userUuid: input.userUuid,
        environment: input.environment,
        topic: input.topic,
        updatedAt: sql`now()`,
      },
    });
};

export const deleteUserPushTarget = async (input: { userUuid: string; token: string }) => {
  await db
    .delete(userPushTargets)
    .where(and(eq(userPushTargets.token, input.token), eq(userPushTargets.userUuid, input.userUuid)));
};

export const listUserPushTargets = async (userUuid: string): Promise<ApnsTarget[]> =>
  db
    .select({
      token: userPushTargets.token,
      environment: userPushTargets.environment,
      topic: userPushTargets.topic,
    })
    .from(userPushTargets)
    .where(eq(userPushTargets.userUuid, userUuid))
    .orderBy(desc(userPushTargets.updatedAt))
    .limit(MAX_PUSH_TARGETS_PER_USER);

/** Deletes exactly the registration APNs rejected, not a newer re-registration of the token. */
export const deleteRejectedPushTarget = async (target: ApnsTarget) => {
  await db
    .delete(userPushTargets)
    .where(and(
      eq(userPushTargets.token, target.token),
      eq(userPushTargets.environment, target.environment),
      eq(userPushTargets.topic, target.topic),
    ));
};
