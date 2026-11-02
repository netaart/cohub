import type { BoardShader, BoardShaderPass } from "./script.js";

export const BOARD_SHADER_API = {
  summary: "export const shader = { layer?, surfaces?, uniforms?, state?, passes }: WebGL 2 passes (GLSL ES 3.00) drawn with the owner on the GPU. Export animated = true for motion.",
  descriptor: {
    layer: "above (default) or below the owner and its contents; filter: passes transform the owner's pixels in turn, read with scene(uv). A Board script's filter transforms every item.",
    surfaces: "true provides surface(local): { distance, normal, inside } to the edges of the Board's items (not frames, arrows, drawings, effects, text or screen and add blends), so motion can collide with cards.",
    uniforms: "Declared values set from setup code with ctx.uniforms(): { name: \"float\" | \"int\" | \"vec2\" | \"vec3\" | \"vec4\", optionally \"[length]\" }; at most 128 vectors.",
    state: "{ width, height, glsl, precision?: byte | half, bounds?: { x, y, width, height } }: a texture vec4 simulate(Fragment f) advances in 60 Hz steps from its previous value state(uv); every pass reads stateAt(f.local). It covers bounds in owner units, by default the box, or for a Board script the view (like glass in front of it); give a Board script bounds in world units to keep its state on the Board.",
    passes: "Up to 8, drawn in order.",
  } satisfies Record<keyof BoardShader, string>,
  pass: {
    glsl: "Defines vec4 effect(Fragment f) returning straight (unpremultiplied) color; with sprites, also Sprite sprite(int id). The same source compiles for both stages: guard stage-only code with #ifdef COHUB_FRAGMENT.",
    sprites: "Draw this many instanced quads (up to 65536, scaled by board.quality) placed by sprite(id), evaluated once per sprite per frame, instead of one quad over the box.",
    blend: "normal (default), add, screen or multiply.",
  } satisfies Record<keyof BoardShaderPass, string>,
  glsl: {
    board: "board.time and board.delta (seconds on the script clock), board.frame (60 Hz steps), board.size (box, or the view for Board scripts), board.view (visible rectangle x, y, width, height in local units), board.resolution (device pixels of the box), board.zoom, board.seed (0–1), board.quality (0–1; scale work by it), board.dark (1 in a dark theme).",
    params: "params.<name>: number and boolean parameters as float, color parameters as vec4 resolved for the viewer's theme.",
    uniforms: "uniforms.<name>: the declared uniforms.",
    Fragment: "f.uv (0–1 across the box or sprite), f.local (owner units; world units for Board scripts), f.color and f.data (from the sprite).",
    Sprite: "{ position, size, rotation (radians), color, data, visible } in local units; makeSprite(position, size) fills the rest.",
    helpers: "scene(uv) in filter layers, surface(local) with surfaces, state(uv) across the state's area and stateAt(local) with state.",
    includes: "#include \"cohub:hash\" (hash, hash2 by integer or vec2, identical on every GPU), \"cohub:noise\" (noise, fbm), \"cohub:shapes\" (sdCircle, sdBox, sdRoundBox, sdSegment, fill), \"cohub:color\" (hsv, luminance, srgbToLinear, linearToSrgb).",
    rules: "No uniform, in/out, layout, #version or #extension declarations; no while or do loops; for loops share a budget of 65536 iterations per invocation. Names starting with cohub or holding __ are reserved.",
  },
  export: "Web exports and `boards export` draw shaders like the live Board; `boards export --renderer canvas` draws draw() instead, or leaves the shader out, and warns.",
} as const;
