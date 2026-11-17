import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist/600.css";
import "@fontsource/silkscreen/400.css";
import { mount } from "svelte";
import App from "../src/App.svelte";
import { Camp } from "../src/engine/camp.svelte.ts";
import "../src/styles.css";
import { createPreviewClient } from "./client.ts";

const target = document.getElementById("app");
if (!target) throw new Error("Missing app mount target");
const camp = new Camp(createPreviewClient());
Object.assign(globalThis, { camp });
mount(App, { target, props: { camp } });
