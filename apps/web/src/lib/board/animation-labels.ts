import type { BoardTrackGroup } from "$lib/board/animation-timeline";
import { m } from "$lib/paraglide/messages.js";

type Locale = Parameters<typeof m.board_prop_position>[1];

const LABELS: Record<string, (locale: Locale) => string> = {
	position: (locale) => m.board_prop_position({}, locale),
	rotation: (locale) => m.board_prop_rotation({}, locale),
	scale: (locale) => m.board_prop_scale({}, locale),
	opacity: (locale) => m.board_prop_opacity({}, locale),
	origin: (locale) => m.board_prop_origin({}, locale),
	"size.width": (locale) => m.board_prop_width({}, locale),
	"size.height": (locale) => m.board_prop_height({}, locale),
	"style.fill": (locale) => m.board_prop_fill({}, locale),
	"style.stroke": (locale) => m.board_prop_stroke({}, locale),
	"style.trim": (locale) => m.board_prop_trim({}, locale),
	"props.reveal": (locale) => m.board_prop_reveal({}, locale),
	center: (locale) => m.board_prop_center({}, locale),
	zoom: (locale) => m.board_camera_zoom({}, locale),
	focus: (locale) => m.board_camera_focus({}, locale),
	shake: (locale) => m.board_camera_shake({}, locale),
	time: (locale) => m.board_prop_time({}, locale),
	"props.time": (locale) => m.board_prop_time({}, locale),
	"props.volume": (locale) => m.board_prop_volume({}, locale),
	"depth.lift": (locale) => m.board_prop_depth_lift({}, locale),
	"depth.tilt": (locale) => m.board_prop_depth_tilt({}, locale),
	"depth.spin": (locale) => m.board_prop_depth_spin({}, locale),
	"depth.bend.amount": (locale) => m.board_prop_depth_bend({}, locale),
	"depth.bend.phase": (locale) => m.board_prop_depth_bend_phase({}, locale),
	"depth.bend.kind": (locale) => m.board_prop_depth_bend_kind({}, locale),
};

export function boardPropertyLabel(property: string, locale: Locale): string {
	return LABELS[property]?.(locale) ?? property;
}

export function boardGroupLabel(
	group: BoardTrackGroup,
	locale: Locale,
): string {
	return group.kind === "camera"
		? m.board_track_camera({}, locale)
		: group.label;
}
