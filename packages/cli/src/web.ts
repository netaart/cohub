import { resolveCohubEnvironment } from "@neta-art/cohub";

export function webUrl(path: string): string {
  const origin =
    process.env.COHUB_WEB_URL?.replace(/\/+$/, "") ??
    `https://${resolveCohubEnvironment() === "prod" ? "" : "dev."}cohub.live`;
  return `${origin}${path}`;
}
