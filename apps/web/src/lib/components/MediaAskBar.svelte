<script lang="ts">
import { ArrowUp, Check } from "lucide-svelte";
import Spinner from "#lib/components/Spinner.svelte";
import {
	getComposerKeyAction,
	isMobileComposerInput,
} from "#lib/composer-keyboard.ts";
import type { MediaAskTarget } from "#lib/media/media-ask.svelte.ts";

let {
	target,
	placeholder,
	sendLabel,
	sentLabel,
	failedLabel,
	inputEl = $bindable(null),
}: {
	target: MediaAskTarget;
	placeholder: string;
	sendLabel: string;
	sentLabel: string;
	failedLabel: string;
	inputEl?: HTMLTextAreaElement | null;
} = $props();

const MAX_HEIGHT_PX = 120;
const SENT_MS = 1600;

let sent = $state(false);
let failed = $state(false);
let sentTimer: ReturnType<typeof setTimeout> | null = null;
const canSend = $derived(
	!target.sending && (target.draft.trim().length > 0 || target.hasMarks),
);

async function send() {
	if (!canSend) return;
	failed = false;
	if (!(await target.send())) {
		failed = true;
		return;
	}
	sent = true;
	if (sentTimer) clearTimeout(sentTimer);
	sentTimer = setTimeout(() => (sent = false), SENT_MS);
}

function onKeydown(event: KeyboardEvent) {
	const action = getComposerKeyAction(event, {
		mobile: isMobileComposerInput(),
	});
	if (action !== "submit") return;
	event.preventDefault();
	void send();
}

$effect(() => {
	void target.draft;
	const el = inputEl;
	if (!el) return;
	el.style.height = "auto";
	el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
});

$effect(() => () => {
	if (sentTimer) clearTimeout(sentTimer);
});
</script>

{#if failed}
	<p class="text-center text-[12px] text-overlay-control-text/70" role="alert">{failedLabel}</p>
{/if}
<form
	class="flex items-end gap-2 rounded-[22px] bg-overlay-control py-1.5 pr-1.5 pl-4"
	onsubmit={(event) => {
		event.preventDefault();
		void send();
	}}
>
	<textarea
		bind:this={inputEl}
		bind:value={target.draft}
		rows="1"
		class="min-h-8 flex-1 resize-none bg-transparent py-1.5 text-[14px] leading-5 text-overlay-control-text outline-none placeholder:text-overlay-control-text/55"
		placeholder={sent ? sentLabel : placeholder}
		aria-label={placeholder}
		enterkeyhint="send"
		onkeydown={onKeydown}
		oninput={() => (failed = false)}
	></textarea>
	<button
		type="submit"
		class="primary-key flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-brand-contrast-fg hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-overlay-control-text disabled:bg-overlay-control-hover disabled:text-overlay-control-text/45"
		disabled={!canSend}
		title={sent ? sentLabel : sendLabel}
		aria-label={sent ? sentLabel : sendLabel}
	>
		{#if target.sending}
			<Spinner class="h-4 w-4" />
		{:else if sent}
			<Check class="h-4 w-4" />
		{:else}
			<ArrowUp class="h-4 w-4" />
		{/if}
	</button>
</form>
