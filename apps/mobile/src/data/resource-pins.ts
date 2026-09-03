import type { CohubClient, LabelAssignmentRecord, LabelResourceType } from "@neta-art/cohub";

// Keep the same system label as Web; the user-label endpoint also supports Chat resources.
export const PINNED_LABEL_REF = "Pinned";
export const PINNED_LABEL_SYSTEM_KEY = "user:pinned";

const PIN_CACHE_TTL_MS = 60_000;
const PIN_LOOKUP_BATCH_SIZE = 8;

type PinCacheEntry = {
  pinned: boolean;
  checkedAt: number;
};

type ClientPinCache = {
  entries: Map<string, PinCacheEntry>;
  pending: Map<string, Promise<boolean>>;
  mutations: Map<string, Promise<boolean>>;
  mutationVersions: Map<string, number>;
};

const caches = new WeakMap<CohubClient, ClientPinCache>();

function getCache(client: CohubClient) {
  const existing = caches.get(client);
  if (existing) return existing;
  const created: ClientPinCache = {
    entries: new Map(),
    pending: new Map(),
    mutations: new Map(),
    mutationVersions: new Map(),
  };
  caches.set(client, created);
  return created;
}

function resourceKey(resourceType: LabelResourceType, resourceRef: string) {
  return `${resourceType}:${resourceRef}`;
}

export function isPinnedLabelAssignment(
  assignment: Pick<LabelAssignmentRecord, "labelSystemKey">,
) {
  return assignment.labelSystemKey === PINNED_LABEL_SYSTEM_KEY;
}

export function isResourcePinned(
  assignments: readonly Pick<LabelAssignmentRecord, "labelSystemKey">[],
) {
  return assignments.some(isPinnedLabelAssignment);
}

function cachePinState(
  client: CohubClient,
  resourceType: LabelResourceType,
  resourceRef: string,
  pinned: boolean,
) {
  getCache(client).entries.set(resourceKey(resourceType, resourceRef), {
    pinned,
    checkedAt: Date.now(),
  });
}

export async function getResourcePinState(
  client: CohubClient,
  resourceType: LabelResourceType,
  resourceRef: string,
  options: { force?: boolean } = {},
) {
  const key = resourceKey(resourceType, resourceRef);
  const cache = getCache(client);
  const mutation = cache.mutations.get(key);
  if (mutation) return mutation;
  const current = cache.entries.get(key);
  if (!options.force && current && Date.now() - current.checkedAt < PIN_CACHE_TTL_MS) {
    return current.pinned;
  }
  const pending = cache.pending.get(key);
  if (pending) return pending;
  const requestVersion = cache.mutationVersions.get(key) ?? 0;

  const request = client.user.labels
    .getResourceLabels(resourceType, resourceRef)
    .then((result) => {
      const pinned = isResourcePinned(result.assignments);
      if ((cache.mutationVersions.get(key) ?? 0) === requestVersion) {
        cachePinState(client, resourceType, resourceRef, pinned);
      }
      return pinned;
    })
    .finally(() => {
      if (cache.pending.get(key) === request) cache.pending.delete(key);
    });
  cache.pending.set(key, request);
  return request;
}

export function invalidateResourcePinReads(
  client: CohubClient,
  resourceType: LabelResourceType,
  resourceRefs: readonly string[],
) {
  const cache = getCache(client);
  for (const resourceRef of new Set(resourceRefs.filter(Boolean))) {
    const key = resourceKey(resourceType, resourceRef);
    cache.pending.delete(key);
    cache.entries.delete(key);
    if (!cache.mutations.has(key)) {
      cache.mutationVersions.set(key, (cache.mutationVersions.get(key) ?? 0) + 1);
    }
  }
}

export async function loadResourcePinStates(
  client: CohubClient,
  resourceType: LabelResourceType,
  resourceRefs: readonly string[],
  options: { force?: boolean } = {},
) {
  const refs = [...new Set(resourceRefs.filter(Boolean))];
  const states: Record<string, boolean> = {};
  for (let start = 0; start < refs.length; start += PIN_LOOKUP_BATCH_SIZE) {
    const batch = refs.slice(start, start + PIN_LOOKUP_BATCH_SIZE);
    const entries = await Promise.all(
      batch.map(async (resourceRef) => [
        resourceRef,
        await getResourcePinState(client, resourceType, resourceRef, options),
      ] as const),
    );
    for (const [resourceRef, pinned] of entries) states[resourceRef] = pinned;
  }
  return states;
}

async function toggleResourcePinFromState(
  client: CohubClient,
  resourceType: LabelResourceType,
  resourceRef: string,
  wasPinned: boolean,
) {
  const key = resourceKey(resourceType, resourceRef);
  const cache = getCache(client);
  const mutationVersion = (cache.mutationVersions.get(key) ?? 0) + 1;
  cache.mutationVersions.set(key, mutationVersion);
  cache.pending.delete(key);
  cachePinState(client, resourceType, resourceRef, !wasPinned);
  const request = (async () => {
    try {
      const result = await client.user.labels.patchResourceLabels(
        resourceType,
        resourceRef,
        wasPinned
          ? { removeLabelRefs: [PINNED_LABEL_REF] }
          : { addLabelRefs: [PINNED_LABEL_REF] },
      );
      const nextPinned = isResourcePinned(result.assignments);
      if ((cache.mutationVersions.get(key) ?? 0) === mutationVersion) {
        cachePinState(client, resourceType, resourceRef, nextPinned);
      }
      return nextPinned;
    } catch (error) {
      if ((cache.mutationVersions.get(key) ?? 0) === mutationVersion) {
        cachePinState(client, resourceType, resourceRef, wasPinned);
      }
      throw error;
    }
  })();
  cache.mutations.set(key, request);
  void request.finally(() => {
    if (cache.mutations.get(key) === request) cache.mutations.delete(key);
  }).catch(() => undefined);
  return request;
}

export async function toggleResourcePin(
  client: CohubClient,
  resourceType: LabelResourceType,
  resourceRef: string,
  currentPinned?: boolean,
) {
  const key = resourceKey(resourceType, resourceRef);
  const cache = getCache(client);
  const pendingMutation = cache.mutations.get(key);
  if (pendingMutation) {
    const wasPinned = await pendingMutation.catch(() => cache.entries.get(key)?.pinned ?? false);
    return toggleResourcePinFromState(client, resourceType, resourceRef, wasPinned);
  }
  const wasPinned = currentPinned ?? await getResourcePinState(client, resourceType, resourceRef);
  const mutationAfterRead = cache.mutations.get(key);
  if (mutationAfterRead) {
    const resolvedPinned = await mutationAfterRead.catch(() => cache.entries.get(key)?.pinned ?? wasPinned);
    return toggleResourcePinFromState(client, resourceType, resourceRef, resolvedPinned);
  }
  return toggleResourcePinFromState(client, resourceType, resourceRef, wasPinned);
}
