import {
	appHandlesFile,
	fileExtensionOf,
	InstalledAppSchema,
	installedFileHandler,
	parseAppFileHandlers,
	type SpaceInstalledApps,
	setInstalledAppEnabled,
	setInstalledFileHandler,
} from "@cohub/protocol";
import type { AppDetailResponse, AppMeta, AppRecord } from "@neta-art/cohub";
import { appDisplayTitle } from "$lib/app-page-meta";
import type { InstalledAppsFile } from "./app-center";
import { type AppLoader, loadAppPreview } from "./app-open";

/** An App the viewer can open a file with. */
export type FileHandlerApp = {
	appId: string;
	slug: string;
	meta: AppMeta | null;
};

type HandlerRecord = Pick<AppRecord, "id" | "slug" | "status" | "meta">;

/** Whether a published App declares that it opens this file. */
export function canOpenFileWith(
	app: HandlerRecord | null | undefined,
	path: string,
): boolean {
	return (
		app?.status === "published" &&
		appHandlesFile(parseAppFileHandlers(app.meta?.fileHandlers), path)
	);
}

const toHandlerApp = (app: HandlerRecord): FileHandlerApp => ({
	appId: app.id,
	slug: app.slug,
	meta: app.meta ?? null,
});

export type FileHandlerResolver = ReturnType<typeof createFileHandlerResolver>;

/** After this, a cached App is still used, but refreshed in the background. */
const APP_DETAIL_TTL_MS = 5 * 60 * 1_000;

/** The App is gone for this viewer, as opposed to unreachable right now. */
const isGone = (cause: unknown) => {
	const status = (cause as { status?: number } | null)?.status;
	return status === 403 || status === 404;
};

/** Resolves which App opens a file; App lookups are stale-while-revalidate. */
export function createFileHandlerResolver(deps: {
	loader: Pick<AppLoader, "get" | "getPublicById">;
	/** Apps the Space published. */
	listSpaceApps: (spaceId: string) => Promise<HandlerRecord[]>;
	/** The Space's installed Apps, `.cohub/apps.json`. */
	readInstalled: (spaceId: string) => Promise<SpaceInstalledApps>;
}) {
	const details = new Map<string, { detail: AppDetailResponse; at: number }>();
	const inFlight = new Map<string, Promise<AppDetailResponse | null>>();

	function fetchApp(appId: string) {
		let pending = inFlight.get(appId);
		if (pending) return pending;
		pending = loadAppPreview(deps.loader, appId)
			.then(
				(detail) => {
					details.set(appId, { detail, at: Date.now() });
					return detail;
				},
				(cause) => {
					// A gone App is not cached, so the next open looks again.
					if (!isGone(cause)) throw cause;
					details.delete(appId);
					return null;
				},
			)
			.finally(() => inFlight.delete(appId));
		inFlight.set(appId, pending);
		return pending;
	}

	/** Null when the App is gone; rejects only when unreachable and uncached. */
	function loadApp(appId: string): Promise<AppDetailResponse | null> {
		const cached = details.get(appId);
		if (!cached) return fetchApp(appId);
		// A failed refresh keeps the known App.
		if (Date.now() - cached.at >= APP_DETAIL_TTL_MS)
			void fetchApp(appId).catch(() => {});
		return Promise.resolve(cached.detail);
	}

	/** The default App for this file; `app` is null when it can no longer open it. */
	async function resolveDefault(
		spaceId: string,
		path: string,
	): Promise<{ ref: string; app: FileHandlerApp | null } | null> {
		const holder = installedFileHandler(
			await deps.readInstalled(spaceId),
			path,
		);
		if (!holder) return null;
		const detail = await loadApp(holder.id);
		return {
			ref: holder.ref,
			app:
				detail && canOpenFileWith(detail.app, path)
					? toHandlerApp(detail.app)
					: null,
		};
	}

	/** Apps this Space published or installed that declare the file's extension. */
	async function listCandidates(spaceId: string, path: string) {
		if (!fileExtensionOf(path)) return [];
		const [own, installed] = await Promise.all([
			deps.listSpaceApps(spaceId).catch(() => []),
			deps.readInstalled(spaceId).then(
				(document) => document.apps.filter((app) => app.enabled),
				() => [],
			),
		]);
		const installedApps = await Promise.all(
			installed.map((app) => loadApp(app.id).catch(() => null)),
		);
		const seen = new Set<string>();
		const candidates: FileHandlerApp[] = [];
		for (const app of [
			...own,
			...installedApps.map((detail) => detail?.app ?? null),
		]) {
			if (!app || seen.has(app.id) || !canOpenFileWith(app, path)) continue;
			seen.add(app.id);
			candidates.push(toHandlerApp(app));
		}
		return candidates;
	}

	return {
		resolveDefault,
		listCandidates,
		loadApp,
		clear: () => details.clear(),
	};
}

/** The install record for a Space's own App, so it can become a default. */
export function installedAppFromDetail(detail: AppDetailResponse) {
	if (!detail.publicUrl) throw new Error("This App has no public URL yet.");
	const icon = detail.app.meta?.icon;
	return InstalledAppSchema.parse({
		id: detail.app.id,
		ref: `${detail.owner.username}/${detail.space.slug}/${detail.app.slug}`,
		url: detail.publicUrl,
		enabled: true,
		source: { type: "url", url: detail.publicUrl },
		snapshot: {
			name: appDisplayTitle(detail.app.meta, detail.app.slug),
			...(detail.app.meta?.description
				? { description: detail.app.meta.description }
				: {}),
			...(icon && /^https?:\/\//.test(icon) ? { icon } : {}),
		},
		installedAt: new Date().toISOString(),
	});
}

/** Sets the default App for the file's extension (null: built in), conditional on the read revision. */
export async function saveDefaultFileHandler(
	deps: {
		read: (spaceId: string) => Promise<InstalledAppsFile>;
		write: (
			spaceId: string,
			document: SpaceInstalledApps,
			revision: InstalledAppsFile["revision"],
		) => Promise<InstalledAppsFile["revision"]>;
		loadApp: (appId: string) => Promise<AppDetailResponse | null>;
	},
	input: { spaceId: string; path: string; appId: string | null },
): Promise<InstalledAppsFile | null> {
	const extension = fileExtensionOf(input.path);
	if (!extension) return null;
	const current = await deps.read(input.spaceId);
	let document = current.document;
	if (input.appId && !document.apps.some((app) => app.id === input.appId)) {
		const detail = await deps.loadApp(input.appId);
		if (!detail) throw new Error("This App is not available.");
		document = {
			...document,
			apps: [...document.apps, installedAppFromDetail(detail)],
		};
	}
	// Choosing an App to open a file type is also choosing to use it.
	if (input.appId)
		document = setInstalledAppEnabled(document, input.appId, true);
	const next = setInstalledFileHandler(document, extension, input.appId);
	const revision = await deps.write(input.spaceId, next, current.revision);
	return { document: next, revision };
}
