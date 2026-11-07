import { COHUB_APP_ORIGINS } from "@neta-art/cohub";

/** Studio serves the dev App under `/dev/` and the prod App at the root. */
export const STUDIO_ORIGINS = {
  dev: "https://dev-studio.neta.art",
  prod: "https://neta.art",
} as const;

export type AppEnvironment = keyof typeof STUDIO_ORIGINS;

/**
 * `allowHostOrigins` replaces the SDK's default trusted list, so it has to name
 * Cohub's own origins and the Studio that serves this environment.
 */
export const hostOriginsFor = (env: AppEnvironment): string[] => [
  ...COHUB_APP_ORIGINS,
  STUDIO_ORIGINS[env],
];

/** The nearest ancestor's origin, or the referrer's origin; null when neither can be read. */
export function embedderOrigin(input: {
  readonly ancestorOrigins?: { readonly [index: number]: string | undefined } | null;
  readonly referrer?: string | null;
}): string | null {
  const ancestor = input.ancestorOrigins?.[0];
  if (typeof ancestor === "string" && ancestor !== "") return ancestor;
  const referrer = input.referrer ?? "";
  if (referrer === "") return null;
  try {
    return new URL(referrer).origin;
  } catch {
    return null;
  }
}

/** Only Cohub's own origins embed the App with a composer; Studio and anything unreadable do not. */
export function hasComposer(origin: string | null | undefined): boolean {
  return typeof origin === "string" && COHUB_APP_ORIGINS.includes(origin);
}

/** Whether the page's embedder has a composer: the nearest ancestor, else the referrer's origin. */
export function hostHasComposer(
  location: { readonly ancestorOrigins?: { readonly [index: number]: string | undefined } | null },
  document: { readonly referrer?: string | null },
): boolean {
  return hasComposer(
    embedderOrigin({
      ancestorOrigins: location.ancestorOrigins,
      referrer: document.referrer,
    }),
  );
}
