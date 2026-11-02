import { eq } from "drizzle-orm";
import { apps } from "@cohub/db";
import { db } from "./db/index.js";
import type { AuthUser } from "./lib/middleware.js";
import { hasPermission } from "./permissions.js";

export const requiresSpaceAppAccess = (app: Pick<typeof apps.$inferSelect, "visibility">) =>
  (app.visibility ?? "public") === "space";

export async function canViewPublishedApp(user: AuthUser | null, appId: string): Promise<boolean> {
  const [app] = await db
    .select({ spaceId: apps.spaceId, status: apps.status, visibility: apps.visibility })
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1);
  if (app?.status !== "published") return false;
  return !requiresSpaceAppAccess(app) || hasPermission(user, "space.view", { spaceId: app.spaceId });
}
