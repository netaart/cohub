import { callHost, supportsHostCapability } from "$lib/host-bridge";

export type ShareContent = { title: string; text: string; url: string };

export function canShare(): boolean {
	return (
		supportsHostCapability("share") ||
		(typeof navigator !== "undefined" && typeof navigator.share === "function")
	);
}

/** Resolves false when the user dismissed the sheet. */
export async function share(content: ShareContent): Promise<boolean> {
	if (supportsHostCapability("share")) {
		await callHost("share.text", {
			title: content.title,
			text: `${content.text}\n${content.url}`,
		});
		return true;
	}
	try {
		await navigator.share(content);
		return true;
	} catch (error) {
		if ((error as { name?: string }).name === "AbortError") return false;
		throw error;
	}
}
