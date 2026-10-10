import type { SessionRecord, SpaceRecord } from "@neta-art/cohub";
import { sdk } from "$lib/sdk";
import { getCachedSessionListSnapshot } from "$lib/stores/session-list-cache";
import { sessionStore } from "$lib/stores/session-store";
import type { ParsedCohubSpaceLink } from "./space";

const LINK_RESOLVE_LIMIT = 20;
const SESSION_LABEL_LIMIT = 72;

function compactText(
	value: string | null | undefined,
	fallback: string,
	limit = 48,
) {
	const text = (value ?? "").replace(/\s+/g, " ").trim() || fallback;
	return text.length > limit
		? `${text.slice(0, Math.max(0, limit - 1))}…`
		: text;
}

function buildSessionMentionLabel(input: {
	space: SpaceRecord;
	session: SessionRecord;
}) {
	const spaceLabel = compactText(
		input.space.name ?? input.space.title,
		`space:${input.space.id.slice(0, 8)}`,
		32,
	);
	const sessionLabel = compactText(
		input.session.title,
		`session:${input.session.id.slice(0, 8)}`,
		48,
	);
	const label = `${spaceLabel}/${sessionLabel}`;
	return label.length > SESSION_LABEL_LIMIT
		? `${label.slice(0, SESSION_LABEL_LIMIT - 1)}…`
		: label;
}

function linkKey(link: Pick<ParsedCohubSpaceLink, "spaceId" | "sessionId">) {
	return link.sessionId
		? `${link.spaceId}/sessions/${link.sessionId}`
		: link.spaceId;
}

function hasSessionView(space: SpaceRecord) {
	return Boolean(space.access?.permissions?.includes("session.view"));
}

async function getCachedSession(spaceId: string, sessionId: string) {
	const known = sessionStore.get(sessionId);
	if (known) return known;
	const snapshot = await getCachedSessionListSnapshot(spaceId).catch(
		() => null,
	);
	return snapshot?.sessions.find((session) => session.id === sessionId) ?? null;
}

export async function resolveCohubLinkMentionLabels(
	links: ParsedCohubSpaceLink[],
	options?: { signal?: AbortSignal; limit?: number },
): Promise<Map<string, string>> {
	const unique = [
		...new Map(links.map((link) => [linkKey(link), link])).values(),
	]
		.filter((link) => link.spaceId)
		.slice(0, options?.limit ?? LINK_RESOLVE_LIMIT);
	const resolved = new Map<string, string>();
	const spaces = new Map<string, SpaceRecord>();

	await Promise.all(
		unique.map(async (link) => {
			try {
				let space = spaces.get(link.spaceId);
				if (!space) {
					space = await sdk
						.space(link.spaceId)
						.get((input, init) =>
							fetch(input, { ...init, signal: options?.signal }),
						);
					spaces.set(link.spaceId, space);
				}

				if (!link.sessionId) {
					const name = space.name ?? space.title;
					if (name) resolved.set(linkKey(link), name);
					return;
				}

				if (!hasSessionView(space)) return;
				const cached = await getCachedSession(link.spaceId, link.sessionId);
				const session =
					cached ??
					sessionStore.merge(
						(
							await sdk
								.space(link.spaceId)
								.session(link.sessionId)
								.get((input, init) =>
									fetch(input, { ...init, signal: options?.signal }),
								)
						).session,
					);
				resolved.set(
					linkKey(link),
					buildSessionMentionLabel({ space, session }),
				);
			} catch (error) {
				if ((error as { name?: string })?.name === "AbortError") return;
				// Keep unresolved links as plain text. This intentionally covers missing
				// permissions, deleted sessions, and transient network errors.
			}
		}),
	);

	return resolved;
}

export { linkKey as getCohubLinkMentionKey };
