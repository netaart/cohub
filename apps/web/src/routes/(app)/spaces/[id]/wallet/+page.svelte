<script lang="ts">
import SpaceWallet from "#lib/features/billing/SpaceWallet.svelte";

const { data }: { data: { spaceId: string } } = $props();
</script>

{#key data.spaceId}<SpaceWallet spaceId={data.spaceId} />{/key}
