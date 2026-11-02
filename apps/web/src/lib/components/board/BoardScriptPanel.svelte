<script lang="ts">
import type { BoardScriptParameter } from "@neta-art/cohub/board";
import { Copy, FileCode, RotateCcw, X } from "lucide-svelte";
import type { BoardScriptStatus } from "$lib/board/board-script-status";
import type { BoardEditor } from "$lib/board/editor.svelte";
import { copyTextToClipboard } from "$lib/clipboard";
import ToggleSwitch from "$lib/components/ToggleSwitch.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	editor,
	ownerId,
	status,
	placement = "floating",
	onOpenSource,
	onRestart,
	onClose,
}: {
	editor: BoardEditor;
	ownerId: string;
	status: BoardScriptStatus;
	placement?: "floating" | "sheet" | "inline";
	onOpenSource?: (path: string) => void;
	onRestart: () => void;
	onClose?: () => void;
} = $props();

const locale = $derived(getLocale());
const boardScript = $derived(editor.settings.scripts?.[ownerId]);
const script = $derived(boardScript ?? editor.itemById(ownerId)?.script);
const fileName = $derived(script?.src.split("/").pop() ?? "");
const parameters = $derived(Object.entries(status.parameters));
let copied = $state(false);

const position = $derived.by(() => {
	if (placement !== "floating") return null;
	const bounds = editor.bounds;
	if (!bounds) return null;
	const { zoom, x, y } = editor.camera;
	return {
		left: (bounds.x + bounds.width / 2) * zoom + x,
		top: (bounds.y + bounds.height) * zoom + y + 12,
	};
});

function paramValue(key: string, spec: BoardScriptParameter) {
	return script?.params[key] ?? spec.default;
}

function write(key: string, value: string | number | boolean) {
	if (!script || script.params[key] === value) return;
	const params = { params: { [key]: value } };
	void editor.commitPatch(
		boardScript
			? { board: { scripts: { [ownerId]: params } } }
			: { items: { [ownerId]: { script: params } } },
	);
}

function writeNumber(key: string, spec: BoardScriptParameter, raw: string) {
	const parsed = Number(raw);
	if (!raw.trim() || !Number.isFinite(parsed)) return;
	const clamped = Math.min(
		spec.max ?? Number.POSITIVE_INFINITY,
		Math.max(spec.min ?? Number.NEGATIVE_INFINITY, parsed),
	);
	write(key, clamped);
}

async function copyError() {
	if (!status.error) return;
	await copyTextToClipboard(status.error).catch(() => undefined);
	copied = true;
	setTimeout(() => {
		copied = false;
	}, 1600);
}

function stopKeys(event: KeyboardEvent) {
	if (event.key === "Escape" && onClose) {
		event.preventDefault();
		onClose();
	}
	event.stopPropagation();
}
</script>

{#if script && !editor.gestureActive && (placement !== "floating" || position)}
	<div
		class="script-panel"
		class:menu-surface={placement !== "inline"}
		class:script-panel--sheet={placement === "sheet"}
		class:script-panel--inline={placement === "inline"}
		style:left={position ? `${position.left}px` : undefined}
		style:top={position ? `${position.top}px` : undefined}
		role="dialog"
		tabindex="-1"
		aria-label={m.board_script_settings({}, { locale })}
		onkeydown={stopKeys}
		onpointerdown={(event) => event.stopPropagation()}
	>
		{#if placement !== "inline"}
			<header class="script-head">
				<span class="script-dot" data-state={status.state} aria-hidden="true"></span>
				<span class="script-name" title={script.src}>{fileName}</span>
				<span class="script-state">
					{status.state === "error"
						? m.board_script_failed({}, { locale })
						: status.state === "running"
							? m.board_script_running({}, { locale })
							: m.board_script_starting({}, { locale })}
				</span>
				{#if onClose}
					<button type="button" class="script-icon" title={m.board_close({}, { locale })} aria-label={m.board_close({}, { locale })} onclick={onClose}>
						<X class="h-3.5 w-3.5" />
					</button>
				{/if}
			</header>
		{/if}

		{#if status.error}
			<div class="script-error">
				<pre>{status.error}</pre>
				<button type="button" class="script-link" onclick={copyError}>
					<Copy class="h-3 w-3" />
					{copied ? m.board_script_copied({}, { locale }) : m.board_script_copy_error({}, { locale })}
				</button>
			</div>
		{:else if parameters.length > 0}
			<div class="script-params">
				{#each parameters as [key, spec] (key)}
					{@const value = paramValue(key, spec)}
					{@const label = spec.label ?? key}
					<label class="script-param" class:script-param--inline={spec.type === "boolean"}>
						<span class="script-param-label">{label}</span>
						{#if spec.type === "boolean"}
							<ToggleSwitch checked={value === true} {label} onchange={(next) => write(key, next)} />
						{:else if spec.type === "number"}
							<span class="script-number">
								{#if spec.min !== undefined && spec.max !== undefined}
									<input
										type="range"
										min={spec.min}
										max={spec.max}
										step={spec.step ?? "any"}
										value={Number(value ?? spec.min)}
										aria-label={label}
										onchange={(event) => writeNumber(key, spec, event.currentTarget.value)}
									/>
								{/if}
								<input
									class="script-input script-input--number"
									type="text"
									inputmode="decimal"
									value={value ?? ""}
									aria-label={label}
									onchange={(event) => writeNumber(key, spec, event.currentTarget.value)}
								/>
							</span>
						{:else if spec.type === "color"}
							<input
								class="script-color"
								type="color"
								value={typeof value === "string" ? value : "#000000"}
								aria-label={label}
								onchange={(event) => write(key, event.currentTarget.value)}
							/>
						{:else}
							<input
								class="script-input"
								type="text"
								value={value ?? ""}
								aria-label={label}
								onchange={(event) => write(key, event.currentTarget.value)}
							/>
						{/if}
					</label>
				{/each}
			</div>
		{:else if status.state === "running"}
			<p class="script-empty">{m.board_script_no_parameters({}, { locale })}</p>
		{/if}

		<footer class="script-foot">
			{#if onOpenSource}
				<button type="button" class="script-link" onclick={() => onOpenSource(script.src)}>
					<FileCode class="h-3.5 w-3.5" />
					{m.board_script_open_source({}, { locale })}
				</button>
			{/if}
			<button type="button" class="script-link" onclick={onRestart}>
				<RotateCcw class="h-3.5 w-3.5" />
				{m.board_script_restart({}, { locale })}
			</button>
		</footer>
	</div>
{/if}

<style>
	.script-panel {
		position: absolute;
		z-index: 31;
		display: flex;
		flex-direction: column;
		gap: 8px;
		width: 264px;
		max-width: calc(100% - 16px);
		transform: translateX(-50%);
		padding: 8px;
		color: var(--text-primary);
		font-size: 12px;
	}
	.script-panel--inline {
		position: static;
		width: auto;
		max-width: none;
		transform: none;
		padding: 2px 0 0;
	}
	.script-panel--sheet {
		right: 8px;
		bottom: calc(64px + env(safe-area-inset-bottom, 0px));
		left: 8px;
		width: auto;
		max-width: none;
		transform: none;
		border-radius: 14px;
		padding: 12px;
	}

	.script-head {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}
	.script-dot {
		flex-shrink: 0;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--text-tertiary);
	}
	.script-dot[data-state="running"] { background: var(--success-500); }
	.script-dot[data-state="error"] { background: var(--error-500); }
	.script-name {
		min-width: 0;
		overflow: hidden;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.script-state {
		flex: 1;
		color: var(--text-tertiary);
		font-size: 11px;
		white-space: nowrap;
	}
	.script-icon {
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		border-radius: 6px;
		color: var(--text-tertiary);
	}
	.script-icon:hover { background: var(--bg-hover); color: var(--text-primary); }

	.script-error {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
		border-radius: 6px;
		background: var(--color-error-bg);
		padding: 6px 8px;
		color: var(--color-error-soft);
	}
	.script-error pre {
		max-height: 132px;
		width: 100%;
		overflow: auto;
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 1.45;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.script-params {
		display: flex;
		flex-direction: column;
		gap: 8px;
		max-height: 260px;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.script-param {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.script-param--inline {
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
	}
	.script-param-label {
		overflow: hidden;
		color: var(--text-secondary);
		font-size: 11px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.script-number {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.script-number input[type="range"] {
		flex: 1;
		min-width: 0;
		accent-color: var(--brand);
	}
	.script-input {
		flex: 1;
		min-width: 0;
		height: 26px;
		border: 1px solid var(--border-subtle);
		border-radius: 6px;
		background: var(--bg-input);
		padding: 0 7px;
		color: var(--text-primary);
		font-size: 12px;
		outline: none;
	}
	.script-input:focus { border-color: var(--brand-border); }
	.script-input--number {
		flex: none;
		width: 56px;
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
	.script-color {
		width: 40px;
		height: 26px;
		border: 1px solid var(--border-subtle);
		border-radius: 6px;
		background: transparent;
		padding: 2px;
	}

	.script-empty {
		color: var(--text-tertiary);
		font-size: 11px;
	}

	.script-foot {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		border-top: 1px solid var(--border-subtle);
		padding-top: 6px;
	}
	.script-link {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		border-radius: 6px;
		padding: 4px 6px;
		color: var(--text-secondary);
		font-size: 11px;
	}
	.script-link:hover { background: var(--bg-hover); color: var(--text-primary); }
	.script-error .script-link { padding: 2px 4px; margin-left: -4px; color: inherit; }

	@media (pointer: coarse) {
		.script-icon { width: 36px; height: 36px; }
		.script-link { min-height: 36px; padding: 6px 10px; font-size: 12px; }
		.script-input, .script-color { height: 36px; }
	}
</style>
