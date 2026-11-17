<script lang="ts">
import type { Snippet } from "svelte";
import DocsShell from "#lib/components/docs/DocsShell.svelte";

type Props = {
	data: {
		locale: "en" | "zh";
		currentSlug: string;
		sections: import("#lib/docs/index.ts").DocsSection[];
		searchEntries: import("#lib/docs/index.ts").DocsSearchEntry[];
	};
	children: Snippet;
};

let { data, children }: Props = $props();
</script>

<DocsShell {data}>{@render children()}</DocsShell>
