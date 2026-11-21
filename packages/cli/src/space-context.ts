import {
  readTurnInitiator,
  type CheckpointRecord,
  type SessionArchiveFilter,
  type SessionRecord,
  type SessionTurnRecord,
  type SpaceFsEntry,
  type SpaceFsTreeResponse,
  type SpaceRecord,
  type SpaceTurnAuthorFilter,
  type SpaceTurnListItem,
  type SpaceTurnListOptions,
  type SpaceTurnsResponse,
} from "@neta-art/cohub";
import { formatBytes } from "./commands/space-files.js";

const GUIDE_FILE_CANDIDATES = ["AGENTS.md", "CLAUDE.md", "README.md"] as const;
const MAX_GUIDE_FILES = 2;
const MAX_GUIDE_CHARS = 2_500;
const MAX_PREVIEW_CHARS = 240;
const MAX_DIFF_FILES_SHOWN = 30;
const MAX_WORKSPACE_ENTRIES_SHOWN = 40;
const SESSION_PAGE_LIMIT = 100;
const MAX_SESSION_PAGES = 50;

export type SpaceContextDiffFile = {
  status: string;
  path: string;
  oldPath?: string | null;
  additions?: number | null;
  deletions?: number | null;
  binary?: boolean;
  asset?: boolean;
};

export type SpaceContextDiffSummary = {
  files: SpaceContextDiffFile[];
  stats?: {
    changedFileCount: number;
    additions: number;
    deletions: number;
  };
  truncated?: boolean;
  incomplete?: boolean;
};

export type SpaceContextFileRead = {
  content?: string;
  encoding?: string;
  delivery?: string;
  size?: number;
};

export type SessionChangedFile = {
  path: string;
  lastKind: string;
  changeCount: number;
  lastTurnSequence: number;
  lastChangedAt?: string;
};

export type SpaceContextClient = {
  spaces: {
    get(spaceId: string): Promise<SpaceRecord>;
  };
  space(spaceId: string): {
    files: {
      list(path: string): Promise<SpaceFsTreeResponse>;
      diff(): Promise<SpaceContextDiffSummary>;
      read(path: string): Promise<SpaceContextFileRead>;
    };
    sessions: {
      list(options?: { archived?: SessionArchiveFilter }): Promise<{ sessions: SessionRecord[] }>;
    };
    turns: {
      list(options: SpaceTurnListOptions): Promise<SpaceTurnsResponse>;
    };
    checkpoints: {
      list(options?: { limit?: number; cursor?: string | null }): Promise<{ checkpoints: CheckpointRecord[] }>;
    };
  };
};

export type SessionReadClient = {
  space(spaceId: string): {
    session(sessionId: string): {
      get(): Promise<{ session: SessionRecord }>;
      files(options?: { limit?: number }): Promise<{ files: SessionChangedFile[]; truncated?: boolean }>;
      turns: {
        listPaginated(options?: {
          cursor?: number;
          limit?: number;
          direction?: "older" | "newer";
        }): Promise<{
          session: unknown;
          turns: SessionTurnRecord[];
          hasMore: boolean;
          nextCursor: number | undefined;
        }>;
      };
    };
  };
};

export type SpaceGuideExcerpt = {
  path: string;
  content: string;
  truncated: boolean;
};

export type SpaceContextSnapshot = {
  spaceId: string;
  space: SpaceRecord;
  authorFilter: SpaceTurnAuthorFilter;
  workspaceEntries: SpaceFsEntry[];
  pendingDiff: SpaceContextDiffSummary | null;
  guides: SpaceGuideExcerpt[];
  sessions: SessionRecord[];
  turns: SpaceTurnListItem[];
  checkpoints: CheckpointRecord[];
  warnings: string[];
};

export type CollectSpaceContextOptions = {
  author?: SpaceTurnAuthorFilter;
  sessionsLimit?: number;
  turnsLimit?: number;
  checkpointsLimit?: number;
  includeDocs?: boolean;
};

export type SessionTranscriptSnapshot = {
  spaceId: string;
  session: SessionRecord;
  turns: SessionTurnRecord[];
  files?: SessionChangedFile[];
  filesTruncated?: boolean;
  hasMore: boolean;
};

export type ReadSessionTranscriptOptions = {
  last?: number;
  all?: boolean;
  withFiles?: boolean;
};

function cleanSingleLine(value: string | null | undefined, maxChars = MAX_PREVIEW_CHARS): string {
  if (!value) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1)}…`;
}

function truncateExcerpt(content: string, maxChars = MAX_GUIDE_CHARS): { content: string; truncated: boolean } {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxChars) {
    return { content: normalized, truncated: false };
  }
  return {
    content: `${normalized.slice(0, maxChars).trimEnd()}\n\n… (truncated)`,
    truncated: true,
  };
}

function selectGuideFiles(entries: SpaceFsEntry[]): string[] {
  const byLower = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type === "file") {
      byLower.set(entry.name.toLowerCase(), entry.name);
    }
  }
  const picked: string[] = [];
  for (const candidate of GUIDE_FILE_CANDIDATES) {
    const match = byLower.get(candidate.toLowerCase());
    if (match) {
      picked.push(match);
      if (picked.length >= MAX_GUIDE_FILES) break;
    }
  }
  return picked;
}

export async function collectSpaceContext(
  client: SpaceContextClient,
  spaceId: string,
  options: CollectSpaceContextOptions = {},
): Promise<SpaceContextSnapshot> {
  const authorFilter = options.author ?? "any";
  const sessionsLimit = options.sessionsLimit ?? 8;
  const turnsLimit = options.turnsLimit ?? 10;
  const checkpointsLimit = options.checkpointsLimit ?? 3;
  const includeDocs = options.includeDocs ?? true;
  const warnings: string[] = [];

  const spaceApi = client.space(spaceId);
  const [space, tree, pendingDiff, sessionsRes, turnsRes, checkpointsRes] = await Promise.all([
    client.spaces.get(spaceId),
    spaceApi.files.list("").catch(() => {
      warnings.push("Workspace file listing unavailable.");
      return null;
    }),
    spaceApi.files.diff().catch(() => null),
    spaceApi.sessions.list({ archived: "exclude" }).catch(() => {
      warnings.push("Active chats unavailable.");
      return null;
    }),
    spaceApi.turns.list({ limit: turnsLimit, author: authorFilter }).catch(() => {
      warnings.push("Recent turns unavailable.");
      return null;
    }),
    spaceApi.checkpoints.list({ limit: checkpointsLimit }).catch(() => null),
  ]);

  const workspaceEntries = [...(tree?.entries ?? [])].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const guides: SpaceGuideExcerpt[] = [];
  if (includeDocs && workspaceEntries.length > 0) {
    const guideNames = selectGuideFiles(workspaceEntries);
    const readResults = await Promise.all(
      guideNames.map(async (path) => {
        try {
          const file = await spaceApi.files.read(path);
          if (typeof file.content !== "string" || file.encoding === "base64") return null;
          const { content, truncated } = truncateExcerpt(file.content);
          if (!content) return null;
          return { path, content, truncated };
        } catch {
          return null;
        }
      }),
    );
    for (const guide of readResults) {
      if (guide) guides.push(guide);
    }
  }

  const sessions = [...(sessionsRes?.sessions ?? [])]
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || ""))
    .slice(0, sessionsLimit);

  return {
    spaceId,
    space,
    authorFilter,
    workspaceEntries,
    pendingDiff,
    guides,
    sessions,
    turns: turnsRes?.turns ?? [],
    checkpoints: checkpointsRes?.checkpoints ?? [],
    warnings,
  };
}

export function formatSpaceContextMarkdown(snapshot: SpaceContextSnapshot): string {
  const lines: string[] = [];
  const { space } = snapshot;
  lines.push(`# Space: ${space.name || space.slug || snapshot.spaceId}`);
  const metaParts = [`ID: \`${snapshot.spaceId}\``];
  if (space.slug) metaParts.push(`Slug: \`${space.slug}\``);
  if (space.status) metaParts.push(`Status: ${space.status}`);
  lines.push(metaParts.join(" · "));
  if (space.description?.trim()) {
    lines.push("", space.description.trim());
  }

  // Workspace top-level files
  lines.push("", "## Workspace Files");
  if (snapshot.workspaceEntries.length === 0) {
    lines.push("- (empty)");
  } else {
    const shown = snapshot.workspaceEntries.slice(0, MAX_WORKSPACE_ENTRIES_SHOWN);
    for (const entry of shown) {
      if (entry.type === "dir") {
        lines.push(`- \`${entry.name}/\``);
      } else {
        const sizeLabel = typeof entry.size === "number" ? ` (${formatBytes(entry.size)})` : "";
        lines.push(`- \`${entry.name}\`${sizeLabel}`);
      }
    }
    if (snapshot.workspaceEntries.length > shown.length) {
      lines.push(`- … ${snapshot.workspaceEntries.length - shown.length} more entries`);
    }
  }

  // Pending diff vs last save
  if (snapshot.pendingDiff) {
    lines.push("", "## Pending Changes (vs Last Save)");
    if (snapshot.pendingDiff.files.length === 0) {
      lines.push("- (no pending changes)");
    } else {
      if (snapshot.pendingDiff.stats) {
        const { changedFileCount, additions, deletions } = snapshot.pendingDiff.stats;
        lines.push(`Summary: ${changedFileCount} file(s), +${additions} / -${deletions}`);
      }
      const shown = snapshot.pendingDiff.files.slice(0, MAX_DIFF_FILES_SHOWN);
      for (const file of shown) {
        const displayPath = file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path;
        const delta = file.binary || file.asset
          ? "binary"
          : `+${file.additions ?? 0}/-${file.deletions ?? 0}`;
        lines.push(`- [${file.status}] \`${displayPath}\` (${delta})`);
      }
      if (snapshot.pendingDiff.files.length > shown.length || snapshot.pendingDiff.truncated) {
        lines.push("- … additional changes omitted");
      }
    }
  }

  // Space guide files (AGENTS.md / CLAUDE.md / README.md)
  if (snapshot.guides.length > 0) {
    lines.push("", "## Space Guides");
    for (const guide of snapshot.guides) {
      lines.push("", `### ${guide.path}`, "", guide.content);
    }
  }

  // Recent active chats
  lines.push("", "## Recent Chats");
  if (snapshot.sessions.length === 0) {
    lines.push("- (no active chats)");
  } else {
    for (const session of snapshot.sessions) {
      const title = session.title?.trim() || "(untitled)";
      const updated = (session.updatedAt || session.createdAt || "").slice(0, 19).replace("T", " ");
      const count = typeof session.totalMessages === "number" ? `${session.totalMessages} msgs` : "";
      const parts = [`\`${session.id}\``, session.status, count, updated].filter(Boolean);
      lines.push(`- **${title}** (${parts.join(" · ")})`);
    }
  }

  // Recent turns
  const turnsHeading = snapshot.authorFilter === "any"
    ? "## Recent Turns"
    : `## Recent Turns (author: ${snapshot.authorFilter})`;
  lines.push("", turnsHeading);
  if (snapshot.turns.length === 0) {
    lines.push("- (no matching turns)");
  } else {
    for (const turn of snapshot.turns) {
      const author = turn.authorProfile?.displayName || turn.authorProfile?.username || turn.userUuid || "system";
      const when = (turn.createdAt || "").slice(0, 19).replace("T", " ");
      const sessionLabel = turn.session.title?.trim()
        ? `${turn.session.title.trim()} (\`${turn.session.id}\`)`
        : `\`${turn.session.id}\``;
      lines.push(`- **${author}** · ${when} · ${sessionLabel} · #${turn.sequence} [${turn.status}]`);
      const userPreview = cleanSingleLine(turn.userPreview);
      if (userPreview) lines.push(`  - User: ${userPreview}`);
      const assistantPreview = cleanSingleLine(turn.assistantPreview);
      if (assistantPreview) lines.push(`  - Assistant: ${assistantPreview}`);
    }
  }

  // Latest saves
  if (snapshot.checkpoints.length > 0) {
    lines.push("", "## Latest Saves");
    for (const checkpoint of snapshot.checkpoints) {
      const when = (checkpoint.createdAt || "").slice(0, 19).replace("T", " ");
      const desc = checkpoint.description?.trim() || "(no description)";
      lines.push(`- \`${checkpoint.id}\` · ${when} · ${desc}`);
    }
  }

  if (snapshot.warnings.length > 0) {
    lines.push("", "## Notes");
    for (const warning of snapshot.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function readSessionTranscript(
  client: SessionReadClient,
  spaceId: string,
  sessionId: string,
  options: ReadSessionTranscriptOptions = {},
): Promise<SessionTranscriptSnapshot> {
  const all = Boolean(options.all);
  const targetCount = all ? Number.POSITIVE_INFINITY : Math.max(1, options.last ?? 30);
  const sessionApi = client.space(spaceId).session(sessionId);

  const [sessionResult, filesResult] = await Promise.all([
    sessionApi.get(),
    options.withFiles ? sessionApi.files({ limit: 200 }) : Promise.resolve(null),
  ]);

  const collected = new Map<string, SessionTurnRecord>();
  let cursor: number | undefined;
  let hasMore = false;

  for (let page = 0; page < MAX_SESSION_PAGES && collected.size < targetCount; page += 1) {
    const remaining = all ? SESSION_PAGE_LIMIT : Math.min(SESSION_PAGE_LIMIT, targetCount - collected.size);
    const res = await sessionApi.turns.listPaginated({
      cursor,
      limit: Math.max(1, remaining),
      direction: "older",
    });

    for (const turn of res.turns) {
      collected.set(turn.id, turn);
    }

    hasMore = res.hasMore;
    if (!res.hasMore || res.nextCursor === undefined || res.nextCursor === cursor || res.turns.length === 0) {
      break;
    }
    cursor = res.nextCursor;
  }

  const turns = [...collected.values()].sort((a, b) => a.sequence - b.sequence);
  const trimmed = !all && turns.length > targetCount ? turns.slice(turns.length - targetCount) : turns;
  const stillHasMore = hasMore || (!all && turns.length > targetCount);

  return {
    spaceId,
    session: sessionResult.session,
    turns: trimmed,
    ...(filesResult ? { files: filesResult.files, filesTruncated: filesResult.truncated } : {}),
    hasMore: stillHasMore,
  };
}

export function formatSessionTranscriptMarkdown(snapshot: SessionTranscriptSnapshot): string {
  const lines: string[] = [];
  const { session, turns } = snapshot;
  const title = session.title?.trim() || session.id;
  lines.push(`# Chat: ${title}`);

  const metaParts = [
    `Session: \`${session.id}\``,
    `Space: \`${snapshot.spaceId}\``,
    session.status ? `Status: ${session.status}` : "",
    `Turns: ${turns.length}${snapshot.hasMore ? "+" : ""}`,
    session.createdAt ? `Created: ${session.createdAt.slice(0, 19).replace("T", " ")}` : "",
  ].filter(Boolean);
  lines.push(metaParts.join(" · "));

  if (snapshot.hasMore) {
    lines.push("", `> Showing the latest ${turns.length} turn(s). Pass \`--all\` or \`--last <n>\` to include earlier turns.`);
  }

  if (snapshot.files) {
    lines.push("", "## Changed Files");
    if (snapshot.files.length === 0) {
      lines.push("- (no workspace files changed in this chat)");
    } else {
      for (const file of snapshot.files) {
        lines.push(`- [${file.lastKind}] \`${file.path}\` (${file.changeCount}x, last turn #${file.lastTurnSequence})`);
      }
      if (snapshot.filesTruncated) {
        lines.push("- … additional changed files omitted");
      }
    }
  }

  lines.push("", "## Transcript");
  if (turns.length === 0) {
    lines.push("", "(no turns yet)");
    return `${lines.join("\n")}\n`;
  }

  for (const turn of turns) {
    const when = (turn.createdAt || turn.updatedAt || "").slice(0, 19).replace("T", " ");
    const initiator = readTurnInitiator(turn.meta);
    const headerParts = [
      `Turn #${turn.sequence}`,
      turn.status,
      when,
      turn.model ? `${turn.provider ? `${turn.provider}/` : ""}${turn.model}` : "",
      initiator && initiator !== "human" ? `by:${initiator}` : "",
    ].filter(Boolean);
    lines.push("", `### ${headerParts.join(" · ")}`);

    const userText = turn.userText?.trim();
    if (userText) {
      lines.push("", "**User:**", "", userText);
    }

    const assistantText = turn.assistantText?.trim();
    if (assistantText) {
      lines.push("", "**Assistant:**", "", assistantText);
    } else if (turn.status === "merged" && turn.summary?.mergedIntoTurnId) {
      lines.push("", `_Merged into turn \`${turn.summary.mergedIntoTurnId}\`._`);
    } else if (turn.errorMessage) {
      lines.push("", `**Error:** ${turn.errorMessage}`);
    } else if (turn.summary?.reason === "billing") {
      lines.push("", "_Stopped: insufficient balance._");
    } else if (turn.status !== "completed") {
      lines.push("", `_Status: ${turn.status}_`);
    }
  }

  return `${lines.join("\n")}\n`;
}
