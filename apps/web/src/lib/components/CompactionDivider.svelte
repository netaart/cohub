<script lang="ts">
import type {
	ContextCompactionMeta,
	SessionTurnRecord,
} from "@cohub/protocol/model";
import SystemCompactionNotice from "#lib/components/SystemCompactionNotice.svelte";

type Props = {
	turn: SessionTurnRecord;
};

const { turn }: Props = $props();

const compaction = $derived(
	(turn.meta?.compaction as
		| (Partial<ContextCompactionMeta> & Record<string, unknown>)
		| undefined) ?? {},
);
const summary = $derived(
	turn.assistantContent?.[0]?.type === "system_note"
		? turn.assistantContent[0].text
		: "",
);
</script>

<SystemCompactionNotice
	variant="turn-boundary"
	{compaction}
	{summary}
	usage={turn.finalUsage}
	durationMs={turn.durationMs}
/>
