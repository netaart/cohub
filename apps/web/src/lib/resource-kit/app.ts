import type { ChannelEnvelope } from "@cohub/protocol/realtime";
import type {
	AppDetailResponse,
	AppDomainListResponse,
	AppDomainRecord,
	AppMeta,
	AppRecord,
	AppVersionRecord,
	Permission,
} from "@neta-art/cohub";
import { m } from "$messages";
import { asRecord, type Locale } from "./core";

export type AppTotals = Pick<AppDetailResponse, "totalViews" | "likeCount">;

type Message = (
	inputs?: Record<string, never>,
	options?: { locale?: Locale },
) => string;

export const APP_SCOPE_OPTIONS: {
	scope: Permission;
	label: Message;
	description: Message;
}[] = [
	{
		scope: "space.view",
		label: m.app_scope_space_view,
		description: m.app_scope_space_view_hint,
	},
	{
		scope: "session.view",
		label: m.app_scope_session_view,
		description: m.app_scope_session_view_hint,
	},
	{
		scope: "file.view",
		label: m.app_scope_file_view,
		description: m.app_scope_file_view_hint,
	},
	{
		scope: "file.edit",
		label: m.app_scope_file_edit,
		description: m.app_scope_file_edit_hint,
	},
	{
		scope: "taskrun.view",
		label: m.app_scope_taskrun_view,
		description: m.app_scope_taskrun_view_hint,
	},
	{
		scope: "session.prompt.readonly",
		label: m.app_scope_session_prompt_readonly,
		description: m.app_scope_session_prompt_readonly_hint,
	},
	{
		scope: "session.prompt.fullaccess",
		label: m.app_scope_session_prompt_fullaccess,
		description: m.app_scope_session_prompt_fullaccess_hint,
	},
	{
		scope: "command.execute",
		label: m.app_scope_command_execute,
		description: m.app_scope_command_execute_hint,
	},
];

export const APP_SCOPE_GROUPS: {
	title: Message;
	scopes: Permission[];
}[] = [
	{
		title: m.app_scope_group_access,
		scopes: APP_SCOPE_OPTIONS.map((option) => option.scope),
	},
];

export function scopeState(
	scopes: Permission[],
	options: { scope: Permission }[],
) {
	const selected = new Set(scopes);
	return Object.fromEntries(
		options.map((option) => [option.scope, selected.has(option.scope)]),
	);
}

export function selectedScopeList(
	state: Record<string, boolean>,
	options: { scope: Permission }[],
) {
	return options.map((option) => option.scope).filter((scope) => state[scope]);
}

export function appStatusTone(status: AppRecord["status"]) {
	if (status === "published") return "text-status-running";
	if (status === "disabled") return "text-error-soft";
	return "text-text-tertiary";
}

export const APP_HIDE_COHUB_BAR_FEATURE = "work.publish.hide_cohub_bar";

export function hidesCohubBar(meta: AppMeta | null | undefined) {
	return asRecord(meta?.presentation)?.hideCohubBar === true;
}

export function withCohubBar(
	meta: AppMeta | null | undefined,
	hide: boolean,
): AppMeta | null {
	const next: AppMeta = { ...asRecord(meta) };
	const presentation: Record<string, unknown> = {
		...asRecord(next.presentation),
	};
	if (hide) presentation.hideCohubBar = true;
	else delete presentation.hideCohubBar;
	if (Object.keys(presentation).length) next.presentation = presentation;
	else delete next.presentation;
	return Object.keys(next).length ? next : null;
}

function timestamp(value: string | null | undefined) {
	const parsed = Date.parse(value ?? "");
	return Number.isFinite(parsed) ? parsed : 0;
}

export function isNewerAppSnapshot(
	current: AppRecord | null | undefined,
	next: AppRecord,
) {
	if (!current) return true;
	if (next.id !== current.id) return true;
	if (next.latestVersion !== current.latestVersion) {
		return next.latestVersion > current.latestVersion;
	}
	return timestamp(next.updatedAt) >= timestamp(current.updatedAt);
}

export function upsertAppVersion(
	versions: AppVersionRecord[],
	next: AppVersionRecord,
) {
	const byId = new Map(versions.map((version) => [version.id, version]));
	byId.set(next.id, next);
	return [...byId.values()].sort((a, b) => b.version - a.version);
}

export type AppVersionPublishedPayload = {
	app: AppRecord;
	version: AppVersionRecord;
	previousVersionId: string | null;
};

export function parseAppVersionPublished(
	event: ChannelEnvelope,
): AppVersionPublishedPayload | null {
	if (event.type !== "app.version.published" || !event.spaceId) return null;
	const app = asRecord(event.payload.app);
	const version = asRecord(event.payload.version);
	if (
		!app ||
		!version ||
		typeof app.id !== "string" ||
		app.spaceId !== event.spaceId ||
		typeof app.latestVersion !== "number" ||
		typeof version.id !== "string" ||
		version.appId !== app.id ||
		typeof version.version !== "number"
	) {
		return null;
	}
	return {
		app: app as AppRecord,
		version: version as AppVersionRecord,
		previousVersionId:
			typeof event.payload.previousVersionId === "string"
				? event.payload.previousVersionId
				: null,
	};
}

export type AppDomainChange = {
	spaceId: string;
	appId: string;
	domain?: AppDomainRecord;
	removedDomainId?: string;
};

export function parseAppDomainEvent(
	event: ChannelEnvelope,
): AppDomainChange | null {
	if (!event.spaceId) return null;
	const payload = asRecord(event.payload);
	if (event.type === "app.domain.updated") {
		const domain = asRecord(payload?.domain);
		if (
			!domain ||
			typeof domain.id !== "string" ||
			typeof domain.appId !== "string" ||
			domain.spaceId !== event.spaceId
		)
			return null;
		return {
			spaceId: event.spaceId,
			appId: domain.appId,
			domain: domain as AppDomainRecord,
		};
	}
	if (event.type === "app.domain.removed") {
		if (
			typeof payload?.appId !== "string" ||
			typeof payload.domainId !== "string"
		)
			return null;
		return {
			spaceId: event.spaceId,
			appId: payload.appId,
			removedDomainId: payload.domainId,
		};
	}
	return null;
}

export type AppDomainCache = {
	read: (
		spaceId: string,
		appId: string,
	) => Promise<AppDomainListResponse | null>;
	write: (
		spaceId: string,
		appId: string,
		list: AppDomainListResponse,
	) => unknown;
};
