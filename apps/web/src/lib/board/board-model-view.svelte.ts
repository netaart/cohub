import { type BoardSceneItem, isBoardModelItem } from "@neta-art/cohub/board";
import type {
	BoardItemView,
	BoardItemViewContext,
} from "@neta-art/cohub/board/stage";
import { mount, unmount } from "svelte";
import type { BoardAssetSource } from "$lib/board/board-asset-source";
import { boardModelSource } from "$lib/board/board-model";
import BoardModelItem from "$lib/components/board/BoardModelItem.svelte";
import type { ModelSource } from "$lib/model3d/source";

type ModelItemProps = {
	source: ModelSource;
	context: BoardItemViewContext;
	frame: { width: number; height: number };
};

const frameOf = ({ frame }: BoardSceneItem) => ({
	width: frame.width,
	height: frame.height,
});

export function createBoardModelItemView(options: {
	assetSource: BoardAssetSource;
	isMobile: () => boolean;
}): BoardItemView {
	return {
		type: (item) => isBoardModelItem(item),
		mount(target, item, context) {
			const source = boardModelSource(item, options.assetSource);
			if (!source) return {};
			const props = $state<ModelItemProps>({
				source,
				context,
				frame: frameOf(item),
			});
			const component = mount(BoardModelItem, {
				target,
				props: {
					get source() {
						return props.source;
					},
					get context() {
						return props.context;
					},
					get frame() {
						return props.frame;
					},
					get isMobile() {
						return options.isMobile();
					},
				},
			});
			return {
				update(next, nextContext) {
					const nextSource = boardModelSource(next, options.assetSource);
					if (nextSource && nextSource.key !== props.source.key)
						props.source = nextSource;
					props.context = nextContext;
					const frame = frameOf(next);
					if (
						frame.width !== props.frame.width ||
						frame.height !== props.frame.height
					)
						props.frame = frame;
				},
				destroy() {
					void unmount(component);
				},
			};
		},
	};
}
