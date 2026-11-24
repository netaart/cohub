import type { RequestHandler } from "@sveltejs/kit";
import { PUBLIC_COHUB_ENV } from "$app/env/public";

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
				// Play signs distribution APKs with its legacy or hybrid signing keys.
				"3C:95:26:A8:F8:7C:19:C6:F4:CA:8A:E0:0E:3F:A4:32:D2:DD:28:41:50:56:BA:49:A7:BB:D8:7E:2C:9F:00:79",
				"3B:FA:A1:5F:EE:1B:BF:48:0B:5B:11:E9:69:EC:60:30:0A:9D:1C:F0:65:DD:BD:4E:B9:6A:3C:74:79:A2:85:9F",
				"A1:D4:E4:81:81:11:24:9A:AC:F4:7D:9A:55:E8:A6:7B:09:FE:57:4B:A1:2C:8C:F1:8B:7A:DA:F9:36:61:0C:A4",
			],
		},
	],
};

const env = PUBLIC_COHUB_ENV?.trim().toLowerCase() ?? "";

const statements = (ANDROID_APPS[env] ?? []).map(
	({ packageName, fingerprints }) => ({
		relation: [
			"delegate_permission/common.handle_all_urls",
			"delegate_permission/common.get_login_creds",
		],
		target: {
			namespace: "android_app",
			package_name: packageName,
			sha256_cert_fingerprints: fingerprints,
		},
	}),
);

export const GET: RequestHandler = () =>
	Response.json(statements, {
		headers: { "cache-control": "no-store" },
	});
