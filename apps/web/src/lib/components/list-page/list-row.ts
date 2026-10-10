export type ListRowDensity = "comfortable" | "compact" | "dense";

export type FixedListRowDensity = Exclude<ListRowDensity, "dense">;

export const LIST_ROW_HEIGHT = {
	comfortable: 60,
	compact: 52,
} as const satisfies Record<FixedListRowDensity, number>;

export const LIST_ROW_AVATAR = {
	comfortable: "lg",
	compact: "md",
} as const satisfies Record<FixedListRowDensity, "lg" | "md">;
