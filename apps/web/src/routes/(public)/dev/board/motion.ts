import { BOARD_SCRIPT_RAIN_EXAMPLE } from "@neta-art/cohub/board";

export const MOTION_SCRIPT_PREFIX = "dev/scripts/";

const SCRIPTS: Record<string, string> = {
	"rain.js": BOARD_SCRIPT_RAIN_EXAMPLE,
	"counter.js": `export const parameters = {
  label: { type: "string", label: "Label", default: "Tap to count" },
  color: { type: "color", label: "Color", default: "#e67845" },
  step: { type: "number", label: "Step", default: 1, min: 1, max: 10, step: 1 },
  rounded: { type: "boolean", label: "Rounded", default: true },
};

export default function (ctx) {
  ctx.state.count ??= 0;
  ctx.hitRegions({ button: { target: "self", label: "Count", cursor: "pointer" } });
  ctx.on("click", () => {
    ctx.state.count += ctx.params.step;
    ctx.invalidate();
  });
}

export function draw(g, { width, height, params, state }) {
  g.fillStyle = params.color;
  g.beginPath();
  g.roundRect(0, 0, width, height, params.rounded ? height / 2 : 6);
  g.fill();
  g.fillStyle = "#fff";
  g.font = "600 20px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(params.label + " · " + (state.count ?? 0), width / 2, height / 2);
}
`,
	"slider.js": `export const parameters = {
  color: { type: "color", label: "Color", default: "#4c8dff" },
};

export default function (ctx) {
  ctx.state.value ??= 0.4;
  let dragging = false;
  const set = (event) => {
    ctx.state.value = Math.min(1, Math.max(0, event.point.x / ctx.self.base.size.width));
    ctx.invalidate();
  };
  ctx.hitRegions({ track: { target: "self", label: "Slider", cursor: "ew-resize" } });
  ctx.on("pointerdown", (event) => { dragging = true; set(event); });
  ctx.on("pointermove", (event) => { if (dragging) set(event); });
  ctx.on("pointerup", () => { dragging = false; });
  ctx.on("pointercancel", () => { dragging = false; });
}

export function draw(g, { width, height, params, state }) {
  const value = state.value ?? 0.4;
  g.fillStyle = "rgba(127,127,127,0.25)";
  g.beginPath();
  g.roundRect(0, height / 2 - 6, width, 12, 6);
  g.fill();
  g.fillStyle = params.color;
  g.beginPath();
  g.roundRect(0, height / 2 - 6, width * value, 12, 6);
  g.fill();
  g.beginPath();
  g.arc(width * value, height / 2, 16, 0, Math.PI * 2);
  g.fill();
}
`,
	"garden.js": `export default function (ctx) {
  ctx.on("gesture", ({ data }) => {
    if (data.tool !== "draw" || data.phase !== "end" || !data.item) return;
    const xs = data.points.map((p) => p.x);
    const ys = data.points.map((p) => p.y);
    const size = Math.max(24, Math.min(160, Math.max(...xs) - Math.min(...xs)));
    ctx.commit({ items: {
      [data.item]: null,
      ["flower-" + data.id]: {
        type: "custom", parent: ctx.self.id,
        position: { x: (Math.min(...xs) + Math.max(...xs) - size) / 2, y: (Math.min(...ys) + Math.max(...ys) - size) / 2 },
        size: { width: size, height: size },
        script: { src: "${MOTION_SCRIPT_PREFIX}flower.js" },
      },
    } });
  });
}
`,
	"flower.js": `export const pixelated = true;
export const frameRate = 12;

export default function (ctx) {
  const phase = ctx.random() * Math.PI * 2;
  ctx.onFrame(({ t }) => ctx.self.present({ rotation: Math.sin(t / 600 + phase) * 6 }));
}

export function draw(g, { width, height, seed }) {
  const hue = [...seed].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 360;
  const u = Math.max(1, Math.floor(width / 8));
  g.fillStyle = "#3f8f4a";
  g.fillRect(width / 2 - u / 2, height / 2, u, height / 2);
  g.fillStyle = \`hsl(\${hue} 80% 65%)\`;
  for (const [x, y] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) g.fillRect(width / 2 + (x - 0.5) * 2 * u, height / 3 + (y - 0.5) * 2 * u, 2 * u, 2 * u);
  g.fillStyle = "#ffd54f";
  g.fillRect(width / 2 - u, height / 3 - u, 2 * u, 2 * u);
}
`,
	"broken.js": `export default function () {
  const missing = undefined;
  return missing.point.x;
}
`,
};

export function motionScriptUrl(path: string): string | null {
	if (!path.startsWith(MOTION_SCRIPT_PREFIX)) return null;
	const source = SCRIPTS[path.slice(MOTION_SCRIPT_PREFIX.length)];
	return source === undefined
		? null
		: `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}

const script = (name: string) => ({ src: `${MOTION_SCRIPT_PREFIX}${name}` });

export const MOTION_BOARD_SCRIPTS = { rain: script("rain.js") };

export function motionItems(stress = 0): Record<string, unknown> {
	const dots: Record<string, unknown> = {};
	for (let index = 0; index < stress; index += 1)
		dots[`dot-${index}`] = {
			type: "shape",
			position: { x: (index % 40) * 24, y: 340 + Math.floor(index / 40) * 24 },
			size: { width: 16, height: 16 },
			props: { geometry: "ellipse" },
		};
	return {
		...dots,
		heading: {
			type: "text",
			position: { x: 0, y: -80 },
			props: { text: "Motion playground", fontSize: 32 },
		},
		counter: {
			type: "custom",
			position: { x: 0, y: 0 },
			size: { width: 280, height: 64 },
			script: script("counter.js"),
		},
		slider: {
			type: "custom",
			position: { x: 340, y: 0 },
			size: { width: 320, height: 64 },
			script: script("slider.js"),
		},
		broken: {
			type: "custom",
			position: { x: 720, y: 0 },
			size: { width: 200, height: 64 },
			script: script("broken.js"),
		},
		garden: {
			type: "frame",
			position: { x: 0, y: 340 },
			size: { width: 520, height: 220 },
			props: { label: "Draw a circle with the pen" },
			script: script("garden.js"),
		},
		seedling: {
			type: "custom",
			parent: "garden",
			position: { x: 20, y: 140 },
			size: { width: 48, height: 48 },
			script: script("flower.js"),
		},
		card: {
			type: "shape",
			position: { x: 0, y: 140 },
			size: { width: 240, height: 140 },
			props: { geometry: "rounded", text: "Card" },
			style: { fill: "blue", fillOpacity: 0.16 },
		},
		badge: {
			type: "shape",
			position: { x: 320, y: 160 },
			size: { width: 120, height: 120 },
			props: { geometry: "ellipse", text: "Badge" },
			style: { fill: "amber", fillOpacity: 0.2 },
		},
	};
}

export function motionAnimations(stress = 0): Record<string, unknown> {
	const tracks: Record<string, unknown> = {};
	for (let index = 0; index < stress; index += 1)
		tracks[`dot-${index}-opacity`] = {
			target: `dot-${index}`,
			property: "opacity",
			keyframes: Array.from({ length: 20 }, (_, step) => ({
				at: step * 100,
				value: (step + index) % 2,
			})),
		};
	return {
		intro: {
			name: "Intro",
			duration: 2000,
			markers: [{ at: 1000, label: "Badge", pause: true }],
			tracks: {
				...tracks,
				"card-position": {
					target: "card",
					property: "position",
					keyframes: [
						{ at: 0, value: { x: 0, y: 220 } },
						{ at: 800, value: { x: 0, y: 140 }, ease: "ease-out" },
					],
				},
				"card-opacity": {
					target: "card",
					property: "opacity",
					keyframes: [
						{ at: 0, value: 0 },
						{ at: 600, value: 1 },
					],
				},
				"badge-rotation": {
					target: "badge",
					property: "rotation",
					keyframes: [
						{ at: 1000, value: -20 },
						{ at: 2000, value: 0, ease: "ease-in-out" },
					],
				},
			},
		},
	};
}
