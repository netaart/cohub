import type {
	CheckpointDiffPatchLine,
	CheckpointDiffStatus,
	SpacePendingDiffFileResponse,
} from "@neta-art/cohub";
import { m } from "../paraglide/messages.js";
import type { Locale } from "./core.ts";

export type FileViewMode = "source" | "preview" | "diff";

export function defaultFileViewMode(hasRenderedPreview: boolean): FileViewMode {
	return hasRenderedPreview ? "preview" : "source";
}

export function formatDiffBytes(value: number | null | undefined): string {
	if (value === null || value === undefined) return "—";
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024)
		return `${(value / 1024).toFixed(value >= 10 * 1024 ? 0 : 1)} KB`;
	return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDiffCounts(
	additions: number | null | undefined,
	deletions: number | null | undefined,
): string {
	const parts: string[] = [];
	if (typeof additions === "number") parts.push(`+${additions}`);
	if (typeof deletions === "number") parts.push(`−${deletions}`);
	return parts.join(" ");
}

export function diffStatusLabel(
	status: CheckpointDiffStatus | null | undefined,
	locale?: Locale,
): string {
	switch (status) {
		case "A":
			return m.diff_status_added({}, { locale });
		case "M":
		case "T":
			return m.diff_status_modified({}, { locale });
		case "D":
			return m.diff_status_deleted({}, { locale });
		case "R":
			return m.diff_status_renamed({}, { locale });
		case "C":
			return m.diff_status_copied({}, { locale });
		default:
			return m.diff_status_changed({}, { locale });
	}
}

export function diffStatusClass(
	status: CheckpointDiffStatus | null | undefined,
): string {
	switch (status) {
		case "A":
			return "text-success-soft";
		case "D":
			return "text-error-soft";
		case "R":
		case "C":
			return "text-brand";
		default:
			return "text-text-secondary";
	}
}

export function patchLineClass(type: CheckpointDiffPatchLine["type"]): string {
	if (type === "add") return "border-success/30 bg-success-bg/40 text-success";
	if (type === "del") return "border-error/30 bg-error-bg/40 text-error";
	if (type === "hunk")
		return "border-border-subtle bg-bg-elevated/50 text-text-tertiary";
	if (type === "meta") return "border-transparent text-text-placeholder";
	return "border-transparent text-text-secondary";
}

export function patchLinePrefix(type: CheckpointDiffPatchLine["type"]): string {
	if (type === "add") return "+";
	if (type === "del") return "−";
	if (type === "hunk" || type === "meta") return "";
	return " ";
}

export function isUnchangedPendingDiff(
	patch: SpacePendingDiffFileResponse | null | undefined,
): boolean {
	if (!patch) return false;
	if (patch.status === "A" || patch.status === "D") return false;
	if (patch.kind !== "text") return false;
	if ((patch.additions ?? 0) > 0 || (patch.deletions ?? 0) > 0) return false;
	return !patch.lines.some(
		(line) => line.type === "add" || line.type === "del",
	);
}
