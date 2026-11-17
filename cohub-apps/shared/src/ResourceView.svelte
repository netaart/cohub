<script lang="ts">
import { untrack } from "svelte";
import type { ResourceViewModule, ViewProps } from "./view-types.ts";

let { view, ...props }: ViewProps & { view: Promise<ResourceViewModule> } = $props();
// A blur/change event from the departing form must never write into its successor.
const updateDraft = untrack(() => props.updateDraft);
</script>

{#await view then module}<module.default {...props} {updateDraft} />{/await}
