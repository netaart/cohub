import { PUBLIC_LANDING_MEDIA_BASE } from "$app/env/public";

/**
 * Where marketing captures live.
 *
 * These are product screenshots that get re-shot whenever the UI moves, so
 * they are hosted outside the repo rather than committed as binaries. Set
 * `PUBLIC_LANDING_MEDIA_BASE` to point the landing page at a different bucket
 * (a staging set, or a self-hosted mirror for a fork).
 */
const DEFAULT_BASE =
	"https://public.cohub.run/s/cf327f11-5065-4f3a-bfe5-cdb0a70f3377/cohub-landing";

/** No trailing slash, so callers can always join with a single "/". */
const BASE = (PUBLIC_LANDING_MEDIA_BASE ?? DEFAULT_BASE).replace(/\/+$/, "");

export type LandingMediaExt = "webp" | "webm" | "mp4";

/**
 * Content hashes for assets that have been re-shot.
 *
 * The CDN in front of this bucket serves with a 30-day edge lifetime and
 * ignores query strings, so overwriting a file in place keeps serving the old
 * bytes. Replacing an asset means uploading it under a new name and recording
 * the hash here; entries are optional, so an asset that has never been
 * replaced stays on its bare filename.
 */
const VERSIONS: Record<string, string> = {
	hero: "4bcbcab1",
	context: "11313556",
};

/** Resolve an asset basename, e.g. ("hero", "webp") → `<base>/hero.webp`. */
export function landingMediaUrl(name: string, ext: LandingMediaExt): string {
	const version = VERSIONS[name];
	return `${BASE}/${name}${version ? `.${version}` : ""}.${ext}`;
}
