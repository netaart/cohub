import { callHost, readyHost, supportsHostCapability } from "$lib/host-bridge";
import { BUILD_LABEL } from "$lib/project";

export const OPEN_ABOUT_EVENT = "cohub:open-about";

export async function openAbout() {
	await readyHost();
	if (
		supportsHostCapability("app.about") &&
		(await callHost("app.about", { web: BUILD_LABEL }).catch(() => false))
	)
		return;
	window.dispatchEvent(new CustomEvent(OPEN_ABOUT_EVENT));
}

export const aboutReport = () =>
	`Cohub Web ${BUILD_LABEL}\n${navigator.userAgent}`;
