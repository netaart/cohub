import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { getCohubContext, HttpError, type CohubHttpClient, type Permission, type AppCreateInput, type AppMeta, type AppStatus, type AppUpdateInput, type AppVersionRecord, type AppViewStatsResponse, type AppVisibility } from "@neta-art/cohub";
import type { Command } from "commander";
import { createClient, createClientWithAccessToken } from "../client.js";
import { error, handleHttp, json as outJson, jsonRequested, ok, table } from "../output.js";
import { resolveSpace } from "../space.js";
import { downloadApp } from "../app-download.js";
import { getAppByRef, parseAppRef } from "../app-ref.js";
import { checkAppTarget } from "../app-target.js";
import { putBytes, putLocalFile } from "../http-put.js";
import { registerAppCommerce } from "./app-commerce.js";
import { collectPublicUpload } from "./public.js";

const APP_STATUSES = ["published", "disabled"] as const;
const APP_VISIBILITIES = ["public", "space"] as const;

const collectOption = (value: string, previous: string[] = []): string[] => [...previous, value];

function parseChoice<const T extends readonly string[]>(value: string, name: string, choices: T): T[number] {
  if ((choices as readonly string[]).includes(value)) return value as T[number];
  return error(`Invalid ${name}`, `Use one of: ${choices.join(", ")}`);
}

function parseJsonObject(value: string | undefined, name: string): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // handled below
  }
  return error(`Invalid ${name}`, `${name} must be a JSON object`);
}

/** Human-readable version provenance: a session title, a channel, or blank. */
function formatVersionSource(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const source = value as AppVersionRecord["source"];
  if (source?.session) return source.session.title?.trim() || source.session.id;
  return source?.via ? `via ${source.via}` : "";
}

function parseJsonValue(value: string | undefined, name: string): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return error(`Invalid ${name}`, `${name} must be valid JSON`);
  }
}

function compactObject<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function withCohubBarMeta(input: {
  meta?: AppMeta | null;
  hideCohubBar?: boolean;
  showCohubBar?: boolean;
}): AppMeta | null | undefined {
  if (!input.hideCohubBar && !input.showCohubBar) return input.meta;
  const meta = input.meta ? { ...input.meta } : {};
  const presentation = meta.presentation && typeof meta.presentation === "object" && !Array.isArray(meta.presentation)
    ? { ...(meta.presentation as Record<string, unknown>) }
    : {};
  if (input.hideCohubBar) presentation.hideCohubBar = true;
  if (input.showCohubBar) delete presentation.hideCohubBar;
  if (Object.keys(presentation).length > 0) meta.presentation = presentation;
  else delete meta.presentation;
  return Object.keys(meta).length > 0 ? meta : null;
}

type AppSourceType = "workspace" | "local";
const MAX_APP_SOURCE_FILES = 1000;
const MAX_APP_SOURCE_BYTES = 1024 * 1024 * 1024;
const APP_SOURCE_UPLOAD_CONCURRENCY = 4;
type ResolvedTarget = { targetType: "file" | "directory" | "port"; targetRef: string };

async function uploadLocalAppSource(client: CohubHttpClient, spaceId: string, source: ResolvedTarget) {
  if (source.targetType === "port") return null;
  const upload = await collectPublicUpload(source.targetRef);
  const totalBytes = upload.files.reduce((sum, file) => sum + file.size, 0);
  if (upload.files.length > MAX_APP_SOURCE_FILES) return error("App source is too large", `Use no more than ${MAX_APP_SOURCE_FILES} files.`);
  if (totalBytes > MAX_APP_SOURCE_BYTES) return error("App source is too large", "The total source size must not exceed 1 GiB.");
  const uploadId = randomUUID();
  const directoryPrefix = source.targetType === "directory" ? upload.destination.replace(/\/$/, "") : "";
  const files: Array<{ path: string; objectKey: string; size: number; mimeType: string }> = new Array(upload.files.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(APP_SOURCE_UPLOAD_CONCURRENCY, upload.files.length) }, async () => {
    while (nextIndex < upload.files.length) {
      const index = nextIndex++;
      const file = upload.files[index];
      if (!file) return;
      const plan = await client.publicAssets.createUpload({
        purpose: "app_source",
        uploadProtocol: "presigned_put_v1",
        spaceId,
        sessionId: uploadId,
        file: { size: file.size, mimeType: file.mimeType, filename: basename(file.publicPath) },
      });
      await putLocalFile({
        url: plan.asset.uploadUrl,
        filePath: file.localPath,
        size: file.size,
        headers: plan.asset.uploadHeaders,
        label: file.publicPath,
      });
      const path = directoryPrefix && file.publicPath.startsWith(`${directoryPrefix}/`)
        ? file.publicPath.slice(directoryPrefix.length + 1)
        : basename(file.publicPath);
      files[index] = { path, objectKey: plan.asset.objectKey, size: file.size, mimeType: file.mimeType };
    }
  });
  await Promise.all(workers);
  const manifest = JSON.stringify({ kind: "cohub.app-source", version: 1, targetType: source.targetType, files });
  const manifestBlob = new Blob([manifest], { type: "application/json" });
  const manifestPlan = await client.publicAssets.createUpload({
    purpose: "app_source",
    uploadProtocol: "presigned_put_v1",
    spaceId,
    sessionId: uploadId,
    file: { size: manifestBlob.size, mimeType: "application/json", filename: "manifest.json" },
  });
  await putBytes({
    url: manifestPlan.asset.uploadUrl,
    body: manifestBlob,
    size: manifestBlob.size,
    headers: manifestPlan.asset.uploadHeaders,
    label: "app source manifest",
  });
  const manifestAsset = manifestPlan.asset;
  return { sourceRef: manifestAsset.objectKey, targetRef: source.targetType === "file" ? files[0]?.path ?? "" : "." };
}

function resolveDefaultAppSource(): AppSourceType {
  return getCohubContext().runtime.kind === "sandbox" ? "workspace" : "local";
}

function resolveTarget(opts: { file?: string; dir?: string; port?: string }): ResolvedTarget | null {
  const targets: Array<ResolvedTarget | null> = [
    opts.file ? { targetType: "file" as const, targetRef: opts.file } : null,
    opts.dir ? { targetType: "directory" as const, targetRef: opts.dir } : null,
    opts.port ? { targetType: "port" as const, targetRef: opts.port } : null,
  ].filter((target): target is ResolvedTarget => Boolean(target));
  if (targets.length === 0) return null;
  if (targets.length > 1) return error("Conflicting target", "Use only one of --file, --dir, or --port");
  return targets[0] ?? null;
}

function resolveStatus(opts: { disabled?: boolean; status?: string }): AppStatus {
  const values = [opts.status, opts.disabled ? "disabled" : undefined].filter(Boolean);
  if (values.length > 1) return error("Conflicting status", "Use only one of --status or --disabled");
  return values[0] ? parseChoice(values[0], "status", APP_STATUSES) : "published";
}

/**
 * Fail early when a Space-relative `--file` / `--dir` target cannot be a valid
 * publish source. The publish worker resolves targets inside the target
 * Space's workspace, not on the local filesystem.
 */
async function guardAppTarget(
  client: CohubHttpClient,
  spaceId: string,
  target: { targetType: "file" | "directory"; targetRef: string },
): Promise<void> {
  const failure = await checkAppTarget(client, spaceId, target);
  if (failure) {
    error(
      failure.status === 404 ? "Publish target not found" : "Publish target is invalid",
      `${failure.message} (--${target.targetType === "directory" ? "dir" : "file"} takes a Space workspace path, not a local path).`,
    );
  }
}

/**
 * Translate the publish worker's bare fs errors (e.g. a target removed between
 * preflight and snapshot) into the same explicit wording as the preflight.
 */
function translateTargetWorkerError(e: unknown): void {
  if (!(e instanceof HttpError)) return;
  if (e.code !== "path_not_found" && e.code !== "not_a_directory" && e.code !== "not_a_file" && e.code !== "symlink_not_supported") return;
  error(
    e.code === "path_not_found" ? "Publish target not found" : "Publish target is invalid",
    "The publish target is a Space workspace path; the Space workspace no longer contains a valid target at that path.",
  );
}

function resolveVisibility(value: string | undefined): AppVisibility | undefined {
  return value ? parseChoice(value, "visibility", APP_VISIBILITIES) : undefined;
}

function printApp(app: Record<string, unknown>): void {
  table([app], [
    { key: "id", label: "ID" },
    { key: "slug", label: "Slug" },
    { key: "status", label: "Status" },
    { key: "visibility", label: "Visibility" },
    { key: "targetType", label: "Target" },
    { key: "targetRef", label: "Ref" },
    { key: "latestVersion", label: "Version" },
    { key: "publishedAt", label: "Published" },
  ]);
}

function printAppUrls(result: { publicUrl?: string | null; content?: { url: string } | null }): void {
  const lines = [
    result.publicUrl ? `Public URL: ${result.publicUrl}` : null,
    result.content?.url ? `Content URL: ${result.content.url}` : null,
  ].filter((line): line is string => Boolean(line));
  if (lines.length) console.log(`\n${lines.join("\n")}`);
}

function promotionUrl(publicUrl: string | null, promotion: { id: string; parameters: Record<string, string> }): string | null {
  if (!publicUrl) return null;
  const url = new URL(publicUrl);
  url.searchParams.set("cohub_campaign", promotion.id);
  for (const [key, value] of Object.entries(promotion.parameters)) url.searchParams.set(key, value);
  return url.toString();
}

function printAppStats(stats: AppViewStatsResponse): void {
  table([stats.summary], [
    { key: "totalViews", label: "Total" },
    { key: "views24h", label: "24h" },
    { key: "views7d", label: "7d" },
    { key: "views30d", label: "30d" },
  ]);
  if (stats.sources.length) {
    console.log("");
    table(stats.sources, [
      { key: "source", label: "Source" },
      { key: "views", label: "Views" },
    ]);
  }
}

export async function getAppStatsByRef(client: CohubHttpClient, app: string): Promise<AppViewStatsResponse> {
  const ref = parseAppRef(app);
  if ("id" in ref) return client.apps.getStats(ref.id);
  const detail = await getAppByRef(client, app);
  return client.apps.getStats(detail.app.id);
}

async function confirmDelete(opts: { yes?: boolean }): Promise<void> {
  if (opts.yes) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return error("Confirmation required", "Pass --yes to delete the app.");
  process.stdout.write("Deleting an app also removes its versions and viewer grants. Continue? [y/N] ");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
    break;
  }
  const answer = Buffer.concat(chunks).toString().trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") return error("Cancelled");
}

async function publishAppVersion(id: string, opts: { json?: boolean }): Promise<void> {
  const client = createClient();
  try {
    const result = await client.apps.publishVersion(id);
    if (jsonRequested(opts)) return outJson(result);
    ok(`App version updated: v${result.version.version}`);
    printApp(result.app);
  } catch (e: unknown) {
    translateTargetWorkerError(e);
    handleHttp(e);
  }
}

type PublishOptions = {
  file?: string;
  dir?: string;
  port?: string;
  source?: AppSourceType;
  disabled?: boolean;
  status?: string;
  visibility?: string;
  appScope?: string[];
  viewerScope?: string[];
  meta?: string;
  hideCohubBar?: boolean;
  showCohubBar?: boolean;
  json?: boolean;
};

type UpdateOptions = PublishOptions & {
  slug?: string;
  clearAppScopes?: boolean;
  clearViewerScopes?: boolean;
};

type ResolveOptions = {
  owner?: string;
  spaceSlug?: string;
  json?: boolean;
};

export function registerApps(program: Command): void {
  const appsCmd = program
    .command("apps")
    .description("App management")
    // Legacy spelling; hidden from help but still typed by existing scripts.
    .alias("works")
    .hook("preAction", () => {
      if (process.argv.slice(2).includes("works")) {
        ok("Deprecated: `cohub works` is now `cohub apps`.");
      }
    });

  appsCmd
    .command("ls")
    .alias("list")
    .description("List apps in the target space")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const spaceId = await resolveSpace(appsCmd);
      const client = createClient();
      try {
        const result = await client.apps.listBySpace(spaceId);
        if (jsonRequested(opts)) return outJson(result);
        table(result.apps, [
          { key: "id", label: "ID" },
          { key: "slug", label: "Slug" },
          { key: "status", label: "Status" },
          { key: "visibility", label: "Visibility" },
          { key: "targetType", label: "Target" },
          { key: "targetRef", label: "Ref" },
          { key: "latestVersion", label: "Version" },
          { key: "publishedAt", label: "Published" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  appsCmd
    .command("get <app>")
    .description("Show app details by id, URL, mention URI, or username/space/app")
    .option("--json", "Output as JSON")
    .action(async (app: string, opts: { json?: boolean }) => {
      const client = createClient();
      try {
        const result = await getAppByRef(client, app);
        if (jsonRequested(opts)) return outJson(result);
        printApp(result.app);
        printAppUrls(result);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  appsCmd
    .command("stats <app>")
    .description("Show view statistics by id, URL, mention URI, or username/space/app")
    .option("--json", "Output as JSON")
    .action(async (app: string, opts: { json?: boolean }) => {
      const client = createClient();
      try {
        const result = await getAppStatsByRef(client, app);
        if (jsonRequested(opts)) return outJson(result);
        printAppStats(result);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  appsCmd
    .command("download <app>")
    .description("Download a published file or directory app")
    .option("-o, --output <path>", "Output file or directory")
    .option("--json", "Output as JSON")
    .action(async (app: string, opts: { output?: string; json?: boolean }) => {
      const client = createClient();
      try {
        const detail = await getAppByRef(client, app);
        const result = await downloadApp(detail, opts.output);
        if (jsonRequested(opts)) return outJson(result);
        ok(`Downloaded ${result.files} file${result.files === 1 ? "" : "s"} to ${result.output}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  const actionsCmd = appsCmd
    .command("actions")
    .description("Run published App Actions");

  actionsCmd
    .command("run <app> <action>")
    .description("Run an App Action")
    .option("--input <json>", "JSON input", "null")
    .option("--json", "Output as JSON")
    .action(async (appRef: string, action: string, opts: { input?: string; json?: boolean }) => {
      const client = createClient();
      try {
        const ref = parseAppRef(appRef);
        const detail = "id" in ref
          ? await client.apps.getPublicById(ref.id)
          : await client.apps.getBySlug(ref.username, ref.spaceSlug, ref.appSlug);
        const session = await client.apps.createSession(detail.app.id);
        const appClient = createClientWithAccessToken(session.token);
        const result = await appClient.apps.runAction(detail.app.id, action, parseJsonValue(opts.input, "input"));
        if (jsonRequested(opts)) return outJson(result);
        ok(`App Action queued: ${result.taskRunId}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  appsCmd
    .command("resolve <appSlug>")
    .description("Resolve a published app by owner and space slug")
    .option("--owner <username>", "Owner username")
    .option("--space-slug <slug>", "Space slug")
    .option("--json", "Output as JSON")
    .action(async (appSlug: string, opts: ResolveOptions) => {
      if (!opts.owner?.trim()) return error("Missing owner username", "Pass --owner <username>.");
      if (!opts.spaceSlug?.trim()) return error("Missing space slug", "Pass --space-slug <slug>.");
      const client = createClient();
      try {
        const result = await client.apps.getBySlug(opts.owner.trim(), opts.spaceSlug.trim(), appSlug);
        if (jsonRequested(opts)) return outJson(result);
        printApp(result.app);
        printAppUrls(result);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  appsCmd
    .command("publish <slug>")
    .description("Create or publish an app in the target space")
    .option("--source <source>", "Source: workspace or local (auto-detected from runtime by default)")
    .option("--file <path>", "Publish a file from the selected source")
    .option("--dir <path>", "Publish a directory site from the selected source")
    .option("--port <port>", "Publish a public sandbox port")
    .option("--disabled", "Create as disabled")
    .option("--status <status>", "App status: published, disabled")
    .option("--visibility <visibility>", "App visibility: public, space")
    .option("--app-scope <scope>", "Scope granted directly to the app runtime (space.view, session.view, file.view, file.edit, taskrun.view, session.prompt.readonly, session.prompt.fullaccess, command.execute)", collectOption, [])
    .option("--viewer-scope <scope>", "Deprecated: viewer grants are no longer gated by the app configuration", collectOption, [])
    .option("--meta <json>", "App metadata as a JSON object")
    .option("--hide-cohub-bar", "Hide the Cohub footer bar on the public app page")
    .option("--show-cohub-bar", "Show the Cohub footer bar on the public app page")
    .option("--json", "Output as JSON")
    .action(async (slug: string, opts: PublishOptions) => {
      if (opts.hideCohubBar && opts.showCohubBar) return error("Conflicting Cohub bar options", "Use either --hide-cohub-bar or --show-cohub-bar.");
      const target = resolveTarget(opts);
      if (!target) return error("Missing target", "Use one of --file, --dir, or --port.");
      const source = opts.source ? parseChoice(opts.source, "source", ["workspace", "local"] as const) : resolveDefaultAppSource();
      if (target.targetType === "port" && opts.source) return error("Invalid source", "--source applies only to --file and --dir.");
      const spaceId = await resolveSpace(appsCmd);
      const client = createClient();
      let { targetType, targetRef } = target;
      let sourceRef: string | null = null;
      if (source === "local") {
        const uploaded = await uploadLocalAppSource(client, spaceId, target);
        if (!uploaded) return error("Invalid source", "--source local applies only to --file and --dir.");
        targetRef = uploaded.targetRef;
        sourceRef = uploaded.sourceRef;
      } else if (targetType !== "port") {
        await guardAppTarget(client, spaceId, { targetType, targetRef });
      }
      const status = resolveStatus(opts);
      const meta = withCohubBarMeta({
        meta: parseJsonObject(opts.meta, "meta"),
        hideCohubBar: opts.hideCohubBar,
        showCohubBar: opts.showCohubBar,
      });
      const publishMeta = source === "local"
        ? { ...(meta ?? {}), runtime: { source: { type: "upload", ref: sourceRef } } }
        : meta;
      const input: AppCreateInput = {
        spaceId,
        slug,
        status,
        visibility: resolveVisibility(opts.visibility),
        targetType: target.targetType,
        targetRef,
        appScopes: opts.appScope as Permission[],
        allowedViewerScopes: opts.viewerScope as Permission[],
        meta: publishMeta,
      };
      try {
        const result = await client.apps.create(input);
        if (jsonRequested(opts)) return outJson(result);
        ok(`App published: ${result.app.id}`);
        printApp(result.app);
      } catch (e: unknown) {
        translateTargetWorkerError(e);
        if (!(e instanceof HttpError) || e.status !== 409) handleHttp(e);
        try {
          const { apps } = await client.apps.listBySpace(spaceId);
          const existingApp = apps.find((app) => app.slug === slug);
          if (!existingApp) return handleHttp(e);
          const { app } = await client.apps.update(existingApp.id, {
            status: status === "published" && existingApp.status !== "published" ? existingApp.status : status,
            visibility: resolveVisibility(opts.visibility),
            targetType: target.targetType,
            targetRef,
            appScopes: opts.appScope as Permission[],
            allowedViewerScopes: opts.viewerScope as Permission[],
            meta: publishMeta,
          });
          const publishedVersion = status === "published"
            ? await client.apps.publishVersion(app.id)
            : null;
          const result = publishedVersion ?? { app };
          if (jsonRequested(opts)) return outJson(result);
          ok(status === "published" && publishedVersion ? `App version updated: v${publishedVersion.version.version}` : `App updated: ${app.id}`);
          printApp(result.app);
        } catch (fallbackError: unknown) {
          translateTargetWorkerError(fallbackError);
          handleHttp(fallbackError);
        }
      }
    });

  appsCmd
    .command("update <id>")
    .description("Update app settings")
    .option("--slug <slug>", "New app slug")
    .option("--file <path>", "Use a file target (HTML page, board, or any other file) from the Space workspace")
    .option("--dir <path>", "Use a directory site target from the Space workspace")
    .option("--port <port>", "Use a public sandbox port target")
    .option("--disabled", "Set status to disabled")
    .option("--status <status>", "App status: published, disabled")
    .option("--visibility <visibility>", "App visibility: public, space")
    .option("--app-scope <scope>", "Scope granted directly to the app runtime (space.view, session.view, file.view, file.edit, taskrun.view, session.prompt.readonly, session.prompt.fullaccess, command.execute)", collectOption, [])
    .option("--viewer-scope <scope>", "Deprecated: viewer grants are no longer gated by the app configuration", collectOption, [])
    .option("--clear-app-scopes", "Clear app runtime scopes")
    .option("--clear-viewer-scopes", "Deprecated: clear legacy scope metadata / 已废弃：清除旧权限元数据")
    .option("--meta <json>", "App metadata as a JSON object")
    .option("--hide-cohub-bar", "Hide the Cohub footer bar on the public app page")
    .option("--show-cohub-bar", "Show the Cohub footer bar on the public app page")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: UpdateOptions) => {
      if (opts.hideCohubBar && opts.showCohubBar) return error("Conflicting Cohub bar options", "Use either --hide-cohub-bar or --show-cohub-bar.");
      const target = resolveTarget(opts);
      if (opts.clearAppScopes && opts.appScope?.length) return error("Conflicting app scopes", "Use either --app-scope or --clear-app-scopes.");
      if (opts.clearViewerScopes && opts.viewerScope?.length) return error("Conflicting viewer scopes", "Use either --viewer-scope or --clear-viewer-scopes.");
      const hasMetaUpdate = opts.meta !== undefined || opts.hideCohubBar || opts.showCohubBar;
      const client = createClient();
      if (target) {
        // Resolve the app's home Space so the preflight checks the same
        // workspace the publish worker will read from.
        try {
          const current = await client.apps.get(id);
          const { targetType, targetRef } = target;
          if (targetType !== "port") await guardAppTarget(client, current.app.spaceId, { targetType, targetRef });
        } catch {
          // The update request below surfaces errors for unknown apps.
        }
      }
      let meta: AppMeta | null | undefined;
      if (hasMetaUpdate) {
        let baseMeta = opts.meta !== undefined ? parseJsonObject(opts.meta, "meta") ?? null : undefined;
        if (baseMeta === undefined && (opts.hideCohubBar || opts.showCohubBar)) {
          try {
            baseMeta = (await client.apps.get(id)).app.meta;
          } catch (e: unknown) {
            handleHttp(e);
          }
        }
        meta = withCohubBarMeta({
          meta: baseMeta,
          hideCohubBar: opts.hideCohubBar,
          showCohubBar: opts.showCohubBar,
        });
      }
      const nextStatus = opts.status || opts.disabled ? resolveStatus(opts) : undefined;
      const currentApp = nextStatus === "published" ? (await client.apps.get(id)).app : null;
      const input = compactObject<AppUpdateInput>({
        slug: opts.slug,
        status: nextStatus === "published" && currentApp?.status !== "published" ? currentApp?.status : nextStatus,
        visibility: resolveVisibility(opts.visibility),
        targetType: target?.targetType,
        targetRef: target?.targetRef,
        appScopes: opts.clearAppScopes ? [] : opts.appScope?.length ? opts.appScope as Permission[] : undefined,
        allowedViewerScopes: opts.clearViewerScopes ? [] : opts.viewerScope?.length ? opts.viewerScope as Permission[] : undefined,
        meta,
      });
      if (Object.keys(input).length === 0) return error("Nothing to update", "Pass --slug, --file, --dir, --port, --status, --visibility, --app-scope, --viewer-scope, --clear-app-scopes, --clear-viewer-scopes, --meta, --hide-cohub-bar, or --show-cohub-bar.");
      try {
        const updated = await client.apps.update(id, input);
        const publishedVersion = nextStatus === "published" && currentApp?.status !== "published"
          ? await client.apps.publishVersion(updated.app.id)
          : null;
        const result = publishedVersion ?? { app: updated.app };
        if (jsonRequested(opts)) return outJson(result);
        ok(publishedVersion ? `App published: v${publishedVersion.version.version}` : "App updated");
        printApp(result.app);
      } catch (e: unknown) {
        translateTargetWorkerError(e);
        handleHttp(e);
      }
    });

  appsCmd
    .command("publish-version <id>")
    .description("Publish or update the current app version")
    .option("--json", "Output as JSON")
    .action(publishAppVersion);

  appsCmd
    .command("release <id>", { hidden: true })
    .description("Deprecated alias for publish-version")
    .option("--json", "Output as JSON")
    .action(publishAppVersion);

  appsCmd
    .command("versions <id>")
    .description("List app versions")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const client = createClient();
      try {
        const result = await client.apps.listVersions(id);
        if (jsonRequested(opts)) return outJson(result);
        table(result.versions, [
          { key: "version", label: "Version" },
          { key: "id", label: "ID" },
          { key: "targetType", label: "Target" },
          { key: "targetRef", label: "Ref" },
          { key: "source", label: "Source", format: formatVersionSource },
          { key: "createdAt", label: "Created" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  const promotionsCmd = appsCmd.command("promotions").description("App promotion links and analytics");

  promotionsCmd
    .command("list <app>")
    .alias("ls")
    .description("List promotion links")
    .option("--json", "Output as JSON")
    .action(async (appRef: string, opts: { json?: boolean }) => {
      const client = createClient();
      try {
        const detail = await getAppByRef(client, appRef);
        const result = await client.apps.listPromotions(detail.app.id);
        const promotions = result.promotions.map((promotion) => ({
          ...promotion,
          url: promotionUrl(detail.publicUrl, promotion),
        }));
        if (jsonRequested(opts)) return outJson({ ...result, promotions });
        table(promotions, [
          { key: "name", label: "Name" },
          { key: "provider", label: "Provider" },
          { key: "id", label: "ID" },
          { key: "url", label: "URL" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  promotionsCmd
    .command("create <app>")
    .description("Create an immutable promotion link")
    .requiredOption("--name <name>", "Promotion name")
    .option("--provider <provider>", "Promotion provider", "generic")
    .option("--utm-id <value>", "UTM campaign ID")
    .option("--utm-source <value>", "UTM source")
    .option("--utm-medium <value>", "UTM medium")
    .option("--utm-campaign <value>", "UTM campaign")
    .option("--utm-term <value>", "UTM term")
    .option("--utm-content <value>", "UTM content")
    .option("--json", "Output as JSON")
    .action(async (appRef: string, opts: {
      name: string;
      provider: string;
      utmId?: string;
      utmSource?: string;
      utmMedium?: string;
      utmCampaign?: string;
      utmTerm?: string;
      utmContent?: string;
      json?: boolean;
    }) => {
      const client = createClient();
      try {
        const detail = await getAppByRef(client, appRef);
        const parameters = Object.fromEntries(Object.entries({
          utm_id: opts.utmId,
          utm_source: opts.utmSource,
          utm_medium: opts.utmMedium,
          utm_campaign: opts.utmCampaign,
          utm_term: opts.utmTerm,
          utm_content: opts.utmContent,
        }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
        const result = await client.apps.createPromotion(detail.app.id, {
          name: opts.name,
          provider: opts.provider,
          parameters,
        });
        const url = promotionUrl(detail.publicUrl, result.promotion);
        if (jsonRequested(opts)) return outJson({ ...result, url });
        ok("Promotion created");
        table([{ ...result.promotion, url }], [
          { key: "name", label: "Name" },
          { key: "provider", label: "Provider" },
          { key: "id", label: "ID" },
          { key: "url", label: "URL" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  promotionsCmd
    .command("stats <app> <promotionId>")
    .description("Show promotion analytics")
    .option("--json", "Output as JSON")
    .action(async (appRef: string, promotionId: string, opts: { json?: boolean }) => {
      const client = createClient();
      try {
        const detail = await getAppByRef(client, appRef);
        const result = await client.apps.getPromotionStats(detail.app.id, promotionId);
        if (jsonRequested(opts)) return outJson(result);
        table([{
          name: result.promotion.name,
          landing: result.summary.landing,
          ready: result.summary.ready,
          registered: result.summary.registrationCompleted,
          paywall: result.summary.paywallViewed,
          checkout: result.summary.checkoutStarted,
          readyRate: `${(result.summary.readyRate * 100).toFixed(1)}%`,
        }], [
          { key: "name", label: "Name" },
          { key: "landing", label: "Landing" },
          { key: "ready", label: "Ready" },
          { key: "registered", label: "Registered" },
          { key: "paywall", label: "Paywall" },
          { key: "checkout", label: "Checkout" },
          { key: "readyRate", label: "Ready rate" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  registerAppCommerce(appsCmd);

  // ── Viewer grants ─────────────────────────────────────────────────────────

  appsCmd
    .command("authorize <app>")
    .description("Grant an app scopes as the current user")
    .requiredOption("--scope <scope>", "Scope to grant (repeatable)", collectOption, [])
    .option("--space <spaceId>", "Target space; defaults to the app's own space")
    .option("--extend", "Add scopes without replacing active grants / 增加权限，保留有效授权")
    .option("--json", "Output as JSON")
    .action(async (appRef: string, opts: { scope: string[]; space?: string; extend?: boolean; json?: boolean }) => {
      const client = createClient();
      try {
        const detail = await getAppByRef(client, appRef);
        const result = await client.apps.authorize(detail.app.id, {
          scopes: opts.scope as Permission[],
          ...(opts.space ? { spaceId: opts.space } : {}),
          ...(opts.extend ? { scopeMode: "extend" as const } : {}),
        });
        if (jsonRequested(opts)) return outJson(result);
        ok(`Granted ${result.grant.scopes.join(", ")} on space ${result.grant.spaceId}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  appsCmd
    .command("grants <app>")
    .description("List your grants for an app")
    .option("--json", "Output as JSON")
    .action(async (appRef: string, opts: { json?: boolean }) => {
      const client = createClient();
      try {
        const detail = await getAppByRef(client, appRef);
        const result = await client.apps.listMyGrants(detail.app.id);
        if (jsonRequested(opts)) return outJson(result);
        table(result.grants, [
          { key: "id", label: "ID" },
          { key: "spaceId", label: "Space" },
          { key: "scopes", label: "Scopes" },
          { key: "expiresAt", label: "Expires" },
          { key: "revokedAt", label: "Revoked" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  appsCmd
    .command("revoke <app> <grantId>")
    .description("Revoke one of your grants for an app")
    .action(async (appRef: string, grantId: string) => {
      const client = createClient();
      try {
        const detail = await getAppByRef(client, appRef);
        await client.apps.revokeMyGrant(detail.app.id, grantId);
        ok("Grant revoked");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  appsCmd
    .command("rm <id>")
    .alias("delete")
    .description("Delete an app")
    .option("-y, --yes", "Confirm deletion")
    .action(async (id: string, opts: { yes?: boolean }) => {
      await confirmDelete(opts);
      const client = createClient();
      try {
        await client.apps.delete(id);
        ok("App deleted");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}
