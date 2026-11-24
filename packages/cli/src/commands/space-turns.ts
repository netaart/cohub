import {
  readTurnInitiator,
  type SpaceTurnAuthorFilter,
  type SpaceTurnListItem,
  type SpaceTurnListOptions,
  type SpaceTurnsResponse,
  type MessageToolCallsFile,
  type SessionTurnRecord,
  type StoredIntermediateMessage,
  type StoredToolCall,
  type TurnIntermediateMessagesFile,
} from "@neta-art/cohub";
import type { Command } from "commander";
import { createClient } from "../client.js";
import {
  error,
  excerptColumn,
  handleHttp,
  json as outJson,
  jsonRequested,
  printable,
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
          listToolCalls(turnId: string, messages: readonly StoredIntermediateMessage[]): Promise<Map<string, MessageToolCallsFile>>;
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
    initiator: turn.initiator ?? "unknown",
    sessionTitle: turn.session.title ?? "",
    sessionId: turn.session.id,
    sequence: turn.sequence,
    id: turn.id,
    status: turn.status,
    userPreview: turn.userPreview ?? "",
    assistantPreview: turn.assistantPreview ?? "",
  }));
}

const TOOL_TEXT_LINES = 40;

function clipLines(text: string): string {
  const lines = text.trimEnd().split(/\r?\n/);
  const shown = lines.slice(0, TOOL_TEXT_LINES).map((line) => `     ${printable(line.length > 400 ? `${line.slice(0, 399)}…` : line)}`);
  if (lines.length > TOOL_TEXT_LINES) shown.push(`     … ${lines.length - TOOL_TEXT_LINES} more lines in --json`);
  return shown.join("\n");
}

function toolText(content: NonNullable<StoredToolCall["result"]>["content"]): string {
  if (typeof content === "string") return content;
  return (content ?? []).map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
}

export function describeToolCall(call: StoredToolCall): string {
  const timing = (call.meta?.timing ?? null) as { durationMs?: number } | null;
  const status = !call.result ? "no result" : call.result.isError ? "error" : "ok";
  const head = `  → ${call.name} · ${status}${typeof timing?.durationMs === "number" ? ` · ${timing.durationMs}ms` : ""}`;
  const input = typeof call.input.command === "string" ? call.input.command : JSON.stringify(call.input, null, 2);
  const parts = [printable(head), clipLines(input)];
  if (call.result) parts.push("   ⇢", clipLines(toolText(call.result.content)));
  return parts.join("\n");
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
            excerptColumn("userText", "User"),
            excerptColumn("assistantText", "Assistant"),
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
          { key: "initiator", label: "By" },
          { key: "sessionTitle", label: "Session" },
          { key: "sessionId", label: "Session ID" },
          { key: "sequence", label: "Seq" },
          { key: "id", label: "Turn ID" },
          { key: "status", label: "Status" },
          excerptColumn("userPreview", "User"),
          excerptColumn("assistantPreview", "Assistant"),
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
    .option("--tool-calls", "Include each tool call's full input and result")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Without --tool-calls, tool calls show as short previews. With it, every call's input,
result and timing are fetched; the table clips long results, --json keeps them whole.

  cohub spaces turns intermediate <sessionId> <turnId> --tool-calls
  cohub spaces turns intermediate <sessionId> <turnId> --tool-calls --json`)
    .action(async (sessionId: string, turnId: string, options: { json?: boolean; toolCalls?: boolean }) => {
      const spaceId = await resolveSpace(spacesCmd);
      const client = dependencies.createClient?.() ?? createClient();
      try {
        const turns = client.space(spaceId).session(sessionId).turns;
        const archive = await turns.intermediate.get(turnId);
        const calls = archive && options.toolCalls ? await turns.intermediate.listToolCalls(turnId, archive.messages) : null;
        if (jsonRequested(options)) {
          return outJson(archive && calls ? { ...archive, messages: archive.messages.map((message) => ({ ...message, toolCalls: calls.get(message.id)?.toolCalls ?? [] })) } : archive);
        }
        if (!archive) return console.log("  No intermediate messages found");
        console.log(`Turn ${archive.turnId}`);
        console.log(`  ${archive.summary.messageCount} intermediate messages · ${archive.summary.toolCallCount} tool calls`);
        for (const [index, message] of archive.messages.entries()) {
          console.log(printable(`\n${index + 1}. ${message.role}${message.provider ? ` · ${message.provider}/${message.model ?? ""}` : ""}${message.createdAt ? ` · ${message.createdAt}` : ""}`));
          if (message.text) console.log(printable(message.text));
          if (calls) for (const call of calls.get(message.id)?.toolCalls ?? []) console.log(describeToolCall(call));
          else if (message.toolCallsObjectKey) console.log("  Tool calls: add --tool-calls");
        }
      } catch (cause) {
        handleHttp(cause);
      }
    });

  return turnsCmd;
}
