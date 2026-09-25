import { z } from "zod";

export const APPS_PATH = ".cohub/apps.json";
export const CATALOG_ID = "cohub";

const HttpUrl = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Expected an HTTP(S) URL");
const AppId = z.string().uuid();

// Mirrors `parseCanonicalAppRef` in @cohub/protocol (packages/protocol/src/app-catalog.ts):
// usernames follow the username rule (no underscores), space/app slugs allow `_` and up to 80 chars.
const UsernamePattern = /^(?!-)(?!.*--)[a-z0-9-]{1,39}(?<!-)$/;
const SlugPattern = /^[a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?$/;

function parseCanonicalAppRef(value: string): string | null {
  const parts = value.trim().split("/");
  if (parts.length !== 3) return null;
  const username = parts[0].trim().toLowerCase();
  const spaceSlug = parts[1].trim();
  const appSlug = parts[2].trim();
  return UsernamePattern.test(username) && SlugPattern.test(spaceSlug) && SlugPattern.test(appSlug)
    ? `${username}/${spaceSlug}/${appSlug}`
    : null;
}

const AppRef = z.string().trim().transform((value, context) => {
  const ref = parseCanonicalAppRef(value);
  if (!ref) {
    context.addIssue({ code: "custom", message: "Expected username/space/app" });
    return z.NEVER;
  }
  return ref;
});
const OptionalText = z.string().trim().min(1).max(500).optional();
const OptionalIcon = HttpUrl.optional();
const Keywords = z.array(z.string().trim().min(1).max(60)).max(30).optional();

export const MarketplaceEntrySchema = z.object({
  id: AppId,
  ref: AppRef,
  name: z.string().trim().min(1).max(120),
  description: OptionalText,
  icon: OptionalIcon,
  url: HttpUrl,
  publisher: z.string().trim().min(1).max(120).optional(),
  keywords: Keywords,
});
export const MarketplaceCatalogSchema = z.object({
  format: z.literal("cohub.app-marketplace"),
  version: z.literal(1),
  apps: z.array(MarketplaceEntrySchema).max(10_000),
});

const MAX_FILE_HANDLERS = 32;
const EXTENSION = /^\.[a-z0-9][a-z0-9_-]{0,31}$/;

// Installed-App records are loose: fields this App does not know yet survive a
// write, so an older Marketplace never erases what a newer Cohub recorded.
const InstalledSourceSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("marketplace"), catalog: z.union([z.literal(CATALOG_ID), HttpUrl]), appId: z.string().trim().min(1).max(255) }),
  z.looseObject({ type: z.literal("url"), url: HttpUrl }),
]);
const InstalledAppSchema = z.looseObject({
  id: AppId,
  ref: AppRef,
  url: HttpUrl,
  enabled: z.boolean(),
  source: InstalledSourceSchema,
  snapshot: z.looseObject({ name: z.string().trim().min(1).max(120), description: OptionalText, icon: OptionalIcon, publisher: z.string().trim().min(1).max(120).optional(), keywords: Keywords }),
  installedAt: z.string().datetime({ offset: true }),
  /** File extensions this App opens by default in the Space. */
  // Lenient on read: one bad record must not break every installed App.
  opens: z.unknown().transform((value) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [])).optional(),
});
export const ManifestSchema = z.looseObject({ format: z.literal("cohub.space-apps"), version: z.literal(1), apps: z.array(InstalledAppSchema).max(1_000) });

export type MarketplaceEntry = z.infer<typeof MarketplaceEntrySchema>;
export type Manifest = z.infer<typeof ManifestSchema>;
export type InstalledApp = Manifest["apps"][number];
export type FileState = { document: Manifest; revision: { mtimeMs: number; size: number } | null };

export function parseCatalog(value: unknown) {
  return MarketplaceCatalogSchema.parse(value).apps;
}

export function parseManifest(value: string): Manifest {
  return ManifestSchema.parse(JSON.parse(value));
}

export function emptyManifest(): Manifest {
  return { format: "cohub.space-apps", version: 1, apps: [] };
}

/** Declared extensions no enabled App holds; installing never replaces a default. */
export function unclaimedFileHandlers(manifest: Manifest, declared: unknown): string[] {
  if (!Array.isArray(declared)) return [];
  // A disabled App does not keep an extension from a new one.
  const held = new Set(manifest.apps.flatMap((app) => (app.enabled ? (app.opens ?? []) : [])));
  // Same normalization as Cohub: `Board` and `.board` are the same extension.
  const extensions = declared
    .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
    .map((value) => (value.startsWith(".") ? value : `.${value}`))
    .filter((value) => EXTENSION.test(value));
  return [...new Set(extensions)].filter((extension) => !held.has(extension)).slice(0, MAX_FILE_HANDLERS);
}

export function toInstalledApp(app: MarketplaceEntry, installedAt = new Date().toISOString(), opens: string[] = []): InstalledApp {
  return {
    id: app.id,
    ref: app.ref,
    url: app.url,
    enabled: true,
    source: { type: "marketplace", catalog: CATALOG_ID, appId: app.id },
    snapshot: { name: app.name, ...(app.description ? { description: app.description } : {}), ...(app.icon ? { icon: app.icon } : {}), ...(app.publisher ? { publisher: app.publisher } : {}), ...(app.keywords ? { keywords: app.keywords } : {}) },
    installedAt,
    ...(opens.length > 0 ? { opens } : {}),
  };
}

export function isPermissionError(cause: unknown) {
  const status = (cause as { status?: unknown } | null)?.status;
  return status === 401 || status === 403;
}
