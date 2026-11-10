<script lang="ts">
import { onMount } from "svelte";
import { resolveSessionReplyRuntime } from "$lib/board/board-session-reply";
import type { BoardEditor } from "$lib/board/editor.svelte";
import ComposerSubmitButton from "$lib/components/composer/ComposerSubmitButton.svelte";
import ComposerSurface from "$lib/components/composer/ComposerSurface.svelte";
import {
	getComposerKeyAction,
	isMobileComposerInput,
} from "$lib/composer-keyboard";
import { getLocale } from "$lib/i18n/locale.svelte";
import { isComposingKeyboardEvent } from "$lib/keyboard";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { sessionStore } from "$lib/stores/session-store";

const {
	editor,
	spaceId,
	sessionId,
	onClose,
}: {
	editor: BoardEditor;
	spaceId: string;
	sessionId: string;
	onClose: () => void;
} = $props();

const MIN_WIDTH = 280;
const MAX_WIDTH = 440;
const GAP = 14;

const locale = $derived(getLocale());
let textarea = $state<HTMLTextAreaElement | null>(null);
let value = $state("");
let sending = $state(false);
let failed = $state(false);
let runtime: ReturnType<typeof resolveSessionReplyRuntime> | null = null;

const position = $derived.by(() => {
	const bounds = editor.bounds;
	if (!bounds) return null;
	const { x, y, zoom } = editor.camera;
	return {
		left: bounds.x * zoom + x,
		top: (bounds.y + bounds.height) * zoom + y + GAP,
		width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, bounds.width * zoom)),
	};
});

onMount(() => {
	runtime = resolveSessionReplyRuntime(spaceId, sessionId);
	textarea?.focus();
});

async function send() {
	const text = value.trim();
	if (!text || sending) return;
	sending = true;
	failed = false;
	try {
		const response = await sdk.space(spaceId).prompt({
			sessionId,
			content: [{ type: "text", text }],
			clientMessageId: crypto.randomUUID(),
			intent: "followup",
			accessMode: "full_access",
			schedule: { mode: "immediate" },
			...(await (runtime ?? resolveSessionReplyRuntime(spaceId, sessionId))),
		});
		if (response.mode === "immediate") {
			if (response.session) sessionStore.merge(response.session);
			sessionStore.applyTurn(response.turn);
		}
		value = "";
		onClose();
	} catch {
		failed = true;
	} finally {
		sending = false;
	}
}

function handleKeydown(event: KeyboardEvent) {
	if (event.key === "Escape" && !isComposingKeyboardEvent(event)) {
		event.preventDefault();
		onClose();
		return;
	}
	if (
		getComposerKeyAction(event, { mobile: isMobileComposerInput() }) ===
		"submit"
	) {
		event.preventDefault();
		void send();
	}
}
</script>

{#if position}
	<div
		class="board-session-reply"
		style:left="{position.left}px"
		style:top="{position.top}px"
		style:width="{position.width}px"
	>
		<ComposerSurface onsubmit={() => void send()}>
			<div class="flex items-end gap-2">
				<textarea
					bind:this={textarea}
					bind:value
					rows="1"
					class="reply-input"
					placeholder={m.board_session_reply_placeholder({}, { locale })}
					aria-label={m.board_session_reply({}, { locale })}
					aria-invalid={failed || undefined}
					readonly={sending}
					onkeydown={handleKeydown}
					oninput={() => {
						failed = false;
					}}
				></textarea>
				<ComposerSubmitButton
					label={m.board_session_reply({}, { locale })}
					disabled={!value.trim()}
					loading={sending}
				/>
			</div>
		</ComposerSurface>
		{#if failed}
			<p class="reply-error" role="alert">
				{m.board_session_reply_failed({}, { locale })}
			</p>
		{/if}
	</div>
{/if}

<style>
	.board-session-reply {
		position: absolute;
		z-index: 24;
		animation: reply-in 160ms var(--ease-out);
	}
	.reply-input {
		flex: 1;
		min-width: 0;
		min-height: 36px;
		max-height: 132px;
		padding: 8px 6px;
		resize: none;
		border: 0;
		outline: none;
		background: transparent;
		color: var(--text-primary);
		font-size: 14px;
		line-height: 20px;
		field-sizing: content;
	}
	.reply-input::placeholder {
		color: var(--text-placeholder);
	}
	.reply-error {
		margin-top: 6px;
		padding: 0 6px;
		color: var(--color-status-error);
		font-size: 12px;
	}
	@keyframes reply-in {
		from {
			opacity: 0;
			translate: 0 -4px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.board-session-reply {
			animation: none;
		}
	}
</style>
