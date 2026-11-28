import { type NotificationRecord, notificationTag } from "@neta-art/cohub";
import { callHost, supportsHostCapability } from "#lib/host-bridge.ts";
import { flagHostTabAttention } from "#lib/host-tabs.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { notificationCopy, notificationHref } from "#lib/notifications/copy.ts";
import {
	isDeviceAttended,
	trackDeviceAttention,
} from "#lib/notifications/device.ts";
import { inbox } from "#lib/notifications/inbox.svelte.ts";
import {
	devicePush,
	pushDisabledHere,
} from "#lib/notifications/push.svelte.ts";
import { sdk } from "#lib/sdk.ts";
import { authStore } from "#lib/stores/auth.svelte.ts";
import { resolveWorkspaceRouteContext } from "#lib/workspace-route.ts";
import { goto } from "$app/navigation";
import { page } from "$app/state";

const MAX_TOASTS = 3;
const TOAST_MS = 6_000;
const SYSTEM_ALERT_DELAY_MS = 1_500;
const PROMPT_COOLDOWN_MS = 7 * 86_400_000;
const PROMPT_MAX_DISMISSALS = 2;

export type NotificationToast = {
	record: NotificationRecord;
	remainingMs: number;
	dismissAt: number | null;
	paused: boolean;
};

type PromptState = { promptedAt?: number; dismissals?: number };

export function syncNotificationLocale(locale: string) {
	const key = `cohub:notification-locale:${authStore.userUuid ?? ""}`;
	try {
		if (localStorage.getItem(key) === locale) return;
	} catch {
		return;
	}
	void sdk.notifications
		.setLocale(locale)
		.then(() => localStorage.setItem(key, locale))
		.catch(() => undefined);
}

const promptKey = () =>
	`cohub:notification-prompt:${authStore.userUuid ?? "anonymous"}:v2`;

function readPrompt(): PromptState {
	try {
		return JSON.parse(localStorage.getItem(promptKey()) ?? "{}") ?? {};
	} catch {
		return {};
	}
}

function writePrompt(state: PromptState) {
	try {
		localStorage.setItem(promptKey(), JSON.stringify(state));
	} catch {}
}

export function viewedSession() {
	const ctx = resolveWorkspaceRouteContext({
		pathname: page.url.pathname,
		searchParams: page.url.searchParams,
		pageData: page.data as { spaceId?: unknown; sessionId?: unknown },
		params: { id: page.params.id },
	});
	return ctx.sessionId && ctx.sessionId !== "new" ? ctx.sessionId : null;
}

class NotificationAlerts {
	toasts = $state<NotificationToast[]>([]);
	showPrompt = $state(false);
	attended = $state(true);
	#seen = new Map<string, number>();
	#tick: number | null = null;
	#stop: (() => void) | null = null;

	start(): () => void {
		if (this.#stop) return this.#stop;
		const syncAttention = () => {
			this.attended = isDeviceAttended();
			this.#syncCountdowns();
		};
		syncAttention();
		const stops = [
			inbox.start(),
			inbox.list.watch("all"),
			trackDeviceAttention(),
			inbox.onUpserted((records) => this.#receive(records)),
		];
		document.addEventListener("visibilitychange", syncAttention);
		window.addEventListener("focus", syncAttention);
		window.addEventListener("blur", syncAttention);
		void devicePush.start();
		this.#stop = () => {
			for (const stop of stops) stop();
			document.removeEventListener("visibilitychange", syncAttention);
			window.removeEventListener("focus", syncAttention);
			window.removeEventListener("blur", syncAttention);
			this.#stopTick();
			this.#stop = null;
		};
		return this.#stop;
	}

	readViewedSession() {
		const sessionId = viewedSession();
		if (!sessionId || !this.attended) return;
		if (inbox.hasUnreadFor(sessionId) || inbox.unknownUnread > 0)
			void inbox.markRead({ sessionId });
	}

	open(toast: NotificationToast, options: { newTab?: boolean } = {}) {
		this.dismiss(toast.record.id);
		void inbox.markRead({ ids: [toast.record.id] });
		const href = notificationHref(toast.record);
		if (options.newTab) window.open(href, "_blank", "noreferrer");
		else void goto(href);
	}

	dismiss(id: string) {
		this.toasts = this.toasts.filter((toast) => toast.record.id !== id);
		this.#syncTick();
	}

	pause(id: string, paused: boolean) {
		this.toasts = this.toasts.map((toast) =>
			toast.record.id === id ? { ...toast, paused } : toast,
		);
		this.#syncCountdowns();
	}

	async enablePush() {
		this.showPrompt = false;
		writePrompt({ promptedAt: Date.now(), dismissals: 0 });
		await devicePush.enable();
	}

	dismissPrompt() {
		const state = readPrompt();
		writePrompt({
			promptedAt: Date.now(),
			dismissals: (state.dismissals ?? 0) + 1,
		});
		this.showPrompt = false;
	}

	#receive(records: NotificationRecord[]) {
		const viewing = viewedSession();
		for (const record of records) {
			if (record.readAt || (this.#seen.get(record.id) ?? 0) >= record.revision)
				continue;
			this.#seen.set(record.id, record.revision);
			const shown = viewing !== null && record.sessionId === viewing;
			if (shown && this.attended) {
				void inbox.markRead({ ids: [record.id] });
				continue;
			}
			if (shown) flagHostTabAttention();
			if (document.visibilityState === "visible") this.#toast(record);
			if (!this.attended) this.#alertSystemLater(record);
			this.#maybePrompt();
		}
	}

	#toast(record: NotificationRecord) {
		this.toasts = [
			{ record, remainingMs: TOAST_MS, dismissAt: null, paused: false },
			...this.toasts.filter((toast) => toast.record.id !== record.id),
		].slice(0, MAX_TOASTS);
		this.#syncCountdowns();
	}

	#alertSystemLater(record: NotificationRecord) {
		if (devicePush.mode !== "local") return;
		window.setTimeout(() => {
			if (inbox.list.find(record.id)?.readAt || isDeviceAttended()) return;
			const { title, body } = notificationCopy(record, getLocale());
			const path = notificationHref(record);
			const tag = notificationTag(record.id);
			if (supportsHostCapability("notifications")) {
				void callHost("notifications.show", {
					id: tag,
					title: title.slice(0, 256),
					body: body.slice(0, 2_000),
					path,
				}).catch(() => undefined);
				return;
			}
			try {
				const notification = new Notification(title, {
					body,
					tag,
					icon: "/pwa/icon-192x192.png",
					data: { url: path },
				});
				notification.onclick = () => {
					window.focus();
					void goto(path);
					notification.close();
				};
			} catch {
				void navigator.serviceWorker?.ready
					.then((registration) =>
						registration.showNotification(title, {
							body,
							tag,
							data: { url: path },
						}),
					)
					.catch(() => undefined);
			}
		}, SYSTEM_ALERT_DELAY_MS);
	}

	#maybePrompt() {
		if (devicePush.mode !== "off" || pushDisabledHere()) return;
		const state = readPrompt();
		if ((state.dismissals ?? 0) >= PROMPT_MAX_DISMISSALS) return;
		if (state.promptedAt && Date.now() - state.promptedAt < PROMPT_COOLDOWN_MS)
			return;
		this.showPrompt = true;
	}

	#syncCountdowns() {
		const now = Date.now();
		const running = document.visibilityState === "visible";
		this.toasts = this.toasts.map((toast) => {
			if (!running || toast.paused)
				return toast.dismissAt
					? {
							...toast,
							remainingMs: Math.max(0, toast.dismissAt - now),
							dismissAt: null,
						}
					: toast;
			return toast.dismissAt
				? toast
				: { ...toast, dismissAt: now + toast.remainingMs };
		});
		this.#syncTick();
	}

	#syncTick() {
		if (this.toasts.some((toast) => toast.dismissAt !== null)) {
			this.#tick ??= window.setInterval(() => {
				const now = Date.now();
				this.toasts = this.toasts.filter(
					(toast) => !toast.dismissAt || toast.dismissAt > now,
				);
				this.#syncTick();
			}, 250);
		} else this.#stopTick();
	}

	#stopTick() {
		if (this.#tick === null) return;
		window.clearInterval(this.#tick);
		this.#tick = null;
	}
}

export const notificationAlerts = new NotificationAlerts();
