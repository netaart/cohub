import { BufferImageSource, Container, Matrix, NineSliceSprite, Texture } from "pixi.js";
import type { BoardDepthShadow } from "../../model/depth.js";

const SIZE = 64;
const BORDER = SIZE / 2;

let softTexture: Texture | null = null;

function soft(): Texture {
	if (softTexture && !softTexture.destroyed) return softTexture;
	const data = new Uint8Array(SIZE * SIZE * 4);
	const fall = (p: number) => {
		const t = Math.min(p + 0.5, SIZE - p - 0.5) / BORDER;
		const s = Math.min(Math.max(t, 0), 1);
		return s * s * (3 - 2 * s);
	};
	for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) data[(y * SIZE + x) * 4 + 3] = Math.round(255 * fall(x) * fall(y));
	softTexture = new Texture({ source: new BufferImageSource({ resource: data, width: SIZE, height: SIZE, alphaMode: "premultiplied-alpha" }) });
	return softTexture;
}

export type BoardDepthShadows = {
	readonly container: Container;
	sync(shadows: ReadonlyMap<string, { shadow: BoardDepthShadow; width: number; height: number; opacity: number }>): void;
	destroy(): void;
};

export function createBoardDepthShadows(): BoardDepthShadows {
	const container = new Container({ label: "board-depth-shadows" });
	const entries = new Map<string, { holder: Container; sprite: NineSliceSprite }>();
	const matrix = new Matrix();
	return {
		container,
		sync(shadows) {
			for (const [id, entry] of entries) {
				if (shadows.has(id)) continue;
				entry.holder.destroy({ children: true });
				entries.delete(id);
			}
			for (const [id, { shadow, width, height, opacity }] of shadows) {
				let entry = entries.get(id);
				if (!entry) {
					const holder = new Container();
					const sprite = new NineSliceSprite({ texture: soft(), leftWidth: BORDER, rightWidth: BORDER, topHeight: BORDER, bottomHeight: BORDER });
					holder.addChild(sprite);
					container.addChild(holder);
					entry = { holder, sprite };
					entries.set(id, entry);
				}
				const [a, b, , d] = shadow.corners;
				const w = Math.max(width, 1e-6);
				const h = Math.max(height, 1e-6);
				entry.holder.setFromMatrix(matrix.set((b.x - a.x) / w, (b.y - a.y) / w, (d.x - a.x) / h, (d.y - a.y) / h, a.x, a.y));
				const scale = Math.hypot((b.x - a.x) / w, (b.y - a.y) / w) || 1;
				const blur = Math.max(shadow.blur / scale, 1);
				const k = blur / BORDER;
				entry.sprite.scale.set(k);
				entry.sprite.position.set(-blur * 0.5, -blur * 0.5);
				entry.sprite.width = (width + blur) / k;
				entry.sprite.height = (height + blur) / k;
				entry.holder.alpha = shadow.alpha * opacity;
			}
		},
		destroy() {
			container.destroy({ children: true });
			entries.clear();
		},
	};
}
