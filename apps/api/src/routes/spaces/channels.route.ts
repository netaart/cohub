import { createLogger } from "@cohub/infra/logging";
import { Hono } from "hono";
import { db } from "../../db/index.js";
import { spaceChannels, userChannels } from "@cohub/db";
import { eq, and, inArray } from "drizzle-orm";
import { useAuth, getOptionalAuth, requireValidId, authzDenied } from "../../lib/middleware.js";
import { getSpaceById } from "../../space-sessions.js";
import { getSpaceChannelsBySpaceId, bindSpaceChannelsToGateway, unbindSpaceChannelFromGateway, updateSpaceChannelConfig } from "../../channels.js";
import { fallbackBoundChannelHealth, getChannelHealthMap } from "../../channel-health.js";
import { hasPermission } from "../../permissions.js";
import { parseChannelConfigPatch, mergeChannelConfig, validateChannelModelConfig } from "../../lib/channel-model-config.js";

const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();

router.get("/:id/channels", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "channel.view", { spaceId }))) return authzDenied(c);

  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);

  const channels = await getSpaceChannelsBySpaceId(space.id);
  const channelIds = channels.map((item) => item.channelId);
  const channelList =
    channelIds.length > 0
      ? await db.select().from(userChannels).where(inArray(userChannels.id, channelIds))
      : [];

  const userChannelById = new Map(channelList.map((item) => [item.id, item]));
  const healthBySpaceChannelId = await getChannelHealthMap(channels.map((channel) => channel.id));

  return c.json(
    channels.map((channel) => {
      const userChannel = userChannelById.get(channel.channelId) ?? null;
      const safeChannel = userChannel
        ? (({ credentials: _credentials, ...rest }) => rest)(userChannel)
        : null;
      return {
        ...channel,
        channel: safeChannel,
        health: healthBySpaceChannelId.get(channel.id) ?? fallbackBoundChannelHealth(),
      };
    }),
  );
});

router.post("/:id/channels/:channelId", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const channelId = c.req.param("channelId");
  if (!requireValidId(spaceId) || !requireValidId(channelId)) {
    return c.json({ message: "space or channel not found" }, 404);
  }
  if (!(await hasPermission(user, "channel.manage", { spaceId }))) return authzDenied(c);

  // Verify ownership: the channel must belong to the same user
  const [userChannel] = await db.select().from(userChannels).where(and(eq(userChannels.id, channelId), eq(userChannels.userUuid, user.uuid))).limit(1);
  if (!userChannel) return c.json({ message: "channel not owned by you" }, 403);

  // Check if already bound to any space
  const [existingBinding] = await db.select({ id: spaceChannels.id }).from(spaceChannels).where(eq(spaceChannels.channelId, channelId)).limit(1);
  if (existingBinding) return c.json({ message: "channel is already bound to another space" }, 409);

  const body = (await c.req.json<{ config?: unknown }>().catch(() => ({}))) as { config?: unknown };
  let channelConfig: ReturnType<typeof parseChannelConfigPatch>;
  try {
    channelConfig = parseChannelConfigPatch(body.config ?? null);
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : "invalid channel config" }, 400);
  }
  if (!(await validateChannelModelConfig(db, spaceId, channelConfig?.model ?? null))) {
    return c.json({ message: "model not found" }, 400);
  }

  const [spaceChannel] = await db.insert(spaceChannels).values({
    spaceId,
    channelId,
    config: channelConfig,
  }).returning();

  if (!spaceChannel) return c.json({ message: "failed to bind channel" }, 500);

  // Push to gateway so it starts listening (bindSingleChannelToGateway handles config cache internally)
  void bindSpaceChannelsToGateway(spaceId).catch((error) => logger.error("[SpaceChannels] failed to bind channel to gateway", { spaceId, error }));

  return c.json(spaceChannel, 201);
});

router.patch("/:id/channels/:channelId", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const channelId = c.req.param("channelId");
  if (!requireValidId(spaceId) || !requireValidId(channelId)) {
    return c.json({ message: "space or channel not found" }, 404);
  }
  if (!(await hasPermission(user, "channel.manage", { spaceId }))) return authzDenied(c);

  const [spaceChannel] = await db.select().from(spaceChannels).where(and(eq(spaceChannels.spaceId, spaceId), eq(spaceChannels.channelId, channelId))).limit(1);
  if (!spaceChannel) return c.json({ message: "channel not bound to this space" }, 404);

  const body = (await c.req.json<{ config?: unknown }>().catch(() => ({}))) as { config?: unknown };
  let configPatch: ReturnType<typeof parseChannelConfigPatch>;
  try {
    configPatch = parseChannelConfigPatch(body.config ?? null);
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : "invalid channel config" }, 400);
  }

  const nextConfig = mergeChannelConfig(spaceChannel.config, configPatch);
  if (!(await validateChannelModelConfig(db, spaceId, nextConfig?.model ?? null))) {
    return c.json({ message: "model not found" }, 400);
  }

  const updated = await updateSpaceChannelConfig({ spaceChannelId: spaceChannel.id, config: nextConfig });
  if (!updated) return c.json({ message: "failed to update channel config" }, 500);

  return c.json(updated);
});

router.delete("/:id/channels/:channelId", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const channelId = c.req.param("channelId");
  if (!requireValidId(spaceId) || !requireValidId(channelId)) {
    return c.json({ message: "space or channel not found" }, 404);
  }
  if (!(await hasPermission(user, "channel.manage", { spaceId }))) return authzDenied(c);

  const [spaceChannel] = await db.select().from(spaceChannels).where(and(eq(spaceChannels.spaceId, spaceId), eq(spaceChannels.channelId, channelId))).limit(1);
  if (!spaceChannel) return c.json({ message: "channel not bound to this space" }, 404);

  await db.delete(spaceChannels).where(eq(spaceChannels.id, spaceChannel.id));
  // Remove from gateway routing
  void unbindSpaceChannelFromGateway(spaceChannel.id).catch((error) => logger.error("[SpaceChannels] failed to unbind channel from gateway", { spaceId, spaceChannelId: spaceChannel.id, error }));

  return c.json({ ok: true });
});

export default router;
