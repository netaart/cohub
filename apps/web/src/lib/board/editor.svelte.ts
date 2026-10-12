import {
	type BoardEditor,
	type BoardEditorChannel,
	type BoardEditorOptions,
	createBoardEditor as createEditor,
} from "@neta-art/cohub/board/editor";
import { ensureBoardTextMeasurement } from "@neta-art/cohub/board/render";
import { createSubscriber } from "svelte/reactivity";
import {
	readBoardCameraPolicy,
	writeBoardCameraPolicy,
} from "$lib/board/board-camera-policy";
import {
	readBoardToolStyles,
	writeBoardToolStyles,
} from "$lib/board/board-tool-preferences";

export type {
	AlignMode,
	BoardEditor,
	BoardInteraction,
	BoardPointerEvent,
	BoardToolId,
	BoardViewState,
	DistributeAxis,
} from "@neta-art/cohub/board/editor";

export function createBoardEditor(
	options: Omit<
		BoardEditorOptions,
		"track" | "preferences" | "onPreferencesChange"
	>,
): BoardEditor {
	ensureBoardTextMeasurement();
	const subscribers = new Map<BoardEditorChannel, () => void>();
	const editor: BoardEditor = createEditor({
		...options,
		preferences: {
			toolStyles: readBoardToolStyles(),
			cameraPolicy: readBoardCameraPolicy(),
		},
		onPreferencesChange: ({ toolStyles, cameraPolicy }) => {
			writeBoardToolStyles(toolStyles);
			writeBoardCameraPolicy(cameraPolicy);
		},
		track: (channel) => {
			let subscribe = subscribers.get(channel);
			if (!subscribe) {
				subscribe = createSubscriber((update) =>
					editor.subscribe(channel, update),
				);
				subscribers.set(channel, subscribe);
			}
			subscribe();
		},
	});
	return editor;
}
