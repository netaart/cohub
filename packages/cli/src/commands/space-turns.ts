import {
  readTurnInitiator,
  type SpaceTurnAuthorFilter,
  type SpaceTurnListItem,
  type SpaceTurnListOptions,
  type SpaceTurnsResponse,
  type SessionTurnRecord,
  type TurnIntermediateMessagesFile,
} from "@neta-art/cohub";
import type { Command } from "commander";
import { createClient } from "../client.js";
import {
  error,
  handleHttp,
  json as outJson,
  jsonRequested,
  table,
  type Row,
} from "../output.js";
import { resolveSpace } from "../space.js";

const SPACE_TURN_AUTHORS = ["any", "self", "others"] as const;

export type SpaceTurnListCliOptions = {
  author?: string;
  after?: string;
  before?: string;
  cursor?: string;
  limit?: string;
  session?: string;
  json?: boolean;
  direction?: "older" | "newer";
};

type SpaceTurnsCommandClient = {
  space(spaceId: string): {
    turns: {
      list(options: SpaceTurnListOptions): Promise<SpaceTurnsResponse>;
    };
    session(sessionId: string): {
      turns: {
        listPaginated(options?: { cursor?: number; limit?: number; direction?: "older" | "newer" }): Promise<{
          session: unknown;
          turns: SessionTurnRecord[];
          hasMore: boolean;
          nextCursor: number | undefined;
        }>;
        intermediate: {
          get(turnId: string): Promise<TurnIntermediateMessagesFile | null>;
        };
      };
    };
  };
};

export class InvalidSpaceTurnCliOptionsError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = "InvalidSpaceTurnCliOptionsError";
  }
}

function parseAuthor(value: string | undefined): SpaceTurnAuthorFilter | undefined {
  if (value === undefined) return undefined;
  if ((SPACE_TURN_AUTHORS as readonly string[]).includes(value)) {
    return value as SpaceTurnAuthorFilter;
  }
  throw new InvalidSpaceTurnCliOptionsError(
    "Invalid author",
    `Use one of: ${SPACE_TURN_AUTHORS.join(", ")}`,
  );
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value.trim())) {
    throw new InvalidSpaceTurnCliOptionsError(
      "Invalid limit",
      "limit must be an integer from 1 to 100",
    );
  }
  const limit = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new InvalidSpaceTurnCliOptionsError(
      "Invalid limit",
      "limit must be an integer from 1 to 100",
    );
  }
  return limit;
}

function parseBefore(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim() || Number.isNaN(new Date(value).getTime())) {
    throw new InvalidSpaceTurnCliOptionsError(
      "Invalid before",
      "before must be an ISO 8601 timestamp",
    );
  }
  return value;
}

export function parseSpaceTurnListOptions(
  options: SpaceTurnListCliOptions,
): SpaceTurnListOptions {
  return {
    author: parseAuthor(options.author),
    after: options.after,
    before: parseBefore(options.before),
    cursor: options.cursor,
    limit: parseLimit(options.limit),
    sessionId: options.session,
  };
}

export function parseSessionTurnCursor(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 1) {
    throw new InvalidSpaceTurnCliOptionsError(
      "Invalid cursor",
      "Session cursor must be a positive turn sequence",
    );
  }
  return cursor;
}

export function validateSpaceTurnListMode(options: SpaceTurnListCliOptions): void {
  if (!options.session && options.direction !== undefined) {
    throw new InvalidSpaceTurnCliOptionsError(
      "Invalid direction",
      "--direction only applies with --session",
    );
  }
  if (options.session && (options.author || options.after || options.before)) {
    throw new InvalidSpaceTurnCliOptionsError(
      "Invalid session turn options",
      "--session uses the Session turns API; omit --author, --after, and --before",
    );
  }
}

export function toSpaceTurnRows(turns: SpaceTurnListItem[]): Row[] {
  return turns.map((turn) => ({
    createdAt: turn.createdAt,
    author: turn.authorProfile?.displayName ?? turn.userUuid ?? "system",
    sessionTitle: turn.session.title ?? "",
    sessionId: turn.session.id,
    sequence: turn.sequence,
    id: turn.id,
    status: turn.status,
    userPreview: turn.userPreview ?? "",
    assistantPreview: turn.assistantPreview ?? "",
  }));
}

export function registerSpaceTurns(
  spacesCmd: Command,
  dependencies: { createClient?: () => SpaceTurnsCommandClient } = {},
): Command {
  const turnsCmd = spacesCmd
    .command("turns")
    .description("Browse turns across the space")
    .hook("preAction", async () => {
      await resolveSpace(spacesCmd);
    });

  turnsCmd
    .command("ls")
    .alias("list")
    .description("List turns in the space, or full turns from one session")
    .option("--author <any|self|others>", "Filter space turns by author")
    .option("--after <cursor>", "Start after a previous snapshot cursor")
    .option("--before <timestamp>", "End at an ISO 8601 timestamp")
    .option("--cursor <cursor>", "Page cursor; with --session, use a turn sequence")
    .option("--limit <n>", "Maximum turns per page, 1-100")
    .option("--session <id>", "Use the full turn list for this session")
    .option("--direction <older|newer>", "Session page direction; use with --session")
    .option("--json", "Output as JSON")
    .action(async (options: SpaceTurnListCliOptions) => {
      let query: SpaceTurnListOptions;
      try {
        query = parseSpaceTurnListOptions(options);
      } catch (cause) {
        if (cause instanceof InvalidSpaceTurnCliOptionsError) {
          return error(cause.message, cause.detail);
        }
        throw cause;
      }

      const spaceId = await resolveSpace(spacesCmd);
      const client = dependencies.createClient?.() ?? createClient();
      try {
        try {
          validateSpaceTurnListMode(options);
        } catch (cause) {
          if (cause instanceof InvalidSpaceTurnCliOptionsError) return error(cause.message, cause.detail);
          throw cause;
        }
        if (options.session) {
          let sessionCursor: number | undefined;
          try {
            sessionCursor = parseSessionTurnCursor(options.cursor);
          } catch (cause) {
            if (cause instanceof InvalidSpaceTurnCliOptionsError) return error(cause.message, cause.detail);
            throw cause;
          }
          const result = await client.space(spaceId).session(options.session).turns.listPaginated({
            cursor: sessionCursor,
            limit: query.limit,
            direction: options.direction,
          });
          if (jsonRequested(options)) return outJson(result);
          if (result.turns.length === 0) return console.log("  No turns found");
          table(result.turns, [
            { key: "sequence", label: "Seq" },
            { key: "id", label: "Turn ID" },
            { key: "meta", label: "By", format: (meta) => readTurnInitiator(meta) },
            { key: "status", label: "Status" },
            { key: "userText", label: "User" },
            { key: "assistantText", label: "Assistant" },
            { key: "updatedAt", label: "Updated" },
          ]);
          if (result.hasMore) console.log(`\n  More turns available - next cursor: ${result.nextCursor}`);
          return;
        }
        const result = await client.space(spaceId).turns.list(query);
        if (jsonRequested(options)) return outJson(result);
        if (result.turns.length === 0) return console.log("  No turns found");

        table(toSpaceTurnRows(result.turns), [
          { key: "createdAt", label: "Created" },
          { key: "author", label: "Author" },
          { key: "sessionTitle", label: "Session" },
          { key: "sessionId", label: "Session ID" },
          { key: "sequence", label: "Seq" },
          { key: "id", label: "Turn ID" },
          { key: "status", label: "Status" },
          { key: "userPreview", label: "User" },
          { key: "assistantPreview", label: "Assistant" },
        ]);
        if (result.pageInfo.hasMore && result.pageInfo.nextCursor) {
          console.log(`\n  More turns available - next cursor: ${result.pageInfo.nextCursor}`);
        }
      } catch (cause) {
        handleHttp(cause);
      }
    });

  turnsCmd
    .command("intermediate <sessionId> <turnId>")
    .description("Read persisted intermediate messages from the CDN archive")
    .option("--json", "Output as JSON")
    .action(async (sessionId: string, turnId: string, options: { json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = dependencies.createClient?.() ?? createClient();
      try {
        const archive = await client.space(spaceId).session(sessionId).turns.intermediate.get(turnId);
        if (jsonRequested(options)) return outJson(archive);
        if (!archive) return console.log("  No intermediate messages found");
        console.log(`Turn ${archive.turnId}`);
        console.log(`  ${archive.summary.messageCount} intermediate messages · ${archive.summary.toolCallCount} tool calls`);
        for (const [index, message] of archive.messages.entries()) {
          console.log(`\n${index + 1}. ${message.role}${message.provider ? ` · ${message.provider}/${message.model ?? ""}` : ""}`);
          if (message.text) console.log(message.text);
          if (message.toolCallsObjectKey) console.log("  Tool calls: available");
        }
      } catch (cause) {
        handleHttp(cause);
      }
    });

  return turnsCmd;
}
