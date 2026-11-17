<script lang="ts">
import { onMount } from "svelte";
import { isComposingKeyboardEvent, isKeyboardClaimed } from "#lib/keyboard.ts";
import PreviewMarkHost from "./PreviewMarkHost.svelte";

/**
 * Global capture & mark entry: ⌘⇧S / Ctrl+Shift+S.
 * Captures the shared tab (prefer current tab) without requiring a preview panel.
 * Works while the composer is focused — same pattern as ⌘O / ⌘⇧U.
 */
let host: {
	triggerCapture?: () => void;
} | null = $state(null);

function isMarkHotkey(event: KeyboardEvent): boolean {
	if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) {
		return false;
	}
	return event.key.toLowerCase() === "s" || event.code === "KeyS";
}

function onKeydown(event: KeyboardEvent) {
	if (
		event.defaultPrevented ||
		isComposingKeyboardEvent(event) ||
		isKeyboardClaimed(event)
	)
		return;
	if (!isMarkHotkey(event)) return;
	event.preventDefault();
	event.stopPropagation();
	// Stay on the keydown stack so getDisplayMedia keeps the user gesture.
	host?.triggerCapture?.();
}

onMount(() => {
	window.addEventListener("keydown", onKeydown, { capture: true });
	return () => {
		window.removeEventListener("keydown", onKeydown, { capture: true });
	};
});
</script>

<PreviewMarkHost
	bind:this={host}
	allowViewport={true}
	showTrigger={false}
	target={null}
/>
