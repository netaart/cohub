import { createSubscriber } from "svelte/reactivity";

const LEGACY_KEY = "cohub:space-danmaku:v1";
const PREFIX = "cohub:danmaku:v1:";
const unsaved = new Map<string, string | null>();

let notify: (() => void) | undefined;
const track = createSubscriber((update) => {
	notify = update;
	function onStorage(event: StorageEvent) {
		if (
			event.storageArea !== window.localStorage ||
			(event.key !== null &&
				event.key !== LEGACY_KEY &&
				!event.key.startsWith(PREFIX))
		)
			return;
		if (event.key === null) unsaved.clear();
		else unsaved.delete(event.key);
		update();
	}
	window.addEventListener("storage", onStorage);
	return () => {
		window.removeEventListener("storage", onStorage);
		notify = undefined;
	};
});

function read(key: string) {
	if (unsaved.has(key)) return unsaved.get(key) ?? null;
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

function write(key: string, value: string | null) {
	if (read(key) === value) return;
	try {
		if (value === null) window.localStorage.removeItem(key);
		else window.localStorage.setItem(key, value);
		unsaved.delete(key);
	} catch {
		unsaved.set(key, value);
	}
	notify?.();
}

function defaultKey(userId: string) {
	return `${PREFIX}user:${encodeURIComponent(userId)}`;
}

function spaceKey(userId: string, spaceId: string) {
	return `${defaultKey(userId)}:space:${encodeURIComponent(spaceId)}`;
}

export function getDanmakuDefault(userId: string) {
	track();
	const value = read(defaultKey(userId));
	if (value === "on" || value === "off") return value === "on";
	try {
		return JSON.parse(read(LEGACY_KEY) ?? "null")?.enabled !== false;
	} catch {
		return true;
	}
}

export function setDanmakuDefault(userId: string, enabled: boolean) {
	write(defaultKey(userId), enabled ? "on" : "off");
}

export function isSpaceDanmakuEnabled(userId: string, spaceId: string) {
	track();
	const value = read(spaceKey(userId, spaceId));
	return value === "on" || value === "off"
		? value === "on"
		: getDanmakuDefault(userId);
}

export function setSpaceDanmakuEnabled(
	userId: string,
	spaceId: string,
	enabled: boolean,
) {
	write(
		spaceKey(userId, spaceId),
		getDanmakuDefault(userId) === enabled ? null : enabled ? "on" : "off",
	);
}
