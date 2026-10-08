<script lang="ts">
import type { Snippet } from "svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import type { RelatedSessionView } from "$lib/related-sessions";
import type { RelatedSessionRef } from "$lib/sent-turns";
import { useSessionRelations } from "$lib/session-relations-context";
import { buildSpaceSessionRoute } from "$lib/space-routes";

type RelatedSessionLabel = {
	title: string | null;
	label: string;
	status: RelatedSessionView["status"];
};

type Props = {
	ref: RelatedSessionRef;
	class?: string;
	children: Snippet<[RelatedSessionLabel]>;
};

const { ref, class: className = "", children }: Props = $props();

const relations = useSessionRelations();
const locale = $derived(getLocale());

$effect(() => {
	relations?.request([ref]);
});

const view = $derived<RelatedSessionView>(
	relations?.session(ref) ?? { status: "unknown" },
);
const label = $derived.by<RelatedSessionLabel>(() => {
	const title =
		view.status === "ready"
			? (view.title ?? m.sidebar_new_chat({}, { locale }))
			: null;
	return {
		title,
		label:
			title ??
			(view.status === "unavailable"
				? m.sent_chat_unavailable({}, { locale })
				: m.sent_other_chat({}, { locale })),
		status: view.status,
	};
});
</script>

{#if view.status === "unavailable"}
	<span class={className} title={m.sent_chat_unavailable_hint({}, { locale })}
		>{@render children(label)}</span
	>
{:else}
	<a
		href={buildSpaceSessionRoute(ref.spaceId, ref.sessionId)}
		class={className}
		title={label.title ?? m.sent_open_chat({}, { locale })}
		>{@render children(label)}</a
	>
{/if}
