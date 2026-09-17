import type {
	AppMeta,
	AppRecord,
	AppVersionRecord,
	AppViewStatsResponse,
} from "@neta-art/cohub";
import { goto } from "$app/navigation";
import {
	type AppsChangedDetail,
	dispatchAppsChanged,
	isNewerAppSnapshot,
	upsertAppVersion,
} from "$lib/features/app/app-realtime";
import { sdk } from "$lib/sdk";
import { buildSpaceLandingRoute } from "$lib/space-routes";
import { APP_SCOPE_OPTIONS, scopeState, selectedScopeList } from "./app-utils";
import { createKeyedRouteRequestGuard } from "./route-request-guard";

export type AppTargetType = "file" | "directory" | "port";
export type AppStatus = "published" | "disabled";
export type AppVisibility = "public" | "space";

const WORK_HIDE_COHUB_BAR_FEATURE = "work.publish.hide_cohub_bar";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value && typeof value === "object" && !Array.isArray(value));

function getHideCohubBar(meta: AppMeta | null | undefined) {
	return (
		isRecord(meta?.presentation) && meta.presentation.hideCohubBar === true
	);
}

function buildAppMeta(
	currentMeta: AppMeta | null | undefined,
	hideCohubBar: boolean,
): AppMeta | null {
	const meta: AppMeta = isRecord(currentMeta) ? { ...currentMeta } : {};
	const presentation: NonNullable<AppMeta["presentation"]> &
		Record<string, unknown> = isRecord(meta.presentation)
		? { ...meta.presentation }
		: {};
	if (hideCohubBar) {
		presentation.hideCohubBar = true;
	} else {
		delete presentation.hideCohubBar;
	}
	if (Object.keys(presentation).length) {
		meta.presentation = presentation;
	} else {
		delete meta.presentation;
	}
	return Object.keys(meta).length ? meta : null;
}

export function createAppDetailController(options: {
	getSpaceId: () => string;
	getRouteAppId: () => string | null;
	getOwnerUsername: () => string | null;
	getSpaceSlug: () => string | null;
	/** Stats require app.manage; skip the request for viewers who cannot manage the App. */
	getCanViewStats: () => boolean;
	onDetailLoaded?: (app: AppRecord | null) => void;
}) {
	let detail = $state<AppRecord | null>(null);
	let loading = $state(false);
	let error = $state("");
	let actionInProgress = $state(false);
	let deleteInProgress = $state(false);
	let editMode = $state(false);
	let formSlug = $state("");
	let formTargetType = $state<AppTargetType>("file");
	let formTargetRef = $state("");
	let formStatus = $state<AppStatus>("published");
	let formVisibility = $state<AppVisibility>("public");
	let formHideCohubBar = $state(false);
	let hideCohubBarAllowed = $state(false);
	let hideCohubBarLoading = $state(false);
	let formScopes = $state<Record<string, boolean>>({});
	let formSubmitting = $state(false);
	let formError = $state("");
	let copiedId = $state(false);
	let copiedPublicRoute = $state(false);
	let copiedTimer: ReturnType<typeof setTimeout> | null = null;
	let copiedPublicRouteTimer: ReturnType<typeof setTimeout> | null = null;
	let routeStateKey = "";
	let versions = $state<AppVersionRecord[]>([]);
	let versionsLoading = $state(false);
	let versionsError = $state("");
	let stats = $state<AppViewStatsResponse | null>(null);
	let statsLoading = $state(false);
	let statsError = $state("");
	let publishSubmitting = $state(false);
	let publishError = $state("");

	function notify(app: AppRecord | null) {
		options.onDetailLoaded?.(app);
	}

	function syncFormFromDetail() {
		if (!detail) return;
		formSlug = detail.slug;
		formTargetType = detail.targetType;
		formTargetRef = detail.targetRef;
		formStatus = detail.status;
		formVisibility = detail.visibility;
		formHideCohubBar = getHideCohubBar(detail.meta);
		formScopes = scopeState(detail.appScopes, APP_SCOPE_OPTIONS);
		formError = "";
		publishError = "";
	}

	async function loadHideCohubBarEntitlement() {
		const stateKey = routeStateKey;
		hideCohubBarLoading = true;
		try {
			const { enabled } = await sdk.billing.getFeatureEntitlement(
				WORK_HIDE_COHUB_BAR_FEATURE,
			);
			if (routeStateKey !== stateKey) return;
			hideCohubBarAllowed = enabled;
			if (!enabled && !getHideCohubBar(detail?.meta)) formHideCohubBar = false;
		} catch {
			if (routeStateKey !== stateKey) return;
			hideCohubBarAllowed = false;
			if (!getHideCohubBar(detail?.meta)) formHideCohubBar = false;
		} finally {
			if (routeStateKey === stateKey) hideCohubBarLoading = false;
		}
	}

	function notifyAppsUpdated(change: Omit<AppsChangedDetail, "spaceId"> = {}) {
		dispatchAppsChanged({ spaceId: options.getSpaceId(), ...change });
	}

	function publicRoute(app: AppRecord | null = detail) {
		const ownerUsername = options.getOwnerUsername();
		const spaceSlug = options.getSpaceSlug();
		return ownerUsername && spaceSlug && app?.slug
			? `/${encodeURIComponent(ownerUsername)}/${encodeURIComponent(spaceSlug)}/w/${encodeURIComponent(app.slug)}`
			: null;
	}

	async function loadDetail(appId: string) {
		const requestSpaceId = options.getSpaceId();
		const isCurrentRequest = () =>
			options.getSpaceId() === requestSpaceId &&
			options.getRouteAppId() === appId;
		loading = true;
		error = "";
		try {
			const { app } = await sdk.apps.get(appId);
			if (!isCurrentRequest()) return;
			if (isNewerAppSnapshot(detail, app)) {
				detail = app;
				notify(app);
				syncFormFromDetail();
			}
			void loadHideCohubBarEntitlement();
			void loadVersions(app.id);
			if (options.getCanViewStats()) void loadStats(app.id);
		} catch (cause) {
			if (!isCurrentRequest()) return;
			detail = null;
			notify(null);
			error = cause instanceof Error ? cause.message : "Failed to load app";
		} finally {
			if (isCurrentRequest()) loading = false;
		}
	}

	async function loadVersions(appId: string) {
		const guard = createKeyedRouteRequestGuard({
			captureKey: () =>
				`${options.getSpaceId()}:${options.getRouteAppId() ?? ""}`,
		});
		versionsLoading = true;
		versionsError = "";
		try {
			const { versions: nextVersions } = await sdk.apps.listVersions(appId);
			if (guard.isCurrent()) {
				versions = versions.reduce(upsertAppVersion, nextVersions);
			}
		} catch (cause) {
			if (guard.isCurrent()) {
				versionsError =
					cause instanceof Error ? cause.message : "Failed to load versions";
			}
		} finally {
			if (guard.isCurrent()) versionsLoading = false;
		}
	}

	async function loadStats(appId: string) {
		if (!options.getCanViewStats()) return;
		const guard = createKeyedRouteRequestGuard({
			captureKey: () =>
				`${options.getSpaceId()}:${options.getRouteAppId() ?? ""}`,
		});
		statsLoading = true;
		statsError = "";
		try {
			const nextStats = await sdk.apps.getStats(appId);
			if (guard.isCurrent()) stats = nextStats;
		} catch (cause) {
			if (guard.isCurrent()) {
				statsError =
					cause instanceof Error ? cause.message : "Failed to load view stats";
			}
		} finally {
			if (guard.isCurrent()) statsLoading = false;
		}
	}

	async function publishVersion() {
		if (!detail || publishSubmitting) return;
		publishError = "";
		publishSubmitting = true;
		try {
			const { app, version } = await sdk.apps.publishVersion(detail.id);
			detail = app;
			notify(app);
			syncFormFromDetail();
			await loadVersions(app.id);
			notifyAppsUpdated({ app, version });
		} catch (cause) {
			publishError =
				cause instanceof Error ? cause.message : "Failed to publish version";
		} finally {
			publishSubmitting = false;
		}
	}

	async function copyId(id: string) {
		try {
			await navigator.clipboard.writeText(id);
			copiedId = true;
			if (copiedTimer) clearTimeout(copiedTimer);
			copiedTimer = setTimeout(() => {
				copiedId = false;
			}, 1600);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Failed to copy app ID";
		}
	}

	async function copyPublicRoute(route: string) {
		const value =
			typeof window === "undefined"
				? route
				: `${window.location.origin}${route}`;
		try {
			await navigator.clipboard.writeText(value);
			copiedPublicRoute = true;
			if (copiedPublicRouteTimer) clearTimeout(copiedPublicRouteTimer);
			copiedPublicRouteTimer = setTimeout(() => {
				copiedPublicRoute = false;
			}, 1600);
		} catch (cause) {
			error =
				cause instanceof Error ? cause.message : "Failed to copy public link";
		}
	}

	async function toggleStatus(status: "published" | "disabled") {
		if (!detail || actionInProgress) return;
		actionInProgress = true;
		error = "";
		try {
			let app: AppRecord;
			let version: AppVersionRecord | undefined;
			if (status === "published") {
				const result = await sdk.apps.publishVersion(detail.id);
				app = result.app;
				version = result.version;
			} else {
				app = (await sdk.apps.update(detail.id, { status })).app;
			}
			detail = app;
			notify(app);
			syncFormFromDetail();
			void loadVersions(app.id);
			notifyAppsUpdated({ app, version });
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Failed to update app";
			void loadDetail(detail.id);
		} finally {
			actionInProgress = false;
		}
	}

	async function deleteApp() {
		if (
			!detail ||
			actionInProgress ||
			deleteInProgress ||
			!confirm(
				"Delete this app? This removes the management record and public link.",
			)
		)
			return;
		const deletedAppId = detail.id;
		let deleted = false;
		actionInProgress = true;
		deleteInProgress = true;
		error = "";
		try {
			await sdk.apps.delete(deletedAppId);
			deleted = true;
			detail = null;
			notify(null);
			notifyAppsUpdated({ deletedAppId });
			await goto(buildSpaceLandingRoute(options.getSpaceId()), {
				replaceState: true,
			});
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Failed to delete app";
		} finally {
			if (!deleted) {
				actionInProgress = false;
				deleteInProgress = false;
			}
		}
	}

	async function submitUpdate(event: SubmitEvent) {
		event.preventDefault();
		if (!detail || formSubmitting) return;
		formError = "";
		if (!formSlug.trim()) {
			formError = "Slug is required";
			return;
		}
		if (!formTargetRef.trim()) {
			formError = "Target is required";
			return;
		}
		formSubmitting = true;
		try {
			const shouldRelease =
				formStatus === "published" && detail.status !== "published";
			const { app: savedApp } = await sdk.apps.update(detail.id, {
				slug: formSlug.trim(),
				status: shouldRelease ? detail.status : formStatus,
				visibility: formVisibility,
				targetType: formTargetType,
				targetRef: formTargetRef.trim(),
				appScopes: selectedScopeList(formScopes, APP_SCOPE_OPTIONS),
				meta: buildAppMeta(detail.meta, formHideCohubBar),
			});
			let app = savedApp;
			let version: AppVersionRecord | undefined;
			if (shouldRelease) {
				const result = await sdk.apps.publishVersion(savedApp.id);
				app = result.app;
				version = result.version;
			}
			detail = app;
			notify(app);
			editMode = false;
			syncFormFromDetail();
			void loadVersions(app.id);
			notifyAppsUpdated({ app, version });
		} catch (cause) {
			formError = cause instanceof Error ? cause.message : "Failed to save app";
		} finally {
			formSubmitting = false;
		}
	}

	function applyAppsChanged(change: AppsChangedDetail) {
		if (change.spaceId !== options.getSpaceId()) return;
		const appId = options.getRouteAppId();
		if (!appId) return;
		if (change.deletedAppId === appId) {
			detail = null;
			notify(null);
			return;
		}
		if (!change.app || change.app.id !== appId) return;
		if (isNewerAppSnapshot(detail, change.app)) {
			detail = change.app;
			notify(change.app);
			if (!editMode && !formSubmitting) syncFormFromDetail();
		}
		if (change.version?.appId === appId) {
			versions = upsertAppVersion(versions, change.version);
		}
	}

	function refresh() {
		const appId = options.getRouteAppId();
		if (appId) void loadDetail(appId);
	}

	function resetTransientState() {
		loading = false;
		versions = [];
		versionsLoading = false;
		versionsError = "";
		stats = null;
		statsLoading = false;
		statsError = "";
		editMode = false;
		actionInProgress = false;
		deleteInProgress = false;
		formError = "";
		hideCohubBarAllowed = false;
		hideCohubBarLoading = false;
		publishError = "";
		copiedPublicRoute = false;
	}

	function syncRoute() {
		const appId = options.getRouteAppId();
		const stateKey = `${options.getSpaceId()}:${appId ?? ""}`;
		if (routeStateKey === stateKey) return;
		routeStateKey = stateKey;
		resetTransientState();
		if (appId) {
			void loadDetail(appId);
			return;
		}
		detail = null;
		notify(null);
	}

	function dispose() {
		if (copiedTimer) clearTimeout(copiedTimer);
		if (copiedPublicRouteTimer) clearTimeout(copiedPublicRouteTimer);
		copiedTimer = null;
		copiedPublicRouteTimer = null;
	}

	return {
		get detail() {
			return detail;
		},
		get loading() {
			return loading;
		},
		get error() {
			return error;
		},
		get actionInProgress() {
			return actionInProgress;
		},
		get deleteInProgress() {
			return deleteInProgress;
		},
		get editMode() {
			return editMode;
		},
		set editMode(value: boolean) {
			editMode = value;
		},
		get formSlug() {
			return formSlug;
		},
		set formSlug(value: string) {
			formSlug = value;
		},
		get formTargetType() {
			return formTargetType;
		},
		set formTargetType(value: AppTargetType) {
			formTargetType = value;
		},
		get formTargetRef() {
			return formTargetRef;
		},
		set formTargetRef(value: string) {
			formTargetRef = value;
		},
		get formStatus() {
			return formStatus;
		},
		set formStatus(value: AppStatus) {
			formStatus = value;
		},
		get formVisibility() {
			return formVisibility;
		},
		set formVisibility(value: AppVisibility) {
			formVisibility = value;
		},
		get formHideCohubBar() {
			return formHideCohubBar;
		},
		set formHideCohubBar(value: boolean) {
			formHideCohubBar = value;
		},
		get hideCohubBarAllowed() {
			return hideCohubBarAllowed;
		},
		get hideCohubBarLoading() {
			return hideCohubBarLoading;
		},
		get formScopes() {
			return formScopes;
		},
		set formScopes(value: Record<string, boolean>) {
			formScopes = value;
		},
		get formSubmitting() {
			return formSubmitting;
		},
		get formError() {
			return formError;
		},
		get copiedId() {
			return copiedId;
		},
		get copiedPublicRoute() {
			return copiedPublicRoute;
		},
		get versions() {
			return versions;
		},
		get versionsLoading() {
			return versionsLoading;
		},
		get versionsError() {
			return versionsError;
		},
		get stats() {
			return stats;
		},
		get statsLoading() {
			return statsLoading;
		},
		get statsError() {
			return statsError;
		},
		get publishSubmitting() {
			return publishSubmitting;
		},
		get publishError() {
			return publishError;
		},
		syncFormFromDetail,
		publicRoute,
		loadStats,
		publishVersion,
		copyId,
		copyPublicRoute,
		toggleStatus,
		deleteApp,
		submitUpdate,
		applyAppsChanged,
		refresh,
		syncRoute,
		dispose,
	};
}
