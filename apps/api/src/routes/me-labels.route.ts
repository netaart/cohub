import { Hono } from "hono";
import { and, count, eq, inArray, ne, sql } from "drizzle-orm";
import { checkpoints, labelAssignments, labels, spaceSessions } from "@cohub/db";
import { listUserLabels, parseLabelRef, parseLabelRefs, resolveLabelPaths, resolveOrCreateLabelPaths } from "@cohub/core/labels";
import { USER_LABEL_SCOPE_TYPE, USER_SYSTEM_LABELS, getUserResourceLabelAssignments, patchUserResourcesLabels } from "@cohub/core/labels";
import { db } from "../db/index.js";
import { getPostgresErrorConstraint, isPostgresUniqueViolation } from "../db/postgres-error.js";
import { useAuth, requireValidId } from "../lib/middleware.js";
import type { AuthUser } from "../lib/middleware.js";
import { hasPermission, filterSpaceIdsByPermission } from "../permissions.js";
import { getRealtimeUserRoom } from "@cohub/protocol/realtime";
import { dispatchRealtimeEvent } from "../channels.js";

const router = new Hono();
const MAX_BATCH = 200;

function labelTree(rows: Array<typeof labels.$inferSelect>) {
  const nodes = new Map(rows.map((row) => [row.id, { ...row, children: [] as Array<typeof row> }]));
  const roots: Array<(typeof nodes extends Map<string, infer V> ? V : never)> = [];
  for (const row of rows) {
    const node = nodes.get(row.id);
    if (!node) continue;
    const parent = row.parentId ? nodes.get(row.parentId) : null;
    if (parent) parent.children.push(node as never);
    else roots.push(node as never);
  }
  return roots;
}

router.get("/labels", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  return c.json({ labels: labelTree(await listUserLabels(db, user.uuid)) });
});

router.post("/labels", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const body = await c.req.json<{ labelRef?: unknown }>().catch(() => null);
  try {
    const paths = parseLabelRefs([body?.labelRef]);
    const { labelIds } = await resolveOrCreateLabelPaths({ db, spaceId: user.uuid, scopeType: USER_LABEL_SCOPE_TYPE, paths, userId: user.uuid, systemKeys: USER_SYSTEM_LABELS });
    const rows = await listUserLabels(db, user.uuid);
    return c.json({ labels: labelTree(rows.filter((row) => labelIds.includes(row.id))) }, 201);
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : "invalid label" }, 400);
  }
});

router.post("/labels/resolve", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const body = await c.req.json<{ labelRefs?: unknown }>().catch(() => null);
  try {
    const paths = parseLabelRefs(body?.labelRefs);
    const { labelIds } = await resolveOrCreateLabelPaths({ db, spaceId: user.uuid, scopeType: USER_LABEL_SCOPE_TYPE, paths, userId: user.uuid, systemKeys: USER_SYSTEM_LABELS });
    const rows = await listUserLabels(db, user.uuid);
    return c.json({ labels: labelTree(rows.filter((row) => labelIds.includes(row.id))) });
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : "invalid labels" }, 400);
  }
});

router.patch("/labels/by-ref", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const body = await c.req.json<{ labelRef?: unknown; name?: unknown; rank?: unknown; parentRef?: unknown }>().catch(() => null);
  try {
    const path = parseLabelRef(body?.labelRef);
    const { labelIds } = await resolveLabelPaths({ db, spaceId: user.uuid, scopeType: USER_LABEL_SCOPE_TYPE, paths: [path] });
    const labelId = labelIds[0];
    if (!labelId) return c.json({ message: "label not found" }, 404);
    const [label] = await db.select().from(labels).where(and(eq(labels.id, labelId), eq(labels.scopeType, USER_LABEL_SCOPE_TYPE), eq(labels.scopeId, user.uuid)));
    if (label?.source !== "user") return c.json({ message: "label cannot be changed" }, 403);
    const patch: Partial<typeof labels.$inferInsert> = { updatedAt: new Date() };
    if (body?.name !== undefined) {
      const name = parseLabelRef(body.name);
      if (name.length !== 1) return c.json({ message: "name must be a single label" }, 400);
      const normalizedName = name[0];
      if (!normalizedName) return c.json({ message: "name is required" }, 400);
      const reservedName = Object.hasOwn(USER_SYSTEM_LABELS, normalizedName.toLowerCase());
      if (reservedName) {
        return c.json({ message: "label name is reserved" }, 400);
      }
      const [duplicate] = await db.select({ id: labels.id }).from(labels).where(and(
        eq(labels.scopeType, USER_LABEL_SCOPE_TYPE),
        eq(labels.scopeId, user.uuid),
        label.parentId ? eq(labels.parentId, label.parentId) : sql`${labels.parentId} is null`,
        sql`lower(${labels.name}) = lower(${normalizedName})`,
        ne(labels.id, label.id),
      )).limit(1);
      if (duplicate) return c.json({ message: "label already exists" }, 409);
      patch.name = normalizedName;
      patch.slug = normalizedName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "label";
    }
    if (body?.rank !== undefined) {
      if (!Number.isSafeInteger(body.rank)) return c.json({ message: "invalid rank" }, 400);
      patch.rank = body.rank as number;
    }
    if (body?.parentRef !== undefined) {
      let parentId: string | null = null;
      let depth = 0;
      if (body.parentRef !== null) {
        const parentPath = parseLabelRef(body.parentRef);
        const { labelIds: parentIds } = await resolveLabelPaths({ db, spaceId: user.uuid, scopeType: USER_LABEL_SCOPE_TYPE, paths: [parentPath] });
        const parentIdCandidate = parentIds[0];
        if (!parentIdCandidate || parentIdCandidate === label.id) return c.json({ message: "parent label not found" }, 404);
        const [parent] = await db.select({ id: labels.id, depth: labels.depth }).from(labels).where(and(eq(labels.id, parentIdCandidate), eq(labels.scopeType, USER_LABEL_SCOPE_TYPE), eq(labels.scopeId, user.uuid)));
        if (parent?.depth !== 0) return c.json({ message: "parent label not found" }, 404);
        parentId = parent.id;
        depth = 1;
      }
      const [{ value: children = 0 } = {}] = await db.select({ value: count() }).from(labels).where(eq(labels.parentId, label.id));
      if (depth === 1 && Number(children) > 0) return c.json({ message: "label has child labels" }, 400);
      patch.parentId = parentId;
      patch.depth = depth;
    }
    const [updated] = await db.update(labels).set(patch).where(eq(labels.id, label.id)).returning();
    return c.json({ label: updated });
  } catch (error) {
    if (isPostgresUniqueViolation(error) && getPostgresErrorConstraint(error)?.includes("labels_scope_parent_name")) {
      return c.json({ message: "label already exists" }, 409);
    }
    return c.json({ message: error instanceof Error ? error.message : "invalid label" }, 400);
  }
});

router.delete("/labels/by-ref", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  try {
    const paths = parseLabelRefs([c.req.query("ref")]);
    const { labelIds } = await resolveLabelPaths({ db, spaceId: user.uuid, scopeType: USER_LABEL_SCOPE_TYPE, paths });
    if (!labelIds[0]) return c.json({ message: "label not found" }, 404);
    const labelId = labelIds[0];
    const [label] = await db.select().from(labels).where(and(eq(labels.id, labelId), eq(labels.scopeType, USER_LABEL_SCOPE_TYPE), eq(labels.scopeId, user.uuid)));
    if (label?.source !== "user") return c.json({ message: "label cannot be deleted" }, 403);
    const [{ value: children = 0 } = {}] = await db.select({ value: count() }).from(labels).where(eq(labels.parentId, labelId));
    if (Number(children)) return c.json({ message: "delete child labels first" }, 400);
    await db.transaction(async (tx) => {
      await tx.delete(labelAssignments).where(and(eq(labelAssignments.scopeType, USER_LABEL_SCOPE_TYPE), eq(labelAssignments.scopeId, user.uuid), eq(labelAssignments.labelId, labelId)));
      await tx.delete(labels).where(eq(labels.id, labelId));
    });
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : "invalid label ref" }, 400);
  }
});

router.post("/labels/reorder", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  try {
    const paths = parseLabelRefs((await c.req.json<{ labelRefs?: unknown }>().catch(() => null))?.labelRefs);
    const { labelIds } = await resolveLabelPaths({ db, spaceId: user.uuid, scopeType: USER_LABEL_SCOPE_TYPE, paths });
    const rows = await db.select({ id: labels.id, source: labels.source }).from(labels).where(and(inArray(labels.id, labelIds), eq(labels.scopeType, USER_LABEL_SCOPE_TYPE), eq(labels.scopeId, user.uuid)));
    if (rows.length !== labelIds.length || rows.some((label) => label.source !== "user")) return c.json({ message: "system labels cannot be reordered" }, 403);
    await db.transaction(async (tx) => {
      for (const [index, id] of labelIds.entries()) {
        await tx.update(labels).set({ rank: (index + 1) * 10, updatedAt: new Date() }).where(and(eq(labels.id, id), eq(labels.scopeId, user.uuid), eq(labels.scopeType, USER_LABEL_SCOPE_TYPE), eq(labels.source, "user")));
      }
    });
    return c.json({ labels: labelTree(await listUserLabels(db, user.uuid)) });
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : "invalid label refs" }, 400);
  }
});

router.get("/resources/:resourceType/labels", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const resourceType = parseResourceType(c.req.param("resourceType") ?? "");
  const resourceRef = c.req.query("resourceRef")?.trim() ?? "";
  if (!resourceType || !resourceRef) return c.json({ message: "resource not found" }, 404);
  return c.json({ assignments: await getUserResourceLabelAssignments(db, user.uuid, resourceType, resourceRef) });
});

router.patch("/resources/:resourceType/labels", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const resourceType = parseResourceType(c.req.param("resourceType") ?? "");
  const resourceRef = c.req.query("resourceRef")?.trim() ?? "";
  if (!resourceType || !resourceRef) return c.json({ message: "resource not found" }, 404);
  if (!(await canLabelResource(user, resourceType, resourceRef))) return c.json({ message: "forbidden" }, 403);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ message: "invalid json body" }, 400);
  try {
    const result = await db.transaction((tx) => patchUserResourcesLabels(tx, user.uuid, resourceType, [resourceRef], body as { addLabelRefs?: string[]; removeLabelRefs?: string[] }));
    await dispatchUserLabelsChanged(user.uuid, resourceType, [resourceRef], result);
    return c.json({ assignments: await getUserResourceLabelAssignments(db, user.uuid, resourceType, resourceRef) });
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : "invalid labels" }, 400);
  }
});

router.patch("/resources/:resourceType/labels/batch", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  if (c.req.param("resourceType") !== "space") return c.json({ message: "resource not found" }, 404);
  const body = await c.req.json().catch(() => null) as { resourceRefs?: unknown; addLabelRefs?: string[]; removeLabelRefs?: string[] } | null;
  if (!Array.isArray(body?.resourceRefs) || body.resourceRefs.length < 1 || body.resourceRefs.length > MAX_BATCH || !body.resourceRefs.every((id) => typeof id === "string" && requireValidId(id))) return c.json({ message: "resourceRefs must contain 1-200 valid ids" }, 400);
  const refs = [...new Set(body.resourceRefs)];
  const allowedRefs = await filterSpaceIdsByPermission(user, "space.view", refs);
  if (allowedRefs.length !== refs.length) return c.json({ message: "forbidden" }, 403);
  try {
    const result = await db.transaction((tx) => patchUserResourcesLabels(tx, user.uuid, "space", refs, body ?? {}));
    await dispatchUserLabelsChanged(user.uuid, "space", result.resourceRefs, result);
    return c.json({ resourceRefs: result.resourceRefs, affectedLabelIds: result.affectedLabelIds });
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : "invalid labels" }, 400);
  }
});

const USER_LABEL_RESOURCE_TYPES = new Set(["space", "session", "checkpoint", "file"] as const);
type UserLabelResourceType = "space" | "session" | "checkpoint" | "file";

function parseResourceType(value: string): UserLabelResourceType | null {
  return USER_LABEL_RESOURCE_TYPES.has(value as UserLabelResourceType) ? value as UserLabelResourceType : null;
}

async function canLabelResource(user: AuthUser, resourceType: UserLabelResourceType, resourceRef: string) {
  if (resourceType === "file") return true;
  if (!requireValidId(resourceRef)) return false;
  if (resourceType === "space") return hasPermission(user, "space.view", { spaceId: resourceRef });
  if (resourceType === "session") {
    const [session] = await db.select({ spaceId: spaceSessions.spaceId }).from(spaceSessions).where(eq(spaceSessions.id, resourceRef)).limit(1);
    return Boolean(session && await hasPermission(user, "session.view", { spaceId: session.spaceId }));
  }
  const [checkpoint] = await db.select({ spaceId: checkpoints.spaceId }).from(checkpoints).where(eq(checkpoints.id, resourceRef)).limit(1);
  return Boolean(checkpoint && await hasPermission(user, "checkpoint.view", { spaceId: checkpoint.spaceId }));
}

async function dispatchUserLabelsChanged(userUuid: string, resourceType: UserLabelResourceType, resourceRefs: string[], result: { affectedLabelIds: string[]; assignmentsByRef: Array<{ resourceRef: string; assignments: unknown[] }> }) {
  await dispatchRealtimeEvent({
    id: crypto.randomUUID(), timestamp: Date.now(), domain: "label", type: "label.assignments.updated",
    spaceId: null, sessionId: null, rooms: [getRealtimeUserRoom(userUuid)],
    payload: { resourceType, resourceRef: resourceRefs[0] ?? "", resourceRefs, resourceAssignments: result.assignmentsByRef, labels: [], assignments: [], items: [], affectedLabelIds: result.affectedLabelIds },
  }).catch(() => undefined);
}

export default router;
