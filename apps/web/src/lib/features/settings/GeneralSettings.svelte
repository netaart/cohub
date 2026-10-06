<script lang="ts">
import {
	Check,
	Copy,
	Languages,
	Loader2,
	Monitor,
	Moon,
	Palette,
	Pencil,
	Sun,
	Upload,
	X,
} from "lucide-svelte";
import { onMount } from "svelte";
import { ensureAuth } from "$lib/auth";
import UploadProgress from "$lib/components/UploadProgress.svelte";
import UserAvatar from "$lib/components/UserAvatar.svelte";
import type { LocalePreference } from "$lib/i18n/locale";
import {
	getLocale,
	getLocalePreference,
	setLocalePreference,
} from "$lib/i18n/locale.svelte";
import {
	localizedThemeDescription,
	localizedThemeLabel,
} from "$lib/i18n/theme";
import { isComposingKeyboardEvent } from "$lib/keyboard";
import { m } from "$lib/paraglide/messages.js";
import { uploadUserAvatarImage } from "$lib/public-asset-images";
import { validateUsernameInput } from "$lib/slug-rules";
import { authStore } from "$lib/stores/auth.svelte";
import { getTheme } from "$lib/theme.svelte";
import { THEME_OPTIONS, type ThemeMode } from "$lib/theme-registry";
import { setThemeWithTransition } from "$lib/theme-transition";

const locale = $derived(getLocale());
const localePreference = $derived(getLocalePreference());
const mode = $derived(getTheme());
type EditableField = "displayName" | "username";

const userUuid = $derived(authStore.userUuid ?? "");
const displayName = $derived(authStore.profile?.displayName ?? "");
const avatarUrl = $derived(authStore.profile?.avatarUrl ?? "");
const username = $derived(authStore.profile?.username ?? "");
const email = $derived(authStore.email ?? "");
const profileLoading = $derived(!authStore.loaded);
let uuidCopied = $state(false);
let inlineError = $state("");
let editingField = $state<EditableField | null>(null);
let draftValue = $state("");
let savingField = $state<EditableField | null>(null);
let uploadingAvatar = $state(false);
let avatarUploadStage = $state<"idle" | "preparing" | "uploading" | "saving">(
	"idle",
);
let avatarUploadProgress = $state(0);
let uuidCopiedTimer: ReturnType<typeof setTimeout> | null = null;

const profileTitle = $derived(
	displayName || username || m.common_user({}, { locale }),
);
const usernameLabel = $derived(
	username ? `@${username}` : m.settings_set_username({}, { locale }),
);
const uuidLabel = $derived(formatUuid(userUuid));
const themeIcon = {
	dark: Moon,
	light: Sun,
	"solarized-dark": Palette,
	"solarized-light": Palette,
	"neta-studio": Palette,
	system: Monitor,
} satisfies Record<ThemeMode, typeof Sun>;
const localeOptions = $derived([
	{
		value: "system" as const,
		label: m.settings_language_system({}, { locale }),
		description: m.settings_language_system_description({}, { locale }),
	},
	{
		value: "en" as const,
		label: m.settings_language_english({}, { locale }),
		description: m.settings_language_english_description({}, { locale }),
	},
	{
		value: "zh-CN" as const,
		label: m.settings_language_chinese({}, { locale }),
		description: m.settings_language_chinese_description({}, { locale }),
	},
]);

function formatUuid(uuid: string): string {
	if (!uuid) return "";
	if (uuid.length <= 13) return uuid;
	return `${uuid.slice(0, 8)}…${uuid.slice(-4)}`;
}

function getFieldValue(field: EditableField): string {
	return field === "displayName" ? displayName : username;
}

function beginEdit(field: EditableField) {
	if (profileLoading || savingField) return;
	inlineError = "";
	editingField = field;
	draftValue = getFieldValue(field);
}

function cancelEdit() {
	if (savingField) return;
	editingField = null;
	draftValue = "";
	inlineError = "";
}

function handleEditKeydown(event: KeyboardEvent) {
	if (event.key === "Escape") {
		event.preventDefault();
		cancelEdit();
		return;
	}
	if (event.key === "Enter" && !isComposingKeyboardEvent(event)) {
		event.preventDefault();
		void saveEditingField();
	}
}

async function saveEditingField() {
	if (!editingField || savingField) return;
	const field = editingField;
	const nextDisplayName =
		field === "displayName" ? draftValue.trim() : displayName.trim();
	const nextUsername =
		field === "username" ? draftValue.trim() : username.trim();
	inlineError = "";
	if (!nextDisplayName) {
		inlineError = m.settings_display_name_required({}, { locale });
		return;
	}
	if (field === "username") {
		const result = validateUsernameInput(nextUsername);
		if (result.error) {
			inlineError = result.error;
			return;
		}
	}
	savingField = field;
	try {
		await authStore.updateProfile({
			displayName: nextDisplayName,
			avatarUrl: avatarUrl.trim() || null,
			username: nextUsername || null,
		});
		editingField = null;
		draftValue = "";
	} catch (error) {
		inlineError =
			error instanceof Error ? error.message : "Failed to save profile";
	} finally {
		savingField = null;
	}
}

async function uploadAvatar(file: File) {
	if (uploadingAvatar) return;
	inlineError = "";
	uploadingAvatar = true;
	avatarUploadStage = "preparing";
	avatarUploadProgress = 0;
	try {
		const asset = await uploadUserAvatarImage(file, {
			onProgress: ({ ratio }) => {
				avatarUploadStage = "uploading";
				avatarUploadProgress = Math.round(ratio * 100);
			},
		});
		avatarUploadStage = "saving";
		await authStore.updateProfile({ avatarUrl: asset.publicUrl });
	} catch (error) {
		inlineError =
			error instanceof Error ? error.message : "Failed to upload avatar";
	} finally {
		uploadingAvatar = false;
		avatarUploadStage = "idle";
		avatarUploadProgress = 0;
	}
}

function handleAvatarFileChange(event: Event) {
	const input = event.currentTarget as HTMLInputElement;
	const file = input.files?.[0];
	input.value = "";
	if (file) void uploadAvatar(file);
}

async function copyUuid() {
	if (!userUuid) return;
	try {
		await navigator.clipboard.writeText(userUuid);
		uuidCopied = true;
		if (uuidCopiedTimer) clearTimeout(uuidCopiedTimer);
		uuidCopiedTimer = setTimeout(() => {
			uuidCopied = false;
		}, 2000);
	} catch {
		console.warn("[general] Failed to copy UUID");
	}
}

function handleThemeChange(nextMode: ThemeMode, event: MouseEvent) {
	setThemeWithTransition(nextMode, event);
}

function handleLocaleChange(preference: LocalePreference) {
	setLocalePreference(preference);
}

onMount(() => {
	void ensureAuth()
		.then((signedIn) => (signedIn ? authStore.ensureLoaded() : undefined))
		.catch((error) =>
			console.error("[general] Failed to load profile:", error),
		);
});
</script>

<div class="flex-1 px-6 py-7">
	<section class="max-w-2xl">
		<div class="border-b border-border-subtle pb-5">
			<h1 class="text-[18px] font-semibold tracking-tight text-text-primary">{m.nav_general({}, { locale })}</h1>
			<p class="mt-1 max-w-xl text-[13px] leading-5 text-text-tertiary">{m.settings_general_description({}, { locale })}</p>
		</div>

		<section id="profile" class="border-b border-border-subtle py-6">
			<div class="py-6">
				<div class="flex items-start gap-4">
					{#if profileLoading}
						<div class="flex w-16 shrink-0 flex-col items-center gap-2" aria-hidden="true"><div class="h-14 w-14 rounded-full border border-border-subtle bg-bg-hover-strong"></div><div class="h-3 w-10 rounded bg-bg-hover-strong"></div></div>
					{:else}
						<div class="flex w-16 shrink-0 flex-col items-center gap-1.5">
							<label class="group relative h-14 w-14 cursor-pointer overflow-hidden rounded-full border border-border-subtle bg-bg-hover-strong transition-colors hover:border-brand/50" title={avatarUrl ? m.settings_change_avatar({}, { locale }) : m.settings_upload_avatar({}, { locale })} aria-label={avatarUrl ? m.settings_change_avatar({}, { locale }) : m.settings_upload_avatar({}, { locale })}>
								<UserAvatar name={displayName || username} {avatarUrl} size="lg" loading="eager" class="h-full w-full border-0" />
								<span class="absolute inset-0 flex items-center justify-center bg-overlay-scrim-strong opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">{#if uploadingAvatar}<Loader2 class="h-4 w-4 animate-spin text-overlay-control-text" />{:else}<Upload class="h-4 w-4 text-overlay-control-text" />{/if}</span>
								<input type="file" accept="image/jpeg,image/png,image/gif,image/webp" class="sr-only" disabled={uploadingAvatar} onchange={handleAvatarFileChange} />
							</label>
							<label class="inline-flex cursor-pointer items-center gap-1 rounded-[4px] px-1 py-0.5 text-[11px] leading-none text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary focus-within:bg-bg-hover focus-within:text-text-secondary {uploadingAvatar ? 'pointer-events-none opacity-70' : ''}">{#if uploadingAvatar}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Upload class="h-3 w-3" />{/if}<span aria-live="polite">{avatarUploadStage === "preparing" ? m.common_preparing({}, { locale }) : avatarUploadStage === "uploading" ? `${avatarUploadProgress}%` : avatarUploadStage === "saving" ? m.common_saving({}, { locale }) : avatarUrl ? m.common_change({}, { locale }) : m.common_upload({}, { locale })}</span><input type="file" accept="image/jpeg,image/png,image/gif,image/webp" class="sr-only" disabled={uploadingAvatar} onchange={handleAvatarFileChange} /></label>
							{#if uploadingAvatar}<UploadProgress class="w-12 rounded-full" value={avatarUploadStage === "uploading" ? avatarUploadProgress : null} label={m.settings_avatar_upload_progress({}, { locale })} />{/if}
						</div>
					{/if}
					<div class="min-w-0 flex-1 pt-0.5">
						{#if profileLoading}
							<div class="h-4 w-32 rounded bg-bg-hover-strong" aria-hidden="true"></div><div class="mt-2 h-3 w-20 rounded bg-bg-hover-strong" aria-hidden="true"></div><div class="mt-2 h-3 w-36 rounded bg-bg-hover-strong" aria-hidden="true"></div>
						{:else}
							<div class="min-w-0">{#if editingField === "displayName"}<div class="flex min-w-0 items-center gap-2"><input aria-label={m.settings_display_name({}, { locale })} bind:value={draftValue} maxlength="120" onkeydown={handleEditKeydown} disabled={savingField === "displayName"} class="min-w-0 flex-1 rounded-[5px] border border-brand/40 bg-bg-input px-2.5 py-1.5 text-[15px] font-medium text-text-primary focus:outline-none" /><button type="button" onclick={() => void saveEditingField()} disabled={savingField === "displayName"} class="shrink-0 rounded-[5px] p-1.5 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50" title={m.settings_save_display_name({}, { locale })}>{#if savingField === "displayName"}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Check class="h-3.5 w-3.5" />{/if}</button><button type="button" onclick={cancelEdit} disabled={savingField === "displayName"} class="shrink-0 rounded-[5px] p-1.5 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50" title={m.common_cancel({}, { locale })}><X class="h-3.5 w-3.5" /></button></div>{:else}<button type="button" onclick={() => beginEdit("displayName")} class="group/edit -ml-1 flex max-w-full items-center gap-1.5 rounded-[5px] px-1 py-0.5 text-left hover:bg-bg-hover" title={m.settings_edit_display_name({}, { locale })}><span class="min-w-0 truncate text-[15px] font-medium text-text-primary group-hover/edit:text-brand">{profileTitle}</span><Pencil class="h-3 w-3 shrink-0 text-text-placeholder opacity-0 group-hover/edit:opacity-100" /></button>{/if}</div>
							<div class="mt-1 min-w-0">{#if editingField === "username"}<div class="min-w-0"><div class="flex min-w-0 items-center gap-2"><div class="flex min-w-0 flex-1 items-center rounded-[5px] border border-brand/40 bg-bg-input px-2.5 py-1.5"><span class="mr-1 shrink-0 text-[13px] text-text-tertiary">@</span><input aria-label={m.settings_username({}, { locale })} bind:value={draftValue} placeholder="your-handle" maxlength="39" onkeydown={handleEditKeydown} disabled={savingField === "username"} class="min-w-0 flex-1 bg-transparent text-[13px] text-text-primary placeholder:text-text-placeholder focus:outline-none" /></div><button type="button" onclick={() => void saveEditingField()} disabled={savingField === "username"} class="shrink-0 rounded-[5px] p-1.5 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50" title={m.settings_save_username({}, { locale })}>{#if savingField === "username"}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Check class="h-3.5 w-3.5" />{/if}</button><button type="button" onclick={cancelEdit} disabled={savingField === "username"} class="shrink-0 rounded-[5px] p-1.5 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50" title={m.common_cancel({}, { locale })}><X class="h-3.5 w-3.5" /></button></div><p class="mt-1.5 text-[11px] leading-4 text-text-tertiary">{m.settings_username_help({}, { locale })}</p></div>{:else}<button type="button" onclick={() => beginEdit("username")} class="group/edit -ml-1 inline-flex max-w-full items-center gap-1.5 rounded-[5px] px-1 py-0.5 text-left hover:bg-bg-hover" title={m.settings_edit_username({}, { locale })}><span class="min-w-0 truncate text-[12px] {username ? 'text-text-tertiary' : 'text-text-placeholder'}">{usernameLabel}</span><Pencil class="h-3 w-3 shrink-0 text-text-placeholder opacity-0 group-hover/edit:opacity-100" /></button>{/if}</div>
							{#if email}<div class="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-text-tertiary"><span class="shrink-0 uppercase tracking-wider">Email</span><span class="min-w-0 truncate" title={email}>{email}</span></div>{/if}
							<div class="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-text-tertiary"><span class="shrink-0 uppercase tracking-wider">ID</span><code class="min-w-0 truncate font-mono" title={userUuid}>{uuidLabel}</code><button type="button" onclick={copyUuid} class="shrink-0 rounded-[4px] p-1 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary" title={m.settings_copy_uuid({}, { locale })}>{#if uuidCopied}<Check class="h-3 w-3 text-status-running" />{:else}<Copy class="h-3 w-3" />{/if}</button></div>
						{/if}
					</div>
				</div>
				{#if inlineError}<div class="mt-4 rounded-md border border-error-soft/30 bg-error-bg p-3 break-all text-[12px] text-error-soft">{inlineError}</div>{/if}
			</div>
		</section>

		<section id="appearance" class="py-6">
			<div class="mt-5">
				<h3 class="text-[13px] font-medium text-text-primary">{m.settings_language({}, { locale })}</h3>
				<p class="mt-1 text-[12px] leading-5 text-text-tertiary">{m.settings_language_description({}, { locale })}</p>
				<div class="mt-4 grid gap-2 sm:grid-cols-3">{#each localeOptions as option (option.value)}{@const active = localePreference === option.value}<button type="button" class="group flex min-w-0 items-center gap-2 rounded-[6px] px-3 py-2.5 text-left transition-colors duration-100 {active ? 'bg-brand-bg text-text-primary' : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'}" onclick={() => handleLocaleChange(option.value)}><span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] {active ? 'bg-brand/15 text-brand' : 'bg-bg-hover-strong text-text-tertiary group-hover:text-text-secondary'}"><Languages class="h-3.5 w-3.5" /></span><span class="min-w-0 flex-1"><span class="block text-[12px] font-medium">{option.label}</span><span class="block truncate text-[10px] text-text-tertiary">{option.description}</span></span>{#if active}<Check class="h-3.5 w-3.5 shrink-0 text-brand" />{/if}</button>{/each}</div>
			</div>
			<div class="mt-6 border-t border-border-subtle pt-6">
				<h3 class="text-[13px] font-medium text-text-primary">{m.settings_theme({}, { locale })}</h3>
				<p class="mt-1 text-[12px] leading-5 text-text-tertiary">{m.settings_theme_description({}, { locale })}</p>
				<div class="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{#each THEME_OPTIONS as option (option.value)}{@const active = mode === option.value}{@const Icon = themeIcon[option.value]}<button type="button" class="group flex min-w-0 items-center gap-2 rounded-[6px] px-3 py-2.5 text-left transition-colors duration-100 {active ? 'bg-brand-bg text-text-primary' : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'}" onclick={(event) => handleThemeChange(option.value, event)}><span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] {active ? 'bg-brand/15 text-brand' : 'bg-bg-hover-strong text-text-tertiary group-hover:text-text-secondary'}"><Icon class="h-3.5 w-3.5" /></span><span class="min-w-0 flex-1"><span class="block text-[12px] font-medium">{localizedThemeLabel(option.value, locale)}</span><span class="block truncate text-[10px] text-text-tertiary">{localizedThemeDescription(option.value, locale)}</span></span>{#if active}<Check class="h-3.5 w-3.5 shrink-0 text-brand" />{/if}</button>{/each}</div>
			</div>
		</section>
	</section>
</div>
