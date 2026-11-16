import {
	BOARD_SCRIPT_HANKY_EXAMPLE,
	type BoardDocument,
	parseBoardDocument,
} from "@neta-art/cohub/board";

const PREFIX = "dev/depth/";

const RIPPLE = `export const bend = {
  glsl: \`
vec3 bend(vec2 uv, vec2 size, float amount, float phase) {
  float r = length((uv - 0.5) * 2.0);
  float wave = sin(r * 14.0 - phase) * exp(-r * 1.6);
  return vec3(0.0, 0.0, amount * min(size.x, size.y) * 0.07 * wave);
}\`,
};

export function draw(g, { width, height }) {
  g.fillStyle = "#0f2a4a";
  g.fillRect(0, 0, width, height);
  g.strokeStyle = "rgba(120, 200, 255, 0.55)";
  g.lineWidth = 2;
  for (let x = 0; x <= width; x += 24) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, height); g.stroke(); }
  for (let y = 0; y <= height; y += 24) { g.beginPath(); g.moveTo(0, y); g.lineTo(width, y); g.stroke(); }
  g.fillStyle = "#e8f6ff";
  g.font = "700 28px Geist";
  g.fillText("custom bend", 24, height - 28);
}
`;

const SCRIPTS: Record<string, string> = {
	"hanky.js": BOARD_SCRIPT_HANKY_EXAMPLE,
	"ripple.js": RIPPLE,
};

export function depthScriptUrl(path: string): string | null {
	if (!path.startsWith(PREFIX)) return null;
	const source = SCRIPTS[path.slice(PREFIX.length)];
	return source === undefined
		? null
		: `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}

const script = (name: string, extra: Record<string, unknown> = {}) => ({
	src: `${PREFIX}${name}`,
	...extra,
});

function card(
	id: string,
	x: number,
	y: number,
	title: string,
	caption: string,
	accent: string,
	depth?: Record<string, unknown>,
) {
	return {
		[id]: {
			type: "frame",
			position: { x, y },
			size: { width: 320, height: 220 },
			props: { label: title, decoration: "none" },
			...(depth ? { depth } : {}),
		},
		[`${id}-panel`]: {
			type: "shape",
			parent: id,
			size: { width: 320, height: 220 },
			style: {
				fill: { light: "#ffffff", dark: "#1d1d21" },
				stroke: accent,
				strokeWidth: 3,
				radius: 20,
			},
			props: { geometry: "rounded" },
		},
		[`${id}-tint`]: {
			type: "shape",
			parent: id,
			size: { width: 320, height: 220 },
			style: { fill: accent, fillOpacity: 0.1, strokeWidth: 0, radius: 20 },
			props: { geometry: "rounded" },
		},
		[`${id}-title`]: {
			type: "text",
			parent: id,
			position: { x: 28, y: 26 },
			props: { text: title, fontSize: 36, fontWeight: 700 },
		},
		[`${id}-body`]: {
			type: "text",
			parent: id,
			position: { x: 28, y: 90 },
			props: { text: caption, fontSize: 18, width: 264, lineHeight: 1.4 },
		},
		[`${id}-chip`]: {
			type: "shape",
			parent: id,
			position: { x: 28, y: 158 },
			size: { width: 120, height: 36 },
			style: { fill: accent, stroke: accent, radius: 18 },
			props: { geometry: "rounded", text: "depth", fontSize: 16 },
		},
	};
}

function playingCard(id: string, x: number, y: number, face: boolean) {
	const color = face ? "#c8102e" : "#ffffff";
	return {
		[id]: {
			type: "frame",
			position: { x, y },
			size: { width: 220, height: 308 },
			props: { label: face ? "Ace" : "Card back", decoration: "none" },
			...(face ? { depth: { back: "card-back" } } : {}),
		},
		[`${id}-paper`]: {
			type: "shape",
			parent: id,
			size: { width: 220, height: 308 },
			style: {
				fill: face ? "#fbf8f1" : "#1f3b8f",
				stroke: face ? "#d9d2c3" : "#f2c14e",
				strokeWidth: face ? 2 : 6,
				radius: 18,
			},
			props: { geometry: "rounded" },
		},
		[`${id}-mark`]: {
			type: "text",
			parent: id,
			position: face ? { x: 18, y: 12 } : { x: 62, y: 104 },
			style: { fill: color },
			props: {
				text: face ? "A\n♥" : "✦",
				fontSize: face ? 34 : 88,
				fontWeight: 700,
				lineHeight: 1,
				font: "serif",
			},
		},
		[`${id}-center`]: {
			type: "text",
			parent: id,
			position: face ? { x: 74, y: 104 } : { x: 54, y: 236 },
			style: { fill: face ? color : "#f2c14e" },
			props: {
				text: face ? "♥" : "COHUB",
				fontSize: face ? 88 : 28,
				fontWeight: 700,
				font: face ? "serif" : "sans",
			},
		},
	};
}

const loop = (tracks: Record<string, unknown>, duration: number) => ({
	play: "always",
	loop: true,
	duration,
	tracks,
});

export function depthDemoDocument(
	options: { still?: boolean; only?: string[] } = {},
): BoardDocument {
	const items: Record<string, unknown> = {
		heading: {
			type: "text",
			position: { x: 0, y: -140 },
			props: { text: "Board depth", fontSize: 44, fontWeight: 700 },
		},
		hint: {
			type: "text",
			position: { x: 0, y: -72 },
			props: {
				text: "Tap the handkerchief three times, or type “toss”. Everything else runs on looping tracks.",
				fontSize: 18,
			},
		},
		hanky: {
			type: "frame",
			position: { x: 0, y: 0 },
			size: { width: 560, height: 560 },
			props: { label: "Handkerchief", decoration: "none" },
		},
		cloth: {
			type: "custom",
			parent: "hanky",
			size: { width: 560, height: 560 },
			script: script("hanky.js", { targets: { lift: "hanky" } }),
		},
		badge: {
			type: "shape",
			parent: "hanky",
			position: { x: 120, y: 206 },
			size: { width: 320, height: 148 },
			style: {
				fill: "#fff7e6",
				fillOpacity: 0.94,
				stroke: "#ffd23f",
				strokeWidth: 4,
				radius: 24,
			},
			props: { geometry: "rounded" },
		},
		badgeTitle: {
			type: "text",
			parent: "hanky",
			position: { x: 150, y: 230 },
			style: { fill: "#b3122e" },
			props: {
				text: "二人转 · 转手绢",
				fontSize: 40,
				fontWeight: 800,
				font: "serif",
			},
		},
		badgeBody: {
			type: "text",
			parent: "hanky",
			position: { x: 152, y: 300 },
			style: { fill: "#5b2a12" },
			props: { text: "A live Board frame in PixiJS 3D", fontSize: 18 },
		},
		...card(
			"tilt",
			680,
			0,
			"Tilt",
			"depth.tilt sways on a looping track, like a card in hand.",
			"blue",
		),
		...card(
			"wave",
			1040,
			0,
			"Wave",
			"depth.bend wave: a flag held at its left edge.",
			"green",
		),
		...card(
			"curl",
			1400,
			0,
			"Curl",
			"depth.bend curl turns it like a page.",
			"amber",
		),
		...card(
			"float",
			680,
			300,
			"Lift",
			"depth.lift rises toward the viewer and casts a shadow.",
			"violet",
		),
		...playingCard("ace", 1060, 300, true),
		...playingCard("card-back", 1340, 300, false),
		duck: {
			type: "file",
			position: { x: 1160, y: 660 },
			size: { width: 240, height: 240 },
			props: {
				src: "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Duck/glTF-Binary/Duck.glb",
				model: { display: "object" },
			},
		},
		fox: {
			type: "file",
			position: { x: 1440, y: 640 },
			size: { width: 280, height: 280 },
			autoplay: true,
			props: {
				src: "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Fox/glTF-Binary/Fox.glb",
				model: {
					display: "object",
					animation: "Walk",
					view: { yaw: 70, pitch: 15, zoom: 1 },
				},
			},
		},
		glass: {
			type: "shape",
			position: { x: 1120, y: 760 },
			size: { width: 220, height: 110 },
			style: {
				fill: "#ffffff",
				fillOpacity: 0.92,
				stroke: "blue",
				strokeWidth: 3,
				radius: 16,
			},
			props: {
				geometry: "rounded",
				text: "rises through the duck",
				fontSize: 18,
			},
		},
		ripple: {
			type: "custom",
			position: { x: 680, y: 660 },
			size: { width: 420, height: 260 },
			script: script("ripple.js"),
			depth: { bend: { kind: "custom", amount: 1 }, shade: 0.8 },
		},
	};
	const animations = {
		"tilt-sway": loop(
			{
				sway: {
					target: "tilt",
					property: "depth.tilt",
					keyframes: [
						{ at: 0, value: { x: 18, y: -28 } },
						{ at: 1800, value: { x: -14, y: 30 }, ease: "ease-in-out" },
						{ at: 3600, value: { x: 18, y: -28 }, ease: "ease-in-out" },
					],
				},
				hover: {
					target: "tilt",
					property: "depth.lift",
					keyframes: [{ at: 0, value: 24 }],
				},
			},
			3600,
		),
		"wave-flag": loop(
			{
				kind: {
					target: "wave",
					property: "depth.bend.kind",
					keyframes: [{ at: 0, value: "wave" }],
				},
				amount: {
					target: "wave",
					property: "depth.bend.amount",
					keyframes: [{ at: 0, value: 0.9 }],
				},
				phase: {
					target: "wave",
					property: "depth.bend.phase",
					keyframes: [
						{ at: 0, value: 0 },
						{ at: 1600, value: Math.PI * 2 },
					],
				},
				lean: {
					target: "wave",
					property: "depth.tilt",
					keyframes: [{ at: 0, value: { x: 0, y: 16 } }],
				},
			},
			1600,
		),
		"curl-page": loop(
			{
				kind: {
					target: "curl",
					property: "depth.bend.kind",
					keyframes: [{ at: 0, value: "curl" }],
				},
				amount: {
					target: "curl",
					property: "depth.bend.amount",
					keyframes: [
						{ at: 0, value: 0 },
						{ at: 1800, value: 0.85, ease: "ease-in-out" },
						{ at: 2400, value: 0.85 },
						{ at: 4200, value: 0, ease: "ease-in-out" },
					],
				},
			},
			4200,
		),
		"float-lift": loop(
			{
				lift: {
					target: "float",
					property: "depth.lift",
					keyframes: [
						{ at: 0, value: 0 },
						{ at: 1400, value: 180, ease: "ease-out" },
						{ at: 2800, value: 0, ease: "cubic-bezier(0.5, 0, 0.75, 0)" },
						{ at: 3600, value: 0 },
					],
				},
				lean: {
					target: "float",
					property: "depth.tilt",
					keyframes: [
						{ at: 0, value: { x: 0, y: 0 } },
						{ at: 1400, value: { x: 16, y: -8 }, ease: "ease-out" },
						{ at: 2800, value: { x: 0, y: 0 }, ease: "ease-in" },
					],
				},
			},
			3600,
		),
		"ace-flip": loop(
			{
				turn: {
					target: "ace",
					property: "depth.tilt",
					keyframes: [
						{ at: 0, value: { x: 0, y: 0 } },
						{ at: 400, value: { x: 0, y: 0 } },
						{
							at: 1300,
							value: { x: 0, y: 180 },
							ease: "cubic-bezier(0.45, 0, 0.2, 1)",
						},
						{ at: 2300, value: { x: 0, y: 180 } },
						{
							at: 3200,
							value: { x: 0, y: 360 },
							ease: "cubic-bezier(0.45, 0, 0.2, 1)",
						},
					],
				},
				rise: {
					target: "ace",
					property: "depth.lift",
					keyframes: [
						{ at: 400, value: 0 },
						{ at: 850, value: 70, ease: "ease-out" },
						{ at: 1300, value: 0, ease: "ease-in" },
						{ at: 2300, value: 0 },
						{ at: 2750, value: 70, ease: "ease-out" },
						{ at: 3200, value: 0, ease: "ease-in" },
					],
				},
			},
			3600,
		),
		"glass-rise": loop(
			{
				lift: {
					target: "glass",
					property: "depth.lift",
					keyframes: [
						{ at: 0, value: 0 },
						{ at: 2000, value: 260, ease: "ease-in-out" },
						{ at: 4000, value: 0, ease: "ease-in-out" },
					],
				},
			},
			4000,
		),
		"fox-turn": loop(
			{
				turn: {
					target: "fox",
					property: "depth.tilt",
					keyframes: [
						{ at: 0, value: { x: 0, y: 0 } },
						{ at: 8000, value: { x: 0, y: 360 } },
					],
				},
			},
			8000,
		),
		"ripple-phase": loop(
			{
				phase: {
					target: "ripple",
					property: "depth.bend.phase",
					keyframes: [
						{ at: 0, value: 0 },
						{ at: 1400, value: Math.PI * 2 },
					],
				},
				lean: {
					target: "ripple",
					property: "depth.tilt",
					keyframes: [{ at: 0, value: { x: 28, y: 0 } }],
				},
			},
			1400,
		),
	};
	if (options.still) {
		Object.assign(items.tilt as object, {
			depth: { lift: 40, tilt: { x: 20, y: -30 } },
		});
		Object.assign(items.ace as object, {
			depth: { back: "card-back", tilt: { x: 0, y: 150 }, lift: 30 },
		});
	}
	const parsed = parseBoardDocument({
		board: { background: { pattern: "dots" } },
		items,
		animations: options.still
			? {}
			: options.only
				? Object.fromEntries(
						Object.entries(animations).filter(([id]) =>
							options.only?.includes(id),
						),
					)
				: animations,
	});
	if (!parsed.ok)
		throw new Error(
			parsed.diagnostics
				.map((entry) => `${entry.path}: ${entry.message}`)
				.join("; "),
		);
	return parsed.document;
}
