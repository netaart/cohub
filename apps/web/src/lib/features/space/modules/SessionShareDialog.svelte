<script lang="ts">
import { Check, Copy, Globe, Loader2, Lock, QrCode } from "lucide-svelte";
import { renderSVG } from "uqr";
import Dialog from "#lib/components/Dialog.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

type Props = {
	open: boolean;
	shareUrl: string;
	isPublic: boolean;
	loadingAccess: boolean;
	saving: boolean;
	copied: boolean;
	error: string;
	onClose: () => void;
	onCopyLink: () => void | Promise<void>;
	onSetPublic: (next: boolean) => void | Promise<void>;
};

let {
	open,
	shareUrl,
	isPublic,
	loadingAccess,
	saving,
	copied,
	error,
	onClose,
	onCopyLink,
	onSetPublic,
}: Props = $props();

const locale = $derived(getLocale());

const accessBusy = $derived(loadingAccess || saving);

let showQr = $state(false);
let lastQrUrl = $state("");

// Collapse QR when dialog closes or the share URL changes.
$effect(() => {
	if (!open) {
		showQr = false;
		lastQrUrl = "";
		return;
	}
	if (showQr && shareUrl && shareUrl !== lastQrUrl) {
		lastQrUrl = shareUrl;
	}
	if (showQr && !shareUrl) {
		showQr = false;
	}
});

const qrSvg = $derived.by(() => {
	if (!showQr || !shareUrl) return "";
	try {
		return renderSVG(shareUrl, {
			ecc: "M",
			border: 2,
			pixelSize: 6,
			// Always black modules on white — phones scan more reliably than theme colors.
			blackColor: "#111111",
			whiteColor: "#ffffff",
		});
	} catch {
		return "";
	}
});

function toggleQr() {
	if (!shareUrl) return;
	showQr = !showQr;
	if (showQr) lastQrUrl = shareUrl;
}
</script>

<Dialog {open} {onClose} title={m.session_share_title({}, { locale })} maxWidth="400px">
	<div class="share-panel">
		<section class="section">
			<div class="section-label">Link</div>
			<div class="link-row">
				<div class="link-url" title={shareUrl}>{shareUrl || "—"}</div>
				<div class="link-actions">
					<button
						type="button"
						class="icon-btn"
						class:is-active={showQr}
						onclick={toggleQr}
						disabled={!shareUrl}
						aria-pressed={showQr}
						aria-label={showQr ? "Hide QR code" : "Show QR code"}
						title={showQr ? "Hide QR code" : "Show QR code"}
					>
						<QrCode class="h-3.5 w-3.5" />
					</button>
					<button
						type="button"
						class="copy-btn"
						class:is-copied={copied}
						onclick={() => void onCopyLink()}
						disabled={!shareUrl}
						aria-label={copied ? "Copied" : "Copy link"}
					>
						{#if copied}
							<Check class="h-3.5 w-3.5" />
							<span>Copied</span>
						{:else}
							<Copy class="h-3.5 w-3.5" />
							<span>Copy</span>
						{/if}
					</button>
				</div>
			</div>

			{#if showQr}
				<div class="qr-panel" aria-live="polite">
					{#if qrSvg}
						<div class="qr-frame">
							{@html qrSvg}
						</div>
					{:else}
						<p class="qr-error">{m.session_share_qr_failed({}, { locale })}</p>
					{/if}
				</div>
			{/if}
		</section>

		<section class="section">
			<div class="section-label">Access</div>
			<button
				type="button"
				class="access-row"
				class:is-public={isPublic}
				class:is-busy={accessBusy}
				role="switch"
				aria-checked={isPublic}
				aria-label="Anyone with the link"
				disabled={accessBusy || !shareUrl}
				onclick={() => void onSetPublic(!isPublic)}
			>
				<div class="access-icon" aria-hidden="true">
					{#if loadingAccess}
						<Loader2 class="h-4 w-4 animate-spin" />
					{:else if isPublic}
						<Globe class="h-4 w-4" />
					{:else}
						<Lock class="h-4 w-4" />
					{/if}
				</div>
				<div class="access-copy">
					<div class="access-title">{m.anyone_with_link({}, { locale })}</div>
					<div class="access-desc">
						{#if isPublic}
							Public · view only
						{:else}
							Private
						{/if}
					</div>
				</div>
				<span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span>
			</button>
		</section>

		{#if error}
			<div class="error-box" role="alert">{error}</div>
		{/if}
	</div>
</Dialog>

<style>
	.share-panel {
		display: grid;
		gap: 16px;
		padding: 14px;
	}

	.section {
		display: grid;
		gap: 8px;
		min-width: 0;
	}

	.section-label {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-tertiary);
	}

	.link-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		border: 1px solid var(--border-subtle);
		border-radius: 8px;
		background: var(--bg-surface);
		padding: 6px 6px 6px 10px;
	}

	.link-url {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: 12px;
		line-height: 1.4;
		color: var(--text-secondary);
		user-select: all;
	}

	.link-actions {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
	}

	.icon-btn,
	.copy-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		height: 30px;
		border-radius: 6px;
		border: 1px solid var(--border-subtle);
		background: var(--bg-primary);
		color: var(--text-secondary);
		font-size: 12px;
		font-weight: 500;
		transition:
			background-color 120ms ease,
			border-color 120ms ease,
			color 120ms ease;
	}

	.icon-btn {
		width: 30px;
		padding: 0;
	}

	.copy-btn {
		gap: 5px;
		padding: 0 10px;
	}

	.icon-btn:hover:not(:disabled),
	.copy-btn:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-primary);
		border-color: var(--border-primary);
	}

	.icon-btn:disabled,
	.copy-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.icon-btn.is-active {
		color: var(--brand);
		border-color: color-mix(in srgb, var(--brand) 40%, var(--border-subtle));
		background: color-mix(in srgb, var(--brand) 8%, var(--bg-primary));
	}

	.copy-btn.is-copied {
		color: var(--success-500);
		border-color: color-mix(in srgb, var(--success-500) 35%, var(--border-subtle));
	}

	.qr-panel {
		display: grid;
		justify-items: center;
		border: 1px solid var(--border-subtle);
		border-radius: 8px;
		background: var(--bg-surface);
		padding: 12px;
	}

	.qr-frame {
		display: grid;
		place-items: center;
		width: 168px;
		height: 168px;
		border-radius: 8px;
		background: #ffffff;
		padding: 8px;
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--border-subtle) 60%, transparent);
	}

	.qr-frame :global(svg) {
		display: block;
		width: 100%;
		height: 100%;
	}

	.qr-error {
		margin: 0;
		font-size: 12px;
		line-height: 1.4;
		color: var(--error-400);
	}

	.access-row {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		min-width: 0;
		min-height: 52px;
		border: 1px solid var(--border-subtle);
		border-radius: 8px;
		background: var(--bg-surface);
		padding: 10px 12px;
		text-align: left;
		color: inherit;
		cursor: pointer;
		transition:
			border-color 120ms ease,
			background-color 120ms ease;
	}

	.access-row:hover:not(:disabled) {
		background: var(--bg-hover);
	}

	.access-row:disabled {
		cursor: not-allowed;
	}

	.access-row.is-public {
		border-color: color-mix(in srgb, var(--brand) 28%, var(--border-subtle));
		background: color-mix(in srgb, var(--brand) 6%, var(--bg-surface));
	}

	.access-row.is-public:hover:not(:disabled) {
		background: color-mix(in srgb, var(--brand) 10%, var(--bg-surface));
	}

	.access-row.is-busy {
		opacity: 0.85;
	}

	.access-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 28px;
		height: 28px;
		border-radius: 6px;
		background: var(--bg-elevated);
		color: var(--text-tertiary);
	}

	.access-row.is-public .access-icon {
		color: var(--brand);
	}

	.access-copy {
		min-width: 0;
		flex: 1;
	}

	.access-title {
		font-size: 13px;
		font-weight: 500;
		color: var(--text-primary);
		line-height: 1.3;
	}

	.access-desc {
		margin-top: 2px;
		font-size: 11px;
		line-height: 1.4;
		color: var(--text-tertiary);
	}

	@media (max-width: 639px) {
		.icon-btn {
			width: 36px;
			min-height: 36px;
		}

		.copy-btn {
			min-height: 36px;
			padding: 0 12px;
		}

		.access-row {
			min-height: 56px;
		}

		.qr-frame {
			width: 188px;
			height: 188px;
		}
	}

	.error-box {
		border-radius: 6px;
		border: 1px solid color-mix(in srgb, var(--error-500) 30%, transparent);
		background: var(--error-900);
		padding: 8px 10px;
		font-size: 12px;
		line-height: 1.4;
		color: var(--error-400);
		word-break: break-word;
	}
</style>
