<script lang="ts">
import type { BoardScriptSense } from "@neta-art/cohub/board";
import {
	BOARD_CONSENT_SENSES,
	type BoardConsentSense,
	type BoardStage,
} from "@neta-art/cohub/board/stage";
import { Camera, Circle, Compass, MapPin, Mic, Square, X } from "lucide-svelte";
import type { BoardSenseConsent } from "$lib/board/board-senses.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	stage,
	consent,
	recording = false,
	onRecord,
}: {
	stage: BoardStage | null;
	consent: BoardSenseConsent;
	recording?: boolean;
	onRecord?: () => void;
} = $props();

const locale = $derived(getLocale());
const ICONS = { microphone: Mic, camera: Camera, location: MapPin } as const;
const NO_STATES = {} as Record<BoardScriptSense, string>;

let wanted = $state.raw<readonly BoardScriptSense[]>([]);
let states = $state.raw<Record<BoardScriptSense, string>>(NO_STATES);
let dismissed = $state("");

$effect(() => {
	const senses = stage?.senses;
	if (!senses) return;
	const read = () => {
		wanted = senses.wanted;
		states = senses.states;
	};
	read();
	return senses.subscribe(read);
});

const consentSenses = $derived(
	BOARD_CONSENT_SENSES.filter((sense) => wanted.includes(sense)),
);
const asking = $derived(
	consentSenses.filter((sense) => states[sense] === "ask"),
);
const using = $derived(consentSenses.filter((sense) => states[sense] === "on"));
const motion = $derived(wanted.includes("motion") && states.motion === "ask");

function label(senses: readonly BoardConsentSense[]) {
	return new Intl.ListFormat(locale, { type: "conjunction" }).format(
		senses.map((sense) =>
			sense === "microphone"
				? m.app_devices_microphone({}, { locale })
				: sense === "camera"
					? m.app_devices_camera({}, { locale })
					: m.app_devices_location({}, { locale }),
		),
	);
}
</script>

{#if asking.length && asking.join() !== dismissed}
	<div class="board-sense board-sense--ask" role="status">
		{#each asking as sense (sense)}
			{@const Icon = ICONS[sense]}
			<Icon class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
		{/each}
		<span class="min-w-0">{m.board_senses_allow({ senses: label(asking) }, { locale })}</span>
		<button type="button" class="board-sense-action" onclick={() => consent.allow(asking)}>{m.app_devices_allow({}, { locale })}</button>
		<button type="button" class="board-sense-close" aria-label={m.common_close({}, { locale })} onclick={() => { dismissed = asking.join(); }}><X class="h-3 w-3" /></button>
	</div>
{:else if motion}
	<button type="button" class="board-sense" onclick={() => stage?.senses.unlock()}>
		<Compass class="h-3.5 w-3.5" aria-hidden="true" />
		{m.board_senses_motion({}, { locale })}
	</button>
{/if}
{#if using.length}
	{@const title = m.board_senses_active({ senses: label(using) }, { locale })}
	<button type="button" class="board-sense board-sense--using" {title} aria-label={title} onclick={() => { for (const sense of using) consent.revoke(sense); }}>
		{#each using as sense (sense)}
			{@const Icon = ICONS[sense]}
			<Icon class="h-3.5 w-3.5" aria-hidden="true" />
		{/each}
	</button>
{/if}
{#if onRecord && (recording || wanted.length)}
	<button type="button" class="board-sense" class:board-sense--recording={recording} aria-pressed={recording} onclick={onRecord}>
		{#if recording}<Square class="h-3 w-3" aria-hidden="true" />{:else}<Circle class="h-3 w-3" aria-hidden="true" />{/if}
		{recording ? m.board_input_stop({}, { locale }) : m.board_input_record({}, { locale })}
	</button>
{/if}

<style>
	.board-sense {
		display: inline-flex;
		max-width: min(92vw, 420px);
		align-items: center;
		gap: 6px;
		height: 32px;
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		background: var(--bg-elevated);
		padding: 0 6px 0 12px;
		color: var(--text-primary);
		font-size: 12px;
		font-weight: 500;
		white-space: nowrap;
		box-shadow: 0 8px 20px color-mix(in srgb, var(--overlay-scrim-strong) 12%, transparent);
		pointer-events: auto;
	}
	button.board-sense { padding: 0 14px; }
	button.board-sense:hover { background: var(--bg-hover); }
	.board-sense--ask {
		height: auto;
		min-height: 32px;
		border-radius: 16px;
		padding-block: 4px;
		white-space: normal;
		line-height: 1.35;
	}
	.board-sense--using { color: var(--brand-muted-fg); }
	.board-sense--recording { color: var(--color-error-soft); }
	.board-sense-action {
		border-radius: 999px;
		padding: 2px 8px;
		color: var(--brand-muted-fg);
		font-weight: 600;
	}
	.board-sense-action:hover,
	.board-sense-close:hover { background: var(--bg-hover); }
	.board-sense-close {
		display: inline-grid;
		place-items: center;
		width: 22px;
		height: 22px;
		border-radius: 999px;
		color: var(--text-tertiary);
	}
</style>
