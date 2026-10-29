import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import {
  isTextMime,
  mimeTypeForPath,
  HttpError,
  UploadHttpError,
  type CohubHttpClient,
  type PublicFileListEntry,
  type PublicFileUploadPlanEntry,
  type UploadConfig,
  UploadGroup,
} from "@neta-art/cohub";
import { type MediaFacts, mediaFacts } from "@neta-art/cohub/media";
import type { Command } from "commander";
import { createClient } from "../client.js";
import { HttpPutError, putLocalFile } from "../http-put.js";
import { localUploadSource } from "../local-upload-source.js";
import { localMediaFacts } from "../local-media.js";
import { error, handleHttp, json as outJson, jsonRequested } from "../output.js";
import { resolveSpace } from "../space.js";

const MEDIA_CONCURRENCY = 4;

type LocalPublicFile = {
  id: string;
  localPath: string;
  publicPath: string;
  size: number;
  mimeType: string;
};

type PublicCommandDeps = {
  createClient?: () => CohubHttpClient;
  fetch?: typeof fetch;
  upload?: Partial<UploadConfig> | UploadGroup;
};

function hasControlCharacters(value: string) {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function terminalText(value: string) {
  return [...value].map((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
      ? `\\u${code.toString(16).padStart(4, "0")}`
      : char;
  }).join("");
}

function normalizePublicPath(input: string) {
  const value = input.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!value || value.startsWith("/") || hasControlCharacters(value)) {
    return error("Invalid public path");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    return error("Invalid public path");
  }
  return parts.join("/");
}

function contentTypeForPath(path: string) {
  const mimeType = mimeTypeForPath(path);
  if (!mimeType) return "application/octet-stream";
  return isTextMime(mimeType) ? `${mimeType}; charset=utf-8` : mimeType;
}

async function walkDirectory(root: string, directory: string, destination: string): Promise<LocalPublicFile[]> {
  const names = await readdir(directory);
  names.sort((left, right) => left.localeCompare(right));
  const files: LocalPublicFile[] = [];
  for (const name of names) {
    const localPath = resolve(directory, name);
    const info = await lstat(localPath);
    if (info.isSymbolicLink()) return error("Symlinks are not supported", relative(root, localPath));
    if (info.isDirectory()) {
      files.push(...await walkDirectory(root, localPath, destination));
      continue;
    }
    if (!info.isFile()) continue;
    const nestedPath = relative(root, localPath).replace(/\\/g, "/");
    const publicPath = normalizePublicPath(`${destination}/${nestedPath}`);
    files.push({
      id: randomUUID(),
      localPath,
      publicPath,
      size: info.size,
      mimeType: contentTypeForPath(localPath),
    });
  }
  return files;
}

export async function collectPublicUpload(source: string, destination?: string): Promise<{
  files: LocalPublicFile[];
  destination: string;
  entryPath: string | null;
}> {
  const localPath = resolve(source);
  const info = await lstat(localPath).catch(() => null);
  if (!info) return error("Source not found", source);
  if (info.isSymbolicLink()) return error("Symlinks are not supported", source);

  if (info.isFile()) {
    const publicPath = normalizePublicPath(
      destination
        ? destination.endsWith("/") ? `${destination}${basename(localPath)}` : destination
        : basename(localPath),
    );
    return {
      destination: publicPath,
      entryPath: publicPath,
      files: [{
        id: randomUUID(),
        localPath,
        publicPath,
        size: info.size,
        mimeType: contentTypeForPath(localPath),
      }],
    };
  }
  if (!info.isDirectory()) return error("Source must be a file or directory", source);

  const target = normalizePublicPath(destination ?? basename(localPath));
  const files = await walkDirectory(localPath, localPath, target);
  if (files.length === 0) return error("Directory contains no files", source);
  const indexPath = `${target}/index.html`;
  return {
    files,
    destination: `${target}/`,
    entryPath: files.some((file) => file.publicPath === indexPath) ? indexPath : null,
  };
}

async function mapSettledWithConcurrency<T>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<void>,
) {
  const errors: Error[] = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        await mapper(items[index] as T);
      } catch (cause) {
        errors.push(cause instanceof Error ? cause : new Error(String(cause)));
      }
    }
  });
  await Promise.all(workers);
  return errors;
}

async function putPublicFile(
  file: LocalPublicFile,
  plan: PublicFileUploadPlanEntry,
  publicFiles: ReturnType<CohubHttpClient["space"]>["publicFiles"],
  upload: UploadGroup,
  fetchImpl: typeof fetch,
) {
  try {
    const filePath = await realpath(file.localPath);
    const source = await localUploadSource(filePath, file.size);
    if (plan.multipart) {
      await publicFiles.createUploadTask(plan, source, { upload, fetch: fetchImpl }).run();
    } else {
      const release = await upload.acquire(new AbortController().signal);
      try {
        await putLocalFile({ url: plan.uploadUrl, filePath, size: file.size, headers: plan.headers, label: file.publicPath, fetch: fetchImpl,
          attempts: upload.config.maxAttempts, timeoutMs: upload.config.timeoutMs, validate: async () => source.validate?.() });
      } finally { release(); }
    }
  } catch (error) {
    if ((error instanceof UploadHttpError || error instanceof HttpPutError || error instanceof HttpError) && (error.status === 409 || error.status === 412)) {
      throw new Error(`${file.publicPath} already exists. Use --overwrite.`);
    }
    throw error;
  }
}

async function publicMediaFacts(files: LocalPublicFile[]) {
  const facts = new Map<string, MediaFacts>();
  const media = files.flatMap((file) => {
    const type = file.mimeType.split("/")[0];
    return type === "image" || type === "video" ? [{ file, type: type as "image" | "video" }] : [];
  });
  await mapSettledWithConcurrency(media, MEDIA_CONCURRENCY, async ({ file, type }) => {
    // Facts only help previews; out-of-range ones are dropped rather than failing the upload.
    const found = mediaFacts(await localMediaFacts(file.localPath, type));
    if (found) facts.set(file.id, found);
  });
  return facts;
}

function uploadFailure(errors: Error[]) {
  if (errors.length === 1) return errors[0] as Error;
  const first = errors[0]?.message ?? "Upload failed";
  return new Error(`${first} (${errors.length} files failed)`);
}

function publicUrlPrefix(
  destination: string,
  entry: Pick<PublicFileUploadPlanEntry, "path" | "publicUrl">,
) {
  const encodedPath = entry.path.split("/").map(encodeURIComponent).join("/");
  if (!entry.publicUrl.endsWith(encodedPath)) {
    throw new Error(`Invalid public URL for ${entry.path}`);
  }
  const encodedDestination = destination.split("/").map(encodeURIComponent).join("/");
  return `${entry.publicUrl.slice(0, -encodedPath.length)}${encodedDestination}`;
}

async function uploadPublic(
  command: Command,
  source: string,
  destination: string | undefined,
  opts: { overwrite?: boolean; json?: boolean },
  deps: PublicCommandDeps,
) {
  const client = deps.createClient?.() ?? createClient();
  const spaceId = await resolveSpace(command, { home: true });
  try {
    const upload = await collectPublicUpload(source, destination);
    const media = await publicMediaFacts(upload.files);
    const publicFiles = client.space(spaceId).publicFiles;
    const group = deps.upload instanceof UploadGroup ? deps.upload : new UploadGroup(deps.upload, publicFiles.uploadConfig);
    const plan = await publicFiles.createUpload({
      uploadRequestId: randomUUID(),
      overwrite: Boolean(opts.overwrite),
      entries: upload.files.map((file) => ({
        id: file.id,
        relativePath: file.publicPath,
        size: file.size,
        mimeType: file.mimeType,
        ...(media.has(file.id) ? { media: media.get(file.id) } : {}),
      })),
    }, { upload: group });

    if (opts.overwrite && !jsonRequested(opts)) {
      process.stderr.write(`Overwrite enabled for ${upload.destination}\n`);
    }

    const filesById = new Map(upload.files.map((file) => [file.id, file]));
    const plansByPath = new Map(plan.entries.map((entry) => [entry.path, entry]));
    const entryPlan = upload.entryPath ? plansByPath.get(upload.entryPath) : undefined;
    const assetPlans = entryPlan
      ? plan.entries.filter((entry) => entry.id !== entryPlan.id)
      : plan.entries;
    const uploadPlans = async (entries: PublicFileUploadPlanEntry[]) =>
      mapSettledWithConcurrency(entries, group.config.concurrency, async (entry) => {
        const file = filesById.get(entry.id);
        if (!file) throw new Error(`Missing local file for ${entry.path}`);
        await putPublicFile(file, entry, publicFiles, group, deps.fetch ?? fetch);
      });

    const assetErrors = await uploadPlans(assetPlans);
    if (assetErrors.length > 0) throw uploadFailure(assetErrors);
    if (entryPlan) {
      const entryErrors = await uploadPlans([entryPlan]);
      if (entryErrors.length > 0) throw uploadFailure(entryErrors);
    }

    const firstPlan = plan.entries[0];
    if (!firstPlan) throw new Error("Upload plan contains no files");
    if (jsonRequested(opts)) {
      outJson({
        destination: upload.destination,
        urlPrefix: publicUrlPrefix("", firstPlan),
        files: upload.files.map((file) => ({
          path: file.publicPath,
          size: file.size,
          mimeType: file.mimeType,
        })),
      });
      return;
    }
    if (entryPlan) {
      console.log(entryPlan.publicUrl);
      return;
    }
    const fileLabel = upload.files.length === 1 ? "file" : "files";
    console.log(`Uploaded ${upload.files.length} ${fileLabel} to ${upload.destination}`);
    console.log(`URL prefix: ${publicUrlPrefix(upload.destination, firstPlan)}`);
  } catch (exception) {
    handleHttp(exception);
  }
}

async function listPublic(
  command: Command,
  path: string | undefined,
  opts: { recursive?: boolean; json?: boolean },
  deps: PublicCommandDeps,
) {
  const client = deps.createClient?.() ?? createClient();
  try {
    const publicFiles = client.space(await resolveSpace(command, { home: true })).publicFiles;
    const entries: PublicFileListEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await publicFiles.list(path ?? "", {
        recursive: opts.recursive,
        limit: 1000,
        cursor,
      });
      if (jsonRequested(opts)) entries.push(...page.entries);
      else for (const entry of page.entries) {
        console.log(`${terminalText(entry.name)}${entry.kind === "directory" ? "/" : ""}`);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    if (jsonRequested(opts)) return outJson({ path: path ?? "", entries, nextCursor: null });
  } catch (exception) {
    handleHttp(exception);
  }
}

async function printPublicUrl(command: Command, path: string, deps: PublicCommandDeps) {
  const client = deps.createClient?.() ?? createClient();
  try {
    const result = await client.space(await resolveSpace(command, { home: true })).publicFiles.url(path);
    console.log(result.url);
  } catch (exception) {
    handleHttp(exception);
  }
}

export function registerPublic(program: Command, deps: PublicCommandDeps = {}) {
  const publicCommand = program
    .command("public")
    .description("Upload and manage public Space files");

  publicCommand
    .command("upload <source> [destination]")
    .description("Upload a file or directory")
    .option("--overwrite", "Replace existing public files")
    .action((source: string, destination: string | undefined, opts: { overwrite?: boolean; json?: boolean }, command: Command) =>
      uploadPublic(command, source, destination, opts, deps));

  publicCommand
    .command("ls [path]")
    .description("List public files")
    .option("-r, --recursive", "List files recursively")
    .action((path: string | undefined, opts: { recursive?: boolean; json?: boolean }, command: Command) =>
      listPublic(command, path, opts, deps));

  publicCommand
    .command("url <path>")
    .description("Print a public file URL")
    .action((path: string, _opts: object, command: Command) => printPublicUrl(command, path, deps));

  return publicCommand;
}
