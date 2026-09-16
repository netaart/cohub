<script lang="ts">
import type { AppPublicOwnerRecord, AppRecord } from "@neta-art/cohub";
import { AlertTriangle, Loader2, ShieldCheck } from "lucide-svelte";
import { onDestroy, onMount } from "svelte";
import { page } from "$app/state";
import { PUBLIC_API_ORIGIN } from "$env/static/public";
import { getAuthToken, signInWithRedirectPath } from "$lib/auth";
import { readAppCheckoutState } from "$lib/components/app/app-checkout-state";
import AppAuthorizeDialog from "$lib/features/app/AppAuthorizeDialog.svelte";
import { isAllowedAppOrigin } from "$lib/features/app/app-origin-allowlist";
import { createAppBridgeHost } from "$lib/features/app/bridge-host.svelte";
import type { Locale } from "$lib/i18n/locale";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

type BrokerState = "loading" | "need-login" | "ready" | "error";

type AppDetail = {
	app: Pick<AppRecord, "id" | "spaceId" | "userUuid" | "slug" | "appScopes">;
	owner: AppPublicOwnerRecord;
	spaceName: string | null;
};

const params = $derived(page.url.searchParams);
const appId = $derived(params.get("app") ?? "");
const openerOrigin = $derived(params.get("origin") ?? "");

let phase = $state<BrokerState>("loading");
let errorMessage = $state("");

let locale: Locale = $derived(getLocale());
let appDetail = $state<AppDetail | null>(null);
let host = $state<ReturnType<typeof createAppBridgeHost> | null>(null);

// The validated origin of the opener window, confirmed from the actual
// MessageEvent (not just the URL param). Used as targetOrigin for replies.
let validatedOpenerOrigin = $state<string | null>(null);

function fail(msg: string) {
	phase = "error";
	errorMessage = msg;
}

async function loadAppDetail(token: string): Promise<AppDetail | null> {
	const response = await fetch(
		`${PUBLIC_API_ORIGIN ?? ""}/api/apps/${encodeURIComponent(appId)}/public`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);
	if (!response.ok) return null;
	const json = (await response.json()) as Partial<AppDetail> & {
		space?: { name?: unknown } | null;
	};
	if (!json.app || !json.owner) return null;
	const spaceName =
		typeof json.space?.name === "string" ? json.space.name : null;
	return { app: json.app, owner: json.owner, spaceName };
}

async function init() {
	if (!appId) {
		fail(m.app_auth_invalid_entry({}, { locale }));
		return;
	}
	if (typeof window === "undefined" || !window.opener) {
		fail(m.app_auth_invalid_entry({}, { locale }));
		return;
	}

	// Validate the destination before starting login or posting any progress.
	if (!openerOrigin || !isAllowedAppOrigin(openerOrigin)) {
		fail(m.app_auth_origin_denied({}, { locale }));
		return;
	}
	const token = await getAuthToken();
	if (!token) {
		phase = "need-login";
		window.opener.postMessage(
			{ type: "cohub.app.broker.progress", phase: "login" },
			openerOrigin,
		);
		// Only one automatic redirect per attempt; keep the sign-in action
		// available when an OAuth callback cannot establish a session.
		try {
			const key = `cohub:broker-login:${appId}`;
			const previous = Number(sessionStorage.getItem(key) ?? 0);
			if (Date.now() - previous > 600_000) {
				sessionStorage.setItem(key, String(Date.now()));
				await handleLogin();
			}
		} catch {
			/* The explicit sign-in action remains available. */
		}
		return;
	}

	// 2. Load work metadata.
	const detail = await loadAppDetail(token);
	if (!detail) {
		fail(m.app_auth_unavailable({}, { locale }));
		return;
	}
	appDetail = detail;

	// 4. Set up the bridge host with a reply that posts back to the opener.
	validatedOpenerOrigin = openerOrigin;
	host = createAppBridgeHost({
		app: { ...detail.app, spaceName: detail.spaceName },
		authorizationContext: { surface: "broker" },
		reply: (requestId, payload) => {
			window.opener?.postMessage(
				{ requestId, ...payload },
				validatedOpenerOrigin ?? openerOrigin,
			);
			// One-shot: close the popup shortly after replying (§7.2), unless
			// the broker is about to navigate to a checkout URL.
			const checkout = (
				payload as {
					checkout?: { checkoutUsable?: unknown; checkoutUrl?: unknown };
				}
			).checkout;
			const willNavigate =
				Boolean(checkout) &&
				checkout?.checkoutUsable === true &&
				typeof checkout?.checkoutUrl === "string";
			if (!willNavigate) {
				setTimeout(() => window.close(), 200);
			}
		},
		getCheckoutState: () => readAppCheckoutState(page.url),
	});

	phase = "ready";

	// 5. Ready handshake: tell the opener we're ready to receive the request.
	window.opener.postMessage(
		{ type: "cohub.app.broker.ready", authorizationVersion: 2 },
		validatedOpenerOrigin ?? openerOrigin,
	);
	// Older published Work SDKs wait for the pre-rename handshake name.
	window.opener.postMessage(
		{ type: "cohub.work.broker.ready" },
		validatedOpenerOrigin ?? openerOrigin,
	);
}

function onMessage(event: MessageEvent) {
	if (!window.opener || event.source !== window.opener) return;
	// Validate the real opener origin against the allowlist.
	if (!isAllowedAppOrigin(event.origin)) return;
	// Use the verified origin for replies.
	validatedOpenerOrigin = event.origin;
	if (!host) return;
	void host.handleMessage(event);
}

async function handleLogin() {
	await signInWithRedirectPath(
		location.pathname + location.search + location.hash,
	);
}

onMount(() => {
	void init().catch((error) => {
		fail(
			error instanceof Error
				? error.message
				: m.app_auth_unavailable({}, { locale }),
		);
	});
	window.addEventListener("message", onMessage);
});

onDestroy(() => window.removeEventListener("message", onMessage));
</script>

<svelte:head>
	<title>{m.app_auth_seo_title({}, { locale })}</title>
</svelte:head>

<div class="broker-page">
	{#if phase === "loading"}
		<div class="broker-center">
			<Loader2 class="h-5 w-5 animate-spin text-text-tertiary" />
			<p class="broker-status">{m.app_auth_preparing({}, { locale })}</p>
		</div>
	{:else if phase === "need-login"}
		<div class="broker-center">
			<div class="broker-login-icon"><ShieldCheck class="h-5 w-5" /></div>
			<p class="broker-login-title">{m.app_auth_sign_in({}, { locale })}</p>
			<p class="broker-login-copy">{m.app_auth_continue({}, { locale })}</p>
			<button type="button" class="broker-login-btn" onclick={handleLogin}>
				{m.app_auth_sign_in({}, { locale })}
			</button>
		</div>
	{:else if phase === "error"}
		<div class="broker-center">
			<AlertTriangle class="h-5 w-5 text-error-soft" />
			<p class="broker-error-msg">{errorMessage}</p>
			<p class="broker-error-hint">{m.app_auth_close({}, { locale })}</p>
		</div>
	{/if}

	{#if host && appDetail}
		{@const h = host}
		{@const detail = appDetail}

		<AppAuthorizeDialog
			open={h.authOpen && !!h.pendingAuth}
			pending={h.pendingAuth}
			error={h.authError}
			saving={h.authSaving}
			appName={detail.app.slug}
			authorName={detail.owner.displayName}
			selectedSpaceId={h.selectedSpaceId}
			canChangeSpace={h.canChangeSpace}
			onSelectSpace={h.setSelectedSpace}
			onConfirm={(spaceId) => void h.confirmAuth(spaceId)}
			onCancel={h.cancelAuth}
		/>
	{/if}
</div>

<style>
	.broker-page {
		min-height: 100dvh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 2rem;
	}

	.broker-center {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		text-align: center;
		max-width: 360px;
	}

	.broker-status {
		font-size: 13px;
		color: var(--text-tertiary);
	}

	.broker-login-icon {
		display: inline-flex;
		width: 40px;
		height: 40px;
		align-items: center;
		justify-content: center;
		border-radius: 10px;
		background: var(--brand-muted);
		color: var(--brand-muted-fg);
		border: 1px solid var(--brand-border);
	}

	.broker-login-title {
		font-size: 15px;
		font-weight: 650;
		color: var(--text-primary);
	}

	.broker-login-copy {
		font-size: 13px;
		color: var(--text-secondary);
		line-height: 1.5;
	}

	.broker-login-btn {
		display: inline-flex;
		height: 36px;
		align-items: center;
		justify-content: center;
		gap: 6px;
		border-radius: 8px;
		padding: 0 16px;
		font-size: 13px;
		font-weight: 650;
		border: 1px solid var(--brand);
		background: var(--brand);
		color: var(--brand-contrast-fg);
		cursor: pointer;
		transition: background-color 0.15s ease;
	}

	.broker-login-btn:hover {
		background: var(--brand-hover);
		border-color: var(--brand-hover);
	}

	.broker-error-msg {
		font-size: 13px;
		font-weight: 500;
		color: var(--text-primary);
		line-height: 1.5;
		word-break: break-word;
	}

	.broker-error-hint {
		font-size: 12px;
		color: var(--text-tertiary);
	}
</style>
