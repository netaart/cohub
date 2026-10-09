import { ossProcessUrl } from "@neta-art/cohub/media";

type AvatarImageSize = "xxs" | "xs" | "sm" | "md" | "lg" | "xl" | number;

const AVATAR_WIDTHS: Record<Exclude<AvatarImageSize, number>, number> = {
	xxs: 48,
	xs: 64,
	sm: 96,
	md: 128,
	lg: 192,
	xl: 320,
};

function widthForSize(size: AvatarImageSize) {
	return typeof size === "number" ? size : AVATAR_WIDTHS[size];
}

export function avatarImageUrl(
	src: string | null | undefined,
	size: AvatarImageSize = "md",
) {
	const value = src?.trim();
	if (!value) return "";
	const width = widthForSize(size);
	const quality = width >= 256 ? 84 : 82;
	// Avatars always live on OSS, so no host capability check applies.
	return ossProcessUrl(
		value,
		`image/resize,w_${width}/quality,q_${quality}/format,webp`,
	);
}
