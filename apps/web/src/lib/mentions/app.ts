import { parseSpaceSlug, parseUsername } from "@cohub/protocol";
import { buildPublicAppRoute } from "$lib/space-routes";
import { COHUB_WEB_ORIGIN_SOURCE } from "./platform-origin";

export type AppMention = {
	type: "app";
	username: string;
	spaceSlug: string;
	appSlug: string;
	label: string;
	uri: string;
	href: string;
};

export type ParsedCohubAppLink = {
	raw: string;
	username: string;
	spaceSlug: string;
	appSlug: string;
	launchSuffix: string;
};

const APP_URI_PREFIX = "cohub://apps/";
const RESOURCE_PATH_END_PATTERN = "(?![a-z0-9_%/-]|\\.[a-z0-9])";
const COHUB_APP_LINK_PATTERN = new RegExp(
	`${COHUB_WEB_ORIGIN_SOURCE}\\/([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)\\/([a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?)\\/w\\/([a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?)((?:[?#][^\\s)\\]]*)?)${RESOURCE_PATH_END_PATTERN}|(^|[\\s([{<:,;!?，。！？、；：])\\/([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)\\/([a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?)\\/w\\/([a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?)((?:[?#][^\\s)\\]]*)?)${RESOURCE_PATH_END_PATTERN}`,
	"gi",
);

function safeDecode(value: string) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function parseAppIdentity(
	usernameValue: string,
	spaceSlugValue: string,
	appSlugValue: string,
) {
	const username = parseUsername(safeDecode(usernameValue));
	const spaceSlug = parseSpaceSlug(safeDecode(spaceSlugValue));
	const appSlug = parseSpaceSlug(safeDecode(appSlugValue));
	return username && spaceSlug && appSlug
		? { username, spaceSlug, appSlug }
		: null;
}

function escapeMentionLabel(label: string) {
	return label
		.replace(/[[\]\\]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function buildAppMentionUri(input: {
	username: string;
	spaceSlug: string;
	appSlug: string;
	launchSuffix?: string;
}) {
	return `${APP_URI_PREFIX}${encodeURIComponent(input.username)}/${encodeURIComponent(input.spaceSlug)}/${encodeURIComponent(input.appSlug)}${input.launchSuffix ?? ""}`;
}

export function buildAppMentionHref(input: {
	username: string;
	spaceSlug: string;
	appSlug: string;
	launchSuffix?: string;
}) {
	return `${buildPublicAppRoute(input)}${input.launchSuffix ?? ""}`;
}

export function buildAppMentionMarkdown(input: {
	username: string;
	spaceSlug: string;
	appSlug: string;
	label: string;
	launchSuffix?: string;
}) {
	const label = escapeMentionLabel(input.label) || input.appSlug;
	return `@[${label}](${buildAppMentionUri(input)})`;
}

export function parseAppMentionUri(uri: string) {
	if (!uri.startsWith(APP_URI_PREFIX)) return null;
	const value = uri.slice(APP_URI_PREFIX.length);
	const suffixIndex = value.search(/[?#]/);
	const path = (suffixIndex >= 0 ? value.slice(0, suffixIndex) : value).split(
		"/",
	);
	if (path.length !== 3) return null;
	const identity = parseAppIdentity(
		path[0] ?? "",
		path[1] ?? "",
		path[2] ?? "",
	);
	if (!identity) return null;
	return {
		...identity,
		launchSuffix: suffixIndex >= 0 ? value.slice(suffixIndex) : "",
	};
}

export function getCohubAppLinkKey(
	link: Pick<ParsedCohubAppLink, "username" | "spaceSlug" | "appSlug">,
) {
	return `${link.username}/${link.spaceSlug}/${link.appSlug}`;
}

export function parseCohubAppUrls(value: string, maxMatches = 20) {
	const matches: ParsedCohubAppLink[] = [];
	for (const match of value.matchAll(COHUB_APP_LINK_PATTERN)) {
		const raw = match[0] ?? "";
		const relativePrefix = match[5] ?? "";
		const identity = parseAppIdentity(
			match[1] ?? match[6] ?? "",
			match[2] ?? match[7] ?? "",
			match[3] ?? match[8] ?? "",
		);
		const launchSuffix = match[4] ?? match[9] ?? "";
		if (!raw || !identity) continue;
		matches.push({
			raw: raw.slice(relativePrefix.length),
			...identity,
			launchSuffix,
		});
		if (matches.length >= maxMatches) break;
	}
	return matches;
}

export function replaceCohubAppUrls(
	value: string,
	resolveLabel: (link: ParsedCohubAppLink) => string | null | undefined,
) {
	return value.replace(
		COHUB_APP_LINK_PATTERN,
		(
			match,
			absoluteUsername: string,
			absoluteSpaceSlug: string,
			absoluteAppSlug: string,
			absoluteSuffix: string,
			relativePrefix: string,
			relativeUsername: string,
			relativeSpaceSlug: string,
			relativeAppSlug: string,
			relativeSuffix: string,
		) => {
			const identity = parseAppIdentity(
				absoluteUsername || relativeUsername,
				absoluteSpaceSlug || relativeSpaceSlug,
				absoluteAppSlug || relativeAppSlug,
			);
			const launchSuffix = absoluteSuffix || relativeSuffix || "";
			if (!identity) return match;
			const link = {
				raw: match.slice((relativePrefix ?? "").length),
				...identity,
				launchSuffix,
			};
			const label = resolveLabel(link);
			if (!label) return match;
			return `${relativePrefix ?? ""}${buildAppMentionMarkdown({ ...link, label })}`;
		},
	);
}
