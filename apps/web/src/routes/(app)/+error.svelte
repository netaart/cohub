<script lang="ts">
import {
	type AccessState,
	classifyAccessError,
} from "#lib/access/access-state.ts";
import AccessStateView from "#lib/components/AccessStateView.svelte";
import { authStore } from "#lib/stores/auth.svelte.ts";
import { page } from "$app/state";

const error = $derived(page.error);
const status = $derived(page.status);

const accessState = $derived.by<AccessState>(() => {
	if (!error) return { kind: "loading" };
	const state = classifyAccessError(error, {
		isAuthenticated: authStore.isAuthenticated,
	});
	// SvelteKit may report a generic error with a 404 status even when the
	// error object itself isn't an HttpError — fall back to status code.
	if (state.kind === "error") {
		if (status === 404) return { kind: "not-found" };
		if (status === 403)
			return { kind: "forbidden", isAuthenticated: authStore.isAuthenticated };
		if (status === 401) return { kind: "unauthorized" };
	}
	return state;
});
</script>

<main class="flex min-h-full flex-col bg-bg-primary text-text-primary">
	<AccessStateView state={accessState} />
</main>
