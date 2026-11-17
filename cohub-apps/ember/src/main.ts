import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist/600.css";
import "@fontsource/silkscreen/400.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { Camp } from "./engine/camp.svelte.ts";
import "./styles.css";

const target = document.getElementById("app");
if (!target) throw new Error("Missing app mount target");
mount(App, { target, props: { camp: new Camp() } });
