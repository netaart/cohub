import { Hono } from "hono";
import { db } from "../../db/index.js";
import { spaces } from "@cohub/db";
import { eq } from "drizzle-orm";
import { useAuth, requireValidId, authzDenied } from "../../lib/middleware.js";
import { normalizeSpaceEnv, setSpaceEnv } from "../../space-sessions.js";
import { hasPermission } from "../../permissions.js";
import { SYSTEM_ENV_KEY_SET } from "@cohub/protocol/sandbox";
import { validateSpaceEnvForResponse } from "./space-config.js";

const router = new Hono();

function getExtraEnvFromSpace(space: typeof spaces.$inferSelect) {
  const meta = space.meta as Record<string, unknown> | null;
  return normalizeSpaceEnv(meta?.extraEnv);
}

async function persistSpaceEnv(space: typeof spaces.$inferSelect, envs: Array<{ name: string; value: string }>) {
  const existingMeta = space.meta as Record<string, unknown> | null;
  await db
    .update(spaces)
    .set({
      meta: { ...existingMeta, extraEnv: envs },
      updatedAt: new Date(),
      lastActivityAt: new Date(),
    })
    .where(eq(spaces.id, space.id));
  await setSpaceEnv(space.id, envs);
}

router.get("/:id/env", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);

  const envs = getExtraEnvFromSpace(space);
  return c.json({ env: envs });
});

router.post("/:id/env", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);

  const body = await c.req.json<{ name: string; value: string }>().catch(() => null);
  if (!body?.name || body.value === undefined) return c.json({ message: "name and value are required" }, 400);

  const entry = { name: body.name.trim(), value: String(body.value) };
  if (SYSTEM_ENV_KEY_SET.has(entry.name)) {
    return c.json({ message: `env name "${entry.name}" is reserved by the system` }, 400);
  }

  const existing = getExtraEnvFromSpace(space);
  const filtered = existing.filter((e) => e.name !== entry.name);
  const updated = [...filtered, entry];
  const validationError = validateSpaceEnvForResponse(updated);
  if (validationError) return c.json(validationError, 400);
  await persistSpaceEnv(space, updated);

  return c.json({ env: updated }, 201);
});

router.put("/:id/env/:name", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const envName = c.req.param("name");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);

  if (!envName?.trim()) return c.json({ message: "env name is required" }, 400);
  if (SYSTEM_ENV_KEY_SET.has(envName)) {
    return c.json({ message: `env name "${envName}" is reserved by the system` }, 400);
  }

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);

  const body = await c.req.json<{ value?: string }>().catch(() => null);
  if (!body || body.value === undefined || body.value === null) return c.json({ message: "value is required" }, 400);

  const existing = getExtraEnvFromSpace(space);
  const target = existing.find((e) => e.name === envName);
  if (!target) return c.json({ message: `env "${envName}" not found` }, 404);

  target.value = String(body.value);
  const validationError = validateSpaceEnvForResponse(existing);
  if (validationError) return c.json(validationError, 400);
  await persistSpaceEnv(space, existing);

  return c.json({ env: existing });
});

router.delete("/:id/env/:name", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const envName = c.req.param("name");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);

  const existing = getExtraEnvFromSpace(space);
  const filtered = existing.filter((e) => e.name !== envName);
  if (filtered.length === existing.length) return c.json({ message: `env "${envName}" not found` }, 404);

  await persistSpaceEnv(space, filtered);
  return c.json({ env: filtered });
});

export default router;
