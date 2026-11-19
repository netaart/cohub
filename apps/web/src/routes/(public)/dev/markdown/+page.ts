import { error } from "@sveltejs/kit";
import { dev } from "$app/env";
import { PUBLIC_COHUB_ENV } from "$app/env/public";

export const ssr = false;
export const prerender = false;

export function load() {
	if (!dev && PUBLIC_COHUB_ENV === "prod") error(404, "Not found");
}
