import { Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import type { BoardSketchItem } from "@cohub/protocol";
import { BOARD_MONO_FONT_STACK } from "@cohub/protocol/board-constants";
import type { SceneItem } from "../../core/scene.js";
import { getBoardResolution } from "../text-resolution.js";
import { positionShell } from "./base-card-renderer.js";
import type { BoardCardRenderer, BoardRenderContext } from "./board-renderer-registry.js";
import { drawFarPlate } from "./far-plate.js";

type SketchParts = {
	id: string;
	root: Container;
	sprite: Sprite;
	placeholder: Graphics;
	label: Text;
	sig: string;
};

const partsByContainer = new WeakMap<Container, SketchParts>();

function sync(container: Container, item: SceneItem<BoardSketchItem>, context: BoardRenderContext) {
	const parts = partsByContainer.get(container);
	if (!parts) return;
	if (parts.id !== item.id) {
		context.sketches?.release(parts.id);
		parts.id = item.id;
	}
	positionShell(parts.root, item);
	const { width, height } = item.frame;
	const resolution = Math.min(4, Math.max(0.25, context.zoom * getBoardResolution()));
	const texture = context.sketches?.frame(item, context.time, resolution) ?? null;
	const error = context.sketches?.error(item.id) ?? null;
	parts.sprite.visible = Boolean(texture);
	if (texture && parts.sprite.texture !== texture) parts.sprite.texture = texture;
	parts.sprite.width = width;
	parts.sprite.height = height;

	const selected = context.selectedIds.has(item.id);
	const message = texture ? "" : error ? `${item.props.src}\n${error}` : item.props.src;
	const sig = [width, height, selected, Boolean(texture), message, context.palette.border, context.palette.muted].join("|");
	if (sig === parts.sig) return;
	parts.sig = sig;
	parts.placeholder.clear();
	if (!texture || selected) {
		parts.placeholder.rect(0, 0, width, height).stroke({ color: selected ? context.palette.brand : context.palette.border, width: selected ? 2 : 1, alpha: 0.8 });
	}
	parts.label.visible = !texture;
	parts.label.text = message;
	parts.label.style.fill = error ? context.colors.rose.stroke : context.palette.muted;
	parts.label.style.wordWrapWidth = Math.max(40, width - 16);
	parts.label.position.set(width / 2, height / 2);
}

export const sketchCardRenderer: BoardCardRenderer = {
	id: "sketch-card",
	canRender: (item) => item.type === "sketch",
	animated: true,
	create: (item, context) => {
		const root = new Container();
		const sprite = new Sprite(Texture.EMPTY);
		const placeholder = new Graphics();
		const label = new Text({
			text: "",
			style: { fontFamily: BOARD_MONO_FONT_STACK, fontSize: 12, align: "center", wordWrap: true, breakWords: true },
			resolution: getBoardResolution(),
		});
		label.anchor.set(0.5);
		root.addChild(sprite, placeholder, label);
		partsByContainer.set(root, { id: item.id, root, sprite, placeholder, label, sig: "" });
		if (item.type === "sketch") sync(root, item as SceneItem<BoardSketchItem>, context);
		return root;
	},
	update: (container, item, context) => {
		if (item.type === "sketch") sync(container, item as SceneItem<BoardSketchItem>, context);
	},
	renderFar: (graphics, item, context) => {
		drawFarPlate(graphics, item.frame, { fill: context.palette.muted, fillAlpha: 0.12 });
	},
	destroy: (container, context) => {
		const parts = partsByContainer.get(container);
		if (parts) context.sketches?.release(parts.id);
		parts?.root.destroy({ children: true });
		partsByContainer.delete(container);
	},
};
