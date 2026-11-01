import type { BoardAtmosphere } from "@cohub/protocol";
import { Container, DOMAdapter, ImageSource, Sprite, Texture, TilingSprite } from "pixi.js";

const VIGNETTE_EDGE = 256;
const GRAIN_EDGE = 192;
const VIGNETTE_ALPHA = 0.75;
const GRAIN_ALPHA = 0.3;

let vignette: Texture | null = null;
let grain: Texture | null = null;

function paint(edge: number, alphaAt: (x: number, y: number) => [number, number]): Texture {
	const canvas = DOMAdapter.get().createCanvas(edge, edge);
	const context = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
	const image = context.createImageData(edge, edge);
	for (let y = 0; y < edge; y += 1) {
		for (let x = 0; x < edge; x += 1) {
			const [gray, alpha] = alphaAt(x, y);
			const offset = (y * edge + x) * 4;
			image.data.fill(gray, offset, offset + 3);
			image.data[offset + 3] = alpha;
		}
	}
	context.putImageData(image, 0, 0);
	return new Texture({ source: new ImageSource({ resource: canvas as unknown as HTMLCanvasElement }) });
}

function vignetteTexture(): Texture {
	if (vignette && !vignette.destroyed) return vignette;
	vignette = paint(VIGNETTE_EDGE, (x, y) => {
		const dx = (x + 0.5) / VIGNETTE_EDGE - 0.5;
		const dy = (y + 0.5) / VIGNETTE_EDGE - 0.5;
		const t = Math.min(1, Math.max(0, (Math.hypot(dx, dy) / Math.SQRT1_2 - 0.4) / 0.6));
		return [0, Math.round(t * t * (3 - 2 * t) * 255)];
	});
	return vignette;
}

function grainTexture(): Texture {
	if (grain && !grain.destroyed) return grain;
	let seed = 0x2545f491;
	const next = () => {
		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		return (seed >>> 0) / 4294967296;
	};
	grain = paint(GRAIN_EDGE, () => {
		const value = next() - 0.5;
		return [value > 0 ? 255 : 0, Math.round(Math.abs(value) * 2 * 255)];
	});
	grain.source.style.addressMode = "repeat";
	return grain;
}

export type BoardAtmosphereLayer = {
	readonly container: Container;
	sync(atmosphere: BoardAtmosphere | undefined, view: { width: number; height: number; density: number }): void;
	destroy(): void;
};

export function createBoardAtmosphereLayer(): BoardAtmosphereLayer {
	const container = new Container({ label: "board-atmosphere" });
	let shade: Sprite | null = null;
	let specks: TilingSprite | null = null;
	return {
		container,
		sync(atmosphere, { width, height, density }) {
			const strength = atmosphere?.vignette ?? 0;
			if (strength > 0) {
				shade ??= container.addChildAt(new Sprite(vignetteTexture()), 0);
				shade.setSize(width, height);
				shade.alpha = strength * VIGNETTE_ALPHA;
			}
			if (shade) shade.visible = strength > 0;
			const amount = atmosphere?.grain ?? 0;
			if (amount > 0) {
				specks ??= container.addChild(new TilingSprite({ texture: grainTexture() }));
				specks.setSize(width, height);
				specks.tileScale.set(1 / density);
				specks.alpha = amount * GRAIN_ALPHA;
			}
			if (specks) specks.visible = amount > 0;
			container.visible = strength > 0 || amount > 0;
		},
		destroy() {
			container.destroy({ children: true });
		},
	};
}
