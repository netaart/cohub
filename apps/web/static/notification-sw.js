/* global clients, location, self */

function resolveNotificationUrl(data) {
	if (!data || typeof data !== "object") return "/";
	const rawUrl = data.url;
	if (typeof rawUrl !== "string" || !rawUrl.trim()) return "/";
	try {
		const url = new URL(rawUrl, location.origin);
		return url.origin === location.origin
			? `${url.pathname}${url.search}${url.hash}`
			: "/";
	} catch {
		return "/";
	}
}

self.addEventListener("push", (event) => {
	let message = null;
	try {
		message = event.data?.json() ?? null;
	} catch {
		message = null;
	}
	if (!message || typeof message.title !== "string") return;
	event.waitUntil(
		(async () => {
			if (typeof message.unread === "number" && "setAppBadge" in self.navigator)
				await self.navigator.setAppBadge(message.unread).catch(() => undefined);
			const windows = await clients.matchAll({
				type: "window",
				includeUncontrolled: true,
			});
			if (
				windows.some(
					(client) => client.focused && client.visibilityState === "visible",
				)
			)
				return;
			await self.registration.showNotification(message.title, {
				body: message.body || undefined,
				tag: message.tag,
				icon: "/pwa/icon-192x192.png",
				badge: "/pwa/icon-192x192.png",
				data: { url: message.path },
			});
		})(),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const targetUrl = resolveNotificationUrl(event.notification.data);
	event.waitUntil(
		(async () => {
			const clientList = await clients.matchAll({
				type: "window",
				includeUncontrolled: true,
			});
			for (const client of clientList) {
				const url = new URL(client.url);
				if (
					`${url.pathname}${url.search}${url.hash}` === targetUrl &&
					"focus" in client
				) {
					return client.focus();
				}
			}
			const focusedClient = clientList.find((client) => "focus" in client);
			if (focusedClient) {
				await focusedClient.focus();
				return focusedClient.navigate(targetUrl);
			}
			return clients.openWindow(targetUrl);
		})(),
	);
});
