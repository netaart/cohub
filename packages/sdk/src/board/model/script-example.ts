export const BOARD_SCRIPT_DRAWING_EXAMPLE = `export const animated = true;

export const parameters = {
  amplitude: { type: "number", label: "Amplitude", default: 40, min: 0, max: 120 }
};

export function draw(ctx, { t, width, height, params }) {
  ctx.strokeStyle = "#e67845";
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let x = 0; x <= width; x += 2) {
    const y = height / 2 + Math.sin(x / 40 - t / 800) * params.amplitude;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
`;

/**
 * A Board script: rain over the whole view that splashes on the Board's items.
 * Every drop is a pure function of time, so it seeks, replays and exports.
 */
export const BOARD_SCRIPT_RAIN_EXAMPLE = `export const animated = true;

export const parameters = {
  density: { type: "number", label: "Density", default: 0.7, min: 0, max: 1, step: 0.05 },
  wind: { type: "number", label: "Wind", default: 0.15, min: -0.6, max: 0.6, step: 0.05 },
  splash: { type: "boolean", label: "Splash on cards", default: true },
};

// Each drop draws a streak and three droplets for its splash.
const PARTS = 4;
const DROPS = 2400;

const glsl = \`
#define PARTS \${PARTS}
#include "cohub:hash"

const float SPEED = 1400.0;  // screen pixels per second, at any zoom
const float SPLASH = 0.38;   // seconds a splash lasts

struct Drop { vec2 start; vec2 heading; float reach; float travelled; float landing; bool lands; };

// Drops respawn every cycle at new seeded places, anywhere in view.
Drop drop(int index, float pixel, bool streak) {
  float speed = SPEED * pixel;
  float cycle = board.view.w * 0.6 / speed + SPLASH;
  float clock = board.time + hash(index, 7) * cycle;
  int key = index * 131 + int(floor(clock / cycle));
  Drop d;
  d.heading = normalize(vec2(params.wind, 1.0));
  d.start = board.view.xy + vec2(hash(key, 1) * 1.2 - 0.1, hash(key, 2) * 0.9 - 0.15) * board.view.zw;
  d.reach = (0.25 + hash(key, 3) * 0.55) * board.view.w;
  d.travelled = mod(clock, cycle) * speed;
  d.lands = false;
  d.landing = d.reach;
  if (surface(d.start).inside) { d.reach = 0.0; return d; }
  float limit = min(d.reach, streak ? d.travelled + 0.15 * d.reach : d.travelled);
  // Sphere-trace the item edges along the drop's path.
  float ahead = 0.0;
  for (int i = 0; i < 40 && params.splash > 0.5; i++) {
    float gap = surface(d.start + d.heading * ahead).distance;
    if (gap < pixel) { d.lands = true; d.landing = ahead; break; }
    ahead += max(gap, 2.0 * pixel);
    if (ahead > limit) break;
  }
  return d;
}

Sprite sprite(int id) {
  int index = id / PARTS;
  int part = id - index * PARTS;
  Sprite s = makeSprite(vec2(0.0), vec2(0.0));
  if (hash(index, 11) > params.density || (part > 0 && params.splash < 0.5)) { s.visible = false; return s; }
  float pixel = 1.0 / board.zoom;
  vec4 tint = board.dark > 0.5 ? vec4(0.75, 0.84, 1.0, 0.5) : vec4(0.3, 0.4, 0.55, 0.45);
  Drop d = drop(index, pixel, part == 0);
  if (part == 0) {
    float end = d.lands ? d.landing : d.reach;
    float head = min(d.travelled, end);
    float tail = max(0.0, d.travelled - 34.0 * pixel);
    s.visible = head > tail;
    vec2 a = d.start + d.heading * tail;
    vec2 b = d.start + d.heading * head;
    s.position = (a + b) * 0.5;
    s.size = vec2(1.4 * pixel, distance(a, b));
    s.rotation = -atan(d.heading.x, d.heading.y);
    float fade = d.lands ? 1.0 : 1.0 - smoothstep(0.85, 1.0, head / max(end, 1e-3));
    s.color = vec4(tint.rgb, tint.a * smoothstep(0.0, 0.08 * d.reach, head) * fade);
    return s;
  }
  float age = (d.travelled - d.landing) / (SPEED * pixel);
  if (!d.lands || age < 0.0 || age > SPLASH) { s.visible = false; return s; }
  vec2 hit = d.start + d.heading * d.landing;
  vec2 normal = surface(hit - d.heading * 2.0 * pixel).normal;
  vec2 side = vec2(-normal.y, normal.x);
  vec2 velocity = (normal * (120.0 + 120.0 * hash(index * 7 + part, 6)) + side * (hash(index * 7 + part, 5) - 0.5) * 220.0) * pixel;
  s.position = hit + velocity * age + vec2(0.0, 450.0 * pixel) * age * age;
  s.size = vec2(2.6 * pixel) * (1.0 - 0.5 * age / SPLASH);
  s.color = vec4(tint.rgb, 1.6 * tint.a * (1.0 - age / SPLASH));
  s.data = vec4(1.0);
  return s;
}

vec4 effect(Fragment f) {
  vec2 c = f.uv - 0.5;
  float shape = f.data.x > 0.5
    ? smoothstep(0.5, 0.2, length(c))
    : smoothstep(0.5, 0.0, abs(c.x)) * (0.5 - c.y);
  return vec4(f.color.rgb, f.color.a * shape);
}
\`;

export const shader = {
  surfaces: true,
  passes: [{ glsl, sprites: DROPS * PARTS }],
};
`;
