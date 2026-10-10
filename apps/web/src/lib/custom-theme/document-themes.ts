import { notifyCustomThemeChanged } from "$lib/custom-theme/events";

const LAYERS = ["user", "space"] as const;
export type DocumentThemeLayer = (typeof LAYERS)[number];

const LAYER_ATTR = "data-cohub-custom-theme";
const SPACE_ACTIVE_ATTR = "data-cohub-space-style-active";
const SPACE_ID_ATTR = "data-space-id";

function layerNode(layer: DocumentThemeLayer) {
	return document.head.querySelector<HTMLStyleElement>(
		`style[${LAYER_ATTR}="${layer}"]`,
	);
}

function insertLayer(layer: DocumentThemeLayer, css: string) {
	const node = document.createElement("style");
	node.setAttribute(LAYER_ATTR, layer);
	node.textContent = css;
	const next = LAYERS.slice(LAYERS.indexOf(layer) + 1)
		.map(layerNode)
		.find(Boolean);
	document.head.insertBefore(node, next ?? null);
	return node;
}

function markSpace(spaceId: string | null) {
	const root = document.documentElement;
	if (spaceId) {
		root.setAttribute(SPACE_ACTIVE_ATTR, "true");
		root.setAttribute(SPACE_ID_ATTR, spaceId);
	} else {
		root.removeAttribute(SPACE_ACTIVE_ATTR);
		root.removeAttribute(SPACE_ID_ATTR);
	}
}

export function applyDocumentTheme(
	layer: DocumentThemeLayer,
	css: string | null,
	spaceId: string | null = null,
) {
	if (typeof document === "undefined") return;
	if (layer === "space") markSpace(css === null ? null : spaceId);
	let node = layerNode(layer);
	if ((node?.textContent ?? null) === css) return;
	if (css === null) {
		node?.remove();
	} else if (node) {
		node.textContent = css;
	} else {
		node = insertLayer(layer, css);
	}
	const notify = () => notifyCustomThemeChanged(spaceId);
	if (css?.includes("@import"))
		node?.addEventListener("load", notify, { once: true });
	notify();
}
