import type { StaffViewPart, ViewPart } from "@neta-art/score-editor";
import { pending } from "$lib/lazy-module";

/** A mounted read-only staff view: the host's playback time draws the cursor, or clears it. */
export type ScoreStaff = {
	setPlayPosition(seconds: number | null): void;
	destroy(): void;
};

/**
 * Mounts the package's staff view, read-only, on the element. The package and its song2 dialect
 * are imported here so a page without a score never loads either one.
 */
export async function mountScoreStaff(
	el: HTMLElement,
	text: string,
	language: "en" | "zh",
): Promise<ScoreStaff> {
	const [editor, dialect] = await Promise.all([
		import.meta.env.SSR ? pending() : import("@neta-art/score-editor"),
		import.meta.env.SSR ? pending() : import("@neta-art/score-dialect-song2"),
	]);
	const project = {
		style: "",
		lyrics: "",
		score: text,
		scoreMode: "full" as const,
		seed: null,
		modelId: "song2",
		sourceKey: "score-viewer",
	};
	const session = editor.createEditingSession({
		project,
		dialects: editor.createDialectRegistry([dialect.song2Dialect]),
		language,
		editable: false,
		activeView: "staff",
	});
	const view: ViewPart =
		session.reading.kind === "score"
			? editor.mountStaffView(el, session)
			: editor.mountProblemView(el, session);
	const staff = session.reading.kind === "score" ? (view as StaffViewPart) : null;
	return {
		setPlayPosition(seconds) {
			staff?.setPlayPosition(seconds);
		},
		destroy() {
			view.destroy();
			el.replaceChildren();
		},
	};
}
