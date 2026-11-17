import { type CheckpointRecord, HttpError } from "@neta-art/cohub";
import { formatDateTime } from "#lib/i18n/format.ts";
import type { Locale } from "#lib/i18n/locale.ts";
import { sdk } from "#lib/sdk.ts";

export async function pollCheckpointJob(taskRunId: string) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < 90_000) {
		try {
			const { run } = await sdk.tasks.get(taskRunId);
			if (run.status === "completed") return run;
			if (run.status === "failed") {
				throw new Error(run.errorMessage || "Save job failed");
			}
		} catch (error) {
			if (!(error instanceof HttpError && error.status === 404)) {
				throw error;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 1500));
	}
	throw new Error("Save job timed out");
}

export function getCheckpointTitle(checkpoint: CheckpointRecord) {
	const normalized = checkpoint.description?.trim();
	return normalized && normalized.length > 0
		? normalized
		: `Save ${checkpoint.commitHash.slice(0, 12)}`;
}

/**
 * Pure, locale-aware timestamp helper. Omitted locale resolves to the
 * deterministic base locale (`en`) so non-reactive callers stay stable;
 * reactive components pass their current `locale` explicitly.
 */
export function formatCheckpointTimestamp(value: string, locale?: Locale) {
	return formatDateTime(value, locale);
}
