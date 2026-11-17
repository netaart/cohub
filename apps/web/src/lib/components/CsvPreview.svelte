<script lang="ts">
import {
	CSV_PREVIEW_MAX_COLUMNS,
	CSV_PREVIEW_MAX_ROWS,
	parseCsv,
} from "#lib/csv-parse.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

let {
	source = "",
	name = "",
}: {
	source?: string;
	name?: string;
} = $props();

const locale = $derived(getLocale());

const parsed = $derived(parseCsv(source, { maxRows: CSV_PREVIEW_MAX_ROWS }));
const columns = $derived(parsed.headers.length);
const visibleColumns = $derived(Math.min(columns, CSV_PREVIEW_MAX_COLUMNS));
const hiddenColumnCount = $derived(columns - visibleColumns);
const isEmpty = $derived(columns === 0 && parsed.rows.length === 0);
const onlyHeader = $derived(columns > 0 && parsed.rows.length === 0);

function cellValue(row: string[], index: number): string {
	return row[index] ?? "";
}

function isBlank(value: string): boolean {
	return value.trim() === "";
}
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col bg-bg-content">
	<div
		class="flex h-8 shrink-0 items-center gap-3 border-b border-border-subtle px-3 text-[11px] text-text-tertiary"
	>
		{#if isEmpty}
			<span>{m.csv_empty({}, { locale })}</span>
		{:else}
			<span class="tabular-nums">
				{parsed.truncated
					? `Showing first ${parsed.rows.length} of ${parsed.totalRows} rows`
					: `${parsed.totalRows} ${parsed.totalRows === 1 ? "row" : "rows"}`}
			</span>
			<span aria-hidden="true" class="text-text-placeholder">·</span>
			<span class="tabular-nums">
				{columns} {columns === 1 ? "column" : "columns"}
			</span>
			{#if hiddenColumnCount > 0}
				<span aria-hidden="true" class="text-text-placeholder">·</span>
				<span>+{hiddenColumnCount} more hidden</span>
			{/if}
			<span aria-hidden="true" class="text-text-placeholder">·</span>
			<span>delimiter “{parsed.delimiter === "\t" ? "tab" : parsed.delimiter}”</span>
		{/if}
	</div>

	{#if isEmpty}
		<div class="flex flex-1 items-center justify-center text-xs text-text-tertiary">
			This CSV has no data.
		</div>
	{:else}
		<div class="csv-scroll min-h-0 flex-1 overflow-auto" role="region" aria-label={name ? `CSV preview: ${name}` : "CSV preview"}>
			<table class="w-full border-collapse font-mono text-[11.5px] leading-snug">
				<thead>
					<tr>
						{#each parsed.headers.slice(0, visibleColumns) as header, index}
							<th
								scope="col"
								title={header}
								class="sticky top-0 z-10 whitespace-nowrap border-b border-border-subtle bg-bg-elevated px-3 py-1.5 text-left font-semibold text-text-secondary"
							>
								{isBlank(header) ? "—" : header}
							</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each parsed.rows as row, rowIndex}
						<tr class="hover:bg-bg-hover/60">
							{#each Array.from({ length: visibleColumns }) as _, colIndex}
								{@const value = cellValue(row, colIndex)}
								<td
									title={isBlank(value) ? "" : value}
									class="max-w-[340px] truncate whitespace-nowrap border-b border-border-subtle px-3 py-1 text-text-secondary"
									class:text-text-placeholder={isBlank(value)}
								>
									{isBlank(value) ? "—" : value}
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
