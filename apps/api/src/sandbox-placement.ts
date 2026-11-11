import { eq } from "drizzle-orm";
import { loadSandboxPlacementConfig, resolveSandboxPlacement, type SandboxPlacement } from "@cohub/infra/config-runtime/sandbox-placement";
import { createLogger } from "@cohub/infra/logging";
import { DEFAULT_SANDBOX_SPEC_ID, SANDBOX_SPECS, type SandboxSpecId } from "@cohub/sandbox-controller";
import { spaces } from "@cohub/db";
import { config } from "./config.js";
import { db } from "./db/index.js";

const logger = createLogger({ serviceName: "cohub-api" });

export type { SandboxPlacement };

export async function getSpaceSandboxPlacement(spaceId: string, specId: SandboxSpecId): Promise<SandboxPlacement> {
  const spec = SANDBOX_SPECS[specId] ?? SANDBOX_SPECS[DEFAULT_SANDBOX_SPEC_ID];
  const [space] = await db.select({ owner: spaces.userUuid }).from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space?.owner) return { pool: null, resources: spec.resources };
  const placements = await loadSandboxPlacementConfig(config.platformConfigRoot, (error) => {
    logger.error("[SandboxPlacement] invalid sandbox placement config", { error });
  });
  return resolveSandboxPlacement(placements, space.owner, spec.resources);
}
