import {
	browserOnlyPatterns,
	NATIVE_APPS,
	nativeDeployment,
} from "@cohub/protocol/native-apps";
import type { RequestHandler } from "@sveltejs/kit";
import { PUBLIC_COHUB_ENV } from "$app/env/public";

const bundleId = nativeDeployment(PUBLIC_COHUB_ENV)?.ios.bundleId;
const apps = bundleId ? [`${NATIVE_APPS.appleTeamId}.${bundleId}`] : [];

const association = {
	applinks: {
		details: apps.map((appID) => ({
			appIDs: [appID],
			components: [
				...browserOnlyPatterns().map((path) => ({ "/": path, exclude: true })),
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
