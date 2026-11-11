import type { ParamMatcher } from "@sveltejs/kit";

export const match = ((param: string): param is "apps" | "scheduled" =>
	param === "apps" || param === "scheduled") satisfies ParamMatcher;
