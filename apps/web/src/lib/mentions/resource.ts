import {
	buildAppMentionHref,
	buildAppMentionUri,
	type ParsedCohubAppLink,
	parseAppMentionUri,
	replaceCohubAppUrls,
} from "./app.ts";
import {
	buildSpaceMentionHref,
	buildSpaceMentionUri,
	type ParsedCohubSpaceLink,
	parseSpaceMentionUri,
	replaceCohubSpaceUrls,
} from "./space.ts";

export type ResourceMentionTextToken =
	| { type: "text"; text: string }
	| {
			type: "spaceMention";
			label: string;
			spaceId: string;
			sessionId?: string;
			raw: string;
			uri: string;
			href: string;
	  }
	| {
			type: "appMention";
			label: string;
			username: string;
			spaceSlug: string;
			appSlug: string;
			launchSuffix: string;
			raw: string;
			uri: string;
			href: string;
	  };

const RESOURCE_MENTION_PATTERN =
	/@\[([^\]\n]+)\]\((cohub:\/\/(?:spaces|apps)\/[^\s)]+)\)/g;
const VALID_MENTION_PREFIX_PATTERN = /[\s([{<:,;!?，。！？、；：]/;

function isMentionBoundary(text: string, index: number) {
	return index <= 0 || VALID_MENTION_PREFIX_PATTERN.test(text[index - 1] ?? "");
}

export function tokenizeResourceMentionText(
	text: string,
): ResourceMentionTextToken[] {
	if (!text) return [];
	const tokens: ResourceMentionTextToken[] = [];
	let cursor = 0;
	for (const match of text.matchAll(RESOURCE_MENTION_PATTERN)) {
		const raw = match[0] ?? "";
		const index = match.index ?? 0;
		if (!isMentionBoundary(text, index)) continue;
		if (index > cursor)
			tokens.push({ type: "text", text: text.slice(cursor, index) });

		const label = match[1]?.trim() ?? "";
		const uri = match[2] ?? "";
		const space = parseSpaceMentionUri(uri);
		const app = parseAppMentionUri(uri);
		if (!raw || !label || (!space && !app)) {
			tokens.push({ type: "text", text: raw });
		} else if (space) {
			tokens.push({
				type: "spaceMention",
				label,
				spaceId: space.spaceId,
				...(space.sessionId ? { sessionId: space.sessionId } : {}),
				raw,
				uri: buildSpaceMentionUri(space.spaceId, space.sessionId),
				href: buildSpaceMentionHref(space.spaceId, space.sessionId),
			});
		} else if (app) {
			tokens.push({
				type: "appMention",
				label,
				...app,
				raw,
				uri: buildAppMentionUri(app),
				href: buildAppMentionHref(app),
			});
		}
		cursor = index + raw.length;
	}
	if (cursor < text.length)
		tokens.push({ type: "text", text: text.slice(cursor) });
	return tokens;
}

export function formatResourceMentionTextForDisplay(text: string) {
	return tokenizeResourceMentionText(text)
		.map((token) => (token.type === "text" ? token.text : `@${token.label}`))
		.join("");
}

export function replaceCohubResourceUrls(
	text: string,
	resolve: {
		space: (link: ParsedCohubSpaceLink) => string | null | undefined;
		app: (link: ParsedCohubAppLink) => string | null | undefined;
	},
) {
	return replaceCohubAppUrls(
		replaceCohubSpaceUrls(text, resolve.space),
		resolve.app,
	);
}
