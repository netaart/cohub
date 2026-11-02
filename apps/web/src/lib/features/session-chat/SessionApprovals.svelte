<script lang="ts">
import { type HarnessKind, harnessLabel } from "@cohub/protocol/runtime";
import type { ApprovalDecision, SessionApproval } from "@neta-art/cohub";
import { FileDiff, Loader2, TerminalSquare } from "lucide-svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { subscribeSpaceChannel } from "./space-channel";

const {
	spaceId,
	sessionId,
	harnessOf,
}: {
	spaceId: string;
	sessionId: string;
	harnessOf: (turnId: string) => HarnessKind;
} = $props();
const locale = $derived(getLocale());
let approvals = $state<SessionApproval[]>([]);
let canDecide = $state(false);
let deciding = $state<string | null>(null);
let error = $state("");

const decisionLabel = (decision: ApprovalDecision) =>
	({
		accept: m.runtime_approval_accept,
		accept_for_session: m.runtime_approval_accept_for_session,
		decline: m.runtime_approval_decline,
	})[decision]({}, { locale });

const requestLabel = (approval: SessionApproval) =>
	(approval.kind === "command"
		? m.runtime_approval_request_command
		: m.runtime_approval_request_file_change)(
		{ harness: harnessLabel(harnessOf(approval.turnId)) },
		{ locale },
	);

$effect(() => {
	const target = { spaceId, sessionId };
	let latest = 0;
	const load = () => {
		const request = ++latest;
		void sdk
			.space(target.spaceId)
			.getSessionApprovals(target.sessionId)
			.then((value) => {
				if (request !== latest) return;
				approvals = value.approvals;
				canDecide = value.canDecide;
			})
			.catch(() => {
				// The list refreshes on the next change; a stale card fails clearly when answered.
			});
	};
	approvals = [];
	error = "";
	load();
	const unsubscribe = subscribeSpaceChannel(target.spaceId, (event) => {
		if (
			event.type === "space.session.approvals.changed" &&
			event.sessionId === target.sessionId
		)
			load();
	});
	// Expired cards are declined by the Runtime; drop them without waiting for its notice.
	const timer = setInterval(() => {
		const now = Date.now();
		if (approvals.some((approval) => Date.parse(approval.expiresAt) <= now))
			approvals = approvals.filter(
				(approval) => Date.parse(approval.expiresAt) > now,
			);
	}, 30_000);
	return () => {
		latest += 1;
		unsubscribe();
		clearInterval(timer);
	};
});

async function decide(approval: SessionApproval, decision: ApprovalDecision) {
	if (deciding) return;
	deciding = approval.id;
	error = "";
	try {
		await sdk.space(spaceId).decideApproval(sessionId, approval.id, decision);
		approvals = approvals.filter((item) => item.id !== approval.id);
	} catch (cause) {
		error = cause instanceof Error ? cause.message : String(cause);
	} finally {
		deciding = null;
	}
}
</script>

{#each approvals as approval (approval.id)}
	<div class="border-t border-border-subtle bg-bg-elevated px-3 py-2.5 text-sm" role="group" aria-label={requestLabel(approval)}>
		<div class="mx-auto flex max-w-3xl flex-col gap-2">
			<div class="flex min-w-0 items-center gap-2 text-text-primary">
				{#if approval.kind === "command"}<TerminalSquare class="h-4 w-4 shrink-0 text-text-tertiary" />{:else}<FileDiff class="h-4 w-4 shrink-0 text-text-tertiary" />{/if}
				<span class="font-medium">{requestLabel(approval)}</span>
			</div>
			{#if approval.command}
				<pre class="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-bg-hover px-2.5 py-1.5 font-mono text-[12px] text-text-secondary">{approval.command}</pre>
			{/if}
			{#if approval.paths?.length}
				<ul class="max-h-24 overflow-auto font-mono text-[12px] text-text-secondary">
					{#each approval.paths as path}<li class="truncate">{path}</li>{/each}
				</ul>
			{/if}
			{#if approval.reason || approval.cwd}
				<p class="break-words text-[12px] text-text-tertiary">{[approval.reason, approval.cwd].filter(Boolean).join(" · ")}</p>
			{/if}
			{#if canDecide}
				<div class="flex flex-wrap items-center gap-2">
					{#each approval.decisions as decision}
						<button type="button" class={`${decision === "accept" ? "primary-key" : decision === "decline" ? "danger-key" : "secondary-key"} min-h-9 gap-1.5 px-3`} disabled={deciding !== null} onclick={() => void decide(approval, decision)}>
							{#if deciding === approval.id && decision === "accept"}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
							{decisionLabel(decision)}
						</button>
					{/each}
				</div>
			{:else}
				<p class="text-[12px] text-text-tertiary" role="status">{m.runtime_approval_waiting({}, { locale })}</p>
			{/if}
			{#if error}<p role="alert" class="break-words text-[12px] text-error-soft">{error}</p>{/if}
		</div>
	</div>
{/each}
