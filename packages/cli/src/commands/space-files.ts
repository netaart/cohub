import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { dirname, posix } from "node:path";
import type { SpaceFsCopyResult, SpaceFsCopyStats } from "@neta-art/cohub";
import { Option, type Command } from "commander";
import { createClient } from "../client.js";
import { error, json as outJson, jsonRequested, ok } from "../output.js";
import { explicitSpace, failSpaceTarget, resolveSpace, resolveSpaceRef } from "../space.js";
import {
  InvalidFileOperandError,
  parseCopyOperand,
  parseSpaceFileOperand,
  type LocalOperand,
  type SpaceOperand,
} from "../space-files/operands.js";
import {
  checkDestination,
  copyLocal,
  CopyAbortError,
  downloadFromSpace,
  localNodeType,
  mergeCopyResults,
  spaceNodeType,
  uploadToSpace,
  type CopyOptions,
} from "../space-files/transfer.js";

function fail(e: unknown): never {
  if (e instanceof InvalidFileOperandError || e instanceof CopyAbortError) return error(e.message);
  return failSpaceTarget(e);
}

const operandSpaceResolver = (spacesCmd: Command) => (space: string | null) =>
  space ? resolveSpaceRef(space) : resolveSpace(spacesCmd);

export function formatBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

const count = (value: number, singular: string, plural = `${singular}s`) => `${value} ${value === 1 ? singular : plural}`;

export function formatCopySummary(result: SpaceFsCopyStats & Pick<SpaceFsCopyResult, "overwritten" | "skipped">) {
  const parts = [count(result.files, "file")];
  if (result.dirs) parts.push(count(result.dirs, "directory", "directories"));
  if (result.symlinks) parts.push(count(result.symlinks, "symlink"));
  let summary = `${parts.join(", ")} (${formatBytes(result.bytes)})`;
  if (result.overwritten) summary += `, ${result.overwritten} overwritten`;
  if (result.skipped) summary += `, ${result.skipped} skipped`;
  return summary;
}

function createProgressLine() {
  if (!process.stderr.isTTY) return { update: () => undefined, clear: () => undefined };
  let shown = false;
  return {
    update: (progress: SpaceFsCopyStats) => {
      shown = true;
      process.stderr.write(`\r\x1b[2K  Copying… ${count(progress.files, "file")} (${formatBytes(progress.bytes)})`);
    },
    clear: () => {
      if (shown) process.stderr.write("\r\x1b[2K");
    },
  };
}

type CopyCliOptions = {
  recursive?: boolean;
  R?: boolean;
  clobber?: boolean;
  preserve?: boolean;
  json?: boolean;
};

const spaceParent = (path: string) => (posix.dirname(path) === "." ? "" : posix.dirname(path));

async function copyFiles(spacesCmd: Command, raw: string[], opts: CopyCliOptions) {
  if (raw.length < 2) return error("missing destination operand", "Usage: cohub spaces files cp [-r] <source>... <destination>");
  const client = createClient();
  const resolveSpaceId = operandSpaceResolver(spacesCmd);
  const progress = createProgressLine();
  const options: CopyOptions = {
    recursive: Boolean(opts.recursive || opts.R),
    noClobber: opts.clobber === false,
    preserveTimestamps: Boolean(opts.preserve),
  };
  try {
    const declared = explicitSpace(spacesCmd) !== null;
    const operands = raw.map((value) => parseCopyOperand(value, declared));
    const destination = operands.pop() as SpaceOperand | LocalOperand;
    const display = raw.at(-1) as string;
    const spaceSources = operands.filter((operand): operand is SpaceOperand => operand.kind === "space");
    const localSources = operands.filter((operand): operand is LocalOperand => operand.kind === "local").map((operand) => operand.path);
    const results: SpaceFsCopyResult[] = [];

    if (destination.kind === "space") {
      const files = client.space(await resolveSpaceId(destination.space)).files;
      const intoDirectory = await checkDestination({
        sourceCount: operands.length,
        display,
        path: destination.path,
        parent: spaceParent(destination.path),
        stat: (path) => spaceNodeType(files, path),
      });
      if (spaceSources.length > 0) {
        const started = await files.copy({
          sources: await Promise.all(spaceSources.map(async (source) => ({ spaceId: await resolveSpaceId(source.space), path: source.path }))),
          destination: destination.path,
          ...options,
          mutationId: randomUUID(),
        });
        results.push(await files.waitForCopy(started, { pollMs: process.stderr.isTTY ? 2_000 : 10_000, onProgress: progress.update }));
      }
      if (localSources.length > 0) {
        results.push(await uploadToSpace({ files, sources: localSources, destination: destination.path, intoDirectory, options, onProgress: progress.update }));
      }
    } else {
      const intoDirectory = await checkDestination({
        sourceCount: operands.length,
        display,
        path: destination.path,
        parent: dirname(destination.path),
        stat: localNodeType,
      });
      if (spaceSources.length > 0) {
        const sources = await Promise.all(spaceSources.map(async (source) => ({
          files: client.space(await resolveSpaceId(source.space)).files,
          path: source.path,
        })));
        results.push(await downloadFromSpace({ sources, destination: destination.path, intoDirectory, options, onProgress: progress.update }));
      }
      if (localSources.length > 0) {
        results.push(await copyLocal({ sources: localSources, destination: destination.path, intoDirectory, options }));
      }
    }

    progress.clear();
    const result = mergeCopyResults(results);
    if (jsonRequested(opts)) {
      outJson(result);
    } else {
      for (const failure of result.errors) process.stderr.write(`cp: ${failure.message}\n`);
      if (result.errors.length === 0 || result.files + result.dirs + result.symlinks > 0) ok(`Copied ${formatCopySummary(result)}`);
    }
    if (result.errors.length > 0) process.exit(1);
  } catch (e: unknown) {
    progress.clear();
    fail(e);
  }
}

async function writeFileBody(response: Response, path: string) {
  const reader = response.body?.getReader();
  if (!reader) return;
  let first = true;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    if (first && process.stdout.isTTY && value.includes(0)) {
      await reader.cancel();
      return error(`'${path}' is a binary file`, `Redirect it to a file: cohub spaces files cat ${path} > <file>`);
    }
    first = false;
    if (!process.stdout.write(value)) await once(process.stdout, "drain");
  }
}

async function catFiles(spacesCmd: Command, paths: string[], opts: { json?: boolean }) {
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") process.exit(0);
    error(e.message);
  });
  const client = createClient();
  const resolveSpaceId = operandSpaceResolver(spacesCmd);
  try {
    const operands = paths.map(parseSpaceFileOperand);
    if (jsonRequested(opts)) {
      const files = await Promise.all(operands.map(async (operand) =>
        client.space(await resolveSpaceId(operand.space)).files.read(operand.path)));
      return outJson(files.length === 1 ? files[0] : files);
    }
    for (const operand of operands) {
      const file = await client.space(await resolveSpaceId(operand.space)).files.open(operand.path);
      await writeFileBody(file.response, operand.path);
    }
  } catch (e: unknown) {
    fail(e);
  }
}

export function registerSpaceFileTransfer(filesCmd: Command, spacesCmd: Command): void {
  filesCmd
    .command("cat <paths...>")
    .description("Print file contents; binary-safe when redirected")
    .option("--json", "Output file metadata and content as JSON")
    .addHelpText("after", `
Paths may name another Space as <space>:<path>, where <space> is an id,
username/slug, or the slug of a Space you own.

Examples:
  cohub spaces files cat README.md
  cohub spaces files cat assets/logo.png > logo.png
  cohub spaces files cat alice/notes:todo.md`)
    .action((paths: string[], opts: { json?: boolean }) => catFiles(spacesCmd, paths, opts));

  filesCmd
    .command("cp <paths...>")
    .description("Copy files between Spaces and the local filesystem, like scp")
    .option("-r, --recursive", "Copy directories recursively")
    .addOption(new Option("-R", "Same as --recursive").hideHelp())
    .option("-n, --no-clobber", "Do not overwrite existing files")
    .option("-p, --preserve", "Preserve modification times (not kept by uploads)")
    .option("--json", "Output the copy result as JSON")
    .addHelpText("after", `
Works like scp and cp: the last path is the destination, existing files are
overwritten and directories merged. <space>:<path> addresses a Space, where
<space> is an id, username/slug, or the slug of a Space you own; write
./name for a path that contains a colon.

Bare paths address the current Space when one is declared with -s or
COHUB_SPACE_ID, as inside a Cohub sandbox; otherwise they are local files.
Absolute paths outside /workspace are always local. Copies between Spaces
run server-side; local files are uploaded or downloaded.

Examples:
  cohub spaces files cp -r alice/templates:starter ./starter
  cohub spaces files cp report.pdf notes:inbox/
  cohub -s <spaceId> spaces files cp -r other:docs docs
  cohub spaces files cp /tmp/chart.png <spaceId>:assets/`)
    .action((paths: string[], opts: CopyCliOptions) => copyFiles(spacesCmd, paths, opts));
}
