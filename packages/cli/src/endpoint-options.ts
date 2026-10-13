import { normalizeBaseUrl } from "@neta-art/cohub";
import { InvalidArgumentError, type Command } from "commander";

export function setApiBaseUrl(value: string): string {
  const url = normalizeBaseUrl(value);
  if (!url) throw new InvalidArgumentError("API base URL must not be empty");
  process.env.COHUB_BASE_URL = url;
  return url;
}

export function registerEndpointOptions(program: Command): Command {
  return program.option("--base-url <url>", "API base URL (overrides COHUB_BASE_URL)", setApiBaseUrl);
}

export function consumeBaseUrlOption(tokens: string[], index: number): number | null {
  const token = tokens[index];
  if (token?.startsWith("--base-url=")) {
    setApiBaseUrl(token.slice("--base-url=".length));
    return index;
  }
  if (token !== "--base-url") return null;
  const value = tokens[index + 1];
  if (value === undefined) throw new InvalidArgumentError("--base-url requires a value");
  setApiBaseUrl(value);
  return index + 1;
}
