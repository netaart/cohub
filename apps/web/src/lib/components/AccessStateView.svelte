<script lang="ts">
import { AlertTriangle, Eye, Ghost, Lock, LogIn, WifiOff } from "lucide-svelte";
import type { AccessState } from "#lib/access/access-state.ts";
import { appHomeHref } from "#lib/app-entry.ts";
import { redirectToSignIn } from "#lib/auth-redirect.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import { goto } from "$app/navigation";

const {
	state,
	size = "full",
	retry,
}: {
	state: AccessState;
	size?: "full" | "compact";
	retry?: () => void;
} = $props();

const locale = $derived(getLocale());

const config = $derived.by(() => {
	switch (state.kind) {
		case "not-found":
			return {
				icon: Ghost,
				title: "Not found",
				description:
					state.resource === "session"
						? "This session doesn't exist or has been deleted."
						: state.resource === "space"
							? "This space doesn't exist or has been deleted."
							: "The page you're looking for doesn't exist or has been moved.",
			};
		case "forbidden":
			return {
				icon: Lock,
				title: "No access",
				description: state.isAuthenticated
					? "You don't have permission to view this."
					: "Sign in to access this content.",
			};
		case "unauthorized":
			return {
				icon: LogIn,
				title: "Sign in required",
				description: "Sign in to access this space.",
			};
		case "error":
			return {
				icon: state.message.toLowerCase().includes("network")
					? WifiOff
					: AlertTriangle,
				title: "Something went wrong",
				description: state.message,
			};
		case "minimal":
			return {
				icon: Eye,
				title: "Limited access",
				description:
					"You're viewing a shared session. Full space content requires permission.",
			};
		default:
			return null;
	}
});

const showHome = $derived(state.kind !== "minimal");
const showSignIn = $derived(
	state.kind === "unauthorized" ||
		(state.kind === "forbidden" && !state.isAuthenticated),
);
const showRetry = $derived(
	(state.kind === "error" || state.kind === "not-found") && retry !== undefined,
);

function goHome() {
	void goto(appHomeHref());
}

function signIn() {
	void redirectToSignIn();
}
</script>

{#if config}
	{@const Icon = config.icon}
	{#if size === "compact"}
		<div class="flex items-start gap-2.5 rounded-md border border-border-subtle bg-bg-surface px-3 py-2.5">
			<Icon class="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
			<div class="min-w-0 flex-1">
				<div class="text-[13px] font-medium text-text-primary">{config.title}</div>
				<div class="mt-0.5 text-[12px] leading-5 text-text-tertiary">{config.description}</div>
				{#if showSignIn || showHome || showRetry}
					<div class="mt-2 flex flex-wrap items-center gap-2">
						{#if showSignIn}
							<button type="button" class="access-btn primary-key" onclick={signIn}>{m.access_sign_in({}, { locale })}</button>
						{/if}
						{#if showRetry}
							<button type="button" class="access-btn secondary-key" onclick={retry}>{m.common_retry({}, { locale })}</button>
						{/if}
						{#if showHome}
							<button type="button" class="access-btn secondary-key" onclick={goHome}>{m.access_go_home({}, { locale })}</button>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	{:else}
		<div class="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-10 text-center">
			<div class="flex max-w-sm flex-col items-center gap-4">
				<div class="flex h-12 w-12 items-center justify-center rounded-full bg-bg-surface text-text-tertiary ring-1 ring-border-subtle">
					<Icon class="h-6 w-6" />
				</div>
				<div class="space-y-1.5">
					<h2 class="text-[16px] font-semibold text-text-primary">{config.title}</h2>
					<p class="text-[13px] leading-6 text-text-tertiary">{config.description}</p>
				</div>
				{#if showSignIn || showHome || showRetry}
					<div class="mt-1 flex flex-wrap items-center justify-center gap-2">
						{#if showSignIn}
							<button type="button" class="access-btn primary-key" onclick={signIn}>{m.access_sign_in({}, { locale })}</button>
						{/if}
						{#if showRetry}
							<button type="button" class="access-btn secondary-key" onclick={retry}>{m.common_retry({}, { locale })}</button>
						{/if}
						{#if showHome}
							<button type="button" class="access-btn secondary-key" onclick={goHome}>{m.access_go_home({}, { locale })}</button>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	{/if}
{/if}

<style>
	.access-btn {
		gap: 0.375rem;
		padding: 0.4rem 0.75rem;
		font-size: 12px;
		line-height: 1.4;
	}
</style>
