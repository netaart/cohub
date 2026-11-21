import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SpaceTurnAuthorFilter } from "@neta-art/cohub";
import type { Command } from "commander";
import { createClient } from "../client.js";
import { error, handleHttp, json as outJson, jsonRequested, ok } from "../output.js";
import { resolveSpace } from "../space.js";
import {
  collectSpaceContext,
  formatSessionTranscriptMarkdown,
  formatSpaceContextMarkdown,
  readSessionTranscript,
  type SessionReadClient,
  type SpaceContextClient,
} from "../space-context.js";

const AUTHOR_FILTERS = ["any", "self", "others"] as const;

type SpaceContextCliOptions = {
  author?: string;
  turns?: string;
  sessions?: string;
  docs?: boolean;
  out?: string;
  json?: boolean;
};

type SessionReadCliOptions = {
  last?: string;
  all?: boolean;
  withFiles?: boolean;
  out?: string;
  json?: boolean;
};

function parsePositiveInt(value: string, name: string, max: number): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    error(`Invalid ${name}`, `--${name} must be an integer from 1 to ${max}`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    error(`Invalid ${name}`, `--${name} must be an integer from 1 to ${max}`);
  }
  return parsed;
}

function parseAuthorFilter(value: string | undefined): SpaceTurnAuthorFilter {
  if (value === undefined) return "any";
  if ((AUTHOR_FILTERS as readonly string[]).includes(value)) {
    return value as SpaceTurnAuthorFilter;
  }
  error("Invalid author", `Use one of: ${AUTHOR_FILTERS.join(", ")}`);
}

async function emitOutput(
  content: string,
  outPath: string | undefined,
  label: string,
): Promise<void> {
  if (!outPath) {
    process.stdout.write(content);
    return;
  }
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, content, "utf-8");
  ok(`Wrote ${label} to ${outPath}`);
}

export function registerSpaceContext(
  spacesCmd: Command,
  dependencies: { createClient?: () => SpaceContextClient } = {},
): void {
  spacesCmd
    .command("context")
    .description("Print a compact cloud context brief (files, pending diff, guides, chats, recent turns)")
    .option("--author <any|self|others>", "Filter recent turns by author", "any")
    .option("--turns <n>", "Maximum recent turns to include, 1-100", "10")
    .option("--sessions <n>", "Maximum active chats to include, 1-50", "8")
    .option("--no-docs", "Skip excerpts of root guide files (AGENTS.md, CLAUDE.md, README.md)")
    .option("-o, --out <path>", "Write the output to a file instead of stdout")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  cohub -s <space> spaces context
  cohub -s <space> spaces context --author others --turns 15
  cohub -s <space> spaces context --out ./space-context.md
  cohub -s <space> spaces context --json`)
    .action(async (opts: SpaceContextCliOptions) => {
      const author = parseAuthorFilter(opts.author);
      const turnsLimit = parsePositiveInt(opts.turns ?? "10", "turns", 100);
      const sessionsLimit = parsePositiveInt(opts.sessions ?? "8", "sessions", 50);
      const spaceId = await resolveSpace(spacesCmd);
      const client = dependencies.createClient?.() ?? createClient();
      try {
        const snapshot = await collectSpaceContext(client, spaceId, {
          author,
          turnsLimit,
          sessionsLimit,
          includeDocs: opts.docs !== false,
        });
        if (jsonRequested(opts)) {
          if (opts.out) {
            await emitOutput(`${JSON.stringify(snapshot, null, 2)}\n`, opts.out, "space context JSON");
            return;
          }
          outJson(snapshot);
          return;
        }
        await emitOutput(formatSpaceContextMarkdown(snapshot), opts.out, "space context");
      } catch (cause: unknown) {
        handleHttp(cause);
      }
    });
}

export function registerSessionRead(
  sessionsCmd: Command,
  dependencies: { createClient?: () => SessionReadClient } = {},
): void {
  sessionsCmd
    .command("read <id>")
    .alias("export")
    .description("Read a chat transcript in chronological Markdown (or JSON)")
    .option("--last <n>", "Number of latest turns to include, 1-5000", "30")
    .option("--all", "Paginate through all turns in the chat")
    .option("--with-files", "Include the list of Space files changed by this chat")
    .option("-o, --out <path>", "Write the transcript to a file instead of stdout")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  cohub -s <space> spaces sessions read <sessionId>
  cohub -s <space> spaces sessions read <sessionId> --all --with-files
  cohub -s <space> spaces sessions read <sessionId> --out ./handoff.md
  cohub -s <space> spaces sessions read <sessionId> --last 10 --json`)
    .action(async (id: string, opts: SessionReadCliOptions) => {
      if (opts.all && opts.last !== undefined && opts.last !== "30") {
        error("Conflicting options", "Use either --all or --last, not both");
      }
      const last = opts.all ? undefined : parsePositiveInt(opts.last ?? "30", "last", 5_000);
      const spaceId = await resolveSpace(sessionsCmd);
      const client = dependencies.createClient?.() ?? createClient();
      try {
        const snapshot = await readSessionTranscript(client, spaceId, id, {
          last,
          all: Boolean(opts.all),
          withFiles: Boolean(opts.withFiles),
        });
        if (jsonRequested(opts)) {
          if (opts.out) {
            await emitOutput(`${JSON.stringify(snapshot, null, 2)}\n`, opts.out, "chat transcript JSON");
            return;
          }
          outJson(snapshot);
          return;
        }
        await emitOutput(formatSessionTranscriptMarkdown(snapshot), opts.out, "chat transcript");
      } catch (cause: unknown) {
        handleHttp(cause);
      }
    });
}
