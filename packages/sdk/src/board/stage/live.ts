import { type BoardAutoplayKind, type BoardDocument, type BoardScene, type BoardViewport, boardAutoplayKind, itemBounds } from "../model/index.js";

export type BoardLiveBudget = Record<BoardAutoplayKind, number>;

const MIN_EDGE: Record<BoardAutoplayKind, number> = { video: 64, model: 120, app: 120 };
const KEEP = 0.85;
const INCUMBENT = 1.5;
const WARM_MS: Record<BoardAutoplayKind, number> = { video: 0, model: 5_000, app: 30_000 };

type Candidate = { id: string; kind: BoardAutoplayKind; auto: boolean };
type Ranked = { id: string; manual: boolean; area: number };

export type BoardLiveScheduler = {
	readonly running: ReadonlySet<string>;
	override(id: string, running: boolean | null): void;
	sync(input: {
		items: BoardDocument["items"];
		scene: BoardScene;
		visible: ReadonlySet<string> | null;
		camera: BoardViewport;
		surface: { width: number; height: number };
		allow: (kind: BoardAutoplayKind) => boolean;
		now: number;
	}): boolean;
	readonly wake: number | null;
};

export function createBoardLiveScheduler(budget: BoardLiveBudget): BoardLiveScheduler {
	const overrides = new Map<string, boolean>();
	const warmUntil = new Map<string, number>();
	let candidates: { items: BoardDocument["items"]; version: number; list: Candidate[] } | null = null;
	let version = 0;
	let running: ReadonlySet<string> = new Set();
	let wake: number | null = null;

	function collect(items: BoardDocument["items"]): Candidate[] {
		if (candidates?.items === items && candidates.version === version) return candidates.list;
		for (const id of overrides.keys()) if (!items[id]) overrides.delete(id);
		const list: Candidate[] = [];
		for (const [id, item] of Object.entries(items)) {
			const choice = overrides.get(id);
			if (choice === false || (!item.autoplay && !choice)) continue;
			const kind = boardAutoplayKind(item);
			if (kind) list.push({ id, kind, auto: !choice });
		}
		candidates = { items, version, list };
		return list;
	}

	return {
		get running() {
			return running;
		},
		get wake() {
			return wake;
		},
		override(id, choice) {
			if (choice === null ? !overrides.delete(id) : overrides.get(id) === choice) return;
			if (choice !== null) overrides.set(id, choice);
			version += 1;
		},
		sync({ items, scene, visible, camera, surface, allow, now }) {
			const left = -camera.x / camera.zoom;
			const top = -camera.y / camera.zoom;
			const right = left + surface.width / camera.zoom;
			const bottom = top + surface.height / camera.zoom;
			const wanted: Record<BoardAutoplayKind, Ranked[]> = { video: [], model: [], app: [] };
			const warm: Record<BoardAutoplayKind, string[]> = { video: [], model: [], app: [] };
			for (const { id, kind, auto } of collect(items)) {
				if (auto && !allow(kind)) continue;
				const item = scene.get(id);
				if (!item || !scene.shown(id)) continue;
				const { frame } = item;
				const edge = Math.min(frame.width, frame.height) * camera.zoom;
				const minimum = MIN_EDGE[kind] * (running.has(id) ? KEEP : 1);
				const bounds = itemBounds(frame);
				const shown = visible?.has(id)
					? Math.max(0, Math.min(right, bounds.x + bounds.width) - Math.max(left, bounds.x)) *
						Math.max(0, Math.min(bottom, bounds.y + bounds.height) - Math.max(top, bounds.y))
					: 0;
				if (shown > 0 && edge >= minimum) wanted[kind].push({ id, manual: !auto, area: shown * (running.has(id) ? INCUMBENT : 1) });
				else if (running.has(id) || (warmUntil.get(id) ?? 0) > now) warm[kind].push(id);
			}
			const next = new Set<string>();
			wake = null;
			for (const kind of Object.keys(wanted) as BoardAutoplayKind[]) {
				const ranked = wanted[kind].sort((a, b) => Number(b.manual) - Number(a.manual) || b.area - a.area);
				const manual = ranked.filter((entry) => entry.manual).length;
				const admitted = ranked.slice(0, Math.max(budget[kind], manual));
				for (const { id } of admitted) {
					next.add(id);
					warmUntil.set(id, now + WARM_MS[kind]);
				}
				let spare = budget[kind] - admitted.length;
				const kept = warm[kind].sort((a, b) => (warmUntil.get(b) ?? 0) - (warmUntil.get(a) ?? 0));
				for (const id of kept) {
					const until = warmUntil.get(id) ?? 0;
					if (spare <= 0 || until <= now) break;
					spare -= 1;
					next.add(id);
					wake = Math.min(wake ?? Infinity, until - now);
				}
			}
			for (const [id, until] of warmUntil) if (until <= now && !next.has(id)) warmUntil.delete(id);
			if (next.size === running.size && [...next].every((id) => running.has(id))) return false;
			running = next;
			return true;
		},
	};
}
