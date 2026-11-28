import type { RequestHandler } from "@sveltejs/kit";
import { androidApp } from "#lib/server/android-app.ts";
import { PUBLIC_COHUB_ENV } from "$app/env/public";

const app = androidApp(PUBLIC_COHUB_ENV);

const statements = app
	? [
			{
				relation: [
					"delegate_permission/common.handle_all_urls",
					"delegate_permission/common.get_login_creds",
				],
				target: {
					namespace: "android_app",
					package_name: app.packageName,
					sha256_cert_fingerprints: app.fingerprints,
				},
			},
		]
	: [];

export const GET: RequestHandler = () =>
	Response.json(statements, {
		headers: { "cache-control": "no-store" },
	});
