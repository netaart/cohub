import { buildUserMentionMarkdown } from "@cohub/protocol";
import type { SpaceMember } from "@neta-art/cohub";
import type { SpaceMentionSuggestion } from "./space.ts";

export type UserMentionSuggestion = {
	type: "user";
	id: string;
	userUuid: string;
	name: string;
	username: string | null;
	avatarUrl: string | null;
};

export type MentionSuggestion = SpaceMentionSuggestion | UserMentionSuggestion;

const MAX_PEOPLE = 5;

export function matchMemberMentions(
	members: readonly SpaceMember[],
	query: string,
	viewerUserUuid: string | null,
): UserMentionSuggestion[] {
	const q = query.trim().toLowerCase();
	return members
		.filter((member) => member.userId !== viewerUserUuid)
		.map((member) => {
			const name =
				member.profile.displayName || member.profile.username || member.userId;
			const username = member.profile.username ?? null;
			const haystacks = [name.toLowerCase(), username?.toLowerCase() ?? ""];
			const rank = !q
				? 1
				: haystacks.some((text) => text.startsWith(q))
					? 0
					: haystacks.some((text) => text.includes(q))
						? 1
						: -1;
			return {
				rank,
				item: {
					type: "user" as const,
					id: `user:${member.userId}`,
					userUuid: member.userId,
					name,
					username,
					avatarUrl: member.profile.avatarUrl ?? null,
				},
			};
		})
		.filter(({ rank }) => rank >= 0)
		.sort((a, b) => a.rank - b.rank || a.item.name.localeCompare(b.item.name))
		.slice(0, MAX_PEOPLE)
		.map(({ item }) => item);
}

export const buildUserMentionSnippet = (item: UserMentionSuggestion) =>
	`${buildUserMentionMarkdown({ userUuid: item.userUuid, label: item.name })} `;
