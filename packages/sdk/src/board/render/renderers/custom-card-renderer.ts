import { Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import type { BoardCustomItem } from "@cohub/protocol";
import { BOARD_MONO_FONT_STACK } from "@cohub/protocol/board-constants";
import type { SceneItem } from "../../model/scene.js";
import { fitTextToLines } from "../text-fit.js";
import { syncTextResolution } from "../text-resolution.js";
import { positionShell } from "./base-card-renderer.js";
import type { BoardCardRenderer, BoardRenderContext } from "./board-renderer-registry.js";
import { drawFarPlate } from "./far-plate.js";

type CustomParts = {
	id: string;
	root: Container;
	sprite: Sprite;
	placeholder: Graphics;
	label: Text;
	sig: string;
};

const partsByContainer = new WeakMap<Container, CustomParts>();
const LABEL_LINE = 16;

function sync(container: Container, item: SceneItem<BoardCustomItem>, context: BoardRenderContext) {
	const parts = partsByContainer.get(container);
	if (!parts) return;
	if (parts.id !== item.id) {
		context.scripts?.release(parts.id);
		parts.id = item.id;
	}
	positionShell(parts.root, item);
	const { width, height } = item.frame;
	const texture = context.scripts?.frame(item, context.time) ?? null;
	const error = context.scripts?.error(item.id) ?? null;
	parts.sprite.visible = Boolean(texture);
	const display = texture ?? Texture.EMPTY;
	if (parts.sprite.texture !== display) parts.sprite.texture = display;
	parts.sprite.width = width;
	parts.sprite.height = height;

	const ready = Boolean(texture) || context.scripts?.ready?.(item.id) === true;
	const message = error ? `${item.script.src}\n${error}` : ready ? "" : item.script.src;
	const sig = [width, height, Boolean(texture), message, context.themeKey].join("|");
	if (sig !== parts.sig) {
		parts.sig = sig;
		parts.placeholder.clear();
		if (!ready || error) parts.placeholder.rect(0, 0, width, height).stroke({ color: context.palette.border, width: 1, alpha: 0.8 });
		parts.label.visible = !ready || Boolean(error);
		parts.label.style.fill = error ? context.colors.rose.stroke : context.palette.muted;
		fitTextToLines(parts.label, message, Math.max(1, Math.floor((height - 16) / LABEL_LINE)), Math.max(40, width - 16));
		parts.label.position.set(width / 2, height / 2);
	}
	syncTextResolution(parts.label, context.textResolution);
}

export const customCardRenderer: BoardCardRenderer = {
	id: "custom-card",
	canRender: (item) => item.type === "custom",
	animated: false,
	create: (item, context) => {
		const root = new Container();
		const sprite = new Sprite(Texture.EMPTY);
		const placeholder = new Graphics();
		const label = new Text({
			text: "",
			style: { fontFamily: BOARD_MONO_FONT_STACK, fontSize: 12, lineHeight: LABEL_LINE, align: "center" },
			resolution: context.textResolution,
			roundPixels: true,
		});
		label.anchor.set(0.5);
		root.addChild(sprite, placeholder, label);
		partsByContainer.set(root, { id: item.id, root, sprite, placeholder, label, sig: "" });
		if (item.type === "custom") sync(root, item as SceneItem<BoardCustomItem>, context);
		return root;
	},
	update: (container, item, context) => {
		if (item.type === "custom") sync(container, item as SceneItem<BoardCustomItem>, context);
	},
	resolution: (container, _item, context) => {
		const parts = partsByContainer.get(container);
		if (parts) syncTextResolution(parts.label, context.textResolution);
	},
	renderFar: (graphics, item, context) => {
		drawFarPlate(graphics, item.frame, { fill: context.palette.muted, fillAlpha: 0.12 });
	},
	destroy: (container, context) => {
		const parts = partsByContainer.get(container);
		if (parts) context.scripts?.release(parts.id);
		parts?.root.destroy({ children: true });
		partsByContainer.delete(container);
	},
};
