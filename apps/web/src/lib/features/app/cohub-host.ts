import {
	type AppNavigationOpenResponse,
	type AppNavigationTarget,
	buildAppNavigationOpenMessage,
	parseAppNavigationOpenResponse,
} from "@cohub/protocol/app-navigation";
import { parseAppRef } from "@neta-art/cohub/app-ref";
import { buildAppMentionHref } from "#lib/mentions/app.ts";

type AppTarget = Extract<AppNavigationTarget, { kind: "app" }>;
type OpenResult = Pick<AppNavigationOpenResponse, "handled" | "reason">;

const OPEN_TIMEOUT_MS = 8_000;

/** `frameElement` is only exposed to same-origin parents, so third-party embedders never qualify. */
export function cohubHostWindow(): Window | null {
	if (typeof window === "undefined") return null;
	try {
		return window.frameElement?.hasAttribute("data-cohub-app-frame")
			? window.parent
			: null;
	} catch {
		return null;
	}
}

export function offerAppOpen(host: Window, ref: string): Promise<boolean> {
	const requestId = crypto.randomUUID();
	return new Promise((resolve) => {
		const settle = (handled: boolean) => {
			window.clearTimeout(timer);
			window.removeEventListener("message", receive);
			resolve(handled);
		};
		const receive = (event: MessageEvent) => {
			if (event.source !== host || event.origin !== window.location.origin)
				return;
			const response = parseAppNavigationOpenResponse(event.data);
			if (response?.requestId === requestId) settle(response.handled);
		};
		const timer = window.setTimeout(() => settle(false), OPEN_TIMEOUT_MS);
		window.addEventListener("message", receive);
		host.postMessage(
			buildAppNavigationOpenMessage({
				requestId,
				target: { kind: "app", ref },
			}),
			window.location.origin,
		);
	});
}

export function publicAppHref(target: AppTarget): string | null {
	let ref: ReturnType<typeof parseAppRef>;
	try {
		ref = parseAppRef(target.ref);
	} catch {
		return null;
	}
	if ("id" in ref) return null;
	const { search = "", hash = "" } = target.launch ?? ref;
	return `${window.location.origin}${buildAppMentionHref({ ...ref, launchSuffix: `${search}${hash}` })}`;
}

export async function openAppFromPage(target: AppTarget): Promise<OpenResult> {
	const href = publicAppHref(target);
	if (!href) return { handled: false, reason: "unsupported" };
	const host = cohubHostWindow();
	if (host && (await offerAppOpen(host, href))) return { handled: true };
	window.location.assign(href);
	return { handled: true };
}
