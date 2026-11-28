<script lang="ts">
import LibraryInbox from "#lib/features/library/LibraryInbox.svelte";
import LibraryPage from "#lib/features/library/LibraryPage.svelte";
import { page } from "$app/state";
</script>

{#if page.params.entity === "inbox"}
	<LibraryInbox />
{:else}
	<LibraryPage />
{/if}
