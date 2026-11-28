import { defineParams } from "@sveltejs/kit/params";

export const params = defineParams({
	library: (param) =>
		param === "apps" || param === "scheduled" || param === "inbox"
			? param
			: undefined,
});
