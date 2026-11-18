import type { BoardSceneItem } from "../model/index.js";
import type { LoadedModel, ModelAsset } from "../render/model3d/index.js";

export type BoardModelTicket = {
	readonly model: LoadedModel | null;
	readonly failed: boolean;
	release(): void;
};

export type BoardModelLoader = {
	request(key: string, item: BoardSceneItem, ready: (model: LoadedModel | null) => void): BoardModelTicket;
	focus(point: { x: number; y: number } | null): void;
	destroy(): void;
};

export type BoardModelLoaderOptions = {
	load: (item: BoardSceneItem, signal: AbortSignal) => Promise<ModelAsset> | null;
	concurrency: number;
};

type Ticket = { model: LoadedModel | null; failed: boolean; at: { x: number; y: number }; ready: (model: LoadedModel | null) => void; release(): void };
type Entry = { key: string; item: BoardSceneItem; tickets: Set<Ticket>; asset: ModelAsset | null; failed: boolean; controller: AbortController };

export function createBoardModelLoader(options: BoardModelLoaderOptions): BoardModelLoader {
	const entries = new Map<string, Entry>();
	const waiting = new Set<Entry>();
	let focus: { x: number; y: number } | null = null;
	let active = 0;
	let disposed = false;
	let pumping = false;

	function distance(entry: Entry): number {
		if (!focus) return 0;
		let nearest = Infinity;
		for (const { at } of entry.tickets) nearest = Math.min(nearest, Math.hypot(at.x - focus.x, at.y - focus.y));
		return nearest;
	}

	function fill(ticket: Ticket, entry: Entry) {
		ticket.failed = entry.failed;
		ticket.model = entry.asset?.create() ?? null;
		ticket.ready(ticket.model);
	}

	function settle(entry: Entry, asset: ModelAsset | null) {
		active -= 1;
		if (disposed || entries.get(entry.key) !== entry) asset?.destroy();
		else {
			entry.asset = asset;
			entry.failed = !asset;
			for (const ticket of entry.tickets) fill(ticket, entry);
		}
		pump();
	}

	function schedule() {
		if (pumping) return;
		pumping = true;
		queueMicrotask(() => {
			pumping = false;
			pump();
		});
	}

	function pump() {
		while (!disposed && active < options.concurrency && waiting.size) {
			let next: Entry | null = null;
			let best = Infinity;
			for (const entry of waiting) {
				const away = distance(entry);
				if (!next || away < best) [next, best] = [entry, away];
			}
			const entry = next as Entry;
			waiting.delete(entry);
			active += 1;
			const loading = options.load(entry.item, entry.controller.signal);
			if (!loading) settle(entry, null);
			else
				loading.then(
					(asset) => settle(entry, asset),
					() => settle(entry, null),
				);
		}
	}

	function drop(entry: Entry) {
		entries.delete(entry.key);
		waiting.delete(entry);
		entry.controller.abort();
		entry.asset?.destroy();
		entry.asset = null;
	}

	return {
		request(key, item, ready) {
			let entry = entries.get(key);
			if (!entry) {
				entry = { key, item, tickets: new Set(), asset: null, failed: false, controller: new AbortController() };
				entries.set(key, entry);
				waiting.add(entry);
			}
			const owner = entry;
			const ticket: Ticket = {
				model: null,
				failed: false,
				at: { x: item.frame.x + item.frame.width / 2, y: item.frame.y + item.frame.height / 2 },
				ready,
				release() {
					if (!owner.tickets.delete(ticket)) return;
					ticket.model?.destroy();
					ticket.model = null;
					if (!owner.tickets.size && entries.get(key) === owner) drop(owner);
				},
			};
			owner.tickets.add(ticket);
			if (owner.asset || owner.failed) fill(ticket, owner);
			else schedule();
			return ticket;
		},
		focus(point) {
			focus = point;
		},
		destroy() {
			disposed = true;
			for (const entry of [...entries.values()]) {
				for (const ticket of entry.tickets) ticket.model?.destroy();
				entry.tickets.clear();
				drop(entry);
			}
		},
	};
}
