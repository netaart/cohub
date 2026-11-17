import { FlatMaterial, Geometry3D, Mesh3D, View3D } from "@pixi/3d";
import { type Container, Matrix, type Renderer, RenderTexture } from "pixi.js";
import { type BoardProjection, boardGroundBands } from "../../model/view-camera.js";
import { aimBoardCamera, straightBit, toScene } from "./math.js";

export type BoardGroundOptions = {
	density: number;
	maxPixels: number;
	maxEdge: number;
	background: readonly [number, number, number, number] | null;
};

export type BoardGround = {
	readonly view: View3D;
	draw(renderer: Renderer, content: Container, projection: BoardProjection, options: BoardGroundOptions): void;
	destroy(): void;
};

type Band = { texture: RenderTexture; geometry: Geometry3D; material: FlatMaterial; mesh: Mesh3D };

const SLACK = 1.12;
const CLEAR: [number, number, number, number] = [0, 0, 0, 0];

export function createBoardGround(): BoardGround {
	const view = new View3D({ width: 1, height: 1, cull: "off", toneMapping: "none" });
	view.eventMode = "none";
	view.label = "board-ground";
	const bands: Band[] = [];
	const transform = new Matrix();

	function band(index: number): Band {
		let entry = bands[index];
		if (entry) return entry;
		const texture = RenderTexture.create({ width: 16, height: 16, resolution: 1, antialias: true });
		const geometry = new Geometry3D({
			positions: new Float32Array(12),
			uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
			indices: new Uint16Array([0, 3, 1, 1, 3, 2]),
			dynamic: true,
		});
		const material = new FlatMaterial({ baseColorTexture: texture, alphaMode: "blend", fog: false, extraBits: [straightBit] });
		material.state.depthMask = false;
		material.state.depthTest = false;
		const mesh = new Mesh3D({ geometry, material, castShadow: false, receiveShadow: false });
		view.root.addChild(mesh);
		entry = { texture, geometry, material, mesh };
		bands[index] = entry;
		return entry;
	}

	return {
		view,
		draw(renderer, content, projection, options) {
			const planned = boardGroundBands(projection, { density: options.density, maxPixels: options.maxPixels, maxEdge: options.maxEdge });
			planned.forEach((plan, index) => {
				const entry = band(index);
				const { texture } = entry;
				const fits = (have: number, want: number) => have >= want && have <= Math.ceil(want * SLACK * SLACK);
				if (!fits(texture.source.pixelWidth, plan.width) || !fits(texture.source.pixelHeight, plan.height))
					texture.resize(Math.ceil(plan.width * SLACK), Math.ceil(plan.height * SLACK), 1);
				const [a, b, c, d, tx, ty] = plan.matrix;
				const kx = texture.source.pixelWidth / plan.width;
				const ky = texture.source.pixelHeight / plan.height;
				transform.set(a * kx, b * ky, c * kx, d * ky, tx * kx, ty * ky);
				renderer.render({ container: content, target: texture, clear: true, clearColor: options.background ? [...options.background] : CLEAR, transform });
				const positions = entry.geometry.positions as Float32Array;
				plan.corners.forEach((point, corner) => {
					positions.set(toScene(projection, point.x, point.y, 0), corner * 3);
				});
				entry.geometry.attributes.aPosition?.buffer.update();
				entry.mesh.visible = true;
			});
			for (let index = planned.length; index < bands.length; index++) (bands[index] as Band).mesh.visible = false;
			aimBoardCamera(view, projection);
		},
		destroy() {
			for (const entry of bands) {
				entry.mesh.destroy();
				entry.material.destroy();
				entry.geometry.destroy();
				entry.texture.destroy(true);
			}
			bands.length = 0;
			view.destroy({ children: true });
		},
	};
}
