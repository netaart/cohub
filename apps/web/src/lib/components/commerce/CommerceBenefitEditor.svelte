<script lang="ts">
import type { SpaceCommerceBenefit } from "@neta-art/cohub";
import { Plus, Trash2 } from "lucide-svelte";
import { untrack } from "svelte";
import Spinner from "#lib/components/Spinner.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

const locale = $derived(getLocale());

type BenefitType = "feature" | "credits";
type MetaType = "string" | "number" | "boolean";

type MetaRow = {
	id: string;
	key: string;
	type: MetaType;
	/** Stored as a string; parsed according to `type` on submit. */
	value: string;
};

type SubmitInput =
	| {
			type: "feature";
			name: string;
			description?: string;
			metadata: Record<string, string | number | boolean>;
	  }
	| {
			type: "credits";
			name: string;
			description?: string;
			amount: number;
			expiresInDays?: number;
	  };

const {
	benefit,
	onSubmit,
	onCancel,
	busy = false,
}: {
	benefit?: SpaceCommerceBenefit | null;
	onSubmit: (input: SubmitInput) => Promise<void>;
	onCancel: () => void;
	busy?: boolean;
} = $props();

const isEdit = $derived(Boolean(benefit));

function makeRow(partial: Partial<MetaRow> = {}): MetaRow {
	return {
		id: crypto.randomUUID(),
		key: "",
		type: "string",
		value: "",
		...partial,
	};
}

function parseMetadata(
	metadata: Record<string, string | number | boolean>,
): MetaRow[] {
	return Object.entries(metadata).map(([rowKey, value]) => {
		const type: MetaType =
			typeof value === "boolean"
				? "boolean"
				: typeof value === "number"
					? "number"
					: "string";
		return {
			id: crypto.randomUUID(),
			key: rowKey,
			type,
			value: type === "boolean" ? (value ? "true" : "false") : String(value),
		};
	});
}

const seed = untrack(() => {
	const benefitType = benefit?.type ?? "feature";
	if (benefitType === "credits" && benefit?.type === "credits") {
		return {
			key: benefit?.key ?? "",
			name: benefit?.name ?? "",
			description: benefit?.description ?? "",
			type: "credits" as BenefitType,
			amount: String(benefit.config.amount ?? ""),
			expiresInDays:
				benefit.config.expiresInDays != null
					? String(benefit.config.expiresInDays)
					: "",
			rows: [] as MetaRow[],
		};
	}
	const metadata = benefit?.type === "feature" ? benefit.config.metadata : {};
	const hasMetadata = metadata && Object.keys(metadata).length > 0;
	return {
		key: benefit?.key ?? "",
		name: benefit?.name ?? "",
		description: benefit?.description ?? "",
		type: "feature" as BenefitType,
		amount: "",
		expiresInDays: "",
		rows: hasMetadata
			? parseMetadata(metadata)
			: [makeRow({ key: "enabled", type: "boolean", value: "true" })],
	};
});

const systemKey = seed.key;
let benefitType = $state<BenefitType>(seed.type);
let name = $state(seed.name);
let description = $state(seed.description);
let creditAmount = $state(seed.amount);
let creditExpiresInDays = $state(seed.expiresInDays);
let error = $state("");
let rows = $state<MetaRow[]>(seed.rows);

const isCredits = $derived(benefitType === "credits");
const typeLocked = $derived(isEdit);

function switchType(type: BenefitType) {
	if (typeLocked || busy) return;
	benefitType = type;
	if (type === "feature" && rows.length === 0) {
		rows = [makeRow({ key: "enabled", type: "boolean", value: "true" })];
	}
}

function addRow() {
	rows = [...rows, makeRow()];
}

function removeRow(id: string) {
	rows = rows.filter((row) => row.id !== id);
}

function changeType(id: string, type: MetaType) {
	rows = rows.map((row) =>
		row.id === id
			? {
					...row,
					type,
					value: type === "boolean" ? "true" : type === "number" ? "0" : "",
				}
			: row,
	);
}

function buildMetadata(): Record<string, string | number | boolean> {
	const metadata: Record<string, string | number | boolean> = {};
	for (const row of rows) {
		const rowKey = row.key.trim();
		if (!rowKey) continue;
		if (row.type === "boolean") {
			metadata[rowKey] = row.value === "true";
		} else if (row.type === "number") {
			metadata[rowKey] = row.value === "" ? 0 : Number(row.value);
		} else {
			metadata[rowKey] = row.value;
		}
	}
	return metadata;
}

const nameInvalid = $derived(!name.trim());
const parsedAmount = $derived(
	creditAmount.trim() === "" ? null : Number.parseInt(creditAmount, 10),
);
const amountInvalid = $derived(
	isCredits &&
		(parsedAmount === null ||
			!Number.isSafeInteger(parsedAmount) ||
			parsedAmount < 1 ||
			String(parsedAmount) !== creditAmount.trim()),
);
const formInvalid = $derived(nameInvalid || (isCredits && amountInvalid));

async function submit() {
	error = "";
	if (formInvalid) return;
	try {
		if (isCredits) {
			const amount = Number.parseInt(creditAmount.trim(), 10);
			if (!Number.isSafeInteger(amount) || amount < 1) return;
			const expiresInDaysRaw = creditExpiresInDays.trim();
			const expiresInDays = expiresInDaysRaw
				? Number.parseInt(expiresInDaysRaw, 10)
				: undefined;
			if (
				expiresInDays !== undefined &&
				(!Number.isSafeInteger(expiresInDays) || expiresInDays < 1)
			)
				return;
			await onSubmit({
				type: "credits",
				name: name.trim(),
				description: description.trim() || undefined,
				amount,
				expiresInDays,
			});
		} else {
			await onSubmit({
				type: "feature",
				name: name.trim(),
				description: description.trim() || undefined,
				metadata: buildMetadata(),
			});
		}
	} catch (err) {
		error =
			err instanceof Error
				? err.message
				: m.benefit_editor_save_failed({}, { locale });
	}
}

const inputClass =
	"h-9 w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 text-[13px] text-text-primary placeholder:text-text-placeholder transition-colors focus:border-brand/50 focus:outline-none disabled:opacity-60";
const labelClass =
	"text-[11px] font-medium uppercase tracking-wide text-text-tertiary";
const readonlyClass =
	"flex h-9 w-full items-center rounded-[6px] border border-border-subtle bg-bg-input px-3 font-mono text-[13px] text-text-tertiary";
</script>

<div class="flex flex-col gap-4 p-4 sm:p-5">
	<!-- Type selector -->
	<div class="flex flex-col gap-1.5">
		<span class={labelClass}>{m.benefit_editor_type({}, { locale })}</span>
		<div class="inline-flex w-fit rounded-[6px] border border-border-subtle bg-bg-subtle p-0.5 text-[12px]">
			<button
				type="button"
				class="rounded-[5px] px-3 py-1.5 font-medium transition-colors {benefitType === 'feature' ? 'bg-bg-input text-text-primary shadow-sm' : 'text-text-placeholder hover:text-text-tertiary'}"
				onclick={() => switchType("feature")}
				disabled={typeLocked || busy}
			>
				{m.benefit_editor_feature({}, { locale })}
			</button>
			<button
				type="button"
				class="rounded-[5px] px-3 py-1.5 font-medium transition-colors {benefitType === 'credits' ? 'bg-bg-input text-text-primary shadow-sm' : 'text-text-placeholder hover:text-text-tertiary'}"
				onclick={() => switchType("credits")}
				disabled={typeLocked || busy}
			>
				{m.benefit_editor_credits({}, { locale })}
			</button>
		</div>
		<span class="text-[11px] text-text-tertiary">
			{isCredits
				? m.benefit_editor_credits_hint({}, { locale })
				: m.benefit_editor_feature_hint({}, { locale })}
		</span>
	</div>

	{#if isEdit}
		<div class="grid gap-4 sm:grid-cols-2">
			<div class="flex flex-col gap-1.5">
				<label class={labelClass} for="benefit-name">{m.benefit_editor_name({}, { locale })}</label>
				<input
					id="benefit-name"
					class={inputClass}
					bind:value={name}
					disabled={busy}
					placeholder={m.benefit_editor_name_placeholder_edit({}, { locale })}
					autocomplete="off"
				/>
			</div>
			<div class="flex flex-col gap-1.5">
				<span class={labelClass}>{m.benefit_editor_system_key({}, { locale })}</span>
				<div class={readonlyClass}>{systemKey}</div>
				<span class="text-[11px] text-text-tertiary">{m.benefit_editor_system_key_hint({}, { locale })}</span>
			</div>
		</div>
	{:else}
		<div class="flex flex-col gap-1.5">
			<label class={labelClass} for="benefit-name">{m.benefit_editor_name({}, { locale })}</label>
			<input
				id="benefit-name"
				class={inputClass}
				bind:value={name}
				disabled={busy}
				placeholder={isCredits ? m.benefit_editor_name_placeholder_credits({}, { locale }) : m.benefit_editor_name_placeholder_edit({}, { locale })}
				autocomplete="off"
			/>
			<span class="text-[11px] text-text-tertiary">{m.benefit_editor_key_hint({}, { locale })}</span>
		</div>
	{/if}

	<div class="flex flex-col gap-1.5">
		<label class={labelClass} for="benefit-description">{m.benefit_editor_description({}, { locale })}</label>
		<textarea
			id="benefit-description"
			class="min-h-16 w-full resize-y rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[13px] leading-5 text-text-primary placeholder:text-text-placeholder transition-colors focus:border-brand/50 focus:outline-none disabled:opacity-60"
			bind:value={description}
			disabled={busy}
			rows={2}
			maxlength="2048"
			placeholder={m.benefit_editor_desc_placeholder({}, { locale })}
		></textarea>
	</div>

	{#if isCredits}
		<!-- Credits configuration -->
		<div class="grid gap-4 sm:grid-cols-2">
			<div class="flex flex-col gap-1.5">
				<label class={labelClass} for="credit-amount">{m.benefit_editor_amount({}, { locale })}</label>
				<input
					id="credit-amount"
					class={inputClass + " font-mono"}
					type="number"
					min="1"
					step="1"
					bind:value={creditAmount}
					disabled={busy || isEdit}
					placeholder={m.benefit_editor_amount_placeholder({}, { locale })}
					autocomplete="off"
				/>
				<span class="text-[11px] text-text-tertiary">{m.benefit_editor_amount_hint({}, { locale })}</span>
			</div>
			<div class="flex flex-col gap-1.5">
				<label class={labelClass} for="credit-expires">{m.benefit_editor_expires({}, { locale })}</label>
				<input
					id="credit-expires"
					class={inputClass + " font-mono"}
					type="number"
					min="1"
					step="1"
					bind:value={creditExpiresInDays}
					disabled={busy || isEdit}
					placeholder={m.benefit_editor_expires_placeholder({}, { locale })}
					autocomplete="off"
				/>
				<span class="text-[11px] text-text-tertiary">{m.benefit_editor_expires_hint({}, { locale })}</span>
			</div>
		</div>
	{:else}
		<!-- Metadata editor -->
		<div class="flex flex-col gap-2">
			<div class="flex items-center justify-between">
				<span class={labelClass}>{m.benefit_editor_metadata({}, { locale })}</span>
				<button
					type="button"
					class="inline-flex h-7 items-center gap-1 rounded-[5px] px-2 text-[11px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
					onclick={addRow}
					disabled={busy}
				>
					<Plus class="h-3 w-3" /> {m.benefit_editor_add_field({}, { locale })}
				</button>
			</div>
			<span class="text-[11px] text-text-tertiary">{m.benefit_editor_metadata_hint_before({}, { locale })}<code class="font-mono text-text-secondary">enabled</code>{m.benefit_editor_metadata_hint_after({}, { locale })}</span>

			<div class="flex flex-col gap-2">
				{#each rows as row (row.id)}
					<div class="flex flex-wrap items-center gap-2">
						<input
							class={inputClass + " min-w-[120px] flex-1 font-mono"}
							bind:value={row.key}
							disabled={busy}
							placeholder="enabled"
							autocomplete="off"
							spellcheck="false"
						/>
						<select
							class="h-9 rounded-[6px] border border-border-subtle bg-bg-input px-2 text-[12px] text-text-primary transition-colors focus:border-brand/50 focus:outline-none disabled:opacity-60"
							value={row.type}
							onchange={(e) => changeType(row.id, e.currentTarget.value as MetaType)}
							disabled={busy}
							aria-label={m.benefit_editor_field_type({}, { locale })}
						>
							<option value="string">text</option>
							<option value="number">number</option>
							<option value="boolean">bool</option>
						</select>
						{#if row.type === "boolean"}
							<button
								type="button"
								class="secondary-key h-9 min-w-[72px] flex-1 px-3 text-[13px]"
								onclick={() => (row.value = row.value === "true" ? "false" : "true")}
								disabled={busy}
							>
								{row.value === "true" ? "true" : "false"}
							</button>
						{:else if row.type === "number"}
							<input
								class={inputClass + " min-w-[100px] flex-1 font-mono"}
								type="number"
								bind:value={row.value}
								disabled={busy}
								placeholder="0"
							/>
						{:else}
							<input
								class={inputClass + " min-w-[100px] flex-1"}
								bind:value={row.value}
								disabled={busy}
								placeholder="value"
							/>
						{/if}
						<button
							type="button"
							class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] text-text-placeholder transition-colors hover:bg-bg-hover hover:text-error-soft disabled:opacity-50"
							onclick={() => removeRow(row.id)}
							disabled={busy}
							aria-label={m.benefit_editor_remove_field({}, { locale })}
						>
							<Trash2 class="h-3.5 w-3.5" />
						</button>
					</div>
				{:else}
					<div class="rounded-[6px] border border-dashed border-border-subtle px-3 py-4 text-center text-[12px] text-text-tertiary">
						{m.benefit_editor_no_fields({}, { locale })}
					</div>
				{/each}
			</div>
		</div>
	{/if}

	{#if error}
		<div class="rounded-[6px] border border-error-soft/30 bg-error-bg px-3 py-2 text-[12px] text-error-soft">{error}</div>
	{/if}

	<div class="flex items-center justify-end gap-2 pt-1">
		<button
			type="button"
			class="inline-flex h-9 items-center justify-center rounded-[6px] px-3 text-[12px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
			onclick={onCancel}
			disabled={busy}
		>
			{m.benefit_editor_cancel({}, { locale })}
		</button>
		<button
			type="button"
			class="primary-key h-9 gap-1.5 px-3 text-[12px]"
			onclick={() => void submit()}
			disabled={busy || formInvalid}
		>
			{#if busy}<Spinner class="h-3.5 w-3.5" />{/if}
			{isEdit ? m.benefit_editor_save({}, { locale }) : m.benefit_editor_create({}, { locale })}
		</button>
	</div>
</div>
