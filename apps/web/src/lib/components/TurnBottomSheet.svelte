<script lang="ts">
import type { SessionTurnIndexItem } from "@cohub/protocol/model";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import {
	formatCompactAbsoluteTime,
	formatFullAbsoluteTime,
} from "#lib/time-format.ts";
import {
	formatTurnNavPreview,
	formatTurnNavPreviewDisplay,
	getTurnNavAttachmentLabel,
	getTurnNavAuthorName,
	shouldShowTurnNavAuthors,
} from "#lib/turn-nav-preview.ts";

type Props = {
	open: boolean;
	turns: SessionTurnIndexItem[];
	currentSequence?: number | null;
	onClose?: () => void;
	onJump?: (sequence: number) => void;
};

let { open, turns, currentSequence = null, onClose, onJump }: Props = $props();

const locale = $derived(getLocale());

const showAuthors = $derived(shouldShowTurnNavAuthors(turns));

function jump(sequence: number) {
	onJump?.(sequence);
	onClose?.();
}

function statusTone(status: SessionTurnIndexItem["status"]) {
	if (status === "failed") return "text-error-soft";
	if (status === "running") return "text-info-soft";
	if (status === "interrupted") return "text-warning-soft";
	return "text-text-tertiary";
}
</script>

{#if open}
	<div class="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label={m.bottom_sheet_aria({}, { locale })}>
		<button class="absolute inset-0 h-full w-full bg-overlay-scrim" aria-label={m.bottom_sheet_close({}, { locale })} onclick={onClose}></button>
		<div class="absolute inset-x-0 bottom-0 max-h-[72vh] rounded-t-2xl border-t border-border-subtle bg-bg-primary shadow-[0_-12px_36px_rgba(0,0,0,0.28)]">
			<div class="mx-auto mt-2.5 h-1 w-9 rounded-full bg-border-subtle"></div>
			<div class="max-h-[66vh] overflow-y-auto pb-2 pt-2">
				{#each turns as turn (`${turn.sequence}:${turn.id}`)}
					{@const fullPreview = formatTurnNavPreview(turn)}
					{@const preview = formatTurnNavPreviewDisplay(turn)}
					{@const attachmentLabel = getTurnNavAttachmentLabel(turn)}
					{@const timeLabel = formatCompactAbsoluteTime(turn.createdAt)}
					{@const fullTime = formatFullAbsoluteTime(turn.createdAt, { seconds: true })}
					{@const authorName = showAuthors ? getTurnNavAuthorName(turn) : null}
					<button
						type="button"
						class={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors ${turn.sequence === currentSequence ? 'bg-brand/10' : 'active:bg-bg-hover'}`}
						onclick={() => jump(turn.sequence)}
					>
						<div class={`mt-0.5 w-10 shrink-0 text-[11px] font-medium tabular-nums ${turn.sequence === currentSequence ? 'text-brand' : 'text-text-tertiary'}`}>#{turn.sequence}</div>
						<div class="min-w-0 flex-1">
							{#if preview}
								<div
									class="line-clamp-3 text-[13px] leading-relaxed text-text-primary"
									title={fullPreview !== preview ? fullPreview : undefined}
								>
									{preview}
								</div>
							{:else if !attachmentLabel}
								<div class="line-clamp-3 text-[13px] leading-relaxed text-text-placeholder">
									Empty message
								</div>
							{/if}
							<div class={`${preview || !attachmentLabel ? 'mt-1' : ''} flex min-w-0 flex-wrap items-center gap-x-1 text-[11px] ${statusTone(turn.status)}`}>
								{#if timeLabel}
									<span class="tabular-nums text-text-placeholder" title={fullTime || undefined}>{timeLabel}</span>
									<span class="text-text-placeholder">·</span>
								{/if}
								{#if attachmentLabel}
									<span class="text-text-placeholder">{attachmentLabel}</span>
									<span class="text-text-placeholder">·</span>
								{/if}
								{#if authorName}
									<span class="min-w-0 max-w-[9rem] truncate text-text-placeholder" title={authorName}>{authorName}</span>
									<span class="text-text-placeholder">·</span>
								{/if}
								<span>{turn.status}{turn.model ? ` · ${turn.model}` : ''}</span>
							</div>
						</div>
					</button>
				{/each}
			</div>
		</div>
	</div>
{/if}
