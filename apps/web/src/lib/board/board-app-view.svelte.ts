import type { AppRuntimeShellContext } from "@neta-art/cohub";
import type {
	BoardItemView,
	BoardItemViewContext,
} from "@neta-art/cohub/board/stage";
import { mount, unmount } from "svelte";
import {
	type AppNavigationHandler,
	type BoardAppMeta,
	boardAppMeta,
	createBoardAppDetailLoader,
} from "$lib/board/board-app";
import BoardAppItem from "$lib/components/board/BoardAppItem.svelte";

type AppItemProps = {
	id: string;
	meta: BoardAppMeta;
	width: number;
	height: number;
	context: BoardItemViewContext;
};

export function createBoardAppItemView(options: {
	shell: () => AppRuntimeShellContext | undefined;
	onNavigationOpen: () => AppNavigationHandler | undefined;
}): BoardItemView {
	const loadDetail = createBoardAppDetailLoader();
	return {
		type: (item) => boardAppMeta(item) !== null,
		mount(target, item, context) {
			const props = $state<AppItemProps>({
				id: item.id,
				meta: boardAppMeta(item) as BoardAppMeta,
				width: item.frame.width,
				height: item.frame.height,
				context,
			});
			const component = mount(BoardAppItem, {
				target,
				props: {
					get id() {
						return props.id;
					},
					get meta() {
						return props.meta;
					},
					get width() {
						return props.width;
					},
					get height() {
						return props.height;
					},
					get context() {
						return props.context;
					},
					loadDetail,
					get shell() {
						return options.shell();
					},
					get onNavigationOpen() {
						return options.onNavigationOpen();
					},
				},
			});
			return {
				update(next, nextContext) {
					const meta = boardAppMeta(next);
					if (meta) props.meta = meta;
					props.width = next.frame.width;
					props.height = next.frame.height;
					props.context = nextContext;
				},
				destroy() {
					void unmount(component);
				},
			};
		},
	};
}
