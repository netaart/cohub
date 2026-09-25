import {
  buildAppComposerChipClear,
  buildAppComposerChipSet,
  buildAppSurfaceReady,
  buildAppSurfaceResponse,
  parseAppComposerChipClear,
  parseAppComposerChipSet,
  parseAppSurfaceRequest,
  type AppComposerChip,
} from "@cohub/protocol/app-surface";
import { parseAppRuntimeAnnounce } from "@cohub/protocol/app-runtime";
export type AppSurfaceHandlerContext = {
  /** The UI command this handler must complete. */
  commandId: string;
};

export type AppSurfaceHandler = (
  input: unknown,
  context: AppSurfaceHandlerContext,
) => unknown | Promise<unknown>;

/**
 * Explicit app origins, not a Cohub suffix match: apps themselves are
 * served from Cohub subdomains, so a suffix match would let one app call into
 * another and turn a subdomain takeover into surface access.
 */
export const COHUB_APP_ORIGINS: readonly string[] = [
  "https://cohub.live",
  "https://www.cohub.live",
  "https://dev.cohub.live",
  "https://cohub.run",
  "https://www.cohub.run",
  "https://dev.cohub.run",
];

export const isCohubHostOrigin = (origin: string): boolean =>
  COHUB_APP_ORIGINS.includes(origin);

const resolveEmbedderOrigin = (): string | null => {
  if (typeof window === "undefined" || window.parent === window) return null;
  const ancestor = window.location?.ancestorOrigins?.[0];
  if (typeof ancestor === "string" && ancestor) return ancestor;
  try {
    const referrer = typeof document === "undefined" ? "" : document.referrer;
    return referrer ? new URL(referrer).origin : null;
  } catch {
    return null;
  }
};

export class AppSurfaceApi {
  private readonly handlers = new Map<string, AppSurfaceHandler>();
  private listening = false;
  private allowedOrigins: string[] | null = null;
  private trustedOrigin: string | null | undefined;
  /** The chip on show, so it can be announced again. */
  private chip: AppComposerChip | null = null;

  allowHostOrigins(origins: string[]): void {
    this.allowedOrigins = origins
      .map((origin) => origin.trim())
      .filter(Boolean)
      .map((origin) => {
        try {
          return new URL(origin).origin;
        } catch {
          return "";
        }
      })
      .filter(Boolean);
    this.trustedOrigin = undefined;
    this.announce();
  }

  handle(method: string, handler: AppSurfaceHandler): () => void {
    const name = method.trim();
    if (!name) throw new Error("App surface method name is required");
    this.handlers.set(name, handler);
    this.start();
    this.announce();
    return () => {
      if (this.handlers.get(name) === handler) {
        this.handlers.delete(name);
        this.announce();
      }
    };
  }

  get methods(): string[] {
    return [...this.handlers.keys()];
  }

  setComposerChip(chip: AppComposerChip): void {
    const message = parseAppComposerChipSet(buildAppComposerChipSet(chip));
    if (!message) throw new Error("Invalid App composer chip");
    this.chip = message.chip;
    this.start();
    this.post(message);
  }

  clearComposerChip(key: string): void {
    const message = parseAppComposerChipClear(buildAppComposerChipClear(key));
    if (!message) throw new Error("Invalid App composer chip key");
    if (this.chip?.key === message.key) this.chip = null;
    this.post(message);
  }

  announce(): void {
    this.post(buildAppSurfaceReady(this.methods));
  }

  private isTrusted(origin: string): boolean {
    if (!origin || origin === "null") return false;
    // Same-origin grants nothing new: such a parent can already script us.
    if (typeof window !== "undefined" && origin === window.location?.origin) return true;
    return this.allowedOrigins
      ? this.allowedOrigins.includes(origin)
      : isCohubHostOrigin(origin);
  }

  private resolveTrustedOrigin(): string | null {
    if (this.trustedOrigin !== undefined) return this.trustedOrigin;
    const embedder = resolveEmbedderOrigin();
    this.trustedOrigin = embedder && this.isTrusted(embedder) ? embedder : null;
    return this.trustedOrigin;
  }

  private start(): void {
    if (this.listening || typeof window === "undefined") return;
    this.listening = true;
    window.addEventListener("message", this.onMessage);
  }

  private readonly onMessage = (event: MessageEvent) => {
    if (typeof window === "undefined" || event.source !== window.parent) return;
    if (!this.isTrusted(event.origin)) return;
    // A reloaded frame forgot what this document announced; say it again.
    if (parseAppRuntimeAnnounce(event.data)) {
      if (this.handlers.size > 0) this.announce();
      if (this.chip) this.post(buildAppComposerChipSet(this.chip));
      return;
    }
    const request = parseAppSurfaceRequest(event.data);
    if (!request) return;
    const commandId = request.commandId;
    if (!commandId) return;
    this.trustedOrigin = event.origin;
    void this.dispatch(
      request.requestId,
      request.method,
      request.input,
      commandId,
    );
  };

  private async dispatch(
    requestId: string,
    method: string,
    input: unknown,
    commandId: string,
  ): Promise<void> {
    const handler = this.handlers.get(method);
    if (!handler) {
      this.post(
        buildAppSurfaceResponse({
          requestId,
          ok: false,
          error: {
            code: "method_not_found",
            message: `This app does not expose "${method}".`,
          },
        }),
      );
      return;
    }
    try {
      await handler(input, { commandId });
      this.post(buildAppSurfaceResponse({ requestId, ok: true }));
    } catch (error) {
      this.post(
        buildAppSurfaceResponse({
          requestId,
          ok: false,
          error: {
            code: "handler_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
    }
  }

  private post(message: Record<string, unknown>): void {
    if (typeof window === "undefined" || window.parent === window) return;
    // Never `*`: the method list and results go to the trusted host only.
    const origin = this.resolveTrustedOrigin();
    if (!origin) return;
    try {
      window.parent.postMessage(message, origin);
    } catch {
    }
  }
}

/** @deprecated Use `AppSurfaceApi`. */
export class WorkSurfaceApi extends AppSurfaceApi {}
