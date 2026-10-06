import type { SessionForkRecord } from "@cohub/protocol/model";

export type SessionForkListItem = SessionForkRecord & {
  firstUserTextAfterFork: string | null;
  parentTitle: string | null;
};

/** Fork edge shaped for sidebar rendering. `parentSessionId`/`parentTitle` may be
 * redacted to null when the parent session is not visible to the current viewer. */
export type SidebarSessionFork = Omit<SessionForkListItem, "parentSessionId"> & {
  parentSessionId: string | null;
};

/**
 * Redact fork edges for a viewer. Members see everything; non-members lose the
 * parent linkage (and its title) whenever the parent session is not in their
 * visible set. Shared by session list and label item endpoints so both surfaces
 * enforce identical visibility.
 */
export const redactSessionForksForViewer = (forks: SessionForkListItem[], input: { isMember: boolean; visibleSessionIds: Iterable<string> }): SidebarSessionFork[] => {
  if (input.isMember) return forks;
  const visible = new Set(input.visibleSessionIds);
  return forks.map((fork) => {
    const parentVisible = visible.has(fork.parentSessionId);
    const rootVisible = visible.has(fork.rootSessionId);
    const anchorVisible = visible.has(fork.anchorSourceSessionId);
    return {
      ...fork,
      parentSessionId: parentVisible ? fork.parentSessionId : null,
      parentTitle: parentVisible ? fork.parentTitle : null,
      // Hide private ancestry graph for viewers who cannot see those sessions.
      rootSessionId: rootVisible ? fork.rootSessionId : fork.childSessionId,
      anchorSourceSessionId: anchorVisible ? fork.anchorSourceSessionId : fork.childSessionId,
      ancestorSessionIds: fork.ancestorSessionIds.filter((id) => visible.has(id)),
      sessionPath: fork.sessionPath.filter((id) => visible.has(id)),
    };
  });
};

export const redactCrossSpaceSessionForks = (forks: SessionForkListItem[], input: { fullViewSpaceIds: ReadonlySet<string>; visibleSessionIds: Iterable<string> }): SidebarSessionFork[] => {
  const full = forks.filter((fork) => input.fullViewSpaceIds.has(fork.spaceId));
  const partial = forks.filter((fork) => !input.fullViewSpaceIds.has(fork.spaceId));
  return [...full, ...redactSessionForksForViewer(partial, { isMember: false, visibleSessionIds: input.visibleSessionIds })];
};
