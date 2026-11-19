const FADE_ATTRIBUTE = "data-markdown-fade";
const FADE_MS = 180;

function parseHtml(html: string) {
	const template = document.createElement("template");
	template.innerHTML = html;
	return template.content;
}

function removeRange(from: Node | null, until: Node | null) {
	let node = from;
	while (node && node !== until) {
		const next: Node | null = node.nextSibling;
		node.parentNode?.removeChild(node);
		node = next;
	}
}

const isFadeSpan = (node: Node) =>
	node instanceof HTMLElement && node.getAttribute(FADE_ATTRIBUTE) === "text";

const isTextLike = (node: Node) =>
	node.nodeType === Node.TEXT_NODE || isFadeSpan(node);

function syncAttributes(element: Element, wanted: Element) {
	for (let index = element.attributes.length - 1; index >= 0; index -= 1) {
		const { name } = element.attributes[index];
		if (name !== FADE_ATTRIBUTE && !wanted.hasAttribute(name))
			element.removeAttribute(name);
	}
	for (const { name, value } of wanted.attributes) {
		if (element.getAttribute(name) !== value) element.setAttribute(name, value);
	}
}

const MEDIA_SELECTOR = "img, video, audio, iframe";
const ATTACHED = "markdownAttached";

function renderedText(node: Node) {
	if (!(node instanceof Element)) return node.textContent ?? "";
	const attached = node.querySelectorAll("[data-markdown-attached]");
	if (attached.length === 0) return node.textContent ?? "";
	const copy = node.cloneNode(true) as Element;
	for (const extra of copy.querySelectorAll("[data-markdown-attached]"))
		extra.remove();
	return copy.textContent ?? "";
}

const isMedia = (node: Node): node is Element =>
	node instanceof Element && node.matches(MEDIA_SELECTOR);

// Settled blocks and the streaming tail share one parent; the tail is patched in place.
export function createMarkdownRegion(root: HTMLElement) {
	const liveStart = document.createComment("live");
	let blocks: { html: string; marker: Comment }[] = [];
	root.replaceChildren(liveStart);

	const renderedMedia = new WeakMap<Element, string>();
	function attachedAfter(node: Node) {
		const attached: HTMLElement[] = [];
		for (
			let next = node.nextSibling;
			next instanceof HTMLElement && ATTACHED in next.dataset;
			next = next.nextSibling
		)
			attached.push(next);
		return attached;
	}

	function adoptLiveMedia(block: DocumentFragment) {
		const live = new Map<string, Element[]>();
		for (let node = liveStart.nextSibling; node; node = node.nextSibling) {
			if (!(node instanceof Element)) continue;
			for (const media of [node, ...node.querySelectorAll(MEDIA_SELECTOR)]) {
				const html = renderedMedia.get(media);
				if (html) live.set(html, [...(live.get(html) ?? []), media]);
			}
		}
		if (live.size === 0) return;
		const promoted = new Set<Node>();
		for (const media of block.querySelectorAll(MEDIA_SELECTOR)) {
			const match = live.get(media.outerHTML)?.shift();
			if (!match) continue;
			let top: Node = match;
			while (top.parentNode && top.parentNode !== root) top = top.parentNode;
			promoted.add(top);
			media.replaceWith(match, ...attachedAfter(match));
		}
		// Blocks settle whole; a misjudged node returns with the next tail patch.
		for (const node of promoted)
			if (node !== root && node.parentNode === root) root.removeChild(node);
	}

	function trackMedia(node: Node) {
		if (!(node instanceof Element)) return;
		if (isMedia(node)) renderedMedia.set(node, node.outerHTML);
		for (const media of node.querySelectorAll(MEDIA_SELECTOR))
			renderedMedia.set(media, media.outerHTML);
	}

	const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
	const fading: { node: HTMLElement; until: number }[] = [];
	let timer: ReturnType<typeof setTimeout> | null = null;
	let animate = false;

	function settleFades(all = false) {
		timer = null;
		const now = performance.now();
		const parents = new Set<Node>();
		let kept = 0;
		for (const entry of fading) {
			if (!all && entry.until > now && entry.node.isConnected) {
				fading[kept++] = entry;
				continue;
			}
			const { node } = entry;
			if (!isFadeSpan(node)) {
				node.removeAttribute(FADE_ATTRIBUTE);
				continue;
			}
			const parent = node.parentNode;
			if (!parent) continue;
			while (node.firstChild) parent.insertBefore(node.firstChild, node);
			parent.removeChild(node);
			parents.add(parent);
		}
		fading.length = kept;
		for (const parent of parents) parent.normalize();
		if (fading.length > 0)
			timer = setTimeout(settleFades, fading[0].until - now + 16);
	}

	function track(node: HTMLElement) {
		fading.push({ node, until: performance.now() + FADE_MS });
		timer ??= setTimeout(settleFades, FADE_MS + 16);
	}

	function appendText(parent: Node, text: string, before: Node | null) {
		const previous = before ? before.previousSibling : parent.lastChild;
		if (!animate || !text.trim() || !(parent instanceof Element)) {
			if (previous?.nodeType === Node.TEXT_NODE)
				(previous as Text).appendData(text);
			else parent.insertBefore(document.createTextNode(text), before);
			return;
		}
		const span = document.createElement("span");
		span.setAttribute(FADE_ATTRIBUTE, "text");
		span.textContent = text;
		parent.insertBefore(span, before);
		track(span);
	}

	function fadeIn(node: Node) {
		if (!animate) return;
		if (node instanceof HTMLElement) {
			node.setAttribute(FADE_ATTRIBUTE, "block");
			track(node);
		} else if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
			const span = document.createElement("span");
			span.setAttribute(FADE_ATTRIBUTE, "text");
			node.parentNode?.replaceChild(span, node);
			span.append(node);
			track(span);
		}
	}

	function patchChildren(parent: Node, incoming: Node, first: Node | null) {
		let current = first;
		let target = incoming.firstChild;
		while (target) {
			const nextTarget: ChildNode | null = target.nextSibling;
			if (target.nodeType === Node.TEXT_NODE) {
				const value = target.textContent ?? "";
				let previous = "";
				let end = current;
				while (end && isTextLike(end)) {
					previous += end.textContent ?? "";
					end = end.nextSibling;
				}
				if (current !== end && value.startsWith(previous)) {
					if (value.length > previous.length)
						appendText(parent, value.slice(previous.length), end);
				} else {
					removeRange(current, end);
					parent.insertBefore(target, end);
					if (!previous) fadeIn(target);
				}
				current = end;
			} else if (
				current instanceof Element &&
				isMedia(target) &&
				renderedMedia.get(current) === target.outerHTML
			) {
				current = attachedAfter(current).at(-1) ?? current;
				current = current.nextSibling;
			} else if (
				current instanceof Element &&
				target instanceof Element &&
				current.nodeName === target.nodeName &&
				!isFadeSpan(current) &&
				!isMedia(target)
			) {
				syncAttributes(current, target);
				patchChildren(current, target, current.firstChild);
				current = current.nextSibling;
			} else {
				const next = current?.nextSibling ?? null;
				const replaced = current?.textContent ?? "";
				trackMedia(target);
				parent.insertBefore(target, current);
				if (current) parent.removeChild(current);
				if (!replaced) fadeIn(target);
				current = next;
			}
			target = nextTarget;
		}
		removeRange(current, null);
	}

	function dropPromotedTail(incoming: DocumentFragment) {
		const first = incoming.firstChild;
		const text = first?.textContent ?? "";
		for (
			let node = liveStart.nextSibling;
			first && node;
			node = node.nextSibling
		) {
			if (node.nodeName !== first.nodeName) continue;
			if (!text.startsWith(renderedText(node))) continue;
			removeRange(liveStart.nextSibling, node);
			return;
		}
	}

	return {
		setBlocks(next: readonly string[]) {
			const kept: typeof blocks = [];
			let cursor = 0;
			for (const html of next) {
				let match = cursor;
				while (match < blocks.length && blocks[match].html !== html) match += 1;
				if (match < blocks.length) {
					removeRange(
						blocks[cursor]?.marker ?? liveStart,
						blocks[match].marker,
					);
					kept.push(blocks[match]);
					cursor = match + 1;
					continue;
				}
				const before = blocks[cursor]?.marker ?? liveStart;
				const marker = document.createComment("");
				const block = parseHtml(html);
				adoptLiveMedia(block);
				root.insertBefore(marker, before);
				root.insertBefore(block, before);
				kept.push({ html, marker });
			}
			removeRange(blocks[cursor]?.marker ?? liveStart, liveStart);
			blocks = kept;
		},
		setTail(html: string, streaming: boolean) {
			animate = streaming && !motion.matches;
			if (!animate && fading.length > 0) settleFades(true);
			const incoming = parseHtml(html);
			dropPromotedTail(incoming);
			patchChildren(root, incoming, liveStart.nextSibling);
		},
		isLive(node: Node) {
			return Boolean(
				liveStart.compareDocumentPosition(node) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			);
		},
		dispose() {
			if (timer) clearTimeout(timer);
			timer = null;
			fading.length = 0;
		},
	};
}
