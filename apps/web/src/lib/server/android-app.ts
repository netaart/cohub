import { nativeDeployment } from "@cohub/protocol/native-apps";

export type AndroidApp = { packageName: string; fingerprints: string[] };

export function androidApp(env: string | undefined): AndroidApp | undefined {
	return nativeDeployment(env)?.android;
}

/** Opens the app by package, even where its App Link was never verified. */
export function androidIntentUrl(url: URL, packageName: string): string {
	return `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=https;package=${packageName};end`;
}
