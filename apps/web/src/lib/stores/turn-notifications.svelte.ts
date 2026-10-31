import type { ChannelEnvelope, SpaceRecord } from "@neta-art/cohub";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { callHost, supportsHostCapability } from "$lib/host-bridge";
import {
	hostPermissions,
	requestHostPermission,
} from "$lib/host-permissions.svelte";
import type { Locale } from "$lib/i18n/locale";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { buildSpaceSessionRoute } from "$lib/space-routes";
import { authStore } from "$lib/stores/auth.svelte";
import {
	cacheSpaceRecordSoon,
	getCachedSpaceRecord,
} from "$lib/stores/space-record-cache";
import { resolveWorkspaceRouteContext } from "$lib/workspace-route";

const MAX_VISIBLE = 3;
const MAX_SEEN = 240;
const AUTO_DISMISS_MS = 6000;
const NOTIFICATION_PROMPT_COOLDOWN_MS = 7 * 86_400_000;
const NOTIFICATION_PROMPT_MAX_DISMISSES = 2;
const NOTIFICATION_PROMPT_VERSION = "v1";
const ACTIVE_SESSION_CHANNEL = "cohub:active-session";
const ACTIVE_SESSION_STORAGE_KEY = "cohub:active-session";
const ACTIVE_SESSION_TTL_MS = 8_000;
const ACTIVE_SESSION_PING_MS = 3_000;

type TurnNotifyPayload = {
	spaceId: string;
	sessionId: string;
	turnId: string;
	status: string;
	finishReason?: string | null;
	userPreview: string | null;
	durationMs: number | null;
	stepCount: number | null;
	sequence: number | null;
	provider: string | null;
	model: string | null;
	completedAt: string | null;
};

export type TurnNotification = {
	id: string;
	spaceId: string;
	sessionId: string;
	turnId: string;
	status: string;
	userPreview: string | null;
	durationMs: number | null;
	stepCount: number | null;
	sequence: number | null;
	provider: string | null;
	model: string | null;
	completedAt: string | null;
	receivedAt: number;
	space: SpaceRecord | null;
	dismissAt: number | null;
	remainingMs: number;
	interactionPaused: boolean;
};

type DesktopPromptState = {
	promptedAt?: number;
	dismissCount?: number;
};

type ActiveSessionMessage = {
	type: "active-session";
	tabId: string;
	spaceId: string;
	sessionId: string;
	focused: boolean;
	visible: boolean;
	updatedAt: number;
};

function isBrowser() {
	return typeof window !== "undefined" && typeof document !== "undefined";
}

function promptStorageKey(userUuid: string | null) {
	return `cohub:desktop-notification-prompt:${userUuid ?? "anonymous"}:${NOTIFICATION_PROMPT_VERSION}`;
}

function readPromptState(userUuid: string | null): DesktopPromptState {
	if (!isBrowser()) return {};
	try {
		return (
			JSON.parse(localStorage.getItem(promptStorageKey(userUuid)) ?? "{}") ?? {}
		);
	} catch {
		return {};
	}
}

function writePromptState(userUuid: string | null, state: DesktopPromptState) {
	if (!isBrowser()) return;
	try {
		localStorage.setItem(promptStorageKey(userUuid), JSON.stringify(state));
	} catch {
		// Best-effort preference persistence.
	}
}

function isTurnNotifyEvent(event: ChannelEnvelope): event is ChannelEnvelope & {
	payload: TurnNotifyPayload;
} {
	if (event.type !== "session.turn.notify") return false;
	const payload = event.payload as Partial<TurnNotifyPayload>;
	return (
		typeof payload.spaceId === "string" &&
		typeof payload.sessionId === "string" &&
		typeof payload.turnId === "string" &&
		typeof payload.status === "string"
	);
}

function currentRouteTarget() {
	const ctx = resolveWorkspaceRouteContext({
		pathname: page.url.pathname,
		searchParams: page.url.searchParams,
		pageData: page.data as { spaceId?: unknown; sessionId?: unknown },
		params: { id: page.params.id },
	});
	return { spaceId: ctx.spaceId, sessionId: ctx.sessionId };
}

function spaceTitle(space: SpaceRecord | null, fallback: string) {
	return space?.title || space?.name || space?.slug || fallback;
}

function notificationHref(
	notification: Pick<TurnNotification, "spaceId" | "sessionId">,
) {
	return buildSpaceSessionRoute(notification.spaceId, notification.sessionId);
}

function statusLabel(status: string, locale?: Locale) {
	if (status === "completed") return m.notif_status_completed({}, { locale });
	if (status === "failed") return m.notif_status_failed({}, { locale });
	if (status === "interrupted")
		return m.notif_status_interrupted({}, { locale });
	if (status === "cancelled") return m.notif_status_cancelled({}, { locale });
	if (status === "merged") return m.notif_status_merged({}, { locale });
	return status
		? status[0]?.toUpperCase() + status.slice(1)
		: m.notif_status_finished({}, { locale });
}

function formatDuration(durationMs: number | null, locale?: Locale) {
	if (
		typeof durationMs !== "number" ||
		!Number.isFinite(durationMs) ||
		durationMs < 0
	)
		return null;
	if (durationMs < 1000) return m.notif_dur_lt_1s({}, { locale });
	if (durationMs < 60_000) {
		return m.notif_dur_s({ n: Math.round(durationMs / 100) / 10 }, { locale });
	}
	const minutes = Math.floor(durationMs / 60_000);
	const seconds = Math.round((durationMs % 60_000) / 1000);
	return seconds > 0
		? m.notif_dur_m_s({ m: minutes, s: seconds }, { locale })
		: m.notif_dur_m({ n: minutes }, { locale });
}

export function getTurnNotificationMeta(
	notification: Pick<TurnNotification, "status" | "durationMs" | "stepCount">,
	locale?: Locale,
) {
	return [
		statusLabel(notification.status, locale),
		formatDuration(notification.durationMs, locale),
		typeof notification.stepCount === "number" && notification.stepCount > 0
			? notification.stepCount === 1
				? m.notif_steps_one({ n: notification.stepCount }, { locale })
				: m.notif_steps_many({ n: notification.stepCount }, { locale })
			: null,
	]
		.filter(Boolean)
		.join(" · ");
}

function canUseDesktopNotifications() {
	return isBrowser() && "Notification" in window;
}

function createTabId() {
	return typeof crypto !== "undefined" && "randomUUID" in crypto
		? crypto.randomUUID()
		: `${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function readActiveSessionRecord(): ActiveSessionMessage | null {
	if (!isBrowser()) return null;
	try {
		const parsed = JSON.parse(
			localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY) ?? "null",
		) as Partial<ActiveSessionMessage> | null;
		if (
			parsed?.type !== "active-session" ||
			typeof parsed.spaceId !== "string" ||
			typeof parsed.sessionId !== "string" ||
			typeof parsed.updatedAt !== "number"
		) {
			return null;
		}
		return parsed as ActiveSessionMessage;
	} catch {
		return null;
	}
}

function writeActiveSessionRecord(message: ActiveSessionMessage) {
	if (!isBrowser()) return;
	try {
		localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, JSON.stringify(message));
	} catch {
		// Best-effort cross-tab presence.
	}
}

class TurnNotificationsStore {
	items = $state<TurnNotification[]>([]);
	desktopPermission = $state<NotificationPermission>("default");
	showDesktopPrompt = $state(false);
	private cleanup: (() => void) | null = null;
	private seenTurnIds: string[] = [];
	private tickTimer: number | null = null;
	private activeSessionTimer: number | null = null;
	private activeSessionChannel: BroadcastChannel | null = null;
	private readonly tabId = createTabId();
	private activeSessions = new Map<string, ActiveSessionMessage>();
	private lastPublishedSession: { spaceId: string; sessionId: string } | null =
		null;
	private visible = true;
	private focused = true;

	get visibleItems() {
		return this.items.slice(0, MAX_VISIBLE);
	}

	get hiddenCount() {
		return Math.max(0, this.items.length - MAX_VISIBLE);
	}

	start() {
		if (this.cleanup || !isBrowser()) return;
		void hostPermissions();
		this.desktopPermission = canUseDesktopNotifications()
			? Notification.permission
			: "denied";
		this.visible = !document.hidden;
		this.focused = document.hasFocus();
		const offEvent = sdk.onUserEvent((event) => this.handleEvent(event));
		this.startActiveSessionPresence();
		const onVisibility = () => {
			this.visible = !document.hidden;
			this.publishActiveSessionPresence();
			this.syncCountdowns();
		};
		const onFocus = () => {
			this.focused = true;
			this.publishActiveSessionPresence();
			this.syncCountdowns();
		};
		const onBlur = () => {
			this.focused = false;
			this.publishActiveSessionPresence();
			this.syncCountdowns();
		};
		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("focus", onFocus);
		window.addEventListener("blur", onBlur);
		this.cleanup = () => {
			offEvent();
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("focus", onFocus);
			window.removeEventListener("blur", onBlur);
			this.stopActiveSessionPresence();
			this.stopTick();
		};
	}

	stop() {
		this.cleanup?.();
		this.cleanup = null;
	}

	dismiss(id: string) {
		this.items = this.items.filter((item) => item.id !== id);
		this.syncTick();
	}

	setInteractionPaused(id: string, interactionPaused: boolean) {
		this.items = this.items.map((item) =>
			item.id === id ? { ...item, interactionPaused } : item,
		);
		this.syncCountdowns();
	}

	openCurrentTab(notification: TurnNotification) {
		this.dismiss(notification.id);
		void goto(notificationHref(notification));
	}

	openNewTab(notification: TurnNotification) {
		this.dismiss(notification.id);
		window.open(notificationHref(notification), "_blank", "noreferrer");
	}

	async enableDesktopNotifications() {
		if (supportsHostCapability("notifications")) {
			this.showDesktopPrompt = false;
			await requestHostPermission("notifications").catch(() => undefined);
		} else {
			if (!canUseDesktopNotifications()) return;
			const permission = await Notification.requestPermission();
			this.desktopPermission = permission;
			this.showDesktopPrompt = false;
		}
		writePromptState(authStore.userUuid, {
			promptedAt: Date.now(),
			dismissCount: 0,
		});
	}

	dismissDesktopPrompt() {
		const state = readPromptState(authStore.userUuid);
		writePromptState(authStore.userUuid, {
			promptedAt: Date.now(),
			dismissCount: (state.dismissCount ?? 0) + 1,
		});
		this.showDesktopPrompt = false;
	}

	syncActiveSessionPresence() {
		this.publishActiveSessionPresence();
	}

	private startActiveSessionPresence() {
		if (typeof BroadcastChannel !== "undefined") {
			this.activeSessionChannel = new BroadcastChannel(ACTIVE_SESSION_CHANNEL);
			this.activeSessionChannel.onmessage = (event: MessageEvent) => {
				this.receiveActiveSessionMessage(event.data);
			};
		}
		const stored = readActiveSessionRecord();
		if (stored) this.receiveActiveSessionMessage(stored);
		window.addEventListener("storage", this.handleActiveSessionStorage);
		this.publishActiveSessionPresence();
		this.activeSessionTimer = window.setInterval(() => {
			this.publishActiveSessionPresence();
			this.pruneActiveSessions();
		}, ACTIVE_SESSION_PING_MS);
	}

	private stopActiveSessionPresence() {
		if (this.activeSessionTimer !== null) {
			window.clearInterval(this.activeSessionTimer);
			this.activeSessionTimer = null;
		}
		window.removeEventListener("storage", this.handleActiveSessionStorage);
		this.activeSessionChannel?.close();
		this.activeSessionChannel = null;
		this.activeSessions.clear();
	}

	private handleActiveSessionStorage = (event: StorageEvent) => {
		if (event.key !== ACTIVE_SESSION_STORAGE_KEY || !event.newValue) return;
		try {
			this.receiveActiveSessionMessage(JSON.parse(event.newValue));
		} catch {
			// Ignore malformed cross-tab presence.
		}
	};

	private publishActiveSessionPresence() {
		const current = currentRouteTarget();
		const target =
			current.spaceId && current.sessionId && current.sessionId !== "new"
				? { spaceId: current.spaceId, sessionId: current.sessionId }
				: this.lastPublishedSession;
		if (!target) return;
		const isCurrent =
			current.spaceId === target.spaceId &&
			current.sessionId === target.sessionId;
		const message: ActiveSessionMessage = {
			type: "active-session",
			tabId: this.tabId,
			spaceId: target.spaceId,
			sessionId: target.sessionId,
			focused: isCurrent && this.focused,
			visible: isCurrent && this.visible,
			updatedAt: Date.now(),
		};
		this.lastPublishedSession = isCurrent ? target : null;
		this.receiveActiveSessionMessage(message);
		writeActiveSessionRecord(message);
		this.activeSessionChannel?.postMessage(message);
	}

	private receiveActiveSessionMessage(value: unknown) {
		const message = value as Partial<ActiveSessionMessage> | null;
		if (
			message?.type !== "active-session" ||
			typeof message.tabId !== "string" ||
			typeof message.spaceId !== "string" ||
			typeof message.sessionId !== "string" ||
			typeof message.updatedAt !== "number"
		) {
			return;
		}
		this.activeSessions.set(message.tabId, message as ActiveSessionMessage);
		this.pruneActiveSessions();
	}

	private pruneActiveSessions() {
		const cutoff = Date.now() - ACTIVE_SESSION_TTL_MS;
		for (const [tabId, message] of this.activeSessions) {
			if (message.updatedAt < cutoff) this.activeSessions.delete(tabId);
		}
	}

	private isSessionActiveInAnyVisibleTab(spaceId: string, sessionId: string) {
		this.pruneActiveSessions();
		for (const message of this.activeSessions.values()) {
			if (
				message.spaceId === spaceId &&
				message.sessionId === sessionId &&
				message.visible &&
				message.focused
			) {
				return true;
			}
		}
		return false;
	}

	private handleEvent(event: ChannelEnvelope) {
		if (!isTurnNotifyEvent(event)) return;
		void this.handleTurnNotifyEvent(event);
	}

	private async handleTurnNotifyEvent(
		event: ChannelEnvelope & { payload: TurnNotifyPayload },
	) {
		const payload = event.payload;
		if (this.hasSeen(payload.turnId)) return;

		if (canUseDesktopNotifications())
			this.desktopPermission = Notification.permission;
		const current = currentRouteTarget();
		const activelyObserved = this.visible && this.focused;
		if (
			activelyObserved &&
			current.spaceId === payload.spaceId &&
			current.sessionId === payload.sessionId
		) {
			return;
		}
		this.markSeen(payload.turnId);

		const cachedSpace =
			(await getCachedSpaceRecord(payload.spaceId).catch(() => null))?.space ??
			null;
		const item: TurnNotification = {
			id: event.id || payload.turnId,
			spaceId: payload.spaceId,
			sessionId: payload.sessionId,
			turnId: payload.turnId,
			status: payload.status,
			userPreview: payload.userPreview,
			durationMs: payload.durationMs,
			stepCount: payload.stepCount,
			sequence: payload.sequence,
			provider: payload.provider,
			model: payload.model,
			completedAt: payload.completedAt,
			receivedAt: Date.now(),
			space: cachedSpace,
			dismissAt: null,
			remainingMs: AUTO_DISMISS_MS,
			interactionPaused: false,
		};
		this.items = [
			item,
			...this.items.filter((existing) => existing.turnId !== item.turnId),
		];
		if (!cachedSpace) void this.hydrateSpace(item.spaceId);
		this.maybeShowDesktopPrompt();
		void this.maybeSendDesktopNotification(item);
		this.syncCountdowns();
	}

	private async hydrateSpace(spaceId: string) {
		const cached = await getCachedSpaceRecord(spaceId).catch(() => null);
		if (cached?.space) {
			this.applySpace(cached.space);
			return;
		}
		const fetched = await sdk.spaces.get(spaceId).catch(() => null);
		if (!fetched) return;
		cacheSpaceRecordSoon(fetched);
		this.applySpace(fetched);
	}

	private applySpace(space: SpaceRecord) {
		this.items = this.items.map((item) =>
			item.spaceId === space.id ? { ...item, space } : item,
		);
	}

	private maybeShowDesktopPrompt() {
		if (supportsHostCapability("notifications")) {
			if (hostPermissions()?.notifications !== "prompt") return;
		} else if (
			!canUseDesktopNotifications() ||
			this.desktopPermission !== "default"
		)
			return;
		const state = readPromptState(authStore.userUuid);
		if ((state.dismissCount ?? 0) >= NOTIFICATION_PROMPT_MAX_DISMISSES) return;
		if (
			state.promptedAt &&
			Date.now() - state.promptedAt < NOTIFICATION_PROMPT_COOLDOWN_MS
		) {
			return;
		}
		this.showDesktopPrompt = true;
	}

	private async maybeSendDesktopNotification(item: TurnNotification) {
		if (supportsHostCapability("notifications")) {
			if (this.visible && this.focused) return;
			if (this.isSessionActiveInAnyVisibleTab(item.spaceId, item.sessionId))
				return;
			await callHost("notifications.show", {
				id: `turn:${item.turnId}`,
				title: spaceTitle(item.space, m.notif_turn_completed()).slice(0, 256),
				body: [item.userPreview, getTurnNotificationMeta(item)]
					.filter(Boolean)
					.join("\n")
					.slice(0, 2_000),
				path: notificationHref(item),
			}).catch(() => {});
			return;
		}
		if (!canUseDesktopNotifications() || this.desktopPermission !== "granted")
			return;
		if (!document.hidden) return;
		if (this.isSessionActiveInAnyVisibleTab(item.spaceId, item.sessionId))
			return;
		const title = spaceTitle(item.space, "Space");
		const targetUrl = notificationHref(item);
		const options: NotificationOptions = {
			body: [item.userPreview, getTurnNotificationMeta(item)]
				.filter(Boolean)
				.join("\n"),
			icon: item.space?.publicProfile?.avatarUrl ?? undefined,
			tag: `turn:${item.turnId}`,
			data: { url: targetUrl },
		};
		try {
			const notification = new Notification(
				`${title} finished a turn`,
				options,
			);
			notification.onclick = () => {
				window.focus();
				void goto(targetUrl);
				notification.close();
			};
			return;
		} catch {
			const registration = await navigator.serviceWorker?.ready.catch(
				() => null,
			);
			await registration?.showNotification(`${title} finished a turn`, options);
		}
	}

	private syncCountdowns() {
		const active = this.visible;
		const now = Date.now();
		this.items = this.items.map((item) => {
			if (!active || item.interactionPaused) {
				return item.dismissAt
					? {
							...item,
							remainingMs: Math.max(0, item.dismissAt - now),
							dismissAt: null,
						}
					: item;
			}
			return item.dismissAt
				? item
				: { ...item, dismissAt: now + item.remainingMs };
		});
		this.syncTick();
	}

	private syncTick() {
		const shouldTick = this.items.some((item) => item.dismissAt !== null);
		if (shouldTick) {
			this.startTick();
		} else {
			this.stopTick();
		}
	}

	private startTick() {
		if (this.tickTimer !== null) return;
		this.tickTimer = window.setInterval(() => {
			const now = Date.now();
			this.items = this.items.filter(
				(item) => !item.dismissAt || item.dismissAt > now,
			);
			this.syncTick();
		}, 250);
	}

	private stopTick() {
		if (this.tickTimer === null) return;
		window.clearInterval(this.tickTimer);
		this.tickTimer = null;
	}

	private hasSeen(turnId: string) {
		return this.seenTurnIds.includes(turnId);
	}

	private markSeen(turnId: string) {
		this.seenTurnIds = [
			turnId,
			...this.seenTurnIds.filter((id) => id !== turnId),
		].slice(0, MAX_SEEN);
	}
}

export const turnNotifications = new TurnNotificationsStore();

export function getTurnNotificationHref(
	notification: Pick<TurnNotification, "spaceId" | "sessionId">,
) {
	return notificationHref(notification);
}

export function getTurnNotificationSpaceTitle(
	notification: Pick<TurnNotification, "space" | "spaceId">,
) {
	return spaceTitle(notification.space, notification.spaceId);
}
