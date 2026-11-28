export interface AndroidApp {
	packageName: string;
	fingerprints: string[];
}

const ANDROID_APPS: Record<string, AndroidApp> = {
	dev: {
		packageName: "live.cohub.android.dev",
		fingerprints: [
			"64:34:C1:D0:3E:EC:B9:06:D5:16:E8:A1:54:7D:AF:69:38:BB:CA:C9:77:F2:C5:B4:F3:0E:7A:33:BB:25:B1:EA",
		],
	},
	prod: {
		packageName: "live.cohub.android",
		fingerprints: [
			"AF:3A:04:1D:78:89:D9:9D:50:7B:0E:25:6D:AD:03:CF:10:3A:18:81:8D:47:51:3C:F4:F7:32:92:EC:09:37:8F",
			// Play signs distribution APKs with its legacy or hybrid signing keys.
			"3C:95:26:A8:F8:7C:19:C6:F4:CA:8A:E0:0E:3F:A4:32:D2:DD:28:41:50:56:BA:49:A7:BB:D8:7E:2C:9F:00:79",
			"3B:FA:A1:5F:EE:1B:BF:48:0B:5B:11:E9:69:EC:60:30:0A:9D:1C:F0:65:DD:BD:4E:B9:6A:3C:74:79:A2:85:9F",
			"A1:D4:E4:81:81:11:24:9A:AC:F4:7D:9A:55:E8:A6:7B:09:FE:57:4B:A1:2C:8C:F1:8B:7A:DA:F9:36:61:0C:A4",
		],
	},
};

export function androidApp(env: string | undefined): AndroidApp | undefined {
	const key = env?.trim().toLowerCase() ?? "";
	return Object.hasOwn(ANDROID_APPS, key) ? ANDROID_APPS[key] : undefined;
}

/** Opens the app by package, even where its App Link was never verified. */
export function androidIntentUrl(url: URL, packageName: string): string {
	return `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=https;package=${packageName};end`;
}
