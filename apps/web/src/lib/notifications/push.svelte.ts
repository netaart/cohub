import type { NotificationConfig } from "@neta-art/cohub";
import {
	callHost,
	readyHost,
	supportsHostCapability,
} from "#lib/host-bridge.ts";
import { requestHostPermission } from "#lib/host-permissions.svelte.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { getDeviceId } from "#lib/notifications/device.ts";
import { sdk } from "#lib/sdk.ts";
import { authStore } from "#lib/stores/auth.svelte.ts";

export type DevicePushMode =
	| "push"
	| "local"
	| "off"
	| "blocked"
	| "unsupported";

const urlBase64ToBytes = (value: string) => {
	const base64 = (value + "=".repeat((4 - (value.length % 4)) % 4))
		.replaceAll("-", "+")
		.replaceAll("_", "/");
	return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
};

function browserPermission(): NotificationPermission | null {
	return typeof Notification === "undefined" ? null : Notification.permission;
}

async function hostNotificationPermission() {
	if (!supportsHostCapability("permissions")) return "granted" as const;
	const permissions = await callHost("permissions.status").catch(() => null);
	return permissions?.notifications ?? "prompt";
}

const FORGET_TIMEOUT_MS = 3_000;
const disabledKey = () => `cohub:push-disabled:${authStore.userUuid ?? ""}`;

export function pushDisabledHere() {
	try {
		return localStorage.getItem(disabledKey()) === "1";
	} catch {
		return false;
	}
}

function setPushDisabledHere(disabled: boolean) {
	try {
		if (disabled) localStorage.setItem(disabledKey(), "1");
		else localStorage.removeItem(disabledKey());
	} catch {}
}

const READY_TIMEOUT_MS = 10_000;

async function serviceWorkerRegistration(options: { wait?: boolean } = {}) {
	if (!("serviceWorker" in navigator) || !("PushManager" in window))
		return null;
	const current = await navigator.serviceWorker
		.getRegistration()
		.catch(() => undefined);
	if (current || !options.wait) return current ?? null;
	return Promise.race([
		navigator.serviceWorker.ready.catch(() => null),
		new Promise<null>((resolve) =>
			setTimeout(() => resolve(null), READY_TIMEOUT_MS),
		),
	]);
}

class DevicePush {
	mode = $state<DevicePushMode>("off");
	#config: NotificationConfig | null = null;
	#started: Promise<void> | null = null;

	start() {
		this.#started ??= this.#resolve({ subscribe: false });
		return this.#started;
	}

	async enable() {
		setPushDisabledHere(false);
		await this.#resolve({ subscribe: true });
		return this.mode;
	}

	async disable() {
		setPushDisabledHere(true);
		this.mode = "off";
		await this.forget();
	}

	async forget() {
		const timeout = new Promise<void>((resolve) =>
			setTimeout(resolve, FORGET_TIMEOUT_MS),
		);
		const unsubscribe = serviceWorkerRegistration()
			.then((registration) => registration?.pushManager.getSubscription())
			.then((subscription) => subscription?.unsubscribe());
		const unregister = sdk.notifications.unregisterPushTarget(getDeviceId());
		await Promise.race([
			Promise.allSettled([unsubscribe, unregister]),
			timeout,
		]);
	}

	async #configuration() {
		this.#config ??= await sdk.notifications.config().catch(() => null);
		return this.#config;
	}

	async #resolve({ subscribe }: { subscribe: boolean }) {
		await readyHost();
		if (!subscribe && pushDisabledHere()) {
			this.mode = "off";
			return;
		}
		const config = await this.#configuration();
		if (supportsHostCapability("notifications.push")) {
			this.mode = await this.#resolveHostPush(subscribe);
		} else if (supportsHostCapability("notifications")) {
			this.mode = await this.#resolveHostLocal(subscribe);
		} else {
			this.mode = await this.#resolveBrowser(config, subscribe);
		}
	}

	async #resolveHostPush(subscribe: boolean): Promise<DevicePushMode> {
		const permission = await hostNotificationPermission();
		if (permission === "denied") return "blocked";
		if (permission !== "granted" && !subscribe) return "off";
		const subscription = await callHost("notifications.subscribe").catch(
			() => null,
		);
		if (!subscription) return subscribe ? "blocked" : "off";
		await sdk.notifications.registerPushTarget({
			deviceId: getDeviceId(),
			transport: subscription.transport,
			token: subscription.token,
			locale: getLocale(),
		});
		return "push";
	}

	async #resolveHostLocal(subscribe: boolean): Promise<DevicePushMode> {
		let permission = await hostNotificationPermission();
		if (permission === "prompt" && subscribe)
			permission = await requestHostPermission("notifications").catch(
				() => "denied" as const,
			);
		return permission === "granted"
			? "local"
			: permission === "denied"
				? "blocked"
				: "off";
	}

	async #resolveBrowser(
		config: NotificationConfig | null,
		subscribe: boolean,
	): Promise<DevicePushMode> {
		let permission = browserPermission();
		if (!permission) return "unsupported";
		if (permission === "default" && subscribe)
			permission = await Notification.requestPermission();
		if (permission === "denied") return "blocked";
		if (permission !== "granted") return "off";
		const publicKey = config?.push.webpush?.publicKey;
		const registration = publicKey
			? await serviceWorkerRegistration({ wait: true })
			: null;
		if (!publicKey || !registration) return "local";
		try {
			const subscription =
				(await registration.pushManager.getSubscription()) ??
				(await registration.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: urlBase64ToBytes(publicKey),
				}));
			const keys = subscription.toJSON().keys;
			if (!keys?.p256dh || !keys.auth) return "local";
			await sdk.notifications.registerPushTarget({
				deviceId: getDeviceId(),
				transport: "webpush",
				token: subscription.endpoint,
				keys: { p256dh: keys.p256dh, auth: keys.auth },
				locale: getLocale(),
			});
			return "push";
		} catch (error) {
			console.warn("[notifications] web push subscription failed", error);
			return "local";
		}
	}
}

export const devicePush = new DevicePush();
