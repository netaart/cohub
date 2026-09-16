import type { UserSessionListItem } from "@neta-art/cohub";

export function mergeSessionPages(current: UserSessionListItem[], incoming: UserSessionListItem[]): UserSessionListItem[] {
  const byId = new Map(current.map((session) => [session.id, session]));
  for (const session of incoming) {
    const previous = byId.get(session.id);
    if (previous && Date.parse(previous.updatedAt) > Date.parse(session.updatedAt)) continue;
    byId.set(session.id, { ...previous, ...session });
  }
  return [...byId.values()];
}

/** A head response is authoritative only within its server-ordered page boundary. */
export function reconcileSessionHead(current: UserSessionListItem[], incoming: UserSessionListItem[], hasMore: boolean, requestStartedAt: number): UserSessionListItem[] {
  const boundary = incoming.at(-1);
  if (hasMore && !boundary) return current;
  const retained = current.filter((session) => {
    if (Date.parse(session.updatedAt) > requestStartedAt) return true;
    if (!hasMore || !boundary) return false;
    if (session.lastMessageAt === null && boundary.lastMessageAt !== null) return true;
    if (session.lastMessageAt !== null && boundary.lastMessageAt === null) return false;
    if (session.lastMessageAt !== boundary.lastMessageAt) return Date.parse(session.lastMessageAt!) < Date.parse(boundary.lastMessageAt!);
    return session.id < boundary.id;
  });
  // Include matching records to preserve a newer local/event revision.
  const incomingIds = new Set(incoming.map((session) => session.id));
  return mergeSessionPages([...retained, ...current.filter((session) => incomingIds.has(session.id))], incoming);
}
