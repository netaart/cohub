import {
	type SpaceFileSaveSource,
	type SpaceFsFileResponse,
	spaceFileSaveSource,
} from "@neta-art/cohub";
import type { SaveSource } from "$lib/downloads.svelte";

type SavableFiles = {
	saveSource: (path: string) => Promise<SpaceFileSaveSource>;
};

export async function spaceFileSource(
	files: SavableFiles,
	path: string,
	knownFile?: SpaceFsFileResponse | null,
): Promise<SaveSource> {
	const saved =
		(knownFile && spaceFileSaveSource(knownFile)) ??
		(await files.saveSource(path));
	return saved.kind === "url"
		? { kind: "attachment", url: saved.url }
		: { kind: "blob", blob: saved.blob };
}
