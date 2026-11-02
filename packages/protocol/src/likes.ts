export const LIKE_RESOURCE_TYPES = ["app"] as const;
export type LikeResourceType = (typeof LIKE_RESOURCE_TYPES)[number];

export const LIKED_LABEL_NAME = "Liked";
export const LIKED_LABEL_SYSTEM_KEY = "user:liked";

export function isLikeResourceType(value: unknown): value is LikeResourceType {
  return LIKE_RESOURCE_TYPES.includes(value as LikeResourceType);
}
