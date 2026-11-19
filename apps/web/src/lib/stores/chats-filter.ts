import {
	APP_SESSION_SOURCES,
	getSessionInitiatorLabelSystemKey,
	getSessionSourceLabelSystemKey,
	isSessionInitiator,
	isSessionSourceKey,
	readSessionInitiator,
	resolveSessionSourceKey,
	SESSION_SOURCE_NAMES,
	type SessionInitiator,
	type SessionSourceKey,
} from "@cohub/protocol/model";
import type { SessionRecord, UserSessionSpaceSummary } from "@neta-art/cohub";
import type { Locale } from "#lib/i18n/locale.ts";
import type { LiveFit } from "#lib/lists/live-list-core.ts";
import { m } from "#lib/paraglide/messages.js";

export type ChatsKind = SessionInitiator | SessionSourceKey;

export type ChatsFilter = {
	kind: ChatsKind | null;
	space: UserSessionSpaceSummary | null;
	archived: boolean;
};

export const DEFAULT_CHATS_FILTER: ChatsFilter = {
	kind: "human",
	space: null,
	archived: false,
};

export const CHATS_KIND_GROUPS = [
	{ id: "initiators", kinds: ["human", "agent", "automation"] },
	{ id: "clients", kinds: ["web", "desktop", "mobile", "cli", "websocket"] },
	{ id: "channels", kinds: ["feishu", "wechat", "discord", "qq"] },
	{ id: "automations", kinds: ["scheduled_task", "space_hook", "public_api"] },
	{ id: "other", kinds: ["other"] },
] as const satisfies readonly { id: string; kinds: readonly ChatsKind[] }[];

export type ChatsKindGroup = (typeof CHATS_KIND_GROUPS)[number]["id"];

export function isChatsKind(value: unknown): value is ChatsKind {
	return isSessionInitiator(value) || isSessionSourceKey(value);
}

export function sessionInitiatorName(
	initiator: SessionInitiator,
	locale?: Locale,
): string {
	switch (initiator) {
		case "human":
			return m.session_initiator_human({}, { locale });
		case "agent":
			return m.session_initiator_agent({}, { locale });
		case "automation":
			return m.session_initiator_automation({}, { locale });
	}
}

export function chatsKindName(kind: ChatsKind | null, locale?: Locale): string {
	if (!kind) return m.chats_kind_all({}, { locale });
	if (isSessionInitiator(kind)) return sessionInitiatorName(kind, locale);
	if (kind === "other") return m.chats_kind_other({}, { locale });
	return SESSION_SOURCE_NAMES[kind];
}

export function chatsKindSystemKey(kind: ChatsKind): string {
	return isSessionInitiator(kind)
		? getSessionInitiatorLabelSystemKey(kind)
		: getSessionSourceLabelSystemKey(kind);
}

export function sessionAttributionName(
	session: Pick<SessionRecord, "source"> &
		Partial<Pick<SessionRecord, "meta" | "initiator">>,
	locale: Locale,
): string | null {
	if (readSessionInitiator(session) === "agent")
		return sessionInitiatorName("agent", locale);
	const source = resolveSessionSourceKey(session.source);
	return APP_SESSION_SOURCES.has(source) ? null : chatsKindName(source, locale);
}

export function showsAttribution(kind: ChatsKind | null): boolean {
	return kind === null || kind === "human" || kind === "automation";
}

export function chatsFilterScope(filter: ChatsFilter): string {
	const kind = filter.archived ? "archived" : (filter.kind ?? "all");
	return filter.space ? `space:${filter.space.id}:${kind}` : kind;
}

export type SessionEventRecord = Partial<SessionRecord> & {
	id: string;
	spaceId: string;
};

function matchesKind(session: SessionEventRecord, kind: ChatsKind) {
	return isSessionInitiator(kind)
		? readSessionInitiator(session) === kind
		: resolveSessionSourceKey(session.source) === kind;
}

export function sessionFit(
	session: SessionEventRecord,
	filter: ChatsFilter,
	viewer: string | null,
): LiveFit {
	if (filter.space && session.spaceId !== filter.space.id) return "out";
	if (session.archivedAt === undefined) {
		if (filter.archived) return "keep";
	} else if (Boolean(session.archivedAt) !== filter.archived) return "out";
	if (!filter.space) {
		const participants = session.participantUserUuids;
		const listed =
			Boolean(viewer) &&
			(session.userUuid === viewer ||
				Boolean(viewer && participants?.includes(viewer)));
		if (!listed) return participants ? "out" : "keep";
	}
	if (!filter.kind || filter.archived) return "in";
	return matchesKind(session, filter.kind) ? "in" : "keep";
}

export function sameChatsFilter(a: ChatsFilter, b: ChatsFilter) {
	return chatsFilterScope(a) === chatsFilterScope(b) && a.kind === b.kind;
}

function readKind(value: {
	kind?: unknown;
	source?: unknown;
}): ChatsKind | null {
	if ("kind" in value) {
		if (value.kind === null) return null;
		return isChatsKind(value.kind) ? value.kind : DEFAULT_CHATS_FILTER.kind;
	}
	if (value.source === null) return null;
	if (value.source === "web") return "human";
	return isSessionSourceKey(value.source)
		? value.source
		: DEFAULT_CHATS_FILTER.kind;
}

export function parseChatsFilter(raw: string | null): ChatsFilter {
	if (!raw) return DEFAULT_CHATS_FILTER;
	try {
		const value = JSON.parse(raw) as {
			kind?: unknown;
			source?: unknown;
			space?: {
				id?: unknown;
				name?: unknown;
				slug?: unknown;
				publicProfile?: unknown;
			} | null;
		};
		const space =
			value.space && typeof value.space.id === "string" && value.space.id
				? {
						id: value.space.id,
						name: typeof value.space.name === "string" ? value.space.name : "",
						slug:
							typeof value.space.slug === "string" ? value.space.slug : null,
						publicProfile:
							value.space.publicProfile &&
							typeof value.space.publicProfile === "object"
								? (value.space
										.publicProfile as UserSessionSpaceSummary["publicProfile"])
								: null,
					}
				: null;
		return { kind: readKind(value), space, archived: false };
	} catch {
		return DEFAULT_CHATS_FILTER;
	}
}

const STORAGE_PREFIX = "cohub:chats-filter";
const STORAGE_VERSION = "v1";

function storageKey(userKey: string) {
	return `${STORAGE_PREFIX}:${encodeURIComponent(userKey)}:${STORAGE_VERSION}`;
}

export function readChatsFilter(userKey: string): ChatsFilter {
	if (typeof localStorage === "undefined") return DEFAULT_CHATS_FILTER;
	try {
		return parseChatsFilter(localStorage.getItem(storageKey(userKey)));
	} catch {
		return DEFAULT_CHATS_FILTER;
	}
}

export function writeChatsFilter(userKey: string, filter: ChatsFilter) {
	if (typeof localStorage === "undefined") return;
	try {
		const { archived: _archived, ...persisted } = filter;
		localStorage.setItem(storageKey(userKey), JSON.stringify(persisted));
	} catch {}
}
