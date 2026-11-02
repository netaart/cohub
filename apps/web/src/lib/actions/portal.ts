/** Mount a node under document.body so it escapes local stacking/overflow. */
export function portal(node: HTMLElement) {
	if (typeof document === "undefined") return {};
	document.body.appendChild(node);
	return {
		destroy() {
			node.remove();
		},
	};
}

type FloatOptions = {
	/** Anchor element used for fixed positioning. */
	getAnchor: () => HTMLElement | null | undefined;
	/** Preferred placement. */
	placement?: "right-start" | "bottom-end" | "bottom-start" | "top-start";
	/** Gap between anchor and panel in px. */
	gap?: number;
	/** Fixed panel width in px (optional). */
	width?: number;
	/** z-index for the floated panel. */
	zIndex?: number;
	/**
	 * right-start: with no room on either side, stack below (or above) the anchor instead of covering it.
	 * On narrow screens "above" can overlap the menu the anchor sits in; staying in the viewport wins.
	 */
	stackWhenCramped?: boolean;
};

function isUsableAnchor(el: HTMLElement | null | undefined): el is HTMLElement {
	if (!el || typeof window === "undefined") return false;
	// Hidden / display:none nodes report empty client rects.
	const rect = el.getBoundingClientRect();
	return rect.width > 0 || rect.height > 0;
}

/**
 * Portals node to body and keeps it fixed next to an anchor.
 * Escapes overflow:hidden and local stacking contexts.
 */
export function floatNear(
	node: HTMLElement,
	options: FloatOptions,
): { update: (next: FloatOptions) => void; destroy: () => void } {
	let opts = options;
	let raf = 0;
	let tries = 0;

	function place() {
		const anchor = opts.getAnchor();
		if (!isUsableAnchor(anchor)) {
			// Anchor may not be measured yet (first paint / dual mobile+desktop mounts).
			if (tries < 8) {
				tries += 1;
				raf = requestAnimationFrame(place);
			}
			return;
		}
		tries = 0;

		const rect = anchor.getBoundingClientRect();
		const gap = opts.gap ?? 8;
		const zIndex = opts.zIndex ?? 120;
		const width = opts.width;
		const placement = opts.placement ?? "right-start";
		const pad = 8;

		node.style.position = "fixed";
		node.style.zIndex = String(zIndex);
		node.style.margin = "0";
		node.style.transform = "";
		node.style.right = "auto";
		node.style.bottom = "auto";
		if (width) node.style.width = `${width}px`;

		// Measure after width is applied.
		const panelRect = node.getBoundingClientRect();
		const panelW = width ?? (panelRect.width || 280);
		const panelH = panelRect.height || 200;

		let top = rect.top;
		let left = rect.right + gap;

		if (placement === "bottom-end") {
			top = rect.bottom + gap;
			left = rect.right - panelW;
		} else if (placement === "bottom-start") {
			top = rect.bottom + gap;
			left = rect.left;
		} else if (placement === "top-start") {
			top = rect.top - gap - panelH;
			left = rect.left;
		} else {
			// right-start: prefer right of anchor; flip left if needed
			top = rect.top;
			left = rect.right + gap;
			if (left + panelW > window.innerWidth - pad) {
				left = rect.left - gap - panelW;
			}
			if (opts.stackWhenCramped && left < pad) {
				left = rect.right - panelW;
				const below = rect.bottom + gap;
				top =
					below + panelH <= window.innerHeight - pad
						? below
						: rect.top - gap - panelH;
			}
		}

		// Vertical flip for bottom placements near viewport bottom.
		if (
			placement.startsWith("bottom") &&
			top + panelH > window.innerHeight - pad
		) {
			top = rect.top - gap - panelH;
		}

		top = Math.min(
			Math.max(pad, top),
			Math.max(pad, window.innerHeight - panelH - pad),
		);
		left = Math.min(
			Math.max(pad, left),
			Math.max(pad, window.innerWidth - panelW - pad),
		);

		node.style.top = `${Math.round(top)}px`;
		node.style.left = `${Math.round(left)}px`;
	}

	function schedule() {
		cancelAnimationFrame(raf);
		raf = requestAnimationFrame(place);
	}

	const portalLifecycle = portal(node);
	// Keep the node out of flow from the start: if the anchor is not measurable
	// yet, an unpositioned portal would sit in document flow and grow the page.
	node.style.position = "fixed";
	place();
	schedule();

	const resizeObserver =
		typeof ResizeObserver !== "undefined"
			? new ResizeObserver(() => schedule())
			: null;
	resizeObserver?.observe(node);

	window.addEventListener("resize", schedule);
	window.addEventListener("scroll", schedule, true);

	return {
		update(next: FloatOptions) {
			opts = next;
			tries = 0;
			schedule();
		},
		destroy() {
			cancelAnimationFrame(raf);
			resizeObserver?.disconnect();
			window.removeEventListener("resize", schedule);
			window.removeEventListener("scroll", schedule, true);
			portalLifecycle.destroy?.();
		},
	};
}
