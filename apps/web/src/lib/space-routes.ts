import { spaceAddressOf, spaceAddressPath } from "$lib/stores/space-address";

/** `/:username/:slug` once the Space's address is confirmed, else `/spaces/:id`. */
export const buildSpaceRootRoute = (spaceId: string) => {
	const address = spaceAddressOf(spaceId);
	return address ? spaceAddressPath(address) : `/spaces/${spaceId}`;
};

export const buildSessionsRoute = () => "/sessions";

export const buildUserSessionRoute = (sessionId: string) =>
	`/sessions/${sessionId}`;

/** Cross-space new chat draft on the sessions inbox (not space workspace). */
export const buildUserNewSessionRoute = (spaceId: string) => {
	const params = new URLSearchParams({ space: spaceId });
	return `${buildSessionsRoute()}/new?${params.toString()}`;
};

export type UserSessionRoute =
	| { kind: "session"; sessionId: string }
	| { kind: "new"; spaceId: string | null };

export function parseUserSessionRoute(url: URL): UserSessionRoute | null {
	const match = url.pathname.match(/^\/sessions\/([^/]+)\/?$/);
	if (!match?.[1]) return null;
	if (match[1] === "new") {
		return {
			kind: "new",
			spaceId: url.searchParams.get("space")?.trim() || null,
		};
	}
	return { kind: "session", sessionId: match[1] };
}

export const buildUserSessionTurnRoute = (
	sessionId: string,
	sequence: number,
) => {
	const params = new URLSearchParams({ turn: String(sequence) });
	return `${buildUserSessionRoute(sessionId)}?${params.toString()}`;
};

export const buildSpaceSessionRoute = (spaceId: string, sessionId: string) =>
	`${buildSpaceRootRoute(spaceId)}/sessions/${sessionId}`;

/** The Space root is the canonical new-session draft. */
export const buildSpaceNewSessionRoute = buildSpaceRootRoute;
export const buildSpaceLandingRoute = buildSpaceRootRoute;

export const buildSpaceSettingsRoute = (spaceId: string) =>
	`${buildSpaceRootRoute(spaceId)}/settings`;

export const buildSpaceWalletRoute = (spaceId: string) =>
	`${buildSpaceRootRoute(spaceId)}/wallet`;

export const buildSpaceActivityRoute = (spaceId: string) =>
	`${buildSpaceRootRoute(spaceId)}/activity`;

export const buildSpaceSessionTurnRoute = (
	spaceId: string,
	sessionId: string,
	sequence: number,
) => {
	const params = new URLSearchParams({ turn: String(sequence) });
	return `${buildSpaceSessionRoute(spaceId, sessionId)}?${params.toString()}`;
};

export const buildSpaceCheckpointRoute = (
	spaceId: string,
	checkpointId: string,
) => `${buildSpaceRootRoute(spaceId)}/checkpoints/${checkpointId}`;

export const buildSpaceCheckpointNewRoute = (spaceId: string) =>
	`${buildSpaceRootRoute(spaceId)}/checkpoints/new`;

/** Legacy deep-link helper. /files/* redirects to Main + ?preview=file:... */
export const buildSpaceFileRoute = (spaceId: string, path: string) =>
	`${buildSpaceRootRoute(spaceId)}/files/${path
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/")}`;

export const buildSpaceCronjobRoute = (spaceId: string, cronjobId: string) =>
	`${buildSpaceRootRoute(spaceId)}/cronjobs/${cronjobId}`;

export const buildSpaceCronjobNewRoute = (spaceId: string) =>
	`${buildSpaceRootRoute(spaceId)}/cronjobs/new`;

export const buildSpaceAppRoute = (spaceId: string, appId: string) =>
	`${buildSpaceRootRoute(spaceId)}/apps/${appId}`;

export const buildSpaceTaskRoute = (spaceId: string, taskId: string) =>
	`${buildSpaceRootRoute(spaceId)}/tasks/${taskId}`;
