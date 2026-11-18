import type { BoardScript, BoardScriptParameter } from "@neta-art/cohub/board";
import type { BoardEditor } from "@neta-art/cohub/board/editor";
import type { BoardStage } from "@neta-art/cohub/board/stage";

export type BoardScriptStatus = {
	state: "starting" | "running" | "error";
	error: string | null;
	parameters: Readonly<Record<string, BoardScriptParameter>>;
};

export function boardScriptRunsHere(
	editor: BoardEditor,
	script: Pick<BoardScript, "modes"> | undefined,
): boolean {
	return !script?.modes || script.modes.includes(editor.scriptMode);
}

const NO_PARAMETERS: Readonly<Record<string, BoardScriptParameter>> = {};

export function readBoardScriptStatus(
	stage: BoardStage,
	id: string,
): BoardScriptStatus {
	const error = stage.scriptError(id);
	const output = stage.scriptOutput(id);
	return {
		state: error ? "error" : output ? "running" : "starting",
		error,
		parameters: output?.parameters ?? NO_PARAMETERS,
	};
}

export function sameBoardScriptStatus(
	a: BoardScriptStatus | null,
	b: BoardScriptStatus | null,
): boolean {
	if (a === b) return true;
	if (!a || !b || a.state !== b.state || a.error !== b.error) return false;
	return (
		a.parameters === b.parameters ||
		JSON.stringify(a.parameters) === JSON.stringify(b.parameters)
	);
}

export function watchBoardScriptStatus(
	stage: BoardStage,
	id: string,
	onChange: (status: BoardScriptStatus) => void,
): () => void {
	let current = readBoardScriptStatus(stage, id);
	onChange(current);
	return stage.subscribeScripts(() => {
		const next = readBoardScriptStatus(stage, id);
		if (sameBoardScriptStatus(current, next)) return;
		current = next;
		onChange(next);
	});
}
