import { SPACE_CUSTOM_THEME_CSS_PATH } from "@cohub/protocol";
import { HttpError } from "@neta-art/cohub";
import { SvelteMap } from "svelte/reactivity";
import { sdk } from "$lib/sdk";

type StoredThemeCss =
	| { type: "inline"; content: string }
	| { type: "url"; href: string };

const REVALIDATE_AFTER_MS = 60_000;
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_DELAY_MS = 1200;

const confirmed = new SvelteMap<string, string | null>();
const stored = new Map<string, string | null>();
const revalidatedAt = new Map<string, number>();
const latestRequest = new Map<string, number>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let requestSeq = 0;

function cacheKey(spaceId: string) {
	return `cohub:space-style:${spaceId}:v1`;
}

function toCss(value: StoredThemeCss): string {
	return value.type === "inline"
		? value.content
		: `@import url(${JSON.stringify(value.href)});`;
}

function readStored(spaceId: string): string | null {
	if (stored.has(spaceId)) return stored.get(spaceId) ?? null;
	let css: string | null = null;
	try {
		const raw = localStorage.getItem(cacheKey(spaceId));
		const value = raw ? (JSON.parse(raw) as Partial<StoredThemeCss>) : null;
		if (value?.type === "inline" && typeof value.content === "string") {
			css = toCss({ type: "inline", content: value.content });
		} else if (value?.type === "url" && typeof value.href === "string") {
			css = toCss({ type: "url", href: value.href });
		}
	} catch {}
	stored.set(spaceId, css);
	return css;
}

function commit(spaceId: string, value: StoredThemeCss | null) {
	try {
		if (value) localStorage.setItem(cacheKey(spaceId), JSON.stringify(value));
		else localStorage.removeItem(cacheKey(spaceId));
	} catch {}
	const css = value ? toCss(value) : null;
	stored.set(spaceId, css);
	if (!confirmed.has(spaceId) || confirmed.get(spaceId) !== css) {
		confirmed.set(spaceId, css);
	}
}

function decodeBase64(content: string) {
	const bytes = Uint8Array.from(atob(content), (char) => char.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

function isRetryable(error: unknown) {
	if (!(error instanceof HttpError)) return true;
	return error.status === 408 || error.status === 429 || error.status >= 500;
}

function scheduleRetry(
	spaceId: string,
	seq: number,
	attempt: number,
	delayMs: number,
) {
	if (attempt + 1 >= MAX_RETRY_ATTEMPTS) return;
	clearTimeout(retryTimers.get(spaceId));
	retryTimers.set(
		spaceId,
		setTimeout(
			() => {
				retryTimers.delete(spaceId);
				void load(spaceId, seq, attempt + 1);
			},
			Math.max(250, delayMs),
		),
	);
}

async function load(spaceId: string, seq: number, attempt = 0) {
	const isLatest = () => latestRequest.get(spaceId) === seq;
	if (!isLatest()) return;
	try {
		const file = await sdk
			.space(spaceId)
			.files.read(SPACE_CUSTOM_THEME_CSS_PATH);
		if (!isLatest()) return;
		if (!("content" in file)) {
			scheduleRetry(spaceId, seq, attempt, file.retryAfterMs);
			return;
		}
		commit(
			spaceId,
			file.delivery === "url" && file.url
				? { type: "url", href: file.url }
				: {
						type: "inline",
						content:
							file.encoding === "base64"
								? decodeBase64(file.content)
								: file.content,
					},
		);
	} catch (error) {
		if (!isLatest()) return;
		if (error instanceof HttpError && error.status === 404) {
			commit(spaceId, null);
		} else if (isRetryable(error)) {
			scheduleRetry(spaceId, seq, attempt, RETRY_DELAY_MS * 2 ** attempt);
		}
	}
}

export function getThemeCss(spaceId: string): string | null {
	if (confirmed.has(spaceId)) return confirmed.get(spaceId) ?? null;
	return readStored(spaceId);
}

export function refreshThemeCss(spaceId: string) {
	if (typeof window === "undefined") return;
	revalidatedAt.set(spaceId, Date.now());
	clearTimeout(retryTimers.get(spaceId));
	const seq = ++requestSeq;
	latestRequest.set(spaceId, seq);
	void load(spaceId, seq);
}

export function ensureThemeCss(spaceId: string) {
	const last = revalidatedAt.get(spaceId);
	if (last === undefined || Date.now() - last >= REVALIDATE_AFTER_MS)
		refreshThemeCss(spaceId);
}

export function isThemeCssPath(path: string | null | undefined) {
	return (
		path?.replace(/\\/g, "/").replace(/^\.\/+/, "") ===
		SPACE_CUSTOM_THEME_CSS_PATH
	);
}
