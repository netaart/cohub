import "./viewer.css";
import { mount } from "svelte";
import LocalBoardViewer from "./LocalBoardViewer.svelte";

mount(LocalBoardViewer, {
	target: document.getElementById("app") as HTMLElement,
});
