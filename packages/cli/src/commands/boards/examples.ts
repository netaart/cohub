import type { Command } from "commander";
import { handleHttp, json } from "../../output.js";
import { BOARD_SCRIPT_ARENA_EXAMPLE, BOARD_SCRIPT_RAIN_EXAMPLE, BOARD_SCRIPT_SPARKS_EXAMPLE } from "@neta-art/cohub/board";

// Fox by PixelMannen (CC0), rigged and animated by @tomkranis (CC BY 4.0), from the Khronos glTF samples.
const FOX = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Fox/glTF-Binary/Fox.glb";

type BoardExample = { description: string; value: Record<string, unknown>; module?: string };

export const BOARD_EXAMPLES: Record<string, BoardExample> = {
  diagram: {
    description: "A title and steps joined by bound arrows.",
    value: {
      items: {
        title: { type: "text", position: { x: 80, y: 60 }, props: { text: "How a request flows", fontSize: 40, fontWeight: 700 } },
        request: { type: "shape", position: { x: 80, y: 160 }, size: { width: 200, height: 110 }, style: { stroke: "brand" }, props: { geometry: "rounded", text: "Request" } },
        agent: { type: "shape", position: { x: 400, y: 160 }, size: { width: 200, height: 110 }, style: { stroke: "blue", fill: "blue", fillOpacity: 0.08 }, props: { geometry: "rounded", text: "Agent" } },
        result: { type: "shape", position: { x: 720, y: 160 }, size: { width: 200, height: 110 }, style: { stroke: "green", fill: "green", fillOpacity: 0.08 }, props: { geometry: "rounded", text: "Result" } },
        "request-agent": { type: "arrow", props: { start: { item: "request" }, end: { item: "agent" }, relation: "triggers", label: "invoke" } },
        "agent-result": { type: "arrow", props: { start: { item: "agent" }, end: { item: "result" }, relation: "produces", label: "output" } },
      },
    },
  },
  slides: {
    description: "960×540 frames as pages, and a lecture: entrances, a drawn arrow, typed text and camera moves that pause at markers.",
    value: {
      items: {
        s1: { type: "frame", position: { x: 0, y: 0 }, size: { width: 960, height: 540 }, props: { label: "Intro" } },
        "s1-title": { type: "text", parent: "s1", position: { x: 72, y: 72 }, props: { text: "Special relativity", fontSize: 56, fontWeight: 700 } },
        "s1-sub": { type: "text", parent: "s1", position: { x: 72, y: 160 }, props: { text: "Nothing outruns light" } },
        s2: { type: "frame", position: { x: 1080, y: 0 }, size: { width: 960, height: 540 }, props: { label: "Length contraction" } },
        title: { type: "text", parent: "s2", position: { x: 72, y: 60 }, props: { text: "Moving rulers get shorter", fontSize: 40, fontWeight: 700 } },
        ruler: { type: "shape", parent: "s2", position: { x: 120, y: 252 }, size: { width: 480, height: 40 }, style: { stroke: "blue", fill: "blue", fillOpacity: 0.15 }, props: { text: "1 m", fontSize: 16 } },
        caption: { type: "text", parent: "s2", position: { x: 120, y: 336 }, props: { text: "L = L₀ √(1 − v²/c²)", font: "serif", reveal: 1 } },
        motion: { type: "arrow", parent: "s2", style: { stroke: "rose", strokeWidth: 3 }, props: { start: { x: 120, y: 216 }, end: { x: 600, y: 216 }, label: "v → c" } },
        glow: { type: "effect", parent: "s2", position: { x: 630, y: 224 }, size: { width: 96, height: 96 }, style: { fill: "amber" }, props: { kind: "glow" } },
      },
      animations: {
        lecture: {
          markers: [{ at: 400, label: "Cover", pause: true }, { at: 2800, label: "Motion", pause: true }, { at: 5200, label: "Ruler", pause: true }],
          tracks: {
            "camera-focus": { target: "camera", property: "focus", keyframes: [{ at: 400, value: "s1" }, { at: 1400, value: "s2", ease: "ease-in-out" }, { at: 2800, value: "s2" }, { at: 3600, value: "ruler", ease: "ease-in-out" }, { at: 5200, value: "ruler" }, { at: 6000, value: "s2", ease: "ease-in-out" }] },
            "title-in": { target: "title", property: "opacity", composite: "add", keyframes: [{ at: 1400, value: 0 }, { at: 2000, value: 1, ease: "ease-out" }] },
            "arrow-draw": { target: "motion", property: "style.trim", keyframes: [{ at: 1800, value: 0 }, { at: 2800, value: 1, ease: "ease-in-out" }] },
            "ruler-shrink": { target: "ruler", property: "scale", keyframes: [{ at: 3600, value: 1 }, { at: 5200, value: { x: 0.45, y: 1 }, ease: "ease-in-out" }] },
            "caption-type": { target: "caption", property: "props.reveal", keyframes: [{ at: 6000, value: 0 }, { at: 7600, value: 1 }] },
          },
        },
      },
    },
  },
  custom: {
    description: "A scripted Canvas item: params, a hit region, and sparks every viewer sees where anyone clicks; --module prints scripts/sparks.js.",
    module: BOARD_SCRIPT_SPARKS_EXAMPLE,
    value: {
      items: {
        pad: { type: "custom", position: { x: 0, y: 0 }, size: { width: 640, height: 400 }, script: { src: "scripts/sparks.js", params: { count: 32 } } },
      },
    },
  },
  rain: {
    description: "A Board script whose shader rains over the view and splashes on cards; --module prints scripts/rain.js.",
    module: BOARD_SCRIPT_RAIN_EXAMPLE,
    value: {
      board: { scripts: { rain: { src: "scripts/rain.js", params: { density: 0.7 } } } },
      items: {
        title: { type: "text", position: { x: 80, y: 40 }, props: { text: "Rainy day", fontSize: 48 } },
        left: { type: "shape", position: { x: 80, y: 180 }, size: { width: 320, height: 180 }, style: { fill: "blue", fillOpacity: 0.16, radius: 16 }, props: { text: "Drops land on top" } },
        right: { type: "shape", position: { x: 480, y: 300 }, size: { width: 280, height: 160 }, rotation: -6, style: { fill: "green", fillOpacity: 0.16, radius: 16 }, props: { text: "and bounce off edges" } },
      },
    },
  },
  arena: {
    description: "3D: a fox to steer in play with WASD or a gamepad; its clips crossfade, a glow rides its head and a low camera follows; --module prints scripts/arena.js.",
    module: BOARD_SCRIPT_ARENA_EXAMPLE,
    value: {
      board: { background: { color: "#24331f" }, scripts: { arena: { src: "scripts/arena.js", targets: { fox: "fox" } } } },
      items: {
        fox: { type: "file", position: { x: 480, y: 260 }, size: { width: 240, height: 240 }, autoplay: true, props: { src: FOX, model: { display: "object", animation: "Survey", view: { yaw: 0, pitch: 30, zoom: 1 } } } },
        halo: { type: "effect", position: { x: -36, y: -36 }, size: { width: 72, height: 72 }, attach: { item: "fox", node: "b_Head_05" }, depth: { lift: 40, shadow: 0 }, style: { fill: "#ffd76a" }, props: { kind: "glow", life: 1400 } },
        hint: { type: "text", position: { x: 380, y: 140 }, props: { text: "Press Play, then WASD or the arrow keys; hold Shift to run", fontSize: 24, align: "center", width: 440 }, style: { fill: "#f4f1e8" } },
        stone: { type: "shape", position: { x: 160, y: 520 }, size: { width: 120, height: 80 }, style: { fill: "#6d7566", stroke: "#4d5448" }, props: { geometry: "ellipse" } },
        pond: { type: "shape", position: { x: 860, y: 460 }, size: { width: 260, height: 150 }, style: { fill: "#3d6f8f", stroke: "#2c5670" }, props: { geometry: "ellipse" } },
        bush: { type: "shape", position: { x: 920, y: 120 }, size: { width: 140, height: 120 }, style: { fill: "#3f6b35", stroke: "#2f5428" }, props: { geometry: "ellipse" } },
      },
    },
  },
};

export function registerBoardExampleCommands(boards: Command): void {
  const scripted = Object.keys(BOARD_EXAMPLES).filter((name) => BOARD_EXAMPLES[name]?.module);
  boards.command("examples [name]")
    .description("Print a starter Board document or list the examples")
    .option("--module", `Print the example's script module (${scripted.join(", ")})`)
    .addHelpText("after", `
Every example is valid input for create and apply. A scripted example's module goes at
the path its script.src names:
  cohub boards examples slides > slides.json
  cohub boards create slides.board -i slides.json
  cohub boards examples custom --module > scripts/sparks.js`)
    .action((name: string | undefined, options: { module?: boolean }) => {
      try {
        if (!name) {
          if (options.module) throw new Error(`--module needs an example: ${scripted.join(", ")}.`);
          for (const [key, example] of Object.entries(BOARD_EXAMPLES)) console.log(`${key.padEnd(8)} ${example.description}`);
          return;
        }
        const example = Object.hasOwn(BOARD_EXAMPLES, name) ? BOARD_EXAMPLES[name] : undefined;
        if (!example) throw new Error(`Unknown example ${name}; expected ${Object.keys(BOARD_EXAMPLES).join(", ")}.`);
        if (!options.module) {
          json(example.value);
          return;
        }
        if (!example.module) throw new Error(`${name} has no module; --module takes ${scripted.join(", ")}.`);
        process.stdout.write(example.module);
      } catch (cause) {
        handleHttp(cause);
      }
    });
}
