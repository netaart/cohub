<script lang="ts">
import { Check, Download, Loader2, Paperclip, Send, X } from "lucide-svelte";
import { page } from "$app/state";
import { PUBLIC_COHUB_ENV } from "$env/static/public";
import Dialog from "$lib/components/Dialog.svelte";
import { saveCohubDebugBundle } from "$lib/debugger";
import { createDebugLogFile, submitFeedback } from "$lib/feedback";
import { formatBytes } from "$lib/format-bytes";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { authStore } from "$lib/stores/auth.svelte";

const { open, onClose }: { open: boolean; onClose: () => void } = $props();

const locale = $derived(getLocale());

let content = $state("");
let files = $state<File[]>([]);
let includeLog = $state(true);
let sending = $state(false);
let error = $state<string | null>(null);
let errorDetail = $state<string | null>(null);
let sent = $state(false);
let fileInput = $state<HTMLInputElement | null>(null);
let textarea = $state<HTMLTextAreaElement | null>(null);

const canSend = $derived(!sending && content.trim().length > 0);

$effect(() => {
	if (!open) return;
	content = "";
	files = [];
	includeLog = true;
	sending = false;
	error = null;
	errorDetail = null;
	sent = false;
	queueMicrotask(() => textarea?.focus());
});

function addFiles(incoming: Iterable<File>) {
	files = [...files, ...incoming];
}

function handleFileChange(event: Event) {
	const input = event.currentTarget as HTMLInputElement;
	if (input.files) addFiles(input.files);
	input.value = "";
}

function handlePaste(event: ClipboardEvent) {
	const pasted = Array.from(event.clipboardData?.files ?? []);
	if (pasted.length === 0) return;
	event.preventDefault();
	addFiles(pasted);
}

function removeFile(index: number) {
	files = files.filter((_, i) => i !== index);
}

function buildExtra() {
	const url = page.url;
	return {
		user_uuid: authStore.userUuid,
		path: `${url.pathname}${url.search}`,
		params: page.params,
		locale,
		env: PUBLIC_COHUB_ENV || null,
		viewport: `${window.innerWidth}x${window.innerHeight}`,
		dpr: window.devicePixelRatio,
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		standalone: window.matchMedia("(display-mode: standalone)").matches,
		online: navigator.onLine,
		has_debug_log: includeLog,
	};
}

async function send() {
	if (!canSend) return;
	sending = true;
	error = null;
	errorDetail = null;
	try {
		const attachments = includeLog ? [...files, createDebugLogFile()] : files;
		await submitFeedback({
			content: content.trim(),
			extra: buildExtra(),
			files: attachments,
		});
		sent = true;
	} catch (cause) {
		console.error("[feedback] Failed to submit", cause);
		error = m.feedback_error_send({}, { locale });
		errorDetail = cause instanceof Error ? cause.message : null;
	} finally {
		sending = false;
	}
}

function handleKeydown(event: KeyboardEvent) {
	if (!open) return;
	if (event.key === "Escape" && !sending) {
		event.preventDefault();
		onClose();
		return;
	}
	if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !sent) {
		event.preventDefault();
		void send();
	}
}
</script>

<svelte:window onkeydown={handleKeydown} />

<Dialog {open} onClose={() => { if (!sending) onClose(); }} title={m.feedback_title({}, { locale })} maxWidth="520px" maxHeight="85vh">
	{#if sent}
		<div class="flex flex-col items-center gap-3 px-6 py-10 text-center">
			<div class="flex h-9 w-9 items-center justify-center rounded-full bg-bg-hover text-brand"><Check class="h-4 w-4" /></div>
			<div class="text-[14px] font-medium text-text-primary">{m.feedback_sent_title({}, { locale })}</div>
			<button type="button" class="primary-btn mt-2" onclick={onClose}>{m.feedback_done({}, { locale })}</button>
		</div>
	{:else}
		<div class="grid gap-3 p-4">
			<textarea
				bind:this={textarea}
				bind:value={content}
				onpaste={handlePaste}
				class="form-textarea"
				rows="6"
				placeholder={m.feedback_placeholder({}, { locale })}
				aria-label={m.feedback_title({}, { locale })}
				disabled={sending}
			></textarea>

			{#if files.length > 0}
				<ul class="grid gap-1">
					{#each files as file, index (`${file.name}-${file.size}-${file.lastModified}-${index}`)}
						<li class="flex min-w-0 items-center gap-2 rounded-[6px] border border-border-subtle bg-bg-surface px-2.5 py-1.5 text-[12px]">
							<Paperclip class="h-3.5 w-3.5 shrink-0 text-text-placeholder" />
							<span class="min-w-0 flex-1 truncate text-text-secondary" title={file.name}>{file.name}</span>
							<span class="shrink-0 font-mono text-[11px] text-text-placeholder">{formatBytes(file.size)}</span>
							<button
								type="button"
								class="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
								onclick={() => removeFile(index)}
								disabled={sending}
								aria-label={m.feedback_remove_file({ name: file.name }, { locale })}
								title={m.feedback_remove_file({ name: file.name }, { locale })}
							><X class="h-3 w-3" /></button>
						</li>
					{/each}
				</ul>
			{/if}

			<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
				<button type="button" class="secondary-btn" onclick={() => fileInput?.click()} disabled={sending}>
					<Paperclip class="h-3.5 w-3.5" />{m.feedback_add_files({}, { locale })}
				</button>
				<span class="min-w-0 text-[11px] text-text-placeholder">{m.feedback_attachment_hint({}, { locale })}</span>
				<input bind:this={fileInput} type="file" class="hidden" multiple onchange={handleFileChange} />
			</div>

			<label class="flex items-start gap-2 rounded-[6px] border border-border-subtle bg-bg-surface p-2.5 text-[12px]">
				<input type="checkbox" class="mt-0.5 accent-[var(--brand)]" bind:checked={includeLog} disabled={sending} />
				<span class="min-w-0 flex-1">
					<span class="block font-medium text-text-primary">{m.feedback_include_log({}, { locale })}</span>
					<span class="mt-0.5 block text-text-tertiary">{m.feedback_include_log_hint({}, { locale })}</span>
				</span>
				<button
					type="button"
					class="flex shrink-0 items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[11px] text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
					onclick={(event) => { event.preventDefault(); saveCohubDebugBundle(); }}
					title={m.feedback_download_log({}, { locale })}
				><Download class="h-3 w-3" />{m.feedback_download_log({}, { locale })}</button>
			</label>

			{#if error}
				<div class="rounded-[6px] border border-error-soft/30 bg-error-bg px-2.5 py-2 text-[12px] text-error-soft" role="alert">
					<div>{error}</div>
					{#if errorDetail}<div class="mt-0.5 break-words font-mono text-[11px] opacity-80">{errorDetail}</div>{/if}
				</div>
			{/if}

			<div class="flex justify-end gap-2 pt-1">
				<button type="button" class="secondary-btn" onclick={onClose} disabled={sending}>{m.common_cancel({}, { locale })}</button>
				<button type="button" class="primary-btn" onclick={() => void send()} disabled={!canSend}>
					{#if sending}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Send class="h-3.5 w-3.5" />{/if}
					{sending ? m.feedback_sending({}, { locale }) : m.feedback_send({}, { locale })}
				</button>
			</div>
		</div>
	{/if}
</Dialog>

<style>
	.form-textarea { width: 100%; min-height: 120px; resize: vertical; border-radius: 6px; border: 1px solid var(--border-subtle); background: var(--bg-input); padding: 8px 10px; color: var(--text-primary); font-size: 13px; line-height: 1.5; outline: none; }
	.form-textarea::placeholder { color: var(--text-placeholder); }
	.form-textarea:focus { border-color: var(--brand); }
	.primary-btn, .secondary-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 30px; border-radius: 6px; padding: 0 12px; font-size: 12px; font-weight: 500; transition: background 120ms ease, border-color 120ms ease, color 120ms ease, opacity 120ms ease; }
	.primary-btn { border: 1px solid var(--brand); background: var(--brand); color: var(--brand-contrast-fg); }
	.primary-btn:hover:not(:disabled) { opacity: .92; }
	.primary-btn:disabled, .secondary-btn:disabled { cursor: not-allowed; opacity: .5; }
	.secondary-btn { border: 1px solid var(--border-subtle); background: var(--bg-surface); color: var(--text-secondary); }
	.secondary-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
</style>
