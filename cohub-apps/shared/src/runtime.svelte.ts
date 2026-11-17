import type { AppRuntimeContext } from "@neta-art/cohub";
import type { Locale } from "$kit/core.ts";

class Runtime {
  context = $state<AppRuntimeContext | null>(null);
  locale = $state<Locale>("en");
  shown = $state(true);
  foreground = $state(
    typeof document === "undefined" || document.visibilityState === "visible",
  );

  get viewer() {
    return this.context?.viewer?.userUuid ?? null;
  }

  get active() {
    return this.shown && this.foreground;
  }
}

export const runtime = new Runtime();

export function getLocale(): Locale {
  return runtime.locale;
}
