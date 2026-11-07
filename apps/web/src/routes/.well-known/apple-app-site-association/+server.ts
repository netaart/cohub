import type { RequestHandler } from "@sveltejs/kit";
import { PUBLIC_COHUB_ENV } from "$env/static/public";

const APPLE_TEAM_ID = "";

const IOS_BUNDLE_IDS: Record<string, string> = {
	dev: "live.cohub.ios.dev",
	prod: "live.cohub.ios",
};

const env = PUBLIC_COHUB_ENV?.trim().toLowerCase() ?? "";
const bundleId = IOS_BUNDLE_IDS[env];
const apps = APPLE_TEAM_ID && bundleId ? [`${APPLE_TEAM_ID}.${bundleId}`] : [];

const association = {
	applinks: {
		details: apps.map((appID) => ({
			appIDs: [appID],
			components: [
				{ "/": "/callback*", exclude: true },
				{ "/": "/app-auth*", exclude: true },
				{ "/": "/mobile/*", exclude: true },
				{ "/": "/*" },
			],
		})),
	},
	webcredentials: { apps },
};

export const GET: RequestHandler = () =>
	Response.json(association, {
		headers: { "cache-control": "public, max-age=3600" },
	});
