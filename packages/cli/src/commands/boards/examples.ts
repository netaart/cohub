import type { Command } from "commander";
import { json } from "../../output.js";
import { BOARD_SCRIPT_DRAWING_EXAMPLE } from "../../board-kernel.js";

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
};

export function registerBoardExampleCommands(boards: Command): void {
  boards.command("examples [name]")
    .description("Print a starter Board document or list the examples")
    .option("--module", "Print the custom example's JavaScript module")
    .addHelpText("after", `
Examples are valid input for create and apply:
  cohub boards examples lesson > lesson.json
  cohub boards create lesson.board -i lesson.json`)
    .action((name: string | undefined, options: { module?: boolean }) => {
      if (options.module) {
        if (name !== "custom") throw new Error("--module requires the custom example.");
        process.stdout.write(BOARD_SCRIPT_DRAWING_EXAMPLE);
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
