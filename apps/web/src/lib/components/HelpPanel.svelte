<script lang="ts">
import { ArrowUpRight } from "lucide-svelte";
import Dialog from "$lib/components/Dialog.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { LICENSE, RELEASE, REPO_URL } from "$lib/project";

const locale = $derived(getLocale());
const keyChoices = $derived(
	new Intl.ListFormat(locale, { type: "disjunction" }),
);

type ShortcutCombo = string[];
type ShortcutItem = {
	label: string;
	keys: ShortcutCombo[];
};

type ShortcutSection = {
	title: string;
	description: string;
	items: ShortcutItem[];
};

const {
	open,
	onClose,
}: {
	open: boolean;
	onClose: () => void;
} = $props();

const sections: ShortcutSection[] = $derived([
	{
		title: m.help_global({}, { locale }),
		description: m.help_global_desc({}, { locale }),
		items: [
			{
				label: m.help_search_everywhere({}, { locale }),
				keys: [
					["⌘", "K"],
					["Ctrl", "K"],
				],
			},
			{
				label: m.help_new_chat({}, { locale }),
				keys: [
					["⌘", "O"],
					["Ctrl", "O"],
				],
			},
			{
				label: m.help_focus_chats({}, { locale }),
				keys: [
					["⌘", "⇧", "U"],
					["Ctrl", "Shift", "U"],
				],
			},
			{
				label: m.help_capture_mark({}, { locale }),
				keys: [
					["⌘", "⇧", "S"],
					["Ctrl", "Shift", "S"],
				],
			},
			{
				label: m.help_toggle_left({}, { locale }),
				keys: [
					["Ctrl", "⌥", "←"],
					["Ctrl", "Alt", "←"],
				],
			},
			{
				label: m.help_toggle_right({}, { locale }),
				keys: [
					["Ctrl", "⌥", "→"],
					["Ctrl", "Alt", "→"],
				],
			},
			{ label: m.help_open_help({}, { locale }), keys: [["?"]] },
		],
	},
	{
		title: m.help_session_page({}, { locale }),
		description: m.help_session_desc({}, { locale }),
		items: [
			{
				label: m.help_open_model_selector({}, { locale }),
				keys: [
					["⌘", "Shift", "M"],
					["Ctrl", "Shift", "M"],
				],
			},
			{ label: m.help_focus_composer({}, { locale }), keys: [["i"]] },
			{ label: m.help_scroll_down({}, { locale }), keys: [["j"]] },
			{ label: m.help_scroll_up({}, { locale }), keys: [["k"]] },
			{ label: m.help_next_turn({}, { locale }), keys: [["Shift", "J"]] },
			{ label: m.help_prev_turn({}, { locale }), keys: [["Shift", "K"]] },
			{ label: m.help_top({}, { locale }), keys: [["g", "g"]] },
			{ label: m.help_bottom({}, { locale }), keys: [["G"]] },
		],
	},
	{
		title: m.help_model_selector({}, { locale }),
		description: m.help_model_desc({}, { locale }),
		items: [
			{
				label: m.help_next_model({}, { locale }),
				keys: [["↓"], ["Ctrl", "N"]],
			},
			{
				label: m.help_prev_model({}, { locale }),
				keys: [["↑"], ["Ctrl", "P"]],
			},
			{ label: m.help_select({}, { locale }), keys: [["Enter"]] },
			{ label: m.help_close({}, { locale }), keys: [["Esc"]] },
		],
	},
	{
		title: m.help_composer({}, { locale }),
		description: m.help_composer_desc({}, { locale }),
		items: [
			{ label: m.help_send({}, { locale }), keys: [["Enter"]] },
			{
				label: m.help_force_send({}, { locale }),
				keys: [
					["⌘", "↵"],
					["Ctrl", "↵"],
				],
			},
			{ label: m.help_new_line({}, { locale }), keys: [["Shift", "↵"]] },
			{ label: m.help_blur({}, { locale }), keys: [["Esc"]] },
		],
	},
	{
		title: m.help_files({}, { locale }),
		description: m.help_files_desc({}, { locale }),
		items: [
			{
				label: m.help_save_file({}, { locale }),
				keys: [
					["⌘", "S"],
					["Ctrl", "S"],
				],
			},
		],
	},
]);
</script>

<Dialog {open} {onClose} title={m.help_title({}, { locale })} maxWidth="680px">
	<div class="help-sheet">
		<div class="shortcut-stack">
			{#each sections as section, sectionIndex (sectionIndex)}
				<section class="shortcut-section" aria-labelledby={`help-section-${sectionIndex}`}>
					<div class="section-meta">
						<h3 id={`help-section-${sectionIndex}`}>{section.title}</h3>
						<p>{section.description}</p>
					</div>
					<div class="shortcut-list">
						{#each section.items as item, itemIndex (itemIndex)}
							<div class="shortcut-row">
								<span class="shortcut-label">{item.label}</span>
								<span class="key-group" aria-label={keyChoices.format(item.keys.map((combo) => combo.join(" ")))}>
									{#each item.keys as combo, comboIndex (comboIndex)}
										<span class="key-combo">
											{#each combo as key, keyIndex (keyIndex)}
												<kbd>{key}</kbd>
											{/each}
										</span>
									{/each}
								</span>
							</div>
						{/each}
					</div>
				</section>
			{/each}

			<section class="shortcut-section doc-section" aria-labelledby="help-section-docs">
				<div class="section-meta">
					<h3 id="help-section-docs">{m.help_product({}, { locale })}</h3>
					<p>{m.help_product_desc({}, { locale })}</p>
				</div>
				<div class="doc-stack">
					<a href="/changelog" class="doc-card doc-card-link" onclick={onClose}>
						<div class="doc-copy-wrap">
							<div class="doc-title">{m.help_changelog({}, { locale })}</div>
							<div class="doc-copy">{m.help_changelog_copy({}, { locale })}</div>
						</div>
						{#if RELEASE}<span class="doc-status">{RELEASE}</span>{/if}
					</a>
					<a href={locale === "zh-CN" ? "/zh/docs" : "/docs"} class="doc-card doc-card-link" onclick={onClose}>
						<div class="doc-copy-wrap">
							<div class="doc-title">{m.help_docs({}, { locale })}</div>
							<div class="doc-copy">{m.help_docs_copy({}, { locale })}</div>
						</div>
					</a>
					<a href={REPO_URL} target="_blank" rel="noopener noreferrer" class="doc-card doc-card-link">
						<div class="doc-copy-wrap">
							<div class="doc-title">{m.help_source({}, { locale })}</div>
							<div class="doc-copy">{m.help_source_copy({ license: LICENSE }, { locale })}</div>
						</div>
						<ArrowUpRight class="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
					</a>
				</div>
			</section>
		</div>
	</div>
</Dialog>

<style>
	.help-sheet {
		padding: 0.5rem 0.58rem 0.62rem;
		background: var(--bg-primary);
	}
	.shortcut-stack {
		display: grid;
		gap: 0;
	}
	.shortcut-section {
		display: grid;
		grid-template-columns: minmax(7.2rem, 0.28fr) minmax(0, 1fr);
		gap: 0.7rem;
		align-items: start;
		border-top: 1px solid color-mix(in oklab, var(--border-subtle) 84%, transparent);
		padding: 0.5rem 0;
	}
	.shortcut-section:first-child {
		border-top: 0;
		padding-top: 0;
	}
	.shortcut-section:last-child {
		padding-bottom: 0;
	}
	.section-meta {
		display: grid;
		gap: 0.12rem;
		padding-top: 0.12rem;
	}
	.section-meta h3 {
		margin: 0;
		font-size: 11px;
		font-weight: 760;
		letter-spacing: 0.09em;
		line-height: 1.2;
		text-transform: uppercase;
		color: var(--text-primary);
	}
	.section-meta p {
		margin: 0;
		max-width: 10.8rem;
		font-size: 11px;
		line-height: 1.35;
		color: color-mix(in oklab, var(--text-secondary) 46%, var(--text-tertiary));
	}
	.shortcut-list {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(13.5rem, 1fr));
		gap: 0.24rem 0.5rem;
	}
	.shortcut-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.42rem;
		min-height: 1.46rem;
		padding: 0.08rem 0.14rem;
		border-radius: 7px;
		background: color-mix(in oklab, var(--bg-surface) 58%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--border-subtle) 52%, transparent);
		transition:
			background-color 120ms ease,
			box-shadow 120ms ease;
	}
	.shortcut-row:hover {
		background: color-mix(in oklab, var(--brand) 5%, var(--bg-surface));
		box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--brand) 18%, var(--border-subtle));
	}
	.shortcut-label {
		min-width: 0;
		font-size: 12px;
		font-weight: 620;
		line-height: 1.15;
		color: var(--text-primary);
	}
	.key-group {
		display: inline-flex;
		flex-wrap: nowrap;
		align-items: center;
		justify-content: flex-end;
		gap: 0.16rem;
		min-width: 0;
	}
	.key-combo {
		display: inline-flex;
		align-items: center;
		gap: 0.01rem;
		height: 1.18rem;
		padding: 0 0.18rem;
		border: 1px solid color-mix(in oklab, var(--brand) 26%, var(--border-subtle));
		border-radius: 5px;
		background: color-mix(in oklab, var(--brand) 9%, var(--bg-primary));
		box-shadow: inset 0 -1px 0 color-mix(in oklab, var(--brand) 13%, transparent);
		white-space: nowrap;
	}
	kbd {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 0.72rem;
		height: 1rem;
		border: 0;
		background: transparent;
		padding: 0 0.015rem;
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		font-size: 10px;
		font-weight: 820;
		letter-spacing: -0.01em;
		line-height: 1;
		color: color-mix(in oklab, var(--brand) 92%, var(--text-primary));
	}
	.doc-stack {
		display: grid;
		gap: 0.28rem;
		max-width: 100%;
	}
	.doc-card {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.9rem;
		max-width: 100%;
		padding: 0.28rem 0.42rem;
		border-radius: 7px;
		background: color-mix(in oklab, var(--bg-surface) 58%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--border-subtle) 52%, transparent);
		text-decoration: none;
		color: inherit;
		transition:
			background-color 120ms ease,
			box-shadow 120ms ease;
	}
	.doc-card-link:hover {
		background: color-mix(in oklab, var(--brand) 5%, var(--bg-surface));
		box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--brand) 18%, var(--border-subtle));
	}
	.doc-copy-wrap {
		min-width: 0;
	}
	.doc-title {
		font-size: 12px;
		font-weight: 650;
		color: var(--text-primary);
	}
	.doc-copy {
		margin-top: 0.08rem;
		font-size: 11px;
		line-height: 1.35;
		color: color-mix(in oklab, var(--text-secondary) 48%, var(--text-tertiary));
	}
	.doc-status {
		border-radius: 999px;
		background: color-mix(in oklab, var(--brand) 10%, var(--bg-primary));
		padding: 0.16rem 0.46rem;
		font-size: 10px;
		font-weight: 750;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--brand);
	}
	@media (max-width: 640px) {
		.help-sheet {
			padding: 0.6rem;
		}
		.shortcut-section {
			grid-template-columns: 1fr;
			gap: 0.36rem;
		}
		.section-meta p {
			max-width: none;
		}
		.shortcut-list {
			grid-template-columns: 1fr;
			gap: 0.2rem;
		}
		.shortcut-row {
			grid-template-columns: minmax(0, 1fr);
			gap: 0.28rem;
		}
		.key-group {
			justify-content: flex-start;
		}
	}
</style>
