import { pickBoardColor } from "@neta-art/cohub/board";
import type { Graphics } from "pixi.js";
import type { RemoteBoardAwarenessPeer } from "$lib/board/board-awareness";
import {
	type BoardThemeSnapshot,
	boardIdentityColor,
} from "$lib/board/board-theme";

export function drawAwarenessOverlay(
	overlay: Graphics,
	peers: readonly RemoteBoardAwarenessPeer[],
	theme: BoardThemeSnapshot,
	zoom: number,
) {
	const { colors, colorScheme: mode } = theme;
	const inv = 1 / Math.max(zoom, 0.0001);
	for (const peer of peers) {
		const collaboration = boardIdentityColor(theme, peer.actorId);
		const selection = peer.state?.selection;
		if (selection?.bounds && selection.count > 0) {
			const bounds = selection.bounds;
			const editing = peer.state?.editingId != null;
			overlay.rect(bounds.x, bounds.y, bounds.width, bounds.height).stroke({
				color: collaboration,
				width: (editing ? 2 : 1.25) * inv,
				alpha: editing ? 0.94 : 0.82,
			});
			if (editing)
				overlay
					.circle(bounds.x, bounds.y, 3.5 * inv)
					.fill({ color: collaboration, alpha: 0.96 });
		}

		const gesture = peer.gesture;
		if (!gesture || gesture.kind === "draw") continue;
		if (gesture.kind === "arrow") {
			const color = pickBoardColor(colors, gesture.color, mode);
			const angle = Math.atan2(
				gesture.current.y - gesture.start.y,
				gesture.current.x - gesture.start.x,
			);
			const head = Math.max(14, 16 * inv);
			const spread = Math.PI / 6;
			const width = Math.max(gesture.size, 1.5 * inv);
			overlay
				.moveTo(gesture.start.x, gesture.start.y)
				.lineTo(gesture.current.x, gesture.current.y)
				.stroke({ color: color.stroke, width, alpha: 0.88 });
			overlay
				.moveTo(
					gesture.current.x - head * Math.cos(angle - spread),
					gesture.current.y - head * Math.sin(angle - spread),
				)
				.lineTo(gesture.current.x, gesture.current.y)
				.lineTo(
					gesture.current.x - head * Math.cos(angle + spread),
					gesture.current.y - head * Math.sin(angle + spread),
				)
				.stroke({
					color: color.stroke,
					width,
					alpha: 0.92,
					cap: "round",
					join: "round",
				});
			continue;
		}
		if (gesture.kind === "box") {
			const color = pickBoardColor(colors, gesture.color, mode);
			const x = Math.min(gesture.start.x, gesture.current.x);
			const y = Math.min(gesture.start.y, gesture.current.y);
			const width = Math.max(1, Math.abs(gesture.current.x - gesture.start.x));
			const height = Math.max(1, Math.abs(gesture.current.y - gesture.start.y));
			overlay
				.roundRect(x, y, width, height, 4)
				.fill({ color: color.fill, alpha: 0.05 })
				.stroke({ color: color.stroke, width: 1.5 * inv, alpha: 0.82 });
			continue;
		}
		if (gesture.kind === "transform" && gesture.bounds) {
			const { x, y, width, height } = gesture.bounds;
			overlay
				.rect(x, y, width, height)
				.stroke({ color: collaboration, width: 1.5 * inv, alpha: 0.88 });
		}
	}
}
