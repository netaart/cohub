<script lang="ts">
import SpaceActivityView from "$lib/features/space/modules/SpaceActivityView.svelte";

let { data }: { data: { spaceId: string } } = $props();
</script>

{#key data.spaceId}
	<SpaceActivityView {data} />
{/key}
