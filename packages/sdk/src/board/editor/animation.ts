import {
	BOARD_CAMERA_TARGET,
	type BoardAnimation,
	type BoardAnimationHeader,
	type BoardChapter,
	type BoardKeyframe,
	type BoardMarker,
	type BoardDocument,
	type BoardItem,
	type BoardTimelinePlacement,
	type BoardTrack,
	boardCameraScale,
	boardInsertTime,
	boardPlaceTarget,
	boardRemoveTarget,
	boardRemoveTime,
	boardSequence,
	boardShiftTargets,
	boardSplitTarget,
	boardTargetSpan,
	boardTrimTarget,
	compileBoardAnimations,
	findBoardKeyTrack,
	newBoardTrackId,
	createBoardItemId,
	evaluateBoardAnimations,
	pointToWorld,
	screenPoint,
} from "../model/index.js";
import { remapItems } from "./clipboard.js";
import type { BoardPlayhead, EditorContext } from "./context.js";
import { diffBoardEdits, readPath, sameJson } from "./document-edits.js";

export type BoardKeyRef = { trackId: string; at: number };

export type BoardKeyframeClip = Array<{ target: string; property: string } & BoardKeyframe>;

export type BoardAnimationSettings = Partial<Pick<BoardAnimationHeader, "name" | "duration" | "play" | "delay" | "loop" | "end" | "viewport">>;

export type BoardTrackSettings = Partial<Pick<BoardTrack, "interpolation" | "composite" | "orient">>;

const ms = (value: number) => Math.max(0, Math.round(value));

function lastAt(tracks: Readonly<Record<string, BoardTrack>>): number {
	let end = 0;
	for (const track of Object.values(tracks)) end = Math.max(end, track.keyframes.at(-1)?.at ?? 0);
	return end;
}

function withKeyframe(track: BoardTrack, keyframe: BoardKeyframe): BoardTrack {
	const keyframes = track.keyframes.filter((entry) => entry.at !== keyframe.at);
	keyframes.push(keyframe);
	keyframes.sort((a, b) => a.at - b.at);
	return { ...track, keyframes };
}

function grouped(keys: readonly BoardKeyRef[]): Map<string, Set<number>> {
	const result = new Map<string, Set<number>>();
	for (const { trackId, at } of keys) {
		const times = result.get(trackId) ?? new Set<number>();
		times.add(at);
		result.set(trackId, times);
	}
	return result;
}

export function createAnimationModule(ctx: EditorContext) {
	const { state, options } = ctx;

	function setPlayhead(next: BoardPlayhead | null) {
		if (next && !state.base.animations[next.animationId]) next = null;
		if (sameJson(next, state.playhead)) return;
		state.playhead = next;
		if (!next) state.recording = false;
		ctx.document.discardDraft();
	}

	function setRecording(value: boolean) {
		state.recording = value && state.playhead !== null && !options.readonly;
	}

	function editing() {
		const { playhead, base } = state;
		const animation = playhead && !options.readonly ? base.animations[playhead.animationId] : undefined;
		return playhead && animation ? { id: playhead.animationId, time: ms(playhead.time), animation } : null;
	}

	function commitAnimation(id: string, animation: BoardAnimation, items: Record<string, BoardItem> = {}): boolean {
		if (animation === state.base.animations[id] && Object.keys(items).length === 0) return true;
		const next: BoardDocument = { ...state.base, items: { ...state.base.items, ...items }, animations: { ...state.base.animations, [id]: animation } };
		const patch = diffBoardEdits(state.base, next, Object.keys(items));
		try {
			void ctx.document.commitPatch(patch)?.catch(() => {});
			return true;
		} catch {
			return false;
		}
	}

	function commitTracks(id: string, animation: BoardAnimation, tracks: Record<string, BoardTrack>): boolean {
		return commitAnimation(id, { ...animation, duration: Math.max(animation.duration, lastAt(tracks)), tracks });
	}

	/** The value a replacing keyframe needs to keep the shown state: the property evaluated without the additive tracks on it. */
	function keyValue(found: NonNullable<ReturnType<typeof editing>>, target: string, property: string): unknown {
		if (target === BOARD_CAMERA_TARGET) {
			const shown = ctx.camera.shown();
			const { width, height } = state.surfaceSize;
			if (property === "center") return pointToWorld(screenPoint(width / 2, height / 2), shown);
			if (property !== "zoom") return undefined;
			const scale = boardCameraScale(state.surfaceSize, found.animation.viewport);
			return scale > 0 ? shown.zoom / scale : shown.zoom;
		}
		const overlaps = (other: string) => other === property || other.startsWith(`${property}.`) || property.startsWith(`${other}.`);
		const animations = { ...state.base.animations };
		for (const [id, animation] of Object.entries(animations)) {
			if (!plays(found.id, id)) continue;
			const tracks = Object.fromEntries(Object.entries(animation.tracks).filter(([, track]) => track.target !== target || track.composite !== "add" || !overlaps(track.property)));
			animations[id] = { ...animation, tracks };
		}
		const items = evaluateBoardAnimations(compileBoardAnimations({ ...state.base, animations }), { [found.id]: found.time }).items;
		return readPath(items.get(target) ?? state.base.items[target], property.split("."));
	}

	function plays(from: string, to: string, seen = new Set<string>()): boolean {
		if (from === to) return true;
		if (seen.has(from)) return false;
		seen.add(from);
		return Object.values(state.base.animations[from]?.tracks ?? {}).some((track) => state.base.animations[track.target] !== undefined && plays(track.target, to, seen));
	}

	function keyProperty(target: string, property: string, on = true) {
		const found = editing();
		if (!found) return;
		const { id, time, animation } = found;
		const existing = findBoardKeyTrack(animation.tracks, target, property);
		const tracks = { ...animation.tracks };
		if (!on) {
			if (!existing) return;
			const keyframes = existing[1].keyframes.filter((keyframe) => keyframe.at !== time);
			if (keyframes.length === existing[1].keyframes.length) return;
			if (keyframes.length) tracks[existing[0]] = { ...existing[1], keyframes };
			else delete tracks[existing[0]];
			return commitAnimation(id, { ...animation, tracks });
		}
		const value = keyValue(found, target, property);
		if (value === undefined) return;
		const [trackId, track]: [string, BoardTrack] = existing ?? [
			newBoardTrackId(animation.tracks, target, property),
			{ target, property, keyframes: [], composite: "replace", interpolation: "auto" },
		];
		const ease = track.keyframes.find((keyframe) => keyframe.at === time)?.ease;
		tracks[trackId] = withKeyframe(track, { at: time, value, ...(ease ? { ease } : {}) });
		commitTracks(id, animation, tracks);
	}

	function keyCamera() {
		const found = editing();
		if (!found) return;
		const { id, time, animation } = found;
		const tracks = { ...animation.tracks };
		for (const property of ["center", "zoom"]) {
			const [trackId, track]: [string, BoardTrack] = findBoardKeyTrack(tracks, BOARD_CAMERA_TARGET, property) ?? [
				newBoardTrackId(tracks, BOARD_CAMERA_TARGET, property),
				{ target: BOARD_CAMERA_TARGET, property, keyframes: [], composite: "replace", interpolation: "auto" },
			];
			tracks[trackId] = withKeyframe(track, { at: time, value: keyValue(found, BOARD_CAMERA_TARGET, property) });
		}
		commitTracks(id, animation, tracks);
	}

	function moveKeyframes(keys: readonly BoardKeyRef[], delta: number): BoardKeyRef[] {
		const found = editing();
		if (!found || keys.length === 0) return [...keys];
		const { id, animation } = found;
		const earliest = Math.min(...keys.map((key) => key.at));
		const shift = Math.round(Math.max(delta, -earliest));
		if (shift === 0) return [...keys];
		const tracks = { ...animation.tracks };
		const moved: BoardKeyRef[] = [];
		for (const [trackId, times] of grouped(keys)) {
			const track = tracks[trackId];
			if (!track) continue;
			const shifted = track.keyframes.filter((keyframe) => times.has(keyframe.at)).map((keyframe) => ({ ...keyframe, at: keyframe.at + shift }));
			const landed = new Set(shifted.map((keyframe) => keyframe.at));
			const kept = track.keyframes.filter((keyframe) => !times.has(keyframe.at) && !landed.has(keyframe.at));
			tracks[trackId] = { ...track, keyframes: [...kept, ...shifted].sort((a, b) => a.at - b.at) };
			for (const at of landed) moved.push({ trackId, at });
		}
		return commitTracks(id, animation, tracks) ? moved : [...keys];
	}

	function removeKeyframes(keys: readonly BoardKeyRef[]) {
		const found = editing();
		if (!found || keys.length === 0) return;
		const { id, animation } = found;
		const tracks = { ...animation.tracks };
		for (const [trackId, times] of grouped(keys)) {
			const track = tracks[trackId];
			if (!track) continue;
			const keyframes = track.keyframes.filter((keyframe) => !times.has(keyframe.at));
			if (keyframes.length) tracks[trackId] = { ...track, keyframes };
			else delete tracks[trackId];
		}
		commitAnimation(id, { ...animation, tracks });
	}

	function setKeyframe(key: BoardKeyRef, patch: { at?: number; value?: unknown; ease?: string | null }): BoardKeyRef | null {
		const found = editing();
		const track = found?.animation.tracks[key.trackId];
		const current = track?.keyframes.find((keyframe) => keyframe.at === key.at);
		if (!found || !track || !current) return null;
		const at = patch.at === undefined ? current.at : ms(patch.at);
		const { ease: _ease, ...rest } = current;
		const ease = patch.ease === undefined ? current.ease : patch.ease;
		const next: BoardKeyframe = { ...rest, at, ...(patch.value !== undefined ? { value: patch.value } : {}), ...(ease && ease !== "linear" ? { ease } : {}) };
		const keyframes = track.keyframes.filter((keyframe) => keyframe !== current);
		const edited = at === key.at
			? { ...track, keyframes: track.keyframes.map((keyframe) => (keyframe === current ? next : keyframe)) }
			: withKeyframe({ ...track, keyframes }, next);
		return commitTracks(found.id, found.animation, { ...found.animation.tracks, [key.trackId]: edited }) ? { trackId: key.trackId, at } : null;
	}

	function setTrack(trackId: string, patch: BoardTrackSettings) {
		const found = editing();
		const track = found?.animation.tracks[trackId];
		if (!found || !track) return;
		const next: BoardTrack = { ...track, ...patch };
		if (!next.orient) delete next.orient;
		if (!sameJson(next, track)) commitAnimation(found.id, { ...found.animation, tracks: { ...found.animation.tracks, [trackId]: next } });
	}

	function copyKeyframes(keys: readonly BoardKeyRef[], animationId = state.playhead?.animationId): BoardKeyframeClip {
		const tracks = (animationId ? state.base.animations[animationId]?.tracks : undefined) ?? {};
		const clip: BoardKeyframeClip = [];
		for (const [trackId, times] of grouped(keys)) {
			const track = tracks[trackId];
			for (const keyframe of track?.keyframes ?? []) {
				if (track && times.has(keyframe.at)) clip.push({ target: track.target, property: track.property, ...structuredClone(keyframe) });
			}
		}
		const start = Math.min(...clip.map((entry) => entry.at));
		return clip.map((entry) => ({ ...entry, at: entry.at - start }));
	}

	function pasteKeyframes(clip: BoardKeyframeClip): BoardKeyRef[] {
		const found = editing();
		if (!found) return [];
		const { id, time, animation } = found;
		const tracks = { ...animation.tracks };
		const pasted: BoardKeyRef[] = [];
		for (const { target, property, ...keyframe } of clip) {
			const nested = state.base.animations[target] !== undefined;
			if (nested ? plays(target, id) : target !== BOARD_CAMERA_TARGET && !state.base.items[target] && !state.base.board.scripts?.[target]) continue;
			const [trackId, track]: [string, BoardTrack] = findBoardKeyTrack(tracks, target, property) ?? [
				newBoardTrackId(tracks, target, property),
				{ target, property, keyframes: [], composite: "replace", interpolation: "auto" },
			];
			const at = ms(time + keyframe.at);
			tracks[trackId] = withKeyframe(track, { ...keyframe, at });
			pasted.push({ trackId, at });
		}
		return pasted.length && commitTracks(id, animation, tracks) ? pasted : [];
	}

	function setMarkers(markers: readonly BoardMarker[]) {
		const found = editing();
		if (!found) return;
		const next = markers.map((marker) => ({ ...marker, at: ms(marker.at) })).sort((a, b) => a.at - b.at);
		if (!sameJson(next, found.animation.markers)) commitAnimation(found.id, { ...found.animation, markers: next });
	}

	function updateAnimation(id: string, settings: BoardAnimationSettings): boolean {
		const animation = options.readonly ? undefined : state.base.animations[id];
		if (!animation) return false;
		const next = { ...animation, ...settings };
		if (settings.duration !== undefined) next.duration = Math.max(1, Math.round(settings.duration));
		if (settings.delay !== undefined) next.delay = ms(settings.delay);
		if (!next.name) delete next.name;
		if (!next.viewport) delete next.viewport;
		return sameJson(next, animation) || commitAnimation(id, next);
	}

	function deleteAnimation(id: string) {
		if (options.readonly || !state.base.animations[id]) return;
		if (state.playhead?.animationId === id) setPlayhead(null);
		const animations: Record<string, BoardAnimation> = {};
		for (const [otherId, animation] of Object.entries(state.base.animations)) {
			if (otherId === id) continue;
			const nested = Object.entries(animation.tracks).filter(([, track]) => track.target === id);
			if (!nested.length) {
				animations[otherId] = animation;
				continue;
			}
			const tracks = { ...animation.tracks };
			for (const [trackId] of nested) delete tracks[trackId];
			animations[otherId] = { ...animation, tracks };
		}
		ctx.document.commit({ animations });
	}

	function createAnimation(name: string, duration = 5000): string {
		const id = createBoardItemId();
		commitAnimation(id, { name, duration, play: "manual", delay: 0, loop: false, end: "hold", markers: [], tracks: {} });
		setPlayhead({ animationId: id, time: 0 });
		return id;
	}

	function createSequence(name: string, chapters: BoardChapter[]): string | null {
		if (options.readonly) return null;
		const id = createBoardItemId();
		const animation = boardSequence(state.base, chapters);
		commitAnimation(id, { ...animation, name });
		setPlayhead({ animationId: id, time: 0 });
		return id;
	}

	function placeOnTimeline(targets: readonly string[], at: number, options: { together?: boolean } & Omit<BoardTimelinePlacement, "at"> = {}): boolean {
		const found = editing();
		if (!found) return false;
		let animation = found.animation;
		let cursor = Math.max(0, at);
		for (const target of targets) {
			if (target === found.id || (state.base.animations[target] ? plays(target, found.id) : !state.base.items[target])) continue;
			animation = boardPlaceTarget(state.base, animation, target, { ...options, at: cursor });
			const span = boardTargetSpan(state.base, animation, target);
			if (!options.together && span) cursor = span.end;
		}
		return commitAnimation(found.id, animation);
	}

	function shiftOnTimeline(targets: readonly string[], delta: number) {
		const found = editing();
		if (found) commitAnimation(found.id, boardShiftTargets(state.base, found.animation, targets, delta));
	}

	function trimOnTimeline(target: string, edge: "start" | "end", at: number) {
		const found = editing();
		if (found) commitAnimation(found.id, boardTrimTarget(state.base, found.animation, target, edge, at));
	}

	function removeFromTimeline(targets: readonly string[]) {
		const found = editing();
		if (!found) return;
		let animation = found.animation;
		for (const target of targets) animation = boardRemoveTarget(animation, target);
		commitAnimation(found.id, animation);
	}

	function splitAtPlayhead(targets: readonly string[]): string[] {
		const found = editing();
		if (!found) return [];
		let animation = found.animation;
		const items: Record<string, BoardItem> = {};
		const roots: string[] = [];
		for (const target of ctx.query.rootsOf(targets)) {
			if (!state.base.items[target]) continue;
			const subtree = [...ctx.query.withSubtrees([target])];
			const source = Object.fromEntries(subtree.flatMap((id) => (state.base.items[id] ? [[id, state.base.items[id] as BoardItem]] : [])));
			const idMap = new Map(subtree.map((id) => [id, createBoardItemId()]));
			const split = boardSplitTarget(state.base, animation, target, idMap, found.time);
			if (!split) continue;
			animation = split;
			Object.assign(items, remapItems(source, idMap));
			const copy = idMap.get(target) as string;
			const { parent } = state.base.items[target] as BoardItem;
			if (parent) items[copy] = { ...(items[copy] as BoardItem), parent };
			roots.push(copy);
		}
		return roots.length && commitAnimation(found.id, animation, items) ? roots : [];
	}

	function insertTime(at: number, length: number) {
		const found = editing();
		if (found) commitAnimation(found.id, boardInsertTime(state.base, found.animation, at, length));
	}

	function removeTime(from: number, to: number) {
		const found = editing();
		if (found) commitAnimation(found.id, boardRemoveTime(state.base, found.animation, from, to));
	}

	return {
		placeOnTimeline,
		shiftOnTimeline,
		trimOnTimeline,
		removeFromTimeline,
		splitAtPlayhead,
		insertTime,
		removeTime,
		setPlayhead,
		setRecording,
		keyProperty,
		keyCamera,
		moveKeyframes,
		removeKeyframes,
		setKeyframe,
		setTrack,
		copyKeyframes,
		pasteKeyframes,
		setMarkers,
		updateAnimation,
		deleteAnimation,
		createAnimation,
		createSequence,
	};
}

export type AnimationModule = ReturnType<typeof createAnimationModule>;
