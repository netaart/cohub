<script lang="ts">
import {
	isSafeBoardSourcePath,
	removeBoardScriptPatch,
} from "@neta-art/cohub/board";
import type { BoardStage } from "@neta-art/cohub/board/stage";
import { ChevronDown, Circle, Plus, Square, Trash2 } from "lucide-svelte";
import { untrack } from "svelte";
import type { BoardInputRecorder } from "#lib/board/board-input-recorder.svelte.ts";
import {
	type BoardScriptStatus,
	boardScriptRunsHere,
	watchBoardScriptStatus,
} from "#lib/board/board-script-status.ts";
import type { BoardEditor } from "#lib/board/editor.svelte.ts";
import BoardScriptPanel from "#lib/components/board/BoardScriptPanel.svelte";
import ToggleSwitch from "#lib/components/ToggleSwitch.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

const {
	editor,
	stage = null,
	inputRecorder,
	onOpenSource,
}: {
	editor: BoardEditor;
	stage?: BoardStage | null;
	inputRecorder?: BoardInputRecorder;
	onOpenSource?: (path: string) => void;
} = $props();

const locale = $derived(getLocale());
const scripts = $derived(Object.entries(editor.settings.scripts ?? {}));
let statuses = $state.raw<Record<string, BoardScriptStatus>>({});
let expanded = $state<string | null>(null);
let path = $state("");
let invalid = $state(false);

$effect(() => {
	const current = stage;
	const ids = scripts.filter(([, script]) => script.enabled).map(([id]) => id);
	if (!current) return;
	return untrack(() => {
		const next: Record<string, BoardScriptStatus> = {};
		const stops = ids.map((id) =>
			watchBoardScriptStatus(current, id, (status) => {
				next[id] = status;
				statuses = { ...next };
			}),
		);
		return () => {
			for (const stop of stops) stop();
		};
	});
});

function freeId(src: string): string {
	const base =
		(src.split("/").pop() ?? "script")
			.replace(/\.m?js$/, "")
			.replace(/[^\w-]+/g, "-")
			.slice(0, 60) || "script";
	const document = editor.document;
	const taken = (id: string) =>
		Boolean(
			document.items[id] ??
				document.animations[id] ??
				document.board.scripts?.[id],
		);
	let id = base;
	for (let index = 2; taken(id); index++) id = `${base}-${index}`;
	return id;
}

function add() {
	const src = path.trim().replace(/^\.?\//, "");
	if (!/\.m?js$/.test(src) || !isSafeBoardSourcePath(src)) {
		invalid = true;
		return;
	}
	invalid = false;
	path = "";
	const id = freeId(src);
	void editor.commitPatch({ board: { scripts: { [id]: { src } } } });
	expanded = id;
}

function setEnabled(id: string, enabled: boolean) {
	void editor.commitPatch({ board: { scripts: { [id]: { enabled } } } });
}

function remove(id: string) {
	if (expanded === id) expanded = null;
	void editor.commitPatch(removeBoardScriptPatch(editor.document, id));
}
</script>

<section class="scripts-section" aria-labelledby="board-scripts-title">
	<h3 id="board-scripts-title" class="field-label">{m.board_scripts_title({}, { locale })}</h3>
	<p class="section-hint">{m.board_scripts_hint({}, { locale })}</p>
	{#each scripts as [id, script] (id)}
		{@const status = statuses[id]}
		{@const here = boardScriptRunsHere(editor, script)}
		{@const state = !script.enabled || !here ? "off" : (status?.state ?? "starting")}
		<div class="script-row" title={script.enabled && !here ? m.board_script_off({}, { locale }) : undefined}>
			<button
				type="button"
				class="script-toggle"
				aria-expanded={expanded === id}
				disabled={state === "off" || !status}
				onclick={() => { expanded = expanded === id ? null : id; }}
			>
				<span class="script-dot" data-state={state} aria-hidden="true"></span>
				<span class="script-name" title={script.src}>{script.src.split("/").pop()}</span>
				{#if state !== "off" && status}
					<ChevronDown class="chevron h-3.5 w-3.5" />
				{/if}
			</button>
			<ToggleSwitch
				checked={script.enabled}
				label={m.board_scripts_run({ name: id }, { locale })}
				onchange={(next) => setEnabled(id, next)}
			/>
			<button
				type="button"
				class="icon-button"
				title={m.board_scripts_remove({}, { locale })}
				aria-label={m.board_scripts_remove({}, { locale })}
				onclick={() => remove(id)}
			>
				<Trash2 class="h-3.5 w-3.5" />
			</button>
		</div>
		{#if expanded === id && state !== "off" && status}
			<BoardScriptPanel
				{editor}
				ownerId={id}
				{status}
				placement="inline"
				{onOpenSource}
				onRestart={() => stage?.resetScripts(id)}
			/>
		{/if}
	{/each}
	<form class="add-row" onsubmit={(event) => { event.preventDefault(); add(); }}>
		<input
			type="text"
			bind:value={path}
			placeholder="scripts/rain.js"
			aria-label={m.board_scripts_path({}, { locale })}
			aria-invalid={invalid}
			oninput={() => { invalid = false; }}
		/>
		<button type="submit" class="add-button" disabled={!path.trim()}>
			<Plus class="h-3.5 w-3.5" />
			{m.board_scripts_add({}, { locale })}
		</button>
	</form>
	{#if invalid}
		<p class="error" role="status">{m.board_scripts_path_invalid({}, { locale })}</p>
	{/if}
	{#if inputRecorder && (inputRecorder.available || inputRecorder.startedAt !== null)}
		{@const recording = inputRecorder.startedAt !== null}
		<div class="record-row">
			<div class="record-copy">
				<span class="record-title">{m.board_input_title({}, { locale })}</span>
				<span class="section-hint">{m.board_input_hint({}, { locale })}</span>
			</div>
			<button type="button" class="secondary-key record-button" aria-pressed={recording} onclick={inputRecorder.toggle}>
				{#if recording}
					<Square class="h-3 w-3" fill="currentColor" aria-hidden="true" />
					{m.board_input_end({}, { locale })}
				{:else}
					<Circle class="record-icon h-3 w-3" fill="currentColor" aria-hidden="true" />
					{m.board_input_record({}, { locale })}
				{/if}
			</button>
		</div>
	{/if}
</section>

<style>
	.scripts-section { display: grid; gap: 6px; margin: 12px 2px 4px; padding-top: 10px; border-top: 1px solid var(--border-subtle); }
	.field-label { margin: 0; color: var(--text-tertiary); font-size: 11px; font-weight: 400; }
	.section-hint { margin: 0 0 2px; color: var(--text-tertiary); font-size: 10px; line-height: 1.35; }
	.script-row { display: flex; align-items: center; gap: 6px; min-height: 32px; }
	.script-toggle { display: flex; flex: 1; align-items: center; gap: 6px; min-width: 0; min-height: 32px; border-radius: 6px; padding: 0 6px; color: var(--text-primary); font-size: 12px; text-align: left; }
	.script-toggle:not(:disabled):hover { background: var(--bg-hover); }
	.script-toggle :global(.chevron) { flex-shrink: 0; margin-left: auto; color: var(--text-tertiary); transition: transform 150ms ease; }
	.script-toggle[aria-expanded="true"] :global(.chevron) { transform: rotate(180deg); }
	.script-dot { flex-shrink: 0; width: 6px; height: 6px; border-radius: 50%; background: var(--text-tertiary); }
	.script-dot[data-state="running"] { background: var(--success-500); }
	.script-dot[data-state="error"] { background: var(--error-500); }
	.script-dot[data-state="off"] { background: transparent; box-shadow: inset 0 0 0 1px var(--text-tertiary); }
	.script-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.icon-button { display: grid; flex-shrink: 0; place-items: center; width: 32px; height: 32px; border-radius: 6px; color: var(--text-tertiary); }
	.icon-button:hover { background: var(--bg-hover); color: var(--error-700); }
	.add-row { display: flex; gap: 6px; }
	.add-row input { min-width: 0; flex: 1; height: 30px; border: 1px solid var(--border-subtle); border-radius: 6px; background: var(--bg-input); padding: 0 8px; color: var(--text-primary); font-size: 12px; }
	.add-row input[aria-invalid="true"] { border-color: var(--error-500); }
	.add-button { display: inline-flex; align-items: center; gap: 4px; height: 30px; border-radius: 6px; padding: 0 9px; background: var(--brand-bg); color: var(--brand-muted-fg); font-size: 11px; }
	.add-button:disabled { opacity: .45; }
	.error { margin: 0; color: var(--error-700); font-size: 11px; line-height: 1.35; }
	.record-row { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
	.record-copy { display: grid; flex: 1; gap: 2px; min-width: 0; }
	.record-title { color: var(--text-primary); font-size: 12px; }
	.record-copy .section-hint { margin: 0; }
	.record-button { flex-shrink: 0; min-width: 76px; height: 28px; padding: 0 10px; font-size: 11px; }
	.record-button :global(.record-icon) { color: var(--error-500); }
	@media (pointer: coarse) { .script-row, .script-toggle, .icon-button { min-height: 40px; } .icon-button { width: 40px; height: 40px; } .add-row input, .add-button, .record-button { height: 40px; } }
</style>
