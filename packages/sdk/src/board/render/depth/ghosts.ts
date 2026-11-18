import { type BoardFrame, framePoint } from "@cohub/protocol";
import { Container, Graphics, Matrix, Sprite, type Texture } from "pixi.js";

export const BOARD_DEPTH_GHOST = { tint: 0x8a9099, alpha: 0.32 } as const;

export type BoardDepthGhost = { frame: BoardFrame; cover: Texture | null; opacity: number };

export type BoardDepthGhosts = {
	readonly container: Container;
	sync(ghosts: ReadonlyMap<string, BoardDepthGhost>): void;
	destroy(): void;
};

export function createBoardDepthGhosts(): BoardDepthGhosts {
	const container = new Container({ label: "board-depth-ghosts" });
	const entries = new Map<string, { holder: Container; shape: Graphics; sprite: Sprite; drawn: string }>();
	const matrix = new Matrix();
	return {
		container,
		sync(ghosts) {
			for (const [id, entry] of entries) {
				if (ghosts.has(id)) continue;
				entry.holder.destroy({ children: true });
				entries.delete(id);
			}
			for (const [id, { frame, cover, opacity }] of ghosts) {
				let entry = entries.get(id);
				if (!entry) {
					const holder = new Container();
					const shape = new Graphics();
					const sprite = new Sprite();
					holder.addChild(shape, sprite);
					container.addChild(holder);
					entry = { holder, shape, sprite, drawn: "" };
					entries.set(id, entry);
				}
				const { width, height } = frame;
				const a = framePoint(frame, 0, 0);
				const b = framePoint(frame, 1, 0);
				const d = framePoint(frame, 0, 1);
				const w = Math.max(width, 1e-6);
				const h = Math.max(height, 1e-6);
				entry.holder.setFromMatrix(matrix.set((b.x - a.x) / w, (b.y - a.y) / w, (d.x - a.x) / h, (d.y - a.y) / h, a.x, a.y));
				entry.holder.alpha = opacity;
				entry.sprite.visible = Boolean(cover);
				entry.shape.visible = !cover;
				if (cover) {
					const scale = Math.min(w / Math.max(cover.width, 1), h / Math.max(cover.height, 1));
					entry.sprite.texture = cover;
					entry.sprite.setSize(cover.width * scale, cover.height * scale);
					entry.sprite.position.set((w - cover.width * scale) / 2, (h - cover.height * scale) / 2);
				} else if (entry.drawn !== `${w}x${h}`) {
					entry.drawn = `${w}x${h}`;
					entry.shape.clear().roundRect(0, 0, w, h, Math.min(w, h) * 0.22).fill({ color: BOARD_DEPTH_GHOST.tint, alpha: BOARD_DEPTH_GHOST.alpha });
				}
			}
		},
		destroy() {
			container.destroy({ children: true });
			entries.clear();
		},
	};
}
