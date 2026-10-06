export type ListRowDensity = "comfortable" | "compact";

export const LIST_ROW_HEIGHT = {
	comfortable: 64,
	compact: 52,
} as const satisfies Record<ListRowDensity, number>;

export const LIST_ROW_AVATAR = {
	comfortable: "lg",
	compact: "md",
} as const satisfies Record<ListRowDensity, "lg" | "md">;
