import type {
	GlobalSearchViewerRelation,
	SpacePublicProfile,
	UserProfile,
} from "@neta-art/cohub";
import { COHUB_WEB_ORIGIN_SOURCE } from "./platform-origin";

export type SpaceMention = {
	type: "space";
	spaceId: string;
	sessionId?: string;
	label: string;
	uri: string;
	href: string;
};

export type SpaceMentionSuggestion = {
	type: "space";
	id: string;
	spaceId: string;
	name: string;
	description: string | null;
	ownerProfile: Pick<
		UserProfile,
		"userUuid" | "displayName" | "avatarUrl"
	> | null;
	spaceProfile: SpacePublicProfile;
	href: string;
	uri: string;
	activityAt: string | null;
	source: "local" | "remote" | "local+remote";
	score: number;
	textScore: number;
	recencyScore: number;
	typePriorityScore: number;
	viewerRelation?: GlobalSearchViewerRelation | "unknown" | null;
	viewerTier?: number;
};

export type SpaceMentionTextToken =
	| { type: "text"; text: string }
	| {
			type: "spaceMention";
			label: string;
			spaceId: string;
			sessionId?: string;
			raw: string;
			uri: string;
			href: string;
	  };

export type ParsedCohubSpaceLink = {
	raw: string;
	spaceId: string;
	sessionId?: string;
};

const SPACE_URI_PREFIX = "cohub://spaces/";
const SPACE_MENTION_PATTERN =
	/@\[([^\]\n]+)\]\(cohub:\/\/spaces\/([^/\s)]+)(?:\/sessions\/([^/\s)]+))?\)/g;
const VALID_SPACE_MENTION_PREFIX_PATTERN = /[\s([{<:,;!?，。！？、；：]/;
const ID_PATTERN =
	"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const RESOURCE_PATH_END_PATTERN = "(?![a-zA-Z0-9_%/-]|\\.[a-zA-Z0-9])";
const COHUB_SPACE_LINK_PATTERN = new RegExp(
	`${COHUB_WEB_ORIGIN_SOURCE}\\/spaces\\/(${ID_PATTERN})(?:\\/sessions\\/(${ID_PATTERN}))?(?:[?#][^\\s)\\]]*)?${RESOURCE_PATH_END_PATTERN}|(^|[\\s([{<:,;!?，。！？、；：])\\/spaces\\/(${ID_PATTERN})(?:\\/sessions\\/(${ID_PATTERN}))?(?:[?#][^\\s)\\]]*)?${RESOURCE_PATH_END_PATTERN}`,
	"g",
);

function isSpaceMentionBoundary(text: string, index: number) {
	if (index <= 0) return true;
	return VALID_SPACE_MENTION_PREFIX_PATTERN.test(text[index - 1] ?? "");
}

function safeDecode(value: string) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function escapeMentionLabel(label: string) {
	return label
		.replace(/[[\]\\]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function buildSpaceMentionUri(spaceId: string, sessionId?: string) {
	const base = `${SPACE_URI_PREFIX}${encodeURIComponent(spaceId)}`;
	return sessionId ? `${base}/sessions/${encodeURIComponent(sessionId)}` : base;
}

export function buildSpaceMentionHref(spaceId: string, sessionId?: string) {
	const base = `/spaces/${encodeURIComponent(spaceId)}`;
	return sessionId ? `${base}/sessions/${encodeURIComponent(sessionId)}` : base;
}

export function buildSpaceMentionMarkdown(input: {
	spaceId: string;
	label: string;
	sessionId?: string;
}) {
	const label =
		escapeMentionLabel(input.label) || `space:${input.spaceId.slice(0, 8)}`;
	return `@[${label}](${buildSpaceMentionUri(input.spaceId, input.sessionId)})`;
}

export function parseSpaceMentionUri(
	uri: string,
): { spaceId: string; sessionId?: string } | null {
	if (!uri.startsWith(SPACE_URI_PREFIX)) return null;
	const path = uri.slice(SPACE_URI_PREFIX.length).split("/");
	const spaceId = safeDecode(path[0] ?? "").trim();
	if (!spaceId) return null;
	if (path.length === 1) return { spaceId };
	if (path.length !== 3 || path[1] !== "sessions") return null;
	const sessionId = safeDecode(path[2] ?? "").trim();
	return sessionId ? { spaceId, sessionId } : null;
}

export function extractSpaceMentionsFromText(text: string): SpaceMention[] {
	const mentions: SpaceMention[] = [];
	const seen = new Set<string>();
	for (const token of tokenizeSpaceMentionText(text)) {
		if (token.type !== "spaceMention") continue;
		const key = token.sessionId
			? `${token.spaceId}/sessions/${token.sessionId}`
			: token.spaceId;
		if (seen.has(key)) continue;
		seen.add(key);
		mentions.push({
			type: "space",
			spaceId: token.spaceId,
			...(token.sessionId ? { sessionId: token.sessionId } : {}),
			label: token.label,
			uri: token.uri,
			href: token.href,
		});
	}
	return mentions;
}

export function tokenizeSpaceMentionText(
	text: string,
): SpaceMentionTextToken[] {
	if (!text) return [];
	const tokens: SpaceMentionTextToken[] = [];
	let cursor = 0;
	for (const match of text.matchAll(SPACE_MENTION_PATTERN)) {
		const raw = match[0] ?? "";
		const index = match.index ?? 0;
		if (!isSpaceMentionBoundary(text, index)) continue;
		if (index > cursor) {
			tokens.push({ type: "text", text: text.slice(cursor, index) });
		}

		const label = match[1]?.trim();
		const spaceId = safeDecode(match[2] ?? "").trim();
		const sessionId = safeDecode(match[3] ?? "").trim() || undefined;
		if (!raw || !label || !spaceId) {
			tokens.push({ type: "text", text: raw });
		} else {
			const token: SpaceMentionTextToken = {
				type: "spaceMention",
				label,
				spaceId,
				raw,
				uri: buildSpaceMentionUri(spaceId, sessionId),
				href: buildSpaceMentionHref(spaceId, sessionId),
			};
			if (sessionId && token.type === "spaceMention")
				token.sessionId = sessionId;
			tokens.push(token);
		}
		cursor = index + raw.length;
	}

	if (cursor < text.length) {
		tokens.push({ type: "text", text: text.slice(cursor) });
	}
	return tokens;
}

export function formatSpaceMentionTextForDisplay(text: string): string {
	return tokenizeSpaceMentionText(text)
		.map((token) => {
			if (token.type === "spaceMention") return `@${token.label}`;
			return token.text;
		})
		.join("");
}

export function getCohubSpaceLinkKey(link: {
	spaceId: string;
	sessionId?: string;
}) {
	return link.sessionId
		? `${link.spaceId}/sessions/${link.sessionId}`
		: link.spaceId;
}

export function parseCohubSpaceUrls(
	value: string,
	maxMatches = 20,
): ParsedCohubSpaceLink[] {
	const matches: ParsedCohubSpaceLink[] = [];
	for (const match of value.matchAll(COHUB_SPACE_LINK_PATTERN)) {
		const raw = match[0] ?? "";
		const absoluteSpaceId = match[1]?.trim();
		const absoluteSessionId = match[2]?.trim();
		const relativePrefix = match[3] ?? "";
		const relativeSpaceId = match[4]?.trim();
		const relativeSessionId = match[5]?.trim();
		const spaceId = absoluteSpaceId ?? relativeSpaceId;
		const sessionId = absoluteSessionId ?? relativeSessionId;
		if (!raw || !spaceId) continue;
		matches.push({
			raw: raw.slice(relativePrefix.length),
			spaceId,
			sessionId: sessionId || undefined,
		});
		if (matches.length >= maxMatches) break;
	}
	return matches;
}

export function replaceCohubSpaceUrls(
	value: string,
	resolveLabel: (link: ParsedCohubSpaceLink) => string | null | undefined,
) {
	return value.replace(
		COHUB_SPACE_LINK_PATTERN,
		(
			match,
			absoluteSpaceId: string,
			absoluteSessionId: string,
			relativePrefix: string,
			relativeSpaceId: string,
			relativeSessionId: string,
		) => {
			const spaceId = absoluteSpaceId?.trim() || relativeSpaceId?.trim();
			const sessionId = absoluteSessionId?.trim() || relativeSessionId?.trim();
			if (!spaceId) return match;
			const link: ParsedCohubSpaceLink = {
				raw: match.slice((relativePrefix ?? "").length),
				spaceId,
				sessionId: sessionId || undefined,
			};
			const label = resolveLabel(link);
			if (!label) return match;
			return `${relativePrefix ?? ""}${buildSpaceMentionMarkdown({
				spaceId,
				sessionId: sessionId || undefined,
				label,
			})}`;
		},
	);
}
