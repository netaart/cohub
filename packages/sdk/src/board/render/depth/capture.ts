import type { BoardFrame } from "@cohub/protocol";
import { type Container, Matrix, type Renderer, RenderTexture } from "pixi.js";

export const BOARD_DEPTH_MAX_EDGE = 2048;
const RESIZE_SLACK = 1.12;
const CLEAR: [number, number, number, number] = [0, 0, 0, 0];

export type BoardDepthPicture = {
	readonly texture: RenderTexture;
	draw(renderer: Renderer, host: Container, frame: BoardFrame, density: number, maxEdge?: number): void;
	destroy(): void;
};

export function createBoardDepthPicture(): BoardDepthPicture {
	const texture = RenderTexture.create({ width: 16, height: 16, resolution: 1, antialias: true, autoGenerateMipmaps: true, dynamic: true });
	texture.source.style.mipmapFilter = "linear";
	texture.source.style.maxAnisotropy = 8;
	texture.source.style.update();
	const transform = new Matrix();
	return {
		texture,
		draw(renderer, host, frame, density, maxEdge = BOARD_DEPTH_MAX_EDGE) {
			const fit = Math.min(density, maxEdge / Math.max(frame.width, frame.height, 1));
			const wanted = [Math.max(1, Math.ceil(frame.width * fit)), Math.max(1, Math.ceil(frame.height * fit))] as const;
			const current = [texture.source.pixelWidth, texture.source.pixelHeight] as const;
			const fits = (index: 0 | 1) => current[index] >= wanted[index] && current[index] <= wanted[index] * RESIZE_SLACK * RESIZE_SLACK;
			if (!fits(0) || !fits(1)) texture.resize(Math.ceil(wanted[0] * RESIZE_SLACK), Math.ceil(wanted[1] * RESIZE_SLACK), 1);
			const sx = texture.source.pixelWidth / Math.max(frame.width, 1e-6);
			const sy = texture.source.pixelHeight / Math.max(frame.height, 1e-6);
			transform
				.identity()
				.translate(-(frame.x + frame.width / 2), -(frame.y + frame.height / 2))
				.rotate((-frame.rotation * Math.PI) / 180)
				.translate(frame.width / 2, frame.height / 2)
				.scale(sx, sy);
			renderer.render({ container: host, target: texture, clear: true, clearColor: CLEAR, transform });
			texture.source.updateMipmaps();
		},
		destroy() {
			texture.destroy(true);
		},
	};
}
