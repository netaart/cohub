import type {
	UserSessionSourceKey,
	UserSessionSpaceSummary,
} from "@neta-art/cohub";
import type { Locale } from "$lib/i18n/locale";
import { m } from "$lib/paraglide/messages.js";

export type ChatsFilter = {
	source: UserSessionSourceKey | null;
	space: UserSessionSpaceSummary | null;
};

export const DEFAULT_CHATS_FILTER: ChatsFilter = { source: "web", space: null };

export const CHATS_SOURCE_GROUPS = [
	{ id: "clients", sources: ["web", "cli", "websocket"] },
	{ id: "channels", sources: ["feishu", "wechat", "discord", "qq"] },
	{
		id: "automations",
		sources: ["scheduled_task", "space_hook", "public_api"],
	},
	{ id: "other", sources: ["other"] },
] as const satisfies readonly {
	id: string;
	sources: readonly UserSessionSourceKey[];
}[];

export type ChatsSourceGroup = (typeof CHATS_SOURCE_GROUPS)[number]["id"];

const SOURCE_KEYS = new Set<string>(
	CHATS_SOURCE_GROUPS.flatMap((group) => group.sources),
);

export const CHATS_SOURCE_NAMES: Record<
	Exclude<UserSessionSourceKey, "other">,
	string
> = {
	web: "Web App",
	cli: "CLI",
	websocket: "Websocket",
	feishu: "Feishu",
	wechat: "WeChat",
	discord: "Discord",
	qq: "QQ",
	scheduled_task: "Scheduled Task",
	space_hook: "Hook",
	public_api: "Public API",
};

export function isChatsSourceKey(
	value: unknown,
): value is UserSessionSourceKey {
	return typeof value === "string" && SOURCE_KEYS.has(value);
}

export function chatsSourceName(
	source: UserSessionSourceKey | null,
	locale: Locale,
): string {
	if (!source) return m.chats_source_all({}, { locale });
	if (source === "other") return m.chats_source_other({}, { locale });
	return CHATS_SOURCE_NAMES[source];
}

/** Mirrors the server's `resolveSessionSourceKey`. */
export function resolveSessionSourceKey(
	source: string | null | undefined,
): UserSessionSourceKey {
	const raw =
		source
			?.trim()
			.toLowerCase()
			.replace(/[\s-]+/g, "_") || "web";
	if (raw === "web_app") return "web";
	if (isChatsSourceKey(raw)) return raw;
	const channel = raw.match(/^channel[:_](.+)$/)?.[1] ?? raw.split(":")[0];
	return channel && channel !== raw && isChatsSourceKey(channel)
		? channel
		: "other";
}

export function chatsFilterScope(filter: ChatsFilter): string {
	const source = filter.source ?? "all";
	return filter.space ? `space:${filter.space.id}:${source}` : source;
}

export function sameChatsFilter(a: ChatsFilter, b: ChatsFilter) {
	return (
		a.source === b.source && (a.space?.id ?? null) === (b.space?.id ?? null)
	);
}

export function parseChatsFilter(raw: string | null): ChatsFilter {
	if (!raw) return DEFAULT_CHATS_FILTER;
	try {
		const value = JSON.parse(raw) as {
			source?: unknown;
			space?: {
				id?: unknown;
				name?: unknown;
				slug?: unknown;
				publicProfile?: unknown;
			} | null;
		};
		const source =
			value.source === null
				? null
				: isChatsSourceKey(value.source)
					? value.source
					: DEFAULT_CHATS_FILTER.source;
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
		return { source, space };
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
		localStorage.setItem(storageKey(userKey), JSON.stringify(filter));
	} catch {}
}
