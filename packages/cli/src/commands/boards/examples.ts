import type { Command } from "commander";
import { json } from "../../output.js";

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
        title: { type: "text", position: { x: 80, y: 60 }, props: { text: "Launch plan", fontSize: 48, fontWeight: 700 } },
        note: { type: "text", position: { x: 80, y: 140 }, props: { text: "Ship the beta to ten design partners, then widen.", fontSize: 20, width: 420 } },
        goal: { type: "shape", position: { x: 600, y: 60 }, size: { width: 240, height: 140 }, style: { stroke: "green", fill: "green", fillOpacity: 0.12, radius: 16 }, props: { text: "Beta in March" } },
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
    description: "Frames as slides; children move and clip with their frame.",
    value: {
      items: {
        s1: { type: "frame", position: { x: 0, y: 0 }, size: { width: 1600, height: 900 }, props: { label: "Intro" } },
        "s1-title": { type: "text", parent: "s1", position: { x: 120, y: 120 }, props: { text: "Special relativity", fontSize: 96, fontWeight: 700 } },
        "s1-sub": { type: "text", parent: "s1", position: { x: 120, y: 260 }, props: { text: "Nothing outruns light", fontSize: 40 } },
        s2: { type: "frame", position: { x: 1800, y: 0 }, size: { width: 1600, height: 900 }, props: { label: "Time dilation" } },
        "s2-title": { type: "text", parent: "s2", position: { x: 120, y: 120 }, props: { text: "Moving clocks run slow", fontSize: 72, fontWeight: 700 } },
      },
    },
  },
  lesson: {
    description: "An animated lesson: entrances, a drawn arrow, typed text and camera moves with pause markers.",
    value: {
      items: {
        s1: { type: "frame", size: { width: 1600, height: 900 }, props: { label: "Length contraction" } },
        title: { type: "text", parent: "s1", position: { x: 120, y: 100 }, props: { text: "Moving rulers get shorter", fontSize: 72, fontWeight: 700 } },
        ruler: { type: "shape", parent: "s1", position: { x: 200, y: 420 }, size: { width: 800, height: 60 }, style: { stroke: "blue", fill: "blue", fillOpacity: 0.15 }, props: { text: "1 m" } },
        caption: { type: "text", parent: "s1", position: { x: 200, y: 560 }, props: { text: "L = L₀ √(1 − v²/c²)", fontSize: 44, font: "serif", reveal: 1 } },
        motion: { type: "arrow", parent: "s1", style: { stroke: "rose", strokeWidth: 4 }, props: { start: { x: 200, y: 360 }, end: { x: 1000, y: 360 }, label: "v → c" } },
        glow: { type: "effect", parent: "s1", position: { x: 1050, y: 380 }, size: { width: 160, height: 160 }, style: { fill: "amber" }, props: { kind: "glow" } },
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
  sketch: {
    description: "A code-drawn item; `src` is a module in the Space exporting draw(ctx, frame).",
    value: {
      items: {
        wave: { type: "sketch", position: { x: 0, y: 0 }, size: { width: 640, height: 360 }, props: { src: "sketches/wave.js", params: { amplitude: 60 } } },
      },
      animations: {
        loop: { duration: 4000, play: "always", tracks: {} },
      },
    },
  },
};

export function registerBoardExampleCommands(boards: Command): void {
  boards.command("examples [name]")
    .description("Print a starter Board document or list the examples")
    .addHelpText("after", `
Examples are valid input for create and apply:
  cohub boards examples lesson > lesson.json
  cohub boards create lesson.board -i lesson.json`)
    .action((name?: string) => {
      if (!name) {
        for (const [key, example] of Object.entries(BOARD_EXAMPLES)) console.log(`${key.padEnd(10)} ${example.description}`);
        return;
      }
      const example = BOARD_EXAMPLES[name];
      if (!example) throw new Error(`Unknown example ${name}; expected ${Object.keys(BOARD_EXAMPLES).join(", ")}`);
      json(example.value);
    });
}
