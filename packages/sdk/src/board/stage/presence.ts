import type { BoardReaction } from "@cohub/protocol/realtime";
import type { Graphics } from "pixi.js";
import {
	type BoardColorId,
	type BoardParticleShape,
	type BoardShapeColors,
	pickBoardColor,
	worldPoint,
} from "../model/index.js";
import type { BoardScriptPeer, BoardScriptPeerInfo } from "../model/script.js";
import { boardPeerColor, type BoardPresenceBroadcast, type BoardPresencePeer } from "../presence/index.js";
import type { BoardBurst } from "./bursts.js";

type Look = { colors: BoardShapeColors; colorScheme: "dark" | "light" };

const REACTIONS: Record<BoardReaction, { shape: BoardParticleShape; colors: readonly BoardColorId[] }> = {
	heart: { shape: "heart", colors: ["rose"] },
	star: { shape: "star", colors: ["amber"] },
	spark: { shape: "spark", colors: ["amber", "rose", "blue"] },
	confetti: { shape: "square", colors: ["rose", "amber", "blue", "green", "violet"] },
};

export function boardReactionBurst(reaction: BoardReaction, at: { x: number; y: number }, look: Look): BoardBurst {
	const { shape, colors } = REACTIONS[reaction];
	return {
		at: worldPoint(at.x, at.y),
		shape,
		colors: colors.map((id) => pickBoardColor(look.colors, id, look.colorScheme).fill),
	};
}

export function defaultBoardPeerColor(actorId: string, look: Look): number {
	return pickBoardColor(look.colors, boardPeerColor(actorId), look.colorScheme).stroke;
}

const cssColor = (color: number) => `#${color.toString(16).padStart(6, "0")}`;

export function boardScriptPeerInfo(peer: BoardPresenceBroadcast["peer"], color: (actorId: string) => number): BoardScriptPeerInfo {
	return { id: peer.connectionId, actorId: peer.actorId, name: peer.actorName, color: cssColor(color(peer.actorId)) };
}

export function boardScriptPeers(peers: readonly BoardPresencePeer[], color: (actorId: string) => number): BoardScriptPeer[] {
	return peers.map((peer) => {
		const cursor = peer.state?.cursor ?? null;
		return {
			...boardScriptPeerInfo(peer, color),
			point: cursor && { x: cursor.x, y: cursor.y },
			pointerType: cursor?.pointerType ?? null,
			pressed: cursor?.pressed === true,
		};
	});
}

export function drawBoardPresence(
	overlay: Graphics,
	peers: readonly BoardPresencePeer[],
	frame: { zoom: number; look: Look; color: (actorId: string) => number },
) {
	const { colors, colorScheme } = frame.look;
	const inv = 1 / Math.max(frame.zoom, 0.0001);
	for (const peer of peers) {
		const own = frame.color(peer.actorId);
		const selection = peer.state?.selection;
		if (selection?.bounds && selection.count > 0) {
			const { x, y, width, height } = selection.bounds;
			const editing = peer.state?.editingId != null;
			overlay.rect(x, y, width, height).stroke({ color: own, width: (editing ? 2 : 1.25) * inv, alpha: editing ? 0.94 : 0.82 });
			if (editing) overlay.circle(x, y, 3.5 * inv).fill({ color: own, alpha: 0.96 });
		}
		const gesture = peer.gesture;
		if (!gesture || gesture.kind === "draw") continue;
		if (gesture.kind === "transform") {
			if (!gesture.bounds) continue;
			const { x, y, width, height } = gesture.bounds;
			overlay.rect(x, y, width, height).stroke({ color: own, width: 1.5 * inv, alpha: 0.88 });
			continue;
		}
		const color = pickBoardColor(colors, gesture.color, colorScheme);
		const { start, current } = gesture;
		if (gesture.kind === "box") {
			const x = Math.min(start.x, current.x);
			const y = Math.min(start.y, current.y);
			overlay
				.roundRect(x, y, Math.max(1, Math.abs(current.x - start.x)), Math.max(1, Math.abs(current.y - start.y)), 4)
				.fill({ color: color.fill, alpha: 0.05 })
				.stroke({ color: color.stroke, width: 1.5 * inv, alpha: 0.82 });
			continue;
		}
		const angle = Math.atan2(current.y - start.y, current.x - start.x);
		const head = Math.max(14, 16 * inv);
		const spread = Math.PI / 6;
		const width = Math.max(gesture.size, 1.5 * inv);
		overlay.moveTo(start.x, start.y).lineTo(current.x, current.y).stroke({ color: color.stroke, width, alpha: 0.88 });
		overlay
			.moveTo(current.x - head * Math.cos(angle - spread), current.y - head * Math.sin(angle - spread))
			.lineTo(current.x, current.y)
			.lineTo(current.x - head * Math.cos(angle + spread), current.y - head * Math.sin(angle + spread))
			.stroke({ color: color.stroke, width, alpha: 0.92, cap: "round", join: "round" });
	}
}
