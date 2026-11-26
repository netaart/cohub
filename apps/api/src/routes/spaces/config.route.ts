import { SANDBOX_SPECS, getSandboxSpecRank, isSandboxSpecId, type SandboxSpecId } from "@cohub/sandbox-controller";
import { createLogger } from "@cohub/infra/logging";
import { Hono } from "hono";
import { db } from "../../db/index.js";
import { spaces } from "@cohub/db";
import { eq } from "drizzle-orm";
import { useAuth, getOptionalAuth, requireValidId, authzDenied } from "../../lib/middleware.js";
import { getSandboxImageCatalog, resolveSpaceSandboxPreferences } from "../../space-sandbox-preferences.js";
import { parseSandboxPreferences } from "../../sandbox-preferences.js";
import { scheduleSandboxAutoDestroy } from "../../sandbox-idle-scheduler.js";
import type { SpaceSandboxAutoDestroyPolicy } from "../../space-create.js";
import { getSpaceSandboxBySpaceId, markSandboxSpecPendingRestart, resizeSpaceSandboxToSpec } from "../../space-sandboxes.js";
import { hasPermission } from "../../permissions.js";
import { dispatchSpaceListChanged } from "../../space-list-events.js";
import { parseSpaceGuestInput, readSpaceGuestConfig } from "../../space-guest.js";
import { type SpaceConfigInput, createSandboxSpecRequiredResponse, getSpaceSandboxAutoDestroyPolicy, getSpaceSandboxProvider, isRecord, mergeSpaceConfig, normalizeSpaceSandboxAutoDestroyPolicy } from "./space-config.js";
import { serializeSpaceForResponse } from "./space-response.js";

const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();

router.get("/:id/config", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.view", { spaceId }))) return authzDenied(c);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);

  const [resolved, sandbox] = await Promise.all([
    resolveSpaceSandboxPreferences(spaceId),
    getSpaceSandboxBySpaceId(spaceId),
  ]);
  const appliedMeta = isRecord(sandbox?.meta) ? sandbox.meta : {};
  const pendingRestart = resolved.applicable && Boolean(sandbox) && (
    sandbox?.desiredImage !== resolved.imageRef.split("/").pop() || appliedMeta.appliedSpec !== resolved.effective.spec
  );
  return c.json({
    config: {
      sandbox: {
        provider: getSpaceSandboxProvider(space),
        autoDestroy: getSpaceSandboxAutoDestroyPolicy(space),
        spec: resolved.effective.spec,
        image: resolved.effective.image,
        preferences: {
          requested: resolved.requested,
          effective: resolved.effective,
          applied: { image: appliedMeta.appliedImage ?? null, spec: appliedMeta.appliedSpec ?? null },
          overrides: resolved.overrides,
          origins: resolved.origins,
          sources: resolved.sources,
          warnings: resolved.warnings,
          images: Object.keys(getSandboxImageCatalog()),
          pendingRestart,
          applicable: resolved.applicable,
        },
        appliedSpec: isRecord(sandbox?.meta) && isSandboxSpecId(sandbox.meta.appliedSpec) ? sandbox.meta.appliedSpec : null,
        specPendingRestart: isRecord(sandbox?.meta) ? sandbox.meta.specPendingRestart === true : false,
        allowedSpec: resolved.allowedSpec,
        specs: SANDBOX_SPECS,
      },
      guest: readSpaceGuestConfig(space.meta),
    },
  });
});

router.patch("/:id/config", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);

  const body = await c.req.json<SpaceConfigInput>().catch(() => null);
  if (!body) return c.json({ message: "invalid body" }, 400);

  const guest = body.guest === undefined ? undefined : await parseSpaceGuestInput(spaceId, body.guest);
  if (body.guest !== undefined && guest === undefined) {
    return c.json({ code: "guest_app_invalid", message: "guest page must be a published public App in this Space" }, 400);
  }
  if (!body.sandbox && guest !== undefined) {
    const [updated] = await db.update(spaces).set({ meta: mergeSpaceConfig(space, { guest }), updatedAt: new Date() }).where(eq(spaces.id, spaceId)).returning();
    if (!updated) return c.json({ message: "failed to update space config" }, 500);
    await dispatchSpaceListChanged(spaceId);
    return c.json({ space: await serializeSpaceForResponse(updated, user) });
  }

  let nextAutoDestroy: SpaceSandboxAutoDestroyPolicy;
  let nextSpec: SandboxSpecId;
  let resolved: Awaited<ReturnType<typeof resolveSpaceSandboxPreferences>>;
  try {
    const image = body.sandbox?.image;
    if (image != null) {
      parseSandboxPreferences({ image });
      if (!getSandboxImageCatalog()[image]) throw new Error("Sandbox image is unavailable");
    }
    resolved = await resolveSpaceSandboxPreferences(spaceId, {
      ...(image !== undefined ? { image } : {}),
      ...(body.sandbox?.spec !== undefined ? { spec: body.sandbox.spec } : {}),
    });
    nextAutoDestroy = body.sandbox?.autoDestroy ? normalizeSpaceSandboxAutoDestroyPolicy(body.sandbox.autoDestroy) : getSpaceSandboxAutoDestroyPolicy(space);
    nextSpec = resolved.effective.spec;
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : "invalid space config" }, 400);
  }

  const allowedSpec = resolved.allowedSpec;
  if (body.sandbox?.spec && getSandboxSpecRank(body.sandbox.spec) > getSandboxSpecRank(allowedSpec)) {
    return createSandboxSpecRequiredResponse(c, body.sandbox.spec);
  }

  const nextMeta = mergeSpaceConfig(space, { sandbox: {
    autoDestroy: nextAutoDestroy,
    ...(body.sandbox?.spec !== undefined ? { spec: body.sandbox.spec } : {}),
    ...(body.sandbox?.image !== undefined ? { image: body.sandbox.image } : {}),
  }, guest });

  const [updated] = await db.update(spaces).set({ meta: nextMeta, updatedAt: new Date(), lastActivityAt: new Date() }).where(eq(spaces.id, spaceId)).returning();
  if (!updated) return c.json({ message: "failed to update space config" }, 500);

  const sandbox = await getSpaceSandboxBySpaceId(spaceId);
  const baseAt = sandbox?.lastActivityAt ?? sandbox?.lastHeartbeatAt ?? sandbox?.createdAt ?? updated.createdAt ?? new Date();
  await scheduleSandboxAutoDestroy({ spaceId, policy: nextAutoDestroy, baseAt: baseAt ? new Date(baseAt) : null }).catch((error) => logger.error("[SandboxAutoDestroy] failed to reschedule policy", { spaceId, error }));

  const imageChanged = Boolean(sandbox) && sandbox?.desiredImage !== resolved.imageRef.split("/").pop();
  const specResult = body.sandbox?.spec !== undefined && !imageChanged ? await resizeSpaceSandboxToSpec({ spaceId, specId: nextSpec }).catch(async (error) => {
    logger.warn("[SandboxSpec] failed to resize sandbox", { spaceId, specId: nextSpec, error });
    await markSandboxSpecPendingRestart({ spaceId, specId: nextSpec, reason: "resize_failed" }).catch((markError) => {
      logger.warn("[SandboxSpec] failed to mark pending restart", { spaceId, specId: nextSpec, error: markError });
    });
    return { resized: false, pendingRestart: true, message: error instanceof Error ? error.message : String(error) };
  }) : { resized: false, pendingRestart: imageChanged };

  await dispatchSpaceListChanged(spaceId);
  return c.json({ space: await serializeSpaceForResponse(updated, user), sandbox: specResult });
});

export default router;
