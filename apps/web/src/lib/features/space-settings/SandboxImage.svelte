<script lang="ts">
import type {
	SandboxImageId,
	SandboxPreferenceStatus,
} from "@cohub/protocol/sandbox";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import SettingsRow, { SETTINGS_SELECT } from "./SettingsRow.svelte";

const {
	status,
	disabled,
	error,
	onChange,
}: {
	status: SandboxPreferenceStatus;
	disabled: boolean;
	error?: string;
	onChange: (image: SandboxImageId | null) => void;
} = $props();

const locale = $derived(getLocale());
const inherited = $derived(
	status.sources.findLast(
		(source) => source.source !== "override" && source.preferences.image,
	)?.preferences.image ?? "default",
);
const imageLabel = (image: SandboxImageId) =>
	image === "game"
		? m.sandbox_image_game({}, { locale })
		: m.sandbox_image_default({}, { locale });
</script>

<SettingsRow
	label={m.sandbox_image({}, { locale })}
	hint={status.applicable ? m.sandbox_image_hint({}, { locale }) : m.sandbox_environment_local({}, { locale })}
	for="sandbox-image"
>
	{#snippet control()}
		<select
			id="sandbox-image"
			class={SETTINGS_SELECT}
			value={status.overrides.image ?? "auto"}
			disabled={disabled || !status.applicable}
			onchange={(event) => {
				const value = event.currentTarget.value;
				onChange(value === "auto" ? null : (value as SandboxImageId));
			}}
		>
			<option value="auto">{m.sandbox_follow_config({}, { locale })} · {imageLabel(inherited)}</option>
			{#each status.images as image (image)}<option value={image}>{imageLabel(image)}</option>{/each}
		</select>
	{/snippet}
	{#if status.applicable && status.warnings.includes("image_unavailable")}
		<p class="mt-2 text-[12px] text-text-secondary">{m.sandbox_image_unavailable({}, { locale })}</p>
	{/if}
	{#if error}<p class="mt-2 break-words text-[12px] text-error-soft">{error}</p>{/if}
</SettingsRow>
