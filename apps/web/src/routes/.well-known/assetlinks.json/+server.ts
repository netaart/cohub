import type { RequestHandler } from "@sveltejs/kit";
import { PUBLIC_COHUB_ENV } from "$env/static/public";

const ANDROID_APPS: Record<
	string,
	{ packageName: string; fingerprints: string[] }[]
> = {
	dev: [
		{
			packageName: "live.cohub.android.dev",
			fingerprints: [
				"64:34:C1:D0:3E:EC:B9:06:D5:16:E8:A1:54:7D:AF:69:38:BB:CA:C9:77:F2:C5:B4:F3:0E:7A:33:BB:25:B1:EA",
			],
		},
	],
	prod: [
		{
			packageName: "live.cohub.android",
			fingerprints: [
				"AF:3A:04:1D:78:89:D9:9D:50:7B:0E:25:6D:AD:03:CF:10:3A:18:81:8D:47:51:3C:F4:F7:32:92:EC:09:37:8F",
			],
		},
	],
};

const env = PUBLIC_COHUB_ENV?.trim().toLowerCase() ?? "";

const statements = (ANDROID_APPS[env] ?? []).map(
	({ packageName, fingerprints }) => ({
		relation: ["delegate_permission/common.handle_all_urls"],
		target: {
			namespace: "android_app",
			package_name: packageName,
			sha256_cert_fingerprints: fingerprints,
		},
	}),
);

export const GET: RequestHandler = () =>
	Response.json(statements, {
		headers: { "cache-control": "public, max-age=3600" },
	});
