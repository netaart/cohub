export function isComposingKeyboardEvent(
	event: Pick<KeyboardEvent, "isComposing" | "key" | "keyCode">,
): boolean {
	return event.isComposing || event.key === "Process" || event.keyCode === 229;
}

export function isApplePlatform(): boolean {
	if (typeof navigator === "undefined") return false;
	return (
		/Mac|iPhone|iPad|iPod/.test(navigator.platform ?? "") ||
		/Mac OS X/.test(navigator.userAgent ?? "")
	);
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	return Boolean(
		target.closest(
			'input, textarea, select, [contenteditable="true"], [contenteditable=""]',
		),
	);
}

type KeyboardClaim = (event: KeyboardEvent) => boolean;

const CLAIM_ATTRIBUTE = "data-keyboard-claim";
const claims = new WeakMap<Element, KeyboardClaim>();

export function claimKeyboard(node: HTMLElement, claim: KeyboardClaim) {
	claims.set(node, claim);
	node.setAttribute(CLAIM_ATTRIBUTE, "");
	return () => {
		claims.delete(node);
		node.removeAttribute(CLAIM_ATTRIBUTE);
	};
}

export function isKeyboardClaimed(event: KeyboardEvent): boolean {
	if (!(event.target instanceof Element)) return false;
	const owner = event.target.closest(`[${CLAIM_ATTRIBUTE}]`);
	return owner ? (claims.get(owner)?.(event) ?? false) : false;
}
