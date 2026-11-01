import { BOARD_SHADOW_DEFAULTS, type BoardFilter, type BoardShadow, type BoardStyle } from "@cohub/protocol";
import {
	ColorMatrixFilter,
	type ColorMatrix,
	Container,
	DOMAdapter,
	defaultFilterVert,
	Filter,
	type FilterSystem,
	GlProgram,
	type ICanvas,
	ImageSource,
	Rectangle,
	type Renderer,
	type RenderSurface,
	Sprite,
	Texture,
	TexturePool,
} from "pixi.js";
import { itemAlpha, itemColor } from "./palette.js";
import type { BoardRenderContext } from "./renderers/board-renderer-registry.js";

export type BoardEffectsContext = Pick<BoardRenderContext, "colors" | "colorScheme" | "palette" | "zoom" | "blurs">;

type Row = [number, number, number, number, number];
type Matrix = [Row, Row, Row, Row];

const IDENTITY: Matrix = [
	[1, 0, 0, 0, 0],
	[0, 1, 0, 0, 0],
	[0, 0, 1, 0, 0],
	[0, 0, 0, 1, 0],
];

function rgb(m: number[]): Matrix {
	return [
		[m[0] ?? 0, m[1] ?? 0, m[2] ?? 0, 0, 0],
		[m[3] ?? 0, m[4] ?? 0, m[5] ?? 0, 0, 0],
		[m[6] ?? 0, m[7] ?? 0, m[8] ?? 0, 0, 0],
		[0, 0, 0, 1, 0],
	];
}

function linear(slope: number, intercept: number): Matrix {
	return [
		[slope, 0, 0, 0, intercept],
		[0, slope, 0, 0, intercept],
		[0, 0, slope, 0, intercept],
		[0, 0, 0, 1, 0],
	];
}

function compose(after: Matrix, before: Matrix): Matrix {
	return after.map((row) =>
		row.map((offset, column) => {
			let sum = column === 4 ? offset : 0;
			for (const [k, source] of before.entries()) sum += (row[k] as number) * (source[column] as number);
			return sum;
		}),
	) as Matrix;
}

const COLOR_STEPS: Array<{ key: keyof BoardFilter; neutral: number; css: (value: number) => string; matrix: (value: number) => Matrix }> = [
	{ key: "brightness", neutral: 1, css: (v) => `brightness(${v})`, matrix: (v) => linear(v, 0) },
	{ key: "contrast", neutral: 1, css: (v) => `contrast(${v})`, matrix: (v) => linear(v, 0.5 - 0.5 * v) },
	{
		key: "saturate",
		neutral: 1,
		css: (v) => `saturate(${v})`,
		matrix: (s) => rgb([0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s]),
	},
	{
		key: "hue",
		neutral: 0,
		css: (v) => `hue-rotate(${v}deg)`,
		matrix: (degrees) => {
			const c = Math.cos((degrees * Math.PI) / 180);
			const s = Math.sin((degrees * Math.PI) / 180);
			return rgb([
				0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
				0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
				0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
			]);
		},
	},
	{
		key: "grayscale",
		neutral: 0,
		css: (v) => `grayscale(${v})`,
		matrix: (g) => {
			const a = 1 - g;
			return rgb([0.2126 + 0.7874 * a, 0.7152 - 0.7152 * a, 0.0722 - 0.0722 * a, 0.2126 - 0.2126 * a, 0.7152 + 0.2848 * a, 0.0722 - 0.0722 * a, 0.2126 - 0.2126 * a, 0.7152 - 0.7152 * a, 0.0722 + 0.9278 * a]);
		},
	},
	{
		key: "sepia",
		neutral: 0,
		css: (v) => `sepia(${v})`,
		matrix: (s) => {
			const a = 1 - s;
			return rgb([0.393 + 0.607 * a, 0.769 - 0.769 * a, 0.189 - 0.189 * a, 0.349 - 0.349 * a, 0.686 + 0.314 * a, 0.168 - 0.168 * a, 0.272 - 0.272 * a, 0.534 - 0.534 * a, 0.131 + 0.869 * a]);
		},
	},
	{ key: "invert", neutral: 0, css: (v) => `invert(${v})`, matrix: (v) => linear(1 - 2 * v, v) },
];

function colorSteps(filter: BoardFilter | undefined) {
	return COLOR_STEPS.filter((step) => {
		const value = filter?.[step.key];
		return value !== undefined && value !== step.neutral;
	}).map((step) => ({ step, value: filter?.[step.key] as number }));
}

class BoardColorFilter extends ColorMatrixFilter {
	css = "";

	set(filter: BoardFilter | undefined) {
		const steps = colorSteps(filter);
		this.css = steps.map(({ step, value }) => step.css(value)).join(" ");
		this.matrix = steps.reduce((matrix, { step, value }) => compose(step.matrix(value), matrix), IDENTITY).flat() as ColorMatrix;
	}

	getCanvasFilterString(): string {
		return this.css;
	}
}

const program = (name: string, fragment: string) => GlProgram.from({ vertex: defaultFilterVert, fragment, name });

const BLUR_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform highp vec4 uInputSize;
uniform highp vec4 uInputClamp;
uniform vec2 uStep;

void main(void) {
	vec4 sum = vec4(0.0);
	float total = 0.0;
	for (int i = -12; i <= 12; i++) {
		float weight = exp(-float(i * i) / 32.0);
		vec2 coord = vTextureCoord + uStep * float(i) * uInputSize.zw;
		vec2 inside = step(uInputClamp.xy, coord) * step(coord, uInputClamp.zw);
		sum += texture(uTexture, coord) * weight * inside.x * inside.y;
		total += weight;
	}
	finalColor = sum / total;
}
`;

const SHADOW_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform highp vec4 uInputSize;
uniform highp vec4 uInputClamp;
uniform vec2 uOffset;
uniform vec4 uColor;

void main(void) {
	vec2 coord = vTextureCoord - uOffset * uInputSize.zw;
	vec2 inside = step(uInputClamp.xy, coord) * step(coord, uInputClamp.zw);
	finalColor = uColor * texture(uTexture, coord).a * inside.x * inside.y;
}
`;

const COPY_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;

void main(void) {
	finalColor = texture(uTexture, vTextureCoord);
}
`;

let passes: { horizontal: Filter; vertical: Filter; copy: Filter } | null = null;

function blurPass(): Filter {
	return new Filter({ glProgram: program("board-blur", BLUR_FRAGMENT), resources: { blurUniforms: { uStep: { value: new Float32Array(2), type: "vec2<f32>" } } } });
}

function shaderPasses() {
	passes ??= { horizontal: blurPass(), vertical: blurPass(), copy: new Filter({ glProgram: program("board-copy", COPY_FRAGMENT) }) };
	return passes;
}

function gaussian(filters: FilterSystem, input: Texture, output: RenderSurface, deviation: number, clear: boolean) {
	const { horizontal, vertical } = shaderPasses();
	horizontal.resources.blurUniforms.uniforms.uStep = [deviation / 4, 0];
	vertical.resources.blurUniforms.uniforms.uStep = [0, deviation / 4];
	const between = TexturePool.getSameSizeTexture(input);
	filters.applyFilter(horizontal, input, between, true);
	filters.applyFilter(vertical, between, output, clear);
	TexturePool.returnTexture(between);
}

class BoardBlurFilter extends Filter {
	css = "";
	radius = 0;
	private deviation = 0;

	constructor() {
		super({ glProgram: program("board-copy", COPY_FRAGMENT) });
	}

	set(radius: number, zoom: number) {
		this.radius = radius;
		this.deviation = radius * zoom;
		this.padding = Math.ceil(radius * 3 * zoom);
		this.css = `blur(${radius * zoom}px)`;
	}

	override apply(filters: FilterSystem, input: Texture, output: RenderSurface, clearMode: boolean) {
		gaussian(filters, input, output, this.deviation, clearMode);
	}

	getCanvasFilterString(): string {
		return this.css;
	}
}

type ShadowCast = { x: number; y: number; blur: number; color: number; alpha: number };

class BoardShadowFilter extends Filter {
	css = "";
	cast: ShadowCast = { x: 0, y: 0, blur: 0, color: 0, alpha: 0 };
	private deviation = 0;

	constructor() {
		super({
			glProgram: program("board-shadow", SHADOW_FRAGMENT),
			resources: {
				shadowUniforms: {
					uOffset: { value: new Float32Array(2), type: "vec2<f32>" },
					uColor: { value: new Float32Array(4), type: "vec4<f32>" },
				},
			},
		});
	}

	set(shadow: ShadowCast, zoom: number) {
		this.cast = shadow;
		const uniforms = this.resources.shadowUniforms.uniforms;
		uniforms.uOffset = [shadow.x * zoom, shadow.y * zoom];
		const { alpha, color } = shadow;
		uniforms.uColor = [(((color >> 16) & 255) / 255) * alpha, (((color >> 8) & 255) / 255) * alpha, ((color & 255) / 255) * alpha, alpha];
		this.deviation = (shadow.blur / 2) * zoom;
		this.padding = Math.ceil((shadow.blur * 1.5 + Math.max(Math.abs(shadow.x), Math.abs(shadow.y))) * zoom);
		const hex = color.toString(16).padStart(6, "0");
		const a = Math.round(alpha * 255).toString(16).padStart(2, "0");
		this.css = `drop-shadow(${shadow.x * zoom}px ${shadow.y * zoom}px ${shadow.blur * zoom}px #${hex}${a})`;
	}

	override apply(filters: FilterSystem, input: Texture, output: RenderSurface, clearMode: boolean) {
		const { copy } = shaderPasses();
		const shadow = TexturePool.getSameSizeTexture(input);
		filters.applyFilter(this, input, shadow, true);
		if (this.deviation > 0) gaussian(filters, shadow, output, this.deviation, clearMode);
		else filters.applyFilter(copy, shadow, output, clearMode);
		filters.applyFilter(copy, input, output, false);
		TexturePool.returnTexture(shadow);
	}

	getCanvasFilterString(): string {
		return this.css;
	}
}

type EffectFilters = { color?: BoardColorFilter; blur?: BoardBlurFilter; shadow?: BoardShadowFilter; key: string };

const filtersByContainer = new WeakMap<Container, EffectFilters>();

export function hasBoardEffects(style: BoardStyle | undefined): boolean {
	return Boolean(style && (style.filter || style.shadow || (style.blend && style.blend !== "normal")));
}

function resolveShadow(shadow: BoardShadow, context: BoardEffectsContext) {
	return {
		x: shadow.x ?? BOARD_SHADOW_DEFAULTS.x,
		y: shadow.y ?? BOARD_SHADOW_DEFAULTS.y,
		blur: shadow.blur ?? BOARD_SHADOW_DEFAULTS.blur,
		color: itemColor(context, shadow.color, "black", "fill"),
		alpha: itemAlpha(context, shadow.color) * (shadow.opacity ?? BOARD_SHADOW_DEFAULTS.opacity),
	};
}

export function syncBoardEffects(container: Container, style: BoardStyle | undefined, context: BoardEffectsContext) {
	container.blendMode = style?.blend && style.blend !== "normal" ? style.blend : "inherit";
	const filter = style?.filter;
	const blurs = context.blurs !== false;
	const blur = blurs ? (filter?.blur ?? 0) : 0;
	const shadow = blurs && style?.shadow ? resolveShadow(style.shadow, context) : null;
	const colored = colorSteps(filter).length > 0;
	let parts = filtersByContainer.get(container);
	if (!colored && blur <= 0 && !shadow) {
		if (parts) {
			container.filters = null;
			filtersByContainer.delete(container);
		}
		return;
	}
	const { zoom } = context;
	const key = JSON.stringify([filter, shadow, zoom]);
	if (parts?.key === key) return;
	parts ??= { key: "" };
	parts.key = key;
	parts.color = colored ? (parts.color ?? new BoardColorFilter()) : undefined;
	parts.blur = blur > 0 ? (parts.blur ?? new BoardBlurFilter()) : undefined;
	parts.shadow = shadow ? (parts.shadow ?? new BoardShadowFilter()) : undefined;
	parts.color?.set(filter);
	if (blur > 0) parts.blur?.set(blur, zoom);
	if (shadow) parts.shadow?.set(shadow, zoom);
	filtersByContainer.set(container, parts);
	container.filters = [parts.color, parts.blur, parts.shadow].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
}

export function rescaleBoardEffects(container: Container, style: BoardStyle | undefined, context: BoardEffectsContext) {
	if (filtersByContainer.has(container)) syncBoardEffects(container, style, context);
}

const MAX_FLAT_PIXELS = 16_000_000;
const MAX_FLAT_EDGE = 8192;

/** Canvas filters apply per draw call, so exports draw blurred and shadowed layers into one picture first. */
export function flattenBoardEffects(renderer: Renderer, root: Container, resolution: number): () => void {
	const textures: Texture[] = [];
	const visit = (node: Container) => {
		for (const child of [...node.children]) visit(child);
		const parts = filtersByContainer.get(node);
		if ((parts?.blur || parts?.shadow) && node.parent) flatten(node, parts);
	};
	const flatten = (target: Container, parts: EffectFilters) => {
		const parent = target.parent as Container;
		const { filters, alpha } = target;
		target.filters = parts.color ? [parts.color] : null;
		target.alpha = 1;
		const bounds = target.getLocalBounds();
		const restore = () => Object.assign(target, { filters, alpha });
		if (bounds.width <= 0 || bounds.height <= 0) return restore();
		target.updateLocalTransform();
		const cast = parts.shadow && localCast(parts.shadow.cast, target.localTransform);
		const grow = (parts.blur?.radius ?? 0) * 3 + (cast ? cast.blur * 1.5 + Math.max(Math.abs(cast.x), Math.abs(cast.y)) : 0);
		const frame = new Rectangle(bounds.x - grow, bounds.y - grow, bounds.width + grow * 2, bounds.height + grow * 2);
		const scale = Math.min(resolution, Math.sqrt(MAX_FLAT_PIXELS / (frame.width * frame.height)), MAX_FLAT_EDGE / Math.max(frame.width, frame.height));
		const picture = renderer.generateTexture({ target, frame, resolution: scale, antialias: true });
		restore();
		const flat = paintEffects(renderer.texture.generateCanvas(picture), parts.blur?.radius ?? 0, cast, scale);
		picture.destroy(true);
		textures.push(flat);
		const layer = new Container({ label: "board-flat-effects" });
		layer.setFromMatrix(target.localTransform);
		layer.addChild(new Sprite(flat)).position.set(frame.x, frame.y);
		Object.assign(layer, { alpha, blendMode: target.blendMode, zIndex: target.zIndex });
		parent.addChildAt(layer, parent.getChildIndex(target));
		target.visible = false;
	};
	visit(root);
	return () => {
		for (const texture of textures) texture.destroy(true);
	};
}

function localCast(cast: ShadowCast, transform: { a: number; b: number; c: number; d: number }): ShadowCast {
	const { a, b, c, d } = transform;
	const det = a * d - b * c || 1;
	return { ...cast, x: (d * cast.x - c * cast.y) / det, y: (a * cast.y - b * cast.x) / det };
}

function canvas2d(width: number, height: number) {
	const canvas = DOMAdapter.get().createCanvas(width, height);
	return { canvas, context: canvas.getContext("2d") as unknown as CanvasRenderingContext2D };
}

function paintEffects(picture: ICanvas, blur: number, cast: ShadowCast | undefined, resolution: number): Texture {
	const { width, height } = picture;
	let content = picture as unknown as CanvasImageSource;
	if (blur > 0) {
		const blurred = canvas2d(width, height);
		blurred.context.filter = `blur(${blur * resolution}px)`;
		blurred.context.drawImage(content, 0, 0);
		content = blurred.canvas as unknown as CanvasImageSource;
	}
	const out = canvas2d(width, height);
	if (cast) {
		const silhouette = canvas2d(width, height);
		silhouette.context.drawImage(content, 0, 0);
		silhouette.context.globalCompositeOperation = "source-in";
		silhouette.context.fillStyle = `#${cast.color.toString(16).padStart(6, "0")}`;
		silhouette.context.fillRect(0, 0, width, height);
		out.context.filter = `blur(${(cast.blur / 2) * resolution}px)`;
		out.context.globalAlpha = cast.alpha;
		out.context.drawImage(silhouette.canvas as unknown as CanvasImageSource, cast.x * resolution, cast.y * resolution);
		out.context.filter = "none";
		out.context.globalAlpha = 1;
	}
	out.context.drawImage(content, 0, 0);
	return new Texture({ source: new ImageSource({ resource: out.canvas as unknown as HTMLCanvasElement, resolution }) });
}
