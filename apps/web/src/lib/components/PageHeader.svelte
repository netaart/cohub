<script lang="ts">
import { Menu } from "lucide-svelte";
import type { Snippet } from "svelte";
import { uiState } from "#lib/stores/ui.svelte.ts";

const {
	left,
	right,
}: {
	left: Snippet;
	right?: Snippet;
} = $props();
</script>

<header class="lg:h-10 h-11 flex items-center justify-between lg:px-4 px-3 border-b border-border-subtle shrink-0 bg-bg-primary">
  <div class="flex items-center lg:gap-2 gap-1.5 min-w-0 flex-1 overflow-hidden">
    <!-- Mobile menu button — hidden on desktop -->
    <button
      type="button"
      class="lg:hidden flex items-center justify-center w-9 h-9 -ml-0.5 rounded-[5px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors shrink-0"
      onclick={() => uiState.mobileDrawerOpen = !uiState.mobileDrawerOpen}
      aria-label="Toggle navigation"
    >
      <Menu class="w-5 h-5" />
    </button>
    {@render left()}
  </div>

  {#if right}
    <div class="flex items-center gap-1 shrink-0 overflow-visible">
      {@render right()}
    </div>
  {/if}
</header>
