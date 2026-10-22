import { apps, appVersions } from "@cohub/db";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

export type AppDomainEligibility = "eligible" | "ineligible" | "missing";

/** Only published, public web or port Apps are served on a custom domain. */
export async function getAppDomainEligibility(
  db: PostgresJsDatabase<Record<string, unknown>>,
  appId: string,
): Promise<AppDomainEligibility> {
  const [app] = await db
    .select({ status: apps.status, visibility: apps.visibility, currentVersionId: apps.currentVersionId })
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1);
  if (!app) return "missing";
  if (app.status !== "published" || app.visibility !== "public" || !app.currentVersionId) return "ineligible";
  const [version] = await db
    .select({ contentKind: appVersions.contentKind })
    .from(appVersions)
    .where(eq(appVersions.id, app.currentVersionId))
    .limit(1);
  return version?.contentKind === "web" ? "eligible" : "ineligible";
}
