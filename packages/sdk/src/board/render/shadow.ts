import { DOMAdapter, type Graphics, ImageSource, Matrix, Texture } from "pixi.js";

export type BoardShadowShape = { blur: number; radius: number; y: number };

type ShadowAtlas = { texture: Texture; width: number; height: number; top: number; card: { width: number; height: number } };

const MAX_ATLASES = 32;
const TEXELS = 48;
const atlases = new Map<string, ShadowAtlas>();

export function boardShadowFalloff(distance: number, blur: number): number {
	if (distance >= blur) return 0;
	return Math.min(1, (1.1 - Math.max(0, distance) / blur) ** 2);
}

function roundRectDistance(px: number, py: number, x: number, y: number, width: number, height: number, radius: number): number {
	const qx = Math.abs(px - (x + width / 2)) - (width / 2 - radius);
	const qy = Math.abs(py - (y + height / 2)) - (height / 2 - radius);
	return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function createAtlas({ blur, radius, y }: BoardShadowShape): ShadowAtlas {
	const card = { width: radius * 2 + 2, height: radius * 2 + Math.abs(y) * 2 + 2 };
	const top = blur + Math.max(0, -y);
	const width = card.width + blur * 2;
	const height = card.height + blur * 2 + Math.abs(y);
	const scale = Math.min(4, Math.max(0.5, TEXELS / (blur + radius)));
	const columns = Math.max(1, Math.ceil(width * scale));
	const rows = Math.max(1, Math.ceil(height * scale));
	const canvas = DOMAdapter.get().createCanvas(columns, rows);
	const context = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
	const image = context.createImageData(columns, rows);
	for (let row = 0; row < rows; row += 1) {
		for (let column = 0; column < columns; column += 1) {
			const px = ((column + 0.5) / columns) * width;
			const py = ((row + 0.5) / rows) * height;
			if (roundRectDistance(px, py, blur, top, card.width, card.height, radius) < 0) continue;
			const alpha = boardShadowFalloff(roundRectDistance(px, py, blur, top + y, card.width, card.height, radius), blur);
			const offset = (row * columns + column) * 4;
			image.data[offset] = 255;
			image.data[offset + 1] = 255;
			image.data[offset + 2] = 255;
			image.data[offset + 3] = Math.round(alpha * 255);
		}
	}
	context.putImageData(image, 0, 0);
	const texture = new Texture({ source: new ImageSource({ resource: canvas as unknown as HTMLCanvasElement, addressMode: "mirror-repeat" }) });
	return { texture, width, height, top, card };
}

function atlasFor(shape: BoardShadowShape): ShadowAtlas {
	const key = `${shape.blur}|${shape.radius}|${shape.y}`;
	let atlas = atlases.get(key);
	if (atlas && !atlas.texture.destroyed) {
		atlases.delete(key);
		atlases.set(key, atlas);
		return atlas;
	}
	atlas = createAtlas(shape);
	atlases.set(key, atlas);
	if (atlases.size > MAX_ATLASES) {
		const [oldest] = atlases.keys();
		if (oldest !== undefined) atlases.delete(oldest);
	}
	return atlas;
}

export function drawBoardShadow(
	graphics: Graphics,
	rect: { x: number; y: number; width: number; height: number },
	shape: BoardShadowShape,
	paint: { color: number; alpha: number },
): boolean {
	if (rect.width < shape.radius * 2 + 1 || rect.height < shape.radius * 2 + Math.abs(shape.y) * 2 + 1) return false;
	const atlas = atlasFor(shape);
	const cx = atlas.width / 2;
	const cy = atlas.top + atlas.card.height / 2;
	const source = [[0, cx - 0.5, cx + 0.5, atlas.width], [0, cy - 0.5, cy + 0.5, atlas.height]] as const;
	const growX = rect.width - atlas.card.width;
	const growY = rect.height - atlas.card.height;
	const originX = rect.x - shape.blur;
	const originY = rect.y - atlas.top;
	const target = (axis: 0 | 1, index: number) => {
		const value = source[axis][index] as number;
		return (axis === 0 ? originX : originY) + (index >= 2 ? value + (axis === 0 ? growX : growY) : value);
	};
	for (let row = 0; row < 3; row += 1) {
		for (let column = 0; column < 3; column += 1) {
			if (row === 1 && column === 1) continue;
			const u0 = (source[0][column] as number) / atlas.width;
			const u1 = (source[0][column + 1] as number) / atlas.width;
			const v0 = (source[1][row] as number) / atlas.height;
			const v1 = (source[1][row + 1] as number) / atlas.height;
			const x0 = target(0, column);
			const y0 = target(1, row);
			const matrix = new Matrix(1 / (u1 - u0), 0, 0, 1 / (v1 - v0), -u0 / (u1 - u0), -v0 / (v1 - v0));
			graphics
				.rect(x0, y0, target(0, column + 1) - x0, target(1, row + 1) - y0)
				.fill({ texture: atlas.texture, textureSpace: "local", matrix, color: paint.color, alpha: paint.alpha });
		}
	}
	return true;
}
