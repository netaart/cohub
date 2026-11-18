import type { ToneMapping } from "@pixi/3d";

export type ModelLighting = "card" | "object";

type Lighting = {
	environment: { skyColor: number; groundColor: number; intensity: number };
	toneMapping: ToneMapping;
	exposure: number;
	light: number;
};

export const MODEL_LIGHTING: Record<ModelLighting, Lighting> = {
	card: { environment: { skyColor: 0xffffff, groundColor: 0x77726c, intensity: 0.85 }, toneMapping: "aces", exposure: 1.1, light: 2.6 },
	object: { environment: { skyColor: 0xffffff, groundColor: 0x8a857e, intensity: 0.75 }, toneMapping: "none", exposure: 1, light: 1.5 },
};
