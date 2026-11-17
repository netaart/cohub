<script lang="ts">
import type { RuntimeSessionRecoveryStatus } from "@neta-art/cohub";
import { AlertTriangle, Loader2, Square } from "lucide-svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import { sdk } from "#lib/sdk.ts";

const {
	spaceId,
	sessionId,
	turnId,
}: { spaceId: string; sessionId: string; turnId: string } = $props();
const locale = $derived(getLocale());
let status = $state<RuntimeSessionRecoveryStatus | null>(null);
let confirmed = $state(false);
let busy = $state(false);
let submitted = $state(false);
let error = $state("");

$effect(() => {
	const target = { spaceId, sessionId, turnId };
	status = null;
	confirmed = false;
	submitted = false;
	error = "";
	void sdk
		.space(target.spaceId)
		.getSessionRuntime(target.sessionId)
		.then((value) => {
			if (
				spaceId === target.spaceId &&
				sessionId === target.sessionId &&
				turnId === target.turnId
			)
				status = value;
		})
		.catch((cause) => {
			if (
				spaceId === target.spaceId &&
				sessionId === target.sessionId &&
				turnId === target.turnId
			)
				error = cause instanceof Error ? cause.message : String(cause);
		});
});

async function confirmStopped() {
	if (
		!status?.pending ||
		status.turnId !== turnId ||
		!status.canManage ||
		!confirmed ||
		busy ||
		submitted
	)
		return;
	busy = true;
	error = "";
	try {
		await sdk.space(spaceId).confirmRuntimeStopped(sessionId, {
			confirmed: true,
			expectedTurnId: turnId,
			revision: status.revision,
		});
		submitted = true;
		confirmed = false;
	} catch (cause) {
		error = cause instanceof Error ? cause.message : String(cause);
	} finally {
		busy = false;
	}
}
</script>

<div class="border-t border-error-soft/30 bg-error-bg px-3 py-2 text-sm">
	<div class="mx-auto flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-2">
		<AlertTriangle class="h-4 w-4 shrink-0 text-error-soft" />
		<span class="min-w-0 flex-1 text-text-secondary">{m.runtime_session_attention({}, { locale })}</span>
		{#if status?.pending && status.turnId === turnId && status.canManage && !submitted}
			<label class="flex items-center gap-2 text-text-secondary">
				<input type="checkbox" bind:checked={confirmed} disabled={busy} />
				<span>{m.runtime_confirm_stopped({}, { locale })}</span>
			</label>
			<button type="button" class="danger-key min-h-9 gap-2 px-3" disabled={!confirmed || busy} onclick={confirmStopped}>
				{#if busy}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Square class="h-3.5 w-3.5" />{/if}
				{m.runtime_end_unknown({}, { locale })}
			</button>
		{/if}
		{#if submitted}<span role="status" class="text-text-secondary">{m.runtime_confirmation_queued({}, { locale })}</span>{/if}
		{#if error}<span role="alert" class="w-full break-words text-error-soft">{error}</span>{/if}
	</div>
</div>
