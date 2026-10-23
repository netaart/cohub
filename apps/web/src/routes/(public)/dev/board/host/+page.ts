import { error } from "@sveltejs/kit";
import { dev } from "$app/environment";

export const ssr = false;
export const prerender = false;

export function load() {
	if (!dev) error(404, "Not found");
}
