<script lang="ts">
import type { SpaceRecord } from "@neta-art/cohub";
import { Heart, Loader2, Upload } from "lucide-svelte";
import UploadProgress from "$lib/components/UploadProgress.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import {
	LikeStickerImageError,
	uploadSpaceLikeStickerImage,
} from "$lib/public-asset-images";
import { sdk } from "$lib/sdk";
import { describeUploadError } from "$lib/upload-errors";
import SettingsRow from "./SettingsRow.svelte";

type Props = {
	spaceId: string;
	likeSticker: string | null;
	canEdit: boolean;
	onSaved: (space: SpaceRecord) => void;
};

const { spaceId, likeSticker, canEdit, onSaved }: Props = $props();

const locale = $derived(getLocale());
let busy = $state(false);
let progress = $state<number | null>(null);
let error = $state("");

async function save(file: File | null) {
	if (busy) return;
	busy = true;
	progress = null;
	error = "";
	try {
		const asset = file
			? await uploadSpaceLikeStickerImage({
					spaceId,
					file,
					onProgress: ({ ratio }) => (progress = Math.round(ratio * 100)),
				})
			: null;
		progress = null;
		const result = await sdk.space(spaceId).profile({
			likeSticker: asset ? { url: asset.publicUrl } : null,
		});
		onSaved(result.space);
	} catch (err) {
		error =
			err instanceof LikeStickerImageError
				? m.space_like_sticker_invalid({}, { locale })
				: (describeUploadError(err, locale) ??
					m.space_like_sticker_failed({}, { locale }));
	} finally {
		busy = false;
		progress = null;
	}
}

function pick(event: Event) {
	const input = event.currentTarget as HTMLInputElement;
	const file = input.files?.[0];
	input.value = "";
	if (file) void save(file);
}
</script>

<SettingsRow
	label={m.space_like_sticker({}, { locale })}
	hint={m.space_like_sticker_hint({}, { locale })}
>
	{#snippet control()}
		<span
			class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] border border-border-subtle bg-bg-elevated/40 text-brand"
			aria-hidden="true"
		>
			{#if likeSticker}
				<img
					src={likeSticker}
					alt=""
					class="h-6 w-6 object-contain"
					decoding="async"
				/>
			{:else}
				<Heart class="h-4 w-4" fill="currentColor" />
			{/if}
		</span>
		{#if canEdit}
			<label
				class="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[5px] border border-border-subtle px-2.5 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary focus-within:border-brand/40 lg:h-8 {busy
					? 'pointer-events-none opacity-60'
					: ''}"
			>
				{#if busy}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Upload
						class="h-3.5 w-3.5"
					/>{/if}
				{likeSticker
					? m.space_change({}, { locale })
					: m.space_upload({}, { locale })}
				<input
					type="file"
					accept="image/png,image/gif,image/webp"
					class="sr-only"
					disabled={busy}
					onchange={pick}
				/>
			</label>
			{#if likeSticker}
				<button
					type="button"
					class="inline-flex h-9 items-center rounded-[5px] px-2 text-[12px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-60 lg:h-8"
					disabled={busy}
					onclick={() => void save(null)}
					>{m.space_like_sticker_reset({}, { locale })}</button
				>
			{/if}
		{/if}
	{/snippet}
	{#if busy && progress !== null}
		<UploadProgress class="mt-3 rounded-full" value={progress} />
	{/if}
	{#if error}
		<p class="mt-2 text-[12px] text-error-soft break-words" aria-live="polite">
			{error}
		</p>
	{/if}
</SettingsRow>
