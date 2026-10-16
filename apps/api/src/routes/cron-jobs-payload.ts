/** Preserve the scheduled target, server-owned auth, and creation provenance. */
export function preserveCronPayloadServerFields(
  nextPayload: Record<string, unknown>,
  originalPayload: unknown,
): Record<string, unknown> {
  const merged = { ...nextPayload };
  const original = originalPayload as Record<string, unknown> | null | undefined;
  for (const key of ["sessionId", "auth", "origin", "requestSource"] as const) {
    delete merged[key];
    if (original?.[key] !== undefined) merged[key] = original[key];
  }
  return merged;
}
