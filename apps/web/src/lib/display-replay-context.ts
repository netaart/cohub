import { getContext, setContext } from "svelte";

const displayReplayKey = Symbol("cohub.chat.display-replay");

export function provideDisplayReplay(spaceId: () => string) {
	setContext(displayReplayKey, spaceId);
}

export function useDisplayReplay(): (() => string) | undefined {
	return getContext<(() => string) | undefined>(displayReplayKey);
}

const DISPLAY_COMMAND =
	/\bcohub\s+spaces\s+displays\s+(?:act|tap|type|long-press|swipe|scroll|key|press|launch|open|wait)\b/;

export function actsOnDisplay(
	name: string,
	input: Record<string, unknown> | undefined,
) {
	if (!input || !/^(bash|shell|exec_command|run_command)$/i.test(name))
		return false;
	const command = input.command ?? input.cmd;
	const text = Array.isArray(command) ? command.join(" ") : command;
	return typeof text === "string" && DISPLAY_COMMAND.test(text);
}
