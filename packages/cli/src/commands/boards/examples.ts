import type { Command } from "commander";
import { json } from "../../output.js";
import {
  BOARD_SCRIPT_DRAWING_EXAMPLE,
  BOARD_SCRIPT_RAIN_EXAMPLE,
  BOARD_SCRIPT_SENSES_EXAMPLE,
  BOARD_SCRIPT_SPARKS_EXAMPLE,
  BOARD_SCRIPT_TILT_EXAMPLE,
} from "@neta-art/cohub/board";

const MODULES: Record<string, string> = {
  custom: BOARD_SCRIPT_DRAWING_EXAMPLE,
  rain: BOARD_SCRIPT_RAIN_EXAMPLE,
  tilt: BOARD_SCRIPT_TILT_EXAMPLE,
  senses: BOARD_SCRIPT_SENSES_EXAMPLE,
  sparks: BOARD_SCRIPT_SPARKS_EXAMPLE,
};

/**
 * Starter documents for `boards create -i` and patches for `boards apply -i`.
 * Every example is a valid Board patch; `boards.test.ts` checks that.
 */
export const BOARD_EXAMPLES: Record<string, { description: string; value: Record<string, unknown> }> = {
  basic: {
    description: "A title, a note and a shape.",
    value: {
      board: { title: "Launch plan" },
      items: {
        title: { type: "text", position: { x: 80, y: 60 }, props: { text: "Launch plan", fontSize: 40, fontWeight: 700 } },
        note: { type: "text", position: { x: 80, y: 128 }, props: { text: "Ship the beta to ten design partners, then widen.", width: 420 } },
        goal: { type: "shape", position: { x: 600, y: 60 }, size: { width: 200, height: 140 }, style: { stroke: "green", fill: "green", fillOpacity: 0.12, radius: 16 }, props: { text: "Beta in March" } },
      },
    },
  },
  workflow: {
    description: "Steps joined by bound arrows with relations.",
    value: {
      items: {
        request: { type: "shape", position: { x: 80, y: 160 }, size: { width: 200, height: 110 }, style: { stroke: "brand" }, props: { geometry: "rounded", text: "Request" } },
        agent: { type: "shape", position: { x: 400, y: 160 }, size: { width: 200, height: 110 }, style: { stroke: "blue", fill: "blue", fillOpacity: 0.08 }, props: { geometry: "rounded", text: "Agent" } },
        result: { type: "shape", position: { x: 720, y: 160 }, size: { width: 200, height: 110 }, style: { stroke: "green", fill: "green", fillOpacity: 0.08 }, props: { geometry: "rounded", text: "Result" } },
        "request-agent": { type: "arrow", props: { start: { item: "request" }, end: { item: "agent" }, relation: "triggers", label: "invoke" } },
        "agent-result": { type: "arrow", props: { start: { item: "agent" }, end: { item: "result" }, relation: "produces", label: "output" } },
      },
    },
  },
  slides: {
    description: "960×540 frames as slides; children move and clip with their frame.",
    value: {
      items: {
        s1: { type: "frame", position: { x: 0, y: 0 }, size: { width: 960, height: 540 }, props: { label: "Intro" } },
        "s1-title": { type: "text", parent: "s1", position: { x: 72, y: 72 }, props: { text: "Special relativity", fontSize: 56, fontWeight: 700 } },
        "s1-sub": { type: "text", parent: "s1", position: { x: 72, y: 160 }, props: { text: "Nothing outruns light" } },
        s2: { type: "frame", position: { x: 1080, y: 0 }, size: { width: 960, height: 540 }, props: { label: "Time dilation" } },
        "s2-title": { type: "text", parent: "s2", position: { x: 72, y: 72 }, props: { text: "Moving clocks run slow", fontSize: 40, fontWeight: 700 } },
      },
    },
  },
  lesson: {
    description: "An animated lesson: entrances, a drawn arrow, typed text and camera moves with pause markers.",
    value: {
      items: {
        s1: { type: "frame", size: { width: 960, height: 540 }, props: { label: "Length contraction" } },
        title: { type: "text", parent: "s1", position: { x: 72, y: 60 }, props: { text: "Moving rulers get shorter", fontSize: 40, fontWeight: 700 } },
        ruler: { type: "shape", parent: "s1", position: { x: 120, y: 252 }, size: { width: 480, height: 40 }, style: { stroke: "blue", fill: "blue", fillOpacity: 0.15 }, props: { text: "1 m", fontSize: 16 } },
        caption: { type: "text", parent: "s1", position: { x: 120, y: 336 }, props: { text: "L = L₀ √(1 − v²/c²)", font: "serif", reveal: 1 } },
        motion: { type: "arrow", parent: "s1", style: { stroke: "rose", strokeWidth: 3 }, props: { start: { x: 120, y: 216 }, end: { x: 600, y: 216 }, label: "v → c" } },
        glow: { type: "effect", parent: "s1", position: { x: 630, y: 224 }, size: { width: 96, height: 96 }, style: { fill: "amber" }, props: { kind: "glow" } },
      },
      animations: {
        lecture: {
          markers: [{ at: 1500, label: "Ruler", pause: true }, { at: 5000, label: "Formula", pause: true }],
          tracks: {
            "title-in": { target: "title", property: "opacity", composite: "add", keyframes: [{ at: 0, value: 0 }, { at: 600, value: 1, ease: "ease-out" }] },
            "arrow-draw": { target: "motion", property: "style.trim", keyframes: [{ at: 800, value: 0 }, { at: 1800, value: 1, ease: "ease-in-out" }] },
            "ruler-shrink": { target: "ruler", property: "scale", keyframes: [{ at: 2000, value: 1 }, { at: 4000, value: { x: 0.45, y: 1 }, ease: "ease-in-out" }] },
            "caption-type": { target: "caption", property: "props.reveal", keyframes: [{ at: 4200, value: 0 }, { at: 6000, value: 1 }] },
            "camera-focus": { target: "camera", property: "focus", keyframes: [{ at: 0, value: "s1" }, { at: 2000, value: "ruler" }, { at: 4500, value: "s1" }] },
          },
        },
      },
    },
  },
  custom: {
    description: "Custom Canvas content; use --module to print scripts/wave.js.",
    value: {
      items: {
        wave: { type: "custom", position: { x: 0, y: 0 }, size: { width: 480, height: 270 }, script: { src: "scripts/wave.js", params: { amplitude: 48 } } },
      },
    },
  },
  rain: {
    description: "A Board script whose shader rains over the view and splashes on cards; use --module to print scripts/rain.js.",
    value: {
      board: { scripts: { rain: { src: "scripts/rain.js", params: { density: 0.7 } } } },
      items: {
        title: { type: "text", position: { x: 80, y: 40 }, props: { text: "Rainy day", fontSize: 48 } },
        left: { type: "shape", position: { x: 80, y: 180 }, size: { width: 320, height: 180 }, style: { fill: "blue", fillOpacity: 0.16, radius: 16 }, props: { text: "Drops land on top" } },
        right: { type: "shape", position: { x: 480, y: 300 }, size: { width: 280, height: 160 }, rotation: -6, style: { fill: "green", fillOpacity: 0.16, radius: 16 }, props: { text: "and bounce off edges" } },
      },
    },
  },
  tilt: {
    description: "A ball that rolls as the phone tilts; --module tilt prints scripts/tilt.js, --module senses the helpers it imports.",
    value: {
      items: {
        table: { type: "custom", position: { x: 0, y: 0 }, size: { width: 360, height: 640 }, script: { src: "scripts/tilt.js" } },
      },
    },
  },
  sparks: {
    description: "Sparks every viewer sees where anyone clicks, and halos on the others' cursors; use --module to print scripts/sparks.js.",
    value: {
      items: {
        pad: { type: "custom", position: { x: 0, y: 0 }, size: { width: 640, height: 400 }, script: { src: "scripts/sparks.js" } },
      },
    },
  },
};

export function registerBoardExampleCommands(boards: Command): void {
  boards.command("examples [name]")
    .description("Print a starter Board document or list the examples")
    .option("--module", `Print the example's JavaScript module (${Object.keys(MODULES).join(", ")})`)
    .addHelpText("after", `
Examples are valid input for create and apply:
  cohub boards examples lesson > lesson.json
  cohub boards create lesson.board -i lesson.json`)
    .action((name: string | undefined, options: { module?: boolean }) => {
      if (options.module) {
        const module = name ? MODULES[name] : undefined;
        if (!module) throw new Error(`--module needs one of these examples: ${Object.keys(MODULES).join(", ")}.`);
        process.stdout.write(module);
        return;
      }
      if (!name) {
        for (const [key, example] of Object.entries(BOARD_EXAMPLES)) console.log(`${key.padEnd(10)} ${example.description}`);
        return;
      }
      const example = BOARD_EXAMPLES[name];
      if (!example) throw new Error(`Unknown example ${name}; expected ${Object.keys(BOARD_EXAMPLES).join(", ")}`);
      json(example.value);
    });
}
