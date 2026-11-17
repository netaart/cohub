<script lang="ts">
import InvitePage from "$lib/features/invitations/InvitePage.svelte";

const props: { params: { token: string } } = $props();
</script>

<InvitePage token={props.params.token} />
