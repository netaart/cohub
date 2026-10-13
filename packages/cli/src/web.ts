import { resolveWebBaseUrl } from "@neta-art/cohub";

export function webUrl(path: string): string {
  return `${resolveWebBaseUrl()}${path}`;
}
