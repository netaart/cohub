import type { AppPromotionEventKey } from "@cohub/protocol";
import type { AppPromotionEventResponse } from "@neta-art/cohub";
import { sdk } from "#lib/sdk.ts";

type MetaFbq = {
	(...args: unknown[]): void;
	callMethod?: (...args: unknown[]) => void;
	queue: unknown[][];
	loaded: boolean;
	version: string;
	push: MetaFbq;
};

declare global {
	interface Window {
		fbq?: MetaFbq;
		_fbq?: MetaFbq;
	}
}

const META_SCRIPT_ID = "cohub-meta-pixel";
const ATTRIBUTION_LATEST_STORAGE_KEY = "cohub:app-promotion:latest";
const ATTRIBUTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const attributionWorkStorageKey = (appId: string) =>
	`cohub:app-promotion:${appId}`;

type AppPromotionAttribution = {
	promotionId: string;
	appId: string;
	capturedAt: number;
};
let initializedMetaPixelId: string | null = null;
let metaPageViewTracked = false;

function readCookie(name: string) {
	const prefix = `${name}=`;
	return document.cookie
		.split("; ")
		.find((item) => item.startsWith(prefix))
		?.slice(prefix.length);
}

function writeAttribution(attribution: AppPromotionAttribution) {
	try {
		const value = JSON.stringify(attribution);
		localStorage.setItem(ATTRIBUTION_LATEST_STORAGE_KEY, value);
		localStorage.setItem(attributionWorkStorageKey(attribution.appId), value);
	} catch {
		// Attribution must never block the app.
	}
}

export function readAppPromotionAttribution(
	appId?: string,
): AppPromotionAttribution | null {
	let raw: string | null = null;
	try {
		raw = localStorage.getItem(
			appId ? attributionWorkStorageKey(appId) : ATTRIBUTION_LATEST_STORAGE_KEY,
		);
	} catch {
		return null;
	}
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<AppPromotionAttribution>;
		if (
			typeof parsed.promotionId !== "string" ||
			typeof parsed.appId !== "string" ||
			typeof parsed.capturedAt !== "number" ||
			Date.now() - parsed.capturedAt > ATTRIBUTION_MAX_AGE_MS ||
			(appId !== undefined && parsed.appId !== appId)
		)
			return null;
		return parsed as AppPromotionAttribution;
	} catch {
		return null;
	}
}

function installFbq(): MetaFbq {
	if (window.fbq) return window.fbq;
	const fbq = ((...args: unknown[]) => {
		if (fbq.callMethod) fbq.callMethod(...args);
		else fbq.queue.push(args);
	}) as MetaFbq;
	fbq.push = fbq;
	fbq.loaded = true;
	fbq.version = "2.0";
	fbq.queue = [];
	window.fbq = fbq;
	window._fbq = fbq;
	return fbq;
}

function initializeMetaPixel(pixelId: string) {
	const fbq = installFbq();
	if (initializedMetaPixelId !== pixelId) {
		fbq("init", pixelId);
		initializedMetaPixelId = pixelId;
	}
	if (!document.getElementById(META_SCRIPT_ID)) {
		const script = document.createElement("script");
		script.id = META_SCRIPT_ID;
		script.async = true;
		script.src = "https://connect.facebook.net/en_US/fbevents.js";
		document.head.append(script);
	}
	if (!metaPageViewTracked) {
		fbq("track", "PageView");
		metaPageViewTracked = true;
	}
}

export function getAppPromotionCheckoutAttribution(appId: string) {
	const attribution = readAppPromotionAttribution(appId);
	if (!attribution) return null;
	const fbclid = new URL(window.location.href).searchParams.get("fbclid");
	return {
		promotionId: attribution.promotionId,
		sourceUrl: window.location.href,
		fbp: readCookie("_fbp"),
		fbc:
			readCookie("_fbc") ??
			(fbclid ? `fb.1.${Date.now()}.${fbclid}` : undefined),
	};
}

function eventInput(
	eventKey: AppPromotionEventKey,
	eventId: string,
	extra: { productKey?: string } = {},
) {
	const fbclid = new URL(window.location.href).searchParams.get("fbclid");
	return {
		eventKey,
		eventId,
		sourceUrl: window.location.href,
		fbp: readCookie("_fbp"),
		fbc:
			readCookie("_fbc") ??
			(fbclid ? `fb.1.${Date.now()}.${fbclid}` : undefined),
		...extra,
	};
}

export async function startAppPromotion(appId: string, promotionId: string) {
	const landingEventId = crypto.randomUUID();
	const runtime = await sdk.apps.recordPromotionEvent(
		appId,
		promotionId,
		eventInput("landing", landingEventId),
	);
	writeAttribution({ promotionId, appId, capturedAt: Date.now() });
	if (runtime.browser?.provider === "meta")
		initializeMetaPixel(runtime.browser.pixelId);
	return runtime;
}

export async function reportAttributedAppPromotionEvent(input: {
	appId: string;
	eventId: string;
	productKey: string;
}) {
	const attribution = readAppPromotionAttribution(input.appId);
	if (!attribution) return;
	window.fbq?.(
		"track",
		"AddToCart",
		{ content_ids: [input.productKey], content_type: "product" },
		{ eventID: input.eventId },
	);
	await sdk.apps.recordPromotionEvent(
		input.appId,
		attribution.promotionId,
		eventInput("paywall_viewed", input.eventId, {
			productKey: input.productKey,
		}),
	);
}

export function reportAppPromotionCheckoutStarted(input: {
	productKey: string;
	eventId: string;
	value?: number;
	currency?: string;
}) {
	window.fbq?.(
		"track",
		"InitiateCheckout",
		{
			content_ids: [input.productKey],
			content_type: "product",
			...(input.value !== undefined ? { value: input.value } : {}),
			...(input.currency ? { currency: input.currency } : {}),
		},
		{ eventID: input.eventId },
	);
}

export async function reportAppPromotionRegistration() {
	const attribution = readAppPromotionAttribution();
	if (!attribution) return;
	const context = getAppPromotionCheckoutAttribution(attribution.appId);
	const result = await sdk.apps.recordPromotionRegistration(
		attribution.appId,
		attribution.promotionId,
		context
			? {
					sourceUrl: context.sourceUrl,
					fbp: context.fbp,
					fbc: context.fbc,
				}
			: undefined,
	);
	if (
		result.reported &&
		result.eventId &&
		result.browser?.provider === "meta"
	) {
		initializeMetaPixel(result.browser.pixelId);
		window.fbq?.(
			"track",
			"CompleteRegistration",
			{},
			{ eventID: result.eventId },
		);
	}
}

export async function reportAppPromotionReady(
	appId: string,
	promotionId: string,
	runtime: AppPromotionEventResponse,
) {
	const eventId = crypto.randomUUID();
	if (runtime.browser?.provider === "meta") {
		initializeMetaPixel(runtime.browser.pixelId);
		window.fbq?.(
			"track",
			"ViewContent",
			{ content_ids: [appId], content_type: "product" },
			{ eventID: eventId },
		);
	}
	await sdk.apps.recordPromotionEvent(
		appId,
		promotionId,
		eventInput("ready", eventId),
	);
}
