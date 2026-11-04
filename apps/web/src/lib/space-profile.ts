import type { SpacePublicProfile, SpaceRecord } from "@neta-art/cohub";

const EMPTY_SPACE_PROFILE: SpacePublicProfile = { avatarUrl: null };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeSpacePublicProfile(
	profile: Partial<SpacePublicProfile> | null | undefined,
): SpacePublicProfile {
	const avatarUrl =
		typeof profile?.avatarUrl === "string" && profile.avatarUrl.trim()
			? profile.avatarUrl.trim()
			: null;
	const stickerUrl = profile?.likeSticker?.url;
	return {
		avatarUrl,
		likeSticker: typeof stickerUrl === "string" ? { url: stickerUrl } : null,
	};
}

export function getSpacePublicProfile(
	space: Pick<SpaceRecord, "meta"> & {
		publicProfile?: SpacePublicProfile | null;
	},
): SpacePublicProfile {
	if (space.publicProfile)
		return normalizeSpacePublicProfile(space.publicProfile);
	const meta = isRecord(space.meta) ? space.meta : {};
	const profile = isRecord(meta.publicProfile) ? meta.publicProfile : null;
	return normalizeSpacePublicProfile(profile);
}

export function getSpaceAvatarUrl(
	space: Pick<SpaceRecord, "meta"> & {
		publicProfile?: SpacePublicProfile | null;
	},
): string | null {
	return (
		getSpacePublicProfile(space).avatarUrl ?? EMPTY_SPACE_PROFILE.avatarUrl
	);
}
