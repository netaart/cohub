<script lang="ts">
import type { HarnessKind } from "@cohub/protocol/runtime";
import { Monitor } from "lucide-svelte";
import claude from "$lib/assets/harness-icons/claude.svg?url";
import codex from "$lib/assets/harness-icons/codex.svg?url";
import pi from "$lib/assets/harness-icons/pi.svg?url";
import workbuddy from "$lib/assets/harness-icons/workbuddy.svg?url";

// Monochrome marks are masked so they follow the text color in both themes.
const icons: Partial<Record<HarnessKind, { url: string; mono?: boolean }>> = {
	cohub: { url: "/favicon.svg" },
	pi: { url: pi, mono: true },
	codex: { url: codex },
	claude: { url: claude },
	workbuddy: { url: workbuddy },
};
const { harness, size = 16 }: { harness: HarnessKind; size?: number } =
	$props();
const icon = $derived(icons[harness]);
</script>

{#if icon?.mono}
	<span class="harness-icon mono" style:width="{size}px" style:height="{size}px" style:--harness-icon={`url("${icon.url}")`} aria-hidden="true"></span>
{:else if icon}
	<img class="harness-icon" src={icon.url} alt="" width={size} height={size} aria-hidden="true" draggable="false" />
{:else}
	<Monitor class="shrink-0" size={size} aria-hidden="true" />
{/if}

<style>
.harness-icon { display: inline-block; flex: none; border-radius: 3px; }
.mono { background-color: currentColor; mask: var(--harness-icon) center / contain no-repeat; -webkit-mask: var(--harness-icon) center / contain no-repeat; }
</style>
