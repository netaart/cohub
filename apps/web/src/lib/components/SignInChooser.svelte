<script lang="ts">
import type { HostSignInProvider } from "@cohub/protocol/host-bridge";
import { startHostSignIn } from "#lib/auth.ts";
import Dialog from "#lib/components/Dialog.svelte";
import Spinner from "#lib/components/Spinner.svelte";
import { hostPlatform } from "#lib/host-bridge.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import { signInChooser } from "#lib/sign-in-chooser.svelte.ts";

type Choice = HostSignInProvider | "email";

const locale = $derived(getLocale());
const labels: Record<Choice, () => string> = {
	google: () => m.sign_in_with_google({}, { locale }),
	apple: () => m.sign_in_with_apple({}, { locale }),
	facebook: () => m.sign_in_with_facebook({}, { locale }),
	email: () => m.sign_in_with_email({}, { locale }),
};
const apple = hostPlatform() === "ios" || hostPlatform() === "macos";
const choices: Choice[] = apple
	? ["apple", "google", "facebook", "email"]
	: ["google", "apple", "facebook", "email"];

let pending = $state<Choice | null>(null);
let failed = $state(false);
let attempt = 0;

async function choose(choice: Choice) {
	if (pending) return;
	const current = ++attempt;
	pending = choice;
	failed = false;
	const outcome = await startHostSignIn(
		signInChooser.redirectPath,
		choice === "email" ? undefined : choice,
	);
	if (current !== attempt) return;
	pending = null;
	if (outcome === "signedIn") close();
	else failed = outcome === "failed";
}

function close() {
	attempt++;
	pending = null;
	failed = false;
	signInChooser.close();
}
</script>

<Dialog open={signInChooser.open} onClose={close} title={m.sign_in_title({}, { locale })} maxWidth="360px" scrollable={false}>
	<div class="flex flex-col gap-2 p-4">
		{#each choices as choice (choice)}
			<button
				type="button"
				class="secondary-key h-11 w-full justify-center gap-2 text-[14px]"
				disabled={pending !== null}
				aria-busy={pending === choice}
				onclick={() => choose(choice)}
			>
				{#if pending === choice}<Spinner />{/if}
				{labels[choice]()}
			</button>
		{/each}
		{#if failed}
			<p class="pt-1 text-center text-[12px] text-error-soft" role="alert">{m.sign_in_failed({}, { locale })}</p>
		{/if}
	</div>
</Dialog>
