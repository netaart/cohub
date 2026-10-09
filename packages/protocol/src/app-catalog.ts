import { z } from "zod";
import { fileExtensionOf, parseAppFileHandlers } from "./app-file-handlers.js";
import { parseSpaceSlug, parseUsername } from "./public-identifiers.js";

export const SPACE_INSTALLED_APPS_PATH = ".cohub/apps.json";
export const COHUB_APP_CATALOG_ID = "cohub";
export const COHUB_APP_MARKETPLACE_URL =
  "https://cdn.cohub.live/app-market/catalog.v1.json";

export const APP_MARKETPLACE_FORMAT = "cohub.app-marketplace";
export const SPACE_APPS_FORMAT = "cohub.space-apps";
export const APP_CATALOG_FORMAT_VERSION = 1;

export function parseCanonicalAppRef(value: string): string | null {
  const parts = value.trim().split("/");
  if (parts.length !== 3) return null;
  const username = parseUsername(parts[0]);
  const spaceSlug = parseSpaceSlug(parts[1]);
  const appSlug = parseSpaceSlug(parts[2]);
  return username && spaceSlug && appSlug
    ? `${username}/${spaceSlug}/${appSlug}`
    : null;
}

const HttpUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}, "Expected an HTTP(S) URL");

const AppIdSchema = z.uuid();

const AppRefSchema = z.string().transform((value, context) => {
  const ref = parseCanonicalAppRef(value);
  if (!ref) {
    context.addIssue({ code: "custom", message: "Expected username/space/app" });
    return z.NEVER;
  }
  return ref;
});

const OptionalTextSchema = z.string().trim().min(1).max(500).optional();
const OptionalIconSchema = HttpUrlSchema.optional();
const KeywordsSchema = z.array(z.string().trim().min(1).max(60)).max(30).optional();

export const AppMarketplaceEntrySchema = z.object({
  id: AppIdSchema,
  ref: AppRefSchema,
  name: z.string().trim().min(1).max(120),
  description: OptionalTextSchema,
  icon: OptionalIconSchema,
  url: HttpUrlSchema,
  publisher: z.string().trim().min(1).max(120).optional(),
  keywords: KeywordsSchema,
});

export type AppMarketplaceEntry = z.infer<typeof AppMarketplaceEntrySchema>;

export const AppMarketplaceCatalogSchema = z.object({
  format: z.literal(APP_MARKETPLACE_FORMAT),
  version: z.literal(APP_CATALOG_FORMAT_VERSION),
  apps: z.array(AppMarketplaceEntrySchema).max(10_000),
});

export type AppMarketplaceCatalog = z.infer<typeof AppMarketplaceCatalogSchema>;

// Installed-App records are loose: a writer keeps fields it does not know yet,
// so an older client never erases what a newer one recorded.
export const InstalledAppSourceSchema = z.discriminatedUnion("type", [
  z.looseObject({
    type: z.literal("marketplace"),
    catalog: z.union([z.literal(COHUB_APP_CATALOG_ID), HttpUrlSchema]),
    appId: z.string().trim().min(1).max(255),
  }),
  z.looseObject({
    type: z.literal("url"),
    url: HttpUrlSchema,
  }),
]);

export type InstalledAppSource = z.infer<typeof InstalledAppSourceSchema>;

export const InstalledAppSnapshotSchema = z.looseObject({
  name: z.string().trim().min(1).max(120),
  description: OptionalTextSchema,
  icon: OptionalIconSchema,
  publisher: z.string().trim().min(1).max(120).optional(),
  keywords: KeywordsSchema,
});

export type InstalledAppSnapshot = z.infer<typeof InstalledAppSnapshotSchema>;

export const InstalledAppSchema = z.looseObject({
  id: AppIdSchema,
  ref: AppRefSchema,
  url: HttpUrlSchema,
  enabled: z.boolean(),
  source: InstalledAppSourceSchema,
  snapshot: InstalledAppSnapshotSchema,
  installedAt: z.iso.datetime(),
  /** Extensions this App opens by default; lenient, so a bad record never breaks the file. */
  opens: z.unknown().transform(parseAppFileHandlers).optional(),
});

export type InstalledApp = z.infer<typeof InstalledAppSchema>;

export const SpaceInstalledAppsSchema = z.looseObject({
  format: z.literal(SPACE_APPS_FORMAT),
  version: z.literal(APP_CATALOG_FORMAT_VERSION),
  apps: z.array(InstalledAppSchema).max(1_000),
});

export type SpaceInstalledApps = z.infer<typeof SpaceInstalledAppsSchema>;

/** The enabled installed App that opens this file by default, if any. */
export function installedFileHandler(
  document: SpaceInstalledApps,
  path: string,
): InstalledApp | null {
  const extension = fileExtensionOf(path);
  if (!extension) return null;
  return document.apps.find((app) => app.enabled && app.opens?.includes(extension)) ?? null;
}

/** Moves `extension` to `appId`, or to the built-in viewer when null. */
export function setInstalledFileHandler(
  document: SpaceInstalledApps,
  extension: string,
  appId: string | null,
): SpaceInstalledApps {
  return {
    ...document,
    apps: document.apps.map((app) => {
      const others = (app.opens ?? []).filter((value) => value !== extension);
      const opens = app.id === appId ? [...others, extension] : others;
      const { opens: _previous, ...rest } = app;
      return opens.length > 0 ? { ...rest, opens } : rest;
    }),
  };
}

/** Enables or disables an App; re-enabling never takes back a claimed extension. */
export function setInstalledAppEnabled(
  document: SpaceInstalledApps,
  appId: string,
  enabled: boolean,
): SpaceInstalledApps {
  const held = new Set(
    document.apps.flatMap((app) => (app.enabled && app.id !== appId ? (app.opens ?? []) : [])),
  );
  return {
    ...document,
    apps: document.apps.map((app) => {
      if (app.id !== appId) return app;
      if (!enabled) return { ...app, enabled };
      const { opens: _previous, ...rest } = app;
      const opens = (app.opens ?? []).filter((extension) => !held.has(extension));
      return opens.length > 0 ? { ...rest, enabled, opens } : { ...rest, enabled };
    }),
  };
}

/** Declared extensions no enabled App holds; installing never replaces a default. */
export function unclaimedFileHandlers(
  document: SpaceInstalledApps,
  declared: readonly string[],
): string[] {
  const held = new Set(document.apps.flatMap((app) => (app.enabled ? (app.opens ?? []) : [])));
  return parseAppFileHandlers(declared).filter((extension) => !held.has(extension));
}

export function emptySpaceInstalledApps(): SpaceInstalledApps {
  return { format: SPACE_APPS_FORMAT, version: APP_CATALOG_FORMAT_VERSION, apps: [] };
}

export function marketplaceEntryToInstalledApp(
  entry: AppMarketplaceEntry,
  installedAt = new Date().toISOString(),
): InstalledApp {
  return {
    id: entry.id,
    ref: entry.ref,
    url: entry.url,
    enabled: true,
    source: {
      type: "marketplace",
      catalog: COHUB_APP_CATALOG_ID,
      appId: entry.id,
    },
    snapshot: {
      name: entry.name,
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.icon ? { icon: entry.icon } : {}),
      ...(entry.publisher ? { publisher: entry.publisher } : {}),
      ...(entry.keywords ? { keywords: entry.keywords } : {}),
    },
    installedAt,
  };
}
