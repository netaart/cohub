import type { BoardDocument } from "@neta-art/cohub/board";
import { parseBoardDocument } from "@neta-art/cohub/board";

export const GALLERY_ASSET_PREFIX = "dev/";

const image = (name: string, width: number, height: number) => ({
	src: `${GALLERY_ASSET_PREFIX}img/${name}`,
	snapshot: {
		title: name,
		naturalWidth: width,
		naturalHeight: height,
		mimeType: "image/webp",
	},
});

const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

function galleryItems(): Record<string, unknown> {
	return {
		title: {
			type: "text",
			position: { x: 0, y: -96 },
			props: { text: "Board gallery", fontSize: 32 },
		},
		media: {
			type: "frame",
			position: { x: 0, y: 0 },
			size: { width: 1180, height: 420 },
			props: { label: "Media" },
		},
		castle: {
			type: "image",
			parent: "media",
			position: { x: 32, y: 40 },
			size: { width: 320, height: 180 },
			props: image("hp-arrival.webp", 1280, 720),
		},
		luna: {
			type: "image",
			parent: "media",
			position: { x: 384, y: 40 },
			size: { width: 150, height: 210 },
			props: image("luna.webp", 512, 720),
		},
		forest: {
			type: "image",
			parent: "media",
			position: { x: 566, y: 40 },
			size: { width: 210, height: 210 },
			props: image("hp-forest.webp", 1024, 1024),
		},
		clip: {
			type: "video",
			parent: "media",
			position: { x: 808, y: 40 },
			size: { width: 340, height: 192 },
			props: {
				src: `${GALLERY_ASSET_PREFIX}video/arrival.mp4`,
				snapshot: {
					title: "arrival.mp4",
					durationMs: 6000,
					naturalWidth: 640,
					naturalHeight: 360,
				},
			},
		},
		track: {
			type: "audio",
			parent: "media",
			position: { x: 32, y: 284 },
			size: { width: 340, height: 96 },
			props: {
				src: `${GALLERY_ASSET_PREFIX}audio/cloud-library.mp3`,
				snapshot: { title: "Cloud library.mp3", durationMs: 16000 },
			},
		},
		missing: {
			type: "image",
			parent: "media",
			position: { x: 404, y: 284 },
			size: { width: 160, height: 100 },
			props: image("missing.webp", 160, 100),
		},
		docs: {
			type: "frame",
			position: { x: 0, y: 480 },
			size: { width: 1180, height: 340 },
			props: { label: "Files and tasks" },
		},
		guide: {
			type: "file",
			parent: "docs",
			position: { x: 32, y: 40 },
			size: { width: 260, height: 240 },
			props: {
				src: `${GALLERY_ASSET_PREFIX}docs/guide.html`,
				snapshot: {
					title: "Orientation guide",
					mimeType: "text/html",
					coverPath: `${GALLERY_ASSET_PREFIX}img/cover-guide.png`,
					size: 48_210,
					excerpt: "Houses, timetables and the map of the castle.",
				},
			},
		},
		notes: {
			type: "file",
			parent: "docs",
			position: { x: 324, y: 40 },
			size: { width: 240, height: 160 },
			props: {
				src: `${GALLERY_ASSET_PREFIX}docs/notes.md`,
				snapshot: {
					title: "Sorting notes",
					mimeType: "text/markdown",
					size: 2_140,
					excerpt:
						"New students line up in the great hall, put on the old hat and hear the name of their house.",
				},
			},
		},
		archive: {
			type: "file",
			parent: "docs",
			position: { x: 324, y: 220 },
			size: { width: 240, height: 80 },
			props: {
				src: `${GALLERY_ASSET_PREFIX}docs/archive.zip`,
				snapshot: {
					title: "archive.zip",
					mimeType: "application/zip",
					size: 9_400_000,
				},
			},
		},
		running: {
			type: "task",
			parent: "docs",
			position: { x: 596, y: 40 },
			size: { width: 260, height: 160 },
			props: {
				taskRunId: "dev-running",
				snapshot: {
					taskType: "generation",
					status: "running",
					title: "Forest guardian",
					model: "image-model",
					promptExcerpt: "A glowing stag in a dark forest",
					artifactCount: 0,
					artifacts: [],
					startedAt: iso(-42_000),
				},
			},
		},
		done: {
			type: "task",
			parent: "docs",
			position: { x: 888, y: 40 },
			size: { width: 260, height: 160 },
			props: {
				taskRunId: "dev-done",
				snapshot: {
					taskType: "generation",
					status: "completed",
					title: "Opening line",
					model: "text-model",
					artifactCount: 1,
					artifacts: [
						{
							id: "a",
							type: "text",
							textExcerpt:
								"Past midnight, a page turns somewhere behind the shelves — as if someone has been waiting for you.",
						},
					],
					updatedAt: iso(-60_000),
				},
			},
		},
		queued: {
			type: "task",
			parent: "docs",
			position: { x: 596, y: 220 },
			size: { width: 260, height: 90 },
			props: {
				taskRunId: "dev-queued",
				snapshot: {
					taskType: "generation",
					status: "pending",
					title: "Great hall",
					artifactCount: 0,
					artifacts: [],
				},
			},
		},
		failed: {
			type: "task",
			parent: "docs",
			position: { x: 888, y: 220 },
			size: { width: 260, height: 90 },
			props: {
				taskRunId: "dev-failed",
				snapshot: {
					taskType: "generation",
					status: "failed",
					title: "Library",
					errorExcerpt: "The model rejected the prompt.",
					artifactCount: 0,
					artifacts: [],
				},
			},
		},
		ideas: {
			type: "frame",
			position: { x: 0, y: 880 },
			size: { width: 1180, height: 300 },
			props: { label: "Shapes and links" },
		},
		note: {
			type: "text",
			parent: "ideas",
			position: { x: 32, y: 40 },
			props: { text: "Plain text sits directly on the canvas.", fontSize: 18 },
		},
		story: {
			type: "text",
			parent: "ideas",
			position: { x: 560, y: 24 },
			props: {
				text: "联邦学生会长失踪的那天，基沃托斯的天空没有塌下来——只是所有学园的枪口，同时失去了方向。Wrapped text breaks where the editor does.",
				fontSize: 16,
				width: 580,
			},
		},
		hat: {
			type: "shape",
			parent: "ideas",
			position: { x: 32, y: 150 },
			size: { width: 180, height: 96 },
			props: { geometry: "rounded", text: "Sorting" },
		},
		hall: {
			type: "shape",
			parent: "ideas",
			position: { x: 300, y: 150 },
			size: { width: 180, height: 96 },
			style: { stroke: "blue", fill: "blue", fillOpacity: 0.12 },
			props: { geometry: "rectangle", text: "Great hall" },
		},
		wind: {
			type: "shape",
			parent: "ideas",
			position: { x: 568, y: 140 },
			size: { width: 140, height: 116 },
			style: { stroke: "amber" },
			props: { geometry: "ellipse", text: "Wind" },
		},
		cloak: {
			type: "shape",
			parent: "ideas",
			position: { x: 796, y: 140 },
			size: { width: 140, height: 116 },
			style: { stroke: "violet", dash: "dashed" },
			props: { geometry: "diamond", text: "Cloak" },
		},
		link1: {
			type: "arrow",
			parent: "ideas",
			props: {
				start: { item: "hat" },
				end: { item: "hall" },
				label: "leads to",
			},
		},
		link2: {
			type: "arrow",
			parent: "ideas",
			style: { dash: "dashed" },
			props: {
				start: { item: "hall" },
				end: { item: "wind" },
				route: "orthogonal",
			},
		},
		link3: {
			type: "arrow",
			parent: "ideas",
			props: {
				start: { item: "wind" },
				end: { item: "cloak" },
				route: "curve",
				bend: 0.3,
			},
		},
		scribble: {
			type: "draw",
			parent: "ideas",
			style: { stroke: "rose", strokeWidth: 4 },
			props: {
				points: [
					{ x: 1000, y: 160, p: 0.5 },
					{ x: 1040, y: 200, p: 0.6 },
					{ x: 1080, y: 150, p: 0.5 },
					{ x: 1120, y: 220, p: 0.4 },
				],
			},
		},
		web: {
			type: "file",
			position: { x: 1240, y: 0 },
			size: { width: 300, height: 420 },
			props: {
				src: "https://example.com/",
				snapshot: { title: "example.com", mimeType: "text/html" },
			},
		},
	};
}

export const BENCH_SCENARIOS = ["mixed", "images", "notes", "tasks"] as const;
export type BenchScenario = (typeof BENCH_SCENARIOS)[number];

const BENCH_IMAGES = [
	"hp-arrival.webp",
	"luna.webp",
	"hp-forest.webp",
	"hp-library.webp",
];
const BENCH_PROSE = [
	"Past midnight, a page turns somewhere behind the shelves.",
	"The lantern swings once, twice, and the corridor answers with a hum.",
	"夜色很深，书架后面传来一页纸被翻动的声音。",
	"Someone left a map on the table, folded along a line nobody drew.",
];

function benchImage(index: number, x: number, y: number) {
	const name = BENCH_IMAGES[index % BENCH_IMAGES.length] as string;
	const tall = name === "luna.webp";
	return {
		type: "image",
		position: { x, y },
		size: tall ? { width: 150, height: 200 } : { width: 200, height: 150 },
		// A distinct URL per card, so each holds its own texture as on a real board.
		props: image(`${name}?n=${index}`, tall ? 768 : 1024, tall ? 1024 : 768),
	};
}

function benchNote(index: number, x: number, y: number) {
	const lines = 1 + (index % 3);
	const text = Array.from(
		{ length: lines },
		(_, line) => BENCH_PROSE[(index + line) % BENCH_PROSE.length],
	).join("\n");
	return {
		type: "text",
		position: { x, y },
		props: {
			text: index % 5 === 0 ? `Note ${index}` : text,
			fontSize: index % 5 === 0 ? 28 : 14,
			width: 200,
		},
	};
}

function benchTask(index: number, x: number, y: number) {
	const status = (["completed", "running", "failed", "completed"] as const)[
		index % 4
	];
	return {
		type: "task",
		position: { x, y },
		size: { width: 200, height: 150 },
		props: {
			taskRunId: `bench-${index}`,
			snapshot: {
				taskType: "generation",
				status,
				title: `Task ${index}`,
				model: "image-model",
				promptExcerpt: BENCH_PROSE[index % BENCH_PROSE.length],
				artifactCount: 0,
				artifacts: [],
				startedAt: iso(-42_000),
			},
		},
	};
}

function benchMixed(index: number, x: number, y: number) {
	switch (index % 4) {
		case 0:
			return benchImage(index, x, y);
		case 1:
			return {
				type: "shape",
				position: { x, y },
				size: { width: 200, height: 150 },
				props: { geometry: "rounded", text: `Card ${index}` },
			};
		case 2:
			return {
				type: "file",
				position: { x, y },
				size: { width: 200, height: 150 },
				props: {
					src: `${GALLERY_ASSET_PREFIX}docs/n${index}.md`,
					snapshot: {
						title: `Note ${index}`,
						mimeType: "text/markdown",
						excerpt: "A short excerpt to measure text layout.",
					},
				},
			};
		default:
			return benchNote(index, x, y);
	}
}

const BENCH_ITEMS = {
	mixed: benchMixed,
	images: benchImage,
	notes: benchNote,
	tasks: benchTask,
} satisfies Record<BenchScenario, unknown>;

function benchItems(
	count: number,
	scenario: BenchScenario,
): Record<string, unknown> {
	const items: Record<string, unknown> = {};
	const columns = Math.ceil(Math.sqrt(count));
	const create = BENCH_ITEMS[scenario];
	for (let index = 0; index < count; index += 1) {
		items[`n${index}`] = create(
			index,
			(index % columns) * 240,
			Math.floor(index / columns) * 200,
		);
	}
	return items;
}

export function boardGalleryDocument(
	options: { bench?: number; scenario?: BenchScenario } = {},
): BoardDocument {
	const items = options.bench
		? benchItems(options.bench, options.scenario ?? "mixed")
		: galleryItems();
	const parsed = parseBoardDocument({ board: {}, items, animations: {} });
	if (!parsed.ok)
		throw new Error(
			parsed.diagnostics
				.map((entry) => `${entry.path}: ${entry.message}`)
				.join("; "),
		);
	return parsed.document;
}
