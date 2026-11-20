import { createCohubClient } from "@neta-art/cohub";
import "./app/styles.css";
import { createApp } from "./app/app.ts";
import { frameCopy, languageFor } from "./app/copy.ts";
import { stateCopy } from "./app/policy.ts";
import { createFrameView, type FrameView } from "./app/view.ts";
import { hostHasComposer, hostOriginsFor } from "./host/origins.ts";
import { createSdkHost } from "./host/sdk-host.ts";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("The App page has no #app element.");

// Dev serves `<origin>/dev/w/…`; prod serves `<origin>/w/…`; the path prefix picks the environment, so one
// build serves both.
const isDev = location.pathname.startsWith("/dev/");
const client = createCohubClient({ env: isDev ? "dev" : "prod" });
// Studio embeds the App too. Allow its origin before anything posts on the surface.
client.app.surface.allowHostOrigins(hostOriginsFor(isDev ? "dev" : "prod"));

// Studio has no composer bridge. Only a Cohub App host can carry a chip; its origin is the
// nearest ancestor, with the referrer as the fallback for browsers without ancestorOrigins.
const composer = hostHasComposer(location, document);

const language = () => languageFor(document.documentElement.lang || navigator.language);
document.documentElement.lang = language();
// Host tokens, color scheme and lang as early as the SDK can set them, before the context resolves.
client.app.appearance.sync(document.documentElement);

let standalone: FrameView | null = null;

function clearBoot(): void {
  document.querySelector("#boot")?.remove();
}

function showStandalone(state: "no-host" | "failed", retry?: () => void): void {
  clearBoot();
  standalone?.destroy();
  (root as HTMLElement).replaceChildren();
  const view = createFrameView(root as HTMLElement, language());
  standalone = view;
  view.setFile(null, null, false);
  if (state === "no-host") {
    view.showState(stateCopy("no-host", null, language()));
    return;
  }
  const copy = frameCopy(language());
  view.showState({
    title: copy.startupFailedTitle,
    body: copy.startupFailedBody,
    ...(retry === undefined ? {} : { action: { label: copy.retry, run: retry } }),
  });
}

async function start(): Promise<void> {
  try {
    const context = await client.context();
    if (context === null) {
      showStandalone("no-host");
      return;
    }
    standalone?.destroy();
    standalone = null;
    clearBoot();
    // `?taskRun=` opens a generation; a file alone opens as a score file. Both together open the generation
    // and keep the file only as the place Save as goes beside.
    const taskRunId = new URLSearchParams(location.search).get("taskRun")?.trim() || null;
    createApp({
      root: root as HTMLElement,
      host: createSdkHost(client, context, { taskRunId, composer }),
    });
  } catch {
    showStandalone("failed", () => void start());
  }
}

void start();
