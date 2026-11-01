import type { BoardReaction } from "@cohub/protocol/realtime";
import { type BoardColorId, type BoardParticleShape, pickBoardColor, worldPoint } from "@neta-art/cohub/board";
import type { BoardBurst } from "@neta-art/cohub/board/stage";
import type { BoardThemeSnapshot } from "$lib/board/board-theme";

const LOOKS: Record<BoardReaction, { shape: BoardParticleShape; colors: readonly BoardColorId[] }> = {
	heart: { shape: "heart", colors: ["rose"] },
	star: { shape: "star", colors: ["amber"] },
	spark: { shape: "spark", colors: ["amber", "rose", "blue"] },
	confetti: { shape: "square", colors: ["rose", "amber", "blue", "green", "violet"] },
};

export function reactionBurst(reaction: BoardReaction, at: { x: number; y: number }, theme: BoardThemeSnapshot): BoardBurst {
	const look = LOOKS[reaction];
	return {
		at: worldPoint(at.x, at.y),
		shape: look.shape,
		colors: look.colors.map((token) => pickBoardColor(theme.colors, token, theme.colorScheme).fill),
	};
}
